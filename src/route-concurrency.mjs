export function concurrencyLimits(input={}){
  const result={};
  for(const name of ['providerConcurrency','modelConcurrency']){
    if(input[name]===undefined)continue;
    const value=input[name];if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100||Object.entries(value).some(([k,v])=>!k.trim()||k.length>200||['__proto__','prototype','constructor'].includes(k)||!Number.isInteger(v)||v<1||v>8))throw new Error('Invalid '+name);
    result[name]={...value};
  }
  return result;
}
export function routeIdentity(member){const route=member?.activeRoute??(member?.route?.model?member.route:member?.routeSnapshot)??{};return {provider:route.provider??member?.routeSnapshot?.provider??'unknown',model:route.model??'unknown'};}
export function routeLimitBlockers(team,task){
  const route=routeIdentity(team.members.find(m=>m.id===task.memberId)),running=team.tasks.filter(t=>t.status==='running'&&t.id!==task.id),out=[];
  for(const [field,key]of [['providerConcurrency','provider'],['modelConcurrency','model']]){
    const limit=team.policy?.[field]?.[route[key]];if(limit!==undefined&&running.filter(t=>routeIdentity(team.members.find(m=>m.id===t.memberId))[key]===route[key]).length>=limit)out.push({code:field==='providerConcurrency'?'provider-limit':'model-limit',message:key+' '+route[key]+' concurrency limit reached ('+limit+')'});
  }
  return out;
}
export function concurrencyExpands(before,after){return ['providerConcurrency','modelConcurrency'].some(k=>Object.entries(before[k]??{}).some(([id,limit])=>after[k]?.[id]===undefined||after[k][id]>limit));}
