import React, {useState} from 'react';
import {ArrowUpRight, Bell, CheckCircle2, ChevronRight, ClipboardList, Eye, EyeOff, Focus, Layers3, MapPin, PanelRightClose, PanelRightOpen, Radio, ShieldAlert, Truck, Wrench} from 'lucide-react';
import ParkScene from './ParkScene.jsx';
import {canReviewApproval} from './rolePolicy.mjs';
import './twin-home.css';

const TASK_NAMES = {delivery:'配送',patrol:'巡检',meeting:'会议',fire:'消防',fall:'现场协助'};
const STATE_NAMES = {planned:'待启动',awaiting_confirmation:'待确认',awaiting_approval:'待审批',running:'执行中',waiting_human:'待人工反馈',paused:'已暂停',blocked:'资源受阻',completed:'已完成',failed:'执行失败',rejected:'已拒绝',cancelled:'已取消'};
const CLOSED = new Set(['completed','cancelled','rejected','failed']);
const PRIORITY = {awaiting_confirmation:0,waiting_human:1,blocked:2,paused:3,awaiting_approval:4,planned:5,running:6};

function DeliveryProgress({task,deliveries}) {
  if(task.type!=='delivery')return null;
  const order=deliveries.find(item=>item.id===task.businessRefs?.deliveryId);
  if(!order||!Number.isFinite(order.progress))return null;
  const progress=Math.round(Math.max(0,Math.min(100,order.progress)));
  return <span className="twin-delivery-progress"><span role="progressbar" aria-label="配送进度" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><i style={{width:progress+'%'}}/></span><small>{progress}%</small></span>;
}

