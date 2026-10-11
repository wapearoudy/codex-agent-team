// Recognize a narrowly defined logging wrapper. This parses evidence only;
// it never runs a shell or accepts an arbitrary PowerShell program as a test.
// Automatic variables are maintained by PowerShell rather than the caller.
// In particular, assigning to $null discards the failure status and exit $null
// returns success. Do not treat any automatic variable as a status capture.
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_automatic_variables
const automaticVariables=new Set(('_ args ConsoleFileName EnabledExperimentalFeatures Error Event EventArgs EventSubscriber ExecutionContext false foreach HOME Host input IsCoreCLR IsLinux IsMacOS IsWindows LASTEXITCODE Matches MyInvocation NestedPromptLevel null PID PROFILE PSBoundParameters PSCmdlet PSCommandPath PSCulture PSDebugContext PSEdition PSHOME PSItem PSScriptRoot PSSenderInfo PSUICulture PSVersionTable PWD Sender ShellId StackTrace switch this true').toLowerCase().split(' '));

export function powerShellVerificationCommand(command,literalWords){
  const outer=literalWords(command);
  if(!outer||outer.length<3||!/^(?:pwsh|powershell)(?:\.exe)?$/i.test(outer[0].split(/[\\/]/).at(-1)))return null;
  const flags=outer.slice(1,-2);
  if(flags.some(flag=>!/^-(?:NoProfile|NonInteractive)$/i.test(flag))||!/^-(?:Command|c)$/i.test(outer.at(-2)))return null;
  const script=outer.at(-1);if(script.includes('`')||script.includes('\0'))return null;
  let quote=null,start=0,braces=0;const statements=[];
  for(let i=0;i<script.length;i++){
    const ch=script[i];if(quote){if(ch===quote)quote=null;continue;}if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='{')braces++;if(ch==='}'&&--braces<0)return null;
    if(!braces&&(ch===';'||ch==='\n'||ch==='\r')){if(script.slice(start,i).trim())statements.push(script.slice(start,i).trim());start=i+1;}
  }
  if(quote||braces)return null;if(script.slice(start).trim())statements.push(script.slice(start).trim());
  if(statements.length<3||statements.length>4)return null;
  const capture=statements[1].match(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$LASTEXITCODE$/i);
  if(!capture||automaticVariables.has(capture[1].toLowerCase())||!new RegExp('^exit\\s+\\$'+capture[1]+'$','i').test(statements.at(-1)))return null;
  let body=statements[0];const redirect=body.match(/^(.*?)\s+(?:\*>|>)\s+(.+?)(?:\s+2>&1)?$/);
  if(redirect){const path=literalWords(redirect[2]);if(path?.length!==1||!path[0]||/[<>]/.test(path[0]))return null;body=redirect[1].trim();}
  const argv=literalWords(body);if(!argv?.length)return null;
  if(statements.length===4){
    if(safeMetadata(statements[2],capture[1],body,literalWords))return body;
    const message=statements[2].replace(/^Write-Output\s+/i,'');
    if(!/^"[^"\r\n]*"$/.test(message)&&!/^'[^'\r\n]*'$/.test(message))return null;
    // Only the captured status may be interpolated, never subexpressions or
    // other variables. No extra command can change the captured native exit.
    if(message.startsWith('"')&&message.replace(new RegExp('\\$'+capture[1]+'(?![A-Za-z0-9_])','gi'),'').includes('$'))return null;
  }
  return body;
}

function safeMetadata(statement,statusVariable,command,literalWords){
  const match=statement.match(/^\[pscustomobject\]@\{([^{}]*)\}\s*\|\s*ConvertTo-Json\s+-Compress\s*\|\s*Set-Content\s+-LiteralPath\s+(.+?)\s+-Encoding\s+utf8$/i);
  if(!match)return false;
  const path=literalWords(match[2]);if(path?.length!==1||!/^evidence[\\/][A-Za-z0-9_./\\-]+\.json$/.test(path[0])||path[0].split(/[\\/]/).includes('..'))return false;
  const fields=match[1].match(/(?:[^;'\"]|'[^']*'|"[^"]*")+/g)?.map(field=>field.trim()).filter(Boolean);
  if(!fields?.length||fields.length>5)return false;
  const values=new Map();
  for(const field of fields){
    const pair=field.match(/^(attemptMarker|command|exitCode|at|log)\s*=\s*([\s\S]+)$/i);if(!pair||values.has(pair[1].toLowerCase()))return false;
    values.set(pair[1].toLowerCase(),pair[2].trim());
  }
  if(values.get('exitcode')?.toLowerCase()!==('$'+statusVariable).toLowerCase())return false;
  const quoted=value=>value?.match(/^'([^']*)'$|^"([^"$]*)"$/)?.slice(1).find(v=>v!==undefined);
  if(quoted(values.get('command'))!==command)return false;
  for(const key of ['attemptmarker','log'])if(values.has(key)&&quoted(values.get(key))===undefined)return false;
  if(values.has('at')&&!/^\[DateTime\]::UtcNow\.ToString\('o'\)$/i.test(values.get('at'))&&quoted(values.get('at'))===undefined)return false;
  return true;
}
