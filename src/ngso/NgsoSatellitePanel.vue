<script setup>
import { computed, ref, watch } from 'vue'
import { BAND_FREQ, BAND_LABEL } from './satPresets.js'
import { ensureSearchPool } from './satSearchPool.js'
import { classifyOrbit, orbitRegimeLabel } from '../shared/orbitClass.js'
import { fmtGeoSlot, geoSlotOfOmm } from '../shared/geoSlot.js'

// NGSO 卫星模块：两种取星模式（互斥）——
//  ① 卫星/天线树选择：从主窗口「星座3D」页那棵卫星/天线树选星，取其真实轨道根数（NORAD / OMM / 经典六根数）。
//  ② 搜索卫星：按名称/NORAD 检索 CelesTrak OMM 全域 → 选中只带轨道根数。
// 两种都只定【轨道】：选星后「轨道高度 / 轨道倾角」只读并显示「自动」（由所选卫星轨道确定）。
// 卫星 EIRP / G·T 在链路表逐站填写——v1.4.5 起 NGSO 不再按 GRD 方向图自动回填（口径问题，见 ngso/satTree.js）。
// 两种取星器都在资源库卫星编辑器里（分段切换，showTree + showSearch + showForm，均为配置级，写该条目的
// ngsoSat）；工作台「卫星与轨道」分区只留只读速览行，不再渲染本组件。
const props = defineProps({
  form: { type: Object, required: true },
  fields: { type: Array, required: true },
  satTree: { type: Array, default: () => [] },       // [{ folder, satName, lon, lat, altKm, elements?, omm?, noradId? }]
  ngsoSat: { type: Object, default: () => ({ mode: 'manual', orbit: null, name: '', noradId: null, folder: '' }) },   // 该卫星的轨道来源（库条目属性）
  satSelected: { type: Boolean, default: false },
  onPickTree: { type: Function, default: () => {} },    // (node) => void
  onPickSearch: { type: Function, default: () => {} },  // (ommRec) => void
  onClear: { type: Function, default: () => {} },       // () => void
  // 取星器/表单三段独立开关（保留独立开关：便于将来单独嵌用其中一段）
  showTree: { type: Boolean, default: false },       // 渲染「卫星/天线树选择」取星器
  showSearch: { type: Boolean, default: false },     // 渲染「从星历搜索」取星器
  showForm: { type: Boolean, default: true }         // 渲染卫星参数表单
})

// 取星模式分段控件：tree / search。仅在两种取星都开启时出现（当前工作台只 tree、资源库只 search，
// 各只用一种，故通常不显分段头）。仅切换「正在看哪个选星器」，不动已选卫星。
const mode = ref(props.ngsoSat.mode === 'search' ? 'search' : 'tree')
function switchMode(m) { if (mode.value === m) return; mode.value = m }
// 库单选切换卫星（satId 变）→ ngsoSat 换成另一条目的对象：分段控件跟随其取星模式（manual 保持当前页签）
watch(() => props.ngsoSat && props.ngsoSat.mode, (m) => { if (m === 'search' || m === 'tree') mode.value = m })
// 取星器可见性：两种取星都开启时用分段控件 mode 切换；只开一种时该种恒显（忽略 mode）。
const anyPicker = computed(() => props.showTree || props.showSearch)
const showTreePicker = computed(() => props.showTree && (!props.showSearch || mode.value === 'tree'))
const showSearchPicker = computed(() => props.showSearch && (!props.showTree || mode.value === 'search'))

// —— ① 卫星/天线树（来自「星座3D」页；下拉直接绑 ngsoSat.folder：唯一真值源，搜索选星/取消选星清空它即回到未选）——
const curSat = computed(() => props.satTree.find((s) => s.folder === props.ngsoSat.folder) || null)
// 已选、但本机卫星树里没有这颗星（换机器 / 尚未在「星座3D」导入）：保留原值占位显示，不静默清空——
// 轨道根数仍在 ngsoSat 里，照常参与计算。
const staleFolder = computed(() => ((props.ngsoSat.folder && !curSat.value) ? props.ngsoSat.folder : ''))
function onPickSat() {
  const s = curSat.value
  if (!s) { props.onClear(); return }
  props.onPickTree(s)
}
const treeSats = computed(() => props.satTree)
// 取星来源（互斥三选一）：一个卫星条目只认一颗星。
const SRC_LABEL = { tree: '卫星/天线树', search: '星历搜索', manual: '手动轨道' }
const srcLabel = computed(() => SRC_LABEL[props.ngsoSat.mode] || SRC_LABEL.manual)

