const CITY="6787b812c168def1b2c6d143",INTERVAL=30000,RESERVATION_TTL=30*60*1000;
const reply=(data,status=200)=>Response.json({service:"jet-reservas-v1",...data},{status,headers:{"Cache-Control":"no-store"}});
const fail=(message,status)=>Object.assign(new Error(message),{status});
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(!url.pathname.startsWith("/api/reservas"))return env.ASSETS.fetch(request);
    const origin=request.headers.get("Origin");
    const allowed=(env.ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean);
    if(origin&&origin!==url.origin&&!allowed.includes(origin))return reply({error:"Origem não autorizada."},403);
    const cors=origin?{"Access-Control-Allow-Origin":origin,"Vary":"Origin","Access-Control-Allow-Headers":"Content-Type, X-Reservation-Token","Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS"}:{};
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    let result;
    try{result=await env.RESERVAS.get(env.RESERVAS.idFromName("brasilia-v1")).fetch(request);}catch(_){result=reply({error:"Serviço temporariamente indisponível. Tente novamente."},503);}
    const headers=new Headers(result.headers);for(const [k,v] of Object.entries(cors))headers.set(k,v);
    return new Response(result.body,{status:result.status,headers});
  }
};
export async function fetchAll(kind){
  const page=async n=>{
    const r=await fetch(`https://logistic.gojet.app/api/v0/urent/${kind}?city_id=${CITY}&page=${n}&limit=1000`,{cache:"no-store",signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error("Contagem JET indisponível");
    const d=await r.json();if(!Array.isArray(d.entries))throw new Error("Página incompleta");return d;
  };
  const first=await page(1),pages=Number(first.total_pages);
  if(!Number.isInteger(pages)||pages<0||pages>40||(pages===0&&first.entries.length)||(first.page!=null&&Number(first.page)!==1))throw new Error("Paginação inválida");
  const list=[...first.entries];
  for(let i=2;i<=pages;i+=4){
    const ids=Array.from({length:Math.min(4,pages-i+1)},(_,j)=>i+j);
    const batch=await Promise.all(ids.map(page));
    batch.forEach((d,j)=>{
      if((d.page!=null&&Number(d.page)!==ids[j])||(d.total_pages!=null&&Number(d.total_pages)!==pages)||(d.total_items!=null&&first.total_items!=null&&Number(d.total_items)!==Number(first.total_items)))throw new Error("Paginação mudou");
      list.push(...d.entries);
    });
  }
  if(first.total_items!=null&&Number(first.total_items)!==list.length)throw new Error("Lista incompleta");
  const ids=new Set(list.map(x=>x.id==null?null:String(x.id)));
  if(ids.has(null)||ids.size!==list.length)throw new Error("Lista repetida ou incompleta");
  return list;
}
// Datas civis de Brasília; semana de segunda a domingo.
export function brazilDay(time=Date.now()){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(time));
  const get=k=>parts.find(p=>p.type===k).value;return `${get("year")}-${get("month")}-${get("day")}`;
}
export function periodStart(period,time=Date.now()){
  const day=brazilDay(time);if(period==="month")return day.slice(0,7)+"-01";
  if(period==="week"){const d=new Date(day+"T12:00:00Z");d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);}
  return day;
}
async function digest(value){
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
}
function randomRecoveryCode(){return "JET-"+Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,"0")).join("");}
async function requireRecoveryAdmin(env,key){
  const expected=env.RECOVERY_ADMIN_KEY;
  if(typeof expected!=="string"||expected.length<32)throw fail("Configure RECOVERY_ADMIN_KEY como segredo de pelo menos 32 caracteres na Cloudflare.",503);
  const a=await digest(String(key||"")),b=await digest(expected);let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  if(diff)throw fail("Chave de administrador inválida.",403);
}
// Mantém o ID do perfil recuperado e soma o histórico do cadastro atual, se houver.
async function moveProfile(tx,sourceKey,ownerHash){
  const targetKey="p:"+ownerHash,p=await tx.get(sourceKey);
  if(!p)throw fail("Cadastro não encontrado.",404);
  const current=await tx.get(targetKey);
  if(sourceKey!==targetKey&&current&&current.id!==p.id){
    for(const [key,entry] of await tx.list({prefix:"d:"}))if(entry.profileId===current.id){
      const mergedKey=`d:${entry.day}:${p.id}`,old=await tx.get(mergedKey);
      await tx.put(mergedKey,{...entry,profileId:p.id,name:p.name,bikes:(old?.bikes||0)+entry.bikes,parkings:(old?.parkings||0)+entry.parkings});
      await tx.delete(key);
    }
  }
  for(const [key,r] of await tx.list({prefix:"r:"}))if(r.ownerHash===sourceKey.slice(2)||r.ownerHash===ownerHash){r.ownerHash=ownerHash;r.name=p.name;await tx.put(key,r);}
  // Código de uso único. O usuário deve guardar um novo após recuperar.
  delete p.recoveryHash;
  await tx.put(targetKey,p);if(sourceKey!==targetKey)await tx.delete(sourceKey);
}
async function profileFor(tx,ownerHash,name){
  const key="p:"+ownerHash;let p=await tx.get(key);
  if(!p){p={id:crypto.randomUUID(),name,createdAt:Date.now()};await tx.put(key,p);}
  return p;
}
export class Reservas {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.snapshot=null;this.snapshotPending=null;this.lastCheck=0;this.upstreamError=false;
    this.ctx.blockConcurrencyWhile(async()=>{await this.reconcile(null);await this.arm();});
  }
  async snapshotNow(){
    if(this.snapshot&&Date.now()-this.snapshot.observedAt<INTERVAL)return this.snapshot;
    if(this.snapshotPending)return this.snapshotPending;
    this.snapshotPending=(async()=>{
      const observedAt=Date.now();const [parkings,bikes]=await Promise.all([fetchAll("parkings"),fetchAll("bikes")]);
      const counts=new Map();for(const b of bikes)if(b.parking_id!=null&&String(b.business_status).toLowerCase()==="operation"&&String(b.business_sub_status).toLowerCase()==="operationavailable"){
        const id=String(b.parking_id);counts.set(id,(counts.get(id)||0)+1);
      }
      this.snapshot={observedAt,parkings:new Map(parkings.map(p=>[String(p.id),p])),counts};this.lastCheck=Date.now();this.upstreamError=false;return this.snapshot;
    })().catch(e=>{this.upstreamError=true;throw e;}).finally(()=>{this.snapshotPending=null;});
    return this.snapshotPending;
  }
  async reconcile(snapshot){
    const now=Date.now();
    await this.ctx.storage.transaction(async tx=>{
      const all=await tx.list({prefix:"r:"});
      for(const [key,r] of all){
        // O prazo é fixo a partir da criação, inclusive para reservas já existentes.
        const expiresAt=r.createdAt+RESERVATION_TTL;
        if(now>=expiresAt){await tx.delete(key);continue;}
        if(r.expiresAt!==expiresAt){r.expiresAt=expiresAt;await tx.put(key,r);}
        if(snapshot?.generations&&snapshot.generations.get(r.parkingId)!==r.createdAt)continue;
        if(!snapshot||snapshot.observedAt<=Math.max(r.createdAt,r.lastObservedAt||0)||!snapshot.parkings.has(r.parkingId))continue;
        const count=snapshot.counts.get(r.parkingId)||0;
        // Reservas da versão anterior começam a medir nesta primeira observação.
        if(!Number.isFinite(r.lastCount)){
          r.lastCount=count;r.creditLimit=Math.max(0,r.target-count);r.credited=0;
        }
        const delta=Math.max(0,count-r.lastCount),remaining=Math.max(0,r.creditLimit-(r.credited||0));
        const credit=Math.min(delta,remaining),completed=count>=r.target?1:0;
        if(credit||completed){
          const profile=await profileFor(tx,r.ownerHash,r.name);
          const day=brazilDay(snapshot.observedAt),dailyKey=`d:${day}:${profile.id}`;
          const daily=await tx.get(dailyKey)||{day,profileId:profile.id,name:profile.name,bikes:0,parkings:0};
          daily.bikes+=credit;daily.parkings+=completed;daily.name=profile.name;
          await tx.put(dailyKey,daily);
        }
        r.credited=(r.credited||0)+credit;r.lastCount=count;r.lastObservedAt=snapshot.observedAt;
        if(completed)await tx.delete(key);else await tx.put(key,r);
      }
    });
  }
  async ranking(period,ownerHash){
    if(!["day","week","month"].includes(period))throw fail("Período inválido.",400);
    const start=periodStart(period),end=brazilDay();
    const daily=await this.ctx.storage.list({prefix:"d:",start:`d:${start}:`,end:`d:${end};`});
    const profiles=[...(await this.ctx.storage.list({prefix:"p:"})).values()];
    const names=new Map(profiles.map(p=>[p.id,p.name])),mine=ownerHash?(await this.ctx.storage.get("p:"+ownerHash))?.id:null;
    const totals=new Map();
    for(const entry of daily.values()){
      const row=totals.get(entry.profileId)||{id:entry.profileId,name:names.get(entry.profileId)||entry.name,bikes:0,parkings:0,mine:entry.profileId===mine};
      row.bikes+=entry.bikes;row.parkings+=entry.parkings;totals.set(entry.profileId,row);
    }
    return {serverTime:Date.now(),period,start,end,rows:[...totals.values()],upstreamError:this.upstreamError};
  }
  async arm(){
    const reservations=[...(await this.ctx.storage.list({prefix:"r:"})).values()];
    if(!reservations.length){
      if(await this.ctx.storage.getAlarm()!==null)await this.ctx.storage.deleteAlarm();
      return;
    }
    // A expiração funciona mesmo sem consultas diretas JET ou monitores abertos.
    let next=Math.min(...reservations.map(r=>r.createdAt+RESERVATION_TTL));
    if(this.env.DIRECT_JET_CHECKS==="true")next=Math.min(next,Date.now()+INTERVAL);
    if(await this.ctx.storage.getAlarm()!==next)await this.ctx.storage.setAlarm(next);
  }

  async view(ownerHash){
    const reservations=[...(await this.ctx.storage.list({prefix:"r:"})).values()].map(({ownerHash:owner,...r})=>({...r,mine:owner===ownerHash}));
    const p=ownerHash?await this.ctx.storage.get("p:"+ownerHash):null;
    return {serverTime:Date.now(),version:4,profile:p?{id:p.id,name:p.name,createdAt:p.createdAt,hasRecoveryCode:!!p.recoveryHash}:null,reservations,lastCheck:this.lastCheck,upstreamError:this.upstreamError};
  }
  async fetch(request){
    try{
      const url=new URL(request.url),method=request.method;
      const token=request.headers.get("X-Reservation-Token")||"";
      if(method!=="GET"&&!/^[a-f0-9]{64}$/.test(token))throw fail("Identificação do navegador inválida.",401);
      const ownerHash=token?Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,"0")).join(""):"";
      if(method==="GET"&&url.pathname==="/api/reservas"){
        await this.reconcile(null);
        await this.arm();
        return reply(await this.view(ownerHash));
      }
      if(method==="GET"&&url.pathname==="/api/reservas/ranking"){
        await this.reconcile(null);
        await this.arm();
        return reply(await this.ranking(url.searchParams.get("period")||"day",ownerHash));
      }
      if(method==="POST"&&url.pathname.startsWith("/api/reservas/recovery/")){
        const raw=await request.text();if(raw.length>4096)throw fail("Pedido muito grande.",413);
        let data;try{data=JSON.parse(raw);}catch(_){throw fail("Pedido inválido.",400);}
        const action=url.pathname.slice("/api/reservas/recovery/".length);
        if(action==="code"){
          const code=randomRecoveryCode(),hash=await digest(code);
          await this.ctx.storage.transaction(async tx=>{
            const p=await tx.get("p:"+ownerHash);if(!p)throw fail("Informe seu nome antes de guardar o acesso.",400);
            p.recoveryHash=hash;await tx.put("p:"+ownerHash,p);
          });return reply({code});
        }
        if(action==="admin-list"||action==="admin-restore"){
          await requireRecoveryAdmin(this.env,data.adminKey);
          if(action==="admin-list"){
            const weekly=await this.ranking("week",ownerHash),totals=new Map(weekly.rows.map(r=>[r.id,r]));
            const profiles=[...(await this.ctx.storage.list({prefix:"p:"})).values()].map(p=>({id:p.id,name:p.name,createdAt:p.createdAt,bikes:totals.get(p.id)?.bikes||0,parkings:totals.get(p.id)?.parkings||0}));
            return reply({profiles});
          }
          if(typeof data.profileId!=="string"||!data.profileId)throw fail("Selecione o cadastro antigo.",400);
        }else if(action!=="restore")throw fail("Rota não encontrada.",404);
        const code=String(data.code||"").trim();
        if(action==="restore"&&!/^JET-[a-f0-9]{48}$/.test(code))throw fail("Código de recuperação inválido.",400);
        const hash=action==="restore"?await digest(code):null;
        await this.ctx.storage.transaction(async tx=>{
          const profiles=await tx.list({prefix:"p:"});
          const matches=[...profiles].filter(([key,p])=>action==="restore"?p.recoveryHash===hash:p.id===data.profileId);
          if(matches.length!==1)throw fail(action==="restore"?"Código inválido ou já utilizado.":"Cadastro não encontrado ou ambíguo.",404);
          await moveProfile(tx,matches[0][0],ownerHash);
        });return reply(await this.view(ownerHash));
      }
      if(method==="POST"&&url.pathname==="/api/reservas/observations"){
        const raw=await request.text();if(raw.length>40000)throw fail("Pedido muito grande.",413);
        let data;try{data=JSON.parse(raw);}catch(_){throw fail("Pedido inválido.",400);}
        const observedAt=data.observedAt,rows=data.entries;
        if(!Number.isFinite(observedAt)||observedAt>Date.now()+1000||observedAt<Date.now()-120000||!Array.isArray(rows)||rows.length>500)throw fail("Consulta antiga ou inválida. Aguarde o mapa atualizar.",400);
        const counts=new Map(),parkings=new Map(),generations=new Map();
        for(const row of rows){
          if(!/^[a-f0-9]{24}$/.test(row.parkingId)||!Number.isInteger(row.count)||row.count<0||row.count>10000||!Number.isFinite(row.createdAt)||counts.has(row.parkingId))throw fail("Contagem inválida.",400);
          counts.set(row.parkingId,row.count);parkings.set(row.parkingId,{});generations.set(row.parkingId,row.createdAt);
        }
        await this.reconcile({observedAt,counts,parkings,generations});await this.arm();this.lastCheck=Date.now();this.upstreamError=false;
        return reply(await this.view(ownerHash));
      }
      if(method==="POST"&&url.pathname==="/api/reservas/profile"){
        const raw=await request.text();if(raw.length>2048)throw fail("Pedido muito grande.",413);
        let data;try{data=JSON.parse(raw);}catch(_){throw fail("Pedido inválido.",400);}
        const name=String(data.name||"").trim();if(name.length<2||name.length>40)throw fail("Informe um nome entre 2 e 40 caracteres.",400);
        await this.ctx.storage.transaction(async tx=>{
          const p=await profileFor(tx,ownerHash,name);p.name=name;await tx.put("p:"+ownerHash,p);
          for(const [key,r] of await tx.list({prefix:"r:"}))if(r.ownerHash===ownerHash){r.name=name;await tx.put(key,r);}
        });return reply(await this.view(ownerHash));
      }
      if(method==="POST"&&url.pathname==="/api/reservas"){
        if(Number(request.headers.get("Content-Length"))>2048)throw fail("Pedido muito grande.",413);
        const raw=await request.text();if(raw.length>2048)throw fail("Pedido muito grande.",413);
        let data;try{data=JSON.parse(raw);}catch(_){throw fail("Pedido inválido.",400);}
        const {parkingId,target}=data,name=String(data.name||"").trim();
        if(!/^[a-f0-9]{24}$/.test(parkingId)||!Number.isInteger(target)||target<1||target>500||name.length<2||name.length>40)throw fail("Confira o nome, o ponto e a meta.",400);
        // Registrar independe de conexão com a JET. A contagem do mapa é a base.
        const initial=Number.isInteger(data.initialCount)&&data.initialCount>=0&&data.initialCount<=10000?data.initialCount:null;
        await this.reconcile(null);
        await this.ctx.storage.transaction(async tx=>{
          const key="r:"+parkingId,old=await tx.get(key);
          if(old){
            if(old.ownerHash===ownerHash)return;
            throw fail("Este estacionamento já está reservado. Atualize o monitor.",409);
          }
          const active=await tx.list({prefix:"r:"});
          if([...active.values()].filter(r=>r.ownerHash===ownerHash).length>=10)throw fail("Você já possui 10 reservas ativas.",429);
          const profile=await profileFor(tx,ownerHash,name),createdAt=Date.now();
          await tx.put(key,{parkingId,name:profile.name,target,ownerHash,createdAt,expiresAt:createdAt+RESERVATION_TTL,
            lastCount:initial,lastObservedAt:createdAt,creditLimit:initial===null?null:Math.max(0,target-initial),credited:0});
        });
        await this.arm();return reply(await this.view(ownerHash),201);
      }
      if(method==="DELETE"&&/^\/api\/reservas\/[a-f0-9]{24}$/.test(url.pathname)){
        const key="r:"+url.pathname.split("/").pop();
        await this.ctx.storage.transaction(async tx=>{
          const old=await tx.get(key);if(!old)return;
          if(old.ownerHash!==ownerHash)throw fail("Somente quem reservou pode cancelar.",403);
          await tx.delete(key);
        });await this.arm();return reply(await this.view(ownerHash));
      }
      return reply({error:"Rota não encontrada."},404);
    }catch(e){return reply({error:e.status?e.message:"Não foi possível processar o pedido."},e.status||500);}
  }
  async alarm(){
    await this.reconcile(null);
    if(this.env.DIRECT_JET_CHECKS==="true"&&(await this.ctx.storage.list({prefix:"r:",limit:1})).size){
      try{await this.reconcile(await this.snapshotNow());}catch(_){}
    }
    await this.arm();
  }
}
