<script setup>
// 导入页：选择文件 / 整窗拖放（在 ModelApp）→ 按格式分派（glb·gltf 主进程入库；OBJ·STL·FBX 渲染端解析 → exporter 出 glb → 入库；
// STEP·IGES·BREP 主进程 occt worker，进度经 models:changed）；导入后自动单位推断 / 部件分割 / 表面体积 / 缩略图 / 存元数据（wbStore）。
// 「从 STK 导入」：扫描本机 STK 目录（只读 JSON 块，不解网格）→ 勾选表 → 导入所选（stk-local、不可再分发）。
import { ref, computed, inject, onMounted, onBeforeUnmount, onActivated, nextTick } from 'vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import Icon from '../components/Icon.vue'
import MdSec from './MdSec.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { byLang } from '../shared/i18n/lang.js'
import { useCheckCol } from './checkCol.js'
import { fmtInt } from './wbLogic.js'

const wb = inject('wb')
const { st } = wb
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

// ============ 选择文件 ============
async function pick() {
  const files = await wb.call('pickFiles')
  if (!files || files === wb.LOCKED || !Array.isArray(files) || !files.length) return
  wb.importFiles(files.map((f) => ({ path: f.path, name: f.name })))
}

// ============ 最近导入（只放数据）============
const PHASE = {
  queued: '排队', start: '开始', load: '加载内核', read: '读取', convert: '转换', simplify: '抽稀', build: '建网格', write: '写入',
  analyze: '分析', segment: '部件分割', mass: '质量特性', thumb: '缩略图', done: '完成', error: '失败', canceled: '已取消'
}
// 状态紧跟名称（左栏缺省 400 px 时一眼看得到；表格按表头 + 内容只增不减地放宽列，靠后的列横向滚动看），失败原因进 title
const JCOLS = [
  { key: 'name', label: '名称', w: 112 },
  { key: 'phase', label: '状态', w: 64 },
  { key: 'fmt', label: '格式', w: 44 },
  { key: 'tris', label: '三角形', num: true, w: 62 },
  { key: 'ms', label: '耗时', unit: 'ms', num: true, w: 54 }
]
const jobs = computed(() => st.imports)
function jText(r, c) {
  if (c.key === 'name') return r.name
  if (c.key === 'fmt') return (r.fmt || '').toUpperCase()
  if (c.key === 'tris') return r.tris == null ? '' : fmtInt(r.tris)
  if (c.key === 'ms') return r.ms == null ? '' : fmtInt(r.ms)
  if (c.key === 'phase') return (PHASE[r.phase] || r.phase || '') + (r.phase === 'error' && r.error ? '：' + r.error : '')
  return ''
}
const jg = useGridSelect({
  gridId: 'md-imports', rows: () => jobs.value,
  cols: () => JCOLS, readOnly: true, cellText: jText,
  sortValue: (r, c) => (c.key === 'tris' || c.key === 'ms' ? r[c.key] : jText(r, c))
})
const jCellClass = (r, c) => (c.key === 'phase' ? (r.phase === 'error' ? 'md-bad' : r.phase === 'done' ? (r.error ? '' : 'md-ok') : 'md-dim') : (c.key === 'tris' || c.key === 'ms' ? 'md-mono' : null))
const jTip = (r, c) => (c.key === 'phase' && r.error ? r.error : c.key === 'name' ? [r.name, r.modelId].filter(Boolean).join(' · ') : null)
function jMenu({ row }) {
  if (!row) return []
  const out = []
  if (row.modelId && row.phase === 'done') out.push({ key: 'open', label: '在模型页打开', run: () => { wb.select(row.modelId, { lod: 'lod0' }); st.tab = 'model' } })
  if (wb.canCancelJob(row)) out.push({ key: 'cancel', label: '取消导入', run: () => wb.cancelImport(row) })
  return out
}
// 单击一行：预览该模型（与当前模型比，不与上次点的行比：中间在库页选过别的，回来再点同一行要能切回去）
function onJobsMouseUp() {
  const r = jg.rect.value
  if (r.r0 < 0 || r.r0 !== r.r1) return
  const row = jg.rows.value[r.r0]
  if (row && row.modelId && row.phase === 'done' && row.modelId !== wb.cur.id) wb.select(row.modelId, { lod: 'lod2' })
}
function clearRecent() {
  st.imports.splice(0, st.imports.length, ...st.imports.filter((j) => j.live))
  try { localStorage.setItem('model/recentImports', '[]') } catch { /* 便利数据 */ }
}

