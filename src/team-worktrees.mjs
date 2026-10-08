import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {DurableStore} from './durable-store.mjs';

const run=promisify(execFile);
async function git(cwd,args){return (await run('git',args,{cwd,windowsHide:true,maxBuffer:8*1024*1024})).stdout.trim();}
const clean=async path=>{if(await git(path,['status','--porcelain','--untracked-files=normal']))throw new Error('Commit or preserve current changes before isolated integration');};
export class TeamWorktrees {
  constructor(root){this.root=resolve(root);}
  async prepare(team,memberId) {
    const m=team.members.find(m=>m.id===memberId&&!m.removedAt);if(!m||!m.writeScopes.length)throw new Error('Choose an active writing team member');
    if(team.tasks.some(t=>t.memberId===memberId&&t.status==='running'))throw new Error('The member must be idle before configuring isolation');
    if(m.workspace)return m.workspace;
    const name='team/'+team.id+'/'+memberId,path=resolve(this.root,team.id,memberId),rel=relative(this.root,path);
    if(!rel||isAbsolute(rel)||rel.startsWith('..'))throw new Error('Worktree target is outside plugin storage');
    await mkdir(join(this.root,team.id),{recursive:true});
    const journal=new DurableStore(join(this.root,team.id,memberId+'.prepare.json'),{});
    await journal.transaction(async intent=>{if(intent.base)return;await clean(team.projectPath);Object.assign(intent,{teamId:team.id,memberId,projectPath:team.projectPath,base:await git(team.projectPath,['rev-parse','HEAD']),path,branch:name});});
    return journal.transaction(async intent=>{
      if(intent.teamId!==team.id||intent.memberId!==memberId||intent.projectPath!==team.projectPath||intent.path!==path||intent.branch!==name)throw new Error('Worktree preparation identity changed');
      if(intent.workspace)return (await this.inspect({...team,members:team.members.map(x=>x.id===memberId?{...x,workspace:intent.workspace}:x)},memberId)).workspace;
      let exists=true;try{await realpath(path);}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
      if(!exists){await clean(team.projectPath);await git(team.projectPath,['worktree','add','-b',name,path,intent.base]);}
      const workspace={mode:'git-worktree',path:await realpath(path),branch:name,base:intent.base,preparedAt:new Date().toISOString()};
      await this.inspect({...team,members:team.members.map(x=>x.id===memberId?{...x,workspace}:x)},memberId);
      intent.workspace=workspace;return workspace;
    });
  }
  async inspect(team,memberId) {
    const m=team.members.find(m=>m.id===memberId),w=m?.workspace;if(!w||w.mode!=='git-worktree')throw new Error('Member has no isolated worktree');
    const actual=await realpath(w.path),rel=relative(await realpath(this.root),actual);if(!rel||isAbsolute(rel)||rel.startsWith('..'))throw new Error('Worktree path is outside plugin storage');
    const common=await git(actual,['rev-parse','--path-format=absolute','--git-common-dir']),leaderCommon=await git(team.projectPath,['rev-parse','--path-format=absolute','--git-common-dir']);
    if(await realpath(common)!==await realpath(leaderCommon))throw new Error('Worktree belongs to another repository');
    if(await git(actual,['branch','--show-current'])!==w.branch)throw new Error('Member worktree branch changed');
    return {memberId,workspace:w,head:await git(actual,['rev-parse','HEAD']),dirty:!!(await git(actual,['status','--porcelain'])),changedFiles:(await git(actual,['diff','--name-only',w.base,'HEAD'])).split('\n').filter(Boolean)};
  }
  async integrate(team,memberId) {
    const m=team.members.find(m=>m.id===memberId),rows=team.tasks.filter(t=>t.memberId===memberId&&t.kind!=='review'&&!t.supersededBy);
    if(!rows.length||rows.some(t=>t.status!=='accepted')||team.tasks.some(t=>t.status==='running'))throw new Error('All member deliveries need independent acceptance and every writer must be idle');
    const candidate=await this.inspect(team,memberId);if(candidate.dirty)throw new Error('Commit the accepted candidate in its worktree before integration');
    const submitted=rows.map(t=>t.attempts.at(-1)?.candidate);
    if(submitted.some(c=>!c||c.path!==candidate.workspace.path)||!submitted.some(c=>c.head===candidate.head))throw new Error('Current isolated commit has no independently accepted submission; review it before integration');
    for(const c of submitted)await git(candidate.workspace.path,['merge-base','--is-ancestor',c.head,candidate.head]);
    for(const file of candidate.changedFiles)if(!m.writeScopes.some(scope=>scope==='.'||file===scope||file.startsWith(scope.replace(/\/$/,'')+'/')))throw new Error('Candidate contains a change outside member write scope: '+file);
    const journal=new DurableStore(join(this.root,team.id,memberId+'.integrate-'+candidate.head+'.json'),{});
    await journal.transaction(async intent=>{
      if(intent.before)return;
      await clean(team.projectPath);const before=await git(team.projectPath,['rev-parse','HEAD']);
      // The conflict preflight does not modify the index or work directory.
      const tree=(await git(team.projectPath,['merge-tree','--write-tree',before,candidate.head])).split('\n')[0];
      Object.assign(intent,{teamId:team.id,memberId,projectPath:team.projectPath,before,candidate:candidate.head,tree});
    });
    return journal.transaction(async intent=>{
      if(intent.teamId!==team.id||intent.projectPath!==team.projectPath)throw new Error('Integration identity changed');
      if(intent.receipt)return intent.receipt;
      if(await git(team.projectPath,['rev-parse','HEAD'])!==intent.before)throw new Error('Integration source changed; preserve the journal and inspect before retrying');
      const stagedTree=await git(team.projectPath,['write-tree']);
      if(stagedTree!==intent.tree){await clean(team.projectPath);await git(team.projectPath,['merge','--squash',candidate.head]);}
      if(await git(team.projectPath,['write-tree'])!==intent.tree||await git(team.projectPath,['diff','--name-only']))throw new Error('Integration has unrelated changes; preserve the index and inspect it');
      intent.receipt={memberId,before:intent.before,candidate:candidate.head,status:'staged-for-leader-validation',committed:false,note:'Leader validates the staged integration and commits explicitly.'};
      return intent.receipt;
    });
  }
}
