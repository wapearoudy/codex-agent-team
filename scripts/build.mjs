import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
const out = 'plugins/team-workspace-probe/dist';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['src/server.mjs'], outfile: `${out}/server.cjs`, platform: 'node',
  target: 'node22', bundle: true, format: 'cjs' });
const view = await build({ entryPoints: ['src/view.mjs'], write: false, platform: 'browser',
  target: 'es2022', bundle: true, format: 'iife' });
const {version}=JSON.parse(await readFile('package.json','utf8'));
const html = (await readFile('src/host.html','utf8')).replace('__TEAM_VERSION__',version).replace('/*__BUNDLE__*/', () => view.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
await writeFile(`${out}/host.html`, html);
console.log('Built self-contained stdio server and MCP Apps resource. No server started.');

// Every host receives the same engine. Native entrypoints externalize only the
// SDK supplied by that host, keeping model clients/credentials out of the plugin.
for(const host of ['deepseek-harness','claude-code','opencode']){
  const destination=`artifacts/hosts/${host}`;
  await mkdir(`${destination}/dist`,{recursive:true});
  for(const file of ['server.cjs','host.html'])await cp(`${out}/${file}`,`${destination}/dist/${file}`);
  const source=`integrations/${host}`;
  for(const entry of await readdir(source,{withFileTypes:true})){
    if(entry.name.endsWith('.mjs')||entry.name==='hooks')continue;
    await cp(`${source}/${entry.name}`,`${destination}/${entry.name}`,{recursive:true});
  }
  if(host==='claude-code'){
    await mkdir(`${destination}/hooks`,{recursive:true});
    await cp(`${source}/hooks/hooks.json`,`${destination}/hooks/hooks.json`);
    await build({entryPoints:[`${source}/hooks/bridge.mjs`],outfile:`${destination}/hooks/bridge.mjs`,platform:'node',target:'node22',bundle:true,format:'esm'});
  }else await build({entryPoints:[`${source}/index.mjs`],outfile:`${destination}/dist/index.mjs`,platform:'node',target:'node22',bundle:true,format:'esm',external:['@opencode-ai/*','@deepseek-ai/*'],banner:{js:"import { createRequire as createHostRequire } from 'node:module'; const require = createHostRequire(import.meta.url);"}});
}
await mkdir('artifacts/hosts/.claude-plugin',{recursive:true});
await writeFile('artifacts/hosts/.claude-plugin/marketplace.json',JSON.stringify({name:'team-workspace-local',owner:{name:'Team Workspace'},plugins:[{name:'team-workspace',source:'./claude-code'}]},null,2));
console.log('Built native packages for DeepSeekHarness, Claude Code and OpenCode.');
