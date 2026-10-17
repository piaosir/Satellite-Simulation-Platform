// 图上链路（STK Chain 范式，设计稿 docs/图上链路与地球站参数设计_2026-10-07.md）：星座 3D 主窗「链路」视图的组合式。
//
// 管：链路的增删改（节点 / 转发方式 / 星间激光 / 名称 / 颜色 / 显隐 / 反向）、插入态（一个插入光标：图上单击地球站 / 卫星
//     与视图里的节点选择器都往光标处插，插完光标后移；新建 = 空链 + 光标在头）、节点就地替换、选择器悬停预览、
//     每拍几何（各跳端点位置 / 仰角 / 斜距 / 可见与否）与读数、推给 3D 与平面图两个渲染器的载荷、导入链路预算的载荷。
//     Polygon / 航迹节点（2026-10-08，设计稿 docs/链路分析·航迹与Polygon节点设计_2026-10-08.md）：一个节点落成若干代表点，
//     相邻的跳画成一束子跳（最差那条全粗，其余细淡）、读数报最差与可见数；取点编辑态（pickEd：面板点表 ⇄ 图上候选点同一份选择）；
//     导入按支路展开（mapLinks.linkStrands）。代表点的几何口径与取舍规则在 packages/core/models/mapLinkPoints.mjs。
// 不管：怎么画（scene.setLinks / flat.setLinks）、怎么点中 / 选中对象（宿主把站 / 星交给 addNode / replaceNode）、
//     星历怎么解（宿主给 satEcefAt）、候选怎么列（linkPickSource.js）。
//
// 数据就是页面里的 links ref（随标记存档 globe3d/markers 落盘，形状与规范化见 packages/core/models/mapLinks.mjs）；
// 站以 id 引用标记层的地球站——站删了链路不跟着删，该节点标红、链路无效（不画、不能导入），用户改节点或删链路。Polygon / 航迹同口径。
//
// 宿主注入（host）：
//   links / stations / points  页面的三个 ref（点标记只当位置端点用）
//   polygons / trajectories    页面的 Polygon（globe3d/polygons）与航迹两个 ref
//   trajShown(id)         该航迹此刻画着载具（航迹图层与该条都开着）—— 载具代表点有载具图标标着，不另画圆点
//   nowMs()               当前计算时刻（ms；导入时载具代表点取这一刻）
//   newId()               新 id
//   commit()              推图 + 落盘（syncMarkers 那一套）
//   satEcefAt(key, tMs)   卫星此刻 ECEF（km）| null（解析不到）
//   satInfo(key)          卫星身份快照 { noradId, geo, slotLon, folder, altKm, inclDeg } | null（导入用，解析不到时沿用存档里的）
//   status(msg)           状态栏 / 日志一句话
//   undo?                 撤销接线（可缺省，缺省时行为与原来逐字相同）：{ begin(isNew), end(), edit(label, fn, key?) }
//                         begin / end 包住一次插入态（startNew / startAt → finish / cancel / 删掉那条）：宿主把整段收成一步撤销；
//                         edit 包住插入态之外的单项修改（改名 / 颜色 / 转发方式 / 激光 / 上下移 / 反向 / 取点）；key = 连发合并（取色框拖动）。
//                         插入态里的修改都算这次建链那一步，不另起。删除链路 / 节点由宿主在调用处自己包（这里不包，免得一步压两条）

import { ref, shallowRef, reactive, toRaw } from 'vue'
import { byLang } from '../../shared/i18n/lang.js'
import { linkIssues, linkTargets, hopKind, linkAutoName, reverseLink, sameNode, slotIssue, linkStrands, linkStrandCount, isAreaNode, LINK_NODES_MAX, ISSUE_TEXT, PICK_MAX } from '../../../packages/core/models/mapLinks.mjs'
import { nodeCands, tjVehicleCand, defaultPick, pickToggle, pickFamily, pickSetDiv } from '../../../packages/core/models/mapLinkPoints.mjs'
import { densifyGreatCircle } from '../../../packages/core/models/trajKinematics.mjs'
import { hopGeom, slotFit } from './linkGeom.js'
import * as W from '../wgs84.js'
import { pointFallbackName } from '../../shared/markerNames.js'
import { linkPointName, linkPointShort } from '../../shared/linkPointNames.js'

// 链路色板：饱和但不荧光，避开航迹的橙 #ff6a4a / 蓝 #5ad1ff 与可见性分析的绿；按建链次序轮换（逐条可改）
export const LINK_PALETTE = Object.freeze(['#3d8bff', '#ffb547', '#4fd18b', '#c08cff', '#ff6f91', '#e2d35c', '#2ec4b6', '#ff8a3d'])
// 链路层显示样式（随设置快照持久化）：线宽 px · 仰角门限（站星跳可见判据，缺省 0° = 几何可见）·
// 不可见跳画法 'dash' 虚线变淡 / 'hide' 不画（STK Show Line 口径）·
// 方向标记 dir：'static' 末端单箭头（出厂）/ 'flow' 末端箭头 + 线身流动虚线（可选动效）/ 'off' 不画
//   （2026-10-08 三轮定稿，取代沿线等距 V 标 —— V 标每跳一串，支路多了满屏是箭头）。
//   末端单箭头 = 专业流向图的通行画法（Jenny 等 2018，CaGIS：97 幅专业流向图凡表方向的全用箭头、几乎都只在线端一枚；
//   用户实验里箭头优于渐细线；箭头按线宽定尺寸、细线放大、别压节点）：每条（子）跳一枚，尖停在终点符号外沿；
//   汇聚束（多个代表点 → 同一颗星）只给最差那条一枚（终点同一个，各条的箭头会叠成一团）。
//   流动 = draw.io「Flow animation」/ React Flow animated edge 的口径：线身淡底 + 沿信号方向匀速走的虚线，箭头不动；
//   淡底让线照样连续（与「不可见跳」的断开虚线区分开）。不可见的跳不流动、淡一档。导出 / 出视频帧一律静止；
//   不跟系统「减少动态效果」走（流动是主动选的；Windows 关了动画效果时 Electron 恒报 reduce，跟着走就永远动不起来）。
//   画法与尺寸：3D 见 globe3d/linkLineMaterial.js（屏幕像素恒定）、2D 见 flatCoverage 的 drawLinkArrow / drawLinkDashes（同一套参数）。
// rev：样式出厂值的版本（2 = 2026-10-08 线宽 1.8 → 1.2、方向箭头 → 方向标记三档），旧存档按它迁移一次（见页面 restoreSettings）
export const LINK_STYLE_REV = 2
export const LINK_STYLE_DEF = Object.freeze({ width: 1.2, minEl: 0, blocked: 'dash', dir: 'static', rev: LINK_STYLE_REV })
// 链路的流动相位（0…1）：按 id 散列，不同链路的流动虚线错开、不齐步走
function flowPhase(id) {
  let h = 2166136261
  const s = String(id)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 997) / 997
}
export const HOP_TEXT = Object.freeze({ up: '上行', down: '下行', isl: '星间微波', laser: '星间激光' })

