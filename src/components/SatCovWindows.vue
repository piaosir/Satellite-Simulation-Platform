<script setup>
// 对星覆盖分析的浮窗：对星性能指标表。
// ★ 窗口外壳与结果表与「对地覆盖分析」的性能指标表【同款】：圆角窗 + 8 向缩放 + 中缝分隔，
//   上区=目标星（对地那边是城市），下区=只读 Excel 网格（框选 / Ctrl+C 复制选区 / 方向键导航），
//   顶上一条 pr-h 工具条 + 「选项…」弹窗（显示列 / 波束筛选 / 过滤 / 参数计算 / 指向误差）。
//   两张表的口径差别见 useSatPerfTable 文件头（一行=一颗目标星、目标由点选），UI 不再另立一套。
// ★ 两种时间口径共用这一个结果区（列与行只有一套，渲染/选区/复制只有一条路径）：
//   · 当前时刻 —— 表跟仿真时钟走；
//   · 时间窗口 —— 先扫出每颗目标星的可见时段（条带），再拖游标点到时窗里的任意一刻，表按那一刻现算。
//     手感对齐链路预算的「星间链路距离」工具：条带上拖 / 滑块细调 / ◀▶ 在窗口峰值间跳。
import { ref, computed, reactive, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import ExcelGrid from './ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { appAlert } from '../stores/alert.js'

const props = defineProps({
  sc: { type: Object, required: true },
  sp: { type: Object, required: true },
  tableOpen: { type: Boolean, default: false },
  timeLabel: { type: String, default: '' },
  // 目标星搜索（宿主注入，全量：星座目录 + 卫星组 + 自定义星座）：
  //   async (q, limit, excludeIds) => { items: [{ name, noradId, group, tag }], total }
  //   excludeIds = 已在目标库里的身份串（'n:<NORAD>' / 'm:<名字>'），由搜索排除，不能拿回结果再滤
  satSearch: { type: Function, default: null },
  hostSize: { type: Object, default: () => ({ w: 0, h: 0 }) },  // .g3 可视尺寸（浮窗以它为参照系定位）
  tzUtc: { type: Boolean, default: false },         // 时刻显示/输入的时区（与主界面时间轴同一开关）
  nowMs: { type: Number, default: 0 }               // 时间轴当前时刻（时窗起点默认跟随它）
})
const emit = defineEmits(['close-table', 'recompute-table', 'add-in-beam', 'scan-windows', 'focus-target', 'seek-clock'])
const sp = props.sp, sc = props.sc
const win = sp.win

// 目标星搜索：★全量（星座目录 / 卫星组 / 自定义星座），不限于在场的星——加进来照样能算
// （解析与对星跟踪同一口径）。结果区与主界面搜索 / 卫星组管理器同款：一行一颗、可滚动、上限 60，
// 底下照实报命中总数。目录懒加载 → 异步：防抖 200 ms + 序号守卫，只认最后一次输入的结果。
const tq = ref('')
const cand = ref([])
const cTotal = ref(0)
const cBusy = ref(false)
let cSeq = 0, cTimer = null
watch(tq, (v) => {
  const q = String(v || '').trim()
  if (cTimer) { clearTimeout(cTimer); cTimer = null }
  cSeq++
  if (!q) { cand.value = []; cTotal.value = 0; cBusy.value = false; return }
  cBusy.value = true
  cTimer = setTimeout(async () => {
    const seq = cSeq
    // 已在目标库里的星交给搜索去排除（不能拿回来再滤：列表是截断的，滤完可能空成「没有匹配」，
    // 而目录里其实还剩一大批没加）
    const had = sp.picks.value.map((p) => (p.noradId ? 'n:' + p.noradId : 'm:' + p.name))
    let r = { items: [], total: 0 }
    try { r = (props.satSearch ? await props.satSearch(q, 60, had) : null) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== cSeq) return
    cand.value = r.items || []
    cTotal.value = r.total || 0
    cBusy.value = false
  }, 200)
})
// 把当前结果整批加为目标（与卫星组管理器「全选结果」同款：搜出一批 → 一次加进来）
function addAllCands() {
  if (!cand.value.length) return
  sp.addTargets(cand.value)
  tq.value = ''
}
onBeforeUnmount(() => { if (cTimer) clearTimeout(cTimer) })

// ==================== 窗口几何 ====================
// 定位与「对地覆盖分析」的性能指标表同款：position:absolute 挂在 .g3 上（不是视口），
// 首次打开按 .g3 可视尺寸算——右对齐留 24px、纵向 12% 起。用视口坐标算会偏出 .g3（活动栏/侧栏/
// 菜单栏/状态栏都不在其内），窗口对不上地图区甚至被裁掉一截，这是对地那张表当年踩过的。
const tw = reactive({ x: 24, y: 90, w: 860, h: 560, init: false })
const inH = ref(170)                    // 上区（目标星）高度，中缝可拖
function initBox(box, wantW, hFrac, dx, dy) {
  if (box.init) return
  const vw = props.hostSize.w || 1200, vh = props.hostSize.h || 800
  box.w = Math.min(wantW, Math.max(320, vw - 48))
  box.h = Math.min(Math.round(vh * hFrac), Math.max(200, vh - 48))
  box.x = Math.max(12, vw - box.w - 24 - dx)
  box.y = Math.max(12, Math.round(vh * 0.12) + dy)
  box.init = true
}
watch(() => props.tableOpen, (v) => { if (v) { initBox(tw, 860, 0.74, 18, 28); inH.value = Math.min(170, Math.round(tw.h * 0.32)) } }, { immediate: true })

const host = () => ({ w: props.hostSize.w || 1200, h: props.hostSize.h || 800 })
function dragSession(onMove) {
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
}
function dragMove(e, box) {
  if (e.button !== 0 || (e.target.closest && e.target.closest('.csx, .ptb, input, select, label'))) return   // 标题栏空白处才拖动
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, o = { x: box.x, y: box.y }
  dragSession((ev) => {
    const { w: vw, h: vh } = host()
    box.x = Math.max(-box.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx)))   // 不让完全拖出 .g3 可视范围
    box.y = Math.max(0, Math.min(vh - 32, o.y + (ev.clientY - sy)))
  })
}
// 8 向缩放：dir 含 n/s/e/w（角=两字母）。东/南改 w/h；西/北还要同步移动 x/y（保持对边不动）。
function dragResize(e, box, dir = 'se', split = false) {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, o = { x: box.x, y: box.y, w: box.w, h: box.h }
  const minW = 380, minH = 260
  const E = dir.includes('e'), Wd = dir.includes('w'), S = dir.includes('s'), N = dir.includes('n')
  dragSession((ev) => {
    const { w: vw, h: vh } = host()
    const dx = ev.clientX - sx, dy = ev.clientY - sy
    if (E) box.w = Math.max(minW, Math.min(o.w + dx, vw - o.x - 6))
    if (S) box.h = Math.max(minH, Math.min(o.h + dy, vh - o.y - 6))
    if (Wd) { const right = o.x + o.w; box.x = Math.max(6, Math.min(o.x + dx, right - minW)); box.w = right - box.x }
    if (N) { const bottom = o.y + o.h; box.y = Math.max(0, Math.min(o.y + dy, bottom - minH)); box.h = bottom - box.y }
    if (split && inH.value > box.h - 140) inH.value = Math.max(64, box.h - 140)   // 缩小时让结果区保底
  })
}
function dragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, o = inH.value
  dragSession((ev) => { inH.value = Math.max(64, Math.min(tw.h - 140, o + (ev.clientY - sy))) })
}

