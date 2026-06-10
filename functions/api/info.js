// Cloudflare Pages Function: ティッカー情報取得プロキシ
// 単一:   GET /api/info?symbol=AAPL
// バッチ: GET /api/info?symbols=AAPL,7203.T,0131103C.T
//   → 単一: { name, sector, ... }  /  バッチ: { "AAPL": {...}, "7203.T": {...} }
//
// 取得戦略（Yahoo Finance v7 quote は認証必須で使用不可）:
//   日本株/投信: Yahoo!ファイナンス日本版（finance.yahoo.co.jp）から日本語名・基準価額を取得
//   米国株:     Yahoo Finance v8/chart（名前）+ v10/quoteSummary or Finnhub（ファンダ）
//   セクター/業種/ファンダ: v10/quoteSummary（取れれば）

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const single = (url.searchParams.get('symbol') || '').trim();
  const multi = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
  const finnhubKey = context.env?.FINNHUB_API_KEY;
  // names=1: 日本語名のみ軽量取得（1銘柄1リクエスト）。マーケットランキングの米株名を日本語化する用途。
  const namesOnly = url.searchParams.get('names') === '1';
  // debug=<symbol>: 時価総額/売買代金が取れない原因を切り分けるため、各取得元の生の状況を返す
  const dbg = (url.searchParams.get('debug') || '').trim();
  if (dbg) { try { return json(await fetchInfoDebug(dbg, finnhubKey)); } catch (e) { return json({ error: String(e?.message || e) }, 500); } }

  if (single) {
    try { return json(namesOnly ? await fetchNameOnly(single) : await fetchInfo(single, finnhubKey)); }
    catch (e) { return json({ error: String(e?.message || e) }, 500); }
  }
  if (multi.length) {
    const out = {};
    await Promise.all(multi.map(async (sym) => {
      try { out[sym] = namesOnly ? await fetchNameOnly(sym) : await fetchInfo(sym, finnhubKey); }
      catch (e) { out[sym] = { error: String(e?.message || e) }; }
    }));
    return json(out);
  }
  return json({ error: 'symbol または symbols パラメータが必要です' }, 400);
}

function symbolType(sym) {
  if (sym.endsWith('.T') && /^[0-9A-Z]{8}\.T$/.test(sym)) return 'fund';
  if (sym.endsWith('.T')) return 'jp';
  return 'us';
}

async function fetchInfo(symbol, finnhubKey) {
  const type = symbolType(symbol);
  if (type === 'fund') return fetchFundInfo(symbol);
  if (type === 'jp')   return fetchJpInfo(symbol);
  return fetchUsInfo(symbol, finnhubKey);
}

