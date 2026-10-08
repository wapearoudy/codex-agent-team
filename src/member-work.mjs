import {planHash,assertDispatchAllowed} from './team-plan-review.mjs';
import {requireTeamVersion} from './team-version.mjs';
import {dispatchBlockers} from './team.mjs';
import {recordCheckpoint} from './team-checkpoints.mjs';
export function assertMember(team,context){
  const member=team.members.find(m=>!m.removedAt&&m.agentThreadId===context.threadId);
  if(!member||context.cwd!==team.projectPath||context.parentThreadId!==team.leaderThreadId||team.state==='superseded')throw new Error('Only the authenticated active native member can access its own work');return member;
}
export function memberWork(team,context){const member=assertMember(team,context);return {kind:'member-work',teamId:team.id,revision:team.revision,memberId:member.id,dispatchPaused:team.dispatchPaused,executionStatus:team.executionControl?.status??'active',tasks:team.tasks.filter(t=>t.memberId===member.id&&!['accepted','cancelled'].includes(t.status)).slice(0,40).map(t=>({taskId:t.id,title:t.title,status:t.status,attemptId:t.attempts.at(-1)?.id??null,ready:!dispatchBlockers(team,t).length,blockers:dispatchBlockers(team,t)})),nextAction:'Claim only an assigned ready task in this existing native turn, publicly emit its marker, then bind your own current thread. Submit progress/delivery with report_member_team_task. Final acceptance remains independent.'};}
export function memberClaimRequest(team,context,{taskId,requestId}){
  const member=assertMember(team,context);assertDispatchAllowed(team);
  if(!/^[0-9a-f-]{36}$/i.test(requestId??''))throw new Error('A stable UUID is required');
  const hash=planHash({taskId,memberId:member.id}),prior=team.memberClaims?.find(r=>r.requestId===requestId);
  if(prior&&prior.hash!==hash)throw new Error('Member claim request ID already has different contents');
  const task=team.tasks.find(t=>t.id===taskId);if(!task||task.memberId!==member.id)throw new Error('Members may claim only their own assigned tasks');
  if(prior&&task.attempts.at(-1)?.id!==prior.attemptId)throw new Error('Member claim refers to an old attempt');
  return {member,task,prior,hash};
}
export function memberReport(team,context,input){
  const member=assertMember(team,context),task=team.tasks.find(t=>t.id===input.taskId),a=task?.attempts.at(-1);
  if(!task||task.memberId!==member.id||task.status!=='running'||a?.id!==input.attemptId||a.agentThreadId!==context.threadId||!a.turnId)throw new Error('Only your bound current attempt may report progress');
  const reportHash=planHash({summary:input.summary,decisions:input.decisions??[],remainingWork:input.remainingWork??[],evidence:input.evidence??[],validation:input.validation??[],delivery:input.delivery??null});
  const existing=team.checkpoints?.find(c=>c.requestId===input.requestId);if(existing&&existing.source!=='authenticated-member')throw new Error('Checkpoint request belongs to another author');
  if(existing&&existing.reportHash!==reportHash)throw new Error('Member report request ID already has different contents');
  const checkpoint=recordCheckpoint(team,input,{source:'authenticated-member'});team.checkpoints.find(c=>c.id===checkpoint.id).reportHash=reportHash;
  if(input.delivery!==undefined&&!existing){if(typeof input.delivery!=='string'||!input.delivery.trim()||input.delivery.length>24000)throw new Error('Delivery must contain 1–24000 characters');if(a.memberSubmission?.requestId===input.requestId&&a.memberSubmission.text!==input.delivery)throw new Error('Submission request ID has different contents');a.memberSubmission={requestId:input.requestId,text:input.delivery,at:new Date().toISOString(),source:'authenticated-member',status:'awaiting-native-terminal'};}
  requireTeamVersion(team,'0.12.0');return {kind:'member-report',checkpoint,submissionStatus:a.memberSubmission?.status??null,acceptance:'Not accepted. Emit the final delivery publicly; the Leader verifies the terminal native record and an independent reviewer judges the result.'};
}
