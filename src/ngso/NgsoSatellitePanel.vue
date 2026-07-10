<script setup>
import { computed, ref, watch } from 'vue'
import { BAND_FREQ, BAND_LABEL } from './satPresets.js'
import { ensureSearchPool } from './satSearchPool.js'

// NGSO 卫星模块：两种取星模式（互斥）——
//  ① 天线树导入：从「星座3D」页导入的 GRD 卫星树选星 → 给「卫星EIRP / 卫星G/T」匹配天线，
//     按各发/收信站经纬度取多波束最大 Parameter 回填站表（联动在父组件）；同时用该星轨道自动算斜距。
//  ② 搜索卫星：按名称/NORAD 检索 CelesTrak OMM 全域 → 选中只带轨道根数（不导 EIRP/GT），自动算斜距。
// 选星后（任一模式）「轨道高度 / 轨道倾角」只读并显示「自动」（由所选卫星轨道确定）。
const props = defineProps({
  form: { type: Object, required: true },
  fields: { type: Array, required: true },
  satTree: { type: Array, default: () => [] },       // [{ folder, satName, lon, antennas:[{name,beams}] , elements?, noradId? }]
  sel: { type: Object, required: true },             // { satFolder, eirpKey, gtKey }（父组件持有）
  ngsoSat: { type: Object, required: true },         // { mode, orbit, name, noradId }
  satSelected: { type: Boolean, default: false },
  horizonHours: { type: Number, default: 24 },       // 互视最差几何搜索时窗（小时）
  onPickTree: { type: Function, required: true },    // (node) => void
  onPickSearch: { type: Function, required: true },  // (ommRec) => void
  onClear: { type: Function, required: true },       // () => void
  onHorizon: { type: Function, required: true }      // (hours) => void
})
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 120, l: '5 天' }, { v: 168, l: '7 天' }, { v: 336, l: '14 天' }, { v: 720, l: '30 天' }]

// 取星模式分段控件：tree / search（切换时清空另一模式的选择）
const mode = ref(props.ngsoSat.mode === 'search' ? 'search' : 'tree')
function switchMode(m) {
  if (mode.value === m) return
  mode.value = m
  props.onClear()
  if (m === 'search') { props.sel.satFolder = ''; props.sel.eirpKey = ''; props.sel.gtKey = '' }
}

// —— ① 天线树 ——
const curSat = computed(() => props.satTree.find((s) => s.folder === props.sel.satFolder) || null)
const antKey = (a) => (curSat.value ? curSat.value.folder + '|' + a.name : '')
function onPickSat() {
  const s = curSat.value
  props.sel.eirpKey = ''; props.sel.gtKey = ''
  if (s) props.onPickTree(s); else props.onClear()
}

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
  return out
})
function onSearchFocus() { ensurePool(); listOpen.value = true }
function onSearchBlur() { setTimeout(() => { listOpen.value = false }, 150) }  // 延时让列表项 click 先触发
function pickSearch(rec) { props.onPickSearch(rec); kw.value = rec.name; listOpen.value = false }
// 选中卫星轨道形状（近/远地点/偏心率/周期）——椭圆/HEO 单一「轨道高度」不足以表达，此处补全
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
  return { apogeeKm: a * (1 + e) - RE, perigeeKm: a * (1 - e) - RE, ecc: e, periodMin: (2 * Math.PI) / (nRadS * 60), elliptical: e >= 0.01 }
})
const fmtKm = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))

