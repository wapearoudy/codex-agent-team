import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';

test('panel shows bounded quality metadata and selects the correct historical executor after reassignment',async()=>{
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs','/panel-plan-start.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async()=>{
      const {setupTeamView}=await import('/team-view.mjs');
      const team={id:'fixture',projectPath:'/fixture/project',goal:'Controlled quality fixture',mode:'host-leader',revision:2,state:'active',dispatchPaused:false,members:[{id:'old',role:'原开发',responsibility:'旧轮执行',writeScopes:['src'],agentThreadId:'child-old',rosterVerified:true,removedAt:'2026-01-01T00:00:00Z'},{id:'new',role:'新开发',responsibility:'接手任务',writeScopes:['src'],agentThreadId:'child-new',rosterVerified:true}],tasks:[{id:'repair',title:'修复任务',goal:'Fix behavior',acceptance:'Checks pass',memberId:'new',status:'waiting',repairRootTaskId:'root',repairRound:2,contract:{stage:'repair',inScope:['src'],outOfScope:['src/secrets'],verify:['node --test']},dependencies:[],attempts:[{id:'old-attempt',memberId:'old',number:1,state:'failed',runtimeStatus:'failed',agentThreadId:'child-old'}],evidence:[]}]};
      const data={kind:'team-detail',team,detailToken:'detail',runs:[{taskId:'repair',memberId:'old',attemptId:'old-attempt',threadId:'child-old',status:'failed',outputs:[{text:'原执行者的公开交付'}]}],quality:{coverage:[{id:'G-1',status:'pending'}],repairCount:1,openFindingCount:1,openFindings:[{id:'F-1',rootTaskId:'root',severity:'high',description:'负向输入缺少处理'}]},observedAt:new Date().toISOString()};
      window.view=setupTeamView({async callServerTool(){return {structuredContent:data};}});await window.view.accept(data);
    });
    await expect(page.locator('#qualitySummary')).toContainText('1 次修复 · 1 项未关闭问题');
    await expect(page.locator('#memberTree')).toContainText('岗位已移除');await expect(page.locator('#membersHeading')).toContainText('1 名成员');
    await page.locator('[data-task-id="repair"]').click();await expect(page.locator('#taskDetail')).toContainText('node --test');await expect(page.locator('#taskDetail')).toContainText('high · F-1');
    await page.locator('[data-member-id="old"] [data-focus-key="view-member:old"]').click();await page.locator('[data-focus-key="execution-tab:old-attempt"]').click();
    await expect(page.locator('#memberDetail h2')).toContainText('原开发');await expect(page.locator('#memberDetail')).toContainText('原执行者的公开交付');
    await mkdir('evidence/strengthening-ui',{recursive:true});await page.screenshot({path:'evidence/strengthening-ui/wide.png',fullPage:true});
    await page.setViewportSize({width:360,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'evidence/strengthening-ui/narrow.png'});
    assert.deepEqual(errors,[]);await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
