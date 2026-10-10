// Parse the documented public envelope without changing the original report.
// Marker checks stay outside the JSON catch so an ownership error is explicit.
export function reportEnvelope(text){
  const raw=text.trim(),match=raw.match(/^(TEAM_WORKSPACE_ATTEMPT:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\r?\n/i);
  return {prefix:match?.[1],body:match?raw.slice(match[0].length).trim():raw};
}
export function assertReportMarker(value,expectedMarker,prefix){
  const markers=['attemptMarker','taskMarker'].filter(key=>Object.hasOwn(value,key)).map(key=>value[key]);
  if(prefix&&value.attemptMarker!==prefix||markers.some(marker=>typeof marker!=='string'||!marker||marker!==markers[0]||expectedMarker!==undefined&&marker!==expectedMarker)||prefix&&expectedMarker!==undefined&&prefix!==expectedMarker){
    const error=new Error('Native delivery reports another task marker');error.code='TEAM_REPORT_MARKER_MISMATCH';throw error;
  }
}
export function parseStructuredReport(text,{expectedMarker,errorMessage='Task must return a structured JSON report'}={}){
  if(typeof text!=='string')throw new Error(errorMessage);
  const {prefix,body}=reportEnvelope(text);
  let value;try{value=JSON.parse(body.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));}catch{throw new Error(errorMessage);}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(errorMessage);
  assertReportMarker(value,expectedMarker,prefix);
  return value;
}
