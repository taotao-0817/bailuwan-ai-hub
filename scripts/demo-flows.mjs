import {randomUUID} from 'node:crypto';
const base=process.env.API_BASE||`http://127.0.0.1:${process.env.PORT||8788}`;
let cookie='';
async function call(path,body){const response=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});const result=await response.json();if(!response.ok)throw new Error(`${path}: ${result.error?.message||response.status}`);if(path==='/login')cookie=response.headers.get('set-cookie').split(';')[0];return result;}
async function until(check,label){const deadline=Date.now()+60000;while(Date.now()<deadline){const snapshot=await call('/bootstrap');if(check(snapshot))return snapshot;await new Promise(resolve=>setTimeout(resolve,700));}throw new Error(`${label}：等待设备回执超时，请检查模拟器。`);}
try {
  await call('/login',{username:process.env.DEMO_USER||'admin',password:process.env.DEMO_PASSWORD||'Bailuwan2026!'});
  const health=await call('/health');if(!health.simulator.connected)throw new Error('设备模拟器离线，请先 npm start。');
  const snapshot=await call('/bootstrap');if(snapshot.takeover.active)throw new Error('请先由接管管理员解除接管，再运行流程演示。');
  const security=await call('/scenarios/security',{});
  for(const action of ['confirm','dispatch','resolve','review','archive'])await call(`/alerts/${security.id}/transition`,{action,assignee:'安保值班员',note:'端到端演示：现场核验与处理记录（模拟）'});
  console.log(`安防闭环完成：${security.id}`);
  const fire=await call('/scenarios/fire',{});
  await call(`/alerts/${fire.id}/transition`,{action:'confirm',note:'端到端消防演练：管理员已核验模拟告警'});
  await call(`/emergency/${fire.id}/execute`,{confirmed:true,idempotencyKey:randomUUID()});
  await until(s=>s.alerts.find(a=>a.id===fire.id)?.emergencySteps?.[2]?.status==='completed','消防联动');
  for(const action of ['resolve','review','archive'])await call(`/alerts/${fire.id}/transition`,{action,note:'端到端演练：设备回执已核对，模拟疏散完成并复核'});
  console.log(`消防演练闭环完成：${fire.id}`);
  const delivery=await call('/deliveries',{title:'端到端演示 · 园区资料包',from:'B06',to:'B04',weight:1,priority:'normal',idempotencyKey:randomUUID()});
  if(delivery.status!=='running')throw new Error('调度员派单未能进入运输。');

  await until(s=>s.deliveries.find(d=>d.id===delivery.id)?.status==='delivered','配送到达');
  await call(`/deliveries/${delivery.id}/action`,{action:'sign'});
  await call(`/deliveries/${delivery.id}/action`,{action:'archive'});
  const audit=await call('/audit/verify');
  console.log(`配送闭环完成：${delivery.id}；全程 ${delivery.routePlan.distanceMeters} 米`);
  console.log(`审计链：${audit.valid?'通过':'未通过'}，${audit.count} 条记录。`);
  console.log('已生成持久化演示记录，可在事件历史、全部订单与全部申请中查看。');
  await call('/logout',{});
}catch(error){console.error(error.message);process.exitCode=1;}
