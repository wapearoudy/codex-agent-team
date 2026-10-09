import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DurableStore} from './durable-store.mjs';
import {memberName} from './team-naming.mjs';
import {ownsNativeThread,lastMemberExecution} from './task-context.mjs';

const terminal=new Set(['host-accepted','opened','failed','superseded','expired']);
// The app opens only this verified native conversation through ui/open-link.
// Legacy host-tool requests remain readable, but direct requests contain no prompt.
export class TeamNavigation {
  constructor({root,store,observer,clock=()=>Date.now(),ttlMs=120000}) {
    this.store=store;this.observer=observer;this.clock=clock;this.ttlMs=ttlMs;
    this.document=new DurableStore(join(root,'team-navigation.json'),{requests:{},latest:{}});
  }
  key(owner,teamId){return createHash('sha256').update(JSON.stringify([owner,teamId])).digest('hex');}
  async target(owner,context,args){
    const team=await this.store.get(args.teamId,owner);
    if(team.projectPath!==context.cwd||team.leaderThreadId!==context.threadId||team.mode!=='host-leader')throw new Error('导航仅限当前项目及其原 Leader 的原生成员');
    const member=team.members.find(m=>m.id===args.memberId);
    if(!member)throw new Error('成员尚未绑定固定成员记录');
    const task=args.taskId?team.tasks.find(t=>t.id===args.taskId):null;
    const attempt=args.attemptId?task?.attempts.find(a=>a.id===args.attemptId):task?.attempts.at(-1);
    if(args.taskId&&(!task||(attempt?.memberId??task.memberId)!==member.id))throw new Error('任务轮次与成员不匹配');
    if(args.attemptId&&!attempt)throw new Error('任务轮次不存在');
    if(task&&!attempt?.agentThreadId)throw new Error('任务尚未绑定原生执行会话，请先在面板查看任务详情');
    const threadId=attempt?.agentThreadId??member.agentThreadId;
    if(!ownsNativeThread(team,member.id,threadId))throw new Error('历史轮次不属于当前固定成员及其审计会话');
    if(threadId===member.agentThreadId&&!member.rosterVerified)throw new Error('成员尚未完成原生绑定，不能打开替代会话');
    const marker=attempt?.agentThreadId?attempt.marker:lastMemberExecution(team,member)?.attempt.marker??member.rosterMarker;
    const observed=await this.observer.inspect(team.leaderThreadId,team.projectPath,threadId,marker);
    if(observed.threadId!==threadId||observed.parentThreadId!==team.leaderThreadId)throw new Error('宿主未确认成员父子关系');
    if(attempt?.turnId&&observed.turnId!==attempt.turnId)throw new Error('宿主轮次与任务记录不匹配');
    return {teamId:team.id,memberId:member.id,memberLabel:memberName(team,member),threadId,parentThreadId:team.leaderThreadId,
      taskId:task?.id??null,taskTitle:task?.title??null,attemptId:attempt?.id??null,turnId:attempt?.agentThreadId?observed.turnId:null,
      destination:args.destination??'member',source:'verified-native-member',nativeTurnAnchorSupported:false};
  }
  action(request){return {type:'navigate-native-member',tool:'navigate_to_codex_page',threadId:request.target.destination==='leader'?request.target.parentThreadId:request.target.threadId,returnLeaderThreadId:request.target.parentThreadId,
    note:'只打开已有成员会话，不创建、接续或发送任务。宿主工具没有轮次锚点；任务轮次在团队面板保留。'};}
  directAction(request){const threadId=request.target.destination==='leader'?request.target.parentThreadId:request.target.threadId;
    return {type:'open-native-thread',threadId,url:'codex://threads/'+encodeURIComponent(threadId)};}
  projection(request){const projected=structuredClone(request);if(projected.status==='requested'&&this.clock()>=Date.parse(projected.expiresAt))projected.status='expired';return projected;}
  async request(owner,context,args){
    const transport=args.transport??'host-tool';
    if(!['open-link','host-tool'].includes(transport))throw new Error('未知导航通道');
    const signature=JSON.stringify({teamId:args.teamId,memberId:args.memberId,taskId:args.taskId??null,attemptId:args.attemptId??null,destination:args.destination??'member',...(transport==='open-link'?{transport}:{})});
    const cached=(await this.document.read()).requests[args.requestId];
    if(cached){if(cached.ownerId!==owner||cached.signature!==signature)throw new Error('导航 requestId 不能改变目标');await this.target(owner,context,args);return this.result(this.projection(cached));}
    const target=await this.target(owner,context,args);
    const request=await this.document.transaction(data=>{
      const existing=data.requests[args.requestId];if(existing){if(existing.ownerId!==owner||existing.signature!==signature)throw new Error('导航 requestId 不能改变目标');return existing;}
      const key=this.key(owner,args.teamId),previous=data.requests[data.latest[key]];
      if(previous&&!terminal.has(previous.status)){previous.status='superseded';previous.note='用户选择了新的导航目标';}
      const now=this.clock();const row={id:args.requestId,ownerId:owner,signature,target,transport,status:'requested',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+this.ttlMs).toISOString(),note:''};
      data.requests[row.id]=row;data.latest[key]=row.id;return row;
    });return this.result(this.projection(request));
  }
  result(request){const {ownerId,signature,...safe}=request;
    if(request.transport==='open-link')return {kind:'team-navigation',request:safe,navigationAction:request.status==='requested'?this.directAction(request):null};
    return {kind:'team-navigation',request:safe,leaderAction:request.status==='requested'?this.action(request):null,
    message:`TEAM_WORKSPACE_NAVIGATION:${request.id}\n请读取 Team Workspace 的 read_team_navigation（teamId=${request.target.teamId}, requestId=${request.id}），确认仍是最新有效请求后，用宿主 navigate_to_codex_page 打开返回的 threadId，再用 record_team_navigation 记录 opened 或 failed。只查看已有成员，不启动任务、不发送成员消息。返回团队时打开原 Leader 的团队面板；面板保留所选任务和轮次。`};}
  async read(owner,context,teamId,requestId){
    const data=await this.document.read(),row=data.requests[requestId];
    if(!row||row.ownerId!==owner||row.target.teamId!==teamId)throw new Error('当前会话没有此导航请求');
    await this.target(owner,context,{...row.target,teamId});
    const projected=this.projection(row);if(data.latest[this.key(owner,teamId)]!==requestId&&!terminal.has(projected.status))projected.status='superseded';
    return this.result(projected);
  }
  async record(owner,context,args){
    const result=await this.read(owner,context,args.teamId,args.requestId);
    const direct=result.request.transport==='open-link';
    if(!['host-accepted','opened','failed'].includes(args.status)||(direct&&args.status==='opened')||(!direct&&args.status==='host-accepted'))throw new Error('导航结果与宿主通道不匹配；链接接收不代表会话已打开');
    if(result.request.status!=='requested'){
      if(result.request.status===args.status)return result;
      throw new Error('导航请求已过期、被替换或已结束，不能记录新的结果');
    }
    const row=await this.document.transaction(data=>{
      const r=data.requests[args.requestId];if(data.latest[this.key(owner,args.teamId)]!==r.id||r.status!=='requested'||this.clock()>=Date.parse(r.expiresAt))throw new Error('导航请求不再有效');
      r.status=args.status;r.note=args.note;r.recordedAt=new Date(this.clock()).toISOString();r.source=direct?'app-reported-open-link-result':'leader-recorded-host-navigation-result';return r;
    });return this.result(row);
  }
  async cancel(owner,context,teamId,requestId){
    await this.read(owner,context,teamId,requestId);
    const row=await this.document.transaction(data=>{const r=data.requests[requestId];if(r.status==='requested'){r.status='superseded';r.note='用户离开了原导航目标';}return r;});
    return this.result(row);
  }
}
