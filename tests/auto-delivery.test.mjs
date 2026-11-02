import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../backend/server.mjs';
import {HubService} from '../backend/hub.mjs';
import {deliveryCandidates,buildDeliveryRoute,makeRoadGraph,shortestPath,positionOnRoute} from '../backend/routing.mjs';
const ADMIN={id:'U-admin',name:'测试管理员',role:'super_admin'};
async function setup(t){const app=createApp({dbPath:':memory:',llmOptions:{mode:'rules'}});t.after(()=>app.close());for(const table of ['patrols','deliveries'])for(const j of app.store.all(table)){j.status='cancelled';app.store.put(table,j);}app.service.tick();return app;}
function vehicle(app,id,update){const d=app.store.get('devices',id);update(d);app.store.put('devices',d);return d;}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=.05,actual+' != '+expected);

test('Automatic dispatch selects nearest current-position resource and records one auditable order without approval',async t=>{
 const app=await setup(t),from=app.store.get('buildings','B01');
 const graph=makeRoadGraph(app.store.all('buildings'));const entry=graph.nodes.get('entry:B01');
 vehicle(app,'DLV-01',d=>{d.buildingId='B08';d.position={...entry};d.state.battery=80;});
 vehicle(app,'DLV-02',d=>{d.buildingId='B01';d.position={x:60,y:.6,z:43};d.state.battery=90;});
 const decision=deliveryCandidates(app.store,{from:'B01',to:'B04',weight:6});assert.equal(decision.selected.vehicleId,'DLV-01');assert.equal(decision.selected.routePlan.pickupDistanceMeters,0);
 const approvals=app.store.all('approvals').length,orders=app.store.all('deliveries').length;
 const payload={title:'自动配送位置测试',from:'B01',to:'B04',weight:6,idempotencyKey:'autodelivery-idempotent'};
 const order=app.store.transaction(()=>app.service.createDelivery(ADMIN,payload));assert.equal(order.status,'running');assert.equal(order.vehicleId,'DLV-01');assert.equal(order.approvalPolicy,'automatic_validation');assert.equal(order.approvalId,undefined);
 const again=app.store.transaction(()=>app.service.createDelivery(ADMIN,payload));assert.equal(again.id,order.id);assert.equal(app.store.all('deliveries').length,orders+1);assert.equal(app.store.all('approvals').length,approvals);
 const logs=app.store.audits(100).filter(a=>a.action==='delivery.auto_dispatched'&&a.target===order.id);assert.equal(logs.length,1);assert.equal(logs[0].detail.vehicleId,'DLV-01');assert.ok(logs[0].detail.routePlan.distanceMeters>0);assert.equal(app.store.verifyAudit().valid,true);
});

test('Delivery rejects forced non-nearest or infeasible units and requires whole-route battery reserve',async t=>{
 const app=await setup(t);const entry=makeRoadGraph(app.store.all('buildings')).nodes.get('entry:B01');
 vehicle(app,'DLV-01',d=>{d.position={...entry};d.state.battery=25;});
 vehicle(app,'DLV-02',d=>{d.position={x:50,y:.6,z:43};d.state.battery=85;});
 const match=deliveryCandidates(app.store,{from:'B01',to:'B08',weight:20});const low=match.candidates.find(c=>c.vehicleId==='DLV-01');assert.ok(low.reasons.some(s=>s.includes('20%')));assert.equal(match.selected.vehicleId,'DLV-02');
 assert.throws(()=>app.store.transaction(()=>app.service.createDelivery(ADMIN,{title:'拒绝模型强制资源',from:'B01',to:'B08',weight:20,vehicleId:'DLV-01'})),e=>e.code==='AUTO_SELECTION_POLICY');
 const before=app.store.all('deliveries').length;vehicle(app,'DLV-02',d=>{d.status='offline';});assert.throws(()=>app.store.transaction(()=>app.service.createDelivery(ADMIN,{title:'没有合适设备',from:'B01',to:'B08',weight:20})),e=>e.code==='NO_VEHICLE_AVAILABLE');assert.equal(app.store.all('deliveries').length,before);
});