// —— ② 搜索卫星 —— 候选池 = CelesTrak「active」全域 ∪ 友好命名组（GPS/北斗/GLONASS… 常用名可搜）
// ∪ 本地自定义星座（星座3D Walker 生成器，含椭圆/HEO）。取共享单例（ensureSearchPool，见
// satSearchPool.js）——与「卫星/天线树选择」按 NORAD 反解走同一份池，保证同一颗星两处几何一致。
const pool = ref(null)          // 合并去重后的统一记录集
const customNames = ref([])     // 本地自定义星座名（提示可搜）
const loading = ref(false)
const loadErr = ref('')
const kw = ref('')
const listOpen = ref(false)     // 搜索结果下拉是否展开（选中/失焦后收起，避免「收不回去」）
async function ensurePool() {
  if (pool.value || loading.value) return
  loading.value = true; loadErr.value = ''
  try {
    const res = await ensureSearchPool()
    pool.value = res.all
    customNames.value = res.customNames
    if (!res.all.length) loadErr.value = '未取到任何卫星（需联网获取 CelesTrak OMM，或本地无缓存/自定义星座）'
  } catch (e) {
    loadErr.value = '卫星星历加载失败：' + (e && e.message || e) + '（需联网获取 CelesTrak OMM）'
  } finally { loading.value = false }
}
const searchRes = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!pool.value || !q) return []
  // 同义兜底：active 目录把 GPS 编目成「NAVSTAR …」，即使 gps-ops 组缓存缺失也让「GPS」搜得到
  const wantNavstar = q.includes('gps')
  const out = []
  for (const s of pool.value) {
    // 匹配 常用名 / 编目别名 / NORAD号 / 组标签（如「GPS」「北斗」「自定义」）
    const nm = s.name.toLowerCase()
    if (nm.includes(q) ||
        (s.altName && s.altName.toLowerCase().includes(q)) ||
        String(s.noradId).includes(q) ||
        (s.groupLabel && s.groupLabel.toLowerCase().includes(q)) ||
        (wantNavstar && (nm.includes('navstar') || (s.altName && s.altName.toLowerCase().includes('navstar'))))) {
      out.push(s); if (out.length >= 60) break
    }
  }
  return out.map((s) => ({ ...s, _regime: regimeOf(s), _slot: geoSlotOfOmm(s) }))   // _slot=GEO 定点标注（缓存在池记录上；'elements' 型自然为空）
})
function onSearchFocus() { ensurePool(); listOpen.value = true }
function onSearchBlur() { setTimeout(() => { listOpen.value = false }, 150) }  // 延时让列表项 click 先触发
// 选中后回填搜索框：取实际落到条目上的星名（父组件的 onPickSearch 是唯一真值源，此处只跟随）。
async function pickSearch(rec) {
  listOpen.value = false
  await props.onPickSearch(rec)
  kw.value = props.ngsoSat.name || ''
}
// 选中卫星轨道形状（近/远地点/偏心率/周期 + 严谨区制 GEO/IGSO/MEO/LEO/HEO）——
// 单一「轨道高度」不足以表达椭圆轨道，且区制须按 a/e/i/周期 严谨判定（见 shared/orbitClass.js）。
const orbitShape = computed(() => {
  const o = props.ngsoSat && props.ngsoSat.orbit
  if (!o) return null
  const RE = 6378.137, MU = 398600.4418
  let a = null, e = 0
  if (o.type === 'elements') { e = Math.max(0, Math.min(0.999, Number(o.ecc) || 0)); a = (RE + (Number(o.altKm) || 0)) / (1 - e) }
  else if (o.type === 'omm') { e = Number(o.ecc) || 0; const n = (Number(o.meanMotion) || 0) * 2 * Math.PI / 86400; a = n > 0 ? Math.cbrt(MU / (n * n)) : null }
  else if (o.type === 'snapshot' || o.type === 'circular') { return null }
  if (!a) return null
  const nRadS = Math.sqrt(MU / (a * a * a))
  const periodMin = (2 * Math.PI) / (nRadS * 60)
  const perigeeKm = a * (1 - e) - RE, apogeeKm = a * (1 + e) - RE
  const regime = classifyOrbit({ aKm: a, e, inclDeg: Number(o.incl) || 0, perigeeAltKm: perigeeKm, apogeeAltKm: apogeeKm, periodMin })
  return { apogeeKm, perigeeKm, ecc: e, periodMin, elliptical: e >= 0.01, regime, regimeZh: orbitRegimeLabel(regime) }
})
// 搜索结果单星的严谨区制（供列表徽标）——由平均运动反推周期，配合 e/i/近远地点判定。
function regimeOf(r) {
  const mm = Number(r.meanMotion) || 0
  return classifyOrbit({ e: Number(r.ecc) || 0, inclDeg: Number(r.incl) || 0, perigeeAltKm: Number(r.perigeeKm), apogeeAltKm: Number(r.apogeeKm), periodMin: mm > 0 ? 1440 / mm : NaN })
}
const fmtKm = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
// 卫星树下拉的轨位标注：°E/°W 折算（西经不再写成负°E）；lon 缺失/为 0（Number(null)=0 陷阱）不标
const treeSlot = (s) => { const v = Number(s && s.lon); return Number.isFinite(v) && v !== 0 ? fmtGeoSlot(v) : '' }

