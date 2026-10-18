'use strict';
// Model downloads run in two phases: bootstrap the smallest complete model,
// then continue preparing other models while llama.cpp and the API are live.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const ROOT=process.env.MIGUY_MODELS_ROOT||'/workspace/models';
const STATE=process.env.MIGUY_MODEL_CATALOG_FILE||'/workspace/config/ready-models.json';
const PRESET=process.env.MIGUY_ROUTER_PRESET_FILE||'/workspace/config/active-models.ini';
const ROUTER=process.env.MIGUY_INFERENCE_UPSTREAM||'http://127.0.0.1:8080';
const MODELS=Object.freeze([
 {id:'qwen3.8-27b-uncensored',folder:'qwen3.8-27b-uncensored',repo:'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',rev:'45d0fc0ad6cfcf9eeee6008ddaea925536409b18',context:32768,
  shards:[
   ['Qwen3.8-27B-Uncensored-Q4_K_M.gguf',16810714528,'4c5e2db039e9325ac7724c8846c71356a24ad1cdfa28002d73ecb6be645f9675'],
   ['mmproj-Qwen3.8-27B-Uncensored-F16.gguf',927606912,'5ac423f8a29059dc24e51bc6a43e9380dcd57a9347f28b62591e0b3f60b7081c']
  ]},
 {id:'qwen3.6-35b-a3b',folder:'qwen3.6-35b-a3b',repo:'ggml-org/Qwen3.6-35B-A3B-GGUF',rev:'baec3ebee244827cda0f4557eafa8b28f7545fa6',context:32768,
  shards:[
   ['Qwen3.6-35B-A3B-Q4_K_M.gguf',20419565568,'671e47e0ec53c665d048b98c3ecbfd5236b5ca9c3e02ed19fc8f81f7b85140c7'],
   ['mmproj-Qwen3.6-35B-A3B-Q8_0.gguf',614194304,'904cbf8c8e876220066ab3bf676c7efa40f3da372276fdaf8b01d2fb2a37a51d']
  ]},
 {id:'qwen3-coder-next',folder:'qwen3-coder-next/Qwen3-Coder-Next-Q5_K_M',repo:'Qwen/Qwen3-Coder-Next-GGUF',rev:'b82fb7382639d97b38fa7672e526c760c2fb358e',context:32768,prefix:'Qwen3-Coder-Next-Q5_K_M/',
  shards:[
   ['Qwen3-Coder-Next-Q5_K_M-00001-of-00004.gguf',17813589920,'d68162877891c4ba309c8601a69721ecfc7be2091ad99e8175a078ae59decdd3'],
   ['Qwen3-Coder-Next-Q5_K_M-00002-of-00004.gguf',17479501728,'3da1a3fda1061009126eb48c7098221653ab63e0a266d3b6d04f5eac3ae9aa74'],
   ['Qwen3-Coder-Next-Q5_K_M-00003-of-00004.gguf',17226413600,'df60c7a55c6e118d4984a829b74df6b9e863dcea749ee7dc25ab5e72913624e1'],
   ['Qwen3-Coder-Next-Q5_K_M-00004-of-00004.gguf',4190867520,'777ac63a6f94272934996b1cfd7e5619c6804e8580ec4e00311d2a465e298c6a']
  ]}
]);
function urlFor(m,file){
 const encoded=file.replace(/[^A-Za-z0-9_.-]/g,x=>encodeURIComponent(x));
 return 'https://huggingface.co/'+m.repo+'/resolve/'+m.rev+'/'+(m.prefix||'')+encoded;
}
function safePath(m,file){
 const dest=path.resolve(ROOT,m.folder,file);
 if(!dest.startsWith(path.resolve(ROOT)+path.sep))throw Error('Unsafe model path');
 return dest;
}
async function sha256(file){
 const h=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))h.update(chunk);
 return h.digest('hex');
}
async function verified(file,bytes,expected){
 try{
  const s=await fsp.stat(file);
  if(s.size!==bytes)return false;
  const marker=file+'.verified.sha256';
  const data=await fsp.readFile(marker,'utf8').catch(()=>null);
  if(data===expected+'\n'&&process.env.MIGUY_VERIFY_CACHE_ON_EVERY_BOOT!=='1')return true;
  const actual=await sha256(file);
  if(actual===expected){await fsp.writeFile(marker,expected+'\n',{mode:0o600});return true;}
  return false;
 }catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function download(m,[file,bytes,expected],{fetchImpl=globalThis.fetch}={}){
 const dest=safePath(m,file),partial=dest+'.partial';
 await fsp.mkdir(path.dirname(dest),{recursive:true});
 if(await verified(dest,bytes,expected)){console.log('MODEL_CACHED '+m.id+' '+file);return {cached:true,file};}
 if(await fsp.stat(dest).catch(()=>false))throw Error('Existing final model checksum mismatch: '+dest+'. Refusing overwrite.');
 let size=(await fsp.stat(partial).catch(()=>({size:0}))).size;
 if(size>bytes){await fsp.rm(partial);size=0;}
 for(let attempt=1;attempt<=10;attempt++){
  const headers=size>0?{'Range':'bytes='+size+'-'}:{};
  try{
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
   let response;
   try{response=await fetchImpl(urlFor(m,file),{headers,redirect:'follow',signal:controller.signal});}
   finally{clearTimeout(timer);}
   if(![200,206].includes(response.status))throw Error('HTTP '+response.status+' from model CDN');
   if(size>0&&response.status!==206){
    await response.body?.cancel?.();
    await fsp.rm(partial,{force:true});size=0;continue;
   }
   if(size>0){
    const range=response.headers?.get('content-range')||'';
    if(!range.startsWith('bytes '+size+'-')){await response.body?.cancel?.();throw Error('Incorrect CDN resume offset');}
   }
   await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(partial,{flags:size?'a':'w'}));
   size=(await fsp.stat(partial)).size;
   if(size!==bytes)throw Error('Incomplete download: '+size+'/'+bytes+' bytes');
   const digest=await sha256(partial);
   if(digest!==expected)throw Error('Checksum mismatch for '+file);
   await fsp.rename(partial,dest);
   await fsp.writeFile(dest+'.verified.sha256',expected+'\n',{mode:0o600});
   console.log('MODEL_VERIFIED '+m.id+' '+file);
   return {cached:false,file};
  }catch(error){
   if(/Checksum mismatch|Incorrect CDN resume|Existing final/.test(error.message))throw error;
   if(attempt===10)throw Error('Model CDN download failed 10 times: '+error.message);
   size=(await fsp.stat(partial).catch(()=>({size:0}))).size;
   console.error('MODEL_RETRY '+m.id+' shard='+file+' attempt='+attempt+' reason='+String(error.message).slice(0,140));
   await new Promise(resolve=>setTimeout(resolve,Math.min(20000,1500*attempt)));
  }
 }
}
const totalBytes=m=>m.shards.reduce((n,[,s])=>n+s,0);
const modelPath=m=>safePath(m,m.shards[0][0]);
const projectorPath=m=>m.id==='qwen3-coder-next'?null:safePath(m,m.shards[1][0]);
async function atomicallyWrite(target,data){
 await fsp.mkdir(path.dirname(target),{recursive:true});
 const tmp=target+'.'+process.pid+'.tmp';
 await fsp.writeFile(tmp,data,{mode:0o600});
 await fsp.rename(tmp,target);
}
function readState(){
 try{const file=process.env.MIGUY_MODEL_CATALOG_FILE||STATE;const s=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(s.ready)?s:{ready:[]};}
 catch(e){if(e.code==='ENOENT')return {ready:[]};throw e;}
}
function renderPreset(ready){
 const context=String(process.env.MIGUY_MODEL_CONTEXT||'167936');
 if(!/^[0-9]+$/.test(context)||Number(context)<160000)throw Error('MIGUY_MODEL_CONTEXT must support the configured 130K input plus 30K output target');
 let out='version = 1\n\n[*]\nn-gpu-layers = 99\nflash-attn = on\ncache-type-k = q8_0\ncache-type-v = q8_0\njinja = true\nparallel = 1\nno-context-shift = true\nload-on-startup = false\n\n';
 for(const m of MODELS.filter(x=>ready.includes(x.id))){
  out+='['+m.id+']\nmodel = '+modelPath(m)+'\n'+(projectorPath(m)?'mmproj = '+projectorPath(m)+'\n':'')+'ctx-size = '+context+'\nn-predict = 30000\n\n';
 }
 return out;
}
async function waitForRouterModel(model,{fetchImpl=globalThis.fetch,timeoutMs=75000}={}){
 const stop=Date.now()+timeoutMs;
 while(Date.now()<stop){
  try{
   const response=await fetchImpl(ROUTER+'/models?reload=1',{signal:AbortSignal.timeout(15000)});
   if(response.ok){
    const body=await response.json();
    if(body.data?.some(x=>x.id===model.id))return true;
   }
  }catch(_){}
  await new Promise(r=>setTimeout(r,1500));
 }
 throw Error('Running inference router did not discover '+model.id+' after preset update');
}
async function ensureDiskSpace(m){
 await fsp.mkdir(ROOT,{recursive:true});
 const missing=await Promise.all(m.shards.map(async item=>(await verified(safePath(m,item[0]),item[1],item[2]))?0:item[1]));
 const required=missing.reduce((n,v)=>n+v,0);
 const s=await fsp.statfs(ROOT).catch(()=>null),free=s?s.bavail*s.bsize:0;
 if(free&&free<required+3e9)throw Error('Insufficient disk to download '+m.id+'. Need '+((required+3e9)/1e9).toFixed(1)+'GB, free '+(free/1e9).toFixed(1)+'GB.');
}
async function prepare(m,{fetchImpl=globalThis.fetch}={}){
 await ensureDiskSpace(m);
 for(const shard of m.shards)await download(m,shard,{fetchImpl});
 // Verify every weight shard and matching projector when the model has Vision.
 for(const [file,bytes,hash] of m.shards){
  if(!await verified(safePath(m,file),bytes,hash))throw Error('Model not fully verified: '+m.id+'/'+file);
 }
 return m;
}
async function publishReady(m,{reload=false,fetchImpl=globalThis.fetch}={}){
 const before=readState(),ready=[...new Set([...before.ready,m.id])];
 await atomicallyWrite(PRESET,renderPreset(ready));
 if(reload)await waitForRouterModel(m,{fetchImpl});
 await atomicallyWrite(STATE,JSON.stringify({version:2,ready,updatedAt:new Date().toISOString()})+'\n');
 console.log('MODEL_AVAILABLE '+m.id+' ready='+ready.join(','));
 return ready;
}
async function main(args=process.argv.slice(2),{fetchImpl=globalThis.fetch}={}){
 if(args.includes('--dry-run')){
  console.log(JSON.stringify({mode:'dry-run',root:ROOT,order:'smallest-first',models:MODELS.map(m=>({id:m.id,bytes:totalBytes(m),files:m.shards.map(x=>x[0])}))},null,2));return;
 }
 if(process.env.MIGUY_APPROVE_COMMUNITY_VARIANT!=='1')throw Error('Explicit MIGUY_APPROVE_COMMUNITY_VARIANT=1 is required for the selected unrestricted first model.');
 if(!args.some(x=>['--initial','--remaining','--all'].includes(x)))throw Error('Specify --initial or --remaining');
 const selected=args.includes('--initial')?[MODELS[0]]:args.includes('--remaining')?MODELS.slice(1):MODELS;
 for(const m of selected){
  try{
   await prepare(m,{fetchImpl});
   await publishReady(m,{reload:m.id!==MODELS[0].id,fetchImpl});
  }catch(e){
   console.error('MODEL_PREP_FAILED '+m.id+' '+e.message);
   if(args.includes('--initial'))throw e;
  }
 }
 if(args.includes('--initial'))console.log('FIRST_MODEL_READY '+MODELS[0].id);
 else console.log('BACKGROUND_MODEL_DOWNLOADS_COMPLETE');
}
if(require.main===module)main().catch(e=>{console.error('MODEL_BOOTSTRAP_FAILED '+e.message);process.exitCode=1;});
module.exports={MODELS,ROOT,STATE,PRESET,urlFor,safePath,download,verified,prepare,publishReady,readState,renderPreset,waitForRouterModel,main,totalBytes};
