// 干扰分析（C/I）服务（主进程）。
//
// 为什么整条引擎放主进程、渲染端只过 IPC 收发数字：
//   ① NGSO 时变扫描本就是重活（几十颗星 × 上万时刻），放渲染端会冻页面；
//   ② C/CCI 场图的逐波束值不能过 IPC（见 grd.js 的 sampleCci）；
//   ③ 平台既有规矩是「渲染端不直接 require core 的 CommonJS」——要么走 IPC，要么在
//      src/shared/ 手写 ESM 镜像。镜像要人肉同步，是已知的维护坑（见 adaptUnits.js 的头注），
//      而干扰引擎有 5 个模块、口径全靠 ITU 建议书钉死，绝不适合镜像。故一律走 IPC。
//
// 与雨衰计算器（rain:compute / rain:computeBatch / rain:sweep）同模式。

const I = require('../../packages/core/utils/interference/index.js');
const ngGeom = require('../../packages/core/utils/ngsoGeometry.js');

// CelesTrak 编目组的中文名（与 omm.js 的 GROUP_LABEL、星座页的 GROUPS 标签同源，改一处要同步）
const GROUP_LABEL = {
  starlink: 'Starlink', oneweb: 'OneWeb', kuiper: 'Kuiper', gps: 'GPS', beidou: '北斗',
  galileo: 'Galileo', qianfan: '千帆星座', guowang: '中国星网', geo: 'GEO 静止轨道',
  glonass: 'GLONASS', o3b: 'O3b', iridium: '铱星', globalstar: 'Globalstar',
  stations: '空间站', planet: 'Planet', spire: 'Spire', active: '全部在轨'
};
const GL = (k) => GROUP_LABEL[k] || k;

