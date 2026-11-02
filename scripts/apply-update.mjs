import {cp,mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..'),target=resolve('C:/auto work/bailuwan-ai-hub-v1.1');
if(source===target)throw new Error('This updater must run from the reviewed update folder.');
const pkg=JSON.parse(await readFile(join(target,'package.json'),'utf8'));if(!pkg.version.startsWith('1.1.'))throw new Error('Expected the existing v1.1 project. No files changed.');
const requiredFiles=['backend/server.mjs','backend/llm.mjs','backend/routing.mjs','frontend/src/HubPage.jsx','dist/index.html'];for(const name of requiredFiles)await stat(join(source,name));
await stat('C:/Users/不羡Rin、/Desktop/deepseek API key.TXT');
let currentEnv='';try{currentEnv=await readFile(join(target,'.env'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
const port=Number(currentEnv.match(/^PORT\s*=\s*["']?(\d+)/m)?.[1]||8788);
const apiBase='http://127.0.0.1:'+port;
const portOpen=()=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(800);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});});
if(process.argv.includes('--dry-run')){console.log('Validated update for '+target+'; database, runtime and secrets will not be overwritten.');process.exit(0);}
const backup=join(target,'backups','before-deepseek-glass-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(backup,{recursive:true});
const stop=spawnSync('powershell.exe',['-NoProfile','-File',join(target,'scripts/stop-background.ps1')],{cwd:target,windowsHide:true,encoding:'utf8'});if(stop.status!==0)throw new Error('Stop did not succeed. Existing files preserved.');
for(let attempt=0;attempt<20&&await portOpen();attempt++)await new Promise(resolve=>setTimeout(resolve,200));
if(await portOpen())throw new Error('The old service is still listening. No project or database files were copied. Stop it from its original project and retry.');
const items=['backend','frontend','scripts','tests','docs','dist','README.md','package.json','package-lock.json','vite.config.js','.env.example','VERSION','START.cmd','START-BACKGROUND.cmd','STOP.cmd'];
for(const name of items){try{await cp(join(target,name),join(backup,name),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}}
try{await cp(join(target,'data'),join(backup,'data'),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
const envPath=join(target,'.env');let env='';try{env=await readFile(envPath,'utf8');await writeFile(join(backup,'.env'),env);}catch(e){if(e.code!=='ENOENT')throw e;}
for(const name of items)await cp(join(source,name),join(target,name),{recursive:true,force:true});
const settings={AI_MODE:'model',AI_PROVIDER:'deepseek',DEEPSEEK_BASE_URL:'https://api.deepseek.com',DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_TIMEOUT_MS:'30000',DEEPSEEK_API_KEY:'',DEEPSEEK_API_KEY_FILE:'"C:/Users/不羡Rin、/Desktop/deepseek API key.TXT"'};
for(const [name,value]of Object.entries(settings)){const lines=env.split(/\r?\n/).filter(line=>!line.startsWith(name+'='));env=lines.join('\n').replace(/\n+$/,'')+'\n'+name+'='+value+'\n';}
await writeFile(envPath,env);await stat(join(target,'backend/llm.mjs'));await stat(join(target,'dist/index.html'));
const start=await new Promise(resolve=>{const child=spawn(process.execPath,['--env-file-if-exists=.env','scripts/background.mjs'],{cwd:target,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));child.on('exit',code=>resolve(code));child.on('error',()=>resolve(1));});
if(start!==0)throw new Error('Files updated, startup needs checking: .runtime/server-error.log');
const health=await fetch(apiBase+'/api/health',{signal:AbortSignal.timeout(3000)}).then(response=>response.json());
if(health.revision!=='deepseek-glass'||health.model.provider!=='deepseek'||!health.model.configured||!health.simulator?.connected)throw new Error('Updated revision, DeepSeek config or simulator connection was not verified. Read .runtime logs.');
console.log('Applied to '+target);console.log('Backup: '+backup);console.log('Existing database preserved. API key remains in original file.');console.log('Open '+apiBase+'/ and refresh.');
