import {readFile} from 'node:fs/promises';
import {pluginDoctor} from '../src/plugin-doctor.mjs';
const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const args=process.argv.slice(2),host=args.find(a=>a.startsWith('--host='))?.slice(7)??'codex';
console.log(JSON.stringify(await pluginDoctor({version,host,registry:args.includes('--registry')}),null,2));
