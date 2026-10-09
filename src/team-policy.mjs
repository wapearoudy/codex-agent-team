import {join} from 'node:path';
import {DurableStore} from './durable-store.mjs';
import {validatePlan,validateMembers} from './team.mjs';

export function normalizePolicy(input={}) {
  const tokenLimit=input.tokenLimit??null,contextChars=input.contextChars??24000,maxAttempts=input.maxAttempts??3;
  if(tokenLimit!==null&&(!Number.isSafeInteger(tokenLimit)||tokenLimit<1))throw new Error('Token limit must be a positive integer');
  if(!Number.isInteger(contextChars)||contextChars<4000||contextChars>100000)throw new Error('Context budget must be 4000–100000 characters');
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)throw new Error('Attempt limit must be 1–10');
  const maxReviewRounds=input.maxReviewRounds??3;
  if(!Number.isInteger(maxReviewRounds)||maxReviewRounds<1||maxReviewRounds>10)throw new Error('Review round limit must be 1–10');
  return {tokenLimit,contextChars,maxAttempts,requireKnownUsage:input.requireKnownUsage===true,autoRepair:input.autoRepair===true,maxReviewRounds};
}
export function nativeRoute(member){const route=member.activeRoute??(member.route?.model?member.route:member.routeSnapshot)??{};return {fork_turns:'none',...(route.model?{model:route.model}:{}),...(route.reasoningEffort?{reasoning_effort:route.reasoningEffort}:{})};}
export function usageReport(team,runs=[]) {
  const members=team.members.map(m=>({memberId:m.id,totalTokens:0,knownAttempts:0,unknownAttempts:0})),tasks=[];
  for(const task of team.tasks) {
    const row={taskId:task.id,memberId:task.memberId,totalTokens:0,knownAttempts:0,unknownAttempts:0};
    for(const a of task.attempts??[]) {
      if(!a.agentThreadId)continue;
      const u=runs.find(r=>r.attemptId===a.id)?.usage??a.observation?.usage;
      const m=members.find(m=>m.memberId===(a.memberId??task.memberId));
      if(Number.isSafeInteger(u?.totalTokens)&&u.totalTokens>=0) {row.totalTokens+=u.totalTokens;row.knownAttempts++;if(m){m.totalTokens+=u.totalTokens;m.knownAttempts++;}}else {row.unknownAttempts++;if(m)m.unknownAttempts++;}
    }
    tasks.push(row);
  }
  const totalTokens=tasks.reduce((s,t)=>s+t.totalTokens,0),unknownAttempts=tasks.reduce((s,t)=>s+t.unknownAttempts,0),knownAttempts=tasks.reduce((s,t)=>s+t.knownAttempts,0),policy=normalizePolicy(team.policy);
  return {source:'host-observed-attempts',totalTokens,knownAttempts,unknownAttempts,complete:unknownAttempts===0,members,tasks,limit:policy.tokenLimit,
    exhausted:policy.tokenLimit!==null&&totalTokens>=policy.tokenLimit,unverifiable:policy.tokenLimit!==null&&policy.requireKnownUsage&&unknownAttempts>0,
    remaining:policy.tokenLimit===null||unknownAttempts?null:Math.max(0,policy.tokenLimit-totalTokens),cost:null,costReason:'Account usage is not a per-token invoice; no price is inferred.'};
}
export function assertBudget(team,runs) {
  const report=usageReport(team,runs);
  if(report.exhausted)throw new Error('Observed token budget exhausted; running work is retained and new dispatch is blocked');
  if(report.unverifiable)throw new Error('Token budget cannot be verified because host usage is unavailable');
  return report;
}
export function compactHandoff(handoff,{contextChars=24000}={}) {
  const out=structuredClone(handoff);
  // Goal, constraints, acceptance and every criterion remain verbatim. Only
  // verbose historical evidence is replaced by an explicit retrieval reference.
  out.dependencies=out.dependencies.map(d=>({...d,evidence:d.evidence.map(e=>({source:e.source,attemptId:e.attemptId,summary:String(e.summary??'').slice(0,1600),reference:{tool:'read_team_context',taskId:d.taskId,view:'full'},condensed:true}))}));
  out.contextBudget={limitChars:contextChars,chars:JSON.stringify(out).length,overBudget:false,source:'deterministic-handoff',requiredFieldsPreserved:true};
  out.contextBudget.overBudget=out.contextBudget.chars>contextChars;
  return out;
}
export class TeamProfiles {
  constructor(root){this.store=new DurableStore(join(root,'profiles.json'),{profiles:{}});}
  async save(name,plan,policy={},note='',{taskPlanning='seed',constraints='',expectedUpdatedAt}={}) {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name))throw new Error('Invalid profile name');
    if(!Array.isArray(plan.members)||!plan.members.length)throw new Error('A profile needs a roster');
    if(!['seed','leader'].includes(taskPlanning))throw new Error('Invalid profile task planning mode');
    if(taskPlanning==='leader'){validateMembers(plan.members);if(plan.tasks?.length)throw new Error('A leader-planned profile stores roles and constraints, not a fixed DAG');}else validatePlan(plan);
    const value={name,taskPlanning,constraints:String(constraints).slice(0,6000),plan:structuredClone(plan),policy:normalizePolicy(policy),note:String(note).slice(0,2000),updatedAt:new Date().toISOString()};
    await this.store.transaction(d=>{if(expectedUpdatedAt&&d.profiles[name]?.updatedAt!==expectedUpdatedAt)throw new Error('Profile changed; refresh before saving');value.updatedAt=new Date(Math.max(Date.now(),(Date.parse(d.profiles[name]?.updatedAt)||0)+1)).toISOString();d.profiles[name]=value;});return value;
  }
  async read(name){const d=await this.store.read();if(name){if(!d.profiles[name])throw new Error('Profile not found');return d.profiles[name];}return Object.values(d.profiles).map(({name,note,updatedAt,plan,taskPlanning})=>({name,note,updatedAt,taskPlanning:taskPlanning??'seed',members:plan.members.length}));}
  async remove(name,updatedAt){return this.store.transaction(d=>{const p=d.profiles[name];if(!p||p.updatedAt!==updatedAt)throw new Error('Profile changed; refresh before deleting');delete d.profiles[name];return {name,deleted:true};});}
}