// ============ 从 STK 导入 ============
const DEFAULT_STK = 'C:\\Program Files\\AGI\\STK 12\\STKData\\VO\\Models'
const stkDir = ref(lsGet('model/stkDir', DEFAULT_STK))
const scan = ref(null)          // {dir, exists, truncated, items}
const scanning = ref(false)
const scanMs = ref(0)
const checked = ref(new Set())
const stkSec = ref(null)
// 类别就是文件路径的第一段（Air / Space …），不单列；gmdf 旁车并进文件名格（「 ·gmdf」后缀）与它的 title
const SCOLS = [
  { key: 'chk', label: '', w: 28, align: 'center', tip: '勾选要导入的模型（点表头全选；空格翻转选中行）' },
  { key: 'rel', label: '文件', w: 126 },
  { key: 'nodes', label: '节点', num: true, w: 38 },
  { key: 'attachPoints', label: '挂点', num: true, w: 38 },
  { key: 'articulations', label: '关节', num: true, w: 38 },
  { key: 'solarPanelGroups', label: '翼组', num: true, w: 38, tip: '太阳翼组（AGI_stk_metadata.solarPanelGroups）' },
  { key: 'mb', label: '大小', unit: 'MB', num: true, w: 54 }
]
const srows = computed(() => (scan.value && Array.isArray(scan.value.items) ? scan.value.items.map((it) => ({ ...it, id: it.rel })) : []))
function sText(r, c) {
  if (c.key === 'chk') return checked.value.has(r.rel) ? '✓' : ''
  if (c.key === 'mb') return Number.isFinite(r.bytes) ? (r.bytes / 1e6).toFixed(2) : ''
  if (c.key === 'gmdf') return r.hasGmdf ? '✓' : ''
  if (c.key === 'rel') return r.rel + (r.hasGmdf ? ' ·gmdf' : '')
  const v = r[c.key]
  return v == null ? '' : String(v)
}
const sg = useGridSelect({ gridId: 'md-stk', rows: () => srows.value, cols: () => SCOLS, readOnly: true, cellText: sText,
  sortValue: (r, c) => (c.key === 'mb' ? r.bytes : c.num ? r[c.key] : sText(r, c)) })
const sCellClass = (r, c) => (c.key === 'chk' ? (checked.value.has(r.rel) ? 'md-chk on' : 'md-chk') : r.error && c.key === 'rel' ? 'md-bad' : (c.num ? 'md-mono' : null))
const sTip = (r, c) => (r.error ? r.error : c.key === 'rel' ? [r.file, r.category, r.hasGmdf ? '同目录有同名 .gmdf 旁车（STK 读取时整份替代内嵌元数据）' : ''].filter(Boolean).join('\n') : null)
const chk = useCheckCol(sg, {
  cols: () => SCOLS, rows: () => srows.value.filter((r) => !r.error),
  isOn: (r) => checked.value.has(r.rel),
  set: (r, on) => { if (r.error) return; const s = new Set(checked.value); on ? s.add(r.rel) : s.delete(r.rel); checked.value = s },
  setAll: (on) => { checked.value = on ? new Set(srows.value.filter((r) => !r.error).map((r) => r.rel)) : new Set() }
})
async function browse() {
  const r = await wb.call('pickStkDir')
  if (!r || r === wb.LOCKED || r.canceled || !r.dir) return
  stkDir.value = r.dir
  doScan()
}
async function doScan() {
  scanning.value = true
  const t0 = performance.now()
  const dir = stkDir.value.trim()
  const r = await wb.call('scanStk', { dir: dir || undefined })
  scanning.value = false
  scanMs.value = Math.round(performance.now() - t0)
  if (!r || r === wb.LOCKED) return
  if (r.ok === false) { scan.value = { dir, exists: false, items: [], error: r.error }; return }
  scan.value = r
  if (r.dir) { stkDir.value = r.dir; lsSet('model/stkDir', r.dir) }
  checked.value = new Set([...checked.value].filter((k) => r.items.some((it) => it.rel === k)))
}
function importChecked() {
  const files = srows.value.filter((r) => checked.value.has(r.rel)).map((r) => r.rel)
  if (!files.length || !scan.value) return
  wb.importStk(scan.value.dir || stkDir.value, files)
  checked.value = new Set()
}
const nChecked = computed(() => checked.value.size)

