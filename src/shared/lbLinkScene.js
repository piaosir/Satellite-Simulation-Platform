// 链路视图的「场景描述子」构建器（GSO / NGSO / 再生式三窗共用）。
//
// 三窗的几何来路各不相同——GSO 只有一个定点轨位、NGSO 有最差时刻 t* 的星下点、再生式
// 还分上行/下行/星间——但画到 3D 地球上要的东西是同一份：**谁在哪儿、谁连谁**。这里把
// 三者归一成一份描述子交给 LbLinkPane，3D 那头就不必再认得体制：
//
//   { epochISO, method, nodes:[…], legs:[…], notes:[…] }
//     nodes  { id, kind:'station'|'sat', role:'tx'|'rx'|'sat', name, lonDeg, latDeg, altKm }
//     legs   { from, to, dir:'up'|'down'|'isl', elevDeg?, azDeg?, slantKm? }
//     notes  诚实边界（示意方位 / 两处不在同一瞬间 / 掠地高度…），原样显示在图下
//   几何一项都凑不齐时返回 { blocked: '<缺什么>' }（没有 nodes），由面板原样说出来——
//   算得出预算却画不出几何时，一句「先计算链路」只会让人以为自己没点计算。
//
// 位置一律取**详细预算此刻正在显示的那一组数**背后的几何，不另算一遍：图与表说的必须是
// 同一条链路的同一个瞬间，否则读者对着 3.2° 的仰角却看见卫星挂在头顶。
// 「那一组数」的准确出处是**引擎回填的结果字段**（earthLongitudeResult / orbitPositionResult…），
// 不是表单里那串入参：引擎对空值有自己的兜底（轨位空 → 110.5°E、站址空 → 北京），对全角
// 数字有自己的归一。照着入参重解一遍，就会出现「表里明明算出了预算、图上却一片空白」——
// 引擎按 110.5°E 算完了，这边 parseFloat('') 得 NaN 就把整幅图判没了。入参只作兜底。

const RE_KM = 6378.137          // 与 core/utils/linkCalculator.js 的 EARTH_RADIUS 同值
const GEO_ALT_KM = 35786        // 同 CONSTANTS.SATELLITE_ALTITUDE
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
// 依次试，取第一个解得出有限数的（结果字段在前、入参在后）
const pick = (...vs) => { for (const v of vs) { const n = num(v); if (n !== null) return n } return null }
const blocked = (why) => ({ blocked: why })

/**
 * 仰角 → 地心中心角（度）：λ = arccos( (Re/(Re+h))·cos ε ) − ε。
 * 站与星下点之间的地面大圆角距，与 ngsoGeometry 的覆盖地心半角同一式子。
 */
export function centralAngleDeg(elevDeg, altKm) {
  const e = num(elevDeg), h = num(altKm)
  if (e === null || h === null || !(h > 0)) return null
  const c = (RE_KM / (RE_KM + h)) * Math.cos(e * D2R)
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D - e
}

// 从 (lat,lon) 沿方位角 brg 走过大圆角距 d（均为度）后的落点
export function destPoint(latDeg, lonDeg, brgDeg, dDeg) {
  const φ1 = latDeg * D2R, λ1 = lonDeg * D2R, θ = brgDeg * D2R, δ = dDeg * D2R
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2)
  return { latDeg: φ2 * R2D, lonDeg: ((λ2 * R2D + 540) % 360) - 180 }
}

// 起点指向终点的初始方位角（度，正北起顺时针）
export function initialBearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, Δλ = (lon2 - lon1) * D2R
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * R2D + 360) % 360
}

// 两点大圆角距（度）
function angDist(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, Δλ = (lon2 - lon1) * D2R
  const c = Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D
}

/**
 * 某一端（'tx' | 'rx'）的地球站在这份场景里连的是哪颗星 → { lon, lat, alt }。
 * 地理图的覆盖门要用它：站址挪出这颗星的视界就没有链路可言（见 LbSpacePane）。
 *
 * 两处讲究：
 *   · 按【腿】找而不是笼统取第一颗星——闭式球面会摆出上/下行两颗示意星，取错就画错半个球；
 *   · 场景标了 schematicSat 的（闭式球面：仰角只定中心角、方位纯属示意）一律返回 null。
 *     拿一个方位是编的星位去画覆盖圈，比不画更误导。
 */
