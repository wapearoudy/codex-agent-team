import {randomUUID} from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses=new Set(['PASS','FAIL','BLOCKED','NOT_RUN']);
function text(value,name,max=2000){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid checkpoint ${name}: expected 1–${max} characters`);
  return value.trim();
}
function list(value,name,convert){
  if(!Array.isArray(value)||value.length>30)throw new Error(`Invalid checkpoint ${name}: expected at most 30 entries`);
  return value.map(convert);
}
function normalized(input){
  if(typeof input.requestId!=='string'||!UUID.test(input.requestId))throw new Error('Checkpoint requestId must be a UUID');
  return {taskId:text(input.taskId,'taskId'),attemptId:text(input.attemptId,'attemptId'),requestId:input.requestId.toLowerCase(),
    summary:text(input.summary,'summary',3000),
    decisions:list(input.decisions??[],'decisions',v=>text(v,'decision')),
    remainingWork:list(input.remainingWork??[],'remainingWork',v=>text(v,'remaining work')),
    validation:list(input.validation??[],'validation',v=>{
      if(!v||!statuses.has(v.status))throw new Error('Invalid checkpoint validation status');
      return {name:text(v.name,'validation name'),status:v.status,evidence:text(v.evidence,'validation evidence')};
    }),evidence:list(input.evidence??[],'evidence',v=>text(v,'evidence'))};
}
function payload(record){return normalized(record);}

export function recordCheckpoint(team,input,{source='leader-recorded'}={}){
  const data=normalized(input);
  validateCheckpoints(team);
  const prior=team.checkpoints?.find(c=>c.requestId===data.requestId);
  if(prior){
    if(JSON.stringify(payload(prior))!==JSON.stringify(data))throw new Error('Checkpoint request ID already has different contents');
    return structuredClone(prior);
  }
  const task=team.tasks.find(t=>t.id===data.taskId),attempt=task?.attempts.at(-1),member=team.members.find(m=>m.id===task?.memberId);
  if(team.mode!=='host-leader'||team.state==='delivered'||!['running','submitted'].includes(task?.status)||!attempt?.agentThreadId||!attempt.turnId||!member)throw new Error('Checkpoint requires a bound active native attempt');
  if(attempt.id!==data.attemptId)throw new Error('Stale checkpoint attempt');
  const checkpoint={...data,contractRevision:task.contractRevision??1,id:randomUUID(),memberId:member.id,threadId:attempt.agentThreadId,turnId:attempt.turnId,source,createdAt:new Date().toISOString()};
  (team.checkpoints??=[]).push(checkpoint);
  return structuredClone(checkpoint);
}

export function checkpointProjection(team){
  return (team.checkpoints??[]).map(c=>{const task=team.tasks.find(t=>t.id===c.taskId);return {...structuredClone(c),stale:task?.attempts.at(-1)?.id!==c.attemptId||task?.memberId!==c.memberId||(c.contractRevision??1)!==(task?.contractRevision??1)};});
}

export function buildHandoff(team,taskId){
  const task=team.tasks.find(t=>t.id===taskId);
  if(!task)throw new Error('Handoff task not found');
  const member=team.members.find(m=>m.id===task.memberId);
  const checkpoint=checkpointProjection(team).filter(c=>c.taskId===taskId).at(-1)??null;
  return structuredClone({source:'leader-recorded',teamGoal:team.goal??'',taskId:task.id,title:task.title??'',goal:task.goal??'',context:task.context??'',acceptance:task.acceptance??'',acceptanceCriteria:task.acceptanceCriteria??[],status:task.status,attemptId:task.attempts.at(-1)?.id??null,
    contract:task.contract??null,repairFindingIds:task.repairFindingIds??[],member:{id:task.memberId,role:member?.role??'',responsibility:member?.responsibility??'',writeScopes:member?.writeScopes??[]},
    dependencies:(task.dependencies??[]).map(d=>{
      const upstream=team.tasks.find(t=>t.id===d.taskId),attemptId=upstream?.attempts.at(-1)?.id??null;
      return {taskId:d.taskId,when:d.when,status:upstream?.status??'unknown',attemptId,candidate:upstream?.attempts.at(-1)?.candidate??null,workspace:team.members.find(m=>m.id===upstream?.memberId)?.workspace??null,evidence:(upstream?.evidence??[]).filter(e=>attemptId!==null&&e.attemptId===attemptId)};
    }),checkpoint,requiresLeaderDispatch:true});
}

export function validateCheckpoints(team){
  if(team.checkpoints===undefined)return;
  if(!Array.isArray(team.checkpoints))throw new Error('Invalid checkpoint history');
  if(team.mode!=='host-leader'&&team.checkpoints.length)throw new Error('Checkpoints require host-leader mode');
  const ids=new Set(),requests=new Set();
  for(const c of team.checkpoints){
    if(!c||typeof c.id!=='string'||!UUID.test(c.id)||ids.has(c.id.toLowerCase())||!['leader-recorded','authenticated-member'].includes(c.source)||typeof c.createdAt!=='string'||!Number.isFinite(Date.parse(c.createdAt)))throw new Error('Invalid checkpoint record');
    const data=normalized(c);
    if(requests.has(data.requestId)||JSON.stringify(data)!==JSON.stringify({taskId:c.taskId,attemptId:c.attemptId,requestId:c.requestId,summary:c.summary,decisions:c.decisions,remainingWork:c.remainingWork,validation:c.validation,evidence:c.evidence}))throw new Error('Invalid checkpoint normalized payload');
    const task=team.tasks.find(t=>t.id===c.taskId),attempt=task?.attempts.find(a=>a.id===c.attemptId);
    if(!attempt||!c.threadId||!c.turnId||attempt.agentThreadId!==c.threadId||attempt.turnId!==c.turnId||(attempt.memberId??task.memberId)!==c.memberId||!team.members.some(m=>m.id===c.memberId))throw new Error('Checkpoint identity mismatch');
    ids.add(c.id.toLowerCase());requests.add(data.requestId);
  }
}
