import {AsyncLocalStorage} from 'node:async_hooks';

// Deduplicate inside one tool request only. The next request must reauthorize with the host.
export class RequestContext {
  scope=new AsyncLocalStorage();
  constructor(resolve){this.resolve=resolve;}
  run(fn){return this.scope.run(new WeakMap(),fn);}
  project(extra){
    const cache=this.scope.getStore();
    if(!cache||!extra||typeof extra!=='object')return this.resolve(extra?._meta);
    if(!cache.has(extra))cache.set(extra,Promise.resolve().then(()=>this.resolve(extra._meta)));
    return cache.get(extra);
  }
}
