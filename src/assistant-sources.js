import { A_ROUTE_SET, labelForRoute } from './assistant-policy.js';
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function googleToken(raw,fetcher) {
  const sa=JSON.parse(raw);const now=Math.floor(Date.now()/1000);
  const header=b64(enc.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const payload=b64(enc.encode(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+300})));
  const bytes=Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g,'')),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey('pkcs8',bytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const assertion=header+'.'+payload+'.'+b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(header+'.'+payload))));
  const r=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('source_auth_failed');const data=await r.json();if(!data.access_token)throw Error('source_auth_failed');return data.access_token;
}
export function sourceDate(value){
  if(typeof value!=='string')return NaN;
  if(/(?:Z|[+-]\d\d:\d\d)$/.test(value))return Date.parse(value);
  const m=value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  return m?Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0)-9,+(m[5]||0),+(m[6]||0)):NaN;
}
export function memberFacts(links,receipts,route,userId,now=Date.now()) {
  const checks=[],matches=links.filter(r=>r[1]===userId&&String(r[16]).replace(/^\/+|\/+$/g,'')===route&&r[11]==='A'&&r[12]===labelForRoute(route));
  const confirmed=matches.filter(r=>/^(連携済|連携済み|確定|linked|confirmed)$/.test(r[13]||''));
  const identities=confirmed.map(r=>r[3]||r[4]);let membership='unknown';
  if(confirmed.length===1||confirmed.length>1&&identities.every(Boolean)&&new Set(identities).size===identities.length){
    const active=confirmed.filter(r=>/^(在籍|在籍中|active)$/.test(r[10]));membership=active.length===confirmed.length?'active':active.length?'mixed':'other';
  }else checks.push('会員連携が未確認、または人物照合が一意ではありません');
  const trials=receipts.filter(r=>r[8]===userId&&r[4]==='A'&&r[5]===labelForRoute(route));
  const today=new Date(now+9*3600000).toISOString().slice(0,10);
  const recent=trials.filter(r=>{
    const updated=sourceDate(r[3]||r[2]),date=sourceDate(r[14]);
    return !/対象外|除外/.test(String(r[13])+' '+String(r[23]))&&Number.isFinite(updated)&&updated<=now+60000&&(Number.isFinite(date)?new Date(date+9*3600000).toISOString().slice(0,10)>=today:updated>=now-30*86400000);
  }).sort((a,b)=>sourceDate(b[3]||b[2])-sourceDate(a[3]||a[2]));
  let reservationStatus='unknown';if(recent.length){const latest=recent[0],status=String(latest[13]||'')+' '+String(latest[23]||'');
    reservationStatus=/キャンセル待ち|waitlisted/.test(status)?'waitlisted':/キャンセル|取消|取り消し|cancelled/.test(status)?'cancelled':'received';
    // No existing observed column proves completed reservation; never infer it from propagation.
    checks.push(reservationStatus==='received'?'最近または将来の体験受付あり。申込完了は未確認':'正本の受付状態: '+reservationStatus);
  }else checks.push(trials.length?'過去または対象外の受付記録のみ。現在の予約は未確認':'体験受付の記録を確認できません');
  return {membership,reservationStatus,checks};
}
export async function readAvailabilityFacts(ctx,env,route,now=Date.now()){
  try{const r=await ctx.exports.AvailabilitySnapshot.getByName('trial-config-v1',{locationHint:'apac'}).getTrialConfig(route);
    const syncAt=Number(r?.revision),updatedAt=Number(r?.updatedAt);const maxAge=Number(env.ASSISTANT_AVAILABILITY_MAX_AGE_MS||12*3600000);
    if(!Number.isFinite(maxAge)||maxAge<60000||maxAge>12*3600000)throw Error('invalid_freshness_limit');
    if(!r||!Number.isFinite(syncAt)||syncAt>now+60000||now-syncAt>maxAge)return {availabilityState:r?'stale':'empty',sourceSyncAt:syncAt||null,checks:['日程の正本が未取得、または許容する保存時間を超えています']};
    const today=new Date(now+9*3600000).toISOString().slice(0,10);
    return {availabilityState:'cached_within_limit',sourceSyncAt:syncAt,sourceUpdatedAt:Number.isFinite(updatedAt)?updatedAt:null,availabilityAgeMinutes:Math.floor((now-syncAt)/60000),availability:{...r.config,dates:r.config.dates.filter(d=>d.value>=today)},checks:[`日程は保存データです。最終同期から${Math.floor((now-syncAt)/60000)}分。最新の変更は担当者が確認してください`]};
  }catch(_){return {availabilityState:'unavailable',checks:['日程の正本を取得できません']};}
}
export async function readCurrentFacts(env,route,userId,fetcher=fetch) {
  if(!A_ROUTE_SET.has(route))throw Error('invalid_route');
  if(!env.ASSISTANT_GOOGLE_SERVICE_ACCOUNT||!/^[-\w]{20,100}$/.test(env.ASSISTANT_MASTER_SHEET_ID||''))return {sourceState:'unavailable',membership:'unknown',reservationStatus:'unknown',checks:['Google Sheetsの読取専用認証または正本IDが未設定です']};
  try {
    const token=await googleToken(env.ASSISTANT_GOOGLE_SERVICE_ACCOUNT,fetcher),query=new URLSearchParams();
    // Read only link/state/route columns. Names, birthday, message bodies and child details are excluded.
    for(const r of ["'17_LINE会員連携'!B4:B5000","'17_LINE会員連携'!D4:E5000","'17_LINE会員連携'!K4:N5000","'17_LINE会員連携'!Q4:Q5000","'14_LINE体験受付'!C4:F10000","'14_LINE体験受付'!I4:I10000","'14_LINE体験受付'!N4:P10000","'14_LINE体験受付'!X4:X10000"])query.append('ranges',r);
    const response=await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${env.ASSISTANT_MASTER_SHEET_ID}/values:batchGet?${query}`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('source_read_failed');const data=await response.json();const ranges=data.valueRanges||[];
    const headers=[['LINEユーザーID'],['Prospect人物ID','Prospect会員ID'],['在籍状態','主チーム','主会場','連携状態'],['元LINEルート'],['受信日時','更新日時','チーム','会場'],['LINEユーザーID'],['抽出状態','体験日','希望クラス'],['会場反映状態']];
    if(ranges.length!==8||ranges.some((r,i)=>JSON.stringify(r.values?.[0])!==JSON.stringify(headers[i])))throw Error('source_schema_changed');
    const [ids,personIds,states,routes,venues,trialIds,statuses,propagation]=ranges.map(r=>(r.values||[]).slice(1));
    if(ids.length>=4996||trialIds.length>=9996)throw Error('source_range_capacity');
    const links=ids.map((v,i)=>{const row=[];row[1]=v[0];row[3]=personIds[i]?.[0];row[4]=personIds[i]?.[1];for(let j=0;j<4;j++)row[10+j]=states[i]?.[j];row[16]=routes[i]?.[0];return row;});
    const receipts=trialIds.map((v,i)=>{const row=[];row[8]=v[0];for(let j=0;j<4;j++)row[2+j]=venues[i]?.[j];for(let j=0;j<3;j++)row[13+j]=statuses[i]?.[j];row[23]=propagation[i]?.[0];return row;});
    return {sourceState:'verified',checkedAt:new Date().toISOString(),source:'会員マスター 17/14 読取専用',...memberFacts(links,receipts,route,userId)};
  }catch(_){return {sourceState:'unavailable',membership:'unknown',reservationStatus:'unknown',checks:['正本の取得・範囲確認に失敗しました。人物情報や予約完了を推測しないでください']};}
}
