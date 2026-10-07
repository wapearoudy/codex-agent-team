import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const validator = new Ajv2020({ allErrors: true, strict: false });
addFormats(validator);
const checks = [];
for (const kind of ['plugin','mcp']) {
  const schema = JSON.parse((await readFile(`schemas/${kind}.schema.json`,'utf8')).replace(/^\uFEFF/,''));
  const data = JSON.parse(await readFile(`plugins/team-workspace-probe/${kind}.json`,'utf8'));
  const valid = validator.compile(schema);
  if (!valid(data)) throw new Error(JSON.stringify(valid.errors));
  checks.push({ file:`${kind}.json`,schema:schema.$id,status:'PASS' });
}
await mkdir('evidence',{recursive:true});
await writeFile('evidence/package-validation.json',JSON.stringify({observedAt:new Date().toISOString(),checks,hostInstallation:'NOT_RUN'},null,2));
console.log('Both manifests pass the published Agent Plugins 1.0 JSON schemas. Host installation remains NOT_RUN.');
