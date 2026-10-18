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
 const statuses=new Map([
  ['qwen3.8-27b-uncensored','unloaded'],
  ['qwen3.6-35b-a3b','unloaded']
 ]);
 const mock=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const parsed=body?JSON.parse(body):{};
  res.writeHead(200,{'Content-Type':'application/json'});
  if(req.method==='GET'&&req.url==='/models'){
   res.end(JSON.stringify({data:[...statuses.entries()].map(([id,value])=>({id,status:{value}}))}));return;
  }
  if(req.method==='POST'&&req.url==='/models/unload'){statuses.set(parsed.model,'unloaded');res.end('{"success":true}');return;}
  if(req.method==='POST'&&req.url==='/models/load'){
   for(const id of statuses.keys())statuses.set(id,id===parsed.model?'loaded':'unloaded');
   res.end('{"success":true}');return;
  }
  requests.push({url:req.url,body:parsed});
  res.end(JSON.stringify({id:'response-1',choices:[{message:{role:'assistant',content:'OK'}}]}));
 });
 mock.listen(0,'127.0.0.1');await once(mock,'listening');
 process.env.MIGUY_GATEWAY_KEYS_FILE=config;process.env.MIGUY_GATEWAY_PORT='0';
 process.env.MIGUY_MODEL_CATALOG_FILE=path.join(dir,'ready-models.json');
 fs.writeFileSync(process.env.MIGUY_MODEL_CATALOG_FILE,JSON.stringify({version:2,ready:['qwen3.8-27b-uncensored','qwen3.6-35b-a3b']}));
 process.env.MIGUY_APPROVE_COMMUNITY_VARIANT='1';
 process.env.MIGUY_INFERENCE_UPSTREAM='http://127.0.0.1:'+mock.address().port;
 delete require.cache[require.resolve('./server.cjs')]; // each mocked gateway binds its own temporary credential file
 const {server}=require('./server.cjs');
 const gateway=server();await once(gateway,'listening');
 const url='http://127.0.0.1:'+gateway.address().port;
 return {url,requests,keyFile:config,catalogFile:process.env.MIGUY_MODEL_CATALOG_FILE,async close(){await new Promise(r=>gateway.close(r));await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('Gateway enforces Bearer API keys, per-client model ACL, bounded output, no router controls',async()=>{
 const s=await setup();
 try{
  const get=(path,key='')=>fetch(s.url+path,{headers:key?{Authorization:'Bearer '+key}:{}});
  const post=(body,key)=>fetch(s.url+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await get('/health')).status,200);
  assert.equal((await get('/v1/models')).status,401);
  const allowed=await (await get('/v1/models',TOKEN)).json();
  assert.deepEqual(allowed.data.map(x=>x.id),['qwen3.6-35b-a3b']);
  const owner=await (await get('/v1/models',TOKEN_ADMIN)).json();
  assert.equal(owner.data.length,2);
  assert.equal((await get('/models/unload',TOKEN_ADMIN)).status,404);
  const normal={model:'qwen3.6-35b-a3b',messages:[{role:'user',content:'hello'}],max_tokens:256};
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
  assert.equal(s.requests[0].body.model,'qwen3.6-35b-a3b');
 }finally{await s.close();}
});
test('Progressive readiness: first vision model becomes available, refresh reveals second; removed Coder-Next cannot be selected',async()=>{
 const s=await setup();
 try{
  const headers={Authorization:'Bearer '+TOKEN_ADMIN};
  const setReady=ids=>fs.writeFileSync(s.catalogFile,JSON.stringify({version:2,ready:ids}));
  const list=async()=>(await (await fetch(s.url+'/v1/models',{headers})).json()).data;
  setReady(['qwen3.8-27b-uncensored']);
  assert.deepEqual((await list()).map(m=>m.id),['qwen3.8-27b-uncensored']);
  assert.equal((await list())[0].capabilities.vision,true);
  setReady(['qwen3.8-27b-uncensored','qwen3.6-35b-a3b']);
  assert.deepEqual((await list()).map(m=>m.id),['qwen3.8-27b-uncensored','qwen3.6-35b-a3b']);
  assert.equal((await list()).length,2);
  const tinyPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9ewAAAABJRU5ErkJggg==';
  const request=async(model,uri)=>fetch(s.url+'/v1/chat/completions',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:[{type:'text',text:'Read screenshot'},{type:'image_url',image_url:{url:uri}}]}],max_tokens:128})});
  assert.equal((await request('qwen3.8-27b-uncensored',tinyPng)).status,200);
  assert.equal((await request('qwen3.6-35b-a3b',tinyPng)).status,200);
  assert.equal((await request('qwen3-coder-next',tinyPng)).status,403);
  assert.equal((await request('qwen3.6-35b-a3b','https://example.com/secret.png')).status,403);
  assert.equal((await request('qwen3.6-35b-a3b','file:///etc/passwd')).status,403);
  assert.equal(s.requests.length,2,'Only matching vision models may forward inline screenshot data');
 }finally{await s.close();}
});
test('More than 64 native function definitions work, with bounded schema checks and no arbitrary control endpoints',async()=>{
 const s=await setup();
 try{
  const base={model:'qwen3.6-35b-a3b',messages:[{role:'user',content:'Use any relevant authorized tool.'}],max_tokens:256,tool_choice:'auto'};
  const tools=Array.from({length:80},(_,i)=>({type:'function',function:{name:'miguy_tool_'+i,description:'Fixture '+i,parameters:{type:'object',properties:{id:{type:'string'}}}}}));
  const post=async body=>fetch(s.url+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const accepted=await post({...base,tools});
  assert.equal(accepted.status,200,'All 80 MIGuy tools should be forwarded, not rejected or truncated');
  assert.equal(s.requests[0].body.tools.length,80);
  assert.deepEqual(s.requests[0].body.tools.map(x=>x.function.name),tools.map(x=>x.function.name));
  const max256=Array.from({length:256},(_,i)=>({type:'function',function:{name:'f'+i,description:'Fixture',parameters:{type:'object'}}}));
  assert.equal((await post({...base,tools:max256})).status,200,'Support up to 256 tools');
  assert.equal((await post({...base,tools:[...max256,{type:'function',function:{name:'extra',description:'Fixture',parameters:{type:'object'}}}]})).status,403);
  assert.equal((await post({...base,tools:[tools[0],tools[0]]})).status,403,'Duplicates must be rejected');
  const invalidTool={type:'function',function:{name:'invalid',description:'test',parameters:{type:'string'}}};
  assert.equal((await post({...base,tools:[invalidTool]})).status,403,'Malformed schema must be rejected');
  assert.equal((await fetch(s.url+'/models/unload',{headers:{Authorization:'Bearer '+TOKEN}})).status,404,'No admin endpoints exposed');
 }finally{await s.close();}
});
test('A strong first-run environment API key works without a JSON key file',async()=>{
 const s=await setup();
 try{
  fs.rmSync(s.keyFile);
  const apiKey='mg_'+crypto.randomBytes(36).toString('base64url');
  process.env.MIGUY_OWNER_API_KEY=apiKey;
  delete process.env.MIGUY_APPROVE_COMMUNITY_VARIANT;
  const headers={Authorization:'Bearer '+apiKey};
  assert.equal((await fetch(s.url+'/v1/models')).status,401);
  const res=await fetch(s.url+'/v1/models',{headers});
  assert.equal(res.status,200);
  const json=await res.json();
  assert.deepEqual(json.data.map(x=>x.id),['qwen3.6-35b-a3b']);
  assert.equal((await fetch(s.url+'/models/unload',{headers})).status,404);
 }finally{delete process.env.MIGUY_OWNER_API_KEY;delete process.env.MIGUY_APPROVE_COMMUNITY_VARIANT;await s.close();}
});