function onStkEvent() {
  if (stkSec.value) stkSec.value.open()
  nextTick(() => {
    const el = document.querySelector('.md-sec[data-sec="imp-stk"]')
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (!scan.value && !scanning.value) doScan()
  })
}
onMounted(() => window.addEventListener('modelwb:stk', onStkEvent))
onBeforeUnmount(() => window.removeEventListener('modelwb:stk', onStkEvent))
onActivated(() => { /* KeepAlive 回到本页：表格尺寸可能变了，交给 ExcelGrid 自己量 */ })

const liveCount = computed(() => st.imports.filter((j) => j.live).length)
</script>

<template>
  <div class="imp">
    <MdSec id="imp-files" title="文件">
      <div class="md-acts">
        <button class="lb-mini primary imp-pick" :disabled="!wb.api" title="glb · glTF · OBJ（含 .mtl 与贴图）· STL · FBX · STEP · IGES · BREP；也可直接拖进窗口" @click="pick">
          <Icon name="folder-open" :size="13" />选择文件…
        </button>
        <span v-if="liveCount" class="md-state"><span class="imp-spin"></span><span data-i18n-skip>{{ liveCount }}</span></span>
      </div>
    </MdSec>

    <MdSec id="imp-recent" title="最近导入" :count="st.imports.length || null">
      <template #actions>
        <button class="lb-mini" :disabled="!st.imports.some((j) => !j.live)" title="清空列表（不删模型）" @click="clearRecent">清空</button>
      </template>
      <div class="md-grid" @mouseup="onJobsMouseUp">
        <ExcelGrid :grid="jg" :cols="JCOLS" :text="jText" :cell-class="jCellClass" :cell-tip="jTip" :menu-items="jMenu"
                   :head-tip="(c) => c.tip || c.label" empty-text="暂无导入。" />
      </div>
    </MdSec>

    <MdSec id="imp-stk" ref="stkSec" title="从 STK 导入" :count="scan && scan.items ? scan.items.length : null"
           tip="本机 STK 安装目录里的 glb：只读 JSON 块列表，不解网格；导入后 stk-local、不可导出、不可分发（AGI SLA）">
      <div class="srow">
        <label title="STK 模型目录（缺省为 STK 12 的 STKData\VO\Models）">目录</label>
        <input v-model="stkDir" class="ci imp-dir" type="text" spellcheck="false" data-i18n-skip @keydown.enter="doScan" />
        <button class="lb-mini" :disabled="!wb.api" title="选择目录" @click="browse"><Icon name="folder" :size="13" /></button>
        <button class="lb-mini" :disabled="!wb.api || scanning" title="扫描目录下的 *.glb 与同名 *.gmdf" @click="doScan">{{ scanning ? '扫描中…' : '扫描' }}</button>
      </div>
      <div v-if="scan && scan.error" class="md-state bad"><Icon name="alert-triangle" :size="12" /><span data-i18n-skip>{{ scan.error }}</span></div>
      <div v-else-if="scan && scan.exists === false" class="md-state warn"><Icon name="alert-triangle" :size="12" />目录不存在。</div>
      <template v-if="scan && scan.items">
        <div class="md-grid tall imp-stk" @click.capture="chk.onClickCapture" @keydown.capture="chk.onKeyCapture">
          <ExcelGrid :grid="sg" :cols="SCOLS" :text="sText" :cell-class="sCellClass" :cell-tip="sTip"
                     :head-tip="(c) => c.tip || c.label" empty-text="没有 glb 模型。" />
        </div>
        <div class="md-acts">
          <button class="lb-mini primary" :disabled="!nChecked" @click="importChecked"><Icon name="import" :size="13" />导入所选</button>
          <span class="md-state"><span data-i18n-skip>{{ nChecked }}</span><span>/</span><span data-i18n-skip>{{ scan.items.length }}</span></span>
          <span v-if="scan.truncated" class="md-state warn">已截断。</span>
          <span class="sp"></span>
          <span class="md-state" :title="scan.dir" data-i18n-skip>{{ scanMs }} ms</span>
        </div>
      </template>
    </MdSec>
  </div>
</template>

<style scoped>
.imp { display: flex; flex-direction: column; gap: 4px; }
.imp-pick { height: var(--h-ctl-lg) !important; padding: 0 14px !important; font-size: var(--fs-3) !important; }
.imp-dir { font-family: var(--font-mono); font-size: var(--fs-2); }
.imp-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: imp-spin .7s linear infinite; }
@keyframes imp-spin { to { transform: rotate(360deg); } }
</style>
