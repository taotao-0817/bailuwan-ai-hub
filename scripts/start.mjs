import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {...process.env, PORT:process.env.PORT||'8788', DB_PATH:process.env.DB_PATH||'./data/park-v1.1.sqlite', API_BASE:process.env.API_BASE || `http://127.0.0.1:${process.env.PORT || '8788'}`, SIMULATOR_TOKEN:process.env.SIMULATOR_TOKEN || crypto.randomBytes(32).toString('hex')};
const children=[];
const startedAt=new Date().toISOString();
function persist(){mkdirSync(path.join(root,'.runtime'),{recursive:true});writeFileSync(path.join(root,'.runtime/processes.json'),JSON.stringify({root,startedAt,parent:process.pid,children:children.map(p=>p.pid),url:env.API_BASE},null,2));}
function run(file){const p=spawn(process.execPath,[path.join(root,file)],{cwd:root,env,stdio:'inherit',windowsHide:true});children.push(p);persist();p.on('error',e=>{console.error(e.message);stop(1);});p.on('exit',(code)=>{if(!stopping){console.error(`子服务退出: ${file} (${code})`);stop(code||1);}});}
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;children.forEach(p=>p.kill());process.exitCode=code;}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());process.on('exit',()=>children.forEach(p=>p.kill()));
run('backend/server.mjs');run('backend/simulator.mjs');
