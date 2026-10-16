import {dispatchBlockers} from './team.mjs';
import {currentTasks} from './quality-policy.mjs';

// Waiting is useful only while an actual reservation/native task or actionable
// transition can advance. A dead end is a blocker, never synthetic completion.
export function idleWorkflowBlockers(team,workflow){
  if(workflow.actions.length||workflow.stage==='completed'||workflow.waitBlocked||workflow.budgetBlocked||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active'||['planned','stopping','halted','delivered','archived','superseded'].includes(team.state)||team.tasks.some(t=>t.status==='running'))return [];
  const unfinished=currentTasks(team).filter(t=>!t.supersededBy&&!['accepted','cancelled'].includes(t.status));
  if(!unfinished.length)return [];
  return unfinished.map(t=>({taskId:t.id,code:'no-progress-path',status:t.status,
    reasons:t.status==='waiting'?dispatchBlockers(team,t):[{code:'saved-task-blocker',message:t.blockReason??`任务状态 ${t.status} 需要处理，当前没有可推进的执行`}],
    message:'没有运行中的成员或可执行任务；先解决已保存的阻塞，保留已有交付与验证记录。'}));
}
