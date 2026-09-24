// 船舶内置实体模板数据（三期契约 DESIGN3 §1 P1b、E13；A3 规格 §7.3 记录形状、§7.4「船」、§12-6 编排者裁定）。
//
// 纯数据 + 小的派生计算；只 import components/sea.mjs 的派生辅助、shapeKit 的 ISO_BOX 与 ./common.mjs（不 import assembly /
// components/index，防环）。汇总、校验、冻结与对外 API 在 models/entityTemplates.mjs。
//
// ★ 出处：研究表 research/entity-templates.json 里的船舶条目尺寸全部来自相关来源、按用户 2026-09-24 的口径一律不收（§12-6）；
//   这里的船型取自国际船型补充调研（交接资料 research/ships-intl/ships-intl.json；原件存档 ships-raw/、核对脚本
//   ships-tools/verify.mjs：日本船舶输出组合（JSEA）《SEA-Japan》刊登的船厂主尺度等一手资料，137 条文本引文逐字命中）。
//   dims 的 value / unit / source / confidence 逐字抄该调研；note 是中性短句。
//   船载卫通罩（Intellian v100NX / v130NX）的罩高 × 罩径、反射面口径、整机质量取研究表 ship-radome-* 条目（SHIP_RADOME_DIMS）。
//   邮轮（上层建筑近通长、18–20 层甲板）、Moss 球罐 LNG 船与油轮（甲板管系 / 集管 / 软管吊）现有 sea.* 组件画不像，本期不收
//   （调研里有出处的主尺度已备，补上对应组件再加模板）。
//
// ★ 数值口径：
//   prov（组件参数 ← 出处字段）：{dim, pick?, k?}，或 {dims, derive, fn, with}（单测按 fn 独立重算对拍）：
//     'mul'           dims[0] 的值 × Π with 的全部值（驾驶楼宽 = 型宽 × 比例）
//     'rowsFromBeam'  floor((型宽 − with.marginM) / (with.boxWM + with.rowGapM))（甲板满宽列数；无列数出处时用）
//     'bridgeTiers'   ceil((with.hatchHM + deckTiers × with.boxHM + with.clearM) / with.tierHM)（驾驶楼视线越过箱顶）
//     'funnelHeight'  with.hatchHM + deckTiers × with.boxHM + with.extraM（烟囱顶高出箱顶）
//   布置（驾驶楼 / 烟囱纵向位置、层高、方形系数、艏楼高、外飘）是示意值：双岛式集装箱船驾驶楼约在艏起 0.3·L、机舱与烟囱在艉 0.15·L。
//   甲板集装箱按「艏楼坡起点 → 驾驶楼 → 烟囱 → 艉」的空当逐贝排（40 ft 高箱、贝距 12.192 + 1.2 m），
//   每贝按该处主甲板半宽（sea.hullShapeInfo.deckHalfWidth，与船体生成同式）能放几列就放几列，列数相同的相邻贝并成一块；
//   满宽块的列数 / 层数有出处就用出处（14 000 TEU 级：甲板 20 列 × 9 层），否则按型宽派生 / 示意。

import { SEA_COMPONENTS, SHIP_RADOMES, hullShapeInfo } from '../components/sea.mjs'
import { ISO_BOX } from '../components/shapeKit.mjs'
import { dim, record } from './common.mjs'

const U = Object.freeze({
  sea426: 'https://www.jsea.or.jp/wp_2022/wp-content/uploads/2024/08/SEA426_fix_240805.pdf',
  sea391: 'https://www.jsea.or.jp/wp_2022/wp-content/uploads/2018/11/Sea391.pdf',
  sea438: 'https://www.jsea.or.jp/wp_2022/wp-content/uploads/2026/09/SEA-Japan-No.-438.pdf'
})

const rec = (r) => record('ship', r)
const HULL = SEA_COMPONENTS.find((d) => d.type === 'sea.hull')

