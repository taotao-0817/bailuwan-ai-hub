import React from 'react';
import './delivery-route.css';

const numeric = value => typeof value === 'number' && Number.isFinite(value);
const metres = value => numeric(value) ? `${Math.round(value)} m` : '';
const percent = value => numeric(value) ? `${Number(value.toFixed(1))}%` : '';
const algorithmLabel = { dijkstra: '园区道路', direct_air_corridor: '空中通道' };

function candidateExplanation(candidate) {
  if (!candidate.eligible) return candidate.reasons?.join('、') || candidate.reason || '当前不可用';
  const pickup = candidate.pickupDistanceMeters ?? candidate.routeMetrics?.pickupDistanceMeters ?? candidate.routePlan?.pickupDistanceMeters;
  return numeric(pickup) ? `可执行，距取件点 ${metres(pickup)}` : '满足当前派单条件';
}

export default function DeliveryRouteSummary({ order, task, compact = false }) {
  if (!order && task?.type !== 'delivery') return null;

  const selection = task?.selection?.[0];
  const plan = order?.routePlan ?? task?.routePlan ?? selection?.routePlan;
  // Older orders may have a vehicle assignment without a saved route or dispatch decision.
  const candidates = order?.routingCandidates ?? task?.candidates ?? [];
  const hasDispatchDecision = plan || order?.dispatchReason || candidates.some(c => c.routePlan || c.routeMetrics);
  if (!hasDispatchDecision) return null;

  const vehicleId = order?.vehicleId ?? plan?.vehicleId;
  const assigned = candidates.find(c => c.vehicleId === vehicleId || c.resourceId === `device:${vehicleId}`);
  const selectedName = assigned?.name ?? selection?.name ?? vehicleId;
  const otherCandidates = candidates.filter(c => c !== assigned && c.resourceId !== selection?.resourceId);
  const sent = Boolean(order?.routePlan || task?.businessRefs?.deliveryId);
  const pickUpName = plan?.pickup?.name, destinationName = plan?.delivery?.name;
  const routeName = [pickUpName, destinationName].filter(Boolean).join(' → ');
  const progress = numeric(order?.progress) ? Math.max(0, Math.min(100, order.progress)) : null;
  const phase = {to_pickup:'前往取件',to_destination:'送往目的地'}[order?.phase];
  const progressLabel = order?.status === 'running' ? phase || '运输中' : {paused:'已暂停',delivered:'已到达 · 待交接',signed:'已签收',archived:'已归档',exception:'异常待处理',cancelled:'已取消',returning:'返回中'}[order?.status];

  if (compact) {
    if (!plan) return null;
    return <div className="delivery-route-compact">
      {selectedName && <span>{sent ? '运载设备' : '建议设备'} · {selectedName}</span>}
      {routeName && <span>{routeName}</span>}
      {numeric(plan.distanceMeters) && <span>模拟全程 {metres(plan.distanceMeters)}</span>}
    </div>;
  }

  const metrics = [
    ['前往取件', metres(plan?.pickupDistanceMeters)],
    ['取件后送达', metres(plan?.deliveryDistanceMeters)],
    ['全程', metres(plan?.distanceMeters)],
    ['预计到达电量', percent(plan?.batteryAfterEstimate)],
  ].filter(([, value]) => value);
  const reason = order?.dispatchReason ?? plan?.reason ?? selection?.reason;

  return <section className="delivery-route-summary" aria-label="配送路线与选车依据">
    <header>
      <h4>{selectedName ? (sent ? '已派设备' : '匹配设备') + ' · ' + selectedName : '设备匹配结果'}</h4>
      {plan && <span>{algorithmLabel[plan.algorithm] ?? '配送路线'} · 模拟</span>}
    </header>
    {routeName && <p className="delivery-route-locations">{routeName}</p>}
    {progress !== null && <div className="delivery-route-progress">
      <span>{progressLabel || '配送进度'} <strong>{Math.round(progress)}%</strong></span>
      <progress aria-label="模拟运输进度" max="100" value={progress}/>
    </div>}
    {metrics.length > 0 && <dl>{metrics.map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {(reason || otherCandidates.length > 0) && <details>
      <summary>选车依据{otherCandidates.length > 0 ? `与其他候选（${otherCandidates.length}）` : ''}</summary>
      {reason && <p>{reason}</p>}
      {numeric(plan?.reserveBatteryPercent) && <p>到达后需保留至少 {percent(plan.reserveBatteryPercent)} 电量。</p>}
      {numeric(plan?.estimatedDurationSeconds) && <p>按路线与模拟速度估算约 {Math.ceil(plan.estimatedDurationSeconds / 60)} 分钟。演示会加速推进，以设备回执为准。</p>}
      {otherCandidates.length > 0 && <ul>{otherCandidates.map(c => (
        <li key={c.resourceId ?? c.vehicleId ?? c.name}>
          <strong>{c.name ?? c.vehicleId ?? c.resourceId}</strong>
          <span>{candidateExplanation(c)}</span>
        </li>
      ))}</ul>}
    </details>}
  </section>;
}
