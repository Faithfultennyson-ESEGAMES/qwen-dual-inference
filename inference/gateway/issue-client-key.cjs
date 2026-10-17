'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=process.argv[2],id=process.argv[3],allow=process.argv.includes('--allow-research-model');
if(!file||!/^[a-zA-Z0-9_-]{2,60}$/.test(id||'')){
 console.error('Usage: node issue-client-key.cjs /workspace/config/inference-clients.json CLIENT_ID [--allow-research-model]');
 process.exit(2);
}
fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
let config={clients:[]};
if(fs.existsSync(file))config=JSON.parse(fs.readFileSync(file,'utf8'));
if(!Array.isArray(config.clients))throw Error('Invalid existing key store');
if(config.clients.some(c=>c.id===id))throw Error('Client ID already exists: use another ID or explicitly revoke old key');
const token='mg_'+crypto.randomBytes(36).toString('base64url');
const sha256=crypto.createHash('sha256').update(token).digest('hex');
config.clients.push({id,sha256,requestsPerMinute:12,maxOutputTokens:30000,allowUncensored:allow});
const temp=file+'.'+process.pid+'.tmp';
fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
fs.renameSync(temp,file);
fs.chmodSync(file,0o600);
console.log('CLIENT='+id);
console.log('API_KEY='+token);
console.log('IMPORTANT: save this API key in a secure password manager now. It cannot be recovered; only the hash is stored.');
console.log('KEYSTORE='+file);