export function satForSide(scene, side) {
  if (!scene || scene.schematicSat || !Array.isArray(scene.nodes) || !Array.isArray(scene.legs)) return null
  const st = scene.nodes.find((n) => n.kind === 'station' && n.role === side)
  if (!st) return null
  for (const lg of scene.legs) {
    const other = lg.from === st.id ? lg.to : (lg.to === st.id ? lg.from : null)
    if (!other) continue
    const sat = scene.nodes.find((n) => n.id === other && n.kind === 'sat')
    if (sat) return { lon: sat.lonDeg, lat: sat.latDeg, alt: sat.altKm }
  }
  return null
}

const station = (id, role, name, lon, lat) => {
  const lo = num(lon), la = num(lat)
  return (lo === null || la === null) ? null : { id, kind: 'station', role, name: name || (role === 'rx' ? '收信站' : '发信站'), lonDeg: lo, latDeg: la, altKm: 0 }
}
const satNode = (id, name, lon, lat, alt) => {
  const lo = num(lon), la = num(lat), h = num(alt)
  return (lo === null || la === null || !(h > 0)) ? null : { id, kind: 'sat', role: 'sat', name: name || '卫星', lonDeg: lo, latDeg: la, altKm: h }
}

// ============================================================================
// GSO 弯管：定点轨位一枚，站址两处，几何静止不随时间变
// ============================================================================
export function buildGeoScene(sel, params) {
  if (!sel || sel.error || !sel.data) return null
  const d = sel.data
  const lp = (params && params.linkParams) || {}, sp = (params && params.satParams) || {}
  const tx = station('tx', 'tx', sel.txName, pick(d.earthLongitudeResult, lp.longitude), pick(d.earthLatitudeResult, lp.latitude))
  const rx = station('rx', 'rx', sel.rxName, pick(d.rxLongitudeResult, lp.rxLongitude), pick(d.rxLatitudeResult, lp.rxLatitude))
  const sat = satNode('sat', sp.satelliteName, pick(d.orbitPositionResult, sp.orbitPosition, sp.position), 0, GEO_ALT_KM)
  if (!tx) return blocked('取不到发信站经纬度')
  if (!rx) return blocked('取不到收信站经纬度')
  if (!sat) return blocked('取不到卫星定点轨道经度')
  return {
    epochISO: null, method: '地球静止轨道',
    nodes: [tx, rx, sat],
    legs: [
      { from: 'tx', to: 'sat', dir: 'up', elevDeg: num(d.elevationResult), azDeg: num(d.azimuthResult), slantKm: num(d.slantRangeResult) },
      { from: 'sat', to: 'rx', dir: 'down', elevDeg: num(d.rxElevationResult), azDeg: num(d.rxAzimuthResult), slantKm: num(d.rxSlantRangeResult) }
    ],
    notes: []
  }
}

