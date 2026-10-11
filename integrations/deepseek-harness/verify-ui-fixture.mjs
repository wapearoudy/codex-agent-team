// Chromium interaction fixture, explicitly separate from deployed native evidence.
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const sdk=process.env.DSH_RUNTIME_ROOT??join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh');
const hostRequire=createRequire(join(sdk,'package.json'));
const official=JSON.parse(await readFile(join(sdk,'node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/package.json'),'utf8'));
assert.equal(official.dsh.client.platform,'web');assert.ok(official.exports['./client']);
const own=await readFile(new URL('./client.js',import.meta.url),'utf8');
const bundle=await build({stdin:{contents:`import * as React from ${JSON.stringify(hostRequire.resolve('react').replaceAll('\\','/'))};
import {createRoot} from ${JSON.stringify(hostRequire.resolve('react-dom/client').replaceAll('\\','/'))};
let entry;window.__ModuleLoader__={load:v=>entry=v};${own}
const ui=entry.factory(()=>React);let listeners=new Set();
let state={projectionsBySession:{lead:{values:{agentTeam:{members:[{id:'lead',name:'lead',role:'Leader'},{id:'member-id',name:'developer',role:'开发'}],tasks:[{id:'t1',subject:'真实成员导航',status:'in_progress',ownerName:'developer'},{id:'t2',subject:'未知负责人',status:'pending',ownerName:'unresolved'}]}}}},phase:'ready'};
let status=new Map([['lead',{running:false}],['member-id',{running:true}]]);window.opened=[];let Component,actions;
const ctx={sessions:{list:{getSnapshot:()=>state},binding:()=>({session:{getSnapshot:()=>({})}}),retainInfo:()=>({getSnapshot:()=>({retainedBy:{mainView:1}})})},uiWorkspace:{openSession:v=>window.opened.push(v)},slots:{inject:(_n,fn)=>fn(),register:(spec,c)=>{Component=c;actions=spec.inject();}}};ui.apply(ctx);
const useStore=select=>select(React.useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb);},()=>state));
const useStatus=select=>{useStore(x=>x);return select(status);};
window.change=()=>{state={...state,projectionsBySession:{lead:{values:{agentTeam:{...state.projectionsBySession.lead.values.agentTeam,members:[{id:'lead',name:'lead'}]}}}}};status=new Map([['lead',{running:true}]]);for(const listener of listeners)listener();};
window.engine=()=>{state={...state,projectionsBySession:{lead:{values:{teamWorkspace:{schemaVersion:1,source:'team-workspace-engine',host:'deepseek-harness',sessionId:'lead',observedAt:new Date().toISOString(),team:{id:'engine-team',revision:8,goal:'引擎团队任务',state:'running',members:[{id:'dev',name:'engine developer',role:'开发',nativeSessionId:'engine-native-child',bindingVerified:true}],tasks:[{id:'e1',title:'引擎真实任务字段',status:'submitted',ownerMemberId:'dev',blockedBy:[]}]}}}}}};for(const listener of listeners)listener();};
window.staleEngine=()=>{state={...state,projectionsBySession:{lead:{values:{teamWorkspace:{...state.projectionsBySession.lead.values.teamWorkspace,observedAt:new Date(Date.now()-21000).toISOString()}}}}};for(const listener of listeners)listener();};
createRoot(document.getElementById('root')).render(React.createElement(Component,{sessionId:'lead',useSession:fn=>fn({}),useSessions:useStore,useSessionStatus:useStatus,...actions}));`,resolveDir:resolve('.')},bundle:true,write:false,platform:'browser',format:'iife'});
const dir=resolve('evidence/native-ui-039');await mkdir(dir,{recursive:true});const browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
try{const page=await browser.newPage({viewport:{width:1000,height:800}});await page.setContent('<div id="root" style="margin:30px;width:600px;text-align:right"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.getByRole('button',{name:'团队工作区 (2)',exact:true}).click();await page.getByText('运行中',{exact:false}).waitFor();
 await page.getByRole('button',{name:'developer',exact:true}).nth(1).click();assert.deepEqual(await page.evaluate(()=>window.opened),[{parentSessionId:'lead',childSessionId:'member-id',mode:'continuable'}]);
 assert.equal(await page.getByRole('button',{name:'unresolved',exact:true}).isDisabled(),true);await page.screenshot({path:join(dir,'fixture-members.png')});
 await page.evaluate(()=>window.change());await page.getByRole('button',{name:'团队工作区 (1)',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'developer',exact:true}).isDisabled(),true);
 await page.screenshot({path:join(dir,'fixture-stale.png')});await page.evaluate(()=>window.engine());await page.getByText('引擎真实任务字段',{exact:true}).waitFor();await page.getByRole('button',{name:'engine developer',exact:true}).nth(1).click();assert.deepEqual((await page.evaluate(()=>window.opened)).at(-1),{parentSessionId:'lead',childSessionId:'engine-native-child',mode:'continuable'});await page.screenshot({path:join(dir,'fixture-engine.png')});await page.evaluate(()=>window.staleEngine());assert.equal(await page.getByRole('button',{name:'engine developer',exact:true}).nth(1).isDisabled(),true);
 await writeFile(join(dir,'fixture.json'),JSON.stringify({scope:'Chromium public-slot fixture; simulated native projections, not deployed member execution',sdkVersion:official.version,status:'PASS',checks:['live status render','actual id navigation shape','unresolved owner disabled','projection change removes member and disables owner','independent engine task render and navigation','engine freshness expiry disables navigation']},null,2));console.log('PASS Chromium fixture: status, navigation, unknown/stale owner, independent engine task/freshness; SDK metadata '+official.version);
}finally{await browser.close();}
