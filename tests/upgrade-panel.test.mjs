import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

test('shipping panel shows live public activity before completion, searches task numbers and exports',async()=>{
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
 const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const {setupTeamView}=await import('/team-view.mjs');
   const team={id:'fixture',projectPath:'E:/fixture',goal:'Controlled browser fixture',mode:'host-leader',revision:1,state:'active',dispatchPaused:false,members:[{id:'dev',role:'开发',responsibility:'实现功能',writeScopes:['src'],agentThreadId:'child',rosterVerified:true}],tasks:[{id:'semantic-work',title:'执行补强',goal:'Implement',acceptance:'Tests pass',status:'running',memberId:'dev',dependencies:[],attempts:[{id:'attempt',number:1,state:'running',agentThreadId:'child'}],evidence:[]}]};
   const data={kind:'team-detail',team,detailToken:'detail',runs:[{taskId:'semantic-work',memberId:'dev',attemptId:'attempt',threadId:'child',status:'inProgress',connection:'connected',model:'host-model',progress:[{text:'正在核对真实执行记录'}],activity:{cursor:2,events:[{sequence:2,type:'exec_command_output_delta',text:'regression 8/8 passed'}]},usage:{totalTokens:123}}],usage:{totalTokens:123,unknownAttempts:0,members:[]},observedAt:new Date().toISOString()};
   window.view=setupTeamView({async callServerTool({name}){if(name==='export_team_report')return {structuredContent:{kind:'team-export',text:'# 可读团队报告',filename:'team.md',mimeType:'text/markdown'}};return {structuredContent:data};}});await window.view.accept(data);
  });
  await page.locator('[data-task-id="semantic-work"]').click();await page.getByRole('button',{name:'查看任务与执行',exact:true}).click();
  await expect(page.locator('#memberDetail')).toContainText('正在核对真实执行记录');await expect(page.locator('#memberDetail')).toContainText('regression 8/8 passed');await expect(page.locator('#usageSummary')).toContainText('123');
  await page.getByRole('searchbox',{name:'查找任务'}).fill('t1');await expect(page.locator('[data-task-id]')).toHaveCount(1);
  await page.getByRole('searchbox',{name:'查找任务'}).fill('no-match');await expect(page.locator('#dependencyGraph')).toContainText('没有符合条件');
  await page.getByRole('searchbox',{name:'查找任务'}).fill('');await page.locator('#teamRecords > summary').click();await page.getByRole('button',{name:'导出报告',exact:true}).click();await expect(page.locator('#recordOutput')).toHaveText('# 可读团队报告');
  await mkdir('evidence/upgrade-ui',{recursive:true});await page.screenshot({path:'evidence/upgrade-ui/wide.png',fullPage:true});await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'evidence/upgrade-ui/narrow.png',fullPage:true});
  assert.deepEqual(errors,[]);await page.evaluate(()=>window.view.close());
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
