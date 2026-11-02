import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const children=[spawn(process.execPath,['--env-file-if-exists=.env','scripts/start.mjs'],{cwd:root,stdio:'inherit',windowsHide:true}),spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--configLoader','native'],{cwd:root,stdio:'inherit',windowsHide:true})];
let stopping=false;function stop(){if(stopping)return;stopping=true;children.forEach(p=>p.kill());}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('exit',stop);children.forEach(p=>p.on('exit',()=>stop()));
