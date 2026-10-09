// Actual Chrome + shipping UI with explicitly controlled protocol fixtures.
// These are interaction regressions, not Desktop/native execution evidence.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
let server,browser,url;
const dir='evidence/interaction-v0.7.0';
const task=(id,memberId,status,dependencies=[],attempts=[])=>({id,memberId,status,dependencies,attempts,title:'任务 '+id,goal:'明确目标 '+id,acceptance:'验证 '+id,evidence:[]});
const attempt=(id,number,endedAt)=>({id,number,agentThreadId:'dev-thread',turnId:'turn-'+id,state:'submitted',startedAt:'2026-10-07T01:00:00Z',endedAt});
function fixture(){return {kind:'team-detail',observedAt:new Date().toISOString(),team:{id:'fixture-team',mode:'host-leader',projectPath:'E:/interaction-fixture',leaderThreadId:'fixture-leader',goal:'交互回归样例（受控协议数据）',revision:1,state:'active',dispatchPaused:false,
 members:[{id:'dev',role:'开发成员',responsibility:'实现功能',rosterVerified:true,agentThreadId:'dev-thread'},{id:'qa',role:'审查成员',responsibility:'独立验证',rosterVerified:true,agentThreadId:'qa-thread'},{id:'finished',role:'已结束成员',responsibility:'历史工作',rosterVerified:true,agentThreadId:'finished-thread'}],
 tasks:[task('t1','dev','submitted',[],[attempt('old-attempt',1,'2026-10-07T01:01:00Z'),attempt('new-attempt',2,'2026-10-07T01:05:00Z')]),
 task('t2','qa','waiting',[{taskId:'t1',when:'submitted'}]),task('t3','dev','waiting',[{taskId:'t2',when:'accepted'}]),task('sibling','qa','waiting',[{taskId:'t1',when:'accepted'}]),
 task('t4','qa','waiting',[{taskId:'t3',when:'accepted'}]),task('t5','dev','waiting',[{taskId:'t4',when:'accepted'}]),task('done','finished','accepted',[],[{...attempt('done-attempt',1,'2026-10-07T01:08:00Z'),agentThreadId:'finished-thread'}])]},
 runs:[{taskId:'t1',memberId:'dev',attemptId:'old-attempt',threadId:'dev-thread',status:'completed',connection:'snapshot',outputs:[{text:'第一轮公开结果'}],commands:[{command:'node old-test.mjs',status:'completed',exitCode:0}]},
 {taskId:'t1',memberId:'dev',attemptId:'new-attempt',threadId:'dev-thread',status:'completed',connection:'snapshot',outputs:[{text:'第二轮公开结果'}],commands:[]}],readiness:[{taskId:'t2',ready:true,blockers:[]},{taskId:'t3',ready:false,blockers:[{message:'等待 t2 验收'}]}]};}
before(async()=>{const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
 server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}
 res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});await mkdir(dir,{recursive:true});});
