import {createHash} from 'node:crypto';
import {qualityReport} from './team-quality.mjs';

const elapsed=(a,b)=>{const n=Date.parse(b)-Date.parse(a);return Number.isFinite(n)&&n>=0?n:null;};
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
function queryTask(task,number){
  const a=task.attempts?.at(-1),exception=a?.acceptanceException;
  return {...pick(task,['id','title','memberId','kind','status','reviewOfTaskId','dependencies','supersededBy','repairRootTaskId','repairRound','contractRevision','validationMode']),number,stage:task.contract?.stage,
    ...(task.blockReason?{blockReason:task.blockReason.slice(0,512),blockReasonTruncated:task.blockReason.length>512}:{}),
    attemptCount:task.attempts?.length??0,evidenceCount:task.evidence?.length??0,
    attempt:a?{...pick(a,['id','number','state','agentThreadId','turnId','runtimeStatus','startedAt','endedAt']),...(exception?{acceptanceException:{requiresLeader:exception.requiresLeader,reason:exception.reason?.slice(0,512),reasonTruncated:(exception.reason?.length??0)>512}}:{})}:null};
}
export function taskQuery(team,{query='',status,memberId,offset=0,limit=50,cursor}={}) {
  const scope={teamId:team.id,revision:team.revision,query:query.trim().toLowerCase(),status:status??null,memberId:memberId??null};
  if(cursor){let page;try{page=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('Invalid history cursor');}
    if(Object.keys(scope).some(k=>scope[k]!==page[k]))throw new Error('History snapshot or filters changed; restart from the first page');offset=page.offset;
  }
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>200)throw new Error('Invalid history page');
  const needle=query.trim().toLowerCase();
  const rows=team.tasks.map((task,index)=>({task,number:task.number??index+1})).filter(({task:t,number})=>(!status||t.status===status)&&(!memberId||t.memberId===memberId)&&(!needle||[t.id,t.title,t.goal,'t'+number].some(v=>String(v??'').toLowerCase().includes(needle))));
  const nextOffset=offset+limit<rows.length?offset+limit:null;
  return {source:'task-metadata',total:rows.length,offset,nextOffset,nextCursor:nextOffset===null?null:Buffer.from(JSON.stringify({...scope,offset:nextOffset})).toString('base64url'),tasks:rows.slice(offset,offset+limit).map(({task,number})=>queryTask(task,number)),evidenceAccess:{tool:'read_team_context',arguments:{teamId:team.id,view:'evidence'},requiresTaskId:true,historyPreserved:true}};
}
export function diagnostics(team,runs=[]) {
  const stages=team.tasks.flatMap(t=>(t.attempts??[]).map(a=>{
    const run=runs.find(r=>r.attemptId===a.id),dispatch=team.events?.find(e=>e.attemptId===a.id&&e.type==='task-dispatched');
    return {taskId:t.id,attemptId:a.id,reservationToBindMs:elapsed(dispatch?.at??a.startedAt,a.boundAt),executionMs:elapsed(a.startedAt,a.endedAt),snapshotAgeMs:elapsed(run?.observedAt,new Date().toISOString()),status:run?.status??a.runtimeStatus??a.state};
  }));
  return {source:'recorded-timestamps',stages,unknown:stages.filter(s=>s.reservationToBindMs===null).length,limits:{members:8,unfinishedTasks:40},notes:['Missing timestamps remain unknown; no timings are invented.','Execution duration includes model and tool time.']};
}
export function exportTeam(team,{format='markdown',runs=[],usage=null}={}) {
  if(!['markdown','json'].includes(format))throw new Error('Unsupported report format');
  const quality=qualityReport(team),data={schemaVersion:1,team,publicRuns:runs,usage,quality,diagnostics:diagnostics(team,runs)};
  const text=format==='json'?JSON.stringify(data,null,2):[
    '# '+team.projectPath.split(/[\\/]/).at(-1)+' · 团队报告',
    '团队：'+team.id+' · 版本：'+team.revision,'',
    ...team.tasks.flatMap((t,i)=>['## t'+(t.number??i+1)+' · '+t.title,'状态：'+t.status+' · 成员：'+t.memberId,'',t.goal??'','',
      '验收：'+(t.acceptance??''),...(t.acceptanceCriteria??[]).map(c=>'- '+c.id+'：'+c.description),
      ...(t.contract?['阶段：'+t.contract.stage+'；写入范围：'+(t.contract.inScope??[]).join(', ')+'；排除范围：'+(t.contract.outOfScope??[]).join(', '),'验证命令：'+(t.contract.verify??[]).join(' / ')]:[]),
      ...(t.supersededBy?['修复替代：'+t.supersededBy]:[]),
      ...(t.attempts??[]).map(a=>'执行第 '+a.number+' 轮：'+(a.memberId??t.memberId)+' · '+a.id),
      ...(t.evidence??[]).map(e=>'\n交付：\n'+(e.summary??'')),'']),
    '## 质量与目标覆盖',...quality.coverage.map(c=>'- '+c.id+'：'+c.description+' · '+c.status+' · '+c.taskIds.join(', ')),
    ...(team.findings??[]).map(f=>'- '+f.id+' · '+f.severity+' · '+f.status+'：'+f.description+(f.resolutionEvidence?'；关闭证据：'+f.resolutionEvidence:'')),
    '## 用量','已观察 token：'+(usage?.totalTokens??'未知')+'；未提供用量的执行：'+(usage?.unknownAttempts??'未知')
  ].join('\n');
  return {format,mimeType:format==='json'?'application/json':'text/markdown',filename:'team-report.'+(format==='json'?'json':'md'),text,sha256:createHash('sha256').update(text).digest('hex'),scope:'public-task-records-only'};
}
