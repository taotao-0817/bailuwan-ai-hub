// Isolated, opt-in local UI preview. Never loads .env or sends goals to a model.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdirSync,openSync,closeSync,existsSync} from 'node:fs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const url='http://127.0.0.1:8801';
const runtime=join(root,'.runtime','merged-ui-20261031');
async function health(){try{return await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)}).then(response=>response.ok?response.json():null);}catch{return null;}}
const current=await health();
if(current?.ok&&current.revision==='role-ui-auto-delivery'){
  console.log(`Preview already running: ${url}/#page=home&view=home`);
  if(!current.simulator?.connected)console.warn('Simulator is disconnected. Stop this project using STOP.cmd, then launch the preview again.');
}else if(current){
  console.error('Port 8801 is in use by a different service. No process was stopped.');process.exitCode=1;
}else if(!existsSync(join(root,'dist','index.html'))){
  console.error('Build missing. Run npm run build first, or use PREVIEW.cmd.');process.exitCode=1;
}else{
  mkdirSync(runtime,{recursive:true});
  const output=openSync(join(runtime,'preview.log'),'a'),error=openSync(join(runtime,'preview-error.log'),'a');
  const child=spawn(process.execPath,[join(root,'scripts','start.mjs')],{
    cwd:root,detached:true,windowsHide:true,stdio:['ignore',output,error],
    env:{...process.env,PORT:'8801',API_BASE:url,DB_PATH:join(runtime,'review.sqlite'),AI_MODE:'rules',SESSION_COOKIE_NAME:'blw_merge_review'}
  });
  child.on('error',err=>{console.error(err.message);process.exitCode=1;});
  child.unref();closeSync(output);closeSync(error);
  let ready=false;
  for(let attempt=0;attempt<45;attempt++){
    const status=await health();
    if(status?.ok&&status.revision==='role-ui-auto-delivery'&&status.simulator?.connected){ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(ready)console.log(`Preview ready: ${url}/#page=home&view=home`);
  else{console.error('Preview startup not verified. See .runtime/merged-ui-20261031/preview-error.log.');process.exitCode=1;}
}
