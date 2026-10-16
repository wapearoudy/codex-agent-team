// A saved closure receipt, not another review or a certificate for later edits.
// Keep bookkeeping in the final tool return so the Leader need not fetch logs.
import {contractCommandEvidence,verificationRecords} from './verification-command.mjs';

export const COMPLETION_MAX_BYTES=3600;
const short=(s,n)=>typeof s==='string'?s.slice(0,n):undefined;
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
function report(task,a){try{return JSON.parse(task.evidence?.findLast(e=>e.attemptId===a?.id)?.summary??'');}catch{return {};}}
export function completionReceipt(team){
  const batch=team.batches?.find(b=>b.id===team.activeBatchId),acceptance=batch?.finalAcceptance??(!batch?team.finalAcceptance:null);
  if(team.activeBatchId&&!batch)return null;
  if(!acceptance)return null;
  const tasks=team.tasks.filter(t=>!batch||t.batchId===batch.id);
  // A retained historical acceptance must not complete a reopened/current goal.
  if(!tasks.length||!tasks.every(t=>['accepted','cancelled'].includes(t.status))||!tasks.some(t=>t.kind!=='review'&&t.status==='accepted'))return null;
  const commands=[],rows=[],artifacts=new Set();
  for(const t of tasks){
    const a=t.attempts?.at(-1),r=report(t,a);
    for(const path of Array.isArray(r.changedPaths)?r.changedPaths:[])if(typeof path==='string')artifacts.add(path);
    rows.push({taskId:t.id,kind:t.kind,status:t.status,attemptId:a?.id??null,threadId:a?.agentThreadId??null,turnId:a?.turnId??null,...(a?.acceptance&&t.kind!=='review'?{acceptance:pick(a.acceptance,['source','gate','reviewTaskId','reviewAttemptId'])}:{}),...(r.summary&&t.kind!=='review'?{summary:short(r.summary,90),...(r.summary.length>90?{summaryTruncated:true}:{})}:{})});
    if(t.status!=='accepted')continue;
    const workspace=a?.evidenceSnapshot?.workspace??team.projectPath;
    for(const c of contractCommandEvidence(t.contract?.verify??[],verificationRecords(a),{workspace}))commands.push({taskId:t.id,command:short(c.command,500),...(c.command?.length>500?{commandTruncated:true}:{}),verifiedAtAcceptance:c.observed,exitCode:c.observed?0:c.exitCode??null,...pick(c,['cwd','turnId','commandId']),evidence:{tool:'read_team_context',teamId:team.id,taskId:t.id,attemptId:a?.id,view:'evidence',section:'commands'}});
  }
  // The last integration receipt is the most useful final validation evidence.
  // Never lose it while trimming older per-task previews to the output budget.
  commands.reverse();commands.sort((a,b)=>Number(tasks.find(t=>t.id===b.taskId)?.contract?.stage==='integration')-Number(tasks.find(t=>t.id===a.taskId)?.contract?.stage==='integration'));
  const finalCommand=commands[0],validation={source:'saved-host-command-records',declaredCommands:commands.length,verifiedCommands:commands.filter(c=>c.verifiedAtAcceptance).length,...(finalCommand?{finalVerification:pick(finalCommand,['taskId','command','commandTruncated','verifiedAtAcceptance','exitCode','turnId','commandId'])}:{}),integrationRequired:batch?.integrationRequired===true};
  const result={kind:'team-goal-completion',teamId:team.id,revision:team.revision,batchId:batch?.id??null,goal:short(batch?.goal??team.goal,240),workspace:team.projectPath,completedAt:acceptance.at,source:'saved-final-acceptance',scope:'candidate-and-contracts-at-acceptance',currentFilesRechecked:false,counts:{accepted:tasks.filter(t=>t.status==='accepted').length,cancelled:tasks.filter(t=>t.status==='cancelled').length,independentReviews:tasks.filter(t=>t.kind==='review'&&t.status==='accepted').length,contractCommands:commands.length},validation,tasks:rows.slice(0,8),commands:commands.slice(0,4),changedPaths:[...artifacts].slice(0,12),reusedEvidenceCount:acceptance.reusedEvidence?.length??0,history:{preserved:true,tool:'export_team_report',teamId:team.id,explicitRequestOnly:true},instruction:'Return the user result from this saved receipt; no routine history/command rereads, export, second review or test rerun. This records the accepted candidate; later edits require fresh input checks.'};
  const mark=()=>{result.truncated=true;result.detailAccess={tool:'read_team_context',teamId:team.id,view:'evidence',required:['taskId'],explicitDetailOnly:true};};
  if(rows.length>result.tasks.length||commands.length>result.commands.length||artifacts.size>result.changedPaths.length)mark();
  while(Buffer.byteLength(JSON.stringify(result))>COMPLETION_MAX_BYTES){
    mark();
    if(result.commands.length){result.commands.pop();continue;}
    if(result.tasks.length){result.tasks.pop();continue;}
    if(result.changedPaths.length){result.changedPaths.pop();continue;}
    break;
  }
  return result;
}
