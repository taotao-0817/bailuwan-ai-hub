import React, {useState} from 'react';
import {ArrowRight, Layers3, Loader2, Shield} from 'lucide-react';
import {api} from './api.js';

const accounts=[
  ['admin','总控管理员','总览、任务调度、审批与系统接管'],
  ['park','园区管理员','园区运行、资源调度与事件处置'],
  ['security','安保值班员','现场事件、巡检任务与到岗复核'],
  ['ops','设备运维员','设备异常、控制回执与配送调度'],
  ['approver','流程审批员','待办申请、审批结果与会议预订'],
  ['viewer','园区用户','申请配送、会议预订与报修进度'],
];
export default function RoleLogin({onLogin}){
  const [username,setUsername]=useState('admin'),[password,setPassword]=useState('Bailuwan2026!'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const account=accounts.find(item=>item[0]===username);
  async function submit(event){event.preventDefault();setBusy(true);setError('');try{await api('/login',{username,password});await onLogin();}catch(error){setError(error.message);}finally{setBusy(false);}}
  return <div className="login-screen"><div className="login-art"><div className="brand"><span className="brand-symbol"><Layers3 size={26}/></span><div><strong>白鹭湾</strong><small>园区服务与运行</small></div></div><div className="login-art-copy"><h1>进入你的<br/>园区工作区</h1><p>根据登录身份显示服务、待办和操作。</p><div className="login-grid-art"><div/><div/><div/><div/><div/></div></div></div><div className="login-panel"><span className="tag"><i/> 本地模拟演示</span><h2>登录白鹭湾</h2><p>选择账号，体验对应角色的工作台。</p><form onSubmit={submit}><label>演示账号<select value={username} onChange={e=>setUsername(e.target.value)}>{accounts.map(([value,label])=><option key={value} value={value}>{label} · {value}</option>)}</select></label><p className="role-login-scope" aria-live="polite">{account[2]}</p><label>登录密码<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div className="inline-error" role="alert">{error}</div>}<button className="primary login-submit" disabled={busy}>{busy?<Loader2 size={18} className="spin"/>:<ArrowRight size={18}/>}进入工作区</button></form><div className="login-note"><Shield size={18}/><p>默认演示密码已填入。<br/>设备与通知均为模拟。</p></div></div><footer>白鹭湾园区 · Demo<span>切换账号可查看不同角色界面</span></footer></div>;
}