/** 船载卫通罩有出处尺寸（研究表 ship-radome-* 逐字：罩高 × 罩径 cm、反射面口径 cm、整机质量 kg）。 */
const RADOME_RESEARCH = Object.freeze({
  v100nx: Object.freeze({ HD: { H: 145.8, D: 137.9 }, refl: 105, mass: 113, url: SHIP_RADOMES.v100nx.source }),
  v130nx: Object.freeze({ HD: { H: 168.1, D: 172.4 }, refl: 125, mass: 150, url: SHIP_RADOMES.v130nx.source }),
  v240m: Object.freeze({ HD: { H: 431, D: 391 }, refl: 240, mass: 1133, url: SHIP_RADOMES.v240m.source })
})
const SHIP_RADOME_DIMS = (model) => {
  const r = RADOME_RESEARCH[model]
  return {
    radomeHxDcm: dim({ ...r.HD }, 'cm', r.url, '船载卫通罩罩高 × 罩径'),
    reflectorDiameterCm: dim(r.refl, 'cm', r.url, '罩内反射面口径'),
    radomeMassKg: dim(r.mass, 'kg', r.url, '船载卫通罩整机质量')
  }
}
/** 船载罩参数与 prov（组件参数与型号预设同值；型号选中时预设生效，照填并记 prov，改成 custom 也不走样）。 */
const radomeParams = (model) => { const r = RADOME_RESEARCH[model]; return { model, heightM: r.HD.H * 0.01, diameterM: r.HD.D * 0.01, reflectorDM: r.refl * 0.01, massKg: r.mass } }
const RADOME_PROV = (id) => ({
  [`${id}.heightM`]: { dim: 'radomeHxDcm', pick: 'H', k: 0.01 }, [`${id}.diameterM`]: { dim: 'radomeHxDcm', pick: 'D', k: 0.01 },
  [`${id}.reflectorDM`]: { dim: 'reflectorDiameterCm', k: 0.01 }, [`${id}.massKg`]: { dim: 'radomeMassKg' }
})

/**
 * 甲板上 x 处（船中起、向艏为正）的贴面挂接：船体按甲板边线收窄分块给面（'deck' 原点在船中，'deckFwd*' / 'deckAft*' 各有自己的原点），
 * 取包含 x 的那块（优先 'deck'），uv = [x − 面原点 x, 0]。
 */
function onDeck(hp, x) {
  const faces = HULL.faces(fillLocal(HULL, hp)).filter((f) => f.id === 'deck' || /^deck(Fwd|Aft)\d$/.test(f.id))
  const f = faces.find((q) => Math.abs(x - q.origin[0]) <= q.halfU + 1e-9) ||
    faces.reduce((b, q) => (Math.abs(x - q.origin[0]) - q.halfU < Math.abs(x - b.origin[0]) - b.halfU ? q : b))
  return { mode: 'surface', face: f.id, uv: [x - f.origin[0], 0], roll: 0 }
}
/** 补缺省（与 components/index.fillParams 同口径；这里不 import 注册表，防环）。 */
function fillLocal(def, raw) {
  const o = {}
  for (const [k, s] of Object.entries(def.params)) { const v = raw[k]; o[k] = v === undefined || (v === null && !s.nullable) ? s.def : v }
  return o
}

// 箱与布置常量（ISO 668 40 ft 高箱；其余示意）
const BOX = ISO_BOX['40ftHC']
const BAY_GAP = 1.2, ROW_GAP = 0.08, HATCH = 1.8, TIER_H = 2.8
const EDGE = 0.1        // 箱块外缘到甲板边线的最小净距（m）
const FC_CLEAR = 1.5    // 最前一贝前端到艏楼坡起点
const STRUCT_CLEAR = 2  // 箱块到驾驶楼 / 烟囱的净距
const AFT_LIMIT = 0.45  // 最后一贝后端不越过船中后 AFT_LIMIT·L

/**
 * 甲板集装箱逐贝排布：spans = [[x前, x后], …]（船中起向艏为正）；每贝按主甲板半宽算能放的列数（≤ rows0），
 * 列数相同的相邻贝并成一块。返回 [{x, bays, rows, full}]（x = 块中心；full = 满宽块）。
 */
