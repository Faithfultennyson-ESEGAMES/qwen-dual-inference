'use strict';
// Non-interactive, idempotent model preparation. Runs before llama-server starts.
// Hugging Face serves files through its own CDN. We do not mirror or proxy model bytes.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const ROOT=process.env.MIGUY_MODELS_ROOT||'/workspace/models';
const WANT_SECOND=process.env.MIGUY_ENABLE_SECOND_MODEL==='1';
const DRY=process.argv.includes('--dry-run');
const MODELS=[
 {id:'qwen3-coder-next',folder:'qwen3-coder-next/Qwen3-Coder-Next-Q5_K_M',repo:'Qwen/Qwen3-Coder-Next-GGUF',rev:'b82fb7382639d97b38fa7672e526c760c2fb358e',
 shards:[
 ['Qwen3-Coder-Next-Q5_K_M-00001-of-00004.gguf',17813589920,'d68162877891c4ba309c8601a69721ecfc7be2091ad99e8175a078ae59decdd3'],
 ['Qwen3-Coder-Next-Q5_K_M-00002-of-00004.gguf',17479501728,'3da1a3fda1061009126eb48c7098221653ab63e0a266d3b6d04f5eac3ae9aa74'],
 ['Qwen3-Coder-Next-Q5_K_M-00003-of-00004.gguf',17226413600,'df60c7a55c6e118d4984a829b74df6b9e863dcea749ee7dc25ab5e72913624e1'],
 ['Qwen3-Coder-Next-Q5_K_M-00004-of-00004.gguf',4190867520,'777ac63a6f94272934996b1cfd7e5619c6804e8580ec4e00311d2a465e298c6a']
 ]},
 {id:'qwen3.8-27b-uncensored',folder:'qwen3.8-27b-uncensored',repo:'JonathanColetti/Qwen3.8-27B-Uncensored-GGUF',rev:'45d0fc0ad6cfcf9eeee6008ddaea925536409b18',
 shards:[['Qwen3.8-27B-Uncensored-Q4_K_M.gguf',16810714528,'4c5e2db039e9325ac7724c8846c71356a24ad1cdfa28002d73ecb6be645f9675']]}
];
function urlFor(m,file){
 const escaped=file.replace(/[^A-Za-z0-9_.-]/g,x=>encodeURIComponent(x));
 const directory=m.id==='qwen3-coder-next'?'Qwen3-Coder-Next-Q5_K_M/':'';
 return 'https://huggingface.co/'+m.repo+'/resolve/'+m.rev+'/'+directory+escaped;
}
function allowed(m){return m.id==='qwen3-coder-next'||WANT_SECOND;}
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
 if(await fsp.stat(dest).catch(()=>false))throw Error('Existing final model file checksum mismatch: '+dest+'. Remove only this corrupted file manually; refusing overwrite.');
 let size=(await fsp.stat(partial).catch(()=>({size:0}))).size;
 if(size>bytes){await fsp.rm(partial);size=0;}
 for(let attempt=1;attempt<=10;attempt++){
  const headers=size>0?{'Range':'bytes='+size+'-'}:{};
  try{
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
   let response;
   try{response=await fetchImpl(urlFor(m,file),{headers,redirect:'follow',signal:controller.signal});}
   finally{clearTimeout(timer);}
   if(![200,206].includes(response.status))throw Error('HTTP '+response.status+' from model CDN');
   if(size>0&&response.status!==206){
    if(response.body?.cancel)await response.body.cancel();
    // Server ignored Range; discard partial to avoid appending duplicate bytes.
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
   if(attempt===10)throw new Error('Model CDN download failed 10 times: '+error.message);
   size=(await fsp.stat(partial).catch(()=>({size:0}))).size;
   console.error('MODEL_RETRY '+m.id+' shard='+file+' attempt='+attempt+' reason='+String(error.message).slice(0,140));
   await new Promise(r=>setTimeout(r,Math.min(20000,1500*attempt)));
  }
 }
}
async function main(){
 const selected=MODELS.filter(allowed);
 if(DRY){console.log(JSON.stringify({mode:'dry-run',root:ROOT,models:selected.map(m=>({id:m.id,totalBytes:m.shards.reduce((n,[_,s])=>n+s,0),files:m.shards.map(x=>x[0])}))},null,2));return;}
 // Explicit opt-in for alternate community GGUF derivative; do not silently download a user-unconfirmed model.
 if(WANT_SECOND&&process.env.MIGUY_APPROVE_COMMUNITY_VARIANT!=='1')throw Error('Secondary community model requires MIGUY_APPROVE_COMMUNITY_VARIANT=1 after reviewing the exact publisher and revision.');
 await fsp.mkdir(ROOT,{recursive:true});
 let free=0;try{const s=await fsp.statfs(ROOT);free=s.bavail*s.bsize;}catch(_){}
 const missing=await Promise.all(selected.flatMap(m=>m.shards.map(async item=>(await verified(safePath(m,item[0]),item[1],item[2]))?0:item[1])));
 const required=missing.reduce((a,b)=>a+b,0);
 if(free&&free<required+5e9)throw Error('Insufficient model storage. Need '+((required+5e9)/1e9).toFixed(1)+' GB free. Available '+(free/1e9).toFixed(1)+' GB.');
 for(const m of selected)for(const shard of m.shards)await download(m,shard);
 for(const m of selected){
  const location=path.join(ROOT,m.folder,'manifest.sha256');
  await fsp.writeFile(location,m.shards.map(([name,_,hash])=>hash+'  '+name).join('\n')+'\n');
 }
 console.log('MODELS_READY '+selected.map(m=>m.id).join(','));
}
if(require.main===module)main().catch(e=>{console.error('MODEL_BOOTSTRAP_FAILED '+e.message);process.exitCode=1;});
module.exports={MODELS,urlFor,download,verified,main};
