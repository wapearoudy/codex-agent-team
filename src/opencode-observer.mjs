// Public SDK messages are the initial baseline and terminal verification.
// Native message/part events update that baseline during a running turn.
export class OpenCodeMessages {
  constructor(){this.rows=new Map();this.initialized=false;this.needsRefresh=false;this.journal=null;}
  async refresh(read){
    this.journal=[];
    try{const rows=await read(),events=this.journal;this.journal=null;this.reset(rows);for(const event of events)this.event(event);}
    finally{this.journal=null;}
  }
  reset(rows){this.rows=new Map(rows.filter(r=>r.info?.id).map(r=>[r.info.id,structuredClone(r)]));this.initialized=true;this.needsRefresh=false;}
  event(event){
    if(this.journal)this.journal.push(structuredClone(event));
    const p=event.properties??{};
    if(event.type==='message.updated'){
      if(!p.info?.id){this.needsRefresh=true;return;}
      const old=this.rows.get(p.info.id);this.rows.set(p.info.id,{info:structuredClone(p.info),parts:old?.parts??[]});
    }else if(event.type==='message.part.updated'){
      const part=p.part,row=this.rows.get(part?.messageID);
      if(!part?.id||!row||p.delta){this.needsRefresh=true;return;}
      const at=row.parts.findIndex(x=>x.id===part.id);if(at<0)row.parts.push(structuredClone(part));else row.parts[at]=structuredClone(part);
    }else if(event.type==='message.removed'){if(!p.messageID)this.needsRefresh=true;else this.rows.delete(p.messageID);}
    else if(event.type==='message.part.removed'){const row=this.rows.get(p.messageID);if(!row||!p.partID)this.needsRefresh=true;else row.parts=row.parts.filter(x=>x.id!==p.partID);}
    else if(event.type==='message.part.delta')this.needsRefresh=true;
  }
  snapshot(){return [...this.rows.values()].sort((a,b)=>(a.info.time?.created??0)-(b.info.time?.created??0)||a.info.id.localeCompare(b.info.id));}
}
