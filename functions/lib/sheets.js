// サーバー（Cloudflare Functions/Cron）からGoogleスプレッドシートの _appdata を読むための共通処理。
// サービスアカウント（人ではないアプリ専用アカウント）でJWT認証 → アクセストークン取得 → Sheets API読取。
// 必要な環境変数（Cloudflare Pages の Secrets）:
//   GOOGLE_SA_EMAIL        … サービスアカウントのメール（client_email）
//   GOOGLE_SA_PRIVATE_KEY  … サービスアカウントの秘密鍵（private_key。\n を含む文字列でOK）
//   GOOGLE_SHEET_ID        … 対象スプレッドシートID
// 通知機能 N1。原典: app.js gsync.save/load（_appdata!A列にJSONを45000字分割で保存）。

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FILE = 'data.json'; // app.js dsync が Drive に書く同期ファイル名

function b64urlFromBytes(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromString(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// PEM(PKCS8) → ArrayBuffer
function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}
// 環境変数の秘密鍵を正規化（前後の引用符除去・\n を実改行へ）
function normalizePrivateKey(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
}

async function getAccessToken(email, privateKeyPem, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: email, scope: scope || SHEETS_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = b64urlFromString(JSON.stringify(header)) + '.' + b64urlFromString(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('pkcs8', pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlFromBytes(sig);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  if (!res.ok) throw new Error('トークン取得失敗 ' + res.status + '：' + (await res.text()).slice(0, 300));
  const d = await res.json();
  if (!d.access_token) throw new Error('アクセストークンが空');
  return d.access_token;
}

// _appdata 列Aを読み、結合してJSON.parse。返り値は app.js dataBundle() のバンドル（store.data + _colPrefs）。
export async function readAppData(env) {
  const email = env && env.GOOGLE_SA_EMAIL;
  const keyRaw = env && env.GOOGLE_SA_PRIVATE_KEY;
  const sheetId = env && env.GOOGLE_SHEET_ID;
  if (!email || !keyRaw || !sheetId) {
    const lack = [!email && 'GOOGLE_SA_EMAIL', !keyRaw && 'GOOGLE_SA_PRIVATE_KEY', !sheetId && 'GOOGLE_SHEET_ID'].filter(Boolean);
    throw new Error('環境変数が未設定: ' + lack.join(' / '));
  }
  const token = await getAccessToken(email, normalizePrivateKey(keyRaw));
  const range = encodeURIComponent('_appdata!A1:A100000');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Sheets読取失敗 ' + res.status + '：' + (await res.text()).slice(0, 300));
  const d = await res.json();
  const json = ((d.values || []).map(r => (r && r[0]) || '')).join('');
  if (!json) throw new Error('_appdata の列Aが空です（保存済みか、共有設定を確認）');
  return JSON.parse(json);
}

// Drive の data.json（dsyncが書く同期ファイル）をサービスアカウントで読む。
// 事前にユーザーが securities-manager フォルダ(または data.json)を SAメールに共有しておく必要がある。
export async function readAppDataFromDrive(env) {
  const email = env && env.GOOGLE_SA_EMAIL;
  const keyRaw = env && env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !keyRaw) throw new Error('環境変数が未設定: GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY');
  const token = await getAccessToken(email, normalizePrivateKey(keyRaw), DRIVE_SCOPE);
  // SAに共有された data.json を探す（最新更新を優先）
  const q = encodeURIComponent(`name='${DRIVE_FILE}' and trashed=false`);
  const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`, { headers: { Authorization: 'Bearer ' + token } });
  if (!listRes.ok) throw new Error('Drive一覧失敗 ' + listRes.status + '：' + (await listRes.text()).slice(0, 300));
  const list = await listRes.json();
  const file = (list.files || [])[0];
  if (!file) throw new Error(`${DRIVE_FILE} が見つかりません（securities-manager フォルダをサービスアカウントに共有してください）`);
  const cRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: 'Bearer ' + token } });
  if (!cRes.ok) throw new Error('Drive読込失敗 ' + cRes.status + '：' + (await cRes.text()).slice(0, 300));
  const json = await cRes.text();
  if (!json) throw new Error('data.json が空です');
  return JSON.parse(json);
}

// 推奨の読取: まず Drive（自動同期の正本）を試し、ダメなら Sheets にフォールバック。
// 返り値に _source（'drive'|'sheets'）と _driveError（フォールバック時）を付与。
export async function readAppDataBundle(env) {
  try {
    const b = await readAppDataFromDrive(env);
    if (b && typeof b === 'object') b._source = 'drive';
    return b;
  } catch (driveErr) {
    try {
      const b = await readAppData(env);
      if (b && typeof b === 'object') { b._source = 'sheets'; b._driveError = String(driveErr && driveErr.message || driveErr); }
      return b;
    } catch (sheetsErr) {
      throw new Error('Drive/Sheets両方の読取に失敗。Drive: ' + (driveErr && driveErr.message || driveErr) + ' ／ Sheets: ' + (sheetsErr && sheetsErr.message || sheetsErr));
    }
  }
}
