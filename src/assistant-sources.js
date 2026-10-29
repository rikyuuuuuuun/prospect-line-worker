import { A_ROUTE_SET, labelForRoute } from './assistant-policy.js';
const MASTER='1Wsj9Q7i2QkDRjCsmW_FCDSr56ja7pDhye6dugmTCTPo';
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
export function memberFacts(links,receipts,route,userId) {
  const warnings=[];const matches=links.filter(r=>r[1]===userId&&String(r[16]).replace(/^\/+|\/+$/g,'')===route);
  const confirmed=matches.filter(r=>/^(連携済|連携済み|確定|linked|confirmed)$/.test(r[13]||''));let membership='unknown';
  if(confirmed.length===1&&confirmed[0][11]==='A'&&confirmed[0][12]===labelForRoute(route))membership=/^(在籍|在籍中|active)$/.test(confirmed[0][10])?'active':'other';
  else warnings.push('会員連携が未確認、または人物照合が一意ではありません');
  const trials=receipts.filter(r=>r[8]===userId&&r[4]==='A'&&r[5]===labelForRoute(route));
  // Propagation to a venue is not proof of a completed application.
  return {membership,reservationStatus:trials.length?'received':'unknown',checks:warnings.concat(trials.length?'体験受付の記録あり。申込完了・希望日変更・取消・キャンセル待ちは担当者確認が必要':'体験受付の記録を確認できません')};
}
export async function readCurrentFacts(env,route,userId,fetcher=fetch) {
  if(!A_ROUTE_SET.has(route))throw Error('invalid_route');
  if(!env.ASSISTANT_GOOGLE_SERVICE_ACCOUNT)return {sourceState:'unavailable',membership:'unknown',reservationStatus:'unknown',checks:['Google Sheetsの読取専用認証が未設定です']};
  try {
    const token=await googleToken(env.ASSISTANT_GOOGLE_SERVICE_ACCOUNT,fetcher),query=new URLSearchParams();
    // Read only link/state/route columns. Names, birthday, message bodies and child details are excluded.
    for(const r of ["'17_LINE会員連携'!B5:B5000","'17_LINE会員連携'!K5:Q5000","'14_LINE体験受付'!E5:F10000","'14_LINE体験受付'!I5:I10000"])query.append('ranges',r);
    const response=await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${MASTER}/values:batchGet?${query}`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('source_read_failed');const data=await response.json();const [ids,states,venues,trialIds]=data.valueRanges||[];
    if(!ids||!states||!venues||!trialIds||(ids.values?.length||0)>=4996||(trialIds.values?.length||0)>=9996)throw Error('source_range_capacity');
    const links=(ids.values||[]).map((v,i)=>{const row=[];row[1]=v[0];for(let j=0;j<7;j++)row[10+j]=states.values?.[i]?.[j];return row;});
    const receipts=(trialIds.values||[]).map((v,i)=>{const row=[];row[8]=v[0];row[4]=venues.values?.[i]?.[0];row[5]=venues.values?.[i]?.[1];return row;});
    return {sourceState:'verified',checkedAt:new Date().toISOString(),source:'会員マスター 17/14 読取専用',...memberFacts(links,receipts,route,userId)};
  }catch(_){return {sourceState:'unavailable',membership:'unknown',reservationStatus:'unknown',checks:['正本の取得・範囲確認に失敗しました。人物情報や予約完了を推測しないでください']};}
}
