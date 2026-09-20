import core, { ReservationOutbox, deliverTrialConfig_ } from './index.js';
import legacyAvailability from './legacy-availability.js';
import { AvailabilitySnapshot } from './availability-snapshot.js';
import { configDigest, verifyConfigPush, normalizeTrialConfig, currentTrialWindow, TRIAL_CONFIG_MAX_BYTES } from './trial-config.js';
export { ReservationOutbox, AvailabilitySnapshot };
const RESERVATION_ROUTES = Object.freeze([
  'a/saitama-shibakawa', 'a/sugishita', 'a/mizuhodai', 'a/kamekubo',
  'a/ageo-fujimi', 'a/ageo-shibakawa', 'a/kasumigaseki-nishi',
  'b/tsuruse', 'b/meiho', 'b/omiya-higashi', 'b/tsurugashima-daiichi',
  'b/okegawa-nishi', 'b/kitamoto-higashi', 'b/kamihira-kita',
  'c/katayanagi', 'c/muneoka-daini', 'c/kamine', 'c/kumagaya-nishi',
  'c/gyoda-nishi', 'c/asaka-dai10', 'c/tokorozawa-minami', 'c/kurohama-minami',
  'd/obukuro-higashi', 'd/shimooshi', 'd/izumi', 'd/yagisaki',
  'd/nakano', 'd/ebinuma', 'd/komatsu', 'd/shima',
]);
const ROUTE_SET = new Set(RESERVATION_ROUTES);

function store(ctx) {
  return ctx?.exports?.AvailabilitySnapshot?.getByName('trial-config-v1', { locationHint: 'apac' });
}
function json(body, status=200, timing='') {
  return Response.json(body, {status, headers:{'cache-control':'no-store','x-content-type-options':'nosniff',
    'x-prospect-cache':'PERSISTENT-CONFIG','server-timing':timing}});
}
async function readBounded(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw Error('request_too_large');
  const reader=request.body?.getReader();
  if (!reader) return '';
  const decoder=new TextDecoder(); let text='', size=0;
  try { for (;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength;
    if(size>limit) { await reader.cancel(); throw Error('request_too_large'); } text+=decoder.decode(value,{stream:true}); }
    return text+decoder.decode();
  } finally {reader.releaseLock();}
}
async function deliver(request,env,ctx) {
  const started=Date.now(); let readMs=0;
  try {
    const raw=request.method==='GET'?new URL(request.url).searchParams.get('route'):JSON.parse(await readBounded(request,32000)).route;
    const route=String(raw||'').toLowerCase().replace(/^\/+|\/+$/g,'');
    if(!ROUTE_SET.has(route))return json({ok:false,message:'invalid_route'},400);
    const object=store(ctx); if(!object)throw Error('trial_config_unavailable');
    const readStarted=Date.now(); const record=await object.getTrialConfig(route); readMs=Date.now()-readStarted;
    // An empty store is an operator/bootstrap issue, never a reason to read Sheets in a user's request.
    if(!record)return json({ok:false,message:'trial_config_not_initialized'},503);
    const body=await deliverTrialConfig_(env,route,record,currentTrialWindow(record.config.dates));
    const workerMs=Date.now()-started;
    console.log(JSON.stringify({event:'trial_config_timing',configMs:readMs,workerMs,gasMs:0}));
    return json(body,200,'config;dur='+readMs+', gas;dur=0, worker;dur='+workerMs);
  }catch(error){
    const message=['request_too_large'].includes(error.message)?error.message:'trial_config_unavailable';
    console.warn(JSON.stringify({event:'trial_config_read_failed',message}));
    return json({ok:false,message},message==='request_too_large'?413:503,'worker;dur='+(Date.now()-started));
  }
}
async function push(request,env,ctx) {
  try {
    const body=await readBounded(request,TRIAL_CONFIG_MAX_BYTES);
    if(!await verifyConfigPush(request,body,env.GAS_FORWARD_KEY))return json({ok:false,message:'unauthorized'},401);
    const bundle=normalizeTrialConfig(JSON.parse(body),RESERVATION_ROUTES);
    const digest=await configDigest(JSON.stringify(bundle.byRoute));
    const object=store(ctx);if(!object)throw Error('trial_config_unavailable');
    return json(await object.putTrialConfig(bundle,digest));
  }catch(error){
    const known=['invalid_trial_config','trial_config_out_of_order','trial_config_revision_conflict','request_too_large'];
    const message=known.includes(error.message)?error.message:'trial_config_update_failed';
    const status=message==='request_too_large'?413:message==='invalid_trial_config'?400:message.startsWith('trial_config_revision')||message==='trial_config_out_of_order'?409:503;
    return json({ok:false,message},status);
  }
}
export default {
  async fetch(request,env,ctx) {
    const path=new URL(request.url).pathname.toLowerCase().replace(/^\/+|\/+$/g,'');
    // Explicit one-time migration mode only. Never an automatic miss/error fallback.
    // Lets the signed push endpoint seed storage before production forms switch.
    if (env.TRIAL_CONFIG_BRIDGE_ONLY === 'true' && request.method==='POST' &&
        path==='api/reservations/availability') return legacyAvailability.fetch(request,env,ctx);
    if ((request.method==='GET' && path==='trial-config') ||
        (request.method==='POST' && path==='api/reservations/availability')) return deliver(request,env,ctx);
    if (request.method==='POST' && path==='internal/trial-config')return push(request,env,ctx);
    if(request.method==='GET' && path==='health/availability-snapshot'){
      const route=new URL(request.url).searchParams.get('route');
      if(!ROUTE_SET.has(route))return json({ok:false,message:'invalid_route'},400);
      try {const r=await store(ctx)?.getTrialConfig(route); return json({ok:!!r,state:r?'ready':'empty',revision:r?.revision,configVersion:r?.digest},r?200:503);}
      catch(_){return json({ok:false,state:'unavailable'},503);}
    }
    return core.fetch(request,env,ctx);
  },
};
