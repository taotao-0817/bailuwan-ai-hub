import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/server.mjs';

async function fixture(t){
  const app=createApp({dbPath:':memory:',simulatorToken:'hub-test-token',llmOptions:{mode:'rules'}});
  const address=await app.listen({port:0});
  t.after(()=>app.close());
  const base='http://127.0.0.1:'+address.port,cookies=new Map();
  async function req(path,body,user='admin',expected=200){
    const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookies.has(user)?{cookie:cookies.get(user)}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const d=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(d));return d;
  }
  for(const username of ['admin','park','security','ops','approver','viewer']){const r=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'Bailuwan2026!'})});assert.equal(r.status,200);cookies.set(username,r.headers.get('set-cookie').split(';')[0]);}
  for(const table of ['patrols','deliveries'])for(const job of app.store.all(table)){job.status='cancelled';app.store.put(table,job);}
  const tick=()=>req('/simulator/tick',{token:'hub-test-token'});
  await tick();
  const action=(id,action,note='集成测试人工核验与执行反馈',user='admin',expected=200)=>req('/hub/tasks/'+id+'/action',{action,note},user,expected);
  return{app,req,tick,action};
}

test('Hub registry derives capabilities and current availability, protects task context and exposes unified twin state',async t=>{
  const {app,req}=await fixture(t);
  const hub=await req('/hub');assert.equal(hub.version,'1.1.0');assert.ok(hub.resources.some(r=>r.kind==='space'));assert.ok(hub.resources.some(r=>r.kind==='person'));assert.ok(hub.resources.some(r=>r.capabilities.includes('deliver')));
  const low=hub.resources.find(r=>r.sourceId==='UAV-02');assert.equal(low.status,'low_battery');
  const secret=await req('/hub/events',{type:'fall',buildingId:'B07',note:'仅授权岗位可见的测试事件'});assert.ok(secret.id);
  const viewer=await req('/hub',undefined,'viewer');assert.equal(viewer.tasks.length,0);assert.equal(viewer.notifications.length,0);assert.ok(!JSON.stringify(viewer).includes('仅授权岗位可见'));
  const twin=await req('/twin/snapshot');assert.equal(twin.schemaVersion,'1.1');assert.ok(twin.hub.tasks.some(x=>x.id===secret.id));assert.ok(twin.devices.length>80);
  const d=app.store.get('devices','DLV-01');d.status='offline';app.store.put('devices',d);assert.equal((await req('/hub')).resources.find(r=>r.sourceId==='DLV-01').status,'offline');
});

test('Explicit delivery action dispatches automatically without OA, remains idempotent, and awaits human handover',async t=>{
  const {app,req,tick,action}=await fixture(t);const body={goal:'请把2公斤资料从智慧运营中心配送到生态会客厅，交给运营值班员',type:'delivery',idempotencyKey:'delivery-plan-1'};
  const beforeApprovals=app.store.all('approvals').length,beforeOrders=app.store.all('deliveries').length;
  const p=await req('/hub/plan',body);assert.equal(p.type,'delivery');assert.equal(p.params.from,'B03');assert.equal(p.params.to,'B06');assert.equal(p.params.weight,2);assert.equal(p.params.recipient,'运营值班员');assert.equal(p.status,'running');assert.ok(p.selection[0].reason);assert.equal((await req('/hub/plan',body)).id,p.id);
  const deliveryId=p.businessRefs.deliveryId;assert.ok(deliveryId);assert.equal(p.businessRefs.approvalId,undefined);assert.equal(app.store.all('approvals').length,beforeApprovals);assert.equal(app.store.all('deliveries').length,beforeOrders+1);
  await action(p.id,'complete','不得提前签收','admin',409);
  for(let i=0;i<20;i++)await tick();let d=(await req('/hub')).tasks.find(x=>x.id===p.id);assert.equal(d.status,'waiting_human');
  d=await action(p.id,'complete');assert.equal(d.status,'completed');assert.equal((await req('/bootstrap')).deliveries.find(x=>x.id===deliveryId).status,'archived');
  await action(p.id,'start','重复启动应失败','admin',409);
});

