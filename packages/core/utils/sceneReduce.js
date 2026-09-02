// utils/sceneReduce.js
// 应用场景仿真 —— 图 → 链的归约器与端到端汇总（纯 JS，平台无关）。
//
// 用户画的是【图】（模块 + 端口 + 边），引擎吃的是【链】。中间这一步是本功能的技术核心。
//
// ============ ★ 一个方案是双向的 ============
// 一条业务流缺省是双向的：A→B 与 B→A 各自是一条独立的链，各有自己的速率、体制、频率、
// 余量与瓶颈。两个方向【绝不共用一份结果】——上行受终端功放限、下行受终端口径限，
// 瓶颈几乎从不在同一段上。单向（广播、只上报的传感器）是 dir 显式设成单边的情形。
//   dir: 'bidir' 双向（缺省）| 'ab' 只 A→B | 'ba' 只 B→A
// 出参 flow.dirs[] 每个方向一条完整结果，flow.summary 是两向的合并读数。
//
// ============ 归约五步 ============
//   ① resolveScene  实例 + 库条目 → 有效模块（含继承宿主的位置、逐条覆盖参数）
//   ② buildGraph    边 → 邻接表，按端口方向定可通行性
//   ③ findPath      源 → 宿的路径（唯一则自动；分叉按 main/backup 取主路；仍不唯一则报出候选）
//   ④ segmentPath   交替切段：连续的卫星边并成一个【卫星段】整体送 linkChain，其余按介质逐条
//                   送 sceneTerrestrial。★ 现有引擎拒绝「地球站直连地球站」不是障碍，是分工线。
//   ⑤ summarize     四本账并列汇总（余量 / 速率 / 时延 / 可用度）+ 能量账另计
//
// ============ ★ 汇总口径（每条都与平台既定口径对齐）============
//   余量   = 最弱 RF 段（卫星段照 linkChain 的 e2eMargin；地面功率档取其 marginDb）。
//            约束档（铜缆/RS485/IFL）【不参与】取最小 —— 它没有 dB 余量这回事。
//   速率   = 逐段可承载 vs 实际要过，报出瓶颈在哪一段。卫星段的可承载由【本段实际的
//            热噪 / 干扰 / 门限】反解（见 maxRateOfSegment），不是拿产品标称速率充数。
//   时延   = Σ 卫星段（传播 + 载荷处理）+ Σ 地面段（传播 + 逐跳处理）+ 契约段承诺时延。
//   可用度 = 串联相乘；★主备并联走「至少 k 条在」的 Poisson–binomial，绝不连乘 ——
//            连乘算的是「两条都在」，主备要的是「至少一条在」，方向正好反了。
//   能量   = 与 dB 账并列的独立一本（sceneEnergy），不折算、不混算。

'use strict';

const M = require('./sceneMedia.js');
const T = require('./sceneTerrestrial.js');
const EN = require('./sceneEnergy.js');
const LIB = require('./sceneLibrary.js');

// ★ Number(null) === 0、Number('') === 0 —— 「没给」与「给了 0」是两件事。
// 这个洞漏一次，一条没有可用度的铜缆段就会当作 0% 参与串联相乘，整条链的可用度归零。
const num = (v, d) => {
  if (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim() === '')) return (d === undefined ? null : d);
  const n = Number(v); return Number.isFinite(n) ? n : (d === undefined ? null : d);
};
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const D2R = Math.PI / 180;
const RE_KM = 6378.137;          // WGS-84 赤道半径（与平台几何同源）
const C_KM_S = 299792.458;

// ═══════════════════════════════════════════════════════════════════════════
// 几何（闭式；SGP4 那条路由调用方解好后注入，本模块不解轨道 —— 与 linkChain 同一分工）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 静止星几何：站址 → 斜距 + 仰角 + 方位（球面闭式，与平台 calculateSatelliteAngle 同口径）。
 * 站高 altM 计入地心距。返回 { slantRange, elevation, azimuth, visible }
 */
function geoStationary(latDeg, lonDeg, satLonDeg, altM) {
  const R = RE_KM + (num(altM, 0) || 0) / 1000;
  const rs = 42164.17;                        // 静止轨道半径（km）
  const lat = latDeg * D2R, dlon = (lonDeg - satLonDeg) * D2R;
  const cosGamma = Math.cos(lat) * Math.cos(dlon);          // 站-地心-星 夹角余弦
  const d = Math.sqrt(R * R + rs * rs - 2 * R * rs * cosGamma);
  // 仰角：cos(el) = rs·sin(γ)/d
  const sinGamma = Math.sqrt(Math.max(0, 1 - cosGamma * cosGamma));
  const el = Math.atan2(cosGamma - R / rs, sinGamma) / D2R;
  // 方位角（自正北顺时针）
  const az = (Math.atan2(Math.tan(dlon), Math.sin(lat)) / D2R + 360) % 360;
  return { slantRange: d, elevation: el, azimuth: (latDeg >= 0 ? (180 + az) % 360 : az), visible: el > 0 };
}

