// 端到端链路条的拓扑编辑：插入 / 删除节点、端点改型、端点向外接，以及随之而来的两件事——
//   · 跳参数「重新播种」：跳的类型由两端节点定死，改拓扑就可能把一跳从星地变成星间（或反过来）；
//   · 业务体制「移交」：载波体制落在段起点节点上，链首那份还定义这条业务的信息速率。
// 另附自动几何的一条门限口径（GSO 跳的最低仰角，见文末）。
//
// 纯数据逻辑：只改传进来的那一条链（row = { nodes, hops }），不碰界面。提示文案、选中项、
// 「输入已变」、清自动几何这些由窗口（E2eLinkBudgetApp.vue）做——抽到这里是为了能在 node 里
// 逐个情形钉住（packages/core/test/e2eChainParams.test.mjs）。
//
// 四个编辑入口的返回值：{ ok: true, sel } ＝ 改成了，sel 是改完该选中的节点下标；
// { ok: false, error } ＝ 被挡住、链一字未动，error 是窗口那边的提示键（null ＝ 不必提示）。
import {
  defaultsFor, HOP_GS_FIELDS, HOP_ISL_FIELDS, GS_SIDE_DEFAULTS,
  hopTypeOf, isSpaceHop, newHop, segmentsOf, defaultCarrier
} from './e2eParams.js'

const clone = (o) => JSON.parse(JSON.stringify(o))
const isGsType = (t) => t === 'up' || t === 'down'

// ============ 逐段体制 ============
// 每个段起点都得有一份具体的体制（面板要有值可编辑）：没有就整套照抄链首＝「和第一跳一致」。
// 只是 UI 便利——引擎侧缺了也会回落链首那份（见 e2eParams 的 buildChain）。
export function ensureSegCarriers(row) {
  if (!row || !row.nodes.length) return
  if (!row.nodes[0].carrier) row.nodes[0].carrier = defaultCarrier()
  for (const sg of segmentsOf(row.nodes)) {
    const nd = row.nodes[sg.from]
    if (nd && !nd.carrier) nd.carrier = clone(row.nodes[0].carrier)
  }
}

// 链首换了人（删掉链首 / 往链首前面接一个节点）：这条业务的定义跟着「链首」这个位置走。
// 不移交的话 ensureSegCarriers 会给新链首塞一份出厂体制——业务速率悄悄变成 2048 kbps QPSK 3/4。
//   · 新链首没有自己那份（透明星 / 刚建的节点）——它起的那一段就是原链首那一段 ⇒ 整套照抄；
//   · 新链首本来就是段起点（再生星 / 地面转接站，带着自己那份）——它起的那一段的调制编码是用户给那一段
//     定的，留着；只接过信息速率（业务定义，全程守恒），速率锚点回到信息速率：它那份锚点是当初从链首
//     照抄来的，在它自己的调制下按旧锚点一反解，速率就走样了。
function takeHeadCarrier(row, oldHead) {
  const src = oldHead && oldHead.carrier
  const nd = row.nodes[0]
  if (!src || !nd || nd === oldHead) return
  if (!nd.carrier) { nd.carrier = clone(src); return }
  nd.carrier.infoRate = src.infoRate
  nd.carrier.rateAnchor = 'info'
  nd.carrier.rateAnchorValue = null
}

// 端点卫星一律按再生类（载荷直发 / 解调结算）——与引擎 computeLinkChain 的端点归一同一口径。
// 不归一的话链路条卡片与检查器仍按透明星给「EIRPs / SFD / IBO」，引擎却按再生星取「再生下行 EIRP」：
// 屏上看的、改的那几格根本不进算式（端点卫星又不许切透明 / 再生，用户自己改不回来）。
// 删端点（剩下的那颗星成了新端点）与载入老场景时各过一遍。
export function normEndpointKinds(row) {
  const ns = (row && row.nodes) || []
  for (const i of [0, ns.length - 1]) {
    const nd = ns[i]
    if (nd && nd.kind !== 'es' && nd.kind !== 'regen') nd.kind = 'regen'
  }
}

