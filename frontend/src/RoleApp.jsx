import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, ArrowUpRight, Bell, Box, Building2, Check, CheckCircle2, ChevronRight, ClipboardList, Clock, FileCheck2, Focus, Layers3, LayoutDashboard, Loader2, LogOut, MapPin, Package, Plus, Radio, Search, Send, Settings2, Shield, ShieldAlert, SlidersHorizontal, Sparkles, Truck, Users, Wind, Wrench, X} from 'lucide-react';
import {api, key} from './api.js';
import {DevicePage, SecurityPage, DeliveryPage, AttendancePage, ReportsPage, Drawer, ActionModal, Modal, Badge, IconButton} from './App.jsx';
import Login from './RoleLogin.jsx';
import HubPage from './HubPage.jsx';
import DeliveryRouteSummary from './DeliveryRouteSummary.jsx';
import ParkScene from './ParkScene.jsx';
import TwinHome from './TwinHome.jsx';
import {roleProfile, availableViews, validateLocation, filterRoleData, canReviewApproval, canManageRequest} from './rolePolicy.mjs';

const NAV_ICONS={home:LayoutDashboard,work:ClipboardList,space:Layers3,records:FileCheck2,service:Building2};
const TASK_LABELS={delivery:'配送',patrol:'巡检',meeting:'会议',fire:'消防',fall:'现场协助'};
const STATE_LABELS={planned:'待启动',awaiting_confirmation:'待管理员确认',awaiting_approval:'待审批',running:'执行中',waiting_human:'待人工反馈',paused:'已暂停',blocked:'资源受阻',completed:'已完成',failed:'执行失败',rejected:'已拒绝',cancelled:'已取消',pending:'待审批',approved:'已通过',withdrawn:'已撤回',queued:'待调度',pending_approval:'待审批',returning:'返航中',delivered:'待交接',signed:'已签收',archived:'已归档',exception:'异常待处理'};
const active=t=>!['completed','cancelled','rejected','failed'].includes(t.status);
const readableTime=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'—';
function currentLocation(role){const params=new URLSearchParams(window.location.hash.replace(/^#/,''));return validateLocation(role,{page:params.get('page')||'home',view:params.get('view'),taskId:params.get('task')});}
function statusLabel(task,data){if(task.status==='awaiting_approval'&&data.approvals?.some(a=>a.id===task.businessRefs?.approvalId&&a.status==='approved'))return '待调度';return STATE_LABELS[task.status]||task.status;}

export default function RoleApp(){
  const [raw,setRaw]=useState(null),[loading,setLoading]=useState(true),[connectionError,setConnectionError]=useState(''),[connected,setConnected]=useState(false);
  const fetching=useRef(false),epoch=useRef(0);
  const refresh=useCallback(async()=>{if(fetching.current)return;fetching.current=true;const requestEpoch=epoch.current;try{const result=await api('/bootstrap');if(requestEpoch===epoch.current){setRaw(result);setConnectionError('');}}catch(error){if(requestEpoch===epoch.current){if(error.status===401)setRaw(null);else setConnectionError(error.message);}}finally{fetching.current=false;setLoading(false);}},[]);
  useEffect(()=>{refresh();},[refresh]);
  const identity=raw?.user?.id;
  useEffect(()=>{if(!identity)return;const source=new EventSource('/api/events');source.onopen=()=>setConnected(true);source.addEventListener('update',refresh);source.onmessage=refresh;source.onerror=()=>setConnected(false);const timer=setInterval(refresh,10000);return()=>{source.close();clearInterval(timer);setConnected(false);};},[identity,refresh]);
  async function logout(){await api('/logout',{});epoch.current++;setRaw(null);setConnected(false);window.history.replaceState(null,'',window.location.pathname);}
  if(loading)return <div className="app-loading"><Loader2 size={28} className="spin"/><h1>正在连接园区</h1></div>;
  if(!raw)return <>{connectionError&&<div className="connection-error" role="alert">{connectionError}<button onClick={refresh}>重试连接</button></div>}<Login onLogin={refresh}/></>;
  return <RoleWorkspace key={identity} data={filterRoleData(raw)} refresh={refresh} connected={connected} connectionError={connectionError} logout={logout}/>;
}

function RoleWorkspace({data,refresh,connected,connectionError,logout}){
  const profile=roleProfile(data.user.role),isUser=data.user.role==='user',isAdmin=['super_admin','park_admin'].includes(data.user.role);
  const [location,setLocation]=useState(()=>currentLocation(data.user.role)),[selection,setSelection]=useState(null),[focus,setFocus]=useState(null),[floor,setFloor]=useState(0),[layer,setLayer]=useState('overview'),[sceneView,setSceneView]=useState('perspective'),[reset,setReset]=useState(0),[modal,setModal]=useState(null),[busy,setBusy]=useState(false),[toasts,setToasts]=useState([]),[composerRequest,setComposerRequest]=useState(null),[returnLocation,setReturnLocation]=useState(null),[search,setSearch]=useState('');
  const nav=profile.nav,views=availableViews(profile,location.page),canControl=['super_admin','park_admin','ops'].includes(data.user.role),canSecurity=['super_admin','park_admin','security'].includes(data.user.role),canApprove=isAdmin||data.user.role==='approver';
  const notify=useCallback((message,type='success')=>{const id=key();setToasts(old=>[...old.slice(-2),{id,message,type}]);setTimeout(()=>setToasts(old=>old.filter(t=>t.id!==id)),6500);},[]);
  const navigate=useCallback((page,view,taskId,replace=false)=>{const next=validateLocation(data.user.role,{page,view,taskId});const params=new URLSearchParams({page:next.page,view:next.view});if(next.taskId)params.set('task',next.taskId);window.history[replace?'replaceState':'pushState'](null,'','#'+params);setLocation(next);setSelection(null);},[data.user.role]);
  useEffect(()=>{const onPop=()=>{setLocation(currentLocation(data.user.role));setSelection(null);};window.addEventListener('popstate',onPop);window.addEventListener('hashchange',onPop);return()=>{window.removeEventListener('popstate',onPop);window.removeEventListener('hashchange',onPop);};},[data.user.role]);
  useEffect(()=>{const close=e=>{if(e.key==='Escape'&&!busy){setSelection(null);setModal(null);}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[busy]);
  async function act(path,body,message='操作已提交',onError){if(busy)return null;setBusy(true);try{const result=await api(path,body);await refresh();if(message)notify(message);return result;}catch(error){if(onError)onError(error.message);else notify(error.message,'error');return null;}finally{setBusy(false);}}
  function openTask(task){navigate(isUser?'work':data.user.role==='approver'?'service':'work',isUser?'hub':data.user.role==='approver'?'service':'hub',task.id);}
  function createTask(type){setComposerRequest({id:key(),type});navigate(data.user.role==='approver'?'service':'work',data.user.role==='approver'?'service':'hub');}
  function openSelection(target){if(isUser)return;setSelection(target);setFocus(target);setFloor(0);}
  function goLocation(buildingId){if(isUser)return;setReturnLocation(location);navigate('space','overview');setFloor(0);setFocus({kind:'building',id:buildingId});setSelection({kind:'building',id:buildingId});}
  function onTaskSelect(taskId){const params=new URLSearchParams(window.location.hash.slice(1));if(!['hub','service'].includes(params.get('view')))return;params.set('task',taskId);window.history.replaceState(null,'','#'+params);setLocation(old=>({...old,taskId}));}
  const selected=selection?.kind==='device'?data.devices.find(d=>d.id===selection.id):selection?.kind==='building'?data.buildings.find(b=>b.id===selection.id):selection?.kind==='alert'?data.alerts.find(a=>a.id===selection.id):null;
  const shared={data,act,busy,setModal,notify,goLocation,openSelection,canControl,canSecurity,canApprove};
  const hubVisible=['hub','resources','demo','service'].includes(location.view)&&location.page!=='home';
  const hubMode=location.view==='resources'?'resources':location.view==='demo'?'demo':isUser||location.page==='service'?'service':'tasks';
  const pageTitle=location.page==='home'?profile.homeTitle:nav.find(n=>n.id===location.page)?.label||profile.homeTitle;
  const pendingCount=(data.hub?.tasks||[]).filter(t=>['awaiting_confirmation','waiting_human','blocked'].includes(t.status)).length+data.approvals.filter(a=>canReviewApproval(data.user,a)).length;
  const helpers={navigate,createTask,openTask,setModal,openSelection,goLocation};
  const twinHome=location.page==='home'&&['super_admin','park_admin','security','ops'].includes(data.user.role);
  return <div className={'app role-app role-'+data.user.role+(twinHome?' role-twin-home':'')}>
    <a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();document.getElementById('main-content')?.focus();}}>跳到主内容</a>
    <aside className="role-sidebar" aria-label="工作区导航">
      <div className="role-brand"><div className="role-brand-symbol"><Layers3 size={25}/></div><div><strong>白鹭湾</strong><span>园区服务与运行</span></div></div>
      <div className="role-workspace-label">{profile.label}</div>
      <nav className="role-nav">{nav.map(item=>{const Icon=NAV_ICONS[item.id]||Box;return <button key={item.id} className={location.page===item.id?'active':''} aria-current={location.page===item.id?'page':undefined} onClick={()=>navigate(item.id)}><Icon size={20}/><span>{item.label}</span>{item.id==='work'&&pendingCount>0&&<small>{pendingCount}</small>}</button>;})}</nav>
      <div className="role-sidebar-footer"><div className="role-session-user"><span className="user-avatar">{data.user.name?.slice(0,1)}</span><div><strong>{data.user.name}</strong><small>{profile.label}</small></div></div><button onClick={async()=>{try{await logout();}catch(error){notify(error.message,'error');}}}><LogOut size={17}/>退出 / 切换账号</button><span className="role-mode-label"><i/>本地模拟环境</span></div>
    </aside>
    <main className="role-main" id="main-content" tabIndex={-1}>
      <header className="role-topbar"><div className="role-breadcrumb">白鹭湾园区<ChevronRight size={14}/><strong>{pageTitle}</strong></div><div className="role-top-actions"><span className={'role-connection '+(connected?'online':'')}><i/>{connected?'已同步':'连接中'}</span><button className="role-assistant-button" onClick={()=>createTask(isUser||data.user.role==='approver'?'meeting':undefined)}><Sparkles size={17}/>{isUser?'预订会议':'用自然语言发起'}</button>{!isUser&&<button className="icon-button" aria-label="查看待办" onClick={()=>navigate('home')}><Bell size={19}/>{pendingCount>0&&<span className="role-bell-dot"/>}</button>}</div></header>
      {data.takeover?.active&&<div className="takeover-banner" role="status"><ShieldAlert size={20}/><div><strong>人工接管中 · {data.takeover.actor||'授权管理员'}</strong><p>{readableTime(data.takeover.at)} · 自动执行已暂停，等待管理员检查恢复。</p></div>{data.user.role==='super_admin'&&<button onClick={()=>setModal({type:'takeover',release:true})}>检查并恢复</button>}</div>}
      {connectionError&&<div className="inline-error" role="alert">{connectionError}<button onClick={refresh}>重新连接</button></div>}
      {!data.simulator?.connected&&!isUser&&<div className="connection-banner"><Radio size={17}/>设备模拟器离线，当前显示最近状态；控制命令将等待回执。</div>}
      <div className="role-page-heading"><div><h1>{pageTitle}</h1><p>{location.page==='home'?profile.homeDescription:location.page==='space'?'查看空间位置、资源状态与设备反馈。':location.page==='work'?isUser?'查看你发起的服务、审批与预订进度。':'按职责查看任务，处理需要你参与的下一步。':location.page==='service'?'预订会议空间，查看自己的预订。':'查看历史记录与运行结果。'}</p></div>{data.user.role==='super_admin'&&<button className="secondary role-takeover" onClick={()=>setModal({type:'takeover',release:!!data.takeover?.active})}><Shield size={16}/>{data.takeover?.active?'恢复检查':'人工接管'}</button>}</div>
      {views.length>1&&<nav className="role-subnav" aria-label="当前工作区视图">{views.map(view=><button key={view.id} className={location.view===view.id?'active':''} aria-current={location.view===view.id?'page':undefined} onClick={()=>navigate(location.page,view.id)}>{view.label}</button>)}</nav>}
      {location.page==='home'&&(twinHome?<TwinHome data={data} profile={profile} {...helpers}/>:<Workbench data={data} profile={profile} {...helpers}/>)}
      <div hidden={!hubVisible} className="role-hub-surface"><HubPage {...shared} mode={hubMode} focusTaskId={location.taskId} composerRequest={composerRequest} onTaskSelect={onTaskSelect}/></div>
      {location.view==='overview'&&<section className="role-space-workspace">
        <div className="role-space-toolbar"><div className="role-scene-layers">{[['overview','综合'],['security','安防'],['energy','能耗'],['delivery','运输'],['devices','设备']].map(([value,label])=><button className={layer===value?'active':''} key={value} onClick={()=>setLayer(value)}>{label}</button>)}</div><label className="role-space-search"><Search size={17}/><input aria-label="搜索空间或设备" placeholder="搜索建筑或设备" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
        {search&&<div className="role-space-results">{[...data.buildings.map(b=>({...b,kind:'building'})),...data.devices.map(d=>({...d,kind:'device'}))].filter(x=>(x.name+' '+x.id).toLowerCase().includes(search.toLowerCase())).slice(0,8).map(x=><button key={x.id} onClick={()=>{openSelection({kind:x.kind,id:x.id});setSearch('');}}><MapPin size={16}/>{x.name}<small>{x.kind==='building'?'建筑':'设备'}</small></button>)}</div>}
        <div className="role-full-scene"><ParkScene buildings={data.buildings} devices={data.devices} alerts={data.alerts.filter(a=>a.status!=='archived')} patrols={data.patrols} deliveries={data.deliveries} layer={layer} selectedId={selection?.id} onSelect={openSelection} focusTarget={focus} resetKey={reset} view={sceneView} floor={floor}/><div className="role-scene-note"><MapPin size={15}/><span>白鹭湾园区<small>示意模型 · 模拟设备状态</small></span></div><div className="role-scene-tools"><button onClick={()=>setSceneView(sceneView==='top'?'perspective':'top')}>{sceneView==='top'?'3D 视图':'俯视图'}</button><button aria-label="复位视角" onClick={()=>{setReset(v=>v+1);setFocus(null);setSelection(null);setFloor(0);}}><Focus size={18}/></button></div>{returnLocation&&<button className="role-return-task" onClick={()=>{navigate(returnLocation.page,returnLocation.view,returnLocation.taskId);setReturnLocation(null);}}><ArrowLeft size={16}/>返回原任务</button>}</div>
        <div className="role-space-foot"><span>{data.buildings.length} 栋建筑 · {data.devices.length} 台接入设备</span><span>点击建筑 → 选择楼层 → 查看设备</span></div>
      </section>}
      {location.view==='devices'&&<DevicePage {...shared}/>}
      {location.view==='security'&&<SecurityPage {...shared}/>}
      {location.view==='delivery'&&<DeliveryPage {...shared}/>}
      {location.view==='oa'&&<ApprovalsView key={location.page} {...shared} history={location.page==='records'}/>}
      {location.view==='requests'&&<MyRequests {...shared} openTask={openTask}/>}
      {location.view==='attendance'&&<AttendancePage {...shared}/>}
      {location.view==='reports'&&<>{canControl&&<DispatchHistory deliveries={data.deliveries} devices={data.devices}/>}<ReportsPage {...shared}/></>}
      <footer className="system-footer"><span><i className={connected?'pulse-dot':'offline-dot'}/>{connected?'状态已同步':'等待状态同步'}</span><span>设备、通知与现场处置均为模拟</span></footer>
    </main>
    {selection&&selected&&<Drawer selection={selection} selected={selected} floor={floor} setFloor={setFloor} onClose={()=>{setSelection(null);setFloor(0);}} {...shared}/>}
    {modal&&(['serviceDelivery','serviceRepair','dispatchDelivery'].includes(modal.type)?<ServiceRequestModal modal={modal} {...shared} onClose={()=>setModal(null)} onCreated={message=>{notify(message);setModal(null);navigate('work',modal.type==='dispatchDelivery'?'delivery':isUser?'requests':canApprove?'oa':'hub');}}/>:<ActionModal modal={modal} {...shared} onClose={()=>setModal(null)}/>)}
    <div className="toast-stack" aria-live="polite">{toasts.map(t=><div key={t.id} className={'toast '+t.type}>{t.type==='error'?<ShieldAlert size={18}/>:<CheckCircle2 size={18}/>}<span>{t.message}</span><button aria-label="关闭提示" onClick={()=>setToasts(old=>old.filter(x=>x.id!==t.id))}><X size={16}/></button></div>)}</div>
  </div>;
}

function Workbench({data,profile,navigate,createTask,openTask,setModal,openSelection,goLocation}){
  const [allItems,setAllItems]=useState(false);
  const role=data.user.role,isUser=role==='user',isApprover=role==='approver',isOps=role==='ops',isSecurity=role==='security',tasks=data.hub?.tasks||[];
  const approvals=data.approvals.filter(a=>canReviewApproval(data.user,a));
  const alerts=data.alerts.filter(a=>a.status!=='archived');
  const offline=data.devices.filter(d=>d.status==='offline');
  const failedCommands=data.commands.filter(c=>['failed','timed_out'].includes(c.status));
  const relevantTasks=tasks.filter(active).sort((a,b)=>{const rank={awaiting_confirmation:0,waiting_human:1,blocked:2,awaiting_approval:3,planned:4,running:5,paused:6};return (rank[a.status]??9)-(rank[b.status]??9);});
  const myApprovals=data.approvals.filter(a=>a.requesterId===data.user.id);
  const titleType=a=>({delivery:'配送申请',maintenance:'维修申请',purchase:'采购申请',permission:'权限申请',incident:'异常报告'}[a.type]||'申请');
  let stats=isUser?[
    ['待审批',myApprovals.filter(a=>a.status==='pending').length,'你的服务申请',Clock],['服务进行中',data.deliveries.filter(d=>['queued','running','paused','delivered'].includes(d.status)).length,'配送与交接',Package],['会议预订',tasks.filter(t=>t.type==='meeting'&&t.status==='completed').length,'已完成的预订任务',Building2]
  ]:isApprover?[
    ['待我审批',approvals.length,'当前可由你处理',FileCheck2],['已转交',data.approvals.filter(a=>a.status==='pending'&&a.assignee&&a.assignee!==data.user.id).length,'等待其他审批人',Users],['已结束',data.approvals.filter(a=>a.status!=='pending').length,'当前可见申请',CheckCircle2]
  ]:isOps?[
    ['离线设备',offline.length,'需要检查通信或设备',Radio],['异常回执',failedCommands.length,'最近控制记录',ShieldAlert],['配送执行中',data.deliveries.filter(d=>['running','returning'].includes(d.status)).length,'在途运载设备',Truck],['执行中任务',tasks.filter(t=>t.status==='running').length,'正在返回执行反馈',ClipboardList]
  ]:[
    ['待处理事件',alerts.length,'尚未归档',ShieldAlert],['待人工确认',tasks.filter(t=>['awaiting_confirmation','waiting_human'].includes(t.status)).length,isSecurity?'高风险联动由管理员确认':'等待决定或结果反馈',FileCheck2],['执行中任务',tasks.filter(t=>t.status==='running').length,'配送与巡检',Truck],['资源受阻',tasks.filter(t=>t.status==='blocked').length,'需要重新分配资源',Radio]
  ];
  const rows=isUser?myApprovals.filter(a=>a.status==='pending').map(a=>({id:a.id,title:a.title,detail:titleType(a)+' · '+readableTime(a.createdAt),state:'待审批',action:()=>navigate('work','requests'),icon:FileCheck2})):isApprover?approvals.map(a=>({id:a.id,title:a.title,detail:a.requester+' · '+titleType(a),state:'待我审批',action:()=>navigate('work','oa'),icon:FileCheck2})):isOps?[
    ...offline.map(d=>({id:d.id,title:d.name,detail:data.buildings.find(b=>b.id===d.buildingId)?.name+' · 设备离线',state:'待检查',action:()=>openSelection({kind:'device',id:d.id}),icon:Wrench})),
    ...data.deliveries.filter(d=>d.status==='queued').map(d=>({id:d.id,title:d.title,detail:'审批通过 · '+data.buildings.find(b=>b.id===d.to)?.name,state:'待调度',action:()=>navigate('work','delivery'),icon:Truck})),
    ...data.deliveries.filter(d=>['delivered','exception'].includes(d.status)).map(d=>({id:d.id,title:d.title,detail:d.exception||'查看订单与处理记录',state:d.status==='delivered'?'待交接':'异常待处理',action:()=>navigate('work','delivery'),icon:Truck})),
    ...relevantTasks.filter(t=>['blocked','waiting_human','paused'].includes(t.status)).map(t=>({id:t.id,title:t.title,detail:TASK_LABELS[t.type]+' · '+(t.error||'查看下一步操作'),state:statusLabel(t,data),action:()=>openTask(t),icon:ClipboardList}))
  ]:[
    ...relevantTasks.filter(t=>['awaiting_confirmation','waiting_human','blocked'].includes(t.status)).map(t=>({id:t.id,title:t.title,detail:TASK_LABELS[t.type]+' · '+(t.error||t.riskReason||'需要人工参与'),state:statusLabel(t,data),action:()=>openTask(t),icon:ShieldAlert})),
    ...alerts.map(a=>({id:a.id,title:a.title,detail:(data.buildings.find(b=>b.id===a.buildingId)?.name||'公共区域')+' · '+readableTime(a.createdAt),state:{detected:'待确认',confirmed:'已确认',dispatched:'处置中',resolved:'待复核',reviewed:'待归档'}[a.status]||'待处理',action:()=>openSelection({kind:'alert',id:a.id}),icon:ShieldAlert})),
    ...approvals.map(a=>({id:a.id,title:a.title,detail:a.requester+' · '+titleType(a),state:'待审批',action:()=>navigate('work','oa'),icon:FileCheck2}))
  ];
  return <div className={'workbench '+(isUser?'workbench-service':'')}>
    {isUser&&<section className="service-launchpad"><div><span className="workbench-kicker">发起服务</span><h2>今天需要什么帮助？</h2><p>提交需求后，在“我的申请”持续查看处理进度。</p></div><div className="workbench-shortcuts"><button onClick={()=>setModal({type:'serviceDelivery'})}><Package size={24}/><strong>申请配送</strong><span>物品、起终点与重量</span><ArrowUpRight size={17}/></button><button onClick={()=>createTask('meeting')}><Building2 size={24}/><strong>预订会议</strong><span>告诉我们时间与人数</span><ArrowUpRight size={17}/></button><button onClick={()=>setModal({type:'serviceRepair'})}><Wrench size={24}/><strong>提交报修</strong><span>描述位置与故障情况</span><ArrowUpRight size={17}/></button></div></section>}
    <div className="workbench-stats">{stats.map(([label,count,hint,Icon])=><section className="workbench-stat" key={label}><div><span>{label}</span><Icon size={19}/></div><strong>{count}<small>项</small></strong><p>{hint}</p></section>)}</div>
    <div className="workbench-grid"><section className="workbench-panel"><div className="workbench-panel-heading"><div><span className="workbench-kicker">{isUser?'服务跟进':isApprover?'审批队列':'当前优先事项'}</span><h2>{isUser?'待处理的申请':isApprover?'待我审批':'需要关注'}</h2></div><button onClick={()=>setAllItems(value=>!value)}>{allItems?'收起':'查看全部'}<ArrowRight size={16}/></button></div><div className="workbench-rows">{rows.length?rows.slice(0,allItems?rows.length:5).map(row=><button className="workbench-row" key={row.id} onClick={row.action}><span className="workbench-row-icon"><row.icon size={19}/></span><span className="workbench-row-copy"><strong>{row.title}</strong><small>{row.detail}</small></span><span className="workbench-row-status">{row.state}</span><ChevronRight size={16}/></button>):<div className="workbench-empty"><CheckCircle2 size={30}/><h3>{isUser?'暂无待审批的申请':'当前没有待处理事项'}</h3><p>{isUser?'可以发起配送、会议或报修服务。':'新的任务与异常会在这里显示。'}</p></div>}</div></section>
      {(isUser||isApprover)?<section className="workbench-panel"><div className="workbench-panel-heading"><div><span className="workbench-kicker">我的日程</span><h2>会议预订</h2></div><button onClick={()=>createTask('meeting')}><Plus size={17}/>预订</button></div>{tasks.filter(t=>t.type==='meeting'&&t.requesterId===data.user.id).slice(0,4).map(t=><button className="workbench-row" key={t.id} onClick={()=>openTask(t)}><Building2 size={21}/><span className="workbench-row-copy"><strong>{t.title}</strong><small>{readableTime(t.params?.startAt)} · {t.params?.participants||'—'} 人</small></span><span>{statusLabel(t,data)}</span><ChevronRight size={16}/></button>)}{!tasks.some(t=>t.type==='meeting'&&t.requesterId===data.user.id)&&<div className="workbench-empty"><Building2 size={30}/><h3>还没有会议预订</h3><p>输入时间、人数，系统会匹配可用空间。</p><button className="secondary" onClick={()=>createTask('meeting')}>预订会议</button></div>}</section>:<section className="workbench-panel workbench-space-panel"><div className="workbench-panel-heading"><div><span className="workbench-kicker">空间定位</span><h2>园区现场</h2></div><button onClick={()=>navigate('space','overview')}>进入空间<ArrowUpRight size={16}/></button></div><div className="workbench-scene"><ParkScene buildings={data.buildings} devices={data.devices} alerts={alerts} deliveries={data.deliveries} patrols={data.patrols} showLabels={false} onSelect={s=>{navigate('space','overview');openSelection(s);}}/><div className="workbench-scene-overlay"><MapPin size={16}/>白鹭湾 · {data.buildings.length} 栋建筑</div><span className="workbench-scene-footer">程序化示意模型</span></div></section>}
    </div>
    {!isUser&&!isApprover&&<section className="workbench-panel workbench-running"><div className="workbench-panel-heading"><div><span className="workbench-kicker">任务跟踪</span><h2>进行中的工作</h2></div><button className="primary" onClick={()=>createTask(isSecurity?'patrol':isOps?'delivery':undefined)}><Plus size={17}/>新建任务</button></div>{relevantTasks.length?relevantTasks.slice(0,4).map(t=><button className="workbench-row" key={t.id} onClick={()=>openTask(t)}><ClipboardList size={21}/><span className="workbench-row-copy"><strong>{t.title||t.goal}</strong><small>{TASK_LABELS[t.type]} · {readableTime(t.createdAt)}</small></span><span className="workbench-row-status">{statusLabel(t,data)}</span><ChevronRight size={16}/></button>):<div className="workbench-empty compact"><p>当前没有进行中的任务。可用自然语言创建配送、巡检或会议任务。</p></div>}</section>}
  </div>;
}

function DispatchHistory({deliveries,devices}){
  const [limit,setLimit]=useState(5);
  const orders=deliveries.filter(order=>order.routePlan).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  return <section className="workbench-panel dispatch-history">
    <div className="workbench-panel-heading"><h2>配送调度记录</h2><span>{orders.length} 单</span></div>
    {orders.slice(0,limit).map(order=><details className="hub-collapse" key={order.id}>
      <summary>{order.title} · {devices.find(device=>device.id===order.vehicleId)?.name||'运载设备'} · {STATE_LABELS[order.status]||order.status}</summary>
      <p>{readableTime(order.createdAt)} · {order.id}</p><DeliveryRouteSummary order={order}/>
    </details>)}
    {orders.length===0&&<p>完成首次派单后，可在这里查看设备、取件路线和选车依据。</p>}
    {limit<orders.length&&<button className="text-button" onClick={()=>setLimit(value=>value+10)}>更多记录</button>}
  </section>;
}

function ApprovalsView({data,act,busy,setModal,history=false}){
  const [expanded,setExpanded]=useState(null),[filter,setFilter]=useState(history?'all':'pending');
  const records=data.approvals.filter(a=>filter==='all'||canReviewApproval(data.user,a));
  return <section className="panel role-approvals"><div className="management-heading"><h2>{history?'审批记录':'申请审批'}</h2><div className="segmented"><button className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>待我审批</button><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>全部可见申请</button></div></div>{records.length?records.map(a=><article className="approval-card" key={a.id}><button className="approval-main role-approval-summary" aria-expanded={expanded===a.id} onClick={()=>setExpanded(expanded===a.id?null:a.id)}><FileCheck2 size={22}/><span className="workbench-row-copy"><strong>{a.title}</strong><small>{a.requester} · {readableTime(a.createdAt)}{a.assigneeName?' · 已转交 '+a.assigneeName:''}</small></span><Badge status={a.status}/><ChevronRight size={17}/></button>{expanded===a.id&&<div className="approval-detail"><p>{a.description||'暂无补充说明'}</p>{a.result&&<div className="notice">{typeof a.result==='string'?a.result:'执行结果已记录'}</div>}<div className="button-row">{canReviewApproval(data.user,a)&&<><button className="primary" disabled={busy||data.takeover?.active} onClick={()=>act('/approvals/'+a.id+'/action',{action:'approve',note:'已核对申请内容与执行条件'},'审批通过；关联业务将进入下一阶段')}><Check size={16}/>同意申请</button><button className="secondary" disabled={busy} onClick={()=>setModal({type:'approvalAction',id:a.id,action:'reject'})}>驳回</button><button className="secondary" disabled={busy} onClick={()=>setModal({type:'approvalAction',id:a.id,action:'transfer'})}>转交</button></>}{canManageRequest(data.user,a)&&<button className="secondary" disabled={busy} onClick={()=>act('/approvals/'+a.id+'/action',{action:'remind'},'已记录催办')}>催办</button>}</div><details className="role-record-details"><summary>记录编号与流转</summary><p>{a.id}{a.relatedId?' · 关联 '+a.relatedId:''}</p>{a.history?.map((h,i)=><p key={i}>{readableTime(h.at)} · {h.actor} · {h.note||({approve:'审批通过',reject:'驳回',transfer:'转交',remind:'催办',withdraw:'撤回'}[h.action])}</p>)}</details></div>}</article>):<div className="workbench-empty"><CheckCircle2 size={30}/><h3>没有待你审批的申请</h3><p>已转交其他人的申请可在全部列表查看。</p></div>}</section>;
}

function MyRequests({data,act,busy,openTask}){
  const [filter,setFilter]=useState('active'),[withdraw,setWithdraw]=useState(null),[note,setNote]=useState('');
  const rows=data.approvals.filter(a=>a.requesterId===data.user.id).filter(a=>{
    if(filter==='all'||a.status==='pending')return true;
    if(a.status!=='approved')return false;
    const delivery=data.deliveries.find(d=>d.id===a.relatedId);
    return delivery?!['archived','cancelled','signed'].includes(delivery.status):!!a.executionTask&&!['completed','failed','cancelled'].includes(a.executionTask.status);
  });
  return <section className="panel role-my-requests"><div className="management-heading"><h2>我的服务申请</h2><div className="segmented"><button className={filter==='active'?'active':''} onClick={()=>setFilter('active')}>进行中</button><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>全部记录</button></div></div>{rows.map(a=>{const delivery=data.deliveries.find(d=>d.id===a.relatedId);return <article className="approval-card role-request-card" key={a.id}><div className="approval-main"><Package size={22}/><span className="workbench-row-copy"><strong>{a.title}</strong><small>{readableTime(a.createdAt)} · {a.description}</small></span><span className="workbench-row-status">{delivery?STATE_LABELS[delivery.status]:STATE_LABELS[a.status]}</span></div>{a.result&&<p className="role-request-result">{typeof a.result==='string'?a.result:'处理结果已更新'}</p>}{delivery&&<p className="role-request-result">{data.buildings.find(b=>b.id===delivery.from)?.name} → {data.buildings.find(b=>b.id===delivery.to)?.name}{delivery.status==='running'?' · 运输进度 '+Math.round(delivery.progress||0)+'%':''}{delivery.status==='queued'?' · 等待运营人员调度':''}</p>}{delivery?.routePlan&&<DeliveryRouteSummary order={delivery} compact/>}{canManageRequest(data.user,a)&&<div className="button-row"><button className="secondary" disabled={busy} onClick={()=>act('/approvals/'+a.id+'/action',{action:'remind'},'已记录催办')}>催办</button><button className="text-button" disabled={busy} onClick={()=>{setWithdraw(a);setNote('');}}>撤回申请</button></div>}</article>;})}{!rows.length&&<div className="workbench-empty"><ClipboardList size={30}/><h3>暂无申请记录</h3><p>从“我的服务”发起配送或报修；会议在“会议预订”查看。</p></div>}{withdraw&&<Modal title="撤回申请" subtitle={withdraw.title} onClose={()=>setWithdraw(null)}><p>撤回后将停止该申请的审批；关联配送也会取消，记录保留。</p><form onSubmit={async e=>{e.preventDefault();const result=await act('/approvals/'+withdraw.id+'/action',{action:'withdraw',note},'申请已撤回');if(result)setWithdraw(null);}}><label>撤回说明<textarea value={note} onChange={e=>setNote(e.target.value)} required minLength={2}/></label><div className="modal-actions"><button type="button" className="secondary" onClick={()=>setWithdraw(null)}>返回</button><button className="danger" disabled={busy}>确认撤回</button></div></form></Modal>}</section>;
}

function ServiceRequestModal({modal,data,act,busy,onClose,onCreated}){
  const dispatcher=modal.type==='dispatchDelivery';
  const delivery=dispatcher||modal.type==='serviceDelivery',buildings=data.buildings||[];
  const [recipient,setRecipient]=useState(''),[priority,setPriority]=useState('normal');
  const submission=useRef(null);
  const [title,setTitle]=useState(''),[from,setFrom]=useState(buildings[0]?.id||''),[to,setTo]=useState(buildings[1]?.id||''),[weight,setWeight]=useState(1),[description,setDescription]=useState(''),[error,setError]=useState('');
  async function submit(event){
    event.preventDefault();setError('');
    if(delivery&&from===to){setError('取件起点与送达地点不能相同。');return;}
    const payload=delivery?{title,from,to,weight:Number(weight),priority,recipient:recipient.trim()||undefined}:{title,type:'maintenance',description};
    const signature=JSON.stringify(payload);
    if(submission.current?.signature!==signature)submission.current={signature,id:key()};
    const result=await act(delivery?'/deliveries':'/approvals',{...payload,idempotencyKey:submission.current.id},'',setError);
    if(result){onCreated(dispatcher?'已派单，正在模拟运输。':delivery?'配送申请已提交，等待审批。':'报修申请已提交。');}
  }
  return <Modal title={dispatcher?'派发配送任务':delivery?'申请物品配送':'提交报修'} subtitle={dispatcher?'系统将选择能够完成全程的最近设备。通过校验后立即出发。':delivery?'审批通过后由运营人员安排运载设备。':'填写位置与故障现象，便于工作人员处理。'} onClose={onClose}><form onSubmit={submit}><label>{delivery?'配送物品':'报修事项'}<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder={delivery?'例如：会议资料，2 份':'例如：研发中心 2F 会议室空调不制冷'}/></label>{delivery?<div className="form-grid"><label>取件起点<select value={from} onChange={e=>setFrom(e.target.value)}>{buildings.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label><label>送达地点<select value={to} onChange={e=>setTo(e.target.value)}>{buildings.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label><label>交接岗位<input maxLength={80} value={recipient} onChange={event=>setRecipient(event.target.value)} placeholder="例如：前台值班岗"/></label>{dispatcher&&<label>优先级<select value={priority} onChange={event=>setPriority(event.target.value)}><option value="normal">普通</option><option value="urgent">紧急</option></select></label>}<label>总重量（kg）<input type="number" min="0.01" max="20" step="0.01" required value={weight} onChange={e=>setWeight(e.target.value)}/></label></div>:<label>位置与情况<textarea required maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} placeholder="所在建筑、楼层、具体位置及故障现象"/></label>}{error&&<div className="inline-error" role="alert">{error}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>返回</button><button className="primary" disabled={busy||data.takeover?.active}>{busy?<Loader2 className="spin" size={16}/>:<Send size={16}/>}{dispatcher?'校验并派单':'提交申请'}</button></div></form></Modal>;
}
