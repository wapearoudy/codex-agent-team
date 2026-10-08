import {memberExecutions,orderedMembers,memberHasWork,memberWorkSummary,taskRelationships,dependencyFamily,taskDisplayState,runIsActive} from './team-projection.mjs';
import {memberName} from './team-naming.mjs';

const labels={reserved:'待 Leader 派发',observed:'执行记录待更新',waiting:'待执行',running:'工作中',submitted:'待审查',accepted:'已验收',blocked:'阻塞',cancelled:'已取消',planned:'待创建',starting:'关联中',idle:'待命',unknown:'状态未知',completed:'执行已结束',inProgress:'执行中',failed:'执行失败',interrupted:'已中断'};
const storagePrefix='team-workspace:interaction:v1:';
export function setupTeamView(app){
  const $=id=>document.getElementById(id);
  let current=null,linked=false,timer=null,expiryTimer=null,loading=false,lastDiscovery=0,connectionGeneration=0,selectionGeneration=0;
  let detailsRequest=null,detailsWanted=null,polling=null,wakeRequested=false,navigationRead=null,targetTeamId=null;
  let ui={},storageKey='',preview=null,hoverTimer=null,navigation=null,navigationBusy=false,restoring=false,taskNumbers=new Map();
  const label=s=>labels[s]??s;
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,action,cls,key)=>{const b=node('button',text,cls);b.type='button';b.onclick=action;if(key)b.dataset.focusKey=key;return b;};
  const selectedTask=()=>current?.team.tasks.find(t=>t.id===ui.taskId);
  const selectedMember=()=>current?.team.members.find(m=>m.id===ui.memberId);
  const taskState=t=>taskDisplayState(t,current?.runs??[]);
  const pollDelay=()=>document.hidden?10000:current?.runs.some(r=>runIsActive(r)&&current.team.tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId))?250:1000;
  const liveFields=['status','statusEvidence','observedAt','connection','source','attemptIdentitySource','observationError','model','progress','activity','usage'];
  const liveRun=r=>Object.fromEntries(liveFields.filter(k=>r?.[k]!==undefined).map(k=>[k,r[k]]));
  const runSignature=runs=>JSON.stringify(runs.map(r=>[r.taskId,r.attemptId,r.status,r.connection,r.observationError,r.model,runIsActive(r),r.outputs,r.commands,r.progress,r.activity?.cursor,r.usage]));
  const cleanDelivery=s=>String(s??'').replace(/^TEAM_WORKSPACE_ATTEMPT:[^\r\n]+\s*/, '');
  const storeState=()=>{if(!storageKey||restoring)return;try{localStorage.setItem(storageKey,JSON.stringify(ui));}catch{/* storage is optional */}};
  const saveScroll=()=>{if(!current||restoring)return;ui.scrollY=window.scrollY;ui.graphX=$('dependencyGraph').parentElement.scrollLeft;ui.graphY=$('dependencyGraph').parentElement.scrollTop;
    ui.innerScroll=Object.fromEntries([...Object.entries(ui.innerScroll??{}),...[...document.querySelectorAll('[data-scroll-key]')].map(e=>[e.dataset.scrollKey,{x:e.scrollLeft,y:e.scrollTop}])].slice(-200));storeState();};
  async function call(name,args={}){
    const r=await app.callServerTool({name,arguments:args},{timeout:60000});
    if(r.isError)throw new Error(r.content?.find(c=>c.type==='text')?.text??'状态读取失败');
    if(!r.structuredContent)throw new Error('宿主没有返回有效数据');return r.structuredContent;
  }
  function restoreState(team){
    storageKey=storagePrefix+JSON.stringify([team.projectPath,team.leaderThreadId??'',team.id]);
    let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)??'{}')??{};}catch{}
    ui={taskId:typeof saved.taskId==='string'?saved.taskId:null,memberId:typeof saved.memberId==='string'?saved.memberId:null,attemptId:typeof saved.attemptId==='string'?saved.attemptId:null,
      memberView:saved.memberView===true,membersOpen:saved.membersOpen!==false,overviewCollapsed:saved.overviewCollapsed===true,expanded:Array.isArray(saved.expanded)?saved.expanded.filter(k=>typeof k==='string').slice(0,100):[],
      scrollY:Number.isFinite(saved.scrollY)?Math.max(0,saved.scrollY):0,graphX:Number.isFinite(saved.graphX)?Math.max(0,saved.graphX):0,graphY:Number.isFinite(saved.graphY)?Math.max(0,saved.graphY):0,
      innerScroll:Object.fromEntries(Object.entries(saved.innerScroll??{}).filter(([k,v])=>typeof k==='string'&&Number.isFinite(v?.x)&&Number.isFinite(v?.y)).slice(-200)),
      navigationId:typeof saved.navigationId==='string'?saved.navigationId:null,navigationError:typeof saved.navigationError==='string'?saved.navigationError:null,
      query:typeof saved.query==='string'?saved.query.slice(0,200):'',status:typeof saved.status==='string'?saved.status:''};
    $('taskSearch').value=ui.query;$('taskStatusFilter').value=ui.status;
    validateSelection(team);
  }
  function validateSelection(team){
    const task=team.tasks.find(t=>t.id===ui.taskId);if(!task){ui.taskId=null;ui.attemptId=null;}
    if(!team.members.some(m=>m.id===ui.memberId))ui.memberId=null;
    if(task){ui.memberId=task.memberId;if(!task.attempts.some(a=>a.id===ui.attemptId))ui.attemptId=null;}
  }
  function render(){
    if(!current)return;
    const focused=document.activeElement?.dataset?.focusKey,scrollY=ui.scrollY??window.scrollY;
    restoring=true;
    const {team,runs}=current,tasks=team.tasks,active=runs.filter(r=>tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId)&&runIsActive(r));
    taskNumbers=new Map(tasks.map((task,index)=>[task.id,'t'+(task.number??index+1)]));
    const usage=current.usage;$('usageSummary').textContent=usage?'已观察 '+usage.totalTokens.toLocaleString()+' tokens'+(usage.unknownAttempts?' · '+usage.unknownAttempts+' 轮用量未知':'')+(usage.limit?' / 预算 '+usage.limit.toLocaleString():''):'';
    const unknown=tasks.filter(t=>taskState(t)==='unknown');
    $('projectName').textContent=team.projectPath.split(/[\\/]/).filter(Boolean).at(-1)||'Team Workspace';
    $('currentProject').textContent='当前主会话的固定团队 · '+(team.state==='delivered'?'已完成本批验收':'任务与成员执行');
    $('teamGoalText').textContent=team.goal;$('goalDetails').hidden=false;
    $('headerSummary').replaceChildren(node('span',team.members.length+' 名成员'),node('span',tasks.filter(t=>t.status==='accepted').length+'/'+tasks.length+' 已验收'));
    $('captainSummary').textContent='已派发 '+tasks.filter(t=>t.attempts.some(a=>a.agentThreadId)).length+' 项任务';
    $('activeCount').textContent=active.length?active.length+' 人执行中':unknown.length?unknown.length+' 项状态待核对':'当前无执行中的成员';
    $('collapsedSummary').textContent=team.members.length+' 名固定成员 · '+$('activeCount').textContent;
    $('toggleOverview').textContent=ui.overviewCollapsed?'展开团队':'收起面板';$('toggleOverview').setAttribute('aria-expanded',String(!ui.overviewCollapsed));
    $('collapsedSummary').hidden=!ui.overviewCollapsed;$('teamBoard').hidden=!!ui.overviewCollapsed;
    $('emptyState').hidden=true;$('loadingState').hidden=true;
    const prep=team.preparation,omissions=prep?.omissions??prep?.excludedGeneratedLogs??[];
    $('workspacePreparation').textContent=prep?.status==='blocked'?'工作区准备失败：'+prep.message:prep?.issues?.length?'验证限制：'+prep.issues.map(i=>i.path+' — '+i.message).join('；'):current.displayLimits?.preview?'面板显示有限预览'+(current.displayLimits.totalTasks>tasks.length?'（'+tasks.length+'/'+current.displayLimits.totalTasks+' 项任务）':'')+'；完整交付和命令请打开原生成员会话，验收时按任务读取原始证据。':'';
    $('workspaceOmissions').hidden=!omissions.length;$('workspaceOmissions').replaceChildren(node('summary','历史产物筛选记录 · '+omissions.length+' 项'));
    for(const item of omissions)$('workspaceOmissions').append(node('p',item.path+' · '+item.reason));
    $('progressSegments').replaceChildren(...tasks.map(t=>{const b=button('',()=>chooseTask(t.id),'segment '+taskState(t),'progress:'+t.id);b.title=t.id+' '+t.title+' · '+label(taskState(t));b.setAttribute('aria-label',b.title);return b;}));
    $('progressLegend').replaceChildren(...['reserved','waiting','running','starting','observed','unknown','completed','submitted','blocked','failed','interrupted','cancelled','accepted'].filter(s=>s==='accepted'||tasks.some(t=>taskState(t)===s)).map(s=>node('span',label(s)+' '+tasks.filter(t=>taskState(t)===s).length,s)));
    const running=tasks.filter(t=>t.status==='running');$('currentTasks').hidden=!running.length;
    $('currentTasks').textContent=running.map(t=>t.id+' · '+t.title+'（'+label(taskState(t))+'）').join('；');
    const pending=(current.readiness??[]).filter(r=>tasks.find(t=>t.id===r.taskId)?.status==='waiting');
    $('dispatchSummary').hidden=!pending.length&&!team.dispatchPaused;
    $('dispatchSummary').textContent=(team.dispatchPaused?'新任务派发已暂停 · ':'')+pending.filter(r=>r.ready).length+' 项就绪 · '+pending.filter(r=>!r.ready).length+' 项等待前置条件';
    renderMembers();renderGraph();renderDetails();renderMember();syncInspection();renderNavigation();
    for(const d of document.querySelectorAll('details[data-key]'))d.open=ui.expanded.includes(d.dataset.key);
    for(const d of document.querySelectorAll('details[data-key]')){const summary=d.querySelector('summary');if(summary&&!summary.dataset.focusKey)summary.dataset.focusKey='disclosure:'+d.dataset.key;}
    for(const e of document.querySelectorAll('[data-scroll-key]')){const saved=ui.innerScroll?.[e.dataset.scrollKey];if(saved){e.scrollLeft=saved.x;e.scrollTop=saved.y;}}
    const graphScroll=$('dependencyGraph').parentElement;graphScroll.scrollLeft=ui.graphX??0;graphScroll.scrollTop=ui.graphY??0;
    if(focused){const target=[...document.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===focused);target?.focus({preventScroll:true});}
    window.scrollTo({top:scrollY,behavior:'instant'});
    restoring=false;
    $('syncState').textContent='最近同步 '+new Date(current.observedAt).toLocaleTimeString()+' · 公开执行记录快照'+(unknown.length?' · 部分状态待核对':'');
  }
  function chip(task,long=false){
    const b=button(long?task.id+' · '+task.title:taskNumbers.get(task.id),()=>chooseTask(task.id),'chip '+taskState(task)+(ui.taskId===task.id?' selected':''),'chip:'+task.id);
    b.title=taskNumbers.get(task.id)+' · '+task.id+' · '+task.title+' · '+label(taskState(task));b.setAttribute('aria-pressed',String(ui.taskId===task.id));return b;
  }
  function renderMembers(){
    const {team,runs}=current,ordered=orderedMembers(team,runs),visible=ui.membersOpen?ordered:ordered.filter(({member})=>memberHasWork(member,team.tasks)||!team.tasks.some(t=>t.memberId===member.id));
    const hidden=ordered.length-visible.length;
    $('membersHeading').textContent=team.members.length+' 名成员';
    $('toggleMembers').textContent=ui.membersOpen?'收起已结束成员':hidden?'展开已结束 '+hidden+' 名成员':'展开全部';
    $('toggleMembers').setAttribute('aria-expanded',String(ui.membersOpen));$('memberTree').hidden=false;
    $('memberTree').replaceChildren(...visible.map(({member:m,index:i,state})=>{
      const assigned=team.tasks.filter(t=>t.memberId===m.id),item=node('article',undefined,'member'+(state==='running'?' active':''));
      item.dataset.memberId=m.id;item.dataset.selected=String(ui.memberId===m.id);
      const head=node('div',undefined,'member-head'),avatar=node('div',m.role.slice(0,1)||String(i+1),'avatar');avatar.setAttribute('aria-hidden','true');
      const body=node('div',undefined,'member-info'),identity=button(memberName(team,m),()=>chooseMember(m.id),'member-name member-select','member:'+m.id);
      identity.setAttribute('aria-pressed',String(ui.memberId===m.id));body.append(identity,node('span',m.responsibility,'responsibility'));
      const executions=memberExecutions(m,team.tasks,runs),latest=executions.toSorted((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt)).at(-1);
      if(latest?.model){const model=node('span',latest.model,'model-tag');model.title=latest.model;body.append(model);}
      const summary=memberWorkSummary(team,m,runs,current.readiness),status=node('div',undefined,'member-state '+state);
      body.append(node('div',(summary.taskId?summary.taskId+' · ':'')+summary.text,'member-action'));
      status.append(node('div',label(state)),node('div',assigned.filter(t=>t.status==='accepted').length+'/'+assigned.length+' 已验收','member-count'));
      head.append(avatar,body,status);item.append(head);
      const actions=node('div',undefined,'member-actions');
      const open=button('打开原生会话',()=>void requestNavigation(m.id),'subtle-button','open-member:'+m.id);
      open.disabled=!m.agentThreadId||!m.rosterVerified;open.title=open.disabled?'成员尚未完成原生绑定':'通过主会话打开已有 subagent；不会派发任务';
      actions.append(open,button('查看任务与执行',()=>chooseMember(m.id),'subtle-button','view-member:'+m.id));
      const toolbar=node('div',undefined,'member-toolbar'),chips=node('div',undefined,'task-chips');chips.append(node('span','队长派发'),...assigned.map(t=>chip(t)));toolbar.append(chips,actions);item.append(toolbar);
      const history=node('details',undefined,'member-history');history.dataset.key='member:'+m.id;
      const summaryNode=node('summary',executions.length+' 次任务执行 · 查看轮次');summaryNode.dataset.focusKey='history:'+m.id;history.append(summaryNode);
      for(const e of executions.toReversed()){
        const row=button(e.taskId+' · 第 '+e.number+' 轮 · '+label(e.status),()=>chooseTask(e.taskId,e.attemptId,true),'execution-row','attempt:'+e.attemptId);
        row.setAttribute('aria-pressed',String(ui.attemptId===e.attemptId));history.append(row);
      }
      if(executions.length)toolbar.append(history);return item;
    }));
    if(!visible.length)$('memberTree').append(node('p',ui.membersOpen?'团队尚未登记成员':'所有成员本批工作已结束，展开可回看执行记录。','muted'));
  }
  function focusTaskId(){return ui.taskId??preview;}
  function renderGraph(){
    const {team}=current,query=$('taskSearch').value.trim().toLowerCase(),status=$('taskStatusFilter').value;
    const matching=team.tasks.filter(t=>(!status||t.status===status)&&(!query||[t.id,t.title,t.goal,taskNumbers.get(t.id)].some(v=>String(v??'').toLowerCase().includes(query))));
    const tasks=(query||status?matching:team.tasks.length>100?team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).concat(team.tasks.filter(t=>['accepted','cancelled'].includes(t.status)).slice(-60)):matching).slice(-100),byId=new Map(tasks.map(t=>[t.id,t])),ranks=new Map(),rows=new Map(),positions=new Map();
    const cardWidth=160,cardHeight=76,columnStep=186,rowStep=88;
    function rank(id,seen=new Set()){if(ranks.has(id))return ranks.get(id);if(seen.has(id))return 0;seen.add(id);const t=byId.get(id),r=t?.dependencies.length?1+Math.max(...t.dependencies.map(d=>rank(d.taskId,new Set(seen)))):0;ranks.set(id,r);return r;}
    for(const t of tasks){const col=rank(t.id),row=rows.get(col)??0;positions.set(t.id,{x:col*columnStep,y:row*rowStep});rows.set(col,row+1);}
    const focused=focusTaskId(),related=focused?dependencyFamily(tasks,focused):null,graph=$('dependencyGraph'),parallel=tasks.every(t=>!t.dependencies.length);
    $('dependencyTitle').textContent=parallel?'并行任务':'任务依赖';
    $('dependencyHint').textContent=ui.taskId?'已固定 '+ui.taskId+' · 再次点击或 Escape 取消':'悬停预览 · 点击固定 · 前置满足后解锁';
    graph.classList.toggle('parallel',parallel);graph.style.setProperty('--task-node-width',cardWidth+'px');graph.style.setProperty('--task-node-height',cardHeight+'px');
    graph.style.width=parallel?'100%':Math.max(0,...ranks.values())*columnStep+cardWidth+4+'px';graph.style.height=parallel?'auto':(Math.max(1,...rows.values())-1)*rowStep+cardHeight+4+'px';
    graph.replaceChildren();
    if(!parallel){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',graph.style.width);svg.setAttribute('height',graph.style.height);svg.setAttribute('aria-hidden','true');
      for(const t of tasks)for(const d of t.dependencies){const from=positions.get(d.taskId),to=positions.get(t.id);if(!from||!to)continue;
        const path=document.createElementNS(svg.namespaceURI,'path'),x=from.x+cardWidth,y=from.y+cardHeight/2,targetY=to.y+cardHeight/2;path.setAttribute('d','M '+x+' '+y+' C '+(x+13)+' '+y+', '+(to.x-13)+' '+targetY+', '+to.x+' '+targetY);
        path.dataset.from=d.taskId;path.dataset.to=t.id;path.dataset.dimmed=String(!!related&&!(related.has(t.id)&&related.has(d.taskId)));svg.append(path);
      }graph.append(svg);
    }
    for(const t of tasks){const p=positions.get(t.id),b=button('',()=>chooseTask(t.id),'dependency-node '+taskState(t),'graph:'+t.id);b.dataset.taskId=t.id;
      if(!parallel){b.style.left=p.x+'px';b.style.top=p.y+'px';}
      const h=node('div',undefined,'node-heading'),owner=team.members.find(m=>m.id===t.memberId),ownerLabel=owner?memberName(team,owner):t.memberId,ownerNode=node('span',ownerLabel);ownerNode.title=ownerLabel;h.append(node('strong',taskNumbers.get(t.id)),ownerNode);b.append(h,node('div',t.title,'node-title'),node('small',label(taskState(t)),'node-status'));
      b.title=taskNumbers.get(t.id)+' · '+t.id+' · '+t.title+' · '+label(taskState(t));b.setAttribute('aria-pressed',String(t.id===ui.taskId));
      b.dataset.selected=String(t.id===ui.taskId);b.dataset.related=String(!!related&&related.has(t.id));b.dataset.dimmed=String(!!related&&!related.has(t.id));
      b.onmouseenter=()=>schedulePreview(t.id);b.onmouseleave=()=>schedulePreview(null);b.onfocus=()=>previewTask(t.id);b.onblur=()=>previewTask(null);graph.append(b);
    }
    if(!tasks.length)graph.append(node('p','没有符合条件的任务。','muted'));
    if(matching.length>tasks.length)$('dependencyHint').textContent+=' · 显示 '+tasks.length+'/'+matching.length+' 项，可按任务号查找';
  }
  function updateGraphFocus(){
    const focused=focusTaskId(),related=focused?dependencyFamily(current.team.tasks,focused):null;
    for(const b of $('dependencyGraph').querySelectorAll('[data-task-id]')){b.dataset.related=String(!!related&&related.has(b.dataset.taskId));b.dataset.dimmed=String(!!related&&!related.has(b.dataset.taskId));}
    for(const path of $('dependencyGraph').querySelectorAll('path'))path.dataset.dimmed=String(!!related&&!(related.has(path.dataset.to)&&related.has(path.dataset.from)));
    renderDetails();syncInspection();
  }
  function syncInspection(){
    const visible=!$('taskDetail').hidden||!$('memberDetail').hidden,previewing=!!preview&&!ui.taskId&&!ui.memberView;
    $('selectionPanel').hidden=!visible;$('selectionPanel').classList.toggle('is-preview',previewing);
    $('workspaceContent').classList.toggle('has-selection',visible&&!previewing);
  }
  function previewTask(id){if(!current||restoring||preview===id)return;preview=id;updateGraphFocus();}
  function schedulePreview(id){clearTimeout(hoverTimer);if(id===null)previewTask(null);else hoverTimer=setTimeout(()=>previewTask(id),180);}
  function clearNavigation(){
    const id=ui.navigationId,teamId=current?.team.id;ui.navigationId=null;ui.navigationError=null;navigation=null;navigationBusy=false;selectionGeneration++;
    if(id&&teamId)void call('cancel_team_navigation',{teamId,requestId:id}).catch(()=>{});
  }
  function chooseTask(id,attemptId=null,memberView=false){
    const task=current?.team.tasks.find(t=>t.id===id);if(!task)return;clearNavigation();
    const unpin=ui.taskId===id&&!attemptId&&!memberView;ui.taskId=unpin?null:id;ui.attemptId=unpin?null:attemptId;ui.memberId=unpin?null:task.memberId;
    ui.memberView=memberView;preview=null;ui.overviewCollapsed=false;storeState();render();
  }
  function chooseMember(id){
    if(!current?.team.members.some(m=>m.id===id))return;clearNavigation();ui.memberId=id;ui.memberView=true;ui.overviewCollapsed=false;
    if(selectedTask()?.memberId!==id){ui.taskId=null;ui.attemptId=null;}ui.membersOpen=true;storeState();render();
    $('memberDetail').scrollIntoView({block:'start',behavior:'instant'});saveScroll();
  }
  function locateMember(id){
    ui.membersOpen=true;ui.memberId=id;storeState();render();
    const target=[...$('memberTree').querySelectorAll('[data-member-id]')].find(e=>e.dataset.memberId===id);
    target?.scrollIntoView({block:'nearest',behavior:'instant'});target?.querySelector('button')?.focus({preventScroll:true});saveScroll();
  }
  function renderDetails(){
    const task=current.team.tasks.find(t=>t.id===focusTaskId()),box=$('taskDetail');box.hidden=!task;box.replaceChildren();if(!task)return;
    const member=current.team.members.find(m=>m.id===task.memberId),attempt=task.attempts.find(a=>a.id===ui.attemptId)??task.attempts.at(-1),relationship=taskRelationships(current.team,task);
    const head=node('div',undefined,'detail-heading');head.append(node('h2',task.id+' · '+task.title),node('span',label(taskState(task)),'status-pill '+taskState(task)));box.append(head);
    const actions=node('div',undefined,'detail-actions');actions.append(button('定位负责人 · '+memberName(current.team,member),()=>locateMember(member.id),'subtle-button','locate:'+task.id),button('查看成员执行',()=>{ui.taskId=task.id;chooseMember(member.id);},'subtle-button','member-detail:'+task.id));
    const open=button('打开对应 subagent',()=>void requestNavigation(member.id,task.id,attempt?.id),'subtle-button','task-open:'+task.id);open.disabled=!member.agentThreadId||!member.rosterVerified;actions.append(open);if(ui.taskId)box.append(actions);
    const dl=node('dl'),field=(name,value)=>dl.append(node('dt',name),node('dd',value));field('负责人',memberName(current.team,member));field('目标',task.goal);field('验收',task.acceptance);
    field('前置',task.dependencies.map(d=>d.taskId+' '+(d.when==='accepted'?'验收后':'提交后')).join('；')||'无，可并行执行');
    field('等待条件',relationship.waiting.length?relationship.waiting.map(d=>d.taskId+' · '+d.memberLabel+' · 等待'+(d.when==='accepted'?'验收':'提交')).join('；'):'前置已满足');
    field('完成后解锁',relationship.downstream.map(d=>d.id+' · '+d.memberLabel+'（'+(d.when==='accepted'?'验收后':'提交后')+'）').join('；')||'无后续依赖');
    if(task.blockReason)field('阻塞原因',task.blockReason);
    const readiness=current.readiness?.find(r=>r.taskId===task.id);if(task.status==='waiting')field('派发条件',readiness?.blockers.length?readiness.blockers.map(r=>r.message).join('；'):'已就绪，等待 Leader 派发');
    for(const criterion of task.acceptanceCriteria??[])field(criterion.id,criterion.description);
    box.append(dl);
    if(task.status==='submitted')box.append(node('p','成员已经交付；独立审查和 Leader 验收尚未完成。','muted'));
    if(attempt)box.append(node('p','所选执行：第 '+attempt.number+' 轮'+(attempt.id===task.attempts.at(-1)?.id?' · 当前轮次':' · 历史轮次'),'muted'));
    for(const e of task.evidence){const el=node('div',undefined,'evidence');el.append(node('small','第 '+e.attempt+' 轮交付'),node('p',cleanDelivery(e.summary)));box.append(el);}
    for(const cp of (current.checkpoints??[]).filter(c=>c.taskId===task.id).slice(-3).reverse()){
      const el=node('section',undefined,'evidence');el.append(node('small','进度检查点 · Leader 记录'+(cp.stale?' · 历史轮次，需重新核对':'')),node('p',cp.summary));
      for(const [title,values] of [['已定事项',cp.decisions],['剩余工作',cp.remainingWork],['证据',cp.evidence]])if(values?.length){el.append(node('strong',title));const list=node('ul');for(const value of values)list.append(node('li',value));el.append(list);}
      for(const check of cp.validation??[])el.append(node('p',check.status+' · '+check.name+'：'+check.evidence));box.append(el);
    }
    const deliveryLabels={'queued':'待 Leader 发送 · 重试前先核对','host-accepted':'宿主已接收 · Leader 记录','unknown':'送达未知 · 不自动重发','failed':'发送失败','acknowledged':'成员公开确认'};
    for(const message of (current.messages??[]).filter(m=>m.taskId===task.id)){const el=node('div',undefined,'evidence');el.append(node('small',(deliveryLabels[message.status]??message.status)+(message.stale?' · 历史轮次':'')),node('p',message.text));box.append(el);}
    for(const r of current.runs.filter(r=>r.taskId===task.id))for(const message of r.messages??[]){const el=node('div',undefined,'evidence');el.append(node('small',message.delivery==='accepted-by-runtime'?'执行端已接收 · 是否已读未知':'送达未确认'),node('p',message.text));box.append(el);}
    const raw=node('details');raw.dataset.key='task:'+task.id;raw.append(node('summary',current.displayLimits?.preview?'执行标识与公开证据预览':'执行标识与原始公开证据'));
    const populate=()=>{if(raw.open&&!raw.querySelector('pre'))raw.append(node('pre',JSON.stringify({attempts:task.attempts,evidence:task.evidence,runs:current.runs.filter(r=>r.taskId===task.id)},null,2)));};raw.addEventListener('toggle',populate);box.append(raw);
    raw.open=ui.expanded.includes(raw.dataset.key);
    populate();
  }
  function renderMember(){
    const member=selectedMember(),box=$('memberDetail');box.hidden=!member||!ui.memberView;box.replaceChildren();if(box.hidden)return;
    const head=node('div',undefined,'detail-heading');head.append(node('h2',memberName(current.team,member)+' · subagent 执行'),button('返回团队',()=>{ui.memberView=false;storeState();render();locateMember(member.id);},'subtle-button','back-team'));box.append(head);
    const tasks=current.team.tasks.filter(t=>t.memberId===member.id),chips=node('div',undefined,'member-task-list');chips.append(...tasks.map(t=>chip(t,true)));box.append(chips);
    const executions=memberExecutions(member,current.team.tasks,current.runs).toReversed(),attempt=executions.find(e=>e.attemptId===ui.attemptId)??executions.find(e=>e.taskId===ui.taskId)??executions[0];
    const list=node('div',undefined,'execution-tabs');list.setAttribute('role','group');list.setAttribute('aria-label','成员任务轮次');
    for(const e of executions){const b=button(e.taskId+' · 第 '+e.number+' 轮',()=>chooseTask(e.taskId,e.attemptId,true),'subtle-button','execution-tab:'+e.attemptId);b.setAttribute('aria-pressed',String(attempt?.attemptId===e.attemptId));list.append(b);}box.append(list);
    const run=current.runs.find(r=>r.attemptId===attempt?.attemptId&&r.memberId===member.id);
    if(attempt){box.append(node('p',attempt.taskId+' · 第 '+attempt.number+' 轮 · '+label(attempt.status),'member-action'));
      if(run?.model)box.append(node('span',run.model,'model-tag'));
      if(run?.usage)box.append(node('small','本轮已观察 '+run.usage.totalTokens+' tokens','muted'));
      if(run?.progress?.length||run?.activity?.events?.length){const live=node('div',undefined,'live-events');live.dataset.scrollKey='live:'+attempt.attemptId;live.append(node('strong','当前轮次 · 公开执行进度'));
        for(const p of run.progress??[])live.append(node('p',cleanDelivery(p.text)));
        for(const e of (run.activity?.events??[]).slice(-12)){if(e.command)live.append(node('pre',e.command));if(e.text)live.append(node('pre',e.text));if(e.type==='file_change')live.append(node('small','文件：'+e.paths.join('、')));}
        box.append(live);
      }
      for(const [index,output] of (run?.outputs??[]).entries()){const el=node('div',cleanDelivery(output.text),'public-output');el.dataset.scrollKey='output:'+attempt.attemptId+':'+index;box.append(el);}
      if(!run?.outputs?.length)box.append(node('p',attempt.active?'正在执行，尚未提交最终结果。':'当前轮次没有可读取的公开最终输出。','muted'));
      const commands=node('details');commands.dataset.key='commands:'+attempt.attemptId;commands.append(node('summary','公开命令记录 · '+(run?.commands?.length??0)));
      for(const command of run?.commands??[]){const line=node('div',undefined,'command-record');line.append(node('small',label(command.status)+' · 退出码 '+(command.exitCode??'未结束')),node('pre',command.command));if(command.output)line.append(node('pre',command.output));commands.append(line);}box.append(commands);
    }else box.append(node('p',!member.agentThreadId?'岗位已登记，等待 Leader 创建并绑定原生成员。':member.rosterVerified===false?'成员正在初始化，完成后可接收任务。':'成员已初始化，尚未执行任务。','muted'));
    const actions=node('div',undefined,'detail-actions');const open=button('打开原生 subagent 会话',()=>void requestNavigation(member.id,attempt?.taskId,attempt?.attemptId),'subtle-button','member-native');
    open.disabled=!member.agentThreadId||!member.rosterVerified;actions.append(open,button('返回主会话',()=>void requestNavigation(member.id,attempt?.taskId,attempt?.attemptId,'leader'),'subtle-button','leader-native'));box.append(actions);
    box.append(node('p','这里按任务轮次展示公开结果。原生会话由宿主打开，宿主暂不支持定位到指定轮次。','muted'));
  }
  function renderNavigation(){
    const box=$('navigationState');box.replaceChildren();box.hidden=!navigation&&!navigationBusy;if(box.hidden)return;
    box.setAttribute('role',navigation?.error?'alert':'status');
    const texts={requested:'导航请求已发送，等待主会话打开',opened:'宿主导航工具已确认打开会话',failed:'导航失败',superseded:'已选择新的导航目标',expired:'导航请求已过期'};
    box.append(node('span',navigationBusy?'正在核对原生成员…':navigation?.error??texts[navigation?.request?.status]??'等待宿主导航回执'));
    if(navigation?.request?.status==='opened')box.append(node('small','任务和轮次已保留；此回执不代表宿主定位到了该轮次。'));
    if(navigation?.error||['failed','expired'].includes(navigation?.request?.status))box.append(button('重试导航',()=>void requestNavigation(...navigation.args),'subtle-button','retry-navigation'));
  }
  async function requestNavigation(memberId,taskId,attemptId,destination='member'){
    const member=current?.team.members.find(m=>m.id===memberId);if(!member)return;
    if(navigationBusy)return;
    const teamId=current.team.id,generation=connectionGeneration,selection=selectionGeneration,args=[memberId,taskId,attemptId,destination];
    const valid=()=>generation===connectionGeneration&&selection===selectionGeneration&&current?.team.id===teamId;
    navigationBusy=true;navigation={args};renderNavigation();
    try{
      if(typeof app.sendMessage!=='function'||(app.getHostCapabilities&&!app.getHostCapabilities()?.message))throw new Error('当前宿主未提供会话导航消息通道，仍可在这里查看成员执行。');
      const data=await call('request_team_navigation',{teamId,memberId,...(taskId?{taskId}:{}),...(attemptId?{attemptId}:{}),destination,requestId:crypto.randomUUID()});
      if(!valid())return;
      navigation={...data,args};ui.navigationId=data.request.id;ui.navigationError=null;storeState();
      if(data.request.status!=='requested')throw new Error('导航请求不再有效，请重新选择成员');
      const sent=await app.sendMessage({role:'user',content:[{type:'text',text:data.message}]});
      if(!valid())return;if(sent?.isError)throw new Error('宿主拒绝导航请求，请重试。');
    }catch(e){if(valid()){navigation={...(navigation??{}),args,error:e.message};ui.navigationError=e.message;storeState();}}
    finally{if(valid()){navigationBusy=false;renderNavigation();}}
  }
  async function refreshNavigation(generation){
    if(!ui.navigationId||navigationBusy||navigationRead)return;
    const read={generation};navigationRead=read;
    const id=ui.navigationId,teamId=current?.team.id,selection=selectionGeneration;
    try{const data=await call('read_team_navigation',{teamId,requestId:id});
      if(generation!==connectionGeneration||current?.team.id!==teamId||ui.navigationId!==id||selection!==selectionGeneration)return;
      const args=navigation?.args??[data.request.target.memberId,data.request.target.taskId,data.request.target.attemptId,data.request.target.destination];
      if(['opened','failed','expired'].includes(data.request.status))ui.navigationError=null;
      navigation={...data,args,...(ui.navigationError?{error:ui.navigationError}:{})};storeState();renderNavigation();
    }catch{/* Preserve user-visible navigation errors; team polling has its own health. */}
    finally{if(navigationRead===read)navigationRead=null;}
  }
  function loseLiveStatus(message){if(current){current={...current,runs:current.runs.map(r=>['inProgress','starting'].includes(r.status)?{...r,status:'unknown',connection:'unavailable'}:r)};render();}$('syncState').textContent=message;}
  function expireActivity(){if(current?.runs.some(r=>r.status==='inProgress'&&r.statusEvidence?.freshUntil&&Date.parse(r.statusEvidence.freshUntil)<=Date.now())){current={...current,runs:current.runs.map(r=>r.status==='inProgress'&&r.statusEvidence?.freshUntil&&Date.parse(r.statusEvidence.freshUntil)<=Date.now()?{...r,status:'unknown'}:r)};render();}}
  function errorState(message){$('errorState').hidden=false;$('errorText').textContent=message;$('loadingState').hidden=true;}
  function requestDetails(data){
    targetTeamId=data.team.id;
    const target={teamId:data.team.id,revision:data.team.revision,detailToken:data.detailToken,generation:connectionGeneration};
    target.key=JSON.stringify([target.generation,target.teamId,target.revision,target.detailToken]);
    if(detailsRequest?.key===target.key)return;
    detailsWanted=target;pumpDetails();
  }
  function pumpDetails(){
    if(detailsRequest||!detailsWanted)return;
    const request=detailsWanted;detailsWanted=null;detailsRequest=request;
    void (async()=>{
      try{
        const data=await call('read_team',{teamId:request.teamId,view:'panel',...(request.detailToken?{detailToken:request.detailToken}:{})});
        if(request.generation===connectionGeneration&&targetTeamId===request.teamId)await accept(data);
      }catch(e){if(request.generation===connectionGeneration&&targetTeamId===request.teamId)errorState('详情同步失败：'+e.message+'；已收到的状态仍保留。');}
      finally{
        if(detailsRequest!==request)return;
        detailsRequest=null;
        if(detailsWanted&&(detailsWanted.generation!==connectionGeneration||(detailsWanted.teamId===current?.team.id&&(detailsWanted.revision<current.team.revision||detailsWanted.detailToken===current.detailToken))))detailsWanted=null;
        pumpDetails();
      }
    })();
  }
  function applyState(data){
    if(!current||current.team.id!==data.team.id)return;
    const before=current,oldTasks=new Map(current.team.tasks.map(t=>[t.id,t])),oldMembers=new Map(current.team.members.map(m=>[m.id,m]));
    const tasks=data.team.tasks?.map(({attempt,...fields})=>{
      const old=oldTasks.get(fields.id)??{goal:'详情同步中',acceptance:'详情同步中',dependencies:[],attempts:[],evidence:[]};
      const attempts=old.attempts.map(a=>a.id===attempt?.id?{...a,...attempt}:a);
      if(attempt&&!attempts.some(a=>a.id===attempt.id))attempts.push({...attempt});
      return {...old,...fields,attempts,...(attempt?.number?{attempt:attempt.number}:{})};
    })??current.team.tasks;
    const team={...current.team,...data.team,tasks,members:data.team.members?.map(m=>({responsibility:'',writeScopes:[],...oldMembers.get(m.id),...m}))??current.team.members};
    if(team.state!=='delivered')delete team.finalAcceptance;
    const updates=new Map(data.runs.map(r=>[JSON.stringify([r.taskId,r.attemptId]),r]));
    const runs=current.runs.map(r=>{const key=JSON.stringify([r.taskId,r.attemptId]),update=updates.get(key);updates.delete(key);return {...r,...update};});runs.push(...updates.values());
    const stale=row=>team.tasks.find(t=>t.id===row.taskId)?.attempts.at(-1)?.id!==row.attemptId;
    current={...current,team,runs,usage:data.usage??current.usage,workflow:data.workflow??current.workflow,readiness:data.readiness??current.readiness,observedAt:data.observedAt,observationMode:data.observationMode,latestStateAt:Math.max(current.latestStateAt??0,Date.parse(data.observedAt)||0),
      messages:current.messages?.map(m=>({...m,stale:stale(m)})),checkpoints:current.checkpoints?.map(c=>({...c,stale:stale(c)}))};
    validateSelection(team);
    if(before.team.revision!==team.revision||runSignature(before.runs)!==runSignature(runs)||JSON.stringify(before.usage)!==JSON.stringify(current.usage))render();
  }
  async function accept(data){
    if(!data)return;const generation=connectionGeneration;
    if(data.kind==='team-navigation'){if(data.request?.id===ui.navigationId){navigation={...data,args:navigation?.args};renderNavigation();}return;}
    if(data.kind==='team-workspace'){
      lastDiscovery=Date.now();$('projectName').textContent=data.context.cwd.split(/[\\/]/).filter(Boolean).at(-1);
      const teams=data.teams??[];$('teamSwitcher').hidden=true;
      targetTeamId=teams[0]?.id??null;
      if(teams[0]){const detail=await call('read_team',{teamId:teams[0].id,view:current?.team.id===teams[0].id?'state':'panel'});if(generation===connectionGeneration)await accept(detail);}
      else{clearNavigation();renderNavigation();current=null;$('goalDetails').hidden=true;$('teamBoard').hidden=true;$('emptyState').hidden=false;$('loadingState').hidden=true;$('collapsedSummary').hidden=true;}
    }
    if(['team-update','team-summary','team-state'].includes(data.kind)){
      if(current?.team.id===data.team.id&&data.team.revision<current.team.revision)return;
      if(data.kind==='team-state'){
        if(targetTeamId&&targetTeamId!==data.team.id)return;
        if(current?.team.id===data.team.id&&current.team.revision===data.team.revision&&(Date.parse(data.observedAt)||0)<(current.latestStateAt??0))return;
        applyState(data);
      }
      const pending=data.kind!=='team-state'||current?.team.id!==data.team.id||!current?.detailToken||current.detailToken!==data.detailToken;
      if(pending)requestDetails(data);
      $('errorState').hidden=true;$('syncState').textContent=pending?'状态已更新，详情同步中…':'最近成功同步 '+new Date(data.observedAt).toLocaleTimeString()+' · 宿主公开执行记录快照';return;
    }
    if(data.kind==='team-detail'){
      if(current?.team.id===data.team.id&&data.team.revision<current.team.revision)return;
      targetTeamId=data.team.id;
      const changedTeam=current?.team.id!==data.team.id;
      let runs=data.runs??[];
      if(!changedTeam&&current.team.revision===data.team.revision&&(current.latestStateAt??0)>0&&current.latestStateAt>=(Date.parse(data.observedAt)||0))runs=runs.map(r=>({...r,...liveRun(current.runs.find(old=>old.taskId===r.taskId&&old.attemptId===r.attemptId))}));
      const same=!changedTeam&&current.team.revision===data.team.revision&&current.detailToken===data.detailToken&&runSignature(current.runs)===runSignature(runs);
      if(changedTeam){restoreState(data.team);preview=null;navigation=null;selectionGeneration++;}else validateSelection(data.team);
      current={...data,runs,latestStateAt:Math.max(changedTeam?0:current?.latestStateAt??0,Date.parse(data.observedAt)||0)};
      if(!same)render();$('errorState').hidden=true;$('loadingState').hidden=true;
      $('syncState').textContent='最近成功同步 '+new Date(data.observedAt).toLocaleTimeString()+' · 宿主公开执行记录快照';
    }
  }
  async function poll(){
    if(!linked)return;if(polling){wakeRequested=true;return;}
    const generation=connectionGeneration,request={generation},started=performance.now();polling=request;clearTimeout(timer);
    try{if(!loading){const id=current?.team.id;const data=(!current||Date.now()-lastDiscovery>30000)?await call('open_team_workspace'):await call('read_team',{teamId:id,view:'state'});
      if(linked&&generation===connectionGeneration&&(!id||current?.team.id===id))await accept(data);if(linked&&generation===connectionGeneration)void refreshNavigation(generation);}}
    catch(e){if(linked&&generation===connectionGeneration){loseLiveStatus('同步中断，执行状态待核对。');errorState('同步中断：'+e.message);}}
    if(polling===request)polling=null;
    if(linked&&generation===connectionGeneration){const delay=wakeRequested?0:Math.max(0,pollDelay()-(performance.now()-started));wakeRequested=false;timer=setTimeout(poll,delay);}
  }
  async function reconnect(){
    if(loading)return;loading=true;linked=true;navigationBusy=false;clearTimeout(timer);
    const generation=++connectionGeneration;polling=null;detailsRequest=null;detailsWanted=null;navigationRead=null;wakeRequested=false;clearInterval(expiryTimer);expiryTimer=setInterval(expireActivity,1000);$('retryConnection').disabled=true;
    try{const data=await call('open_team_workspace');if(generation===connectionGeneration){await accept(data);$('errorState').hidden=true;}}
    catch(e){if(generation===connectionGeneration)errorState(e.message);}
    finally{loading=false;$('retryConnection').disabled=false;if(linked&&generation===connectionGeneration)timer=setTimeout(poll,pollDelay());}
  }
  const onToggle=e=>{const d=e.target;if(!d?.isConnected||!d?.dataset?.key||restoring)return;const set=new Set(ui.expanded);if(d.open)set.add(d.dataset.key);else set.delete(d.dataset.key);ui.expanded=[...set];storeState();};
  const onKey=e=>{if(e.key!=='Escape'||!current)return;clearTimeout(hoverTimer);preview=null;ui.taskId=null;ui.attemptId=null;ui.memberId=null;ui.memberView=false;clearNavigation();storeState();render();};
  const onInnerScroll=e=>{if(e.target?.dataset?.scrollKey)saveScroll();};
  const onVisible=()=>{if(!linked||document.hidden)return;clearTimeout(timer);if(loading)wakeRequested=true;else void poll();};
  window.addEventListener('scroll',saveScroll,{passive:true});$('dependencyGraph').parentElement.addEventListener('scroll',saveScroll,{passive:true});
  document.addEventListener('toggle',onToggle,true);document.addEventListener('keydown',onKey);
  document.addEventListener('scroll',onInnerScroll,true);
  document.addEventListener('visibilitychange',onVisible);window.addEventListener('focus',onVisible);
  $('toggleMembers').onclick=()=>{ui.membersOpen=!ui.membersOpen;storeState();render();};
  $('toggleOverview').onclick=()=>{ui.overviewCollapsed=!ui.overviewCollapsed;storeState();render();};
  $('retryConnection').onclick=()=>void reconnect();$('refreshTeam').onclick=()=>void reconnect();
  $('taskSearch').oninput=()=>{ui.query=$('taskSearch').value;storeState();if(current)renderGraph();};$('taskStatusFilter').onchange=()=>{ui.status=$('taskStatusFilter').value;storeState();if(current)renderGraph();};
  let report=null;
  async function showRecord(name,args={}){if(!current)return;const id=current.team.id,generation=connectionGeneration;try{const data=await call(name,{teamId:id,...args});if(id!==current?.team.id||generation!==connectionGeneration)return;const box=$('recordOutput');$('teamRecords').open=true;
    if(data.kind==='team-export'){report=data;box.textContent=data.text;$('downloadReport').hidden=false;}
    else if(data.kind==='team-recovery')box.textContent=data.members.map(m=>memberName(current.team,current.team.members.find(x=>x.id===m.memberId))+'：'+label(m.status)+' · '+(m.control?.status==='available'?'原生控制已核对':'原生控制待核对')).join('\n')+'\n插件不会自动恢复模型轮次；请在原主会话核对现有成员的控制能力。';
    else box.textContent=JSON.stringify(data,null,2);
  }catch(error){$('feedback').textContent='记录读取失败：'+error.message;}}
  $('exportReport').onclick=()=>void showRecord('export_team_report');
  $('showRecovery').onclick=()=>void showRecord('read_team_recovery');
  $('showDiagnostics').onclick=()=>{if(current){$('teamRecords').open=true;$('recordOutput').textContent=(current.diagnostics?.stages??[]).map(s=>s.taskId+' · 预留到绑定 '+(s.reservationToBindMs??'未知')+' ms · 执行 '+(s.executionMs??'未知')+' ms').join('\n')||'尚无可计算的执行时间记录。';}};
  $('downloadReport').onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([report.text],{type:report.mimeType})),a=document.createElement('a');a.href=url;a.download=report.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return {accept,connect:async()=>{linked=true;const generation=++connectionGeneration;polling=null;detailsRequest=null;detailsWanted=null;navigationRead=null;wakeRequested=false;clearInterval(expiryTimer);expiryTimer=setInterval(expireActivity,1000);$('loadingState').hidden=!current;$('emptyState').hidden=true;
    try{const data=await call('open_team_workspace');if(linked&&generation===connectionGeneration)await accept(data);}
    catch(e){if(linked&&generation===connectionGeneration)errorState(e.message);}
    if(linked&&generation===connectionGeneration)void poll();
  },disconnect:()=>{linked=false;connectionGeneration++;selectionGeneration++;navigationBusy=false;polling=null;detailsRequest=null;detailsWanted=null;navigationRead=null;clearTimeout(timer);clearInterval(expiryTimer);loseLiveStatus('宿主连接中断，执行状态待核对。');errorState('宿主连接中断，显示内容可能已过期。');},
  close:()=>{saveScroll();linked=false;connectionGeneration++;detailsRequest=null;detailsWanted=null;clearTimeout(timer);clearInterval(expiryTimer);clearTimeout(hoverTimer);window.removeEventListener('scroll',saveScroll);$('dependencyGraph').parentElement.removeEventListener('scroll',saveScroll);document.removeEventListener('toggle',onToggle,true);document.removeEventListener('keydown',onKey);document.removeEventListener('scroll',onInnerScroll,true);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',onVisible);}};
}