// 代表点缓存的内容签名：Polygon 的顶点 / 航迹的航点（经纬 / 钉高 / 钉时 / id）与运动参数逐个混进一个整数（O(点数) 的纯数值循环，
// 每拍每个节点跑一遍也只是微秒级）。撞车概率可忽略，撞了只是代表点晚一拍更新
const SIG_P = 1000000007
function geomSig(kind, o) {
  let h = 7
  const mix = (v) => { h = (h * 31 + (Number.isFinite(v) ? Math.round(v * 1e7) : -77777) % SIG_P + SIG_P) % SIG_P }
  const mixS = (s) => { const t = s == null ? '' : String(s); for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i)); mix(-1) }
  const pts = o && Array.isArray(o.pts) ? o.pts : []
  mix(pts.length)
  if (kind === 'pg') { for (const p of pts) { if (Array.isArray(p)) { mix(p[0]); mix(p[1]) } else mix(NaN) } return h + ':' + pts.length }
  for (const p of pts) { if (!p) { mix(NaN); continue } mix(p.lat); mix(p.lon); mix(p.altM); mix(p.tMs); mixS(p.id) }
  mix(o.t0Ms); mix(o.speedKmh); mix(o.cruiseAltM); mix(o.climbRateMs); mix(o.glideDeg); mixS(o.kind); mixS(o.model && o.model.id)
  return h + ':' + pts.length
}

