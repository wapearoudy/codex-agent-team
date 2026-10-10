import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {TeamCoordination} from '../src/team-coordination.mjs';
import {TeamProfiles} from '../src/team-policy.mjs';
import {teamResponse} from '../src/team-responses.mjs';

async function fixture({failNotification=false}={}){
 const root=await mkdtemp(join(tmpdir(),'completion-ui-')),engine=new LeaderEngine({root}),coordination=new TeamCoordination(root),profiles=new TeamProfiles(root);
 const plan={members:[{id:'dev',role:'开发工程师',responsibility:'实现用户目标',reason:'交付',writeScopes:['src'],routeSnapshot:{model:'host-a',provider:'provider-a',reasoningEffort:'low'}},{id:'qa',role:'独立审查',responsibility:'验证交付',reason:'独立性',writeScopes:[]}],tasks:[{id:'work',title:'原始中文交付',goal:'保留用户原始中文目标',acceptance:'独立验证通过',memberId:'dev',kind:'work',priority:3,dependencies:[]},{id:'review',title:'独立审查',goal:'核对交付',acceptance:'提供证据',memberId:'qa',kind:'review',reviewOfTaskId:'work',priority:3,dependencies:[{taskId:'work',when:'submitted'}]}]};
 const team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'保留用户原始中文目标并完成独立验证',execute:true,initializeMembers:true,memberStartup:'on-demand',approvalMode:'required',plan});
 let archived=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'旧团队历史保留且不可重新派发',execute:false,plan});archived=(await engine.store.update(archived.id,'owner',archived.revision,t=>{t.state='superseded';t.dispatchPaused=true;})).team;
 const state=async(id=team.id,view='panel')=>teamResponse(await engine.receipt('owner',id),view);
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
 const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1100,height:900}}),messages=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('tool',async({name,arguments:a})=>{try{let data;
  if(name==='read_team')data=await state(a.teamId,a.view);
  else if(name==='read_team_plan')data=await engine.readPlan('owner',a.teamId);
  else if(name==='open_team_workspace')data={kind:'team-workspace',context:{cwd:root},teams:[{id:team.id}]};
  else if(name==='request_team_plan_feedback')data=await engine.requestPlanFeedback('owner',a.teamId,a.revision,a);
  else if(name==='approve_team_plan'){data=await engine.decidePlan('owner',a.teamId,a.revision,a,'approve');data={...data,coordination:await coordination.reserve('owner',data)};data=teamResponse(data);}
  else if(name==='coordinate_team'){const d=await engine.receipt('owner',a.teamId);if(a.operation==='status')data=await coordination.read('owner',d);else if(a.operation==='enable')data=await coordination.enable('owner',d,a.enabled);else if(a.operation==='reserve')data=await coordination.reserve('owner',d,a);else if(a.operation==='receipt')data=await coordination.receipt('owner',a.teamId,a);else data=await coordination.consume('owner',d,a.notificationId);}
  else if(name==='add_team_members')data=teamResponse(await engine.addMembers('owner',a.teamId,a.revision,a.members,a.requestId,{reviewExpansion:true}));
  else if(name==='plan_team_from_profile')data={kind:'team-planning-request'};else if(name==='save_team_profile')data={kind:'team-profile',profile:await profiles.save(a.name,a.plan,a.policy,a.note,a)};
  else if(name==='manage_team'){if(a.operation==='history')data={kind:'team-history',teams:(await engine.store.summaries('owner',root)).map(t=>({...t,readOnly:t.id!==team.id})),nextOffset:null};else if(a.operation==='profiles')data={profiles:await profiles.read()};else if(a.operation==='profile')data={profile:await profiles.read(a.name)};else if(a.operation==='delete-profile')data=await profiles.remove(a.name,a.updatedAt);else throw new Error('Unsupported fixture operation');}
  else throw new Error('Unexpected operation: '+name);
  return {structuredContent:data};
 }catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
 await page.exposeFunction('notify',async message=>{messages.push(message);throw new Error('Chat transport is forbidden');});
 await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(async data=>{const {setupTeamView}=await import('/team-view.mjs');window.view=setupTeamView({callServerTool:window.tool,getHostCapabilities:()=>({message:{}}),sendMessage:window.notify});await window.view.accept(data);},await state());
 return {team,archived,engine,profiles,coordination,page,messages,errors,state,async close(){await page.evaluate(()=>window.view.close());await browser.close();await new Promise(r=>server.close(r));}};
}

test('plan feedback is persisted without chat or approval; language changes retain original user content and form edits',async()=>{
 const f=await fixture();try{await expect(f.page.locator('#planReturnToChat')).toBeEnabled();const goal=f.page.getByLabel('任务目标',{exact:true});await goal.fill('用户尚未保存的中文目标');await f.page.locator('#teamLocale').selectOption('en');await expect(f.page.locator('#planReturnToChat')).toHaveText('Request revision');await expect(f.page.getByLabel('Team goal',{exact:true})).toHaveValue('用户尚未保存的中文目标');await expect(f.page.locator('#teamGoalText')).toHaveText(f.team.goal);await f.page.locator('#teamLocale').selectOption('zh-CN');await expect(f.page.getByLabel('任务目标',{exact:true})).toHaveValue('用户尚未保存的中文目标');await f.page.locator('#planReturnToChat').click();await expect(f.page.locator('#planReviewFeedback')).toContainText('修改请求已保存');const t=await f.engine.native('owner',f.team.id);assert.equal(t.planReview.status,'pending');assert.equal(t.planReview.feedback.status,'awaiting-user-feedback');assert.ok(t.members.every(m=>!m.agentThreadId));assert.equal(f.messages.length,0);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('approval and role management persist through internal coordination without chat notifications',async()=>{
 const f=await fixture({failNotification:true});try{await expect(f.page.locator('#planApprove')).toBeEnabled();await f.page.locator('#planApprove').click();await expect(f.page.locator('#planReviewStatus')).toContainText('已确认');assert.equal(await f.page.locator('#teamNotificationRetry').count(),0);assert.equal(f.messages.length,0);await f.page.evaluate(data=>window.view.accept(data),await f.state());assert.equal(f.messages.length,0);const status=await f.coordination.read('owner',await f.engine.receipt('owner',f.team.id));assert.equal(status.enabled,false);assert.equal(status.delivery,'native-agent-messages');assert.deepEqual(status.notifications,[]);
 await f.page.locator('#teamManageOpen').click();await f.page.getByLabel('管理操作',{exact:true}).selectOption('add-member');await f.page.getByLabel('操作原因',{exact:true}).fill('增加独立文档职责');await f.page.getByLabel('岗位 ID',{exact:true}).fill('docs');await f.page.getByLabel('岗位名称',{exact:true}).fill('文档工程师');await f.page.getByLabel('岗位职责',{exact:true}).fill('说明交付行为');await f.page.getByLabel('写入范围（每行一个）',{exact:true}).fill('docs');await f.page.getByRole('button',{name:'保存操作',exact:true}).click();await expect(f.page.locator('#planReviewTitle')).toContainText('确认团队变更');const t=await f.engine.native('owner',f.team.id);assert.equal(t.members.length,2);assert.equal(t.planReview.pending.members[0].id,'docs');assert.deepEqual(f.errors,[]);}finally{await f.close();}
});
test('project archive is read-only, profiles are manageable, and narrow layouts preserve the controls',async()=>{
 const f=await fixture();try{await f.profiles.save('dynamic',{members:f.team.members},{},'Reusable',{taskPlanning:'leader'});await f.page.locator('#teamLibraryOpen').click();await f.page.getByRole('button',{name:new RegExp(f.archived.goal)}).click();await expect(f.page.locator('#teamOperations')).toBeHidden();await expect(f.page.locator('#planReview')).toBeHidden();await expect(f.page.locator('#teamControl')).toBeHidden();await expect(f.page.locator('#teamGoalText')).toHaveText(f.archived.goal);await f.page.getByRole('button',{name:'返回当前团队',exact:true}).click();await expect(f.page.locator('#teamGoalText')).toHaveText(f.team.goal);await f.page.locator('#teamLibraryOpen').click();await f.page.getByRole('button',{name:'团队模板',exact:true}).click();await f.page.getByLabel('已有模板',{exact:true}).selectOption('dynamic');await expect(f.page.getByLabel('模板名称',{exact:true})).toHaveValue('dynamic');await f.page.getByLabel('模板约束',{exact:true}).fill('保持用户范围');await f.page.getByRole('button',{name:'保存模板',exact:true}).click();await expect(f.page.locator('#teamLibraryFeedback')).toContainText('模板已保存');assert.equal((await f.profiles.read('dynamic')).constraints,'保持用户范围');await f.page.setViewportSize({width:360,height:900});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(f.errors,[]);}finally{await f.close();}
});

test('legacy profile planning requests stay in the panel without falling back to user chat',async()=>{const f=await fixture();try{
 await f.profiles.save('dynamic',{members:f.team.members},{},'Reusable',{taskPlanning:'leader'});await f.page.locator('#teamLibraryOpen').click();await f.page.getByRole('button',{name:'团队模板',exact:true}).click();await f.page.getByLabel('已有模板',{exact:true}).selectOption('dynamic');await f.page.getByRole('button',{name:'使用模板生成待审计划',exact:true}).click();await expect(f.page.locator('#teamLibraryFeedback')).toContainText('当前连接需要升级');assert.equal(f.messages.length,0);assert.equal((await f.engine.native('owner',f.team.id)).planReview.status,'pending');assert.deepEqual(f.errors,[]);
 }finally{await f.close();}});
