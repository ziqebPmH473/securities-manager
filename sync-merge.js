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
  // meta(銘柄名)専用: 「名称あり」を「名称なし」より常に優先する。日本株は名称取得に失敗しても
  // currency等が入るため「名称なし・新updatedAt」エントリが生まれ得て、updatedAt比較だけだと別端末の
  // 正しい名称を上書きしてしまう（＝銘柄名が証券コードに戻る）。名称の有無を最優先し、同条件なら updatedAt。
  const metaNewer = (l, r) => {
    const ln = !!(l && l.name), rn = !!(r && r.name);
    if (ln !== rn) return rn;                 // remoteのみ名称あり→remote採用 / localのみ名称あり→local維持
    return ((r && r.updatedAt) || '') > ((l && l.updatedAt) || '');
  };
  // mktRanking はキャッシュ map（key→{items,at}）。両在時は取得時刻 at の新しい方を採る。
  const byAt = (l, r) => ((r && r.at) || '') > ((l && l.at) || '');
  const SCHEMA = {
    securities:      ['records', (s) => `${s.market}:${String(s.ticker || '').toUpperCase()}`],
    holdings:        ['records', (h) => `${h.securityId}|${h.broker}|${h.accountType}`],
    transactions:    ['records', (t) => `t:${t.id}`],
    rules:           ['records', (r) => `r:${r.id}`],
    categories:      ['records', (c) => `c:${c.category}`],
    investCategories: ['records', (c) => `ic:${c.name}`], // 投資カテゴリ（分析枠ラベル）マスタ。名前キーで3-wayマージ（updatedAt タイブレーク）
    labelDefs:       ['records', (c) => `ld:${c.name}`],   // 銘柄ラベル（複数タグ）マスタ。名前キーで3-wayマージ
    // マスタ系（背景色ルール/格付け色/フィルタプリセット）。id等で一致＋updatedAtの新しい方。
    // 削除は配列除去ではなくトンボストン（deleted:true＋新updatedAt）で表現するので、
    // 「新しい削除」が「古い設定」や「別端末の再シードした既定」に勝てる（＝削除も同期で保持される）。
    cfRules:         ['records', (r) => `cf:${r.id}`],
    grades:          ['records', (r) => `g:${r.grade}`],
    _filterPresets:  ['records', (r) => `fp:${r.id}`],
    mktRanking:      ['map', byAt],
    earnings:        ['map', byAt],   // 決算日キャッシュ priceKey→{prev,next,...,at}。取得時刻 at の新しい方
    amountHistory:   ['records', (r) => `ah:${r.id}`],
    amountSnapshots: ['records', (r) => `as:${r.id}`],
    analyses:        ['records', (r) => `an:${r.securityId}|${r.analysisDate}`],
    importHistory:   ['records', (r) => `ih:${r.id}`],
    importFormats:   ['records', (f) => f && f.name != null ? `if:n:${f.name}` : `if:${JSON.stringify(f)}`],
    prices:          ['map', byFetchedAt],
    meta:            ['map', metaNewer],
    techAnalysis:    ['map', byUpdatedAt],   // テクニカル分析結果。priceKey単位で3-way（_updatedAtの新しい方）
    indices:         ['map', null],
    importMappings:  ['map', null],
    importAliases:   ['map', null],
    newsRead:        ['map', null],   // ニュース既読（記事リンク→既読日時ISO）。キー単位3-way・両在はlocal
    newsTags:        ['records', (t) => `ntag:${t.name}`], // ニュース注目タグ。名前キーで3-way（削除も伝播）
    newsHidden:      ['map', null],   // ニュース非表示（記事リンク→非表示日時ISO）。キー単位3-way・両在はlocal
    newsTrans:       ['map', null],   // ニュース翻訳キャッシュ（記事リンク→{t,d,at}）。キー単位3-way・両在はlocal
    newsPrefs:       ['singleTs'],    // ニュース表示設定（除外カテゴリ/開示種類）。両方編集時は _updatedAt の新しい方
    // 開示種別マスタ / YouTube購読チャンネル。以前は ['single'] だったが、既定値が自動シードされる
    // マスタなので「別端末で再シードされた既定値」が本物の登録内容を上書きして消える事故が起きた
    // （実際に登録済みのYouTubeチャンネルが消失）。行ごとの updatedAt ＋ 削除のトンボストン（deleted:true）で
    // 3-wayマージし、新しい更新・新しい削除が後勝ちするようにする（cfRules/grades と同じ方式）。
    discTypeDefs:    ['records', (d) => `dt:${d && d.name}`],
    ytChannels:      ['records', (c) => `yt:${c && c.id}`],
    ytSummaries:     ['map', null],   // 動画要約キャッシュ（videoId→{summary,at}）。キー単位3-way・両在はlocal
    listedMaster:    ['single'],      // 全上場銘柄マスタ（自動タグ用・配列）。一括取込なので base から変わった側を採用
    listedMasterInfo: ['single'],     // 上場マスタの取込メタ（日付・件数）。listedMasterと一緒に更新

    fx:              ['single'],
    settings:        ['singleTs'],
    // マトリックスのレンジ(順序つき配列)とレート設定は常に一括編集される。配列は _updatedAt を
    // 直接持てない（JSON化でドロップ）ため、matrixSettings._updatedAt を共通の編集時刻として両方の
    // タイブレークに使う（matrixBands は pairTs で matrixSettings の時刻を参照）。
    matrixBands:     ['pairTs', 'matrixSettings'],
    matrixSettings:  ['singleTs'],
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
        // 両在→updatedAt の新しい方。片方だけ updatedAt を持つ場合は「持つ方（=編集された方）」が勝つ
        // （'' < 実時刻）。両方無し/同値なら local 維持。これで「別端末の編集」が「自端末の再シードした
        // 既定（updatedAt無し）」に勝ち、背景色ルール等がデフォルトへ戻る不具合を防ぐ。
        out.push(c > a ? r : l);
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
  // singleTs と同じだが、タイブレークの _updatedAt を「別キーの値(lref/rref)」から読む。
  // 配列など _updatedAt を自身に持てない値を、一括編集される相方(matrixSettings)の時刻で判定する用途。
  function mergeSingleRefTs3way(base, local, remote, lref, rref) {
    const bj = JSON.stringify(base), lj = JSON.stringify(local), rj = JSON.stringify(remote);
    if (lj === bj) return remote;
    if (rj === bj) return local;
    const lt = (lref && lref._updatedAt) || '', rt = (rref && rref._updatedAt) || '';
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
      else if (rule[0] === 'pairTs') out[key] = mergeSingleRefTs3way(base[key], local[key], remote[key], local[rule[1]], remote[rule[1]]);
      else if (rule[0] === 'colprefs') out[key] = mergeColPrefs3way(base[key], local[key], remote[key]);
      else out[key] = mergeSingle3way(base[key], local[key], remote[key]);
    }
    return out;
  }

  const api = { mergeBundle, mergeRecords3way, mergeMap3way, mergeSingle3way, mergeSingleTs3way, mergeSingleRefTs3way, mergeColPrefs3way, mergeMax, mergeMaxNum, SCHEMA };
  if (typeof globalThis !== 'undefined') globalThis.SyncMerge = api;
})();