export function useMapLinks(host) {
  const selId = ref('')                   // 检查器里展开的那一条
  // 插入态：{ id, isNew, nodes0, at, ins }；null = 不在插入态。at = 插入光标（0…节点数）：下一个节点插在第 at 位，插完 at + 1。
  // nodes0 = 进入时的节点快照（「取消」回到它；新建的整条丢掉）；ins = 本次插入态里插进去的节点（对象本身，按插入先后）——
  // 「撤销」只撤这些：在已有链路上接着加节点时，光标前那个可能是原有节点，按光标位置删就把原有的删了
  const draw = ref(null)
  const style = reactive({ ...LINK_STYLE_DEF })
  // 链路 id → { hops:[读数], state:'ok'|'part'|'bad', issues, strands, cand? }；跳读数 = { k, el, rangeKm, vis, miss, n, elMax, rMin, rMax, visN, worst }
  //   n > 1 = 多点束（el = 最低仰角、elMax = 最高、rangeKm = 最差那条的斜距、visN = 此刻可见几条、worst = 最差那条的代表点）；
  //   cand = 取点编辑器开着的那个节点：{ i, map: 候选键 → { el, rangeKm, vis, n, lat, lon, altM } }（点表逐行读数，载具行的位置随拍）
  const read = shallowRef(new Map())
  const checked = ref(new Set())          // 列表勾选（批量导入）
  // 节点选择器悬停 / 键盘停留的候选：{ id, at, rep, node?, ll? }——rep = 替换第 at 个节点（否则插在第 at 位）；
  // node = 已有的站 / 点 / 星节点，ll = { lat, lon }（城市库条目：选中才建站，预览只要位置）。null = 不预览
  const preview = shallowRef(null)
  // 取点编辑态：{ id, node }（node = 链路里那个 Polygon / 航迹节点对象本身（toRaw）——前后插删 / 上下移不丢；节点被删 / 「取消」换了一批对象即失效）
  const pickEd = shallowRef(null)
  const pickHi = ref('')                  // 编辑器点表 / 图上悬停的那个候选点键（图上加一圈高亮）
  // 撤销接线（见文件头 host.undo）
  const U = host.undo || null
  const undoBegin = (isNew) => { if (U && U.begin) U.begin(isNew) }
  const undoEnd = () => { if (U && U.end) U.end() }
  const edit = (label, fn, key) => (U && U.edit && !draw.value ? U.edit(label, fn, key) : fn())

  const list = () => host.links.value
  const linkOf = (id) => list().find((l) => l.id === id) || null
  function stMap() { const m = new Map(); for (const s of host.stations.value) if (s && s.id != null) m.set(String(s.id), s); return m }
  // 点标记：id → { 点, 序号 }（没起名的点按兜底名「点标记N / Point N」称呼，见 shared/markerNames.js）
  function ptMap() {
    const m = new Map(), arr = (host.points && host.points.value) || []
    arr.forEach((p, i) => { if (p && p.id != null) m.set(String(p.id), { p, i }) })
    return m
  }
  // Polygon / 航迹：'pg:<id>' | 'tj:<id>' → 对象
  function areaMap() {
    const m = new Map()
    for (const p of ((host.polygons && host.polygons.value) || [])) if (p && p.id != null) m.set('pg:' + p.id, p)
    for (const t of ((host.trajectories && host.trajectories.value) || [])) if (t && t.id != null) m.set('tj:' + t.id, t)
    return m
  }
  const areaKey = (n) => n.k + ':' + n.id
  const ptName = (e) => (e ? (String(e.p.name || '').trim() || pointFallbackName(e.i)) : '')
  const areaName = (n, o) => (o ? (String(o.name || '').trim() || (n.k === 'pg' ? 'Polygon' : '')) : '')
  function ctxOf(m, pmIn, amIn) {
    const sm = m || stMap(), pm = pmIn || ptMap(), am = amIn || areaMap()
    return {
      hasStation: (id) => sm.has(String(id)),
      hasPoint: (id) => pm.has(String(id)),
      satOk: (n) => !!(n && n.key),
      area: (n) => am.get(areaKey(n)) || null,
      station: (id) => sm.get(String(id)) || null,
      point: (id) => { const e = pm.get(String(id)); return e ? { name: ptName(e), lat: e.p.lat, lon: e.p.lon } : null },
      nameOf: (n) => (n.k === 'st' ? ((sm.get(String(n.id)) || {}).name || '') : n.k === 'pt' ? ptName(pm.get(String(n.id))) : isAreaNode(n) ? areaName(n, am.get(areaKey(n))) : n.name)
    }
  }
  const nodeName = (n, sm) => ctxOf(sm).nameOf(n) || (n.k === 'sat' ? (n.name || '?') : '')
  function nameOf(l, sm) {
    if (!l) return ''
    if (l.nameAuto === false && String(l.name || '').trim()) return l.name
    return linkAutoName(l, ctxOf(sm).nameOf)
  }
  function nextColor() {
    const used = new Set(list().map((l) => l.color))
    return LINK_PALETTE.find((c) => !used.has(c)) || LINK_PALETTE[list().length % LINK_PALETTE.length]
  }
  /** Polygon / 航迹 → 链路节点（带缺省取点：Polygon 取质心，航迹运动档取载具、静止档取航点）；对象不存在返回 null */
  function areaNode(k, id) {
    const o = areaMap().get(k + ':' + id)
    return o ? { k, id: o.id, pick: defaultPick(k, o) } : null
  }

  // ---- 代表点（Polygon / 航迹节点）----
  // 不随时刻变的候选点（Polygon 全部；航迹的航点 + 等分点）按「对象内容签名 + 取点」缓存；航迹载具逐拍现算
  let _cand = new Map()   // 'pg:<id>' | 'tj:<id>' → { sig, pk, list }
  function staticCands(n, o) {
    const key = areaKey(n), sig = geomSig(n.k, o), pk = JSON.stringify(n.pick || null)
    const c = _cand.get(key)
    if (c && c.sig === sig && c.pk === pk) return c.list
    if (_cand.size > 400) _cand = new Map()
    const lst = nodeCands(n.k, o, n.pick, NaN, null, { noVeh: true })
    _cand.set(key, { sig, pk, list: lst })
    return lst
  }
  /** 节点的全部候选点（含没取的；航迹载具按 tMs）；n 不是 Polygon / 航迹或对象没了返回 [] */
  function candsOf(n, o, tMs) {
    if (!o || !isAreaNode(n)) return []
    const st = staticCands(n, o)
    if (n.k !== 'tj') return st
    const v = tjVehicleCand(o, n.pick, tMs)
    return v ? [v, ...st] : st
  }

  // ---- 插入态 ----
  /** 新建一条并进入插入态；first = 起点节点（右键「从此站 / 此卫星新建链路」），可空 */
  function startNew(first) {
    if (draw.value) finish()
    undoBegin(true)   // 这一整次建链（到完成 / 取消）收成一步撤销
    const l = { id: host.newId(), name: '', nameAuto: true, color: nextColor(), nodes: [] }
    if (first) l.nodes.push(first)
    list().push(l)
    selId.value = l.id
    draw.value = { id: l.id, isNew: true, nodes0: [], at: l.nodes.length, ins: first ? [first] : [] }   // 新建：起点也是这次加的
    host.commit()
    return l.id
  }
  /**
   * 在已有链路的第 at 位进入插入态（缺省 = 末尾，即 STK Extend）。同一条已在插入态：只挪光标，
   * 不重拍进入时的快照（「取消」仍回到最初）；另一条在插入态：先把那条收尾（同「完成」）。
   */
  function startAt(id, at) {
    const l = linkOf(id); if (!l) return
    const n = l.nodes.length
    const k = Number.isInteger(at) ? Math.max(0, Math.min(n, at)) : n
    const d = draw.value
    if (d && d.id === id) { if (d.at !== k) draw.value = { ...d, at: k }; return }
    if (d) finish()
    undoBegin(false)
    selId.value = id
    draw.value = { id, isNew: false, nodes0: JSON.parse(JSON.stringify(l.nodes)), at: k, ins: [] }
    host.commit()
  }
  /** 插入光标在链路 id 上的位置；不在插入态（或在别的链路上）返回 -1 */
  function cursorOf(id) {
    const d = draw.value
    if (!d || d.id !== id) return -1
    const l = linkOf(id)
    return l ? Math.max(0, Math.min(l.nodes.length, d.at)) : -1
  }
  // 往链路 l 的第 at 位插一个节点；返回 '' = 成功，否则为不插的原因（与相邻节点同口径判，见 mapLinks.slotIssue）
  function insertAt(l, at, node) {
    const k = Math.max(0, Math.min(l.nodes.length, at))
    if (l.nodes.length >= LINK_NODES_MAX) return '节点数已达上限'
    const code = slotIssue(l.nodes[k - 1] || null, node, l.nodes[k] || null)
    if (code) return ISSUE_TEXT[code] || ''
    l.nodes.splice(k, 0, node)
    host.commit()
    return ''
  }
  /** 往插入光标处插一个节点（图上点选 / 选择器共用），插完光标后移；返回 '' = 成功，否则为不插的原因（状态栏报） */
  function addNode(node) {
    const d = draw.value, l = d ? linkOf(d.id) : null
    if (!l || !node) return ''
    const at = Math.max(0, Math.min(l.nodes.length, d.at))
    const why = insertAt(l, at, node)
    if (!why) draw.value = { ...d, at: at + 1, ins: [...insOf(d), node] }
    return why
  }
  // 本次插入态插进去、且此刻还在链路里的节点下标（最后插的那个在末尾）。按对象认（toRaw 两边对齐：存进响应式数组的是原对象，
  // 读出来是代理）；被「删除该节点」删掉的自然不在了，被「更换」换掉的已由 replaceNode 把记录换成新节点
  const insOf = (d) => (d && Array.isArray(d.ins) ? d.ins : [])
  function insIdx(d, l) {
    const raw = l.nodes.map((n) => toRaw(n))
    const out = []
    for (const n of insOf(d)) { const i = raw.indexOf(toRaw(n)); if (i >= 0) out.push(i) }
    return out
  }
  /** 插入态里有没有可撤销的节点（横幅「撤销」/ 右键「撤销上一节点」据此置灰） */
  function canUndo() {
    const d = draw.value, l = d ? linkOf(d.id) : null
    return !!l && insIdx(d, l).length > 0
  }
  /**
   * 撤销：删掉【本次插入态里】最后插进去、且还在链路里的那个节点，光标回到它原来那道缝（接着往这一位插）。
   * 进入插入态之前就有的节点一个都不碰 —— 没有可撤销的就什么也不做
   */
  function undoNode() {
    const d = draw.value, l = d ? linkOf(d.id) : null
    if (!l) return
    const idx = insIdx(d, l)
    if (!idx.length) return
    const i = idx[idx.length - 1], gone = toRaw(l.nodes[i])
    l.nodes.splice(i, 1)
    draw.value = { ...d, at: i, ins: insOf(d).filter((n) => toRaw(n) !== gone) }
    host.commit()
  }
  /**
   * 就地替换第 i 个节点（选择器「更换」）；返回 '' = 成功，否则为不换的原因。换成自己什么也不做。
   * 转发方式 / 星间激光是这一位的属性：卫星换卫星时留下，换成地面端随旧节点去掉。Polygon / 航迹换上来的用它自带的缺省取点。
   */
  function replaceNode(id, i, node) {
    const l = linkOf(id), old = l && l.nodes[i]
    if (!old || !node || sameNode(old, node)) return ''
    const code = slotIssue(l.nodes[i - 1] || null, node, l.nodes[i + 1] || null)
    if (code) return ISSUE_TEXT[code] || ''
    if (node.k === 'sat' && old.k === 'sat') { if (old.regen) node.regen = true; if (old.laser) node.laser = true }
    l.nodes.splice(i, 1, node)
    // 换掉的是本次插进去的节点：这一位仍算本次加的（撤销撤掉换上来的这个）；换原有节点不进撤销（「取消」才回到进入前）
    const d = draw.value, o = toRaw(old)
    if (d && d.id === id && insOf(d).some((n) => toRaw(n) === o)) draw.value = { ...d, ins: insOf(d).map((n) => (toRaw(n) === o ? node : n)) }
    host.commit()
    return ''
  }
  /** 完成：新建的不足两个节点就整条丢掉（同航迹「结束描绘」口径）；接着点的保留现状 */
  function finish() {
    const d = draw.value
    if (!d) return
    const l = linkOf(d.id)
    draw.value = null
    if (l && d.isNew && l.nodes.length < 2) remove(l.id)
    else host.commit()
    undoEnd()
  }
  /** 取消：新建的整条丢掉；接着点的恢复到进入建链态之前 */
  function cancel() {
    const d = draw.value
    if (!d) return
    const l = linkOf(d.id)
    draw.value = null
    if (l && d.isNew) remove(l.id)
    else { if (l) l.nodes = d.nodes0; host.commit() }
    undoEnd()
  }

  // ---- 列表 / 检查器 ----
  function remove(id) {
    if (draw.value && draw.value.id === id) { draw.value = null; undoEnd() }
    if (pickEd.value && pickEd.value.id === id) closePick()
    host.links.value = list().filter((l) => l.id !== id)
    if (selId.value === id) selId.value = ''
    if (checked.value.has(id)) { const s = new Set(checked.value); s.delete(id); checked.value = s }
    host.commit()
  }
  function removeNode(id, i) {
    const l = linkOf(id)
    if (!l || !l.nodes[i]) return
    const pe = pickEd.value
    if (pe && pe.id === id && toRaw(l.nodes[i]) === pe.node) closePick()
    l.nodes.splice(i, 1)
    const d = draw.value   // 删的在插入光标之前：光标跟着前移，仍指着原来那道缝
    if (d && d.id === id && i < d.at) draw.value = { ...d, at: d.at - 1 }
    host.commit()
  }
  function moveNode(id, i, dir) {
    const l = linkOf(id), j = i + dir
    if (!l || j < 0 || j >= l.nodes.length) return
    edit(byLang('已调整节点顺序', 'Node order changed'), () => {
      const t = l.nodes[i]; l.nodes[i] = l.nodes[j]; l.nodes[j] = t
      host.commit()
    })
  }
  function setRegen(id, i, on) { const l = linkOf(id), n = l && l.nodes[i]; if (n && n.k === 'sat') edit(byLang('已修改转发方式', 'Relay mode changed'), () => { if (on) n.regen = true; else delete n.regen; host.commit() }) }
  function setLaser(id, i, on) { const l = linkOf(id), n = l && l.nodes[i]; if (n && n.k === 'sat') edit(byLang('已修改星间链路类型', 'Inter-satellite link type changed'), () => { if (on) n.laser = true; else delete n.laser; host.commit() }) }
  /** 改名：空串 = 交还自动命名 */
  function rename(id, v) {
    const l = linkOf(id); if (!l) return
    const t = String(v == null ? '' : v).trim()
    edit(byLang('已修改链路名称', 'Link renamed'), () => {
      if (t) { l.name = t; l.nameAuto = false } else { l.name = ''; l.nameAuto = true }
      host.commit()
    })
  }
  // 取色框拖动连发 input：按链路合并成一步（key）
  function setColor(id, c) { const l = linkOf(id); if (l && /^#[0-9a-fA-F]{6}$/.test(c)) edit(byLang('已修改链路颜色', 'Link color changed'), () => { l.color = c; host.commit() }, 'lkc:' + id) }
  function toggleShow(id) { const l = linkOf(id); if (!l) return; if (l.show === false) delete l.show; else l.show = false; host.commit() }
  /** 全部隐藏（右键「隐藏所有链路」）：同 toggleShow 逐条置 show=false，数据保留，可在列表逐条重新打开 */
  function hideAll() { for (const l of list()) l.show = false; host.commit() }
  /** 生成反向链路（用户主动点的复制操作；双向 = 两条独立链路） */
  function reverse(id) {
    const l = linkOf(id); if (!l) return ''
    const r = reverseLink(l, host.newId)
    r.color = nextColor()
    edit(byLang('已生成反向链路', 'Reverse link created'), () => {
      list().push(r)
      selId.value = r.id
      host.commit()
    })
    return r.id
  }
  function toggleCheck(id) { const s = new Set(checked.value); if (s.has(id)) s.delete(id); else s.add(id); checked.value = s }
  function setAllChecked(on) { checked.value = on ? new Set(list().map((l) => l.id)) : new Set() }

  // ---- 取点编辑（Polygon / 航迹节点）----
  /** 编辑器开着的那个节点的下标；没开 / 节点已不在返回 -1 */
  function pickIdx() {
    const e = pickEd.value, l = e ? linkOf(e.id) : null
    if (!l) return -1
    return l.nodes.findIndex((n) => toRaw(n) === e.node)
  }
  function openPick(id, i) {
    const l = linkOf(id), n = l && l.nodes[i]
    if (!n || !isAreaNode(n)) return
    pickEd.value = { id, node: toRaw(n) }
    pickHi.value = ''
  }
  function closePick() { if (pickEd.value) { pickEd.value = null; pickHi.value = '' } }
  function togglePick(id, i) { if (pickEd.value && pickEd.value.id === id && pickIdx() === i) closePick(); else openPick(id, i) }
  /** 编辑器开着的节点：{ l, i, n, o } | null */
  function pickCur() {
    const e = pickEd.value, l = e ? linkOf(e.id) : null, i = pickIdx()
    if (!l || i < 0) return null
    const n = l.nodes[i], o = areaMap().get(areaKey(n)) || null
    return o ? { l, i, n, o } : null
  }
  function editPick(fn) {
    const c = pickCur()
    if (!c) return
    edit(byLang('已修改取点', 'Sample points changed'), () => {
      c.n.pick = fn(c.n.k, c.o, c.n.pick)
      host.commit()
    })
  }
  /** 逐点取舍（点表一行 / 图上一个候选点） */
  function pickKey(key) { editPick((k, o, p) => pickToggle(k, o, p, key)) }
  /** 整族取舍：fam = 'c' | 'veh' | 'v' | 'w' | 'd' */
  function pickFam(fam, on) { editPick((k, o, p) => pickFamily(k, o, p, fam, on)) }
  /** 改等分点数 */
  function pickDiv(n) { editPick((k, o, p) => pickSetDiv(k, o, p, n)) }
  /** 编辑器开着的节点此刻的全部候选点（点表 / 图上点选命中用）：{ kind, list, obj } | null */
  function pickCands(tMs) {
    const c = pickCur()
    if (!c) return null
    return { kind: c.n.k, obj: c.o, list: candsOf(c.n, c.o, tMs) }
  }

  // ---- 每拍几何 ----
  /**
   * 算一拍：更新读数 read，返回 { scene, flat } 两份渲染载荷。
   * scene = [{ id, color, width, sel, dir, ph, hops:[{ a:{lat,lon,altKm}, b:{lat,lon,altKm}, vis, thin?, e, de, s }], sats:[{lat,lon,altKm}], gpts:[…], cands:[…] }]
   *   s  = 跳的起点身份（同 e 的口径；3D 跟随视图的近场链路从起点符号外沿起画）
   * flat  = [{ id, color, width, sel, dir, ph, hops:[{ pts:[[lon,lat]…], vis, thin?, e, de }], sats:[{lon,lat}], gpts:[{lon,lat}], cands:[{lon,lat,sel,hi}] }]
   *   e  = 跳的终点身份 { k:'st'|'pt'|'veh', id } | { k:'sat', key } | { k:'gp' }（箭头尖停在它的符号外沿，见 endOf）；de = 这条画不画末端箭头
   *   dir = 方向标记 'static' | 'flow' | 'off'（见 LINK_STYLE_DEF）；ph = 流动相位（0…1，不同链路错开）
   *   thin  = 多点束里不是最差的那些子跳（细一档、淡一档）；gpts = Polygon / 航迹取到的代表点；
   *   cands = 取点编辑器开着时该节点的全部候选点（sel 已取 / hi 悬停），链路隐藏 / 无效时也画（不然取不回点）
   */
  // 端点：站 / 点 = 地面点；星 = 此刻 ECEF → 大地坐标；Polygon / 航迹 = 取到的各代表点（飞行航迹带高度）。解析不到 = 空数组（该节点相邻的跳不画）。
  // 形状 { lat, lon, altKm, ecef, st, ground, key?, cand? }：st 给渲染载荷分站 / 星，ground 是 linkGeom 的口径（两者同值）
  function groundPos(lat, lon, altKm) {
    const h = Number.isFinite(altKm) ? altKm : 0
    return { lat, lon, altKm: h, ecef: W.geodeticToEcef(lon, lat, h), st: true, ground: true }
  }
  function endsIn(n, sm, pm, am, tMs) {
    if (!n) return []
    if (n.k === 'st') {
      const s = sm.get(String(n.id))
      return s && Number.isFinite(s.lat) && Number.isFinite(s.lon) ? [groundPos(s.lat, s.lon)] : []
    }
    if (n.k === 'pt') {
      const e = pm.get(String(n.id)), p = e && e.p
      return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? [groundPos(p.lat, p.lon)] : []
    }
    if (isAreaNode(n)) {
      const o = am.get(areaKey(n))
      if (!o) return []
      const cs = candsOf(n, o, tMs).filter((c) => c.sel)
      if (cs.length > PICK_MAX) return []
      return cs.map((c) => ({ ...groundPos(c.lat, c.lon, c.altM / 1000), key: c.key, cand: c }))
    }
    const e = host.satEcefAt(n.key, tMs)
    if (!e) return []
    const g = W.ecefToGeodetic(e[0], e[1], e[2])
    return [{ lat: g.lat, lon: g.lon, altKm: g.h, ecef: e, st: false, ground: false }]
  }
  /** 单个节点此刻的端点（节点选择器算候选与相邻节点的几何用）：站 / 点 / 星 = 那一个；Polygon / 航迹 = 第一个代表点（要全部用 nodeEnds） */
  function nodePos(n, tMs) { const a = endsIn(n, stMap(), ptMap(), areaMap(), tMs); return a[0] || null }
  /** 单个节点此刻的全部端点（Polygon / 航迹 = 取到的各代表点） */
  function nodeEnds(n, tMs) { return endsIn(n, stMap(), ptMap(), areaMap(), tMs) }

  // 一跳的一束子跳 → 读数与最差那条（仰角最低；同仰角取斜距远的；没有仰角的星间跳取斜距最远）
  function bundle(A, B, minEl) {
    const subs = []
    const multiA = A.length > 1
    for (const a of A) for (const b of B) { const m = multiA ? a : b; subs.push({ a, b, g: hopGeom(a, b, minEl), cand: m.cand || null }) }
    let w = 0, visN = 0, elMin = Infinity, elMax = -Infinity, rMin = Infinity, rMax = -Infinity
    subs.forEach((s, j) => {
      const g = s.g
      if (g.vis) visN++
      if (g.el != null) { if (g.el < elMin) elMin = g.el; if (g.el > elMax) elMax = g.el }
      if (g.rangeKm < rMin) rMin = g.rangeKm
      if (g.rangeKm > rMax) rMax = g.rangeKm
      if (!j) return
      const gw = subs[w].g
      const worse = g.el != null && gw.el != null ? (g.el < gw.el || (g.el === gw.el && g.rangeKm > gw.rangeKm)) : g.rangeKm > gw.rangeKm
      if (worse) w = j
    })
    return { subs, w, visN, el: Number.isFinite(elMin) ? elMin : null, elMax: Number.isFinite(elMax) ? elMax : null, rMin, rMax }
  }
  const gcPts = (a, b) => { const pts = densifyGreatCircle([{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }], 1); return (pts && pts.length >= 2 ? pts : [a, b]).map((p) => [p.lon, p.lat]) }
  // 跳的终点身份 e（渲染器按它把箭头尖停在终点符号的外沿）：站 / 点 = 按 id 查图上那枚符号；Polygon / 航迹的代表点 = 链路小圆点，
  // 其中载具代表点且载具图标画着 = 载具图标（id = 航迹 id）；卫星 = 链路小圆点，带身份键 key（3D 按它认这颗星画没画模型图标、
  // 画着就让图标的包围圆，见 scene.linkEndTip）。n 缺省（预览里城市库的就地位置）按端点认
  const endOf = (n, p) => {
    if (n && (n.k === 'st' || n.k === 'pt')) return { k: n.k, id: String(n.id) }
    if (n && isAreaNode(n)) return p && p.key === 'veh' && host.trajShown && host.trajShown(n.id) ? { k: 'veh', id: String(n.id) } : { k: 'gp' }
    return p && p.st ? { k: 'gp' } : { k: 'sat', key: n && n.k === 'sat' && n.key ? String(n.key) : '' }
  }
  const linkDir = () => (style.dir === 'flow' || style.dir === 'off' ? style.dir : 'static')

  function compute(tMs) {
    const sm = stMap(), pm = ptMap(), am = areaMap(), ctx = ctxOf(sm, pm, am)
    const rd = new Map(), sc = [], fl = []
    const minEl = Number(style.minEl) || 0
    const dId = draw.value ? draw.value.id : ''
    const pe = pickEd.value
    const endsOf = (n) => endsIn(n, sm, pm, am, tMs)
    for (const l of list()) {
      const P = l.nodes.map(endsOf)
      // 卫星节点「解析得到」= 此刻算得出位置（星历没载入 / 合成星已删 → 标红）
      const issues = linkIssues(l, { ...ctx, satOk: (n) => { const i = l.nodes.indexOf(n); return i >= 0 && P[i].length > 0 } })
      const hops = []
      let allVis = true
      for (let i = 0; i < l.nodes.length - 1; i++) {
        const k = hopKind(l.nodes[i], l.nodes[i + 1]), A = P[i], B = P[i + 1]
        if (!k || !A.length || !B.length) { hops.push({ k, miss: true }); allVis = false; continue }
        if (A.length === 1 && B.length === 1) {
          const g = hopGeom(A[0], B[0], minEl)
          if (!g.vis) allVis = false
          hops.push({ k, n: 1, el: g.el, rangeKm: g.rangeKm, vis: g.vis, a: A[0], b: B[0] })
          continue
        }
        const bu = bundle(A, B, minEl)
        if (bu.visN < bu.subs.length) allVis = false
        hops.push({ k, n: bu.subs.length, el: bu.el, elMax: bu.elMax, rangeKm: bu.subs[bu.w].g.rangeKm, rMin: bu.rMin, rMax: bu.rMax, vis: bu.visN === bu.subs.length, visN: bu.visN, worst: bu.subs[bu.w].cand, bu })
      }
      const entry = {
        hops: hops.map((h) => ({ k: h.k, el: h.el, rangeKm: h.rangeKm, vis: !!h.vis, miss: !!h.miss, n: h.n || 0, elMax: h.elMax, rMin: h.rMin, rMax: h.rMax, visN: h.visN, worst: h.worst || null })),
        state: issues.length ? 'bad' : (allVis ? 'ok' : 'part'),
        issues,
        strands: issues.length ? 0 : linkStrandCount(l, ctx)
      }
      rd.set(l.id, entry)
      // 取点编辑器开着的节点：全部候选点（逐个按「放在这一位」与相邻卫星算读数）+ 图上候选点层
      let c3 = null, c2 = null
      if (pe && pe.id === l.id) {
        const ci = l.nodes.findIndex((n) => toRaw(n) === pe.node)
        const cn = ci >= 0 ? l.nodes[ci] : null
        const co = cn && isAreaNode(cn) ? am.get(areaKey(cn)) : null
        if (co) {
          const one = (arr) => (arr && arr.length === 1 && !arr[0].ground ? arr[0] : null)   // 相邻的卫星端点（Polygon / 航迹两侧只会是星或空）
          const prev = one(P[ci - 1]), next = one(P[ci + 1])
          const map = new Map()
          c3 = []; c2 = []
          for (const c of candsOf(cn, co, tMs)) {
            const f = slotFit(prev, groundPos(c.lat, c.lon, c.altM / 1000), next, minEl)
            map.set(c.key, { el: f.el, rangeKm: f.rangeKm, vis: f.vis, n: f.n, lat: c.lat, lon: c.lon, altM: c.altM })
            const hi = c.key === pickHi.value
            c3.push({ lat: c.lat, lon: c.lon, altKm: c.altM / 1000, sel: !!c.sel, hi })
            c2.push({ lon: c.lon, lat: c.lat, sel: !!c.sel, hi })
          }
          entry.cand = { i: ci, map }
        }
      }
      // 画：隐藏的链路不画；无效的只在建链中画（正在点的那条边点边看）；编辑器的候选点照画
      const sel = l.id === selId.value || l.id === dId
      const drawn = l.show !== false && (!issues.length || l.id === dId)
      if (!drawn && !c3) continue
      const s3 = { id: l.id, color: l.color || LINK_PALETTE[0], width: Number(style.width) || LINK_STYLE_DEF.width, sel, dir: linkDir(), ph: flowPhase(l.id), hops: [], sats: [], gpts: [], cands: c3 || [] }
      const s2 = { id: l.id, color: s3.color, width: s3.width, sel, dir: s3.dir, ph: s3.ph, hops: [], sats: [], gpts: [], cands: c2 || [] }
      if (drawn) {
        hops.forEach((h, i) => {
          if (h.miss) return
          const sn = l.nodes[i], en = l.nodes[i + 1]
          if (h.n === 1) {
            if (!h.vis && style.blocked === 'hide') return
            const e = endOf(en, h.b)
            // s = 起点身份（3D 跟随视图局部那一趟画在起点符号之上，线芯从起点符号外沿起画，见 scene.setLinks）
            s3.hops.push({ a: { lat: h.a.lat, lon: h.a.lon, altKm: h.a.altKm }, b: { lat: h.b.lat, lon: h.b.lon, altKm: h.b.altKm }, vis: h.vis, e, de: true, s: endOf(sn, h.a) })
            s2.hops.push({ pts: gcPts(h.a, h.b), vis: h.vis, e, de: true })
            return
          }
          // 多点束：最差那条按链路样式全粗，其余细淡；最差那条排在最后（压在束上面）。
          // 箭头：汇聚束（多个代表点 → 同一颗星）终点同一个，只给最差那条一枚（各条的箭头会在星点前叠成一团）；
          // 发散束（星 → 多个代表点）终点各不相同，每条一枚
          const conv = P[i + 1].length === 1
          const order = h.bu.subs.map((s, j) => j).filter((j) => j !== h.bu.w).concat([h.bu.w])
          for (const j of order) {
            const s = h.bu.subs[j]
            if (!s.g.vis && style.blocked === 'hide') continue
            const thin = j !== h.bu.w, e = endOf(en, s.b), de = !(thin && conv)
            s3.hops.push({ a: { lat: s.a.lat, lon: s.a.lon, altKm: s.a.altKm }, b: { lat: s.b.lat, lon: s.b.lon, altKm: s.b.altKm }, vis: s.g.vis, thin, e, de, s: endOf(sn, s.a) })
            s2.hops.push({ pts: gcPts(s.a, s.b), vis: s.g.vis, thin, e, de })
          }
        })
        P.forEach((arr, i) => {
          const n = l.nodes[i]
          for (const p of arr) {
            if (!p.st) { s3.sats.push({ lat: p.lat, lon: p.lon, altKm: p.altKm }); s2.sats.push({ lon: p.lon, lat: p.lat }); continue }
            if (!isAreaNode(n)) continue
            if (p.key === 'veh' && host.trajShown && host.trajShown(n.id)) continue   // 载具有载具图标标着
            s3.gpts.push({ lat: p.lat, lon: p.lon, altKm: p.altKm }); s2.gpts.push({ lon: p.lon, lat: p.lat })
          }
        })
      }
      sc.push(s3); fl.push(s2)
    }
    // 选择器预览：候选放进该位后与前后邻的跳，画成虚线（同「不可见跳」的画法，一眼分得出是还没放进去的）、不加粗；
    // 候选是星就带它的圆点（检索出来的编目星不一定在图上）；Polygon / 航迹候选按缺省取点的各代表点各画一束。
    // 不进读数；正在给这条挑节点，链路隐藏着也照画
    const pv = preview.value, pl = pv ? linkOf(pv.id) : null
    if (pl) {
      const ns = pl.nodes, at = Math.max(0, Math.min(ns.length, pv.at))
      const cs = pv.node ? endsOf(pv.node) : (pv.ll && Number.isFinite(pv.ll.lat) && Number.isFinite(pv.ll.lon) ? [groundPos(pv.ll.lat, pv.ll.lon)] : [])
      if (cs.length) {
        // 预览是「还没放进去」的虚线：方向标只给静止的，不流动（悬停一下就满屏在动太吵）
        const g3 = { id: pl.id + ':pv', color: pl.color || LINK_PALETTE[0], width: Number(style.width) || LINK_STYLE_DEF.width, sel: false, dir: linkDir() === 'off' ? 'off' : 'static', ph: 0, hops: [], sats: [], gpts: [], cands: [] }
        const g2 = { id: g3.id, color: g3.color, width: g3.width, sel: false, dir: g3.dir, ph: 0, hops: [], sats: [], gpts: [], cands: [] }
        const seg = (a, b, nb, na) => {
          if (!a || !b || (a.st && b.st)) return
          const e = endOf(nb, b)
          g3.hops.push({ a: { lat: a.lat, lon: a.lon, altKm: a.altKm }, b: { lat: b.lat, lon: b.lon, altKm: b.altKm }, vis: false, e, de: true, s: endOf(na, a) })
          g2.hops.push({ pts: gcPts(a, b), vis: false, e, de: true })
        }
        const nBefore = ns[at - 1] || null, nAfter = (pv.rep ? ns[at + 1] : ns[at]) || null
        const before = endsOf(nBefore), after = endsOf(nAfter)
        for (const c of cs) {
          for (const a of before) seg(a, c, pv.node || null, nBefore)
          for (const b of after) seg(c, b, nAfter, pv.node || null)
          if (!c.st) { g3.sats.push({ lat: c.lat, lon: c.lon, altKm: c.altKm }); g2.sats.push({ lon: c.lon, lat: c.lat }) }
          else if (pv.node && isAreaNode(pv.node)) { g3.gpts.push({ lat: c.lat, lon: c.lon, altKm: c.altKm }); g2.gpts.push({ lon: c.lon, lat: c.lat }) }
        }
        sc.push(g3); fl.push(g2)
      }
    }
    read.value = rd
    return { scene: sc, flat: fl }
  }

  // ---- 导入链路预算 ----
  // 导入用的上下文：Polygon / 航迹节点按 tMs 取代表点，落成「对象名·代表点」的地面端（航迹点带实际高度）
  function importCtx(tMs) {
    const sm = stMap(), pm = ptMap(), am = areaMap(), ctx = ctxOf(sm, pm, am)
    return {
      ...ctx,
      points: (n) => {
        const o = am.get(areaKey(n))
        if (!o) return []
        const nm = areaName(n, o)
        return candsOf(n, o, tMs).filter((c) => c.sel).map((c) => ({
          name: linkPointName(nm, n.k, c), label: linkPointShort(n.k, c), lat: c.lat, lon: c.lon,
          ...(n.k === 'tj' ? { altM: c.altM } : {})
        }))
      }
    }
  }
  const importNow = () => (host.nowMs ? Number(host.nowMs()) : Date.now())
  /** 各目标可导入几条链路 / 共几条支路（ids = 要导入的链路；空 = 勾选的）：{ linkbudget, ngso, regen, e2e, rows:{ 同四键 } } */
  function targetCounts(ids) {
    const want = ids && ids.length ? new Set(ids) : checked.value
    const ctx = ctxOf()
    const n = { linkbudget: 0, ngso: 0, regen: 0, e2e: 0 }, rows = { linkbudget: 0, ngso: 0, regen: 0, e2e: 0 }
    for (const l of list()) {
      if (!want.has(l.id)) continue
      const t = linkTargets(l, ctx), s = linkStrandCount(l, ctx)
      for (const k of Object.keys(n)) if (t[k]) { n[k]++; rows[k] += s }
    }
    return { ...n, rows }
  }
  /**
   * 导入载荷：先用宿主现解的身份快照刷新各星节点（导入时总拿最新的定点经度 / 天线树关联），再按 kind 过滤可导入的，
   * 按支路展开（mapLinks.linkStrands：Polygon / 航迹节点每个代表点一条；载具代表点取此刻位置）。
   * 返回 { list:[单点载荷…], skipped:跳过几条链路, links:导入几条链路 }
   */
  function payloads(kind, ids) {
    const want = ids && ids.length ? new Set(ids) : checked.value
    const ctx = importCtx(importNow())
    const out = []
    let skipped = 0, links = 0, touched = false
    for (const l of list()) {
      if (!want.has(l.id)) continue
      for (const n of l.nodes) {
        if (n.k !== 'sat') continue
        const inf = host.satInfo(n.key)
        if (inf) { n.info = inf; touched = true }
      }
      if (!linkTargets(l, ctx)[kind]) { skipped++; continue }
      const ss = linkStrands(l, ctx)
      if (!ss.length) { skipped++; continue }
      for (const p of ss) out.push(JSON.parse(JSON.stringify(p)))
      links++
    }
    if (touched) host.commit()
    return { list: out, skipped, links }
  }

  return {
    selId, draw, style, read, checked, preview, pickEd, pickHi,
    linkOf, nameOf, nodeName, stMap, nodePos, nodeEnds, areaNode, candsOf,
    startNew, startAt, cursorOf, addNode, undoNode, canUndo, replaceNode, finish, cancel,
    remove, removeNode, moveNode, setRegen, setLaser, rename, setColor, toggleShow, hideAll, reverse, toggleCheck, setAllChecked,
    pickIdx, openPick, closePick, togglePick, pickCur, pickKey, pickFam, pickDiv, pickCands,
    compute, targetCounts, payloads
  }
}
