import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secret = 'integration-simulator-token';
const password = 'Bailuwan2026!';
const sessions = new Map();
let temporary, dbPath, child, base, output = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(path, { method = 'GET', body, as = 'admin', headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(sessions.has(as) ? { cookie: sessions.get(as) } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}

async function ok(path, body, as = 'admin', expected = [200, 201, 202]) {
  const result = await request(path, { method: body === undefined ? 'GET' : 'POST', body, as });
  assert.ok(expected.includes(result.status), `${path}: HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function denied(path, body, as = 'admin', codes = [400, 401, 403, 409, 422]) {
  const result = await request(path, { method: 'POST', body, as });
  assert.ok(codes.includes(result.status), `${path}: expected rejection, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.ok(result.data.error?.code, 'standard error code');
  assert.ok(result.data.error?.message, 'standard error message');
  return result;
}

const snapshot = () => ok('/api/bootstrap');
const tick = () => ok('/api/simulator/tick', { token: secret }, null);
const liveLight = data => data.devices.find(d => d.type === 'light' && d.status !== 'offline' && !d.state.simulateFailure && !d.state.simulateTimeout);

function mutateFixture(table, id, update) {
  assert.ok(['devices', 'commands'].includes(table));
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    assert.ok(row, `fixture ${table}/${id} exists`);
    const item = JSON.parse(row.data);
    update(item);
    db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(item), id);
  } finally { db.close(); }
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'bailuwan-integration-'));
  dbPath = join(temporary, 'test.sqlite');
  const port = await unusedPort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['backend/server.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DB_PATH: dbPath,
      SIMULATOR_TOKEN: secret, COMMAND_TIMEOUT_MS: '300', NODE_ENV: 'test', AI_MODE:'rules' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited before ready:\n${output}`);
    try { const response = await fetch(base + '/api/health'); if (response.ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `Server did not become ready:\n${output}`);
  for (const username of ['admin', 'park', 'security', 'ops', 'approver', 'viewer']) {
    const response = await request('/api/login', { method: 'POST', body: { username, password }, as: null });
    assert.equal(response.status, 200, `login ${username}: ${JSON.stringify(response.data)}`);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    sessions.set(username, cookie.split(';')[0]);
  }
}, { timeout: 20000 });

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), delay(3000)]);
  }
  if (temporary) {
    const target = resolve(temporary);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('bailuwan-integration-'), 'cleanup stays in this test temporary directory');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Authentication, origin validation, role restrictions, and simulator credentials', async () => {
  const unauthenticated = await request('/api/bootstrap', { as: null });
  assert.equal(unauthenticated.status, 401);
  await denied('/api/login', { username: 'admin', password: 'incorrect' }, null, [401]);
  const data = await snapshot();
  assert.ok(data.buildings.length >= 6, 'substantial campus seed');
  assert.ok(data.devices.length >= 20, 'substantial device seed');
  assert.equal(data.user.password_hash, undefined, 'password hash never leaves backend');
  assert.equal(data.user.salt, undefined, 'password salt never leaves backend');
  const userData = await ok('/api/bootstrap', undefined, 'viewer');
  assert.equal(userData.attendance.length, 0, 'regular users cannot browse staff attendance');
  assert.equal(userData.audit.length, 0, 'regular users cannot browse administration audit');
  const device = liveLight(data);
  assert.ok(device, 'online light fixture');
  await denied('/api/commands', { deviceIds: [device.id], action: 'power', value: false }, 'viewer', [403]);
  await denied('/api/takeover', { action: 'activate', password, confirmed: true, reason: 'unauthorized' }, 'ops', [403]);
  await denied('/api/simulator/tick', { token: 'incorrect' }, null, [401, 403]);
  const crossOrigin = await request('/api/commands', { method: 'POST', body: { deviceIds: [device.id], action: 'power', value: false }, headers: { origin: 'https://untrusted.invalid' } });
  assert.equal(crossOrigin.status, 403);
});

test('Device commands acknowledge only after simulation; capability and offline failures are explicit', async () => {
  const before = await snapshot();
  const device = liveLight(before);
  const value = !device.state.power;
  const result = await ok('/api/commands', { deviceIds: [device.id], action: 'power', value, idempotencyKey: 'test-device-ack' });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].status, 'pending');
  let state = await snapshot();
  assert.equal(state.devices.find(d => d.id === device.id).state.power, device.state.power, 'state is not optimistically changed');
  await tick();
  state = await snapshot();
  assert.equal(state.devices.find(d => d.id === device.id).state.power, value);
  assert.equal(state.commands.find(c => c.id === result.commands[0].id).status, 'succeeded');
  await denied('/api/commands', { deviceIds: [device.id], action: 'temperature', value: 24 }, 'admin', [400, 422]);
  await denied('/api/commands', { deviceIds: [device.id], action: 'brightness', value: 500 }, 'admin', [400, 422]);
  const offline = state.devices.find(d => d.status === 'offline' && d.capabilities.includes('power'));
  assert.ok(offline, 'seed includes a controllable offline device');
  await denied('/api/commands', { deviceIds: [offline.id], action: 'power', value: true }, 'admin', [400, 409]);
});

test('Idempotency replays the original command and rejects conflicting reuse', async () => {
  const device = liveLight(await snapshot());
  const payload = { deviceIds: [device.id], action: 'brightness', value: 65, idempotencyKey: 'test-replay-key' };
  const first = await ok('/api/commands', payload);
  const again = await ok('/api/commands', payload);
  assert.equal(first.commands[0].id, again.commands[0].id);
  await denied('/api/commands', { ...payload, value: 66 }, 'admin', [409]);
  await tick();
});

test('Adapter failure and expired acknowledgement never update the device to a false success', async () => {
  const device = liveLight(await snapshot());
  const originalPower = device.state.power;
  mutateFixture('devices', device.id, fixture => { fixture.state.simulateFailure = true; });
  try {
    const failed = await ok('/api/commands', { deviceIds: [device.id], action: 'power', value: !originalPower, idempotencyKey: 'test-adapter-failure' });
    await tick();
    let data = await snapshot();
    assert.equal(data.commands.find(c => c.id === failed.commands[0].id).status, 'failed');
    assert.equal(data.devices.find(d => d.id === device.id).state.power, originalPower);
    mutateFixture('devices', device.id, fixture => { delete fixture.state.simulateFailure; fixture.state.simulateTimeout = true; });
    const expired = await ok('/api/commands', { deviceIds: [device.id], action: 'power', value: !originalPower, idempotencyKey: 'test-adapter-timeout' });
    await tick();
    data = await snapshot();
    assert.equal(data.commands.find(c => c.id === expired.commands[0].id).status, 'pending', 'missing acknowledgement stays pending');
    mutateFixture('commands', expired.commands[0].id, fixture => { fixture.deadline = new Date(Date.now() - 1000).toISOString(); });
    await tick();
    data = await snapshot();
    assert.equal(data.commands.find(c => c.id === expired.commands[0].id).status, 'timed_out');
    assert.equal(data.devices.find(d => d.id === device.id).state.power, originalPower);
  } finally {
    mutateFixture('devices', device.id, fixture => { delete fixture.state.simulateFailure; delete fixture.state.simulateTimeout; });
  }
});

test('Backend watchdog times out unacknowledged commands even when simulator stops ticking', async () => {
  const device = liveLight(await snapshot());
  const originalPower = device.state.power;
  const queued = await ok('/api/commands', { deviceIds: [device.id], action: 'power', value: !originalPower, idempotencyKey: 'test-no-simulator-watchdog' });
  let terminal;
  const deadline = Date.now() + 3000;
  do {
    await delay(100);
    terminal = (await snapshot()).commands.find(c => c.id === queued.commands[0].id);
  } while (terminal.status === 'pending' && Date.now() < deadline);
  assert.equal(terminal.status, 'timed_out', 'backend watchdog settles command without simulator or tick endpoint');
  assert.equal((await snapshot()).devices.find(d => d.id === device.id).state.power, originalPower);
});

test('Security event enforces discovery-confirm-dispatch-resolve-review-archive closure', async () => {
  const alert = await ok('/api/scenarios/security', {});
  assert.equal(alert.status, 'detected');
  await denied(`/api/alerts/${alert.id}/transition`, { action: 'archive' }, 'admin', [409]);
  const expected = ['confirmed', 'dispatched', 'resolved', 'reviewed', 'archived'];
  let current;
  for (const [index, action] of ['confirm', 'dispatch', 'resolve', 'review', 'archive'].entries()) {
    current = await ok(`/api/alerts/${alert.id}/transition`, { action, assignee: 'security', note: `集成测试 ${action}` });
    assert.equal(current.status, expected[index]);
  }
  assert.ok(current.timeline.length >= 6, 'discovery and every transition remain traceable');
  await denied(`/api/alerts/${alert.id}/transition`, { action: 'confirm' }, 'admin', [409]);
});

test('Fire drill requires explicit confirmation, dispatches linked commands, then closes', async () => {
  const alert = await ok('/api/scenarios/fire', {});
  assert.equal(alert.type, 'fire');
  assert.equal(alert.drill, true, 'drills never masquerade as real fire');
  await denied(`/api/emergency/${alert.id}/execute`, { confirmed: true, idempotencyKey: 'test-fire-too-early' }, 'admin', [409]);
  await ok(`/api/alerts/${alert.id}/transition`, { action: 'confirm' });
  await denied(`/api/emergency/${alert.id}/execute`, { confirmed: false, idempotencyKey: 'test-fire-no-confirm' }, 'admin', [400, 403, 409]);
  await ok(`/api/emergency/${alert.id}/execute`, { confirmed: true, idempotencyKey: 'test-fire-execute' });
  let data = await snapshot();
  assert.equal(data.alerts.find(a => a.id === alert.id).status, 'dispatched');
  assert.ok(data.commands.some(c => c.status === 'pending'), 'emergency action is routed through command acknowledgement');
  await tick();
  for (const action of ['resolve', 'review', 'archive']) await ok(`/api/alerts/${alert.id}/transition`, { action, note: '演练验证完成' });
  data = await snapshot();
  assert.equal(data.alerts.find(a => a.id === alert.id).status, 'archived');
});

test('An emergency command conflict rolls back every partial command in the operation', async () => {
  const alert = await ok('/api/scenarios/fire', {});
  await ok(`/api/alerts/${alert.id}/transition`, { action: 'confirm' });
  const hvac = (await snapshot()).devices.find(d => d.buildingId === alert.buildingId && d.type === 'hvac' && d.status !== 'offline');
  await ok('/api/commands', { deviceIds: [hvac.id], action: 'power', value: true, idempotencyKey: 'test-emergency-conflict-device' });
  const before = await snapshot();
  const payload = { confirmed: true, idempotencyKey: 'test-emergency-atomic' };
  await denied(`/api/emergency/${alert.id}/execute`, payload, 'admin', [409]);
  const after = await snapshot();
  assert.equal(after.commands.length, before.commands.length, 'no light commands survive a later HVAC conflict');
  assert.equal(after.alerts.find(a => a.id === alert.id).status, 'confirmed');
  await tick();
  await ok(`/api/emergency/${alert.id}/execute`, payload);
  await tick();
  for (const action of ['resolve', 'review', 'archive']) await ok(`/api/alerts/${alert.id}/transition`, { action });
});

test('Delivery dispatches after automatic validation without creating OA and is signed only after arrival', async () => {
  const data = await snapshot();const count=data.approvals.length;
  await tick();
  const order = await ok('/api/deliveries', { title: '集成测试文件配送', from: data.buildings[0].id, to: data.buildings[1].id, weight: 0.5, priority: 'normal' });
  assert.equal(order.status, 'running');assert.equal(order.autoDispatch,true);assert.equal(order.approvalPolicy,'automatic_validation');assert.equal(order.approvalId,undefined);assert.equal((await snapshot()).approvals.length,count);assert.ok(order.routePlan.distanceMeters>0);
  const request=await ok('/api/deliveries', {title:'普通用户配送申请',from:'B01',to:'B02',weight:1,source:'hub',autoDispatch:true,approved:true,vehicleId:order.vehicleId},'viewer');
  assert.equal(request.status,'pending_approval');assert.equal(request.approved,false);assert.equal(request.source,'human');assert.equal(request.vehicleId,null);
  await denied('/api/deliveries/'+request.id+'/action',{action:'dispatch'},'viewer',[403]);
  await denied('/api/deliveries/'+request.id+'/action',{action:'dispatch'},'admin',[409]);
  assert.equal((await snapshot()).approvals.find(a=>a.id===request.approvalId).status,'pending');
  await ok('/api/approvals/'+request.approvalId+'/action',{action:'withdraw',note:'申请人撤回测试单'},'viewer');
  await denied('/api/deliveries/'+order.id+'/action', { action:'sign' }, 'admin', [409]);
  for (let i = 0; i < 20; i++) await tick();
  const delivered = (await snapshot()).deliveries.find(d => d.id === order.id);assert.equal(delivered.status,'delivered');assert.equal(delivered.progress,100);
  assert.equal((await ok('/api/deliveries/'+order.id+'/action',{action:'sign'})).status,'signed');assert.equal((await ok('/api/deliveries/'+order.id+'/action',{action:'archive'})).status,'archived');
});

test('OA operations preserve request ownership and permission approval never elevates a user', async () => {
  const maintenance = await ok('/api/approvals', { title: '测试灯具维修申请', type: 'maintenance', relatedId: liveLight(await snapshot()).id, description: '模拟线路检查' }, 'viewer');
  await denied(`/api/approvals/${maintenance.id}/action`, { action: 'withdraw' }, 'ops', [403]);
  const reminded = await ok(`/api/approvals/${maintenance.id}/action`, { action: 'remind' }, 'viewer');
  assert.ok(reminded.remindedAt);
  await denied(`/api/approvals/${maintenance.id}/action`, { action: 'transfer', assignee: 'U-viewer' }, 'approver', [400, 403, 422]);
  const transferred = await ok(`/api/approvals/${maintenance.id}/action`, { action: 'transfer', assignee: 'U-park' }, 'approver');
  assert.equal(transferred.assignee, 'U-park');
  await denied(`/api/approvals/${maintenance.id}/action`, { action: 'approve' }, 'approver', [403]);
  await ok(`/api/approvals/${maintenance.id}/action`, { action: 'approve' }, 'park');
  for (let i = 0; i < 4; i++) await tick();
  const completed = (await snapshot()).approvals.find(a => a.id === maintenance.id);
  assert.equal(completed.executionTask.status, 'completed');
  assert.equal(completed.steps[2].status, 'completed');
  const privilegeRequest = await ok('/api/approvals', { title: '申请临时设备控制权限', type: 'permission', description: '仅验证批准不会自动改角色' }, 'viewer');
  await ok(`/api/approvals/${privilegeRequest.id}/action`, { action: 'approve' }, 'approver');
  const viewerData = await ok('/api/bootstrap', undefined, 'viewer');
  assert.equal(viewerData.user.role, 'user');
  await denied('/api/commands', { deviceIds: [liveLight(viewerData).id], action: 'power', value: false }, 'viewer', [403]);
  const withdrawn = await ok('/api/approvals', { title: '测试撤回', type: 'purchase' }, 'viewer');
  assert.equal((await ok(`/api/approvals/${withdrawn.id}/action`, { action: 'withdraw' }, 'viewer')).status, 'withdrawn');
  const rejected = await ok('/api/approvals', { title: '测试驳回', type: 'purchase' }, 'viewer');
  assert.equal((await ok(`/api/approvals/${rejected.id}/action`, { action: 'reject', note: '演示预算不足' }, 'approver')).status, 'rejected');
});

test('Delivery degradation refuses a forced low-battery unit and records route blockage as an exception', async () => {
  const data=await snapshot();const lowBattery=data.devices.find(d=>d.type==='drone'&&d.state.battery<25);assert.ok(lowBattery);
  await tick();await denied('/api/deliveries',{title:'拒绝不合适设备',from:'B07',to:'B08',weight:.5,vehicleId:lowBattery.id},'admin',[409]);
  const order=await ok('/api/deliveries',{title:'降级处理测试',from:'B07',to:'B08',weight:.5});const vehicleId=order.vehicleId;assert.notEqual(vehicleId,lowBattery.id);
  mutateFixture('devices',vehicleId,fixture=>{fixture.state.routeBlocked=true;});
  try{await tick();const current=(await snapshot()).deliveries.find(d=>d.id===order.id);assert.equal(current.status,'exception');assert.ok(current.exception);}finally{mutateFixture('devices',vehicleId,fixture=>{delete fixture.state.routeBlocked;});}
  await ok('/api/deliveries/'+order.id+'/action',{action:'recall'});for(let i=0;i<4;i++)await tick();assert.equal((await snapshot()).deliveries.find(d=>d.id===order.id).status,'cancelled');
});

test('Agent records read tools and does not execute a high-risk emergency tool', async () => {
  const tools = await ok('/api/agent/tools');
  assert.ok(tools, 'tool discovery works');
  const summary = await ok('/api/agent/call', { tool: 'park.status', input: {}, context: { requestId: 'test-agent-query' } });
  assert.equal(summary.tool, 'park.status');
  const before = await snapshot();
  const proposed = await ok('/api/agent/call', { tool: 'emergency.execute', input: { confirmed: true, role: 'super_admin' }, context: { requestId: 'test-agent-highrisk' } });
  assert.ok(['proposed', 'requires_confirmation', 'proposal', 'pending_confirmation'].includes(proposed.status), `high risk status ${proposed.status}`);
  const after = await snapshot();
  assert.equal(after.commands.length, before.commands.length, 'Agent cannot self-authorize emergency control');
  assert.ok(after.agentRuns.some(run => run.id === proposed.id), 'auditable Agent record');
  await denied('/api/agent/call', { tool: 'arbitrary.database.write', input: {} }, 'admin', [400, 404]);
});

test('Human takeover reauthenticates, blocks Agent writes, checks recovery, and preserves task state', async () => {
  const data = await snapshot();
  const robot = data.devices.find(d => d.type === 'robot' && d.status !== 'offline' && Number(d.state.battery) >= 30);
  assert.ok(robot);
  const patrol = await ok('/api/patrols', { name: '接管一致性测试', robotId: robot.id, route: data.buildings.slice(0, 3).map(b => b.id) });
  await denied('/api/takeover', { action: 'activate', password: 'incorrect', reason: '身份测试', confirmed: true }, 'admin', [401, 403]);
  const fire = await ok('/api/scenarios/fire', {});
  const light = liveLight(data);
  const agentCommand = await ok('/api/agent/call', { tool: 'device.control', input: { deviceIds: [light.id], action: 'power', value: !light.state.power }, context: { requestId: 'test-cancel-agent-on-takeover' } });
  assert.equal(agentCommand.result.commands[0].status, 'pending');
  await ok('/api/takeover', { action: 'activate', password, reason: '集成测试人工接管', confirmed: true });
  let current = await snapshot();
  assert.equal(current.takeover.active, true);
  assert.ok(current.takeover.actor);
  assert.ok(current.takeover.at);
  assert.equal(current.commands.find(c => c.id === agentCommand.result.commands[0].id).status, 'cancelled', 'pending automatic command cancelled on takeover');
  assert.ok(['paused', 'returning'].includes(current.patrols.find(p => p.id === patrol.id).status));
  const manualCommand = await ok('/api/commands', { deviceIds: [light.id], action: 'power', value: !light.state.power, idempotencyKey: 'test-human-command-stop' });
  await denied(`/api/commands/${manualCommand.commands[0].id}/cancel`, {}, 'ops', [403, 423]);
  await ok(`/api/commands/${manualCommand.commands[0].id}/cancel`, {});
  current = await snapshot();
  assert.equal(current.commands.find(c => c.id === manualCommand.commands[0].id).status, 'cancelled');
  assert.equal(current.devices.find(d => d.id === light.id).state.power, light.state.power, 'stopping pending manual linkage does not mutate physical state');
  await denied('/api/agent/call', { tool: 'device.control', input: { deviceIds: [liveLight(current).id], action: 'power', value: false } }, 'admin', [403, 409, 423]);
  await denied('/api/takeover', { action: 'release', password, reason: '未闭环应禁止恢复', confirmed: true }, 'admin', [409]);
  await ok(`/api/alerts/${fire.id}/transition`, { action: 'confirm' });
  await ok(`/api/emergency/${fire.id}/execute`, { confirmed: true, idempotencyKey: 'test-takeover-fire' });
  await tick();
  for (const action of ['resolve', 'review', 'archive']) await ok(`/api/alerts/${fire.id}/transition`, { action, note: '人工处置完成' });
  // Seed data may contain another active fire. Close it through the same business endpoints.
  for (let alert of (await snapshot()).alerts.filter(a => a.type === 'fire' && a.severity === 'critical' && !['resolved', 'reviewed', 'archived'].includes(a.status))) {
    if (alert.status === 'detected') alert = await ok(`/api/alerts/${alert.id}/transition`, { action: 'confirm' });
    if (alert.status === 'confirmed') { await ok(`/api/emergency/${alert.id}/execute`, { confirmed: true, idempotencyKey: `test-close-${alert.id}` }); await tick(); }
    for (const action of ['resolve', 'review', 'archive']) await ok(`/api/alerts/${alert.id}/transition`, { action, note: '接管恢复核验' });
  }
  await tick();
  const recoveryPending = await ok('/api/commands', { deviceIds: [light.id], action: 'power', value: !light.state.power, idempotencyKey: 'test-recovery-pending' });
  await denied('/api/takeover', { action: 'release', password, reason: '指令未收敛应禁止恢复', confirmed: true }, 'admin', [409]);
  await ok(`/api/commands/${recoveryPending.commands[0].id}/cancel`, {});
  await ok('/api/takeover', { action: 'release', password, reason: '状态核验通过后恢复', confirmed: true });
  current = await snapshot();
  assert.equal(current.takeover.active, false);
  assert.notEqual(current.patrols.find(p => p.id === patrol.id).status, 'running', 'old work is not automatically replayed');
});

test('Manual command cancellation requires takeover authority and rejects every terminal command', async () => {
  const initial = await snapshot();
  assert.equal(initial.takeover.active, false);
  const light = liveLight(initial);
  const originalPower = light.state.power;
  const queued = await ok('/api/commands', { deviceIds: [light.id], action: 'power', value: !originalPower, idempotencyKey: 'test-cancel-policy-pending' });
  const commandId = queued.commands[0].id;
  mutateFixture('commands', commandId, fixture => { fixture.deadline = new Date(Date.now() + 60000).toISOString(); });
  const needsTakeover = await denied(`/api/commands/${commandId}/cancel`, {}, 'admin', [409]);
  assert.equal(needsTakeover.data.error.code, 'TAKEOVER_REQUIRED');
  await denied(`/api/commands/${commandId}/cancel`, {}, 'park', [403]);
  await ok('/api/takeover', { action: 'activate', password, reason: '验证人工联动撤销权限与终态保护', confirmed: true });
  try {
    await denied(`/api/commands/${commandId}/cancel`, {}, 'park', [403, 423]);
    const cancelled = await ok(`/api/commands/${commandId}/cancel`, {});
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.completedAt);
    const repeated = await denied(`/api/commands/${commandId}/cancel`, {}, 'admin', [409]);
    assert.equal(repeated.data.error.code, 'INVALID_TRANSITION');
    await tick();
    let state = await snapshot();
    assert.equal(state.devices.find(d => d.id === light.id).state.power, originalPower, 'cancelled command is not applied by a later adapter tick');
    assert.ok(state.audit.some(a => a.action === 'device.command.cancelled' && a.target === commandId), 'manual cancellation is auditable');
    const completed = await ok('/api/commands', { deviceIds: [light.id], action: 'power', value: !originalPower, idempotencyKey: 'test-cancel-policy-completed' });
    await tick();
    const completedId = completed.commands[0].id;
    const terminal = await denied(`/api/commands/${completedId}/cancel`, {}, 'admin', [409]);
    assert.equal(terminal.data.error.code, 'INVALID_TRANSITION');
    state = await snapshot();
    assert.equal(state.commands.find(c => c.id === completedId).status, 'succeeded', 'already acknowledged action keeps its terminal outcome');
    assert.equal(state.devices.find(d => d.id === light.id).state.power, !originalPower, 'rejection must not invent a rollback of an executed device action');
  } finally {
    await tick();
    await ok('/api/takeover', { action: 'release', password, confirmed: true });
  }
});

test('Audit chain verifies and database rejects casual audit mutation', async () => {
  const verification = await ok('/api/audit/verify');
  assert.equal(verification.valid, true, JSON.stringify(verification));
  const data = await snapshot();
  assert.ok(data.audit.length > 10, 'business actions have persisted audit events');
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const auditTable = tables.find(t => ['audit_logs', 'audit', 'audit_log'].includes(t.name));
    assert.ok(auditTable, 'audit table exists');
    assert.throws(() => db.exec(`DELETE FROM ${auditTable.name}`), /audit|append|immutable|禁止|只读|delete/i, 'append-only trigger rejects deletion');
  } finally { db.close(); }
  const stillValid = await ok('/api/audit/verify');
  assert.equal(stillValid.valid, true);
});
