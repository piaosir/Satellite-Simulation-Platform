<script setup>
import { computed, ref, watch } from 'vue'
import { BAND_FREQ, BAND_LABEL } from '../ngso/satPresets.js'
import { ensureSearchPool, findPoolByNorad } from '../ngso/satSearchPool.js'
import { classifyOrbit, orbitRegimeLabel } from '../shared/orbitClass.js'

// 再生式「卫星群」单份配置的参数面板 —— 和 NGSO 一样支持「搜索卫星 / 天线树导入」选星定轨道。
// 【不做 EIRP 匹配】；卫星 G/T 不在此面板取值——它是「卫星×发信站」配对量，由各发信站在「发信站群」表逐站手动输入。
// 每份卫星配置各自持有 form（频段/极化/轨道，不含 G/T）与 ngsoSat（轨道来源，tree 模式记 folder），本组件按引用就地改写。
const props = defineProps({
  form: { type: Object, required: true },              // 卫星参数（satelliteName / 频段 / 上行频率极化 / 轨道高度倾角）
  fields: { type: Array, required: true },             // SAT_FIELDS
  ngsoSat: { type: Object, required: true },           // { mode:'manual'|'tree'|'search', orbit, name, noradId, folder }
  satTree: { type: Array, default: () => [] }          // 天线树（星座3D 导入的卫星，用于取轨道）
})

const satSelected = computed(() => props.ngsoSat.mode !== 'manual' && !!props.ngsoSat.orbit)

// —— 取星模式：天线树导入 / 搜索卫星。仅切换「看哪个选星器」，不动已选卫星——
// 单一 active 卫星在两标签页间保留，来回切换不再清缓存；只有真正另选一颗星才替换当前选星
// （互斥由 pick 时清 ngsoSat.folder 保证；tree 下拉直接绑 ngsoSat.folder，无独立本地态需同步）。
const mode = ref(props.ngsoSat.mode === 'search' ? 'search' : (props.ngsoSat.mode === 'tree' ? 'tree' : 'tree'))
function switchMode(m) { if (mode.value === m) return; mode.value = m }
function onClear() { props.ngsoSat.mode = 'manual'; props.ngsoSat.orbit = null; props.ngsoSat.name = ''; props.ngsoSat.noradId = null; props.ngsoSat.folder = '' }

// 平均运动(rev/day) → 圆轨道高度(km)
const _MU = 398600.4418, _RE = 6378.137
function altFromMeanMotion(revDay) {
  const n = (Number(revDay) || 0) * 2 * Math.PI / 86400
  if (!(n > 0)) return null
  return Math.cbrt(_MU / (n * n)) - _RE
}

