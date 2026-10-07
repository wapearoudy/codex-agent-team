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
            z.write(path, 'team-workspace-probe/' + path.relative_to(plugin).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert all(name.startswith('team-workspace-probe/') for name in z.namelist())
    assert 'team-workspace-probe/dist/server.cjs' in z.namelist()
    assert 'team-workspace-probe/dist/host.html' in z.namelist()
    record = {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
              'entries': z.namelist(), 'kind': 'private-host-probe-not-final-product',
              'packagingInstallsPlugin': False, 'uploaded': False}
(root / 'evidence' / 'archive.json').write_text(json.dumps(record, ensure_ascii=False, indent=2),encoding='utf-8')
print(json.dumps(record,ensure_ascii=False,indent=2))
