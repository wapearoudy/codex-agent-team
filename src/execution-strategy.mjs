// Explicit auto selection is planning only: no model launch, scope reduction,
// route override or permission change. Existing explicit modes stay unchanged.
export function executionStrategy(team,unit,{unitCount,qualityMode,leaderRoute}){
  if(unit.executionMode!=='auto')return null;
  const member=team.members.find(m=>m.id===unit.memberId),route=member?.activeRoute??(member?.route?.model?member.route:member?.routeSnapshot??member?.route);
  const reasons=[];
  if(!['low','medium'].includes(unit.complexity))reasons.push('complexity-needs-native-members');
  if((team.hostId??'codex')!=='codex')reasons.push('host-needs-native-members');
  if(unitCount!==1)reasons.push('multiple-execution-units');
  if(qualityMode!=='standard'||unit.riskFlags?.length)reasons.push('strict-or-risk-contract');
  if(unit.validationMode==='source-only'||!['implementation','repair'].includes(unit.stage??'implementation'))reasons.push('not-bounded-executable-work');
  const inherited=route===member?.routeSnapshot&&route?.source==='host-thread-inheritance-snapshot',sameRoute=inherited&&!!route.model&&['model','provider','reasoningEffort'].every(k=>(route[k]??null)===(leaderRoute?.[k]??null));
  if((route?.model||route?.reasoningEffort||route?.provider)&&!sameRoute)reasons.push('preserve-explicit-member-route');
  return {source:'explicit-auto-execution-choice',complexity:unit.complexity,mode:reasons.length?'member':'leader',reasons:reasons.length?reasons:['one-bounded-unit-with-independent-review'],...(sameRoute&&!reasons.length?{inheritedRoute:Object.fromEntries(['model','provider','reasoningEffort'].map(k=>[k,route[k]??null]))}:{}),independentReview:true,changesQuality:false,changesRoute:false};
}
