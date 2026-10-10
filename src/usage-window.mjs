// Numeric public accounting only. Never retain prompts, tool arguments or
// reasoning. A missing baseline stays unknown rather than becoming zero.
const fields=['totalTokens','inputTokens','cachedInputTokens','outputTokens'];
const zero=()=>Object.fromEntries(fields.map(k=>[k,0]));
export class UsageWindow {
  constructor({maxSamples=20000}={}){this.maxSamples=maxSamples;this.samples=[];this.previous=null;this.truncatedBefore=null;this.unlocated=false;}
  record(at,total,last){
    if(!total)return;
    const previous=this.previous;this.previous=total;
    if(previous?.totalTokens===total.totalTokens)return;
    const time=Date.parse(at);if(!Number.isFinite(time)){this.unlocated=true;return;}
    const base=previous&&previous.totalTokens<total.totalTokens?previous:last?.totalTokens===total.totalTokens?zero():null;
    const delta=base?Object.fromEntries(fields.map(k=>[k,total[k]===null||base[k]===null?null:Math.max(0,total[k]-base[k])])):null;
    this.samples.push({at:time,delta});
    if(this.samples.length>this.maxSamples)this.truncatedBefore=this.samples.splice(0,this.samples.length-this.maxSamples).at(-1).at;
  }
  read({since,until}={}){
    const from=Date.parse(since),to=until?Date.parse(until):Infinity;
    if(!Number.isFinite(from)||Number.isNaN(to)||to<from)throw new Error('Invalid usage time window');
    if(!this.previous)return {source:'host-observed-time-window',usage:null,complete:false,reason:'No public token accounting'};
    const rows=this.samples.filter(s=>s.at>=from&&s.at<=to),sum=zero();let unknownSamples=0;
    for(const row of rows){if(!row.delta){unknownSamples++;continue;}for(const k of fields)sum[k]=sum[k]===null||row.delta[k]===null?null:sum[k]+row.delta[k];}
    const truncated=this.truncatedBefore!==null&&from<=this.truncatedBefore,complete=!unknownSamples&&!truncated&&!this.unlocated;
    return {source:'host-observed-time-window',usage:sum,complete,sampleCount:rows.length,unknownSamples,truncated,window:{since,until:until??null}};
  }
}