function bayBlocks(h, spans, rows0) {
  const pitch = BOX.L + BAY_GAP, out = []
  const fit = (hw) => Math.floor((2 * (hw - EDGE) + ROW_GAP) / (BOX.W + ROW_GAP))
  for (const [xf, xa] of spans) {
    const n = Math.floor((xf - xa + BAY_GAP) / pitch)
    let cur = null
    for (let b = 0; b < n; b++) {
      const f = xf - b * pitch, a = f - BOX.L
      const hw = Math.min(h.deckHalfWidth(f), h.deckHalfWidth((f + a) / 2), h.deckHalfWidth(a))
      const rows = Math.min(rows0, fit(hw))
      if (rows < 2) { cur = null; continue }
      if (cur && cur.rows === rows && Math.abs(cur.back - f - BAY_GAP) < 1e-9) { cur.bays++; cur.back = a } else { cur = { front: f, back: a, bays: 1, rows }; out.push(cur) }
    }
  }
  return out.map((c) => ({ x: (c.front + c.back) / 2, bays: c.bays, rows: c.rows, full: c.rows === rows0 }))
}

/**
 * 集装箱船装配文档：船体 + 驾驶楼（翼桥 = 型宽）+ 驾驶楼顶雷达桅 + 船载卫通罩 + 烟囱 + 艏楼前桅 + 甲板集装箱块。
 * o.hull 船体参数；o.brgX / o.fnlX 驾驶楼 / 烟囱中心（船中起、向艏为正，米）；o.rows0 / o.tiers 满宽列数 / 甲板层数；
 * o.brg / o.fnl 其余参数；o.radome 船载罩型号；o.stepFwd 最前一块前端减层。
 */
function containerShip(o) {
  const hp = o.hull, L = hp.loaM, h = hullShapeInfo(fillLocal(HULL, hp))
  const boxTop = HATCH + o.tiers * BOX.H
  const brgTiers = Math.ceil((boxTop + 1.0) / TIER_H)
  const fnlH = boxTop + 4
  const brg = { lengthM: 14, tiers: brgTiers, tierHM: TIER_H, wingSpanM: hp.beamM, lifeboat: false, ...o.brg }
  const fnl = { lengthM: 12, widthM: 0.3 * hp.beamM, heightM: fnlH, rakeDeg: 6, pipes: 2, ...o.fnl }
  const bHalf = brg.lengthM / 2 + STRUCT_CLEAR, fHalf = fnl.lengthM / 2 + STRUCT_CLEAR + fnlH * Math.tan(fnl.rakeDeg * Math.PI / 180)
  const xFwd = h.xFc0 - FC_CLEAR, xAft = -AFT_LIMIT * L
  // 空当：艏楼坡 → 驾驶楼、驾驶楼 → 烟囱、烟囱 → 艉（驾驶楼在烟囱之前）
  const spans = [[xFwd, o.brgX + bHalf], [o.brgX - bHalf, o.fnlX + fHalf], [o.fnlX - fHalf, xAft]].filter(([f, a]) => f - a > BOX.L)
  const blocks = bayBlocks(h, spans, o.rows0)
  const comps = [
    { id: 'hull', type: 'sea.hull', parent: null, params: hp },
    { id: 'brg', type: 'sea.superstructure', parent: 'hull', attach: onDeck(hp, o.brgX), params: brg },
    { id: 'mast', type: 'sea.mast', parent: 'brg', attach: { mode: 'socket', socket: 'top' }, params: { heightM: 6, radars: 2 } },
    { id: 'vsat', type: 'sea.vsat.radome', parent: 'mast', attach: { mode: 'socket', socket: 'platform' }, params: radomeParams(o.radome) },
    { id: 'fnl', type: 'sea.funnel', parent: 'hull', attach: onDeck(hp, o.fnlX), params: fnl },
    { id: 'fmast', type: 'sea.mast', parent: 'hull', attach: { mode: 'socket', socket: 'bow' }, params: { heightM: 10, dM: 0.4, radars: 0, yard: false, platformWM: 1.4 } }
  ]
  blocks.forEach((b, i) => {
    const first = i === 0
    comps.push({
      id: `cnt${i + 1}`, type: 'sea.containers', parent: 'hull', attach: onDeck(hp, b.x),
      params: { size: '40ft', highCube: true, bays: b.bays, rows: b.rows, tiers: o.tiers, bayGapM: BAY_GAP, rowGapM: ROW_GAP, hatchHM: HATCH, stepFwd: first ? o.stepFwd : 0, stepBays: first ? Math.min(3, b.bays) : 3, seed: 11 * (i + 1) + o.seed }
    })
  })
  return { doc: { kind: 'assembly', schema: 1, domain: 'ship', name: o.name, comps, density: {}, massTargetKg: null }, blocks, brg, fnl }
}

