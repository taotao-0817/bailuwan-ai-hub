// Presentation policy only. Server permissions remain the authority for every action.
const adminRoles = new Set(['super_admin', 'park_admin']);
const activeTaskStates = new Set(['planned', 'awaiting_confirmation', 'awaiting_approval', 'running', 'waiting_human', 'paused', 'blocked']);
const item = (id, label) => ({id, label});

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

const managementProfile = {
  homeTitle: '园区总览',
  homeDescription: '处理待办、查看异常，并跟踪园区任务。',
  nav: [item('home', '园区总览'), item('work', '任务与事件'), item('space', '空间与设备'), item('records', '记录与报告')],
  workViews: [item('hub', '任务'), item('security', '事件与巡检'), item('delivery', '配送订单'), item('oa', '审批')],
  spaceViews: [item('overview', '空间视图'), item('devices', '设备控制'), item('resources', '资源目录')],
  recordViews: [item('reports', '运行报告'), item('attendance', '到岗复核'), item('demo', '演示控制')],
  taskTypes: ['delivery', 'patrol', 'meeting', 'fire', 'fall'],
  canCreateTask: true,
};

export const ROLE_PROFILES = freezeTree({
  super_admin: {...managementProfile, label: '总控管理员'},
  park_admin: {...managementProfile, label: '园区管理员'},
  security: {
    label: '安保值班员',
    homeTitle: '安防总览',
    homeDescription: '优先处理现场事件，安排巡检与到岗复核。',
    nav: [item('home', '安防总览'), item('work', '事件与巡检'), item('space', '空间定位'), item('records', '运行记录')],
    workViews: [item('security', '事件处置'), item('hub', '巡检任务')],
    spaceViews: [item('overview', '空间视图'), item('resources', '可用资源')],
    recordViews: [item('attendance', '到岗复核'), item('reports', '运行记录'), item('demo', '演示控制')],
    taskTypes: ['patrol', 'fire', 'fall', 'meeting'],
    canCreateTask: true,
  },
  ops: {
    label: '设备运维员',
    homeTitle: '运维总览',
    homeDescription: '检查设备异常、执行回执和待调度配送。',
    nav: [item('home', '运维总览'), item('work', '任务调度'), item('space', '空间与设备'), item('records', '运行记录')],
    workViews: [item('hub', '执行任务'), item('delivery', '配送订单')],
    spaceViews: [item('overview', '空间视图'), item('devices', '设备控制'), item('resources', '资源目录')],
    recordViews: [item('reports', '运行记录')],
    taskTypes: ['delivery', 'meeting'],
    canCreateTask: true,
  },
  approver: {
    label: '流程审批员',
    homeTitle: '审批工作台',
    homeDescription: '处理待审批申请，查看审批结果。',
    nav: [item('home', '审批工作台'), item('work', '申请审批'), item('service', '我的预订'), item('records', '审批记录')],
    workViews: [item('oa', '待处理')],
    spaceViews: [],
    recordViews: [item('oa', '历史申请')],
    taskTypes: ['meeting'],
    canCreateTask: true,
  },
  user: {
    label: '园区用户',
    homeTitle: '我的服务',
    homeDescription: '申请配送、预订会议空间，查看自己的办理进度。',
    nav: [item('home', '我的服务'), item('work', '我的申请')],
    workViews: [item('requests', '申请记录'), item('hub', '会议预订')],
    spaceViews: [],
    recordViews: [],
    taskTypes: ['meeting'],
    canCreateTask: true,
  },
});

export function roleProfile(role) {
  return Object.hasOwn(ROLE_PROFILES, role) ? ROLE_PROFILES[role] : ROLE_PROFILES.user;
}

export function availableViews(profileOrRole, page) {
  const profile = typeof profileOrRole === 'string' ? roleProfile(profileOrRole) : profileOrRole || ROLE_PROFILES.user;
  if (!profile.nav.some(entry => entry.id === page)) return [];
  if (page === 'home') return [item('home', profile.homeTitle)];
  if (page === 'work') return profile.workViews;
  if (page === 'space') return profile.spaceViews;
  if (page === 'records') return profile.recordViews;
  if (page === 'service') return [item('service', '我的预订')];
  return [];
}

export function validateLocation(role, location = {}) {
  const profile = roleProfile(role);
  const page = profile.nav.some(entry => entry.id === location.page) ? location.page : 'home';
  const views = availableViews(profile, page);
  const view = views.some(entry => entry.id === location.view) ? location.view : views[0]?.id || 'home';
  const isTaskView = (page === 'work' && view === 'hub') || (page === 'service' && view === 'service');
  const taskId = isTaskView && typeof location.taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(location.taskId) ? location.taskId : null;
  return {page, view, taskId};
}

export function canReviewApproval(user, approval) {
  if (!user || !approval || approval.status !== 'pending') return false;
  if (adminRoles.has(user.role)) return true;
  return user.role === 'approver' && !!user.id && (!approval.assignee || approval.assignee === user.id);
}

export function canManageRequest(user, approval) {
  if (!user || !approval || approval.status !== 'pending') return false;
  return adminRoles.has(user.role) || (!!user.id && approval.requesterId === user.id);
}

export function filterRoleData(data) {
  if (!data || typeof data !== 'object') return data;
  const result = structuredClone(data);
  const user = result.user || {};
  const role = Object.hasOwn(ROLE_PROFILES, user.role) ? user.role : 'user';
  const isOwn = record => !!user.id && record.requesterId === user.id;
  if (result.hub) {
    const tasks = (result.hub.tasks || []).filter(task => {
      if (adminRoles.has(role)) return true;
      if (role === 'user') return isOwn(task);
      if (task.type === 'meeting') return isOwn(task);
      if (role === 'security') return ['patrol', 'fire', 'fall'].includes(task.type);
      if (role === 'ops') return task.type === 'delivery';
      return false;
    });
    const taskIds = new Set(tasks.map(task => task.id));
    result.hub.tasks = tasks;
    result.hub.notifications = (result.hub.notifications || []).filter(notification => taskIds.has(notification.taskId));
    result.hub.stats = {
      ...result.hub.stats,
      activeTasks: tasks.filter(task => activeTaskStates.has(task.status)).length,
      awaitingConfirmation: tasks.filter(task => task.status === 'awaiting_confirmation').length,
      completed: tasks.filter(task => task.status === 'completed').length,
    };
    if (role === 'user') {
      const selectedIds = new Set(tasks.flatMap(task => [
        ...(task.resourceIds || []),
        ...(task.selection || []).map(selection => selection.resourceId),
      ]));
      result.hub.resources = (result.hub.resources || []).filter(resource => resource.kind !== 'person' && (resource.kind === 'space' || selectedIds.has(resource.id)));
      result.hub.responders = [];
      result.hub.capabilities = [...new Set(result.hub.resources.flatMap(resource => resource.capabilities || []))];
      result.hub.stats.resources = result.hub.resources.length;
    }
  }
  if (role === 'user') {
    result.deliveries = (result.deliveries || []).filter(isOwn);
    result.approvals = (result.approvals || []).filter(isOwn);
    for (const field of ['devices', 'commands', 'alerts', 'patrols', 'audit', 'attendance', 'automations', 'agentRuns', 'energy']) result[field] = [];
  }
  return result;
}
