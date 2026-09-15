<script setup>
// 对星性能指标表（独立窗口）。上 = 目标星（点选 / 波束内），下 = 只读结果表；两种时间口径共用一个结果区：
//   · 当前时刻 —— 表跟仿真时钟走；
//   · 时间窗口 —— 先扫出每颗目标星的可见时段（条带），再拖游标点到时窗里的任意一刻，表按那一刻现算。
// 取值全在主窗口（它握着星历与天线上下文）：这里只展示推来的状态，操作一律发回去；
// 选项是本地可编辑的镜像（改完整份发回）。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { SAT_COL_DEFS, SAT_COL_GROUPS, satVisibleColumns, fillSatOpts } from '../viz/grd/useSatPerfTable.js'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { tzParts, tzToMs } from '../shared/tz.js'
import { appAlert } from '../stores/alert.js'
import { useBridge, useMirror } from './bridge.js'
import { persistedRef } from './prefs.js'
import PerfOptsDialog from './PerfOptsDialog.vue'

const B = useBridge()
const { st, act, req } = B
const ctx = computed(() => st.ctx || null)

// ===== 选项：本地镜像（改完整份发回）=====
const opts = ref(fillSatOpts(null))
useMirror(st, 'opts', {
  sigOf: (o) => JSON.stringify(fillSatOpts(o)),
  apply: (v) => { opts.value = fillSatOpts(v) },
  local: () => opts.value,
  send: (v) => act('opts', v)
})
const ctxBeams = computed(() => (Array.isArray(st.ctxBeams) ? st.ctxBeams : []))
const win = computed(() => st.win || { on: false, startMs: null, durH: 24, cursorMs: null, busy: false, progress: 0, msg: '' })
const wi = computed(() => st.winInfo || null)
const tzMode = computed(() => (st.tzMode == null ? 'local' : st.tzMode))
onMounted(() => B.ready())

// ===== 时刻格式化（与主界面时间轴同一档位）=====
const p2 = (n) => String(n).padStart(2, '0')
const fmtTime = (ms) => { const t = tzParts(ms, tzMode.value); return `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}` }
function fmtCell(c, v) {
  if (v == null || v === '') return ''
  if (c.time) return Number.isFinite(v) ? fmtTime(v) : ''
  if (c.num && typeof v === 'number') return Number.isFinite(v) ? v.toFixed(c.fix != null ? c.fix : 2) : ''
  return String(v)
}

// ===== 目标星搜索：全量（星座目录 / 卫星组 / 自定义星座），交给主窗口；防抖 200 ms + 序号守卫 =====
const tq = ref('')
const cand = ref([])
const cTotal = ref(0)
const cBusy = ref(false)
let cSeq = 0, cTimer = null
const picks = computed(() => (Array.isArray(st.picks) ? st.picks : []))
const beamMode = computed(() => st.targetMode === 'beam')
const activePicks = computed(() => (beamMode.value ? (st.beamPicks || []) : picks.value))
watch(tq, (v) => {
  const q = String(v || '').trim()
  if (cTimer) { clearTimeout(cTimer); cTimer = null }
  cSeq++
  if (!q) { cand.value = []; cTotal.value = 0; cBusy.value = false; return }
  cBusy.value = true
  cTimer = setTimeout(async () => {
    const seq = cSeq
    const had = picks.value.map((p) => (p.noradId ? 'n:' + p.noradId : 'm:' + p.name))
    let r = { items: [], total: 0 }
    try { r = (await req('search', { q, limit: 60, exclude: had })) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== cSeq) return
    cand.value = r.items || []
    cTotal.value = r.total || 0
    cBusy.value = false
  }, 200)
})
function addCand(e) { act('picks:add', e); tq.value = '' }
function addAllCands() { if (!cand.value.length) return; act('picks:addMany', cand.value.slice()); tq.value = '' }
onBeforeUnmount(() => { if (cTimer) clearTimeout(cTimer); if (seekRaf) cancelAnimationFrame(seekRaf) })

