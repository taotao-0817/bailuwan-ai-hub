import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_PROFILES, roleProfile, availableViews, validateLocation, filterRoleData, canReviewApproval, canManageRequest} from '../frontend/src/rolePolicy.mjs';

const ownId = 'U-viewer';
function fixture(role = 'user', id = ownId) {
  return {
    user: {id, role},
    buildings: [{id: 'B01'}],
    devices: [{id: 'D01'}], commands: [{id: 'CMD1'}], alerts: [{id: 'A01'}], patrols: [{id: 'P01'}],
    audit: [{id: 'AUD1'}], attendance: [{id: 'ATT1'}], automations: [{id: 'AUT1'}], agentRuns: [{id: 'AR1'}], energy: [{value: 12}],
    deliveries: [{id: 'DEL-own', requesterId: ownId}, {id: 'DEL-other', requesterId: 'U-other'}, {id: 'DEL-seed'}],
    approvals: [{id: 'OA-own', requesterId: ownId}, {id: 'OA-other', requesterId: 'U-other'}],
    hub: {
      tasks: [
        {id: 'HUB-own-meeting', type: 'meeting', requesterId: ownId, status: 'completed', resourceIds: ['space:ROOM1']},
        {id: 'HUB-other-meeting', type: 'meeting', requesterId: 'U-other', status: 'planned'},
        {id: 'HUB-own-delivery', type: 'delivery', requesterId: ownId, status: 'planned', selection: [{resourceId: 'device:D01'}]},
        {id: 'HUB-other-delivery', type: 'delivery', requesterId: 'U-other', status: 'running'},
        {id: 'HUB-patrol', type: 'patrol', requesterId: 'U-other', status: 'running'},
        {id: 'HUB-fire', type: 'fire', requesterId: 'U-other', status: 'awaiting_confirmation'},
        {id: 'HUB-fall', type: 'fall', requesterId: 'U-other', status: 'waiting_human'},
      ],
      notifications: [{id: 'N-own', taskId: 'HUB-own-meeting'}, {id: 'N-other', taskId: 'HUB-other-meeting'}, {id: 'N-fire', taskId: 'HUB-fire'}],
      resources: [
        {id: 'space:ROOM1', kind: 'space', capabilities: ['meeting.host']},
        {id: 'space:ROOM2', kind: 'space', capabilities: ['meeting.host']},
        {id: 'device:D01', kind: 'robot', capabilities: ['deliver']},
        {id: 'device:D02', kind: 'device', capabilities: ['hvac.control']},
        {id: 'person:RESP1', kind: 'person', capabilities: ['safety.respond']},
      ],
      responders: [{id: 'RESP1'}], capabilities: ['meeting.host', 'deliver', 'hvac.control', 'safety.respond'],
      stats: {resources: 5, activeTasks: 6, awaitingConfirmation: 1, completed: 1},
    },
  };
}

test('Role navigation exposes only the intended role destinations and defaults safely', () => {
  assert.equal(Object.keys(ROLE_PROFILES).length, 6);
  assert.equal(roleProfile('unexpected'), ROLE_PROFILES.user);
  assert.equal(roleProfile('__proto__'), ROLE_PROFILES.user);
  assert.deepEqual(roleProfile('user').nav.map(value => value.id), ['home', 'work']);
  assert.deepEqual(availableViews('user', 'space'), []);
  assert.deepEqual(availableViews('ops', 'records').map(value => value.id), ['reports']);
  assert.deepEqual(availableViews('approver', 'service').map(value => value.id), ['service']);
  assert.deepEqual(validateLocation('user', {page: 'space', view: 'devices', taskId: 'HUB-X'}), {page: 'home', view: 'home', taskId: null});
  assert.deepEqual(validateLocation('security', {page: 'work', view: 'delivery'}), {page: 'work', view: 'security', taskId: null});
  assert.deepEqual(validateLocation('ops', {page: 'work', view: 'hub', taskId: 'HUB-123'}), {page: 'work', view: 'hub', taskId: 'HUB-123'});
  assert.equal(validateLocation('ops', {page: 'work', view: 'hub', taskId: '../bad'}).taskId, null);
  assert.deepEqual(validateLocation('approver', {page: 'service', view: 'service', taskId: 'HUB-123'}), {page: 'service', view: 'service', taskId: 'HUB-123'});
});

