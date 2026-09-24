// 地球站内置实体模板数据（三期契约 DESIGN3 §1 P1b、E13；A3 规格 §7.3 记录形状、§7.4「地球站」）。
//
// 纯数据 + 小的派生计算；只 import ./common.mjs（不 import assembly / components/index，防环）。汇总、校验、冻结与对外 API
// 在 models/entityTemplates.mjs。顺序 = 口径从小到大（界面顺序）。
//
// ★ 数值口径：
//   dims = 研究表 research/entity-templates.json 的有出处字段，value / unit / source / confidence 逐字抄；note 是中性短句（不抄原文）。
//   prov（组件参数 ← 出处字段；键 '<compId>.<param>'，'<compId>#massKg' = 组件级质量覆盖）：
//     {dim, pick?, k?}          值 = dims[dim].value（对象型取 [pick]）× k（缺省 1）
//     {dims, derive, fn, with}  派生量（单测按 fn 独立重算对拍）：
//       'sub'         dims[0] − dims[1]，取 1e-9 m（反射面最前点距离 = 仰角 90° 总高 − 俯仰轴高，CPI 读图口径）
//       'linear'      with.a + with.b × dims[0]（X-Y 单轴限位 = 90° − 地平限位）
//       'pieces'      反射面分瓣：optics 文字里的 one- / two- / four-piece → 瓣缝 0 / 2 / 4
//       'mountStyle'  座型：mountType 文字含 tripod → 'tripod'，否则 'kingpost'
//   其余（立柱高、撑杆数、初始仰角、配重、未给出处的方位行程与焦径比）都是示意值，不在 prov 里 = 示意。
//   反射面与座架的方位行程填同一个数（两条关节的限位 / 初值由各自的 azTravelDeg 算，ground.azStage）。
//   剔除：研究表 13.1 m 条目里的对照型号（副面直径、alt 值、对照说明）一律不抄（用户 2026-09-24 定：内置目录不带相关型号）。

import { dim, round9, record } from './common.mjs'

const U = Object.freeze({
  gi12: 'https://globalinvacom.com/cdn/shop/files/1.2m_Ku_Band_Receiver_Transmitter_RxTx_Offset_Antenna_System.pdf',
  pr12: 'https://www.purplesat.com/web_documents/prodelin_1-2manual.pdf',
  gi18: 'https://globalinvacom.com/cdn/shop/files/1.8m_Ku_Band_Receiver_Transmitter_RxTx_Class_III_Antenna_System.pdf',
  pr18: 'https://sky-brokers.com/wp-content/uploads/2020/11/Installation-Manual-Prodelin-1.8m-RxTx-VSAT-Antenna-1183-series.pdf',
  gi24: 'https://globalinvacom.com/cdn/shop/files/2.4m_Ku_Band_Receiver_Transmitter_RxTx_Class_III_Antenna_System.pdf',
  pr24: 'https://purplesat.com/web_documents/prodelin_2-4m_manual.pdf',
  pr37: 'https://www.satellite-bandwidth.net/NewEra-2015/equipment-manuals/Prodelin/ds-cku-3m-3.4m-3.7m-ro.pdf',
  asc45: 'https://satcom-services.com/products/asc-signal/asc-signal-102-4-5m-earth-station-antenna-high-wind.pdf',
  cpi73: 'https://www.cpii.com/docs/datasheets/498/7.3%20Meter%20Cassegrain%20Antenna%2001-2023.pdf',
  cpi90: 'https://www.cpii.com/docs/datasheets/498/9.0%20Meter%20Cassegrain%20Antenna%2010-2023.pdf',
  cpi111: 'https://www.cpii.com/docs/datasheets/498/11.1%20Meter%20Cassegrain%20Antenna%2012-2023.pdf',
  cpi131: 'https://www.cpii.com/docs/datasheets/498/13.1%20Meter%20Turning%20Head%20Antenna%2009-2023.pdf',
  tcs: 'http://www.satcomsource.com/TCS-Type-1-XY-Tracking-Antenna.pdf',
  dsn104: 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/104/104L.pdf',
  dsn302: 'https://deepspace.jpl.nasa.gov/dsndocs/810-005/302/302E.pdf',
  descanso: 'https://descanso.jpl.nasa.gov/monograph/series4/Mono4_Ch7.pdf'
})