// ===== 两张网格 =====
const PICK_COLS = [
  { key: 'no', label: 'No.', num: true },
  { key: 'name', label: '目标卫星' },
  { key: 'noradId', label: 'NORAD', num: true },
  { key: 'group', label: '分组' }
]
const pickRows = computed(() => activePicks.value.map((p, i) => ({ ...p, no: i + 1 })))
// 目标星名单是只读列表（成员来自搜索 / 波束内），但可以整行移除：右键「删除 N 行」/ Delete / Ctrl+- / 工具条「删除选中」
// 同走 onDeleteRows；「波束内」档成员随时钟重算、不可移除（deletable 把整套入口一起关掉）。移除在主窗口执行，行由它推回。
const canRemove = () => !beamMode.value
function removePickIds(ids) {
  if (!canRemove() || !ids.length) return 0
  act('picks:removeMany', { ids })
  return ids.length
}
const pickGrid = useGridSelect({
  gridId: 'pw-pick', rows: () => pickRows.value, cols: () => PICK_COLS, readOnly: true,
  cellText: (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) },
  onDeleteRows: removePickIds, deletable: canRemove
})
const query = ref('')
const rows = computed(() => (Array.isArray(st.rows) ? st.rows : []))
const filteredRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter((r) => [r.tgtName, r.group, r.noradId].some((v) => String(v || '').toLowerCase().includes(q)))
})
const cols = computed(() => satVisibleColumns(opts.value))
// 结果行一行＝一颗目标星，但行 id 是 NORAD / 星名而不是名单里的 pick id：按 { name, noradId } 交主窗口对名单
function removeResultRows(ids) {
  if (!canRemove() || !ids.length) return 0
  const want = new Set(ids.map(String))
  const keys = filteredRows.value.filter((r) => want.has(String(r.id))).map((r) => ({ name: r.tgtName || '', noradId: r.noradId || null }))
  if (!keys.length) return 0
  act('picks:removeMany', { keys })
  return keys.length
}
const resGrid = useGridSelect({
  gridId: 'pw-sres', rows: () => filteredRows.value, cols: () => cols.value, readOnly: true,
  cellText: (r, c) => fmtCell(c, r[c.key]),
  onDeleteRows: removeResultRows, deletable: canRemove
})
// 右键菜单的业务项（两张网格同一份）：聚焦活动行那颗星
const satMenu = ({ row }) => (row && (row.tgtName || row.name) ? [{ key: 'focus', label: '聚焦该卫星', run: () => focusRow(row) }] : [])
const optsOpen = ref(false)
const hoverId = ref('')
const resEmptyText = computed(() => {
  if (!pickRows.value.length) return beamMode.value ? '当前波束内没有卫星。' : '还没有目标星。'
  if (win.value.on && !wi.value) return '尚未扫描时段。'
  return '这些目标星都没有取到值。'
})
function focusRow(r) { if (r && (r.tgtName || r.name)) act('focus', { name: r.tgtName || r.name, noradId: r.noradId }) }

