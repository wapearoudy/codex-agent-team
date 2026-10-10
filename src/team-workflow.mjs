import {settlementInputHash} from './settlement-exception.mjs';
import {dispatchBlockers} from './team.mjs';
import {finalEvidenceCandidates} from './final-evidence.mjs';
import {parseReview} from './quality-gates.mjs';
import {recoverableReview} from './review-recovery.mjs';

// A bounded action batch for the current Leader. This module never owns a model
// loop, sends messages, runs tools, accepts work or silently restarts a worker.
function deriveWorkflowActions(team,runs=[]) {
  if(['superseded','archived'].includes(team.state))return {actions:[],authority:'current-main-conversation',stage:'archived',automaticAcceptance:true};
  if(team.state==='delivered'||team.finalAcceptance)return {actions:[],authority:'current-main-conversation',stage:'completed',automaticAcceptance:true};
  if(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')return {actions:team.planReview.status==='pending'?[{type:'plan-review',version:team.planReview.version,hash:team.planReview.hash,requiresUserConfirmation:true}]:[],authority:'current-main-conversation',stage:'plan-review',automaticAcceptance:true};
  if(team.executionControl?.status==='stopping')return {actions:[{type:'stop-members',requiresNativeInterrupt:true,tool:'reconcile_team_stop'}],authority:'current-main-conversation',stage:'stopping',automaticAcceptance:true};
  if(team.executionControl?.status==='halted')return {actions:[],authority:'current-main-conversation',stage:'halted',automaticAcceptance:true};
  if(team.taskPlanning==='leader'&&!team.tasks.length&&!(team.planReview?.scope==='expansion'&&team.planReview.status==='pending')){const paused=team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active';return {actions:paused?[]:[{type:'plan-tasks',requiresUserConfirmation:false,tool:'add_team_tasks',goal:team.goal,...(team.profile?{profile:team.profile,templateInstruction:'Read read_team_profile and adapt its constraints and optional seed tasks to this confirmed goal before add_team_tasks.'}:{}),memberIds:team.members.filter(m=>!m.removedAt).map(m=>m.id),instruction:'Leader decomposes the confirmed goal within the confirmed roles and write scopes, creates work plus independent reviews, and calls add_team_tasks. Do not ask the user to confirm individual tasks. Material scope expansions still require propose_team_change.'}],authority:'current-main-conversation',stage:'task-planning',automaticAcceptance:true};}
  const actions=team.planReview?.scope==='expansion'&&team.planReview.status==='pending'?[{type:'plan-review',version:team.planReview.version,hash:team.planReview.hash,requiresUserConfirmation:true}]:[],known=new Map(runs.map(r=>[r.attemptId,r]));
  for(const t of team.tasks) {
    const a=t.attempts.at(-1),run=known.get(a?.id);
    if(t.status==='running') {
      if(a.state==='reserved')actions.push({type:'verify-before-binding',taskId:t.id,attemptId:a.id});
      else if(['completed','failed','interrupted'].includes(run?.status)){
        const saved=a.settlementException;
        actions.push(saved?.inputHash===settlementInputHash(team,t,run)?{type:'settlement-exception',taskId:t.id,attemptId:a.id,tool:'settle_team_task',requiresLeaderValidation:true,reason:saved.reason,instruction:'Resolve the saved delivery/contract mismatch and retry registration explicitly; retain the original terminal attempt and do not rerun completed work merely to register it'}:{type:'settle',taskId:t.id,attemptId:a.id,observedStatus:run.status});
      }
    } else if(t.status==='waiting'&&recoverableReview(team,t)) {
      actions.push({type:'reconcile-review',taskId:t.id,attemptId:a.id,proposedDecision:'accept',requiresLeaderValidation:true,tool:'reconcile_team_review',reason:'Reuse the saved independent verdict; resolve registration exceptions without another review or test run'});
    } else if(t.kind==='review'&&t.status==='submitted') {
      let verdict;try{verdict=parseReview(t.evidence.at(-1)?.summary,a?.marker);}catch{verdict=null;}
      actions.push({type:a?.acceptanceException?'review-exception':'accept-review',taskId:t.id,attemptId:a?.id,proposedDecision:verdict?.decision??null,requiresLeaderValidation:!!a?.acceptanceException,...(a?.acceptanceException?{reason:a.acceptanceException.reason,tool:'accept_team_review'}:{tool:'advance_team_workflow'})});
    }
  }
  // Only reservations change while deriving a batch. Historical observations
  // and deliveries may be huge and are never needed or copied here.
  const candidates=team.tasks.filter(t=>t.status==='waiting').sort((a,b)=>a.priority-b.priority),draft={...team,members:team.members.map(m=>({...m})),tasks:team.tasks.map(t=>({...t,attempts:[...t.attempts]}))},ready=[];
  for(const t of candidates) {
    if(dispatchBlockers(draft,draft.tasks.find(x=>x.id===t.id)).length)continue;
    ready.push(t.id);const picked=draft.tasks.find(x=>x.id===t.id);picked.status='running';picked.attempts.push({state:'reserved'});draft.members.find(m=>m.id===picked.memberId).status='starting';
  }
  if(ready.length&&!team.dispatchPaused)actions.push({type:'claim-batch',taskIds:ready.slice(0,8)});
  if(team.tasks.length&&team.tasks.every(t=>['accepted','cancelled'].includes(t.status)))actions.push({type:'final-validation',requiresLeaderEvidence:true,tool:'finish_team',reusableEvidence:finalEvidenceCandidates(team)});
  const maxActions=team.members.length*2+2;
  return {actions:actions.slice(0,maxActions),maxActions,hasMore:actions.length>maxActions,maxAttempts:team.policy?.maxAttempts??3,automaticAcceptance:true,authority:'current-main-conversation',stage:actions.some(a=>['accept-review','review-exception','reconcile-review'].includes(a.type))?'verify':ready.length?'execute':actions.some(a=>a.type==='final-validation')?'integrate':'observe'};
}

export function workflowActions(team,runs=[],{usage}={}) {
  const workflow=deriveWorkflowActions(team,runs);
  if(usage?.exhausted||usage?.unverifiable){workflow.actions=workflow.actions.filter(a=>a.type!=='claim-batch');workflow.budgetBlocked=true;workflow.budgetReason=usage.exhausted?'exhausted':'unknown-usage';}
  return {...workflow,communication:{transport:'native-agent-messages',chatMessages:false,waitTool:'wait_team_event',memberWaitTool:'wait_agent',maxWaitMs:60000,panelWaitMaxMs:55000,panelWakeWithoutWaiter:false,timeoutAction:'continue-waiting',stateView:'coordination',instruction:'Use wait_team_event as the single bounded wait for saved controls and exact native completion. Do not alternate wait_agent and zero-time panel probes. Progress-only saves are coalesced within the wait. An unchanged timeout repeats only this wait, without read_team or inbox reads. Changed events include compact coordination; member-terminal includes exact attempt IDs: advance_team_workflow immediately without a second read. Consume the inbox only when actionable pending messages are reported. Stops take priority. Verify latest revision and budget before dispatch. Never inject chat messages or start a coordinator. Valid independent reviewer PASS is registered through plugin gates; handle exceptions and final closure, reuse unchanged valid evidence without repeating review or tests.'}};
}