test('Route graph yields reachable road paths, correct summed length, and simulator follows exactly the planned path',async t=>{
 const app=await setup(t);vehicle(app,'DLV-01',d=>{d.position={x:-32,y:.6,z:0};d.state.battery=95;});vehicle(app,'DLV-02',d=>{d.status='offline';});
 const buildings=app.store.all('buildings'),graph=makeRoadGraph(buildings);const direct=shortestPath(graph,'entry:B01','entry:B08');assert.ok(direct);for(let i=1;i<direct.nodeIds.length;i++)assert.ok(graph.edges.get(direct.nodeIds[i-1]).some(e=>e.to===direct.nodeIds[i]));
 const route=buildDeliveryRoute(buildings,app.store.get('devices','DLV-01'),'B01','B08',6);assert.equal(route.algorithm,'dijkstra');const dist=route.points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-route.points[i].x,p.y-route.points[i].y,p.z-route.points[i].z),0);near(route.distanceMeters,dist);near(route.distanceMeters,route.pickupDistanceMeters+route.deliveryDistanceMeters);assert.equal(route.reserveBatteryPercent,20);
 const order=app.store.transaction(()=>app.service.createDelivery(ADMIN,{title:'道路轨迹回执',from:'B01',to:'B08',weight:6}));const startBattery=app.store.get('devices',order.vehicleId).state.battery;
 app.service.tick();const expected=positionOnRoute(order.routePlan.points,.1),position=app.store.get('devices',order.vehicleId).position;assert.deepEqual(position,expected);assert.equal(app.store.get('deliveries',order.id).progress,10);
 for(let i=0;i<9;i++)app.service.tick();const result=app.store.get('deliveries',order.id),unit=app.store.get('devices',order.vehicleId);assert.equal(result.status,'delivered');assert.equal(unit.buildingId,'B08');assert.deepEqual(unit.position,order.routePlan.points.at(-1));near(startBattery-unit.state.battery,order.routePlan.estimatedBatteryUse);assert.ok(unit.state.battery>=20);
});

test('Busy, offline, under-capacity and blocked resources have explicit exclusion reasons',async t=>{
 const app=await setup(t);vehicle(app,'DLV-01',d=>{d.state.routeBlocked=true;});vehicle(app,'DLV-02',d=>{d.status='offline';});const match=deliveryCandidates(app.store,{from:'B01',to:'B08',weight:6});assert.equal(match.selected,null);assert.ok(match.candidates.find(c=>c.vehicleId==='DLV-01').reasons.some(s=>s.includes('阻塞')));assert.ok(match.candidates.find(c=>c.vehicleId==='DLV-02').reasons.some(s=>s.includes('离线')));assert.ok(match.candidates.filter(c=>c.type==='drone').every(c=>c.reasons.some(s=>s.includes('载重'))));
 vehicle(app,'DLV-01',d=>{delete d.state.routeBlocked;});const existing=app.store.get('deliveries','DLV-T002');existing.vehicleId='DLV-01';existing.status='running';app.store.put('deliveries',existing);const occupied=deliveryCandidates(app.store,{from:'B01',to:'B08',weight:6});assert.ok(occupied.candidates.find(c=>c.vehicleId==='DLV-01').reasons.some(s=>s.includes('占用')));
});

test('Legacy pending delivery rejects dispatch and keeps its original pending approval',async t=>{
 const app=await setup(t);const old=app.store.get('deliveries','DLV-T002');old.status='pending_approval';old.approved=false;old.autoDispatch=false;app.store.put('deliveries',old);app.store.put('approvals',{id:'OA-LEGACY-TEST',title:'旧配送审批',type:'delivery',relatedId:old.id,status:'pending',requesterId:'U-admin',requester:'管理员',createdAt:new Date().toISOString(),steps:[],result:null});
 const before=app.store.all('deliveries').length;
 assert.throws(()=>app.store.transaction(()=>app.service.deliveryAction(ADMIN,old.id,{action:'dispatch'})),e=>e.code==='APPROVAL_REQUIRED');
 assert.equal(app.store.all('deliveries').length,before);
 assert.equal(app.store.get('approvals','OA-LEGACY-TEST').status,'pending');
 assert.equal(app.store.get('deliveries',old.id).approved,false);
});

