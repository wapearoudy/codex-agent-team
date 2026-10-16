import {createHash} from 'node:crypto';
import {safeQualityPath,within} from './team-quality.mjs';
import {validatePlan} from './team.mjs';
import {attachBatch} from './team-batches.mjs';
import {assertReviewTopology,RISK_FLAGS} from './quality-policy.mjs';
import {executionStrategy} from './execution-strategy.mjs';
import {REPAIR_BUDGET_POLICY} from './review-budget.mjs';
import {REVIEW_EVIDENCE_POLICY} from './review-assurance.mjs';
import {REVIEW_SCOPE_POLICY} from './review-ownership.mjs';

const key=/^[a-zA-Z0-9_-]{1,64}$/;
const text=v=>typeof v==='string'&&!!v.trim();
const unique=v=>[...new Set(v)];
// This rejects obvious instructions, not arbitrary unknown executables. It
// never runs a command or claims to prove that a shell command will succeed.
export function commandInstruction(command){
  return typeof command!=='string'||!command.trim()||/^(?:Run|Execute|Inspect|Compare|Report|Use|Check|Targeted|Verify|Review|Preserve|运行|执行|检查|比较|核对|报告|验证)(?:\s|[：:])/.test(command.trim());
}
export function compileTeamTasks(team,input,selectionContext={}){
  const errors=[],warnings=[],add=(path,code,message)=>errors.push({path,code,message});
  input=input&&typeof input==='object'?input:{};
  let units=Array.isArray(input.units)?input.units:[];const mode=input.batch?.qualityMode??'standard';
  units=units.map(u=>{if(!u||typeof u!=='object'||Array.isArray(u))return u;const strategy=executionStrategy(team,u,{unitCount:units.length,qualityMode:mode,leaderRoute:selectionContext.leaderRoute});return strategy?{...u,executionMode:strategy.mode,executionStrategy:strategy}:u;});
  for(const [i,u] of units.entries()){
    if(!u||typeof u!=='object'||Array.isArray(u)){add(`units[${i}]`,'shape','Use a business-unit object.');continue;}
    if(!Array.isArray(u.criteria)||!u.criteria.length)add(`units[${i}].criteria`,'criteria','Provide required criterion objects before grouping or execution.');
    if(u.complexity!==undefined&&!['low','medium','high'].includes(u.complexity))add(`units[${i}].complexity`,'complexity','Use low, medium or high business complexity.');
    if(input.units[i]?.executionMode==='auto'&&!u.complexity)add(`units[${i}].complexity`,'complexity','Explicit auto execution needs declared business complexity.');
    for(const f of ['criteria','writePaths','readPaths','verifyCommands','riskFlags','outOfScope','dependencies','coverageOf','resources'])if(u[f]!==undefined&&!Array.isArray(u[f]))add(`units[${i}].${f}`,'shape','Use an array.');
    for(const [f,max] of [['title',200],['goal',3000],['context',12000]])if(u[f]!==undefined&&(typeof u[f]!=='string'||u[f].length>max))add(`units[${i}].${f}`,'length',`Use a string of at most ${max} characters; preserve full scope in bounded work units.`);
    if(Array.isArray(u.criteria)&&u.criteria.some(c=>!c||typeof c!=='object'||typeof c.description!=='string'||c.description.length>2000))add(`units[${i}].criteria`,'shape','Use criterion objects with bounded full descriptions.');
    if(Array.isArray(u.dependencies)&&u.dependencies.some(d=>typeof d!=='string'&&(!d||typeof d!=='object'||!['delivered','submitted','accepted'].includes(d.when))))add(`units[${i}].dependencies`,'shape','Use unit IDs or taskId/when objects.');
  }
  if(errors.length)return {kind:'team-plan-preflight',valid:false,errors,warnings,startsModel:false,mutates:false};
  if(input.combineGroups!==undefined){
    if(!Array.isArray(input.combineGroups))add('combineGroups','shape','Use explicit groups of new unit IDs.');
    else {
      const used=new Set();
      for(const [i,g] of input.combineGroups.entries()){
        const selected=Array.isArray(g?.unitIds)?units.filter(u=>g.unitIds.includes(u.id)):[];
        if(!key.test(g?.id??'')||!Array.isArray(g?.unitIds)||g.unitIds.length<2||selected.length!==g.unitIds.length||new Set(g.unitIds).size!==g.unitIds.length||g.unitIds.some(id=>used.has(id))){add(`combineGroups[${i}]`,'group','Use a unique group ID and disjoint existing new unit IDs.');continue;}
        const first=selected[0];
        if(selected.some(u=>u.executionMode==='leader'||u.memberId!==first.memberId||(u.reviewerId??input.reviewerId)!==(first.reviewerId??input.reviewerId)||(u.stage??'implementation')!==(first.stage??'implementation')||(u.validationMode??'execute')!==(first.validationMode??'execute')||u.riskFlags?.length)||mode==='strict'){add(`combineGroups[${i}]`,'quality','Combine only same-member, same-stage standard native work; Leader/risk deliveries remain separate.');continue;}
        g.unitIds.forEach(id=>used.add(id));
      }
      if(!errors.length){
        const mapping=new Map(input.combineGroups.flatMap(g=>g.unitIds.map(id=>[id,g.id]))),merged=[];
        for(const g of input.combineGroups){const selected=units.filter(u=>g.unitIds.includes(u.id)),first=selected[0];merged.push({...first,id:g.id,title:selected.map(u=>u.title).join(' · '),goal:selected.map(u=>u.goal).join('\n'),context:selected.map(u=>`Unit ${u.id}: ${u.context??u.goal}`).join('\n'),criteria:selected.flatMap(u=>u.criteria.map(c=>({...c,id:u.id+'_'+c.id}))),writePaths:unique(selected.flatMap(u=>u.writePaths)),readPaths:unique(selected.flatMap(u=>u.readPaths??[])),outOfScope:unique(selected.flatMap(u=>u.outOfScope??[])),verifyCommands:unique(selected.flatMap(u=>u.verifyCommands??[])),coverageOf:unique(selected.flatMap(u=>u.coverageOf??[])),resources:unique(selected.flatMap(u=>u.resources??[])),dependencies:selected.flatMap(u=>u.dependencies??[]).filter(d=>!g.unitIds.includes(typeof d==='string'?d:d.taskId)),sourceUnitIds:g.unitIds});}
        units=[...units.filter(u=>!mapping.has(u.id)),...merged].map(u=>({...u,dependencies:(u.dependencies??[]).map(d=>typeof d==='string'?(mapping.get(d)??d):({...d,taskId:mapping.get(d.taskId)??d.taskId}))}));
        // Revalidate the merged contract rather than silently truncating scope.
        const result=compileTeamTasks(team,{...input,units,combineGroups:undefined});
        return {...result,grouping:{sourceUnits:input.units.length,executionUnits:units.length,groups:structuredClone(input.combineGroups),preservesCriteria:true,changesHistory:false},...(result.valid?{sourceUnits:structuredClone(input.units)}:{})};
      }
    }
    if(errors.length)return {kind:'team-plan-preflight',valid:false,errors,warnings,startsModel:false,mutates:false};
  }
  if(!Array.isArray(units)||!units.length||units.length>20)add('units','count','Provide 1–20 business work units.');
  if(!input.batch||!key.test(input.batch.id??'')||!text(input.batch.title)||!text(input.batch.goal))add('batch','identity','Provide batch id, title and confirmed goal.');
  if(!['standard','strict'].includes(mode))add('batch.qualityMode','review-required','The compiler retains independent review; use standard or strict.');
  if(units.some(u=>u.executionMode!==undefined&&!['member','leader'].includes(u.executionMode)))add('units.executionMode','mode','Use member or explicit leader execution.');
  if(units.some(u=>u.executionMode==='leader')&&(units.length!==1||mode!=='standard'||units[0].riskFlags?.length||units[0].validationMode==='source-only'))add('units.executionMode','scope','Leader execution requires one bounded standard execution unit plus a distinct independent reviewer; strict/risk or multiple units use native members.');
  const allIds=new Set(team.tasks.map(t=>t.id)),unitIds=new Set(),members=new Map(team.members.filter(m=>!m.removedAt).map(m=>[m.id,m]));
  for(const [i,u] of (Array.isArray(units)?units:[]).entries()){
    const p=`units[${i}]`,m=members.get(u.memberId),reviewer=members.get(u.reviewerId??input.reviewerId);
    if(!key.test(u.id??'')||unitIds.has(u.id)||allIds.has(u.id))add(p+'.id','identity','Use a new unique ASCII work-unit ID (max 64 characters).');
    unitIds.add(u.id);
    for(const f of ['title','goal'])if(!text(u[f]))add(p+'.'+f,'required','A business title and goal are required.');
    if(!m)add(p+'.memberId','member','Use an existing confirmed member.');
    if(!reviewer||reviewer.id===m?.id||reviewer.writeScopes.length)add(p+'.reviewerId','independence','Select a distinct confirmed read-only reviewer.');
    if(!Array.isArray(u.criteria)||!u.criteria.length||u.criteria.length>30||u.criteria.some(c=>!key.test(c?.id??'')||!text(c?.description))||new Set(u.criteria.map(c=>c.id)).size!==u.criteria.length)add(p+'.criteria','criteria','Provide unique criterion IDs and full descriptions.');
    if(!['requirements','implementation','verification','repair','integration'].includes(u.stage??'implementation'))add(p+'.stage','stage','Use a supported business stage.');
    if(u.validationMode!==undefined&&!['execute','source-only'].includes(u.validationMode))add(p+'.validationMode','validation','Use execute or source-only.');
    if(!Array.isArray(u.writePaths)||u.writePaths.length>30||u.writePaths.some(v=>!safeQualityPath(v)))add(p+'.writePaths','paths','Provide safe project-relative write paths; read-only units use [].');
    else if(u.writePaths.some(path=>!m?.writeScopes.some(scope=>within(path,scope))))add(p+'.writePaths','scope','Write paths exceed the confirmed member scope.');
    if(['implementation','repair'].includes(u.stage??'implementation')&&!u.writePaths?.length)add(p+'.writePaths','scope','Implementation/repair needs an explicit write scope.');
    if(u.readPaths!==undefined&&(u.readPaths.length>30||u.readPaths.some(v=>!safeQualityPath(v)||v.length>300)))add(p+'.readPaths','paths','Provide up to 30 explicit safe project-relative text files, not directories or instructions.');
    if(u.riskFlags?.some(f=>!RISK_FLAGS.includes(f)))add(p+'.riskFlags','risk','Unknown risk flag.');
    const commands=u.verifyCommands??[];
    if(!Array.isArray(commands)||commands.length>30)add(p+'.verifyCommands','commands','Provide at most 30 exact shell commands.');
    else for(const [j,c] of commands.entries())if(commandInstruction(c))add(`${p}.verifyCommands[${j}]`,'command-not-instruction','Provide an exact native command, e.g. python3 -m unittest test_store.py -v; put explanations in context.');
    if(u.validationMode==='source-only'&&commands.length)add(p+'.verifyCommands','source-only','Source-only units must not claim executed commands.');
    if(u.validationMode!=='source-only'&&(u.stage??'implementation')!=='requirements'&&!commands.length)add(p+'.verifyCommands','required','Executable units need an exact verification command.');
    if(u.riskFlags?.length&&u.validationMode==='source-only')add(p+'.validationMode','risk','High-risk delivery requires executable verification.');
    if((u.outOfScope??[]).some(v=>!safeQualityPath(v)))add(p+'.outOfScope','paths','Use project-relative paths, not explanatory prose.');
    if((u.dependencies??[]).some(d=>!key.test(typeof d==='string'?d:d?.taskId??'')))add(p+'.dependencies','dependency','Dependencies must reference work-unit IDs.');
  }
  for(const [i,u] of (Array.isArray(units)?units:[]).entries())for(const d of u.dependencies??[]){const id=typeof d==='string'?d:d.taskId;if(id===u.id||!unitIds.has(id)&&!allIds.has(id))add(`units[${i}].dependencies`,'dependency','Missing or self dependency: '+id);}
  const batch={...input.batch,qualityMode:mode,integrationRequired:mode==='strict'||units.some(u=>u.riskFlags?.length)||!!input.batch?.integrationRequired};
  const goalCriteria=Array.isArray(batch.goalCriteria)?batch.goalCriteria:[];
  if(batch.goalCriteria!==undefined&&(!Array.isArray(batch.goalCriteria)||goalCriteria.some(c=>!c||!key.test(c.id??'')||!text(c.description))))add('batch.goalCriteria','shape','Provide goal criterion objects with unique IDs and full descriptions.');
  for(const criterion of goalCriteria.filter(c=>c&&key.test(c.id??'')))if(!units.some(u=>u.coverageOf?.includes(criterion.id))&&!team.tasks.some(t=>t.batchId===batch.id&&t.kind!=='review'&&t.contract?.coverageOf?.includes(criterion.id)))add('batch.goalCriteria','missing-coverage','Declare the work unit coverageOf for goal criterion '+criterion.id+' before execution; generated reviews independently validate those work units.');
  if(batch.integrationRequired&&!(units??[]).some(u=>u.stage==='integration')&&!team.tasks.some(t=>t.batchId===batch.id&&t.contract?.stage==='integration'))add('units','integration','This batch needs an explicit integration unit with exact verification commands.');
  if(errors.length)return {kind:'team-plan-preflight',valid:false,errors,warnings,startsModel:false,mutates:false};
  const tasks=units.map(u=>({id:u.id,title:u.title,goal:u.goal,context:u.context??'',acceptance:u.criteria.map(c=>c.description).join('\n'),acceptanceCriteria:structuredClone(u.criteria),...(u.sourceUnitIds?{sourceUnitIds:u.sourceUnitIds}:{}),
    contract:{stage:u.stage??'implementation',inScope:unique(u.writePaths),...(u.readPaths?.length?{readPaths:unique(u.readPaths)}:{}),outOfScope:unique(u.outOfScope??[]),verify:unique(u.verifyCommands??[]),coverageOf:u.coverageOf??[]},
    deliveryReadinessPolicy:'same-attempt-v1',repairBudgetPolicy:REPAIR_BUDGET_POLICY,memberId:u.memberId,...(u.executionMode==='leader'?{executionMode:'leader'}:{}),...(u.executionStrategy?{executionStrategy:u.executionStrategy}:{}),priority:u.priority??3,kind:'work',validationMode:u.validationMode??'execute',batchId:batch.id,qualityMode:u.riskFlags?.length?'strict':mode,riskFlags:u.riskFlags??[],resources:u.resources??[],
    dependencies:(u.dependencies??[]).map(d=>typeof d==='string'?{taskId:d,when:'delivered'}:{...d})}));
  const groups=new Map();
  for(const u of units){const task=tasks.find(t=>t.id===u.id),reviewer=u.reviewerId??input.reviewerId,group=task.qualityMode==='strict'?u.id:'batch-'+reviewer;const row=groups.get(group)??{reviewer,targets:[]};row.targets.push(task);groups.set(group,row);}
  for(const [group,{reviewer,targets}] of groups){
    const reviewId=('review-'+group).slice(0,39)+'-'+createHash('sha256').update(JSON.stringify([batch.id,group])).digest('hex').slice(0,12);
    if(allIds.has(reviewId)){add('units','review-id','Generated review ID already exists; choose a new batch.');continue;}
    tasks.push({id:reviewId,title:'独立审查 · '+targets.map(t=>t.title).join('、').slice(0,170),goal:'独立核对以下目标的当前候选、合同与已有验证证据；不改代码，不重复已有有效测试：'+targets.map(t=>t.id).join(', '),context:'Required source and saved command evidence is read-only. Current checks must cover each exact target attempt; future/advisory checks do not replace required criteria.',
      acceptance:'独立审查覆盖全部目标条件，真实发现保留并明确 accept 或 rework。',acceptanceCriteria:[{id:'independent-review',description:'独立检查精确候选与所有本轮条件，提供逐项证据和发现。'}],
      contract:{stage:'review',inScope:[],outOfScope:[],verify:[],coverageOf:[]},reviewScopePolicy:REVIEW_SCOPE_POLICY,reviewEvidencePolicy:REVIEW_EVIDENCE_POLICY,memberId:reviewer,priority:3,kind:'review',validationMode:'source-only',batchId:batch.id,qualityMode:targets[0].qualityMode,
      reviewOfTaskId:targets[0].id,...(targets.length>1?{reviewOfTaskIds:targets.map(t=>t.id)}:{}),resources:[],dependencies:targets.map(t=>({taskId:t.id,when:'submitted'}))});
  }
  const verificationOwners=new Map();
  for(const t of tasks)for(const command of t.contract.verify){const ids=verificationOwners.get(command)??[];ids.push(t.id);verificationOwners.set(command,ids);}
  for(const [command,ids] of verificationOwners)if(ids.length>1)warnings.push({code:'overlapping-verification',taskIds:ids,command,message:'Reuse only host-proven success on unchanged complete inputs; this warning does not remove required checks.'});
  const clone=structuredClone(team);clone.tasks.push(...structuredClone(tasks));
  try{attachBatch(clone,clone.tasks.filter(t=>tasks.some(n=>n.id===t.id)),batch);validatePlan(clone);assertReviewTopology(clone);}catch(e){add('plan','topology',e.message);}
  if(errors.length)return {kind:'team-plan-preflight',valid:false,errors,warnings,startsModel:false,mutates:false};
  const planHash=createHash('sha256').update(JSON.stringify({tasks,batch})).digest('hex');
  return {kind:'team-plan-preflight',valid:true,errors:[],warnings,tasks,batch,planHash,startsModel:false,mutates:false,
    summary:{workUnits:units.length,independentReviews:tasks.length-units.length,executionMembers:unique(units.map(u=>u.memberId)).length},
    groupingAdvice:units.length>1?'Combine tightly coupled units before committing when the same confirmed write scope permits it; independent review is retained.':'Do not start extra execution members for one bounded unit.'};
}
