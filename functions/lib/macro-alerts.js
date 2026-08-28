// 定時通知でマクロ指標の基準値警告を判定する（サーバー側）。
// クライアントの macroAlertState と同じ規則で判定するが、値はその場で /api/macro・/api/estat から
// 取り直す（端末が同期していなくても最新で判定できるように）。
//
// 判定はクライアントの表示と同じ「変換後の値」で行う:
//   tf='yoy' … 約1年前の観測に対する変化率%   / tf='diff' … 直前の観測との差 / それ以外は生の値
// mode: 'level'=その値 / 'chg'=前期差 / 'yoy'=1年差、cmp: 'gt'=上回ったら / 'lt'=下回ったら

// クライアント（app.js の MACRO_SERIES）と同じ変換規則。ラベル・単位はメール本文用。
// ※ここに無い系列IDの警告は「判定できない」として黙って飛ばす（片方だけ増えた時に落ちないように）。
export const SERIES = {
  CPIAUCSL:        { label: 'CPI 総合',                 tf: 'yoy',  unit: '%',   dec: 1 },
  CPILFESL:        { label: 'コアCPI',                  tf: 'yoy',  unit: '%',   dec: 1 },
  PCEPILFE:        { label: 'コアPCE',                  tf: 'yoy',  unit: '%',   dec: 1 },
  T10YIE:          { label: '期待インフレ(10年BEI)',    tf: 'raw',  unit: '%',   dec: 2 },
  DFF:             { label: 'FF金利(実効)',             tf: 'raw',  unit: '%',   dec: 2 },
  DGS2:            { label: '米2年債',                  tf: 'raw',  unit: '%',   dec: 2 },
  DGS10:           { label: '米10年債',                 tf: 'raw',  unit: '%',   dec: 2 },
  T10Y2Y:          { label: '10年−2年',                 tf: 'raw',  unit: '%pt', dec: 2 },
  MORTGAGE30US:    { label: '住宅ローン30年',           tf: 'raw',  unit: '%',   dec: 2 },
  DRTSCILM:        { label: 'C&I 基準厳格化(大企業)',   tf: 'raw',  unit: '%pt', dec: 1 },
  DRTSCIS:         { label: 'C&I 基準厳格化(中小)',     tf: 'raw',  unit: '%pt', dec: 1 },
  DRSDCILM:        { label: 'C&I 需要(大企業)',         tf: 'raw',  unit: '%pt', dec: 1 },
  DRSDCIS:         { label: 'C&I 需要(中小)',           tf: 'raw',  unit: '%pt', dec: 1 },
  DRTSCLCC:        { label: 'カードローン 基準厳格化',  tf: 'raw',  unit: '%pt', dec: 1 },
  SUBLPDHMSGNQ:    { label: '住宅ローン 基準厳格化',    tf: 'raw',  unit: '%pt', dec: 1 },
  UNRATE:          { label: '失業率',                   tf: 'raw',  unit: '%',   dec: 1 },
  PAYEMS:          { label: '非農業雇用(前月差)',       tf: 'diff', unit: '千人', dec: 0 },
  ICSA:            { label: '新規失業保険申請',         tf: 'raw',  unit: '件',  dec: 0 },
  A191RL1Q225SBEA: { label: '実質GDP成長率(年率)',      tf: 'raw',  unit: '%',   dec: 1 },
  INDPRO:          { label: '鉱工業生産(前年比)',       tf: 'yoy',  unit: '%',   dec: 1 },
  RSAFS:           { label: '小売売上(前年比)',         tf: 'yoy',  unit: '%',   dec: 1 },
  UMCSENT:         { label: '消費者信頼感(ミシガン大)', tf: 'raw',  unit: '',    dec: 1 },
  BAMLH0A0HYM2:    { label: 'ハイイールド・スプレッド', tf: 'raw',  unit: '%pt', dec: 2 },
  NFCI:            { label: '金融環境指数(シカゴ連銀)', tf: 'raw',  unit: '',    dec: 2 },
  VIXCLS:          { label: 'VIX',                      tf: 'raw',  unit: '',    dec: 1 },
  IRLTLT01JPM156N: { label: '日本10年国債',             tf: 'raw',  unit: '%',   dec: 2 },
  IRSTCI01JPM156N: { label: '日本 短期金利(コール)',    tf: 'raw',  unit: '%',   dec: 2 },
  LRHUTTTTJPM156S: { label: '日本 失業率',              tf: 'raw',  unit: '%',   dec: 1 },
  JPNRGDPEXP:      { label: '日本 実質GDP(前年比)',     tf: 'yoy',  unit: '%',   dec: 1 },
  XTEXVA01JPM667S: { label: '日本 輸出額(前年比)',      tf: 'yoy',  unit: '%',   dec: 1 },
  RBJPBIS:         { label: '円 実質実効為替レート',    tf: 'raw',  unit: '',    dec: 1 },
  JP_CPI:      { label: '日本CPI 総合',     tf: 'raw', unit: '%', dec: 1, estat: { id: '0004052037', cdTab: '3', cdCat01: '0001', cdArea: '00000' } },
  JP_CPI_CORE: { label: '日本CPI コア',     tf: 'raw', unit: '%', dec: 1, estat: { id: '0004052037', cdTab: '3', cdCat01: '0161', cdArea: '00000' } },
  JP_CPI_CC:   { label: '日本CPI コアコア', tf: 'raw', unit: '%', dec: 1, estat: { id: '0004052037', cdTab: '3', cdCat01: '0178', cdArea: '00000' } },
};

