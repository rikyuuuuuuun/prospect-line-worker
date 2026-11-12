// Only variable spans are replaced. This module never generates or paraphrases prose.
const TYPES={date:'日程',time:'時間',class:'クラス',fee:'会費',count:'人数',url:'URL',text:'差し込み内容'};
export const EXACT_CLAIMS={withdrawal_completed:'今回の退会・手続きが実際に完了したことを確認',change_completed:'今回の日程・クラス変更が実際に完了したことを確認',reservation_completed:'今回の体験予約が実際に完了したことを確認',item_found:'今回の忘れ物が見つかり、受け渡し案内も確認',venue_guidance:'会場・持ち物等の案内が現行の正式ルールと一致することを確認'};
const patterns=[
  ['text',/\{([^{}\n]{1,100})\}/g],
  ['url',/https?:\/\/[^\s{}]+/g],
  ['text',/第[\d一二三四五六七八九十]+[月火水木金土日]曜(?:日)?|(?:再来週|来週|今週)(?:[月火水木金土日]曜(?:日)?)?|明後日|明日|(?:来月|今月)末|[\d一二三四五六七八九十]+(?:日まで|日以内|日締め|分前)/g],
  ['date',/(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[（(][月火水木金土日](?:曜日|曜)?[）)])?|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}/g],
  ['time',/\d{1,2}[:：]\d{2}(?:[〜～~ー–-]\d{1,2}[:：]\d{2})?|(?:午前|午後)?[\d一二三四五六七八九十〇零]+時(?:[\d一二三四五六七八九十〇零]+分|半)?/g],
  ['fee',/[\d,一二三四五六七八九十百千万〇零]+円/g],
  ['count',/\d+(?=名|人)/g],
  ['class',/前半|後半|相談したい/g],
];
function inferType(name){if(/(?:日|日時).*(?:クラス|時間)|日程.*一覧/.test(name))return 'text';if(/^(date|日程|日付)|確認済み日付|予約日/.test(name))return 'date';if(/^time|時刻|時間/.test(name))return 'time';if(/^class|クラス/.test(name))return 'class';if(/^fee|会費|料金/.test(name))return 'fee';if(/^count|人数|空き人数/.test(name))return 'count';if(/^url|URL/i.test(name))return 'url';return 'text';}
export function requiredClaims(body){
  const s=body.replace(/\s/g,'');const claims=[];
  if(/(?:退会|手続き).{0,20}(?:完了|済みました|済ん)|退会を承りました/.test(s))claims.push('withdrawal_completed');
  if(/(?:日程|クラス|変更).{0,20}(?:変更いたしました|変更しました|完了|済みました)/.test(s))claims.push('change_completed');
  if(/(?:予約|申込).{0,20}(?:確定|完了|承りました|お取りしました)|《体験予約日》|ご参加いただけます/.test(s))claims.push('reservation_completed');
  if(/(?:水筒|忘れ物|落とし物).{0,25}(?:ありました|見つかりました|お預かり)|次回お渡し/.test(s))claims.push('item_found');
  if(/入口|入場|体育館|駐車|内履|室内履|持ち物|ステージ側/.test(s))claims.push('venue_guidance');
  return claims;
}
export function compileExactReply(source,declared=[]){
  const text=String(source),spans=[];
  for(const [type,re]of patterns)for(const m of text.matchAll(re)){
    if(spans.some(s=>m.index<s.end&&m.index+m[0].length>s.start))continue;
    spans.push({start:m.index,end:m.index+m[0].length,type,original:m[0],name:type==='text'?m[1]:null});
  }
  spans.sort((a,b)=>a.start-b.start);const slots=[],byKey=new Map(),counts={};let body='',cursor=0;
  for(const span of spans){
    const key=span.name||span.type+':'+span.original;let slot=byKey.get(key);
    if(!slot){const id=span.name||span.type+'_'+(counts[span.type]=(counts[span.type]||0)+1);const saved=declared.find(s=>s.id===id);
      const type=saved?.type||(span.name?inferType(span.name):span.type);
      slot={id,type,label:TYPES[type]||TYPES.text,original:saved?.original||(span.name?'':span.original)};byKey.set(key,slot);slots.push(slot);}
    body+=text.slice(cursor,span.start)+'{'+slot.id+'}';cursor=span.end;
  }
  return {body:body+text.slice(cursor),slots,requiredClaims:requiredClaims(text)};
}
const illness=t=>/体調|熱|病|風邪/.test(t);
const makeup=t=>/振替|振り替え|ふりかえ/.test(t);
const items=t=>String(t).match(/水筒|タオル|上着|靴|カバン|鞄|帽子|傘/g)||[];
const otherTopics=[[/入会.{0,20}(?:手続|方法|フォーム|申込)|(?:手続|フォーム).{0,20}入会/,'enrollment'],[/雨|雨天/,'weather'],[/持ち物|準備いただ|用意|持参/,'belongings'],[/駐車|車で/,'parking']];
function otherMatches(query,source){
  if(/忘れ|落とし|紛失/.test(query))return /忘れ|落とし|ありました|見つか|お預かり/.test(source)&&items(query).some(x=>items(source).includes(x));
  const requested=otherTopics.filter(([re])=>re.test(query));return requested.length>0&&requested.every(([re])=>re.test(source));
}
export function exactCandidates(row,cases,templates){
  const list=[];
  for(const t of templates.filter(t=>t.status==='approved'&&t.privacyReviewed&&t.route===row.route&&t.category===row.category&&(t.usage!=='same_day_procedure'||row.procedureContextConfirmed))){
    const source=t.title||t.body;if(row.category==='欠席'&&makeup(row.body)!==makeup(source+' '+t.body))continue;
    if(row.category==='欠席'&&/お大事|体調/.test(t.body)&&!illness(row.body))continue;
    if(row.category==='その他'&&!otherMatches(row.body,source+' '+t.body))continue;
    list.push({id:t.id,kind:'template',label:t.title||t.category,sourceBody:t.body,...compileExactReply(t.body,t.slots),score:2});
  }
  for(const c of cases.filter(c=>c.status==='approved'&&c.privacyReviewed&&c.author==='owner'&&c.route===row.route&&c.category===row.category)){
    if(row.category==='欠席'&&(illness(c.inquiry)!==illness(row.body)||makeup(c.inquiry+' '+c.reply)!==makeup(row.body)))continue;
    if(row.category==='その他'&&!otherMatches(row.body,c.inquiry+' '+c.reply))continue;
    if(row.category==='体験日時変更'&&/キャンセル|取消/.test(c.inquiry)!==/キャンセル|取消/.test(row.body))continue;
    const compiled=compileExactReply(c.reply);if(list.some(t=>t.body===compiled.body))continue;
    list.push({id:c.id,kind:'case',label:c.category+' / '+c.reply.slice(0,35).replace(/\n/g,' '),sourceBody:c.reply,...compiled,score:1});
  }
  return list.slice(0,20);
}
function dateText(value,original){
  const date=new Date(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(+date)||date.toISOString().slice(0,10)!==value)throw Error('invalid_slot_date');
  const y=date.getUTCFullYear(),m=date.getUTCMonth()+1,d=date.getUTCDate();
  if(/月/.test(original))return (original.includes('年')?y+'年':'')+m+'月'+d+'日'+(/[（(]/.test(original)?(original.includes('（')?'（':'(')+'日月火水木金土'[date.getUTCDay()]+(original.includes('曜日')?'曜日':original.includes('曜')?'曜':'')+(original.includes('）')?'）':')'):'');
  if(/^\d{4}-/.test(original))return value;
  if(original.includes('/'))return (/^\d{4}\//.test(original)?y+'/':'')+m+'/'+d;
  return m+'月'+d+'日（'+'日月火水木金土'[date.getUTCDay()]+'）';
}
function timeText(value,original){
  if(!/^\d{1,2}:\d{2}(?:[〜～~-]\d{1,2}:\d{2})?$/.test(value)||value.match(/\d+:\d+/g).some(t=>+t.split(':')[0]>23||+t.split(':')[1]>59))throw Error('invalid_slot_time');
  if(original.includes('時')){const [h,m]=value.split(/[〜～~-]/)[0].split(':').map(Number);return (/午前|午後/.test(original)?(h<12?'午前':'午後')+(h%12||12):h)+'時'+(m?m+'分':'');}
  return value.replace(/[〜～~-]/,original.match(/[〜～~ー–-]/)?.[0]||'〜').replace(/:/g,original.includes('：')?'：':':');
}
function formatted(value,slot){
  if(typeof value!=='string'||!value.trim()||value.length>1000||/[{}\u0000-\u0008]/.test(value))throw Error('invalid_slot_value');
  if(slot.type==='date')return dateText(value,slot.original);
  if(slot.type==='time')return timeText(value,slot.original);
  if(slot.type==='class'){if(!['前半','後半','相談したい'].includes(value))throw Error('invalid_slot_class');return value;}
  if(slot.type==='fee'||slot.type==='count'){if(!/^\d+$/.test(value))throw Error('invalid_slot_number');return (slot.original.includes(',')?Number(value).toLocaleString('en-US'):value)+(slot.type==='fee'?'円':'');}
  if(slot.type==='url'&&!/^https:\/\//.test(value))throw Error('invalid_slot_url');
  return value.trim();
}
export function renderExactReply(template,facts={},selection={},query=''){
  if(selection.confirmedClaims!==undefined&&!Array.isArray(selection.confirmedClaims))throw Error('invalid_exact_confirmation');
  const values=selection.values||{},fields=[],blocking=[],checks=[],claims=[];
  const classes=(facts.availability?.classes||[]).filter(c=>c.status!=='closed'),classSlots=template.slots.filter(s=>s.type==='class');
  const requested=[...new Set(query.match(/前半|後半|相談したい/g)||[])];
  const classChoice=classSlots.length===1?(values[classSlots[0].id]||(requested.length===1?requested[0]:null)):(requested.length===1?requested[0]:null);
  let reply=template.body;
  for(const slot of template.slots){
    let options=[],automatic='';
    if(slot.type==='date'){
      options=(facts.availability?.dates||[]).map(d=>({value:d.value,label:d.label||d.value}));
      const qs=[...query.matchAll(/(?:(\d{4})[-/年])?(\d{1,2})[月/](\d{1,2})日?/g)].map(m=>options.filter(o=>o.value.endsWith('-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'))&&(!m[1]||o.value.startsWith(m[1]+'-')))).flat();
      if(new Set(qs.map(x=>x.value)).size===1)automatic=qs[0].value;
    }else if(slot.type==='class'){options=classes.map(c=>({value:c.value,label:c.label||c.value}));if(classSlots.length===1&&requested.length===1)automatic=requested[0];}
    else if(slot.type==='time'){
      const chosen=classes.filter(c=>!classChoice||c.value===classChoice);const range=/[〜～~ー–-]/.test(slot.original)||!slot.original;
      options=chosen.flatMap(c=>(range?[c.time]:String(c.time||'').split(/[〜～~-]/)).filter(Boolean).map(value=>({value,label:(c.label||c.value)+' / '+value})));
      if(classChoice&&options.length===1)automatic=options[0].value;
    }else if(slot.type==='fee')options=(facts.fees||[]).filter(f=>f.verified===true).map(f=>({value:String(f.amount),label:String(f.amount)+'円'}));
    const value=Object.hasOwn(values,slot.id)?String(values[slot.id]):automatic;
    let resolved=false,rendered='';
    if(value){try{
      if(options.length&&!options.some(o=>o.value===value))throw Error('slot_conflicts_with_source');
      if(!options.length&&selection.slotsVerified!==true)throw Error('slot_source_confirmation_required');
      rendered=formatted(value,slot);resolved=true;
    }catch(e){blocking.push({code:e.message,message:slot.label+'「'+slot.id+'」を正本で確認してください',severity:'block'});}}
    else blocking.push({code:'exact_slot_missing',message:slot.label+'「'+slot.id+'」を選択・入力してください',severity:'block'});
    fields.push({...slot,options,value:value||'',resolved});if(resolved)reply=reply.split('{'+slot.id+'}').join(rendered);
  }
  for(const id of template.requiredClaims){const canonical=id==='reservation_completed'&&facts.reservationStatus==='applied';const confirmed=canonical||(selection.confirmedClaims||[]).includes(id);claims.push({id,label:EXACT_CLAIMS[id],confirmed,source:canonical?'canonical':confirmed?'operator':'unconfirmed'});if(!confirmed)blocking.push({code:'exact_fact_unconfirmed',message:EXACT_CLAIMS[id],severity:'block'});}
  if(template.requiredClaims.includes('reservation_completed')&&facts.reservationStatus!=='applied'&&classChoice&&classes.some(c=>c.value===classChoice&&c.status==='waitlist'))blocking.push({code:'exact_class_not_open',message:'選択したクラスはキャンセル待ちです。通常の予約完了文面は使えません',severity:'block'});
  checks.push(...blocking.map(x=>x.message));
  return {reply,fields,claims,blocking,checks,slotsVerified:selection.slotsVerified===true,values:Object.fromEntries(fields.map(f=>[f.id,f.value])),sourceId:template.id,sourceKind:template.kind,sourceBody:template.sourceBody,templateBody:template.body};
}
