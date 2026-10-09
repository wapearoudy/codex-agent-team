import {memberExecutions,orderedMembers,memberHasWork,memberWorkSummary,taskRelationships,dependencyFamily,taskDisplayState,runIsActive} from './team-projection.mjs';
import {memberName} from './team-naming.mjs';

const labels={removed:'岗位已移除',reserved:'待 Leader 派发',observed:'执行记录待更新',waiting:'待执行',running:'工作中',submitted:'待审查',accepted:'已验收',blocked:'阻塞',cancelled:'已取消',planned:'待创建',starting:'关联中',idle:'待命',unknown:'状态未知',completed:'执行已结束',inProgress:'执行中',failed:'执行失败',interrupted:'已中断'};
const storagePrefix='team-workspace:interaction:v1:';
export function setupTeamView(app){
  const $=id=>document.getElementById(id);
  let current=null,linked=false,timer=null,expiryTimer=null,loading=false,lastDiscovery=0,connectionGeneration=0,selectionGeneration=0;
  let detailsRequest=null,detailsWanted=null,polling=null,wakeRequested=false,navigationRead=null,targetTeamId=null;
  let ui={},storageKey='',navigation=null,navigationBusy=false,restoring=false,taskNumbers=new Map();
  let modelCatalogModels=[],modelCatalogLoading=false,modelCatalogError='',controlBusy=false,controlTeamId=null,controlStatus=null,controlFeedback='',controlNotice=null;
  let planKey='',planDocument=null,planBusy=false,planDirty=false,planLoading=null,planFeedback='',planExpanded=false;
  const language=setupTeamLanguage();
  const actionTooltips=setupActionTooltips();
  const label=s=>language.text(labels[s]??s);
  const roleLabel=m=>m.role+(current.team.members.filter(other=>other.role===m.role).length>1?' · '+m.id:'');
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const button=(text,action,cls,key)=>{const b=node('button',language.text(text),cls);b.type='button';b.onclick=action;if(key)b.dataset.focusKey=key;return b;};
  const memberGoals=setupMemberGoalEditor({call,getData:()=>current,getLanguage:()=>language,readOnly:()=>viewingHistory,onSaved:data=>{
    if(current?.team.id!==data.teamId)return;
    current={...current,team:{...current.team,revision:Math.max(current.team.revision,data.revision),members:current.team.members.map(m=>m.id===data.memberId&&(m.goalRevision??1)<=data.goalRevision?{...m,responsibility:data.goal,goalRevision:data.goalRevision,goalUpdatedAt:data.updatedAt}:m)}};render();
  }});
  function iconAction(text,description,icon,action,key,disabled=false){
    const wrap=node('span',undefined,'icon-action'),control=button('',action,'subtle-button icon-button',key);
    wrap.dataset.tooltipLabel=language.text(text);wrap.dataset.tooltipDescription=language.text(description);
    control.setAttribute('aria-label',language.text(text));control.disabled=disabled;
    if(disabled){wrap.tabIndex=0;wrap.dataset.focusKey='hint:'+key;wrap.setAttribute('aria-label',language.text(text)+' · '+language.text(description));}
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [name,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(name,value);
    const paths=icon==='open'?['M14 4h6v6','M20 4l-9 9','M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5']:icon==='edit'?['m15 5 4 4','m4 20 5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z']:['M4 4h16v16H4z','M10 4v16','M13.5 9H17','M13.5 13H17'];
    for(const d of paths){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}
    control.append(svg);wrap.append(control);return wrap;
  }
  if($('teamStop'))$('teamStop').onclick=()=>void controlTeam('stop');
  if($('teamResume'))$('teamResume').onclick=()=>void controlTeam('resume');
  if($('planSummaryToggle'))$('planSummaryToggle').onclick=()=>{planExpanded=!planExpanded;renderPlanReview();if(planExpanded&&!planDocument&&!planLoading)void loadPlan();};
  if($('closeInspection'))$('closeInspection').onclick=()=>{const focus=ui.taskId?'task-row:'+ui.taskId:'member:'+ui.memberId;clearNavigation();ui.taskId=null;ui.memberId=null;ui.attemptId=null;ui.memberView=false;storeState();render();[...document.querySelectorAll('[data-focus-key]')].find(el=>el.dataset.focusKey===focus)?.focus();};
  let viewingHistory=false;
  const extras=setupTeamExtras({app,call,getData:()=>current,getTask:()=>selectedTask(),getLanguage:()=>language,accept,editMemberGoal:id=>memberGoals.open(id,'teamManageOpen'),switchTeam:async(id)=>{viewingHistory=!!id;targetTeamId=id;if(id)await accept(await call('read_team',{teamId:id,view:'panel'}));else await accept(await call('open_team_workspace'));}});
  language.onchange=()=>{if(current){render();if(planDocument)renderPlanDocument();}extras.translate();};
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
    if(r.isError)throw new Error(r.content?.find(c=>c.type==='text')?.text??language.text('状态读取失败'));
    if(!r.structuredContent)throw new Error(language.text('宿主没有返回有效数据'));return r.structuredContent;
  }
  const reviewKey=()=>current?.team.planReview?JSON.stringify([current.team.id,current.team.planReview.version,current.team.planReview.hash,current.team.planReview.status]):'';
  function planStatus(text){planFeedback=text;$('planReviewFeedback').textContent=language.text(text);}
  function renderPlanReview(){
    const review=current?.team.planReview,box=$('planReview');if(!box)return;box.hidden=!review||viewingHistory;if(!review||viewingHistory)return;
    const pending=review.status==='pending',key=reviewKey();
    if(key!==planKey){planKey=key;planDocument=null;planDirty=false;planLoading=null;planExpanded=false;$('planReviewContent').replaceChildren();}
    box.classList.toggle('is-settled',!pending);$('planReviewBody').hidden=!pending&&!planExpanded;
    $('planSummaryToggle').hidden=pending;$('planSummaryToggle').textContent=language.text(planExpanded?'收起计划':'查看计划');$('planSummaryToggle').setAttribute('aria-expanded',String(planExpanded));
    $('planReviewTitle').textContent=language.text(pending?(review.scope==='expansion'?'确认团队变更':'确认团队计划'):(review.scope==='expansion'?'团队变更':'团队计划'));
    $('planReviewStatus').textContent=language.locale==='en'?'Version '+review.version+' · '+language.text(pending?language.text('等待确认'):review.status==='approved'?language.text('已确认'):language.text('已取消')):language.text('第 ')+review.version+language.text(' 版 · ')+(pending?language.text('等待确认'):review.status==='approved'?language.text('已确认'):language.text('已取消'));
    $('planReviewBrief').textContent=review.brief||review.reason;
    $('planReviewNotice').textContent=review.scope==='expansion'?language.text('确认前保留原团队执行；变更确认只授权新范围，不代表任务验收。'):pending?language.text('确认前不会初始化成员或派发任务。确认后仍须独立审查与验收。'):language.text('计划授权与任务验收分别记录。');
    const actions=$('planReviewActions');actions.replaceChildren();
    if(pending){
      const approve=button(language.text('确认并继续'),()=>void decidePlan('approve'),'primary','plan-approve');approve.id='planApprove';approve.disabled=planBusy||planDirty||!planDocument;
      const save=button(language.text('保存修改'),()=>void savePlan(),'subtle-button','plan-save');save.id='planSave';save.disabled=planBusy||!planDirty||!planDocument;
      const cancel=button(review.scope==='expansion'?language.text('取消本次变更'):language.text('取消计划'),()=>void decidePlan('cancel'),'subtle-button','plan-cancel');cancel.id='planCancel';cancel.disabled=planBusy;
      const feedback=button(language.text('返回聊天修改'),()=>void returnPlanToChat(),'subtle-button','plan-feedback');feedback.id='planReturnToChat';feedback.disabled=planBusy;actions.append(approve,save,feedback,cancel);
    }
    const reload=button(planDocument?language.text('重新读取计划'):language.text('查看计划详情'),()=>void loadPlan(),'subtle-button','plan-reload');reload.id='planReload';reload.disabled=planBusy;actions.append(reload);
    $('planReviewFeedback').textContent=language.text(planFeedback);
    if(pending&&!planBusy&&!planDocument&&!planLoading)void loadPlan();
  }
  async function loadPlan(){
    const key=planKey,teamId=current?.team.id,generation=connectionGeneration;if(!teamId||planLoading&&!planLoading.failed)return;
    if(planLoading?.failed)planLoading=null;const request={key};planLoading=request;
    try{const data=await call('read_team_plan',{teamId});if(key!==planKey||generation!==connectionGeneration||teamId!==current?.team.id)return;
      if(data.review.hash!==current.team.planReview.hash||data.review.version!==current.team.planReview.version)throw new Error(language.text('计划已变化，请等待面板同步后重新读取。'));
      planDocument=data;planDirty=false;renderPlanDocument();planStatus(language.text(data.review.status==='pending'?'已读取完整计划。修改后请先保存，再确认新版本。':'已读取确认记录。'));
    }catch(e){if(key===planKey)planStatus(e.message);}finally{if(planLoading===request)planLoading=planDocument?null:{failed:true};if(key===planKey)renderPlanReview();}
  }
  function renderPlanDocument(){
    const box=$('planReviewContent');box.replaceChildren();const doc=planDocument,c=doc.configuration,pending=doc.review.status==='pending',initial=doc.review.scope==='initial';
    const members=initial?c.plan.members:(c.members??=[]),tasks=initial?c.plan.tasks:(c.tasks??=[]);
    const roster=()=>initial?members:[...current.team.members,...members],allTasks=()=>initial?tasks:[...current.team.tasks,...tasks];
    const sync=()=>{const json=$('planJson');if(json)json.value=JSON.stringify(c,null,2);};
    const markDirty=()=>{planDirty=true;sync();if($('planApprove'))$('planApprove').disabled=true;if($('planSave'))$('planSave').disabled=false;planStatus(language.text('修改尚未保存；保存后将生成新的待确认版本。'));};
    const field=(parent,title,value,set,multiline=false)=>{const label=node('label',language.text(title)),input=node(multiline?'textarea':'input');input.value=value??'';input.disabled=!pending;input.setAttribute('aria-label',language.text(title));input.oninput=()=>{set(input.value);markDirty();};label.append(input);parent.append(label);return input;};
    const select=(parent,title,value,options,set)=>{const label=node('label',language.text(title)),input=node('select');input.setAttribute('aria-label',language.text(title));for(const [v,text] of options){const option=node('option',language.text(text));option.value=v;input.append(option);}input.value=value??'';input.disabled=!pending;input.onchange=()=>{set(input.value);markDirty();};label.append(input);parent.append(label);return input;};
    const number=(parent,title,value,set,min,max)=>{const input=field(parent,title,value,v=>set(v===''?null:Number(v)));input.type='number';if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;return input;};
    const lines=value=>value.split('\n').map(s=>s.trim()).filter(Boolean);
    const unique=prefix=>prefix+'_'+crypto.randomUUID().slice(0,8);
    const change=fn=>{try{fn();markDirty();renderPlanDocument();}catch(e){planStatus(e.message);}};
    if(initial){field(box,language.text('任务目标'),c.goal,value=>c.goal=value,true);select(box,language.text('成员启动方式'),c.memberStartup??'eager',[['on-demand',language.text('首个任务就绪时创建')],['eager',language.text('先初始化全部成员')]],v=>c.memberStartup=v);}
    box.append(node('p',members.length+language.text(' 个')+(initial?language.text('岗位'):language.text('新增岗位'))+' · '+tasks.length+language.text(' 项')+(initial?language.text('任务'):language.text('新增任务'))));
    box.append(node('p',language.text('每个任务使用独立会话，已完成任务的原始上下文不会自动带入。'),'muted'));
    const budget=node('details');budget.append(node('summary',language.text('并发与执行预算')));box.append(budget);
    number(budget,language.text('最大并发'),c.maxParallel??current.team.maxParallel,v=>c.maxParallel=v,1,8);
    const policy=c.policy??(c.policy={...current.team.policy});
    number(budget,language.text('Token 上限（留空表示不限）'),policy.tokenLimit,v=>policy.tokenLimit=v,1);
    number(budget,language.text('完整派发提示字符上限'),policy.contextChars??24000,v=>policy.contextChars=v,4000,100000);
    number(budget,language.text('每项任务最大尝试次数'),policy.maxAttempts??3,v=>policy.maxAttempts=v,1,10);
    number(budget,language.text('最大审查修复轮数'),policy.maxReviewRounds??3,v=>policy.maxReviewRounds=v,1,10);
    select(budget,language.text('自动生成修复任务'),String(policy.autoRepair===true),[['false',language.text('关闭')],['true',language.text('开启（仍须独立审查）')]],v=>policy.autoRepair=v==='true');
    select(budget,language.text('用量未知时阻止新派发'),String(policy.requireKnownUsage===true),[['false',language.text('允许，明确保留未知')],['true',language.text('阻止')]],v=>policy.requireKnownUsage=v==='true');
    const roles=node('details');roles.open=true;roles.append(node('summary',language.text('岗位、职责与模型 · ')+members.length));const rolesBox=node('div',undefined,'plan-items');roles.append(rolesBox);box.append(roles);
    const catalogButton=button(modelCatalogLoading?language.text('读取模型目录中…'):language.text('读取宿主模型目录'),()=>void loadModelCatalog(),'subtle-button');catalogButton.id='planLoadModels';catalogButton.disabled=modelCatalogLoading;roles.append(catalogButton);
    if(modelCatalogError)roles.append(node('p',language.text('模型目录暂不可用：')+modelCatalogError+language.text('。沿用已有路由；可以重新读取。'),'muted'));
    for(const m of members){const row=node('div',undefined,'plan-item');row.dataset.memberId=m.id;row.append(node('strong',m.id));field(row,language.text('岗位 ')+m.id,m.role,value=>m.role=value);field(row,language.text('职责 ')+m.id,m.responsibility,value=>m.responsibility=value,true);field(row,language.text('设置理由 ')+m.id,m.reason,value=>m.reason=value,true);field(row,language.text('写入范围 ')+m.id,(m.writeScopes??[]).join('\n'),value=>m.writeScopes=lines(value),true);
      const choices=[['',language.text('沿用宿主（计划保存模型快照）')],...modelCatalogModels.map(model=>[model.model,model.displayName])];if(m.route?.model&&!choices.some(([id])=>id===m.route.model))choices.push([m.route.model,m.route.model+language.text('（待宿主核实）')]);
      const model=select(row,language.text('模型 ')+m.id,m.route?.model,choices,v=>{if(v){m.route={model:v};}else delete m.route;renderEfforts();});model.disabled=!pending||!modelCatalogModels.length;
      const effortsBox=node('div');row.append(effortsBox);const renderEfforts=()=>{effortsBox.replaceChildren();const found=modelCatalogModels.find(model=>model.model===m.route?.model),efforts=found?.supportedReasoningEfforts??[];const choices=[['',language.text('沿用所选模型默认')],...efforts.map(e=>[e,e])];if(m.route?.reasoningEffort&&!efforts.includes(m.route.reasoningEffort))choices.push([m.route.reasoningEffort,m.route.reasoningEffort+language.text('（待核实）')]);const effort=select(effortsBox,language.text('思考档位 ')+m.id,m.route?.reasoningEffort,choices,v=>{if(v)m.route.reasoningEffort=v;else if(m.route)delete m.route.reasoningEffort;});effort.disabled=!pending||!found;};renderEfforts();
      const fallback=select(row,language.text('备用模型 ')+m.id,m.fallbackRoute?.model,[['',language.text('不配置备用模型')],...modelCatalogModels.map(model=>[model.model,model.displayName])],v=>{if(v)m.fallbackRoute={model:v};else delete m.fallbackRoute;});fallback.disabled=!pending||!modelCatalogModels.length;
      if(m.routeSnapshot?.model)row.append(node('p',language.text('计划模型快照：')+m.routeSnapshot.model+' · '+(m.routeSnapshot.reasoningEffort??language.text('未知档位')),'muted'));
      if(pending)row.append(button(language.text('删除岗位 ')+m.id,()=>change(()=>{if(tasks.some(t=>t.memberId===m.id))throw new Error(language.text('请先在任务中改派或删除该岗位的任务。'));members.splice(members.indexOf(m),1);})));
      rolesBox.append(row);
    }
    if(pending){const add=button(language.text('新增岗位'),()=>change(()=>{if(roster().length>=8)throw new Error(language.text('最多 8 个活跃岗位。'));members.push({id:unique('role'),role:language.text('新岗位'),responsibility:language.text('请填写职责'),reason:language.text('请填写设置理由'),writeScopes:[]});}));add.id='planAddMember';roles.append(add);}
    const jobs=node('details');jobs.open=true;jobs.append(node('summary',language.text('交付、验收与依赖 · ')+tasks.length));const jobsBox=node('div',undefined,'plan-items');jobs.append(jobsBox);box.append(jobs);
    for(const t of tasks){const row=node('div',undefined,'plan-item');row.dataset.taskId=t.id;row.append(node('strong',t.id));field(row,language.text('任务名称 ')+t.id,t.title,value=>t.title=value);field(row,language.text('任务目标 ')+t.id,t.goal,value=>t.goal=value,true);field(row,language.text('验收条件 ')+t.id,t.acceptance,value=>t.acceptance=value,true);
      select(row,language.text('负责岗位 ')+t.id,t.memberId,roster().filter(m=>!m.removedAt&&(t.kind!=='review'||!m.writeScopes?.length&&m.id!==allTasks().find(x=>x.id===t.reviewOfTaskId)?.memberId)).map(m=>[m.id,m.role+' · '+m.id]),v=>t.memberId=v);
      number(row,language.text('优先级 ')+t.id,t.priority,v=>t.priority=v,1,5);
      if(t.kind==='review')select(row,language.text('审查对象 ')+t.id,t.reviewOfTaskId,allTasks().filter(x=>x.id!==t.id&&x.kind!=='review'&&x.memberId!==t.memberId).map(x=>[x.id,x.title]),v=>{const old=t.reviewOfTaskId;t.reviewOfTaskId=v;t.dependencies=t.dependencies.filter(d=>d.taskId!==old&&d.taskId!==v);t.dependencies.push({taskId:v,when:'submitted'});});
      const deps=node('details');deps.append(node('summary',language.text('任务依赖 ')+t.id));row.append(deps);
      for(const other of allTasks().filter(x=>x.id!==t.id)){const existing=t.dependencies.find(d=>d.taskId===other.id);select(deps,language.text('依赖 ')+t.id+' ← '+other.id,existing?.when??'',[['',language.text('无依赖')],['submitted',language.text('等待提交')],['accepted',language.text('等待验收')]],v=>{t.dependencies=t.dependencies.filter(d=>d.taskId!==other.id);if(v)t.dependencies.push({taskId:other.id,when:v});});}
      if(t.acceptanceCriteria)field(row,language.text('逐项验收 ')+t.id,t.acceptanceCriteria.map(x=>x.id+' | '+x.description).join('\n'),v=>t.acceptanceCriteria=lines(v).map(line=>{const i=line.indexOf('|');return {id:line.slice(0,i).trim(),description:line.slice(i+1).trim()};}),true);
      if(t.contract){for(const [key,title] of [['inScope',language.text('包含路径')],['outOfScope',language.text('排除路径')],['verify',language.text('验证命令')],['coverageOf',language.text('覆盖目标')]])field(row,title+' '+t.id,(t.contract[key]??[]).join('\n'),v=>t.contract[key]=lines(v),true);}
      if(pending)row.append(button(language.text('删除任务 ')+t.id,()=>change(()=>{const ids=new Set([t.id,...tasks.filter(x=>x.reviewOfTaskId===t.id).map(x=>x.id)]);if(tasks.some(x=>!ids.has(x.id)&&x.dependencies.some(d=>ids.has(d.taskId))))throw new Error(language.text('其他任务仍依赖此任务，请先调整依赖。'));for(let i=tasks.length-1;i>=0;i--)if(ids.has(tasks[i].id))tasks.splice(i,1);})));
      jobsBox.append(row);
    }
    if(pending){const add=button(language.text('新增交付与独立审查'),()=>change(()=>{if(tasks.length>38)throw new Error(language.text('最多 40 项待执行任务。'));const owner=roster().find(m=>!m.removedAt&&m.writeScopes?.length)??roster()[0],reviewer=roster().find(m=>!m.removedAt&&m.id!==owner?.id&&!m.writeScopes?.length);if(!owner||!reviewer)throw new Error(language.text('请先设置交付岗位和另一名只读审查岗位。'));const work=unique('work');tasks.push({id:work,title:language.text('新交付'),goal:language.text('请填写交付目标'),acceptance:language.text('请填写验收要求'),memberId:owner.id,priority:3,kind:'work',validationMode:'execute',resources:[],dependencies:[]},{id:unique('review'),title:language.text('独立审查新交付'),goal:language.text('核实交付符合验收要求'),acceptance:language.text('提供独立验证证据'),memberId:reviewer.id,priority:3,kind:'review',reviewOfTaskId:work,validationMode:'execute',resources:[],dependencies:[{taskId:work,when:'submitted'}]});}));add.id='planAddTask';jobs.append(add);}
    const advanced=node('details');advanced.append(node('summary',language.text('高级：完整配置 JSON')));field(advanced,language.text('完整计划 JSON'),JSON.stringify(c,null,2),()=>{},true).id='planJson';const json=advanced.querySelector('textarea');json.className='plan-json';json.oninput=()=>{planDirty=true;if($('planApprove'))$('planApprove').disabled=true;if($('planSave'))$('planSave').disabled=false;planStatus(language.text('修改尚未保存；保存后将生成新的待确认版本。'));};box.append(advanced);
    if(doc.history?.length)box.append(node('p',language.text('保留计划版本：')+doc.history.map(h=>'v'+h.version).join('、'),'muted'));
  }
  async function loadModelCatalog(){if(modelCatalogLoading)return;modelCatalogLoading=true;modelCatalogError='';try{const catalog=await call('read_team_model_catalog');modelCatalogModels=catalog.models??[];}catch(e){modelCatalogError=e.message;}finally{modelCatalogLoading=false;if(planDocument)renderPlanDocument();}}
  async function savePlan(){
    if(planBusy||!planDocument||!planDirty)return;const key=planKey,generation=connectionGeneration,teamId=current.team.id;
    planBusy=true;renderPlanReview();
    try{const configuration=JSON.parse($('planJson').value),data=await call('revise_team_plan',{teamId,revision:current.team.revision,configuration});if(key!==planKey||generation!==connectionGeneration)return;
      const state=await call('read_team',{teamId,view:'state'});if(key!==planKey||generation!==connectionGeneration)return;await accept(state);planKey=reviewKey();planDocument=data;planDirty=false;renderPlanDocument();planStatus(language.text('修改已保存，请审阅并确认第 ')+data.review.version+language.text(' 版。'));
    }catch(e){if(key===planKey)planStatus(language.text('保存失败：')+e.message);}finally{planBusy=false;renderPlanReview();}
  }
  async function returnPlanToChat(){
    if(planBusy||!current)return;const teamId=current.team.id,p=current.team.planReview,requestId=crypto.randomUUID();planBusy=true;renderPlanReview();
    try{const data=await call('request_team_plan_feedback',{teamId,revision:current.team.revision,planVersion:p.version,planHash:p.hash,requestId,note:language.text('用户选择返回聊天修改当前计划')});planDocument=data;
      const text='TEAM_WORKSPACE_PLAN_FEEDBACK:'+requestId+' teamId='+teamId+' planVersion='+p.version+language.text('. 用户选择返回聊天修改。保留当前草案，不批准、不创建成员、不重建团队。请停止当前规划，询问用户希望修改的内容并等待回复。');
      try{if(!app.sendMessage||!app.getHostCapabilities?.()?.message)throw new Error('Message unavailable');const r=await app.sendMessage({role:'user',content:[{type:'text',text}]});if(r?.isError)throw new Error('Message rejected');planStatus(language.text('已返回聊天，等待你说明修改内容。'));}catch{planStatus(language.text('修改请求已保存；通知失败，请回主会话说“修改当前团队计划”。'));}
      await accept(await call('read_team',{teamId,view:'state'}));
    }catch(e){planStatus(e.message);}finally{planBusy=false;renderPlanReview();}
  }
  async function decidePlan(action){
    if(planBusy||action==='approve'&&(!planDocument||planDirty))return;
    const key=planKey,generation=connectionGeneration,teamId=current.team.id,p=current.team.planReview,requestId=crypto.randomUUID();planBusy=true;renderPlanReview();
    try{const decisionResult=await call(action==='approve'?'approve_team_plan':'cancel_team_plan',{teamId,revision:current.team.revision,planVersion:p.version,planHash:p.hash,requestId,note:action==='approve'?language.text('用户在面板确认此版本计划'):language.text('用户在面板取消此版本计划'),source:'panel-user-action'});
      if(key!==planKey||generation!==connectionGeneration||teamId!==current?.team.id)return;
      if(action==='approve'){
        planStatus(language.text('计划已确认，正在通知主会话继续。'));
        try{if(decisionResult.coordination?.notification&&!decisionResult.coordination.firstOffer){planStatus(language.text('计划已确认，工作流通知已记录；请查看协调状态。'));}else {if(!app.getHostCapabilities?.()?.message||!app.sendMessage)throw new Error(language.text('宿主未提供消息能力'));const sent=await app.sendMessage({role:'user',content:[{type:'text',text:language.text('我已在团队面板确认计划。teamId=')+teamId+'，planVersion='+p.version+'，planHash='+p.hash+'，requestId='+requestId+language.text('。请先 read_team_plan 核对当前确认仍有效，再按成员启动方式派发已批准任务；按需模式在首个就绪任务时创建成员；无需再次要求确认。')+(decisionResult.coordination?.message?'\n'+decisionResult.coordination.message:'')}]});if(sent?.isError)throw new Error(language.text('宿主没有接受通知'));if(decisionResult.coordination?.firstOffer)await call('coordinate_team',{teamId,operation:'receipt',notificationId:decisionResult.coordination.notification.id,status:'host-accepted',note:'Host accepted the approved-plan continuation'});planStatus(language.text('计划已确认，已通知主会话继续；实际执行进度以成员记录为准。'));}}catch{if(decisionResult.coordination?.firstOffer)try{await call('coordinate_team',{teamId,operation:'receipt',notificationId:decisionResult.coordination.notification.id,status:'unknown',note:'Approved-plan notification was not confirmed'});}catch{}planStatus(language.text('计划已确认。请回到主会话说“继续执行已确认计划”；确认记录已保存。'));}
      }else planStatus(language.text('已取消本次')+(p.scope==='expansion'?language.text('变更；原团队继续沿用已有授权。'):language.text('计划，未启动成员。')));
      if(teamId===current?.team.id&&generation===connectionGeneration)await accept(await call('read_team',{teamId,view:'state'}));
    }catch(e){if(key===planKey)planStatus(language.text('操作未确认成功：')+e.message+language.text('。请重新读取当前计划；不要重复启动成员。'));}finally{planBusy=false;renderPlanReview();}
  }
  function renderControl(){
    const box=$('teamControl');if(!box)return;
    if(controlTeamId!==current?.team.id){controlTeamId=current?.team.id;controlStatus=null;controlFeedback='';controlNotice=null;$('teamControlReason').value='';$('teamControlFeedback').textContent='';$('teamControlOptions').open=false;}
    box.hidden=viewingHistory||!current||current.team.mode!=='host-leader'||['superseded','delivered','cancelled'].includes(current.team.state)||current.team.planReview?.scope==='initial'&&current.team.planReview.status!=='approved';if(box.hidden)return;
    const status=current.team.executionControl?.status??'active',active=current.runs.some(runIsActive);
    box.dataset.status=status;
    if(status!==controlStatus){
      if(status==='halted')controlFeedback='进度与交付记录已保留。';
      else if((status==='stopping'&&!(controlNotice?.action==='stop'&&controlNotice.requestId===current.team.executionControl?.requestId))||(status==='active'&&controlNotice?.action!=='resume'))controlFeedback='';
      controlStatus=status;
    }
    $('teamControlFeedback').textContent=language.text(controlFeedback);
    $('teamControlStatus').textContent=language.text(status==='stopping'?'正在停止':status==='halted'?'团队已停止':active?'执行中':'等待执行');
    $('teamStop').hidden=status!=='active';$('teamResume').hidden=status!=='halted';$('teamStop').disabled=controlBusy;$('teamResume').disabled=controlBusy;
    $('teamStop').textContent=language.text(controlBusy?'正在提交…':'停止');$('teamResume').textContent=language.text(controlBusy?'正在提交…':'继续执行');
    $('teamControlOptionsLabel').textContent=language.text(status==='halted'?'恢复选项与说明':'添加说明');
    const list=$('teamRetryTasks'),retryable=current.team.tasks.filter(t=>t.status==='blocked'&&['stopped','failed','interrupted'].includes(t.attempts.at(-1)?.state)),signature=JSON.stringify([current.team.id,status,retryable.map(t=>[t.id,t.attempts.at(-1)?.id,t.attempts.at(-1)?.state])]);
    if(list.dataset.signature!==signature){list.dataset.signature=signature;list.replaceChildren();if(status==='halted')for(const task of retryable){const label=node('label'),input=node('input'),caption=node('span',task.title);input.type='checkbox';input.value=task.id;input.checked=task.attempts.at(-1).state==='stopped';input.dataset.focusKey='retry:'+task.id;input.onchange=renderControl;label.append(input,caption);list.append(label);}}
    for(const input of list.querySelectorAll('input')){input.disabled=controlBusy;const task=retryable.find(t=>t.id===input.value);if(task)input.nextElementSibling.textContent=task.title+' · '+language.text(task.attempts.at(-1).state==='stopped'?'因停止而中断':task.attempts.at(-1).state==='failed'?'执行失败':'已中断');}
    const selected=list.querySelectorAll('input:checked').length;
    $('teamControlHint').textContent=status==='stopping'?language.text('正在结束成员任务，进度与记录会保留。'):status==='halted'?language.text('继续待执行任务')+(selected?' · '+selected+language.text(' 项任务将重试'):'')+(retryable.length?language.text('；可在恢复选项中调整。'):language.text('，保留已完成的交付。')):language.text('停止会保留进度与交付记录。');
    $('teamControlOptions').hidden=status==='stopping';$('teamControlReason').disabled=controlBusy;
  }
  async function controlTeam(action){
    if(controlBusy||!current||viewingHistory)return;const status=current.team.executionControl?.status??'active';if(action==='stop'?status!=='active':status!=='halted')return;
    const note=$('teamControlReason').value.trim(),reason=note||language.text(action==='stop'?'用户在团队面板点击停止':'用户在团队面板点击继续执行');
    const teamId=current.team.id,revision=current.team.revision,requestId=crypto.randomUUID(),say=value=>{if(teamId===current?.team.id&&!viewingHistory){controlFeedback=action==='stop'&&current.team.executionControl?.status==='halted'?'进度与交付记录已保留。':value;$('teamControlFeedback').textContent=language.text(controlFeedback);}};controlNotice={teamId,requestId,action};controlFeedback='';controlBusy=true;renderControl();
    try{const result=await call(action==='stop'?'stop_team':'resume_team',{teamId,revision,reason,requestId,...(action==='resume'?{retryTaskIds:[...$('teamRetryTasks').querySelectorAll('input:checked')].map(e=>e.value)}:{})});
      if(teamId===current?.team.id){await accept(result);$('teamControlReason').value='';$('teamControlOptions').open=false;}
      say(action==='stop'?'正在通知主会话结束成员任务…':'正在通知主会话继续执行…');
      try{if(!app.getHostCapabilities?.()?.message||!app.sendMessage)throw new Error('Message unavailable');const sent=await app.sendMessage({role:'user',content:[{type:'text',text:action==='stop'?language.text('我在面板请求停止团队 ')+teamId+language.text('。请 read_team 核对最新状态，中断全部已绑定成员（包括初始化），核实未知预留后 reconcile_team_stop；不要重新派发。原因：')+reason:language.text('我在面板明确恢复团队 ')+teamId+language.text('，原因：')+reason+language.text('。请 read_team 核对 resume 记录，只继续已授权的就绪任务；保留历史和预算。')}]});if(sent?.isError)throw new Error('Message rejected');say(action==='stop'?'已发出停止通知，正在等待成员结束。':'已通知主会话继续执行。');}catch{say(action==='stop'?'停止请求已保存；通知失败，请回主会话说“执行已保存的团队停止请求”。':'恢复记录已保存；通知失败，请回主会话说“继续已恢复的团队”。');}
      if(teamId===current?.team.id)await accept(await call('read_team',{teamId,view:'state'}));
    }catch(e){say(language.text('操作失败：')+e.message);}finally{controlBusy=false;renderControl();}
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
    if(task){if(!task.attempts.some(a=>a.id===ui.attemptId))ui.attemptId=null;ui.memberId=task.attempts.find(a=>a.id===ui.attemptId)?.memberId??task.memberId;}
  }
  function render(){
    if(!current)return;actionTooltips.beforeRender();extras.update(viewingHistory);memberGoals.sync();
    const focused=document.activeElement?.dataset?.focusKey,scrollY=ui.scrollY??window.scrollY;
    restoring=true;
    if(viewingHistory){$('teamControl').hidden=true;}
    const {team,runs}=current,tasks=team.tasks,active=runs.filter(r=>tasks.some(t=>t.status==='running'&&t.attempts.at(-1)?.id===r.attemptId)&&runIsActive(r));
    taskNumbers=new Map(tasks.map((task,index)=>[task.id,'t'+(task.number??index+1)]));
    const usage=current.usage;$('usageSummary').textContent=usage?language.text('已观察 ')+usage.totalTokens.toLocaleString()+' tokens'+(usage.unknownAttempts?' · '+usage.unknownAttempts+language.text(' 轮用量未知'):'')+(usage.limit?language.text(' / 预算 ')+usage.limit.toLocaleString():''):'';
    const unknown=tasks.filter(t=>taskState(t)==='unknown');
    $('projectName').textContent=team.projectPath.split(/[\\/]/).filter(Boolean).at(-1)||'Team Workspace';
    $('currentProject').textContent=language.text('当前主会话的固定团队 · ')+(team.state==='delivered'?language.text('已完成本批验收'):language.text('任务与成员执行'));
    $('teamGoalText').textContent=team.goal;$('teamGoalTitle').textContent=team.goal;$('goalDetails').hidden=false;
    const memberCount=team.members.filter(m=>!m.removedAt).length;
    $('headerSummary').textContent=tasks.filter(t=>t.status==='accepted').length+'/'+tasks.length+language.text(' 已验收');
    $('progressValue').textContent=(tasks.length?Math.round(tasks.filter(t=>t.status==='accepted').length/tasks.length*100):0)+'%';
    $('captainSummary').textContent=language.text('已派发 ')+tasks.filter(t=>t.attempts.some(a=>a.agentThreadId)).length+language.text(' 项任务');
    $('activeCount').textContent=active.length?active.length+language.text(' 人执行中'):unknown.length?unknown.length+language.text(' 项状态待核对'):language.text('当前无执行中的成员');
    $('activeCount').hidden=!active.length&&!unknown.length;
    $('collapsedSummary').textContent=memberCount+language.text(' 名固定成员 · ')+$('activeCount').textContent;
    $('toggleOverview').textContent=ui.overviewCollapsed?language.text('展开团队'):language.text('收起面板');$('toggleOverview').setAttribute('aria-expanded',String(!ui.overviewCollapsed));
    $('collapsedSummary').hidden=!ui.overviewCollapsed;$('teamBoard').hidden=!!ui.overviewCollapsed;
    $('emptyState').hidden=true;$('loadingState').hidden=true;
    const prep=team.preparation,omissions=prep?.omissions??prep?.excludedGeneratedLogs??[];
    $('workspacePreparation').textContent=prep?.status==='blocked'?language.text('工作区准备失败：')+prep.message:prep?.issues?.length?language.text('验证限制：')+prep.issues.map(i=>i.path+' — '+i.message).join('；'):current.displayLimits?.preview?language.text('面板显示有限预览')+(current.displayLimits.totalTasks>tasks.length?'（'+tasks.length+'/'+current.displayLimits.totalTasks+language.text(' 项任务）'):'')+language.text('；完整交付和命令请打开原生成员会话，验收时按任务读取原始证据。'):'';
    const preparationWarning=prep?.status==='blocked'||prep?.issues?.length;
    $('panelNotes').hidden=!$('workspacePreparation').textContent&&!omissions.length;$('panelNotes').dataset.severity=preparationWarning?'warning':'info';$('panelNotesLabel').textContent=language.text(preparationWarning?'运行限制':'运行说明');
    $('workspaceOmissions').hidden=!omissions.length;$('workspaceOmissions').replaceChildren(node('summary',language.text('历史产物筛选记录 · ')+omissions.length+language.text(' 项')));
    for(const item of omissions)$('workspaceOmissions').append(node('p',item.path+' · '+item.reason));
    $('progressSegments').replaceChildren(...tasks.map(t=>{const b=button('',()=>chooseTask(t.id),'segment '+taskState(t),'progress:'+t.id);b.title=t.id+' '+t.title+' · '+label(taskState(t));b.setAttribute('aria-label',b.title);return b;}));
    $('progressLegend').replaceChildren(...['reserved','waiting','running','starting','observed','unknown','completed','submitted','blocked','failed','interrupted','cancelled','accepted'].filter(s=>s==='accepted'||tasks.some(t=>taskState(t)===s)).map(s=>{const metric=node('span',undefined,'progress-metric '+s);metric.append(node('strong',String(tasks.filter(t=>taskState(t)===s).length)),node('small',label(s)));return metric;}));
    const running=tasks.filter(t=>t.status==='running');$('currentTasks').hidden=!running.length;
    $('currentTasks').textContent=running.map(t=>t.id+' · '+t.title+'（'+label(taskState(t))+'）').join('；');
    const pending=(current.readiness??[]).filter(r=>tasks.find(t=>t.id===r.taskId)?.status==='waiting');
    renderOverviewStatus(active,pending,unknown);
    $('dispatchSummary').hidden=!pending.length&&!team.dispatchPaused;
    $('dispatchSummary').textContent=(team.dispatchPaused?language.text('新任务派发已暂停 · '):'')+pending.filter(r=>r.ready).length+language.text(' 项就绪 · ')+pending.filter(r=>!r.ready).length+language.text(' 项等待前置条件');
    const quality=current.quality;$('qualitySummary').hidden=!quality||!quality.coverage?.length&&!quality.repairCount&&!quality.openFindingCount;
    $('qualitySummary').textContent=quality?(quality.coverage.length?language.text('目标覆盖 ')+quality.coverage.filter(c=>c.status==='accepted').length+'/'+quality.coverage.length+language.text(' 已验收'):language.text('未声明目标覆盖'))+' · '+quality.repairCount+language.text(' 次修复 · ')+quality.openFindingCount+language.text(' 项未关闭问题'):'';
    renderPlanReview();renderControl();renderTaskList();renderMembers();renderGraph();renderDetails();renderMember();syncInspection();renderNavigation();
    for(const d of document.querySelectorAll('details[data-key]'))d.open=ui.expanded.includes(d.dataset.key);
    if(preparationWarning)$('panelNotes').open=true;
    for(const d of document.querySelectorAll('details[data-key]')){const summary=d.querySelector('summary');if(summary&&!summary.dataset.focusKey)summary.dataset.focusKey='disclosure:'+d.dataset.key;}
    for(const e of document.querySelectorAll('[data-scroll-key]')){const saved=ui.innerScroll?.[e.dataset.scrollKey];if(saved){e.scrollLeft=saved.x;e.scrollTop=saved.y;}}
    const graphScroll=$('dependencyGraph').parentElement;graphScroll.scrollLeft=ui.graphX??0;graphScroll.scrollTop=ui.graphY??0;
    if(focused){const target=[...document.querySelectorAll('[data-focus-key]')].find(e=>e.dataset.focusKey===focused);target?.focus({preventScroll:true});}
    window.scrollTo({top:scrollY,behavior:'instant'});
    restoring=false;
    actionTooltips.refresh();
    $('syncState').textContent=language.text('最近同步 ')+new Date(current.observedAt).toLocaleTimeString()+language.text(' · 公开执行记录快照')+(unknown.length?language.text(' · 部分状态待核对'):'');
  }
  function chip(task,long=false){
    const b=button(long?task.id+' · '+task.title:taskNumbers.get(task.id),()=>chooseTask(task.id),'chip '+taskState(task)+(ui.taskId===task.id?' selected':''),'chip:'+task.id);
    b.title=taskNumbers.get(task.id)+' · '+task.id+' · '+task.title+' · '+label(taskState(task));b.setAttribute('aria-pressed',String(ui.taskId===task.id));return b;
  }
  function renderOverviewStatus(active,pending,unknown){
    const {team}=current,tasks=team.tasks,control=team.executionControl?.status,issues=tasks.filter(t=>['blocked','failed','interrupted'].includes(taskState(t))),ready=pending.filter(r=>r.ready),submitted=tasks.filter(t=>t.status==='submitted'),reserved=tasks.filter(t=>taskState(t)==='reserved');
    const counted=(n,source,singular,plural)=>language.locale==='en'?n+' '+(n===1?singular:plural):n+language.text(source);
    let state='waiting',title=language.text('等待执行'),task=null;
    if(team.planReview?.scope==='initial'&&team.planReview.status==='pending')title=language.text('等待计划确认');
    else if(control==='stopping'){state='stopping';title=language.text('正在停止');}
    else if(control==='halted'){state='halted';title=language.text('团队已停止');}
    else if(team.state==='delivered'){state='accepted';title=language.text('已完成本批验收');}
    else if(issues.length){state='blocked';title=counted(issues.length,' 项任务需要处理','task needs attention','tasks need attention');task=issues[0];}
    else if(unknown.length){state='unknown';title=counted(unknown.length,' 项状态待核对','state to verify','states to verify');task=unknown[0];}
    else if(active.length){state='running';const ids=new Set(active.map(r=>r.taskId));title=counted(ids.size,' 项任务执行中','task running','tasks running');task=tasks.find(t=>ids.has(t.id));}
    else if(team.dispatchPaused){state='halted';title=language.text('新任务派发已暂停');}
    else if(submitted.length){state='submitted';title=counted(submitted.length,' 项等待独立审查','task awaiting independent review','tasks awaiting independent review');task=submitted[0];}
    else if(reserved.length){title=counted(reserved.length,' 项等待派发','task awaiting dispatch','tasks awaiting dispatch');task=reserved[0];}
    else if(tasks.some(t=>t.status==='running')){title=language.text('等待执行记录');task=tasks.find(t=>t.status==='running');}
    else if(ready.length){state='ready';title=counted(ready.length,' 项任务已就绪','task ready','tasks ready');task=tasks.find(t=>t.id===ready[0].taskId);}
    else if(tasks.length&&tasks.every(t=>['accepted','cancelled'].includes(t.status))){title=language.text('任务已结束，等待收尾');}
    else if(pending.length){title=language.text('等待前置条件');task=tasks.find(t=>t.id===pending[0].taskId);}
    $('overviewStatus').dataset.state=state;$('overviewHeadline').textContent=title;
    $('overviewTask').hidden=!task;$('overviewTask').textContent=task?(taskNumbers.get(task.id)??task.id)+' · '+task.title:'';
  }
  function filteredTasks(){
    const query=$('taskSearch').value.trim().toLowerCase(),status=$('taskStatusFilter').value;
    return current.team.tasks.filter(t=>(!status||t.status===status)&&(!query||[t.id,t.title,t.goal,taskNumbers.get(t.id)].some(v=>String(v??'').toLowerCase().includes(query))));
  }
  function renderTaskList(){
    const list=$('taskList'),matching=filteredTasks(),tasks=matching.slice(0,100);list.replaceChildren();
    $('taskListCount').textContent=tasks.length+'/'+current.team.tasks.length;
    const focus=$('taskFocus');focus.replaceChildren();
    const groups=[['blocked','failed','interrupted','unknown'],['running','starting','reserved','observed'],['submitted','completed']];
    const highlighted=groups.map(states=>matching.find(t=>states.includes(taskState(t)))).find(Boolean)??matching.find(t=>t.status==='waiting'&&current.readiness?.some(r=>r.taskId===t.id&&r.ready));
    focus.hidden=!highlighted;
    if(highlighted){
      const state=taskState(highlighted),owner=current.team.members.find(m=>m.id===highlighted.memberId),action=button('',()=>{chooseTask(highlighted.id);if(ui.taskId){$('selectionPanel').focus({preventScroll:true});$('selectionPanel').scrollIntoView({block:'nearest'});}},'focus-task','focus-task:'+highlighted.id);
      focus.dataset.state=state;action.dataset.focusTaskId=highlighted.id;
      const copy=node('span',undefined,'focus-task-copy');copy.append(node('small',language.text('当前关注')) ,node('strong',highlighted.title),node('span',(owner?roleLabel(owner):highlighted.memberId)+' · '+(state==='waiting'?language.text(current.team.dispatchPaused?'新任务派发已暂停':'已就绪，等待派发'):label(state))));
      action.append(copy,node('span',language.text('查看详情'),'focus-task-link'));focus.append(action);
    }
    for(const task of tasks){
      const row=button('',()=>{chooseTask(task.id);if(ui.taskId){$('selectionPanel').focus({preventScroll:true});$('selectionPanel').scrollIntoView({block:'nearest'});}},'task-row','task-row:'+task.id),copy=node('span',undefined,'task-copy'),owner=current.team.members.find(m=>m.id===task.memberId),state=taskState(task);
      row.dataset.listTaskId=task.id;row.dataset.state=state;row.dataset.focused=String(task.id===highlighted?.id);row.setAttribute('aria-pressed',String(ui.taskId===task.id));copy.append(node('span',task.title,'task-title'));
      const assignee=node('span',owner?roleLabel(owner):task.memberId,'task-owner');assignee.title=owner?memberName(current.team,owner):task.memberId;
      row.append(node('span',taskNumbers.get(task.id),'task-number'),copy,assignee,node('span',label(state),'status-pill '+state));list.append(row);
    }
    if(!tasks.length)list.append(node('p',language.text('没有匹配的任务'),'task-list-empty'));
    if(matching.length>tasks.length)list.append(node('p',language.text('当前仅显示前 100 项，请搜索或筛选更多任务。'),'task-list-empty'));
  }
  function renderMembers(){
    const {team,runs}=current,ordered=orderedMembers(team,runs),visible=ui.membersOpen?ordered:ordered.filter(({member})=>memberHasWork(member,team.tasks)||!team.tasks.some(t=>t.memberId===member.id));
    const hidden=ordered.length-visible.length;
    $('membersHeading').textContent=team.members.filter(m=>!m.removedAt).length+language.text(' 名成员')+(team.members.some(m=>m.removedAt)?language.text(' · 含历史岗位'):'');
    $('toggleMembers').textContent=ui.membersOpen?language.text('收起已结束成员'):hidden?language.text('展开已结束 ')+hidden+language.text(' 名成员'):language.text('展开全部');
    $('toggleMembers').setAttribute('aria-expanded',String(ui.membersOpen));$('memberTree').hidden=false;
    $('memberTree').replaceChildren(...visible.map(({member:m,index:i,state})=>{
      const assigned=team.tasks.filter(t=>t.memberId===m.id),item=node('article',undefined,'member'+(state==='running'?' active':''));
      item.dataset.memberId=m.id;item.dataset.selected=String(ui.memberId===m.id);item.dataset.state=state;
      const head=node('div',undefined,'member-head'),avatar=node('div',m.role.slice(0,1)||String(i+1),'avatar');avatar.setAttribute('aria-hidden','true');
      const body=node('div',undefined,'member-info'),identity=button(roleLabel(m),()=>chooseMember(m.id),'member-name member-select','member:'+m.id);identity.title=memberName(team,m);
      identity.setAttribute('aria-pressed',String(ui.memberId===m.id));body.append(identity,node('span',m.responsibility,'responsibility'));
      const executions=memberExecutions(m,team.tasks,runs),latest=executions.toSorted((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt)).at(-1);
      if(latest?.model){const model=node('span',latest.model,'model-tag');model.title=latest.model;body.append(model);}
      const summary=memberWorkSummary(team,m,runs,current.readiness),status=node('div',undefined,'member-state '+state);
      const summaryText=team.members.reduce((text,member)=>text.replaceAll(memberName(team,member),roleLabel(member)),summary.text);
      const activity=node('div',(summary.taskId?(taskNumbers.get(summary.taskId)??summary.taskId)+' · ':'')+summaryText,'member-action');
      status.append(node('div',label(state)),node('div',assigned.filter(t=>t.status==='accepted').length+'/'+assigned.length+language.text(' 已验收'),'member-count'));
      head.append(avatar,body,status);item.append(head,activity);
      const actions=node('div',undefined,'member-actions');
      const unbound=!m.agentThreadId||!m.rosterVerified;
      actions.append(iconAction('打开原生会话',unbound?'成员尚未完成原生绑定':'直接打开已有 subagent 会话；不会派发任务','open',()=>void requestNavigation(m.id),'open-member:'+m.id,unbound),
        iconAction('查看任务与执行','查看成员任务、交付与历史轮次','inspect',()=>chooseMember(m.id),'view-member:'+m.id));
      if(team.mode==='host-leader'&&team.fixedRoster&&!m.removedAt&&!viewingHistory&&team.state!=='cancelled'&&!(team.planReview?.scope==='initial'&&team.planReview.status!=='approved'))actions.append(iconAction('调整角色目标','编辑后用于后续派发，保留当前任务约定','edit',()=>memberGoals.open(m.id,'edit-member-goal:'+m.id),'edit-member-goal:'+m.id));
      const toolbar=node('div',undefined,'member-toolbar'),chips=node('div',undefined,'task-chips');chips.append(node('span',language.text('队长派发')),...assigned.map(t=>chip(t)));toolbar.append(chips,actions);item.append(toolbar);
      const history=node('details',undefined,'member-history');history.dataset.key='member:'+m.id;
      const summaryNode=node('summary',executions.length+language.text(' 次任务执行 · 查看轮次'));summaryNode.dataset.focusKey='history:'+m.id;history.append(summaryNode);
      for(const e of executions.toReversed()){
        const row=button(e.taskId+language.text(' · 第 ')+e.number+language.text(' 轮 · ')+label(e.status),()=>chooseTask(e.taskId,e.attemptId,true),'execution-row','attempt:'+e.attemptId);
        row.setAttribute('aria-pressed',String(ui.attemptId===e.attemptId));history.append(row);
      }
      if(executions.length)toolbar.append(history);return item;
    }));
    if(!visible.length)$('memberTree').append(node('p',ui.membersOpen?language.text('团队尚未登记成员'):language.text('所有成员本批工作已结束，展开可回看执行记录。'),'muted'));
  }
  function renderGraph(){
    const {team}=current,query=$('taskSearch').value.trim().toLowerCase(),status=$('taskStatusFilter').value;
    const matching=filteredTasks();
    const tasks=(query||status?matching:team.tasks.length>100?team.tasks.filter(t=>!['accepted','cancelled'].includes(t.status)).concat(team.tasks.filter(t=>['accepted','cancelled'].includes(t.status)).slice(-60)):matching).slice(-100),byId=new Map(tasks.map(t=>[t.id,t])),ranks=new Map(),rows=new Map(),positions=new Map();
    const cardWidth=160,cardHeight=76,columnStep=186,rowStep=88;
    function rank(id,seen=new Set()){if(ranks.has(id))return ranks.get(id);if(seen.has(id))return 0;seen.add(id);const t=byId.get(id),r=t?.dependencies.length?1+Math.max(...t.dependencies.map(d=>rank(d.taskId,new Set(seen)))):0;ranks.set(id,r);return r;}
    for(const t of tasks){const col=rank(t.id),row=rows.get(col)??0;positions.set(t.id,{x:col*columnStep,y:row*rowStep});rows.set(col,row+1);}
    const focused=ui.taskId,related=focused?dependencyFamily(tasks,focused):null,graph=$('dependencyGraph'),parallel=tasks.every(t=>!t.dependencies.length);
    $('dependencyTitle').textContent=parallel?language.text('并行任务'):language.text('任务依赖');
    $('dependencyHint').textContent=ui.taskId?language.text('已固定 ')+ui.taskId+language.text(' · 再次点击或 Escape 取消'):language.text('点击查看详情 · 前置满足后解锁');
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
      const h=node('div',undefined,'node-heading'),owner=team.members.find(m=>m.id===t.memberId),ownerLabel=owner?roleLabel(owner):t.memberId,ownerNode=node('span',ownerLabel);h.append(node('strong',taskNumbers.get(t.id)),ownerNode);b.append(h,node('div',t.title,'node-title'),node('small',label(taskState(t)),'node-status'));
      b.setAttribute('aria-label',taskNumbers.get(t.id)+' · '+t.id+' · '+t.title+' · '+ownerLabel+' · '+label(taskState(t)));b.setAttribute('aria-pressed',String(t.id===ui.taskId));
      b.dataset.selected=String(t.id===ui.taskId);b.dataset.related=String(!!related&&related.has(t.id));b.dataset.dimmed=String(!!related&&!related.has(t.id));
      graph.append(b);
    }
    if(!tasks.length)graph.append(node('p',language.text('没有符合条件的任务。'),'muted'));
    if(matching.length>tasks.length)$('dependencyHint').textContent+=language.text(' · 显示 ')+tasks.length+'/'+matching.length+language.text(' 项，可按任务号查找');
  }
  function syncInspection(){
    const visible=!$('taskDetail').hidden||!$('memberDetail').hidden;
    $('selectionPanel').hidden=!visible;
    $('workspaceContent').classList.toggle('has-selection',visible);
  }
  function clearNavigation(){
    const id=ui.navigationId,teamId=current?.team.id;ui.navigationId=null;ui.navigationError=null;navigation=null;navigationBusy=false;selectionGeneration++;
    if(id&&teamId)void call('cancel_team_navigation',{teamId,requestId:id}).catch(()=>{});
  }
  function chooseTask(id,attemptId=null,memberView=false){
    const task=current?.team.tasks.find(t=>t.id===id);if(!task)return;clearNavigation();
    const unpin=ui.taskId===id&&!attemptId&&!memberView;ui.taskId=unpin?null:id;ui.attemptId=unpin?null:attemptId;ui.memberId=unpin?null:task.attempts.find(a=>a.id===attemptId)?.memberId??task.memberId;
    ui.memberView=memberView;ui.overviewCollapsed=false;storeState();render();
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
    const task=current.team.tasks.find(t=>t.id===ui.taskId),box=$('taskDetail');box.hidden=!task;box.replaceChildren();if(!task)return;
    const member=current.team.members.find(m=>m.id===task.memberId),attempt=task.attempts.find(a=>a.id===ui.attemptId)??task.attempts.at(-1),relationship=taskRelationships(current.team,task);
    const head=node('div',undefined,'detail-heading');head.append(node('h2',task.id+' · '+task.title),node('span',label(taskState(task)),'status-pill '+taskState(task)));box.append(head);
    const actions=node('div',undefined,'detail-actions');actions.append(button(language.text('定位负责人 · ')+memberName(current.team,member),()=>locateMember(member.id),'subtle-button','locate:'+task.id),button(language.text('查看成员执行'),()=>{ui.taskId=task.id;chooseMember(member.id);},'subtle-button','member-detail:'+task.id));
    const executor=current.team.members.find(m=>m.id===(attempt?.memberId??member.id))??member;
    const open=button(language.text('打开对应 subagent'),()=>void requestNavigation(executor.id,task.id,attempt?.id),'subtle-button','task-open:'+task.id);open.disabled=!attempt?.agentThreadId;actions.append(open);if(open.disabled)actions.append(node('small',language.text('任务尚未绑定执行会话'),'muted'));if(ui.taskId)box.append(actions);
    const dl=node('dl'),field=(name,value)=>dl.append(node('dt',name),node('dd',value));field(language.text('负责人'),memberName(current.team,member));field(language.text('目标'),task.goal);field(language.text('验收'),task.acceptance);
    field(language.text('前置'),task.dependencies.map(d=>d.taskId+' '+(d.when==='accepted'?language.text('验收后'):language.text('提交后'))).join('；')||language.text('无，可并行执行'));
    field(language.text('等待条件'),relationship.waiting.length?relationship.waiting.map(d=>d.taskId+' · '+d.memberLabel+language.text(' · 等待')+(d.when==='accepted'?language.text('验收'):language.text('提交'))).join('；'):language.text('前置已满足'));
    field(language.text('完成后解锁'),relationship.downstream.map(d=>d.id+' · '+d.memberLabel+'（'+(d.when==='accepted'?language.text('验收后'):language.text('提交后'))+'）').join('；')||language.text('无后续依赖'));
    if(task.blockReason)field(language.text('阻塞原因'),task.blockReason);
    if(task.supersededBy)field(language.text('修复替代'),task.supersededBy+language.text('（原交付和审查证据保留）'));
    if(task.repairRound)field(language.text('审查轮次'),language.text('第 ')+task.repairRound+language.text(' 轮'));
    if(task.contract){field(language.text('阶段'),task.contract.stage);field(language.text('写入范围'),(task.contract.inScope??[]).join('；')||language.text('无'));field(language.text('排除范围'),(task.contract.outOfScope??[]).join('；')||language.text('无'));field(language.text('验证命令'),(task.contract.verify??[]).join('；')||language.text('源代码审查'));}
    for(const f of current.quality?.openFindings??[])if(f.rootTaskId===(task.repairRootTaskId??task.reviewOfTaskId??task.id))field(f.severity+' · '+f.id,f.description);
    const readiness=current.readiness?.find(r=>r.taskId===task.id);if(task.status==='waiting')field(language.text('派发条件'),readiness?.blockers.length?readiness.blockers.map(r=>r.message).join('；'):language.text('已就绪，等待 Leader 派发'));
    for(const criterion of task.acceptanceCriteria??[])field(criterion.id,criterion.description);
    box.append(dl);
    if(task.status==='submitted')box.append(node('p',language.text('成员已经交付；独立审查和 Leader 验收尚未完成。'),'muted'));
    if(attempt)box.append(node('p',language.text('所选执行：第 ')+attempt.number+language.text(' 轮 · ')+memberName(current.team,executor)+(attempt.id===task.attempts.at(-1)?.id&&task.memberId===executor.id?language.text(' · 当前轮次'):language.text(' · 历史轮次')),'muted'));
    for(const e of task.evidence){const el=node('div',undefined,'evidence');el.append(node('small',language.text('第 ')+e.attempt+language.text(' 轮交付')),node('p',cleanDelivery(e.summary)));box.append(el);}
    for(const cp of (current.checkpoints??[]).filter(c=>c.taskId===task.id).slice(-3).reverse()){
      const el=node('section',undefined,'evidence');el.append(node('small',language.text('进度检查点 · ')+(cp.source==='authenticated-member'?language.text('成员报告'):language.text('Leader 记录'))+(cp.stale?language.text(' · 历史轮次，需重新核对'):'')),node('p',cp.summary));
      for(const [title,values] of [[language.text('已定事项'),cp.decisions],[language.text('剩余工作'),cp.remainingWork],[language.text('证据'),cp.evidence]])if(values?.length){el.append(node('strong',title));const list=node('ul');for(const value of values)list.append(node('li',value));el.append(list);}
      for(const check of cp.validation??[])el.append(node('p',check.status+' · '+check.name+'：'+check.evidence));box.append(el);
    }
    const deliveryLabels={'queued':language.text('待 Leader 发送 · 重试前先核对'),'host-accepted':language.text('宿主已接收 · Leader 记录'),'unknown':language.text('送达未知 · 不自动重发'),'failed':language.text('发送失败'),'acknowledged':language.text('成员公开确认')};
    for(const message of (current.messages??[]).filter(m=>m.taskId===task.id)){const el=node('div',undefined,'evidence');el.append(node('small',(deliveryLabels[message.status]??message.status)+(message.stale?language.text(' · 历史轮次'):'')),node('p',message.text));box.append(el);}
    for(const r of current.runs.filter(r=>r.taskId===task.id))for(const message of r.messages??[]){const el=node('div',undefined,'evidence');el.append(node('small',message.delivery==='accepted-by-runtime'?language.text('执行端已接收 · 是否已读未知'):language.text('送达未确认')),node('p',message.text));box.append(el);}
    const raw=node('details');raw.dataset.key='task:'+task.id;raw.append(node('summary',current.displayLimits?.preview?language.text('执行标识与公开证据预览'):language.text('执行标识与原始公开证据')));
    const populate=()=>{if(raw.open&&!raw.querySelector('pre'))raw.append(node('pre',JSON.stringify({attempts:task.attempts,evidence:task.evidence,runs:current.runs.filter(r=>r.taskId===task.id)},null,2)));};raw.addEventListener('toggle',populate);box.append(raw);
    raw.open=ui.expanded.includes(raw.dataset.key);
    populate();
  }
  function renderMember(){
    const member=selectedMember(),box=$('memberDetail');box.hidden=!member||!ui.memberView;box.replaceChildren();if(box.hidden)return;
    const head=node('div',undefined,'detail-heading');head.append(node('h2',memberName(current.team,member)+language.text(' · subagent 执行')),button(language.text('返回团队'),()=>{ui.memberView=false;storeState();render();locateMember(member.id);},'subtle-button','back-team'));box.append(head);
    const tasks=current.team.tasks.filter(t=>t.memberId===member.id),chips=node('div',undefined,'member-task-list');chips.append(...tasks.map(t=>chip(t,true)));box.append(chips);
    const executions=memberExecutions(member,current.team.tasks,current.runs).toReversed(),attempt=executions.find(e=>e.attemptId===ui.attemptId)??executions.find(e=>e.taskId===ui.taskId)??executions[0];
    const list=node('div',undefined,'execution-tabs');list.setAttribute('role','group');list.setAttribute('aria-label',language.text('成员任务轮次'));
    for(const e of executions){const b=button(e.taskId+language.text(' · 第 ')+e.number+language.text(' 轮'),()=>chooseTask(e.taskId,e.attemptId,true),'subtle-button','execution-tab:'+e.attemptId);b.setAttribute('aria-pressed',String(attempt?.attemptId===e.attemptId));list.append(b);}box.append(list);
    const run=current.runs.find(r=>r.attemptId===attempt?.attemptId&&r.memberId===member.id);
    if(attempt){box.append(node('p',attempt.taskId+language.text(' · 第 ')+attempt.number+language.text(' 轮 · ')+label(attempt.status),'member-action'));
      if(run?.model)box.append(node('span',run.model,'model-tag'));
      if(run?.usage)box.append(node('small',language.text('本轮已观察 ')+run.usage.totalTokens+' tokens','muted'));
      if(run?.progress?.length||run?.activity?.events?.length){const live=node('div',undefined,'live-events');live.dataset.scrollKey='live:'+attempt.attemptId;live.append(node('strong',language.text('当前轮次 · 公开执行进度')));
        for(const p of run.progress??[])live.append(node('p',cleanDelivery(p.text)));
        for(const e of (run.activity?.events??[]).slice(-12)){if(e.command)live.append(node('pre',e.command));if(e.text)live.append(node('pre',e.text));if(e.type==='file_change')live.append(node('small',language.text('文件：')+e.paths.join('、')));}
        box.append(live);
      }
      for(const [index,output] of (run?.outputs??[]).entries()){const el=node('div',cleanDelivery(output.text),'public-output');el.dataset.scrollKey='output:'+attempt.attemptId+':'+index;box.append(el);}
      if(!run?.outputs?.length)box.append(node('p',attempt.active?language.text('正在执行，尚未提交最终结果。'):language.text('当前轮次没有可读取的公开最终输出。'),'muted'));
      const commands=node('details');commands.dataset.key='commands:'+attempt.attemptId;commands.append(node('summary',language.text('公开命令记录 · ')+(run?.commands?.length??0)));
      for(const command of run?.commands??[]){const line=node('div',undefined,'command-record');line.append(node('small',label(command.status)+language.text(' · 退出码 ')+(command.exitCode??language.text('未结束'))),node('pre',command.command));if(command.output)line.append(node('pre',command.output));commands.append(line);}box.append(commands);
    }else box.append(node('p',!member.agentThreadId?language.text('岗位已登记，等待 Leader 创建并绑定原生成员。'):member.rosterVerified===false?language.text('成员正在初始化，完成后可接收任务。'):language.text('成员已初始化，尚未执行任务。'),'muted'));
    box.append(node('p',language.text('执行上下文代次：')+(attempt?.contextGeneration??member.contextGeneration??1),'muted'));
    const actions=node('div',undefined,'detail-actions');const open=button(language.text('打开原生 subagent 会话'),()=>void requestNavigation(member.id,attempt?.taskId,attempt?.attemptId),'subtle-button','member-native');
    open.disabled=!attempt?.threadId&&(!member.agentThreadId||!member.rosterVerified);actions.append(open,button(language.text('返回主会话'),()=>void requestNavigation(member.id,attempt?.taskId,attempt?.attemptId,'leader'),'subtle-button','leader-native'));box.append(actions);
    box.append(node('p',language.text('这里按任务轮次展示公开结果。原生会话由宿主打开，宿主暂不支持定位到指定轮次。'),'muted'));
  }
  function renderNavigation(){
    const box=$('navigationState');box.replaceChildren();box.hidden=!navigation&&!navigationBusy;if(box.hidden)return;
    box.setAttribute('role',navigation?.error?'alert':'status');
    const texts={requested:language.text('正在打开会话…'),'host-accepted':language.text('已将会话跳转交给宿主'),opened:language.text('宿主导航工具已确认打开会话'),failed:language.text('导航失败'),superseded:language.text('已选择新的导航目标'),expired:language.text('导航请求已过期')};
    box.append(node('span',navigation?.error??(navigationBusy?language.text(navigation?.phase==='opening'?'正在打开会话…':'正在核对原生成员…'):texts[navigation?.request?.status]??language.text('等待宿主导航回执'))));
    if(navigation?.receiptError)box.append(node('small',language.text('跳转记录保存失败；不会自动重复跳转。')));
    if(navigation?.request?.status==='opened')box.append(node('small',language.text('任务和轮次已保留；此回执不代表宿主定位到了该轮次。')));
    if(navigation?.error||['failed','expired'].includes(navigation?.request?.status))box.append(button(language.text('重试导航'),()=>void requestNavigation(...navigation.args),'subtle-button','retry-navigation'));
  }
  async function requestNavigation(memberId,taskId,attemptId,destination='member'){
    const member=current?.team.members.find(m=>m.id===memberId);if(!member)return;
    clearNavigation();
    const teamId=current.team.id,generation=connectionGeneration,selection=selectionGeneration,args=[memberId,taskId,attemptId,destination];
    const valid=()=>generation===connectionGeneration&&selection===selectionGeneration&&current?.team.id===teamId;
    const cancel=data=>void call('cancel_team_navigation',{teamId,requestId:data.request.id}).catch(()=>{});
    navigationBusy=true;navigation={args};renderNavigation();
    let requestId,accepted=false;
    try{
      if(typeof app.openLink!=='function'||(app.getHostCapabilities&&!app.getHostCapabilities()?.openLinks))throw new Error(language.text('当前宿主不支持直接打开会话，请在面板内查看任务详情。'));
      const pending=await call('request_team_navigation',{teamId,memberId,...(taskId?{taskId}:{}),...(attemptId?{attemptId}:{}),destination,transport:'open-link',requestId:crypto.randomUUID()});
      if(!valid()){cancel(pending);return;}
      requestId=pending.request.id;navigation={...pending,args};ui.navigationId=requestId;ui.navigationError=null;storeState();
      const data=await call('read_team_navigation',{teamId,requestId});
      if(!valid()){cancel(data);return;}
      if(data.request.status!=='requested')throw new Error(language.text('导航请求不再有效，请重新选择成员'));
      const action=data.navigationAction,target=data.request.target,threadId=destination==='leader'?target.parentThreadId:target.threadId;
      if(!threadId||action?.type!=='open-native-thread'||action.threadId!==threadId||action.url!=='codex://threads/'+encodeURIComponent(threadId))throw new Error(language.text('宿主未返回有效的会话地址，请重新打开团队面板。'));
      navigation={...data,args,phase:'opening'};renderNavigation();
      const receipt=await app.openLink({url:action.url},{timeout:15000});
      if(!receipt||receipt.isError)throw new Error(language.text('宿主拒绝打开会话，请重试。'));
      accepted=true;
      if(valid()){navigation={...data,args,request:{...data.request,status:'host-accepted'}};ui.navigationError=null;storeState();renderNavigation();}
      try{
        const recorded=await call('record_team_navigation',{teamId,requestId,status:'host-accepted',note:'MCP Apps ui/open-link returned without error; page display and turn anchoring are not confirmed.'});
        if(valid())navigation={...recorded,args};
      }catch{if(valid())navigation={...navigation,receiptError:true};}
    }catch(e){if(valid()){
      navigation={...(navigation??{}),args,error:e.message};ui.navigationError=e.message;storeState();
      if(requestId&&!accepted)void call('record_team_navigation',{teamId,requestId,status:'failed',note:e.message}).catch(()=>{});
    }}
    finally{if(valid()){navigationBusy=false;renderNavigation();}}
  }
  async function refreshNavigation(generation){
    if(!ui.navigationId||navigationBusy||navigationRead||['host-accepted','opened','failed','superseded','expired'].includes(navigation?.request?.status))return;
    const read={generation};navigationRead=read;
    const id=ui.navigationId,teamId=current?.team.id,selection=selectionGeneration;
    try{const data=await call('read_team_navigation',{teamId,requestId:id});
      if(generation!==connectionGeneration||current?.team.id!==teamId||ui.navigationId!==id||selection!==selectionGeneration)return;
      const args=navigation?.args??[data.request.target.memberId,data.request.target.taskId,data.request.target.attemptId,data.request.target.destination];
      if(['host-accepted','opened','expired'].includes(data.request.status))ui.navigationError=null;
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
      }catch(e){if(request.generation===connectionGeneration&&targetTeamId===request.teamId)errorState(language.text('详情同步失败：')+e.message+language.text('；已收到的状态仍保留。'));}
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
      const old=oldTasks.get(fields.id)??{goal:language.text('详情同步中'),acceptance:language.text('详情同步中'),dependencies:[],attempts:[],evidence:[]};
      const attempts=old.attempts.map(a=>a.id===attempt?.id?{...a,...attempt}:a);
      if(attempt&&!attempts.some(a=>a.id===attempt.id))attempts.push({...attempt});
      return {...old,...fields,attempts,...(attempt?.number?{attempt:attempt.number}:{})};
    })??current.team.tasks;
    const team={...current.team,...data.team,tasks,members:data.team.members?.map(m=>({responsibility:'',writeScopes:[],...oldMembers.get(m.id),...m}))??current.team.members};
    if(team.state!=='delivered')delete team.finalAcceptance;
    const updates=new Map(data.runs.map(r=>[JSON.stringify([r.taskId,r.attemptId]),r]));
    const runs=current.runs.map(r=>{const key=JSON.stringify([r.taskId,r.attemptId]),update=updates.get(key);updates.delete(key);return {...r,...update};});runs.push(...updates.values());
    const stale=row=>team.tasks.find(t=>t.id===row.taskId)?.attempts.at(-1)?.id!==row.attemptId;
    current={...current,team,runs,stateDetailToken:data.detailToken,usage:data.usage??current.usage,workflow:data.workflow??current.workflow,readiness:data.readiness??current.readiness,observedAt:data.observedAt,observationMode:data.observationMode,latestStateAt:Math.max(current.latestStateAt??0,Date.parse(data.observedAt)||0),
      messages:current.messages?.map(m=>({...m,stale:stale(m)})),checkpoints:current.checkpoints?.map(c=>({...c,stale:stale(c)||(c.contractRevision??1)!==(team.tasks.find(t=>t.id===c.taskId)?.contractRevision??1)}))};
    validateSelection(team);
    if(before.team.revision!==team.revision||runSignature(before.runs)!==runSignature(runs)||JSON.stringify(before.usage)!==JSON.stringify(current.usage))render();
  }
  async function accept(data){
    if(!data)return;const generation=connectionGeneration;
    if(data.kind==='team-navigation'){if(data.request?.id===ui.navigationId){navigation={...data,args:navigation?.args};renderNavigation();}return;}
    if(data.kind==='team-workspace'){
      lastDiscovery=Date.now();$('projectName').textContent=data.context.cwd.split(/[\\/]/).filter(Boolean).at(-1);
      const teams=data.teams??[];$('teamSwitcher').hidden=true;if(viewingHistory&&current)return;
      targetTeamId=teams[0]?.id??null;
      if(teams[0]){const detail=await call('read_team',{teamId:teams[0].id,view:current?.team.id===teams[0].id?'state':'panel'});if(generation===connectionGeneration)await accept(detail);}
      else{memberGoals.close(false);clearNavigation();renderNavigation();current=null;$('goalDetails').hidden=true;$('teamBoard').hidden=true;$('emptyState').hidden=false;$('loadingState').hidden=true;$('collapsedSummary').hidden=true;}
    }
    if(['team-update','team-summary','team-state'].includes(data.kind)){
      if(current?.team.id===data.team.id&&data.team.revision<current.team.revision)return;
      if(data.kind==='team-state'){
        if(targetTeamId&&targetTeamId!==data.team.id)return;
        if(current?.team.id===data.team.id&&current.team.revision===data.team.revision&&(Date.parse(data.observedAt)||0)<(current.latestStateAt??0))return;
        applyState(data);void extras.observe();
      }
      const pending=data.kind!=='team-state'||current?.team.id!==data.team.id||!current?.detailToken||current.detailToken!==data.detailToken;
      if(pending)requestDetails(data);
      $('errorState').hidden=true;$('syncState').textContent=pending?language.text('状态已更新，详情同步中…'):language.text('最近成功同步 ')+new Date(data.observedAt).toLocaleTimeString()+language.text(' · 宿主公开执行记录快照');return;
    }
    if(data.kind==='team-detail'){
      if(current?.team.id===data.team.id&&data.team.revision<current.team.revision)return;
      targetTeamId=data.team.id;
      const changedTeam=current?.team.id!==data.team.id;
      let runs=data.runs??[];
      if(!changedTeam&&current.team.revision===data.team.revision&&(current.latestStateAt??0)>0&&current.latestStateAt>=(Date.parse(data.observedAt)||0))runs=runs.map(r=>({...r,...liveRun(current.runs.find(old=>old.taskId===r.taskId&&old.attemptId===r.attemptId))}));
      const same=!changedTeam&&current.team.revision===data.team.revision&&current.detailToken===data.detailToken&&runSignature(current.runs)===runSignature(runs);
      if(changedTeam){restoreState(data.team);navigation=null;selectionGeneration++;}else validateSelection(data.team);
      current={...data,runs,latestStateAt:Math.max(changedTeam?0:current?.latestStateAt??0,Date.parse(data.observedAt)||0)};
      if(!same)render();void extras.observe();$('errorState').hidden=true;$('loadingState').hidden=true;
      $('syncState').textContent=language.text('最近成功同步 ')+new Date(data.observedAt).toLocaleTimeString()+language.text(' · 宿主公开执行记录快照');
    }
  }
  async function poll(){
    if(!linked)return;if(polling){wakeRequested=true;return;}
    const generation=connectionGeneration,request={generation},started=performance.now();polling=request;clearTimeout(timer);
    try{if(!loading){const id=current?.team.id;const data=(!current||!viewingHistory&&Date.now()-lastDiscovery>30000)?await call('open_team_workspace'):await call('read_team',{teamId:id,view:'state'});
      if(linked&&generation===connectionGeneration&&(!id||current?.team.id===id))await accept(data);if(linked&&generation===connectionGeneration)void refreshNavigation(generation);}}
    catch(e){if(linked&&generation===connectionGeneration){loseLiveStatus(language.text('同步中断，执行状态待核对。'));errorState(language.text('同步中断：')+e.message);}}
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
  const onKey=e=>{if(e.key!=='Escape'||$('memberGoalEditor')?.open)return;if(actionTooltips.dismiss())return;if(!current)return;ui.taskId=null;ui.attemptId=null;ui.memberId=null;ui.memberView=false;clearNavigation();storeState();render();};
  const onInnerScroll=e=>{if(e.target?.dataset?.scrollKey)saveScroll();};
  const onVisible=()=>{if(!linked||document.hidden)return;clearTimeout(timer);if(loading)wakeRequested=true;else void poll();};
  window.addEventListener('scroll',saveScroll,{passive:true});$('dependencyGraph').parentElement.addEventListener('scroll',saveScroll,{passive:true});
  document.addEventListener('toggle',onToggle,true);document.addEventListener('keydown',onKey);
  document.addEventListener('scroll',onInnerScroll,true);
  document.addEventListener('visibilitychange',onVisible);window.addEventListener('focus',onVisible);
  $('toggleMembers').onclick=()=>{ui.membersOpen=!ui.membersOpen;storeState();render();};
  $('toggleOverview').onclick=()=>{ui.overviewCollapsed=!ui.overviewCollapsed;storeState();render();};
  $('retryConnection').onclick=()=>void reconnect();$('refreshTeam').onclick=()=>void reconnect();
  $('taskSearch').oninput=()=>{ui.query=$('taskSearch').value;storeState();if(current){renderTaskList();renderGraph();}};$('taskStatusFilter').onchange=()=>{ui.status=$('taskStatusFilter').value;storeState();if(current){renderTaskList();renderGraph();}};
  let report=null;
  async function showRecord(name,args={}){if(!current)return;const id=current.team.id,generation=connectionGeneration;try{const data=await call(name,{teamId:id,...args});if(id!==current?.team.id||generation!==connectionGeneration)return;const box=$('recordOutput');$('teamRecords').open=true;
    if(data.kind==='team-export'){report=data;box.textContent=data.text;$('downloadReport').hidden=false;}
    else if(data.kind==='team-recovery')box.textContent=data.members.map(m=>memberName(current.team,current.team.members.find(x=>x.id===m.memberId))+'：'+label(m.status)+' · '+(m.control?.status==='available'?language.text('原生控制已核对'):language.text('原生控制待核对'))).join('\n')+language.text('\n插件不会自动恢复模型轮次；请在原主会话核对现有成员的控制能力。');
    else box.textContent=JSON.stringify(data,null,2);
  }catch(error){$('feedback').textContent=language.text('记录读取失败：')+error.message;}}
  $('exportReport').onclick=()=>void showRecord('export_team_report');
  $('showRecovery').onclick=()=>void showRecord('read_team_recovery');
  $('showDiagnostics').onclick=()=>{if(current){$('teamRecords').open=true;$('recordOutput').textContent=(current.diagnostics?.stages??[]).map(s=>s.taskId+language.text(' · 预留到绑定 ')+(s.reservationToBindMs??language.text('未知'))+language.text(' ms · 执行 ')+(s.executionMs??language.text('未知'))+' ms').join('\n')||language.text('尚无可计算的执行时间记录。');}};
  $('downloadReport').onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([report.text],{type:report.mimeType})),a=document.createElement('a');a.href=url;a.download=report.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return {accept,setLanguage:value=>language.set(value),connect:async()=>{linked=true;const generation=++connectionGeneration;polling=null;detailsRequest=null;detailsWanted=null;navigationRead=null;wakeRequested=false;clearInterval(expiryTimer);expiryTimer=setInterval(expireActivity,1000);$('loadingState').hidden=!current;$('emptyState').hidden=true;
    try{const data=await call('open_team_workspace');if(linked&&generation===connectionGeneration)await accept(data);}
    catch(e){if(linked&&generation===connectionGeneration)errorState(e.message);}
    if(linked&&generation===connectionGeneration)void poll();
  },disconnect:()=>{linked=false;connectionGeneration++;selectionGeneration++;navigationBusy=false;polling=null;detailsRequest=null;detailsWanted=null;navigationRead=null;clearTimeout(timer);clearInterval(expiryTimer);loseLiveStatus(language.text('宿主连接中断，执行状态待核对。'));errorState(language.text('宿主连接中断，显示内容可能已过期。'));},
  close:()=>{memberGoals.close(false);actionTooltips.close();extras.close();language.close();saveScroll();linked=false;connectionGeneration++;detailsRequest=null;detailsWanted=null;clearTimeout(timer);clearInterval(expiryTimer);window.removeEventListener('scroll',saveScroll);$('dependencyGraph').parentElement.removeEventListener('scroll',saveScroll);document.removeEventListener('toggle',onToggle,true);document.removeEventListener('keydown',onKey);document.removeEventListener('scroll',onInnerScroll,true);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',onVisible);}};
}

// The editor lives outside the polling renderer so status updates cannot replace
// the user's draft, caret or focus. The server reads the unabridged goal on open.
function setupMemberGoalEditor({call,getData,getLanguage,readOnly,onSaved}){
  const $=id=>document.getElementById(id),dialog=$('memberGoalEditor'),input=$('memberGoalInput'),note=$('memberGoalNote'),save=$('memberGoalSave'),reload=$('memberGoalReload');
  const text=s=>getLanguage().text(s);
  let editor=null,feedback='';
  const valid=()=>{const team=getData()?.team;return editor&&team?.id===editor.teamId&&!readOnly()&&team.fixedRoster&&team.mode==='host-leader'&&!['superseded','cancelled'].includes(team.state)&&!(team.planReview?.scope==='initial'&&team.planReview.status!=='approved')&&team.members.some(m=>m.id===editor.memberId&&!m.removedAt);};
  const restore=key=>[...document.querySelectorAll('[data-focus-key]')].find(el=>el.dataset.focusKey===key)?.focus({preventScroll:true});
  function close(focus=true){const key=editor?.focusKey;editor=null;feedback='';if(dialog?.open)dialog.close();if(focus&&key)restore(key);}
  function controls(){
    if(!editor)return;const locked=editor.loading||editor.saving;
    input.disabled=locked;note.disabled=locked;reload.disabled=locked;
    save.disabled=locked||!editor.loaded||editor.stale||!input.value.trim()||input.value.length>2000||input.value.trim()===editor.goal;
    save.textContent=text(editor.saving?'正在保存…':'保存目标');
    $('memberGoalCount').textContent=input.value.length+' / 2000';
    $('memberGoalFeedback').textContent=text(feedback);
  }
  function translate(){
    for(const [id,label] of Object.entries({memberGoalTitle:'调整角色目标',memberGoalLabel:'角色目标',memberGoalNoteLabel:'修改说明（可选）',memberGoalHint:'保存后用于后续派发，当前任务继续按原约定执行。',memberGoalHistoryLabel:'修改记录',memberGoalCancel:'取消',memberGoalReload:'重新读取目标'}))$(id).textContent=text(label);
    if(editor?.loaded)$('memberGoalVersion').textContent=text('当前版本')+' '+editor.goalRevision;
    controls();
  }
  function history(rows){
    const box=$('memberGoalHistoryRows');box.replaceChildren();$('memberGoalHistory').hidden=!rows.length;
    for(const row of [...rows].reverse()){
      const item=document.createElement('article'),heading=document.createElement('strong'),why=document.createElement('p'),before=document.createElement('p'),after=document.createElement('p');
      heading.textContent='v'+row.previous.revision+' → v'+row.next.revision+' · '+new Date(row.at).toLocaleString(getLanguage().locale);
      why.textContent=row.note;before.textContent=text('修改前')+' · '+row.previous.goal;after.textContent=text('修改后')+' · '+row.next.goal;
      item.append(heading,why,before,after);box.append(item);
    }
  }
  async function load(){
    const attempt=editor;if(!valid()||attempt.loading||attempt.saving)return;
    attempt.loading=true;feedback='正在读取角色目标…';reload.hidden=true;controls();
    try{
      const data=await call('manage_team',{operation:'member-goal',teamId:attempt.teamId,memberId:attempt.memberId});
      if(editor!==attempt||!valid())return;
      if(data.kind!=='team-member-goal'||data.teamId!==attempt.teamId||data.memberId!==attempt.memberId||typeof data.goal!=='string'||!Number.isInteger(data.goalRevision)||!Number.isInteger(data.revision)||data.removed)throw new Error(text('角色目标数据无效，请重新读取。'));
      Object.assign(attempt,{loaded:true,goal:data.goal,goalRevision:data.goalRevision,readRevision:data.revision,stale:false,request:null});
      input.value=data.goal;note.value='';$('memberGoalRole').textContent=data.role;feedback='';history(data.history??[]);
    }catch(e){if(editor===attempt){feedback=e.message;reload.hidden=false;}}
    finally{if(editor===attempt){attempt.loading=false;translate();if(attempt.loaded)input.focus();}}
  }
  async function open(memberId,focusKey){
    close(false);const team=getData()?.team;if(!team)return;
    editor={teamId:team.id,memberId,focusKey,defaultNote:text('用户在团队面板调整角色目标'),loaded:false,loading:false,saving:false,stale:false,request:null};
    if(!valid()){close();return;}
    input.value='';note.value='';$('memberGoalRole').textContent=team.members.find(m=>m.id===memberId).role;$('memberGoalVersion').textContent='';$('memberGoalHistory').hidden=true;$('memberGoalHistory').open=false;
    translate();dialog.showModal();await load();
  }
  async function submit(event){
    event.preventDefault();if(!valid()||save.disabled)return;
    const attempt=editor,payload={memberId:attempt.memberId,goal:input.value.trim(),goalRevision:attempt.goalRevision,note:note.value.trim()||attempt.defaultNote,source:'panel-user-action'};
    const signature=JSON.stringify(payload);
    if(attempt.request?.signature!==signature)attempt.request={signature,requestId:crypto.randomUUID()};
    attempt.saving=true;feedback='';reload.hidden=true;controls();
    try{
      const data=await call('update_team_member_goal',{teamId:attempt.teamId,revision:Math.max(getData().team.revision,attempt.readRevision),requestId:attempt.request.requestId,...payload});
      if(editor!==attempt||!valid())return;
      if(data.kind!=='team-member-goal'||data.teamId!==attempt.teamId||data.memberId!==attempt.memberId||typeof data.goal!=='string'||!Number.isInteger(data.goalRevision)||!Number.isInteger(data.revision))throw new Error(text('保存结果未确认，请重试或重新读取目标。'));
      const key=attempt.focusKey;close(false);onSaved(data);restore(key);
    }catch(e){if(editor===attempt){feedback=e.message;reload.hidden=false;}}
    finally{if(editor===attempt){attempt.saving=false;controls();}}
  }
  function sync(){
    if(!editor)return;if(!valid()){close(false);return;}
    const member=getData().team.members.find(m=>m.id===editor.memberId);
    if(editor.loaded&&!editor.saving&&!editor.request&&(member.goalRevision??1)>editor.goalRevision){editor.stale=true;feedback='角色目标已被修改，草稿已保留。请重新读取最新目标后再编辑。';reload.hidden=false;}
    translate();
  }
  $('memberGoalForm').onsubmit=submit;$('memberGoalCancel').onclick=()=>close();reload.onclick=()=>void load();
  input.oninput=note.oninput=()=>controls();dialog.oncancel=e=>{e.preventDefault();close();};
  // Keep Escape scoped to this modal, including after its cancel handler closes it.
  dialog.onkeydown=e=>{if(e.key==='Escape')e.stopPropagation();};
  return {open,sync,close};
}

// One tooltip outside the cards avoids clipping and keeps the hover delay stable
// while live status renders replace the member controls.
function setupActionTooltips(){
  const tip=document.createElement('div'),heading=document.createElement('strong'),description=document.createElement('span');
  tip.id='action-tooltip-'+crypto.randomUUID();tip.className='action-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;tip.append(heading,description);document.body.append(tip);
  let key='',mode='',showTimer=null,hideTimer=null,dismissed='',owner=null,rendering=false;
  const wrapOf=target=>target instanceof Element?target.closest('.icon-action'):null;
  const keyOf=wrap=>wrap?.querySelector('button')?.dataset.focusKey;
  const find=()=>[...document.querySelectorAll('.icon-action')].find(wrap=>keyOf(wrap)===key);
  function hide(){clearTimeout(showTimer);clearTimeout(hideTimer);owner?.removeAttribute('aria-describedby');owner?.querySelector('button')?.removeAttribute('aria-describedby');owner=null;key='';mode='';tip.hidden=true;}
  function show(){
    const wrap=find(),rect=wrap?.getBoundingClientRect();if(!rect?.width||!rect.height){hide();return;}
    owner?.removeAttribute('aria-describedby');owner?.querySelector('button')?.removeAttribute('aria-describedby');owner=wrap;
    heading.textContent=wrap.dataset.tooltipLabel;description.textContent=wrap.dataset.tooltipDescription;
    tip.hidden=false;(wrap.tabIndex===0?wrap:wrap.querySelector('button')).setAttribute('aria-describedby',tip.id);
    const width=tip.offsetWidth,height=tip.offsetHeight;
    tip.style.left=Math.max(12,Math.min(rect.right-width,innerWidth-width-12))+'px';
    tip.style.top=(rect.top-height-8>=12?rect.top-height-8:Math.min(rect.bottom+8,innerHeight-height-12))+'px';
  }
  function begin(wrap,nextMode){
    const next=keyOf(wrap);if(!next||next===dismissed)return;clearTimeout(hideTimer);
    if(next===key){if(nextMode==='focus'){mode=nextMode;clearTimeout(showTimer);show();}return;}
    hide();key=next;mode=nextMode;if(mode==='focus')show();else showTimer=setTimeout(show,650);
  }
  const over=e=>{if(rendering||e.pointerType==='touch')return;if(tip.contains(e.target)){clearTimeout(hideTimer);return;}const wrap=wrapOf(e.target);if(wrap&&wrap!==wrapOf(e.relatedTarget))begin(wrap,'hover');};
  const out=e=>{
    if(rendering)return;const wrap=wrapOf(e.target);if(wrap&&!wrap.isConnected)return;
    if(!wrap&&!tip.contains(e.target))return;
    if(wrap&&wrap===wrapOf(e.relatedTarget)||tip.contains(e.relatedTarget))return;
    if(wrapOf(e.relatedTarget)&&keyOf(wrapOf(e.relatedTarget))===key)return;
    dismissed='';if(mode==='focus'&&owner?.contains(document.activeElement))return;
    if(tip.hidden){hide();return;}
    clearTimeout(hideTimer);hideTimer=setTimeout(hide,100);
  };
  const focus=e=>{if(rendering)return;const wrap=wrapOf(e.target);if(wrap&&e.target.matches(':focus-visible'))begin(wrap,'focus');};
  const blur=e=>{if(rendering||!e.target.isConnected)return;const wrap=wrapOf(e.target);if(wrap&&wrap!==wrapOf(e.relatedTarget)){dismissed='';if(mode==='focus')hide();}};
  const dismiss=()=>{if(!key)return false;dismissed=key;hide();return true;};
  const scroll=()=>{if(mode==='focus')show();else hide();},visibility=()=>{if(document.hidden)hide();},windowBlur=()=>hide();
  const listeners=[['pointerover',over],['pointerout',out],['focusin',focus],['focusout',blur],['pointerdown',dismiss],['click',dismiss],['scroll',scroll,true],['visibilitychange',visibility]];
  for(const [event,handler,capture] of listeners)document.addEventListener(event,handler,capture);
  window.addEventListener('blur',windowBlur);window.addEventListener('resize',scroll);
  return {dismiss,beforeRender(){rendering=true;},refresh(){rendering=false;if(key){if(!find())hide();else if(!tip.hidden)show();}},close(){hide();for(const [event,handler,capture] of listeners)document.removeEventListener(event,handler,capture);window.removeEventListener('blur',windowBlur);window.removeEventListener('resize',scroll);tip.remove();}};
}

// Additional controls share the existing revision-checked tools. Keeping forms
// outside the polling renderer preserves user edits during live updates.
function setupTeamExtras({app,call,getData,getTask,getLanguage,accept,switchTeam,editMemberGoal}){
  const $=id=>document.getElementById(id),text=s=>getLanguage().text(s),n=(tag,value)=>{const el=document.createElement(tag);if(value!==undefined){el.textContent=text(value);el.dataset.chromeText=getLanguage().source(value);}return el;};
  let closed=false,busy=false,enabled=false,lastSignal='',activeTeam=null,authorizationKey='',failedNotification=null,history=false;
  const message=s=>{$('teamManagementFeedback').textContent=text(s);};
  const btn=(label,fn)=>{const b=n('button',label);b.type='button';b.onclick=()=>void fn();return b;};
  const field=(box,title,value='',multiline=false)=>{const l=n('label',title),input=n(multiline?'textarea':'input');input.value=value??'';input.setAttribute('aria-label',text(title));input.dataset.chromeLabel=getLanguage().source(title);l.append(input);box.append(l);return input;};
  const select=(box,title,options,value)=>{const l=n('label',title),input=n('select');input.setAttribute('aria-label',text(title));input.dataset.chromeLabel=getLanguage().source(title);for(const [id,label] of options){const o=document.createElement('option');o.textContent=label;o.value=id;input.append(o);}input.value=value??options[0]?.[0]??'';l.append(input);box.append(l);return input;};
  const lines=s=>s.split('\n').map(s=>s.trim()).filter(Boolean);
  async function perform(name,args){
    if(busy)return;const id=getData()?.team.id;busy=true;
    try{const data=await call(name,args);if(id===getData()?.team.id){if(data.team)await accept(await call('read_team',{teamId:data.team.id,view:'panel'}));message(data.reused?text('当前项目已有团队，保留原团队。'):text('操作已保存。'));}return data;}
    catch(e){message(e.message);throw e;}finally{busy=false;}
  }
  async function notify(text){if(!app.sendMessage||!app.getHostCapabilities?.()?.message)throw new Error('Host message capability unavailable');const r=await app.sendMessage({role:'user',content:[{type:'text',text}]});if(r?.isError)throw new Error('Host rejected the notification');}
  async function observe(retryId){
    const data=getData();if(closed||history||!enabled||busy||!data)return;
    const identity=JSON.stringify([data.team.executionControl?.resumedAt,(data.workflow?.actions??[]).filter(a=>['settle','review-decision','claim-batch','final-validation'].includes(a.type)).map(a=>[a.type,a.taskId,a.attemptId,a.observedStatus,a.taskIds?.map(id=>{const t=data.team.tasks.find(t=>t.id===id);return [id,t?.memberId,t?.attempts.at(-1)?.id,t?.contractRevision];})])]);
    if(!retryId&&lastSignal===identity)return;lastSignal=identity;
    const teamId=data.team.id;
    try{const offer=await call('coordinate_team',{teamId,operation:'reserve',...(data.stateDetailToken||data.detailToken?{detailToken:data.stateDetailToken??data.detailToken}:{}),...(retryId?{retryId}:{})});if(closed||teamId!==getData()?.team.id)return;if(!offer.firstOffer){if(offer.notification&&['failed','unknown'].includes(offer.notification.status))failedNotification=offer.notification.id;return;}
      let status='host-accepted',note='Host accepted the workflow notification';
      try{await notify(offer.message);}catch(e){status='unknown';note=e.message;failedNotification=offer.notification.id;}
      await call('coordinate_team',{teamId,operation:'receipt',notificationId:offer.notification.id,status,note});
      $('teamCoordinationStatus').textContent=text(status==='host-accepted'?text('已通知 Leader 推进；等待真实执行记录。'):text('通知结果未知，未自动重发。可以显式重试。'));
    }catch(e){$('teamCoordinationStatus').textContent=e.message;}finally{$('teamNotificationRetry').hidden=!failedNotification;}
  }
  async function loadCoordination(){const id=getData()?.team.id;if(!id||history)return;try{const state=await call('coordinate_team',{teamId:id,operation:'status'});if(closed||id!==getData()?.team.id)return;enabled=state.enabled;failedNotification=state.notifications.findLast(n=>n.retryable||['unknown','failed'].includes(n.status))?.id??null;update(history);if(enabled)void observe();}catch{/* Older connections keep their existing controls. */}}
  function update(readOnly){
    history=readOnly;const data=getData();if(!data)return;$('teamOperations').hidden=readOnly||data.team.state==='cancelled'||data.team.planReview?.scope==='initial'&&data.team.planReview.status!=='approved';
    if(activeTeam!==data.team.id){activeTeam=data.team.id;authorizationKey='';enabled=false;failedNotification=null;lastSignal='';closeManagement();}const key=JSON.stringify([data.team.id,data.team.planReview?.status,data.team.planReview?.hash]);if(key!==authorizationKey){authorizationKey=key;if(data.team.coordinationSupported||data.team.requiresTeamWorkspaceVersion==='0.13.0')void loadCoordination();}
    $('teamAutoAdvance').textContent=text(enabled?text('关闭自动推进通知'):text('开启自动推进通知'));$('teamNotificationRetry').hidden=!failedNotification;
    if(!enabled)$('teamCoordinationStatus').textContent=text(text('开启后，面板仅在工作流需要推进时通知 Leader。关闭面板后依赖宿主原生通知。'));
  }
  $('teamAutoAdvance').onclick=async()=>{try{const id=getData().team.id;await call('coordinate_team',{teamId:id,operation:'enable',enabled:!enabled});if(id!==getData()?.team.id)return;enabled=!enabled;lastSignal='';update(history);if(enabled)void observe();}catch(e){message(e.message);}};
  $('teamNotificationCheck').onclick=()=>void loadCoordination();
  $('teamNotificationRetry').onclick=()=>{const id=failedNotification;failedNotification=null;void observe(id);};
  function closeManagement(restoreFocus=false){ $('teamManagementPanel').hidden=true;$('teamManageOpen').setAttribute('aria-expanded','false');if(restoreFocus)$('teamManageOpen').focus({preventScroll:true}); }
  $('teamManagementClose').onclick=()=>closeManagement(true);
  function manage(){
    const data=getData();if(!data||history)return;if(!$('teamManagementPanel').hidden){closeManagement(true);return;}
    $('teamManagementPanel').hidden=false;$('teamManageOpen').setAttribute('aria-expanded','true');
    const box=$('teamManagement');box.hidden=false;if(box.dataset.teamId===data.team.id&&box.childElementCount)return;box.dataset.teamId=data.team.id;box.replaceChildren();const team=data.team,args=()=>({teamId:team.id,revision:getData().team.revision});
    const modes=[['member-goal',text('调整角色目标')],['task',text('调整任务')],['add-task',text('追加交付与审查')],['add-member',text('新增岗位')],['remove-member',text('移除空闲岗位')],['contract',text('修订质量合同')],['revisions',text('查看合同修订')],['fallback',text('首次启动使用备用模型')]];
    const mode=select(box,text('管理操作'),modes.map(([k,v])=>[k,text(v)]),'task'),form=n('div');box.append(form);
    const run=(name,make)=>form.append(btn(text('保存操作'),async()=>{try{await perform(name,{...args(),...make()});}catch{}}));
    const members=team.members.filter(m=>!m.removedAt),roster=members.map(m=>[m.id,m.role+' · '+m.id]);
    function render(){form.replaceChildren();
      if(mode.value==='member-goal'){
        const member=select(form,text('目标岗位'),roster,getTask()?.memberId);
        form.append(btn(text('编辑角色目标'),()=>editMemberGoal(member.value)));return;
      }
      const note=field(form,text('操作原因'),'',true);
      if(mode.value==='add-member'){
        const id=field(form,text('岗位 ID')),role=field(form,text('岗位名称')),responsibility=field(form,text('岗位职责'),'',true),scopes=field(form,text('写入范围（每行一个）'),'',true);
        run('add_team_members',()=>({requestId:crypto.randomUUID(),members:[{id:id.value,role:role.value,responsibility:responsibility.value,reason:note.value,writeScopes:lines(scopes.value)}]}));
        form.append(n('p',text('新增岗位将进入范围变更确认；批准前不会创建成员。')));return;
      }
      if(mode.value==='remove-member'||mode.value==='fallback'){
        const member=select(form,text('目标岗位'),roster,getTask()?.memberId);
        run(mode.value==='fallback'?'manage_team':'remove_team_member',()=>({memberId:member.value,...(mode.value==='fallback'?{operation:'fallback',reason:note.value}:{note:note.value,requestId:crypto.randomUUID()})}));return;
      }
      if(mode.value==='add-task'){
        const id=field(form,text('交付任务 ID')),title=field(form,text('交付名称')),goal=field(form,text('交付目标'),'',true),acceptance=field(form,text('交付验收条件'),'',true),owner=select(form,text('实施岗位'),roster),reviewer=select(form,text('独立审查岗位'),members.filter(m=>!m.writeScopes.length).map(m=>[m.id,m.role]));
        const deps=field(form,text('前置验收任务 ID（每行一个）'),'',true),scope=select(form,text('是否扩大已授权范围'),[['false',text(text('沿用已有范围'))],['true',text(text('扩大范围，先确认'))]]);
        run('add_team_tasks',()=>({note:note.value,scopeChange:scope.value==='true',tasks:[{id:id.value,title:title.value,goal:goal.value,acceptance:acceptance.value,memberId:owner.value,priority:3,kind:'work',dependencies:lines(deps.value).map(taskId=>({taskId,when:'accepted'}))},{id:id.value+'_review',title:title.value+' · Review',goal:'Independently verify: '+goal.value,acceptance:acceptance.value,memberId:reviewer.value,priority:3,kind:'review',reviewOfTaskId:id.value,dependencies:[{taskId:id.value,when:'submitted'}]}]}));return;
      }
      const taskSelect=select(form,text('目标任务'),team.tasks.map(t=>[t.id,t.id+' · '+t.title]),getTask()?.id),details=n('div');form.append(details);
      function taskForm(){details.replaceChildren();const task=team.tasks.find(t=>t.id===taskSelect.value);if(!task)return;
        if(mode.value==='revisions'){
          details.append(btn(text('读取修订历史'),async()=>{try{const data=await call('manage_team',{operation:'contracts',teamId:team.id,taskId:task.id});const out=n('pre');out.textContent=JSON.stringify(data.amendments,null,2);details.append(out);}catch(e){message(e.message);}}));return;
        }
        if(mode.value==='contract'){
          const goal=field(details,text('合同目标'),task.goal,true),acceptance=field(details,text('合同验收条件'),task.acceptance,true),criteria=field(details,text('验收条目（ID: 描述，每行一个）'),(task.acceptanceCriteria??[]).map(c=>c.id+': '+c.description).join('\n'),true);
          const kind=select(details,text('合同阶段'),[['',text('保留现有阶段')],...['requirements','implementation','verification','review','repair','integration'].map(s=>[s,s])],task.contract?.stage??''),inside=field(details,text('合同写入范围'),(task.contract?.inScope??[]).join('\n'),true),outside=field(details,text('合同排除范围'),(task.contract?.outOfScope??[]).join('\n'),true),verify=field(details,text('验证命令'),(task.contract?.verify??[]).join('\n'),true),coverage=field(details,text('目标覆盖 ID'),(task.contract?.coverageOf??[]).join('\n'),true);
          details.append(n('p',text('运行中先停止并核实终态，已提交先返工；已通过的合同保持冻结。')));
          details.append(btn(text('提交合同修订'),async()=>{try{const patch={goal:goal.value,acceptance:acceptance.value};if(criteria.value.trim())patch.acceptanceCriteria=lines(criteria.value).map(line=>{const at=line.indexOf(':');if(at<1)throw new Error('Each criterion needs ID: description');return {id:line.slice(0,at).trim(),description:line.slice(at+1).trim()};});if(kind.value)patch.contract={stage:kind.value,inScope:lines(inside.value),outOfScope:lines(outside.value),verify:lines(verify.value),coverageOf:lines(coverage.value)};await perform('amend_team_task_contract',{...args(),taskId:task.id,requestId:crypto.randomUUID(),reason:note.value,patch});}catch(e){message(e.message);}}));return;
        }
        const owner=select(details,text('新负责人'),roster,task.memberId),priority=field(details,text('任务优先级'),task.priority),deps=field(details,text('依赖（任务 ID: submitted 或 accepted）'),task.dependencies.map(d=>d.taskId+': '+d.when).join('\n'),true);
        details.append(btn(text('保存任务调整'),async()=>{try{if(owner.value!==task.memberId)await perform('reassign_team_task',{...args(),taskId:task.id,memberId:owner.value,note:note.value,requestId:crypto.randomUUID()});await perform('edit_team_task',{...args(),taskId:task.id,patch:{priority:Number(priority.value),dependencies:lines(deps.value).map(line=>{const at=line.lastIndexOf(':');return {taskId:line.slice(0,at).trim(),when:line.slice(at+1).trim()};})}});}catch{}}));
      }
      taskSelect.onchange=taskForm;taskForm();
    }
    mode.onchange=render;render();
  }
  $('teamManageOpen').onclick=manage;
  async function library(){
    const box=$('teamLibrary');box.hidden=false;const actions=$('teamLibraryActions');actions.replaceChildren(btn(text('团队历史'),()=>showHistory()),btn(text('团队模板'),()=>showProfiles()),btn(text('返回当前团队'),async()=>{await switchTeam(null);box.hidden=true;}),btn(text('能力说明'),async()=>{try{const data=await call('manage_team',{operation:'capabilities'});const out=n('pre');out.textContent=JSON.stringify(data,null,2);$('teamLibraryContent').replaceChildren(out);}catch(e){message(e.message);}}),btn(text('关闭'),()=>{box.hidden=true;}));await showHistory();
  }
  async function showHistory(offset=0){
    const box=$('teamLibraryContent');if(!offset)box.replaceChildren();try{const data=await call('manage_team',{operation:'history',offset,limit:20});for(const row of data.teams){const b=btn(row.goal+' · '+row.state,async()=>{try{await switchTeam(row.readOnly?row.id:null);$('teamLibraryFeedback').textContent=text(row.readOnly?text('正在查看历史团队，控制操作已关闭。'):text('已返回当前团队。'));}catch(e){$('teamLibraryFeedback').textContent=e.message;}});b.dataset.chromeText='';box.append(b);}if(data.nextOffset!==null)box.append(btn(text('更多历史'),()=>showHistory(data.nextOffset)));}catch(e){$('teamLibraryFeedback').textContent=e.message;}
  }
  async function showProfiles(){
    const box=$('teamLibraryContent');box.replaceChildren();try{const data=await call('manage_team',{operation:'profiles'}),list=select(box,text('已有模板'),[['',text('新建模板')],...data.profiles.map(p=>[p.name,p.name+' · '+p.members])]),name=field(box,text('模板名称')),mode=select(box,text('任务规划方式'),[['leader',text('按当前目标动态规划')],['seed',text('固定任务图')]]),constraints=field(box,text('模板约束'),'',true),note=field(box,text('模板说明'),'',true),json=field(box,text('岗位与任务配置（JSON）'),'',true);let loaded=null;
      list.onchange=async()=>{try{if(!list.value)return;const d=await call('manage_team',{operation:'profile',name:list.value});loaded=d.profile;name.value=loaded.name;mode.value=loaded.taskPlanning;constraints.value=loaded.constraints??'';note.value=loaded.note;json.value=JSON.stringify(loaded.plan,null,2);}catch(e){message(e.message);}};
      box.append(btn(text('从当前审阅计划填入'),async()=>{try{const p=await call('read_team_plan',{teamId:getData().team.id});json.value=JSON.stringify(p.configuration.plan??{members:p.configuration.members,tasks:p.configuration.tasks},null,2);}catch(e){message(e.message);}}),btn(text('保存模板'),async()=>{try{const plan=JSON.parse(json.value);if(mode.value==='leader')delete plan.tasks;const saved=await perform('save_team_profile',{name:name.value,taskPlanning:mode.value,constraints:constraints.value,note:note.value,plan,...(loaded?.name===name.value?{expectedUpdatedAt:loaded.updatedAt}:{})});loaded=saved.profile;$('teamLibraryFeedback').textContent=text(text('模板已保存。'));}catch(e){$('teamLibraryFeedback').textContent=e.message;}}));
      let armed=false;const remove=btn(text('删除所选模板'),async()=>{try{if(!loaded)throw new Error('Select and read a saved profile first');if(!armed){armed=true;remove.textContent=text(text('确认删除所选模板'));return;}await call('manage_team',{operation:'delete-profile',name:loaded.name,updatedAt:loaded.updatedAt});await showProfiles();}catch(e){$('teamLibraryFeedback').textContent=e.message;}});box.append(remove);
      const goal=field(box,text('使用模板的任务目标'),getData()?.team.goal??'');box.append(btn(text('使用模板生成待审计划'),async()=>{try{const data=await perform('plan_team_from_profile',{name:name.value,goal:goal.value,execute:false,approvalMode:'required'});if(data?.kind==='team-planning-request'){await notify(text('按团队模板 ')+name.value+text(' 规划以下目标：')+goal.value+text('。调用 plan_team_from_profile 读取模板约束，设计任务与独立审查后提交待确认草案。不要自行批准。'));$('teamLibraryFeedback').textContent=text(text('已通知 Leader 按模板规划。'));}}catch(e){$('teamLibraryFeedback').textContent=e.message;}}));
    }catch(e){$('teamLibraryFeedback').textContent=e.message;}
  }
  $('teamLibraryOpen').onclick=()=>void library();
  return {update,observe,translate(){for(const el of document.querySelectorAll('[data-chrome-text]'))if(el.dataset.chromeText){const value=text(el.dataset.chromeText);if(el.firstChild?.nodeType===3)el.firstChild.textContent=value;}for(const el of document.querySelectorAll('[data-chrome-label]'))el.setAttribute('aria-label',text(el.dataset.chromeLabel));},close(){closed=true;}};
}

export function setupTeamLanguage(){
  const dictionary={
    '调整角色目标':'Edit role goal','编辑角色目标':'Edit role goal','角色目标':'Role goal','修改说明（可选）':'Change note (optional)','保存目标':'Save goal','正在保存…':'Saving…','重新读取目标':'Reload goal','当前版本':'Current version','修改记录':'Change history','修改前':'Before','修改后':'After','正在读取角色目标…':'Loading role goal…','保存后用于后续派发，当前任务继续按原约定执行。':'Applies to future dispatches. Current tasks keep their existing instructions.','编辑后用于后续派发，保留当前任务约定':'Edit the goal for future dispatches; current task instructions are preserved','用户在团队面板调整角色目标':'User edited the role goal in the team panel','角色目标数据无效，请重新读取。':'Invalid role goal data. Reload to continue.','保存结果未确认，请重试或重新读取目标。':'Save result is unconfirmed. Retry or reload the goal.','角色目标已被修改，草稿已保留。请重新读取最新目标后再编辑。':'The goal has changed. Your draft is preserved. Reload the latest goal before editing.',
    '团队工作台':'Team Workspace','当前目标':'Current goal','整体进度':'Overall progress','任务':'Tasks','运行说明':'Run notes','运行限制':'Execution limits','没有匹配的任务':'No matching tasks','当前仅显示前 100 项，请搜索或筛选更多任务。':'Showing the first 100 tasks. Search or filter for more.','刷新':'Refresh','展开完整目标':'Expand full goal','详情':'Details','关闭详情':'Close details','添加说明':'Add note','团队成员':'Team members','团队状态':'Team status','等待计划确认':'Awaiting plan approval',' 项任务需要处理':' tasks need attention',' 项任务执行中':' tasks running',' 项等待独立审查':' awaiting independent review',' 项等待派发':' awaiting dispatch','等待执行记录':'Awaiting execution records',' 项任务已就绪':' tasks ready','任务已结束，等待收尾':'Tasks settled, awaiting wrap-up','等待前置条件':'Awaiting dependencies','状态':'Status','当前关注':'Current focus','已就绪，等待派发':'Ready, awaiting dispatch','新任务派发已暂停':'Dispatch paused','查看详情':'View details',
    '停止':'Stop','继续执行':'Continue','正在提交…':'Submitting…','等待执行':'Awaiting execution','执行状态与操作':'Execution status and actions','操作说明（可选）':'Note (optional)','补充说明（可选）':'Add a note (optional)','恢复选项与说明':'Resume options and note','继续待执行任务':'Continue waiting tasks',' 项中断任务将重试':' stopped tasks will be retried','；可在恢复选项中调整。':'; adjust in resume options.','，保留已完成的交付。':'; completed deliveries are preserved.','停止会保留进度与交付记录。':'Stopping preserves progress and deliveries.','正在结束成员任务，进度与记录会保留。':'Ending member tasks. Progress and records will be preserved.','进度与交付记录已保留。':'Progress and deliveries have been preserved.',
    '查看计划':'View plan','收起计划':'Hide plan','团队计划':'Team plan','团队变更':'Team change','已读取确认记录。':'Approval record loaded.','更多设置':'More settings','用户在团队面板点击停止':'User clicked Stop in the team panel','用户在团队面板点击继续执行':'User clicked Continue in the team panel','正在通知主会话结束成员任务…':'Notifying the leader to end member tasks…','正在通知主会话继续执行…':'Notifying the leader to continue…','已发出停止通知，正在等待成员结束。':'Stop notification sent; waiting for members to finish.','已通知主会话继续执行。':'Leader notified to continue.',' 项任务将重试':' tasks will be retried','因停止而中断':'Interrupted by team stop',
    '历史与模板':'History & profiles','语言':'Language','刷新团队':'Refresh team','收起面板':'Collapse panel','切换团队':'Switch team','团队历史':'Team history','团队模板':'Team profiles','返回当前团队':'Current team','关闭':'Close','更多历史':'More history',
    '确认团队计划':'Review team plan','确认团队变更':'Review team change','等待确认':'Awaiting approval','已确认':'Approved','已取消':'Cancelled','确认并继续':'Approve and continue','保存修改':'Save changes','返回聊天修改':'Revise in chat','取消计划':'Discard plan','取消本次变更':'Discard change','重新读取计划':'Reload plan','查看计划详情':'View plan',
    '正在关联当前项目…':'Connecting to the current project…','停止或恢复原因':'Reason for stop or resume','请求停止团队':'Request team stop','按所选任务恢复':'Resume selected tasks','团队执行控制':'Team execution control','正在停止':'Stopping','团队已停止':'Team halted',
    '岗位已移除':'Role removed','待 Leader 派发':'Awaiting Leader dispatch','执行记录待更新':'Awaiting execution record','待执行':'Waiting','工作中':'Working','待审查':'Awaiting review','已验收':'Accepted','阻塞':'Blocked','待创建':'Not started','关联中':'Binding','待命':'Idle','状态未知':'Unknown','执行已结束':'Completed','执行中':'Running','执行失败':'Failed','已中断':'Interrupted',
    '任务目标':'Team goal','成员启动方式':'Member startup','首个任务就绪时创建':'Create on first ready task','先初始化全部成员':'Initialize all members first','最大并发':'Maximum concurrency','并发与执行预算':'Concurrency and budgets','Token 上限（留空表示不限）':'Token limit (blank for unlimited)','交接上下文字符数':'Handoff character budget','每项任务最大尝试次数':'Maximum attempts per task','最大审查修复轮数':'Maximum review rounds','自动生成修复任务':'Generate repair tasks','用量未知时阻止新派发':'Block dispatch when usage is unknown','允许，明确保留未知':'Allow; preserve unknown usage','阻止':'Block','开启（仍须独立审查）':'Enable (independent review required)',
    '读取宿主模型目录':'Load host models','读取模型目录中…':'Loading host models…','沿用宿主（计划保存模型快照）':'Inherit host (snapshot recorded in the plan)','沿用所选模型默认':'Selected model default','新增岗位':'Add role','新增交付与审查':'Add delivery and review',
    '管理岗位与任务':'Manage roles and tasks','开启自动推进通知':'Enable workflow notifications','关闭自动推进通知':'Disable workflow notifications','核对通知状态':'Check notification status','重试失败通知':'Retry failed notification','开启后，面板仅在工作流需要推进时通知 Leader。关闭面板后依赖宿主原生通知。':'When enabled, this panel notifies the Leader only when the workflow needs action. With the panel closed, native host notifications apply.','已通知 Leader 推进；等待真实执行记录。':'Leader notified; awaiting execution records.','通知结果未知，未自动重发。可以显式重试。':'Delivery is unknown. No automatic retry; you can retry explicitly.',
    '管理操作':'Operation','调整任务':'Edit task','追加交付与审查':'Add delivery and review','移除空闲岗位':'Remove idle role','修订质量合同':'Amend quality contract','查看合同修订':'Contract history','首次启动使用备用模型':'Use fallback before first start','操作原因':'Reason','保存操作':'Save operation','岗位 ID':'Role ID','岗位名称':'Role name','岗位职责':'Responsibility','写入范围（每行一个）':'Write scopes (one per line)','目标岗位':'Target role','新增岗位将进入范围变更确认；批准前不会创建成员。':'New roles require change approval; no member starts before approval.',
    '每个任务使用独立会话，已完成任务的原始上下文不会自动带入。':'Each task uses a separate session; completed task history is retrieved only when needed.','完整派发提示字符上限':'Complete dispatch prompt character limit','执行上下文代次：':'Execution context generation: ','交付任务 ID':'Delivery task ID','交付名称':'Delivery title','交付目标':'Delivery objective','交付验收条件':'Delivery acceptance','实施岗位':'Implementation role','独立审查岗位':'Independent reviewer','前置验收任务 ID（每行一个）':'Accepted dependencies (one task ID per line)','是否扩大已授权范围':'Expand approved scope?','沿用已有范围':'Keep approved scope','扩大范围，先确认':'Expand scope; request approval','目标任务':'Target task','读取修订历史':'Load contract history','合同目标':'Contract objective','合同验收条件':'Contract acceptance','验收条目（ID: 描述，每行一个）':'Acceptance criteria (ID: description, one per line)','合同阶段':'Contract stage','合同写入范围':'Contract write scope','合同排除范围':'Excluded paths','验证命令':'Verification commands','目标覆盖 ID':'Covered objective IDs','运行中先停止并核实终态，已提交先返工；已通过的合同保持冻结。':'Stop and verify running attempts; rework submitted tasks first. Passed contracts remain frozen.','提交合同修订':'Submit contract amendment','新负责人':'New assignee','任务优先级':'Task priority','依赖（任务 ID: submitted 或 accepted）':'Dependencies (task ID: submitted or accepted)','保存任务调整':'Save task changes',
    '已有模板':'Saved profiles','新建模板':'New profile','模板名称':'Profile name','任务规划方式':'Task planning','按当前目标动态规划':'Plan dynamically for this goal','固定任务图':'Fixed task graph','模板约束':'Profile constraints','模板说明':'Profile note','岗位与任务配置（JSON）':'Roles and tasks (JSON)','从当前审阅计划填入':'Copy current reviewed plan','保存模板':'Save profile','删除所选模板':'Delete selected profile','确认删除所选模板':'Confirm profile deletion','使用模板的任务目标':'Goal for this profile','使用模板生成待审计划':'Generate a plan for approval','模板已保存。':'Profile saved.','已通知 Leader 按模板规划。':'Leader notified to plan from the profile.',
    '正在查看历史团队，控制操作已关闭。':'Viewing archived team; controls are disabled.','已返回当前团队。':'Returned to the current team.','操作已保存。':'Operation saved.','当前项目已有团队，保留原团队。':'This project already has a team; its identity is preserved.','已返回聊天，等待你说明修改内容。':'Returned to chat; awaiting your requested changes.',
    '岗位':'Role','职责':'Responsibility','设置理由':'Reason','写入范围':'Write scopes','模型':'Model','思考档位':'Reasoning effort','备用模型':'Fallback model','任务名称':'Task title','验收条件':'Acceptance','负责岗位':'Assignee','搜索任务':'Search tasks','全部状态':'All statuses','查看成员执行':'View member execution','导出报告':'Export report','查看恢复信息':'Recovery information',
  };
  Object.assign(dictionary,{
  "状态读取失败": "Unable to read state",
  "宿主没有返回有效数据": "The host returned no valid data",
  "确认前保留原团队执行；变更确认只授权新范围，不代表任务验收。": "Existing approved work continues. Approval authorizes the new scope, not acceptance.",
  "确认前不会初始化成员或派发任务。确认后仍须独立审查与验收。": "No members or tasks start before approval. Independent review and acceptance remain required.",
  "计划授权与任务验收分别记录。": "Plan authorization and task acceptance are recorded separately.",
  "计划已变化，请等待面板同步后重新读取。": "The plan changed. Wait for synchronization and reload it.",
  "已读取完整计划。修改后请先保存，再确认新版本。": "Full plan loaded. Save edits before approving the new version.",
  "修改尚未保存；保存后将生成新的待确认版本。": "Unsaved changes. Saving creates a new version for approval.",
  " 个": " roles",
  " 项": " tasks",
  "任务": "Tasks",
  "新增任务": "New tasks",
  "岗位、职责与模型 · ": "Roles, responsibilities and models · ",
  "模型目录暂不可用：": "Model catalog unavailable: ",
  "。沿用已有路由；可以重新读取。": ". Existing routes are preserved; reload to retry.",
  "（待宿主核实）": " (pending host verification)",
  "（待核实）": " (unverified)",
  "不配置备用模型": "No fallback model",
  "计划模型快照：": "Frozen model route: ",
  "未知档位": "Unknown effort",
  "删除岗位 ": "Delete role ",
  "请先在任务中改派或删除该岗位的任务。": "Reassign or remove this role’s tasks first.",
  "最多 8 个活跃岗位。": "At most 8 active roles.",
  "新岗位": "New role",
  "请填写职责": "Enter responsibility",
  "请填写设置理由": "Enter the reason",
  "交付、验收与依赖 · ": "Deliveries, acceptance and dependencies · ",
  "优先级 ": "Priority ",
  "审查对象 ": "Review target ",
  "任务依赖 ": "Task dependencies ",
  "依赖 ": "Dependency ",
  "无依赖": "No dependencies",
  "等待提交": "Wait for submission",
  "等待验收": "Wait for acceptance",
  "逐项验收 ": "Acceptance criteria ",
  "包含路径": "Included paths",
  "排除路径": "Excluded paths",
  "覆盖目标": "Covered objectives",
  "删除任务 ": "Delete task ",
  "其他任务仍依赖此任务，请先调整依赖。": "Other tasks depend on this task. Update their dependencies first.",
  "新增交付与独立审查": "Add delivery and independent review",
  "最多 40 项待执行任务。": "At most 40 unfinished tasks.",
  "请先设置交付岗位和另一名只读审查岗位。": "Add an implementation role and a different read-only reviewer first.",
  "新交付": "New delivery",
  "请填写交付目标": "Enter the delivery objective",
  "请填写验收要求": "Enter acceptance requirements",
  "独立审查新交付": "Independently review the new delivery",
  "核实交付符合验收要求": "Verify the delivery against its acceptance requirements",
  "提供独立验证证据": "Provide independent verification evidence",
  "高级：完整配置 JSON": "Advanced: complete JSON configuration",
  "完整计划 JSON": "Complete plan JSON",
  "保留计划版本：": "Saved plan versions: ",
  "修改已保存，请审阅并确认第 ": "Changes saved. Review and approve version ",
  " 版。": ".",
  "保存失败：": "Save failed: ",
  "修改请求已保存；通知失败，请回主会话说“修改当前团队计划”。": "Revision request saved. Notification failed; ask the Leader to revise the current plan.",
  "计划已确认，正在通知主会话继续。": "Plan approved. Notifying the Leader.",
  "宿主未提供消息能力": "The host does not provide messaging",
  "宿主没有接受通知": "The host did not accept the notification",
  "计划已确认，已通知主会话继续；实际执行进度以成员记录为准。": "Plan approved and Leader notified. Member records show actual execution progress.",
  "计划已确认。请回到主会话说“继续执行已确认计划”；确认记录已保存。": "Approval saved. Ask the Leader to continue the approved plan.",
  "已取消本次": "Discarded this ",
  "变更；原团队继续沿用已有授权。": "change. Existing approved work continues.",
  "计划，未启动成员。": "plan. No members were started.",
  "操作未确认成功：": "Operation not confirmed: ",
  "。请重新读取当前计划；不要重复启动成员。": ". Reload the current plan; do not start duplicate members.",
  "正在停止：等待 Leader 中断并核实全部轮次": "Stopping: waiting for the Leader to interrupt and verify all turns",
  "团队已停止：宿主终态已核实": "Team halted: native terminal states verified",
  " 恢复时重试 ": " Retry on resume: ",
  "请填写停止或恢复原因。": "Enter a reason for stopping or resuming.",
  "停止请求已保存，正在通知主会话核实。": "Stop request saved. Notifying the Leader to verify it.",
  "恢复授权已保存，正在通知主会话。": "Resume authorization saved. Notifying the Leader.",
  "已通知主会话停止；实际停止以宿主终态核实为准。": "Leader notified to stop. The halt requires native terminal-state verification.",
  "已通知主会话按恢复记录继续。": "Leader notified to continue according to the resume record.",
  "停止请求已保存；通知失败，请回主会话说“执行已保存的团队停止请求”。": "Stop request saved. Notification failed; ask the Leader to execute the saved stop request.",
  "恢复记录已保存；通知失败，请回主会话说“继续已恢复的团队”。": "Resume saved. Notification failed; ask the Leader to continue the resumed team.",
  "操作失败：": "Operation failed: ",
  "已观察 ": "Observed ",
  " 轮用量未知": " turns with unknown usage",
  " / 预算 ": " / budget ",
  "当前主会话的固定团队 · ": "This conversation’s fixed team · ",
  "已完成本批验收": "Current batch accepted",
  "任务与成员执行": "Tasks and member execution",
  " 名成员": " members",
  " 已验收": " accepted",
  "已派发 ": "Dispatched ",
  " 项任务": " tasks",
  " 人执行中": " members running",
  " 项状态待核对": " states to verify",
  "当前无执行中的成员": "No members are running",
  " 名固定成员 · ": " fixed members · ",
  "展开团队": "Expand team",
  "工作区准备失败：": "Workspace preparation failed: ",
  "验证限制：": "Verification limitations: ",
  "面板显示有限预览": "This panel shows a bounded preview",
  " 项任务）": " tasks)",
  "；完整交付和命令请打开原生成员会话，验收时按任务读取原始证据。": "; open the native member conversation for full deliveries and commands. Read original evidence per task before acceptance.",
  "历史产物筛选记录 · ": "Historical artifact filter · ",
  "新任务派发已暂停 · ": "New dispatch paused · ",
  " 项就绪 · ": " ready · ",
  " 项等待前置条件": " waiting for prerequisites",
  "目标覆盖 ": "Objective coverage ",
  "未声明目标覆盖": "No declared objective coverage",
  " 次修复 · ": " repairs · ",
  " 项未关闭问题": " unresolved findings",
  "最近同步 ": "Last synchronized ",
  " · 公开执行记录快照": " · public execution snapshot",
  " · 部分状态待核对": " · some states need verification",
  " · 含历史岗位": " · includes historical roles",
  "收起已结束成员": "Collapse finished members",
  "展开已结束 ": "Expand finished members ",
  "展开全部": "Expand all",
  "打开原生会话": "Open native conversation",
  "成员尚未完成原生绑定": "Member is not yet bound to a native thread",
  "直接打开已有 subagent 会话；不会派发任务": "Open the existing subagent directly; no task is dispatched",
  "查看任务与执行": "View tasks and execution",
  "查看成员任务、交付与历史轮次": "Inspect member tasks, deliveries and past attempts",
  "队长派发": "Leader dispatch",
  " 次任务执行 · 查看轮次": " task executions · view attempts",
  " · 第 ": " · attempt ",
  " 轮 · ": " · ",
  "团队尚未登记成员": "No team members registered",
  "所有成员本批工作已结束，展开可回看执行记录。": "This batch has finished. Expand to inspect execution records.",
  "并行任务": "Parallel tasks",
  "任务依赖": "Task dependencies",
  "已固定 ": "Pinned ",
  " · 再次点击或 Escape 取消": " · click again or press Escape to unpin",
  "点击查看详情 · 前置满足后解锁": "Click for details · prerequisites unlock work",
  "没有符合条件的任务。": "No tasks match these filters.",
  " · 显示 ": " · showing ",
  " 项，可按任务号查找": " tasks; search by task ID",
  "定位负责人 · ": "Locate assignee · ",
  "打开对应 subagent": "Open this subagent",
  "负责人": "Assignee",
  "目标": "Objective",
  "验收": "Acceptance",
  "前置": "Prerequisites",
  "验收后": "After acceptance",
  "提交后": "After submission",
  "无，可并行执行": "None; can run in parallel",
  "等待条件": "Waiting conditions",
  " · 等待": " · waiting for ",
  "提交": "submission",
  "前置已满足": "Prerequisites satisfied",
  "完成后解锁": "Unlocks after completion",
  "无后续依赖": "No downstream dependencies",
  "阻塞原因": "Block reason",
  "修复替代": "Replaced by repair",
  "（原交付和审查证据保留）": " (original delivery and review evidence preserved)",
  "审查轮次": "Review round",
  " 轮": " attempts",
  "阶段": "Stage",
  "无": "None",
  "排除范围": "Excluded scope",
  "源代码审查": "Source review",
  "派发条件": "Dispatch conditions",
  "已就绪，等待 Leader 派发": "Ready; awaiting Leader dispatch",
  "成员已经交付；独立审查和 Leader 验收尚未完成。": "Member delivered; independent review and Leader acceptance are pending.",
  "所选执行：第 ": "Selected execution: attempt ",
  " · 当前轮次": " · current attempt",
  " · 历史轮次": " · historical attempt",
  " 轮交付": " delivery",
  "进度检查点 · ": "Progress checkpoint · ",
  "成员报告": "Member report",
  "Leader 记录": "Leader record",
  " · 历史轮次，需重新核对": " · historical attempt; verify again",
  "已定事项": "Decisions",
  "剩余工作": "Remaining work",
  "证据": "Evidence",
  "待 Leader 发送 · 重试前先核对": "Awaiting Leader delivery · verify before retry",
  "宿主已接收 · Leader 记录": "Host accepted · recorded by Leader",
  "送达未知 · 不自动重发": "Delivery unknown · no automatic resend",
  "发送失败": "Delivery failed",
  "成员公开确认": "Member publicly acknowledged",
  "执行端已接收 · 是否已读未知": "Execution backend accepted · read status unknown",
  "送达未确认": "Delivery not confirmed",
  "执行标识与公开证据预览": "Execution identity and public evidence preview",
  "执行标识与原始公开证据": "Execution identity and original public evidence",
  " · subagent 执行": " · subagent execution",
  "返回团队": "Back to team",
  "成员任务轮次": "Member task attempts",
  "本轮已观察 ": "Observed this attempt: ",
  "当前轮次 · 公开执行进度": "Current attempt · public progress",
  "文件：": "Files: ",
  "正在执行，尚未提交最终结果。": "Running; no final result submitted.",
  "当前轮次没有可读取的公开最终输出。": "No public final output is available for this attempt.",
  "公开命令记录 · ": "Public command records · ",
  " · 退出码 ": " · exit code ",
  "未结束": "Not finished",
  "岗位已登记，等待 Leader 创建并绑定原生成员。": "Role registered; waiting for the Leader to create and bind its native member.",
  "成员正在初始化，完成后可接收任务。": "Member initializing; tasks can start when initialization finishes.",
  "成员已初始化，尚未执行任务。": "Member initialized; no tasks executed yet.",
  "打开原生 subagent 会话": "Open native subagent conversation",
  "返回主会话": "Back to Leader",
  "这里按任务轮次展示公开结果。原生会话由宿主打开，宿主暂不支持定位到指定轮次。": "Public results are organized by attempt here. The host opens native conversations but does not support attempt anchors.",
  "正在打开会话…": "Opening conversation…",
  "已将会话跳转交给宿主": "Conversation link accepted by the host",
  "跳转记录保存失败；不会自动重复跳转。": "Could not save the navigation receipt; navigation will not repeat automatically.",
  "宿主导航工具已确认打开会话": "The host navigation tool confirmed the conversation opened",
  "导航失败": "Navigation failed",
  "已选择新的导航目标": "A new navigation target was selected",
  "导航请求已过期": "Navigation request expired",
  "正在核对原生成员…": "Verifying native member…",
  "等待宿主导航回执": "Waiting for host navigation receipt",
  "任务和轮次已保留；此回执不代表宿主定位到了该轮次。": "Task and attempt selection preserved. This receipt does not prove the host navigated to that attempt.",
  "重试导航": "Retry navigation",
  "当前宿主不支持直接打开会话，请在面板内查看任务详情。": "This host cannot open conversations directly. Task details remain available in the panel.",
  "宿主未返回有效的会话地址，请重新打开团队面板。": "No valid conversation address was returned. Reopen the team panel.",
  "任务尚未绑定执行会话": "Task is not yet bound to an execution thread",
  "导航请求不再有效，请重新选择成员": "Navigation request is no longer valid; select the member again",
  "宿主拒绝打开会话，请重试。": "The host rejected the conversation link; retry explicitly.",
  "详情同步失败：": "Detail synchronization failed: ",
  "；已收到的状态仍保留。": "; previously received state is preserved.",
  "详情同步中": "Synchronizing details",
  "状态已更新，详情同步中…": "State updated; synchronizing details…",
  "最近成功同步 ": "Last successful synchronization ",
  " · 宿主公开执行记录快照": " · native public execution snapshot",
  "同步中断，执行状态待核对。": "Synchronization interrupted; execution state needs verification.",
  "同步中断：": "Synchronization interrupted: ",
  "原生控制已核对": "Native control verified",
  "原生控制待核对": "Native control unverified",
  "记录读取失败：": "Unable to read records: ",
  " · 预留到绑定 ": " · reservation to binding ",
  "未知": "Unknown",
  " ms · 执行 ": " ms · execution ",
  "尚无可计算的执行时间记录。": "No execution timing records are available yet.",
  "宿主连接中断，执行状态待核对。": "Host connection lost; execution state needs verification.",
  "宿主连接中断，显示内容可能已过期。": "Host connection lost; displayed content may be stale.",
  "保留现有阶段": "Keep existing stage"
});
  Object.assign(dictionary,{"重新连接": "Reconnect", "团队跟随当前对话": "The team follows this conversation", "当前主会话担任 Leader，成员接受任务，这里显示团队执行。": "This conversation is the Leader. Members receive tasks; their execution appears here.", "确认只授权执行；任务仍须独立审查与验收。": "Approval authorizes execution. Independent review and acceptance remain required.", "队": "T", "主会话 · Leader": "Current conversation · Leader", "拆解 · 派发 · 汇总": "Plan · dispatch · integrate", "总进度": "Overall progress", "受阻": "Blocked", "用量与运行记录": "Usage and execution records", "查看耗时": "View timings", "查看接续状态": "View recovery", "保存报告": "Save report", "成员": "Members", "收起": "Collapse", "能力说明": "Capability details"});
  const reverse=new Map(Object.entries(dictionary).map(([a,b])=>[b,a]));
  let initialized=false,locale='zh-CN';try{locale=localStorage.getItem('team-workspace:locale')==='en'?'en':'zh-CN';}catch{}
  const attributes=[...document.querySelectorAll('[aria-label],[placeholder]')].flatMap(el=>['aria-label','placeholder'].filter(a=>dictionary[el.getAttribute(a)]).map(a=>[el,a,el.getAttribute(a)]));
  const originals=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let item;
  // Capture only initial HTML chrome, before any project data is rendered.
  while((item=walker.nextNode()))if(!['SCRIPT','STYLE'].includes(item.parentElement?.tagName)&&dictionary[item.textContent.trim()])originals.push([item,item.textContent]);
  const api={get locale(){return locale;},onchange:null,source:value=>locale==='en'?(reverse.get(String(value))??String(value)):String(value),text(value){const source=String(value??'');if(locale!=='en')return source;if(dictionary[source])return dictionary[source];const match=/^(岗位|职责|设置理由|写入范围|模型|思考档位|备用模型|任务名称|任务目标|验收条件|负责岗位) (.+)$/.exec(source);return match?(dictionary[match[1]]+' '+match[2]):source;},set(value){const next=String(value).toLowerCase().startsWith('en')?'en':'zh-CN';if(initialized&&next===locale)return;initialized=true;locale=next;document.documentElement.lang=locale;try{localStorage.setItem('team-workspace:locale',locale);}catch{}for(const [el,source] of originals)el.textContent=locale==='en'?dictionary[source.trim()]:source;for(const [el,a,source] of attributes)el.setAttribute(a,locale==='en'?dictionary[source]:source);const select=document.getElementById('teamLocale');if(select)select.value=locale;api.onchange?.();},close(){}};
  const select=document.getElementById('teamLocale');if(select)select.onchange=()=>api.set(select.value);api.set(locale);return api;
}
