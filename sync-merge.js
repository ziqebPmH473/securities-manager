// 証券ツールのデータ（store.data + _colPrefs のバンドル）を 3-way マージする純ロジック。
// base=前回同期時点 / local=自端末 / remote=Drive。aoiro-accounting の mergeThreeWay を、
// 証券ツールの「レコード配列 / キャッシュ(オブジェクト) / 単一設定 / スカラ」の混在に合わせて拡張。
// プレーンスクリプト（globalThis.SyncMerge）として読み込み、app.js から使う。

(function () {
  // ストアごとのマージ規則。
  //  records: 配列。自然キーで一致判定し 3-way（追加は両方残す/削除も伝播/編集は削除優先/両在は updatedAt 新しい方）
  //  map    : オブジェクト{key:val}。キー単位で 3-way。両在時は newerFn(l,r) が真なら remote、無ければ local
  //  single : 単一値/設定。base から変わった側を採用、両方変わったら local 優先
  //  max    : 文字列(日時/日付)。大きい方（=新しい方）
  //  maxNum : 数値（seq 等）。大きい方（ID再利用を防ぐ）
  const byFetchedAt = (l, r) => ((r && r.fetchedAt) || '') > ((l && l.fetchedAt) || '');
  const SCHEMA = {
    securities:      ['records', (s) => `${s.market}:${String(s.ticker || '').toUpperCase()}`],
    holdings:        ['records', (h) => `${h.securityId}|${h.broker}|${h.accountType}`],
    transactions:    ['records', (t) => `t:${t.id}`],
    rules:           ['records', (r) => `r:${r.id}`],
    categories:      ['records', (c) => `c:${c.category}`],
    amountHistory:   ['records', (r) => `ah:${r.id}`],
    amountSnapshots: ['records', (r) => `as:${r.id}`],
    importHistory:   ['records', (r) => `ih:${r.id}`],
    importFormats:   ['records', (f) => f && f.name != null ? `if:n:${f.name}` : `if:${JSON.stringify(f)}`],
    prices:          ['map', byFetchedAt],
    meta:            ['map', null],
    indices:         ['map', null],
    importMappings:  ['map', null],
    importAliases:   ['map', null],
    fx:              ['single'],
    settings:        ['single'],
    _colPrefs:       ['single'],
    lastPriceUpdate: ['max'],
    lastInfoDate:    ['max'],
    lastHighsDate:   ['max'],
    lastPriceSource: ['single'],
    seq:             ['maxNum'],
  };

  const tsOf = (r) => (r && typeof r.updatedAt === 'string') ? r.updatedAt : '';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changedFromBase = (rec, base) => base === undefined ? true : !same(rec, base);

  function mergeRecords3way(base, local, remote, keyFn) {
    const idx = (arr) => { const m = new Map(); for (const it of arr || []) m.set(keyFn(it), it); return m; };
    const B = idx(base), L = idx(local), R = idx(remote);
    const out = [];
    for (const k of new Set([...B.keys(), ...L.keys(), ...R.keys()])) {
      const b = B.get(k), l = L.get(k), r = R.get(k);
      const lP = l !== undefined, rP = r !== undefined, bP = b !== undefined;
      if (lP && rP) {
        const a = tsOf(l), c = tsOf(r);
        out.push(a && c && c > a ? r : l);            // 両在→updatedAt新しい方（無ければlocal）
      } else if (lP && !rP) {
        if (bP && !changedFromBase(l, b)) { /* remoteで削除＆local未変更→削除反映 */ } else out.push(l);
      } else if (!lP && rP) {
        if (bP && !changedFromBase(r, b)) { /* localで削除＆remote未変更→削除反映 */ } else out.push(r);
      }
    }
    return out;
  }

  function mergeMap3way(base, local, remote, newerFn) {
    base = base || {}; local = local || {}; remote = remote || {};
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const b = base[k], l = local[k], r = remote[k];
      const lP = l !== undefined, rP = r !== undefined, bP = b !== undefined;
      if (lP && rP) {
        out[k] = (newerFn && newerFn(l, r)) ? r : l;
      } else if (lP && !rP) {
        if (bP && same(l, b)) { /* remoteで削除＆local未変更→削除反映 */ } else out[k] = l;
      } else if (!lP && rP) {
        if (bP && same(r, b)) { /* localで削除＆remote未変更→削除反映 */ } else out[k] = r;
      }
    }
    return out;
  }

  function mergeSingle3way(base, local, remote) {
    const bj = JSON.stringify(base), lj = JSON.stringify(local), rj = JSON.stringify(remote);
    if (lj === bj) return remote;   // localが未変更→remoteを採用
    if (rj === bj) return local;    // remoteが未変更→localを採用
    return local;                   // 両方変わった→local優先
  }
  const mergeMax = (a, b) => (a == null) ? b : (b == null) ? a : (b > a ? b : a);
  const mergeMaxNum = (a, b) => Math.max(a || 0, b || 0);

  // base/local/remote の3バンドルをマージして1つに。
  function mergeBundle(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    const out = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const rule = SCHEMA[key] || ['single'];
      if (rule[0] === 'records') out[key] = mergeRecords3way(base[key], local[key], remote[key], rule[1]);
      else if (rule[0] === 'map') out[key] = mergeMap3way(base[key], local[key], remote[key], rule[1]);
      else if (rule[0] === 'max') out[key] = mergeMax(local[key], remote[key]);
      else if (rule[0] === 'maxNum') out[key] = mergeMaxNum(local[key], remote[key]);
      else out[key] = mergeSingle3way(base[key], local[key], remote[key]);
    }
    return out;
  }

  const api = { mergeBundle, mergeRecords3way, mergeMap3way, mergeSingle3way, mergeMax, mergeMaxNum, SCHEMA };
  if (typeof globalThis !== 'undefined') globalThis.SyncMerge = api;
})();
