import {mkdir,open,readFile,rename,unlink,access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const transactions=new Map();

// Windows readers/scanners can briefly deny atomic replacement. Retry the same
// rename, never delete the destination or rerun the transaction's mutator.
export async function replaceFile(from,to,{renameFile=rename,platform=process.platform,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const delays=[20,50,100,200,400];
  for(let attempt=0;;attempt++){
    try{return await renameFile(from,to);}catch(error){
      if(platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=delays.length)throw error;
      await wait(delays[attempt]);
    }
  }
}

// Every transaction reloads under an exclusive filesystem lock. Invalid data is never reset.
export class DurableStore {
  constructor(file,initial,validate=()=>{},{renameFile=rename}={}) {
    this.file=resolve(file);this.initial=initial;this.validate=validate;this.renameFile=renameFile;
  }
  async read() {
    try {const data=JSON.parse(await readFile(this.file,'utf8'));this.validate(data);return data;}
    catch(e){if(e.code==='ENOENT')return structuredClone(this.initial);throw new Error('Saved data is unreadable; changes are blocked to preserve the original file');}
  }
  async lock({timeoutMs=10000}={}) {
    await mkdir(dirname(this.file),{recursive:true});
    const path=`${this.file}.lock`;
    const deadline=performance.now()+timeoutMs;
    for(;;){
      try {
        try{await access(`${path}.recovery`);throw new Error('Lock recovery is in progress; execution remains paused');}catch(e){if(e.code!=='ENOENT')throw e;}
        const fd=await open(path,'wx');
        try { await fd.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()})); }
        catch(error) { await fd.close(); await unlink(path); throw error; }
        return async()=>{await fd.close();await unlink(path);};
      } catch(e) {
        if(e.code!=='EEXIST')throw e;
        if(await this.recoverDeadLock(path))continue;
        if(performance.now()>=deadline)throw new Error('Saved data is locked by another operation; retry after it finishes');
        // A lock held by an unavailable process is left for explicit recovery. Never steal a live lock.
        await new Promise(r=>setTimeout(r,30));
      }
    }
  }
  async recoverDeadLock(path){
    let record,body;
    try{body=await readFile(path,'utf8');record=JSON.parse(body);}catch{return false;}
    if(!Number.isInteger(record.pid)||record.pid<=0||typeof record.token!=='string')return false;
    try{process.kill(record.pid,0);return false;}catch(e){if(e.code!=='ESRCH')return false;}
    let guard;
    try{guard=await open(`${path}.recovery`,'wx');}catch(e){if(e.code==='EEXIST')return false;throw e;}
    try{
      await guard.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()}));
      if(await readFile(path,'utf8')!==body)return false;
      // An absent owner cannot release its lock. The recovery guard fences new contenders.
      try{process.kill(record.pid,0);return false;}catch(e){if(e.code!=='ESRCH')return false;}
      await rename(path,`${path}.recovered-${randomUUID()}`);
      return true;
    }catch(e){if(e.code==='ENOENT')return false;throw e;}
    finally{await guard.close();await unlink(`${path}.recovery`);}
  }
  async transaction(mutator) {
    // Serialize local contenders before competing for the cross-process lock.
    const previous=transactions.get(this.file)??Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>this.commit(mutator));
    transactions.set(this.file,next);
    try{return await next;}finally{if(transactions.get(this.file)===next)transactions.delete(this.file);}
  }
  async commit(mutator) {
    const release=await this.lock();let tmp;
    try {
      const data=await this.read();const result=await mutator(data);this.validate(data);
      tmp=`${this.file}.${randomUUID()}.tmp`;
      const fd=await open(tmp,'wx');
      try{await fd.writeFile(JSON.stringify(data,null,2));await fd.sync();}finally{await fd.close();}
      await replaceFile(tmp,this.file,{renameFile:this.renameFile});tmp=null;
      return structuredClone(result);
    } finally {
      if(tmp)await unlink(tmp).catch(()=>{});
      await release();
    }
  }
}