// ==================== 两张网格 ====================
const tblOpts = computed(() => (sc.active.value ? sp.getOpts(sc.active.value) : null))
const tblCols = computed(() => (tblOpts.value ? sp.visibleColumns(tblOpts.value) : []))
const PICK_COLS = [
  { key: 'no', label: 'No.', num: true },
  { key: 'name', label: '目标卫星' },
  { key: 'noradId', label: 'NORAD', num: true },
  { key: 'group', label: '分组' }
]
// 目标名单：点选档取用户名单，波束内档取宿主每拍回填的「此刻在波束里的星」（只读，不能逐行删）
const beamMode = computed(() => sp.targetMode.value === 'beam')
const pickRows = computed(() => sp.activePicks.value.map((p, i) => ({ ...p, no: i + 1 })))
// 上：目标星列表（只读网格——目标是「点选」进来的，不像城市那样逐格键入）
const pickGrid = useGridSelect({
  rows: () => pickRows.value, cols: () => PICK_COLS, readOnly: true,
  cellText: (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) }
})
// 下：性能结果（只读）——框选 + 复制 + 键盘导航；与对地结果表同一套交互
const resGrid = useGridSelect({
  rows: () => sp.filteredRows.value, cols: () => tblCols.value, readOnly: true,
  cellText: (r, c) => sp.fmtCell(c, r[c.key])
})
const fmt = (c, v) => sp.fmtCell(c, v)
const optsOpen = ref(false)
// 结果区空态（三种成因各一句陈述）：没目标星 / 没扫过时段 / 有目标但一行都没出
const resEmptyText = computed(() => {
  if (!pickRows.value.length) return beamMode.value ? '当前波束内没有卫星。' : '还没有目标星。'
  if (win.on && !sp.winInfo.value) return '尚未扫描时段。'
  return '这些目标星都没有取到值。'
})
function resetOpts() { if (!sc.active.value) return; sp.resetOpts(sc.active.value); sp.beamQuery.value = ''; emit('recompute-table') }
watch(tblOpts, () => { if (sc.active.value) sp.rememberOpts(sc.active.value) }, { deep: true })

