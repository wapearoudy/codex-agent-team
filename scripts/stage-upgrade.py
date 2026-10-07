"""Stage this task's versioned source; verify old source and preserve all host config."""
from pathlib import Path
import zipfile
import shutil
import json
import hashlib

root=Path(__file__).resolve().parent.parent
destination=Path.home()/'.agents/plugins/team-workspace-probe'
source=root/'plugins/team-workspace-probe'
previous=json.loads((destination/'plugin.json').read_text(encoding='utf8'))['version']
version=json.loads((source/'plugin.json').read_text(encoding='utf8'))['version']
old=root/f'artifacts/team-workspace-probe-{previous}.zip'
with zipfile.ZipFile(old) as z:
    expected={n.removeprefix('team-workspace-probe/'):z.read(n) for n in z.namelist() if not n.endswith('/')}
actual={p.relative_to(destination).as_posix():p.read_bytes() for p in destination.rglob('*') if p.is_file()}
if actual!=expected:
    raise RuntimeError('Staged source changed outside this operation; refusing overwrite')
config=Path.home()/'.codex/config.toml'
before=hashlib.sha256(config.read_bytes()).hexdigest()
for p in source.rglob('*'):
    if p.is_symlink(): raise RuntimeError('Symlink not allowed')
    if p.is_file():
        target=destination/p.relative_to(source)
        if not target.resolve().is_relative_to(destination.resolve()): raise RuntimeError('Path escaped plugin')
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(p,target)
after=hashlib.sha256(config.read_bytes()).hexdigest()
assert before==after
record={'status':'SOURCE_UPDATED_HOST_RELOAD_PENDING','version':version,
        'destination':str(destination),'backup':str(old),'configBefore':before,'configAfter':after,
        'cacheModified':False,'modelStarted':False}
(root/f'evidence/upgrade-{version}.json').write_text(json.dumps(record,indent=2),encoding='utf8')
print(json.dumps(record,indent=2))