export default function TwinHome({data,profile,navigate,createTask,openTask,setModal,openSelection}) {
  const [layer,setLayer] = useState('overview');
  const [showLabels,setShowLabels] = useState(false);
  const [showPanels,setShowPanels] = useState(true);
  const [view,setView] = useState('perspective');
  const [resetKey,setResetKey] = useState(0);
  const isOps = data.user.role === 'ops';
  const isSecurity = data.user.role === 'security';
  const tasks = (data.hub?.tasks || []).filter(task=>!CLOSED.has(task.status)).sort((a,b)=>(PRIORITY[a.status]??9)-(PRIORITY[b.status]??9));
  const devices = data.devices || [];
  const alerts = (data.alerts || []).filter(alert=>alert.status!=='archived');
  const offline = devices.filter(device=>device.status==='offline');
  const deliveries = data.deliveries || [];
  const approvals = (data.approvals || []).filter(approval=>canReviewApproval(data.user,approval));
  const manualTasks = tasks.filter(task=>['awaiting_confirmation','waiting_human','blocked'].includes(task.status));
  const buildingName = id => data.buildings.find(building=>building.id===id)?.name || '公共区域';
  const locate = selection => { navigate('space','overview'); openSelection(selection); };
  const rows = isOps ? [
    ...offline.map(device=>({id:device.id,title:device.name,detail:buildingName(device.buildingId),state:'设备离线',Icon:Wrench,onClick:()=>locate({kind:'device',id:device.id})})),
    ...deliveries.filter(order=>['queued','delivered','exception'].includes(order.status)).map(order=>({id:order.id,title:order.title,detail:buildingName(order.to),state:{queued:'待调度',delivered:'待交接',exception:'异常待处理'}[order.status],Icon:Truck,onClick:()=>navigate('work','delivery')})),
    ...manualTasks.map(task=>({id:task.id,title:task.title||task.goal,detail:TASK_NAMES[task.type],state:STATE_NAMES[task.status],Icon:ClipboardList,onClick:()=>openTask(task)})),
  ] : [
    ...manualTasks.map(task=>({id:task.id,title:task.title||task.goal,detail:TASK_NAMES[task.type],state:STATE_NAMES[task.status],Icon:ShieldAlert,onClick:()=>openTask(task)})),
    ...alerts.map(alert=>({id:alert.id,title:alert.title,detail:buildingName(alert.buildingId),state:{detected:'待确认',confirmed:'已确认',dispatched:'处置中',resolved:'待复核',reviewed:'待归档'}[alert.status]||'待处理',Icon:ShieldAlert,onClick:()=>locate({kind:'alert',id:alert.id})})),
    ...approvals.map(approval=>({id:approval.id,title:approval.title,detail:approval.requester,state:'待审批',Icon:ClipboardList,onClick:()=>navigate('work','oa')})),
  ];
  const stats = isOps ? [
    {label:'离线设备',value:offline.length,unit:'台',Icon:Radio,onClick:()=>navigate('space','devices'),attention:offline.length>0},
    {label:'异常回执',value:(data.commands||[]).filter(command=>['failed','timed_out'].includes(command.status)).length,unit:'条',Icon:Wrench,onClick:()=>navigate('space','devices')},
    {label:'运输中',value:deliveries.filter(order=>['running','returning'].includes(order.status)).length,unit:'单',Icon:Truck,onClick:()=>navigate('work','delivery')},
    {label:'执行中任务',value:tasks.filter(task=>task.status==='running').length,unit:'项',Icon:ClipboardList,onClick:()=>navigate('work','hub')},
  ] : [
    {label:'待处理事件',value:alerts.length,unit:'起',Icon:ShieldAlert,onClick:()=>navigate('work','security'),attention:alerts.length>0},
    {label:'待人工参与',value:manualTasks.length,unit:'项',Icon:Bell,onClick:()=>navigate('work','hub')},
    {label:'执行中任务',value:tasks.filter(task=>task.status==='running').length,unit:'项',Icon:ClipboardList,onClick:()=>navigate('work','hub')},
    {label:'设备在线',value:devices.filter(device=>device.status!=='offline').length,unit:`/ ${devices.length}`,Icon:Radio,onClick:()=>navigate('space',isSecurity?'resources':'devices')},
  ];
  const liveTasks = [...tasks].sort((a,b)=>Number(b.status==='running')-Number(a.status==='running')).slice(0,2);

  return <section className={'twin-home '+(!showPanels?'twin-home-quiet':'')} aria-label="园区三维总览">
    <div className="twin-home-scene"><ParkScene buildings={data.buildings} devices={devices} alerts={alerts} deliveries={deliveries} patrols={data.patrols||[]} layer={layer} showLabels={showLabels} view={view} resetKey={resetKey} onSelect={locate} framing="home"/></div>
    <header className="twin-home-heading">
      <div className="twin-home-title"><span><MapPin size={15}/>白鹭湾 · {profile.label}</span><h1>{profile.homeTitle}</h1></div>
      <div className="twin-heading-actions">
        {data.user.role==='super_admin'&&<button className="twin-glass twin-takeover" aria-label={data.takeover?.active?'人工接管恢复检查':'人工接管'} title={data.takeover?.active?'恢复检查':'人工接管'} onClick={()=>setModal({type:'takeover',release:!!data.takeover?.active})}><ShieldAlert size={16}/><span>{data.takeover?.active?'恢复检查':'人工接管'}</span></button>}
        <button className="twin-glass twin-panel-toggle" aria-label={showPanels?'隐藏信息面板':'显示信息面板'} aria-pressed={!showPanels} onClick={()=>setShowPanels(value=>!value)}>{showPanels?<PanelRightClose size={18}/>:<PanelRightOpen size={18}/>}<span>{showPanels?'收起面板':'显示面板'}</span></button>
      </div>
    </header>
    {showPanels&&<div className="twin-stat-strip twin-glass" aria-label="当前运行指标">{stats.map(({label,value,unit,Icon,onClick,attention})=><button key={label} className={'twin-stat '+(attention?'needs-attention':'')} onClick={onClick}><span className="twin-stat-label"><Icon size={15}/>{label}</span><strong>{value}<small>{unit}</small></strong></button>)}</div>}
    <nav className="twin-layer-switch twin-glass" aria-label="场景图层">{[['overview','综合'],['security','安防'],['delivery','运输'],['devices','设备']].map(([id,label])=><button key={id} className={layer===id?'active':''} aria-pressed={layer===id} onClick={()=>setLayer(id)}>{id==='overview'&&<Layers3 size={16}/>}<span>{label}</span></button>)}</nav>
    {showPanels&&<aside className="twin-priority twin-glass" aria-label="需要关注的事项">
      <div className="twin-panel-heading"><div><span className="twin-eyebrow">当前待办</span><h2>需要关注 <small>{rows.length}</small></h2></div><Bell size={19}/></div>
      <div className="twin-priority-list">{rows.length?rows.slice(0,3).map(row=><button className="twin-priority-row" key={row.id} onClick={row.onClick}><span className="twin-priority-icon"><row.Icon size={18}/></span><span className="twin-row-copy"><strong>{row.title}</strong><small>{row.detail}</small><span className="twin-row-state">{row.state}</span></span><ChevronRight size={15}/></button>):<div className="twin-empty"><CheckCircle2 size={24}/><strong>暂无待处理事项</strong><span>新的任务与异常会在此显示</span></div>}</div>
      <button className="twin-panel-more" onClick={()=>navigate('work',isOps?'hub':isSecurity?'security':'hub')}>进入{isOps?'任务调度':isSecurity?'事件与巡检':'任务与事件'}<ArrowUpRight size={16}/></button>
    </aside>}
    <div className="twin-scene-tools twin-glass" aria-label="场景工具">
      <button aria-pressed={view==='top'} onClick={()=>setView(value=>value==='top'?'perspective':'top')}>{view==='top'?'3D 视角':'俯视图'}</button>
      <button aria-label="复位视角" title="复位视角" onClick={()=>{setView('perspective');setResetKey(value=>value+1);}}><Focus size={18}/></button>
      <button aria-label={showLabels?'隐藏建筑标签':'显示建筑标签'} title={showLabels?'隐藏建筑标签':'显示建筑标签'} aria-pressed={showLabels} onClick={()=>setShowLabels(value=>!value)}>{showLabels?<Eye size={18}/>:<EyeOff size={18}/>}</button>
      <button onClick={()=>navigate('space','overview')}>空间详情<ArrowUpRight size={16}/></button>
    </div>
    {showPanels&&<section className="twin-task-dock twin-glass" aria-label="任务动态"><div className="twin-task-heading"><h2>任务动态</h2><button onClick={()=>createTask(isSecurity?'patrol':isOps?'delivery':undefined)}>发起任务<ArrowUpRight size={16}/></button></div><div className="twin-task-items">{liveTasks.length?liveTasks.map(task=><button className="twin-task-item" key={task.id} onClick={()=>openTask(task)}><span className={'twin-task-dot '+(task.status==='running'?'running':'')}/><span className="twin-row-copy"><strong>{task.title||task.goal}</strong><small>{TASK_NAMES[task.type]} · {STATE_NAMES[task.status]||task.status}</small><DeliveryProgress task={task} deliveries={deliveries}/></span><ChevronRight size={16}/></button>):<p className="twin-task-empty">当前没有进行中的任务</p>}</div></section>}
    <div className="twin-map-caption"><span>程序化示意模型 · 模拟设备状态</span><span>拖动旋转 · 滚轮缩放 · 点击定位</span></div>
  </section>;
}
