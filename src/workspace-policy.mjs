// Conservative generated-output classification. Never classify a file by size alone.
export function generatedLogReason(path,{tracked=false}={}){
  if(tracked)return null;
  const parts=path.replaceAll('\\','/').toLowerCase().split('/'),file=parts.pop();
  if(parts.some(p=>['test','tests','fixtures','__fixtures__','testdata','resources','src'].includes(p)))return null;
  if(!/\.log(?:\.\d+)?(?:\.gz)?$/.test(file))return null;
  const outputDirectory=parts.some(p=>/^(audit(?:-output)?|logs?|reports?|test-results|playwright-report|agent-output|verification)$/.test(p));
  const toolOutput=/^(maven|mvn|npm|pnpm|yarn|gradle|build|debug|error|access)(?:[-.]|$)/.test(file);
  return outputDirectory||toolOutput?'generated-execution-log':null;
}

// Historical build archives are execution outputs, not source dependencies.
// Tracked inputs and conventional fixture/resource directories always win.
export function generatedArchiveReason(path,{tracked=false}={}){
  if(tracked)return null;
  const parts=path.replaceAll('\\','/').toLowerCase().split('/'),file=parts.pop();
  if(parts.some(p=>['src','test','tests','resources','fixtures','__fixtures__','testdata','lib','libs','vendor'].includes(p)))return null;
  if(/^databasebackup[_-]\d.*\.sql(?:\.gz)?$/.test(file))return 'historical-database-backup';
  if(parts.some(p=>/^(audit|backups?|_sync-conflicts-backup|history)$/.test(p))&&/\.(jar|war|tar|tgz|zip|7z|bak|dump)(?:\.gz)?$/.test(file))return 'historical-build-archive';
  if(parts.some(p=>/^(audit|_sync-conflicts-backup)$/.test(p))&&/\.(png|jpe?g|webp|gif|svg|ico|mp4|webm|woff2?|ttf|html|css|[cm]?js|map|pdf)$/.test(file))return 'historical-execution-artifact';
  return null;
}
