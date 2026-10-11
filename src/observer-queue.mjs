// At most one active publication and one coalesced follow-up per session.
// A request received during a write waits for a newer observation, never an old one.
export class ObserverQueue {
  constructor(){this.entries=new Map();}
  publish(id,read){
    const running=this.entries.get(id);
    if(running){running.next=read;return new Promise((resolve,reject)=>running.waiters.push({resolve,reject}));}
    const entry={next:null,waiters:[]};this.entries.set(id,entry);
    const work=async()=>{let fn=read,waiters=[];while(fn){let error;try{await fn();}catch(e){error=e;}
      for(const waiter of waiters)error?waiter.reject(error):waiter.resolve();
      if(!entry.next){this.entries.delete(id);if(error)throw error;return;}
      fn=entry.next;entry.next=null;waiters=entry.waiters;entry.waiters=[];
    }};
    entry.promise=work();return entry.promise;
  }
  async drain(){await Promise.allSettled([...this.entries.values()].map(e=>e.promise));}
}
