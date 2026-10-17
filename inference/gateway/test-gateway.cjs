'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {once}=require('node:events');
const TOKEN='mg_'+'A'.repeat(43);
const TOKEN_ADMIN='mg_'+'B'.repeat(43);
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
async function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'miguy-runpod-gateway-'));
 const config=path.join(dir,'keys.json');
 function keys(research=false){fs.writeFileSync(config,JSON.stringify({clients:[{id:'external',sha256:sha(TOKEN),requestsPerMinute:80,maxOutputTokens:30000,allowUncensored:false},{id:'owner',sha256:sha(TOKEN_ADMIN),requestsPerMinute:80,maxOutputTokens:30000,allowUncensored:research}]}),{mode:0o600});}
 keys(true);
 const requests=[];
 const mock=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  requests.push({url:req.url,body:JSON.parse(body)});
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({id:'response-1',choices:[{message:{role:'assistant',content:'OK'}}]}));
 });
 mock.listen(0,'127.0.0.1');await once(mock,'listening');
 process.env.MIGUY_GATEWAY_KEYS_FILE=config;process.env.MIGUY_GATEWAY_PORT='0';
 process.env.MIGUY_ENABLE_SECOND_MODEL='1';
 process.env.MIGUY_INFERENCE_UPSTREAM='http://127.0.0.1:'+mock.address().port;
 const {server}=require('./server.cjs');
 const gateway=server();await once(gateway,'listening');
 const url='http://127.0.0.1:'+gateway.address().port;
 return {url,requests,keyFile:config,async close(){await new Promise(r=>gateway.close(r));await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('Gateway enforces Bearer API keys, per-client model ACL, bounded output, no router controls',async()=>{
 const s=await setup();
 try{
  const get=(path,key='')=>fetch(s.url+path,{headers:key?{Authorization:'Bearer '+key}:{}});
  const post=(body,key)=>fetch(s.url+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await get('/health')).status,200);
  assert.equal((await get('/v1/models')).status,401);
  const allowed=await (await get('/v1/models',TOKEN)).json();
  assert.deepEqual(allowed.data.map(x=>x.id),['qwen3-coder-next']);
  const owner=await (await get('/v1/models',TOKEN_ADMIN)).json();
  assert.equal(owner.data.length,2);
  assert.equal((await get('/models/unload',TOKEN_ADMIN)).status,404);
  const normal={model:'qwen3-coder-next',messages:[{role:'user',content:'hello'}],max_tokens:256};
  assert.equal((await post(normal,'invalid')).status,401);
  assert.equal((await post({...normal,model:'qwen3.8-27b-uncensored'},TOKEN)).status,403);
  assert.equal((await post({...normal,max_tokens:30001},TOKEN)).status,403);
  assert.equal((await post({...normal,max_tokens:30000},TOKEN)).status,403);
  assert.equal((await post({...normal,image_url:'http://127.0.0.1/secret'},TOKEN)).status,403);
  const allowedReply=await post(normal,TOKEN);
  assert.equal(allowedReply.status,200);
  assert.equal((await allowedReply.json()).choices[0].message.content,'OK');
  const researchReply=await post({...normal,model:'qwen3.8-27b-uncensored'},TOKEN_ADMIN);
  assert.equal(researchReply.status,200);
  assert.deepEqual(s.requests.map(x=>x.url),['/v1/chat/completions','/v1/chat/completions']);
  assert.equal(s.requests[0].body.model,'qwen3-coder-next');
 }finally{await s.close();}
});
test('A strong first-run environment API key works without a JSON key file',async()=>{
 const s=await setup();
 try{
  fs.rmSync(s.keyFile);
  const apiKey='mg_'+crypto.randomBytes(36).toString('base64url');
  process.env.MIGUY_OWNER_API_KEY=apiKey;
  delete process.env.MIGUY_ENABLE_SECOND_MODEL;
  const headers={Authorization:'Bearer '+apiKey};
  assert.equal((await fetch(s.url+'/v1/models')).status,401);
  const res=await fetch(s.url+'/v1/models',{headers});
  assert.equal(res.status,200);
  const json=await res.json();
  assert.deepEqual(json.data.map(x=>x.id),['qwen3-coder-next']);
  assert.equal((await fetch(s.url+'/models/unload',{headers})).status,404);
 }finally{delete process.env.MIGUY_OWNER_API_KEY;delete process.env.MIGUY_ENABLE_SECOND_MODEL;await s.close();}
});