test('Ordinary-user view contains only own requests and tasks, never operational lists', () => {
  const source = fixture();
  const before = structuredClone(source);
  const filtered = filterRoleData(source);
  assert.deepEqual(filtered.deliveries.map(value => value.id), ['DEL-own']);
  assert.deepEqual(filtered.approvals.map(value => value.id), ['OA-own']);
  assert.deepEqual(filtered.hub.tasks.map(value => value.id), ['HUB-own-meeting', 'HUB-own-delivery']);
  assert.deepEqual(filtered.hub.notifications.map(value => value.id), ['N-own']);
  assert.deepEqual(filtered.hub.resources.map(value => value.id), ['space:ROOM1', 'space:ROOM2', 'device:D01']);
  assert.deepEqual(filtered.hub.responders, []);
  assert.deepEqual(filtered.hub.capabilities, ['meeting.host', 'deliver']);
  assert.deepEqual(filtered.hub.stats, {resources: 3, activeTasks: 1, awaitingConfirmation: 0, completed: 1});
  for (const field of ['devices', 'commands', 'alerts', 'patrols', 'audit', 'attendance', 'automations', 'agentRuns', 'energy']) assert.deepEqual(filtered[field], []);
  assert.deepEqual(filtered.buildings, [{id: 'B01'}]);
  filtered.hub.tasks[0].status = 'changed';
  assert.deepEqual(source, before, 'view policy does not mutate the API snapshot');
});

test('Staff task views follow responsibilities while meetings remain owned', () => {
  const expected = {
    security: ['HUB-own-meeting', 'HUB-patrol', 'HUB-fire', 'HUB-fall'],
    ops: ['HUB-own-meeting', 'HUB-own-delivery', 'HUB-other-delivery'],
    approver: ['HUB-own-meeting'],
  };
  for (const [role, ids] of Object.entries(expected)) {
    const data = filterRoleData(fixture(role));
    assert.deepEqual(data.hub.tasks.map(task => task.id), ids, role);
    assert.equal(data.devices.length, 1, 'staff operational data is preserved');
    assert.equal(data.approvals.length, 2, 'approval action policy is separate from read presentation');
  }
  for (const role of ['super_admin', 'park_admin']) assert.equal(filterRoleData(fixture(role)).hub.tasks.length, 7);
});

test('Unknown role receives the ordinary-user view and missing IDs never imply ownership', () => {
  assert.equal(filterRoleData(fixture('unrecognized')).hub.tasks.length, 2);
  const noIdentity = fixture('user');
  delete noIdentity.user.id;
  noIdentity.approvals.push({id: 'OA-no-owner'});
  noIdentity.hub.tasks.push({id: 'HUB-no-owner', type: 'meeting'});
  const anonymous = filterRoleData(noIdentity);
  assert.deepEqual(anonymous.approvals, []);
  assert.deepEqual(anonymous.hub.tasks, []);
  assert.equal(filterRoleData(null), null);
});

test('Approval actions honor role, assignment, request ownership and terminal state', () => {
  const pending = {status: 'pending', requesterId: 'U-viewer'};
  const approver = {id: 'U-approver', role: 'approver'};
  assert.equal(canReviewApproval(approver, pending), true);
  assert.equal(canReviewApproval(approver, {...pending, assignee: approver.id}), true);
  assert.equal(canReviewApproval(approver, {...pending, assignee: 'U-park'}), false);
  assert.equal(canReviewApproval({id: 'U-park', role: 'park_admin'}, {...pending, assignee: approver.id}), true);
  assert.equal(canReviewApproval({id: ownId, role: 'user'}, pending), false);
  assert.equal(canReviewApproval(approver, {...pending, status: 'approved'}), false);
  assert.equal(canManageRequest({id: ownId, role: 'user'}, pending), true);
  assert.equal(canManageRequest({id: 'U-ops', role: 'ops'}, pending), false);
  assert.equal(canManageRequest({id: 'U-admin', role: 'super_admin'}, pending), true);
  assert.equal(canManageRequest({id: ownId, role: 'user'}, {...pending, status: 'withdrawn'}), false);
  assert.equal(canManageRequest({}, {status: 'pending'}), false);
});
