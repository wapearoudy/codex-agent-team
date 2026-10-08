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
  const {setupTeamView}=await import('/team-view.mjs');window.data=data;window.calls=[];window.sent=[];window.navStatus='requested';window.rejectMessage=false;window.failRead=false;
  window.view=setupTeamView({getHostCapabilities:()=>({message:{}}),async sendMessage(message){window.sent.push(message);return {isError:window.rejectMessage};},
   async callServerTool({name,arguments:args}){window.calls.push({name,args});
    if(window.failRead&&['read_team','open_team_workspace'].includes(name))return {isError:true,content:[{type:'text',text:'fixture disconnect'}]};
    if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:window.data.team.projectPath},teams:[{id:window.data.team.id}]}};
    if(name==='read_team')return {structuredContent:structuredClone(window.data)};
    if(name==='request_team_navigation'){if(window.holdNavigation)await new Promise(r=>window.releaseNavigation=r);
     window.lastNavigation={kind:'team-navigation',request:{id:args.requestId,status:'requested',target:{...args,memberLabel:'interaction-fixture-开发成员',threadId:'dev-thread'}},message:'TEAM_WORKSPACE_NAVIGATION:'+args.requestId};
     return {structuredContent:structuredClone(window.lastNavigation)};}
    if(name==='read_team_navigation')return {structuredContent:{...window.lastNavigation,request:{...window.lastNavigation.request,status:window.navStatus}}};
    return {structuredContent:{kind:'team-navigation',request:{id:args.requestId,status:'superseded'}}};
   }});
  await window.view.connect();
 },fixture());
 await expect(page.locator('#projectName')).toHaveText('interaction-fixture');
}
async function update(page){await page.evaluate(async()=>{window.data.team.revision++;await window.view.accept(structuredClone(window.data));});}
test('appended roles appear without losing existing task selection or native identity',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();
  await page.evaluate(()=>window.data.team.members.push({id:'docs',role:'文档岗位',responsibility:'维护项目文档',agentThreadId:null,rosterVerified:false,status:'planned'}));
  await update(page);
  await expect(page.locator('#membersHeading')).toHaveText('4 名成员');
  await expect(page.locator('[data-focus-key="member:docs"]')).toHaveText('interaction-fixture-文档岗位');
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
test('DAG hover, pin, full chain, sibling exclusion and keyboard Escape',async()=>{
 const {page,errors}=await open();try{
  const t2=page.locator('[data-task-id="t2"]');await t2.hover();await expect(t2).toHaveAttribute('data-related','true');
  for(const id of ['t1','t3','t4','t5'])await expect(page.locator('[data-task-id="'+id+'"]')).toHaveAttribute('data-related','true');
  await expect(page.locator('[data-task-id="sibling"]')).toHaveAttribute('data-dimmed','true');
  await t2.click();await page.locator('#projectName').hover();await expect(t2).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#taskDetail')).toContainText('完成后解锁');await expect(page.locator('#taskDetail')).toContainText('t3 · interaction-fixture-开发成员（验收后）');
  await page.keyboard.press('Escape');await expect(t2).toHaveAttribute('aria-pressed','false');await expect(page.locator('#taskDetail')).toBeHidden();
  await t2.focus();await page.keyboard.press('Enter');await expect(t2).toHaveAttribute('aria-pressed','true');
  await page.locator('[data-task-id="t3"]').click();await expect(page.locator('#taskDetail')).toContainText('t2 · interaction-fixture-审查成员 · 等待验收');
  await page.screenshot({path:dir+'/controlled-dag.png',fullPage:true});assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('member/task links, exact old round, focus/open/scroll retention, restoration and project isolation',async()=>{
 const {page,errors}=await open();try{
  await expect(page.locator('[data-focus-key="member:dev"]')).toHaveText('interaction-fixture-开发成员');
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
  await expect(page.locator('[data-focus-key="member:dev"]')).toHaveText('other-开发成员');
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
test('navigation carries exact task/round; rejection stays visible after poll and retry/receipt works',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:old-attempt"]').click();
  await page.evaluate(()=>window.rejectMessage=true);await page.locator('[data-focus-key="member-native"]').click();
  await expect(page.locator('#navigationState')).toContainText('宿主拒绝导航请求');await page.waitForTimeout(1800);
  await expect(page.locator('#navigationState')).toContainText('宿主拒绝导航请求');
  const request=await page.evaluate(()=>window.calls.find(c=>c.name==='request_team_navigation').args);assert.equal(request.taskId,'t1');assert.equal(request.attemptId,'old-attempt');assert.equal(request.memberId,'dev');
  await page.evaluate(()=>window.rejectMessage=false);await page.getByRole('button',{name:'重试导航'}).click();await expect(page.locator('#navigationState')).toContainText('等待主会话打开');
  await page.evaluate(()=>window.navStatus='opened');await expect(page.locator('#navigationState')).toContainText('宿主导航工具已确认');
  await expect(page.locator('#memberDetail')).toContainText('第一轮公开结果');
  await page.locator('[data-focus-key="leader-native"]').click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='request_team_navigation').at(-1).args.destination),'leader');
  assert.deepEqual(errors,[]);
 }finally{await page.close();}
});
test('obsolete navigation cannot send or replace selected task; reconnect restarts fresh polling',async()=>{
 const {page,errors}=await open();try{
  await page.locator('[data-task-id="t1"]').click();await page.evaluate(()=>window.holdNavigation=true);
  await page.locator('[data-focus-key="task-open:t1"]').click();await expect(page.locator('#navigationState')).toContainText('正在核对');
  await page.locator('[data-task-id="t3"]').click();await page.evaluate(()=>window.releaseNavigation());await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.sent.length),0);await expect(page.locator('#navigationState')).toBeHidden();await expect(page.locator('#taskDetail')).toContainText('t3 · 任务 t3');
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
