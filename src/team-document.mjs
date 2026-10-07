import {readFile,access} from 'node:fs/promises';
import {DurableStore} from './durable-store.mjs';

// The old connection must never overwrite a compact manifest as if it were a
// complete v1 team. v2 has its own authoritative file; the v1 file becomes an
// explicit upgrade fence, with its original bytes kept in the immutable backup.
export class TeamDocument {
  constructor(path,archive,validate){this.file=path;this.v2=path.replace(/\.json$/,'.v2.json');this.archive=archive;this.validate=validate;}
  v2Store(){return new DurableStore(this.v2,{},value=>{if(Object.keys(value).length&&!value.archiveManifest)this.validate(value);});}
  async exists(){try{await access(this.v2);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
  async read(){
    if(await this.exists())return this.v2Store().read();
    const legacy=new DurableStore(this.file,{}),saved=await legacy.read();
    if(saved.requiresTeamWorkspaceVersion){
      // A crash after fencing v1 but before v2 commit is recoverable from the
      // exact backup. It never authorizes starting or retrying a model.
      if(!/^[a-f0-9]{64}$/.test(saved.originalHash??''))throw new Error('Invalid legacy upgrade fence');
      const body=await readFile(this.archive.originalPath(saved.id,saved.originalHash),'utf8');
      if(this.archive.hash(body)!==saved.originalHash)throw new Error('Legacy backup integrity mismatch');
      const original=JSON.parse(body);this.validate(original);return original;
    }
    if(Object.keys(saved).length)this.validate(saved);return saved;
  }
  async transaction(mutator){
    const legacy=new DurableStore(this.file,{}),release=await legacy.lock();
    try{
      let seed;
      if(!(await this.exists())){
        seed=await this.read();
        if(Object.keys(seed).length){
          const original=await readFile(this.file),saved=JSON.parse(original.toString('utf8'));
          // A retry following a fenced-but-uncommitted migration must retain
          // the original backup reference, never back up the fence as a team.
          const backup=saved.requiresTeamWorkspaceVersion?{hash:saved.originalHash}:await this.archive.backupOriginal(seed,original);
          // Under the same v1 lock: fence old readers before committing v2.
          const fence={id:seed.id,ownerId:seed.ownerId,requiresTeamWorkspaceVersion:'0.9.0',originalHash:backup.hash};
          await legacy.commitUnlocked(fence);
        }
      }
      return await this.v2Store().transaction(async data=>{if(!Object.keys(data).length&&seed)Object.assign(data,seed);return mutator(data);});
    }finally{await release();}
  }
}
