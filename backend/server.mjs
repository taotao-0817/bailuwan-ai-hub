import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, extname, sep } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Store, digest } from './store.mjs';
import { seed } from './seed.mjs';
import { ParkService, ApiError } from './service.mjs';
import { HubService, seedHub } from './hub.mjs';
import { ModelPlanner } from './llm.mjs';

const projectRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const publicUser=u=>({id:u.id,username:u.username,name:u.name,role:u.role});
const equals=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&timingSafeEqual(x,y);};
const error=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};
function json(response,status,value,headers={}){response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});response.end(JSON.stringify(value));}
async function body(request){let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>65536)error(413,'PAYLOAD_TOO_LARGE','请求体超过 64 KB');}if(!text)return{};try{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{error(400,'INVALID_JSON','请求体必须为 JSON 对象');}}

export function createApp(options={}) {
  const dbPath=options.dbPath||process.env.DB_PATH||resolve(projectRoot,'data/park-v1.1.sqlite');
  const store=new Store(dbPath);seed(store);seedHub(store);
  const cookieName=options.cookieName||process.env.SESSION_COOKIE_NAME||'blw_session_v11';
  if(!/^[A-Za-z0-9_]{1,64}$/.test(cookieName))error(500,'CONFIG_ERROR','会话 Cookie 名称无效');
  const sessionToken=request=>{const entry=(request.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='));const token=entry?.slice(cookieName.length+1);return /^[a-f0-9]{64}$/.test(token||'')?token:null;};
  const streams=new Set();
  const service=new ParkService(store,payload=>{for(const stream of streams){try{stream.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);}catch{streams.delete(stream);}}});
  const hub=new HubService(service);
  const modelPlanner=new ModelPlanner(options.llmOptions||{});
  const canDispatch=actor=>['super_admin','park_admin','ops'].includes(actor.role);
  const deliveryPolicy=actor=>canDispatch(actor)
    ? {mode:'automatic_validation',requiresApproval:false,explicitDeliveryRequired:true,selection:'nearest_feasible_current_position',reserveBatteryPercent:20}
    : {mode:'request_then_approval',requiresApproval:true};
  function businessState(actor) {
    const state=service.bootstrap(actor);
    if(actor.role==='user')state.deliveries=state.deliveries.filter(order=>order.requesterId===actor.id);
    return state;
  }
  function hubState(actor) {
    const state=hub.bootstrap(actor);
    if(actor.role==='user'){
      state.resources=state.resources.filter(resource=>resource.kind==='space');
      state.stats.resources=state.resources.length;
      state.capabilities=[...new Set(state.resources.flatMap(resource=>resource.capabilities))];
    }
    return {...state,mode:modelPlanner.config.mode==='model'?'model_assisted':'rules_simulation',model:modelPlanner.status(),deliveryPolicy:deliveryPolicy(actor)};
  }
  const planningRequests=new Map(),modelRates=new Map();
  async function planGoal(actor,payload,request,response){
    hub.guardAutomation();
    if(payload.type)hub.authorize(actor,payload.type);
    if(typeof payload.goal!=='string'||!payload.goal.trim()||payload.goal.length>1200)error(400,'VALIDATION_ERROR','请输入最多1200字的园区任务目标');
    if(payload.idempotencyKey!==undefined&&(typeof payload.idempotencyKey!=='string'||!payload.idempotencyKey||payload.idempotencyKey.length>128))error(400,'VALIDATION_ERROR','幂等键格式无效');
    const original={goal:payload.goal,type:payload.type,params:payload.params??{}};
    const fingerprint=digest(JSON.stringify(original));const key=actor.id+':hub.request:'+(payload.idempotencyKey||randomBytes(12).toString('hex'));
    const previous=store.db.prepare('SELECT * FROM idempotency WHERE key=?').get(key);
    if(previous){if(previous.fingerprint!==fingerprint)error(409,'IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同目标');const saved=JSON.parse(previous.response);return store.get('hub_tasks',saved.id)||saved;}
    const pending=planningRequests.get(key);if(pending){if(pending.fingerprint!==fingerprint)error(409,'IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同目标');return pending.promise;}
    if(planningRequests.size>=8)error(429,'MODEL_BUSY','园区中枢当前有8个理解请求正在处理，请稍后重试',{source:'application',retryAfterSeconds:5});
    const rate=modelRates.get(actor.id)||{count:0,until:Date.now()+60000};if(Date.now()>rate.until){rate.count=0;rate.until=Date.now()+60000;}if(rate.count>=12)error(429,'MODEL_LOCAL_RATE_LIMIT','园区中枢每个账号每分钟最多提交12次理解请求，请稍后重试',{source:'application',retryAfterSeconds:Math.max(1,Math.ceil((rate.until-Date.now())/1000))});rate.count++;modelRates.set(actor.id,rate);
    const controller=new AbortController();const closed=()=>{if(!response.writableEnded)controller.abort();};response.once('close',closed);
    const promise=(async()=>{
      const parsed=await modelPlanner.interpret({...original,context:{buildings:store.all('buildings'),now:new Date().toISOString(),timeZone:'Asia/Shanghai'},signal:controller.signal});
      if(controller.signal.aborted)error(499,'CLIENT_CLOSED','请求已取消，本次未执行');
      const current=publicUser(session(request));if(current.id!==actor.id)error(401,'SESSION_EXPIRED','会话已变化，请重新登录');
      hub.guardAutomation();hub.authorize(current,parsed.type||payload.type||hub.parse(original).type);
      return store.transaction(()=>{
        const task=hub.plan(current,{
          ...original,...parsed,
          ...(payload.idempotencyKey?{idempotencyKey:payload.idempotencyKey}:{}),
          goal:original.goal,
          submittedWeight:original.params.weight??null,
          automaticDelivery:original.type==='delivery'
        });
        store.db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(key,fingerprint,JSON.stringify(task),new Date().toISOString());
        service.record(current,'model.goal_interpreted',task.id,{source:parsed.interpretation.source,model:parsed.interpretation.model,summary:parsed.interpretation.summary,requestId:parsed.interpretation.requestId,latencyMs:parsed.interpretation.latencyMs,usage:parsed.interpretation.usage,executionStatus:task.status,deliveryPolicy:task.type==='delivery'?deliveryPolicy(current).mode:undefined});
        return task;
      });
    })();planningRequests.set(key,{fingerprint,promise});
    try{return await promise;}finally{planningRequests.delete(key);response.removeListener('close',closed);}
  }
  const simulatorToken=options.simulatorToken||process.env.SIMULATOR_TOKEN||'bailuwan-local-simulator-change-me';
  const loginAttempts=new Map();
  const checkPassword=(u,password)=>{if(typeof password!=='string'||password.length>256)return false;return equals(scryptSync(password,u.salt,64).toString('hex'),u.password_hash);};
  function session(request) {
    const token=sessionToken(request);
    if(!token)error(401,'UNAUTHENTICATED','请先登录');
    const u=store.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(digest(token),Date.now());
    if(!u)error(401,'SESSION_EXPIRED','登录状态已过期，请重新登录');return u;
  }
  const server=http.createServer(async(request,response)=>{
    const requestId=randomBytes(6).toString('hex');let user=null;let pathname='';
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('X-Frame-Options','DENY');response.setHeader('Referrer-Policy','same-origin');response.setHeader('X-Request-Id',requestId);
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    try {
      const parsed=new URL(request.url,'http://localhost');pathname=parsed.pathname;
      if(!pathname.startsWith('/api/')) {
        if(!['GET','HEAD'].includes(request.method))error(405,'METHOD_NOT_ALLOWED','不支持的请求方法');
        const dist=resolve(projectRoot,'dist');let candidate=resolve(dist,`.${decodeURIComponent(pathname)}`);
        if(!candidate.startsWith(dist+sep)&&candidate!==dist)error(403,'FORBIDDEN','路径不可访问');
        if(!existsSync(candidate)||!statSync(candidate).isFile())candidate=resolve(dist,'index.html');
        if(!existsSync(candidate)){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><title>白鹭湾系统 API</title><p>后端已运行。开发界面：http://127.0.0.1:5174；生产运行请先 npm run build。</p>');return;}
        const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ico':'image/x-icon','.json':'application/json'};
        response.writeHead(200,{'Content-Type':types[extname(candidate)]||'application/octet-stream','Cache-Control':extname(candidate)==='.html'?'no-cache':'public, max-age=3600'});response.end(request.method==='HEAD'?undefined:readFileSync(candidate));return;
      }
      if(request.method==='GET'&&pathname==='/api/health'){
        const {mode,provider,configured,model,status,verified}=modelPlanner.status();
        json(response,200,{ok:true,mode:'simulation',database:'sqlite',version:'1.1.0',revision:'deepseek-glass',model:{mode,provider,configured,model,status,verified},deliveryPolicy:'role_scoped',simulator:service.simulatorStatus()});return;
      }
      if(!['GET','POST'].includes(request.method))error(405,'METHOD_NOT_ALLOWED','只支持 GET / POST');
      if(request.method==='POST'&&request.headers.origin){const allowed=new Set([`http://${request.headers.host}`,'http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:5174','http://localhost:5174',...(process.env.ALLOWED_ORIGINS||'').split(',').filter(Boolean)]);if(!allowed.has(request.headers.origin))error(403,'ORIGIN_REJECTED','请求来源不在允许范围内');}
      const payload=request.method==='POST'?await body(request):{};
      if(pathname==='/api/simulator/tick'&&request.method==='POST'){
        const remote=request.socket.remoteAddress;if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))error(403,'FORBIDDEN','模拟器仅允许本机访问');
        if(!equals(payload.token||request.headers['x-simulator-token'],simulatorToken))error(403,'SIMULATOR_UNAUTHORIZED','模拟器凭据无效');
        const result=store.transaction(()=>{const result=service.tick();hub.sync();return result;});json(response,200,result);return;
      }
      if(pathname==='/api/login'&&request.method==='POST') {
        const key=request.socket.remoteAddress;const attempts=loginAttempts.get(key)||{count:0,until:Date.now()+60000};if(Date.now()>attempts.until){attempts.count=0;attempts.until=Date.now()+60000;}if(attempts.count>=20)error(429,'RATE_LIMITED','登录尝试过多，请一分钟后重试');
        const u=typeof payload.username==='string'?store.db.prepare('SELECT * FROM users WHERE username=?').get(payload.username):null;
        if(!u||!checkPassword(u,payload.password)){attempts.count++;loginAttempts.set(key,attempts);store.audit('匿名用户','auth.login.failed','session',{username:typeof payload.username==='string'?payload.username.slice(0,80):''});error(401,'INVALID_CREDENTIALS','用户名或密码不正确');}
        loginAttempts.delete(key);store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());const token=randomBytes(32).toString('hex');store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),u.id,Date.now()+8*3600000);store.audit(u.name,'auth.login','session',{role:u.role});
        json(response,200,{user:publicUser(u)}, {'Set-Cookie':`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.COOKIE_SECURE==='true'?'; Secure':''}`});return;
      }
      user=session(request);const actor=publicUser(user);
      if(request.method==='GET') {
        if(pathname==='/api/session'){json(response,200,{user:actor});return;}
        if(pathname==='/api/bootstrap'){json(response,200,{...businessState(actor),hub:hubState(actor),version:'1.1.0'});return;}
        if(pathname==='/api/hub'){json(response,200,hubState(actor));return;}
        if(pathname==='/api/twin/snapshot'){const b=businessState(actor);json(response,200,{schemaVersion:'1.1',version:'1.1.0',at:new Date().toISOString(),coordinateSystem:'local-meters',buildings:b.buildings,devices:b.devices,alerts:b.alerts,patrols:b.patrols,deliveries:b.deliveries,hub:hubState(actor),takeover:b.takeover});return;}
        if(pathname==='/api/agent/tools'){json(response,200,service.agentTools());return;}
        if(pathname==='/api/audit/verify'){service.require(actor,'audit');json(response,200,store.verifyAudit());return;}
        if(pathname==='/api/events'){
          response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});response.write(`event: update\ndata: ${JSON.stringify({type:'connected',at:new Date().toISOString()})}\n\n`);streams.add(response);const heartbeat=setInterval(()=>{response.write(': heartbeat\n\n');},15000);request.on('close',()=>{clearInterval(heartbeat);streams.delete(response);});return;
        }
        error(404,'NOT_FOUND','接口不存在');
      }
      if(pathname==='/api/logout'){const token=sessionToken(request);if(token)store.db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));store.audit(actor,'auth.logout','session',{});json(response,200,{ok:true},{'Set-Cookie':cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;}
      const takeover=store.setting('takeover');
      if(takeover.active&&actor.role!=='super_admin'&&!pathname.startsWith('/api/agent/'))error(423,'HUMAN_TAKEOVER','当前已由最高权限管理员接管，其他角色操作已冻结');
      if(pathname==='/api/takeover'&&!checkPassword(user,payload.password))error(401,'IDENTITY_VERIFICATION_FAILED','身份确认失败，请输入当前账户密码');
      if(pathname==='/api/hub/plan'){json(response,200,await planGoal(actor,payload,request,response));return;}
      let result;
      const mutation=()=>{
        if(pathname==='/api/hub/events')return hub.event(actor,payload);
        if(pathname==='/api/commands')return service.commands(actor,payload);
        if(pathname==='/api/scenes')return service.scenes(actor,payload);
        if(pathname==='/api/patrols')return service.createPatrol(actor,payload);
        if(pathname==='/api/deliveries')return service.createDelivery(actor,payload);
        if(pathname==='/api/approvals')return service.createApproval(actor,payload);
        if(pathname==='/api/takeover')return service.takeover(actor,payload);
        if(pathname==='/api/agent/call')return service.agent(actor,payload);
        let match;
        if((match=pathname.match(/^\/api\/hub\/tasks\/([^/]+)\/action$/)))return hub.action(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/commands\/([^/]+)\/cancel$/)))return service.cancelCommand(actor,match[1]);
        if((match=pathname.match(/^\/api\/scenarios\/(security|fire)$/)))return service.scenario(actor,match[1]);
        if((match=pathname.match(/^\/api\/alerts\/([^/]+)\/transition$/)))return service.transitionAlert(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/emergency\/([^/]+)\/execute$/)))return service.emergency(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/patrols\/([^/]+)\/action$/)))return service.patrolAction(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/deliveries\/([^/]+)\/action$/)))return service.deliveryAction(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/approvals\/([^/]+)\/action$/)))return service.approvalAction(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/attendance\/([^/]+)\/review$/)))return service.reviewAttendance(actor,match[1],payload);
        if((match=pathname.match(/^\/api\/automations\/([^/]+)$/)))return service.automation(actor,match[1],payload);
        error(404,'NOT_FOUND','接口不存在');
      };
      // Agent failures intentionally persist their own failed audit/run records.
      result=pathname==='/api/agent/call'?mutation():store.transaction(mutation);
      json(response,200,result);
    }catch(e){
      const status=e instanceof ApiError?e.status:500;
      if(user&&request.method==='POST'){try{store.audit(user.name,'request.rejected',pathname,{code:e.code||'INTERNAL_ERROR',message:status===500?'内部服务异常':e.message,requestId});}catch{}}
      if(status===500)console.error(`[${requestId}] Internal error:`,e.stack);
      if(!response.headersSent)json(response,status,{error:{code:e.code||'INTERNAL_ERROR',message:status===500?'服务暂时异常，请稍后重试':e.message,...(e.details?{details:e.details}:{})},requestId});else response.end();
    }
  });
  const watchdog=setInterval(()=>{try{store.transaction(()=>{service.settleCommands(true);hub.sync();});}catch(e){console.error('Command watchdog:',e.message);}},Math.min(1000,Number(process.env.COMMAND_TIMEOUT_MS)||1000));watchdog.unref();
  return {server,store,service,modelPlanner,listen:({port=options.port||Number(process.env.PORT)||8788,host=process.env.HOST||'127.0.0.1'}={})=>new Promise((resolvePromise,reject)=>{server.once('error',reject);server.listen(port,host,()=>resolvePromise(server.address()));}),close:()=>new Promise(resolvePromise=>{clearInterval(watchdog);for(const stream of streams)stream.end();server.close(()=>{store.db.close();resolvePromise();});})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.includes('--init')){const store=new Store(process.env.DB_PATH||resolve(projectRoot,'data/park-v1.1.sqlite'));seed(store);seedHub(store);console.log('Database initialized with simulated park data.');store.db.close();}
  else{const app=createApp();app.listen().then(address=>console.log(`白鹭湾中央控制系统 API: http://127.0.0.1:${address.port} · simulation only`)).catch(e=>{console.error(e.message);process.exit(1);});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));}
}