const rec = (r) => record('ground', r)
/** 地球站装配文档：comps 依次挂接（第一件为根）。 */
const stationDoc = (name, comps) => ({ kind: 'assembly', schema: 1, domain: 'ground', name, comps, density: {}, massTargetKg: null })
/** 对象型研究值取键。 */
const vOf = (d, pick) => (d.value !== null && typeof d.value === 'object' ? d.value[pick] : d.value)
/** 仰角范围 prov（反射面 elMinDeg / elMaxDeg ← elevationRangeDeg.min / max）。 */
const EL_PROV = (id) => ({ [`${id}.elMinDeg`]: { dim: 'elevationRangeDeg', pick: 'min' }, [`${id}.elMaxDeg`]: { dim: 'elevationRangeDeg', pick: 'max' } })
/** 分瓣（与单测同式）。 */
const piecesOf = (optics) => (/two-piece/.test(optics) ? 2 : /four-piece/.test(optics) ? 4 : 0)

// ───────────────────────────── 偏馈 VSAT ─────────────────────────────

// —— 1.2 m：非穿透式底座 + 偏馈（立柱直径取厂家范围上限）
const vsat12 = (() => {
  const dims = {
    apertureM: dim(1.2, 'm', U.gi12, '有效口径'),
    optics: dim('offset prime focus (one-piece)', null, U.gi12, '单瓣偏馈'),
    fOverD: dim(0.8, null, U.pr12, '同级 1.2 m 偏馈安装手册'),
    offsetAngleDeg: dim(17.3, 'deg', U.pr12, '口面竖直时波束仰起的角度'),
    mountType: dim('az-el', null, U.gi12),
    elevationRangeDeg: dim({ min: 7, max: 84 }, 'deg', U.gi12),
    azimuthRangeDeg: dim({ coarse: 360, fine: 20 }, 'deg', U.gi12, '粗调 360°、细调 ±20°'),
    mastDiameterMm: dim({ min: 73, max: 76 }, 'mm', U.gi12, '适配立柱外径范围')
  }
  const mastDM = vOf(dims.mastDiameterMm, 'max') * 0.001
  return rec({
    id: 'ent:vsat-1p2', title: '1.2 m offset VSAT', titleZh: '1.2 m 偏馈 VSAT',
    representative: 'Skyware Global Type 123（焦径比 / 偏置角取 Prodelin 1132）',
    dims,
    prov: {
      'mnt.mastDM': { dim: 'mastDiameterMm', pick: 'max', k: 0.001 },
      'refl.diameterM': { dim: 'apertureM' }, 'refl.offsetDeg': { dim: 'offsetAngleDeg' }, 'refl.fD': { dim: 'fOverD' },
      'refl.mastDM': { dim: 'mastDiameterMm', pick: 'max', k: 0.001 },
      ...EL_PROV('refl'), 'refl.azTravelDeg': { dim: 'azimuthRangeDeg', pick: 'coarse' },
      'refl.seams': { dims: ['optics'], derive: 'one-piece → 0', fn: 'pieces', with: {} }
    },
    needsInput: ['mountHeightM'],
    doc: stationDoc('1.2 m 偏馈 VSAT', [
      { id: 'mnt', type: 'es.vsat.mount', parent: null, params: { frameM: 1.5, mastHM: 1.0, mastDM } },
      {
        id: 'refl', type: 'es.refl.offset', parent: 'mnt', attach: { mode: 'socket', socket: 'mast' },
        params: { diameterM: dims.apertureM.value, offsetDeg: dims.offsetAngleDeg.value, fD: dims.fOverD.value, feedArm: 'boom', mastDM, elMinDeg: 7, elMaxDeg: 84, azTravelDeg: 360, seams: piecesOf(dims.optics.value), el0Deg: 35 }
      }
    ])
  })
})()

