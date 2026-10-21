// 时区图层的状态与编排（主窗「地图综合设置」视图的「时区」分区）。
//
// 体例：打开即是一张时区图（CIA《Standard Time Zones of the World》那一套）—— 陆地按时区实色铺满、海区按航海带铺浅调、
//   每个连通时区标时区号、平面图上下两条时区条（上：各航海带的时区号；下：此刻各带的当地时刻，跨日处标星期）、
//   国际日期变更线粗线。「选择时区」里勾选的偏移常驻描亮外轮廓；「悬停描亮」开着时把与光标处同偏移的全部区域也勾出来。
//   配色与线 / 字样式见 ../geo/tzStyle.js。
//
// 分层：规则表 + 时区面拓扑（懒加载，按底图档）→ 按视角解每面时区 → 每拍按仿真时刻算偏移 →
//   偏移签名没变：零开销（每分钟只刷一次时刻文字）；
//   偏移变了（夏令时跃迁 / 换口径 / 换视角 / 换档 / 选择时区变了）：重组几何推给 2D / 3D（geomVer + 1）。
// 宿主（3D 页）注入 draw(spec) / drawHover(h) 与几个取值回调；本模块不认识 THREE / canvas。
//
// ★ 一次 onTick = 一个时刻的完整画面：宿主在 refreshPositions() 里每拍调 tick(ms)，这里同步算完，不许延后到下一帧。
// ★ 时区一律走 tzRules（tzdb 2026e），不用 Intl / Date 取任何地方的偏移（Electron 31 的 ICU 是 2024a，近两年的改制全算错）。

import { ref, watch } from 'vue'
import { loadRules, rulesVersion, offsetAt } from '../geo/tzRules.js'
import { ensureTzDetail, resolveZones, faceOffsets, offsetsSig, boundaryLines, components, highlightLines, fillGroups, faceRings, hitFace, faceZoneName, meridianSpan } from '../geo/tzLayer.js'
import { tzFillColor } from '../geo/tzStyle.js'
import { onPovChange } from '../geo/povResolver.js'
import { tzOffLabel } from '../../shared/tz.js'
import { byLang } from '../../shared/i18n/lang.js'

const LS_KEY = 'tz-layer-ui-v2'
const TEXT_MIN_MS = 250          // 时刻文字的刷新下限（倍速播放时一秒走几十个仿真分钟，没必要每拍重排文字）

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n) => String(n).padStart(2, '0')
// 偏移 off（分钟）处的当地钟点：只做加法再读 UTC 分量（与 shared/tz.js 的 tzDate 同一招）
function localParts(ms, off) {
  const t = ms + off * 60000
  const d = new Date(t)
  return { w: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), dk: Math.floor(t / 86400000), mo: d.getUTCMonth() + 1, dd: d.getUTCDate() }
}
const weekday = (w) => byLang(WEEK_ZH[w], WEEK_EN[w])
export function fmtLocal(ms, off, withSec) {
  const p = localParts(ms, off)
  return weekday(p.w) + ' ' + two(p.h) + ':' + two(p.m) + (withSec ? ':' + two(p.s) : '')
}
const hhmm = (ms, off) => { const p = localParts(ms, off); return two(p.h) + ':' + two(p.m) }
// 地图上的时区号：+8 / −5 / +5:30 / 0（CIA 图的写法；完整的 UTC+8 留给读数）
export function offShort(min) {
  const m = Math.round(Number(min) || 0)
  if (!m) return '0'
  const a = Math.abs(m)
  return (m < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + two(a % 60) : '')
}

// 「选择时区」的候选偏移（分钟）：整点 −12…+14，加上世界上现行 / 标准时用到的全部非整点（tzdb 2026e）
export const TZ_PICK_OFFS = Object.freeze([
  ...Array.from({ length: 27 }, (_, i) => (i - 12) * 60),
  -570, -210, 210, 270, 330, 345, 390, 525, 570, 630, 765
].sort((a, b) => a - b))
const PICK_SET = new Set(TZ_PICK_OFFS)
const cleanPicks = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => PICK_SET.has(x)))].sort((a, b) => a - b)

// 本节出厂值（「恢复本节默认」回到这里；总开关不在其列）
const DEF = Object.freeze({
  civil: true,          // 口径：true = 现行（民用时，含夏令时），false = 标准时
  fill: true, alpha: 1,
  labels: true, localTime: false, bold: true,
  strips: true, idl: true,
  picks: Object.freeze([]),   // 选择时区：常驻描亮的偏移（分钟）
  hoverHi: true               // 悬停描亮：光标处同偏移的区域勾外轮廓
})

