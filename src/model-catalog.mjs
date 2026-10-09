// Read the installed host's catalog. No model sessions are started.
export class ModelCatalog {
  constructor(host,{ttlMs=60000}={}){this.host=host;this.ttlMs=ttlMs;}
  async read(){
    if(this.cached&&Date.now()-this.cachedAt<this.ttlMs)return structuredClone(this.cached);
    if(!this.pending)this.pending=this.fetch().finally(()=>{this.pending=null;});return structuredClone(await this.pending);
  }
  async fetch(){
    const models=[],seen=new Set();let cursor;
    for(let page=0;page<20;page++){
      const params={limit:100,...(cursor?{cursor}:{})};
      const response=this.host.call?await this.host.call('model/list',params):await (await this.host.connect()).call('model/list',params);
      if(!Array.isArray(response.data))throw new Error('Host model catalog unavailable');
      for(const m of response.data){if(m.hidden||typeof m.model!=='string')continue;if(seen.has(m.model))continue;seen.add(m.model);models.push({model:m.model,displayName:m.displayName??m.model,isDefault:m.isDefault===true,defaultReasoningEffort:m.defaultReasoningEffort,supportedReasoningEfforts:(m.supportedReasoningEfforts??[]).map(e=>typeof e==='string'?e:e.reasoningEffort).filter(e=>typeof e==='string')});}
      if(models.length>200)throw new Error('Host model catalog exceeds the safe display limit');
      if(!response.nextCursor){this.cached={source:'host-model-list',observedAt:new Date().toISOString(),models,inheritedRoute:'Host inheritance; observed model is recorded when the native attempt is bound'};this.cachedAt=Date.now();return this.cached;}
      if(response.nextCursor===cursor)throw new Error('Host model catalog pagination did not advance');cursor=response.nextCursor;
    }throw new Error('Host model catalog pagination exceeded the safe limit');
  }
  async validate(members,{resolveDefaults=false,includeFrozen=true}={}){
    const selected=m=>m.route?.model||m.route?.reasoningEffort?m.route:includeFrozen?m.routeSnapshot:null;
    if(!members?.some(m=>selected(m)?.model||selected(m)?.reasoningEffort))return;
    const {models}=await this.read();
    for(const m of members){const route=selected(m);if(!route?.model&&!route?.reasoningEffort)continue;
      if(!route.model)throw new Error('Select a host model before selecting its reasoning effort');
      const model=models.find(row=>row.model===route.model);if(!model)throw new Error(`Model ${route.model} is not offered by this host; refresh the model catalog`);
      if(resolveDefaults&&!route.reasoningEffort&&model.supportedReasoningEfforts.includes(model.defaultReasoningEffort))route.reasoningEffort=model.defaultReasoningEffort;
      if(route.reasoningEffort&&!model.supportedReasoningEfforts.includes(route.reasoningEffort))throw new Error(`Model ${route.model} does not support reasoning effort ${route.reasoningEffort}`);
    }
  }
  async freeze(members,context){
    if(!members?.length)return;
    await this.validate(members,{resolveDefaults:true,includeFrozen:false});
    for(const member of members){
      const inherited=!member.route?.model,host=context.modelRoute??{};
      member.routeSnapshot={model:member.route?.model??host.model??null,provider:host.provider??null,
        reasoningEffort:member.route?.reasoningEffort??(inherited?host.reasoningEffort:null)??null,
        source:inherited?'host-thread-inheritance-snapshot':'explicit-catalog-route'};
      if(member.fallbackRoute)await this.validate([{route:member.fallbackRoute}],{resolveDefaults:true});
    }
    await this.validate(members);
  }
}
