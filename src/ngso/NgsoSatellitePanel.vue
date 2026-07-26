<script setup>
import { computed, ref, watch } from 'vue'
import { BAND_FREQ, BAND_LABEL } from './satPresets.js'
import { ensureSearchPool } from './satSearchPool.js'
import { classifyOrbit, orbitRegimeLabel } from '../shared/orbitClass.js'
import Icon from '../components/Icon.vue'

// NGSO 卫星模块：两种取星模式（互斥）——
//  ① 天线树导入：从「星座3D」页导入的 GRD 卫星树选星 → 给「卫星EIRP / 卫星G/T」匹配天线，
//     按各发/收信站经纬度取多波束最大 Parameter 回填站表（联动在父组件）；同时用该星轨道自动算斜距。
//  ② 搜索卫星：按名称/NORAD 检索 CelesTrak OMM 全域 → 选中只带轨道根数（不导 EIRP/GT），自动算斜距。
// 选星后（任一模式）「轨道高度 / 轨道倾角」只读并显示「自动」（由所选卫星轨道确定）。
// v1.4.3 起两种取星器都在资源库卫星编辑器里（分段切换，showTree + showSearch + showForm，均为配置级：
// 天线树导入写该条目的 ngsoSat + grd（方向图匹配），搜索卫星只写 ngsoSat 轨道根数）——轨道来源与方向图
// 都是卫星库条目的属性，随条目传入；工作台「卫星与轨道」分区只留只读速览行，不再渲染本组件。
const props = defineProps({
  form: { type: Object, required: true },
  fields: { type: Array, required: true },
  satTree: { type: Array, default: () => [] },       // [{ folder, satName, lon, antennas:[{name,beams}] , elements?, noradId? }]
  sel: { type: Object, default: () => ({ satFolder: '', eirpKey: '', gtKey: '' }) },   // 库条目的 grd（方向图匹配），本组件就地写入
  ngsoSat: { type: Object, default: () => ({ mode: 'manual', orbit: null, name: '', noradId: null }) },   // 该卫星的轨道来源（库条目属性）
  satSelected: { type: Boolean, default: false },
  onPickTree: { type: Function, default: () => {} },    // (node) => void
  onPickSearch: { type: Function, default: () => {} },  // (ommRec) => void
  onClear: { type: Function, default: () => {} },       // () => void
  // 本模块导入的方向图节点（local:true，只有天线、没有轨道根数）：选中它只改方向图匹配，
  // 不动本条目的轨道来源（轨道仍由天线树取星/星历检索/手动填决定）。
  onPickLocal: { type: Function, default: () => {} },   // (node) => void
  // 「导入方向图」：在本编辑器里直接导入 GRD/PAT 挂到本卫星条目名下（免去先去「星座3D」页导入）
  onImport: { type: Function, default: null },          // () => Promise<void>
  onRemoveAnt: { type: Function, default: null },       // () => Promise<void>
  importing: { type: Boolean, default: false },
  // 取星器/表单三段独立开关（保留独立开关：便于将来单独嵌用其中一段）
  showTree: { type: Boolean, default: false },       // 渲染「天线树导入」取星器（选 GRD 卫星 + 匹配 EIRP/G·T 天线）
  showSearch: { type: Boolean, default: false },     // 渲染「搜索卫星」取星器（仅写轨道根数到该条目）
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

// —— ① 天线树 ——
const curSat = computed(() => props.satTree.find((s) => s.folder === props.sel.satFolder) || null)
const antKey = (a) => (curSat.value ? curSat.value.folder + '|' + a.name : '')
// 已匹配、但本机卫星树里没有这颗 GRD 卫星（换机器 / 尚未在「星座3D」导入）：保留原值占位显示，
// 不静默清空——库是全局资产，清掉的匹配无从找回；未命中期间父组件自然不回填（轨道根数仍在 ngsoSat 里）。
const staleFolder = computed(() => ((props.sel.satFolder && !curSat.value) ? props.sel.satFolder : ''))
function onPickSat() {
  const s = curSat.value
  props.sel.eirpKey = ''; props.sel.gtKey = ''
  if (!s) { props.onClear(); return }
  // local 节点＝本模块导入的方向图，本身不带轨道根数：只接方向图，轨道来源保持不变
  if (s.local) props.onPickLocal(s); else props.onPickTree(s)
}
// 卫星树按来源分两组：星座3D 页导入的（带轨道，可作轨道来源）/ 本模块导入的（只有方向图）
const treeSats = computed(() => props.satTree.filter((s) => !s.local))
const localSats = computed(() => props.satTree.filter((s) => s.local))
const localAnts = computed(() => ((curSat.value && curSat.value.local) ? curSat.value.antennas : []))
// 取星来源（互斥三选一）：一个卫星条目只认一颗星，轨道与方向图必须出自同一次取星。
// 只作标签用——真会作废方向图匹配时父组件会弹确认，不再另铺提示句。
const SRC_LABEL = { tree: '天线树', search: '星历检索', manual: '手动轨道' }
const srcLabel = computed(() => SRC_LABEL[props.ngsoSat.mode] || SRC_LABEL.manual)

// —— ② 搜索卫星 —— 候选池 = CelesTrak「active」全域 ∪ 友好命名组（GPS/北斗/GLONASS… 常用名可搜）
// ∪ 本地自定义星座（星座3D Walker 生成器，含椭圆/HEO）。取共享单例（ensureSearchPool，见
// satSearchPool.js）——与「天线树导入」按 NORAD 反解走同一份池，保证同一颗星两处几何一致。
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
  return out.map((s) => ({ ...s, _regime: regimeOf(s) }))
})
function onSearchFocus() { ensurePool(); listOpen.value = true }
function onSearchBlur() { setTimeout(() => { listOpen.value = false }, 150) }  // 延时让列表项 click 先触发
// 选中后回填搜索框：取实际落到条目上的星名——改用星历检索会作废方向图匹配，父组件可能弹确认，
// 用户点「取消」时这里就不该留下一个并未选中的星名。
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
        <button class="sp-seg" :class="{ on: mode === 'tree' }" @click="switchMode('tree')">天线树导入</button>
        <button class="sp-seg" :class="{ on: mode === 'search' }" @click="switchMode('search')">搜索卫星</button>
      </template>
      <span class="sp-flex"></span>
      <button v-if="satSelected" class="sp-clear" title="取消选星，恢复手动填轨道" @click="onClear">✕ 取消选星</button>
    </div>

    <!-- ① 天线树导入（资源库卫星编辑器，配置级：写该条目 ngsoSat + grd） -->
    <div v-if="showTreePicker" class="sp-grd">
      <label class="pf"><span class="pf-l">选择卫星</span>
        <select v-model="sel.satFolder" class="pf-i" @change="onPickSat">
          <option value="" disabled>从卫星树选择…</option>
          <optgroup v-if="treeSats.length" label="星座3D 导入（带轨道，可作轨道来源）">
            <option v-for="s in treeSats" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
          </optgroup>
          <optgroup v-if="localSats.length" label="本模块导入（仅方向图，不改轨道来源）">
            <option v-for="s in localSats" :key="s.folder" :value="s.folder">{{ s.satName }}</option>
          </optgroup>
          <option v-if="staleFolder" :value="staleFolder">{{ staleFolder }}（未导入）</option>
        </select>
        <i class="pf-u"></i>
      </label>
      <!-- 直接导入：方向图挂在本卫星条目名下（轨道来源另定，见上方分组说明） -->
      <div v-if="onImport" class="sp-gacts">
        <button class="sp-gbtn" :disabled="importing"
                title="直接导入 GRD / PAT 方向图（可多选），挂到本卫星条目名下；一个文件＝一副天线，文件内多个 set＝多波束"
                @click.prevent="onImport()">
          <Icon name="folder-plus" :size="12" /><span>{{ importing ? '导入中…' : '导入方向图' }}</span>
        </button>
        <button v-if="onRemoveAnt && localAnts.length" class="sp-gbtn" :disabled="importing"
                :title="'删除本条目导入的方向图：' + localAnts.map((a) => a.name).join('、')"
                @click.prevent="onRemoveAnt()">
          <Icon name="eye-off" :size="12" /><span>删除方向图</span>
        </button>
      </div>
      <div v-if="staleFolder" class="sp-tip">本机卫星树中没有该 GRD 卫星，匹配已保留：在「星座3D」页导入后自动恢复回填（轨道根数不受影响）</div>
      <div v-else-if="!satTree.length" class="sp-tip">卫星树为空：点「导入方向图」直接导入，或在「星座3D」页导入 GRD 天线</div>
      <template v-else-if="curSat">
        <template v-if="curSat.antennas.length">
          <label class="pf"><span class="pf-l" title="按各收信站经纬度取该天线多波束最大 Parameter → 卫星EIRP">卫星EIRP 天线</span>
            <select v-model="sel.eirpKey" class="pf-i">
              <option value="">— 未匹配 —</option>
              <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
            </select>
            <i class="pf-u"></i>
          </label>
          <label class="pf"><span class="pf-l" title="按各发信站经纬度取该天线多波束最大 Parameter → 卫星G/T">卫星G/T 天线</span>
            <select v-model="sel.gtKey" class="pf-i">
              <option value="">— 未匹配 —</option>
              <option v-for="a in curSat.antennas" :key="a.name" :value="antKey(a)">{{ a.name }}（{{ a.beams }} 波束）</option>
            </select>
            <i class="pf-u"></i>
          </label>
          <div class="sp-tip">匹配后按站经纬度自动回填：收信站「卫星EIRP」、发信站「卫星G/T」（多波束取 Parameter 最大者）；斜距按所选卫星轨道自动计算。</div>
        </template>
        <div v-else class="sp-tip">该卫星未导入天线，仅作轨道来源：斜距按其轨道自动计算，EIRP/G/T 请在发/收信站手动输入。</div>
      </template>
    </div>

    <!-- ② 搜索卫星（资源库编辑器，配置级） -->
    <div v-if="showSearchPicker" class="sp-grd">
      <label class="pf"><span class="pf-l">搜索卫星</span>
        <input v-model="kw" class="pf-i" placeholder="名称 / NORAD 号，如 STARLINK / 44713" @focus="onSearchFocus" @click="listOpen = true" @input="listOpen = true" @blur="onSearchBlur" />
        <i class="pf-u"></i>
      </label>
      <div v-if="loading" class="sp-tip">正在加载星历（CelesTrak 全域 + 导航星常用名 + 本地自定义星座）…</div>
      <div v-else-if="loadErr" class="sp-tip sp-err">{{ loadErr }}</div>
      <template v-else-if="listOpen">
        <div v-if="kw && !searchRes.length" class="sp-tip">无匹配卫星</div>
        <ul v-else-if="searchRes.length" class="sp-list">
          <li v-for="r in searchRes" :key="r.noradId" :class="{ on: ngsoSat.noradId === r.noradId }" @mousedown.prevent="pickSearch(r)">
            <span class="sp-li-n">
              {{ r.name }}
              <em v-if="r.custom" class="sp-badge sp-badge-cc">自定义</em>
              <em v-else-if="r.groupLabel" class="sp-badge">{{ r.groupLabel }}</em>
              <em v-if="r._regime && r._regime !== 'LEO'" class="sp-badge" :class="'sp-rg-' + r._regime">{{ r._regime }}</em>
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
      <div>已选卫星：<b class="sp-name" title="可框选复制此卫星名">{{ ngsoSat.name || form.satelliteName }}</b>
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
.sp-seg { font-size: 12px; padding: 4px 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.sp-seg.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.sp-flex { flex: 1; }
.sp-clear { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.sp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
.sp-grd .pf { margin-bottom: 6px; }
.sp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; margin-top: 2px; }
/* 直接导入 / 删除方向图 */
.sp-gacts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.sp-gbtn { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12px; padding: 3px 9px; cursor: pointer; white-space: nowrap; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 3px); }
.sp-gbtn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sp-gbtn:disabled { opacity: .55; cursor: default; }
.sp-err { color: var(--danger); }
.sp-list { list-style: none; margin: 4px 0; padding: 0; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 3px; }
.sp-list li { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--border); }
.sp-list li:last-child { border-bottom: none; }
.sp-list li:hover { background: var(--surface); }
.sp-list li.on { background: var(--surface-2); }
.sp-li-n { display: block; font-size: 12px; color: var(--text); }
.sp-li-i { display: block; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.sp-badge { display: inline-block; font-size: 9px; font-style: normal; padding: 0 5px; margin-left: 5px; border-radius: 8px; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); vertical-align: middle; }
.sp-badge-cc { background: var(--accent); color: #fff; border-color: var(--accent); }
/* 轨道区制徽标配色（列表）：GEO 绿 / IGSO 青 / MEO 蓝 / HEO 琥珀（LEO 不显示徽标） */
.sp-badge.sp-rg-GEO { background: #16a34a1a; color: #16a34a; border-color: #16a34a55; }
.sp-badge.sp-rg-IGSO { background: #0d94881a; color: #0d9488; border-color: #0d948855; }
.sp-badge.sp-rg-MEO { background: #2563eb1a; color: #2563eb; border-color: #2563eb55; }
.sp-badge.sp-rg-HEO { background: #f59f0022; color: #d98600; border-color: #f59f0055; }
.sp-sel { font-size: 11px; color: var(--text-muted); background: var(--surface); border-radius: 3px; padding: 6px 8px; margin-bottom: 10px; }
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
.sp-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sp-i:focus { outline: none; border-color: var(--accent); }
.sp-i.mono { font-family: var(--font-mono); }
.sp-i.auto { background: var(--surface); color: var(--text-muted); cursor: not-allowed; }
/* 取星区（树/搜索）沿用 pf 行式，仅放宽选择列 */
.pf { display: grid; grid-template-columns: 96px minmax(180px, 320px) 30px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 2px; }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-i.auto { background: var(--surface); color: var(--text-muted); cursor: not-allowed; }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }
</style>