test('Inferred deliveries require dispatcher confirmation even if the client spoofs dispatch flags',async t=>{
  const {app,req,action}=await fixture(t);
  const count=app.store.all('deliveries').length;
  const goal='请从科创中心配送八公斤资料到企业服务中心';
  const preview=await req('/hub/plan',{goal,source:'hub',automaticDelivery:true},'ops');
  assert.equal(preview.status,'planned');
  assert.equal(preview.params.weight,8);
  assert.equal(app.store.get('devices',preview.selection[0].resourceId.replace('device:','')).type,'delivery_robot');
  assert.equal((await action(preview.id,'replan','核对可用设备','ops')).status,'planned');
  assert.equal(app.store.all('deliveries').length,count);
  for(const role of ['viewer','approver','security']){
    await req('/hub/plan',{goal,type:'delivery',automaticDelivery:true},role,403);
    await action(preview.id,'start','禁止代调度',role,403);
  }
  const started=await action(preview.id,'start','起终点已核对','ops');
  assert.equal(started.status,'running');
  assert.equal(app.store.get('deliveries',started.businessRefs.deliveryId).source,'hub');
  assert.equal(app.store.all('deliveries').length,count+1);
});

test('Legacy hub orders keep their approval and start only after that approval is granted',async t=>{
  const {app,req,action}=await fixture(t);
  const pending=await req('/deliveries',{title:'旧申请',from:'B01',to:'B04',weight:1},'viewer');
  const plan=await req('/hub/plan',{goal:'从科创中心配送两公斤资料到企业服务中心'});
  plan.businessRefs={deliveryId:pending.id,approvalId:pending.approvalId};
  plan.status='awaiting_approval';
  app.store.put('hub_tasks',plan);
  const blocked=await action(plan.id,'start','尝试调度','admin',409);
  assert.equal(blocked.error.code,'APPROVAL_REQUIRED');
  assert.equal(app.store.get('approvals',pending.approvalId).status,'pending');
  await req('/approvals/'+pending.approvalId+'/action',{action:'approve',note:'已核对'},'approver');
  const running=await action(plan.id,'start','调度已批准运单','ops');
  assert.equal(running.status,'running');
  assert.equal(running.businessRefs.approvalId,pending.approvalId);
});

test('Unavailable delivery resources produce persisted blocked plans and replan uses fresh availability without duplicate orders',async t=>{
  const {app,req,action}=await fixture(t);
  for(const d of app.store.all('devices').filter(d=>['drone','delivery_robot'].includes(d.type))){d.status='offline';app.store.put('devices',d);}
  const before=app.store.all('deliveries').length;
  const blocked=await req('/hub/plan',{goal:'从科创中心配送资料到企业服务中心',type:'delivery',params:{from:'B01',to:'B04',weight:1}});assert.equal(blocked.status,'blocked');assert.ok(blocked.error);assert.ok(blocked.candidates.every(c=>!c.eligible));assert.equal(app.store.all('deliveries').length,before);
  const reverse=await req('/hub/plan',{goal:'把500克资料送到研发中心，从智慧运营中心出发'});assert.equal(reverse.params.from,'B03');assert.equal(reverse.params.to,'B02');assert.equal(reverse.params.weight,.5);
  for(const weight of ['','1至2公斤','几公斤']){
    const missing=await req('/hub/plan',{goal:'从科创中心配送'+weight+'资料到企业服务中心',type:'delivery'},'admin',400);
    assert.equal(missing.error.code,'WEIGHT_REQUIRED');
  }
  const unknown=await req('/hub/plan',{goal:'帮我做点事情'},'admin',400);assert.ok(unknown.error.code);
  await req('/hub/plan',{goal:'配送资料到不存在的区域',type:'delivery'},'admin',400);
  const available=app.store.get('devices','DLV-01');
  available.status='online';available.state.battery=95;app.store.put('devices',available);
  assert.equal((await action(blocked.id,'replan')).status,'planned');
  assert.equal(app.store.all('deliveries').length,before);
  assert.equal((await action(blocked.id,'start')).status,'running');
  assert.equal(app.store.all('deliveries').length,before+1);
});