/** 1.8 / 2.4 m：落地立柱 + 偏馈（立柱高示意，厂家不规定）。 */
function vsatMast(o) {
  const { dims } = o
  const mastDM = dims.mastDiameterMm.value * 0.001
  const refl = { diameterM: dims.apertureM.value, offsetDeg: dims.offsetAngleDeg.value, mastDM, elMinDeg: dims.elevationRangeDeg.value.min, elMaxDeg: dims.elevationRangeDeg.value.max, azTravelDeg: 360, seams: piecesOf(dims.optics.value), el0Deg: 35 }
  const comps = [
    { id: 'mast', type: 'es.mast', parent: null, params: { mastDM, heightM: o.mastHM } },
    { id: 'refl', type: 'es.refl.offset', parent: 'mast', attach: { mode: 'socket', socket: 'mast' }, params: refl }
  ]
  if (dims.massKg) comps[1].massKg = dims.massKg.value   // 组件级质量覆盖（天线不含立柱）
  return rec({
    id: o.id, title: o.title, titleZh: o.titleZh, representative: o.representative, dims,
    prov: {
      'mast.mastDM': { dim: 'mastDiameterMm', k: 0.001 },
      'refl.diameterM': { dim: 'apertureM' }, 'refl.offsetDeg': { dim: 'offsetAngleDeg' }, 'refl.mastDM': { dim: 'mastDiameterMm', k: 0.001 },
      ...EL_PROV('refl'),
      'refl.seams': { dims: ['optics'], derive: o.seamsDerive, fn: 'pieces', with: {} },
      ...(dims.massKg ? { 'refl#massKg': { dim: 'massKg' } } : {})
    },
    needsInput: ['fOverD', 'mountHeightM'],
    doc: stationDoc(o.titleZh, comps)
  })
}

const vsat18 = vsatMast({
  id: 'ent:vsat-1p8', title: '1.8 m offset VSAT', titleZh: '1.8 m 偏馈 VSAT',
  representative: 'Skyware Global Type 183（偏置角取 Prodelin 1183）', mastHM: 1.5, seamsDerive: 'one-piece → 0',
  dims: {
    apertureM: dim(1.8, 'm', U.gi18),
    optics: dim('offset prime focus (one-piece)', null, U.gi18, '单瓣偏馈'),
    offsetAngleDeg: dim(22.3, 'deg', U.pr18, '同级 1.8 m 偏馈安装手册'),
    mountType: dim('az-el', null, U.gi18),
    elevationRangeDeg: dim({ min: 10, max: 90 }, 'deg', U.gi18),
    mastDiameterMm: dim(114, 'mm', U.gi18, '适配立柱外径')
  }
})

const vsat24 = vsatMast({
  id: 'ent:vsat-2p4', title: '2.4 m offset VSAT', titleZh: '2.4 m 偏馈 VSAT',
  representative: 'Skyware Global Type 243（偏置角取 Prodelin 1251）', mastHM: 1.8, seamsDerive: 'two-piece → 2（一条竖缝）',
  dims: {
    apertureM: dim(2.4, 'm', U.gi24),
    optics: dim('offset prime focus (two-piece)', null, U.gi24, '两瓣偏馈'),
    offsetAngleDeg: dim(22.3, 'deg', U.pr24, '同级 2.4 m 两瓣偏馈安装手册'),
    mountType: dim('az-el', null, U.gi24),
    elevationRangeDeg: dim({ min: 10, max: 90 }, 'deg', U.gi24),
    mastDiameterMm: dim(168, 'mm', U.gi24, '适配立柱外径'),
    massKg: dim(110.65, 'kg', U.gi24, '天线质量，不含立柱')
  }
})

// ───────────────────────────── X-Y 座跟踪天线 ─────────────────────────────

const xy24 = (() => {
  const dims = {
    mountType: dim('x-y', null, U.tcs, 'X-Y 座架'),
    noZenithKeyhole: dim(true, null, U.tcs, '天顶无锁孔'),
    apertureRangeM: dim({ min: 1.5, max: 7.3 }, 'm', U.tcs, '系列口径范围'),
    horizonLimitDeg: dim(-2, 'deg', U.tcs, '地平限位'),
    optics: dim('prime focus', null, U.tcs)
  }
  const lim = 90 - dims.horizonLimitDeg.value
  const D = 2.4
  return rec({
    id: 'ent:es-xy-2p4', title: 'X-Y tracking antenna 2.4 m', titleZh: '2.4 m X-Y 座跟踪天线',
    representative: 'TCS Type 1 X/Y 跟踪天线（口径取室外型上限 2.4 m）',
    dims,
    prov: {
      'ped.limitDeg': { dims: ['horizonLimitDeg'], derive: '90 − horizonLimitDeg', fn: 'linear', with: { a: 90, b: -1 } },
      'refl.xyLimitDeg': { dims: ['horizonLimitDeg'], derive: '90 − horizonLimitDeg', fn: 'linear', with: { a: 90, b: -1 } }
    },
    needsInput: ['fOverD', 'mountHeightM'],
    doc: stationDoc('2.4 m X-Y 座跟踪天线', [
      { id: 'ped', type: 'es.pedestal.xy', parent: null, params: { dishDM: D, limitDeg: lim } },
      { id: 'refl', type: 'es.refl.prime', parent: 'ped', attach: { mode: 'socket', socket: 'y' }, params: { diameterM: D, gimbal: 'xy', xyLimitDeg: lim, el0Deg: 0 } }
    ])
  })
})()

