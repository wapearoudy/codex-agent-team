const nonempty=v=>typeof v==='string'&&v.trim().length>0;
export function parseReview(text){
  if(typeof text!=='string')throw new Error('Reviewer must provide a structured verdict');
  const body=text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  let verdict;try{verdict=JSON.parse(body);}catch{throw new Error('Reviewer must provide a structured verdict');}
  if(!verdict||Array.isArray(verdict)||typeof verdict!=='object')throw new Error('Reviewer must provide a structured verdict');
  return verdict;
}
export function assertReviewPass(verdict,commands=[],requiredCriteria=[],nonValidationFailures=[]){
  if(verdict.decision!=='accept'||!nonempty(verdict.summary)||!nonempty(verdict.reason)||!Array.isArray(verdict.checks)||!verdict.checks.length||verdict.checks.some(c=>!c||!nonempty(c.name)||c.status!=='PASS'||!nonempty(c.evidence)))throw new Error('Review contains failed, missing or unverified checks; every check needs named PASS evidence and a reason');
  if(new Set(verdict.checks.map(c=>c.name.trim())).size!==verdict.checks.length)throw new Error('Review contains duplicate checks');
  if(!Array.isArray(verdict.findings)||verdict.findings.some(f=>!f||!['blocker','high','medium','low'].includes(f.severity)||!nonempty(f.description)||!['open','resolved'].includes(f.status)))throw new Error('Review needs explicit findings (use [] when none)');
  if(verdict.findings.some(f=>['blocker','high'].includes(f.severity)&&f.status!=='resolved'))throw new Error('Unresolved blocker/high review findings prevent acceptance');
  if(!Array.isArray(nonValidationFailures)||new Set(nonValidationFailures.map(x=>x.commandIndex)).size!==nonValidationFailures.length||nonValidationFailures.some(x=>!Number.isInteger(x.commandIndex)||x.commandIndex<0||!commands[x.commandIndex]||!nonempty(x.reason)))throw new Error('Invalid non-validation command explanation');
  for(const [index,c] of commands.entries()){
    if(c.status==='inProgress')throw new Error('Review contains unverified command records');
    if((c.exitCode!=null&&c.exitCode!==0||c.status==='failed')&&!nonValidationFailures.some(x=>x.commandIndex===index))throw new Error('Review contains failed command records; Leader must explicitly explain incidental non-validation failures');
  }
  const covered=new Set(verdict.checks.map(c=>c.criterionId).filter(Boolean));
  if(requiredCriteria.some(c=>!covered.has(c.id)))throw new Error('Review does not cover every required acceptance criterion');
  return true;
}
