/** Add alongside the verified LINE receiver Code.gs; do not replace its reservation handlers.
 * Installable triggers use HEAD, so the receiver's web app need not be redeployed.
 * Required existing secret: LINE_WEBHOOK_FORWARD_KEY. New public property: PROSPECT_TRIAL_CONFIG_URL.
 */
function prospectTrialSourceVersions_() {
  return JSON.stringify([
    DriveApp.getFileById(PROSPECT_LINE_MASTER.spreadsheetId).getLastUpdated().getTime(),
    DriveApp.getFileById(PROSPECT_ACTIVITY_CALENDAR.spreadsheetId).getLastUpdated().getTime(),
  ]);
}
function prospectTrialHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function readProspectTrialSources_() {
  const calendar = SpreadsheetApp.openById(PROSPECT_ACTIVITY_CALENDAR.spreadsheetId);
  const months = calendar.getSheets().filter(function (sheet) { return /^(?:[1-9]|1[0-2])月$/.test(sheet.getName()); })
    .map(function (sheet) {
      const values = sheet.getRange(1, 1, Math.min(Math.max(sheet.getLastRow(), 1), PROSPECT_ACTIVITY_CALENDAR.maxReadRows),
        Math.min(sheet.getMaxColumns(), PROSPECT_ACTIVITY_CALENDAR.maxReadColumns)).getDisplayValues();
      const year = String(values[1] && values[1][1] || '').match(/\d{4}/);
      const month = String(values[1] && values[1][2] || '').match(/\d{1,2}/);
      if (!year || !month || Number(month[0]) !== Number(sheet.getName().replace('月',''))) throw Error('trial_calendar_header_invalid');
      return { name: sheet.getName(), year: Number(year[0]), month: Number(month[0]), values: values };
    }).sort(function (a,b) { return a.name.localeCompare(b.name); });
  if (!months.length) throw Error('trial_calendar_empty');
  // One bounded class-settings read using the receiver's existing parser/status mapping.
  return { months: months, classes: readProspectClassAvailabilityAllLive_() };
}
function buildProspectTrialConfig_(sources, revision) {
  const byRoute = {};
  Object.keys(PROSPECT_LINE_ROUTES).filter(function (key) { return PROSPECT_LINE_ROUTES[key].active; }).sort().forEach(function (key) {
    const route = PROSPECT_LINE_ROUTES[key]; const unique = {};
    sources.months.forEach(function (month) {
      // Preserve the source parser, aliases, shared weekday columns, and schedule markers.
      // Keep all stored months; Worker applies today..end-of-next-month at delivery.
      readProspectCalendarAvailabilityValues_(month.values, month.name, route, month.year, month.month, '0000-00-00')
        .forEach(function (date) { unique[date.value] = date; });
    });
    const classes = selectProspectClassAvailability_(route, sources.classes);
    byRoute[key] = { dates: Object.keys(unique).sort().map(function (key) { return unique[key]; }),
      classes: classes, fixedClass: resolveProspectReservationFixedClass_(route, classes) };
  });
  return { schemaVersion: 1, revision: revision, byRoute: byRoute };
}
function syncProspectTrialConfig_(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: false, deferred: true }; // watchdog retries; never block reservation writes
  const started = Date.now();
  try {
    const props = PropertiesService.getScriptProperties();
    const versions = prospectTrialSourceVersions_();
    if (!force && versions === props.getProperty('TRIAL_CONFIG_SOURCE_VERSIONS')) return { ok: true, unchanged: true, sheetsReads: 0 };
    const readAt = Date.now(); const sources = readProspectTrialSources_(); const sheetsMs = Date.now() - readAt;
    // API/script writes do not fire onEdit. File-version watchdog covers those paths.
    // Read only after source-file metadata changes; unrelated file edits may cause a harmless extra read.
    const fingerprint = prospectTrialHash_(JSON.stringify(sources));
    if (versions !== prospectTrialSourceVersions_()) throw Error('trial_sources_changed_during_read');
    if (force !== 'publish' && fingerprint === props.getProperty('TRIAL_CONFIG_SOURCE_HASH')) {
      props.setProperty('TRIAL_CONFIG_SOURCE_VERSIONS', versions);
      return { ok: true, unchanged: true, sheetsMs: sheetsMs };
    }
    const processAt = Date.now();
    const revision = Math.max(Date.now(), Number(props.getProperty('TRIAL_CONFIG_REVISION') || 0) + 1);
    const body = JSON.stringify(buildProspectTrialConfig_(sources, revision));
    const processMs = Date.now() - processAt;
    const url = props.getProperty('PROSPECT_TRIAL_CONFIG_URL') || '';
    if (!/^https:\/\/[^/]+\/internal\/trial-config$/.test(url)) throw Error('trial_config_url_not_configured');
    const secret = props.getProperty('LINE_WEBHOOK_FORWARD_KEY');
    if (!secret) throw Error('trial_config_signing_key_missing');
    const timestamp = String(Date.now());
    const signature = Utilities.computeHmacSha256Signature('prospect-trial-config-push-v1\n' + timestamp + '\n' + body, secret, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    const response = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: body,
      headers: { 'x-prospect-timestamp': timestamp, 'x-prospect-signature': signature }, muteHttpExceptions: true, followRedirects: false });
    const result = JSON.parse(response.getContentText());
    if (response.getResponseCode() !== 200 || result.ok !== true) throw Error('trial_config_push_failed_' + response.getResponseCode());
    // Only acknowledge AFTER durable storage. Any failure leaves the old snapshot and causes retry.
    props.setProperties({ TRIAL_CONFIG_SOURCE_VERSIONS: versions, TRIAL_CONFIG_SOURCE_HASH: fingerprint, TRIAL_CONFIG_REVISION: String(revision) }, false);
    console.log(JSON.stringify({event:'trial_config_sync',sheetsMs:sheetsMs,processMs:processMs,totalMs:Date.now()-started,routeCount:Object.keys(sources.classes).length}));
    return { ok: true, revision: revision, sheetsMs: sheetsMs, processMs: processMs, totalMs: Date.now()-started };
  } finally { lock.releaseLock(); }
}
function syncProspectTrialConfig() { return syncProspectTrialConfig_('publish'); }
function watchProspectTrialConfig() { return syncProspectTrialConfig_(false); }
function handleProspectTrialConfigEdit(e) {
  if (!e || !e.range || !e.source) return;
  const id=e.source.getId(), sheet=e.range.getSheet().getName();
  if (id===PROSPECT_LINE_MASTER.spreadsheetId && sheet===PROSPECT_LINE_MASTER.settingsSheet && e.range.getColumn()<=8) return syncProspectTrialConfig_(true);
  if (id===PROSPECT_ACTIVITY_CALENDAR.spreadsheetId && /^(?:[1-9]|1[0-2])月$/.test(sheet) && e.range.getColumn()<=14) return syncProspectTrialConfig_(true);
}
function installProspectTrialConfigSync() {
  const triggers=ScriptApp.getProjectTriggers();
  [PROSPECT_LINE_MASTER.spreadsheetId,PROSPECT_ACTIVITY_CALENDAR.spreadsheetId].forEach(function(id){
    if(!triggers.some(function(t){return t.getHandlerFunction()==='handleProspectTrialConfigEdit' && t.getTriggerSourceId()===id;}))
      ScriptApp.newTrigger('handleProspectTrialConfigEdit').forSpreadsheet(id).onEdit().create();
  });
  // Metadata only when unchanged. Also recovers missed edits, structural changes, and failed pushes.
  if(!triggers.some(function(t){return t.getHandlerFunction()==='watchProspectTrialConfig';}))
    ScriptApp.newTrigger('watchProspectTrialConfig').timeBased().everyMinutes(15).create();
  return syncProspectTrialConfig();
}

function previewProspectTrialConfig() {
  const started=Date.now(); const data=buildProspectTrialConfig_(readProspectTrialSources_(),Date.now());
  console.log(JSON.stringify({event:"trial_config_preview",totalMs:Date.now()-started,bytes:Utilities.newBlob(JSON.stringify(data)).getBytes().length,routes:Object.keys(data.byRoute).map(function(route){const c=data.byRoute[route];return {route:route,dateCount:c.dates.length,first:c.dates[0],last:c.dates[c.dates.length-1],classes:c.classes,fixedClass:c.fixedClass};})}));
}
function prepareProspectTrialConfigProduction() {
  PropertiesService.getScriptProperties().setProperty("PROSPECT_TRIAL_CONFIG_URL","https://prospect-line-webhook.line-harness-trampoline.workers.dev/internal/trial-config");
  console.log(JSON.stringify(syncProspectTrialConfig()));
}
function verifyProspectTrialConfigWatchdog() { console.log(JSON.stringify(watchProspectTrialConfig())); }