test('Patrol uses the shared resource registry and follows legacy simulator completion',async t=>{
  const {req,tick,action}=await fixture(t);const p=await req('/hub/plan',{goal:'巡检低碳能源站',type:'patrol',params:{buildingId:'B08'}},'security');assert.equal(p.params.buildingId,'B08');assert.ok(p.requiredCapabilities.includes('inspect'));
  let task=await action(p.id,'start','巡检路线核验','security');assert.equal(task.status,'running');const legacy=task.businessRefs.patrolId;
  await action(p.id,'pause','暂停','security');assert.equal((await req('/hub')).tasks.find(x=>x.id===p.id).status,'paused');await action(p.id,'resume','恢复','security');
  for(let i=0;i<11;i++)await tick();task=(await req('/hub')).tasks.find(x=>x.id===p.id);assert.equal(task.status,'completed');assert.equal((await req('/bootstrap')).patrols.find(x=>x.id===legacy).status,'completed');
});

test('Meeting booking rechecks capacity and overlapping slots and permits safe cancellation by owner',async t=>{
  const {app,req,action}=await fixture(t);const startAt=new Date(Date.now()+86400000).toISOString(),endAt=new Date(Date.now()+90000000).toISOString();
  const b={goal:'安排8人会议',type:'meeting',params:{buildingId:'B01',participants:8,startAt,endAt,attendees:['研发联络岗','运营联络岗']}};
  const first=await req('/hub/plan',b,'viewer'),second=await req('/hub/plan',b,'viewer');let task=await action(first.id,'start','确认会议','viewer');assert.equal(task.status,'completed');assert.ok(task.businessRefs.bookingId);assert.equal(app.store.all('notifications').filter(n=>n.taskId===first.id).length,2);
  const conflict=await action(second.id,'start','时间冲突','viewer');assert.equal(conflict.status,'blocked');assert.ok(conflict.candidates.some(c=>c.reasons.some(s=>s.includes('预订'))));assert.equal(app.store.all('bookings').length,1);
  await action(first.id,'cancel','会议取消','viewer');assert.equal(app.store.all('bookings')[0].status,'cancelled');const replanned=await action(second.id,'replan','重新匹配','viewer');assert.equal(replanned.status,'planned');assert.equal((await action(second.id,'start','确认时段','viewer')).status,'completed');
});

test('Fire event is dynamic, rejection keeps the alert open, and confirmation waits for device receipts before closure',async t=>{
  const {app,req,tick,action}=await fixture(t);let task=await req('/hub/events',{type:'fire',buildingId:'B06',floor:2,note:'二层烟温异常演练'});assert.equal(task.origin,'event');assert.equal(task.status,'awaiting_confirmation');assert.equal(app.store.all('commands').length,0);assert.equal(app.store.get('alerts',task.businessRefs.alertId).buildingId,'B06');
  await action(task.id,'confirm','运维无权确认','ops',403);await action(task.id,'reject','人工核验后拒绝联动');assert.equal(app.store.all('commands').length,0);assert.equal(app.store.get('alerts',task.businessRefs.alertId).status,'detected');
  task=await req('/hub/events',{type:'fire',buildingId:'B04',floor:2,note:'另一位置消防演练'});task=await action(task.id,'confirm','已核验联动影响范围');assert.equal(task.status,'running');await action(task.id,'complete','未收到回执','admin',409);await tick();task=(await req('/hub')).tasks.find(x=>x.id===task.id);assert.equal(task.status,'waiting_human');task=await action(task.id,'complete','照明新风回执与模拟现场结果已复核');assert.equal(task.status,'completed');await tick();assert.equal(app.store.get('alerts',task.businessRefs.alertId).status,'archived');assert.ok(app.store.all('devices').filter(d=>d.type==='sensor'&&d.buildingId==='B04').every(d=>d.status==='online'));
});