// ============================================================================
// NGSO 弯管：卫星摆在最差工况那一刻的星下点
// ============================================================================
// geom 有 subSat（真实星历的典型时刻 t*，或静止/快照星）→ 一颗星、两条腿，同一物理瞬间。
// 没有 subSat（手动圆轨道走闭式球面）→ 上/下行最差本就各自独立取自家最低仰角，不在同一
// 瞬间也不在同一位置：此时按各自仰角反算中心角，各摆一颗「示意星」，并在注记里说清楚。
export function buildNgsoScene(sel, params) {
  if (!sel || sel.error || !sel.data) return null
  const d = sel.data
  const lp = (params && params.linkParams) || {}, sp = (params && params.satParams) || {}
  const tx = station('tx', 'tx', sel.txName, pick(d.earthLongitudeResult, lp.longitude), pick(d.earthLatitudeResult, lp.latitude))
  const rx = station('rx', 'rx', sel.rxName, pick(d.rxLongitudeResult, lp.rxLongitude), pick(d.rxLatitudeResult, lp.rxLatitude))
  if (!tx) return blocked('取不到发信站经纬度')
  if (!rx) return blocked('取不到收信站经纬度')
  const g = sel.geom
  const w = g && g.worst
  const name = sp.satelliteName || sel.satName || '卫星'
  const upEl = w ? num(w.up.elevDeg) : num(d.elevationResult)
  const dnEl = w ? num(w.dn.elevDeg) : num(d.rxElevationResult)
  const upKm = w ? num(w.up.slantKm) : num(d.slantRangeResult)
  const dnKm = w ? num(w.dn.slantKm) : num(d.rxSlantRangeResult)

  if (g && g.subSat) {
    const sat = satNode('sat', name, g.subSat.lonDeg, g.subSat.latDeg, g.subSat.altKm)
    if (!sat) return blocked('取不到卫星星下点')
    return {
      epochISO: (g.search && g.search.typicalISO) || null,
      method: g.method || '',
      nodes: [tx, rx, sat],
      legs: [
        { from: 'tx', to: 'sat', dir: 'up', elevDeg: upEl, slantKm: upKm },
        { from: 'sat', to: 'rx', dir: 'down', elevDeg: dnEl, slantKm: dnKm }
      ],
      notes: g.static ? [] : ['卫星位于最差工况时刻 t* 的星下点，上下行取自同一物理瞬间']
    }
  }

  // 闭式球面：两颗示意星，方位各取指向对端（仰角只定中心角、不定方位，故方位纯属示意）
  const altKm = w ? num(w.up.altKm) : num(lp.orbitAltitude)
  const λu = centralAngleDeg(upEl, altKm), λd = centralAngleDeg(dnEl, w ? num(w.dn.altKm) : altKm)
  if (λu === null || λd === null) return blocked('取不到轨道高度或最差仰角')
  const pu = destPoint(tx.latDeg, tx.lonDeg, initialBearing(tx.latDeg, tx.lonDeg, rx.latDeg, rx.lonDeg), λu)
  const pd = destPoint(rx.latDeg, rx.lonDeg, initialBearing(rx.latDeg, rx.lonDeg, tx.latDeg, tx.lonDeg), λd)
  const one = angDist(pu.latDeg, pu.lonDeg, pd.latDeg, pd.lonDeg) < 0.5
  const notes = ['闭式球面最差几何：上/下行各自取自家最低仰角，' + (one ? '此处恰好重合' : '图中两颗星不在同一瞬间') + '；方位为示意（仰角只定中心角）']
  // schematicSat：星位的方位是编的（仰角只定中心角），凡是要用星位去算别的东西的地方
  // 都得先看这面旗——如地理图的覆盖门（见 satForSide）
  if (one) {
    const sat = satNode('sat', name, pu.lonDeg, pu.latDeg, altKm)
    if (!sat) return blocked('取不到轨道高度')
    return {
      epochISO: null, method: g ? g.method : '闭式球面', schematicSat: true, nodes: [tx, rx, sat],
      legs: [
        { from: 'tx', to: 'sat', dir: 'up', elevDeg: upEl, slantKm: upKm },
        { from: 'sat', to: 'rx', dir: 'down', elevDeg: dnEl, slantKm: dnKm }
      ],
      notes
    }
  }
  const su = satNode('satU', name + '·上行最差', pu.lonDeg, pu.latDeg, altKm)
  const sd = satNode('satD', name + '·下行最差', pd.lonDeg, pd.latDeg, w ? num(w.dn.altKm) : altKm)
  if (!su || !sd) return blocked('取不到轨道高度')
  return {
    epochISO: null, method: g ? g.method : '闭式球面', schematicSat: true, nodes: [tx, rx, su, sd],
    legs: [
      { from: 'tx', to: 'satU', dir: 'up', elevDeg: upEl, slantKm: upKm },
      { from: 'satD', to: 'rx', dir: 'down', elevDeg: dnEl, slantKm: dnKm }
    ],
    notes
  }
}

