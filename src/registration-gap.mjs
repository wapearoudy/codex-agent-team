// Native contexts can belong to this Leader without being assigned to a task.
// This is a reconciliation hint, never authority to infer delivery or rerun it.
export function registrationGap(usage){
  const count=usage?.unregisteredNativeCount??0;
  if(!count)return null;
  const contexts=(usage.contexts??[]).filter(c=>c.kind==='unregistered-native');
  const pending=contexts.filter(c=>c.association?.status==='starting'),actionable=contexts.filter(c=>c.association?.status!=='starting');
  const ids=actionable.map(c=>c.threadId).sort(),pendingCount=pending.length,actionableCount=Math.max(0,count-pendingCount);
  return {count:actionableCount,pendingCount,threadIds:ids.slice(0,8),hasMore:actionableCount>8,executionAuthority:false,
    records:actionable.slice(0,8).map(c=>({threadId:c.threadId,...c.association})),
    pendingTasks:pending.slice(0,8).map(c=>({threadId:c.threadId,...c.association})),
    detailsTool:'read_team_usage',registrationTool:'register_team_native_attempts',
    instruction:'Startup records already have a reserved task; await the same child bootstrap, never spawn or re-register them. Overdue/paused startup needs one inspection of that original child. Unmapped contexts require evidence inspection; same-parent usage alone does not prove missing delivery. Check whether they delivered this goal before dispatching waiting work; explicitly map actual tasks and ordered turns with dryRun, or keep unrelated contexts as cost only. Never infer acceptance or rerun completed work to repair the panel.'};
}
