'use strict';
// Standalone, minimal-auth inference gateway. No secrets stored in logs or responses.
const http=require('node:http');
const fs=require('node:fs');
const crypto=require('node:crypto');
const ALIASES=Object.freeze({
 'qwen3-coder-next':{unsafe:false},
 'qwen3.8-27b-uncensored':{unsafe:true},
});
const KEYFILE=process.env.MIGUY_GATEWAY_KEYS_FILE||'/workspace/config/inference-clients.json';
const UPSTREAM=process.env.MIGUY_INFERENCE_UPSTREAM||'http://127.0.0.1:8080';
const u=new URL(UPSTREAM);
if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search)throw Error('Upstream must use an internal 127.0.0.1 HTTP listener');
const MAX_BODY=6*1024*1024;
let running=0;
const activity=new Map();
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
 const bootstrap=key?[{id:'owner',sha256:crypto.createHash('sha256').update(key).digest('hex'),requestsPerMinute:12,maxOutputTokens:30000,allowUncensored:process.env.MIGUY_ENABLE_SECOND_MODEL==='1'}]:[];
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
function validate(body,client){
 if(!body||typeof body!=='object'||Array.isArray(body))return 'Expected JSON object';
 const model=String(body.model||'');
 if(!Object.hasOwn(ALIASES,model))return 'Unsupported model ID';
 if(ALIASES[model].unsafe&&process.env.MIGUY_ENABLE_SECOND_MODEL!=='1')return 'Secondary model is not configured on this Pod';
 if(ALIASES[model].unsafe&&!client.allowUncensored)return 'This client is not authorized for the research model';
 if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>512)return 'Expected 1-512 chat messages';
 for(const msg of body.messages){
  if(!msg||!['system','developer','user','assistant','tool'].includes(msg.role))return 'Invalid message role';
  if(typeof msg.content==='string')continue;
  if(Array.isArray(msg.content)){
   if(msg.content.length>128||msg.content.some(item=>item?.type!=='text'||typeof item.text!=='string'))return 'Text-only messages currently supported; external images/URLs disabled';
  }else if(msg.content!==null || msg.role!=='assistant')return 'Invalid message content';
 }
 const allowed=new Set(['model','messages','max_tokens','max_completion_tokens','stream','temperature','top_p','top_k','min_p','stop','seed','frequency_penalty','presence_penalty','repeat_penalty','response_format','tools','tool_choice','chat_template_kwargs']);
 if(Object.keys(body).some(key=>!allowed.has(key)))return 'Unsupported request parameter';
 const max=Number(body.max_tokens??body.max_completion_tokens??2048);
 if(!Number.isInteger(max)||max<1||max>30000)return 'Completion budget must be 1–30,000 tokens';
 const cap=Math.max(128,Math.min(30000,Number(client.maxOutputTokens)||4096));
 if(max>cap)return 'Requested completion budget exceeds this API key limit';
 if(body.stream!==true&&max>4096)return 'Use streaming for responses over 4,096 tokens';
 if(body.stream!=null&&typeof body.stream!=='boolean')return 'stream must be boolean';
 if(body.tools!=null&&(!Array.isArray(body.tools)||body.tools.length>64))return 'Too many tools';
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
  const data=Object.entries(ALIASES).filter(([id,meta])=>!meta.unsafe||(client.allowUncensored&&process.env.MIGUY_ENABLE_SECOND_MODEL==='1')).map(([id])=>({id,object:'model',owned_by:'miguy-inference'}));
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data}));return;
 }
 if(req.method!=='POST'||path!=='/v1/chat/completions'){fail(res,404,'not_found','Endpoint not available');return;}
 if(!String(req.headers['content-type']||'').startsWith('application/json')){fail(res,415,'unsupported_media_type','Use application/json');return;}
 let body;
 try{body=await bodyJson(req);}catch(e){fail(res,e.status||400,'invalid_request',e.message);return;}
 const issue=validate(body,client);
 if(issue){fail(res,403,'invalid_request',issue);return;}
 const slot=admitted(client);
 if(slot.retry){fail(res,429,'busy_or_rate_limited','Request queued elsewhere or rate limit reached',slot.retry);return;}
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
module.exports={server,handler,loadClients,checkKey,validate,admitted};