// ===== 时间窗口 =====
const nowMs = computed(() => Number(st.nowMs) || Date.now())
const winT0 = computed(() => (Number.isFinite(win.value.startMs) ? win.value.startMs : nowMs.value))
const startLocal = computed({
  get: () => { const t = tzParts(winT0.value, tzMode.value); return `${t.y}-${p2(t.mo)}-${p2(t.d)}T${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}` },
  set: (v) => {
    if (!v) { act('win', { startMs: null }); return }
    const [dp, tp] = String(v).split('T'); if (!dp || !tp) return
    const [Y, M, D] = dp.split('-').map(Number), [h, m, s] = tp.split(':').map(Number)
    if (!Number.isFinite(Y) || !Number.isFinite(h)) return
    const ms = tzToMs(tzMode.value, Y, M, D, h, m, Number.isFinite(s) ? s : 0)
    if (Number.isFinite(ms)) act('win', { startMs: ms })
  }
})
const durH = computed({ get: () => win.value.durH, set: (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) act('win', { durH: n }) } })
const stampText = computed(() => (Number.isFinite(st.stampMs) ? fmtTime(st.stampMs) : (st.timeLabel || '')))
const durText = (min) => (min >= 1440 ? (min / 1440).toFixed(1) + ' d' : min >= 60 ? (min / 60).toFixed(1) + ' h' : min.toFixed(1) + ' min')
const bands = computed(() => (wi.value && wi.value.bands) || [])
// 游标：本地当场跟手（拖动时不等主窗口回推），重算按帧节流发回主窗口
const cursorLocal = ref(null)
watch(() => win.value.cursorMs, (v) => { cursorLocal.value = Number.isFinite(v) ? v : null })
const curMs = computed(() => (Number.isFinite(cursorLocal.value) ? cursorLocal.value : (wi.value ? wi.value.t0Ms : 0)))
const curFrac = computed(() => { const w = wi.value; if (!w || !(w.t1Ms > w.t0Ms)) return 0; return Math.max(0, Math.min(1, (curMs.value - w.t0Ms) / (w.t1Ms - w.t0Ms))) })
let seekRaf = 0
function seek(tMs) {
  const w = wi.value; if (!w) return
  cursorLocal.value = Math.max(w.t0Ms, Math.min(w.t1Ms, tMs))
  if (seekRaf) return
  seekRaf = requestAnimationFrame(() => { seekRaf = 0; act('cursor', { t: cursorLocal.value }) })
}
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
const peaks = computed(() => bands.value.flatMap((b) => b.segs.map((s) => s.peakMs)).sort((a, b) => a - b))
function jumpPeak(dir) {
  const ps = peaks.value; if (!ps.length) return
  const t = curMs.value
  const k = dir > 0 ? ps.find((p) => p > t + 500) : [...ps].reverse().find((p) => p < t - 500)
  if (k != null) seek(k)
}
const inWinCount = computed(() => { const t = curMs.value; return bands.value.reduce((n, b) => n + (b.segs.some((s) => t >= s.startMs && t <= s.endMs) ? 1 : 0), 0) })
function setWinOn(on) { if (win.value.on === on) return; act('win', { on }); resGrid.sel.value = { ar: -1, ac: -1, ri: -1, ci: -1 } }
const staleNow = computed(() => !!st.stale)

