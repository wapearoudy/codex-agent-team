import {dispatchBlockers} from './team.mjs';
import {parseReview} from './quality-gates.mjs';

// A bounded action batch for the current Leader. This module never owns a model
// loop, sends messages, runs tools, accepts work or silently restarts a worker.
export function workflowActions(team,runs=[]) {
  if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')return {actions:team.planReview.status==='pending'?[{type:'plan-review',version:team.planReview.version,hash:team.planReview.hash,requiresUserConfirmation:true}]:[],authority:'current-main-conversation',stage:'plan-review',automaticAcceptance:false};
  const actions=team.planReview?.scope==='expansion'&&team.planReview.status==='pending'?[{type:'plan-review',version:team.planReview.version,hash:team.planReview.hash,requiresUserConfirmation:true}]:[],known=new Map(runs.map(r=>[r.attemptId,r]));
  for(const t of team.tasks) {
    const a=t.attempts.at(-1),run=known.get(a?.id);
    if(t.status==='running') {
      if(a.state==='reserved')actions.push({type:'verify-before-binding',taskId:t.id,attemptId:a.id});
      else if(['completed','failed','interrupted'].includes(run?.status))actions.push({type:'settle',taskId:t.id,attemptId:a.id,observedStatus:run.status});
    } else if(t.kind==='review'&&t.status==='submitted') {
      let verdict;try{verdict=parseReview(t.evidence.at(-1)?.summary);}catch{verdict=null;}
      actions.push({type:'review-decision',taskId:t.id,attemptId:a?.id,proposedDecision:verdict?.decision??null,requiresLeaderValidation:true});
    }
  }
  const candidates=team.tasks.filter(t=>t.status==='waiting').sort((a,b)=>a.priority-b.priority),draft=structuredClone(team),ready=[];
  for(const t of candidates) {
    if(dispatchBlockers(draft,draft.tasks.find(x=>x.id===t.id)).length)continue;
    ready.push(t.id);const picked=draft.tasks.find(x=>x.id===t.id);picked.status='running';picked.attempts.push({state:'reserved'});
  }
  if(ready.length&&!team.dispatchPaused)actions.push({type:'claim-batch',taskIds:ready.slice(0,8)});
  if(team.tasks.every(t=>['accepted','cancelled'].includes(t.status)))actions.push({type:'final-validation',requiresLeaderEvidence:true});
  const maxActions=team.members.length*2+2;
  return {actions:actions.slice(0,maxActions),maxActions,hasMore:actions.length>maxActions,maxAttempts:team.policy?.maxAttempts??3,automaticAcceptance:false,authority:'current-main-conversation',stage:actions.some(a=>a.type==='review-decision')?'verify':ready.length?'execute':actions.some(a=>a.type==='final-validation')?'integrate':'observe'};
}