export function useTzLayer(host) {
  const H = host || {}

  const open = ref(false)
  const on = ref(false)                   // 图层总开关（缺省关；之后按上次的选择恢复）
  const civil = ref(DEF.civil)
  const fill = ref(DEF.fill), alpha = ref(DEF.alpha)
  const labels = ref(DEF.labels), localTime = ref(DEF.localTime), bold = ref(DEF.bold)
  const strips = ref(DEF.strips), idl = ref(DEF.idl)
  const picks = ref([...DEF.picks]), hoverHi = ref(DEF.hoverHi)
  const busy = ref(false), msg = ref('')
  const STYLE = { civil, fill, alpha, labels, localTime, bold, strips, idl, picks, hoverHi }

  let B = null, zones = null, offs = null, sig = -1, comps = null, detailLoaded = ''
  let geomVer = 0, textVer = 0, spec = null
  let lastMs = NaN, minuteKey = -1, lastTextAt = 0, textTimer = 0
  let reqSeq = 0
  let hover = null, hoverOff = NaN       // 悬停：{ off, geomVer, lines } | null

  const detailNow = () => (H.detail ? H.detail() : '50m') || '50m'
  // 选择时区：多选切换（整组换新数组，watch 才看得见）
  function togglePick(off) {
    const cur = picks.value
    picks.value = cleanPicks(cur.includes(off) ? cur.filter((x) => x !== off) : [...cur, off])
  }

  // ---- 取数（规则表 + 当前档的拓扑）----
  async function ensure() {
    const d = detailNow()
    if (B && detailLoaded === d) return true
    const seq = ++reqSeq
    busy.value = true; msg.value = ''
    try {
      await loadRules()
      const b = await ensureTzDetail(d)
      if (seq !== reqSeq) return false
      B = b; detailLoaded = d
      zones = resolveZones(B); offs = null; sig = -1
      return true
    } catch (e) {
      if (seq === reqSeq) { msg.value = (e && e.message) || String(e); B = null }
      return false
    } finally {
      if (seq === reqSeq) busy.value = false
    }
  }

  // ---- 每拍 ----
  function tick(ms) {
    if (!Number.isFinite(ms)) return
    lastMs = ms
    if (!on.value || !B) return
    offs = faceOffsets(B, zones, ms, civil.value, offs)
    const s = offsetsSig(offs) >>> 0
    if (s !== sig) { sig = s; rebuild(ms); return }
    const mk = Math.floor(ms / 60000)
    if (mk !== minuteKey && ((labels.value && localTime.value) || strips.value)) retext(ms)
  }

  function rebuild(ms) {
    if (!B || !offs) return
    comps = components(B, offs)
    const fa = fill.value ? Math.max(0, Math.min(1, Number(alpha.value) || 0)) : 0
    const fills = []
    if (fa > 0) {
      for (const g of fillGroups(B, offs)) {
        const polys = []
        for (const i of g.faces) for (const p of faceRings(B, i)) polys.push(p)
        const c = tzFillColor(g.off, g.k)
        fills.push({ color: c.color, hatch: c.hatch, flat: c.flat, alpha: fa, polys, off: g.off, k: g.k })
      }
    }
    const L = boundaryLines(B, offs)
    const lines = {
      land: L.land,
      sea: idl.value ? L.sea : L.sea.concat(L.idl),   // 不单画日界线时，它就是一条普通的海上分界
      idl: idl.value ? L.idl : [],
      hi: picks.value.length ? highlightLines(B, offs, picks.value) : []
    }
    geomVer++; textVer++
    minuteKey = Math.floor(ms / 60000); lastTextAt = Date.now()
    spec = {
      geomVer, textVer, detail: B.detail,
      fills, lines,
      style: { labels: !!labels.value, bold: !!bold.value, strips: !!strips.value, idl: !!idl.value, fillAlpha: fa },
      hiOffs: picks.value.slice(),                     // 选择时区（时区条里对应的格勾内框、时区号加粗）
      labels: labelList(ms),
      strips: strips.value ? stripData(ms) : null
    }
    H.draw?.(spec)
    if (Number.isFinite(hoverOff)) setHoverOff(hoverOff, true)     // 几何换了：悬停轮廓按新几何重取
  }

  // 时区号候选：陆地 = 每个同偏移连通区一个 + 逐面（国家 × 时区的每一块）一个，海区逐连通区（航海带）；
  // 锚点都是构建期 polylabel 的最大内切圆心。按内切圆大小排队，渲染器再按「字放得进 + 同偏移的号彼此拉开」取舍 ——
  // 连通区那一个先占（它最大），同一连通区里远处的块各补一处（cid = 连通区号，渲染器按它拉开间距）；相邻小国不重复标同一个号
  function labelList(ms) {
    if (!labels.value || !comps || !B || !offs) return []
    const out = []
    // span = 锚点所在那块面沿锚点经线的纬度段：2D 渲染器把压到时区条下的字沿经线挪出来时，只在这一段里挪
    const mk = (a, off, sea, cid, fi) => ({
      lon: a[0], lat: a[1], r: a[2], sea, cid, span: fi >= 0 ? meridianSpan(B, fi, a[0], a[1]) : null,
      t1: offShort(off), t2: localTime.value ? hhmm(ms, off) : '',
      off, pri: a[2] * (sea ? 0.5 : 1), hi: picks.value.includes(off)
    })
    comps.list.forEach((c, ci) => { if (c.anchor) out.push(mk(c.anchor, c.off, c.k === 's', ci, c.face)) })
    for (let i = 0; i < B.faces.length; i++) {
      const f = B.faces[i]
      if (f.k === 'l' && f.a && !Number.isNaN(offs[i])) out.push(mk(f.a, offs[i], false, comps.comp[i], i))
    }
    out.sort((a, b) => b.pri - a.pri)
    return out
  }
  // 时区条（2D 上下沿）：15° 一带，±12 两个半带在 180° 两侧。上条写时区号，下条写此刻的当地时刻（dk = 当地日序，跨日处渲染器标星期）
  function stripData(ms) {
    const top = [], bottom = []
    for (let h = -12; h <= 12; h++) {
      const w0 = h === -12 ? -180 : 15 * h - 7.5
      const w1 = h === 12 ? 180 : 15 * h + 7.5
      const p = localParts(ms, 60 * h)
      top.push({ w0, w1, h, t: offShort(60 * h) })
      bottom.push({ w0, w1, h, t: two(p.h) + ':' + two(p.m), day: weekday(p.w), md: two(p.mo) + '-' + two(p.dd), dk: p.dk })
    }
    return { top, bottom }
  }
  // 只有时刻变了：同一份几何、换文字（2D 只重画文字层 / 时区条、3D 只重烘标注）
  function retext(ms) {
    if (!spec) return
    const now = Date.now()
    if (now - lastTextAt < TEXT_MIN_MS) {
      if (!textTimer) textTimer = setTimeout(() => { textTimer = 0; if (Number.isFinite(lastMs) && spec) retext(lastMs) }, TEXT_MIN_MS)
      return
    }
    lastTextAt = now; minuteKey = Math.floor(ms / 60000)
    textVer++
    // 时区号只有带当地时刻时才随时刻变：否则沿用原数组（同一引用）—— 渲染端据此只重画时区条，不重排整张文字层 / 不重烘 3D 标注
    const labs = labels.value && localTime.value ? labelList(ms) : spec.labels
    spec = { ...spec, textVer, labels: labs, strips: strips.value ? stripData(ms) : null }
    H.draw?.(spec)
  }
  // 界面语言换了：时区条日期行的星期是按语言生成的，暂停时也要立刻换（不等下一个仿真分钟）
  function relang() { if (spec && Number.isFinite(lastMs)) retext(lastMs) }

  function redraw() {
    sig = -1
    if (!on.value) { clearLayer(); return }
    const ms = Number.isFinite(lastMs) ? lastMs : (H.nowMs ? H.nowMs() : Date.now())
    ensure().then((ok) => { if (ok && on.value) tick(ms) })
  }
  function clearLayer() { spec = null; sig = -1; hover = null; hoverOff = NaN; H.draw?.(null); H.drawHover?.(null) }

  // ---- 悬停：与光标处同偏移的全部区域勾外轮廓（同一偏移只取一次几何）----
  function setHoverOff(off, force) {
    if (!force && (off === hoverOff || (Number.isNaN(off) && Number.isNaN(hoverOff)))) return
    hoverOff = off
    hover = Number.isFinite(off) && B && offs ? { off, geomVer, lines: highlightLines(B, offs, off) } : null
    H.drawHover?.(hover)
  }
  function hoverAt(lat, lon) {
    if (!hoverHi.value || !on.value || !spec || !B || !offs) { if (hover) setHoverOff(NaN); return }
    const i = hitFace(B, lon, lat)
    const f = i >= 0 ? B.faces[i] : null
    setHoverOff(f && f.k !== 'w' ? offs[i] : NaN)
  }
  const hoverClear = () => setHoverOff(NaN)

  // ---- 光标读数（状态栏一格）----
  // { off, text, dst, dstSlot, title, value }：off = 偏移（UTC+8）、text = 当地时刻（周二 14:23:05）、dst = 此刻在夏令时；
  // 陆地 title 写 IANA 区名 + 规则版本，海区写「航海时区」；内陆水域没有时区，只给「—」。
  // ★ 字段都是定宽的（偏移 / 时刻 / 夏令时三格各自占位）：光标跨区时状态栏整排不跳，见 App.vue 的 .tzval
  const dashRead = (o) => (o ? { ...o, off: '—', text: '', dst: false, value: null } : null)
  // dstSlot：现行口径才给「夏令时」那格占位（标准时口径恒不在夏令时，不占）
  function readAt(lat, lon) {
    if (!on.value || !spec || !B || !offs) return null
    const i = hitFace(B, lon, lat)
    if (i < 0) return null
    const f = B.faces[i]
    if (f.k === 'w') return { off: '—', text: '', dst: false, dstSlot: civil.value, title: '', value: null }
    const ms = Number.isFinite(lastMs) ? lastMs : Date.now()
    const off = offs[i]
    const dst = f.k === 'l' && civil.value && zones[i] >= 0 && offsetAt(zones[i], ms).dst !== 0
    const title = f.k === 'l' ? faceZoneName(zones, i) + ' · tzdb ' + rulesVersion() : byLang('航海时区', 'Nautical time zone')
    return { off: tzOffLabel(off), text: fmtLocal(ms, off, true), dst, dstSlot: civil.value, title, value: off }
  }

  // ---- 面板 ----
  function openPanel() { open.value = true }
  function close() { open.value = false }   // 面板收起不撤图层

  // ---- 本节样式：快照 / 放回 / 出厂（宿主的「恢复本节默认」+ 撤销走这三个）----
  // 放回时按出厂值的类型逐项把关：缓存里的旧值、手改的 localStorage 都过这一道
  function putStyle(v) {
    if (!v || typeof v !== 'object') return
    for (const k in STYLE) {
      const x = v[k], d = DEF[k]
      if (Array.isArray(d)) { if (Array.isArray(x)) STYLE[k].value = cleanPicks(x) }
      else if (typeof d === 'boolean') { if (typeof x === 'boolean') STYLE[k].value = x }
      else if (typeof d === 'number') { if (Number.isFinite(x)) STYLE[k].value = x }
    }
  }
  function snapStyle() { const o = {}; for (const k in STYLE) { const v = STYLE[k].value; o[k] = Array.isArray(v) ? v.slice() : v } return o }
  function resetStyle() { putStyle(DEF) }

  // ---- 设置记忆（只记界面选择）----
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    if (s && typeof s === 'object') {
      if (typeof s.on === 'boolean') on.value = s.on
      putStyle(s)
    }
  } catch { /* 首次运行无缓存 */ }

  // ---- 联动 ----
  const offPov = onPovChange(() => { if (B) { zones = resolveZones(B); sig = -1; if (Number.isFinite(lastMs)) tick(lastMs) } })
  // 底图档变了（设置 → 显示画质）：图层开着就换一份拓扑，国界段才与底图同档逐点重合
  function setDetail() { if (on.value) redraw() }
  watch(on, (v) => { if (v) redraw(); else clearLayer() })
  watch(Object.values(STYLE).filter((r) => r !== alpha && r !== hoverHi), () => { if (on.value) redraw() })
  watch(hoverHi, (v) => { if (!v) hoverClear() })
  // 不透明度单走一路：几何不动，只换 spec 里的透明度（2D 重画快照但不重烘 Path2D、3D 只改 uniform）——
  // 曾与其余样式同走 redraw：滑杆每一格都 geomVer + 1，3D 整份重拼 50m 色块网格（约 71 万顶点、45 MB）并重传 GPU
  watch(alpha, () => {
    if (!on.value) return
    const fa = fill.value ? Math.max(0, Math.min(1, Number(alpha.value) || 0)) : 0
    if (spec && spec.fills && spec.fills.length && fa > 0) {
      spec = { ...spec, fills: spec.fills.map((f) => ({ ...f, alpha: fa })), style: { ...spec.style, fillAlpha: fa } }
      H.draw?.(spec)
    } else redraw()   // 从 0 拉起来 / 拉到 0：色块组要重组
  })

  watch([on, ...Object.values(STYLE)], () => {
    try {
      const o = snapStyle(); o.alpha = Number(o.alpha)
      localStorage.setItem(LS_KEY, JSON.stringify({ on: on.value, ...o }))
    } catch { /* 隐私模式等写不进去，忽略 */ }
  })

  // 启动时恢复了「开」：宿主建好场景后调一次（取数是异步的，画面随后补上）
  function start() { if (on.value) redraw() }

  function dispose() {
    offPov()
    if (textTimer) { clearTimeout(textTimer); textTimer = 0 }
  }

  return {
    open, on, civil, fill, alpha, labels, localTime, bold, strips, idl, picks, hoverHi, busy, msg,
    togglePick, offShort,
    openPanel, close, start, tick, redraw, relang, clearLayer, readAt, dashRead, hoverAt, hoverClear, setDetail, dispose,
    snapStyle, putStyle, resetStyle,
    currentSpec: () => spec,
    currentHover: () => hover,
    rulesVersion
  }
}
