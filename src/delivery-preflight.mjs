import {latestVerificationCommands} from './verification-command.mjs';
import {createHash} from 'node:crypto';
import {parseStructuredReport} from './report-format.mjs';
import {assertContractDelivery,assertContractPass,validatedFindings,qualityRoot} from './team-quality.mjs';
import {reviewTargetIds} from './quality-policy.mjs';
import {resolutionEvidenceText} from './quality-gates.mjs';
import {assertReviewAssurance} from './review-assurance.mjs';
const nonempty=v=>typeof v==='string'&&!!v.trim();
export const deliveryHash=text=>createHash('sha256').update(text).digest('hex');
export function deliveryTemplate(team,task){
  const attemptMarker=task.attempts.at(-1)?.marker;
  if(task.kind!=='review')return {attemptMarker,summary:'',changedPaths:[],acceptanceResults:(task.acceptanceCriteria??[]).map(c=>({criterionId:c.id,status:'NOT_RUN',evidence:''})),commandsRun:[],verificationInputs:[],limitations:[]};
  const targets=reviewTargetIds(task).map(id=>{const t=team.tasks.find(t=>t.id===id);return {taskId:id,attemptId:t.attempts.at(-1)?.id,summary:'',decision:'rework',reason:'',checks:(t.acceptanceCriteria??[]).map(c=>({name:c.description,criterionId:c.id,status:'NOT_RUN',evidence:''})),findings:[]};});
  if(targets.length>1)return {attemptMarker,summary:'',decision:'rework',targets};
  // A single target is already authenticated by the reserved review and its
  // exact dependency attempt. Avoid asking the model to recopy opaque UUIDs.
  const {taskId,attemptId,...verdict}=targets[0]??{};
  return {attemptMarker,...verdict};
}
export function preflightDelivery(team,task,member,text,commands=[],{requireReviewReady=false}={}){
  const errors=[],fail=(path,message)=>errors.push({path,message});let report;
  try{report=parseStructuredReport(text,{expectedMarker:task.attempts.at(-1)?.marker});}catch(e){fail('$',e.message);return {valid:false,errors};}
  if(!nonempty(report.summary))fail('summary','Provide a factual summary.');
  if(task.kind!=='review'){
    const rows=report.acceptanceResults;
    if(!Array.isArray(rows))fail('acceptanceResults','Use the supplied criterion template.');
    else for(const c of task.acceptanceCriteria??[]){const r=rows.find(r=>r?.criterionId===c.id);if(!r)fail('acceptanceResults.'+c.id,'Required criterion is missing.');else if(!['PASS','FAIL','BLOCKED','NOT_RUN'].includes(r.status)||!nonempty(r.evidence)&&!(Array.isArray(r.evidence)&&r.evidence.length&&r.evidence.every(nonempty)))fail('acceptanceResults.'+c.id,'Declare actual status and concrete evidence.');}
    if(task.deliveryReadinessPolicy==='same-attempt-v1'&&Array.isArray(rows)){
      for(const c of task.acceptanceCriteria??[]){const r=rows.find(r=>r?.criterionId===c.id);if(r?.status==='NOT_RUN')fail('acceptanceResults.'+c.id,'Assess this current criterion in this SAME attempt using unchanged original source and saved verification. Unchanged code is not NOT_RUN. Do not rerun successful checks for registration. If genuinely unverified, preserve BLOCKED with its factual reason; never invent PASS.');}
      if(rows.length&&rows.every(r=>r.status==='PASS')){
        const latest=latestVerificationCommands(task.contract?.verify??[],commands,{workspace:team.projectPath});
        if(latest.some(c=>!c||c.status!=='completed'||c.exitCode!==0))fail('verification','Review-ready PASS requires the latest real successful required host commands. Reuse unchanged prepared evidence; do not start QA with known absent/failed/unknown evidence. Preserve genuine failures as FAIL/BLOCKED.');
      }
    }
    try{const delivery=assertContractDelivery(task,member,text,commands,{projectPath:team.projectPath});
      if(requireReviewReady&&task.contract){const a=task.attempts.at(-1);assertContractPass({...task,attempts:[{...a,delivery,observation:{commands},evidenceSnapshot:{workspace:team.projectPath}}]});}
    }catch(e){fail(requireReviewReady?'review-readiness':'contract',e.message);}
  }else{
    const ids=reviewTargetIds(task),rows=ids.length>1?(Array.isArray(report.targets)?report.targets:[]):[report],findingOwners=new Map();
    if(!Array.isArray(rows)||rows.length!==ids.length||ids.length>1&&(new Set(rows.map(r=>r?.taskId)).size!==ids.length||rows.some(r=>!ids.includes(r?.taskId))))fail('targets','Cover exactly the supplied target IDs, without duplicates.');
    if(ids.length>1&&!['accept','rework'].includes(report.decision))fail('decision','Declare an overall batch decision.');
    for(const id of ids){const target=team.tasks.find(t=>t.id===id),row=ids.length>1?rows?.find(r=>r?.taskId===id):report;if(!row||typeof row!=='object'){fail('targets.'+id,'Target missing.');continue;}const checks=Array.isArray(row.checks)?row.checks:[];
      if(row.taskId!==undefined&&row.taskId!==id)fail('targets.'+id+'.taskId','An explicit target taskId must equal the exact reserved review target; omit it for the supplied single-target template.');
      if(row.attemptId!==undefined&&row.attemptId!==target.attempts.at(-1)?.id||ids.length>1&&row.attemptId===undefined)fail('targets.'+id+'.attemptId','Use the exact current target attempt.');
      const rowPath=ids.length>1?'targets.'+id:'$';
      if(!['accept','rework'].includes(row.decision))fail(rowPath+'.decision','Use accept or rework. Keep the supplied report structure.');
      if(!nonempty(row.reason))fail(rowPath+'.reason','Fill reason with the independent decision rationale. Do not wrap a single-target report in targets.');
      if(!nonempty(row.summary))fail(rowPath+'.summary','Fill the factual review summary. Keep the supplied report structure.');
      if(!Array.isArray(row.checks)||new Set(checks.map(r=>r?.name)).size!==row.checks?.length||new Set(checks.filter(r=>r?.criterionId).map(r=>r.criterionId)).size!==checks.filter(r=>r?.criterionId).length)fail('checks.'+id,'Use an array of uniquely named checks with unique criterion IDs.');
      for(const c of target.acceptanceCriteria??[]){const r=Array.isArray(row.checks)?row.checks.find(r=>r?.criterionId===c.id):null;if(!r||!nonempty(r.name)||!['PASS','FAIL','BLOCKED','NOT_RUN'].includes(r.status)||!nonempty(r.evidence))fail('checks.'+id+'.'+c.id,'Provide named check, actual status and evidence.');}
      if(row.decision==='accept'){
        for(const c of target.acceptanceCriteria??[]){const r=checks.find(r=>r?.criterionId===c.id);if(r&&r.status!=='PASS')fail('checks.'+id+'.'+c.id,'An accept decision requires every current contract criterion PASS, regardless of finding severity. Report actual rework with concrete findings; do not relabel an unmet criterion.');}
        try{assertContractPass(target);}catch(error){fail('targets.'+id+'.contract',error.message+'. Acceptance cannot register this saved target delivery. Preserve its original evidence; report concrete rework or the explicit blocker in this same review turn. Do not rewrite a target FAIL merely to register acceptance.');}
        if(Array.isArray(row.findings)&&row.findings.some(f=>['blocker','high'].includes(f?.severity)&&f.status==='open'))fail('findings.'+id,'Open blocker/high findings require rework. Medium/low severity also cannot excuse an unmet contract criterion.');
      }
      const findingErrorStart=errors.length;
      try{assertReviewAssurance(task,target,row,team);}catch(error){fail('assurance.'+id,error.message);}
      if(!Array.isArray(row.findings))fail('findings.'+id,'Explicit findings array required; [] is valid.');
      else for(const [i,f] of row.findings.entries()){
        const path=`findings.${id}[${i}]`;
        if(!f||typeof f!=='object'){fail(path,'Use a finding object.');continue;}
        if(!nonempty(f.id))fail(path+'.id','Provide a stable finding ID.');
        if(!['blocker','high','medium','low'].includes(f.severity))fail(path+'.severity','Use blocker, high, medium or low; major is not a supported value.');
        if(!['open','resolved'].includes(f.status))fail(path+'.status','Declare open or resolved.');
        if(!nonempty(f.description))fail(path+'.description','Provide the finding description in description (summary does not substitute).');
        if(f.status==='resolved'&&!resolutionEvidenceText(f.resolutionEvidence))fail(path+'.resolutionEvidence','Resolved findings require nonempty text or a nonempty array of nonempty text entries.');
      }
      if(Array.isArray(row.findings)&&errors.length===findingErrorStart)try{
        const findings=validatedFindings(team,target,row,{accept:row.decision==='accept'});
        if(row.decision==='rework'&&target.qualityMode&&!findings.some(f=>f.status==='open'))fail('findings.'+id,'Rework requires a concrete open finding for the actual unmet requirement or verification blocker. Resolved findings alone cannot route repair. Preserve the real verdict; add its factual structured blocker in this SAME review turn without rerunning tests.');
        for(const finding of findings){const owner=qualityRoot(target),prior=findingOwners.get(finding.id);if(prior&&prior!==owner)fail('findings.'+id,'Finding ID belongs to a different batch delivery.');findingOwners.set(finding.id,owner);}
      }catch(error){fail('findings.'+id,error.message+' Correct the closure/shape in this SAME review turn using independently inspected existing evidence; do not restart review or rerun valid tests.');}
    }
  }
  return {valid:!errors.length,errors,deliveryHash:deliveryHash(text),acceptance:false,hostTerminalRequired:task.executionMode!=='leader',...(task.executionMode==='leader'?{authenticatedTaskCheckpointRequired:true,nativeTurnStatusPreserved:true}:{})};
}
export function resolveDeliveryReceipt(task,run,output){
  let receipt;try{receipt=JSON.parse(output);}catch{return output;}
  const savedReference=receipt?.kind==='team-saved-delivery';
  const recoveryReference=receipt?.kind==='team-report-recovery';
  if(!savedReference&&!recoveryReference&&receipt?.kind!=='team-delivery-receipt')return output;
  const a=task.attempts.at(-1),saved=a.memberSubmission;
  // This literal references only the latest authenticated, format-validated
  // draft in the already verified native turn. It carries no model-copied IDs
  // or hashes, and never supplies a verdict or bypasses settlement gates.
  const referenceValid=recoveryReference?Object.keys(receipt).length===2&&receipt.requestId===saved?.requestId&&saved?.preflightVersion===1:savedReference?Object.keys(receipt).length===1&&saved?.preflightVersion===1:
    receipt.attemptMarker===a.marker&&receipt.deliveryHash===saved?.deliveryHash;
  if(!saved||saved.source!=='authenticated-member'||saved.turnId!==run.turnId||saved.contractRevision!==(task.contractRevision??1)||!referenceValid||deliveryHash(saved.text)!==saved.deliveryHash)throw new Error('Final delivery receipt does not identify the authenticated draft in this exact native turn and contract');
  return saved.text;
}