// ───────────────────────────── 正馈 3.7 / 4.5 m ─────────────────────────────

const es37 = (() => {
  const dims = {
    apertureM: dim(3.7, 'm', U.pr37),
    optics: dim('prime focus, axisymmetric', null, U.pr37, '轴对称正馈'),
    fOverD: dim(0.37, null, U.pr37, '数据表 3.7 m 一列'),
    mountType: dim('az-el (polar optional)', null, U.pr37, '方位俯仰座（可选极轴座）'),
    elevationRangeDeg: dim({ min: 10, max: 70, optionalMax: 90 }, 'deg', U.pr37, '标准行程 10–70°，选配到 90°')
  }
  const D = dims.apertureM.value
  return rec({
    id: 'ent:es-3p7', title: '3.7 m prime-focus antenna', titleZh: '3.7 m 正馈天线',
    representative: 'Prodelin 1374 系列 3.7 m 正馈', dims,
    prov: { 'ped.dishDM': { dim: 'apertureM' }, 'refl.diameterM': { dim: 'apertureM' }, 'refl.fD': { dim: 'fOverD' }, ...EL_PROV('refl') },
    needsInput: ['mountHeightM'],
    doc: stationDoc('3.7 m 正馈天线', [
      { id: 'ped', type: 'es.pedestal.azel', parent: null, params: { dishDM: D } },
      { id: 'refl', type: 'es.refl.prime', parent: 'ped', attach: { mode: 'socket', socket: 'el' }, params: { diameterM: D, fD: dims.fOverD.value, struts: 4, elMinDeg: 10, elMaxDeg: 70, el0Deg: 35 } }
    ])
  })
})()

const es45 = (() => {
  const dims = {
    apertureM: dim(4.5, 'm', U.asc45),
    optics: dim('prime focus', null, U.asc45),
    mountType: dim('az-el (tripod)', null, U.asc45, '俯仰-方位三脚座'),
    elevationRangeDeg: dim({ min: 5, max: 90 }, 'deg', U.asc45),
    hubDiameterM: dim(1.32, 'm', U.asc45, '中心设备舱直径')
  }
  const D = dims.apertureM.value
  return rec({
    id: 'ent:es-4p5', title: '4.5 m prime-focus antenna', titleZh: '4.5 m 正馈天线',
    representative: 'ASC Signal 4.5 m 高风载地球站天线', dims,
    prov: {
      'ped.dishDM': { dim: 'apertureM' }, 'ped.style': { dims: ['mountType'], derive: 'az-el (tripod) → tripod', fn: 'mountStyle', with: {} },
      'refl.diameterM': { dim: 'apertureM' }, 'refl.hubDM': { dim: 'hubDiameterM' }, ...EL_PROV('refl')
    },
    needsInput: ['fOverD', 'mountHeightM'],
    doc: stationDoc('4.5 m 正馈天线', [
      { id: 'ped', type: 'es.pedestal.azel', parent: null, params: { dishDM: D, style: 'tripod' } },
      { id: 'refl', type: 'es.refl.prime', parent: 'ped', attach: { mode: 'socket', socket: 'el' }, params: { diameterM: D, hubDM: dims.hubDiameterM.value, struts: 4, elMinDeg: 5, elMaxDeg: 90, el0Deg: 35 } }
    ])
  })
})()

// ───────────────────────────── 卡塞格伦 7.3 / 9 / 11.1 / 13.1 m（CPI 读图口径） ─────────────────────────────

/**
 * 方位俯仰立柱座 + 卡塞格伦。俯仰轴高、仰角 90° 总高逐字取数据表读图值；反射面最前点距离 = 总高 − 俯仰轴高（'sub'），
 * 组件按它反推顶点前伸——装好后仰角 90° 的总高恰为数据表值。o.az = 数据表方位行程（没有就示意 200°，与同系列 KX200 同）。
 */
