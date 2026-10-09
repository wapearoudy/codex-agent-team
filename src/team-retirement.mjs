import {createHash} from 'node:crypto';

const sources=new Set(['panel-user-action','leader-recorded-user-instruction']);
const terminal=new Set(['completed','failed','interrupted']);
export function archiveRequest(team,input){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId??'')||!sources.has(input.source))throw new Error('归档需要稳定的 UUID 和明确的用户指令来源');
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)throw new Error('归档说明需要 1–1000 个字符');
  const payload={teamId:team.id,reason:input.reason.trim(),source:input.source},hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if(team.archival){if(team.archival.requestId!==input.requestId||team.archival.hash!==hash)throw new Error('团队已归档；归档请求与已保存记录不一致');return {hash,payload,replayed:true};}
  return {hash,payload,replayed:false};
}
export function assertArchivable(team){
  if(team.mode!=='host-leader'||!team.fixedRoster||team.state!=='delivered'||team.finalAcceptance?.source!=='main-conversation-leader'||!team.finalAcceptance.checks?.length||team.finalAcceptance.checks.some(c=>c.status!=='PASS'||!c.evidence?.trim()))throw new Error('目标完成并通过 Leader 最终验收后才能归档团队');
  if(team.planReview?.status==='pending')throw new Error('请先处理尚未确认的团队变更，再归档');
  if(team.executionControl?.status==='stopping'||!team.tasks.every(t=>['accepted','cancelled'].includes(t.status))||team.tasks.some(t=>t.attempts.some(a=>['reserved','linking','running'].includes(a.state))))throw new Error('请先结束并核实全部任务执行，再归档团队');
}
export function validateRetirement(team){
  if(team.state!=='archived'&&!team.archival)return;
  const a=team.archival;
  if(!['0.16.0','0.17.0'].includes(team.requiresTeamWorkspaceVersion)||team.state!=='archived'||!team.dispatchPaused||a?.teamId!==team.id||a?.previousState!=='delivered'||!Number.isFinite(Date.parse(a.at))||!Array.isArray(a.members))throw new Error('团队归档记录无效；保留数据并升级插件');
  const request=archiveRequest({...team,archival:undefined},a);
  if(request.hash!==a.hash)throw new Error('团队归档记录校验失败');
  assertArchivable({...team,state:'delivered'});
  const bound=team.members.filter(m=>m.agentThreadId);
  if(a.members.length!==bound.length||new Set(a.members.map(m=>m.memberId)).size!==bound.length||a.members.some(row=>!bound.some(m=>m.id===row.memberId&&m.agentThreadId===row.threadId)||!row.turnId||!terminal.has(row.status)||row.source!=='native-latest-turn'))throw new Error('团队归档缺少成员终态记录');
}
