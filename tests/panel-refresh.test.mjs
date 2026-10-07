// Actual Chrome executing the shipping view with controlled protocol responses.
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
test('view clears offline and expired activity and ignores a response returning after disconnect',async()=>{
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});try{const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    const result=await page.evaluate(async()=>{
      const {setupTeamView}=await import('/team-view.mjs');const team={id:'team',mode:'host-leader',projectPath:'E:/example',goal:'Controlled browser response fixture',revision:2,state:'active',dispatchPaused:false,members:[{id:'dev',role:'Dev',responsibility:'Work',writeScopes:[],agentThreadId:'child',agentPath:'/root/dev'}],tasks:[{id:'work',memberId:'dev',title:'Work',goal:'Work',acceptance:'Pass',status:'running',dependencies:[],attempts:[{id:'attempt',state:'running',agentThreadId:'child'}],evidence:[]}]};
      const data={kind:'team-detail',team,runs:[{taskId:'work',memberId:'dev',attemptId:'attempt',threadId:'child',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',statusEvidence:{freshUntil:new Date(Date.now()+60000).toISOString()}}],observedAt:new Date().toISOString()};
      const discovery={kind:'team-workspace',context:{cwd:team.projectPath},teams:[{id:team.id}]};let release,readCount=0;
      const view=setupTeamView({async callServerTool({name}){if(name==='open_team_workspace')return {structuredContent:discovery};if(++readCount===1)return {structuredContent:structuredClone(data)};return new Promise(r=>release=()=>r({structuredContent:structuredClone(data)}));}});
      await view.connect();for(let n=0;n<100&&!release;n++)await new Promise(r=>setTimeout(r,10));
      const running=document.querySelector('#activeCount').textContent;view.disconnect();const offline=document.querySelector('#activeCount').textContent;release();await new Promise(r=>setTimeout(r,30));const afterLate=document.querySelector('#activeCount').textContent;
      const expired=structuredClone(data);expired.runs[0].statusEvidence.freshUntil=new Date(Date.now()-1000).toISOString();await view.accept(expired);const stale=document.querySelector('#memberTree').textContent;view.close();
      let releaseNested;const nested=setupTeamView({async callServerTool({name}){if(name==='open_team_workspace')return {structuredContent:discovery};return new Promise(r=>releaseNested=()=>r({structuredContent:structuredClone(data)}));}});
      await nested.accept(data);const connecting=nested.connect();for(let n=0;n<100&&!releaseNested;n++)await new Promise(r=>setTimeout(r,10));nested.disconnect();releaseNested();await connecting;await new Promise(r=>setTimeout(r,30));const afterNestedLate=document.querySelector('#activeCount').textContent;nested.close();
      return {running,offline,afterLate,stale,afterNestedLate};
    });assert.equal(result.running,'1 人执行中');assert.ok(!result.offline.includes('人执行中'));assert.ok(!result.afterLate.includes('人执行中'));assert.ok(result.stale.includes('状态未知'));assert.ok(!result.afterNestedLate.includes('人执行中'));
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('active panel polls lightweight state and reloads evidence only when its token changes',async()=>{
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});try{
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async()=>{
      const {setupTeamView}=await import('/team-view.mjs');window.calls=[];window.changedEvidence=false;window.holdFull=false;
      const team={id:'team',mode:'host-leader',projectPath:'E:/example',leaderThreadId:'leader',goal:'Controlled latency fixture',revision:2,state:'active',dispatchPaused:false,members:[{id:'dev',role:'Dev',responsibility:'Read source',writeScopes:[],agentThreadId:'child',agentPath:'/root/dev'}],tasks:[{id:'work',memberId:'dev',title:'Read source',goal:'Read source',acceptance:'Pass',status:'running',dependencies:[],attempts:[{id:'attempt',state:'running',agentThreadId:'child'}],evidence:[]}]};
      const snapshot=()=>({kind:'team-detail',team:structuredClone(team),detailToken:window.changedEvidence?'new':'old',runs:[{taskId:'work',memberId:'dev',attemptId:'attempt',threadId:'child',turnId:'turn',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',observedAt:new Date().toISOString(),outputs:[{text:window.changedEvidence?'Updated public evidence':'Original public evidence'}],commands:[]}],observedAt:new Date().toISOString()});
      window.view=setupTeamView({async callServerTool({name,arguments:args}){
        window.calls.push({name,args,at:performance.now()});
        if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:team.projectPath},teams:[{id:team.id}]}};
        if(args.view==='full'){
          const response={structuredContent:snapshot()};
          if(window.holdFull)return new Promise(resolve=>{window.releaseFull=()=>resolve(response);});
          return response;
        }
        return {structuredContent:{kind:'team-state',team:{id:team.id,revision:2},detailToken:window.changedEvidence?'new':'old',runs:[{taskId:'work',attemptId:'attempt',status:'completed',connection:'snapshot',observedAt:new Date().toISOString(),observationError:null}],observedAt:new Date().toISOString()}};
      }});await window.view.connect();
    });
    await expect.poll(()=>page.evaluate(()=>window.calls.filter(c=>c.args?.view==='state').length)).toBeGreaterThanOrEqual(2);
    const timing=await page.evaluate(()=>{const states=window.calls.filter(c=>c.args?.view==='state');return {interval:states[1].at-states[0].at,full:window.calls.filter(c=>c.args?.view==='full').length};});
    assert.ok(timing.interval<1100,'active polling must not add the old 1500ms wait');assert.equal(timing.full,1,'status-only changes must not retransmit history');
    await expect(page.locator('#memberTree')).toContainText('执行已结束');
    await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:attempt"]').click();
    await expect(page.locator('#memberDetail')).toContainText('Original public evidence');
    await page.evaluate(()=>{window.changedEvidence=true;});
    await expect(page.locator('#memberDetail')).toContainText('Updated public evidence');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.args?.view==='full').length),2);
    await page.evaluate(()=>{window.changedEvidence=false;window.holdFull=true;});
    await expect.poll(()=>page.evaluate(()=>typeof window.releaseFull)).toBe('function');
    await page.evaluate(()=>{window.view.disconnect();window.releaseFull();});
    await expect(page.locator('#memberDetail')).toContainText('Updated public evidence');
    await expect(page.locator('#activeCount')).not.toContainText('人执行中');
    await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('a received terminal state is visible while changed delivery details are still loading',async()=>{
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});try{
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async()=>{
      const {setupTeamView}=await import('/team-view.mjs');
      const team={id:'team',mode:'host-leader',projectPath:'E:/example',leaderThreadId:'leader',goal:'Controlled terminal refresh fixture',revision:2,state:'active',members:[{id:'dev',role:'Dev',responsibility:'Read source',writeScopes:[],agentThreadId:'child'}],tasks:[{id:'work',title:'Read source',memberId:'dev',kind:'work',status:'running',dependencies:[],attempts:[{id:'attempt',state:'running',agentThreadId:'child'}],evidence:[]}]};
      const full={kind:'team-detail',team,detailToken:'old',runs:[{taskId:'work',memberId:'dev',attemptId:'attempt',threadId:'child',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',observedAt:new Date().toISOString(),outputs:[{text:'Original public evidence'}],commands:[]}],observedAt:new Date().toISOString()};
      window.fullCalls=0;
      window.view=setupTeamView({callServerTool(){window.fullCalls++;if(window.fullCalls>1)return Promise.resolve({structuredContent:window.nextFull});return new Promise(resolve=>{window.releaseFull=()=>resolve({structuredContent:{...full,detailToken:'new',runs:[{...full.runs[0],status:'completed',outputs:[{text:'New completed delivery'}]}]}});});}});
      await window.view.accept(full);
      window.stateReceivedAt=performance.now();window.pendingState=window.view.accept({kind:'team-state',team:{id:team.id,revision:2},detailToken:'new',runs:[{taskId:'work',attemptId:'attempt',status:'completed',connection:'snapshot',observedAt:new Date().toISOString()}],observedAt:new Date().toISOString()});
      window.stateToDOMMs=document.querySelector('#memberTree').textContent.includes('执行已结束')?performance.now()-window.stateReceivedAt:null;
    });
    await expect.poll(()=>page.evaluate(()=>typeof window.releaseFull)).toBe('function');
    await expect(page.locator('#memberTree')).toContainText('执行已结束',{timeout:500});
    await expect(page.locator('#activeCount')).not.toContainText('人执行中');
    const stateToDOMMs=await page.evaluate(()=>window.stateToDOMMs);assert.notEqual(stateToDOMMs,null);console.log(JSON.stringify({kind:'controlled-Chrome-state-to-DOM-not-end-to-end',stateToDOMMs}));
    await page.evaluate(async()=>{
      const state={kind:'team-state',team:{id:'team',revision:3,tasks:[{id:'work',title:'Read source',memberId:'dev',kind:'work',status:'accepted',dependencies:[],attempt:{id:'attempt',state:'completed',agentThreadId:'child'}}]},detailToken:'revision-three',runs:[{taskId:'work',attemptId:'attempt',status:'completed',connection:'snapshot',observedAt:new Date().toISOString()}],observedAt:new Date().toISOString()};
      await window.view.accept(state);await window.view.accept(state);await window.view.accept(state);
      window.nextFull={kind:'team-detail',team:{id:'team',mode:'host-leader',projectPath:'E:/example',leaderThreadId:'leader',revision:3,state:'active',members:[{id:'dev',role:'Dev',responsibility:'Read source',writeScopes:[],agentThreadId:'child'}],tasks:[{id:'work',title:'Read source',goal:'Read source',acceptance:'Pass',memberId:'dev',kind:'work',status:'accepted',dependencies:[],attempts:[{id:'attempt',state:'completed',agentThreadId:'child'}],evidence:[]}]},detailToken:'revision-three',runs:[{...state.runs[0],memberId:'dev',threadId:'child',outputs:[{text:'New completed delivery'}],commands:[]}],observedAt:new Date().toISOString()};
    });
    await expect(page.locator('[data-task-id="work"]')).toContainText('已验收');
    assert.equal(await page.evaluate(()=>window.fullCalls),1,'coalesce newer state while one detail request is pending');
    await page.evaluate(async()=>{window.releaseFull();await window.pendingState;});
    await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:attempt"]').click();
    await expect(page.locator('#memberDetail')).toContainText('New completed delivery');
    await expect(page.locator('[data-task-id="work"]')).toContainText('已验收');
    assert.equal(await page.evaluate(()=>window.fullCalls),2,'fetch only the latest queued detail snapshot');
    await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('returning to a visible panel wakes sync; slow navigation does not block polling or create overlapping reads',async()=>{
  const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
  const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:'chrome',headless:true});try{
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async()=>{
      const {setupTeamView}=await import('/team-view.mjs');window.hiddenFixture=true;Object.defineProperty(document,'hidden',{get:()=>window.hiddenFixture,configurable:true});window.calls=[];window.activeReads=0;window.peakReads=0;window.completedReads=0;window.navigationReads=0;
      const team={id:'team',mode:'host-leader',projectPath:'E:/example',leaderThreadId:'leader',revision:2,state:'active',members:[{id:'dev',role:'Dev',responsibility:'Read source',writeScopes:[]}],tasks:[{id:'work',title:'Read source',memberId:'dev',kind:'work',status:'running',dependencies:[],attempts:[{id:'attempt',state:'running'}],evidence:[]}]};
      localStorage.setItem('team-workspace:interaction:v1:'+JSON.stringify([team.projectPath,team.leaderThreadId,team.id]),JSON.stringify({navigationId:'pending-navigation'}));
      const full={kind:'team-detail',team,detailToken:'same',runs:[],observedAt:new Date().toISOString()};
      window.view=setupTeamView({async callServerTool({name,arguments:args}){
        if(name==='read_team_navigation'){window.navigationReads++;return new Promise(()=>{});}
        if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:team.projectPath},teams:[{id:team.id}]}};
        if(args.view==='full')return {structuredContent:full};
        window.calls.push(performance.now());window.activeReads++;window.peakReads=Math.max(window.peakReads,window.activeReads);
        await new Promise(resolve=>setTimeout(resolve,180));window.activeReads--;window.completedReads++;
        return {structuredContent:{kind:'team-state',team:{id:team.id,revision:2},detailToken:'same',runs:[],observedAt:new Date().toISOString()}};
      }});await window.view.connect();
    });
    await expect.poll(()=>page.evaluate(()=>window.completedReads)).toBeGreaterThanOrEqual(1);
    await page.evaluate(()=>{window.visibleAt=performance.now();window.hiddenFixture=false;document.dispatchEvent(new Event('visibilitychange'));});
    await expect.poll(()=>page.evaluate(()=>window.calls.length)).toBeGreaterThanOrEqual(2);
    const wake=await page.evaluate(()=>window.calls[1]-window.visibleAt);assert.ok(wake<200,'visibility must wake a hidden 10s timer immediately');
    await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
    await expect.poll(()=>page.evaluate(()=>window.completedReads)).toBeGreaterThanOrEqual(4);
    const result=await page.evaluate(()=>({calls:window.calls.slice(-3),peak:window.peakReads,navigationReads:window.navigationReads}));
    assert.equal(result.peak,1,'only one state read may be in flight');assert.equal(result.navigationReads,1,'a stalled navigation read must not be duplicated');
    assert.ok((result.calls[2]-result.calls[0])/2<550,'request duration must not be added to the refresh interval');
    console.log(JSON.stringify({kind:'controlled-Chrome-poll-scheduling-not-Desktop',wakeMs:wake,averageStartIntervalMs:(result.calls[2]-result.calls[0])/2,stateRequestDelayMs:180,peakStateReads:result.peak}));
    await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