// 診断: 時価総額/売買代金(出来高)が取れない原因を各取得元ごとに可視化する。
// 本番で /api/info?debug=7203.T や ?debug=AAPL を開いて結果を確認する用途。
async function fetchInfoDebug(symbol, finnhubKey) {
  const type = symbolType(symbol);
  const out = { symbol, type, finnhubKeyPresent: !!finnhubKey, result: null, diag: {} };
  out.result = await fetchInfo(symbol, finnhubKey).catch(e => ({ error: String(e?.message || e) }));
  // chart（出来高の元）
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' } });
    out.diag.chart = { status: res.status };
    if (res.ok) {
      const r = (await res.json())?.chart?.result?.[0];
      const volArr = r?.indicators?.quote?.[0]?.volume || [];
      let lastVol = null; for (let i = volArr.length - 1; i >= 0; i--) if (typeof volArr[i] === 'number') { lastVol = volArr[i]; break; }
      out.diag.chart.regularMarketVolume = r?.meta?.regularMarketVolume ?? null;
      out.diag.chart.volumeArrayLast = lastVol;
      out.diag.chart.metaKeys = Object.keys(r?.meta || {});
    }
  } catch (e) { out.diag.chart = { error: String(e?.message || e) }; }
  // quoteSummary（時価総額の本来の元・ブロックされている想定）
  try {
    const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics`;
    const res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' } });
    out.diag.quoteSummary = { status: res.status, ok: res.ok };
    if (res.ok) { const d = await res.json().catch(() => null); out.diag.quoteSummary.hasResult = !!d?.quoteSummary?.result; out.diag.quoteSummary.error = d?.quoteSummary?.error || null; }
  } catch (e) { out.diag.quoteSummary = { error: String(e?.message || e) }; }
  if (type === 'jp') {
    // 日本版ページ（時価総額のスクレイプ元）
    try {
      const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
      out.diag.jpPage = { status: res.status };
      if (res.ok) {
        const html = await res.text();
        out.diag.jpPage.htmlLen = html.length;
        out.diag.jpPage.marketCapExtracted = extractJpMarketCap(html);
        out.diag.jpPage.foundLabel = html.indexOf('時価総額') >= 0;
        // タグ除去したラベル直後テキスト（値の位置・形式を確認する用）
        out.diag.jpPage.cleanText = jpLabelText(html, '時価総額', 600);
      }
    } catch (e) { out.diag.jpPage = { error: String(e?.message || e) }; }
  } else if (type === 'us' && finnhubKey) {
    // Finnhub metric（米株 時価総額）＋計上通貨（外国ADR判定）
    const [m, prof] = await Promise.all([
      fetchFinnhubMetric(symbol, finnhubKey).catch(() => null),
      fetchFinnhubProfile(symbol, finnhubKey).catch(() => null),
    ]);
    const cur = prof?.currency || null;
    out.diag.finnhub = { marketCap: m?.marketCap ?? null, pbr: m?.pbr ?? null, currency: cur, industry: prof?.industry ?? null, foreign: !!(cur && cur !== 'USD') };
  }
  return out;
}

// ---------- 日本株 ----------
async function fetchJpInfo(symbol) {
  // 日本語名・時価総額・参考指標(PER/PBR/EPS/配当利回り/業種)は Yahoo!ファイナンス日本版（同一ページ）から取得。
  // quoteSummary は日本株でブロックされがちなので、参考指標ページスクレイプを主経路にする（取れれば quoteSummary を優先）。
  // 信用倍率は信用残時系列ページ（週次更新）から最新＋前週分を取得。
  const [jpq, chart, summary, margin] = await Promise.all([
    fetchYahooJpQuote(symbol).catch(() => null),
    fetchChartMeta(symbol).catch(() => null),
    fetchQuoteSummary(symbol).catch(() => null),
    fetchJpMargin(symbol).catch(() => null),
  ]);
  return {
    name:      cleanName(jpq?.name) || cleanName(chart?.name) || null,
    sector:    summary?.sector || null,
    industry:  summary?.industry || jpq?.industry || null, // 日本版ページの業種（食料品 等）で補完
    marketCap: summary?.marketCap ?? jpq?.marketCap ?? null, // quoteSummaryがブロックされる日本株は日本版ページの時価総額を使用
    per:       summary?.per ?? jpq?.per ?? null,
    pbr:       summary?.pbr ?? jpq?.pbr ?? null,
    eps:       summary?.eps ?? jpq?.eps ?? null,
    dividend:  summary?.dividend ?? null,
    divYield:  jpq?.divYield ?? null, // 日本版ページの配当利回り(%)。divYieldはこれを優先（per-share未取得でも表示可）
    sharesOut: summary?.sharesOut ?? null,
    volume:    chart?.volume ?? null,   // 当日出来高（売買代金=現在値×出来高 の算出用）
    currency:  chart?.currency || 'JPY',
    quoteType: chart?.instrumentType || null, // EQUITY/ETF/MUTUALFUND（詳細種別の判定に使用）
    // 信用倍率（日本株のみ・週次）。最新＋前週分。
    marginRatio:     margin?.marginRatio ?? null,
    marginDate:      margin?.marginDate ?? null,
    marginRatioPrev: margin?.marginRatioPrev ?? null,
    marginDatePrev:  margin?.marginDatePrev ?? null,
  };
}

// 銘柄名から法人格表記のみを省略（株式会社/(株)/㈱ / Inc. / Corporation / Co., Ltd. 等）
// Group/Holdings/Class などは社名の一部のことが多いので残す
function cleanName(name) {
  if (!name) return null;
  const orig = String(name).trim();
  let s = orig;
  // 日本語: 「株式会社」「(株)」「（株）」「㈱」を除去
  s = s.replace(/(株式会社|\(株\)|（株）|㈱)/g, '');
  // 英語の法人格サフィックスを末尾から最大2回除去（"Co., Ltd." 等の連結対応）
  const EN = /[,，]?\s*(Incorporated|Inc|Corporation|Corp|Company|Co|Limited|Ltd|P\.?L\.?C|LLC|N\.?V|S\.?A|A\.?G)\.?$/i;
  s = s.replace(EN, '').replace(EN, '');
  s = s.replace(/[\s,，・]+$/, '').trim();
  return s || orig;
}

// 日本語名のみ取得（1リクエスト）。Yahoo!ファイナンス日本版→無ければchart英語名。
async function fetchNameOnly(symbol) {
  const jp = await fetchYahooJpName(symbol).catch(() => null);
  let name = cleanName(jp);
  if (!name) { const c = await fetchChartMeta(symbol).catch(() => null); name = cleanName(c?.name) || null; }
  return { name };
}

// ---------- 米国株 ----------
async function fetchUsInfo(symbol, finnhubKey) {
  // 日本語名は Yahoo!ファイナンス日本版から（例: AAPL→アップル）、無ければ英語名(chart)
  const [jpName, chart, summary] = await Promise.all([
    fetchYahooJpName(symbol).catch(() => null),
    fetchChartMeta(symbol).catch(() => null),
    fetchQuoteSummary(symbol).catch(() => null),
  ]);
  let fh = null, fhProfile = null;
  // Finnhubは「ファンダ未取得 or 業種未取得」のとき取得（業種/通貨は profile2、PER/PBR等は metric）
  if (finnhubKey && (!summary || summary.per == null || !summary.industry)) {
    [fh, fhProfile] = await Promise.all([
      fetchFinnhubMetric(symbol, finnhubKey).catch(() => null),
      fetchFinnhubProfile(symbol, finnhubKey).catch(() => null),
    ]);
  }
  const fhCur = fhProfile?.currency || null;
  // 外国ADR（TSM等）はFinnhubの時価総額・配当が現地通貨建て（TWD等）でドルと食い違うため、
  // 計上通貨がUSD以外なら時価総額・配当は出さない（誤った数値を表示しない）。為替換算は行わない。
  const foreign = !!(fhCur && fhCur !== 'USD');
  return {
    name:      cleanName(jpName) || cleanName(chart?.name) || null,
    sector:    summary?.sector || null,
    industry:  summary?.industry || fhProfile?.industry || null, // FinnhubのfinnhubIndustryで補完
    marketCap: summary?.marketCap ?? (foreign ? null : fh?.marketCap) ?? null,
    per:       summary?.per ?? fh?.per ?? null,
    pbr:       summary?.pbr ?? (foreign ? null : fh?.pbr) ?? null,
    eps:       summary?.eps ?? fh?.eps ?? null,
    dividend:  summary?.dividend ?? (foreign ? null : fh?.dividend) ?? null,
    sharesOut: summary?.sharesOut ?? null,
    volume:    chart?.volume ?? null,   // 当日出来高（売買代金算出用・Finnhub利用時もYahoo chartから取得）
    currency:  chart?.currency || 'USD',
    quoteType: chart?.instrumentType || null, // EQUITY/ETF/MUTUALFUND（詳細種別の判定に使用）
  };
}

// ---------- 投資信託 ----------
async function fetchFundInfo(symbol) {
  const code = symbol.replace(/\.T$/, '');
  const d = await fetchYahooJpFund(code).catch(() => null);
  return {
    name:     d?.name || null,
    sector:   null, industry: null, marketCap: null,
    per: null, eps: null, dividend: null,
    currency: 'JPY',
    quoteType: 'MUTUALFUND',
    nav:      d?.nav ?? null, // 基準価額
  };
}

// ---------- 取得ヘルパー ----------
async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Yahoo!ファイナンス日本版（株式）から日本語名＋時価総額を1回の取得で得る。
// 時価総額は quoteSummary がブロックされる日本株の代替取得元（同ページに「参考指標」として記載）。
async function fetchYahooJpQuote(symbol) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return {
    name: extractJpName(html),
    marketCap: extractJpMarketCap(html),
    per:      jpRefMetric(html, 'PER'),
    pbr:      jpRefMetric(html, 'PBR'),
    eps:      jpRefMetric(html, 'EPS'),
    divYield: jpRefMetric(html, '配当利回り'),
    industry: extractJpIndustry(html),
  };
}
// 後方互換: 名前のみ必要な呼び出し用
async function fetchYahooJpName(symbol) { const q = await fetchYahooJpQuote(symbol); return q ? q.name : null; }

// 日本版ページ「参考指標」から指標値を抽出。各指標は _DataListItem（名称spanの直後の dd に StyledNumber__value）。
// クラス名のハッシュは変わり得るので、名称spanの接頭辞だけで緩く一致させ、直後の最初の数値を拾う。
function jpRefMetric(html, label) {
  const re = new RegExp('_DataListItem__name[^>]*>' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '<');
  const m = re.exec(html);
  if (!m) return null;
  const after = html.slice(m.index, m.index + 1400);
  const vm = after.match(/_StyledNumber__value[^>]*>([\d.,]+)</);
  if (!vm) return null;
  const v = parseFloat(vm[1].replace(/,/g, ''));
  return isFinite(v) ? v : null;
}
// 日本版ページ上部の業種（例: 食料品）。_CommonPriceBoard__industryName の最初の非空テキスト。
function extractJpIndustry(html) {
  const m = html.match(/_CommonPriceBoard__industryName[^>]*>([^<]+)</);
  const v = m ? m[1].trim() : '';
  return v || null;
}

// 信用残時系列ページ（週次更新）から信用倍率の最新＋前週分を取得。
// 表: 日付/売残/買残/売残増減/買残増減/信用倍率（各値は _StyledNumber__value）。
async function fetchJpMargin(symbol) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(symbol)}/history?styl=margin`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 21600, cacheEverything: true }, // 週次データなので6時間キャッシュ（再取得負荷を抑える）
  });
  if (!res.ok) return null;
  const html = await res.text();
  return extractJpMargin(html);
}
function extractJpMargin(html) {
  const ti = html.indexOf('信用残時系列のテーブル');
  if (ti < 0) return null;
  const tbl = html.slice(ti, ti + 12000); // 先頭数行で十分（最新＋前週分）
  const rowRe = /<tr[^>]*>\s*<th[^>]*>([^<]+)<\/th>([\s\S]*?)<\/tr>/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(tbl)) !== null && rows.length < 2) {
    const vals = [...m[2].matchAll(/_StyledNumber__value[^>]*>([^<]+)</g)].map(x => x[1].replace(/,/g, ''));
    if (vals.length < 5) continue; // ヘッダ行（StyledNumber無し）はスキップ
    const ratio = parseFloat(vals[4]); // 5列目=信用倍率
    if (!isFinite(ratio)) continue;
    rows.push({ date: normJpDate(m[1].trim()), ratio });
  }
  if (!rows.length) return null;
  return {
    marginRatio:     rows[0].ratio,
    marginDate:      rows[0].date,
    marginRatioPrev: rows[1]?.ratio ?? null,
    marginDatePrev:  rows[1]?.date ?? null,
  };
}
// "2026/6/5" → "2026-06-05"
function normJpDate(s) {
  const m = String(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return s;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

// 日本版ページから「時価総額」を抽出し百万円単位で返す（列の単位＝百万に合わせる）。取れなければ null。
// 新デザイン（_DataListItem_ 等）で値が複数要素に分かれ、ラベルからやや離れているため、
// ラベル以降を広めに取り→HTMLタグを除去→最初の「数値(＋単位)円」を拾う方式にする。
function extractJpMarketCap(html) {
  const text = jpLabelText(html, '時価総額', 3000);
  if (text == null) return null;
  const m = text.match(/([\d][\d,]*(?:\.\d+)?)\s*(兆|億|百万|千)?\s*円/);
  if (!m) return null;
  const yen = scaleJpUnit(parseFloat(m[1].replace(/,/g, '')), m[2] || '');
  return (yen != null && isFinite(yen)) ? Math.round(yen / 1e6) : null; // 円 → 百万円
}
// ラベル直後のHTMLをタグ除去したテキストにして返す（値抽出・診断用）
function jpLabelText(html, label, span) {
  const i = html.indexOf(label);
  if (i < 0) return null;
  return html.slice(i, i + (span || 2000)).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}
function scaleJpUnit(n, unit) { if (!isFinite(n)) return null; if (/兆/.test(unit)) return n * 1e12; if (/億/.test(unit)) return n * 1e8; if (/百万/.test(unit)) return n * 1e6; if (/千/.test(unit)) return n * 1e3; return n; }

// Yahoo!ファイナンス日本版（投信）から名称・基準価額を取得
async function fetchYahooJpFund(code) {
  const res = await fetchWithTimeout(`https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const name = extractJpName(html);
  // 基準価額: og:description や本文から「基準価額 12,345円」を拾う（best-effort）
  let nav = null;
  const m = html.match(/基準価額[^0-9]{0,8}([0-9,]+)\s*円/);
  if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (isFinite(v)) nav = v; }
  return { name, nav };
}

// HTMLの<title>等から銘柄名を抽出（「トヨタ自動車(株)【7203】…」→「トヨタ自動車(株)」）
function extractJpName(html) {
  // og:title 優先
  let m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  let title = m ? m[1] : null;
  if (!title) {
    m = html.match(/<title>([^<]+)<\/title>/i);
    title = m ? m[1] : null;
  }
  if (!title) return null;
  // 【コード】や ：、- 以降を除去
  let name = title.split(/[【\[]/)[0].split(/[：:]/)[0].split(' - ')[0].trim();
  return name || null;
}

async function fetchChartMeta(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta) throw new Error('chart データなし');
  // 出来高: meta.regularMarketVolume が無い場合があるので出来高配列の最後の有効値で補完
  const volArr = r?.indicators?.quote?.[0]?.volume || [];
  let lastVol = null; for (let i = volArr.length - 1; i >= 0; i--) { if (typeof volArr[i] === 'number') { lastVol = volArr[i]; break; } }
  return { name: meta.longName || meta.shortName || null, currency: meta.currency || null, instrumentType: meta.instrumentType || null, volume: num(meta.regularMarketVolume) ?? lastVol };
}

async function fetchQuoteSummary(symbol) {
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=assetProfile,summaryDetail,defaultKeyStatistics`;
  let res;
  try { res = await fetchWithTimeout(u, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data?.quoteSummary?.error) return null;
  const r = data?.quoteSummary?.result?.[0];
  if (!r) return null;
  const ap = r.assetProfile || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {};
  return {
    sector: ap.sector || null,
    industry: ap.industry || null,
    marketCap: n(sd.marketCap) ? Math.round(sd.marketCap.raw / 1e6) : (n(ks.marketCap) ? Math.round(ks.marketCap.raw / 1e6) : null),
    per: n(sd.trailingPE) ? sd.trailingPE.raw : (n(ks.trailingPE) ? ks.trailingPE.raw : null),
    pbr: n(ks.priceToBook) ? ks.priceToBook.raw : (n(sd.priceToBook) ? sd.priceToBook.raw : null),
    eps: n(ks.trailingEps) ? ks.trailingEps.raw : null,
    dividend: n(sd.dividendRate) ? sd.dividendRate.raw : null,
    sharesOut: n(ks.sharesOutstanding) ? ks.sharesOutstanding.raw : null, // 発行済株式数（時価総額=株価×これ で随時算出）
  };
}

async function fetchFinnhubMetric(symbol, token) {
  let res;
  // エッジキャッシュ1h: 再取得時のFinnhub呼び出しを減らしレート制限を回避（時価総額・PER等は日中ほぼ不変）
  try { res = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 3600, cacheEverything: true } }); }
  catch { return null; }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const m = data?.metric || {};
  return {
    marketCap: num(m.marketCapitalization),
    per: num(m['peBasicExclExtraTTM']) || num(m['peTTM']),
    pbr: num(m['pbAnnual']) || num(m['pbQuarterly']) || num(m['pb']),
    eps: num(m['epsBasicExclExtraItemsTTM']),
    dividend: num(m['dividendPerShareAnnual']),
  };
}

// Finnhub プロフィールから計上通貨（外国ADR判定用）＋業種(finnhubIndustry)を取得。
// 不変に近いので7日キャッシュ＝追加負荷ほぼ無し。業種は米株セクター/業種が未取得時の補完に使う。
async function fetchFinnhubProfile(symbol, token) {
  let res;
  try { res = await fetchWithTimeout(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${token}`, { headers: { 'User-Agent': 'securities-manager/1.0' }, cf: { cacheTtl: 604800, cacheEverything: true } }); }
  catch { return null; }
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d) return null;
  return { currency: d.currency || null, industry: d.finnhubIndustry || null };
}

function n(obj) { return obj && typeof obj.raw === 'number' && isFinite(obj.raw); }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}