// omm：星历服务（主进程已持有各组 satrec），用于把「星座名」解析成 satrec 列表。
// customSats：自定义星历库（文件管理导入的 OMM/TLE，存 custom.json）。
// getCore：引擎实例的 getter，取 sgp4.omm2satrec 用（自定义记录要现建 satrec）。
module.exports = function createInterference(omm, customSats, getCore, grd) {

  // ---------------------------------------------------------------------------
  // 星座 key 的三类编码
  // ---------------------------------------------------------------------------
  //
  // 一个字符串走通下拉 / 面板持久化 / payload，不为多两类来源去改数据结构：
  //   'starlink'    → CelesTrak OMM 组（裸 key，与已存的旧面板态天然兼容）
  //   'custom:<id>' → 文件管理导入的自定义星历组（custom.json，记录就在本地）
  //   'sg:<id>'     → 星座页「卫星组管理器」建的组。该组只存 NORAD 号（见 useSatGroups.js），
  //                   成员由渲染端随 spec.satIds 带过来，在此从 active 全量编目 + 自定义星历解析回 satrec。
  //   'cc:<id>'     → 星座页 Walker 生成器建的「自定义星座」（useCustomConstellations.js，存渲染端
  //                   localStorage）。星是按参数合成的，没有 TLE：渲染端用 walker.js 展开成经典六根数
  //                   随 spec.sats 带过来（与星座3D 页 / NGSO 链路预算搜索池同一份 generateConstellation，
  //                   绝不在主进程另写一遍放置公式），在此按 type:'elements' 建 satrec。
  function parseKey(key) {
    const s = String(key || '');
    if (s.startsWith('custom:')) return { kind: 'custom', id: s.slice(7) };
    if (s.startsWith('sg:')) return { kind: 'satgroup', id: s.slice(3) };
    if (s.startsWith('cc:')) return { kind: 'ccustom', id: s.slice(3) };
    return { kind: 'omm', id: s };
  }

  /** OMM 记录数组 → [{id,name,rec}]。坏记录跳过（与 omm.satrecs 同口径）。 */
  function recsToSats(records) {
    const core = getCore && getCore();
    const sgp4 = core && core.sgp4;
    if (!sgp4) return [];
    const out = [];
    for (const r of (records || [])) {
      try { out.push({ id: String(r.noradId), name: r.name, rec: sgp4.omm2satrec(r) }); }
      catch (e) { /* 坏记录跳过 */ }
    }
    return out;
  }

  /** 自定义星历全库的 NORAD → 记录索引（卫星组成员可能是导入的星，不在 CelesTrak 编目里）。 */
  function customIndex() {
    const map = new Map();
    if (!customSats || !customSats.list) return map;
    try {
      for (const g of (customSats.list().groups || [])) {
        for (const r of (customSats.groupRecords(g.id) || [])) map.set(String(r.noradId), r);
      }
    } catch (e) { /* 无自定义库 */ }
    return map;
  }

  /**
   * 限量抽样：**等间隔取**而不是取前 N 条。
   *   名单按 NORAD 号排（≈ 发射批次），取前 N 条会拿到同一批、同几个轨道面的星，
   *   几何上完全不具代表性；等间隔跨越整份名单，轨道面分布接近原样。
   * ⚠️ 但抽样必然让**聚合干扰偏低**：只算了 1/K 的干扰源，C/I 会乐观约 10·lg(K) dB。
   *   这一项由调用方读 samplingFactor 后明确告警，绝不静默。
   */
  function applyLimit(sats, limit) {
    const total = sats.length;
    if (!(limit > 0) || total <= limit) return { sats, samplingFactor: 1, total };
    const step = total / limit;
    const picked = [];
    for (let i = 0; picked.length < limit && Math.floor(i * step) < total; i++) picked.push(sats[Math.floor(i * step)]);
    return { sats: picked, samplingFactor: total / picked.length, total };
  }

  // ---------------------------------------------------------------------------
  // 星座来源解析
  // ---------------------------------------------------------------------------
  //
  // 四种来源，覆盖「有真星历」与「只有设计参数」两类场景：
  //   group    —— 已载入主进程的 OMM 组 / 自定义星历组 / 我的卫星组（见 parseKey）。真星历，用于实测评估。
  //   elements —— 逐颗给经典六根数（星座页「自定义星座」由 walker.js 展开后带过来）。
  //   walker   —— 由 Walker 参数现造圆轨道星座。做方案比选时手上只有设计参数，没有 TLE。
  //   tle      —— 直接给两行根数。
  function resolveSats(spec) {
    if (!spec) return { sats: [], error: '未指定星座' };
    const src = spec.source || (spec.group ? 'group' : (spec.planes ? 'walker' : null));

    if (src === 'group') {
      const k = parseKey(spec.group);

      // ---- 自定义星历组：记录就在 custom.json 里，不经 omm，也无所谓「载入」----
      if (k.kind === 'custom') {
        const recs = (customSats && customSats.groupRecords) ? customSats.groupRecords(k.id) : null;
        if (!recs || !recs.length) return { sats: [], error: '自定义星历组已不存在（可能在文件管理里被删了）' };
        const sats = recsToSats(recs);
        if (!sats.length) return { sats: [], error: '自定义星历组内没有可用的卫星（记录全部 SGP4 校验失败）' };
        return applyLimit(sats, spec.limit);
      }

      // ---- 我的卫星组：组里只有 NORAD 号，从 active 全量编目 + 自定义星历解析回 satrec ----
      if (k.kind === 'satgroup') {
        const ids = (spec.satIds || []).map(String).filter(Boolean);
        if (!ids.length) return { sats: [], error: '卫星组是空的（在星座页往组里加几颗星）' };
        const pool = new Map();
        for (const s of ((omm && omm.peek) ? (omm.peek('active') || []) : [])) {
          const n = s.satrec && s.satrec.satnum;
          if (n != null) pool.set(String(n), s);
        }
        const cust = customIndex();
        const sats = [];
        let missing = 0;
        for (const id of ids) {
          const hit = pool.get(id);
          if (hit) { sats.push({ id, name: hit.name, rec: hit.satrec }); continue; }
          const rec = cust.get(id);
          if (rec) { const c = recsToSats([rec]); if (c.length) { sats.push(c[0]); continue; } }
          missing++;   // 编目里没有、自定义星历里也没有：退役星或编目号写错
        }
        if (!sats.length) return { sats: [], error: `卫星组里 ${ids.length} 颗星在全量编目与自定义星历里都找不到（可能已退役）` };
        const out = applyLimit(sats, spec.limit);
        if (missing) out.missing = missing;
        return out;
      }

      // ---- CelesTrak OMM 组 ----
      // 此处只 peek（同步）。真正的载入由调用方先 await ensureSatrecs() 完成——
      // omm.satrecs() 走 CSV 缓存 / 内置快照，是异步的。
      const list = (omm && omm.peek) ? omm.peek(k.id) : null;
      if (!list || !list.length) return { sats: [], error: `星座「${k.id}」星历不可用（本地无缓存且无内置快照）` };
      let use = list;
      if (Array.isArray(spec.noradIds) && spec.noradIds.length) {
        const want = new Set(spec.noradIds.map(String));
        use = list.filter((s) => want.has(String(s.satrec && s.satrec.satnum)));
      }
      return applyLimit(use.map((s) => ({ id: String(s.satrec && s.satrec.satnum), name: s.name, rec: s.satrec })), spec.limit);
    }

    // ---- 逐颗六根数：星座页「自定义星座」（合成星，无 TLE）----
    // 放置公式一概在渲染端的 walker.js 里算完，这里只把根数变成 satrec；epoch=场景历元，
    // 由渲染端按 resolveScenarioEpoch 透传，否则合成星在地固系的指向与星座3D 页对不上。
    if (src === 'elements') {
      const list = spec.sats || [];
      if (!list.length) return { sats: [], error: '自定义星座是空的（参数生成不出卫星，去星座页看一眼 Walker 参数）' };
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const s = list[i] || {};
        const el = s.elements || s;
        try {
          out.push({
            id: String(s.noradId != null ? s.noradId : `cc-${i}`),
            name: s.name || `${spec.name || '自定义星座'}-${i + 1}`,
            rec: ngGeom.buildSatrec({
              type: 'elements',
              altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0,
              raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0,
              epoch: s.epoch || spec.epoch, noradId: s.noradId
            })
          });
        } catch (e) { /* 单颗构造失败不影响整座 */ }
      }
      if (!out.length) return { sats: [], error: '自定义星座的根数建不出 satrec（检查近地点高度 / 倾角）' };
      return applyLimit(out, spec.limit);
    }

    if (src === 'walker') {
      const planes = Math.max(1, Math.round(Number(spec.planes) || 1));
      const per = Math.max(1, Math.round(Number(spec.perPlane) || 1));
      const altKm = Number(spec.altKm) || 0;
      const incl = Number(spec.incl) || 0;
      const phase = Number(spec.phase) || 0;
      const epoch = spec.epoch || new Date().toISOString();
      if (!(altKm > 0)) return { sats: [], error: 'Walker 星座缺轨道高度' };
      const out = [];
      for (let p = 0; p < planes; p++) {
        for (let k = 0; k < per; k++) {
          try {
            out.push({
              id: `${spec.name || 'W'}-${p}-${k}`,
              name: `${spec.name || 'Walker'} ${p + 1}/${k + 1}`,
              rec: ngGeom.buildSatrec({
                type: 'elements', altKm, incl, ecc: 0, argp: 0,
                raan: 360 * p / planes,
                // 相位因子 F：相邻轨道面之间的相位偏移 = F×360/(planes×per)，Walker δ 记法
                ma: (360 * k / per) + (phase * 360 * p) / (planes * per),
                epoch
              })
            });
          } catch (e) { /* 单颗构造失败不影响整座 */ }
        }
      }
      return out.length ? { sats: out } : { sats: [], error: 'Walker 星座构造失败' };
    }

    if (src === 'tle') {
      const out = [];
      for (const t of (spec.sats || [])) {
        try { out.push({ id: t.id || t.name, name: t.name, rec: ngGeom.buildSatrec({ type: 'tle', line1: t.line1, line2: t.line2 }) }); }
        catch (e) { /* 跳过坏行 */ }
      }
      return out.length ? { sats: out } : { sats: [], error: 'TLE 解析失败' };
    }

    return { sats: [], error: '未知星座来源：' + src };
  }

  // ---------------------------------------------------------------------------
  // 星历接入：复用平台既有的星座数据，不让用户手抄轨位
  // ---------------------------------------------------------------------------

  /**
   * 可用星座组（键 + 中文名 + 已载入的星数）。未载入的 count 为 0，UI 据此提示先加载。
   * 主进程能看到的两类一次给全：CelesTrak 编目组 + 自定义星历组（custom.json）。
   * 另两类存在渲染端 localStorage、主进程看不到，由渲染端自行并进列表：
   * 「我的卫星组」（useSatGroups.js）与「自定义星座」（useCustomConstellations.js）。
   */
  function groups() {
    // count = 已在内存里的星数；available = 本地有 CSV 缓存或内置快照（不解析、只探文件）。
    // 二者要分开报：available 为真就说明「点一下就能用」，UI 不该显示成「未载入」——
    // 干扰分析首版把这两件事混成一件，用户看到的全是「未载入」，其实数据一直都在盘上。
    const out = Object.keys(GROUP_LABEL).map((k) => {
      const list = omm && omm.peek ? omm.peek(k) : null;
      let available = false;
      try { available = !!(omm && omm.hasLocal && omm.hasLocal(k)); } catch (e) { available = false; }
      return { key: k, label: GROUP_LABEL[k], count: list ? list.length : 0, available, kind: 'omm' };
    });
    // 自定义星历：记录已落盘在 custom.json，永远 available，count 直接就是真数
    try {
      for (const g of (((customSats && customSats.list) ? customSats.list() : {}).groups || [])) {
        out.push({ key: `custom:${g.id}`, label: g.name, count: g.count, available: true, kind: 'custom' });
      }
    } catch (e) { /* 无自定义库 */ }
    return { ok: true, groups: out };
  }

  /**
   * 确保若干组的 satrec 已就绪（走 omm.satrecs：CSV 缓存 / 内置快照，必要时联网）。
   * 自定义星历组无需载入（记录在 custom.json）；卫星组要靠 active 全量编目解析成员，故折算成 active。
   */
  async function ensureSatrecs(specs, online) {
    const errs = [];
    const need = new Set();
    for (const sp of specs) {
      if (!sp || (sp.source || (sp.group ? 'group' : '')) !== 'group' || !sp.group) continue;
      const k = parseKey(sp.group);
      if (k.kind === 'omm') need.add(k.id);
      else if (k.kind === 'satgroup') need.add('active');
    }
    for (const g of need) {
      const r = await omm.satrecs(g, { online: !!online });
      if (!r.ok) errs.push(`「${GL(g)}」：${r.error}`);
    }
    return errs;
  }

  // 壳层识别的两个尺度。SHELL_BIN_KM = 高度直方图步长；SHELL_HALF_KM = 主峰两侧多宽算「同一层」。
  // 25 km 的取法——LEO 星座各设计壳层之间普遍隔着 ≥ 50 km（实测 Starlink 43° / 53° / 70° 三层
  // 分居 483 / 465 / 570 km），而同一壳层内的位置保持带宽不到 ±10 km：25 km 两头都够得着，
  // 又不至于把两个相邻壳层并成一个。
  const SHELL_BIN_KM = 10, SHELL_HALF_KM = 25;
  const qOf = (arr, p) => { const b = arr.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

  /**
   * 一个倾角箱 → 一个壳层。
   *
   * ★ 只按倾角分箱是不够的：正在抬轨 / 离轨的星与在轨工作的星**倾角相同、高度差一两百公里**
   *   （实测 Starlink 53° 箱内高度从 196 km 一直铺到 543 km）。混在一起取中位数，得到的是一条
   *   **任何一颗星都不在其上**的轨道。故先在箱内按高度找主峰，只把主峰窗里的那一撮算作壳层，
   *   窗外的星单独计数（strayCount），不参与该壳层的任何统计。
   *
   * 倾角报**窗内实测中位数**而不是箱号：箱号是 Math.round 的产物、不是实测值
   *   （实测 OneWeb 87.90° 报成箱号 88°、Starlink 主壳层 53.16° 报成 53°）。
   */
  function shellOf(items) {
    const hist = new Map();
    for (const it of items) {
      const k = Math.round(it.h / SHELL_BIN_KM);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    // 并列时取高的那个峰：抬轨 / 离轨的星总在工作轨道之下，取高者更可能是工作壳层
    let peak = null, best = -1;
    for (const [k, c] of hist) if (c > best || (c === best && k > peak)) { best = c; peak = k; }
    const hc = peak * SHELL_BIN_KM;
    const core = items.filter((it) => Math.abs(it.h - hc) <= SHELL_HALF_KM);
    const hs = core.map((x) => x.h), is = core.map((x) => x.i);
    return {
      inclDeg: +qOf(is, 0.5).toFixed(2),
      altKmMed: Math.round(qOf(hs, 0.5)),
      altKmMin: Math.round(Math.min(...hs)), altKmMax: Math.round(Math.max(...hs)),
      count: core.length, strayCount: items.length - core.length
    };
  }

  /**
   * 星座实参统计：高度 / 倾角 / 周期的分布 + 壳层分解。
   * 选了真实星座就不该再让用户填根数——这些数由星历直接给出，填了也是白填、还会与星历打架。
   *
   * ★ 顶层的 altKmMed / inclMed 是**全体**的中位数，两者未必出自同一撮星。要「一条真实存在的
   *   轨道」必须整取某个 shells[i]（高度与倾角同源），别把这两个顶层字段配成一对。
   */
  function statsOf(list) {
    const RE = 6378.137, MU = 398600.4418;
    const items = [], bins = new Map();
    for (const s of list) {
      const rec = s.satrec;
      const n = Number(rec && (rec.no != null ? rec.no : rec.no_kozai));
      if (!(n > 0)) continue;
      const nRadS = n / 60;
      const a = Math.pow(MU / (nRadS * nRadS), 1 / 3);
      const it = { h: a - RE, i: Math.abs((rec.inclo || 0) * 180 / Math.PI) };
      items.push(it);
      const k = Math.round(it.i);
      const b = bins.get(k);
      if (b) b.push(it); else bins.set(k, [it]);
    }
    if (!items.length) return null;
    const alts = items.map((x) => x.h), incls = items.map((x) => x.i);
    // 壳层按规模降序。占比不足 1% 的碎片不列（多是退役星与在途星），但前 3 档无论多小都保留，
    // 否则单壳星座里那几颗掉队的会把唯一一档挤掉。
    const all = Array.from(bins.values()).map(shellOf).sort((a, b) => b.count - a.count);
    const shells = all.filter((s, i) => i < 3 || s.count >= items.length * 0.01).slice(0, 6);
    return {
      count: items.length,
      altKmMin: Math.round(Math.min(...alts)), altKmMax: Math.round(Math.max(...alts)), altKmMed: Math.round(qOf(alts, 0.5)),
      inclMin: +Math.min(...incls).toFixed(1), inclMax: +Math.max(...incls).toFixed(1), inclMed: +qOf(incls, 0.5).toFixed(1),
      periodMin: +(2 * Math.PI * Math.sqrt(Math.pow(qOf(alts, 0.5) + RE, 3) / MU) / 60).toFixed(1),
      shells
    };
  }

  /**
   * 确保某组已载入主进程并回其实参统计（NGSO 星座选组后调用）。online=true 时尝试联网刷新。
   * @param {string} group  四类 key 之一（见 parseKey）
   * @param {boolean} online
   * @param {string[]} satIds  仅 'sg:' 卫星组需要：组成员的 NORAD 号（组本身存在渲染端）
   * @param {object[]} sats    仅 'cc:' 自定义星座需要：渲染端展开好的逐颗六根数
   */
  async function loadGroup(group, online, satIds, sats) {
    const k = parseKey(group);
    try {
      // 自定义星座：合成星，无「载入」一说；根数由渲染端带来，现建 satrec 出统计
      if (k.kind === 'ccustom') {
        const got = resolveSats({ source: 'elements', sats });
        if (got.error) return { ok: false, error: got.error };
        return { ok: true, group, source: '自定义星座 · Walker 合成', count: got.sats.length, stats: statsOf(got.sats.map((s) => ({ satrec: s.rec }))) };
      }
      // 自定义星历：无「载入」一说，现建 satrec 直接出统计
      if (k.kind === 'custom') {
        const recs = (customSats && customSats.groupRecords) ? customSats.groupRecords(k.id) : null;
        if (!recs || !recs.length) return { ok: false, error: '自定义星历组已不存在' };
        const sats = recsToSats(recs);
        if (!sats.length) return { ok: false, error: '组内记录全部 SGP4 校验失败' };
        return { ok: true, group, source: '自定义星历', count: sats.length, stats: statsOf(sats.map((s) => ({ satrec: s.rec }))) };
      }
      // 卫星组：成员靠 active 全量编目解析，故先把 active 载上
      if (k.kind === 'satgroup') {
        const r = await omm.satrecs('active', { online: !!online, force: !!online });
        if (!r.ok) return { ok: false, error: r.error };
        const got = resolveSats({ source: 'group', group, satIds });
        if (got.error) return { ok: false, error: got.error };
        const res = { ok: true, group, source: '卫星组 · 全量编目', count: got.sats.length, fetchedAt: r.fetchedAt, stats: statsOf(got.sats.map((s) => ({ satrec: s.rec }))) };
        if (got.missing) res.missing = got.missing;
        return res;
      }
      const r = await omm.satrecs(k.id, { online: !!online, force: !!online });
      if (!r.ok) return { ok: false, error: r.error };
      const list = omm.peek(k.id) || [];
      return { ok: true, group, source: r.source, count: r.count, fetchedAt: r.fetchedAt, stats: statsOf(list) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /**
   * GEO 邻星搜索：把 geo 组按**当前星下点经度**排好，供 C/ASI 直接挑邻星，
   * 不必让用户去别处查轨位再手抄。
   *
   * 倾角残余大的老星（IGSO / 漂移星）星下点纬度不为 0，一并回传 latDeg，让使用者看得见
   * ——那种星按赤道面圆轨道近似算 C/ASI 会有偏差。
   *
   * @param {object} req { lonDeg 中心轨位, spanDeg 搜索半宽(默认20), q 名称过滤, online }
   */
  async function geoNeighbors(req) {
    const r = req || {};
    try {
      const ld = await omm.satrecs('geo', { online: !!r.online });
      if (!ld.ok) return { ok: false, error: ld.error, sats: [] };
      const iso = r.iso || new Date().toISOString();
      const pos = omm.positions('geo', iso) || [];
      if (!pos.length) return { ok: false, error: 'GEO 星历已载入但传播结果为空（星历可能过旧）', sats: [] };
      const center = Number(r.lonDeg);
      const span = Number(r.spanDeg) > 0 ? Number(r.spanDeg) : 20;
      const q = String(r.q || '').trim().toUpperCase();
      const wrap = (d) => { let x = d % 360; if (x > 180) x -= 360; if (x < -180) x += 360; return x; };
      let out = pos.map((p) => ({
        name: p.name,
        lonDeg: +Number(p.lon).toFixed(3),
        latDeg: +Number(p.lat).toFixed(3),
        altKm: Math.round(p.altKm),
        // 与中心轨位的经度差（有中心时才有意义）
        dLon: Number.isFinite(center) ? +Math.abs(wrap(p.lon - center)).toFixed(3) : null,
        // 倾角残余：星下点纬度明显不为 0 → 不是标准 GEO，按赤道面近似会有偏差
        inclined: Math.abs(Number(p.lat)) > 0.5
      }));
      if (q) out = out.filter((s) => String(s.name).toUpperCase().includes(q));
      if (Number.isFinite(center)) out = out.filter((s) => s.dLon <= span);
      out.sort((a, b) => (a.dLon != null && b.dLon != null ? a.dLon - b.dLon : a.lonDeg - b.lonDeg));
      return { ok: true, count: out.length, sats: out.slice(0, 200), iso };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), sats: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // C/ASI · C/XPI （轻量，同步返回）
  // ---------------------------------------------------------------------------

  function asi(req) {
    const r = req || {};
    try {
      const out = { ok: true };
      if (r.downlink !== false) out.downlink = I.downlinkCAsi(r.downlink || r);
      if (r.uplink) out.uplink = I.uplinkCAsi(r.uplink);
      if (r.coordination) out.coordination = I.deltaTOverT(r.coordination);
      return out;
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  function xpi(req) {
    try { return { ok: true, result: I.combineXpi(req || {}) }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  // 单段解析：给法描述子（轴比 / 实测共交电平 / 对准误差 / 直接填）→ 该段 XPD + 算式。
  // 供 UI 边填边看用。换算公式一律留在引擎里——渲染端不重写公式是本模块的既定规矩，
  // 一个 IPC 往返换掉一份必然漂移的镜像，划算。
  function xpiTerm(req) {
    try { return { ok: true, term: I.ciXpi.resolveXpd(req == null ? null : req) }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  // 单点 C/CCI（逐站取值用；整张场图走 grd.sampleCci）
  function cciPoint(req) {
    const r = req || {};
    try { return { ok: true, result: I.cciAtPoint(r.values, r.beamIdx, r) }; }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  }

  // ---------------------------------------------------------------------------
  // NGSO 时变扫描：分帧 + 进度 + 取消
  // ---------------------------------------------------------------------------
  //
  // 口径对齐 useVisibility 的 createCoverageRun：取消令牌 + setImmediate 分帧 + 进度回推。
  // 放主进程跑，渲染端只收进度与最终 CDF——期间窗口照常可交互、可取消。
  let _token = 0;

  async function ngsoEstimate(req) {
    const r = req || {};
    await ensureSatrecs([r.wanted, ...(r.interferers || [])]);
    const w = resolveSats(r.wanted);
    if (w.error) return { ok: false, error: w.error };
    let intCount = 0;
    const groupInfo = [];
    for (const g of (r.interferers || [])) {
      const s = resolveSats(g);
      if (s.error) { groupInfo.push({ id: g.id, name: g.name, error: s.error, count: 0 }); continue; }
      intCount += s.sats.length;
      groupInfo.push({ id: g.id, name: g.name, count: s.sats.length });
    }
    const total = w.sats.length + intCount;
    // 多历元把同一段时窗跑 M 遍，算力就是 M 倍——预估必须把它算进去，否则拦截线形同虚设
    const ep = r.epochs || {};
    const epochCount = ep.mode && ep.mode !== 'single' ? Math.max(1, Math.round(Number(ep.count) || 1)) : 1;
    return {
      ok: true,
      wantedCount: w.sats.length,
      interfererCount: intCount,
      groups: groupInfo,
      epochCount,
      work: I.ciNgso.estimateWork(total, Number(r.horizonSec) || 86400, Number(r.stepSec) || 10) * epochCount
    };
  }

  /**
   * 卫星方向图配置：把 payload 里的 grdFile（字符串，能过 IPC）换成引擎要的采样器（函数，过不了 IPC）。
   * 其余模式原样透传。GRD 拿不到就明确报错——静默退回别的模式等于偷偷换了算法。
   */
  function resolveSatPattern(cfg, who, warns) {
    if (!cfg || cfg.mode !== 'grd') return cfg || null;
    if (!grd || typeof grd.ngsoSampler !== 'function') throw new Error(`${who}：GRD 服务不可用`);
    if (!cfg.grdFile) throw new Error(`${who}：卫星方向图选了 GRD，但未指定方向图文件`);
    // grdBeam：原始 GRD set 序号（0 基）；null/未给 = 全部波束取最大（上界口径）
    const pick = Number.isInteger(cfg.grdBeam) ? cfg.grdBeam : null;
    const s = grd.ngsoSampler(cfg.grdFile, cfg.grdCfg || {}, pick);
    warns.push(`${who}：卫星方向图取自 GRD「${cfg.grdFile}」，共 ${s.beamCount} 个波束，`
      + (s.beamPick == null ? '按全部波束取最大' : `仅取第 ${s.beamPick + 1} 个波束`)
      + `，峰值 ${s.peakDbi.toFixed(2)} dB`);
    return { ...cfg, grd: s };
  }

  async function ngsoStart(webContents, req) {
    const r = req || {};
    const token = ++_token;

    // 星历先就位再解析——resolveSats 是同步的，只 peek 内存
    const loadErrs = await ensureSatrecs([r.wanted, ...(r.interferers || [])]);

    const w = resolveSats(r.wanted);
    if (w.error) return { ok: false, error: w.error };
    const groups = [];
    const resolveWarnings = [...loadErrs];
    if (w.samplingFactor > 1.001) {
      resolveWarnings.push(`本星座从 ${w.total} 颗中等间隔抽了 ${w.sats.length} 颗（1/${w.samplingFactor.toFixed(1)}）——服务星可选范围随之减小，服务可用度偏低`);
    }
    if (w.missing) resolveWarnings.push(`本星座的卫星组中有 ${w.missing} 颗在全量编目与自定义星历中均未找到，已跳过（可能已退役）`);
    for (const g of (r.interferers || [])) {
      const s = resolveSats(g);
      if (s.error) { resolveWarnings.push(`干扰星座「${g.name || g.id || '?'}」：${s.error}`); continue; }
      if (s.missing) resolveWarnings.push(`干扰星座「${g.name || g.id}」的卫星组中有 ${s.missing} 颗未找到星历，已跳过，聚合干扰因此偏低`);
      if (s.samplingFactor > 1.001) {
        // 干扰源抽样是会算错的那一头：少算了 (K−1)/K 的干扰源，C/I 系统性偏乐观
        resolveWarnings.push(`⚠ 干扰星座「${g.name || g.id}」从 ${s.total} 颗中抽了 ${s.sats.length} 颗（1/${s.samplingFactor.toFixed(1)}）——聚合干扰因此偏低约 ${(10 * Math.log10(s.samplingFactor)).toFixed(1)} dB，C/I 偏乐观；如需完整结果请将「抽样上限」留空`);
      }
      // 抽样倍率要一路带进引擎：不止在这里说一句，每个分位数上都要留下 sampled 标记
      groups.push({ ...g, sats: s.sats, samplingFactor: s.samplingFactor || 1 });
    }

    let run;
    try {
      // GRD 采样器在此现建（函数过不了 IPC，payload 里只有文件名）
      const satPatDefault = resolveSatPattern(r.satPattern, '默认卫星方向图', resolveWarnings);
      const wantedPat = resolveSatPattern((r.wanted || {}).satPattern, '本星座', resolveWarnings);
      for (const g of groups) {
        if (g.satPattern) g.satPattern = resolveSatPattern(g.satPattern, `干扰星座「${g.name || g.id}」`, resolveWarnings);
      }
      // ---- 历元编排（P3）----
      //
      // 分工：**起始时刻由渲染端给**（引擎与本层都不碰 Date.now()，可复现是硬要求），
      // 本层只按 (startMs, spanDays, count, seed) 把它确定性地展开成一串历元——
      // 展开公式在 core 里（ciNgso.makeEpochs），渲染端过不了 CommonJS 的门，故落在这一层。
      const ep = r.epochs || {};
      const epMode = ep.mode || 'single';
      let horizonSec = Number(r.horizonSec) || 86400;
      let epochs = null;

      if (epMode === 'repeat') {
        // 时窗取「回归周期与上限中的小者」，并把覆盖率如实写进告警
        const recs = groups.reduce((a, g) => a.concat((g.sats || []).map((s) => s.rec)), []);
        const rp = I.ciNgso.constellationRepeatPeriodSec(recs);
        if (rp && rp.sec > 0) {
          const capSec = (Number(ep.capDays) > 0 ? Number(ep.capDays) : 7) * 86400;
          const want = Math.min(rp.sec, capSec);
          resolveWarnings.push(
            `按回归周期取时窗：星座回归周期 ${(rp.sec / 86400).toFixed(2)} 天（${rp.orbits} 圈，S.1325-3 §2.7.3，精度 ${rp.accuracyDeg}°）`
            + (rp.sec > capSec ? `，超过上限 ${(capSec / 86400).toFixed(1)} 天已封顶，本次覆盖 ${(want / rp.sec * 100).toFixed(1)}%` : '，本次完整覆盖一个回归周期')
            + (rp.exhausted ? '；搜索至上限仍未满足回归精度，该值为下界' : '')
          );
          horizonSec = want;
        } else {
          resolveWarnings.push('按回归周期取时窗：无法获得干扰星的轨道周期，已沿用手工设定的时窗');
        }
      } else if (epMode === 'monte-carlo') {
        const count = Math.max(1, Math.round(Number(ep.count) || 1));
        const spanMs = (Number(ep.spanDays) > 0 ? Number(ep.spanDays) : 7) * 86400e3;
        epochs = I.ciNgso.makeEpochs(Number(r.startMs) || 0, spanMs, count, ep.seed);
      }

      const runOpt = {
        station: r.station, rx: r.rx,
        wanted: { ...(r.wanted || {}), sats: w.sats, satPattern: wantedPat },
        interferers: groups,
        minElevDeg: r.minElevDeg, startMs: r.startMs,
        horizonSec, stepSec: r.stepSec,
        patternKind: r.patternKind, applyPolarization: r.applyPolarization,
        satPattern: satPatDefault, inlineGuardDeg: r.inlineGuardDeg,
        // P4：噪声 / 门限 / 雨衰分布 / 时序抽稀点数
        noise: r.noise, criteria: r.criteria, rain: r.rain, seriesMaxPoints: r.seriesMaxPoints
      };
      run = epochs && epochs.length > 1
        ? I.ciNgso.createNgsoCiMultiRun({
          ...runOpt, epochs, epochMode: epMode, epochSpanDays: ep.spanDays, seed: ep.seed,
          convergeTolDb: ep.convergeTolDb, convergePct: ep.convergePct
        })
        : I.createNgsoCiRun(runOpt);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }

    const send = (ch, payload) => {
      try { if (webContents && !webContents.isDestroyed()) webContents.send(ch, payload); } catch (e) { /* 窗口已关 */ }
    };

    // 每帧的样本数：按活跃星数反推，让单帧耗时大致恒定（星多则每帧少走几步）
    const BATCH = Math.max(20, Math.min(4000, Math.round(3e5 / Math.max(1, run.activeCount))));
    const t0 = Date.now();

    const tick = () => {
      if (token !== _token) return;                       // 已被新一次计算 / 取消作废
      let done;
      try { done = run.stepBatch(BATCH); }
      catch (e) { send('ci:ngsoDone', { ok: false, token, error: (e && e.message) || String(e) }); return; }
      if (done < run.T) {
        send('ci:ngsoProgress', { token, done, total: run.T });
        setImmediate(tick);
      } else {
        let result;
        try { result = run.finalize(); }
        catch (e) { send('ci:ngsoDone', { ok: false, token, error: (e && e.message) || String(e) }); return; }
        result.warnings = (result.warnings || []).concat(resolveWarnings);
        result.elapsedMs = Date.now() - t0;
        send('ci:ngsoDone', { ok: true, token, result });
      }
    };
    setImmediate(tick);

    return { ok: true, token, T: run.T, activeCount: run.activeCount, recommendedStepSec: run.recommendedStepSec, warnings: run.warnings.concat(resolveWarnings) };
  }

  function ngsoCancel() { _token++; return { ok: true }; }

  return { asi, xpi, xpiTerm, cciPoint, ngsoEstimate, ngsoStart, ngsoCancel, resolveSats, groups, loadGroup, geoNeighbors, ensureSatrecs, statsOf };
};