test('Non-dispatchers can submit their own request and cannot bypass OA with client fields', async t=>{
 const app=await setup(t);
 for(const role of ['user','security','approver']){
   const user={id:'unit-'+role,name:'申请人',role};
   const payload={title:'样品',from:'B03',to:'B08',weight:6,recipient:'接收岗',source:'hub',requesterId:'other',vehicleId:'DLV-02',approved:true,autoDispatch:true,idempotencyKey:'sample'};
   const order=app.store.transaction(()=>app.service.createDelivery(user,payload));
   assert.equal(order.status,'pending_approval');assert.equal(order.requesterId,user.id);assert.equal(order.source,'human');assert.equal(order.vehicleId,null);assert.equal(order.recipient,'接收岗');
   assert.equal(app.store.get('approvals',order.approvalId).requesterId,user.id);
   assert.equal(app.store.transaction(()=>app.service.createDelivery(user,payload)).approvalId,order.approvalId);
   assert.throws(()=>app.service.deliveryAction(user,order.id,{action:'dispatch'}),e=>e.code==='FORBIDDEN');
 }
});

test('Legacy dispatch and reassignment cannot force a non-nearest available resource',async t=>{
 const app=await setup(t),entry=makeRoadGraph(app.store.all('buildings')).nodes.get('entry:B01');
 vehicle(app,'DLV-01',d=>{d.position={...entry};d.state.battery=90;});
 vehicle(app,'DLV-02',d=>{d.position={x:50,y:.6,z:43};d.state.battery=90;});
 const old=app.store.get('deliveries','DLV-T002');Object.assign(old,{status:'queued',approved:true,from:'B01',to:'B04',weight:8,vehicleId:null});app.store.put('deliveries',old);
 assert.throws(()=>app.store.transaction(()=>app.service.deliveryAction(ADMIN,old.id,{action:'dispatch',vehicleId:'DLV-02'})),e=>e.code==='AUTO_SELECTION_POLICY');
 assert.equal(app.store.get('deliveries',old.id).status,'queued');
 const result=app.store.transaction(()=>app.service.deliveryAction(ADMIN,old.id,{action:'dispatch'}));assert.equal(result.vehicleId,'DLV-01');
});

test('Reassignment through a delivery order updates its hub resource, route, candidates and cleared error',async t=>{
  const app=await setup(t);
  const hub=new HubService(app.service);
  const task=app.store.transaction(()=>hub.plan(ADMIN,{
    goal:'从科创中心配送6公斤资料到研发中心',type:'delivery',
    params:{from:'B01',to:'B02',weight:6},automaticDelivery:true
  }));
  const orderId=task.businessRefs.deliveryId;
  const initialVehicle=app.store.get('deliveries',orderId).vehicleId;
  vehicle(app,initialVehicle,device=>{device.state.routeBlocked=true;});
  app.service.tick();hub.sync();
  assert.equal(app.store.get('hub_tasks',task.id).status,'blocked');
  assert.ok(app.store.get('hub_tasks',task.id).error);

  const order=app.store.transaction(()=>app.service.deliveryAction(ADMIN,orderId,{action:'reassign'}));
  assert.notEqual(order.vehicleId,initialVehicle);
  hub.sync();
  const synced=app.store.get('hub_tasks',task.id);
  const device=app.store.get('devices',order.vehicleId);
  assert.equal(synced.status,'running');
  assert.equal(synced.error,null);
  assert.deepEqual(synced.resourceIds,['device:'+device.id]);
  assert.equal(synced.selection[0].resourceId,'device:'+device.id);
  assert.equal(synced.selection[0].name,device.name);
  assert.equal(synced.selection[0].reason,order.dispatchReason);
  assert.deepEqual(synced.selection[0].routePlan,order.routePlan);
  assert.deepEqual(synced.routePlan,order.routePlan);
  assert.deepEqual(synced.candidates,order.routingCandidates);
  const auditCount=app.store.audits(1000).length;
  hub.sync();
  assert.equal(app.store.audits(1000).length,auditCount,'unchanged order should not produce repeated sync records');
});