function cassStation(o) {
  const { dims } = o
  const D = dims.apertureM.value, H = dims.elAxisHeightM.value
  const reach = round9(dims.overallHeightAt90ElM.value - H)
  const az = dims.azimuthRangeDeg ? dims.azimuthRangeDeg.value : 200
  const refl = { diameterM: D, reachM: reach, elMinDeg: dims.elevationRangeDeg.value.min, elMaxDeg: dims.elevationRangeDeg.value.max, azTravelDeg: az, el0Deg: 35 }
  if (dims.hubDiameterM) refl.hubDM = dims.hubDiameterM.value
  const comps = [
    { id: 'ped', type: 'es.pedestal.azel', parent: null, params: { dishDM: D, elAxisHM: H, azTravelDeg: az, style: /tripod/.test(dims.mountType.value) ? 'tripod' : 'kingpost' } },
    { id: 'refl', type: 'es.refl.cass', parent: 'ped', attach: { mode: 'socket', socket: 'el' }, params: refl }
  ]
  if (dims.reflectorMassKg) comps[1].massKg = dims.reflectorMassKg.value
  const prov = {
    'ped.dishDM': { dim: 'apertureM' }, 'ped.elAxisHM': { dim: 'elAxisHeightM' },
    'refl.diameterM': { dim: 'apertureM' },
    'refl.reachM': { dims: ['overallHeightAt90ElM', 'elAxisHeightM'], derive: 'overallHeightAt90ElM − elAxisHeightM', fn: 'sub', with: {} },
    ...EL_PROV('refl')
  }
  if (dims.azimuthRangeDeg) { prov['ped.azTravelDeg'] = { dim: 'azimuthRangeDeg' }; prov['refl.azTravelDeg'] = { dim: 'azimuthRangeDeg' } }
  if (dims.hubDiameterM) prov['refl.hubDM'] = { dim: 'hubDiameterM' }
  if (dims.reflectorMassKg) prov['refl#massKg'] = { dim: 'reflectorMassKg' }
  // 座型只在数据表写明（kingpost / tripod）时记出处；只写 az-el 的按缺省立柱座（示意）
  if (/kingpost|tripod/.test(dims.mountType.value)) prov['ped.style'] = { dims: ['mountType'], derive: `${dims.mountType.value} → ${comps[0].params.style}`, fn: 'mountStyle', with: {} }
  return rec({ id: o.id, title: o.title, titleZh: o.titleZh, representative: o.representative, dims, prov, needsInput: ['fOverD'], doc: stationDoc(o.titleZh, comps) })
}

const es73 = cassStation({
  id: 'ent:es-7p3', title: '7.3 m Cassegrain antenna', titleZh: '7.3 m 卡塞格伦天线', representative: 'CPI 7.3 m 卡塞格伦（KX200 立柱座）',
  dims: {
    apertureM: dim(7.3, 'm', U.cpi73), optics: dim('cassegrain', null, U.cpi73),
    mountType: dim('az-el (kingpost)', null, U.cpi73, '方位俯仰立柱座'),
    elevationRangeDeg: dim({ min: 0, max: 90 }, 'deg', U.cpi73),
    azimuthRangeDeg: dim(200, 'deg', U.cpi73, 'KX200 方位行程'),
    elAxisHeightM: dim(3.704, 'm', U.cpi73, '侧视图读图：地面到俯仰轴'),
    overallHeightAt90ElM: dim(8.23, 'm', U.cpi73, '读图：仰角 90° 总高'),
    reflectorMassKg: dim(998, 'kg', U.cpi73, '反射面质量（KX200 列）')
  }
})

const es90 = cassStation({
  id: 'ent:es-9p0', title: '9 m Cassegrain antenna', titleZh: '9 m 卡塞格伦天线', representative: 'CPI 9.0 m 卡塞格伦（KX200 立柱座）',
  dims: {
    apertureM: dim(9, 'm', U.cpi90), optics: dim('cassegrain', null, U.cpi90),
    mountType: dim('az-el (kingpost)', null, U.cpi90, '方位俯仰立柱座'),
    elevationRangeDeg: dim({ min: 0, max: 90 }, 'deg', U.cpi90),
    azimuthRangeDeg: dim(200, 'deg', U.cpi90, 'KX200 方位行程'),
    elAxisHeightM: dim(4.48, 'm', U.cpi90, '侧视图读图：地面到俯仰轴'),
    overallHeightAt90ElM: dim(9.991, 'm', U.cpi90, '读图：仰角 90° 总高'),
    hubDiameterM: dim(1.78, 'm', U.cpi90, '中心舱直径')
  }
})