// —— ① 天线树导入：按 NORAD/根数解析真实轨道（与 NGSO 同口径，读同一份共享候选池）——
// tree 下拉直接绑定 ngsoSat.folder（唯一真值源）：搜索选星/取消选星把它清空即自动回到未选，
// 重载时也自动回显已保存的 folder，无需独立本地态同步（切换标签页因此不会丢失树选星）。
const curNode = computed(() => props.satTree.find((s) => s.folder === props.ngsoSat.folder) || null)
async function treeNodeOrbit(node) {
  if (!node) return null
  const kind = node.kind || ''
  if (node.noradId != null) {
    const rec = await findPoolByNorad(node.noradId)
    if (rec) {
      if (rec.orbitType === 'elements' && rec.elements) {
        const e = rec.elements
        return { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
      }
      return { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
    }
    return { type: 'unresolved', noradId: node.noradId, reason: `关联星（NORAD ${node.noradId}）暂未在星历库解析到轨道（可能离线或本地缓存缺失）。请联网后在「搜索卫星」按 NORAD 重选，或改用手动轨道高度+倾角。` }
  }
  if (node.omm && node.omm.meanMotion) return Object.assign({ type: 'omm' }, node.omm)
  const el = node.elements
  if (el && el.altKm != null) return { type: 'elements', altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, epoch: node.epoch || null, noradId: node.noradId }
  if ((kind === 'preset' || kind === 'custom' || !kind) && node.altKm != null) return { type: 'snapshot', lonDeg: Number(node.lon) || 0, latDeg: Number(node.lat) || 0, altKm: Number(node.altKm) || 0, noradId: node.noradId }
  return { type: 'unresolved', noradId: node.noradId, reason: `卫星「${node.satName || node.folder}」缺少可用轨道根数，无法确定其轨道。请在「星座3D」页为其补充轨道根数，或改用手动轨道高度+倾角。` }
}
async function onPickTree() {
  const node = curNode.value
  if (!node) { onClear(); return }
  props.ngsoSat.mode = 'tree'; props.ngsoSat.name = node.satName; props.ngsoSat.noradId = node.noradId || null
  props.ngsoSat.folder = node.folder
  props.form.satelliteName = node.satName
  const orbit = await treeNodeOrbit(node)
  props.ngsoSat.orbit = orbit
  applyOrbitToForm(orbit)
}

// —— ② 搜索卫星：CelesTrak 全域 ∪ 常用名 ∪ 本地自定义星座（仅取轨道根数）——
const pool = ref(null)
const loading = ref(false)
const loadErr = ref('')
const kw = ref('')
const listOpen = ref(false)
async function ensurePool() {
  if (pool.value || loading.value) return
  loading.value = true; loadErr.value = ''
  try {
    const res = await ensureSearchPool()
    pool.value = res.all
    if (!res.all.length) loadErr.value = '未取到任何卫星（需联网获取 CelesTrak OMM，或本地无缓存/自定义星座）'
  } catch (e) {
    loadErr.value = '卫星星历加载失败：' + (e && e.message || e) + '（需联网获取 CelesTrak OMM）'
  } finally { loading.value = false }
}
const searchRes = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!pool.value || !q) return []
  const wantNavstar = q.includes('gps')
  const out = []
  for (const s of pool.value) {
    const nm = s.name.toLowerCase()
    if (nm.includes(q) || (s.altName && s.altName.toLowerCase().includes(q)) || String(s.noradId).includes(q) ||
        (s.groupLabel && s.groupLabel.toLowerCase().includes(q)) ||
        (wantNavstar && (nm.includes('navstar') || (s.altName && s.altName.toLowerCase().includes('navstar'))))) {
      out.push(s); if (out.length >= 60) break
    }
  }
  return out.map((s) => ({ ...s, _regime: regimeOf(s) }))
})
function onSearchFocus() { ensurePool(); listOpen.value = true }
function onSearchBlur() { setTimeout(() => { listOpen.value = false }, 150) }
function pickSearch(rec) {
  props.ngsoSat.mode = 'search'; props.ngsoSat.name = rec.name; props.ngsoSat.noradId = rec.noradId || null
  props.ngsoSat.folder = ''
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    props.ngsoSat.orbit = { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
  } else {
    props.ngsoSat.orbit = { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
  }
  props.form.satelliteName = rec.name
  applyOrbitToForm(props.ngsoSat.orbit)
  kw.value = rec.name; listOpen.value = false
}

// 选星后回显轨道高度/倾角到 form（只读「自动」）
function applyOrbitToForm(orbit) {
  if (!orbit) return
  if (orbit.type === 'elements') {
    if (orbit.altKm != null) props.form.orbitAltitude = String(Math.round(orbit.altKm))
    if (orbit.incl != null) props.form.orbitInclination = String(orbit.incl)
  } else if (orbit.type === 'omm') {
    const h = altFromMeanMotion(orbit.meanMotion); if (h != null) props.form.orbitAltitude = h.toFixed(0)
    if (orbit.incl != null) props.form.orbitInclination = String(orbit.incl)
  } else if (orbit.type === 'snapshot') {
    if (orbit.altKm != null) props.form.orbitAltitude = String(Math.round(orbit.altKm))
    props.form.orbitInclination = String(Math.abs(Number(orbit.latDeg) || 0).toFixed(2))
  }
}

// 选中卫星轨道形状（近/远地点/偏心率/周期 + 严谨区制 GEO/IGSO/MEO/LEO/HEO，见 shared/orbitClass.js）
const orbitShape = computed(() => {
  const o = props.ngsoSat && props.ngsoSat.orbit
  if (!o) return null
  const RE = 6378.137, MU = 398600.4418
  let a = null, e = 0
  if (o.type === 'elements') { e = Math.max(0, Math.min(0.999, Number(o.ecc) || 0)); a = (RE + (Number(o.altKm) || 0)) / (1 - e) }
  else if (o.type === 'omm') { e = Number(o.ecc) || 0; const n = (Number(o.meanMotion) || 0) * 2 * Math.PI / 86400; a = n > 0 ? Math.cbrt(MU / (n * n)) : null }
  else return null
  if (!a) return null
  const nRadS = Math.sqrt(MU / (a * a * a))
  const periodMin = (2 * Math.PI) / (nRadS * 60)
  const perigeeKm = a * (1 - e) - RE, apogeeKm = a * (1 + e) - RE
  const regime = classifyOrbit({ aKm: a, e, inclDeg: Number(o.incl) || 0, perigeeAltKm: perigeeKm, apogeeAltKm: apogeeKm, periodMin })
  return { apogeeKm, perigeeKm, ecc: e, periodMin, elliptical: e >= 0.01, regime, regimeZh: orbitRegimeLabel(regime) }
})
// 搜索结果单星的严谨区制（供列表徽标）
function regimeOf(r) {
  const mm = Number(r.meanMotion) || 0
  return classifyOrbit({ e: Number(r.ecc) || 0, inclDeg: Number(r.incl) || 0, perigeeAltKm: Number(r.perigeeKm), apogeeAltKm: Number(r.apogeeKm), periodMin: mm > 0 ? 1440 / mm : NaN })
}
const fmtKm = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))

