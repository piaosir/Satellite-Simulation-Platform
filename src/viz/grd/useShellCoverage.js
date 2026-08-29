// 对星覆盖分析 —— 波束打在【轨道壳层】上，而不是打在地球上。
//
// 与对地覆盖（useGrdCoverage）的分工，改这里之前先弄清：
//   · 卫星 / 天线 / 波束【树】与【全部天线设置】（指向、极化、增益、路损、电平档、填充、Beams To Plot、
//     显示选项）两个视图共用同一份 —— 一律经 grd.getPerfContext(key).settings 现取，本文件不自己存一份。
//     面板上的控件也直接绑 grd.s（对地那份编辑态），所以两边逻辑逐字一致，改哪边都同步。
//   · 本视图独有的只有三样：画哪些天线（selected）、轨道壳层库（shells）、遮挡排除高度 / 参照网。
//
// 几何走参数域（见 shellProj.js 文件头）：bandGeometry 直接吃 gridXY 的 (X,Y)，切出来的顶点再逐壳投影。
// 2D 平面地图（flatView）另走一条【对地投影】：同一批波束按对地那套投到 WGS84 椭球，与「对地覆盖分析」画法完全相同。
import { ref, reactive, computed, watch } from 'vue'
import { fieldDb, bandGeometry, stitchLoops, gridXY, projectGrid, projectLimb, gridDirs, loopLabelAnchor } from './coverage.js'
import { shellGeom, shellGrid, shellMapper, tessellateFills, tessellateSegs } from './shellProj.js'
import { cssRgb } from './colormap.js'
import { A, geodeticToEcef, isoElevationContourAt } from '../wgs84.js'
import { effective as displayQuality } from '../../stores/displayQuality.js'

let _sid = 1
const newShellId = () => 'sh' + Date.now().toString(36) + (_sid++)
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180

// 预置壳层：常见轨道高度，选中即用（可增删改）。颜色只用于壳层参照网与列表标识，不参与场配色。
export const PRESET_SHELLS = [
  { name: 'LEO 550', altKm: 550, color: '#5ad1ff' },
  { name: 'LEO 1200', altKm: 1200, color: '#7cff8a' },
  { name: 'MEO 8000', altKm: 8000, color: '#ffd24a' },
  { name: 'MEO 20200', altKm: 20200, color: '#ff9a5a' },
  { name: 'GEO 35786', altKm: 35786, color: '#ff6fae' }
]
// 新层的默认色按库里已有层数轮转：一次从星座取进来七八层，全是同一个青色就分不出谁是谁
const SHELL_PALETTE = ['#5ad1ff', '#7cff8a', '#ffd24a', '#ff9a5a', '#ff6fae', '#b48cff', '#5ae0c8']