// ===== 复制 / Excel =====
function copyTsv() {
  const cs = cols.value
  const head = cs.map((c) => c.label + (c.unit ? `(${c.unit})` : '')).join('\t')
  const body = filteredRows.value.map((r) => cs.map((c) => fmtCell(c, r[c.key])).join('\t'))
  const text = [head, ...body].join('\n')
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
  if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch { /* 剪贴板不可用 */ } }
}
const xlsxVal = (r, c) => {
  const v = r[c.key]
  if (v == null || v === '') return null
  if (c.time) return fmtCell(c, v)
  if (c.num && typeof v === 'number') return Number.isFinite(v) ? v : null
  return fmtCell(c, v)
}
const ctxName = () => (ctx.value ? ctx.value.satName + '_' + ctx.value.antName : '对星性能')
const viewName = () => (!win.value.on ? '当前时刻' : '时间窗口')
const noteText = () => [ctx.value ? '源卫星 ' + ctx.value.satName : '', ctx.value ? '天线 ' + ctx.value.antName : '', '视图 ' + viewName(), stampText.value ? '时刻 ' + stampText.value : ''].filter(Boolean).join(' · ')
async function exportResultXlsx() {
  if (!cols.value.length) { appAlert('当前没有显示任何列'); return }
  const sheets = [
    sheetModel({ name: '性能结果 · ' + viewName(), cols: cols.value, rows: resGrid.rows.value, value: xlsxVal, note: noteText() }),
    sheetModel({ name: '目标星', cols: PICK_COLS, rows: pickRows.value, value: (r, c) => r[c.key] })
  ]
  const r = await exportSheets({ defaultName: safeFileName('对星性能指标表_' + ctxName(), '对星性能指标表') + '.xlsx', title: '导出对星性能指标表', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function exportPicksXlsx() {
  if (!pickRows.value.length) { appAlert('还没有目标星'); return }
  const r = await exportSheets({ defaultName: safeFileName('目标星_' + ctxName(), '目标星') + '.xlsx', title: '导出目标星', sheets: [sheetModel({ name: '目标星', cols: PICK_COLS, rows: pickRows.value, value: (r, c) => r[c.key] })] })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function importPicksXlsx() {
  if (beamMode.value) { appAlert('「波束内」的目标星随时钟自动重算，切到「点选」再导入'); return }
  const r = await importWorkbook({ title: '导入目标星' })
  if (!r || r.canceled) return
  if (!r.ok) { appAlert('导入失败：' + (r.error || '无法读取该文件')); return }
  const sheet = pickSheet(r.sheets, PICK_COLS)
  if (!sheet) { appAlert('这份工作簿里没有数据'); return }
  const { records } = sheetToRecords(sheet, PICK_COLS)
  const list = records
    ? records.map((x) => ({ name: String(x.name || '').trim(), noradId: Number(x.noradId) || null, group: String(x.group || '').trim() }))
    : sheet.rows.map((cells) => ({ name: String(cells[0] == null ? '' : cells[0]).trim(), noradId: Number(cells[1]) || null, group: String(cells[2] == null ? '' : cells[2]).trim() }))
  const clean = list.filter((x) => x.name)
  if (!clean.length) { appAlert('没有读到卫星名（表头需含「目标卫星」，或把星名放在第一列）'); return }
  act('picks:addMany', clean)
}
function resetOpts() { opts.value = fillSatOpts(null) }

// ===== 中缝 =====
const inH = persistedRef('shell/inH', 180, { min: 72, max: Math.max(72, window.innerHeight - 200) })   // 中缝高度：记住上次
function dragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, o = inH.value
  const onMove = (ev) => { inH.value = Math.max(72, Math.min(window.innerHeight - 200, o + (ev.clientY - sy))) }
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
}
</script>

<template>
  <div class="pw-body">
    <!-- 上：目标星（想看哪颗加哪颗；「加入波束内的星」把当前落在方向图里的一次捞进来） -->
    <section class="pw-in" :style="{ height: inH + 'px' }">
      <div class="pw-bar">
        <span class="pw-t">目标星</span>
        <span class="seg2" role="group" aria-label="目标星来源">
          <span class="sg" :class="{ on: !beamMode }" title="自己加的名单，不随时刻变" @click="act('targetMode', 'pick')">点选</span>
          <span class="sg" :class="{ on: beamMode }" title="此刻落在方向图域内的星，随时钟每拍重算" @click="act('targetMode', 'beam')">波束内</span>
        </span>
        <input v-if="!beamMode" class="pw-q" v-model="tq" placeholder="搜索添加：卫星名 / NORAD / 星座 / 卫星组" />
        <span v-if="!beamMode" class="ptb" title="把当前落在方向图网格域内的在场卫星一次性加为目标" @click="act('addInBeam')"><Icon name="plus" :size="12" /> 加入波束内的星</span>
        <span v-if="!beamMode" class="ptb" title="从 Excel 导入目标星（表头含「目标卫星 / NORAD / 分组」，或星名放第一列）" @click="importPicksXlsx"><Icon name="import" :size="12" /> 导入 Excel</span>
        <span class="ptb" :class="{ dis: !pickRows.length }" title="把目标星列表导出为 Excel" @click="exportPicksXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span v-if="!beamMode" class="ptb" :class="{ dis: !pickGrid.selRowCount.value }" title="移除选中的目标星（表内 Delete / Ctrl+- 同）" @click="pickGrid.deleteRows()"><Icon name="minus" :size="12" /> 删除选中<em v-if="pickGrid.selRowCount.value" class="ptb-n">{{ pickGrid.selRowCount.value }}</em></span>
        <span v-if="!beamMode" class="ptb" :class="{ dis: !picks.length }" title="清空目标星列表" @click="act('picks:clear')"><Icon name="trash" :size="12" /> 清空</span>
        <span class="pw-cnt">{{ pickRows.length }} 目标</span>
      </div>
      <div v-if="!beamMode && tq.trim()" class="sres">
        <div v-if="cBusy" class="sres-e">搜索中…</div>
        <div v-else-if="!cand.length" class="sres-e">没有匹配的卫星。</div>
        <template v-else>
          <div class="sres-list">
            <div v-for="e in cand" :key="e.noradId || e.name" class="sitem" @click="addCand(e)">
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
      <ExcelGrid class="pw-grid sc-grid" :grid="pickGrid" :cols="PICK_COLS" :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))"
                 :serial="false" :actions-width="46" :menu-items="satMenu" :row-class="(r) => (hoverId && hoverId === (r.noradId || r.name) ? 'hov' : null)"
                 :empty-text="beamMode ? '当前波束内没有卫星。' : '还没有目标星。'">
        <template #actions="{ row }">
          <span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(row)"><Icon name="crosshair" :size="12" /></span>
          <span v-if="!beamMode" class="del" title="移除该目标星" @click="act('picks:remove', { id: row.id })"><Icon name="x" :size="12" /></span>
        </template>
      </ExcelGrid>
    </section>

    <div class="pw-split" title="拖拽调整上下高度" @mousedown="dragSplit"><span class="grip"></span></div>

    <!-- 下：只读性能结果表。一行 = 一颗目标星，两档只差在算在哪一刻 -->
    <section class="pw-res">
      <div class="pw-bar">
        <span class="pw-t">性能结果<em>只读</em></span>
        <span class="seg2">
          <span class="sg" :class="{ on: !win.on }" title="表跟仿真时钟走" @click="setWinOn(false)">当前时刻</span>
          <span class="sg" :class="{ on: win.on }" title="扫出可见时段，拖游标看任意一刻" @click="setWinOn(true)">时间窗口</span>
        </span>
        <label class="pw-chk"><input type="checkbox" v-model="opts.filterOn" title="仅列方向性≥阈值（被波束照到）的目标星；取不到值的（域外/背面/遮挡）一并不列" /> 仅照到的星</label>
        <label class="pw-chk" :class="{ dis: !opts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.lazy.number="opts.minDir" :disabled="!opts.filterOn" /><span class="u">dB</span></label>
        <input class="pw-q" v-model="query" placeholder="查询：卫星名 / 分组 / NORAD" />
        <span v-if="!win.on" class="ptb" title="按当前时间轴时刻重算" @click="act('recompute')"><Icon name="refresh-cw" :size="12" /> 重算</span>
        <span v-if="!beamMode" class="ptb" :class="{ dis: !resGrid.selRowCount.value }" title="移除选中行对应的目标星（表内 Delete / Ctrl+- 同）" @click="resGrid.deleteRows()"><Icon name="minus" :size="12" /> 删除选中<em v-if="resGrid.selRowCount.value" class="ptb-n">{{ resGrid.selRowCount.value }}</em></span>
        <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="copyTsv"><Icon name="copy" :size="12" /> 复制全表</span>
        <span class="ptb" title="导出为 Excel（结果表 + 目标星两张工作表；数字列存真数字）" @click="exportResultXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span class="ptb" :class="{ on: optsOpen }" title="显示列 / 波束筛选 / 参数计算 / 指向误差" @click="optsOpen = true"><Icon name="sliders-horizontal" :size="12" /> 选项…</span>
        <span class="pw-cnt">{{ filteredRows.length }} 行</span>
      </div>

      <!-- 时窗参数：起点 + 时长（窗口判据＝域内且视线通）。改任一项即标「输入已变」 -->
      <div v-if="win.on" class="tw-bar">
        <label>起始</label>
        <input class="ci dt" type="datetime-local" step="1" v-model="startLocal" />
        <span class="ptb sq" :class="{ dis: win.startMs == null }" title="回到跟随时间轴当前时刻" @click="act('win', { startMs: null })"><Icon name="refresh-cw" :size="12" /></span>
        <label>时长</label>
        <input class="ci w56" type="number" step="1" min="0.02" max="720" v-model.lazy.number="durH" /><span class="u">h</span>
        <span v-if="!win.busy" class="ptb go" :class="{ warn: staleNow }" title="扫描全部目标星在该时窗内的可见时段" @click="act('scan')"><Icon name="play" :size="12" /> {{ staleNow ? '重算' : '计算' }}</span>
        <span v-else class="ptb" title="中止本次扫描" @click="act('cancelScan')"><Icon name="x" :size="12" /> 取消 {{ Math.round(win.progress * 100) }}%</span>
        <span v-if="win.busy" class="pw-prog"><i :style="{ width: (win.progress * 100) + '%' }"></i></span>
        <span v-else-if="wi" class="pw-cnt">{{ wi.nLit }}/{{ wi.nTarget }} 有窗口 · {{ wi.nWin }} 个时段 · {{ durText((wi.t1Ms - wi.t0Ms) / 60000) }}</span>
      </div>

      <!-- 可见时段条带：一行一颗目标星，横轴 = 整个时窗；条上按住拖动 = 挪游标（落在窗口里先吸到峰值） -->
      <div v-if="win.on && wi && bands.length" class="sgantt">
        <div class="sgt-ax">
          <span data-i18n-skip>{{ fmtTime(wi.t0Ms) }}</span>
          <span class="mid">{{ durText((wi.t1Ms - wi.t0Ms) / 60000) }}</span>
          <span data-i18n-skip>{{ fmtTime(wi.t1Ms) }}</span>
        </div>
        <div class="sgt-rows">
          <div v-for="b in bands" :key="b.id" class="sgt-row" :class="{ hov: hoverId === b.id }"
               :title="b.name + ' · ' + b.nWin + ' 次 · 总 ' + durText(b.totMin) + ' · 占比 ' + b.pct.toFixed(1) + '%'"
               @mouseenter="hoverId = b.id" @mouseleave="hoverId = ''">
            <span class="sgt-n" data-i18n-skip @click="act('focus', { name: b.name, noradId: b.noradId })">{{ b.name }}</span>
            <span class="sgt-bar" @pointerdown="barDown($event, b)">
              <i v-for="(s, si) in b.segs" :key="si" :style="{ left: (s.a * 100) + '%', width: Math.max(0.35, (s.b - s.a) * 100) + '%' }"></i>
              <b class="sgt-cur" :style="{ left: (curFrac * 100) + '%' }"></b>
            </span>
            <span class="sgt-c">{{ b.nWin }}</span>
          </div>
        </div>
        <div class="swc">
          <span class="ptb sq" title="上一个窗口峰值" @click="jumpPeak(-1)"><Icon name="chevron-left" :size="12" /></span>
          <input class="swc-sl" type="range" :min="wi.t0Ms" :max="wi.t1Ms" step="1000" :value="curMs" @input="seek(Number($event.target.value))" />
          <span class="ptb sq" title="下一个窗口峰值" @click="jumpPeak(1)"><Icon name="chevron-right" :size="12" /></span>
          <span class="swc-t" data-i18n-skip>{{ fmtTime(curMs) }}</span>
          <span class="pw-cnt">窗口内 {{ inWinCount }} 颗</span>
          <span class="ptb" title="把主时间轴跳到游标时刻（画面上的星位随之走到这一刻）" @click="act('seekClock', { t: curMs })">同步到时间轴</span>
        </div>
      </div>

      <ExcelGrid class="pw-grid sc-grid" :grid="resGrid" :cols="cols" :text="(r, c) => fmtCell(c, r[c.key])"
                 :serial="!cols.some((c) => c.key === 'no')" :actions-width="26" :menu-items="satMenu"
                 :row-class="(r) => [r.state ? 'out' : null, hoverId && hoverId === (r.noradId || r.tgtName) ? 'hov' : null]"
                 :cell-class="(r, c) => (c.key === 'state' && r.state ? 'occ' : null)"
                 :empty-text="resEmptyText"
                 @row-enter="(r) => hoverId = r.noradId || r.tgtName" @row-leave="hoverId = ''">
        <template #actions="{ row }">
          <span class="foc" title="聚焦该卫星（旋转地球正对它并选中）" @click="focusRow(row)"><Icon name="crosshair" :size="12" /></span>
        </template>
      </ExcelGrid>
    </section>

    <div class="pw-status">
      <span v-if="ctx" data-i18n-skip>{{ ctx.satName }} / {{ ctx.antName }}</span>
      <span v-if="ctx">{{ ctx.beams }} 波束</span>
      <span v-if="win.on && st.winNote" data-i18n-skip>{{ st.winNote }}</span>
      <span v-else-if="st.note" data-i18n-skip>{{ st.note }}</span>
      <span v-if="stampText" class="r" data-i18n-skip>{{ stampText }}</span>
    </div>

    <PerfOptsDialog v-if="optsOpen" title="对星性能表选项" :sub="ctx ? ctx.antName : ''" :opts="opts" :col-defs="SAT_COL_DEFS" :col-groups="SAT_COL_GROUPS" :ctx-beams="ctxBeams" pointing @close="optsOpen = false" @reset="resetOpts" />
  </div>
</template>
