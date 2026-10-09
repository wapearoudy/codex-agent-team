import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {ProjectTeams} from '../src/project-teams.mjs';
import {teamResponse} from '../src/team-responses.mjs';

async function fixture({loseArchiveReply=false}={}){
 const root=await mkdtemp(join(tmpdir(),'team-retirement-ui-')),engine=new LeaderEngine({root}),projects=new ProjectTeams(engine),context={cwd:root,threadId:'leader'},calls=[],messages=[],errors=[];
 const plan={members:[{id:'dev',role:'开发工程师',responsibility:'实现当前目标',reason:'交付',writeScopes:['src']},{id:'qa',role:'独立审查工程师',responsibility:'验证当前目标',reason:'独立性',writeScopes:[]}],tasks:[{id:'work',title:'已完成的交付',goal:'实现功能',acceptance:'独立验证通过',memberId:'dev',priority:3,kind:'work',dependencies:[]},{id:'review',title:'已完成的独立审查',goal:'核对交付',acceptance:'记录证据',memberId:'qa',priority:3,kind:'review',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]}]};
 const team=(await projects.plan('owner',context,{goal:'完成原始中文目标并独立验收',execute:true,memberStartup:'on-demand',approvalMode:'immediate',executionAuthorization:'用户明确要求直接执行',plan})).team;
 const state=async()=>teamResponse(await engine.receipt('owner',team.id),'panel');
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>',''),server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1040,height:900}});page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('tool',async({name,arguments:a})=>{calls.push({name,args:a});try{let data;
   if(name==='read_team')data=teamResponse(await engine.receipt('owner',a.teamId),a.view);
   else if(name==='read_team_plan')data=await engine.readPlan('owner',a.teamId);
   else if(name==='open_team_workspace'){const t=await projects.current('owner',context);data={kind:'team-workspace',version:'0.16.0',context,teams:t?[{id:t.id}]:[]};}
   else if(name==='coordinate_team')data={enabled:false,notifications:[],firstOffer:false};
   else if(name==='archive_team'){data=await projects.archive('owner',context,a);if(loseArchiveReply){loseArchiveReply=false;throw new Error('Controlled lost archive response');}}
   else if(name==='manage_team'&&a.operation==='history'){const current=await projects.current('owner',context);data={kind:'team-history',teams:(await engine.store.summaries('owner',root)).map(t=>({...t,readOnly:t.id!==current?.id})),nextOffset:null};}
   else throw new Error('Unexpected fixture tool: '+name);
   return {structuredContent:data};
 }catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
 await page.exposeFunction('notify',async m=>{messages.push(m);return {};});await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(async data=>{const {setupTeamView}=await import('/team-view.mjs');window.view=setupTeamView({callServerTool:window.tool,getHostCapabilities:()=>({message:{}}),sendMessage:window.notify});await window.view.accept(data);},await state());
 const finish=async()=>{let t=await engine.native('owner',team.id);t=(await engine.store.update(t.id,'owner',t.revision,x=>{x.tasks.forEach(task=>task.status='accepted');})).team;await engine.finish('owner',t.id,t.revision,'目标完成',[{status:'PASS',evidence:'最终验证通过'}]);await page.evaluate(d=>window.view.accept(d),await state());};
 return {root,engine,projects,team,page,calls,messages,errors,state,finish,async close(){await page.evaluate(()=>window.view.close());await browser.close();await new Promise(r=>server.close(r));}};
}
test('completion reveals manual archive; refresh, locale and cancel preserve a reviewable confirmation, then history remains read-only',async()=>{
 const f=await fixture();try{
  await expect(f.page.locator('#teamArchiveOpen')).toBeHidden();await f.finish();await expect(f.page.locator('#teamArchiveOpen')).toBeVisible();await f.page.locator('#teamArchiveOpen').click();await expect(f.page.locator('#teamArchiveGoal')).toHaveText(f.team.goal);await f.page.locator('#teamArchiveReason').fill('后续目标与本团队无关');await f.page.evaluate(d=>window.view.accept(d),await f.state());await expect(f.page.locator('#teamArchiveReason')).toHaveValue('后续目标与本团队无关');
  await f.page.locator('#teamLocale').selectOption('en');await expect(f.page.locator('#teamArchiveTitle')).toHaveText('Archive team');await expect(f.page.locator('#teamArchiveReason')).toHaveValue('后续目标与本团队无关');await expect(f.page.locator('#teamArchiveGoal')).toHaveText(f.team.goal);await f.page.locator('#teamArchiveReason').press('Escape');await expect(f.page.locator('#teamArchiveEditor')).not.toBeVisible();await expect(f.page.locator('#teamArchiveOpen')).toBeFocused();assert.equal(f.calls.filter(c=>c.name==='archive_team').length,0);
  await f.page.locator('#teamLocale').selectOption('zh-CN');await f.page.locator('#teamArchiveOpen').click();await f.page.locator('#teamArchiveReason').fill('后续目标与本团队无关');await mkdir('evidence/team-retirement-ui',{recursive:true});await f.page.screenshot({path:'evidence/team-retirement-ui/confirmation.png'});await f.page.locator('#teamArchiveSave').click();await expect(f.page.locator('#emptyState')).toBeVisible();await expect(f.page.locator('#teamBoard')).toBeHidden();await expect(f.page.locator('#planReview')).toBeHidden();await expect(f.page.locator('#feedback')).toContainText('团队已归档');assert.equal(await f.projects.current('owner',{cwd:f.root}),null);assert.equal(f.calls.filter(c=>c.name==='archive_team').length,1);assert.equal(f.messages.length,0);
  await f.page.getByRole('button',{name:'查看已归档团队',exact:true}).click();await expect(f.page.locator('#overviewHeadline')).toHaveText('团队已归档');await expect(f.page.locator('#teamOperations')).toBeHidden();assert.equal(await f.page.locator('button[aria-label="调整角色目标"]').count(),0);await f.page.locator('#teamLibraryOpen').click();await expect(f.page.locator('#teamLibraryContent')).toContainText('已归档');await expect(f.page.locator('.history-meta')).toContainText('归档于');await expect(f.page.locator('.history-meta')).toContainText('后续目标与本团队无关');await f.page.locator('#teamLocale').selectOption('en');await expect(f.page.locator('#teamLibraryContent')).toContainText('Archived');await expect(f.page.locator('#feedback')).toContainText('Team archived.');await expect(f.page.locator('#teamLibraryContent')).toContainText(f.team.goal);await f.page.setViewportSize({width:360,height:900});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await f.page.screenshot({path:'evidence/team-retirement-ui/history-narrow.png'});assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('lost archive reply retains its UUID and original input; a late archived snapshot still permits safe receipt verification',async()=>{
 const f=await fixture({loseArchiveReply:true});try{
  await f.finish();await f.page.locator('#teamArchiveOpen').click();await f.page.locator('#teamArchiveReason').fill('独立的新目标');await f.page.locator('#teamArchiveSave').click();await expect(f.page.locator('#teamArchiveFeedback')).toContainText('Controlled lost archive response');await expect(f.page.locator('#teamArchiveReason')).toBeDisabled();await expect(f.page.locator('#teamArchiveSave')).toBeEnabled();await f.page.evaluate(context=>window.view.accept({kind:'team-workspace',context,teams:[]}),{cwd:f.root});await expect(f.page.locator('#teamArchiveEditor')).toBeVisible();await f.page.evaluate(d=>window.view.accept(d),await f.state());await expect(f.page.locator('#teamArchiveEditor')).toBeVisible();await f.page.locator('#teamArchiveSave').click();await expect(f.page.locator('#emptyState')).toBeVisible();
  const calls=f.calls.filter(c=>c.name==='archive_team');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);const t=await f.engine.native('owner',f.team.id);assert.equal(t.events.filter(e=>e.type==='team-archived').length,1);assert.equal(t.archival.reason,'独立的新目标');assert.equal(f.messages.length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
test('a changed completion snapshot requires fresh confirmation and never silently archives the newer revision',async()=>{
 const f=await fixture();try{
  await f.finish();await f.page.locator('#teamArchiveOpen').click();const t=await f.engine.native('owner',f.team.id);await f.engine.store.update(t.id,'owner',t.revision,x=>{x.members[0].responsibility='并发修改目标';});await f.page.evaluate(d=>window.view.accept(d),await f.state());await expect(f.page.locator('#teamArchiveFeedback')).toContainText('团队已变化');await f.page.locator('#teamArchiveSave').click();assert.equal(f.calls.filter(c=>c.name==='archive_team').length,0);await f.page.locator('#teamArchiveCancel').click();await f.page.locator('#teamArchiveOpen').click();await f.page.locator('#teamArchiveSave').click();await expect(f.page.locator('#emptyState')).toBeVisible();assert.equal(f.calls.filter(c=>c.name==='archive_team').length,1);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});
