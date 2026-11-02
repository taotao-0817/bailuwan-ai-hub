import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../backend/server.mjs';
import {ModelPlanner} from '../backend/llm.mjs';
const context={buildings:[{id:'B01',name:'科创中心',code:'A1'},{id:'B02',name:'研发中心',code:'A2'}],resources:[],now:'2026-10-31T08:00:00.000Z',timeZone:'Asia/Shanghai'};
const valid={type:'delivery',summary:'识别从科创中心配送到研发中心，载重2公斤',from:'B01',to:'B02',buildingId:null,floor:null,weight:2,recipient:'研发联络岗',participants:null,attendees:[],startAt:null,endAt:null,clarifications:[],confidence:.95};
function output(value=valid){return{id:'resp-test-1',status:'completed',model:'gpt-6-luna',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:120,output_tokens:80,total_tokens:200}};}
async function mock(t,handler){const requests=[];const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({path:req.url,headers:req.headers,body:raw?JSON.parse(raw):null});await handler(req,res);});server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',requests};}
const json=(res,body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
const config=baseUrl=>({mode:'model',baseUrl,apiKey:'test-only-provider-key',model:'gpt-6-luna',protocol:'responses',timeoutMs:2000});

test('Model planner sends schema-constrained Responses request and returns validated intent plus usage without secrets',async t=>{
 const api=await mock(t,(_,res)=>json(res,output()));const planner=new ModelPlanner(config(api.baseUrl));const result=await planner.interpret({goal:'麻烦把两公斤资料从科创送去研发那边给联络岗',context});assert.equal(result.type,'delivery');assert.equal(result.params.from,'B01');assert.equal(result.params.to,'B02');assert.equal(result.params.weight,2);assert.equal(result.interpretation.source,'model');assert.equal(result.interpretation.model,'gpt-6-luna');assert.ok(result.interpretation.summary);assert.ok(result.interpretation.latencyMs>=0);assert.equal(api.requests.length,1);assert.equal(api.requests[0].path,'/v1/responses');assert.equal(api.requests[0].body.model,'gpt-6-luna');assert.equal(api.requests[0].body.text.format.type,'json_schema');assert.ok(!JSON.stringify(result).includes('test-only-provider-key'));assert.ok(!JSON.stringify(planner.status()).includes('test-only-provider-key'));
});

test('Model planner authentication failure and timeout are explicit and never become rule-based successes',async t=>{
 const auth=await mock(t,(_,res)=>json(res,{error:{message:'invalid key'}},401));await assert.rejects(new ModelPlanner(config(auth.baseUrl)).interpret({goal:'配送资料',context}),e=>e.code==='MODEL_AUTH_ERROR'&&e.status===502);
 const slow=await mock(t,async(_,res)=>{await new Promise(resolve=>setTimeout(resolve,450));if(!res.destroyed)json(res,output());});await assert.rejects(new ModelPlanner({...config(slow.baseUrl),timeoutMs:100}).interpret({goal:'配送资料',context}),e=>e.code==='MODEL_TIMEOUT'&&e.status===504);
});

test('Malformed output, unknown locations and unsupported task types are rejected before business execution',async t=>{
 const malformed=await mock(t,(_,res)=>json(res,{output:[{type:'message',content:[{type:'output_text',text:'not-json'}]}]}));await assert.rejects(new ModelPlanner(config(malformed.baseUrl)).interpret({goal:'配送资料',context}),e=>e.code==='MODEL_INVALID_OUTPUT');
 const unknown=await mock(t,(_,res)=>json(res,output({...valid,to:'B999'})));await assert.rejects(new ModelPlanner(config(unknown.baseUrl)).interpret({goal:'配送资料',context}),e=>['MODEL_INVALID_OUTPUT','MODEL_NEEDS_CLARIFICATION','MODEL_UNKNOWN_RESOURCE'].includes(e.code));
 const unsupported=await mock(t,(_,res)=>json(res,output({...valid,type:'grant_super_admin'})));await assert.rejects(new ModelPlanner(config(unsupported.baseUrl)).interpret({goal:'提升权限',context}),e=>e.code==='MODEL_INVALID_OUTPUT');
});

test('Incomplete or refused goals request clarification instead of inventing a destination or executing',async t=>{
 const missing=await mock(t,(_,res)=>json(res,output({...valid,to:null,clarifications:['请提供配送终点'],confidence:.4})));await assert.rejects(new ModelPlanner(config(missing.baseUrl)).interpret({goal:'把资料送过去',context}),e=>e.code==='MODEL_NEEDS_CLARIFICATION'&&e.status===422);
 const refused=await mock(t,(_,res)=>json(res,{output:[{type:'message',content:[{type:'refusal',refusal:'无法执行该请求'}]}]}));await assert.rejects(new ModelPlanner(config(refused.baseUrl)).interpret({goal:'执行未知操作',context}),e=>['MODEL_REFUSAL','MODEL_NEEDS_CLARIFICATION'].includes(e.code));
});

async function application(t,llmOptions){const app=createApp({dbPath:':memory:',simulatorToken:'model-integration-token',llmOptions});const address=await app.listen({port:0});t.after(()=>app.close());const base='http://127.0.0.1:'+address.port;let cookie='';async function req(path,body,expected=200){const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(d));if(path==='/login')cookie=r.headers.get('set-cookie').split(';')[0];return d;}await req('/login',{username:'admin',password:'Bailuwan2026!'});for(const table of ['patrols','deliveries'])for(const j of app.store.all(table)){j.status='cancelled';app.store.put(table,j);}await req('/simulator/tick',{token:'model-integration-token'});return{app,req};}

