// Native contexts can belong to this Leader without being assigned to a task.
// This is a reconciliation hint, never authority to infer delivery or rerun it.
export function registrationGap(usage){
  const count=usage?.unregisteredNativeCount??0;
  if(!count)return null;
  const ids=(usage.contexts??[]).filter(c=>c.kind==='unregistered-native').map(c=>c.threadId).sort();
  return {count,threadIds:ids.slice(0,8),hasMore:count>8,executionAuthority:false,
    detailsTool:'read_team_usage',registrationTool:'register_team_native_attempts',
    instruction:'Verified native contexts are missing task registration. Check whether they delivered this goal before dispatching waiting work; explicitly map actual tasks and ordered turns with dryRun, or keep unrelated contexts as cost only. Never infer acceptance or rerun completed work to repair the panel.'};
}
