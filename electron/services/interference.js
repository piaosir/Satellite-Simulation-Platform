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
module.exports = function createInterference(omm, customSats, getCore) {

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

  /**
   * 星座实参统计：高度 / 倾角 / 周期的分布。
   * 选了真实星座就不该再让用户填根数——这些数由星历直接给出，填了也是白填、还会与星历打架。
   * 倾角按 1° 分箱找主壳层（Starlink 这类多壳星座只报「最多的那几档」才有意义）。
   */
  function statsOf(list) {
    const RE = 6378.137, MU = 398600.4418;
    const alts = [], incls = [], bins = {};
    for (const s of list) {
      const rec = s.satrec;
      const n = Number(rec && (rec.no != null ? rec.no : rec.no_kozai));
      if (!(n > 0)) continue;
      const nRadS = n / 60;
      const a = Math.pow(MU / (nRadS * nRadS), 1 / 3);
      alts.push(a - RE);
      const inc = Math.abs((rec.inclo || 0) * 180 / Math.PI);
      incls.push(inc);
      const k = Math.round(inc);
      bins[k] = (bins[k] || 0) + 1;
    }
    if (!alts.length) return null;
    const q = (arr, p) => { const b = arr.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
    const shells = Object.keys(bins).map(Number).sort((a, b) => bins[b] - bins[a]).slice(0, 3)
      .map((k) => ({ inclDeg: k, count: bins[k] }));
    return {
      count: alts.length,
      altKmMin: Math.round(Math.min(...alts)), altKmMax: Math.round(Math.max(...alts)), altKmMed: Math.round(q(alts, 0.5)),
      inclMin: +Math.min(...incls).toFixed(1), inclMax: +Math.max(...incls).toFixed(1), inclMed: +q(incls, 0.5).toFixed(1),
      periodMin: +(2 * Math.PI * Math.sqrt(Math.pow(q(alts, 0.5) + RE, 3) / MU) / 60).toFixed(1),
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
    return {
      ok: true,
      wantedCount: w.sats.length,
      interfererCount: intCount,
      groups: groupInfo,
      work: I.ciNgso.estimateWork(total, Number(r.horizonSec) || 86400, Number(r.stepSec) || 10)
    };
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
      resolveWarnings.push(`本星座从 ${w.total} 颗中等间隔抽了 ${w.sats.length} 颗（1/${w.samplingFactor.toFixed(1)}）——服务星可选范围变小，服务可用度会偏低`);
    }
    if (w.missing) resolveWarnings.push(`本星座的卫星组里有 ${w.missing} 颗在全量编目与自定义星历里都找不到，已跳过（可能已退役）`);
    for (const g of (r.interferers || [])) {
      const s = resolveSats(g);
      if (s.error) { resolveWarnings.push(`干扰星座「${g.name || g.id || '?'}」：${s.error}`); continue; }
      if (s.missing) resolveWarnings.push(`干扰星座「${g.name || g.id}」的卫星组里有 ${s.missing} 颗找不到星历，已跳过——聚合干扰因此偏低`);
      if (s.samplingFactor > 1.001) {
        // 干扰源抽样是会算错的那一头：少算了 (K−1)/K 的干扰源，C/I 系统性偏乐观
        resolveWarnings.push(`⚠ 干扰星座「${g.name || g.id}」从 ${s.total} 颗中抽了 ${s.sats.length} 颗（1/${s.samplingFactor.toFixed(1)}）——聚合干扰因此偏低约 ${(10 * Math.log10(s.samplingFactor)).toFixed(1)} dB，**C/I 偏乐观**。要真实结果请把「取前 N 颗」留空`);
      }
      groups.push({ ...g, sats: s.sats });
    }

    let run;
    try {
      run = I.createNgsoCiRun({
        station: r.station, rx: r.rx,
        wanted: { ...(r.wanted || {}), sats: w.sats },
        interferers: groups,
        minElevDeg: r.minElevDeg, startMs: r.startMs,
        horizonSec: r.horizonSec, stepSec: r.stepSec,
        patternKind: r.patternKind, applyPolarization: r.applyPolarization
      });
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