const es111 = cassStation({
  id: 'ent:es-11p1', title: '11.1 m Cassegrain antenna', titleZh: '11.1 m 卡塞格伦天线', representative: 'CPI 11.1 m 卡塞格伦（KX 座）',
  dims: {
    apertureM: dim(11.1, 'm', U.cpi111), optics: dim('cassegrain', null, U.cpi111),
    mountType: dim('az-el', null, U.cpi111),
    elevationRangeDeg: dim({ min: 0, max: 90 }, 'deg', U.cpi111),
    elAxisHeightM: dim(6.026, 'm', U.cpi111, '侧视图读图：地面到俯仰轴'),
    overallHeightAt90ElM: dim(12.655, 'm', U.cpi111, '读图：仰角 90° 总高')
  }
})

const es131 = cassStation({
  id: 'ent:es-13p1', title: '13.1 m Cassegrain antenna', titleZh: '13.1 m 卡塞格伦天线', representative: 'CPI 13.1 m 卡塞格伦（KX 座）',
  dims: {
    apertureM: dim(13.1, 'm', U.cpi131), optics: dim('cassegrain', null, U.cpi131),
    mountType: dim('az-el', null, U.cpi131),
    elevationRangeDeg: dim({ min: 0, max: 90 }, 'deg', U.cpi131),
    azimuthRangeDeg: dim(180, 'deg', U.cpi131, 'KX 座方位行程'),
    elAxisHeightM: dim(7.087, 'm', U.cpi131, '侧视图读图：地面到俯仰轴'),
    overallHeightAt90ElM: dim(15.064, 'm', U.cpi131, '读图：仰角 90° 总高')
  }
})

// ───────────────────────────── 34 m 波束波导 ─────────────────────────────

const dsn34 = (() => {
  const dims = {
    apertureM: dim(34, 'm', U.dsn104),
    mountType: dim('az-el', null, U.dsn302, '方位俯仰座'),
    elevationRangeDeg: dim({ min: 6, max: 89.5 }, 'deg', U.dsn302, '俯仰运动限位'),
    slewRateDegS: dim(0.8, 'deg/s', U.dsn302, '各轴回转速率'),
    subreflectorDiameterM: dim(3.42, 'm', U.descanso, 'DSS-13 研发型 BWG 副面直径（运行型同构）'),
    bwgMirrorDiameterM: dim(2.4, 'm', U.dsn104, '波束波导镜直径')
  }
  const D = dims.apertureM.value
  return rec({
    id: 'ent:dsn-34m', title: '34 m beam-waveguide antenna', titleZh: '34 m 波束波导天线',
    representative: 'NASA DSN 34 m 波束波导天线（DSS-24/25/26/34/35/36/54/55；副面直径取研发型 DSS-13）', dims,
    prov: {
      'ped.dishDM': { dim: 'apertureM' }, 'ped.bwgDM': { dim: 'bwgMirrorDiameterM' },
      'refl.diameterM': { dim: 'apertureM' }, 'refl.subDM': { dim: 'subreflectorDiameterM' }, ...EL_PROV('refl')
    },
    ops: { slewRateDegS: { value: 0.8, source: U.dsn302 } },
    needsInput: ['fOverD', 'elAxisHeightM'],
    doc: stationDoc('34 m 波束波导天线', [
      { id: 'ped', type: 'es.pedestal.wheeltrack', parent: null, params: { dishDM: D, bwgDM: dims.bwgMirrorDiameterM.value } },
      { id: 'refl', type: 'es.refl.cass', parent: 'ped', attach: { mode: 'socket', socket: 'el' }, params: { diameterM: D, subDM: dims.subreflectorDiameterM.value, elMinDeg: 6, elMaxDeg: 89.5, counterweight: true, el0Deg: 45 } }
    ])
  })
})()

export const GROUND_TEMPLATES = [vsat12, vsat18, vsat24, xy24, es37, es45, es73, es90, es111, es131, dsn34]
