// Display previews have a separate budget. Saved observations and full evidence
// are never rewritten, and remain available through read_team(view=full).
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const attemptKeys=['id','memberId','number','state','agentThreadId','turnId','runtimeStatus','startedAt','endedAt','connection'];
const runKeys=['taskId','memberId','attemptId','threadId','turnId','status','statusEvidence','observedAt','connection','source','attemptIdentitySource','model','usage'];
export const PANEL_MAX_BYTES=256*1024;
export function panelTasks(tasks){
  if(tasks.length<=80)return tasks;
  const selected=new Set([...tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).slice(0,80),...tasks.filter(t=>['accepted','cancelled'].includes(t.status)).slice(-80)].slice(0,80));
  return tasks.filter(t=>selected.has(t));
}
function previewBudget(bytes){
  let remaining=bytes,truncated=false;
  function text(value,max=2000){
    const source=String(value??''),limit=Math.min(max,remaining);
    let result=limit?source.slice(-limit):'';
    // UTF-8 accounting also keeps non-ASCII command logs within the budget.
    while(Buffer.byteLength(result)>remaining)result=result.slice(Math.ceil(result.length/4));
    remaining-=Buffer.byteLength(result);
    if(result!==source){truncated=true;return result?'…'+result:'[预览已省略]';}
    return result;
  }
  function value(input,depth=0){
    if(typeof input==='string')return text(input);
    if(input===null||typeof input!=='object')return input;
    if(depth>=5){truncated=true;return '[详情按需读取]';}
    if(Array.isArray(input)){if(input.length>12)truncated=true;return input.slice(-12).map(v=>value(v,depth+1));}
    return Object.fromEntries(Object.entries(input).slice(0,40).map(([k,v])=>[k,value(v,depth+1)]));
  }
  return {text,value,get truncated(){return truncated;}};
}
export function stateRun(run,budget=previewBudget(24*1024)){
  const state=pick(run,runKeys);
  // Freshness is control metadata; a log budget must not erase its timestamp.
  if(state.statusEvidence)state.statusEvidence=pick(state.statusEvidence,['freshUntil','source','observedAt','status','turnId']);
  state.progress=(run.progress??[]).slice(-3).map(p=>({...pick(p,['id','type','at']),text:budget.text(p.text,1000)}));
  if(run.activity)state.activity={...pick(run.activity,['cursor','source','status','observedAt']),events:(run.activity.events??[]).slice(-3).map(e=>({...pick(e,['id','type','at','status','exitCode']),...(e.command?{command:budget.text(e.command,500)}:{}),...(e.text?{text:budget.text(e.text,1000)}:{}),...(e.paths?{paths:e.paths.slice(0,10).map(p=>budget.text(p,300))}:{})}))};
  state.observationError=run.observationError?budget.text(run.observationError,1000):null;
  return state;
}
export function stateRuns(runs){const budget=previewBudget(24*1024);return runs.map(run=>stateRun(run,budget));}
export function panelResponse(data,detailToken){
  const budget=previewBudget(64*1024),rows=panelTasks(data.team.tasks),ids=new Set(rows.map(t=>t.id)),numbers=new Map(data.team.tasks.map((t,i)=>[t.id,t.number??i+1]));
  const team=pick(data.team,['id','revision','mode','state','projectPath','leaderThreadId','dispatchPaused','totalDispatches','maxParallel','fixedRoster']);
  team.goal=budget.text(data.team.goal,3000);
  Object.assign(team,budget.value(pick(data.team,['policy','profile','preparation','finalAcceptance'])));
  team.members=data.team.members.map(m=>({...pick(m,['id','role','displayName','threadTitle','taskName','status','agentThreadId','agentPath','rosterVerified','removedAt']),responsibility:budget.text(m.responsibility,2000),writeScopes:(m.writeScopes??[]).slice(0,30).map(p=>budget.text(p,300)),...budget.value(pick(m,['route','workspace','recoveryControl']))}));
  team.tasks=rows.map(t=>({...pick(t,['id','title','kind','memberId','status','reviewOfTaskId','parentTaskId','priority','supersededBy','repairRootTaskId','repairRound']),contract:budget.value(t.contract),number:numbers.get(t.id),goal:budget.text(t.goal,3000),acceptance:budget.text(t.acceptance,3000),blockReason:budget.text(t.blockReason,2000),dependencies:(t.dependencies??[]).slice(0,40),acceptanceCriteria:budget.value(t.acceptanceCriteria??[]),attempts:t.attempts.slice(-10).map(a=>pick(a,attemptKeys)),evidence:t.evidence?.slice(-3).map(e=>({...pick(e,['attempt','attemptId','createdAt','status']),summary:budget.text(e.summary,2000)}))??[] }));
  const relevant=data.runs.filter(r=>ids.has(r.taskId));
  const latest=new Set(rows.map(t=>t.attempts.at(-1)?.id));
  const selected=relevant.toReversed().sort((a,b)=>Number(latest.has(b.attemptId))-Number(latest.has(a.attemptId))||Number(b.status==='inProgress')-Number(a.status==='inProgress')).slice(0,40);
  const runs=selected.map(r=>({...stateRun(r,budget),outputs:(r.outputs??[]).slice(-2).map(o=>({...pick(o,['id','type','at']),text:budget.text(o.text,6000)})),commands:(r.commands??[]).slice(-6).map(c=>({...pick(c,['id','status','exitCode','startedAt','endedAt']),command:budget.text(c.command,1000),output:budget.text(c.output,2000)}))}));
  const output={kind:'team-detail',team,runs,detailToken,observedAt:data.observedAt,observationMode:data.observationMode,readiness:budget.value((data.readiness??[]).filter(r=>ids.has(r.taskId))),usage:budget.value(data.usage),workflow:budget.value(data.workflow),diagnostics:budget.value(data.diagnostics),messages:budget.value((data.messages??[]).slice(-10)),checkpoints:budget.value((data.checkpoints??[]).slice(-10)),displayLimits:{preview:true,maxBytes:PANEL_MAX_BYTES,totalTasks:data.team.tasks.length,totalRuns:data.runs.length,truncated:false},evidenceAccess:{tool:'read_team',arguments:{teamId:team.id,view:'full'},handoffTool:'read_team_handoff'}};
  if(data.quality)output.quality={...pick(data.quality,['source','resolvedFindingCount','repairCount','scopeEvidenceSource','scopeIsSandbox']),coverage:budget.value(data.quality.coverage),openFindingCount:data.quality.openFindings.length,openFindings:budget.value(data.quality.openFindings.slice(0,20).map(f=>pick(f,['id','rootTaskId','severity','status','description'])))};
  // Bound structural overhead as well as text, including very long histories.
  const size=()=>Buffer.byteLength(JSON.stringify(output));
  let shortened=false;
  while(size()>PANEL_MAX_BYTES-256){
    shortened=true;
    if(runs.length>1){runs.pop();continue;}
    const history=team.tasks.find(t=>t.attempts.length>1);
    if(history){history.attempts.shift();continue;}
    if(team.tasks.length>1){team.tasks.pop();continue;}
    break;
  }
  output.displayLimits.truncated=shortened||budget.truncated||rows.length!==data.team.tasks.length||selected.length!==data.runs.length||rows.some(t=>t.attempts.length>10||t.evidence?.length>3)||selected.some(r=>r.outputs?.length>2||r.commands?.length>6||r.activity?.events?.length>3);
  return output;
}
