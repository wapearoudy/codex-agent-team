// Registered reviewer rework is not implementation acceptance. These measures
// describe saved outcomes, never infer correctness from a PASS/test count.
export function deliveryQualityMetrics(team,tasks){
  const work=tasks.filter(t=>t.kind!=='review'),root=t=>t.repairRootTaskId??t.id,roots=new Set(work.map(root));
  const current=work.filter(t=>!t.supersededBy&&t.status!=='cancelled'),outcomes=[];
  for(const review of tasks.filter(t=>t.kind==='review'))for(const a of review.attempts??[]){
    const rows=a.batchReview?.targets??(['accept','rework'].includes(a.review?.decision)?[{taskId:review.reviewOfTaskId,decision:a.review.decision}]:[]);
    for(const r of rows){const target=team.tasks.find(t=>t.id===r.taskId);if(target&&roots.has(root(target)))outcomes.push({rootTaskId:root(target),decision:r.decision,at:a.review?.at??a.endedAt??a.startedAt??null,attemptId:a.id});}
  }
  outcomes.sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));
  const first=new Map();for(const r of outcomes)if(!first.has(r.rootTaskId))first.set(r.rootTaskId,r);
  const findings=(team.findings??[]).filter(f=>roots.has(f.rootTaskId)),accepted=current.filter(t=>t.status==='accepted'),batch=team.batches?.find(b=>b.id===team.activeBatchId),final=batch?.finalAcceptance??(!team.activeBatchId?team.finalAcceptance:null);
  const start=Date.parse(batch?.createdAt??team.createdAt),end=Date.parse(final?.at??final?.completedAt),firstPass=[...first.values()].filter(r=>r.decision==='accept').length;
  return {source:'recorded-independent-decisions-not-whole-code-correctness',currentWorkTasks:current.length,acceptedWorkTasks:accepted.length,unfinishedWorkTasks:current.length-accepted.length,
    reviewedWorkRoots:first.size,firstPassWorkRoots:firstPass,firstReviewPassRate:first.size?firstPass/first.size:null,reworkDecisions:outcomes.filter(r=>r.decision==='rework').length,
    uniqueFindings:findings.length,resolvedFindings:findings.filter(f=>f.status==='resolved').length,openContractFindings:findings.filter(f=>f.status==='open'&&f.scope!=='advisory').length,
    goalClosed:!!final,goalWallMs:Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null,falsePositiveRate:null,
    limitations:['First-pass rate covers registered independent verdicts only, not unaudited work or blind benchmark correctness.','Finding closure is the recorded reviewer judgment; false-positive rate requires separate adjudication.','Goal wall time starts at saved formation/batch creation and excludes earlier Leader planning.']};
}
