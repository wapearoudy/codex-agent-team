import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
import {teamResponse} from '../src/team-responses.mjs';
import {largeDisplayFixture} from './fixtures/large-display.mjs';

test('large-log previews survive repeated refresh and history selection without retaining old DOM',async()=>{
  const original=largeDisplayFixture(),panel=teamResponse(original,'panel'),state=teamResponse(original,'state');
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{
    if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs','/panel-plan-start.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();let crashed=false;const errors=[];
    page.on('crash',()=>{crashed=true;});page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async({panel,state})=>{
      const {setupTeamView}=await import('/team-view.mjs');window.preview=panel;window.live=state;window.detailCalls=0;window.fullCalls=0;
      window.view=setupTeamView({async callServerTool({arguments:args}){
        if(args.view==='full')window.fullCalls++;
        window.detailCalls++;return {structuredContent:structuredClone(window.preview)};
      }});await window.view.accept(panel);
    },{panel,state});
    await page.locator('[data-focus-key="history:dev"]').click();
    await page.locator('[data-focus-key="attempt:attempt5-2"]').click();
    await expect(page.locator('#workspacePreparation')).toContainText('有限预览');
    assert.equal(await page.locator('#taskDetail details pre').count(),0,'collapsed raw previews must not serialize their records eagerly');
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
    const heap=async()=>{await cdp.send('HeapProfiler.collectGarbage');return (await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='JSHeapUsedSize').value;};
    const before=await heap();
    await page.evaluate(async()=>{
      for(let i=0;i<400;i++){
        window.preview.detailToken=window.live.detailToken='preview-'+i;
        window.preview.observedAt=window.live.observedAt=new Date().toISOString();
        const run=window.live.runs.at(-1);run.activity.cursor=i;run.progress=[{text:'Updated public progress '+i}];
        await window.view.accept(structuredClone(window.live));
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    });
    const after=await heap(),stats=await page.evaluate(()=>({nodes:document.querySelectorAll('*').length,details:window.detailCalls,full:window.fullCalls}));
    assert.equal(crashed,false);assert.deepEqual(errors,[]);assert.equal(stats.full,0);assert.equal(stats.details,400);
    assert.ok(stats.nodes<2500,JSON.stringify(stats));assert.ok(after-before<16*1024*1024,'discarded refresh trees must be collectable');
    await expect(page.locator('#memberDetail')).toContainText('Updated public progress 399');
    await page.locator('#taskDetail details summary').click();await expect(page.locator('#taskDetail details pre')).toBeVisible();
    console.log(JSON.stringify({kind:'controlled-Chrome-preview-stress-not-Desktop',refreshes:400,sourceBytes:Buffer.byteLength(JSON.stringify(original)),previewBytes:Buffer.byteLength(JSON.stringify(panel)),heapGrowthBytes:after-before,domNodes:stats.nodes}));
    await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