/** 集装箱船记录：主尺度 prov + 布置派生 prov（满宽块列数 / 层数、驾驶楼层数、烟囱高）。 */
function containerRecord(o) {
  const dims = { ...o.dims, ...SHIP_RADOME_DIMS(o.radome) }
  const built = containerShip(o)
  const prov = {
    ...RADOME_PROV('vsat'),
    'hull.loaM': { dim: 'loaM' }, 'hull.beamM': { dim: 'beamM' }, 'hull.depthM': { dim: 'depthM' }, 'hull.draftM': { dim: 'draftM', pick: o.draftPick },
    'brg.wingSpanM': { dim: 'beamM' },
    'brg.widthM': { dims: ['beamM'], derive: 'beamM × ratio', fn: 'mul', with: { ratio: o.brgWRatio } },
    'fnl.widthM': { dims: ['beamM'], derive: 'beamM × ratio', fn: 'mul', with: { ratio: 0.3 } }
  }
  const lay = { hatchHM: HATCH, boxHM: BOX.H }
  if (dims.deckTiers) {
    prov['brg.tiers'] = { dims: ['deckTiers'], derive: 'ceil((hatchHM + deckTiers × boxHM + clearM) / tierHM)', fn: 'bridgeTiers', with: { ...lay, clearM: 1.0, tierHM: TIER_H } }
    prov['fnl.heightM'] = { dims: ['deckTiers'], derive: 'hatchHM + deckTiers × boxHM + extraM', fn: 'funnelHeight', with: { ...lay, extraM: 4 } }
  }
  built.blocks.forEach((b, i) => {
    const id = `cnt${i + 1}`
    if (dims.deckTiers) prov[`${id}.tiers`] = { dim: 'deckTiers' }
    if (!b.full) return
    prov[`${id}.rows`] = dims.deckRows
      ? { dim: 'deckRows' }
      : { dims: ['beamM'], derive: 'floor((beamM − marginM) / (boxWM + rowGapM))', fn: 'rowsFromBeam', with: { marginM: 0.8, boxWM: BOX.W, rowGapM: ROW_GAP } }
  })
  return rec({ id: o.id, title: o.title, titleZh: o.titleZh, representative: o.representative, dims, prov, ops: o.ops || {}, needsInput: o.needsInput, doc: built.doc })
}

const rowsFromBeam = (B) => Math.floor((B - 0.8) / (BOX.W + ROW_GAP))

// —— 24 000 TEU 级（双岛式；甲板列数按型宽派生、层数示意 11）
const ulcs24k = (() => {
  const dims = {
    loaM: dim(399.95, 'm', U.sea426, '总长'), beamM: dim(61.4, 'm', U.sea426, '型宽'), depthM: dim(33.2, 'm', U.sea426, '型深'),
    draftM: dim({ scantling: 16.5 }, 'm', U.sea426, '吃水（结构吃水口径）'), teu: dim(24136, 'TEU', U.sea426, '载箱量')
  }
  const L = dims.loaM.value, B = dims.beamM.value
  return containerRecord({
    id: 'ent:ulcs-24k', title: '24,000 TEU container ship', titleZh: '24000 TEU 级集装箱船', representative: 'ONE INNOVATION 级（24 000 TEU）',
    name: '24000 TEU 级集装箱船', dims, draftPick: 'scantling', brgWRatio: 0.55,
    hull: { loaM: L, beamM: B, depthM: dims.depthM.value, draftM: dims.draftM.value.scantling, cb: 0.66, bow: 'bulb', stern: 'transom', forecastleHM: 3, flareDeg: 20 },
    brgX: 0.2 * L, fnlX: -0.35 * L, brg: { widthM: 0.55 * B }, fnl: { widthM: 0.3 * B }, rows0: rowsFromBeam(B), tiers: 11, stepFwd: 3, seed: 1, radome: 'v130nx',
    needsInput: ['superstructurePosition', 'deckhouseTiers', 'funnelPosition', 'deckRows', 'deckTiers']
  })
})()