// ============ 跳参数播种 ============
// 改完拓扑按新类型给相关跳「重新播种」：变成星间的换星间默认（23 GHz / 45 dBW / 12 dB/K / 1 dB，
// ★ 距离留空——几何全部手填，留空即报错，绝不替用户编一个数）；星地跳承接来源跳的参数。
// 不播种就会出现「星间跳挂着 14.25 GHz 上行频率」这种串味参数。
// ★ 承接分【有向】与【无向】两类：几何量（斜距 / 仰角 / 其他损耗）与方向无关，承接；频率与极化是有向的——
//   新跳与来源跳反向（链首接卫星把上行跳换成下行跳）时承接过来就是「下行跳挂着上行的 14.25 GHz/V」，
//   此时取新跳这一侧的默认值。
// ★ 来源不是星地跳（插转接站拆的是星间跳、相邻那跳是星间跳）就什么都不承接：那一跳身上的斜距 / 仰角是它
//   变成星间之前的残留，「其他损耗」是星间那一项（默认 1 dB），频率是星间频率——都不是这条星地跳的数，
//   整套取星地默认 + 本侧频率 / 极化（斜距留空，手动档由几何建议值补上）。
export function reseedHop(row, i, gs, gsFromType) {
  const h = row.hops[i]; if (!h) return
  const t = hopTypeOf(row.nodes[i], row.nodes[i + 1], h)
  if (!t) return
  if (isSpaceHop(t)) { Object.assign(h, defaultsFor(HOP_ISL_FIELDS)); return }
  const from = gs ? ((gsFromType === undefined) ? gs.fromType : gsFromType) : null
  if (!isGsType(from)) { Object.assign(h, defaultsFor(HOP_GS_FIELDS), GS_SIDE_DEFAULTS[t] || {}); return }
  h.slantRange = gs.slantRange; h.elevation = gs.elevation; h.miscLoss = gs.miscLoss
  if (from === t) { h.frequency = gs.frequency; h.polarization = gs.polarization }
  else { const d = GS_SIDE_DEFAULTS[t] || {}; h.frequency = d.frequency; h.polarization = d.polarization }
}
// 承接给新跳的星地参数 + 它的【来源跳类型】（up/down/isl/laser，由 hopTypeOf 在改拓扑前算出）
export const gsParamsOf = (h, fromType) => ({
  frequency: h.frequency, polarization: h.polarization,
  slantRange: h.slantRange, elevation: h.elevation, miscLoss: h.miscLoss, fromType
})

// ============ 四个编辑入口 ============
// 在第 hopIdx 跳中间插入节点 nd（窗口建好：站名 / 站址按语言与角色定）
export function insertNodeAt(row, hopIdx, nd) {
  const old = row && row.hops[hopIdx]
  if (!old || !nd) return { ok: false, error: null }
  const oldType = hopTypeOf(row.nodes[hopIdx], row.nodes[hopIdx + 1], old)
  // 地面转接站的入跳是星地下行、出跳是星地上行 ⇒ 只能插在星间跳上；插在星地跳上会造出
  // 「地球站 → 地球站」这种非卫星链路（引擎会直接拒绝），故这里先挡住。
  if (nd.kind === 'es' && !isSpaceHop(oldType)) return { ok: false, error: 'relayOnSpaceHop' }
  // 拆出来的两跳里，与原跳同向的那一跳全承接（另一跳必是星间跳，走星间默认）；
  // 原跳是星间跳（插转接站 / 插星）时没有星地参数可承接，新出来的星地跳按各自侧向默认播种
  const gs = isSpaceHop(oldType) ? null : gsParamsOf(old, oldType)
  row.nodes.splice(hopIdx + 1, 0, nd)
  row.hops.splice(hopIdx + 1, 0, newHop('rf'))
  reseedHop(row, hopIdx, gs, oldType); reseedHop(row, hopIdx + 1, gs, oldType)
  ensureSegCarriers(row)
  return { ok: true, sel: hopIdx + 1 }
}

// 删除第 i 个节点
export function removeNodeAt(row, i) {
  const n = row ? row.nodes.length : 0, last = n - 1
  if (!(i >= 0 && i <= last)) return { ok: false, error: null }
  if (n <= 2) return { ok: false, error: 'minNodes' }
  if (i === 0 || i === last) {
    // 端点：删它连带删相邻那一跳，链就此缩短（链端不必是地球站，故端点也可删）
    const old = row.nodes[i]
    if (i === 0) { row.nodes.splice(0, 1); row.hops.splice(0, 1) }
    else { row.nodes.splice(last, 1); row.hops.splice(last - 1, 1) }
    normEndpointKinds(row)                    // 剩下那个成了新端点：是卫星就按再生类（同引擎）
    if (i === 0) takeHeadCarrier(row, old)    // 删的是链首：业务定义交给新链首
  } else {
    // 删中间节点会把它两侧的节点接到一起——若两侧都是地球站，接出来就是「地球站直连地球站」
    // 这种非卫星链路（引擎会拒）。与插入时的前置挡同一处理哲学：当场挡住，不等点计算。
    const after = row.nodes.slice(0, i).concat(row.nodes.slice(i + 1))
    for (let k = 0; k + 1 < after.length; k++) {
      if (after[k].kind === 'es' && after[k + 1].kind === 'es') return { ok: false, error: 'esEsAfterRemove' }
    }
    // 两侧那两跳并成一跳（nodes[i−1] → nodes[i+1]），承接与合并后跳型相同的那一侧：
    //   合并成下行 ⇒ 留右侧那跳（它本来就是进这座站的下行：频率 / 极化 / 几何都是它的）；
    //   合并成上行 ⇒ 留左侧那跳；合并成星间（两星之间去掉转接站 / 中间星）⇒ 留左侧那跳，按星间默认重播。
    // 早先一律留左侧：「下行设 19.7 GHz/R → 下行上插一颗再生星 → 再删掉」，留下的是插星时已变成星间的
    // 那一跳，下行于是回到 12.5 GHz/H（其他损耗还挂着星间的 1 dB）。
    const merged = hopTypeOf(row.nodes[i - 1], row.nodes[i + 1], row.hops[i - 1])
    const keep = merged === 'down' ? i : i - 1
    const keepType = hopTypeOf(row.nodes[keep], row.nodes[keep + 1], row.hops[keep])
    const gs = gsParamsOf(row.hops[keep], keepType)
    row.nodes.splice(i, 1)
    row.hops.splice(keep === i ? i - 1 : i, 1)
    reseedHop(row, i - 1, gs, keepType)       // 接上下游后类型可能变（如两星间去掉转接站 ⇒ 星地变星间）
  }
  ensureSegCarriers(row)
  return { ok: true, sel: Math.min(i, row.nodes.length - 1) }
}

