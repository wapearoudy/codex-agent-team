import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute,win32,posix} from 'node:path';
import {contractCommandEvidence} from './verification-command.mjs';

const stages=new Set(['requirements','implementation','verification','review','repair','integration']);
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const now=()=>new Date().toISOString();
export const safeQualityPath=p=>nonempty(p)&&!isAbsolute(p)&&!win32.isAbsolute(p)&&!/[\0:*?]/.test(p)&&!p.split(/[\\/]/).some(s=>s==='..'||s==='.git'||s==='.codex');
const within=(path,scope)=>{const normalize=v=>{const p=posix.normalize(v.replaceAll('\\','/')).replace(/\/$/,'');return ['win32','darwin'].includes(process.platform)?p.toLowerCase():p;};const p=normalize(path),s=normalize(scope);return s==='.'||p===s||p.startsWith(s+'/');};
function strings(value,name,{paths=false}={}){
  if(!Array.isArray(value)||value.length>30||value.some(v=>!nonempty(v)||v.length>2000||paths&&!safeQualityPath(v))||new Set(value).size!==value.length)throw new Error(`Invalid quality contract ${name}`);
}
export function validateQualityPlan({members,tasks,goalCriteria,findings}){
  if(goalCriteria!==undefined&&(!Array.isArray(goalCriteria)||!goalCriteria.length||goalCriteria.length>30||goalCriteria.some(c=>!c||!nonempty(c.id)||!nonempty(c.description))||new Set(goalCriteria.map(c=>c.id)).size!==goalCriteria.length))throw new Error('Goal criteria need unique IDs and descriptions');
  for(const task of tasks){
    const c=task.contract;if(!c)continue;
    if(!stages.has(c.stage)||!task.acceptanceCriteria?.length)throw new Error('Quality contracts need a valid stage and explicit acceptance criteria');
    for(const name of ['inScope','outOfScope','verify','coverageOf'])strings(c[name]??[],name,{paths:['inScope','outOfScope'].includes(name)});
    if(task.kind==='review'&&c.stage!=='review'||task.kind!=='review'&&c.stage==='review')throw new Error('Review stage requires an independent review task');
    if(['implementation','repair'].includes(c.stage)&&!c.inScope?.length)throw new Error('Implementation/repair contracts need an explicit write scope');
    if((task.validationMode??'execute')==='execute'&&['implementation','verification','repair','integration'].includes(c.stage)&&!c.verify?.length)throw new Error('Executable quality contracts need verification commands');
    if(task.validationMode==='source-only'&&c.verify?.length)throw new Error('Source-only tasks cannot declare executed verification commands');
    const member=members.find(m=>m.id===task.memberId);
    if((c.inScope??[]).some(path=>!member?.writeScopes.some(scope=>within(path,scope))))throw new Error('Task write scope exceeds its member write scope');
    if((c.coverageOf??[]).some(id=>!goalCriteria?.some(c=>c.id===id)))throw new Error('Task coverage references an undeclared goal criterion');
  }
  if(findings!==undefined){
    if(!Array.isArray(findings))throw new Error('Invalid quality finding ledger');
    const ids=new Set();
    for(const f of findings){
      if(!f||!nonempty(f.id)||ids.has(f.id)||!tasks.some(t=>t.id===f.rootTaskId)||!['open','resolved'].includes(f.status)||!['blocker','high','medium','low'].includes(f.severity)||!nonempty(f.description)||!Array.isArray(f.history)||!f.history.length)throw new Error('Invalid quality finding identity/history');
      if(f.status==='resolved'&&!nonempty(f.resolutionEvidence))throw new Error('Resolved findings need independent resolution evidence');
      ids.add(f.id);
    }
  }
}
export function qualityBlockers(team,task){
  if(!task.contract||task.contract.stage==='requirements'||task.kind==='review')return [];
  return team.tasks.filter(t=>t.contract?.stage==='requirements'&&t.status!=='accepted'&&!t.supersededBy).map(t=>({code:'requirements-gate',taskId:t.id,message:`等待需求任务 ${t.id} 独立验收`}));
}
export function parseDelivery(text){
  try{const value=JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
  throw new Error('Contract task must return a structured JSON delivery');
}
export function assertContractDelivery(task,member,output,commands=[]){
  if(!task.contract||task.kind==='review')return null;
  const delivery=parseDelivery(output);
  if(!nonempty(delivery.summary)||!Array.isArray(delivery.acceptanceResults)||delivery.acceptanceResults.some(c=>!c||!nonempty(c.criterionId)||!['PASS','FAIL','BLOCKED','NOT_RUN'].includes(c.status)||!nonempty(c.evidence))||new Set(delivery.acceptanceResults.map(c=>c.criterionId)).size!==delivery.acceptanceResults.length||task.acceptanceCriteria.some(c=>!delivery.acceptanceResults.some(r=>r.criterionId===c.id)))throw new Error('Contract delivery must report every acceptance criterion with evidence');
  if(!Array.isArray(delivery.changedPaths)||delivery.changedPaths.length>1000||delivery.changedPaths.some(p=>!safeQualityPath(p)))throw new Error('Contract delivery needs safe project-relative changedPaths');
  for(const path of delivery.changedPaths){
    if(!member.writeScopes.some(scope=>within(path,scope))||!task.contract.inScope?.some(scope=>within(path,scope))||task.contract.outOfScope?.some(scope=>within(path,scope)))throw new Error(`Reported change is outside the task write scope: ${path}`);
  }
  // A model's commandsRun claim cannot substitute for host command records.
  // Failed checks may be submitted for review, but cannot pass acceptance.
  return {...delivery,scopeEvidenceSource:'member-reported-paths',verifiedCommands:contractCommandEvidence(task.contract.verify??[],commands),commandVerificationVersion:1};
}
export function assertContractPass(task){
  if(!task.contract||task.kind==='review')return;
  const attempt=task.attempts.at(-1),delivery=attempt?.delivery;
  // Recompute from this exact attempt's saved host observation. Old releases
  // cached false negatives for wrapped commands; cached flags are not evidence.
  const verifiedCommands=contractCommandEvidence(task.contract.verify??[],attempt?.observation?.commands??[]);
  if(!delivery||delivery.acceptanceResults.some(c=>c.status!=='PASS')||verifiedCommands.some(c=>!c.observed))throw new Error('Contract acceptance requires every criterion PASS and successful host-observed verification commands');
  return {verifiedCommands,commandVerificationVersion:1};
}
export const qualityRoot=task=>task.repairRootTaskId??task.id;
export function openFindings(team,task){return (team.findings??[]).filter(f=>f.rootTaskId===qualityRoot(task)&&f.status==='open');}
export function recordFindings(team,review,target,verdict,{accept=false}={}){
  if(!Array.isArray(verdict.findings)||verdict.findings.length>100||verdict.findings.some(f=>!f||!['blocker','high','medium','low'].includes(f.severity)||!['open','resolved'].includes(f.status)||!nonempty(f.description)||f.description.length>4000||f.id!==undefined&&(!/^[a-zA-Z0-9_-]{1,64}$/.test(f.id))))throw new Error('Structured review needs valid findings with stable IDs');
  const rootTaskId=qualityRoot(target),attemptId=review.attempts.at(-1).id;
  const incoming=verdict.findings.map(f=>({...f,id:f.id??'finding-'+createHash('sha256').update(JSON.stringify([rootTaskId,f.severity,f.description])).digest('hex').slice(0,24)}));
  if(new Set(incoming.map(f=>f.id)).size!==incoming.length)throw new Error('Duplicate finding IDs');
  for(const f of incoming){
    const prior=team.findings?.find(x=>x.id===f.id);
    if(prior&&prior.rootTaskId!==rootTaskId)throw new Error('Finding ID belongs to a different delivery');
    if(f.status==='resolved'&&!nonempty(f.resolutionEvidence))throw new Error('Resolved findings need independent resolution evidence');
    if(prior&&prior.severity!==f.severity)throw new Error('Finding severity cannot be downgraded or changed using the same ID');
  }
  if(accept)for(const f of openFindings(team,target).filter(f=>['blocker','high'].includes(f.severity)))if(!incoming.some(x=>x.id===f.id&&x.status==='resolved'&&nonempty(x.resolutionEvidence)))throw new Error(`Open finding ${f.id} needs explicit independent resolution evidence`);
  if(incoming.length||team.findings?.length)team.requiresTeamWorkspaceVersion??='0.10.0';
  team.findings??=[];
  for(const f of incoming){
    let row=team.findings.find(x=>x.id===f.id);
    if(!row){row={id:f.id,rootTaskId,severity:f.severity,description:f.description,status:'open',history:[]};team.findings.push(row);}
    Object.assign(row,{status:f.status,description:f.description,resolutionEvidence:f.status==='resolved'?f.resolutionEvidence:null,updatedAt:now()});
    row.history.push({at:now(),reviewTaskId:review.id,reviewAttemptId:attemptId,targetTaskId:target.id,targetAttemptId:target.attempts.at(-1)?.id,severity:f.severity,description:f.description,status:f.status,evidence:f.resolutionEvidence??null});
  }
}
export function planRepair(team,review,target,note){
  team.requiresTeamWorkspaceVersion??='0.10.0';
  const round=(target.repairRound??1)+1,limit=team.policy?.maxReviewRounds??3;
  if(round>limit){
    target.status='blocked';review.status='blocked';target.blockReason=review.blockReason=`Review round limit (${limit}) reached; Leader escalation required: ${note}`;
    team.dispatchPaused=true;team.state='review-escalated';
    team.events.push({at:now(),type:'review-round-limit',taskId:target.id,reviewTaskId:review.id,limit});return null;
  }
  const affected=new Set([target.id,review.id]);
  for(let changed=true;changed;){changed=false;for(const row of team.tasks)if(!affected.has(row.id)&&row.dependencies.some(d=>affected.has(d.taskId))){affected.add(row.id);changed=true;}}
  if(team.tasks.some(t=>affected.has(t.id)&&t.status==='running'))throw new Error('Stop and settle affected downstream members before planning repair');
  const stamp=now(),id='repair-'+randomUUID(),reviewId='review-'+randomUUID(),rootTaskId=qualityRoot(target);
  const fresh=task=>({...structuredClone(task),status:'waiting',attempt:0,attempts:[],evidence:[],history:[],blockReason:null,createdAt:stamp,updatedAt:stamp});
  const repair=fresh(target);Object.assign(repair,{id,title:`修复第 ${round-1} 轮：${target.title}`.slice(0,200),parentTaskId:rootTaskId,repairRootTaskId:rootTaskId,repairRound:round,repairFindingIds:openFindings(team,target).map(f=>f.id),context:`${target.context??''}\nIndependent review: ${note}`.slice(-12000)});delete repair.supersededBy;
  if(repair.contract&&['implementation','repair'].includes(target.contract.stage))repair.contract.stage='repair';
  const followup=fresh(review);Object.assign(followup,{id:reviewId,title:`复审第 ${round} 轮：${target.title}`.slice(0,200),reviewOfTaskId:id,parentTaskId:rootTaskId,repairRound:round,dependencies:review.dependencies.map(d=>({...d,taskId:d.taskId===target.id?id:d.taskId}))});delete followup.supersededBy;
  for(const row of team.tasks.filter(t=>affected.has(t.id)&&![target.id,review.id].includes(t.id))){
    row.dependencies=row.dependencies.map(d=>({...d,taskId:d.taskId===target.id?id:d.taskId===review.id?reviewId:d.taskId}));
    if(!row.supersededBy&&row.status!=='cancelled'){row.status='waiting';row.blockReason='Upstream repair requires fresh evidence';}
    (row.history??=[]).push({at:stamp,type:'repair-dependency-redirected',fromTaskId:target.id,toTaskId:id});
  }
  for(const [task,replacement] of [[target,id],[review,reviewId]]){task.status='cancelled';task.supersededBy=replacement;task.blockReason='Replaced by independently reviewed repair; original evidence retained';}
  team.tasks.push(repair,followup);team.events.push({at:stamp,type:'repair-planned',rootTaskId,repairTaskId:id,reviewTaskId:reviewId,round});return {repairTaskId:id,reviewTaskId:reviewId,round};
}
export function qualityReport(team){
  const coverage=(team.goalCriteria??[]).map(c=>{const tasks=team.tasks.filter(t=>t.kind!=='review'&&!t.supersededBy&&t.contract?.coverageOf?.includes(c.id));return {...c,taskIds:tasks.map(t=>t.id),status:tasks.length&&tasks.every(t=>t.status==='accepted')?'accepted':tasks.length?'pending':'missing'};});
  return {source:'declared-contracts-and-independent-reviews',coverage,openFindings:(team.findings??[]).filter(f=>f.status==='open'),resolvedFindingCount:(team.findings??[]).filter(f=>f.status==='resolved').length,repairCount:team.tasks.filter(t=>t.repairRootTaskId).length,scopeEvidenceSource:'member-reported-paths',scopeIsSandbox:false};
}
export function assertQualityFinish(team){
  const report=qualityReport(team);
  if(report.coverage.some(c=>c.status!=='accepted'))throw new Error('Final acceptance has missing or unaccepted declared goal coverage');
  if(report.openFindings.some(f=>['blocker','high'].includes(f.severity)))throw new Error('Unresolved blocker/high findings prevent final delivery');
}