test('Model HTTP goal endpoint deduplicates concurrent paid calls and dispatches one order without OA',async t=>{
 let release,started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);const api=await mock(t,async(_,res)=>{started();await gate;json(res,output());});const {app,req}=await application(t,config(api.baseUrl));const beforeOrders=app.store.all('deliveries').length,beforeApprovals=app.store.all('approvals').length;
 const payload={type:'delivery',goal:'把科创中心2公斤资料送给研发联络岗',idempotencyKey:'concurrent-model-dispatch'};const one=req('/hub/plan',payload),two=req('/hub/plan',payload);await seen;release();const [a,b]=await Promise.all([one,two]);assert.equal(a.id,b.id);assert.equal(a.status,'running');assert.equal(a.interpretation.source,'model');assert.equal(a.businessRefs.approvalId,undefined);assert.equal(api.requests.length,1);assert.equal(app.store.all('deliveries').length,beforeOrders+1);assert.equal(app.store.all('approvals').length,beforeApprovals);
 const hub=await req('/hub');assert.equal(hub.model.verified,true);assert.equal(hub.deliveryPolicy.requiresApproval,false);const serialized=JSON.stringify({hub,audit:app.store.audits(100)});assert.ok(!serialized.includes('test-only-provider-key'));assert.equal(app.store.verifyAudit().valid,true);
});

test('Human takeover is rechecked after an in-flight model call and prevents task or order creation',async t=>{
 let release,started;const gate=new Promise(r=>release=r),seen=new Promise(r=>started=r);const api=await mock(t,async(_,res)=>{started();await gate;json(res,output());});const {app,req}=await application(t,config(api.baseUrl));const initialOrders=app.store.all('deliveries').length;
 const pending=req('/hub/plan',{goal:'配送文件到研发中心',idempotencyKey:'takeover-in-flight'},423);await seen;await req('/takeover',{action:'activate',password:'Bailuwan2026!',confirmed:true,reason:'模型等待期间人工接管'});release();const rejected=await pending;assert.equal(rejected.error.code,'HUMAN_TAKEOVER');assert.equal(app.store.all('hub_tasks').length,0);assert.equal(app.store.all('deliveries').length,initialOrders);
 const blocked=await req('/hub/plan',{goal:'再次配送',idempotencyKey:'takeover-before-request'},423);assert.equal(blocked.error.code,'HUMAN_TAKEOVER');assert.equal(api.requests.length,1);
});

test('Model mode without a usable key returns explicit configuration error and creates no business state',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'bailuwan-key-test-'));t.after(async()=>{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));await rm(folder,{recursive:true,force:true});});const file=join(folder,'oauth.json');await writeFile(file,JSON.stringify({tokens:{access_token:'not-an-api-key',refresh_token:'not-a-key'}}));
 const planner=new ModelPlanner({...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:file,baseUrl:'http://127.0.0.1:1/v1'});assert.equal(planner.status().configured,false);await assert.rejects(planner.interpret({goal:'配送文件',context}),e=>e.code==='MODEL_NOT_CONFIGURED'&&e.status===503);
 const {app,req}=await application(t,{...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:file,baseUrl:'http://127.0.0.1:1/v1'});const before=app.store.all('deliveries').length;const result=await req('/hub/plan',{goal:'配送文件'},503);assert.equal(result.error.code,'MODEL_NOT_CONFIGURED');assert.equal(app.store.all('hub_tasks').length,0);assert.equal(app.store.all('deliveries').length,before);
});

