// Public DSH browser module format. Dependencies are supplied by the host.
window.__ModuleLoader__.load({
  id: 'agent-team-deepseek-harness',
  factory(require) {
    const {createElement: h, useState, useEffect} = require('react');
    const inject = ['sessions', 'uiWorkspace', 'slots', 'locale'];
    const leaderId = (sessions, sessionId) => sessions.binding(sessionId)?.session.getSnapshot().subagent?.address.parentSessionId ?? sessionId;
    const fresh = value => value?.source === 'team-workspace-engine' && value.host === 'deepseek-harness' && Date.now() - Date.parse(value.observedAt) >= 0 && Date.now() - Date.parse(value.observedAt) < 20000;
    function selectTeam(values, parentId) {
      const value=values?.teamWorkspace;
      if(value?.team) return {engine:true,available:fresh(value)&&value.sessionId===parentId,...value.team,
        members:value.team.members.map(member=>({...member,engineMemberId:member.id,id:member.nativeSessionId})),
        tasks:value.team.tasks.map(task=>({...task,subject:task.title,ownerName:value.team.members.find(member=>member.id===task.ownerMemberId)?.name}))};
      return values?.agentTeam ? {...values.agentTeam,engine:false,available:true} : null;
    }
    const projection = (sessions, parentId) => selectTeam(sessions.list.getSnapshot().projectionsBySession[parentId]?.values,parentId);
    function uniqueOwner(team, ownerName) {
      if (typeof ownerName !== 'string' || !ownerName) return null;
      const members = (team?.members ?? []).filter(member => member.name === ownerName && typeof member.id === 'string' && member.id);
      return members.length === 1 && (team.members.filter(member => member.id === members[0].id).length === 1) ? members[0] : null;
    }
    function navigate(ctx, sessionId, targetId) {
      if (!ctx.sessions.binding(sessionId) || (ctx.sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return false;
      const parentSessionId = leaderId(ctx.sessions, sessionId);
      const team = projection(ctx.sessions, parentSessionId);
      const members=team?.members?.filter(member => member.id === targetId)??[];
      if (!team?.available || !targetId || members.length !== 1 || (team.engine&&!members[0].bindingVerified)) return false;
      ctx.uiWorkspace.openSession(targetId === parentSessionId ? parentSessionId : {parentSessionId, childSessionId: targetId, mode: 'continuable'});
      return true;
    }
    const ownerFor=(team,task)=>team?.engine ? (team.available ? team.members.find(member=>member.engineMemberId===task?.ownerMemberId&&member.id&&member.bindingVerified) : null) : uniqueOwner(team,task?.ownerName);
    const panelStyle = {position:'absolute',right:0,top:'100%',zIndex:100,width:'min(440px, calc(100vw - 32px))',maxHeight:'70vh',overflow:'auto',padding:16,borderRadius:12,background:'var(--dsw-specific-menu, #202329)',color:'var(--dsw-alias-label-primary, #eee)',boxShadow:'0 8px 32px #0005'};
    function Member({member, useSessionStatus, onOpen}) {
      const running = useSessionStatus(state => state.get(member.id)?.running);
      const status = running === true ? '运行中' : running === false ? '空闲' : member.status ?? member.phase ?? '状态未知';
      return h('li', {style:{marginBottom:8}}, h('button', {type:'button',disabled:member.disabled,onClick:()=>onOpen(member.id)}, member.name), ` · ${member.role ?? ''} · ${status}`, member.error ? h('span', {role:'status'}, ` · ${member.error}`) : null);
    }
    function TeamWorkspace({sessionId, useSession, useSessions, useSessionStatus, openMember, openOwner}) {
      const [open, setOpen] = useState(false), [error, setError] = useState('');
      const [,tick]=useState(0);useEffect(()=>{const timer=setInterval(()=>tick(value=>value+1),1000);return()=>clearInterval(timer);},[]);
      const parentId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId;
      const values = useSessions(state => state.projectionsBySession[parentId]?.values);
      const team = selectTeam(values,parentId);
      const loading = useSessions(state => state.phase === 'pending');
      const invoke = fn => {try {setError(fn() ? '' : '会话已失效或成员身份未确认，请在当前会话重试。');} catch {setError('宿主暂时无法打开成员会话。');}};
      return h('div', {style:{position:'relative'}},
        h('button', {type:'button','aria-expanded':open,'aria-controls':'team-workspace-native',onClick:()=>setOpen(!open)}, `团队工作区${team ? ` (${team.members?.length ?? 0})` : ''}`),
        open ? h('section', {id:'team-workspace-native','aria-label':'团队工作区',style:panelStyle},
          h('h3', null, '成员'),
          team?.engine ? h('p', {role:'status'}, `${team.goal} · ${team.state} · 版本 ${team.revision}${team.available?'':' · 状态已过期，导航已禁用'}`) : h('p', null, '官方原生团队视图；当前会话尚未关联 Team Workspace 团队。'),
          loading && !team ? h('p', {role:'status'}, '正在读取宿主团队状态…') : !team ? h('p', null, '当前会话尚无原生团队。') : h('ul', null, ...(team.members ?? []).map(member => h(Member, {key:member.engineMemberId??member.id,member:{...member,disabled:!team.available||!member.id||(team.engine&&!member.bindingVerified)},useSessionStatus,onOpen:id=>invoke(()=>openMember(sessionId,id))}))),
          h('h3', null, '任务'),
          !(team?.tasks?.length) ? h('p', null, '暂无任务。') : h('ul', null, ...team.tasks.map(task => h('li', {key:task.id,style:{marginBottom:12}},
            h('strong', null, `${Number.isInteger(task.number) ? `t${task.number} · ` : ''}${task.subject}`), ` · ${task.status}`, h('div', null,
              h('button', {type:'button',disabled:!ownerFor(team,task),onClick:()=>invoke(()=>openOwner(sessionId,task.id))}, task.ownerName ?? '未分配'),
              task.blockedBy?.length ? ` · 等待 ${task.blockedBy.join(', ')}` : task.ready ? ' · 可开始' : ''),
            task.description ? h('p', null, task.description) : null))),
          error ? h('p', {role:'alert'}, error) : null) : null);
    }
    function apply(ctx) {
      const actions = {
        openMember: (sessionId, targetId) => navigate(ctx,sessionId,targetId),
        openOwner(sessionId, taskId) {
          const team = projection(ctx.sessions,leaderId(ctx.sessions,sessionId));
          const task = team?.tasks?.find(task=>task.id===taskId), owner = ownerFor(team,task);
          return owner ? navigate(ctx,sessionId,owner.id) : false;
        }
      };
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({name:'conversation.session.header.actions',id:'team-workspace',order:-19,inject:()=>actions}, TeamWorkspace));
    }
    return {inject, apply, uniqueOwner, navigate, selectTeam, ownerFor, TeamWorkspace};
  }
});
