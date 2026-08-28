// サーバー側: 現在値だけを軽量取得する（既存の /api/price?mode=light を小分けで呼ぶ）。
// 高値(5年/52週)等は保存スナップショット(_appdata)を流用し、現在値だけ最新化 → シート保存の鮮度に依存せず判定できる。
// 通知機能 N2b。原典: app.js yahooSymbol / priceKey / api.refreshAll のバッチ取得。

function yahooSymbol(sec) {
  if (sec.market === 'JP' || sec.market === 'FUND') return `${sec.ticker}.T`;
  return sec.ticker;
}
function priceKey(sec) { return `${sec.market}:${sec.ticker}`; }

// origin: 例 https://xxx.pages.dev 。securities: バンドルの securities 配列。
// 返り値: { '<priceKey>': { price, prevClose, ... }, ... }
// token: NOTIFY_TRIGGER_TOKEN。/api/price は鍵つきAPIとして保護されているので内部呼び出しでも必要。
export async function fetchFreshPrices(origin, securities, token) {
  const secs = (securities || []).filter(s => s && s.ticker && s.market !== 'FUND');
  const symToKeys = {}; // yahooSymbol → [priceKey...]（同一シンボルに複数銘柄が紐づく場合の保険）
  for (const s of secs) {
    const sym = yahooSymbol(s);
    (symToKeys[sym] = symToKeys[sym] || []).push(priceKey(s));
  }
  const symbols = Object.keys(symToKeys);
  const out = {};
  const CHUNK = 40; // /api/price 1回あたりの銘柄数（その関数内のサブリクエスト上限対策）
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const part = symbols.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${origin}/api/price?mode=light&symbols=${encodeURIComponent(part.join(','))}`,
        token ? { headers: { authorization: 'Bearer ' + token } } : undefined);
      if (!res.ok) continue;
      const d = await res.json();
      for (const sym of part) {
        const q = d[sym];
        if (q && !q.error && q.price != null) for (const pk of symToKeys[sym]) out[pk] = q;
      }
    } catch (_) { /* この塊は失敗→保存スナップショットの価格にフォールバック */ }
  }
  return out;
}

// バンドルの price キャッシュへ現在値をマージ（高値等は保存値を維持し price/prevClose を更新）
export function mergeFreshPrices(bundle, fresh) {
  bundle.prices = bundle.prices || {};
  for (const pk in fresh) {
    const q = fresh[pk];
    const prev = bundle.prices[pk] || {};
    bundle.prices[pk] = { ...prev, price: q.price, prevClose: q.prevClose != null ? q.prevClose : prev.prevClose };
  }
  return bundle;
}