// ============================================================================
// 再生式：上行（站→星）/ 下行（星→站）/ 星间（星→星）
// ============================================================================
// 上下行各只有一个地球站（另一端的站址字段是引擎用的镜像，见 regenParams），故只画那一个站。
// 星间没有地球站，两颗星取最差刻各自的星下点（core 的 islGeo.worst.txSub/rxSub）。
export function buildRegenScene(sel, params, mode) {
  if (!sel || sel.error || !sel.data) return null
  const d = sel.data
  const lp = (params && params.linkParams) || {}, sp = (params && params.satParams) || {}
  const name = sp.satelliteName || sel.satName || '卫星'

  if (mode === 'isl' || mode === 'laser') {
    const ig = sel.islGeo
    const w = ig && ig.feasible && ig.worst
    if (!w || !w.txSub || !w.rxSub) return blocked('星间几何不可解（两星互不可见或缺相位）')
    const a = satNode('satA', sel.txName || '发射星', w.txSub.lonDeg, w.txSub.latDeg, w.txSub.altKm)
    const b = satNode('satB', sel.satName || '接收星', w.rxSub.lonDeg, w.rxSub.latDeg, w.rxSub.altKm)
    if (!a || !b) return blocked('取不到两星的星下点')
    const graz = num(w.grazAltKm)
    const notes = [ig.representative ? '手动圆轨道：两星位置为示意（相位缺省），几何量仍按此刻严格算出' : '两星位于最差星间距离时刻的位置']
    if (graz !== null) notes.push('LOS 掠地高度 ' + graz.toFixed(0) + ' km' + (graz < 0 ? '（被地球遮挡）' : ''))
    return {
      epochISO: w.worstISO || null, method: ig.method || '',
      nodes: [a, b],
      legs: [{ from: 'satA', to: 'satB', dir: 'isl', slantKm: num(w.rangeKm) }],
      notes
    }
  }

  const isDown = mode === 'down'
  const g = sel.geom, w = g && g.worst
  const st = isDown
    ? station('rx', 'rx', sel.txName, pick(d.rxLongitudeResult, lp.rxLongitude), pick(d.rxLatitudeResult, lp.rxLatitude))
    : station('tx', 'tx', sel.txName, pick(d.earthLongitudeResult, lp.longitude), pick(d.earthLatitudeResult, lp.latitude))
  if (!st) return blocked(isDown ? '取不到收信站经纬度' : '取不到发信站经纬度')
  const elevDeg = w ? num(isDown ? w.dn.elevDeg : w.up.elevDeg) : num(isDown ? d.rxElevationResult : d.elevationResult)
  const slantKm = w ? num(isDown ? w.dn.slantKm : w.up.slantKm) : num(isDown ? d.rxSlantRangeResult : d.slantRangeResult)
  const leg = isDown
    ? { from: 'sat', to: 'rx', dir: 'down', elevDeg, slantKm }
    : { from: 'tx', to: 'sat', dir: 'up', elevDeg, slantKm }

  if (g && g.subSat) {
    const sat = satNode('sat', name, g.subSat.lonDeg, g.subSat.latDeg, g.subSat.altKm)
    if (!sat) return blocked('取不到卫星星下点')
    return {
      epochISO: (g.search && g.search.typicalISO) || null, method: g.method || '',
      nodes: [st, sat], legs: [leg],
      notes: g.static ? [] : ['卫星位于最差工况时刻 t* 的星下点']
    }
  }
  // 闭式球面：仰角只定中心角不定方位 → 方位取指向赤道一侧（示意），高度取轨道高度
  const altKm = w ? num(isDown ? w.dn.altKm : w.up.altKm) : num(lp.orbitAltitude)
  const λ = centralAngleDeg(elevDeg, altKm)
  if (λ === null) return blocked('取不到轨道高度或最差仰角')
  const brg = st.latDeg >= 0 ? 180 : 0
  const p = destPoint(st.latDeg, st.lonDeg, brg, λ)
  const sat = satNode('sat', name, p.lonDeg, p.latDeg, altKm)
  if (!sat) return blocked('取不到轨道高度')
  return {
    epochISO: null, method: g ? g.method : '闭式球面', schematicSat: true,
    nodes: [st, sat], legs: [leg],
    notes: ['闭式球面最差几何：卫星按该仰角的中心角摆位，方位为示意（仰角只定中心角）']
  }
}
