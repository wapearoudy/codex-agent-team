"""Create a local plugin ZIP. Does not upload, install or publish."""
import hashlib
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
plugin = root / 'plugins' / 'team-workspace-probe'
output = root / 'artifacts'
output.mkdir(exist_ok=True)
(root / 'evidence').mkdir(exist_ok=True)
version=json.loads((plugin/'plugin.json').read_text(encoding='utf8'))['version']
archive = output / f'team-workspace-probe-{version}.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in sorted(plugin.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'Symlink not allowed: {path}')
        if path.is_file():
            entry=zipfile.ZipInfo('team-workspace-probe/' + path.relative_to(plugin).as_posix(),date_time=(2020,1,1,0,0,0))
            entry.compress_type=zipfile.ZIP_DEFLATED
            entry.external_attr=0o100644 << 16
            z.writestr(entry,path.read_bytes())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert all(name.startswith('team-workspace-probe/') for name in z.namelist())
    assert 'team-workspace-probe/dist/server.cjs' in z.namelist()
    assert 'team-workspace-probe/dist/host.html' in z.namelist()
    checksum=hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{checksum}  {archive.name}\n',encoding='utf-8')
    record = {'archive': str(archive), 'sha256': checksum,
              'entries': z.namelist(), 'kind': 'experimental-team-workspace-release-package',
              'packagingInstallsPlugin': False, 'uploaded': False}
(root / 'evidence' / 'archive.json').write_text(json.dumps(record, ensure_ascii=False, indent=2),encoding='utf-8')
print(json.dumps(record,ensure_ascii=False,indent=2))