// 可见地平弧凸包（2D 对地投影的平滑地平裁剪用，与对地视图同口径）
function convexHullCCW(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const crs = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const q of p) { while (lo.length >= 2 && crs(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
  const up = []
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && crs(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q) }
  lo.pop(); up.pop()
  return lo.concat(up)
}
const _hullCache = new Map()
function satHull(lon, lat, alt) {
  const key = lon + ',' + lat + ',' + alt
  if (_hullCache.has(key)) return _hullCache.get(key)
  let hull = null
  const arc = isoElevationContourAt(geodeticToEcef(lon, lat || 0, alt), 0, 80)
  if (arc && arc.length >= 3) {
    const ring = convexHullCCW(arc.map((p) => [wrap180(p[0] - lon), p[1]]))
    if (ring.length >= 3) hull = { ring, satLon: lon }
  }
  if (_hullCache.size > 64) _hullCache.clear()
  _hullCache.set(key, hull)
  return hull
}

// grd = useGrdCoverage 的活实例；getScene/getFlat = 3D 与 2D 渲染器；isFlat = 当前是否 2D 视图。
// panelOn = 本视图的面板此刻【开着没有】（宿主页裁定 shellUi.side === 'satcov'）。★ 它只管【面板读数】
//   （stats / shellStatus / focusBeam）要不要现算 —— 场景里画什么一概不由它裁，否则收起侧栏就等于关灯。
// ownsFlat = 2D 那块 GRD 场此刻归不归自己（宿主页按【上下文视图】裁定：收起侧栏不改归属，见 stores/shellUi 的 sideCtx）。
//
// 为什么要有归属这道闸：下面 watch(grd.s) 盯的是【两个视图共享的编辑态】，对地面板改一次填充/电平/指向，
// 本视图同样被唤醒 —— 而本视图往外写的两处都不是自己独占的：
//   · 2D 平面图只有【一块】GRD 场且是整体替换（见 useGrdCoverage 的 ownsFlatField）：不归自己时照写，
//     会把对地刚画好的层整体换成本视图的（selected 通常为空 → 直接清空），表现为覆盖闪一下就没；
//   · 3D 壳层内容是自己的通道，闸在 _painted（【从没画过】就一次也不推），否则对地那边一改设置就凭空
//     往球上糊两层壳层参照网。
// flatActive = 2D 那块场此刻有没有人看：平面图可见【或宿主正在按 2D 出图】（导出在 3D 视图下也走 flat）。
// 与 isFlat 分工：isFlat 管「哪个视图可见」（3D 通道的闸），flatActive 管「flat 要不要喂」（2D 通道的闸）。
export function useShellCoverage(grd, getScene, getFlat = () => null, isFlat = () => false, panelOn = () => true, flatActive = isFlat, ownsFlat = panelOn) {
  const shells = ref(PRESET_SHELLS.slice(0, 2).map((p) => ({ id: newShellId(), ...p, show: true, branch: 'both' })))
  const selected = ref([])        // 画在壳层上的天线 key 列表（与对地视图各自独立）
  // ★ 聚焦天线【不自存一份】，只做 grd.active 的镜像：面板的天线设置区绑的就是 grd.s（＝grd.active
  //   那根天线的编辑态）。早先这里另存一个 ref，两处一旦岔开——对地面板换了聚焦、或快照恢复时两边
  //   各按各的规则取——对星面板显示与改动的就是【另一根天线】的设置，看起来就像「指向模式没保存」。
  const active = computed(() => grd.active.value)
  const stats = ref({ layers: 0, tris: 0, ms: 0 })
  const shellStatus = ref({})     // 壳层 id → { tris, why }：空层归因，选错壳层时不留白让人猜

  const s = reactive({
    hEx: 0,                       // 大气/临边排除高度 km：判遮挡时把地球膨胀这么多。0 = 纯几何
    guides: true,                 // 壳层参照网
    // 参照网样式：全局一份，作用于所有壳层（逐层只留颜色）。★ 扁平存放，不套嵌套对象——
    // getState 的 opts 是 { ...s } 浅拷贝、restoreState 按 s 的键逐个回填：老快照缺键天然落默认，
    // 快照过 IPC 也要求纯数据。套一层对象两条都要另写代码。
    guideStep: 30,                // 网格间隔 °（经线与纬线同一间隔）
    guideLat: 60,                 // 纬线范围 ±°
    guideWidth: 0.8,              // 线宽 px（粗线基建，与 DPR 无关）
    guideAlpha: 0.14,             // 透明度
    guideDash: false              // 线型：true = 虚线
  })

  // ==================== 树选择（画哪些天线是本视图独有的；设置一概共享）====================
  const isSelected = (key) => selected.value.includes(key)
  const isActive = (key) => active.value === key
  // ★ 勾选（画不画）与聚焦（编辑谁）是【两件事】，不许互相牵连：
  //   早先取消勾选后会再走一遍 setActive，而 setActive 又把该天线塞回 selected —— 正在编辑的那根
  //   天线于是永远关不掉显示。现在取消勾选只管取消，聚焦原地不动（设置区照常编辑，只是不画出来）。
  async function toggleAnt(sat, a) {
    const key = grd.keyOf(sat.folder, a.name)
    if (selected.value.includes(key)) { selected.value = selected.value.filter((k) => k !== key); return }
    if (!(await grd.ensureAntLoaded(key))) return
    selected.value = [...selected.value, key]
    if (!active.value) await setActive(sat, a)          // 还没有聚焦项时，首个勾选的顺带成为编辑对象
  }
  // 聚焦即 grd 的聚焦：面板上的设置控件绑的就是 grd.s（对地那份编辑态），
  // 两处聚焦必须是同一根天线，否则改的是另一根天线的参数。
  async function setActive(sat, a) {
    const key = grd.keyOf(sat.folder, a.name)
    if (!(await grd.ensureAntLoaded(key))) return
    if (grd.active.value !== key) await grd.setActive(sat, a)
  }
  function satState(sat) {
    const ks = (sat.antennas || []).map((a) => grd.keyOf(sat.folder, a.name))
    if (!ks.length) return 'none'
    const on = ks.filter((k) => isSelected(k)).length
    return on === 0 ? 'none' : (on === ks.length ? 'all' : 'some')
  }
  async function toggleSatAll(sat) {
    const all = satState(sat) === 'all'
    let next = selected.value.slice()
    for (const a of (sat.antennas || [])) {
      const key = grd.keyOf(sat.folder, a.name)
      if (all) next = next.filter((k) => k !== key)
      else if (!next.includes(key) && await grd.ensureAntLoaded(key)) next.push(key)
    }
    selected.value = next
    if (!active.value && selected.value[0]) await grd.setActiveKey(selected.value[0])   // 同 toggleAnt：只补空，不因取消勾选改聚焦
  }
  function clearDrawing() { selected.value = [] }
  // 树是两个视图共用的，删天线/删卫星/改名可以从【任一棵树】发起，而本视图的 selected 是独有的一份 →
  // 订阅 grd 的 key 变更就地跟随。不订阅的话：从对地树删掉的天线会在这儿留一个死 key（画不出来、
  // 还会被存进快照），改名则等同于悄悄取消勾选。
  grd.onTreeKeys((ev) => {
    if (!ev) return
    if (ev.type === 'remove') { const gone = new Set(ev.keys || []); selected.value = selected.value.filter((k) => !gone.has(k)) }
    else if (ev.type === 'rename') selected.value = selected.value.map((k) => (k === ev.from ? ev.to : k))
  })
  // 在本视图导入 GRD 新建天线：grd.importGrd 只会把新天线勾进【对地】那份显示列表，
  // 这里要自己认领一份，否则导入完壳层上什么也没有，看着像导入没生效。
  async function importGrd(sat) {
    const keys = await grd.importGrd(sat)
    if (!Array.isArray(keys) || !keys.length) return
    const next = selected.value.slice()
    for (const k of keys) if (!next.includes(k)) next.push(k)
    selected.value = next
  }

  // ==================== 壳层库 ====================
  const nextColor = (i = 0) => SHELL_PALETTE[(shells.value.length + i) % SHELL_PALETTE.length]
  function addShell(altKm, name, color) {
    const alt = clampN(Number(altKm) || 550, 1, 400000)
    shells.value = [...shells.value, { id: newShellId(), name: name || '', altKm: alt, color: color || nextColor(), show: true, branch: 'both' }]
  }
  function removeShell(id) { shells.value = shells.value.filter((x) => x.id !== id) }
  function updateShell(id, patch) { shells.value = shells.value.map((x) => (x.id === id ? { ...x, ...patch } : x)) }
  // 批量加壳层（「从星座取」选中的那几层）。已在库中的（同高度 ±tolKm）跳过，返回真正新增的层数。
  function addShells(items, tolKm = 1) {
    const add = []
    for (const it of (items || [])) {
      const alt = clampN(Number(it.altKm) || 0, 1, 400000)
      if (!(alt > 0)) continue
      if (shells.value.some((x) => Math.abs(x.altKm - alt) <= tolKm)) continue
      if (add.some((x) => Math.abs(x.altKm - alt) <= tolKm)) continue
      add.push({ id: newShellId(), name: it.name || '', altKm: alt, color: it.color || nextColor(add.length), show: true, branch: 'both' })
    }
    if (add.length) shells.value = [...shells.value, ...add]
    return add.length
  }

  // ==================== 场与热区盒 ====================
  function patternField(beam, st) {
    const cc = beam._shfld
    if (cc && cc.pol === st.pol && cc.gain === st.gainOffset) return cc.field
    const field = fieldDb({ P1: beam.P1, P2: beam.P2, NX: beam.grid.NX, NY: beam.grid.NY }, null,
      { pol: st.pol, gainOffset: st.gainOffset, pathLoss: 'none' })
    beam._shfld = { pol: st.pol, gain: st.gainOffset, field }
    return field
  }
  function lossField(beam, st, slant) {
    if (st.pathLoss === 'none') return patternField(beam, st)
    return fieldDb({ P1: beam.P1, P2: beam.P2, NX: beam.grid.NX, NY: beam.grid.NY }, { slant },
      { pol: st.pol, gainOffset: st.gainOffset, pathLoss: st.pathLoss })
  }
  const lowestAbs = (max, st) => { let lo = Infinity; for (const L of st.levels) { const a = st.ctype === 'rel' ? max + L.v : L.v; if (a < lo) lo = a }; return lo }
  function computeBox(db, NX, NY, L0) {
    let r0 = NY, r1 = -1, c0 = NX, c1 = -1
    for (let r = 0; r < NY; r++) { const rb = r * NX; for (let c = 0; c < NX; c++) { if (db[rb + c] >= L0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c } } }
    if (r1 < 0) return null
    return { r0: Math.max(0, r0 - 1), r1: Math.min(NY - 1, r1 + 1), c0: Math.max(0, c0 - 1), c1: Math.min(NX - 1, c1 + 1) }
  }
  const absLevels = (peak, st) => st.levels.map((L, idx) => ({
    idx, abs: st.ctype === 'rel' ? peak + L.v : L.v, v: L.v, name: L.name || '', color: L.color, lineColor: L.lineColor || L.color
  }))
  // 数值标签：开关是【全局显示选项】，只活在 grd.s 上 —— 它不在 persistActive 的回存名单(PA)里，
  // 天线设置 ctx.settings 永远没有 showVal 这个键。早先这里按 st.showVal 取，恒为 undefined →
  // labels 恒空，勾「显示数值标签」怎么点都不出字（渲染端的 showVal 倒是从 grd.s 取的，对得上）。
  const wantLabels = () => !!grd.s.showVal
  // 「够到最低档的那些格」上的 vis 极值。只在某层空了、要给归因时才走（O(热区)，不在热路径上）。
  // ★ 必须按此过滤：±12° 网格四角早跑出地球 8.7° 圆盘，整张网格/热区矩形取极值会把「全被地球遮挡」
  //   误报成「低于最低档」。
  function litMaxVis(field, sg, L0, box) {
    const NX = field.NX, NY = field.NY, db = field.db, vis = sg.vis
    const r0 = box ? box.r0 : 0, r1 = box ? box.r1 : NY - 1, c0 = box ? box.c0 : 0, c1 = box ? box.c1 : NX - 1
    let mx = -Infinity
    for (let r = r0; r <= r1; r++) {
      const rb = r * NX
      for (let c = c0; c <= c1; c++) { const k = rb + c; if (db[k] >= L0 && vis[k] > mx) mx = vis[k] }
    }
    return mx
  }
  function emptyWhy(field, sg, L0, box) {
    if (sg.maxShellM < 0) return '波束未及'
    const lm = litMaxVis(field, sg, L0, box)
    return (lm !== -Infinity && lm < 0) ? '全被地球遮挡' : '低于最低档'
  }

  // 聚焦天线这一轮真正画出来的第一个波束（宿主页「加入波束内的星」按它取样，不必再猜第几个）
  const focusBeam = ref(null)

  // 每根天线一遍公共准备：设置 / 波束 / 场 / 热区盒（3D 壳层与 2D 对地投影共用）
  function* eachBeam() {
    for (const key of selected.value) {
      const ctx = grd.getPerfContext(key); if (!ctx) continue
      const st = ctx.settings
      if (!st.fill && !st.line) continue
      const node = grd.sats.value.find((x) => x.folder === key.split('|')[0])
      const satShown = !node || node.labelShow !== false
      for (const bi of (st.beamsToPlot || [])) {
        const bm = ctx.beams.find((b) => b.bi === bi); if (!bm) continue
        const beam = bm.beam, set = beam.grid
        const pat = patternField(beam, st)
        // 热区盒【与星位无关】：只由方向图本身（pat.db，已按 pol/增益记忆化）和最低档电平定。
        // 播放时每拍逐波束全网格扫一遍纯属白做——94 波束 × 101×101 就是每帧近百万次比较。
        // 用 pat.db 的对象身份 + L0 当键：方向图或档位一变，键自然不命中。
        let box = null
        if (st.pathLoss === 'none') {
          const L0 = lowestAbs(pat.max, st), ck = beam._shbox
          if (ck && ck.db === pat.db && ck.L0 === L0) box = ck.box
          else { box = computeBox(pat.db, set.NX, set.NY, L0); beam._shbox = { db: pat.db, L0, box } }
          if (!box) continue
        }
        yield { key, ctx, st, bm, beam, set, box, satShown }
      }
    }
  }

  // ==================== 3D：壳层图层 ====================
  function buildShellLayers() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0)
    const out = []
    let tris = 0, focus = null
    const why = {}
    const noteShell = (id, add, reason) => {
      const e = why[id] || (why[id] = { tris: 0, why: '' })
      e.tris += add
      if (add > 0) e.why = ''
      else if (!e.tris && reason) e.why = reason
    }
    const shown = shells.value.filter((sh) => sh.show)
    const mine = []                    // 聚焦天线画出来的层（取其中峰值最高者做面板读数）
    for (const it of eachBeam()) {
      const { key, ctx, st, bm, beam, set, box, satShown } = it
      const igrid = ctx.igrid, basis = ctx.basis
      const { gx, gy } = gridXY(set)
      for (const sh of shown) {
        const R = A + sh.altKm
        const g = shellGeom(basis, R, s.hEx)
        const branches = g.inside ? ['far'] : (sh.branch === 'both' ? ['near', 'far'] : [sh.branch])
        for (const br of branches) {
          const sg = shellGrid(set, igrid, basis, g, br, box, beam._shbuf)
          beam._shbuf = sg
          const field = lossField(beam, st, sg.slant)
          const asc = [...absLevels(field.max, st)].sort((a, b) => a.abs - b.abs)
          if (!asc.length) continue
          const geo = bandGeometry(
            { lon: gx, lat: gy, vis: sg.vis, db: field.db, NX: set.NX, NY: set.NY },
            asc.map((x) => x.abs), st.fill, box, null, displayQuality.value.gridStride
          )
          if (key === active.value && !focus) focus = { bi: bm.bi, name: bm.name }
          const map = shellMapper(igrid, basis, g, br)
          const fillBands = st.fill
            ? tessellateFills(asc.map((x, i) => ({ color: cssRgb(x.color), verts: geo.fills[i].verts, counts: geo.fills[i].counts })).filter((b) => b.counts.length), map)
            : null
          const wl = wantLabels()
          const segGroups = st.line
            ? asc.map((x, i) => {
              const segs = tessellateSegs(geo.lines[i], map)
              const labels = []
              if (wl) for (const loop of stitchLoops(segs)) { if (loop.length >= 4) labels.push(loopLabelAnchor(loop, i, asc.length)) }
              return { segs, color: x.lineColor, width: st.lineWidth, txt: (x.name || String(x.v)), labels }
            }).filter((gp) => gp.segs.length)
            : []
          if (!(fillBands && fillBands.length) && !segGroups.length) {
            noteShell(sh.id, 0, emptyWhy(field, sg, asc[0].abs, box))
            continue
          }
          let nTri = 0
          if (fillBands) for (const fb of fillBands) nTri += fb.counts.length
          tris += nTri
          noteShell(sh.id, nTri || 1, '')
          // 峰值点：先用 strict 版求交——峰值方向【真打在这层壳上】才是一个能标的点。打不到时
          // 退回默认 map 的相切兜底点，那只是个锚（波束名贴在那儿），点与峰值电平由渲染端按 hit 不画。
          const pkHit = shellMapper(igrid, basis, g, br, true)(gx[field.maxIdx], gy[field.maxIdx])
          const pk = pkHit || map(gx[field.maxIdx], gy[field.maxIdx])
          const layer = {
            id: `${key}#${bm.bi}@${sh.id}:${br}`, R, alpha: st.alpha,
            name: bm.name + (branches.length > 1 ? (br === 'near' ? ' 近' : ' 远') : ''),
            fillBands, segGroups,
            bore: pk && Number.isFinite(field.max) ? {
              lon: pk.lon, lat: pk.lat, hit: !!pkHit, satLon: ctx.meta.satLon, satLat: ctx.meta.satLat || 0, satAlt: ctx.meta.satAlt,
              peak: field.max, satShown
            } : null
          }
          if (key === grd.active.value) mine.push(layer)   // 面板 tip 的实时峰值读数（聚焦天线这一份）
          out.push(layer)
        }
      }
    }
    focusBeam.value = focus
    shellStatus.value = why
    grd.setLivePeak('shell', grd.bestPeakOf(mine))
    stats.value = { layers: out.length, tris, ms: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0) }
    return out
  }

  // ==================== 2D：对地投影（与「对地覆盖分析」同一条链路）====================
  // 同一批波束投到 WGS84 椭球，几何在【经纬度域】切（不是参数域）——这就是对地那套，逐字同口径。
  // 指向若朝反天底（如低轨打 GSO），整片投不到地球上，这里自然为空，平面图留白。
  function buildGroundLayers() {
    const out = []
    const mine = []                    // 聚焦天线画出来的层（取其中峰值最高者做面板读数）
    for (const it of eachBeam()) {
      const { key, ctx, st, bm, beam, set, box, satShown } = it
      const igrid = ctx.igrid, basis = ctx.basis
      const proj = projectGrid(set, igrid, basis, box, beam._gbuf, true)
      beam._gbuf = proj
      const field = lossField(beam, st, proj.slant)
      const asc = [...absLevels(field.max, st)].sort((a, b) => a.abs - b.abs)
      if (!asc.length) continue
      const hull = st.fill ? satHull(ctx.meta.satLon, ctx.meta.satLat || 0, ctx.meta.satAlt) : null
      const geo = bandGeometry(
        { lon: proj.lon, lat: proj.lat, vis: proj.vis, db: field.db, NX: set.NX, NY: set.NY },
        asc.map((x) => x.abs), st.fill, box, hull, displayQuality.value.gridStride
      )
      const fillBands = st.fill
        ? asc.map((x, i) => ({ color: cssRgb(x.color), verts: geo.fills[i].verts, counts: geo.fills[i].counts })).filter((b) => b.counts.length)
        : null
      const wl = wantLabels()
      const segGroups = st.line
        ? asc.map((x, i) => {
          const segs = geo.lines[i]
          const labels = []
          if (wl) for (const loop of stitchLoops(segs)) { if (loop.length >= 4) labels.push(loopLabelAnchor(loop, i, asc.length)) }
          return { segs, color: x.lineColor, width: st.lineWidth, txt: (x.name || String(x.v)), labels }
        }).filter((gp) => gp.segs.length)
        : []
      if (!(fillBands && fillBands.length) && !segGroups.length) continue
      // 峰值点：与对地视图逐字同口径（useGrdCoverage.peakPoint）——★ 不能读 proj.lon/lat[maxIdx]，
      // 那张投影 limbOutside=true，越地平的点返回的是「射线到地心的垂足」，反算出来的经纬度是假读数。
      // 对 argmax 那一条射线单独求交：hit=真打到椭球；打不到则退回该方向的地平点，只作波束名的锚。
      const dirs = gridDirs(set, igrid), o3 = field.maxIdx * 3
      const pr = Number.isFinite(field.max) ? projectLimb([dirs[o3], dirs[o3 + 1], dirs[o3 + 2]], basis) : null
      const layer = {
        id: `${key}#${bm.bi}`, fillBands, segGroups, name: bm.name,
        bore: pr && Number.isFinite(pr.lon) && Number.isFinite(pr.lat) ? {
          lon: pr.lon, lat: pr.lat, hit: pr.vis >= 0,
          satLon: ctx.meta.satLon, satLat: ctx.meta.satLat || 0, satAlt: ctx.meta.satAlt,
          peak: field.max, satShown
        } : null
      }
      if (key === grd.active.value) mine.push(layer)   // 面板 tip 的实时峰值读数（聚焦天线这一份）
      out.push(layer)
    }
    grd.setLivePeak('shell', grd.bestPeakOf(mine))
    return out
  }

  const fieldOpts = () => {
    const st = grd.s
    return {
      alpha: st.alpha, lineAlpha: st.lineAlpha, showBore: st.showBore, boreSize: st.boreSize, boreColor: st.boreColor,
      showName: st.showName, nameSize: st.nameSize, nameColor: st.nameColor,
      showPeak: st.showPeak, peakSize: st.peakSize, peakColor: st.peakColor, showVal: st.showVal, valSize: st.valSize, valColor: st.valColor
    }
  }
  // 天线视轴：每根选中天线【一条】，从源星沿方向图坐标系的 z 轴射到最外一层壳。
  // 与「卫星↔峰值点」的连线是两回事——视轴不依赖有没有画出覆盖：波束转到空无一物的方向时，
  // 它是唯一还看得见的把手（拖拽全向指向时全靠它），故独立成一条通道、单独开关。
  // 求交与对地视图共用 grd.buildAxisRays（那边打到地球，这边打到壳层），两个视图同一条轴、同一套样式。
  function buildRays() {
    let Rout = A
    for (const sh of shells.value) if (sh.show && A + sh.altKm > Rout) Rout = A + sh.altKm
    return grd.buildAxisRays(selected.value, Rout)
  }
  // 「已经画到场景里过」：壳层是场景内容，【离开面板不撤】（要清空走面板的「清除绘图」）——所以一旦画过，
  // 之后即便切走也得继续跟着设置/时间刷新，否则星在动、壳层还停在旧位置。反过来，从没画过就一次也不推。
  // 随存档走（见 getState/restoreState）：重开软件时场景照原样接着画，不必等用户再进一次面板。
  let _painted = false
  let _guideKey = ''
  // 壳层参照网只随壳层库/开关变，与时间无关 —— 键控跳过：播放拍键不变就一次也不重建
  //（改造前每拍销毁重建几千顶点的格网，纯属白做）。场景清空后由 clearAll 复位键。
  function syncGuides(sc) {
    const list = s.guides ? shells.value.filter((x) => x.show).map((x) => ({ R: A + x.altKm, color: x.color })) : []
    const style = { step: s.guideStep, latMax: s.guideLat, width: s.guideWidth, alpha: s.guideAlpha, dash: s.guideDash }
    // ★ 键必须并进【全部】样式字段：漏一个就是改了那项不重建，表现为「设置没生效」
    const key = list.map((g) => g.R + '|' + g.color).join(',') + '#' +
      [style.step, style.latMax, style.width, style.alpha, style.dash].join('|')
    if (key === _guideKey) return
    _guideKey = key
    sc.setShellGuides(list, style)
  }
  function recompute() {
    const on = panelOn()
    if (!on && !_painted) return       // 面板没打开过 → 场景里本就没有本视图的东西；stats/shellStatus/focusBeam 的读者也全在面板内
    if (on) _painted = true
    // 2D 平面图盖住球面期间（scene 已 pause）不喂 3D：几何构建 + GPU 缓冲全是白做，切回 3D 时由
    // applyFlat 补一次全量。面板开着时 buildShellLayers 照跑——读数行/空层归因/focusBeam
    //（「波束内的星」的成员判据）都从它出，2D 下指标表还在每拍走，不能喂它旧焦点。
    const sc = isFlat() ? null : getScene()
    const fl = (ownsFlat() && flatActive()) ? getFlat() : null   // 归属看上下文视图，不看侧栏开合
    if (!sc && !fl && !on) return      // 两侧都不收、读数也没人看（2D 期间面板关着）：整轮白算
    const t0 = perfNow()
    if (sc && sc.setShellField) {
      // 播放热路径走增量：按层 id 复用填充缓冲原地写回，只重建线与标签（对地 updateCoverageField 同款）
      ;(sc.updateShellField || sc.setShellField)(buildShellLayers(), fieldOpts())
      syncGuides(sc)
      if (sc.setShellRays) sc.setShellRays(buildRays())
    } else if (on) buildShellLayers()  // 场景不收（未就绪 / 2D 期间）也要出空层归因，面板读数不能等
    // 2D 那块场：平面图可见或正在按 2D 出图才烘 —— 3D 视图下 buildGroundLayers + Path2D 烘焙
    // 是每拍一整套白算（独立的对地投影 + bandGeometry，画布根本不可见）。
    if (fl) fl.setField(buildGroundLayers(), fieldOpts())
    // 整轮耗时（含 GPU 重建）：贵不贵不该让人猜，摆进面板读数行
    stats.value = { ...stats.value, fullMs: Math.round(perfNow() - t0) }
  }
  // ★ 【一帧一个时刻】：时间推进时壳层与星位在同一次调用里算完，绝不延后 —— 延后就等于
  //   画面上星在 t、覆盖场在 t−Δ（用户原话「慢半拍」）。省算力的活交给时钟的占用底线去做。
  //   rAF 合帧只服务【设置变更】那一路（一次改动可能连着触发好几个 watcher，合成一帧做完）。
  let _pending = false
  function scheduleRecompute() {
    if (_pending) return
    _pending = true
    const run = () => { _pending = false; recompute() }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16)
  }
  function clearAll() {
    const sc = getScene()
    if (sc && sc.clearShellField) { sc.clearShellField(); sc.clearShellGuides(); if (sc.clearShellRays) sc.clearShellRays() }
    _guideKey = ''                     // 参照网已清 → 键复位，下次 recompute 重喂
    const fl = ownsFlat() ? getFlat() : null; if (fl) fl.setField([], {})
    _painted = false                   // 场景已清空 → 回到「没画过」，面板关着时不再自行复现
  }

  watch(shells, scheduleRecompute, { deep: true })
  watch(selected, scheduleRecompute, { deep: true })
  watch(active, scheduleRecompute)
  watch(() => [s.hEx, s.guides, s.guideStep, s.guideLat, s.guideWidth, s.guideAlpha, s.guideDash], scheduleRecompute)
  // 天线设置是【共享】的：对地面板改、对星面板改、拖拽改，都落在 grd.s 上 → 一处监听全覆盖
  watch(() => grd.s, scheduleRecompute, { deep: true })

  // ==================== 持久化（随页面快照）====================
  function getState() {
    return {
      shells: shells.value.map((x) => ({ name: x.name, altKm: x.altKm, color: x.color, show: x.show, branch: x.branch })),
      selected: selected.value.slice(), active: active.value,
      opts: { ...s },
      painted: _painted   // 3D 壳层已在场景里（离开面板不撤）→ 重开软件要照原样接着画，见 recompute 的闸
    }
  }
  async function restoreState(st) {
    if (!st) return
    if (Array.isArray(st.shells) && st.shells.length) {
      shells.value = st.shells.map((x, i) => ({
        id: newShellId(), name: x.name || '', altKm: Number(x.altKm) || 550,
        color: x.color || SHELL_PALETTE[i % SHELL_PALETTE.length], show: x.show !== false, branch: x.branch || 'both'
      }))
    }
    if (st.opts) for (const k of Object.keys(s)) if (st.opts[k] !== undefined) s[k] = st.opts[k]
    const keys = []
    for (const key of (Array.isArray(st.selected) ? st.selected : [])) if (await grd.ensureAntLoaded(key)) keys.push(key)
    selected.value = keys
    // 聚焦由 grd.restoreState 一并还原（两视图同一根天线，见 active 的定义）。只有 grd 那边落空时
    // ——存档里对地一根天线都没选、聚焦项也没了——才拿本视图的选中项补一个，免得设置区整块不显示。
    if (!grd.active.value) {
      const want = (st.active && keys.includes(st.active)) ? st.active : (keys[0] || '')
      if (want) await grd.setActiveKey(want)
    }
    // 上次退出时壳层就画着 → 这次也接着画（面板未必停在对星视图，但内容本就不随离开而撤）。
    // 老存档没有 painted 字段：有选中天线即视作画过，不让升级掉一层图。
    if (st.painted || keys.length) _painted = true
    recompute()
  }

  return {
    shells, selected, active, s, stats, focusBeam, shellStatus,
    isSelected, isActive, satState, toggleAnt, setActive, toggleSatAll, clearDrawing, importGrd,
    addShell, addShells, removeShell, updateShell, presetShells: () => PRESET_SHELLS,
    recompute, scheduleRecompute, clearAll, getState, restoreState
  }
}
