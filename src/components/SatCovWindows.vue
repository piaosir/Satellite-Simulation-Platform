<script setup>
// 对星覆盖分析的浮窗：对星性能指标表。
// ★ 窗口外壳与结果表与「对地覆盖分析」的性能指标表【同款】：圆角窗 + 8 向缩放 + 中缝分隔，
//   上区=目标星（对地那边是城市），下区=只读 Excel 网格（框选 / Ctrl+C 复制选区 / 方向键导航），
//   顶上一条 pr-h 工具条 + 「选项…」弹窗（显示列 / 波束筛选 / 过滤 / 参数计算 / 指向误差）。
//   两张表的口径差别见 useSatPerfTable 文件头（一行=一颗目标星、目标由点选），UI 不再另立一套。
// ★ 两种时间口径共用这一个结果区（列定义与行由 sp.viewMode 切换，渲染/选区/复制只有一条路径）：
//   · 当前时刻 —— 一行 = 一颗目标星；
//   · 时间窗口 —— 时段视图一行 = 一次「照到」的时段，汇总视图一行 = 一颗目标星的时窗统计；
//     上面再压一条甘特条带，一眼看出并发与空档（与可见性分析 ACCESS 甘特同一套视觉语言）。
import { ref, computed, reactive, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'

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
const emit = defineEmits(['close-table', 'recompute-table', 'add-in-beam', 'scan-windows', 'focus-target'])
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
const tblCols = computed(() => (tblOpts.value ? sp.viewCols(tblOpts.value) : []))
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
// 表脚的时刻：瞬时表报【这批数值算在哪一刻】（跟随仿真时钟；重算太贵跳拍时它会比时间轴慢一两拍，
// 那正是这些数真正对应的时刻）；时段表的时刻在结果里逐行给，脚上只报时间轴当前值。
const stampText = computed(() => {
  if (win.on) return props.timeLabel
  const ms = sp.stampMs.value
  return Number.isFinite(ms) ? sp.fmtCell({ time: true }, ms) : props.timeLabel
})
const durText = (min) => (min >= 1440 ? (min / 1440).toFixed(1) + ' d' : min >= 60 ? (min / 60).toFixed(1) + ' h' : min.toFixed(1) + ' min')
const bands = computed(() => (sp.winInfo.value && sp.winInfo.value.bands) || [])
const hoverId = ref('')
// 甘特行 / 结果行 → 聚焦该目标星（旋转地球正对它并选中，与搜索结果点选同一路径）
function focusRow(r) { if (r && (r.tgtName || r.name)) emit('focus-target', { name: r.tgtName || r.name, noradId: r.noradId }) }
// 切视图 = 换了一套列与行，旧选区的行列号已无意义 → 收回到左上角，别让高亮框落在别的格子上
watch(() => [win.on, win.view], () => { resGrid.sel.value = { ar: -1, ac: -1, ri: -1, ci: -1 } })
// 时窗参数/目标星/天线一改，已算出的结果就与输入对不上了 → 计算按钮转「重算」并变色（与雨衰页同款）
const staleNow = computed(() => sp.winStaleFor(sc.active.value))
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
              <div class="sub">{{ e.tag }}<template v-if="e.noradId"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template></div>
            </div>
          </div>
          <div class="sres-n">
            <span>{{ cTotal > cand.length ? `命中 ${cTotal} 颗 · 列出前 ${cand.length}` : `${cTotal} 颗` }}</span>
            <span class="ptb" title="把当前列出的结果全部加为目标星" @click="addAllCands">全选结果</span>
          </div>
        </template>
      </div>
      <div class="pin-body" :ref="el => pickGrid.bodyEl.value = el" tabindex="0" @keydown="pickGrid.gridKey" @click="pickGrid.focusGrid">
        <table class="perf-tbl grid ro">
          <thead>
            <tr><th v-for="c in PICK_COLS" :key="c.key" :class="{ n: c.num }">{{ c.label }}</th><th class="th-act"></th></tr>
          </thead>
          <tbody>
            <tr v-for="(p, ri) in pickRows" :key="p.id" :class="{ hov: hoverId && hoverId === (p.noradId || p.name) }">
              <td v-for="(c, ci) in PICK_COLS" :key="c.key"
                  :class="{ n: c.num, sel: pickGrid.inSel(ri, ci), active: pickGrid.isActive(ri, ci) }"
                  @mousedown="pickGrid.cellDown($event, ri, ci)" @mouseenter="pickGrid.cellEnter(ri, ci)">{{ p[c.key] == null ? '' : p[c.key] }}</td>
              <td class="td-act">
                <span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(p)"><Icon name="crosshair" :size="11" /></span>
                <span v-if="!beamMode" class="del" title="移除该目标星" @click="sp.removeTarget(p.id)"><Icon name="x" :size="11" /></span>
              </td>
            </tr>
            <tr v-if="!pickRows.length"><td class="pin-empty" :colspan="PICK_COLS.length + 1">{{ beamMode ? '当前波束内没有卫星。' : '还没有目标星。' }}</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 中缝：上下拖拽调整目标星区 / 结果区的高度比例 -->
    <div class="perf-split" title="拖拽调整上下高度" @mousedown="dragSplit"><span class="grip"></span></div>

    <!-- 下：只读性能结果表（第二步——输出）。当前时刻：一行 = 一颗目标星；时间窗口：一行 = 一次时段 / 一颗星的统计 -->
    <section class="perf-result">
      <div class="pr-h">
        <span class="pr-t">性能结果<em>只读</em></span>
        <span class="seg2">
          <span class="sg" :class="{ on: !win.on }" @click="win.on = false">当前时刻</span>
          <span class="sg" :class="{ on: win.on }" @click="win.on = true">时间窗口</span>
        </span>
        <template v-if="!win.on">
          <label v-if="tblOpts" class="pr-cov"><input type="checkbox" v-model="tblOpts.filterOn" title="仅列方向性≥阈值（被波束照到）的目标星" /> 仅照到的星</label>
          <label v-if="tblOpts" class="pr-cov" :class="{ dis: !tblOpts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.number="tblOpts.minDir" :disabled="!tblOpts.filterOn" /><span class="u">dB</span></label>
        </template>
        <template v-else>
          <span class="seg2">
            <span class="sg" :class="{ on: win.view === 'seg' }" @click="win.view = 'seg'">时段</span>
            <span class="sg" :class="{ on: win.view === 'sum' }" @click="win.view = 'sum'">汇总</span>
          </span>
          <span class="ptb" :class="{ on: win.gantt }" title="时段甘特条带" @click="win.gantt = !win.gantt">甘特</span>
        </template>
        <input class="perf-q" v-model="sp.query.value" placeholder="查询：卫星名 / 分组 / NORAD" />
        <span v-if="!win.on" class="ptb" title="按当前时间轴时刻重算" @click="emit('recompute-table')"><Icon name="refresh-cw" :size="11" /> 重算</span>
        <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="copyTsv"><Icon name="copy" :size="11" /> 复制全表</span>
        <span class="ptb" :class="{ on: optsOpen }" title="显示列 / 波束筛选 / 参数计算 / 指向误差" @click="optsOpen = !optsOpen"><Icon name="settings" :size="11" /> 选项…</span>
        <span class="perf-cnt">{{ sp.filteredRows.value.length }} 行</span>
      </div>

      <!-- 时窗参数：起点/时长/门限/遮挡/角步进 + 扫描按钮。改任一项即标「输入已变」，等点重算 -->
      <div v-if="win.on" class="pw-bar">
        <label>起始</label>
        <input class="ci dt" type="datetime-local" step="1" v-model="startLocal" />
        <span class="ptb sq" :class="{ dis: win.startMs == null }" title="回到跟随时间轴当前时刻" @click="win.startMs = null"><Icon name="refresh-cw" :size="10" /></span>
        <label>时长</label>
        <input class="ci w56" type="number" step="1" min="0.02" max="720" v-model.number="win.durH" /><span class="u">h</span>
        <label>门限</label>
        <select class="ci w104" v-model="win.thrMode">
          <option value="rel">相对波束峰值</option>
          <option value="abs">绝对方向性</option>
        </select>
        <input v-if="win.thrMode === 'rel'" class="ci w56" type="number" step="0.5" v-model.number="win.thrRel" />
        <input v-else class="ci w56" type="number" step="0.5" v-model.number="win.thrAbs" />
        <span class="u">dB</span>
        <label class="pr-cov"><input type="checkbox" v-model="win.losOn" title="星-星视线被地球挡住时出窗" /> 视线遮挡</label>
        <label>角步进</label>
        <select class="ci w76" v-model="win.res">
          <option value="coarse">粗</option>
          <option value="std">标准</option>
          <option value="fine">精细</option>
        </select>
        <span v-if="!win.busy" class="ptb go" :class="{ warn: staleNow }" title="按上述时窗扫描全部目标星的照射时段" @click="emit('scan-windows')">
          <Icon name="play" :size="11" /> {{ staleNow ? '重算' : '计算' }}
        </span>
        <span v-else class="ptb" title="中止本次扫描" @click="sp.cancelWindows()"><Icon name="x" :size="11" /> 取消 {{ Math.round(win.progress * 100) }}%</span>
        <span v-if="win.busy" class="pw-prog"><i :style="{ width: (win.progress * 100) + '%' }"></i></span>
        <span v-else-if="sp.winInfo.value" class="perf-cnt">{{ sp.winInfo.value.nLit }}/{{ sp.winInfo.value.nTarget }} 有窗口 · {{ durText((sp.winInfo.value.t1Ms - sp.winInfo.value.t0Ms) / 60000) }}</span>
      </div>

      <!-- 甘特条带：一行一颗目标星，横轴 = 整个时窗。悬停与结果行互相高亮，点击聚焦该星 -->
      <div v-if="win.on && win.gantt && bands.length" class="sgantt">
        <div class="sgt-ax">
          <span>{{ sp.fmtCell({ time: true }, sp.winInfo.value.t0Ms) }}</span>
          <span class="mid">{{ durText((sp.winInfo.value.t1Ms - sp.winInfo.value.t0Ms) / 60000) }}</span>
          <span>{{ sp.fmtCell({ time: true }, sp.winInfo.value.t1Ms) }}</span>
        </div>
        <div class="sgt-rows">
          <div v-for="b in bands" :key="b.id" class="sgt-row" :class="{ hov: hoverId === b.id }"
               :title="b.name + ' · ' + b.nWin + ' 次'" @mouseenter="hoverId = b.id" @mouseleave="hoverId = ''"
               @click="emit('focus-target', { name: b.name, noradId: b.id })">
            <span class="sgt-n" data-i18n-skip>{{ b.name }}</span>
            <span class="sgt-bar"><i v-for="(s, si) in b.segs" :key="si" :style="{ left: (s.a * 100) + '%', width: Math.max(0.35, (s.b - s.a) * 100) + '%' }"></i></span>
            <span class="sgt-c">{{ b.nWin }}</span>
          </div>
        </div>
      </div>

      <div class="pr-body" :ref="el => resGrid.bodyEl.value = el" tabindex="0" @keydown="resGrid.gridKey" @click="resGrid.focusGrid">
        <table class="perf-tbl grid ro">
          <thead>
            <tr><th v-for="c in tblCols" :key="c.key" :style="{ width: c.w + 'px' }" :class="{ n: c.num }" :title="c.tip || ''">
              {{ c.label }}<i v-if="c.unit" class="cu">({{ c.unit }})</i>
            </th><th class="th-act"></th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, ri) in sp.filteredRows.value" :key="r.id" :class="{ out: !!r.state, hov: hoverId && hoverId === (r.noradId || r.tgtName) }"
                @mouseenter="hoverId = r.noradId || r.tgtName" @mouseleave="hoverId = ''">
              <td v-for="(c, ci) in tblCols" :key="c.key"
                  :class="{ n: c.num, occ: c.key === 'state' && r.state, sel: resGrid.inSel(ri, ci), active: resGrid.isActive(ri, ci) }"
                  @mousedown="resGrid.cellDown($event, ri, ci)" @mouseenter="resGrid.cellEnter(ri, ci)">{{ fmt(c, r[c.key]) }}</td>
              <td class="td-act"><span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(r)"><Icon name="crosshair" :size="11" /></span></td>
            </tr>
            <tr v-if="!pickRows.length"><td :colspan="Math.max(1, tblCols.length) + 1" class="perf-empty">{{ beamMode ? '当前波束内没有卫星。' : '还没有目标星。' }}</td></tr>
            <tr v-else-if="win.on && !sp.winInfo.value"><td :colspan="Math.max(1, tblCols.length) + 1" class="perf-empty">尚未扫描时段。</td></tr>
            <tr v-else-if="!sp.filteredRows.value.length"><td :colspan="Math.max(1, tblCols.length) + 1" class="perf-empty">{{ win.on ? '时窗内没有照到任何目标星。' : '这些目标星都没有取到值。' }}</td></tr>
          </tbody>
        </table>
      </div>
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
        <!-- 显示列跟着当前视图走：三种视图三套列，各存各的（切回去还是原来那几列） -->
        <section class="po-card po-cols">
          <div class="po-ct">显示列<em class="po-cv">{{ sp.viewMode.value === 'now' ? '当前时刻' : sp.viewMode.value === 'seg' ? '时段' : '汇总' }}</em></div>
          <div class="po-scroll">
            <div v-for="g in sp.colGroupsOf(sp.viewMode.value)" :key="g.title" class="po-grp">
              <div class="po-gt">{{ g.title }}</div>
              <label v-for="k in g.keys" :key="k" class="po-ck">
                <input type="checkbox" v-model="tblOpts[sp.colKeyOf(sp.viewMode.value)][k]" /><span>{{ sp.colDefsOf(sp.viewMode.value).find((c) => c.key === k).label }}</span>
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
            <div class="po-row"><label>最低方向性</label><input class="ci" type="number" step="0.5" v-model.number="tblOpts.minDir" :disabled="!tblOpts.filterOn" /><span class="u">dB</span></div>
          </section>

          <section class="po-card">
            <div class="po-ct">参数计算</div>
            <label class="po-chk"><input type="checkbox" v-model="tblOpts.sameAsAnt" /><span>与天线当前设置一致</span></label>
            <template v-if="!tblOpts.sameAsAnt">
              <div class="po-row"><label>极化</label><select v-model="tblOpts.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
              <div class="po-row"><label>路径损耗</label><select v-model="tblOpts.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>
              <div class="po-row"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.number="tblOpts.gainOffset" /><span class="u">dB</span></div>
            </template>
          </section>

          <section class="po-card">
            <div class="po-ct">指向误差 · Min/Max Pointing</div>
            <div class="po-row"><label>方位 Az</label><input class="ci" type="number" step="any" min="0" v-model.number="tblOpts.pointAz" /><span class="u">°</span></div>
            <div class="po-row"><label>俯仰 El</label><input class="ci" type="number" step="any" min="0" v-model.number="tblOpts.pointEl" /><span class="u">°</span></div>
            <div class="po-row"><label>偏航 Yaw</label><input class="ci" type="number" step="any" min="0" v-model.number="tblOpts.pointYaw" /><span class="u">°</span></div>
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
.perf-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.perf-tbl th, .perf-tbl td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); text-align: left; white-space: nowrap; }
.perf-tbl th { position: sticky; top: 0; background: var(--panel, var(--bg)); color: var(--text-muted); font-weight: 600; z-index: 1; }
.perf-tbl th.n, .perf-tbl td.n { text-align: right; font-family: var(--font-mono); }
.perf-tbl td { color: var(--text); }
.perf-tbl td.occ { color: #d08b5a; }
.perf-tbl th .cu { font-style: normal; color: var(--text-faint); font-weight: 400; font-size: .9em; margin-left: 2px; }
.perf-tbl th.n .cu { font-family: var(--font-mono); }
.perf-tbl tbody tr:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.perf-tbl tr.out td { color: var(--text-faint); }
.perf-tbl td.pin-empty { padding: 14px 12px; text-align: center; color: var(--text-faint); cursor: default; }
.perf-empty { text-align: center !important; color: var(--text-faint); padding: 18px !important; font-style: italic; }
.perf-tbl.grid { user-select: none; }
.perf-tbl.grid tbody td { cursor: cell; }
.perf-tbl.grid td.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.perf-tbl.grid tr.out td.sel { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.perf-tbl.grid td.active { box-shadow: inset 0 0 0 2px var(--accent); }
.perf-tbl .td-act, .perf-tbl .th-act { width: 22px; text-align: center; white-space: nowrap; }
.perf-tbl .th-act { border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.pin-body .td-act, .pin-body .th-act { width: 42px; }
.perf-tbl .td-act { cursor: default; }
.perf-tbl .td-act .del, .perf-tbl .td-act .foc { cursor: pointer; color: var(--text-faint); opacity: 0; display: inline-flex; vertical-align: middle; }
.perf-tbl .td-act .foc { margin-right: 4px; }
.perf-tbl tbody tr:hover .del, .perf-tbl tbody tr:hover .foc { opacity: .8; }
.perf-tbl .td-act .del:hover { color: #ff6a6a; }
.perf-tbl .td-act .foc:hover { color: var(--accent); }
.perf-tbl tbody tr.hov > td { background: color-mix(in srgb, var(--accent) 12%, transparent); }
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
.pw-bar .w56 { width: 56px; } .pw-bar .w76 { width: 76px; } .pw-bar .w104 { width: 104px; }
.pw-bar select { font-family: inherit; }
.pw-bar .u { color: var(--text-faint); font-size: 10.5px; }
.pw-bar .ptb.sq { padding: 2px 5px; }
.pw-bar .ptb.go { color: var(--accent); border-color: var(--accent); }
.pw-bar .ptb.go.warn { color: var(--warn, #d08b5a); border-color: var(--warn, #d08b5a); }
.pw-prog { flex: 1; min-width: 60px; height: 3px; background: color-mix(in srgb, var(--border) 60%, transparent); border-radius: 2px; overflow: hidden; }
.pw-prog i { display: block; height: 100%; background: var(--accent); transition: width .12s linear; }
/* 甘特条带：与可见性分析 ACCESS 甘特同款（78px 星名 + 轨道条 + 次数） */
.sgantt { flex: none; border-bottom: 1px solid var(--border); padding: 4px 12px 6px; }
.sgt-ax { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 9.5px; color: var(--text-faint); padding: 0 0 3px 84px; }
.sgt-ax .mid { color: var(--text-muted); }
.sgt-rows { display: flex; flex-direction: column; gap: 2px; max-height: 150px; overflow-y: auto; }
.sgt-row { display: grid; grid-template-columns: 78px 1fr 26px; gap: 6px; align-items: center; font-size: 10.5px; padding: 1px 3px; border-radius: 3px; cursor: pointer; }
.sgt-row:hover, .sgt-row.hov { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.sgt-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.sgt-bar { position: relative; height: 9px; background: color-mix(in srgb, var(--border) 45%, transparent); border-radius: 2px; }
.sgt-bar i { position: absolute; top: 1px; bottom: 1px; min-width: 1.2px; background: var(--accent); border-radius: 1px; }
.sgt-c { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); text-align: right; }
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
