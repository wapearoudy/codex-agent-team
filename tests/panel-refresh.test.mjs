// Actual Chrome executing the shipping view with controlled protocol responses.
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
test('temporary read failure does not flicker to unknown; expiry explains delay and preserves native evidence',async()=>{
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','');
 const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.clock.install({time:new Date('2026-10-10T08:00:00Z')});await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const {setupTeamView}=await import('/team-view.mjs');
   const team={id:'team',mode:'host-leader',projectPath:'/project',leaderThreadId:'leader',goal:'Controlled observation-health fixture',revision:2,state:'active',members:[{id:'dev',role:'Dev',responsibility:'Read source',writeScopes:[],agentThreadId:'child',rosterVerified:true}],tasks:[{id:'work',title:'Read source',memberId:'dev',kind:'work',goal:'Read source',acceptance:'Pass',status:'running',dependencies:[],attempts:[{id:'attempt',number:1,state:'running',agentThreadId:'child',turnId:'turn'}],evidence:[]}]};
   window.original={kind:'team-detail',team,detailToken:'same',runs:[{taskId:'work',memberId:'dev',attemptId:'attempt',threadId:'child',turnId:'turn',status:'inProgress',connection:'snapshot',source:'native-thread-persisted-snapshot',observedAt:new Date().toISOString(),statusEvidence:{status:'inProgress',source:'persisted-native-activity',at:new Date().toISOString(),freshUntil:new Date(Date.now()+3500).toISOString()},outputs:[{text:'Evidence kept intact'}],commands:[]}],observedAt:new Date().toISOString()};
   window.stateCalls=0;window.view=setupTeamView({async callServerTool({name,arguments:args}){
    if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:'/project'},teams:[{id:'team'}]}};
    if(args.view==='panel')return {structuredContent:structuredClone(window.original)};
    if(++window.stateCalls===1)throw new Error('Controlled transport timeout');
    return new Promise(()=>{});
   }});await window.view.connect();
  });
  await expect(page.locator('#errorText')).toContainText('Controlled transport timeout');
  await expect(page.locator('#activeCount')).toContainText('1 人执行中');await expect(page.locator('#memberTree')).not.toContainText('状态未知');await expect(page.locator('#memberTree')).toContainText('连接暂不可用');
  await page.clock.runFor(4000);await expect(page.locator('#activeCount')).toContainText('1 项记录待更新');await expect(page.locator('#memberTree')).toContainText('执行记录待更新');await expect(page.locator('#teamControlStatus')).toContainText('执行记录待更新');
  await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:attempt"]').click();await expect(page.locator('#memberDetail')).toContainText('Evidence kept intact');
  await page.locator('#taskDetail summary').last().click();
  const raw=await page.locator('#taskDetail pre').last().textContent();assert.match(raw,/"status": "inProgress"/);assert.match(raw,/"freshUntil": "2026-10-10T08:00:03/);assert.doesNotMatch(raw,/"status": "accepted"/);
  await page.screenshot({path:'evidence/unknown-state-stale-panel.png',fullPage:true});
  await page.evaluate(async()=>{
   const invalid=structuredClone(window.original);invalid.observedAt=new Date().toISOString();invalid.runs[0]={...invalid.runs[0],status:'unknown',connection:'unavailable',observedAt:invalid.observedAt,observationError:'Controlled identity mismatch',observationIssue:{kind:'verification-failed',at:invalid.observedAt}};await window.view.accept(invalid);
  });
  await expect(page.locator('#memberTree')).toContainText('状态未知');await expect(page.locator('#memberDetail')).toContainText('执行关联待核对：Controlled identity mismatch');
  await page.evaluate(async()=>{const completed=structuredClone(window.original);completed.observedAt=new Date().toISOString();completed.runs[0]={...completed.runs[0],status:'completed',observedAt:completed.observedAt};await window.view.accept(completed);});
  await expect(page.locator('#memberTree')).toContainText('执行已结束');await expect(page.locator('#memberDetail')).not.toContainText('Controlled identity mismatch');await expect(page.locator('#memberDetail')).toContainText('Evidence kept intact');await page.evaluate(()=>window.view.close());
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
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
    });assert.equal(result.running,'1 人执行中');assert.ok(!result.offline.includes('人执行中'));assert.ok(!result.afterLate.includes('人执行中'));assert.ok(result.stale.includes('执行记录待更新'));assert.ok(!result.afterNestedLate.includes('人执行中'));
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
        if(args.view==='panel'){
          const response={structuredContent:snapshot()};
          if(window.holdFull)return new Promise(resolve=>{window.releaseFull=()=>resolve(response);});
          return response;
        }
        return {structuredContent:{kind:'team-state',team:{id:team.id,revision:2},detailToken:window.changedEvidence?'new':'old',runs:[{taskId:'work',attemptId:'attempt',status:'completed',connection:'snapshot',observedAt:new Date().toISOString(),observationError:null}],observedAt:new Date().toISOString()}};
      }});await window.view.connect();
    });
    await expect.poll(()=>page.evaluate(()=>window.calls.filter(c=>c.args?.view==='state').length)).toBeGreaterThanOrEqual(2);
    const timing=await page.evaluate(()=>{const states=window.calls.filter(c=>c.args?.view==='state');return {interval:states[1].at-states[0].at,full:window.calls.filter(c=>c.args?.view==='panel').length};});
    assert.ok(timing.interval>=800&&timing.interval<1200,'completed execution waits about 1s instead of continuing at 250ms');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.args?.view==='full').length),0);assert.equal(timing.full,1,'status-only changes must not retransmit history');
    await expect(page.locator('#memberTree')).toContainText('执行已结束');
    await page.locator('[data-focus-key="history:dev"]').click();await page.locator('[data-focus-key="attempt:attempt"]').click();
    await expect(page.locator('#memberDetail')).toContainText('Original public evidence');
    await page.evaluate(()=>{window.changedEvidence=true;});
    await expect(page.locator('#memberDetail')).toContainText('Updated public evidence');
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.args?.view==='panel').length),2);
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
      const activeRun={taskId:'work',memberId:'dev',attemptId:'attempt',status:'inProgress',connection:'connected'};const full={kind:'team-detail',team,detailToken:'same',runs:[activeRun],observedAt:new Date().toISOString()};
      window.view=setupTeamView({async callServerTool({name,arguments:args}){
        if(name==='read_team_navigation'){window.navigationReads++;return new Promise(()=>{});}
        if(name==='open_team_workspace')return {structuredContent:{kind:'team-workspace',context:{cwd:team.projectPath},teams:[{id:team.id}]}};
        if(args.view==='panel')return {structuredContent:full};
        window.calls.push(performance.now());window.activeReads++;window.peakReads=Math.max(window.peakReads,window.activeReads);
        await new Promise(resolve=>setTimeout(resolve,180));window.activeReads--;window.completedReads++;
        return {structuredContent:{kind:'team-state',team:{id:team.id,revision:2},detailToken:'same',runs:[activeRun],observedAt:new Date().toISOString()}};
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
    assert.ok((result.calls[2]-result.calls[0])/2<1200,'request duration must not be added to the refresh interval');
    console.log(JSON.stringify({kind:'controlled-Chrome-poll-scheduling-not-Desktop',wakeMs:wake,averageStartIntervalMs:(result.calls[2]-result.calls[0])/2,stateRequestDelayMs:180,peakStateReads:result.peak}));
    await page.evaluate(()=>window.view.close());
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('a later saved receipt cannot roll a verified terminal execution back to running or unknown',async()=>{
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>',''),server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'chrome',headless:true});try{const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(async()=>{
  const {setupTeamView}=await import('/team-view.mjs'),now=Date.now();const team={id:'team',mode:'host-leader',projectPath:'/fixture',goal:'Controlled terminal regression',revision:2,state:'active',members:[{id:'dev',role:'Dev',writeScopes:[],agentThreadId:'child'}],tasks:[{id:'work',title:'Work',memberId:'dev',status:'running',dependencies:[],attempts:[{id:'attempt',state:'running',turnId:'turn',agentThreadId:'child'}],evidence:[]}]};const run={taskId:'work',memberId:'dev',attemptId:'attempt',threadId:'child',turnId:'turn',status:'completed',connection:'snapshot',observedAt:new Date(now).toISOString(),outputs:[{text:'Verified final result'}]};const data={kind:'team-detail',team,runs:[run],detailToken:'same',observedAt:new Date(now).toISOString()};window.view=setupTeamView({async callServerTool(){return {structuredContent:data};}});await window.view.accept(data);
  await window.view.accept({...structuredClone(data),team:{...team,revision:3},observationMode:'saved',observedAt:new Date(now+1000).toISOString(),runs:[{...run,status:'inProgress',observedAt:new Date(now-10000).toISOString(),statusEvidence:{freshUntil:new Date(now+60000).toISOString()},outputs:[]}]});
  await window.view.accept({...structuredClone(data),team:{...team,revision:3},observedAt:new Date(now+2000).toISOString(),runs:[{...run,status:'unknown',observedAt:new Date(now+2000).toISOString(),observationError:'Transient observation failure'}]});
 });await expect(page.locator('#activeCount')).not.toContainText('状态待核对');await expect(page.locator('#teamControlStatus')).toHaveText('待 Leader 接收');await expect(page.locator('[data-task-id="work"]')).toContainText('待 Leader 接收');await page.evaluate(()=>window.view.close());}finally{await browser.close();await new Promise(r=>server.close(r));}
});


