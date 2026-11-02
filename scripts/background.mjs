import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {mkdirSync,openSync,closeSync} from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const url=process.env.API_BASE||`http://127.0.0.1:${process.env.PORT||8788}`;
let online=false;
try{const health=await fetch(url+'/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());if(health.ok&&health.revision!=='deepseek-glass')throw new Error('PORT_CONFLICT');online=health.ok&&health.revision==='deepseek-glass'&&health.mode==='simulation'&&health.version==='1.1.0';}catch(e){if(e.message==='PORT_CONFLICT'){console.error('This port runs a different project revision. Stop that project before starting this one.');process.exit(1);}}
if(online){console.log(`Already online: ${url}`);}else{
  mkdirSync(join(root,'.runtime'),{recursive:true});
  const out=openSync(join(root,'.runtime/server.log'),'a'),err=openSync(join(root,'.runtime/server-error.log'),'a');
  const child=spawn(process.execPath,['--env-file-if-exists=.env',join(root,'scripts/start.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err]});
  child.on('error',e=>{console.error(e.message);process.exitCode=1;});
  child.unref();closeSync(out);closeSync(err);
  let ready=false;
  for(let attempt=0;attempt<30;attempt++){
    try{const health=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json());if(health.ok&&health.revision==='deepseek-glass'&&health.simulator?.connected){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(ready)console.log(`Background service ready. PID ${child.pid}: ${url}`);
  else {console.error('Startup could not be verified. Read .runtime/server-error.log.');process.exitCode=1;}
}