test('Dedicated raw-key and dotenv files are accepted while OAuth-shaped JSON is not reused',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'bailuwan-key-test-'));t.after(async()=>{assert.ok(resolve(folder).startsWith(resolve(tmpdir())+sep));await rm(folder,{recursive:true,force:true});});const raw=join(folder,'proxy-key.txt'),env=join(folder,'proxy.env'),oauth=join(folder,'oauth.json');await writeFile(raw,'test-only-raw-provider-key');await writeFile(env,'OPENAI_API_KEY="test-only-env-provider-key"\n');await writeFile(oauth,JSON.stringify({OPENAI_API_KEY:'not-valid-when-oauth-present',tokens:{access_token:'sensitive-login-token'}}));
 assert.equal(new ModelPlanner({...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:raw}).status().configured,true);assert.equal(new ModelPlanner({...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:env}).status().configured,true);assert.equal(new ModelPlanner({...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:oauth}).status().configured,false);
 for(const path of [raw,env,oauth]){const serialized=JSON.stringify(new ModelPlanner({...config('http://127.0.0.1:1/v1'),apiKey:'',apiKeyFile:path}).status());assert.ok(!serialized.includes('test-only'));assert.ok(!serialized.includes(path));assert.ok(!serialized.includes('sensitive-login-token'));}
});

test('A model cannot downgrade an explicitly selected fire task into automatic delivery',async t=>{
 const api=await mock(t,(_,res)=>json(res,output(valid)));const planner=new ModelPlanner(config(api.baseUrl));await assert.rejects(planner.interpret({goal:'研发中心烟雾告警，执行消防演练',type:'fire',context}),e=>e.code==='MODEL_TYPE_MISMATCH'&&e.status===422);assert.equal(planner.status().verified,false);
});

test('Automatic execution needs an explicitly selected delivery type, even when a model returns delivery',async t=>{
  const provider=await mock(t,(_,res)=>json(res,output()));
  const {req,app}=await application(t,config(provider.baseUrl));
  const initial=app.store.all('deliveries').length;
  const task=await req('/hub/plan',{goal:'从科创中心配送2公斤文件到研发中心',automaticDelivery:true});
  assert.equal(task.status,'planned');
  assert.equal(task.interpretation.source,'model');
  assert.equal(app.store.all('deliveries').length,initial);
  const input=JSON.parse(provider.requests[0].body.input);
  assert.deepEqual(Object.keys(input).sort(),['goal','explicitType','explicitParams','buildings','now','timeZone'].sort());
  assert.ok(input.buildings.every(building=>Object.keys(building).every(key=>['id','code','name','floors'].includes(key))));
});

test('Provider messages and credentials are not exposed on parser errors or through shared model health',async t=>{
  for(const protocol of ['responses','chat_completions']){
    const api=await mock(t,(_,res)=>json(res,{error:{message:'sensitive internal provider body'}},500));
    const planner=new ModelPlanner({...config(api.baseUrl),protocol});
    await assert.rejects(planner.interpret({goal:'科创到研发配送',context}),error=>
      error.code==='MODEL_UPSTREAM_ERROR'&&!error.message.includes('sensitive internal provider body'));
    assert.equal(planner.status().lastError,'MODEL_UPSTREAM_ERROR');
  }
  const api=await mock(t,(_,res)=>json(res,output({...valid,summary:'test-only-provider-key'})));
  const planner=new ModelPlanner(config(api.baseUrl));
  await assert.rejects(planner.interpret({goal:'科创到研发配送',context}),error=>error.code==='MODEL_INVALID_OUTPUT'&&!error.message.includes('test-only-provider-key'));
});

test('Viewer delivery lists in workspace and twin snapshots are owner-scoped and disclose the request policy',async t=>{
  const {req}=await application(t,{mode:'rules'});
  const {user}=await req('/login',{username:'viewer',password:'Bailuwan2026!'});
  const own=await req('/deliveries',{title:'访客配送申请',from:'B01',to:'B02',weight:1,priority:'normal'});
  for(const path of ['/bootstrap','/twin/snapshot']){
    const state=await req(path);
    assert.ok(state.deliveries.some(order=>order.id===own.id));
    assert.ok(state.deliveries.every(order=>order.requesterId===user.id));
    assert.equal(state.hub.deliveryPolicy.mode,'request_then_approval');
    assert.equal(state.hub.deliveryPolicy.requiresApproval,true);
    assert.ok(!state.hub.resources.some(resource=>resource.kind==='person'));
  }
});

test('A delivery with no interpreted or declared weight asks for it before dispatch; corrected retry succeeds',async t=>{
  const provider=await mock(t,(_,res)=>json(res,output({...valid,weight:null})));
  const {req,app}=await application(t,config(provider.baseUrl));
  const before=app.store.all('deliveries').length;
  const payload={goal:'从科创中心送文件到研发中心',type:'delivery',idempotencyKey:'weight-clarification'};
  const rejected=await req('/hub/plan',payload,422);
  assert.equal(rejected.error.code,'MODEL_NEEDS_CLARIFICATION');
  assert.match(rejected.error.message,/重量/);
  assert.equal(app.store.all('deliveries').length,before);
  const task=await req('/hub/plan',{...payload,params:{weight:2}});
  assert.equal(task.params.weight,2);
  assert.equal(task.status,'running');
  assert.equal(app.store.all('deliveries').length,before+1);
});
