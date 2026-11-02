import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ModelPlanner, TASK_SCHEMA} from '../backend/llm.mjs';

const key='test-only-deepseek-provider-key';
const context={buildings:[{id:'B01',name:'科创中心',code:'A1'},{id:'B02',name:'研发中心',code:'A2'}],now:'2026-11-01T00:00:00.000Z',timeZone:'Asia/Shanghai'};
const valid={type:'delivery',summary:'从科创中心送2公斤文件到研发中心',from:'B01',to:'B02',buildingId:null,floor:null,weight:2,recipient:'研发联络岗',participants:null,attendees:[],startAt:null,endAt:null,clarifications:[],confidence:.96};
const response=(value=valid,finishReason='stop')=>({id:'deepseek-test-request',model:'deepseek-flash',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(value)},finish_reason:finishReason}],usage:{prompt_tokens:220,completion_tokens:100,total_tokens:320}});
const config=baseUrl=>({provider:'deepseek',mode:'model',baseUrl,model:'deepseek-flash',protocol:'chat_completions',apiKey:key,timeoutMs:2000});
async function mock(t,handler){
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push({path:req.url,headers:req.headers,body:JSON.parse(raw)});
    await handler(req,res);
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return{requests,baseUrl:'http://127.0.0.1:'+server.address().port};
}
const json=(res,body,status=200,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));};
const goal='请从科创中心配送2公斤文件到研发中心';

test('DeepSeek uses supported JSON Chat fields and validates a completed task before returning it',async t=>{
  const api=await mock(t,(_,res)=>json(res,response()));
  const planner=new ModelPlanner(config(api.baseUrl));
  const result=await planner.interpret({goal,context});
  assert.equal(api.requests.length,1);
  const {path,body,headers}=api.requests[0];
  assert.equal(path,'/chat/completions');
  assert.equal(headers.authorization,'Bearer '+key);
  assert.equal(body.model,'deepseek-flash');
  assert.equal(body.max_tokens,2200);
  assert.deepEqual(body.response_format,{type:'json_object'});
  assert.deepEqual(body.thinking,{type:'disabled'});
  for(const unsupported of ['store','reasoning_effort','max_completion_tokens'])assert.equal(Object.hasOwn(body,unsupported),false);
  const system=body.messages.find(message=>message.role==='system').content;
  assert.match(system,/json/i);
  assert.ok(system.includes(JSON.stringify(TASK_SCHEMA)),'The provider receives the complete field contract');
  assert.match(system,/示例|example/i);
  assert.match(system,/"clarifications"\s*:\s*\[\]/);
  assert.equal(result.type,'delivery');
  assert.deepEqual({from:result.params.from,to:result.params.to,weight:result.params.weight},{from:'B01',to:'B02',weight:2});
  assert.equal(result.interpretation.provider,'deepseek');
  assert.equal(result.interpretation.model,'deepseek-flash');
  assert.equal(result.interpretation.usage.total_tokens,320);
  assert.equal(planner.status().provider,'deepseek');
  assert.equal(planner.status().verified,true);
  assert.ok(!JSON.stringify({result,status:planner.status()}).includes(key));
});

test('DeepSeek balance, frequency, availability, and authentication failures remain distinct and sanitized',async t=>{
  const cases=[[402,'MODEL_INSUFFICIENT_BALANCE'],[429,'MODEL_RATE_LIMITED'],[503,'MODEL_OVERLOADED'],[401,'MODEL_AUTH_ERROR'],[403,'MODEL_AUTH_ERROR']];
  for(const [upstreamStatus,code] of cases){
    const api=await mock(t,(_,res)=>json(res,{error:{message:'sensitive provider diagnostic '+key}},upstreamStatus,{'retry-after':'7'}));
    const planner=new ModelPlanner(config(api.baseUrl));
    await assert.rejects(planner.interpret({goal,context}),error=>{
      assert.equal(error.code,code);
      assert.equal(error.details.source,'provider');
      assert.equal(error.details.upstreamStatus,upstreamStatus);
      if(upstreamStatus===429){assert.equal(error.details.retryAfterSeconds,7);assert.match(error.message,/频率|并发/);assert.doesNotMatch(error.message,/额度或频率|余额已?不足，请/);}
      assert.ok(!error.message.includes('sensitive provider diagnostic'));
      assert.ok(!JSON.stringify(error).includes(key));
      return true;
    });
    assert.equal(planner.status().verified,false);
    assert.ok(!JSON.stringify(planner.status()).includes(key));
  }
});

test('DeepSeek does not execute truncated, malformed, invented-resource, or secret-echo output',async t=>{
  const scenarios=[
    {body:response(valid,'length'),code:'MODEL_INCOMPLETE'},
    {body:{choices:[{finish_reason:'stop',message:{content:'not-json'}}]},code:'MODEL_INVALID_OUTPUT'},
    {body:response({...valid,to:'B999'}),code:'MODEL_UNKNOWN_RESOURCE'},
    {body:response({...valid,summary:key}),code:'MODEL_INVALID_OUTPUT'}
  ];
  for(const {body,code} of scenarios){
    const api=await mock(t,(_,res)=>json(res,body));
    const planner=new ModelPlanner(config(api.baseUrl));
    await assert.rejects(planner.interpret({goal,context}),error=>error.code===code&&!error.message.includes(key));
    assert.equal(planner.status().verified,false);
  }
});
