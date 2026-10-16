import {qualityMetrics,qualityMode} from './quality-policy.mjs';
import {createHash} from 'node:crypto';
const amount=v=>Number.isFinite(v)&&v>=0?v:null;
export function costSignature(team,tasks=team.tasks){
  const rows=tasks.map(t=>{const m=team.members.find(m=>m.id===t.memberId),c=t.contract??{};return {kind:t.kind,goal:t.goal,criteria:t.acceptanceCriteria??c.criteria,stage:c.stage,quality:qualityMode(t),contract:c,route:m?.activeRoute??m?.routeSnapshot??m?.route??null};});
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function historicalCostProfile(team,usage,tasks=team.tasks){
  const complete=(usage?.accountingComplete??false)&&tasks.length===team.tasks.length;
  const byTask=new Map((usage?.tasks??[]).map(r=>[r.taskId,r]));
  const component=predicate=>{const rows=tasks.filter(predicate).map(t=>byTask.get(t.id));return rows.some(r=>!r||r.unknownAttempts)?null:rows.reduce((n,r)=>n+r.totalTokens,0);};
  return {signature:costSignature(team,tasks),scope:'whole-team-window',complete,totalTokens:complete?amount(usage.totalTokens):null,
    components:{executionIncludingStartupTokens:component(t=>t.kind!=='review'&&t.contract?.stage!=='integration'),independentReviewIncludingStartupTokens:component(t=>t.kind==='review'),integrationIncludingStartupTokens:component(t=>t.kind!=='review'&&t.contract?.stage==='integration'),leaderCoordinationTokens:complete?amount(usage.leaderTokens):null,unregisteredAndFailedContextTokens:complete?amount(usage.unregisteredNativeTokens):null,startupTokens:null,recoveryTokens:null},
    limitations:['Task components include every recorded attempt, including rework; startup and recovery cannot be isolated from aggregate host counters.','Later batches sharing a cumulative team window are not comparable standalone samples.']};
}
export function historicalCostReference(team,tasks=team.tasks){
  const signature=costSignature(team,tasks),samples=(team.efficiencyHistory??[]).map(h=>h.historicalProfile).filter(p=>p?.signature===signature&&p.complete&&amount(p.totalTokens)!==null);
  const range=values=>values.length?{min:Math.min(...values),median:[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)],max:Math.max(...values)}:null;
  return {source:'same-team-exact-contract-and-model-history',signature,sampleCount:samples.length,confidence:samples.length?'historical-reference-only':'unknown',totalTokens:range(samples.map(s=>s.totalTokens)),components:Object.fromEntries(['executionIncludingStartupTokens','independentReviewIncludingStartupTokens','integrationIncludingStartupTokens','leaderCoordinationTokens','unregisteredAndFailedContextTokens','startupTokens','recoveryTokens'].map(k=>[k,range(samples.map(s=>s.components[k]).filter(v=>amount(v)!==null))])),includesFailedAndRecoveredAttempts:true,changesModel:false,changesQuality:false,executionAuthority:false};
}
export function economyForecast(team,input={},tasks=team.tasks){
  const fields=['soloTokens','businessTokens','avoidedInputTokens','startupTokensPerContext','coordinationTokens','reviewTokens','integrationTokens','recoveryTokens'];
  const estimates=Object.fromEntries(fields.map(k=>[k,amount(input[k])]));
  const members=Number.isInteger(input.executionContexts)&&input.executionContexts>0?input.executionContexts:null;
  const known=members!==null&&fields.every(k=>estimates[k]!==null);
  const overhead=known?members*estimates.startupTokensPerContext+estimates.coordinationTokens+estimates.reviewTokens+estimates.integrationTokens+estimates.recoveryTokens:null;
  const teamTokens=known?Math.max(0,estimates.businessTokens-estimates.avoidedInputTokens)+overhead:null;
  const solo=estimates.soloTokens;
  return {kind:'team-economy-forecast',source:'explicit-estimates-not-measured-savings',confidence:known?'estimate':'unknown',
    estimatedTeamTokens:teamTokens,estimatedSoloTokens:solo,estimatedOverheadTokens:overhead,estimatedRatio:known&&solo>0?teamTokens/solo:null,
    recommendedExecution:!known?'measure-before-claiming-savings':teamTokens<solo?'scoped-multiple-executors':'combine-coupled-work-with-independent-review',
    retainedQuality:{independentReview:true,strictTasks:team.tasks.filter(t=>qualityMode(t)==='strict').length},
    estimates,executionContexts:members,historicalReference:historicalCostReference(team,tasks),changesModel:false,changesQuality:false,executionAuthority:false};
}
export function teamEconomy(team,usage,input={}){
  const complete=usage?.accountingComplete??usage?.complete??false;
  const total=complete?amount(usage?.totalTokens):null;
  const solo=amount(input.soloTokens);
  return {...economyForecast(team,input),actual:{scope:usage?.scope??'saved-team-window',complete,totalTokens:total,
    inputTokens:usage?.inputTokens??null,cachedInputTokens:usage?.cachedInputTokens??null,uncachedInputTokens:usage?.uncachedInputTokens??null,outputTokens:usage?.outputTokens??null,
    leaderTokens:usage?.leaderTokens??null,memberTokens:usage?.memberTokens??null,unregisteredNativeTokens:usage?.unregisteredNativeTokens??null,
    observedRatio:total!==null&&solo>0?total/solo:null,savingsClaimAllowed:!!(complete&&total!==null&&solo>0&&(team.finalAcceptance||team.batches?.some(b=>b.id===team.activeBatchId&&b.finalAcceptance))&&total<solo),
    includesFailedAndRecoveredAttempts:true},metrics:qualityMetrics(team),
    limitations:['Saved team-window accounting may exclude pre-formation Leader work; a fresh-root comparison must count the whole root plus descendants.','Estimates do not authorize scope changes, omit independent review, or prove a financial/quota saving.']};
}
export function phaseEconomy({currentInputTokens,remainingRequests,cleanInputTokens,handoffTokens}){
  const values=[currentInputTokens,remainingRequests,cleanInputTokens,handoffTokens];
  if(values.some(v=>amount(v)===null))return {decision:'unknown',rotate:false,reason:'Estimate remaining requests and restart/transfer costs at a meaningful phase boundary.'};
  const avoided=Math.max(0,currentInputTokens-cleanInputTokens)*remainingRequests;
  return {decision:avoided>cleanInputTokens+handoffTokens?'beneficial':'keep-current',rotate:avoided>cleanInputTokens+handoffTokens,avoidedInputTokens:avoided,restartAndHandoffTokens:cleanInputTokens+handoffTokens};
}
