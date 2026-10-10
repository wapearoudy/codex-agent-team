import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
