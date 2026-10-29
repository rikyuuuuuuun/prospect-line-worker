// Deterministic redaction is a preview aid, not proof that arbitrary Japanese text is anonymous.
export function redactText(value, terms=[]) {
  let text=String(value||'').slice(0,8000);
  for(const term of terms.filter(t=>typeof t==='string'&&t.length>=2).sort((a,b)=>b.length-a.length))text=text.split(term).join('[氏名]');
  return text.replace(/U[0-9a-f]{32}/gi,'[LINE_ID]')
    .replace(/https?:\/\/\S+/g,'[URL]').replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[メール]')
    .replace(/(?:〒\s*)?\d{3}[-ー]\d{4}/g,'[郵便番号]')
    .replace(/\b0\d{1,4}[-ー ]?\d{1,4}[-ー ]?\d{3,4}\b/g,'[電話]')
    .replace(/(?:氏名|お名前|生年月日|住所|受付番号|ふりがな|お子さま|お子様)\s*[:：][^\n]+/g,'[個人情報]')
    .replace(/(?:担当の|名前は)[一-龠々ぁ-んァ-ヶ]{2,12}(?=より|です|と申)/g,'担当の[氏名]')
    .replace(/[一-龠々ァ-ヶ]{2,10}(?=くん|ちゃん|君|様|の母|の父)/g,'[氏名]')
    .replace(/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?生(?:まれ)?/g,'[生年月日]');
}
export function privacyWarnings(value) {
  const s=String(value||'');const issues=[];
  if(/U[0-9a-f]{32}|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b0\d{8,12}\b/i.test(s))issues.push('識別子・連絡先・URLが残っています');
  if(redactText(s)!==s)issues.push('自動検出できる個人情報が残っています');
  return issues;
}
export async function digestText(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(text))))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const RAW_RETENTION_DAYS=30;
export function budgetMonth(now=Date.now()){return new Date(now+9*3600000).toISOString().slice(0,7);}
