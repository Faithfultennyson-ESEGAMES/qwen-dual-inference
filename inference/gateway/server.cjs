'use strict';
// Standalone, minimal-auth inference gateway. No secrets stored in logs or responses.
const http=require('node:http');
const fs=require('node:fs');
const crypto=require('node:crypto');
const {MODELS,readState}=require('../ensure-models.cjs');
const ALIASES=Object.freeze(Object.fromEntries(MODELS.map(m=>[m.id,{unsafe:m.id.endsWith('-uncensored'),hasVision:m.id!=='qwen3-coder-next',hasThinking:m.id!=='qwen3-coder-next'}])));
const routerLoadTimeoutMs=Number(process.env.MIGUY_ROUTER_LOAD_TIMEOUT_MS)||300000;
const KEYFILE=process.env.MIGUY_GATEWAY_KEYS_FILE||'/workspace/config/inference-clients.json';
const UPSTREAM=process.env.MIGUY_INFERENCE_UPSTREAM||'http://127.0.0.1:8080';
const u=new URL(UPSTREAM);
if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search)throw Error('Upstream must use an internal 127.0.0.1 HTTP listener');
const MAX_BODY=6*1024*1024;
// GPU model context, request-body size and a bounded tool-schema count protect resources;
// the previous 64-function cap was an artificial gateway restriction, not a model limit.
const MAX_TOOLS=256;
const MAX_TOOL_SCHEMAS_BYTES=2*1024*1024;
let running=0;
const activity=new Map();
const waiting=[];
const MAX_PENDING=8;
function fail(res,status,code,msg,retry=null){
 if(res.headersSent){res.end();return;}
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(retry)headers['Retry-After']=String(retry);
 res.writeHead(status,headers);
 res.end(JSON.stringify({error:{code,message:msg,type:'api_error'}}));
}
function loadClients(){
 let stored=[];
 if(fs.existsSync(KEYFILE)){
  const s=fs.statSync(KEYFILE);
  if(process.platform!=='win32'&&(s.mode&0o077)!==0)throw Error('Gateway key file permissions must be 0600');
  const value=JSON.parse(fs.readFileSync(KEYFILE,'utf8'));
  if(!Array.isArray(value.clients))throw Error('Invalid gateway key file');
  stored=value.clients;
 }
 // Simple first-run mode: supply a strong secret in the RunPod environment.
 // No plaintext credential is saved in the model volume or the image.
 const key=process.env.MIGUY_OWNER_API_KEY||'';
 if(key && (!/^mg_[A-Za-z0-9_-]{40,150}$/.test(key)))throw Error('Invalid MIGUY_OWNER_API_KEY; expected mg_ followed by 40+ secure random URL-safe characters');
 const bootstrap=key?[{id:'owner',sha256:crypto.createHash('sha256').update(key).digest('hex'),requestsPerMinute:12,maxOutputTokens:30000,allowUncensored:process.env.MIGUY_APPROVE_COMMUNITY_VARIANT==='1'}]:[];
 const clients=[...stored,...bootstrap].filter(c=>/^[a-zA-Z0-9_-]{2,60}$/.test(c.id||'')&&/^[0-9a-f]{64}$/i.test(c.sha256||''));
 if(!clients.length)throw Error('No API clients configured');
 return clients;
}
function checkKey(value,clients){
 if(typeof value!=='string'||!value.startsWith('Bearer '))return null;
 const token=value.slice(7);
 if(token.length<32||token.length>160||!/^mg_[A-Za-z0-9_-]+$/.test(token))return null;
 const digest=crypto.createHash('sha256').update(token).digest();
 for(const client of clients){
  const target=Buffer.from(client.sha256,'hex');
  if(target.length===digest.length&&crypto.timingSafeEqual(target,digest))return client;
 }
 return null;
}
function admitted(client){
 const now=Date.now(),minute=Math.floor(now/60000),id=client.id;
 const old=activity.get(id)||{minute,count:0,active:0};
 if(old.minute!==minute){old.minute=minute;old.count=0;}
 const maxRpm=Math.max(1,Math.min(120,Math.floor(Number(client.requestsPerMinute)||12)));
 if(old.count>=maxRpm){activity.set(id,old);return {retry:60-Math.floor(now/1000)%60};}
 if(running>0||old.active>0)return {retry:10};
 old.count++;old.active++;running++;activity.set(id,old);
 return {release(){old.active=Math.max(0,old.active-1);running=Math.max(0,running-1);}};
}
async function waitForAdmission(client,res){
 if(!running && waiting.length===0)return admitted(client);
 if(waiting.length>=MAX_PENDING)return {retry:15};
 const ticket={id:crypto.randomUUID()};
 waiting.push(ticket);
 const deadline=Date.now()+360000;
 try{
  while(Date.now()<deadline){
   if(res.destroyed)return {retry:0,aborted:true};
   if(waiting[0]===ticket&&!running){
    const slot=admitted(client);
    if(!slot.retry)return slot;
    if(slot.retry>10)return slot;
   }
   await new Promise(resolve=>setTimeout(resolve,140));
  }
  return {retry:15};
 }finally{
  const index=waiting.indexOf(ticket);
  if(index>=0)waiting.splice(index,1);
 }
}
async function bodyJson(req){
 let chunks=[],size=0;
 for await(const chunk of req){
  size+=chunk.length;
  if(size>MAX_BODY)throw Object.assign(new Error('Payload too large'),{status:413});
  chunks.push(chunk);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 catch(_){throw Object.assign(new Error('Invalid JSON'),{status:400});}
}

function validContentPart(item){
 if(item?.type==='text')return typeof item.text==='string';
 if(item?.type!=='image_url')return false;
 const uri=typeof item.image_url==='string'?item.image_url:item.image_url?.url;
 if(typeof uri!=='string'||uri.length>3800000)return false;
 const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(uri);
 if(!match)return false;
 const encoded=match[2];
 if(encoded.length<32||encoded.length%4!==0)return false;
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length<20||bytes.length>2800000||bytes.toString('base64')!==encoded)return false;
 if(match[1].toLowerCase()==='png')return bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
 if(match[1].toLowerCase()==='jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 return bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function routerApi(method,route,body,signal){
 const res=await fetch(UPSTREAM+route,{
  method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,
  signal:signal||AbortSignal.timeout(20000),
 });
 const reply=await res.json().catch(()=>({}));
 return {ok:res.ok,status:res.status,reply};
}
function modelStatus(data,id){
 return String(data.find(x=>x.id===id)?.status?.value||'unloaded');
}
async function ensureRouterModel(id,signal){
 const deadline=Date.now()+routerLoadTimeoutMs;
 const list=async()=>{
  const a=await routerApi('GET','/models',null,signal);
  if(!a.ok||!Array.isArray(a.reply?.data))throw Error('Local GPU router model status is unavailable');
  return a.reply.data;
 };
 let data=await list();
 const status=modelStatus(data,id);
 if(status==='loaded'||status==='sleeping')return;
 for(const other of data.filter(x=>x.id!==id&&['loaded','sleeping','loading'].includes(x?.status?.value))){
  const res=await routerApi('POST','/models/unload',{model:other.id},signal);
  if(!res.ok&&res.status!==400)throw Error('Could not unload previous model');
 }
 while(Date.now()<deadline){
  data=await list();
  if(data.every(x=>x.id===id||!['loaded','sleeping','loading'].includes(x.status?.value)))break;
  await wait(1400);
 }
 if(Date.now()>=deadline)throw Error('Timeout unloading previous GPU model');
 data=await list();
 if(!data.some(x=>x.id===id))throw Error('Selected GGUF is not yet recognized by the router');
 if(modelStatus(data,id)==='unloaded'){
  const res=await routerApi('POST','/models/load',{model:id},signal);
  const already=String(res.reply?.error?.message||res.reply?.error||'').includes('already running');
  if(!res.ok&&!(res.status===400&&already))throw Error('Router could not start selected model');
 }
 while(Date.now()<deadline){
  data=await list();
  if(['loaded','sleeping'].includes(modelStatus(data,id)))return;
  if(data.find(x=>x.id===id)?.status?.failed)throw Error('Selected model failed to load in GPU memory');
  await wait(1500);
 }
 throw Error('Timeout loading selected GPU model');
}

function validate(body,client){
 if(!body||typeof body!=='object'||Array.isArray(body))return 'Expected JSON object';
 const model=String(body.model||'');
 if(!Object.hasOwn(ALIASES,model))return 'Unsupported model ID';
 if(!readState().ready.includes(model))return 'Model has not finished downloading and verifying on this Pod';
 if(ALIASES[model].unsafe&&!client.allowUncensored)return 'This client is not authorized for the research model';
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>512)return 'Expected 1-512 chat messages';
 for(const msg of body.messages){
  if(!msg||!['system','developer','user','assistant','tool'].includes(msg.role))return 'Invalid message role';
  if(typeof msg.content==='string')continue;
  if(Array.isArray(msg.content)){
   if(msg.content.length>128||msg.content.some(item=>!validContentPart(item)))return 'Only text and validated inline PNG/JPEG/WebP images are supported; remote URLs are not permitted';
   if(!ALIASES[model].hasVision&&msg.content.some(item=>item?.type==='image_url'))return 'This coding model cannot see images; select the vision-capable Qwen3.8 or Qwen3.6 model';
  }else if(msg.content!==null || msg.role!=='assistant')return 'Invalid message content';
 }
 const allowed=new Set(['model','messages','max_tokens','max_completion_tokens','stream','temperature','top_p','top_k','min_p','stop','seed','frequency_penalty','presence_penalty','repeat_penalty','response_format','tools','tool_choice','chat_template_kwargs','reasoning_effort','reasoning_budget_tokens']);
 if(Object.keys(body).some(key=>!allowed.has(key)))return 'Unsupported request parameter';
 const max=Number(body.max_tokens??body.max_completion_tokens??2048);
 if(!Number.isInteger(max)||max<1||max>30000)return 'Completion budget must be 1–30,000 tokens';
 const cap=Math.max(128,Math.min(30000,Number(client.maxOutputTokens)||4096));
 if(max>cap)return 'Requested completion budget exceeds this API key limit';
 if(body.stream!==true&&max>4096)return 'Use streaming for responses over 4,096 tokens';
 if(body.stream!=null&&typeof body.stream!=='boolean')return 'stream must be boolean';
 if(body.reasoning_effort!==undefined&&!['low','medium','high','xhigh'].includes(body.reasoning_effort))return 'Invalid reasoning_effort';
 if(body.reasoning_budget_tokens!==undefined&&(!Number.isInteger(body.reasoning_budget_tokens)||body.reasoning_budget_tokens<0||(body.reasoning_budget_tokens>0&&body.reasoning_budget_tokens>max-512)))return 'Reasoning budget must preserve at least 512 completion tokens';
 if(body.tools!=null){
  if(!Array.isArray(body.tools)||body.tools.length>MAX_TOOLS)return `Expected up to ${MAX_TOOLS} tool definitions`;
  if(Buffer.byteLength(JSON.stringify(body.tools),'utf8')>MAX_TOOL_SCHEMAS_BYTES)return 'Tool definitions exceed the maximum schema size';
  const seen=new Set();
  for(const entry of body.tools){
   const fn=entry?.function;
   if(entry?.type!=='function'||!fn||typeof fn!=='object'||Array.isArray(fn))return 'Invalid function tool definition';
   if(typeof fn.name!=='string'||!(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/).test(fn.name)||seen.has(fn.name))return 'Invalid or duplicate function name';
   seen.add(fn.name);
   if(typeof fn.description!=='string'||fn.description.length>16000)return 'Invalid function description';
   if(!fn.parameters||typeof fn.parameters!=='object'||Array.isArray(fn.parameters)||fn.parameters.type!=='object')return 'Invalid function parameters schema';
  }
 }
 // Reject remote media/tool URLs and opaque provider endpoint controls; no arbitrary data fetches.
 if('response_format' in body&&body.response_format?.type==='json_schema'&&JSON.stringify(body.response_format).length>20000)return 'Oversized response schema';
 return null;
}
function forward(res,req,body,release){
 const controller=new AbortController();
 let finalized=false;
 function done(){if(finalized)return;finalized=true;release();controller.abort();}
 res.on('close',done);
 const header={'Content-Type':'application/json','Accept':body.stream?'text/event-stream':'application/json'};
 const signal=controller.signal;
 const timer=setTimeout(()=>controller.abort(),90*60*1000);
 (async()=>{
  try{
   await ensureRouterModel(body.model,signal);
   if(res.destroyed)return;
   const upstream=await fetch(UPSTREAM+'/v1/chat/completions',{method:'POST',headers:header,body:JSON.stringify(body),signal});
   if(res.destroyed)return;
   res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
   if(!upstream.body){res.end();return;}
   // Back-pressure by awaiting drain before next chunk.
   for await(const chunk of upstream.body){
    if(res.destroyed)break;
    if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));
   }
   if(!res.destroyed)res.end();
  }catch(error){
   if(!res.headersSent)fail(res,502,'inference_upstream_unavailable','GPU inference router unavailable or request timed out');
   else res.end();
  }finally{clearTimeout(timer);done();}
 })();
}
async function handler(req,res){
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Cache-Control','no-store');
 const path=(req.url||'').split('?')[0];
 if(req.method==='GET'&&path==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"gateway_online"}');return;}
 let clients;
 try{clients=loadClients();}catch(_){fail(res,503,'gateway_configuration','API service is not configured');return;}
 const client=checkKey(req.headers.authorization,clients);
 if(!client){fail(res,401,'unauthorized','Valid Bearer API key required');return;}
 if(req.method==='GET'&&path==='/v1/models'){
  const data=readState().ready.filter(id=>Object.hasOwn(ALIASES,id)&&(!ALIASES[id].unsafe||client.allowUncensored)).map(id=>({id,object:'model',owned_by:'miguy-inference',capabilities:{vision:ALIASES[id].hasVision,thinking:ALIASES[id].hasThinking,tools:true},runtime_status:'available'}));
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data}));return;
 }
 if(req.method!=='POST'||path!=='/v1/chat/completions'){fail(res,404,'not_found','Endpoint not available');return;}
 if(!String(req.headers['content-type']||'').startsWith('application/json')){fail(res,415,'unsupported_media_type','Use application/json');return;}
 let body;
 try{body=await bodyJson(req);}catch(e){fail(res,e.status||400,'invalid_request',e.message);return;}
 const issue=validate(body,client);
 if(issue){fail(res,403,'invalid_request',issue);return;}
 const slot=await waitForAdmission(client,res);
 if(slot.aborted)return;
 if(slot.retry){fail(res,429,'busy_or_rate_limited','Inference queue full, timed out, or rate limit reached',slot.retry);return;}
 forward(res,req,body,slot.release);
}
function server(){
 const app=http.createServer((req,res)=>{handler(req,res).catch(()=>fail(res,500,'internal_error','Unexpected gateway error'));});
 app.requestTimeout=90*60*1000;
 app.headersTimeout=120000;
 app.listen(Number(process.env.MIGUY_GATEWAY_PORT||8787),'0.0.0.0');
 return app;
}
if(require.main===module)server();
module.exports={server,handler,loadClients,checkKey,validate,admitted,waitForAdmission,MAX_TOOLS,MAX_TOOL_SCHEMAS_BYTES,validContentPart,ensureRouterModel};