// 端点在「地球站 ⇄ 卫星」之间换型：nd 是换上去的那个节点（窗口按原端点的类型建好）。
// 切完相邻那一跳的类型会变（星地 ⇄ 星间），照例重新播种。
export function toggleEndpointAt(row, i, nd) {
  const last = row ? row.nodes.length - 1 : -1
  if (!nd || (i !== 0 && i !== last)) return { ok: false, error: null }
  const old = row.nodes[i]
  const hopIdx = (i === 0) ? 0 : last - 1
  // 端点切成地球站前先看相邻那个：也是地球站就挡住（与向外接同一条口径、同一句文案）
  if (nd.kind === 'es') {
    const nb = row.nodes[i === 0 ? 1 : last - 1]
    if (nb && nb.kind === 'es') return { ok: false, error: 'esEs' }
  }
  const oldType = hopTypeOf(row.nodes[hopIdx], row.nodes[hopIdx + 1], row.hops[hopIdx])
  const gs = gsParamsOf(row.hops[hopIdx], oldType)
  row.nodes[i] = nd
  // 体制跟着这个位置走：链首换了人，业务定义（含信息速率）不能跟着没了（新节点与原端点同起一段，整套照抄）
  if (old.carrier) nd.carrier = clone(old.carrier)
  reseedHop(row, hopIdx, gs, oldType)
  ensureSegCarriers(row)
  return { ok: true, sel: i }
}

// 端点向外接一个节点 nd：链首往前接、链尾往后接（链两端不必是地球站，故两种都可接）。
// 地球站直连地球站不是卫星链路 ⇒ 端点已是地球站时只让接卫星（菜单里也据此隐藏）。
export function extendEndAt(row, i, nd) {
  const last = row ? row.nodes.length - 1 : -1
  if (!nd || (i !== 0 && i !== last)) return { ok: false, error: null }
  const head = i === 0
  const old = row.nodes[i]
  if (nd.kind === 'es' && old.kind === 'es') return { ok: false, error: 'esEs' }
  // 相邻那一跳（承接的来源）与它的类型：在改拓扑前算好——链首接一颗星会让原本的上行跳
  // 在新跳这一侧变成下行，方向反转下频率 / 极化不能承接（见 reseedHop）
  const nearIdx = head ? 0 : row.hops.length - 1
  const near = row.hops[nearIdx]
  const nearType = near ? hopTypeOf(row.nodes[nearIdx], row.nodes[nearIdx + 1], near) : null
  const h = newHop('rf')
  if (head) { row.nodes.unshift(nd); row.hops.unshift(h) } else { row.nodes.push(nd); row.hops.push(h) }
  const hopIdx = head ? 0 : row.hops.length - 1
  // 新跳按其类型播种：星地跳承接相邻那跳的几何（频率 / 极化按侧向定），星间跳走星间默认（距离仍留空）
  reseedHop(row, hopIdx, near ? gsParamsOf(near, nearType) : null, nearType)
  // 往链首前面接：新链首接过业务定义（原链首若成了段起点，它自己那份照旧定它起的那一段）
  if (head) takeHeadCarrier(row, old)
  ensureSegCarriers(row)
  return { ok: true, sel: head ? 0 : row.nodes.length - 1 }
}

// ============ 自动几何：GSO 跳的最低仰角门限 ============
// GSO（snapshot）几何时不变，「最低仰角」对它只是一道可见性闸。这一格在手动档由真几何回填（gsoLookAngles，
// 两位小数、就近取整——可高出真值至多 0.005°），切到自动档它原样成了门限，站对星本身就被判「低于最低仰角」：
// 国内 364 座城市对 110.5°E 约一半中招（北京回填 43.46°、真值 43.4578°）。故按 0.01° 显示分辨率的一半放宽，
// 读数上相等即视为达到；NGSO 的门限决定最差斜距，不在此列。
// 放在渲染端而不改 ngsoGeometry：那边的 1e-6 容差同时服务 NGSO 弯管 / 再生式两窗的用户输入门限。
export const GSO_MIN_ELEV_TOL_DEG = 0.005
export function autoGeoMinElev(orbit, minElevDeg) {
  const v = Number(minElevDeg) || 0
  return (orbit && orbit.type === 'snapshot') ? Math.max(0, v - GSO_MIN_ELEV_TOL_DEG) : v
}