test('panel surfaces registration gaps and cache breakdown, clears repaired gaps, and detects stale connection versions',async()=>{
 const html=(await readFile('src/host.html','utf8')).replace('<script>/*__BUNDLE__*/</script>','').replace('__TEAM_VERSION__','0.25.0');
 const server=createServer(async(req,res)=>{if(!['/','/team-view.mjs','/team-projection.mjs','/team-naming.mjs'].includes(req.url)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');res.end(req.url==='/'?html:await readFile('src'+req.url,'utf8'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:'chrome',headless:true});try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const {setupTeamView}=await import('/team-view.mjs');window.calls=[];
   window.data={kind:'team-detail',pluginVersion:'0.25.0',detailToken:'same',team:{id:'team',revision:2,mode:'host-leader',projectPath:'/project',leaderThreadId:'leader',goal:'Existing native work awaits mapping',state:'active',members:[{id:'dev',role:'Dev',responsibility:'Implement',writeScopes:[]}],tasks:[{id:'work',title:'Implement',kind:'work',memberId:'dev',status:'waiting',dependencies:[],attempts:[],evidence:[]}]},runs:[],usage:{totalTokens:150,inputTokens:140,cachedInputTokens:100,uncachedInputTokens:40,outputTokens:10},registrationGap:{count:1,threadIds:['fallback'],executionAuthority:false},observedAt:new Date().toISOString()};
   window.view=setupTeamView({async callServerTool({name,arguments:args}){window.calls.push({name,args});return {structuredContent:{kind:'team-usage',usage:{contexts:[{threadId:'fallback',kind:'unregistered-native',totalTokens:20},{threadId:'leader',kind:'leader',totalTokens:130}]}}};}});await window.view.accept(window.data);
  });
  await expect(page.locator('#executionNotice')).toBeVisible();await expect(page.locator('#executionNotice')).toContainText('避免重复执行');await expect(page.locator('#usageSummary')).toContainText('缓存输入 100');await expect(page.locator('#usageSummary')).toContainText('新增输入 40');
  await page.locator('#showRegistration').click();await expect(page.locator('#recordOutput')).toContainText('fallback');await expect(page.locator('#recordOutput')).not.toContainText('leader');assert.deepEqual(await page.evaluate(()=>window.calls.map(c=>c.name)),['read_team_usage']);
  await page.evaluate(async()=>{await window.view.accept({kind:'team-state',team:{id:'team',revision:2},runs:[],detailToken:'same',pluginVersion:'0.25.0',registrationGap:null,usage:window.data.usage,observedAt:new Date().toISOString()});});await expect(page.locator('#executionNotice')).toBeHidden();await expect(page.locator('#taskList')).toContainText('待执行');
  await page.evaluate(async()=>{await window.view.accept({kind:'team-state',team:{id:'team',revision:2},runs:[],detailToken:'same',pluginVersion:'0.24.0',registrationGap:null,usage:window.data.usage,observedAt:new Date().toISOString()});});await expect(page.locator('#executionNotice')).toContainText('面板与连接版本不一致');await expect(page.locator('#showRegistration')).toBeHidden();
  await page.screenshot({path:'evidence/v5-connection-version-notice.png'});await page.evaluate(()=>window.view.close());
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