after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
async function open(options={}){
 const page=await browser.newPage({viewport:{width:1000,height:900},...options});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await boot(page);return {page,errors};
}
async function boot(page){
 await page.evaluate(async data=>{
  const {setupTeamView}=await import('/team-view.mjs');window.data=data;window.calls=[];window.sent=[];window.navStatus='requested';window.links=[];window.linkCapability=true;window.rejectLink=false;window.rejectMessage=false;window.failRead=false;
  window.view=setupTeamView({getHostCapabilities:()=>({message:{},...(window.linkCapability?{openLinks:{}}:{})}),async openLink(link){window.links.push(link);if(window.holdLink)await new Promise(r=>window.releaseLink=r);return {isError:window.rejectLink};},async sendMessage(message){window.sent.push(message);return {isError:window.rejectMessage};},
   async callServerTool({name,arguments:args}){window.calls.push({name,args});
    if(window.failRead&&['read_team','open_team_workspace'].includes(name))return {isError:true,content:[{type:'text',text:'fixture disconnect'}]};
    if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:window.data.team.projectPath},teams:[{id:window.data.team.id}]}};
    if(name==='read_team')return {structuredContent:structuredClone(window.data)};
    if(name==='manage_team'&&args.operation==='member-goal'){
     if(window.holdGoalRead)await new Promise(r=>window.releaseGoalRead=r);
     const m=window.data.team.members.find(m=>m.id===args.memberId);return {structuredContent:{kind:'team-member-goal',teamId:window.data.team.id,revision:window.data.team.revision,memberId:m.id,role:m.role,goal:window.fullGoal??m.responsibility,goalRevision:m.goalRevision??1,history:window.goalHistory??[]}};
    }
    if(name==='update_team_member_goal'){
     if(window.holdGoalSave)await new Promise(r=>window.releaseGoalSave=r);
     if(window.failGoalSave)throw new Error('目标保存失败，草稿未丢失');
     const m=window.data.team.members.find(m=>m.id===args.memberId),prior=window.goalRequests?.[args.requestId];
     if(!prior){if((m.goalRevision??1)!==args.goalRevision||window.data.team.revision!==args.revision)throw new Error('角色目标已被其他操作修改，请重新读取后再保存');
      const row={previous:{revision:m.goalRevision??1,goal:m.responsibility},next:{revision:args.goalRevision+1,goal:args.goal},at:new Date().toISOString(),note:args.note};
      (window.goalHistory??=[]).push(row);m.responsibility=args.goal;m.goalRevision=args.goalRevision+1;window.data.team.revision++;window.fullGoal=null;(window.goalRequests??={})[args.requestId]=row;
     }
     if(window.loseGoalReply){window.loseGoalReply=false;throw new Error('保存结果未知，请重试');}
     return {structuredContent:{kind:'team-member-goal',teamId:window.data.team.id,revision:window.data.team.revision,memberId:m.id,role:m.role,goal:m.responsibility,goalRevision:m.goalRevision,change:{replayed:!!prior}}};
    }
    if(name==='request_team_navigation'){if(window.holdNavigation)await new Promise(r=>window.releaseNavigation=r);
     window.lastNavigation={kind:'team-navigation',request:{id:args.requestId,status:'requested',target:{...args,memberLabel:'interaction-fixture-开发成员',threadId:window.data.team.tasks.find(t=>t.id===args.taskId)?.attempts.find(a=>a.id===args.attemptId)?.agentThreadId??window.data.team.members.find(m=>m.id===args.memberId).agentThreadId,parentThreadId:'fixture-leader'},transport:args.transport}};const target=window.lastNavigation.request.target;window.lastNavigation.navigationAction={type:'open-native-thread',threadId:args.destination==='leader'?target.parentThreadId:target.threadId,url:'codex://threads/'+encodeURIComponent(args.destination==='leader'?target.parentThreadId:target.threadId)};window.navStatus='requested';window.lastNavigation={...window.lastNavigation};
     return {structuredContent:structuredClone(window.lastNavigation)};}
    if(name==='record_team_navigation'){if(window.failNavigationRecord)throw new Error('receipt unavailable');window.navStatus=args.status;window.lastNavigation.request.status=args.status;return {structuredContent:structuredClone(window.lastNavigation)};}
    if(name==='read_team_navigation'){if(window.holdNavigationRead)await new Promise(r=>window.releaseNavigationRead=r);return {structuredContent:{...window.lastNavigation,request:{...window.lastNavigation.request,status:window.navStatus}}};}
    return {structuredContent:{kind:'team-navigation',request:{id:args.requestId,status:'superseded'}}};
   }});
  await window.view.connect();
 },fixture());
 await expect(page.locator('#projectName')).toHaveText('interaction-fixture');
}
async function update(page){await page.evaluate(async()=>{window.data.team.revision++;await window.view.accept(structuredClone(window.data));});}
async function enableGoals(page){await page.evaluate(()=>{window.data.team.fixedRoster=true;});await update(page);}
test('manual role goal editor reads the full goal, preserves a draft through refresh, and saves without navigation or messages',async()=>{
 const {page,errors}=await open();try{
  await enableGoals(page);await page.locator('[data-task-id="t1"]').click();
  await page.evaluate(()=>{window.fullGoal='完整目标：'+ '目标原文'.repeat(100);window.data.team.members[0].responsibility='面板预览…';});await update(page);
  const edit=page.locator('[data-focus-key="edit-member-goal:dev"]'),input=page.locator('#memberGoalInput'),modal=page.getByRole('dialog');
  await expect(edit).toHaveAccessibleName('调整角色目标');await edit.click();await expect(modal).toBeVisible();await expect(input).toHaveValue('完整目标：'+'目标原文'.repeat(100));
  await expect(page.locator('#memberGoalSave')).toBeDisabled();await input.fill('聚焦任务质量和可维护性');await input.evaluate(el=>el.setSelectionRange(3,6));
  await update(page);await expect(input).toHaveValue('聚焦任务质量和可维护性');assert.deepEqual(await input.evaluate(el=>[el.selectionStart,el.selectionEnd]),[3,6]);await expect(input).toBeFocused();
  await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:dir+'/member-goal-edit-mobile.png',fullPage:true});
  await page.locator('#memberGoalNote').fill('加强质量要求');await page.locator('#memberGoalSave').click();await expect(modal).toBeHidden();await expect(edit).toBeFocused();
  await expect(page.locator('[data-member-id="dev"] .responsibility')).toContainText('聚焦任务质量和可维护性');await expect(page.locator('#taskDetail')).toContainText('任务 t1');
  const actions=await page.evaluate(()=>({sent:window.sent.length,links:window.links.length,saves:window.calls.filter(c=>c.name==='update_team_member_goal')}));assert.equal(actions.sent,0);assert.equal(actions.links,0);assert.equal(actions.saves.length,1);assert.equal(actions.saves[0].args.source,'panel-user-action');assert.equal(actions.saves[0].args.goalRevision,1);
  await edit.click();await expect(input).toHaveValue('聚焦任务质量和可维护性');await page.locator('#memberGoalHistoryLabel').click();await expect(page.locator('#memberGoalHistoryRows')).toContainText('加强质量要求');await expect(page.locator('#memberGoalHistoryRows')).toContainText('v1 → v2');
  await input.fill('不保存的草稿');await page.keyboard.press('Escape');await expect(modal).toBeHidden();await expect(page.locator('#taskDetail')).toBeVisible();await edit.click();await expect(input).toHaveValue('聚焦任务质量和可维护性');
  await page.locator('#memberGoalCancel').click();await page.locator('#teamLocale').selectOption('en');await edit.click();await expect(modal).toHaveAccessibleName('Edit role goal');await expect(input).toHaveValue('聚焦任务质量和可维护性');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('conflicting role edits keep the draft and require explicit reload; unknown saves retry the same UUID once',async()=>{
 const {page,errors}=await open();try{
  await enableGoals(page);await page.locator('[data-focus-key="edit-member-goal:dev"]').click();const input=page.locator('#memberGoalInput'),save=page.locator('#memberGoalSave');await input.fill('人工草稿');
  await page.evaluate(()=>{window.data.team.members[0].responsibility='外部新目标';window.data.team.members[0].goalRevision=2;});await update(page);
  await expect(input).toHaveValue('人工草稿');await expect(save).toBeDisabled();await expect(page.locator('#memberGoalFeedback')).toContainText('草稿已保留');await page.locator('#memberGoalReload').click();await expect(input).toHaveValue('外部新目标');
  await input.fill('新目标第三版');await page.evaluate(()=>{window.holdGoalSave=true;window.loseGoalReply=true;});await save.click();await page.evaluate(()=>document.getElementById('memberGoalForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='update_team_member_goal').length),1);
  await page.evaluate(()=>{window.holdGoalSave=false;window.releaseGoalSave();});await expect(page.locator('#memberGoalFeedback')).toContainText('保存结果未知');await update(page);await expect(input).toHaveValue('新目标第三版');await expect(save).toBeEnabled();await page.evaluate(()=>window.view.setLanguage('en'));await expect(save).toHaveText('Save goal');await save.click();await expect(page.getByRole('dialog')).toBeHidden();
  const requests=await page.evaluate(()=>window.calls.filter(c=>c.name==='update_team_member_goal').map(c=>c.args.requestId));assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(await page.evaluate(()=>window.goalHistory.length),1);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('role goal management shares the editor and historical or removed roles remain read-only; stale read replies cannot reopen it',async()=>{
 const {page,errors}=await open();try{
  await enableGoals(page);await page.locator('#teamManageOpen').click();await page.getByLabel('管理操作').selectOption('member-goal');await page.getByRole('button',{name:'编辑角色目标',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.locator('#memberGoalCancel').click();
  await page.evaluate(()=>{window.data.team.members[1].removedAt=new Date().toISOString();});await update(page);await expect(page.locator('[data-focus-key="edit-member-goal:qa"]')).toHaveCount(0);
  await page.evaluate(()=>{window.holdGoalRead=true;});await page.locator('[data-focus-key="edit-member-goal:dev"]').click();await expect(page.locator('#memberGoalInput')).toBeDisabled();await page.keyboard.press('Escape');await page.evaluate(()=>{window.holdGoalRead=false;window.releaseGoalRead();});await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('[data-focus-key="edit-member-goal:dev"]').click();await page.locator('#memberGoalInput').fill('未保存');await page.evaluate(()=>{window.data.team.id='another-team';});await update(page);await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('[data-focus-key="edit-member-goal:dev"]').click();await expect(page.locator('#memberGoalInput')).toBeEnabled();await page.evaluate(()=>window.view.accept({kind:'team-workspace',context:{cwd:window.data.team.projectPath},teams:[]}));await expect(page.getByRole('dialog')).toBeHidden();await update(page);
  await page.evaluate(()=>{window.data.team.planReview={scope:'initial',status:'pending',hash:'fixture',version:1};});await update(page);await expect(page.locator('[data-focus-key^="edit-member-goal:"]')).toHaveCount(0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('compact member actions explain delayed hover, keyboard focus and unavailable navigation without disturbing task details',async()=>{
 const {page,errors}=await open();try{
  const inspect=page.locator('[data-focus-key="view-member:dev"]'),native=page.locator('[data-focus-key="open-member:dev"]'),tip=page.getByRole('tooltip');
  await expect(inspect).toHaveAccessibleName('查看任务与执行');await expect(inspect.locator('svg')).toHaveCount(1);await expect(inspect).toHaveText('');await expect(native).not.toHaveAttribute('title');
  const sizes=await inspect.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));assert.equal(sizes.width,32);assert.equal(sizes.height,32);
  await inspect.hover();await page.waitForTimeout(200);await page.mouse.move(0,0);await page.waitForTimeout(500);await expect(tip).toBeHidden();
  await inspect.hover();await page.waitForTimeout(250);await expect(tip).toBeHidden();await expect(tip).toBeVisible();await expect(tip).toContainText('查看成员任务、交付与历史轮次');
  await update(page);await expect(tip).toBeVisible();await tip.hover();await page.waitForTimeout(150);await expect(tip).toBeVisible();await page.mouse.move(0,0);await expect(tip).toBeHidden();
  await inspect.click();await expect(page.locator('#memberDetail')).toBeVisible();await native.focus();await page.keyboard.press('Tab');await expect(inspect).toBeFocused();await expect(tip).toBeVisible();await expect(inspect).toHaveAttribute('aria-describedby',await tip.getAttribute('id'));
  await page.keyboard.press('Escape');await expect(tip).toBeHidden();await expect(page.locator('#memberDetail')).toBeVisible();await update(page);await expect(tip).toBeHidden();
  await page.locator('#teamLocale').selectOption('en');await native.focus();await expect(native).toHaveAccessibleName('Open native conversation');await expect(tip).toContainText('Open the existing subagent directly');
  await page.evaluate(()=>{const m=window.data.team.members.find(m=>m.id==='qa');m.agentThreadId=null;m.rosterVerified=false;});await update(page);
  const unavailable=page.locator('[data-focus-key="open-member:qa"]');await expect(unavailable).toBeDisabled();await unavailable.locator('..').focus();await expect(tip).toContainText('Member is not yet bound to a native thread');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='request_team_navigation').length),0);
  await page.setViewportSize({width:320,height:900});await inspect.focus();await expect(tip).toBeVisible();const bounds=await tip.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=320);
  assert.deepEqual(errors,[]);await page.evaluate(()=>window.view.close());await expect(tip).toHaveCount(0);
 }finally{await page.close();}
});
test('appended roles appear without losing existing task selection or native identity',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();
  await page.evaluate(()=>window.data.team.members.push({id:'docs',role:'文档岗位',responsibility:'维护项目文档',agentThreadId:null,rosterVerified:false,status:'planned'}));
  await update(page);
  await expect(page.locator('#membersHeading')).toHaveText('4 名成员');
 await expect(page.locator('[data-focus-key="member:docs"]')).toHaveText('文档岗位');
 await expect(page.locator('[data-focus-key="member:docs"]')).toHaveAttribute('title','interaction-fixture-文档岗位');
  await expect(page.locator('#taskDetail')).toContainText('任务 t1');
  await expect(page.locator('[data-member-id="dev"]')).toHaveAttribute('data-selected','true');
  await page.locator('[data-focus-key="member:docs"]').click();
  await expect(page.locator('#memberDetail')).toContainText('岗位已登记，等待 Leader 创建并绑定原生成员。');
  await page.evaluate(()=>{const m=window.data.team.members.find(m=>m.id==='docs');m.agentThreadId='docs-thread';m.rosterVerified=true;window.data.team.tasks.push({id:'guide',memberId:'docs',title:'更新指南',goal:'同步指南',acceptance:'检查通过',status:'waiting',dependencies:[],attempts:[],evidence:[]});});
  await update(page);
  await expect(page.locator('[data-member-id="docs"] [data-focus-key="chip:guide"]')).toHaveAttribute('title',/更新指南/);
  await expect(page.locator('#memberDetail')).toContainText('更新指南');
  await expect(page.locator('#memberDetail [data-focus-key="member-native"]')).toBeEnabled();
  assert.equal(await page.evaluate(()=>window.data.team.members.find(m=>m.id==='dev').agentThreadId),'dev-thread');
  await page.screenshot({path:dir+'/appended-role.png',fullPage:true});assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('task list searches real titles, opens exact details with the keyboard and returns focus on close',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('#teamGoalTitle')).toHaveText(fixture().team.goal);await expect(page.locator('#progressValue')).toHaveText('14%');await expect(page.locator('#taskList .task-row')).toHaveCount(7);
  await page.getByLabel('查找任务',{exact:true}).fill('任务 t2');await expect(page.locator('#taskList .task-row')).toHaveCount(1);const row=page.locator('[data-list-task-id="t2"]');await expect(row).toContainText('审查成员');await row.press('Enter');await expect(page.locator('#selectionPanel')).toBeFocused();await expect(page.locator('#taskDetail')).toContainText('任务 t2');await page.locator('#closeInspection').click();await expect(page.locator('#taskDetail')).toBeHidden();await expect(row).toBeFocused();await expect(page.getByLabel('查找任务',{exact:true})).toHaveValue('任务 t2');
  await page.getByLabel('查找任务',{exact:true}).fill('');await page.getByLabel('按状态筛选',{exact:true}).selectOption('accepted');await expect(page.locator('#taskList .task-row')).toHaveCount(1);await expect(page.locator('[data-list-task-id="done"]')).toBeVisible();
  await page.getByLabel('按状态筛选',{exact:true}).selectOption('');await page.getByLabel('查找任务',{exact:true}).fill('任务 t2');await page.evaluate(()=>{const t=window.data.team.tasks.find(t=>t.id==='t2');t.status='running';t.attempts=[{id:'reserved-narrow',number:1,state:'reserved'}];});await update(page);await page.setViewportSize({width:360,height:900});
  const cells=await page.locator('[data-list-task-id="t2"]').evaluate(row=>{const owner=row.querySelector('.task-owner').getBoundingClientRect(),status=row.querySelector('.status-pill').getBoundingClientRect();return {ownerRight:owner.right,statusLeft:status.left};});assert.ok(cells.ownerRight<=cells.statusLeft+1,'assignee and long status must occupy separate columns');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('execution limits stay visible while informational run notes start collapsed',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('#panelNotes')).toBeHidden();await page.evaluate(()=>window.data.team.preparation={status:'blocked',message:'缺少必要的工作区输入'});await update(page);await expect(page.locator('#panelNotes')).toHaveAttribute('open','');await expect(page.locator('#panelNotes')).toHaveAttribute('data-severity','warning');await expect(page.locator('#workspacePreparation')).toBeVisible();await expect(page.locator('#workspacePreparation')).toContainText('缺少必要的工作区输入');await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('overview distinguishes review, observed execution, unknown state, halted control and ready work',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('#overviewHeadline')).toHaveText('1 项等待独立审查');await expect(page.locator('#progressValue')).toHaveText('14%');
  await page.evaluate(()=>{const t=window.data.team.tasks.find(t=>t.id==='t2');t.status='running';t.attempts=[{id:'overview-attempt',number:1,state:'running',agentThreadId:'qa-thread'}];window.data.runs.push({taskId:'t2',memberId:'qa',attemptId:'overview-attempt',threadId:'qa-thread',status:'inProgress',connection:'connected'});});await update(page);await expect(page.locator('#overviewHeadline')).toHaveText('1 项任务执行中');await expect(page.locator('#overviewTask')).toHaveText('t2 · 任务 t2');
  await page.evaluate(()=>{window.data.runs.find(r=>r.attemptId==='overview-attempt').status='unknown';});await update(page);await expect(page.locator('#overviewStatus')).toHaveAttribute('data-state','unknown');await expect(page.locator('#overviewHeadline')).toContainText('状态待核对');
  await page.evaluate(()=>{window.data.team.executionControl={status:'halted'};});await update(page);await expect(page.locator('#overviewHeadline')).toHaveText('团队已停止');await expect(page.locator('#overviewTask')).toBeHidden();
  await page.evaluate(()=>{window.data.team.executionControl={status:'active'};window.data.team.tasks.find(t=>t.id==='t1').status='accepted';const t=window.data.team.tasks.find(t=>t.id==='t2');t.status='waiting';t.attempts=[];window.data.runs=window.data.runs.filter(r=>r.attemptId!=='overview-attempt');});await update(page);await expect(page.locator('#overviewHeadline')).toHaveText('1 项任务已就绪');await expect(page.locator('#progressValue')).toHaveText('29%');await page.locator('#teamLocale').selectOption('en');await expect(page.locator('#overviewHeadline')).toHaveText('1 task ready');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('current focus follows real task state and filters, opens the exact task and preserves paused wording',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('#taskFocus')).toHaveAttribute('data-state','submitted');await expect(page.locator('[data-focus-task-id="t1"]')).toBeVisible();
  await page.evaluate(()=>{window.data.team.tasks.find(t=>t.id==='t3').status='blocked';});await update(page);
  await expect(page.locator('#taskFocus')).toHaveAttribute('data-state','blocked');await page.locator('[data-focus-task-id="t3"]').click();await expect(page.locator('#selectionPanel')).toBeFocused();await expect(page.locator('#taskDetail')).toContainText('任务 t3');await page.locator('#closeInspection').click();
  await page.getByLabel('按状态筛选',{exact:true}).selectOption('accepted');await expect(page.locator('#taskFocus')).toBeHidden();
  await page.getByLabel('按状态筛选',{exact:true}).selectOption('');await page.getByLabel('查找任务',{exact:true}).fill('任务 t2');await expect(page.locator('#taskFocus')).toContainText('已就绪，等待派发');
  await page.evaluate(()=>{window.data.team.dispatchPaused=true;});await update(page);await expect(page.locator('#taskFocus')).toContainText('新任务派发已暂停');await expect(page.locator('#taskFocus')).not.toContainText('已就绪，等待派发');
  await page.locator('#teamLocale').selectOption('en');await expect(page.locator('#taskFocus')).toContainText('Dispatch paused');await expect(page.locator('.task-table-head')).toContainText('Status');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('DAG hover and keyboard focus stay quiet; click selects the full chain and Escape closes details',async()=>{
 const {page,errors}=await open();try{
  const t2=page.locator('[data-task-id="t2"]');await t2.hover();await page.waitForTimeout(300);await expect(page.locator('#selectionPanel')).toBeHidden();await expect(t2).toHaveAttribute('data-related','false');await expect(t2).not.toHaveAttribute('title');
  await t2.focus();await expect(page.locator('#selectionPanel')).toBeHidden();await t2.click();await expect(t2).toHaveAttribute('data-related','true');
  for(const id of ['t1','t3','t4','t5'])await expect(page.locator('[data-task-id="'+id+'"]')).toHaveAttribute('data-related','true');
  await expect(page.locator('[data-task-id="sibling"]')).toHaveAttribute('data-dimmed','true');
  await page.locator('[data-task-id="sibling"]').hover();await expect(t2).toHaveAttribute('aria-pressed','true');await expect(page.locator('#taskDetail')).toContainText('任务 t2');
  await expect(page.locator('#taskDetail')).toContainText('完成后解锁');await expect(page.locator('#taskDetail')).toContainText('t3 · interaction-fixture-开发成员（验收后）');
  await page.keyboard.press('Escape');await expect(t2).toHaveAttribute('aria-pressed','false');await expect(page.locator('#taskDetail')).toBeHidden();
  await t2.focus();await page.keyboard.press('Enter');await expect(t2).toHaveAttribute('aria-pressed','true');
  await page.locator('[data-task-id="t3"]').click();await expect(page.locator('#taskDetail')).toContainText('t2 · interaction-fixture-审查成员 · 等待验收');
  await page.screenshot({path:dir+'/controlled-dag.png',fullPage:true});assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('member/task links, exact old round, focus/open/scroll retention, restoration and project isolation',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('[data-focus-key="member:dev"]')).toHaveText('开发成员');
  await page.locator('[data-task-id="t1"]').click();await page.getByRole('button',{name:'定位负责人 · interaction-fixture-开发成员',exact:true}).click();
  await expect(page.locator('[data-member-id="dev"]')).toHaveAttribute('data-selected','true');
  await page.locator('[data-focus-key="history:dev"]').click();
  await page.locator('[data-focus-key="attempt:old-attempt"]').click();await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');await expect(page.locator('#memberDetail')).not.toContainText('第二轮公开结果');
  const command=page.locator('#memberDetail details');await command.locator('summary').click();await expect(command).toHaveAttribute('open','');
  await page.locator('[data-focus-key="execution-tab:old-attempt"]').focus();
  await page.evaluate(()=>{document.querySelector('.graph-scroll').scrollLeft=200;window.scrollTo(0,350);});await page.waitForTimeout(50);
  const beforeState=await page.evaluate(()=>({y:window.scrollY,x:document.querySelector('.graph-scroll').scrollLeft,focus:document.activeElement.dataset.focusKey}));
  await update(page);
  const afterState=await page.evaluate(()=>({y:window.scrollY,x:document.querySelector('.graph-scroll').scrollLeft,focus:document.activeElement.dataset.focusKey}));
  assert.deepEqual(afterState,beforeState);await expect(page.locator('#memberDetail details')).toHaveAttribute('open','');
  await page.reload();await boot(page);await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');
  assert.equal(await page.locator('[data-focus-key="execution-tab:old-attempt"]').getAttribute('aria-pressed'),'true');
  await expect(page.locator('#memberDetail details')).toHaveAttribute('open','');
  await page.getByRole('button',{name:'返回团队',exact:true}).click();await expect(page.locator('#memberDetail')).toBeHidden();
  await page.locator('[data-focus-key="member:dev"]').click();await expect(page.locator('#memberDetail')).toBeVisible();
  await page.evaluate(async()=>{window.data.team={...window.data.team,id:'second-team',projectPath:'E:/other'};await window.view.accept(structuredClone(window.data));});
  await expect(page.locator('[data-focus-key="member:dev"]')).toHaveText('开发成员');
  await expect(page.locator('#memberDetail')).toBeHidden();await expect(page.locator('#taskDetail')).toBeHidden();assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('collapsed members retain submitted/blocked work; parallel grid and overview persist',async()=>{
 const {page,errors}=await open();try{
  await page.locator('#toggleMembers').click();await expect(page.locator('[data-member-id="finished"]')).toHaveCount(0);
  await expect(page.locator('[data-member-id="dev"]')).toBeVisible();await expect(page.locator('[data-member-id="dev"]')).toContainText('已交付，等待独立审查和验收');
  await expect(page.locator('[data-member-id="qa"]')).toBeVisible();
  await page.evaluate(async()=>{window.data.team.members.push({id:'idle',role:'未分配成员',responsibility:'等待任务',rosterVerified:true,agentThreadId:'idle-thread'});window.data.team.revision++;await window.view.accept(structuredClone(window.data));});
  await expect(page.locator('[data-member-id="idle"]')).toBeVisible();
  await page.evaluate(async()=>{window.data.team.tasks.forEach(t=>t.dependencies=[]);window.data.team.revision++;await window.view.accept(structuredClone(window.data));});
  await expect(page.locator('#dependencyTitle')).toHaveText('并行任务');await expect(page.locator('#dependencyGraph')).toHaveClass('graph parallel');
  await page.locator('#toggleOverview').click();await expect(page.locator('#teamBoard')).toBeHidden();await expect(page.locator('#collapsedSummary')).toContainText('4 名固定成员');
  await page.reload();await boot(page);await expect(page.locator('#teamBoard')).toBeHidden();await page.locator('#toggleOverview').click();
  await expect(page.locator('[data-member-id="finished"]')).toHaveCount(0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('details stay in the panel; native navigation opens the exact historical thread without messages or selection changes',async()=>{
 const {page,errors}=await open();try{
  await page.evaluate(()=>{window.data.team.tasks[0].attempts[0].agentThreadId='retired-dev-thread';window.data.runs[0].threadId='retired-dev-thread';});await update(page);
  await page.locator('[data-task-id="t1"]').click();await expect(page.locator('#taskDetail')).toContainText('任务 t1');
  await page.locator('[data-focus-key="view-member:dev"]').click();await expect(page.locator('#memberDetail')).toBeVisible();
  await page.locator('[data-focus-key="execution-tab:old-attempt"]').click();await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');
  assert.deepEqual(await page.evaluate(()=>({links:window.links,messages:window.sent,navigations:window.calls.filter(c=>c.name==='request_team_navigation')})),{links:[],messages:[],navigations:[]});
  await page.locator('[data-focus-key="member-native"]').click();await expect(page.locator('#navigationState')).toContainText('已将会话跳转交给宿主');
  const request=await page.evaluate(()=>window.calls.find(c=>c.name==='request_team_navigation').args);assert.equal(request.taskId,'t1');assert.equal(request.attemptId,'old-attempt');assert.equal(request.memberId,'dev');assert.equal(request.transport,'open-link');
  assert.deepEqual(await page.evaluate(()=>window.links),[{url:'codex://threads/retired-dev-thread'}]);assert.equal(await page.evaluate(()=>window.sent.length),0);
  assert.equal(await page.locator('[data-focus-key="execution-tab:old-attempt"]').getAttribute('aria-pressed'),'true');await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');
  await page.locator('[data-focus-key="leader-native"]').click();await expect.poll(()=>page.evaluate(()=>window.links.at(-1)?.url)).toBe('codex://threads/fixture-leader');
  await expect.poll(()=>page.evaluate(()=>window.calls.filter(c=>c.name==='record_team_navigation'&&c.args.status==='host-accepted').length)).toBe(2);assert.equal(await page.evaluate(()=>window.sent.length),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('rejected deep links show a durable failure and explicit retry never notifies the Leader',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();await page.evaluate(()=>window.rejectLink=true);await page.locator('[data-focus-key="task-open:t1"]').click();
  await expect(page.locator('#navigationState')).toContainText('宿主拒绝打开会话');await page.waitForTimeout(1800);await expect(page.locator('#navigationState')).toContainText('宿主拒绝打开会话');
  assert.equal(await page.evaluate(()=>window.sent.length),0);assert.equal(await page.evaluate(()=>window.links.length),1);
  await page.evaluate(()=>window.rejectLink=false);await page.getByRole('button',{name:'重试导航'}).click();await expect(page.locator('#navigationState')).toContainText('已将会话跳转交给宿主');
  assert.equal(await page.evaluate(()=>window.links.length),2);assert.equal(await page.evaluate(()=>window.sent.length),0);await expect(page.locator('#taskDetail')).toContainText('任务 t1');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('missing host link capability leaves details usable and cannot fall back to messaging',async()=>{
 const {page,errors}=await open();try{
  await page.evaluate(()=>window.linkCapability=false);await page.locator('[data-focus-key="open-member:dev"]').click();await expect(page.locator('#navigationState')).toContainText('当前宿主不支持直接打开会话');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='request_team_navigation').length),0);assert.equal(await page.evaluate(()=>window.sent.length),0);
  await page.locator('[data-task-id="t3"]').click();await expect(page.locator('#taskDetail')).toContainText('任务 t3');await expect(page.locator('[data-focus-key="task-open:t3"]')).toBeDisabled();await expect(page.locator('#taskDetail')).toContainText('任务尚未绑定执行会话');assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('a lost navigation receipt cannot repeat an accepted host link',async()=>{
 const {page,errors}=await open();try{
  await page.evaluate(()=>window.failNavigationRecord=true);await page.locator('[data-focus-key="open-member:dev"]').click();await expect(page.locator('#navigationState')).toContainText('跳转记录保存失败');
  await update(page);await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>window.links.length),1);assert.equal(await page.evaluate(()=>window.sent.length),0);await expect(page.getByRole('button',{name:'重试导航'})).toHaveCount(0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('changing details during navigation revalidation cancels the jump; late host replies cannot replace a newer selection',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();await page.evaluate(()=>window.holdNavigationRead=true);await page.locator('[data-focus-key="task-open:t1"]').click();
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseNavigationRead)).toBe('function');await page.locator('[data-task-id="t3"]').click();await page.evaluate(()=>{window.holdNavigationRead=false;window.releaseNavigationRead();});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.links.length),0);await expect(page.locator('#taskDetail')).toContainText('任务 t3');
  await page.locator('[data-task-id="t1"]').click();await page.evaluate(()=>window.holdLink=true);await page.locator('[data-focus-key="task-open:t1"]').click();await expect.poll(()=>page.evaluate(()=>typeof window.releaseLink)).toBe('function');
  await page.locator('[data-task-id="t3"]').click();await page.evaluate(()=>window.releaseLink());await page.waitForTimeout(100);await expect(page.locator('#navigationState')).toBeHidden();await expect(page.locator('#taskDetail')).toContainText('任务 t3');assert.equal(await page.evaluate(()=>window.sent.length),0);assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('obsolete navigation cannot send or replace selected task; reconnect restarts fresh polling',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();await page.evaluate(()=>window.holdNavigation=true);
  await page.locator('[data-focus-key="task-open:t1"]').click();await expect(page.locator('#navigationState')).toContainText('正在核对');
  await page.locator('[data-task-id="t3"]').click();await page.evaluate(()=>window.releaseNavigation());await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.sent.length),0);assert.equal(await page.evaluate(()=>window.links.length),0);await expect(page.locator('#navigationState')).toBeHidden();await expect(page.locator('#taskDetail')).toContainText('t3 · 任务 t3');
  await page.evaluate(()=>{window.view.disconnect();window.failRead=true;});await page.locator('#retryConnection').click();await expect(page.locator('#errorState')).toContainText('fixture disconnect');
  await page.evaluate(()=>window.failRead=false);await page.locator('#retryConnection').click();await expect(page.locator('#errorState')).toBeHidden();
  await page.evaluate(()=>{window.data.team.goal='已恢复并持续同步';window.data.team.revision++;});await expect(page.locator('#teamGoalText')).toHaveText('已恢复并持续同步');
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('narrow/light/dark, host variables, reduced motion, loading, empty and failure recovery',async()=>{
 const {page,errors}=await open({viewport:{width:360,height:800},reducedMotion:'reduce'});try{
  await page.locator('[data-task-id="t3"]').click();await page.screenshot({path:dir+'/controlled-narrow-light.png',fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:dir+'/controlled-narrow-dark.png',fullPage:true});
  await page.evaluate(()=>{document.documentElement.style.setProperty('--color-text-primary','rgb(201, 202, 203)');});
  assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).color),'rgb(201, 202, 203)');
  assert.equal(await page.locator('.segment').first().evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.evaluate(async()=>{await window.view.accept({kind:'team-workspace',context:{cwd:'E:/empty'},teams:[]});});
  await expect(page.locator('#emptyState')).toBeVisible();await expect(page.locator('#teamBoard')).toBeHidden();
  await page.evaluate(()=>window.view.disconnect());await page.locator('#retryConnection').click();await expect(page.locator('#teamBoard')).toBeVisible();
  assert.deepEqual(errors,[]);
  await writeFile(dir+'/controlled-browser.json',JSON.stringify({status:'PASS',kind:'actual-Chrome-shipping-view-controlled-protocol-not-Desktop',cases:6,viewports:[1000,360],themes:['light','dark'],consoleErrors:errors,at:new Date().toISOString()},null,2));
 }finally{await page.close();}
});
test('a changed team revision preserves long public-output reading and disclosure focus',async()=>{
 const {page}=await open();try{
  await page.evaluate(async()=>{window.data.runs[0].outputs[0].text='长公开输出\n'.repeat(200);window.data.team.revision++;await window.view.accept(structuredClone(window.data));});
  await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:old-attempt"]').click();
  await page.locator('#memberDetail details summary').click();await page.locator('#memberDetail details summary').focus();
  await page.locator('.public-output').evaluate(e=>e.scrollTop=180);await page.locator('#selectionPanel').evaluate(e=>e.scrollTop=90);await page.waitForTimeout(50);
  const inspectionScroll=await page.locator('#selectionPanel').evaluate(e=>e.scrollTop);assert.ok(inspectionScroll>0);await update(page);
  assert.equal(await page.locator('#selectionPanel').evaluate(e=>e.scrollTop),inspectionScroll);
  assert.equal(await page.locator('.public-output').evaluate(e=>e.scrollTop),180);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.focusKey),'disclosure:commands:old-attempt');
  await page.reload();await boot(page);await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');
 }finally{await page.close();}
});
test('waiting labels remain readable in light/dark independently of status dot color',async()=>{
 const {page}=await open();try{
  await page.locator('[data-task-id="t3"]').click();
  for(const theme of ['light','dark']){await page.emulateMedia({colorScheme:theme});
   const ratios=await page.evaluate(()=>{const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);const lum=s=>rgb(s).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return ['#progressLegend .waiting','#taskDetail .status-pill','.chip.waiting'].map(selector=>{const e=document.querySelector(selector),style=getComputedStyle(e),background=style.backgroundColor==='rgba(0, 0, 0, 0)'?getComputedStyle(document.body).backgroundColor:style.backgroundColor,a=lum(style.color),b=lum(background);return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});});
   for(const value of ratios)assert.ok(value.ratio>=4.5,theme+' '+value.selector+' contrast '+value.ratio);
  }
 }finally{await page.close();}
});
