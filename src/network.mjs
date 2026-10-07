import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Reuse an existing local Windows proxy. Never discover credentials or alter OS settings.
export function proxyEnvironment(env, settings) {
  const next = {...env};
  if (Object.keys(env).some(k => /^(https?|all)_proxy$/i.test(k) && env[k])) return next;
  if (settings?.enabled !== 1 || typeof settings.server !== 'string') return next;
  const mappings = Object.fromEntries(settings.server.split(';').map(part => {
    const pair = part.trim().split('='); return pair.length === 1 ? ['all',pair[0]] : pair;
  }));
  for (const protocol of ['http','https']) {
    const address = mappings[protocol] ?? mappings.all;
    if (!address) continue;
    try {
      const url = new URL(address.includes('://') ? address : `http://${address}`);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
          !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !url.port ||
          url.pathname !== '/' || url.search || url.hash) continue;
      next[`${protocol.toUpperCase()}_PROXY`] = url.origin;
    } catch { /* Unsupported OS proxy format: preserve environment. */ }
  }
  return next;
}

export async function executionEnvironment(env = process.env) {
  if (process.platform !== 'win32') return {...env};
  if (Object.keys(env).some(k => /^(https?|all)_proxy$/i.test(k) && env[k])) return {...env};
  try {
    const command = "$p=Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer} | ConvertTo-Json -Compress";
    const {stdout} = await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
      {windowsHide:true,timeout:5000,maxBuffer:8192});
    return proxyEnvironment(env,JSON.parse(stdout));
  } catch { return {...env}; }
}
