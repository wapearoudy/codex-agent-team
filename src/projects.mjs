import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {DurableStore} from './durable-store.mjs';
import {inspectProject} from './project.mjs';

export class Projects {
  constructor(root=join(homedir(),'.codex','team-workspace')){this.store=new DurableStore(join(root,'projects.json'),{grants:[]},d=>{if(!Array.isArray(d.grants))throw new Error('Invalid projects');});}
  async bindCurrent(owner,context){
    if(context?.source!=='host-thread-metadata'||!context.threadId)throw new Error('Only the current host project can be bound');
    const project=await inspectProject(context.cwd);
    return this.store.transaction(d=>{
      const existing=d.grants.find(g=>g.owner===owner&&g.project.projectId===project.projectId&&g.source==='host-thread-metadata');
      if(existing){existing.project=project;existing.at=context.observedAt;return existing;}
      const grant={id:randomUUID(),owner,project,mode:'project-selected',source:'host-thread-metadata',at:context.observedAt};d.grants.push(grant);return grant;
    });
  }
  async list(owner){return(await this.store.read()).grants.filter(g=>g.owner===owner);}
  async get(owner,id){const g=(await this.list(owner)).find(g=>g.id===id);if(!g)throw new Error('Project selection not found in this conversation');return g;}
  fingerprint(project){return createHash('sha256').update(JSON.stringify(project)).digest('hex');}
}
