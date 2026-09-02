// utils/sceneSat.js
// 应用场景仿真 —— 场景里的【卫星节点】（纯 JS，平台无关）。
//
// ============ 为什么卫星不在模块库里 ============
// 一期把卫星当成模块库的 A 类条目，20 颗中国卫通 / 亚太 GEO + 天启写死在数据文件里 ——
// 于是用户想用 AsiaSat 7、Starlink、北斗、或者自己导入的星，做不到；NGSO 的几何也只有
// 「圆轨道高度 + 最低仰角」的闭式最差值，轨道高度还得手填，解不出真实星历。
//
// 二期改成：场景里的卫星节点【引用平台卫星库】（library.json 命名空间 'e2e' 的 sat[]，
// 与端到端链路预算窗口共用同一份）。一条卫星定义一次，两个工作台都用得上：
//   · 库条目 = 这颗星的身份 + 轨道（GSO 定点经度 / NGSO 手填或选星取真实根数）+ 转发器标称；
//   · 场景实例 ov  = 本场景这条业务分到的那一片（带宽、这个波束的 G/T、EIRP、SFD 增益档）。
// ★ 口径 5「模块不复制射频参数真值」不变：真值在库里，场景里改的是实例覆盖。
//
// 本模块只管【与库无关的那部分】：频段 → 空口介质、卫星节点的端口、预置卫星表的展开。
// 轨道 spec（喂给 SGP4 求解器的那个）留在渲染端（e2eParams.orbitSpecOf）—— 本模块不解轨道，
// 与 linkChain / sceneReduce 同一分工：几何由调用方解好后注入。

'use strict';

const DATA = require('./sceneLibData.js');

// 频段 → 空口介质。ExtC / ExtKu 是同一段空口的扩展频段，归各自主频段；
// Ku-BSS 是广播业务频段，物理上仍是 Ku 空口。
const BAND_MEDIUM = {
  UHF: 'sat_uhf', L: 'sat_l', S: 'sat_s', C: 'sat_c', ExtC: 'sat_c', X: 'sat_x',
  Ku: 'sat_ku', ExtKu: 'sat_ku', 'Ku-BSS': 'sat_ku', K: 'sat_ka', Ka: 'sat_ka', Q: 'sat_q', V: 'sat_v'
};

/** 频段名 → 空口介质 key。认不出返回 null —— 上层要如实报「频段未知」，不许静默按 Ku 算 */
function satMedium(band) {
  const b = String(band == null ? '' : band).trim();
  return BAND_MEDIUM[b] || null;
}

/**
 * 卫星节点的端口清单。
 *   · 空口一个（按库条目的工作频段）——星地边接这里；
 *   · NGSO 另给星间微波 / 星间激光两个口。GSO 不给：静止星之间的星间链路在本平台的
 *     业务场景里不出现，多给两个永远接不上的口只会让连线菜单更难挑。
 */
function satPorts(form) {
  const f = form || {};
  const band = f.frequencyBand || 'Ku';
  const med = satMedium(band) || 'sat_ku';
  const out = [{ key: 'rf', zh: band + ' 空口', medium: med, dir: 'trx', role: 'data' }];
  if ((f.orbitClass || 'GSO') !== 'GSO') {
    out.push({ key: 'isl', zh: '星间微波', medium: 'isl_rf', dir: 'trx', role: 'data' });
    out.push({ key: 'islo', zh: '星间激光', medium: 'isl_laser', dir: 'trx', role: 'data' });
  }
  return out;
}

/** 透明 / 再生：给了 SFD 就是透明转发（与 sceneReduce.resolveScene 同判据，两处必须一致） */
const payloadKindOf = (sat) => ((sat && sat.sfdRef != null && sat.sfdRef !== '') ? 'txp' : 'regen');

/** 深合并（只合对象，数组整体替换）—— 与 sceneLibrary.deepMerge 同口径 */
function merge(dst, src) {
  if (src == null) return dst;
  if (Array.isArray(src) || typeof src !== 'object') return JSON.parse(JSON.stringify(src));
  const out = (dst && typeof dst === 'object' && !Array.isArray(dst)) ? Object.assign({}, dst) : {};
  for (const k of Object.keys(src)) out[k] = merge(out[k], src[k]);
  return out;
}

/**
 * 库条目 form（或预置）+ 实例覆盖 ov → 场景里那一条【已解析的卫星节点】。
 * 出参形状与 resolveScene 对普通模块的产物同构（cat / name / sat / ports / place / payloadKind），
 * 归约器拿到即可用，不必再去查任何库。
 */
function resolveSatNode(o) {
  const opt = o || {};
  const form = opt.form || {};
  const sat = merge(JSON.parse(JSON.stringify(form)), (opt.ov && opt.ov.sat) || null);
  return {
    id: opt.id || '',
    kind: 'sat',
    cat: 'A',
    satId: opt.satId || '',
    name: opt.name || sat.satelliteName || '卫星',
    sat,
    ports: satPorts(sat),
    place: { mode: 'orbit' },
    payloadKind: opt.payloadKind || payloadKindOf(sat),
    typical: !!opt.typical,
    // 符号：静止星与非静止星两档（见 src/viz/scene/sceneSymbolMap.js 的同一对图标）
    symbol: (sat.orbitClass || 'GSO') === 'GSO' ? 'tabler:satellite' : 'lucide:satellite'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 预置卫星
// ═══════════════════════════════════════════════════════════════════════════
// 一期那 20 条中国卫通 / 亚太 GEO + 天启的数据【没有删】，改成「建库条目时的一键预置」：
// 用户点一下就在平台卫星库里生成一条，之后它和任何一条自己建的卫星条目没有区别。
const PRESETS = DATA.SAT_PRESETS_SCENE;
const presetIndex = new Map(PRESETS.map((p) => [p.key, p]));

const listSatPresets = () => PRESETS.map((p) => ({
  key: p.key, zh: p.zh, en: p.en, band: p.sat.frequencyBand,
  orbitClass: p.sat.orbitClass, orbitLongitude: p.sat.orbitLongitude,
  orbitAltitude: p.sat.orbitAltitude, orbitInclination: p.sat.orbitInclination,
  group: p.group, tags: p.tags, src: p.src, typical: !!p.typical
}));
const satPresetOf = (key) => {
  const p = presetIndex.get(String(key == null ? '' : key));
  return p ? JSON.parse(JSON.stringify(p)) : null;
};

/**
 * 预置 key + 实例覆盖 → 已解析的卫星节点。
 * ★ 场景模板走这条：模板里的卫星写的是 preset key，core 侧直接展开成可算的节点，
 *   于是「模板 → 计算」这条路不依赖任何库，单测与验证台照旧跑得通；
 *   渲染端另有一步（applyTemplate 时按 preset 在平台卫星库里找条目、找不到就建一条），
 *   建好后实例改记 satId，参数真值从此跟着库走。
 */
function satNodeFromPreset(key, o) {
  const p = satPresetOf(key);
  if (!p) return null;
  const opt = o || {};
  return resolveSatNode({
    id: opt.id, satId: opt.satId || '', name: opt.name || p.zh,
    form: p.sat, ov: opt.ov, typical: p.typical
  });
}

module.exports = {
  BAND_MEDIUM, satMedium, satPorts, payloadKindOf, resolveSatNode,
  SAT_PRESETS_SCENE: PRESETS, listSatPresets, satPresetOf, satNodeFromPreset
};