/**
 * 圆轨道最差几何：给定轨道高度与最低工作仰角，求该仰角上的斜距（过境内的最大斜距）。
 *   d = −R·sinε + √(R²·sin²ε + h² + 2·R·h)
 * 这是「最差工况」的严格闭式（仰角越低斜距越大），与 NGSO 引擎未选星时同口径。
 */
function circularWorst(altKm, minElevDeg, stationAltM) {
  const R = RE_KM + (num(stationAltM, 0) || 0) / 1000;
  const h = num(altKm, 0);
  const s = Math.sin(num(minElevDeg, 10) * D2R);
  const d = -R * s + Math.sqrt(R * R * s * s + h * h + 2 * R * h);
  return { slantRange: d, elevation: num(minElevDeg, 10), visible: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 可用度合成
// ═══════════════════════════════════════════════════════════════════════════

/** 串联：全都在才通 → 连乘。avails 为百分数数组，忽略 null */
function seriesAvail(avails) {
  const xs = avails.filter((a) => a != null && isFinite(a));
  if (!xs.length) return null;
  return xs.reduce((acc, a) => acc * (a / 100), 1) * 100;
}

/**
 * 并联「至少 k 条可用」——Poisson–binomial（各条可用度不必相同、相互独立）。
 * ★ 绝不能写成连乘：连乘算的是「全都在」，主备要的是「至少一条在」。
 * 逐条卷积求恰好 j 条可用的概率分布，再对 j ≥ k 求和。
 */
function atLeastK(avails, k) {
  const ps = avails.filter((a) => a != null && isFinite(a)).map((a) => Math.min(1, Math.max(0, a / 100)));
  const n = ps.length;
  if (!n) return null;
  const kk = Math.max(1, Math.min(n, Math.round(num(k, 1))));
  let dist = [1];                                   // dist[j] = 恰好 j 条可用的概率
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    for (let j = 0; j < dist.length; j++) {
      next[j] += dist[j] * (1 - p);
      next[j + 1] += dist[j] * p;
    }
    dist = next;
  }
  let s = 0;
  for (let j = kk; j < dist.length; j++) s += dist[j];
  return s * 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 解析场景：实例 + 库 → 有效模块
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} scene { modules:[], links:[], flows:[] }
 * @param {object} libStore 模块库改写层
 * @returns { mods: Map<instId, resolved>, errors, warn }
 */
function resolveScene(scene, libStore) {
  const errors = [], warn = [];
  const mods = new Map();
  const raw = (scene && scene.modules) || [];

  for (const inst of raw) {
    if (!inst || !inst.id) { errors.push('场景里有一条模块缺 id'); continue; }
    const lib = LIB.moduleOf(libStore, inst.libId);
    if (!lib) { errors.push(`模块「${inst.name || inst.id}」引用的库条目不存在：${inst.libId}`); continue; }
    const r = LIB.deepMerge(lib, inst.ov || null);
    r.instId = inst.id;
    r.libId = inst.libId;
    r.name = inst.name || lib.zh;
    r.place = Object.assign({ mode: 'fixed' }, lib.place, inst.place || {});
    // 端口：库端口 + 实例逐口覆盖（key 对齐）
    const povr = inst.ports || {};
    r.ports = (r.ports || []).map((pt) => Object.assign({}, pt, povr[pt.key] || {}));
    // 载荷类型：有 SFD 即透明转发，否则再生（实例可显式覆盖）
    if (r.cat === 'A') {
      r.payloadKind = inst.payloadKind || (r.sat && r.sat.sfdRef != null && r.sat.sfdRef !== '' ? 'txp' : 'regen');
    }
    mods.set(r.instId, r);
  }

  // 位置继承：挂在宿主上的模块取宿主坐标（可多级，最多 8 层防环）
  for (const m of mods.values()) {
    if (m.place.mode !== 'mounted') continue;
    let host = mods.get(m.place.hostId), depth = 0;
    const seen = new Set([m.instId]);
    while (host && host.place && host.place.mode === 'mounted' && depth++ < 8) {
      if (seen.has(host.instId)) { errors.push(`模块「${m.name}」的挂载关系成环`); host = null; break; }
      seen.add(host.instId);
      host = mods.get(host.place.hostId);
    }
    if (!host) { warn.push(`模块「${m.name}」的宿主不存在，位置未确定`); continue; }
    m.place = Object.assign({}, m.place, { lat: host.place.lat, lon: host.place.lon, altM: host.place.altM, _hostName: host.name });
  }
  return { mods, errors, warn };
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 图 + ③ 路径
// ═══════════════════════════════════════════════════════════════════════════

const portOf = (mod, key) => (mod && (mod.ports || []).find((x) => x.key === key)) || null;
const canTx = (d) => d === 'tx' || d === 'trx' || d == null;
const canRx = (d) => d === 'rx' || d === 'trx' || d == null;

/** 边 → 邻接表。每条边记两个方向的可通行性 */
function buildGraph(scene, mods) {
  const adj = new Map();          // instId → [{ linkId, toId, forward:bool, link }]
  const errors = [];
  for (const id of mods.keys()) adj.set(id, []);
  for (const lk of (scene && scene.links) || []) {
    if (!lk || !lk.id) { errors.push('场景里有一条链路缺 id'); continue; }
    const ma = mods.get(lk.a && lk.a.modId), mb = mods.get(lk.b && lk.b.modId);
    if (!ma || !mb) { errors.push(`链路 ${lk.id} 的一端模块不存在`); continue; }
    const pa = portOf(ma, lk.a.portKey), pb = portOf(mb, lk.b.portKey);
    if (!pa || !pb) { errors.push(`链路 ${lk.id} 的一端端口不存在`); continue; }
    const med = lk.medium || pa.medium;
    if (!M.mediaOf(med)) { errors.push(`链路 ${lk.id} 的介质未知：${med}`); continue; }
    // ★ 端口类型系统：连接器族 + 方向 + 频段三重校验。这道闸是整套设计里挡住「画得出算不了的图」
    //   的那一道 —— 不在这里拦，错误就一路漏到引擎里变成一个看不懂的数值报错。
    //   RJ45 插不进 SFP 光口、UHF 终端接不上 Ka 馈源、两个只发的口对接，都在这里被判掉。
    const compat = M.portsCompatible(pa, pb);
    if (!compat.ok) {
      const why = { 'connector-mismatch': '接口类型不符', 'direction-mismatch': '收发方向不相容', 'band-mismatch': '频段不符', 'unknown-medium': '介质未知' }[compat.reason] || compat.reason;
      errors.push(`链路 ${lk.id}（${ma.name}·${pa.zh || pa.key} ↔ ${mb.name}·${pb.zh || pb.key}）${why}`);
      continue;
    }
    const okAB = canTx(pa.dir) && canRx(pb.dir);
    const okBA = canTx(pb.dir) && canRx(pa.dir);
    if (okAB) adj.get(ma.instId).push({ linkId: lk.id, toId: mb.instId, link: lk, fromPort: pa, toPort: pb, medium: med, reversed: false });
    if (okBA) adj.get(mb.instId).push({ linkId: lk.id, toId: ma.instId, link: lk, fromPort: pb, toPort: pa, medium: med, reversed: true });
    if (!okAB && !okBA) errors.push(`链路 ${lk.id} 两端方向不相容（${pa.dir || 'trx'} ↔ ${pb.dir || 'trx'}）`);
  }
  return { adj, errors };
}

/**
 * 找路径。返回 { path:[edge], alts:候选条数, err }
 * 规则：① 用户给了 pathHint（边 id 列表）就走它；② 否则枚举所有简单路径，
 *       优先 role!=='backup' 的、跳数最少的；③ 同代价多条时如实报出候选数。
 */
function findPath(adj, fromId, toId, pathHint) {
  if (fromId === toId) return { path: [], alts: 0, err: '源与宿是同一个模块' };
  if (pathHint && pathHint.length) {
    // 按给定边序还原路径
    const path = [];
    let cur = fromId;
    for (const lid of pathHint) {
      const e = (adj.get(cur) || []).find((x) => x.linkId === lid);
      if (!e) return { path: [], alts: 0, err: `指定路径断在 ${lid}` };
      path.push(e); cur = e.toId;
    }
    if (cur !== toId) return { path: [], alts: 0, err: '指定路径没有到达终点' };
    return { path, alts: 0, err: '' };
  }
  // 枚举简单路径（限深，场景不会很深；超限即视为图过复杂，要求用户指定路径）
  const MAXD = 12, found = [];
  const walk = (cur, visited, acc) => {
    if (found.length > 64 || acc.length > MAXD) return;
    for (const e of adj.get(cur) || []) {
      if (visited.has(e.toId)) continue;
      if (e.toId === toId) { found.push(acc.concat([e])); continue; }
      visited.add(e.toId);
      walk(e.toId, visited, acc.concat([e]));
      visited.delete(e.toId);
    }
  };
  walk(fromId, new Set([fromId]), []);
  if (!found.length) return { path: [], alts: 0, err: '源与宿之间没有连通路径' };
  const score = (pp) => pp.length * 10 + pp.filter((e) => (e.link.role === 'backup')).length * 100;
  found.sort((a, b) => score(a) - score(b));
  const best = score(found[0]);
  const tie = found.filter((pp) => score(pp) === best).length;
  return { path: found[0], alts: tie - 1, all: found, err: '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 切段
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 交替切段：连续的卫星边并成一个卫星段（其节点序列即 linkChain 的 nodes），其余逐条为地面段。
 * @returns [ { kind:'sat', edges:[], nodeIds:[] } | { kind:'terr', edge } ]
 */
function segmentPath(path, fromId) {
  const segs = [];
  let cur = null, node = fromId;
  for (const e of path) {
    const isSat = M.tierOf(e.medium) === 'satellite';
    if (isSat) {
      if (!cur) { cur = { kind: 'sat', edges: [], nodeIds: [node] }; segs.push(cur); }
      cur.edges.push(e); cur.nodeIds.push(e.toId);
    } else {
      cur = null;
      segs.push({ kind: 'terr', edge: e, fromId: node, toId: e.toId });
    }
    node = e.toId;
  }
  return segs;
}

// ═══════════════════════════════════════════════════════════════════════════
// 卫星段 → linkChain 描述子
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★ 非口径天线 → 等效口径。
 * 引擎按「口径 + 效率」算天线增益（面积法），但天启终端那一类用的是卷尺 / 胶棒 / 螺旋 /
 * 微带天线，物理上【没有口径】这个量，厂商给的是增益 dBi。填 0 口径进去算出来是 −∞。
 * 反解等效口径（在本跳频率上严格等价）：
 *   G = 10·lg(η·(πD/λ)²)  ⇒  D = (λ/π)·√(10^(G/10)/η)
 * 只在模块声明了 gainTxDbi / gainRxDbi 且没给口径时用；给了口径的一律走口径（不覆盖用户输入）。
 */
function equivDiameterM(gainDbi, effPct, freqGHz) {
  const g = num(gainDbi), eta = num(effPct, 50) / 100, f = num(freqGHz);
  if (g == null || !(f > 0) || !(eta > 0)) return null;
  const lambda = C_KM_S * 1000 / (f * 1e9);          // m
  return (lambda / Math.PI) * Math.sqrt(Math.pow(10, g / 10) / eta);
}

/** 地球站节点：模块的 rf 出厂值/覆盖值 + 站址 */
function esNode(mod, link) {
  const rf = mod.rf || {};
  const pl = mod.place || {};
  return {
    kind: 'es', name: mod.name,
    latitude: num(pl.lat), longitude: num(pl.lon), altitude: num(pl.altM, 0) / 1000,
    rainRate: num(pl.rainRate),
    // 可用度是【站址的雨衰统计】，属于这座站不属于某条边：站上给了用站的，没给才退回边上那个
    availability: num(pl.availPct, num((link && link.params && link.params.availPct), 99.5)),
    antennaDiameter: num(rf.antennaDiameter), antennaEfficiency: num(rf.antennaEfficiency, 65),
    feederLoss: num(rf.feederLoss, 0.5), paBackoff: num(rf.paBackoff, 0),
    powerW: num(rf.opPowerW), uplinkPowerControl: rf.uplinkPowerControl || '否', upcValue: num(rf.upcValue, 0),
    rxAntennaEfficiency: num(rf.rxAntennaEfficiency, 65),
    rxAntennaNoiseTempMode: rf.rxAntennaNoiseTempMode || '自动',
    rxAntennaNoiseTemp: num(rf.rxAntennaNoiseTemp, 35),
    rxReceiverNoiseTemp: num(rf.rxReceiverNoiseTemp, 75),
    rxFeederLoss: num(rf.rxFeederLoss, 0.3)
  };
}

/** 卫星节点：模块的 sat 出厂值/覆盖值 */
function satNode(mod) {
  const s = mod.sat || {};
  return Object.assign({}, s, { kind: mod.payloadKind === 'txp' ? 'txp' : 'regen', name: mod.name });
}

/**
 * 一个卫星段 → linkChain 的 { nodes, hops }。
 * 几何：GSO 走静止闭式；NGSO 走圆轨道最差仰角闭式；调用方注入的 geo[hopKey] 优先。
 */
function buildChainDescriptor(seg, mods, flow, dirKey, opts) {
  const nodes = [], hops = [], warn = [], errors = [];
  const ids = seg.nodeIds;
  for (let i = 0; i < ids.length; i++) {
    const m = mods.get(ids[i]);
    if (!m) { errors.push('卫星段里有节点解析不出'); return { errors, warn }; }
    nodes.push(m.cat === 'A' ? satNode(m) : esNode(m, seg.edges[Math.min(i, seg.edges.length - 1)] && seg.edges[Math.min(i, seg.edges.length - 1)].link));
  }
  // 非口径天线（鞭 / 螺旋 / 微带）：在本段的收发频率上反解等效口径，再交给引擎的面积法。
  // 频率要等 hop 建完才知道，故这一步在 hops 组装之后回填（见循环末尾的 fixAperture）。
  const fixAperture = [];
  for (let i = 0; i < seg.edges.length; i++) {
    const e = seg.edges[i];
    const a = mods.get(ids[i]), b = mods.get(ids[i + 1]);
    const lp = (e.link && e.link.params) || {};
    const med = M.mediaOf(e.medium) || {};
    const isIsl = e.medium === 'isl_rf' || e.medium === 'isl_laser';
    // ★ 一条星地边【同时承载上行与下行两个频率】（C 频段 6 GHz 上 / 4 GHz 下），
    //   走哪一个取决于这一跳往哪个方向走 —— 双向业务流反过来走同一条边时，
    //   若只存一个 freqGHz，返向那条链就会把上下行频率整个对调。
    const toSat = (b && b.cat === 'A');
    const fUp = num(lp.freqUpGHz), fDn = num(lp.freqDnGHz), fOne = num(lp.freqGHz);
    const pUp = lp.polUp || lp.pol, pDn = lp.polDn || lp.pol;
    const hop = {
      frequency: isIsl ? fOne : (toSat ? (fUp != null ? fUp : fOne) : (fDn != null ? fDn : fOne)),
      polarization: (toSat ? pUp : pDn) || 'V',
      miscLoss: num(lp.miscLossDb, 0)
    };

    if (isIsl) {
      const inj = opts && opts.geo && opts.geo[`${dirKey}:${e.linkId}`];
      hop.rangeKm = num(lp.rangeKm, inj && inj.rangeKm);
      hop.islEirp = num(lp.islEirpDbW); hop.islGT = num(lp.islGtDbK); hop.islCI = num(lp.islCiDb);
      if (hop.rangeKm == null) errors.push(`星间链路「${a.name} → ${b.name}」缺距离（km）`);
    } else {
      const sat = a.cat === 'A' ? a : (b.cat === 'A' ? b : null);
      const es = a.cat === 'A' ? b : a;
      if (!sat) { errors.push(`「${a.name} → ${b.name}」这一跳两端都不是卫星`); continue; }
      // 频率：边上给了用它；没给按介质频段中值兜个数并告警（频率是必填项，不静默）
      if (hop.frequency == null) {
        const bd = M.bandDef(med.band || (sat.sat && sat.sat.frequencyBand));
        if (bd) { hop.frequency = (bd.lo + bd.hi) / 2; warn.push(`「${a.name} → ${b.name}」未给频率，暂按 ${med.band || ''} 频段中值 ${hop.frequency.toFixed(2)} GHz 计`); }
        else errors.push(`「${a.name} → ${b.name}」缺频率（GHz）`);
      }
      const inj = opts && opts.geo && opts.geo[`${dirKey}:${e.linkId}`];
      if (inj && inj.slantRange != null) {
        hop.slantRange = num(inj.slantRange); hop.elevation = num(inj.elevation);
      } else if (lp.slantRangeKm != null) {
        hop.slantRange = num(lp.slantRangeKm); hop.elevation = num(lp.elevationDeg, 10);
      } else {
        const so = (sat.sat || {});
        const pl = es.place || {};
        if (pl.lat == null || pl.lon == null) {
          errors.push(`「${es.name}」没有站址坐标，无法解几何`);
        } else if (so.orbitClass === 'GSO') {
          const g = geoStationary(num(pl.lat), num(pl.lon), num(so.orbitLongitude, 110.5), num(pl.altM, 0));
          hop.slantRange = g.slantRange; hop.elevation = g.elevation;
          if (!g.visible) errors.push(`「${es.name}」看不到 ${sat.name}（仰角 ${g.elevation.toFixed(1)}°）`);
        } else {
          const minEl = num(lp.minElevDeg, 10);
          const g = circularWorst(num(so.orbitAltitude, 900), minEl, num(pl.altM, 0));
          hop.slantRange = g.slantRange; hop.elevation = g.elevation;
          warn.push(`「${es.name} ↔ ${sat.name}」按圆轨道 ${num(so.orbitAltitude, 900)} km / 最低仰角 ${minEl}° 的最差几何计（未按星历解算）`);
        }
      }
    }
    // 这一跳两端若是「只给增益不给口径」的终端，就在本跳频率上反解等效口径
    if (!isIsl && hop.frequency > 0) {
      const put = (idx, side) => {
        const m = mods.get(ids[idx]); const nd = nodes[idx];
        if (!m || m.cat === 'A' || !nd) return;
        const rf = m.rf || {};
        if (num(rf.antennaDiameter) > 0) return;                 // 给了口径就走口径，不覆盖用户输入
        const g = side === 'tx' ? rf.gainTxDbi : rf.gainRxDbi;
        const eff = side === 'tx' ? num(rf.antennaEfficiency, 50) : num(rf.rxAntennaEfficiency, 50);
        const d = equivDiameterM(g, eff, hop.frequency);
        if (d != null) { nd.antennaDiameter = d; fixAperture.push(`${m.name} 按 ${g} dBi @${hop.frequency.toFixed(3)} GHz 折算等效口径 ${d.toFixed(3)} m`); }
      };
      put(i, toSat ? 'tx' : 'rx');
      put(i + 1, toSat ? 'rx' : 'tx');
    }
    hops.push(hop);
  }
  if (fixAperture.length) warn.push(...fixAperture);
  const carrier = Object.assign({}, (opts && opts.carrier) || {}, (flow && flow.carrier) || {});
  return { chain: { nodes, hops, carrier }, errors, warn };
}

/**
 * 卫星段可承载的最大信息速率（严格反解，不拿产品标称速率充数）。
 * 固定 MODCOD 时符号率 ∝ 信息速率 ∝ 噪声带宽：把带宽放大 k 倍，热噪 N 放大 k 倍、干扰 I 不变。
 *   现状：C/(N+I) 已知；目标：C/(kN+I) = 门限
 *   ⇒ k = (10^(−Th/10) − I/C) / (N/C)，其中 N/C = 10^(−CN_th/10)、I/C = 10^(−CI/10)
 * 拿不到热噪/干扰分项时退回纯热噪近似 k = 10^(margin/10)（干扰存在时这是【保守】侧）。
 */
function maxRateOfSegment(sg, curRateBps) {
  const rate = num(curRateBps);
  if (!(rate > 0)) return null;
  const th = num(sg.thresholdEffResult != null && sg.thresholdEffResult !== '' ? sg.thresholdEffResult : sg.thresholdCN);
  const cnTh = num(sg.thermalCNResult), ci = num(sg.interferenceCNResult), margin = num(sg.marginResult);
  if (th != null && cnTh != null) {
    const nc = Math.pow(10, -cnTh / 10);
    const ic = (ci != null && isFinite(ci)) ? Math.pow(10, -ci / 10) : 0;
    const k = (Math.pow(10, -th / 10) - ic) / nc;
    if (isFinite(k) && k > 0) return { rateBps: rate * k, method: 'exact' };
    return { rateBps: 0, method: 'exact' };
  }
  if (margin != null) return { rateBps: rate * Math.pow(10, margin / 10), method: 'thermal-only' };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 计算一条流的一个方向
// ═══════════════════════════════════════════════════════════════════════════

function computeDirection(ctx, flow, dirKey) {
  const { mods, adj, engines, opts } = ctx;
  const ab = dirKey === 'ab';
  const fromId = ab ? flow.aId : flow.bId;
  const toId = ab ? flow.bId : flow.aId;
  const rateBps = num(ab ? flow.rateAbBps : flow.rateBaBps, num(flow.rateAbBps, 0));
  const out = {
    dir: dirKey, fromId, toId,
    fromName: (mods.get(fromId) || {}).name || fromId,
    toName: (mods.get(toId) || {}).name || toId,
    rateBps, segments: [], errors: [], warn: [], notes: []
  };

  const fp = findPath(adj, fromId, toId, ab ? flow.pathAb : flow.pathBa);
  if (fp.err) { out.errors.push(fp.err); return out; }
  out.path = fp.path.map((e) => e.linkId);
  if (fp.alts > 0) out.warn.push(`源宿之间有 ${fp.alts + 1} 条等代价路径，已取其一；要指定请在业务流上给定路径`);

  const segs = segmentPath(fp.path, fromId);
  for (const sg of segs) {
    if (sg.kind === 'sat') {
      const bd = buildChainDescriptor(sg, mods, flow, dirKey, Object.assign({}, opts, { carrier: opts && opts.carrier }));
      out.warn.push(...bd.warn);
      if (bd.errors.length) { out.errors.push(...bd.errors); continue; }
      // 信息速率：本方向的业务速率（kbps，引擎口径）
      bd.chain.carrier = Object.assign({}, bd.chain.carrier, { infoRate: rateBps / 1000 });
      const res = engines.chain(bd.chain);
      const nodeNames = sg.nodeIds.map((i) => (mods.get(i) || {}).name);
      if (!res || !res.success) {
        out.errors.push(`卫星段（${nodeNames.join(' → ')}）：${(res && res.message) || '计算失败'}`);
        out.segments.push({ kind: 'sat', tier: 'power', ok: false, names: nodeNames, error: (res && res.message) || '计算失败' });
        continue;
      }
      const d = res.data;
      const weakestIdx = num(d.weakestSegment) ? num(d.weakestSegment) - 1 : 0;
      const wseg = (d.segments || [])[weakestIdx] || (d.segments || [])[0] || {};
      const mr = maxRateOfSegment(wseg, rateBps);
      out.segments.push({
        kind: 'sat', tier: 'power', ok: true, names: nodeNames,
        label: nodeNames.join(' → '),
        marginDb: num(d.e2eMarginResult),
        latencyMs: num(d.e2eDelayResult),
        availPct: num(d.systemAvailabilityResult),
        rateBps, capacityBps: mr ? mr.rateBps : null, capacityMethod: mr ? mr.method : null,
        cn: num(d.carrierTotalCN), threshold: num(d.thresholdCN),
        hops: d.hops, segs: d.segments, transponders: d.transponders, raw: d
      });
    } else {
      const e = sg.edge;
      const med = M.mediaOf(e.medium);
      const a = mods.get(sg.fromId), b = mods.get(sg.toId);
      const label = `${a ? a.name : sg.fromId} → ${b ? b.name : sg.toId}`;
      // 边参数 = 介质缺省 + 边上覆盖；无线边的收发增益/功率优先取两端模块的 radio/antenna
      const params = Object.assign({}, (e.link && e.link.params) || {});
      if (med && med.cat === 'wireless') {
        const ra = (a && a.radio) || {}, rb = (b && b.radio) || {};
        if (params.txDbm == null && ra.txDbm != null) params.txDbm = ra.txDbm;
        if (params.sensDbm == null && rb.sensDbm != null) params.sensDbm = rb.sensDbm;
        if (params.gTxDbi == null) params.gTxDbi = antennaGainOf(a, e.fromPort) != null ? antennaGainOf(a, e.fromPort) : ra.gainDbi;
        if (params.gRxDbi == null) params.gRxDbi = antennaGainOf(b, e.toPort) != null ? antennaGainOf(b, e.toPort) : rb.gainDbi;
        if (params.distM == null && params.distKm == null) {
          const d = greatCircleKm(a && a.place, b && b.place);
          if (d != null) params.distM = d * 1000;
        }
        if (params.hTxM == null && a && a.place && a.place.antHM != null) params.hTxM = a.place.antHM;
        if (params.hRxM == null && b && b.place && b.place.antHM != null) params.hRxM = b.place.antHM;
      }
      const r = T.computeSegment({ medium: e.medium, params });
      r.kind = 'terr'; r.label = label; r.names = [a && a.name, b && b.name];
      r.rateReqBps = rateBps;
      r.capacityBps = r.rateBps;
      out.segments.push(r);
      if (!r.ok) out.errors.push(`${label}（${med ? med.zh : e.medium}）：${r.errors.join('；')}`);
      out.warn.push(...(r.warn || []).map((w) => `${label}：${w}`));
    }
  }
  return summarizeDirection(out);
}

/** 天线增益：端口上挂了 F 类天线就用它的，否则 null */
function antennaGainOf(mod, port) {
  if (!mod || !port) return null;
  if (port.antennaGainDbi != null) return num(port.antennaGainDbi);
  if (mod.antenna && mod.antenna.gainDbi != null) return num(mod.antenna.gainDbi);
  return null;
}

/** 两点大圆距离（km）。任一点缺坐标返回 null —— 不拿 0 顶替 */
function greatCircleKm(pa, pb) {
  if (!pa || !pb || pa.lat == null || pa.lon == null || pb.lat == null || pb.lon == null) return null;
  const la = num(pa.lat) * D2R, lb = num(pb.lat) * D2R;
  const dlo = (num(pb.lon) - num(pa.lon)) * D2R;
  const c = Math.sin(la) * Math.sin(lb) + Math.cos(la) * Math.cos(lb) * Math.cos(dlo);
  return RE_KM * Math.acos(Math.min(1, Math.max(-1, c)));
}

// ── 单方向汇总 ──
function summarizeDirection(out) {
  const segs = out.segments;
  // 余量：只取有 dB 余量的段（卫星段 + 地面功率档）。约束档不参与 —— 它没有余量这回事。
  let weakest = null;
  for (const s of segs) {
    if (s.tier !== 'power' || s.marginDb == null || !isFinite(s.marginDb)) continue;
    if (!weakest || s.marginDb < weakest.marginDb) weakest = s;
  }
  out.marginDb = weakest ? weakest.marginDb : null;
  out.weakestLabel = weakest ? weakest.label : '';

  // 速率：逐段可承载 vs 实际要过
  let bottleneck = null;
  for (const s of segs) {
    const cap = num(s.capacityBps);
    if (cap == null) continue;
    if (!bottleneck || cap < bottleneck.capacityBps) bottleneck = s;
  }
  out.capacityBps = bottleneck ? num(bottleneck.capacityBps) : null;
  out.bottleneckLabel = bottleneck ? bottleneck.label : '';
  out.rateOkRatio = (out.capacityBps != null && out.rateBps > 0) ? out.capacityBps / out.rateBps : null;

  // 时延：逐段相加（缺的段不计入，并如实标注）
  let lat = 0, latMissing = 0;
  for (const s of segs) { const v = num(s.latencyMs); if (v == null) latMissing++; else lat += v; }
  out.latencyMs = segs.length ? lat : null;
  if (latMissing) out.notes.push(`${latMissing} 段没有时延数据，未计入合计`);

  // 可用度：串联相乘（只算给得出可用度的段）
  const avs = segs.map((s) => num(s.availPct)).filter((a) => a != null);
  out.availPct = avs.length ? seriesAvail(avs) : null;
  out.availSegs = avs.length;

  // 契约段清点：结果里必须让人一眼看到哪些数不是算出来的
  out.quotedSegs = segs.filter((s) => s.quoted).map((s) => s.label);
  // 约束档越界清点
  out.violations = [];
  for (const s of segs) {
    for (const c of (s.checks || [])) if (c.over) {
      out.violations.push({ seg: s.label, k: c.k, label: c.label, actual: c.actual, limit: c.limit, unit: c.unit, low: !!c.low, src: c.src });
    }
  }
  out.ok = out.errors.length === 0;
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外：整场景计算
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} scene
 * @param {object} libStore   模块库改写层
 * @param {object} engines    { chain: (chainDescriptor) => linkChain 出参 }  —— 注入以便单测
 * @param {object} opts       { geo: { '<dir>:<linkId>': {slantRange,elevation,rangeKm} }, carrier: 缺省体制 }
 */
function computeScene(scene, libStore, engines, opts) {
  const res = { flows: [], modules: [], errors: [], warn: [] };
  const rs = resolveScene(scene, libStore);
  res.errors.push(...rs.errors); res.warn.push(...rs.warn);
  const gr = buildGraph(scene, rs.mods);
  res.errors.push(...gr.errors);
  const ctx = { mods: rs.mods, adj: gr.adj, engines, opts: opts || {} };

  for (const flow of (scene && scene.flows) || []) {
    if (!flow || !flow.aId || !flow.bId) { res.errors.push('业务流缺端点'); continue; }
    const dir = flow.dir || 'bidir';
    const keys = dir === 'ab' ? ['ab'] : (dir === 'ba' ? ['ba'] : ['ab', 'ba']);
    const f = {
      id: flow.id, name: flow.name || '', dir,
      aName: (rs.mods.get(flow.aId) || {}).name || flow.aId,
      bName: (rs.mods.get(flow.bId) || {}).name || flow.bId,
      dirs: keys.map((k) => computeDirection(ctx, flow, k))
    };
    // 两向合并读数：各取最不利的一侧，并标出是哪一向
    const okDirs = f.dirs.filter((d) => d.ok);
    const pick = (sel, cmp) => {
      let best = null;
      for (const d of okDirs) { const v = sel(d); if (v == null) continue; if (best == null || cmp(v, best.v)) best = { v, d }; }
      return best;
    };
    const mn = pick((d) => d.marginDb, (a, b) => a < b);
    const av = pick((d) => d.availPct, (a, b) => a < b);
    const rr = pick((d) => d.rateOkRatio, (a, b) => a < b);
    f.summary = {
      marginDb: mn ? mn.v : null, marginDir: mn ? mn.d.dir : '',
      availPct: av ? av.v : null, availDir: av ? av.d.dir : '',
      rateOkRatio: rr ? rr.v : null, rateDir: rr ? rr.d.dir : '',
      latencyMs: okDirs.length ? Math.max(...okDirs.map((d) => num(d.latencyMs, 0))) : null,
      // 往返时延：双向流才有意义（一去一回）
      rttMs: (dir === 'bidir' && f.dirs.length === 2 && f.dirs.every((d) => d.latencyMs != null))
        ? f.dirs.reduce((a, d) => a + d.latencyMs, 0) : null,
      dirCount: f.dirs.length, okCount: okDirs.length
    };
    // 要求对照（用户给了才出；不给不编）
    if (flow.availReqPct != null) f.summary.availReqPct = num(flow.availReqPct);
    if (flow.latReqMs != null) f.summary.latReqMs = num(flow.latReqMs);
    res.flows.push(f);
  }

  // 逐模块能量账
  for (const m of rs.mods.values()) {
    if (!m.power && !m.supply) continue;
    const sup = m.supply ? Object.assign({}, m.supply) : (m.power && m.power.supply ? supplyFromKey(m.power.supply, m) : null);
    if (!sup) continue;
    if (sup.kind === 'solar' && sup.latDeg == null && m.place) sup.latDeg = num(m.place.lat);
    const e = EN.computeEnergy({ load: m.power || {}, supply: sup });
    res.modules.push({ instId: m.instId, name: m.name, cat: m.cat, energy: e });
  }
  return res;
}

/** power.supply 是个介质 key（'solar' / 'ac_mains' / 'battery' …）→ 能量账的供电描述子 */
function supplyFromKey(key, mod) {
  if (key === 'solar') return { kind: 'solar', wp: 100, kt: 0.5, etaSys: 0.75, autonomyDays: 3, battery: { chem: 'lifepo4', vdc: 12, ah: 100 } };
  if (key === 'battery') return { kind: 'battery', chem: 'primary_li', vdc: 3.6, ah: 19 };
  if (key === 'poe') return { kind: 'poe' };
  if (key === 'genset') return { kind: 'genset' };
  return { kind: 'mains' };
}

module.exports = {
  geoStationary, circularWorst, seriesAvail, atLeastK,
  resolveScene, buildGraph, findPath, segmentPath,
  buildChainDescriptor, maxRateOfSegment, computeDirection, computeScene,
  greatCircleKm, esNode, satNode
};