// —— 14 000 TEU 级（甲板 20 列 × 9 层有出处；布置示意同双岛式）
const c14k = (() => {
  const dims = {
    loaM: dim(364.15, 'm', U.sea391, '总长'), beamM: dim(50.6, 'm', U.sea391, '型宽'), depthM: dim(29.5, 'm', U.sea391, '型深'),
    draftM: dim({ mld: 15.75 }, 'm', U.sea391, '型吃水'), dwtT: dim(139335, 't', U.sea391, '载重吨'), gt: dim(144285, '', U.sea391, '总吨'),
    serviceSpeedKn: dim(22.5, 'kn', U.sea391, '服务航速'), teu: dim(14000, 'TEU', U.sea391, '载箱量'),
    deckRows: dim(20, 'rows', U.sea391, '甲板列数'), deckTiers: dim(9, 'tiers', U.sea391, '甲板层数'),
    holdRows: dim(18, 'rows', U.sea391, '舱内列数'), holdTiers: dim(11, 'tiers', U.sea391, '舱内层数')
  }
  const L = dims.loaM.value, B = dims.beamM.value
  return containerRecord({
    id: 'ent:container-14k', title: '14,000 TEU container ship', titleZh: '14000 TEU 级集装箱船', representative: 'ONE STORK（14 000 TEU 型）',
    name: '14000 TEU 级集装箱船', dims, draftPick: 'mld', brgWRatio: 0.55,
    hull: { loaM: L, beamM: B, depthM: dims.depthM.value, draftM: dims.draftM.value.mld, cb: 0.65, bow: 'bulb', stern: 'transom', flareDeg: 20 },
    brgX: 0.2 * L, fnlX: -0.35 * L, brg: { widthM: 0.55 * B }, fnl: { widthM: 0.3 * B }, rows0: dims.deckRows.value, tiers: dims.deckTiers.value, stepFwd: 2, seed: 3, radome: 'v130nx',
    ops: { serviceSpeedKn: { value: 22.5, source: U.sea391 } },
    needsInput: ['superstructurePosition', 'deckhouseTiers', 'funnelPosition']
  })
})()

// —— 8 900 TEU 级（双岛式、居住楼在前与机舱分离有出处；甲板最多 11 层有出处）
const c9k = (() => {
  const dims = {
    loaM: dim(276.94, 'm', U.sea438, '总长'), beamM: dim(45.8, 'm', U.sea438, '型宽'), depthM: dim(24.4, 'm', U.sea438, '型深'),
    draftM: dim({ draft: 15.5 }, 'm', U.sea438, '吃水'), gt: dim(85294, '', U.sea438, '总吨'),
    superstructurePosition: dim({ arrangement: 'two-island', accommodation: 'forward', engineRoom: 'separate' }, '', U.sea438, '双岛式：居住楼在前、与机舱分离'),
    teu: dim(8900, 'TEU', U.sea438, '载箱量'), deckTiers: dim(11, 'tiers', U.sea438, '甲板层数上限')
  }
  const L = dims.loaM.value, B = dims.beamM.value
  return containerRecord({
    id: 'ent:container-9k', title: '8,900 TEU container ship', titleZh: '8900 TEU 级集装箱船', representative: 'MAERSK TOKYO（8 900 TEU 级）',
    name: '8900 TEU 级集装箱船', dims, draftPick: 'draft', brgWRatio: 0.6,
    hull: { loaM: L, beamM: B, depthM: dims.depthM.value, draftM: dims.draftM.value.draft, cb: 0.65, bow: 'bulb', stern: 'transom', flareDeg: 20 },
    brgX: 0.2 * L, fnlX: -0.35 * L, brg: { lengthM: 16, widthM: 0.6 * B }, fnl: { widthM: 0.3 * B }, rows0: rowsFromBeam(B), tiers: dims.deckTiers.value, stepFwd: 3, seed: 5, radome: 'v100nx',
    needsInput: ['deckhouseTiers', 'funnelPosition', 'deckRows']
  })
})()

export const SEA_TEMPLATES = [ulcs24k, c14k, c9k]
