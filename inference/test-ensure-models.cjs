'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('Auto-downloader writes verified cache, skips repeat downloads, resumes byte ranges, rejects corrupted data',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'miguy-model-boot-'));
 process.env.MIGUY_MODELS_ROOT=root;
 const {download}=require('./ensure-models.cjs');
 const model={id:'qwen3-coder-next',repo:'Qwen/example',rev:'pinned-revision',folder:'demo'};
 try{
  const payload=Buffer.from('The test data representing a GGUF shard.');
  const hash=crypto.createHash('sha256').update(payload).digest('hex');
  const item=['test.gguf',payload.length,hash];
  let calls=0;
  const fetched=async()=>{calls++;return new Response(payload,{status:200});};
  assert.equal((await download(model,item,{fetchImpl:fetched})).cached,false);
  assert.equal(calls,1);
  assert.equal((await download(model,item,{fetchImpl:fetched})).cached,true);
  assert.equal(calls,1,'Repeated Pod boot never downloads verified file again');
  const dest=path.join(root,'demo','test.gguf');
  assert.equal(fs.readFileSync(dest,'utf8'),payload.toString());
  fs.unlinkSync(dest);fs.unlinkSync(dest+'.verified.sha256');
  fs.writeFileSync(dest+'.partial',payload.subarray(0,13));
  const ranged=async(_url,opts)=>{
   calls++;assert.equal(opts.headers.Range,'bytes=13-');
   return new Response(payload.subarray(13),{status:206,headers:{'content-range':'bytes 13-'+(payload.length-1)+'/'+payload.length}});
  };
  assert.equal((await download(model,item,{fetchImpl:ranged})).cached,false);
  assert.equal(fs.readFileSync(dest,'utf8'),payload.toString());
  const other={...model,folder:'bad'};
  await assert.rejects(()=>download(other,item,{fetchImpl:async()=>new Response(Buffer.alloc(payload.length,1),{status:200})}),/Checksum mismatch/);
 }finally{fs.rmSync(root,{recursive:true,force:true});delete process.env.MIGUY_MODELS_ROOT;}
});
