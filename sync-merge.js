// 証券ツールのデータ（store.data + _colPrefs のバンドル）を 3-way マージする純ロジック。
// base=前回同期時点 / local=自端末 / remote=Drive。aoiro-accounting の mergeThreeWay を、
// 証券ツールの「レコード配列 / キャッシュ(オブジェクト) / 単一設定 / スカラ」の混在に合わせて拡張。
// プレーンスクリプト（globalThis.SyncMerge）として読み込み、app.js から使う。

(function () {
  // ストアごとのマージ規則。
  //  records: 配列。自然キーで一致判定し 3-way（追加は両方残す/削除も伝播/編集は削除優先/両在は updatedAt 新しい方）
  //  map    : オブジェクト{key:val}。キー単位で 3-way。両在時は newerFn(l,r) が真なら remote、無ければ local
  //  single : 単一値/設定。base から変わった側を採用、両方変わったら local 優先
  //  singleTs: single だが両方変わった時は _updatedAt の新しい方を採用（無ければ local）
  //  colprefs: 列設定。市場ごとに分割し、編集時刻(_ts[market])の新しい方を採用（受動マイグレーションで上書きしない）
  //  max    : 文字列(日時/日付)。大きい方（=新しい方）
  //  maxNum : 数値（seq 等）。大きい方（ID再利用を防ぐ）
  const byFetchedAt = (l, r) => ((r && r.fetchedAt) || '') > ((l && l.fetchedAt) || '');
  // meta は両端末に同キーがあると従来 local 固定で上書きしていた。updatedAt の新しい方を採る。
  const byUpdatedAt = (l, r) => ((r && r.updatedAt) || '') > ((l && l.updatedAt) || '');
  const SCHEMA = {
    securities:      ['records', (s) => `${s.market}:${String(s.ticker || '').toUpperCase()}`],
    holdings:        ['records', (h) => `${h.securityId}|${h.broker}|${h.accountType}`],
    transactions:    ['records', (t) => `t:${t.id}`],
    rules:           ['records', (r) => `r:${r.id}`],
    categories:      ['records', (c) => `c:${c.category}`],
    amountHistory:   ['records', (r) => `ah:${r.id}`],
    amountSnapshots: ['records', (r) => `as:${r.id}`],
    analyses:        ['records', (r) => `an:${r.securityId}|${r.analysisDate}`],
    importHistory:   ['records', (r) => `ih:${r.id}`],
    importFormats:   ['records', (f) => f && f.name != null ? `if:n:${f.name}` : `if:${JSON.stringify(f)}`],
    prices:          ['map', byFetchedAt],
    meta:            ['map', byUpdatedAt],
    indices:         ['map', null],
    importMappings:  ['map', null],
    importAliases:   ['map', null],
    fx:              ['single'],
    settings:        ['singleTs'],
    _colPrefs:       ['colprefs'],
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
    // 配列キーが「存在して空/欠けている（=削除の意思表示）」のか「そもそも未提供（undefined＝情報なし）」
    // のかを区別する。未提供側を「全削除」と解釈すると、Drive のファイルにキャッシュキーが欠落した
    // だけで全レコードが消える（rules欠落→空→クラッシュの起点）。未提供側からは削除を伝播しない。
    const localGiven = Array.isArray(local), remoteGiven = Array.isArray(remote);
    const out = [];
    for (const k of new Set([...B.keys(), ...L.keys(), ...R.keys()])) {
      const b = B.get(k), l = L.get(k), r = R.get(k);
      const lP = l !== undefined, rP = r !== undefined, bP = b !== undefined;
      if (lP && rP) {
        const a = tsOf(l), c = tsOf(r);
        out.push(a && c && c > a ? r : l);            // 両在→updatedAt新しい方（無ければlocal）
      } else if (lP && !rP) {
        // remote が配列として提供されている時だけ「remoteで削除」とみなす（未提供なら local を保持）
        if (remoteGiven && bP && !changedFromBase(l, b)) { /* remoteで削除＆local未変更→削除反映 */ } else out.push(l);
      } else if (!lP && rP) {
        // local が配列として提供されている時だけ「localで削除」とみなす（未提供なら remote を保持）
        if (localGiven && bP && !changedFromBase(r, b)) { /* localで削除＆remote未変更→削除反映 */ } else out.push(r);
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
  // single だが、両方変わった時は _updatedAt の新しい方を採る（無ければ local）。設定(settings)用。
  function mergeSingleTs3way(base, local, remote) {
    const bj = JSON.stringify(base), lj = JSON.stringify(local), rj = JSON.stringify(remote);
    if (lj === bj) return remote;
    if (rj === bj) return local;
    const lt = (local && local._updatedAt) || '', rt = (remote && remote._updatedAt) || '';
    return (rt > lt) ? remote : local;
  }
  const mergeMax = (a, b) => (a == null) ? b : (b == null) ? a : (b > a ? b : a);
  const mergeMaxNum = (a, b) => Math.max(a || 0, b || 0);

  // 列設定(_colPrefs)を市場ごとに3-wayマージ。各市場は { US:[...], JP:[...], ... } に加え
  // 編集時刻 _ts:{US:iso,...} を持つ。_ts はユーザーが実際に列を編集した時だけ更新される（画面表示に
  // 伴う reconcile/reset では更新しない）ので、「別端末でタブを開いただけ」の受動変化が本物の編集を
  // 上書きしない。両在で内容が違う時は _ts の新しい方を採用。_ts が無ければ base 基準(single)に退避。
  function mergeColPrefs3way(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    const bts = base._ts || {}, lts = local._ts || {}, rts = remote._ts || {};
    const out = {}, outTs = {};
    const markets = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)].filter(k => k !== '_ts'));
    for (const m of markets) {
      const b = base[m], l = local[m], r = remote[m];
      const lP = l !== undefined, rP = r !== undefined;
      if (lP && rP) {
        if (same(l, r)) out[m] = l;
        else {
          const lt = lts[m] || '', rt = rts[m] || '';
          if (lt || rt) out[m] = (rt > lt) ? r : l;       // 編集時刻の新しい方
          else out[m] = mergeSingle3way(b, l, r);          // 時刻が無い（受動変化のみ）→base基準
        }
      } else if (lP) out[m] = l;
      else if (rP) out[m] = r;                             // 列設定は削除しない（片側のみ＝その側を採用）
      const t = mergeMax(lts[m], rts[m]);
      if (t) outTs[m] = t;                                 // 時刻は市場ごとに新しい方を保持
    }
    if (Object.keys(outTs).length) out._ts = outTs;
    return out;
  }

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
      else if (rule[0] === 'singleTs') out[key] = mergeSingleTs3way(base[key], local[key], remote[key]);
      else if (rule[0] === 'colprefs') out[key] = mergeColPrefs3way(base[key], local[key], remote[key]);
      else out[key] = mergeSingle3way(base[key], local[key], remote[key]);
    }
    return out;
  }

  const api = { mergeBundle, mergeRecords3way, mergeMap3way, mergeSingle3way, mergeSingleTs3way, mergeColPrefs3way, mergeMax, mergeMaxNum, SCHEMA };
  if (typeof globalThis !== 'undefined') globalThis.SyncMerge = api;
})();