// 选完工作频段，上行频率跟随预设变
watch(() => props.form.frequencyBand, (band) => { const f = BAND_FREQ[band]; if (f) props.form.centerFrequency = String(f.up) })
const bandLabel = (o) => BAND_LABEL[o] || o
const isAutoField = (key) => satSelected.value && (key === 'orbitAltitude' || key === 'orbitInclination')

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
  <div class="rsp">
    <!-- 取星模式 -->
    <div class="rsp-modes">
      <button class="rsp-seg" :class="{ on: mode === 'tree' }" @click="switchMode('tree')">天线树导入</button>
      <button class="rsp-seg" :class="{ on: mode === 'search' }" @click="switchMode('search')">搜索卫星</button>
      <span class="rsp-flex"></span>
      <button v-if="satSelected" class="rsp-clear" title="取消选星，恢复手动填轨道" @click="onClear">✕ 取消选星</button>
    </div>

    <!-- ① 天线树导入：取所选卫星轨道用于几何求解 -->
    <div v-if="mode === 'tree'" class="rsp-grd">
      <label class="pf"><span class="pf-l">选择卫星</span>
        <select v-model="ngsoSat.folder" class="pf-i" @change="onPickTree">
          <option value="" disabled>从卫星树选择…</option>
          <option v-for="s in satTree" :key="s.folder" :value="s.folder">{{ s.satName }}（{{ s.lon }}°E）</option>
        </select>
        <i class="pf-u"></i>
      </label>
      <div v-if="!satTree.length" class="rsp-tip">卫星树为空：请先在「星座3D」页导入卫星（作轨道来源），或改用「搜索卫星」。</div>
      <div v-else class="rsp-tip">取所选卫星轨道用于几何求解（斜距/仰角/访问窗口）；卫星 G/T 在「发信站群」表逐站手动输入。</div>
    </div>

    <!-- ② 搜索卫星 -->
    <div v-else class="rsp-grd">
      <label class="pf"><span class="pf-l">搜索卫星</span>
        <input v-model="kw" class="pf-i" placeholder="名称 / NORAD 号，如 STARLINK / 44713" @focus="onSearchFocus" @click="listOpen = true" @input="listOpen = true" @blur="onSearchBlur" />
        <i class="pf-u"></i>
      </label>
      <div v-if="loading" class="rsp-tip">正在加载星历（CelesTrak 全域 + 导航星常用名 + 本地自定义星座）…</div>
      <div v-else-if="loadErr" class="rsp-tip rsp-err">{{ loadErr }}</div>
      <template v-else-if="listOpen">
        <div v-if="kw && !searchRes.length" class="rsp-tip">无匹配卫星</div>
        <ul v-else-if="searchRes.length" class="rsp-list">
          <li v-for="r in searchRes" :key="r.noradId" :class="{ on: ngsoSat.noradId === r.noradId }" @mousedown.prevent="pickSearch(r)">
            <span class="rsp-li-n">
              {{ r.name }}
              <em v-if="r.custom" class="rsp-badge rsp-badge-cc">自定义</em>
              <em v-else-if="r.groupLabel" class="rsp-badge">{{ r.groupLabel }}</em>
              <em v-if="r._regime && r._regime !== 'LEO'" class="rsp-badge" :class="'rsp-rg-' + r._regime">{{ r._regime }}</em>
            </span>
            <span class="rsp-li-i">
              {{ r.custom ? '合成' : 'NORAD' }} {{ r.noradId }} · i={{ (+r.incl).toFixed(1) }}° ·
              <template v-if="(+r.ecc) >= 0.01">近{{ Math.round(r.perigeeKm) }}/远{{ Math.round(r.apogeeKm) }}km</template>
              <template v-else>h≈{{ Math.round(r.perigeeKm) }}km</template>
            </span>
          </li>
        </ul>
      </template>
    </div>

    <!-- 当前选星摘要 -->
    <div v-if="satSelected" class="rsp-sel">
      <div>已选卫星：<b class="rsp-name" title="可框选复制此卫星名">{{ ngsoSat.name || form.satelliteName }}</b>
        <span v-if="ngsoSat.noradId">（NORAD {{ ngsoSat.noradId }}）</span> · 轨道高度/倾角已由所选卫星自动确定
      </div>
      <div v-if="orbitShape" class="rsp-shape">
        <b class="rsp-regime" :class="'rsp-rg-' + orbitShape.regime" :title="orbitShape.regimeZh">{{ orbitShape.regime }}</b>
        <template v-if="orbitShape.elliptical">
          · 近 {{ fmtKm(orbitShape.perigeeKm) }} · 远 {{ fmtKm(orbitShape.apogeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
        </template>
        <template v-else>· 圆轨道 ≈ {{ fmtKm(orbitShape.perigeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min</template>
      </div>
    </div>

    <!-- 卫星参数表单（选星后轨道高度/倾角只读「自动」）-->
    <div class="form">
      <div v-for="(row, ri) in rows" :key="ri" class="rsp-row2" :class="{ pair: row.length === 2 }">
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
.rsp { max-width: 520px; }
.rsp-modes { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.rsp-seg { font-size: 12px; padding: 4px 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.rsp-seg.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.rsp-flex { flex: 1; }
.rsp-clear { font-size: 11px; padding: 3px 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); border-radius: 3px; cursor: pointer; }
.rsp-grd { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed var(--border); }
.rsp-grd .pf { margin-bottom: 6px; }
.rsp-tip { font-size: 11px; color: var(--text-faint); line-height: 1.5; margin-top: 2px; }
.rsp-err { color: var(--danger); }
.rsp-list { list-style: none; margin: 4px 0; padding: 0; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 3px; }
.rsp-list li { padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--border); }
.rsp-list li:last-child { border-bottom: none; }
.rsp-list li:hover { background: var(--surface); }
.rsp-list li.on { background: var(--surface-2); }
.rsp-li-n { display: block; font-size: 12px; color: var(--text); }
.rsp-li-i { display: block; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.rsp-badge { display: inline-block; font-size: 9px; font-style: normal; padding: 0 5px; margin-left: 5px; border-radius: 8px; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); vertical-align: middle; }
.rsp-badge-cc { background: var(--accent); color: #fff; border-color: var(--accent); }
/* 轨道区制徽标配色（列表）：GEO 绿 / IGSO 青 / MEO 蓝 / HEO 琥珀（LEO 不显示徽标） */
.rsp-badge.rsp-rg-GEO { background: #16a34a1a; color: #16a34a; border-color: #16a34a55; }
.rsp-badge.rsp-rg-IGSO { background: #0d94881a; color: #0d9488; border-color: #0d948855; }
.rsp-badge.rsp-rg-MEO { background: #2563eb1a; color: #2563eb; border-color: #2563eb55; }
.rsp-badge.rsp-rg-HEO { background: #f59f0022; color: #d98600; border-color: #f59f0055; }
.rsp-sel { font-size: 11px; color: var(--text-muted); background: var(--surface); border-radius: 3px; padding: 6px 8px; margin-bottom: 10px; }
/* 卫星名可框选复制（覆盖全局 user-select:none），文本光标作可选的提示 —— 方便用户复制去改名 */
.rsp-name { user-select: text; -webkit-user-select: text; cursor: text; }
.rsp-shape { margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--border); }
/* 轨道区制标签（选星摘要）配色 */
.rsp-regime { font-weight: 700; }
.rsp-regime.rsp-rg-GEO { color: #16a34a; }
.rsp-regime.rsp-rg-IGSO { color: #0d9488; }
.rsp-regime.rsp-rg-MEO { color: #2563eb; }
.rsp-regime.rsp-rg-LEO { color: var(--text-muted); }
.rsp-regime.rsp-rg-HEO { color: #d98600; }
.rsp-row2 { margin-bottom: 6px; }
.rsp-row2.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.rsp-row2 .pf { margin-bottom: 0; }
.rsp-row2.pair .pf { grid-template-columns: 96px 110px 30px; }
.pf { display: grid; grid-template-columns: 96px 110px 36px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 2px; }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-i.auto { background: var(--surface); color: var(--text-muted); cursor: not-allowed; }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }
</style>
