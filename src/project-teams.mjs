import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {DurableStore} from './durable-store.mjs';
import {archiveRequest,assertArchivable} from './team-retirement.mjs';
import {verifyQuiescence} from './team-lifecycle.mjs';
import {requireTeamVersion} from './team-version.mjs';
const pathKey=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
export class ProjectTeams {
  constructor(leader){this.leader=leader;this.registry=new DurableStore(join(leader.root,'project-teams.json'),{projects:{}});}
  key(context){return createHash('sha256').update(pathKey(context.cwd)).digest('hex');}
  async candidate(owner,context,data){
    const entry=data.projects[this.key(context)];
    if(entry){if(!entry.teamId)return null;const team=await this.leader.store.get(entry.teamId,entry.ownerId);if(team.state==='archived')return null;if(entry.ownerId!==owner)throw new Error('This project already has a fixed team in another Leader conversation; continue in that conversation before changing its members');return team;}
    const teams=(await this.leader.store.list(owner)).filter(t=>t.mode==='host-leader'&&!['superseded','archived'].includes(t.state)&&pathKey(t.projectPath)===pathKey(context.cwd));
    return teams.find(t=>t.fixedRoster)??teams[0]??null;
  }
  async current(owner,context){return this.candidate(owner,context,await this.registry.read());}
  async archive(owner,context,input){return this.registry.transaction(async data=>{
    const team=await this.leader.store.get(input.teamId,owner);
    if(pathKey(team.projectPath)!==pathKey(context.cwd))throw new Error('团队不属于当前项目，不能归档');
    const request=archiveRequest(team,input),key=this.key(context);
    if(!request.replayed){
      const current=await this.candidate(owner,context,data);
      if(current?.id!==team.id)throw new Error('只有当前团队可以归档');
      if(team.revision!==input.revision)throw new Error('团队已变化，请重新读取并确认归档');
      assertArchivable(team);
      const members=await Promise.all(team.members.filter(m=>m.agentThreadId).map(async member=>{
        const run=await verifyQuiescence(team,member,this.leader.observer);
        if(!run.quiescence?.turnId||!['completed','failed','interrupted'].includes(run.quiescence.status))throw new Error('成员的最新轮次终态尚未确认，不能归档');
        return {memberId:member.id,threadId:member.agentThreadId,...run.quiescence,source:'native-latest-turn'};
      }));
      await this.leader.store.update(team.id,owner,input.revision,t=>{
        assertArchivable(t);t.state='archived';t.dispatchPaused=true;requireTeamVersion(t,'0.16.0');
        t.archival={...request.payload,requestId:input.requestId,hash:request.hash,previousState:'delivered',at:new Date().toISOString(),members};
        t.events.push({at:t.archival.at,type:'team-archived',requestId:input.requestId,source:input.source,reason:request.payload.reason});
      });
    }
    // The team document is the retirement authority. If this index write fails,
    // discovery still excludes the archived team and the same UUID repairs it.
    if(!data.projects[key]||data.projects[key].teamId===team.id)data.projects[key]={teamId:null,archivedTeamId:team.id};
    const saved=await this.leader.store.get(team.id,owner);
    return {kind:'team-archive',teamId:saved.id,revision:saved.revision,archival:saved.archival,replayed:request.replayed};
  });}
  async plan(owner,context,args){return this.registry.transaction(async data=>{
    const existing=await this.candidate(owner,context,data);
    const team=existing??await this.leader.planOnce(owner,context,{...args,initializeMembers:true});
    data.projects[this.key(context)]={teamId:team.id,ownerId:owner,leaderThreadId:team.leaderThreadId};
    return {team,reused:!!existing};
  });}
  async rebuild(owner,context,args){const result=await this.registry.transaction(async data=>{
    data.rebuilds??={};const key=createHash('sha256').update(owner+':'+args.requestId).digest('hex'),hash=createHash('sha256').update(JSON.stringify({cwd:pathKey(context.cwd),goal:args.goal,plan:args.plan,execute:args.execute,maxParallel:args.maxParallel,approvalMode:args.approvalMode,memberStartup:args.memberStartup,executionAuthorization:args.executionAuthorization,policy:args.policy,brief:args.brief})).digest('hex');
    if(data.rebuilds[key]){if(data.rebuilds[key].hash!==hash)throw new Error('Rebuild request ID already has different contents');return {team:await this.leader.store.get(data.rebuilds[key].teamId,owner),reused:false};}
    const existing=await this.candidate(owner,context,data);
    if(existing?.tasks.some(t=>t.status==='running'))throw new Error('Stop and settle all existing native attempts before explicitly rebuilding this project team');
    if(existing)for(const m of existing.members.filter(m=>m.agentThreadId&&m.rosterMarker&&!m.rosterVerified)){const run=await this.leader.observer.inspect(existing.leaderThreadId,existing.projectPath,m.agentThreadId,m.rosterMarker,{allowPending:true});if(!['completed','failed','interrupted'].includes(run.status)||!run.turnId)throw new Error('Stop and verify pending member initialization before rebuilding');}
    const team=await this.leader.planOnce(owner,context,{...args,initializeMembers:true,requestId:args.requestId??randomUUID()});
    data.projects[this.key(context)]={teamId:team.id,ownerId:owner,leaderThreadId:team.leaderThreadId};data.rebuilds[key]={hash,teamId:team.id};return {team,reused:false,previous:existing?{id:existing.id,revision:existing.revision}:null};
  });
    // The registry is authoritative. Archive metadata only after the new index
    // commits; a failed registry write cannot retire the current team.
    if(result.previous&&result.previous.id!==result.team.id)await this.leader.store.update(result.previous.id,owner,result.previous.revision,t=>{t.state='superseded';t.dispatchPaused=true;t.events.push({at:new Date().toISOString(),type:'user-triggered-team-rebuild',replacementTeamId:result.team.id});});
    return {team:result.team,reused:false};
  }
}