// ==================== 时间窗口 ====================
// 起点默认跟随时间轴（startMs=null）；改过一次就钉住，⟲ 放回跟随。datetime-local 走本地时刻，
// 主界面切到 UTC 显示时这里也按 UTC 解释输入，否则同一个读数两处差 8 小时。
const p2 = (n) => String(n).padStart(2, '0')
const winT0 = computed(() => (Number.isFinite(win.startMs) ? win.startMs : (props.nowMs || Date.now())))
const startLocal = computed({
  // 秒也要能录：时间轴游标已经下沉到秒级，时窗起点再只到分钟就对不上（同一个「起点」两处差半分钟）
  get: () => {
    const d = new Date(winT0.value)
    return props.tzUtc
      ? `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
      : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  },
  set: (v) => {
    if (!v) { win.startMs = null; return }
    const [dp, tp] = String(v).split('T'); if (!dp || !tp) return
    const [Y, M, D] = dp.split('-').map(Number), [h, m, s] = tp.split(':').map(Number)
    if (!Number.isFinite(Y) || !Number.isFinite(h)) return
    const ss = Number.isFinite(s) ? s : 0
    win.startMs = props.tzUtc ? Date.UTC(Y, M - 1, D, h, m, ss) : new Date(Y, M - 1, D, h, m, ss).getTime()
  }
})
// 表脚的时刻 = 【这批数值算在哪一刻】：当前时刻档跟随仿真时钟（重算太贵跳拍时会比时间轴慢一两拍，
// 那正是这些数真正对应的时刻），时间窗口档就是游标时刻。两档都读同一个 stampMs，不另立口径。
const stampText = computed(() => {
  const ms = sp.stampMs.value
  return Number.isFinite(ms) ? sp.fmtCell({ time: true }, ms) : props.timeLabel
})
const durText = (min) => (min >= 1440 ? (min / 1440).toFixed(1) + ' d' : min >= 60 ? (min / 60).toFixed(1) + ' h' : min.toFixed(1) + ' min')
const hoverId = ref('')
// 条带行 / 结果行 → 聚焦该目标星（旋转地球正对它并选中，与搜索结果点选同一路径）
function focusRow(r) { if (r && (r.tgtName || r.name)) emit('focus-target', { name: r.tgtName || r.name, noradId: r.noradId }) }

// ==================== 时窗游标 ====================
// 扫描只给「哪些时段可见」；表里的数由游标那一刻现算。游标本身当场跟手（setCursor），
// 【重算】按 rAF 节流：一次重算＝一张瞬时表（几十颗星的 SGP4 + 方向图取值），逐 pointermove 直算会一顿一顿。
const wi = computed(() => sp.winInfo.value)
const bands = computed(() => (wi.value && wi.value.bands) || [])
const curMs = computed(() => (Number.isFinite(win.cursorMs) ? win.cursorMs : (wi.value ? wi.value.t0Ms : 0)))
const curFrac = computed(() => {
  const w = wi.value
  if (!w || !(w.t1Ms > w.t0Ms)) return 0
  return Math.max(0, Math.min(1, (curMs.value - w.t0Ms) / (w.t1Ms - w.t0Ms)))
})
let seekRaf = 0
function seek(tMs) {
  if (!wi.value) return
  sp.setCursor(tMs)
  if (seekRaf) return
  seekRaf = requestAnimationFrame(() => { seekRaf = 0; sp.computeAtCursor(win.cursorMs) })
}
onBeforeUnmount(() => { if (seekRaf) cancelAnimationFrame(seekRaf) })
// 条带上按下 → 落到那一刻；落点正好在某个窗口里就吸到该窗口的【峰值时刻】（点一下窗口＝看它最好的那一瞬）。
// 之后 pointermove 自由拖动。捕获挂在条上，指针移出条外仍连续；非左键不捕获（见 input-focus-intermittent）。
function barDown(e, b) {
  if (e.button !== 0 || !wi.value) return
  const el = e.currentTarget, rect = el.getBoundingClientRect()
  const w = wi.value, span = w.t1Ms - w.t0Ms
  const at = (clientX) => w.t0Ms + Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))) * span
  const t0 = at(e.clientX)
  const hit = b && b.segs.find((s) => t0 >= s.startMs && t0 <= s.endMs)
  seek(hit ? hit.peakMs : t0)
  try { el.setPointerCapture(e.pointerId) } catch { /* 捕获失败就退化成不跟出条外 */ }
  const move = (ev) => seek(at(ev.clientX))
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up)
    try { el.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
  }
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
  e.preventDefault()
}
// ◀▶：在【全部目标星的窗口峰值】里前后跳（按时刻排序）。跳到的就是那次照射最好的一瞬。
const peaks = computed(() => bands.value.flatMap((b) => b.segs.map((s) => s.peakMs)).sort((a, b) => a - b))
function jumpPeak(dir) {
  const ps = peaks.value
  if (!ps.length) return
  const t = curMs.value
  const k = dir > 0 ? ps.find((p) => p > t + 500) : [...ps].reverse().find((p) => p < t - 500)
  if (k != null) seek(k)
}
// 游标此刻落在几颗星的窗口里（读数用；每行的具体取值看表）
const inWinCount = computed(() => {
  const t = curMs.value
  return bands.value.reduce((n, b) => n + (b.segs.some((s) => t >= s.startMs && t <= s.endMs) ? 1 : 0), 0)
})
// 切换时间口径：回「当前时刻」按时钟重算，回「时间窗口」按游标重算（否则表里还留着另一档的那一刻的数）
function setWinOn(on) {
  if (win.on === on) return
  win.on = on
  if (on) { if (wi.value) sp.seekCursor(curMs.value); else sp.clearRows() } else emit('recompute-table')
  resGrid.sel.value = { ar: -1, ac: -1, ri: -1, ci: -1 }
}
// 时窗参数/目标星/天线一改，已算出的结果就与输入对不上了 → 计算按钮转「重算」并变色（与雨衰页同款）。
// 一次都没扫过时不叫「重算」—— 没有旧结果可重，那就是第一次「计算」。
const staleNow = computed(() => !!sp.winInfo.value && sp.winStaleFor(sc.active.value))
// 复制整张结果表为 TSV（含表头，可直接粘进 Excel）。同步 execCommand 优先，剪贴板 API 不可用时兜底。
function copyTsv() {
  const text = sp.toTsv(tblCols.value)
  let ok = false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    ok = document.execCommand('copy')
    document.body.removeChild(ta)
  } catch { ok = false }
  if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch { /* 剪贴板不可用时静默 */ } }
}

// ==================== Excel 导入 / 导出 ====================
// 出表值：数字列写【真数字】（Excel 里能直接算），时刻列写与网格同一条口径的文本。
const xlsxVal = (r, c) => {
  const v = r[c.key]
  if (v == null || v === '') return null
  if (c.time) return sp.fmtCell(c, v)
  if (c.num && typeof v === 'number') return Number.isFinite(v) ? v : null
  return sp.fmtCell(c, v)
}
const ctxName = () => (sp.ctxInfo.value ? sp.ctxInfo.value.satName + '_' + sp.ctxInfo.value.antName : '对星性能')
const viewName = () => (!win.on ? '当前时刻' : '时间窗口')
const noteText = () => {
  const c = sp.ctxInfo.value
  const bits = [c ? '源卫星 ' + c.satName : '', c ? '天线 ' + c.antName : '', '视图 ' + viewName(), stampText.value ? '时刻 ' + stampText.value : '']
  return bits.filter(Boolean).join(' · ')
}
async function exportResultXlsx() {
  if (!tblCols.value.length) { appAlert('当前没有显示任何列'); return }
  const sheets = [
    sheetModel({ name: '性能结果 · ' + viewName(), cols: tblCols.value, rows: resGrid.rows.value, value: xlsxVal, note: noteText() }),
    sheetModel({ name: '目标星', cols: PICK_COLS, rows: pickRows.value, value: (r, c) => r[c.key] })
  ]
  const r = await exportSheets({ defaultName: safeFileName('对星性能指标表_' + ctxName(), '对星性能指标表') + '.xlsx', title: '导出对星性能指标表', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function exportPicksXlsx() {
  if (!pickRows.value.length) { appAlert('还没有目标星'); return }
  const sheets = [sheetModel({ name: '目标星', cols: PICK_COLS, rows: pickRows.value, value: (r, c) => r[c.key] })]
  const r = await exportSheets({ defaultName: safeFileName('目标星_' + ctxName(), '目标星') + '.xlsx', title: '导出目标星', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
// 导入目标星：按表头匹配「目标卫星 / NORAD / 分组」；没有表头则按位置读（第 1 列星名、第 2 列 NORAD）。
// 只落身份（名字 + NORAD），星历仍由页面按身份重新解析 —— 与点选加进来的目标完全同路。
async function importPicksXlsx() {
  if (beamMode.value) { appAlert('「波束内」的目标星随时钟自动重算，切到「点选」再导入'); return }
  const r = await importWorkbook({ title: '导入目标星' })
  if (!r || r.canceled) return
  if (!r.ok) { appAlert('导入失败：' + (r.error || '无法读取该文件')); return }
  // 自家导出的工作簿有「性能结果 + 目标星」两张表，不能取「第一张有数据的」——按表头匹配挑
  const sheet = pickSheet(r.sheets, PICK_COLS)
  if (!sheet) { appAlert('这份工作簿里没有数据'); return }
  const { records } = sheetToRecords(sheet, PICK_COLS)
  const list = records
    ? records.map((x) => ({ name: String(x.name || '').trim(), noradId: Number(x.noradId) || null, group: String(x.group || '').trim() }))
    : sheet.rows.map((cells) => ({ name: String(cells[0] == null ? '' : cells[0]).trim(), noradId: Number(cells[1]) || null, group: String(cells[2] == null ? '' : cells[2]).trim() }))
  const clean = list.filter((x) => x.name)
  if (!clean.length) { appAlert('没有读到卫星名（表头需含「目标卫星」，或把星名放在第一列）'); return }
  const n = sp.addTargets(clean)
  if (!n) appAlert('这些卫星都已在目标星列表里')
  else emit('recompute-table')
}
</script>

<template>
  <!-- 对星性能指标表：上=目标星（点选），下=只读结果表 -->
  <div v-if="tableOpen" class="perf-win" :style="{ left: tw.x + 'px', top: tw.y + 'px', width: tw.w + 'px', height: tw.h + 'px' }">
    <div class="perf-h" @mousedown="dragMove($event, tw)">
      <span class="perf-t">对星性能指标表<em v-if="sp.ctxInfo.value">· {{ sp.ctxInfo.value.satName }} / {{ sp.ctxInfo.value.antName }}</em></span>
      <span class="csx" title="关闭" @click="emit('close-table')"><Icon name="x" :size="12" /></span>
    </div>

    <!-- 上：目标星（第一步——想看哪颗加哪颗；「加入波束内的星」把当前落在方向图里的一次捞进来） -->
    <section class="perf-input" :style="{ height: inH + 'px' }">
      <div class="pin-h">
        <span class="pin-t">目标星</span>
        <span class="seg2 tmseg" role="group" aria-label="目标星来源">
          <span class="sg" :class="{ on: !beamMode }" title="自己加的名单，不随时刻变" @click="sp.targetMode.value = 'pick'">点选</span>
          <span class="sg" :class="{ on: beamMode }" title="此刻落在方向图域内的星，随时钟每拍重算" @click="sp.targetMode.value = 'beam'">波束内</span>
        </span>
        <input v-if="!beamMode" class="perf-q" v-model="tq" placeholder="搜索添加：卫星名 / NORAD / 星座 / 卫星组" />
        <span v-if="!beamMode" class="ptb" title="把当前落在方向图网格域内的在场卫星一次性加为目标" @click="emit('add-in-beam')"><Icon name="plus" :size="12" /> 加入波束内的星</span>
        <span v-if="!beamMode" class="ptb" title="从 Excel 导入目标星（表头含「目标卫星 / NORAD / 分组」，或星名放第一列）" @click="importPicksXlsx"><Icon name="import" :size="12" /> 导入 Excel</span>
        <span class="ptb" :class="{ dis: !pickRows.length }" title="把目标星列表导出为 Excel" @click="exportPicksXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span v-if="!beamMode" class="ptb" :class="{ dis: !sp.picks.value.length }" title="清空目标星列表" @click="sp.clearTargets()">清空</span>
        <span class="perf-cnt">{{ pickRows.length }} 目标</span>
      </div>
      <div v-if="!beamMode && tq.trim()" class="sres">
        <div v-if="cBusy" class="sres-e">搜索中…</div>
        <div v-else-if="!cand.length" class="sres-e">没有匹配的卫星。</div>
        <template v-else>
          <div class="sres-list">
            <div v-for="e in cand" :key="e.noradId || e.name" class="sitem" @click="sp.addTarget(e); tq = ''">
              <div class="nm" :title="e.name" data-i18n-skip>{{ e.name }}</div>
              <div class="sub">{{ e.tag }}<template v-if="e.noradId"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template><template v-if="e.slot"> · {{ e.slot }}</template></div>
            </div>
          </div>
          <div class="sres-n">
            <span>{{ cTotal > cand.length ? `命中 ${cTotal} 颗 · 列出前 ${cand.length}` : `${cTotal} 颗` }}</span>
            <span class="ptb" title="把当前列出的结果全部加为目标星" @click="addAllCands">全选结果</span>
          </div>
        </template>
      </div>
      <ExcelGrid class="pin-body sc-grid" :grid="pickGrid" :cols="PICK_COLS" :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))"
                 :serial="false" :actions-width="46" :row-class="(r) => (hoverId && hoverId === (r.noradId || r.name) ? 'hov' : null)"
                 :empty-text="beamMode ? '当前波束内没有卫星。' : '还没有目标星。'">
        <template #actions="{ row }">
          <span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(row)"><Icon name="crosshair" :size="11" /></span>
          <span v-if="!beamMode" class="del" title="移除该目标星" @click="sp.removeTarget(row.id)"><Icon name="x" :size="11" /></span>
        </template>
      </ExcelGrid>
    </section>

    <!-- 中缝：上下拖拽调整目标星区 / 结果区的高度比例 -->
    <div class="perf-split" title="拖拽调整上下高度" @mousedown="dragSplit"><span class="grip"></span></div>

    <!-- 下：只读性能结果表（第二步——输出）。一行 = 一颗目标星，两档只差在算在哪一刻 -->
    <section class="perf-result">
      <div class="pr-h">
        <span class="pr-t">性能结果<em>只读</em></span>
        <span class="seg2">
          <span class="sg" :class="{ on: !win.on }" title="表跟仿真时钟走" @click="setWinOn(false)">当前时刻</span>
          <span class="sg" :class="{ on: win.on }" title="扫出可见时段，拖游标看任意一刻" @click="setWinOn(true)">时间窗口</span>
        </span>
        <label v-if="tblOpts" class="pr-cov"><input type="checkbox" v-model="tblOpts.filterOn" title="仅列方向性≥阈值（被波束照到）的目标星；取不到值的（域外/背面/遮挡）一并不列" /> 仅照到的星</label>
        <!-- 选项里的数字框一律 .lazy（绑 change 而非 input）：改一下就整表重算，每敲一个字符算一遍且中途
             拿的是半截数字。失焦/回车才生效；▲▼ 微调与上下方向键仍即时生效（规范上它们 input+change 一起发）。
             与对地性能表同一口径，见 ConstellationMap3D.vue 同处注释。 -->
        <label v-if="tblOpts" class="pr-cov" :class="{ dis: !tblOpts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.lazy.number="tblOpts.minDir" :disabled="!tblOpts.filterOn" /><span class="u">dB</span></label>
        <input class="perf-q" v-model="sp.query.value" placeholder="查询：卫星名 / 分组 / NORAD" />
        <span v-if="!win.on" class="ptb" title="按当前时间轴时刻重算" @click="emit('recompute-table')"><Icon name="refresh-cw" :size="11" /> 重算</span>
        <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="copyTsv"><Icon name="copy" :size="11" /> 复制全表</span>
        <span class="ptb" title="导出为 Excel（结果表 + 目标星两张工作表；数字列存真数字）" @click="exportResultXlsx"><Icon name="download" :size="11" /> 导出 Excel</span>
        <span class="ptb" :class="{ on: optsOpen }" title="显示列 / 波束筛选 / 参数计算 / 指向误差" @click="optsOpen = !optsOpen"><Icon name="settings" :size="11" /> 选项…</span>
        <span class="perf-cnt">{{ sp.filteredRows.value.length }} 行</span>
      </div>

      <!-- 时窗参数：只剩起点 + 时长（窗口判据＝域内且视线通，不再有门限/角步进档）。改任一项即标「输入已变」 -->
      <div v-if="win.on" class="pw-bar">
        <label>起始</label>
        <input class="ci dt" type="datetime-local" step="1" v-model="startLocal" />
        <span class="ptb sq" :class="{ dis: win.startMs == null }" title="回到跟随时间轴当前时刻" @click="win.startMs = null"><Icon name="refresh-cw" :size="10" /></span>
        <label>时长</label>
        <input class="ci w56" type="number" step="1" min="0.02" max="720" v-model.number="win.durH" /><span class="u">h</span>
        <span v-if="!win.busy" class="ptb go" :class="{ warn: staleNow }" title="扫描全部目标星在该时窗内的可见时段" @click="emit('scan-windows')">
          <Icon name="play" :size="11" /> {{ staleNow ? '重算' : '计算' }}
        </span>
        <span v-else class="ptb" title="中止本次扫描" @click="sp.cancelWindows()"><Icon name="x" :size="11" /> 取消 {{ Math.round(win.progress * 100) }}%</span>
        <span v-if="win.busy" class="pw-prog"><i :style="{ width: (win.progress * 100) + '%' }"></i></span>
        <span v-else-if="wi" class="perf-cnt">{{ wi.nLit }}/{{ wi.nTarget }} 有窗口 · {{ wi.nWin }} 个时段 · {{ durText((wi.t1Ms - wi.t0Ms) / 60000) }}</span>
      </div>

      <!-- 可见时段条带：一行一颗目标星，横轴 = 整个时窗；条上按住拖动 = 挪游标（落在窗口里先吸到峰值）。
           悬停与结果行互相高亮；星名可点，聚焦该星。 -->
      <div v-if="win.on && wi && bands.length" class="sgantt">
        <div class="sgt-ax">
          <span>{{ sp.fmtCell({ time: true }, wi.t0Ms) }}</span>
          <span class="mid">{{ durText((wi.t1Ms - wi.t0Ms) / 60000) }}</span>
          <span>{{ sp.fmtCell({ time: true }, wi.t1Ms) }}</span>
        </div>
        <div class="sgt-rows">
          <div v-for="b in bands" :key="b.id" class="sgt-row" :class="{ hov: hoverId === b.id }"
               :title="b.name + ' · ' + b.nWin + ' 次 · 总 ' + durText(b.totMin) + ' · 占比 ' + b.pct.toFixed(1) + '%'"
               @mouseenter="hoverId = b.id" @mouseleave="hoverId = ''">
            <span class="sgt-n" data-i18n-skip @click="emit('focus-target', { name: b.name, noradId: b.noradId })">{{ b.name }}</span>
            <span class="sgt-bar" @pointerdown="barDown($event, b)">
              <i v-for="(s, si) in b.segs" :key="si" :style="{ left: (s.a * 100) + '%', width: Math.max(0.35, (s.b - s.a) * 100) + '%' }"></i>
              <b class="sgt-cur" :style="{ left: (curFrac * 100) + '%' }"></b>
            </span>
            <span class="sgt-c">{{ b.nWin }}</span>
          </div>
        </div>
        <!-- 游标：滑块细调（条上像素粒度不够时）+ 读数 + 在窗口峰值间前后跳 -->
        <div class="swc">
          <span class="ptb sq" title="上一个窗口峰值" @click="jumpPeak(-1)"><Icon name="chevron-left" :size="11" /></span>
          <input class="swc-sl" type="range" :min="wi.t0Ms" :max="wi.t1Ms" step="1000" :value="curMs"
                 @input="seek(Number($event.target.value))" />
          <span class="ptb sq" title="下一个窗口峰值" @click="jumpPeak(1)"><Icon name="chevron-right" :size="11" /></span>
          <span class="swc-t">{{ sp.fmtCell({ time: true }, curMs) }}</span>
          <span class="perf-cnt">窗口内 {{ inWinCount }} 颗</span>
          <span class="ptb" title="把主时间轴跳到游标时刻（画面上的星位随之走到这一刻）" @click="emit('seek-clock', curMs)">同步到时间轴</span>
        </div>
      </div>

      <ExcelGrid class="pr-body sc-grid" :grid="resGrid" :cols="tblCols" :text="(r, c) => fmt(c, r[c.key])"
                 :serial="!tblCols.some((c) => c.key === 'no')" :actions-width="26"
                 :row-class="(r) => [r.state ? 'out' : null, hoverId && hoverId === (r.noradId || r.tgtName) ? 'hov' : null]"
                 :cell-class="(r, c) => (c.key === 'state' && r.state ? 'occ' : null)"
                 :empty-text="resEmptyText"
                 @row-enter="(r) => hoverId = r.noradId || r.tgtName" @row-leave="hoverId = ''">
        <template #actions="{ row }">
          <span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(row)"><Icon name="crosshair" :size="11" /></span>
        </template>
      </ExcelGrid>
      <div class="pr-foot">{{ sp.footNote.value }}<span v-if="stampText" class="tl">{{ stampText }}</span></div>
    </section>

    <div class="prh prh-n" @mousedown="dragResize($event, tw, 'n', true)"></div>
    <div class="prh prh-s" @mousedown="dragResize($event, tw, 's', true)"></div>
    <div class="prh prh-w" @mousedown="dragResize($event, tw, 'w', true)"></div>
    <div class="prh prh-e" @mousedown="dragResize($event, tw, 'e', true)"></div>
    <div class="prh prh-nw" @mousedown="dragResize($event, tw, 'nw', true)"></div>
    <div class="prh prh-ne" @mousedown="dragResize($event, tw, 'ne', true)"></div>
    <div class="prh prh-sw" @mousedown="dragResize($event, tw, 'sw', true)"></div>
    <div class="perf-rsz" title="拖拽缩放窗口" @mousedown="dragResize($event, tw, 'se', true)"></div>
  </div>

  <!-- 表选项：与对地性能表选项同款（显示列 / 波束筛选 / 过滤 / 参数计算 / 指向误差） -->
  <div v-if="optsOpen && tblOpts" class="sat-mask perf-opt-mask" @click.self="optsOpen = false">
    <div class="perf-opt-dlg">
      <div class="sdh"><span>对星性能表选项<em v-if="sp.ctxInfo.value"> · {{ sp.ctxInfo.value.antName }}</em></span><span class="csx" @click="optsOpen = false"><Icon name="x" :size="12" /></span></div>
      <div class="perf-opt-body">
        <!-- 显示列：两档时间口径共用一套（当前时刻与时窗游标报的是同一批量，只是算在不同时刻） -->
        <section class="po-card po-cols">
          <div class="po-ct">显示列</div>
          <div class="po-scroll">
            <div v-for="g in sp.colGroups" :key="g.title" class="po-grp">
              <div class="po-gt">{{ g.title }}</div>
              <label v-for="k in g.keys" :key="k" class="po-ck">
                <input type="checkbox" v-model="tblOpts.cols[k]" /><span>{{ sp.colDefs.find((c) => c.key === k).label }}</span>
              </label>
            </div>
          </div>
        </section>
        <div class="po-right">
          <section v-if="sp.ctxBeams.value.length > 1" class="po-card">
            <div class="po-ct">波束筛选</div>
            <input class="ci bq" :value="sp.beamQuery.value" placeholder="搜索：波束名，或序号 1-62、1,3,5、1-10,20-30" @input="e => sp.beamQuery.value = e.target.value" />
            <div class="bplist">
              <label class="brow ball">
                <input type="checkbox" :checked="sp.filteredAllOn(tblOpts)" :indeterminate.prop="sp.filteredAnyOn(tblOpts) && !sp.filteredAllOn(tblOpts)" @change="sp.selectFiltered(tblOpts, !sp.filteredAllOn(tblOpts))" />
                <span class="balln">{{ sp.beamQuery.value.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
                <span class="bpk">{{ sp.beamSelCount(tblOpts) }}/{{ sp.ctxBeams.value.length }}</span>
              </label>
              <label v-for="b in sp.filteredBeams()" :key="b.seq" class="brow" :class="{ on: sp.beamOn(tblOpts, b.bi) }">
                <input type="checkbox" :checked="sp.beamOn(tblOpts, b.bi)" @change="sp.toggleBeam(tblOpts, b.bi)" />
                <span class="bseq">{{ b.seq }}</span>
                <span class="pbnm" :title="b.name" data-i18n-skip>{{ b.name }}</span>
                <span class="bpk">{{ b.peakDb == null ? '—' : b.peakDb.toFixed(1) }}</span>
              </label>
              <div v-if="!sp.filteredBeams().length" class="empty">无匹配波束</div>
            </div>
          </section>

          <section class="po-card">
            <div class="po-ct">过滤</div>
            <label class="po-chk"><input type="checkbox" v-model="tblOpts.filterOn" /><span>剔除低于最低方向性的记录</span></label>
            <div class="po-row"><label>最低方向性</label><input class="ci" type="number" step="0.5" v-model.lazy.number="tblOpts.minDir" :disabled="!tblOpts.filterOn" /><span class="u">dB</span></div>
          </section>

          <section class="po-card">
            <div class="po-ct">参数计算</div>
            <label class="po-chk"><input type="checkbox" v-model="tblOpts.sameAsAnt" /><span>与天线当前设置一致</span></label>
            <template v-if="!tblOpts.sameAsAnt">
              <div class="po-row"><label>极化</label><select v-model="tblOpts.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
              <div class="po-row"><label>路径损耗</label><select v-model="tblOpts.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>
              <div class="po-row"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.lazy.number="tblOpts.gainOffset" /><span class="u">dB</span></div>
            </template>
          </section>

          <section class="po-card">
            <div class="po-ct">指向误差 · Min/Max Pointing</div>
            <div class="po-row"><label>方位 Az</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="tblOpts.pointAz" /><span class="u">°</span></div>
            <div class="po-row"><label>俯仰 El</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="tblOpts.pointEl" /><span class="u">°</span></div>
            <div class="po-row"><label>偏航 Yaw</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="tblOpts.pointYaw" /><span class="u">°</span></div>
          </section>
        </div>
      </div>
      <div class="sdfoot"><span class="save ghost po-reset" title="将当前天线的表选项恢复为默认值（列 / 波束筛选 / 口径 / 指向误差）" @click="resetOpts">恢复默认</span><span class="save" @click="optsOpen = false">完成</span></div>
    </div>
  </div>
</template>

<style scoped>
/* 与「对地覆盖分析」性能指标表浮窗同源（ConstellationMap3D.vue 的 .perf-win 一套）：那份是 scoped 的、
   进不到本组件，故这里带一份同值副本。改动请两处对照。 */
.perf-win { position: absolute; display: flex; flex-direction: column; background: var(--panel, var(--bg)); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 40px rgba(0, 0, 0, .35); z-index: 60; overflow: hidden; }
.perf-h { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; cursor: move; user-select: none; }
.perf-t { flex: 1; min-width: 0; font-family: var(--font-serif); font-size: 13.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.perf-t em { font-style: normal; font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); margin-left: 4px; }
.perf-h .csx { cursor: pointer; color: var(--text-faint); padding: 0 4px; position: relative; z-index: 5; display: inline-flex; }
.perf-h .csx:hover { color: var(--text); }
.ptb { font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; }
.ptb:hover { color: var(--text); border-color: var(--accent); }
.ptb.dis { opacity: .38; pointer-events: none; }
.ptb.on { color: var(--accent); border-color: var(--accent); }
.perf-q { flex: 1; min-width: 110px; border: 1px solid var(--border); background: var(--bg); padding: 2px 8px; font-size: 11.5px; color: var(--text); border-radius: 4px; outline: none; }
.perf-cnt { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; margin-left: auto; }
.perf-input { flex: none; display: flex; flex-direction: column; min-height: 0; }
.perf-split { flex: none; height: 7px; cursor: ns-resize; background: var(--border); display: flex; align-items: center; justify-content: center; }
.perf-split:hover { background: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.perf-split .grip { width: 30px; height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--text) 35%, transparent); }
.prh { position: absolute; z-index: 3; }
.prh-n { top: 0; left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
.prh-s { bottom: 0; left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
.prh-w { left: 0; top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
.prh-e { right: 0; top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
.prh-nw { left: 0; top: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 4; }
.prh-ne { right: 0; top: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 4; }
.prh-sw { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 4; }
.perf-rsz { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 4; background: linear-gradient(135deg, transparent 50%, color-mix(in srgb, var(--text) 30%, transparent) 50%, color-mix(in srgb, var(--text) 30%, transparent) 62%, transparent 62%, transparent 74%, color-mix(in srgb, var(--text) 30%, transparent) 74%, color-mix(in srgb, var(--text) 30%, transparent) 86%, transparent 86%); }
.pin-h, .pr-h { display: flex; align-items: center; gap: 6px; padding: 6px 12px; flex: none; flex-wrap: wrap; }
.pin-h { border-bottom: 1px solid var(--border); }
.pin-t, .pr-t { font-size: 11.5px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.pr-t em { margin-left: 4px; font-style: normal; font-size: 10px; font-weight: 400; color: var(--text-faint); border: 1px solid var(--border); border-radius: 6px; padding: 0 5px; }
.pin-body { flex: 1; overflow: auto; outline: none; }
.perf-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pr-h { border-bottom: 1px solid var(--border); }
.pr-cov { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); white-space: nowrap; cursor: pointer; }
.pr-cov.dis { opacity: .5; }
.pr-cov input[type=checkbox] { accent-color: var(--accent); }
.pr-cov .ci { width: 52px; border: 1px solid var(--border); background: var(--bg); padding: 1px 5px; font-size: 11px; color: var(--text); border-radius: 4px; outline: none; font-family: var(--font-mono); }
.pr-cov .ci:disabled { opacity: .45; }
.pr-cov .u { color: var(--text-faint); font-size: 10.5px; }
.pr-body { flex: 1; overflow: auto; outline: none; }
.pr-foot { flex: none; padding: 3px 12px; border-top: 1px solid var(--border); font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); display: flex; gap: 10px; }
.pr-foot .tl { margin-left: auto; }
/* 两张网格都交给 ExcelGrid（src/components/ExcelGrid.vue）渲染，表体样式在那边；这里只补本窗口
   特有的行/格着色与操作列图标。子组件渲染出来的节点带的是【它自己】的 scoped 标记，故一律走 :deep()。 */
.sc-grid :deep(td.occ) { color: #d08b5a; }
.sc-grid :deep(tr.out td) { color: var(--text-faint); }
.sc-grid :deep(tbody tr.hov > td) { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sc-grid :deep(.eg-act .del), .sc-grid :deep(.eg-act .foc) { cursor: pointer; color: var(--text-faint); opacity: 0; display: inline-flex; vertical-align: middle; }
.sc-grid :deep(.eg-act .foc) { margin-right: 4px; }
.sc-grid :deep(tbody tr:hover .del), .sc-grid :deep(tbody tr:hover .foc) { opacity: .8; }
.sc-grid :deep(.eg-act .del:hover) { color: #ff6a6a; }
.sc-grid :deep(.eg-act .foc:hover) { color: var(--accent); }
/* 两段/三段切换（当前时刻⇄时间窗口、时段⇄汇总）：与可见性分析 .seg.sm.vis-mode 同一套锐边分段语言。
   活动段文字用 var(--bg) 而非写死 #fff —— 深色主题下 accent≈白，写死白字＝白底白字。 */
.seg2 { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; background: var(--surface); flex: none; }
.seg2 .sg { padding: 2px 9px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; user-select: none; white-space: nowrap; transition: background .12s ease, color .12s ease; }
.seg2 .sg + .sg { border-left: 1px solid var(--border); }
.seg2 .sg:hover:not(.on) { background: var(--bg); color: var(--text); }
.seg2 .sg.on { background: var(--accent); color: var(--bg); font-weight: 600; }
.seg2 .sg.on, .seg2 .sg.on + .sg { border-left-color: transparent; }
/* 时窗参数条 */
.pw-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 5px 12px; border-bottom: 1px solid var(--border); flex: none; }
.pw-bar label { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.pw-bar .ci, .pw-bar select { border: 1px solid var(--border); background: var(--bg); padding: 1px 5px; font-size: 11px; color: var(--text); border-radius: 4px; outline: none; font-family: var(--font-mono); }
.pw-bar .ci.dt { width: 150px; }
.pw-bar .w56 { width: 56px; }
.pw-bar .u { color: var(--text-faint); font-size: 10.5px; }
.pw-bar .ptb.sq { padding: 2px 5px; }
.pw-bar .ptb.go { color: var(--accent); border-color: var(--accent); }
.pw-bar .ptb.go.warn { color: var(--warn, #d08b5a); border-color: var(--warn, #d08b5a); }
.pw-prog { flex: 1; min-width: 60px; height: 3px; background: color-mix(in srgb, var(--border) 60%, transparent); border-radius: 2px; overflow: hidden; }
.pw-prog i { display: block; height: 100%; background: var(--accent); transition: width .12s linear; }
/* 可见时段条带：与可见性分析 ACCESS 甘特同款（78px 星名 + 轨道条 + 次数），条上多一根游标 */
.sgantt { flex: none; border-bottom: 1px solid var(--border); padding: 4px 12px 6px; }
/* 轴的左右内缩要与条带列宽对齐（名字 78 + 间隔 6 ｜ 次数 26 + 间隔 6），否则末端时刻标在条外 32px 处 */
.sgt-ax { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 9.5px; color: var(--text-faint); padding: 0 32px 3px 84px; }
.sgt-ax .mid { color: var(--text-muted); }
.sgt-rows { display: flex; flex-direction: column; gap: 2px; max-height: 150px; overflow-y: auto; }
.sgt-row { display: grid; grid-template-columns: 78px 1fr 26px; gap: 6px; align-items: center; font-size: 10.5px; padding: 1px 3px; border-radius: 3px; }
.sgt-row:hover, .sgt-row.hov { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.sgt-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); cursor: pointer; }
.sgt-n:hover { color: var(--accent); }
.sgt-bar { position: relative; height: 9px; background: color-mix(in srgb, var(--border) 45%, transparent); border-radius: 2px; cursor: col-resize; touch-action: none; }
.sgt-bar i { position: absolute; top: 1px; bottom: 1px; min-width: 1.2px; background: var(--accent); border-radius: 1px; }
/* 游标：上下各探出 3px，正好把行间距接上，多行看着是一根通条的线 */
.sgt-cur { position: absolute; top: -3px; bottom: -3px; width: 1px; margin-left: -0.5px; background: var(--text); pointer-events: none; }
.sgt-c { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); text-align: right; }
/* 游标控制条（滑块 + 读数 + 前后跳），与「星间链路距离」工具同款 */
.swc { display: flex; align-items: center; gap: 6px; padding-top: 5px; }
.swc-sl { flex: 1; min-width: 80px; accent-color: var(--accent); height: 12px; }
.swc-t { font-family: var(--font-mono); font-size: 11px; color: var(--text); white-space: nowrap; user-select: text; }
.swc .perf-cnt { margin-left: 0; }
.po-cv { font-style: normal; font-weight: 400; color: var(--text-faint); margin-left: 5px; font-size: 10px; }
/* 目标星搜索结果：与主界面搜索下拉 / 卫星组管理器同款（一行一颗 + 「来源 · NORAD」副行 + 命中读数） */
.sres { flex: none; border-bottom: 1px solid var(--border); background: var(--bg); }
.sres-list { max-height: 168px; overflow-y: auto; }
.sitem { padding: 4px 12px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); cursor: pointer; }
.sitem:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sitem .nm { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sitem .sub { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.sres-e { padding: 6px 12px; font-size: 11.5px; color: var(--text-faint); }
.sres-n { display: flex; align-items: center; gap: 8px; padding: 3px 12px; border-top: 1px solid var(--border); font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.sres-n .ptb { margin-left: auto; font-size: 10.5px; font-family: inherit; }
/* 表选项弹窗 */
.sat-mask { position: absolute; inset: 0; background: rgba(4, 8, 14, .55); display: flex; align-items: center; justify-content: center; z-index: 70; }
.perf-opt-dlg { width: 700px; max-width: calc(100% - 32px); max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .55); }
.sdh { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: 14px; color: var(--text); }
.sdh em { font-style: normal; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-faint); }
.sdh .csx { margin-left: auto; cursor: pointer; color: var(--text-faint); display: inline-flex; }
.sdh .csx:hover { color: var(--text); }
.sdfoot { display: flex; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
.sdfoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: 12px; margin-left: auto; }
.sdfoot .save.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
.sdfoot .po-reset { margin-right: auto; margin-left: 0; }
.perf-opt-body { display: flex; gap: 12px; padding: 12px; overflow: auto; align-items: stretch; }
.po-card { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: color-mix(in srgb, var(--text) 2.5%, transparent); }
.po-ct { font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: .3px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.po-cols { flex: 0 0 280px; display: flex; flex-direction: column; }
.po-scroll { flex: 1; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; align-content: start; }
.po-grp { display: contents; }
.po-gt { grid-column: 1 / -1; font-size: 10px; color: var(--text-faint); margin: 6px 0 1px; letter-spacing: .5px; }
.po-gt:first-child { margin-top: 0; }
.po-ck { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: 11.5px; color: var(--text); cursor: pointer; min-width: 0; }
.po-ck span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-ck input { flex: none; accent-color: var(--accent); }
.po-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.po-chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; padding: 1px 0; }
.po-chk input { accent-color: var(--accent); }
.po-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
.po-row label { flex: 0 0 64px; color: var(--text-muted); }
.po-row .ci, .po-row select { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 12px; color: var(--text); border-radius: 4px; outline: none; }
.po-row .ci:disabled { opacity: .45; }
.po-row .u { flex: none; color: var(--text-faint); font-size: 11px; }
.po-card .ci.bq { width: 100%; box-sizing: border-box; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); border-radius: 4px; outline: none; }
.bplist { border: 1px solid var(--border); border-radius: 2px; margin-top: 5px; max-height: 300px; min-height: 48px; overflow-y: auto; resize: vertical; }
.brow { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: pointer; font-size: 11.5px; color: var(--text-muted); }
.brow + .brow { border-top: 1px solid var(--border); }
.brow:hover { background: var(--bg); }
.brow input { accent-color: var(--accent); }
.brow .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.brow .bpk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.brow .pbnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brow.on .pbnm { color: var(--text); }
.brow.ball { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--border); }
.brow.ball + .brow { border-top: 0; }
.brow .balln { flex: 1; color: var(--text); font-weight: 600; }
.empty { color: var(--text-faint); padding: 4px 8px; font-size: 11px; }
</style>
