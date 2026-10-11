import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {teamResponse} from '../src/team-responses.mjs';

test('shipping management UI saves light and merged standard tasks through the real engine',async t=>{
 const root=await mkdtemp(join(tmpdir(),'quality-strategy-ui-')),engine=new LeaderEngine({root:join(root,'records')});t.after(()=>engine.close());
 const team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Improve the current feature safely',execute:true,plan:{members:[{id:'dev',role:'开发',responsibility:'实现当前目标',reason:'实现',writeScopes:['src']},{id:'qa',role:'审查',responsibility:'独立审查',reason:'验证',writeScopes:[]}],tasks:[{id:'base',title:'Base',goal:'Base feature',acceptance:'Works',memberId:'dev',kind:'work',priority:3,dependencies:[]},{id:'review',title:'Feature review',goal:'Independent check',acceptance:'Works',memberId:'qa',kind:'review',reviewOfTaskId:'base',priority:3,dependencies:[{taskId:'base',when:'submitted'}]}]}});
 await engine.store.update(team.id,'owner',team.revision,s=>{s.batches=[{id:'current',title:'Current',goal:s.goal,qualityMode:'standard',goalCriteria:[],integrationRequired:false,state:'active',policyVersion:1}];s.activeBatchId='current';s.requiresTeamWorkspaceVersion='0.37.0';for(const task of s.tasks){task.batchId='current';task.qualityMode='standard';}});
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>',''),server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs','/panel-plan-start.mjs'].includes(req.url)){res.writeHead(404).end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const state=async view=>teamResponse(await engine.receipt('owner',team.id),view??'panel');
  await page.exposeFunction('teamTool',async({name,arguments:a})=>{try{if(name==='add_team_tasks')return {structuredContent:teamResponse(await engine.addTasks('owner',team.id,a.revision,a.tasks,a),'panel')};return {structuredContent:await state(a?.view)};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(async data=>{const {setupTeamView}=await import('/team-view.mjs');window.view=setupTeamView({callServerTool:a=>window.teamTool(a)});await window.view.accept(data);},await state());
  await page.locator('#teamManageOpen').click();await page.getByLabel('管理操作',{exact:true}).selectOption('add-task');
  const fill=async id=>{await page.getByLabel('交付任务 ID',{exact:true}).fill(id);await page.getByLabel('交付名称',{exact:true}).fill(id);await page.getByLabel('交付目标',{exact:true}).fill('Implement current behavior');await page.getByLabel('交付验收条件',{exact:true}).fill('Current behavior works');};
  await fill('light-ui');await page.getByLabel('验收策略',{exact:true}).selectOption('light');await expect(page.getByLabel('独立审查岗位',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'保存操作',exact:true}).click();await expect(page.locator('#teamManagementFeedback')).toHaveText('操作已保存。');
  let saved=await engine.native('owner',team.id);assert.equal(saved.tasks.find(x=>x.id==='light-ui').qualityMode,'light');assert.ok(!saved.tasks.some(x=>x.id==='light-ui_review'));
  await fill('standard-ui');await page.getByLabel('验收策略',{exact:true}).selectOption('standard');await page.getByLabel('审查安排',{exact:true}).selectOption('review');await page.getByRole('button',{name:'保存操作',exact:true}).click();
  await expect.poll(async()=> (await engine.native('owner',team.id)).tasks.find(x=>x.id==='review').reviewOfTaskIds).toEqual(['base','standard-ui']);
  await page.getByText('验证与范围（按需）',{exact:true}).click();await page.getByLabel('高风险标记（每行一个：security、data-migration、concurrency、execution-protocol、publication）',{exact:true}).fill('security');await expect(page.getByLabel('审查安排',{exact:true})).toBeDisabled();
  await mkdir('evidence',{recursive:true});await page.screenshot({path:'evidence/quality-strategy-0.38.0.png',fullPage:true});assert.deepEqual(errors,[]);await page.evaluate(()=>window.view.close());
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