test('Fall assistance coordinates job resources and requires explicit human resolution, without simulated arrival claims',async t=>{
  const {app,req,action}=await fixture(t);let task=await req('/hub/events',{type:'fall',buildingId:'B07',floor:3,note:'演练：人员跌倒线索'});assert.equal(task.status,'awaiting_confirmation');assert.ok(task.selection.some(s=>s.resourceId.startsWith('person:')));task=await action(task.id,'confirm','人工确认现场协助方案');assert.equal(task.status,'waiting_human');assert.equal(app.store.all('commands').length,0);assert.ok(app.store.all('notifications').every(n=>n.channel==='in_app_simulation'));task=await action(task.id,'complete','现场岗位反馈已到场核验，完成模拟协助');assert.equal(task.status,'completed');assert.equal(app.store.get('alerts',task.businessRefs.alertId).status,'archived');assert.ok(task.timeline.some(t=>t.action==='completed'));
});

test('Takeover blocks new hub execution and device failure propagates to hub without false completion',async t=>{
  const {app,req,tick,action}=await fixture(t);const p=await req('/hub/plan',{goal:'巡检研发中心'});await tick();await req('/takeover',{action:'activate',password:'Bailuwan2026!',confirmed:true,reason:'测试中枢接管门禁'});await action(p.id,'start','接管期间不执行','admin',423);await req('/takeover',{action:'release',password:'Bailuwan2026!',confirmed:true});
  let fire=await req('/hub/events',{type:'fire',buildingId:'B03',floor:1,note:'模拟回执失败'});const light=app.store.all('devices').find(d=>d.type==='light'&&d.buildingId==='B03');light.state.simulateFailure=true;app.store.put('devices',light);fire=await action(fire.id,'confirm','演练故障回执');await tick();fire=(await req('/hub')).tasks.find(x=>x.id===fire.id);assert.equal(fire.status,'failed');assert.notEqual(fire.progress,100);assert.equal(app.store.get('alerts',fire.businessRefs.alertId).status,'dispatched');const audit=await req('/audit/verify');assert.equal(audit.valid,true);
});

test('Fire plan refuses empty device capability and meeting execution refuses expired reservation time',async t=>{
 const {app,req,action}=await fixture(t);for(const d of app.store.all('devices').filter(d=>d.type==='hvac'&&d.buildingId==='B08')){d.status='offline';app.store.put('devices',d);}
 const fire=await req('/hub/events',{type:'fire',buildingId:'B08',floor:1,note:'无联动能力演练'});assert.equal(fire.status,'blocked');assert.ok(fire.error);assert.equal(app.store.all('commands').length,0);
 const empty=await req('/hub/plan',{goal:'为运营联络岗安排8人会议',type:'meeting',params:{participants:8,startAt:new Date(Date.now()+172800000).toISOString(),endAt:new Date(Date.now()+176400000).toISOString(),attendees:[]}});assert.deepEqual(empty.params.attendees,['运营联络岗']);await action(empty.id,'start');assert.equal(app.store.all('notifications').filter(n=>n.taskId===empty.id).length,1);
 const startAt=new Date(Date.now()+10000).toISOString(),endAt=new Date(Date.now()+3600000).toISOString();const m=await req('/hub/plan',{goal:'安排8人会议',type:'meeting',params:{participants:8,startAt,endAt}});m.params.startAt=new Date(Date.now()-1000).toISOString();app.store.put('hub_tasks',m);await action(m.id,'start','过期会议不创建','admin',409);assert.equal(app.store.all('bookings').length,1);
});