const MODE_LABEL = { level: '実値', chg: '前期差', yoy: '1年差' };
const CMP_LABEL = { gt: '上回ったら', lt: '下回ったら' };

// pts の中から「date より days 日前」に最も近い点（許容 tol 日）。app.js の macroAtBefore と同じ。
function atBefore(pts, date, days, tol) {
  const target = Date.parse(date) - days * 86400000;
  let best = null, bestDiff = Infinity;
  for (let i = pts.length - 1; i >= 0; i--) {
    const diff = Math.abs(Date.parse(pts[i][0]) - target);
    if (diff < bestDiff) { bestDiff = diff; best = pts[i]; }
    if (Date.parse(pts[i][0]) < target - tol * 86400000) break;
  }
  return (best && bestDiff <= tol * 86400000) ? best : null;
}
// 生の観測列を表示用に変換（app.js の macroPoints と同じ規則）
function transform(def, raw) {
  if (!raw || !raw.length) return [];
  if (def.tf === 'diff') {
    const out = [];
    for (let i = 1; i < raw.length; i++) out.push([raw[i][0], raw[i][1] - raw[i - 1][1]]);
    return out;
  }
  if (def.tf === 'yoy') {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const prev = atBefore(raw, raw[i][0], 365, 60);
      if (prev && prev[1]) out.push([raw[i][0], (raw[i][1] / prev[1] - 1) * 100]);
    }
    return out;
  }
  return raw.slice();
}
function fmt(v, dec) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// 有効な警告設定に必要な系列だけを取得する（不要な系列は引かない）
// token: NOTIFY_TRIGGER_TOKEN。/api/macro・/api/estat は鍵つきAPIとして保護されている。
async function fetchSeries(origin, ids, token) {
  const authInit = token ? { headers: { authorization: 'Bearer ' + token } } : undefined;
  const out = {};
  const fred = ids.filter(id => SERIES[id] && !SERIES[id].estat);
  const estat = ids.filter(id => SERIES[id] && SERIES[id].estat);
  for (let i = 0; i < fred.length; i += 12) {
    const batch = fred.slice(i, i + 12);
    try {
      const res = await fetch(`${origin}/api/macro?ids=${encodeURIComponent(batch.join(','))}`, authInit);
      if (!res.ok) continue;
      const d = await res.json();
      for (const id of batch) {
        const s = d && d.series && d.series[id];
        if (s && Array.isArray(s.obs) && s.obs.length) out[id] = s.obs;
      }
    } catch (_) { /* 取れない系列は判定対象外にするだけ（通知全体は止めない） */ }
  }
  await Promise.all(estat.map(async (id) => {
    const q = SERIES[id].estat;
    const p = new URLSearchParams({ op: 'data', id: q.id });
    for (const [k, v] of Object.entries(q)) if (k !== 'id') p.set(k, v);
    try {
      const res = await fetch(`${origin}/api/estat?${p.toString()}`, authInit);
      if (!res.ok) return;
      const d = await res.json();
      if (Array.isArray(d.obs) && d.obs.length) out[id] = d.obs;
    } catch (_) { /* 同上 */ }
  }));
  return out;
}

// 警告設定（bundle.macroAlerts）を評価して、条件成立している行の説明文を返す。
// 戻り値: { fired:[{text}], checked:件数, skipped:件数 }
export async function evaluateMacroAlerts(origin, bundle, token) {
  const alerts = (bundle && Array.isArray(bundle.macroAlerts) ? bundle.macroAlerts : [])
    .filter(a => a && !a.deleted && a.enabled !== false && a.seriesId && isFinite(a.value) && SERIES[a.seriesId]);
  if (!alerts.length) return { fired: [], checked: 0, skipped: 0 };

  const ids = [...new Set(alerts.map(a => a.seriesId))];
  const obsById = await fetchSeries(origin, ids, token);

  const fired = [];
  let skipped = 0;
  for (const a of alerts) {
    const def = SERIES[a.seriesId];
    const pts = transform(def, obsById[a.seriesId]);
    if (!pts.length) { skipped++; continue; }
    const last = pts[pts.length - 1];
    let v = null;
    if (a.mode === 'chg') { if (pts.length < 2) { skipped++; continue; } v = last[1] - pts[pts.length - 2][1]; }
    else if (a.mode === 'yoy') { const y = atBefore(pts, last[0], 365, 60); if (!y) { skipped++; continue; } v = last[1] - y[1]; }
    else v = last[1];
    if (v == null || !isFinite(v)) { skipped++; continue; }
    const hit = a.cmp === 'lt' ? (v < a.value) : (v > a.value);
    if (!hit) continue;
    const unit = def.unit ? ' ' + def.unit : '';
    fired.push({
      text: `${def.label}（${MODE_LABEL[a.mode] || '実値'}）が ${fmt(a.value, def.dec)}${unit} を${CMP_LABEL[a.cmp] || '上回ったら'}`
        + `：現在 ${fmt(v, def.dec)}${unit}（${last[0]}）`,
    });
  }
  return { fired, checked: alerts.length, skipped };
}

// メール本文へ差し込むテキスト（成立が無ければ空文字＝欄ごと出さない）
export function macroAlertSection(result) {
  if (!result || !result.fired || !result.fired.length) return '';
  const L = ['', '── マクロ警告（設定した基準値を抜けた指標）──'];
  for (const f of result.fired) L.push('・' + f.text);
  L.push('※設定した条件を満たした事実のお知らせです。売買の判断を示すものではありません。');
  return L.join('\n');
}