// 选完工作频段，上/下行频率跟随预设变（与 GEO 窗口一致；仍可手改）
watch(() => props.form.frequencyBand, (band) => {
  const f = BAND_FREQ[band]; if (!f) return
  props.form.centerFrequency = String(f.up)
  props.form.rxCenterFrequency = String(f.dn)
})
const bandLabel = (o) => BAND_LABEL[o] || o

// 选星后「轨道高度 / 轨道倾角」只读显示「自动」
const isAutoField = (key) => props.satSelected && (key === 'orbitAltitude' || key === 'orbitInclination')

// 字段按行分组：相邻同 pair 的两字段并到一行
const rows = computed(() => {
  const out = [], fs = props.fields
  for (let i = 0; i < fs.length; i++) {
    if (fs[i].pair && fs[i + 1] && fs[i + 1].pair === fs[i].pair) { out.push([fs[i], fs[i + 1]]); i++ }
    else out.push([fs[i]])
  }
  return out
})
</script>

<template>
  <div class="sp">
    <!-- 取星模式头：两种取星都开启时才显分段切换；只开一种时仅在已选星时显「取消选星」 -->
    <div v-if="(showTree && showSearch) || (anyPicker && satSelected)" class="sp-modes">
      <template v-if="showTree && showSearch">
        <button class="sp-seg" :class="{ on: mode === 'tree' }" @click="switchMode('tree')">卫星/天线树选择</button>
        <button class="sp-seg" :class="{ on: mode === 'search' }" @click="switchMode('search')">从星历搜索</button>
      </template>
      <span class="sp-flex"></span>
      <button v-if="satSelected" class="sp-clear" title="取消选星，恢复手动填轨道" @click="onClear">✕ 取消选星</button>
    </div>

    <!-- ① 卫星/天线树选择（资源库卫星编辑器，配置级：写该条目 ngsoSat 轨道来源） -->
    <div v-if="showTreePicker" class="sp-grd">
      <label class="pf"><span class="pf-l">选择卫星</span>
        <select v-model="ngsoSat.folder" class="pf-i" @change="onPickSat">
          <option value="" disabled>从卫星树选择…</option>
          <option v-for="s in treeSats" :key="s.folder" :value="s.folder">{{ s.satName }}<template v-if="treeSlot(s)">（{{ treeSlot(s) }}）</template></option>
          <option v-if="staleFolder" :value="staleFolder">{{ staleFolder }}（未导入）</option>
        </select>
        <i class="pf-u"></i>
      </label>
      <div v-if="staleFolder" class="sp-tip">本机卫星树中没有该卫星。</div>
      <div v-else-if="!satTree.length" class="sp-tip">卫星树为空。</div>
    </div>

    <!-- ② 搜索卫星（资源库编辑器，配置级） -->
    <div v-if="showSearchPicker" class="sp-grd">
      <label class="pf"><span class="pf-l">搜索卫星</span>
        <input v-model="kw" class="pf-i" placeholder="名称 / NORAD 号，如 STARLINK / 44713" @focus="onSearchFocus" @click="listOpen = true" @input="listOpen = true" @blur="onSearchBlur" />
        <i class="pf-u"></i>
      </label>
      <div v-if="loading" class="sp-tip">正在加载星历…</div>
      <div v-else-if="loadErr" class="sp-tip sp-err">{{ loadErr }}</div>
      <template v-else-if="listOpen">
        <div v-if="kw && !searchRes.length" class="sp-tip">无匹配卫星</div>
        <ul v-else-if="searchRes.length" class="sp-list">
          <li v-for="r in searchRes" :key="r.noradId" :class="{ on: ngsoSat.noradId === r.noradId }" @mousedown.prevent="pickSearch(r)">
            <span class="sp-li-n">
              {{ r.name }}
              <em v-if="r.custom" class="sp-badge sp-badge-cc">自定义</em>
              <em v-else-if="r.groupLabel" class="sp-badge">{{ r.groupLabel }}</em>
              <em v-if="r._regime && r._regime !== 'LEO'" class="sp-badge" :class="'sp-rg-' + r._regime">{{ r._slot ? r._regime + ' ' + r._slot : r._regime }}</em>
            </span>
            <span class="sp-li-i">
              {{ r.custom ? '合成' : 'NORAD' }} {{ r.noradId }} · i={{ (+r.incl).toFixed(1) }}° ·
              <template v-if="(+r.ecc) >= 0.01">近{{ Math.round(r.perigeeKm) }}/远{{ Math.round(r.apogeeKm) }}km</template>
              <template v-else>h≈{{ Math.round(r.perigeeKm) }}km</template>
            </span>
          </li>
        </ul>
      </template>
    </div>

    <!-- 当前选星摘要（互视搜索时窗输入已移到工作台计算栏） -->
    <div v-if="anyPicker && satSelected" class="sp-sel">
      <div>已选卫星：<b class="sp-name" title="可框选复制此卫星名" data-i18n-skip>{{ ngsoSat.name || form.satelliteName }}</b>
        <span v-if="ngsoSat.noradId">（NORAD {{ ngsoSat.noradId }}）</span>
        · 取星来源：{{ srcLabel }} · 轨道高度/倾角已由所选卫星自动确定
      </div>
      <div v-if="orbitShape" class="sp-shape">
        <b class="sp-regime" :class="'sp-rg-' + orbitShape.regime" :title="orbitShape.regimeZh">{{ orbitShape.regime }}</b>
        <template v-if="orbitShape.elliptical">
          · 近地点 {{ fmtKm(orbitShape.perigeeKm) }} km · 远地点 {{ fmtKm(orbitShape.apogeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
        </template>
        <template v-else>
          · 圆轨道高度 ≈ {{ fmtKm(orbitShape.perigeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
        </template>
      </div>
    </div>

    <!-- 卫星参数：自适应多列密排（选星后轨道高度/倾角只读「自动」；工作台 show-form=false 不渲染，参数编辑在资源库） -->
    <div v-if="showForm" class="sp-fields">
      <template v-for="f in fields" :key="f.key">
        <span v-if="f.br" class="sp-break" aria-hidden="true"></span>
        <label class="sp-f" :title="f.tip || f.label">
          <span class="sp-l">{{ f.label }}<i v-if="f.unit || isAutoField(f.key)"> ({{ isAutoField(f.key) ? '自动' : f.unit }})</i></span>
          <select v-if="f.type === 'select'" v-model="form[f.key]" class="sp-i">
            <option v-for="o in f.options" :key="o" :value="o">{{ f.key === 'frequencyBand' ? bandLabel(o) : o }}</option>
          </select>
          <input v-else v-model="form[f.key]" class="sp-i mono" :class="{ auto: isAutoField(f.key) }" :readonly="isAutoField(f.key)" :placeholder="f.ph || ''" />
        </label>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sp { max-width: 940px; }
.sp-modes { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.sp-seg { font-size: 12px; padding: 4px 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: var(--r-box); cursor: pointer; }
.sp-seg.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.sp-flex { flex: 1; }
.sp-clear { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: var(--r-box); cursor: pointer; }
.sp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
.sp-grd .pf { margin-bottom: 6px; }
.sp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; margin-top: 2px; }
.sp-err { color: var(--danger); }
.sp-list { list-style: none; margin: 4px 0; padding: 0; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-box); }
.sp-list li { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--border); }
.sp-list li:last-child { border-bottom: none; }
.sp-list li:hover { background: var(--surface); }
.sp-list li.on { background: var(--surface-2); }
.sp-li-n { display: block; font-size: 12px; color: var(--text); }
.sp-li-i { display: block; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.sp-badge { display: inline-block; font-size: 9px; font-style: normal; padding: 0 5px; margin-left: 5px; border-radius: var(--r-pill); background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); vertical-align: middle; }
.sp-badge-cc { background: var(--accent); color: var(--bg); border-color: var(--accent); }
/* 轨道区制徽标配色（列表）：GEO 绿 / IGSO 青 / MEO 蓝 / HEO 琥珀（LEO 不显示徽标） */
.sp-badge.sp-rg-GEO { background: #16a34a1a; color: #16a34a; border-color: #16a34a55; }
.sp-badge.sp-rg-IGSO { background: #0d94881a; color: #0d9488; border-color: #0d948855; }
.sp-badge.sp-rg-MEO { background: #2563eb1a; color: #2563eb; border-color: #2563eb55; }
.sp-badge.sp-rg-HEO { background: #f59f0022; color: #d98600; border-color: #f59f0055; }
.sp-sel { font-size: 11px; color: var(--text-muted); background: var(--surface); border-radius: var(--r-box); padding: 6px 8px; margin-bottom: 10px; }
/* 卫星名可框选复制（覆盖全局 user-select:none），文本光标作可选的提示 —— 方便用户复制去改名 */
.sp-name { user-select: text; -webkit-user-select: text; cursor: text; }
.sp-shape { margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--border); }
/* 轨道区制标签（选星摘要）配色 */
.sp-regime { font-weight: 700; }
.sp-regime.sp-rg-GEO { color: #16a34a; }
.sp-regime.sp-rg-IGSO { color: #0d9488; }
.sp-regime.sp-rg-MEO { color: #2563eb; }
.sp-regime.sp-rg-LEO { color: var(--text-muted); }
.sp-regime.sp-rg-HEO { color: #d98600; }
/* 参数密排网格（与 GEO 卫星面板同款） */
.sp-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 7px 11px; }
/* 整行占位：令下一字段另起一行（上/下行干扰分行用）；零高度，仅靠栅格行距形成一点间隔，不加边框/底色 */
.sp-break { grid-column: 1 / -1; height: 0; }
.sp-f { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sp-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-l i { color: var(--text-faint); font-style: normal; }
.sp-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sp-i:focus { outline: none; border-color: var(--accent); }
.sp-i.mono { font-family: var(--font-mono); }
.sp-i.auto { background-color: var(--surface); color: var(--text-muted); cursor: not-allowed; }
/* 取星区（树/搜索）沿用 pf 行式，仅放宽选择列 */
.pf { display: grid; grid-template-columns: 96px minmax(180px, 320px) 30px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-i.auto { background-color: var(--surface); color: var(--text-muted); cursor: not-allowed; }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }
</style>
