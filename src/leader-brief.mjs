import {createHash} from 'node:crypto';
export const LEADER_BRIEF_MAX_BYTES=6000;
const terminal=new Set(['accepted','cancelled']);
const short=(value,size)=>String(value??'').slice(0,size);
// Saved, bounded decision context; never an execution or acceptance authority.
export function leaderBrief(team,{offset=0,limit=8}={}){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid Leader brief page');
  const scoped=team.tasks.filter(t=>!team.activeBatchId||t.batchId===team.activeBatchId);
  const active=team.tasks.filter(t=>scoped.includes(t)&&!terminal.has(t.status)||t.status==='running');
  const batch=team.batches?.find(b=>b.id===team.activeBatchId),goal=String(batch?.goal??team.goal??'');
  const counts={};for(const t of scoped)counts[t.status]=(counts[t.status]??0)+1;
  const rows=active.slice(offset,offset+Math.min(limit,8)).map(t=>{const a=t.attempts.at(-1);return {taskId:t.id,title:short(t.title,80),status:t.status,memberId:t.memberId,attemptId:a?.id??null,threadId:a?.agentThreadId??null,turnId:a?.turnId??null,contractRevision:t.contractRevision??1,...(t.blockReason?{blockReason:short(t.blockReason,120)}:{}),evidence:{tool:'read_team_context',taskId:t.id,attemptId:a?.id??undefined,view:'evidence'}};});
  const decisions=(team.checkpoints??[]).filter(c=>{const t=scoped.find(t=>t.id===c.taskId),a=t?.attempts.at(-1);return a&&a.id===c.attemptId&&a.turnId===c.turnId&&t.memberId===c.memberId&&(t.contractRevision??1)===(c.contractRevision??1);}).slice(-4).map(c=>({checkpointId:c.id,taskId:c.taskId,attemptId:c.attemptId,source:c.source,decisions:(c.decisions??[]).slice(-2).map(d=>short(d,140)),advisory:true}));
  const result={kind:'team-leader-brief',source:'saved-team-decision-projection',previews:true,teamId:team.id,leaderThreadId:team.leaderThreadId,revision:team.revision,batchId:team.activeBatchId??null,state:team.state,control:team.executionControl?.status??'active',dispatchPaused:!!team.dispatchPaused,goal:short(goal,400),goalTruncated:goal.length>400,counts,
    constraints:{maxParallel:team.maxParallel,tokenLimit:team.policy?.tokenLimit??null,maxAttempts:team.policy?.maxAttempts??3,planApproval:team.planReview?.status??null,full:{tool:'read_team_plan',teamId:team.id}},activeTasks:rows,totalActiveTasks:active.length,offset,nextOffset:null,decisions,
    history:{completedInGoal:scoped.filter(t=>terminal.has(t.status)).length,outsideGoal:team.tasks.length-scoped.length,retained:true,tool:'query_team_tasks'},executionAuthority:false,acceptanceAuthority:false};
  while(Buffer.byteLength(JSON.stringify(result))>LEADER_BRIEF_MAX_BYTES-160){if(rows.length>1){rows.pop();continue;}if(decisions.length){decisions.pop();continue;}if(result.goal.length){result.goal=result.goal.slice(0,-40);result.goalTruncated=true;continue;}throw new Error('Leader brief identity exceeds its display budget');}
  result.nextOffset=offset+rows.length<active.length?offset+rows.length:null;
  result.hasMore=result.nextOffset!==null;
  result.briefHash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}