// 选完工作频段，上/下行频率跟随预设变
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
    <!-- 取星模式 -->
    <div class="sp-modes">
      <button class="sp-seg" :class="{ on: mode === 'tree' }" @click="switchMode('tree')">天线树导入</button>
      <button class="sp-seg" :class="{ on: mode === 'search' }" @click="switchMode('search')">搜索卫星</button>
      <span class="sp-flex"></span>
      <button v-if="satSelected" class="sp-clear" title="取消选星，恢复手动填轨道" @click="onClear">✕ 取消选星</button>
    </div>

    <!-- ① 天线树导入 -->
    <div v-if="mode === 'tree'" class="sp-grd">
      <label class="pf"><span class="pf-l">选择卫星</span>
        <select v-model="sel.satFolder" class="pf-i" @change="onPickSat">
          <option value="" disabled>从卫星树选择…</option>
          <option v-for="s in satTree" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
        </select>
        <i class="pf-u"></i>
      </label>
      <div v-if="!satTree.length" class="sp-tip">卫星树为空：请先在「星座3D」页导入 GRD 天线</div>
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
        <div v-else class="sp-tip">该卫星未导入天线，仅作轨道来源：斜距按其轨道自动计算，EIRP/G/T 请在发/收信站手填。</div>
      </template>
    </div>

    <!-- ② 搜索卫星 -->
    <div v-else class="sp-grd">
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
              <em v-if="(+r.ecc) >= 0.1" class="sp-badge sp-badge-heo">HEO e={{ (+r.ecc).toFixed(2) }}</em>
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

    <!-- 当前选星摘要 + 互视最差几何搜索时窗 -->
    <div v-if="satSelected" class="sp-sel">
      <div>已选卫星：<b>{{ ngsoSat.name || form.satelliteName }}</b>
        <span v-if="ngsoSat.noradId">（NORAD {{ ngsoSat.noradId }}）</span>
        · 轨道高度/倾角已由所选卫星自动确定
      </div>
      <div v-if="orbitShape" class="sp-shape">
        <template v-if="orbitShape.elliptical">
          <b class="sp-heo">椭圆/HEO</b> · 近地点 {{ fmtKm(orbitShape.perigeeKm) }} km · 远地点 {{ fmtKm(orbitShape.apogeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
        </template>
        <template v-else>
          圆轨道高度 ≈ {{ fmtKm(orbitShape.perigeeKm) }} km · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
        </template>
      </div>
      <label class="sp-hz">互视最差几何搜索时窗
        <select :value="horizonHours" class="sp-hz-i" @change="onHorizon(Number($event.target.value))">
          <option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option>
        </select>
        <span class="sp-hz-t">（从当前时刻起在此时窗内，比较全部互视过境，取最坏一次的工况）</span>
      </label>
    </div>

    <!-- 卫星参数表单（频率+极化、轨道高度+倾角成对一行；选星后轨道高度/倾角只读「自动」）-->
    <div class="form">
      <div v-for="(row, ri) in rows" :key="ri" class="sp-row2" :class="{ pair: row.length === 2 }">
        <label v-for="f in row" :key="f.key" class="pf">
          <span class="pf-l" :title="f.tip || f.label">{{ f.label }}</span>
          <select v-if="f.type === 'select'" v-model="form[f.key]" class="pf-i">
            <option v-for="o in f.options" :key="o" :value="o">{{ f.key === 'frequencyBand' ? bandLabel(o) : o }}</option>
          </select>
          <input v-else v-model="form[f.key]" class="pf-i mono" :class="{ auto: isAutoField(f.key) }" :readonly="isAutoField(f.key)" :placeholder="f.ph || ''" />
          <i class="pf-u">{{ isAutoField(f.key) ? '自动' : (f.unit || '') }}</i>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sp { max-width: 520px; }
.sp-modes { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.sp-seg { font-size: 12px; padding: 4px 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.sp-seg.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.sp-flex { flex: 1; }
.sp-clear { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.sp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
.sp-grd .pf { margin-bottom: 6px; }
.sp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; margin-top: 2px; }
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
.sp-badge-heo { background: #f59f0022; color: #d98600; border-color: #f59f0055; }
.sp-sel { font-size: 11px; color: var(--text-muted); background: var(--surface); border-radius: 3px; padding: 6px 8px; margin-bottom: 10px; }
.sp-shape { margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--border); }
.sp-heo { color: #d98600; }
.sp-hz { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }
.sp-hz-i { font: inherit; font-size: 11px; padding: 2px 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 2px; }
.sp-hz-t { color: var(--text-faint); }
.sp-row2 { margin-bottom: 6px; }
.sp-row2.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.sp-row2 .pf { margin-bottom: 0; }
.sp-row2.pair .pf { grid-template-columns: 96px 110px 30px; }
.pf { display: grid; grid-template-columns: 96px 110px 36px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 2px; }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-i.auto { background: var(--surface); color: var(--text-muted); cursor: not-allowed; }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }
</style>
