import {DurableObject} from 'cloudflare:workers';
import {A_ROUTE_SET,normalizeIncoming,extractResponseText} from './assistant-policy.js';
import {MODEL_PRICES as PRICES,buildDraftRequest} from './assistant-model.js';
import {assistantHtml,assistantClientJs} from './assistant-ui.js';
import {CATEGORIES,classify,normalizeCase,csvCases,proposeTemplates,retrieve,styleProfile,correctionSuggestions,buildModelInput,inspectReply,policyWarnings,typedClaims,RULES,POLICY_VERSION,intentFeatures,deriveSafeInquiry} from './assistant-learning.js';
import {redactText,privacyWarnings,digestText,budgetMonth,RAW_RETENTION_DAYS} from './assistant-privacy.js';
import {readCurrentFacts,readAvailabilityFacts} from './assistant-sources.js';
const TERMINAL=['sent','sent_confirmed','ignored','expired','send_unknown'];
const reference=c=>JSON.stringify([c.route,c.category,c.author,c.status,c.privacyReviewed,c.inquiry,c.reply,c.body]);
export class AssistantInbox extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.sql=ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,route TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,received_at INTEGER NOT NULL,status TEXT NOT NULL,draft TEXT NOT NULL DEFAULT '',modified_at INTEGER NOT NULL,reply_key TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '')");
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_msg_user_time ON messages(route,user_id,received_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS assistant_records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,body TEXT NOT NULL,modified_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_assistant_kind ON assistant_records(kind)');
    this.sql.exec("UPDATE assistant_records SET body=json_set(body,'$.createdAt',modified_at) WHERE kind IN ('template','message-meta','input','draft-version','feedback') AND json_extract(body,'$.createdAt') IS NULL");
    this.sql.exec("UPDATE messages SET status='send_unknown' WHERE status='sending'");
  }
  rows(q,...p){return this.sql.exec(q,...p).toArray();}
  record(id){const r=this.rows('SELECT body FROM assistant_records WHERE id=?',id)[0];return r?JSON.parse(r.body):null;}
  records(kind){return this.rows('SELECT body FROM assistant_records WHERE kind=? ORDER BY modified_at DESC',kind).map(r=>JSON.parse(r.body));}
  put(kind,item){this.sql.exec('INSERT OR REPLACE INTO assistant_records(id,kind,body,modified_at) VALUES(?,?,?,?)',item.id,kind,JSON.stringify(item),Date.now());return item;}
  message(id){return this.rows('SELECT * FROM messages WHERE id=?',id)[0];}
  newer(row){return this.rows("SELECT id,kind,body,received_at FROM messages WHERE route=? AND user_id=? AND received_at>=? AND id<>? AND status<>'expired' ORDER BY received_at",row.route,row.user_id,row.received_at,row.id);}
  async schedule(ms){const at=Date.now()+ms,old=await this.ctx.storage.getAlarm();if(!old||old>at)await this.ctx.storage.setAlarm(at);}
  async scheduleRetention(){
    const message=this.rows("SELECT min(received_at) AS at FROM messages WHERE status<>'expired'")[0]?.at;
    const records=this.rows("SELECT min(CAST(json_extract(body,'$.createdAt') AS INTEGER)) AS at FROM assistant_records WHERE kind IN ('case','template','message-meta','input','draft-version','feedback') AND coalesce(json_extract(body,'$.status'),'')<>'expired' AND coalesce(json_extract(body,'$.retentionProcessed'),0)=0")[0]?.at;
    const times=[message,records].filter(x=>Number.isFinite(x)&&x>0).map(x=>x+RAW_RETENTION_DAYS*86400000);
    await this.schedule(times.length?Math.max(500,Math.min(86400000,Math.min(...times)-Date.now()+1)):86400000);
  }
  async receive(items){let inserted=0;this.expireRaw();
    for(const r of items.slice(0,50)){if(!A_ROUTE_SET.has(r.route)||!r.id.startsWith(r.route+':')||this.message(r.id))continue;
      this.sql.exec('INSERT INTO messages(id,route,user_id,kind,body,received_at,status,modified_at) VALUES(?,?,?,?,?,?,?,?)',r.id,r.route,r.userId,r.kind,r.body,r.receivedAt,r.status,Date.now());inserted++;}
    if(inserted){await this.scheduleRetention();if(this.env.ASSISTANT_AUTO_DRAFT==='true')await this.schedule(500);}return {ok:true,inserted};
  }
  retentionPlan(now=Date.now()){
    const cutoff=now-RAW_RETENTION_DAYS*86400000;
    return {days:RAW_RETENTION_DAYS,cutoff,messages:this.rows("SELECT id FROM messages WHERE received_at<? AND status<>'expired'",cutoff).length,
      cases:this.records('case').filter(c=>c.createdAt<cutoff&&!(c.status==='approved'&&c.privacyReviewed)&&c.status!=='expired').length};
  }
  expireRaw(now=Date.now()){
    const cutoff=now-RAW_RETENTION_DAYS*86400000;
    const ids=new Set(this.rows("SELECT id FROM messages WHERE received_at<? AND status<>'expired'",cutoff).map(r=>r.id));
    this.sql.exec("UPDATE messages SET body='',user_id='',draft='',status='expired',error='原文の保存期限を経過しました',modified_at=? WHERE received_at<? AND status<>'expired'",now,cutoff);
    for(const kind of ['message-meta','input','draft-version','feedback'])for(const r of this.records(kind)){
      const messageId=r.messageId||(kind==='input'?r.id.slice(6):kind==='message-meta'?r.id.slice(5):'');
      if(ids.has(messageId)||(r.createdAt&&r.createdAt<cutoff))this.put(kind,{id:r.id,messageId,createdAt:r.createdAt||now,status:'expired',evidence:r.evidence||'',author:r.author||'unknown'});
    }
    for(const c of this.records('case').filter(c=>c.createdAt<cutoff&&!c.retentionProcessed)){
      if(c.status==='approved'&&c.privacyReviewed){c.source='保存期限経過後の匿名事例';c.authorshipBasis='所有者申告・匿名事例として承認済み';}
      else {c.inquiry='';c.reply='';c.status='expired';c.source='保存期限経過';c.authorshipBasis='';}
      c.retentionProcessed=true;this.put('case',c);
    }
    for(const t of this.records('template').filter(t=>t.createdAt&&t.createdAt<cutoff&&!t.retentionProcessed))this.put('template',t.status==='approved'&&t.privacyReviewed?{...t,source:'承認済みの匿名テンプレート',retentionProcessed:true}:{...t,body:'',source:'保存期限経過',status:'expired',retentionProcessed:true});
    this.sql.exec("DELETE FROM assistant_records WHERE kind IN ('throttle','copy-review') AND modified_at<?",cutoff);
    return {ok:true,expired:ids.size};
  }
  async list(p={}){
    this.expireRaw();await this.scheduleRetention();const offset=Math.max(0,Math.min(100000,Number(p.offset)||0)),limit=100;
    const messages=this.rows("SELECT * FROM messages ORDER BY CASE WHEN status IN ('sent','sent_confirmed','ignored','expired') THEN 1 ELSE 0 END,received_at DESC LIMIT ? OFFSET ?",limit,offset).map(m=>({...m,meta:this.record('meta:'+m.id),input:this.record('input:'+m.id),newerMessages:m.user_id?this.newer(m):[]}));
    const total=Number(this.rows('SELECT count(*) AS n FROM messages')[0].n);
    return {ok:true,messages,offset,nextOffset:offset+limit<total?offset+limit:null,total,countActive:Number(this.rows("SELECT count(*) AS n FROM messages WHERE status NOT IN ('sent','ignored','sent_confirmed','expired')")[0].n),cases:this.records('case'),templates:this.records('template'),suggestions:correctionSuggestions(this.records('feedback')),style:styleProfile(this.records('case')),rules:RULES,policyVersion:POLICY_VERSION,usage:this.record('budget:'+budgetMonth()),retention:this.retentionPlan(),apiEnabled:this.env.ASSISTANT_API_ENABLED==='true',model:this.env.ASSISTANT_MODEL||'',monthlyRequests:Number(this.env.ASSISTANT_MONTHLY_REQUEST_LIMIT||0),monthlyTokens:Number(this.env.ASSISTANT_MONTHLY_TOKEN_LIMIT||0),monthlyUsd:Number(this.env.ASSISTANT_MONTHLY_USD_LIMIT||0)};
  }
  async previewInput(p){const row=this.message(p.id);if(!row||row.status==='expired')throw Error('not_found');return {ok:true,text:redactText(row.body),bodyHash:await digestText(row.body),warnings:['自動除去は完全ではありません。氏名・連絡先・住所・診断名等を確認してください']};}
  async approveInput(p){const row=this.message(p.id);if(!row||row.status==='expired'||p.confirmed!==true||p.bodyHash!==await digestText(row.body)||typeof p.text!=='string'||!p.text.trim()||p.text.length>4000)throw Error('invalid_privacy_review');
    if(privacyWarnings(p.text).length)throw Error('personal_data_detected');
    const item={id:'input:'+p.id,messageId:p.id,bodyHash:p.bodyHash,text:p.text.trim(),privacyReviewed:true,safeForModel:true,procedureContextConfirmed:p.procedureContextConfirmed===true,reviewedAt:Date.now(),createdAt:Date.now()};this.put('input',item);
    this.invalidateMessage(p.id);if(!TERMINAL.includes(row.status)&&row.status!=='drafting')this.sql.exec("UPDATE messages SET status='new',error='' WHERE id=?",p.id);if(this.env.ASSISTANT_AUTO_DRAFT==='true')await this.schedule(500);return {ok:true};
  }
  async alarm(){this.expireRaw();if(this.env.ASSISTANT_ENABLED!=='true'){await this.scheduleRetention();return;}
    this.sql.exec("UPDATE messages SET status='draft_failed',error='生成が中断しました。手動で再生成してください' WHERE status='drafting' AND modified_at<?",Date.now()-120000);
    if(this.env.ASSISTANT_AUTO_DRAFT==='true'){
      const row=this.rows("SELECT id,body FROM messages WHERE status IN ('new','privacy_review') ORDER BY received_at").find(r=>this.record('input:'+r.id)?.safeForModel||deriveSafeInquiry(r.body));
      if(row)await this.generate(row.id,{automatic:true});
    }
    await this.scheduleRetention();
    if(this.env.ASSISTANT_AUTO_DRAFT==='true'&&this.rows("SELECT id,body FROM messages WHERE status IN ('new','privacy_review')").some(r=>this.record('input:'+r.id)?.safeForModel||deriveSafeInquiry(r.body)))await this.schedule(1000);
  }
  reserveBudget(tokens,model){const price=PRICES[model];if(!price)throw Error('model_not_allowed');
    const id='budget:'+budgetMonth(),b=this.record(id)||{id,requests:0,tokensReserved:0,actualTokens:0,reservedMicros:0};
    const cap=Number(this.env.ASSISTANT_MONTHLY_REQUEST_LIMIT||0),limit=Number(this.env.ASSISTANT_MONTHLY_TOKEN_LIMIT||0),usd=Number(this.env.ASSISTANT_MONTHLY_USD_LIMIT||0),micros=Math.ceil(tokens*Math.max(price.input,price.output));
    if(!Number.isSafeInteger(cap)||!Number.isSafeInteger(limit)||cap<1||!Number.isFinite(usd)||usd<=0||b.requests>=cap||b.tokensReserved+tokens>limit||(b.reservedMicros||0)+micros>Math.floor(usd*1e6))throw Error('budget_limit');
    b.requests++;b.tokensReserved+=tokens;b.reservedMicros=(b.reservedMicros||0)+micros;this.put('budget',b);return {id,tokens,micros,price};
  }
  settleBudget(reservation,usage){const total=Number(usage?.total_tokens);if(!Number.isSafeInteger(total)||total<0||total>reservation.tokens)return;
    const b=this.record(reservation.id),micros=Math.ceil(total*Math.max(reservation.price.input,reservation.price.output));
    b.tokensReserved-=reservation.tokens-total;b.reservedMicros-=reservation.micros-micros;b.actualTokens+=total;this.put('budget',b);
  }
  referencesValid(meta){return Object.entries(meta?.references||{}).every(([id,value])=>{const r=this.record(id);return r&&reference(r)===value;});}
  async generate(id,{automatic=false}={}){
    this.expireRaw();const row=this.message(id);if(!row||row.kind!=='text'||TERMINAL.includes(row.status)||row.status==='drafting')return {ok:false,code:'not_redraftable'};
    let reviewed=this.record('input:'+id);const bodyHash=await digestText(row.body);
    if(this.env.ASSISTANT_API_ENABLED==='true'&&(!reviewed?.safeForModel||reviewed.bodyHash!==bodyHash)){
      const summary=deriveSafeInquiry(row.body);
      if(!summary){this.sql.exec("UPDATE messages SET status='privacy_review',error='匿名化した用件の確認が必要です' WHERE id=?",id);return {ok:false,code:'privacy_review_required'};}
      reviewed=this.put('input',{id:'input:'+id,messageId:id,bodyHash,text:summary,safeForModel:true,privacyReviewed:false,autoDerived:true,reviewedAt:Date.now(),createdAt:Date.now()});
    }
    if(automatic){const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),key='auto:'+day+':'+await digestText(row.route+row.user_id),count=this.record(key)?.count||0;
      if(count>=Number(this.env.ASSISTANT_DAILY_CONTACT_LIMIT||3)){this.sql.exec("UPDATE messages SET status='draft_failed',error='この相手の本日の自動生成上限です' WHERE id=?",id);return {ok:false,code:'contact_daily_limit'};}
      this.put('throttle',{id:key,count:count+1,createdAt:Date.now()});
    }
    this.sql.exec("UPDATE messages SET status='drafting',modified_at=? WHERE id=?",Date.now(),id);await this.schedule(150000);
    try{
      // Both manual and automatic generation resolve the exact same source path here.
      const [member,availability]=await Promise.all([readCurrentFacts(this.env,row.route,row.user_id),readAvailabilityFacts(this.ctx,this.env,row.route)]);
      const facts={...member,...availability,checks:[...member.checks,...availability.checks]},cases=this.records('case');
      row.safeText=reviewed?.text||'';row.procedureContextConfirmed=reviewed?.procedureContextConfirmed===true;
      row.context=this.rows("SELECT id,body,received_at FROM messages WHERE route=? AND user_id=? AND received_at<? AND status<>'expired' ORDER BY received_at DESC LIMIT 5",row.route,row.user_id,row.received_at).reverse().map(m=>({direction:'incoming',text:m.body,safeText:this.record('input:'+m.id)?.text||'',at:m.received_at}));
      for(const f of this.records('feedback').filter(f=>f.status==='active'&&f.route===row.route&&f.messageId!==id&&this.message(f.messageId)?.user_id===row.user_id&&Date.parse(f.sentAt)<=row.received_at)){
        const c=cases.find(c=>c.source==='feedback:'+f.id&&c.status==='approved'&&c.privacyReviewed);if(c)row.context.push({direction:'sent_confirmed',text:c.reply,safeText:c.reply,at:Date.parse(f.sentAt)});
      }
      row.context.sort((a,b)=>a.at-b.at);const input=buildModelInput(row,cases,this.records('template'),facts);
      const references=Object.fromEntries([...input.examples,...input.templates].map(x=>[x.id,reference(this.record(x.id))]));let reply,checks=[],usedTemplateIds=[],generator='local';
      if(this.env.ASSISTANT_API_ENABLED==='true'){
        if(!this.env.OPENAI_API_KEY||!this.env.ASSISTANT_MODEL)throw Error('api_not_configured');
        const payload=buildDraftRequest(input,this.env.ASSISTANT_MODEL);
        const reservation=this.reserveBudget(new TextEncoder().encode(JSON.stringify(payload)).length+2048,this.env.ASSISTANT_MODEL);
        const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+this.env.OPENAI_API_KEY,'content-type':'application/json'},signal:AbortSignal.timeout(45000),body:JSON.stringify(payload)});
        if(!response.ok){await response.body?.cancel();throw Error('model_request_failed');}
        const result=await response.json();this.settleBudget(reservation,result.usage);if(result.status!=='completed')throw Error('model_incomplete');const data=JSON.parse(extractResponseText(result));
        if(typeof data.reply!=='string'||data.reply.length>4000||!Array.isArray(data.checks)||!Array.isArray(data.templateIds)||(!data.reply.trim()&&!data.checks.length))throw Error('invalid_model_output');
        reply=data.reply;checks=data.checks.map(String).slice(0,12);usedTemplateIds=data.templateIds.filter(id=>input.templates.some(t=>t.id===id));generator='openai';
      }else{
        const ref=retrieve(row.body,row.route,cases).find(c=>classify(row.body)==='欠席'&&intentFeatures(c.inquiry).illness===intentFeatures(row.body).illness&&!inspectReply(c.reply,facts,{category:classify(row.body)}).length);
        reply=ref?ref.reply:'こんにちは！\nご連絡ありがとうございます！';checks.push('OpenAI API停止中のローカル参考文です');
      }
      const inspection=inspectReply(reply,facts,{category:classify(row.body)});if(!reply.trim())inspection.push({code:'abstained',message:'AIが返信文の作成を見合わせました。確認事項を確認してください',severity:'block'});checks.push(...facts.checks,...inspection.map(x=>x.message));
      if(this.message(id)?.status!=='drafting')return {ok:false,code:'generation_cancelled'};
      if(!this.referencesValid({references})||reviewed&&this.record(reviewed.id)?.reviewedAt!==reviewed.reviewedAt)throw Error('knowledge_changed');
      if(reviewed?.autoDerived)checks.push('原文を送らず定型の用件から自動要約しています。細かな条件は原文と照合してください');
      const versionId=crypto.randomUUID(),meta={id:'meta:'+id,schemaVersion:2,messageId:id,versionId,generator,inputMode:reviewed?.autoDerived?'automatic_summary':'reviewed_body',facts,inspection,checks:[...new Set(checks)],caseIds:input.examples.map(c=>c.id),templateIds:input.templates.map(t=>t.id),usedTemplateIds,references,policyVersion:POLICY_VERSION,guardBlocked:inspection.some(i=>i.severity==='block'),createdAt:Date.now()};
      this.put('draft-version',{...meta,id:versionId,draft:reply,rawDraft:reply});this.put('message-meta',meta);
      this.sql.exec('UPDATE messages SET status=?,draft=?,error=?,modified_at=? WHERE id=?',inspection.length?'draft_review':'draft_ready',reply,'',Date.now(),id);return {ok:true,generator,needsReview:!!inspection.length,checks:meta.checks};
    }catch(e){const code=/^[a-z_]+$/.test(e.message)?e.message:'draft_failed';if(this.message(id)?.status==='drafting')this.sql.exec("UPDATE messages SET status='draft_failed',error=?,modified_at=? WHERE id=?",code,Date.now(),id);return {ok:false,code};}
  }
  async importCases(p){const rows=p.csv!==undefined?csvCases(p.csv,p.options||{}):p.rows;if(!Array.isArray(rows)||!rows.length||rows.length>200)throw Error('invalid_import');const existing=this.records('case');if(existing.length+rows.length>2000)throw Error('case_capacity_reached');const normalized=rows.map(normalizeCase);let inserted=0;
    for(const c of normalized){if(existing.some(e=>e.route===c.route&&e.inquiry===c.inquiry&&e.reply===c.reply))continue;this.put('case',c);existing.push(c);inserted++;}await this.scheduleRetention();return {ok:true,inserted,quarantined:normalized.filter(c=>c.status==='quarantined').length};}
  invalidateMessage(id){const row=this.message(id);if(row&&['draft_ready','draft_review','copied'].includes(row.status))this.sql.exec("UPDATE messages SET status='draft_failed',error='参照内容が変更されました。再生成してください' WHERE id=?",id);}
  invalidateKnowledge(field,id){for(const m of this.records('message-meta'))if(m[field]?.includes(id))this.invalidateMessage(m.messageId||m.id.slice(5));}
  async reviewCase(p){const original=this.record(p.caseId);if(!original||!this.records('case').some(c=>c.id===p.caseId))throw Error('case_not_found');const c={...original};
    if(p.status==='excluded'){c.status='excluded';}else{
      if(typeof p.inquiry==='string')c.inquiry=p.inquiry.slice(0,4000);if(typeof p.reply==='string')c.reply=p.reply.slice(0,4000);if(['owner','staff','unknown'].includes(p.author))c.author=p.author;
      if(p.privacyReviewed!==true||privacyWarnings(c.inquiry+'\n'+c.reply).length)throw Error('privacy_review_required');
      const checked=normalizeCase(c);if(checked.warnings.length)throw Error('case_quarantined');c.status='approved';c.privacyReviewed=true;c.category=classify(c.inquiry);c.warnings=[];c.reviewedAt=Date.now();
    }
    this.put('case',c);this.invalidateKnowledge('caseIds',c.id);
    for(const t of this.records('template').filter(t=>t.caseIds?.includes(c.id))){t.status=c.status==='excluded'?'revoked':'pending';this.put('template',t);this.invalidateKnowledge('templateIds',t.id);}return {ok:true};
  }
  async extract(){let inserted=0;const existing=this.records('template');for(const t of proposeTemplates(this.records('case'))){if(existing.some(x=>x.body===t.body&&x.route===t.route&&x.category===t.category))continue;this.put('template',{...t,createdAt:Date.now()});inserted++;}return {ok:true,inserted};}
  async template(p){const previous=this.record(p.templateId);if(!previous||!this.records('template').some(t=>t.id===p.templateId))throw Error('template_not_found');const t={...previous};
    if(p.usage&&!['inbound_reply','same_day_procedure'].includes(p.usage))throw Error('invalid_scope');
    if(typeof p.body==='string')t.body=p.body.trim().slice(0,4000);if(!t.body)throw Error('empty_template');if(CATEGORIES.includes(p.category))t.category=p.category;
    if(!['pending','approved','revoked'].includes(p.status))throw Error('invalid_status');
    if(p.status==='approved'){
      const checks=policyWarnings(t.body,{category:t.category}),claims=typedClaims(t.body.replace(/\{[^}]+\}/g,''));
      if(checks.length||claims.length)throw Error('template_policy_review_required');
      if(p.privacyReviewed!==true||privacyWarnings(t.body).length)throw Error('privacy_review_required');
      if(/入会.{0,12}フォーム|入会申込/.test(t.body.replace(/\s/g,''))&&p.usage!=='same_day_procedure')throw Error('same_day_scope_required');
      if(p.usage==='same_day_procedure'&&p.sameDayConfirmed!==true)throw Error('same_day_scope_required');
    }
    t.usage=p.usage||t.usage||'inbound_reply';t.status=p.status;t.privacyReviewed=p.privacyReviewed===true;t.version++;this.put('template',t);this.invalidateKnowledge('templateIds',t.id);return {ok:true};
  }
  async importTemplates(p){if(!Array.isArray(p.rows)||!p.rows.length||p.rows.length>50)throw Error('invalid_import');const rows=p.rows.map(r=>{if(!A_ROUTE_SET.has(r.route)||typeof r.body!=='string'||!r.body.trim()||r.body.length>4000)throw Error('invalid_template');return r;});let inserted=0;
    for(const r of rows){if(this.records('template').some(t=>t.body===r.body&&t.route===r.route))continue;this.put('template',{id:crypto.randomUUID(),route:r.route,category:CATEGORIES.includes(r.category)?r.category:classify(r.title),body:r.body,title:String(r.title||'既存定型文').slice(0,80),source:String(r.source||'LINE定型文').slice(0,300),status:'pending',privacyReviewed:false,caseIds:[],version:1,createdAt:Date.now()});inserted++;}await this.scheduleRetention();return {ok:true,inserted};}
  async copied(p){const row=this.message(p.id),meta=this.record('meta:'+p.id);if(!row||!['draft_ready','draft_review','copied'].includes(row.status)||meta?.schemaVersion!==2||p.versionId!==meta.versionId||!this.referencesValid(meta))throw Error('stale_draft');
    const newer=this.newer(row);if(newer.some(m=>!Array.isArray(p.reviewedMessageIds)||!p.reviewedMessageIds.includes(m.id)))return {ok:false,code:'newer_message_requires_review',newerMessages:newer};
    if(!p.noMakeup||!p.noFollowup||!p.factsChecked)throw Error('reply_review_required');if(typeof p.text!=='string'||!p.text.trim()||p.text.length>4000)throw Error('invalid_reply');
    const inspection=inspectReply(p.text,meta.facts,{category:classify(row.body)});if(inspection.some(i=>i.severity==='block'))return {ok:false,code:'policy_edit_required',inspection};
    this.sql.exec("UPDATE messages SET status='copied',modified_at=? WHERE id=?",Date.now(),p.id);
    this.put('copy-review',{id:'copy:'+p.id,messageId:p.id,versionId:p.versionId,textHash:await digestText(p.text),reviewedMessageIds:newer.map(m=>m.id),createdAt:Date.now()});return {ok:true,text:p.text,sent:false,inspection};
  }
  async confirmSent(p){const row=this.message(p.id),version=this.record(p.versionId),sent=Date.parse(p.sentAt);
    if(!row||!version||version.messageId!==p.id||version.status==='expired'||p.confirmed!==true||!String(p.text||'').trim()||p.text.length>4000||!Number.isFinite(sent)||sent<Math.floor(row.received_at/60000)*60000||sent>Date.now()+60000||['sent','sent_confirmed'].includes(row.status))throw Error('invalid_sent_confirmation');
    const author=['owner','staff','unknown'].includes(p.author)?p.author:'unknown';
    const f={id:crypto.randomUUID(),messageId:p.id,route:row.route,author,authorshipBasis:author==='owner'?'所有者申告：Aチームは原則本人。登録時に変更可能':'登録者による申告',draftVersion:p.versionId,draft:version.rawDraft||version.draft,final:p.text.trim(),category:classify(row.body),status:'active',sentAt:p.sentAt,evidence:'manual_sent_confirmation',createdAt:Date.now()};
    this.put('feedback',f);const c=normalizeCase({route:row.route,inquiry:row.body,reply:f.final,author,authorshipBasis:f.authorshipBasis,evidence:f.evidence,sentAt:p.sentAt,source:'feedback:'+f.id});this.put('case',c);this.sql.exec("UPDATE messages SET status='sent_confirmed',modified_at=? WHERE id=?",Date.now(),p.id);return {ok:true,evidence:f.evidence,caseId:c.id};
  }
  async revokeFeedback(p){const f=this.record(p.feedbackId);if(!f||!this.records('feedback').some(x=>x.id===f.id))throw Error('feedback_not_found');f.status='revoked';this.put('feedback',f);for(const c of this.records('case').filter(c=>c.source==='feedback:'+f.id))await this.reviewCase({caseId:c.id,status:'excluded'});return {ok:true};}
  async suggest(p){const s=correctionSuggestions(this.records('feedback')).find(s=>s.feedbackIds.includes(p.feedbackId));if(!s)throw Error('suggestion_not_found');const sources=this.records('case').filter(c=>s.feedbackIds.some(id=>c.source==='feedback:'+id));if(!sources.length)throw Error('source_missing');this.put('template',{id:crypto.randomUUID(),route:s.route,category:s.category,body:s.body,status:'pending',privacyReviewed:false,caseIds:sources.map(c=>c.id),version:1,createdAt:Date.now()});return {ok:true};}
  async feedbackList(){this.expireRaw();return {ok:true,feedback:this.records('feedback'),versions:this.records('draft-version')};}
  async dismiss(id){if(!this.message(id))return {ok:false,code:'not_found'};this.sql.exec("UPDATE messages SET status='ignored',modified_at=? WHERE id=?",Date.now(),id);return {ok:true};}
  async manual(p){if(!A_ROUTE_SET.has(p.route)||!String(p.text||'').trim()||p.text.length>4000)throw Error('invalid_message');const id=p.route+':manual-'+crypto.randomUUID();await this.receive([{id,route:p.route,userId:'manual-'+crypto.randomUUID(),kind:'text',body:p.text,receivedAt:Date.now(),status:'new'}]);return {ok:true,id};}
}
export async function captureAInbox(ctx,env,route,events){if(env.ASSISTANT_ENABLED!=='true'||!A_ROUTE_SET.has(route))return;const messages=events.map(e=>normalizeIncoming(route,e)).filter(Boolean);if(!messages.length)return;try{const inbox=ctx?.exports?.AssistantInbox?.getByName('prospect-a-team-inbox-v1',{locationHint:'apac'});if(!inbox)throw Error('missing_binding');await inbox.receive(messages);}catch(_){console.error('assistant_inbox_capture_failed');}}
async function authorized(request,env){const expected=String(env.ASSISTANT_ADMIN_TOKEN||''),actual=(request.headers.get('authorization')||'').replace(/^Bearer /i,'');if(expected.length<32||expected.length!==actual.length)return false;const digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));const [a,b]=await Promise.all([digest(expected),digest(actual)]);let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];return mismatch===0;}
function out(data,status=200){return Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
async function boundedJson(request){const reader=request.body?.getReader();let size=0,text='';const decoder=new TextDecoder();if(!reader)throw Error('invalid_json');try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>600000){await reader.cancel();throw Error('too_large');}text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}}
export async function assistantRequest(request,env,ctx){const url=new URL(request.url),path=url.pathname.replace(/\/+$/,'');if(env.ASSISTANT_ENABLED!=='true')return out({ok:false,code:'assistant_not_enabled'},404);
  const headers={'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
  if(request.method==='GET'&&path==='/assistant')return new Response(assistantHtml,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
  if(request.method==='GET'&&path==='/assistant/app.js')return new Response(assistantClientJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if(!await authorized(request,env))return out({ok:false,code:'unauthorized'},401);if(request.method==='POST'&&request.headers.get('origin')&&request.headers.get('origin')!==url.origin)return out({ok:false,code:'origin_rejected'},403);
  const inbox=ctx?.exports?.AssistantInbox?.getByName('prospect-a-team-inbox-v1',{locationHint:'apac'});if(!inbox)return out({ok:false,code:'inbox_not_configured'},503);
  if(request.method==='GET'&&path==='/assistant/api/messages')return out(await inbox.list({offset:url.searchParams.get('offset')}));if(request.method==='GET'&&path==='/assistant/api/feedback')return out(await inbox.feedbackList());if(request.method!=='POST')return out({ok:false,code:'not_found'},404);
  const actions={'import':p=>inbox.importCases(p),'import-templates':p=>inbox.importTemplates(p),'suggest':p=>inbox.suggest(p),'case-review':p=>inbox.reviewCase(p),'extract':()=>inbox.extract(),'template':p=>inbox.template(p),'input-preview':p=>inbox.previewInput(p),'input-approve':p=>inbox.approveInput(p),'copied':p=>inbox.copied(p),'confirm-sent':p=>inbox.confirmSent(p),'feedback-revoke':p=>inbox.revokeFeedback(p),'dismiss':p=>inbox.dismiss(p.id),'manual':p=>inbox.manual(p),'redraft':p=>inbox.generate(p.id)};
  const key=path.slice('/assistant/api/'.length);if(!path.startsWith('/assistant/api/')||!Object.hasOwn(actions,key))return out({ok:false,code:'not_found'},404);
  try{return out(await actions[key](await boundedJson(request)));}catch(e){return out({ok:false,code:/^[a-z_]+$/.test(e.message)?e.message:'invalid_request'},e.message==='too_large'?413:400);}
}
