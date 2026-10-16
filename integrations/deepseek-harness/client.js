// Public DSH browser module format. Dependencies are supplied by the host.
window.__ModuleLoader__.load({
  id: 'agent-team-deepseek-harness',
  factory(require) {
    const {createElement: h, useState, useEffect} = require('react');
    const {Button} = require('@deepseek-ai/dsh-client-ui-primitives');
    const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];
    const panelId = 'agent-team-deepseek-harness/team-workspace';
    const panelKind = 'team-workspace';
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
    function openPanel(ctx, sessionId) {
      if (!ctx.sessions.binding(sessionId) || (ctx.sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0 || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return false;
      ctx.sidebarRight.openTab(panelKind);
      return true;
    }
    const panelStyle = {height:'100%',minHeight:0,boxSizing:'border-box',overflow:'auto',padding:20,color:'var(--dsw-alias-label-primary, inherit)'};
    const mutedStyle = {color:'var(--dsw-alias-label-secondary, #777)',fontSize:12,lineHeight:1.6};
    const sectionStyle = {margin:'24px 0 12px',fontSize:14,fontWeight:600};
    const cardStyle = {padding:'12px 0',borderBottom:'1px solid var(--dsw-alias-border-primary, #8883)',overflowWrap:'anywhere'};
    const labels = {running:'执行中',waiting:'待执行',submitted:'待审查',accepted:'已验收',blocked:'受阻',failed:'失败',stopped:'已停止',stopping:'停止中',archived:'已归档',delivered:'已完成',idle:'空闲',completed:'已完成',unknown:'状态未知'};
    const statusLabel = status => labels[status] ?? status ?? '状态未知';
    function Member({member, useSessionStatus, onOpen}) {
      const running = useSessionStatus(state => state.get(member.id)?.running);
      const status = running === true ? '运行中' : running === false ? '空闲' : member.status ?? member.phase ?? '状态未知';
      return h('li', {style:cardStyle}, h('div', {style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12}},
        h(Button, {size:'sm',type:'button',disabled:member.disabled,onClick:()=>onOpen(member.id),'aria-label':`打开 ${member.name} 的会话`}, member.name),
        h('span', {style:mutedStyle}, statusLabel(status))),
        member.role ? h('div', {style:mutedStyle}, member.role) : null,
        member.error ? h('span', {role:'status',style:mutedStyle}, member.error) : null);
    }
    function TeamWorkspace({sessionId, openPanel}) {
      const [error, setError] = useState('');
      return h('div', null,
        h(Button, {size:'sm',type:'button',onClick:()=>{try{setError(openPanel(sessionId)?'':'当前会话的右侧面板尚未就绪，请稍后重试。');}catch{setError('宿主暂时无法打开团队面板，请稍后重试。');}},'aria-label':'在右侧打开团队工作区'}, '团队工作区'),
        error ? h('span', {role:'alert',style:mutedStyle}, error) : null);
    }
    function TeamPanel({sessionId, useSession, useSessions, useSessionStatus, useTabInfo, openMember, openOwner}) {
      const [error, setError] = useState('');
      const {tab} = useTabInfo();
      const [,tick]=useState(0);useEffect(()=>{if(!tab.visible)return;const timer=setInterval(()=>tick(value=>value+1),1000);return()=>clearInterval(timer);},[tab.visible]);
      const parentId = useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId;
      const values = useSessions(state => state.projectionsBySession[parentId]?.values);
      const team = selectTeam(values,parentId);
      const tasks = (team?.tasks ?? []).filter(task => task.status !== 'cancelled');
      const loading = useSessions(state => state.phase === 'pending');
      const invoke = fn => {try {setError(fn() ? '' : '会话已失效或成员身份未确认，请在当前会话重试。');} catch {setError('宿主暂时无法打开成员会话。');}};
      return h('section', {'data-team-workspace':true,'aria-label':'团队工作区',style:panelStyle},
        h('h2', {style:{margin:'0 0 8px',fontSize:18,fontWeight:600}}, team?.engine ? team.goal : '团队工作区'),
        team?.engine ? h('p', {role:'status',style:mutedStyle}, `${statusLabel(team.state)} · ${team.members?.length??0} 名成员 · ${tasks.filter(task=>task.status==='accepted').length}/${tasks.length} 已验收${team.available?'':' · 状态已过期，导航已禁用'}`) : team ? h('p', {style:mutedStyle}, '官方原生团队视图；当前会话尚未关联 Team Workspace 团队。') : null,
        h('h3', {style:sectionStyle}, '团队成员'),
        loading && !team ? h('p', {role:'status',style:mutedStyle}, '正在读取宿主团队状态…') : !team ? h('p', {style:mutedStyle}, '当前会话尚无团队。可在聊天中描述目标并请求组建团队。') : h('ul', {style:{listStyle:'none',padding:0,margin:0}}, ...(team.members ?? []).map(member => h(Member, {key:member.engineMemberId??member.id,member:{...member,disabled:!team.available||!member.id||(team.engine&&!member.bindingVerified)},useSessionStatus,onOpen:id=>invoke(()=>openMember(sessionId,id))}))),
        h('h3', {style:sectionStyle}, '任务'),
        !tasks.length ? h('p', {style:mutedStyle}, '暂无任务。') : h('ul', {style:{listStyle:'none',padding:0,margin:0}}, ...tasks.map(task => h('li', {key:task.id,style:cardStyle},
          h('details', null, h('summary', {style:{cursor:'pointer',fontWeight:500,lineHeight:1.6}}, `${Number.isInteger(task.number) ? `t${task.number} · ` : ''}${task.subject}`),
            h('p', {style:mutedStyle}, task.description ?? '暂无任务说明。')),
          h('div', {style:{display:'flex',alignItems:'center',gap:8,marginTop:8,flexWrap:'wrap'}},
            h('span', {style:mutedStyle}, statusLabel(task.status)),
            h(Button, {size:'sm',type:'button',disabled:!ownerFor(team,task),onClick:()=>invoke(()=>openOwner(sessionId,task.id)),'aria-label':`打开 ${task.ownerName??'任务负责人'} 的会话`}, task.ownerName ?? '未分配')),
          task.blockedBy?.length ? h('p', {style:mutedStyle}, `等待 ${task.blockedBy.join(', ')}`) : task.ready ? h('p', {style:mutedStyle}, '可开始') : null))),
        error ? h('p', {role:'alert',style:mutedStyle}, error) : null);
    }
    function apply(ctx) {
      const actions = {
        openPanel: sessionId => openPanel(ctx,sessionId),
        openMember: (sessionId, targetId) => navigate(ctx,sessionId,targetId),
        openOwner(sessionId, taskId) {
          const team = projection(ctx.sessions,leaderId(ctx.sessions,sessionId));
          const task = team?.tasks?.find(task=>task.id===taskId), owner = ownerFor(team,task);
          return owner ? navigate(ctx,sessionId,owner.id) : false;
        }
      };
      ctx.effect(() => ctx.sidebarRightTabs.register({id:panelId,kind:panelKind,title:()=> '团队工作区'}));
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name:'sidebar.right.pane.tab',key:panelId,inject:()=>actions}, TeamPanel));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({name:'conversation.session.header.actions',id:'team-workspace',order:-19,inject:()=>actions}, TeamWorkspace));
    }
    return {inject, apply, uniqueOwner, navigate, selectTeam, ownerFor, openPanel, TeamWorkspace, TeamPanel};
  }
});
