'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('Auto-downloader writes verified cache, skips repeat downloads, resumes byte ranges, rejects corrupted data',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'miguy-model-boot-'));
 process.env.MIGUY_MODELS_ROOT=root;
 const {download}=require('./ensure-models.cjs');
 const model={id:'qwen3.8-27b-uncensored',repo:'Qwen/example',rev:'pinned-revision',folder:'demo'};
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

test('Production model manifest has exactly two Vision-capable model/projector pairs, with no large coder fallback',()=>{
 const {MODELS,renderPreset,totalBytes}=require('./ensure-models.cjs');
 assert.deepEqual(MODELS.map(m=>m.id),['qwen3.8-27b-uncensored','qwen3.6-35b-a3b']);
 assert.equal(MODELS.every(m=>m.shards.length===2&&m.shards[1][0].startsWith('mmproj-')),true);
 assert.equal(MODELS.reduce((sum,m)=>sum+totalBytes(m),0),38772081312);
 const preset=renderPreset(MODELS.map(m=>m.id));
 assert.ok(preset.includes('mmproj-Qwen3.8-27B-Uncensored-F16.gguf'));
 assert.ok(preset.includes('mmproj-Qwen3.6-35B-A3B-Q8_0.gguf'));
 assert.ok(!preset.includes('Coder-Next'));
 const previous=process.env.MIGUY_MODEL_CONTEXT;
 try {
  process.env.MIGUY_MODEL_CONTEXT='65536';
  assert.equal((renderPreset(MODELS.map(m=>m.id)).match(/ctx-size = 65536/g)||[]).length,2,'Smaller GPU can run a verified reduced context without lying about 167K');
  process.env.MIGUY_MODEL_CONTEXT='32768';
  assert.equal((renderPreset(MODELS.map(m=>m.id)).match(/ctx-size = 32768/g)||[]).length,2);
 } finally {if(previous===undefined)delete process.env.MIGUY_MODEL_CONTEXT;else process.env.MIGUY_MODEL_CONTEXT=previous;}
});
