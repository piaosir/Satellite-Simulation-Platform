<script setup>
// 端到端窗口的卫星库编辑器（一份条目 = 一颗星）。
//
// 与 NGSO / 再生式两窗同一套「取星」范式，差别只在这里先分 GSO / NGSO：
//   · GSO —— 静止星，一个定点经度就把几何定死（自动几何按站址与它算斜距 / 仰角）；
//   · NGSO —— 两条路：手填轨道高度 + 倾角（闭式最差几何），或从【卫星/天线树】【星历搜索】
//     选一颗真星取其真实轨道根数（SGP4/SDP4 走单一典型时刻互视几何）。搜索池 = CelesTrak
//     active 全域 ∪ 常用名组 ∪ 本地自定义卫星库 ∪ 本地自定义星座（见 ngso/satSearchPool.js），
//     故「全量、含自定义」是同一份池子保证的，不在本窗口另建一份。
// 选星只定【轨道】：卫星 EIRP / G·T / 转发器参数一律手填（平台既定，方向图自动取值已否决）。
// 其余参数分组交给 E2eFields 渲染，保持本窗口检查器/资源库同一套密排读数行。
import { computed, ref, watch } from 'vue'
import E2eFields from './E2eFields.vue'
import { ensureSearchPool, findPoolByNorad } from '../ngso/satSearchPool.js'
import { classifyOrbit, orbitRegimeLabel } from '../shared/orbitClass.js'
import { fmtGeoSlot, geoSlotOfOmm } from '../shared/geoSlot.js'
import {
  SAT_ID_FIELDS, SAT_ORBIT_FIELDS, SAT_TXP_FIELDS, SAT_REGEN_FIELDS,
  SAT_INTF_UP_FIELDS, SAT_INTF_DN_FIELDS
} from './e2eParams.js'

const props = defineProps({
  form: { type: Object, required: true },        // 卫星条目参数
  ngsoSat: { type: Object, required: true },     // { mode:'manual'|'tree'|'search', orbit, name, noradId, folder }
  satTree: { type: Array, default: () => [] }    // 卫星树（星座3D 页导入的卫星，作轨道来源）
})

const isGso = computed(() => (props.form.orbitClass || 'GSO') === 'GSO')
const satSelected = computed(() => props.ngsoSat.mode !== 'manual' && !!props.ngsoSat.orbit)
// 轨道字段按类型挑：GSO 只留定点经度，NGSO 留高度 / 倾角（选星后这两项只读「自动」）
const orbitFields = computed(() => SAT_ORBIT_FIELDS.filter((f) => (
  f.key === 'orbitClass' ? false : (isGso.value ? f.key === 'orbitLongitude' : f.key !== 'orbitLongitude')
)))

function setOrbitClass(v) {
  if (props.form.orbitClass === v) return
  props.form.orbitClass = v
  if (v === 'GSO') onClear()      // 转回 GSO：放开选星（静止星几何只认定点经度）
}

// —— 取星模式：卫星/天线树 / 星历搜索（仅切「看哪个选星器」，不动已选卫星）——
const mode = ref(props.ngsoSat.mode === 'tree' ? 'tree' : 'search')
function switchMode(m) { if (mode.value !== m) mode.value = m }
watch(() => props.ngsoSat && props.ngsoSat.mode, (m) => { if (m === 'search' || m === 'tree') mode.value = m })
function onClear() {
  const ns = props.ngsoSat
  ns.mode = 'manual'; ns.orbit = null; ns.name = ''; ns.noradId = null; ns.folder = ''
}

const _MU = 398600.4418, _RE = 6378.137
function altFromMeanMotion(revDay) {
  const n = (Number(revDay) || 0) * 2 * Math.PI / 86400
  return n > 0 ? Math.cbrt(_MU / (n * n)) - _RE : null
}
// 选星后回显轨道高度 / 倾角（只读「自动」）
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

// —— ① 卫星/天线树选星（与 NGSO / 再生式同口径：按 NORAD 到同一份搜索池反解真实轨道）——
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
    return { type: 'unresolved', noradId: node.noradId, reason: `关联星（NORAD ${node.noradId}）暂未在星历库解析到轨道（可能离线或本地缓存缺失）。请联网后在「从星历搜索」按 NORAD 重选，或改用手动轨道高度+倾角。` }
  }
  if (node.omm && node.omm.meanMotion) return Object.assign({ type: 'omm' }, node.omm)
  const el = node.elements
  if (el && el.altKm != null) return { type: 'elements', altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, epoch: node.epoch || null, noradId: node.noradId }
  if ((kind === 'preset' || kind === 'custom' || !kind) && node.altKm != null) return { type: 'snapshot', lonDeg: Number(node.lon) || 0, latDeg: Number(node.lat) || 0, altKm: Number(node.altKm) || 0, noradId: node.noradId }
  return { type: 'unresolved', noradId: node.noradId, reason: `卫星「${node.satName || node.folder}」缺少可用轨道根数。请在「星座3D」页为其补充轨道根数，或改用手动轨道高度+倾角。` }
}
async function onPickTree() {
  const node = curNode.value
  if (!node) { onClear(); return }
  const ns = props.ngsoSat
  ns.mode = 'tree'; ns.name = node.satName; ns.noradId = node.noradId || null; ns.folder = node.folder
  props.form.satelliteName = node.satName
  ns.orbit = await treeNodeOrbit(node)
  applyOrbitToForm(ns.orbit)
}

// —— ② 星历搜索（全量：CelesTrak active ∪ 常用名组 ∪ 自定义卫星 ∪ 自定义星座）——
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
    loadErr.value = '卫星星历加载失败：' + ((e && e.message) || e) + '（需联网获取 CelesTrak OMM）'
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
  return out.map((s) => ({ ...s, _regime: regimeOf(s), _slot: geoSlotOfOmm(s) }))   // _slot=GEO 定点标注（缓存在池记录上；'elements' 型自然为空）
})
function onSearchFocus() { ensurePool(); listOpen.value = true }
function onSearchBlur() { setTimeout(() => { listOpen.value = false }, 150) }
function pickSearch(rec) {
  const ns = props.ngsoSat
  ns.mode = 'search'; ns.name = rec.name; ns.noradId = rec.noradId || null; ns.folder = ''
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    ns.orbit = { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
  } else {
    ns.orbit = { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
  }
  props.form.satelliteName = rec.name
  applyOrbitToForm(ns.orbit)
  kw.value = rec.name; listOpen.value = false
}

// 选中星的轨道形状与区制（近/远地点、偏心率、周期；判定见 shared/orbitClass.js）
const orbitShape = computed(() => {
  const o = props.ngsoSat && props.ngsoSat.orbit
  if (!o) return null
  let a = null, e = 0
  if (o.type === 'elements') { e = Math.max(0, Math.min(0.999, Number(o.ecc) || 0)); a = (_RE + (Number(o.altKm) || 0)) / (1 - e) }
  else if (o.type === 'omm') { e = Number(o.ecc) || 0; const n = (Number(o.meanMotion) || 0) * 2 * Math.PI / 86400; a = n > 0 ? Math.cbrt(_MU / (n * n)) : null }
  else return null
  if (!a) return null
  const periodMin = (2 * Math.PI) / (Math.sqrt(_MU / (a * a * a)) * 60)
  const perigeeKm = a * (1 - e) - _RE, apogeeKm = a * (1 + e) - _RE
  const regime = classifyOrbit({ aKm: a, e, inclDeg: Number(o.incl) || 0, perigeeAltKm: perigeeKm, apogeeAltKm: apogeeKm, periodMin })
  return { apogeeKm, perigeeKm, ecc: e, periodMin, elliptical: e >= 0.01, regime, regimeZh: orbitRegimeLabel(regime) }
})
function regimeOf(r) {
  const mm = Number(r.meanMotion) || 0
  return classifyOrbit({ e: Number(r.ecc) || 0, inclDeg: Number(r.incl) || 0, perigeeAltKm: Number(r.perigeeKm), apogeeAltKm: Number(r.apogeeKm), periodMin: mm > 0 ? 1440 / mm : NaN })
}
const fmtKm = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))
// 卫星树下拉的轨位标注：°E/°W 折算（西经不再写成负°E）；lon 缺失/为 0（Number(null)=0 陷阱）不标
const treeSlot = (s) => { const v = Number(s && s.lon); return Number.isFinite(v) && v !== 0 ? fmtGeoSlot(v) : '' }
// 选星后轨道高度/倾角只读（值由所选卫星轨道确定）
const roKeys = computed(() => (satSelected.value ? ['orbitAltitude', 'orbitInclination'] : []))
const unresolved = computed(() => {
  const o = props.ngsoSat && props.ngsoSat.orbit
  return (o && o.type === 'unresolved') ? (o.reason || '所选卫星轨道未能解析') : ''
})
</script>

<template>
  <div class="esp">
    <E2eFields :fields="SAT_ID_FIELDS" :form="form" />

    <!-- 轨道 -->
    <div class="esp-sub">轨道</div>
    <div class="esp-seg">
      <button class="esp-segb" :class="{ on: isGso }" title="地球静止轨道：定点经度即可定几何" @click="setOrbitClass('GSO')">GSO</button>
      <button class="esp-segb" :class="{ on: !isGso }" title="非静止轨道：手填轨道高度/倾角，或从星历搜索一颗真星" @click="setOrbitClass('NGSO')">NGSO</button>
    </div>
    <E2eFields :fields="orbitFields" :form="form" :readonly-keys="roKeys" />

    <!-- NGSO 取星器 -->
    <template v-if="!isGso">
      <div class="esp-modes">
        <button class="esp-tab" :class="{ on: mode === 'search' }" @click="switchMode('search')">从星历搜索</button>
        <button class="esp-tab" :class="{ on: mode === 'tree' }" @click="switchMode('tree')">卫星/天线树</button>
        <span class="esp-flex"></span>
        <button v-if="satSelected" class="esp-clear" title="取消选星，恢复手填轨道高度/倾角" @click="onClear">✕ 取消选星</button>
      </div>

      <div v-if="mode === 'search'" class="esp-pick">
        <input v-model="kw" class="esp-in" placeholder="名称 / NORAD 号，如 STARLINK / 44713"
               @focus="onSearchFocus" @click="listOpen = true" @input="listOpen = true" @blur="onSearchBlur" />
        <div v-if="loading" class="esp-tip">正在加载星历…</div>
        <div v-else-if="loadErr" class="esp-tip esp-err">{{ loadErr }}</div>
        <template v-else-if="listOpen">
          <div v-if="kw && !searchRes.length" class="esp-tip">无匹配卫星</div>
          <ul v-else-if="searchRes.length" class="esp-list">
            <li v-for="r in searchRes" :key="r.noradId" :class="{ on: ngsoSat.noradId === r.noradId }" @mousedown.prevent="pickSearch(r)">
              <span class="esp-li-n" data-i18n-skip>
                {{ r.name }}
                <em v-if="r.custom" class="esp-badge esp-badge-cc">自定义</em>
                <em v-else-if="r.groupLabel" class="esp-badge">{{ r.groupLabel }}</em>
                <em v-if="r._regime && r._regime !== 'LEO'" class="esp-badge" :class="'esp-rg-' + r._regime">{{ r._slot ? r._regime + ' ' + r._slot : r._regime }}</em>
              </span>
              <span class="esp-li-i">
                {{ r.custom ? '合成' : 'NORAD' }} {{ r.noradId }} · i={{ (+r.incl).toFixed(1) }}° ·
                <template v-if="(+r.ecc) >= 0.01">近{{ Math.round(r.perigeeKm) }}/远{{ Math.round(r.apogeeKm) }}km</template>
                <template v-else>h≈{{ Math.round(r.perigeeKm) }}km</template>
              </span>
            </li>
          </ul>
        </template>
      </div>

      <div v-else class="esp-pick">
        <select v-model="ngsoSat.folder" class="esp-in" @change="onPickTree">
          <option value="" disabled>从卫星树选择…</option>
          <option v-for="s in satTree" :key="s.folder" :value="s.folder">{{ s.satName }}<template v-if="treeSlot(s)">（{{ treeSlot(s) }}）</template></option>
        </select>
        <div v-if="!satTree.length" class="esp-tip">卫星树为空。</div>
      </div>

      <div v-if="satSelected" class="esp-sel">
        <div>已选卫星：<b class="esp-name" data-i18n-skip>{{ ngsoSat.name || form.satelliteName }}</b>
          <span v-if="ngsoSat.noradId">（NORAD {{ ngsoSat.noradId }}）</span>
        </div>
        <div v-if="orbitShape" class="esp-shape">
          <b class="esp-regime" :class="'esp-rg-' + orbitShape.regime" :title="orbitShape.regimeZh">{{ orbitShape.regime }}</b>
          <template v-if="orbitShape.elliptical">
            · 近地点 {{ fmtKm(orbitShape.perigeeKm) }} km · 远地点 {{ fmtKm(orbitShape.apogeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
          </template>
          <template v-else>
            · 圆轨道高度 ≈ {{ fmtKm(orbitShape.perigeeKm) }} km · e={{ orbitShape.ecc.toFixed(3) }} · 周期 {{ orbitShape.periodMin.toFixed(0) }} min
          </template>
        </div>
        <div v-if="unresolved" class="esp-tip esp-err">{{ unresolved }}</div>
      </div>
    </template>

    <div class="esp-sub">接收与转发器</div>
    <E2eFields :fields="SAT_TXP_FIELDS" :form="form" />
    <div class="esp-sub">再生载荷</div>
    <E2eFields :fields="SAT_REGEN_FIELDS.filter((f) => f.grp === 'regen')" :form="form" />
    <div class="esp-sub">干扰</div>
    <E2eFields :fields="[...SAT_INTF_UP_FIELDS, ...SAT_INTF_DN_FIELDS]" :form="form" />
  </div>
</template>

<style scoped>
.esp { display: flex; flex-direction: column; }
.esp-sub { margin: 9px 0 3px; padding-bottom: 2px; font-size: 11.5px; letter-spacing: var(--ls-label); color: var(--text-muted); border-bottom: 1px solid var(--lb-rule); }
.esp-seg { display: flex; gap: 0; margin: 4px 0 6px; }
.esp-segb {
  font: inherit; font-size: 11.5px; line-height: 1; padding: 4px 14px; cursor: pointer;
  background: var(--bg); color: var(--text-muted); border: 1px solid var(--border);
}
.esp-segb:first-child { border-radius: var(--r-ctl, 2px) 0 0 var(--r-ctl, 2px); }
.esp-segb:last-child { border-radius: 0 var(--r-ctl, 2px) var(--r-ctl, 2px) 0; border-left: none; }
.esp-segb.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.esp-modes { display: flex; align-items: center; gap: 6px; margin: 8px 0 5px; }
.esp-tab {
  font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer;
  background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.esp-tab.on { color: var(--text); border-color: var(--accent); }
.esp-flex { flex: 1; }
.esp-clear { font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.esp-pick { margin-bottom: 4px; }
.esp-in {
  width: 100%; font: inherit; font-size: 11.5px; padding: 3px 6px;
  color: var(--text); background-color: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.esp-in:focus { outline: none; border-color: var(--accent); }
.esp-tip { font-size: 11px; color: var(--text-muted); line-height: 1.5; margin-top: 3px; }
.esp-err { color: var(--danger); }
.esp-list { list-style: none; margin: 4px 0 0; padding: 0; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.esp-list li { padding: 4px 7px; cursor: pointer; border-bottom: 1px solid var(--lb-rule-soft); }
.esp-list li:last-child { border-bottom: none; }
.esp-list li:hover { background: var(--surface); }
.esp-list li.on { background: var(--surface-2); }
.esp-li-n { display: block; font-size: 11.5px; color: var(--text); }
.esp-li-i { display: block; font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); }
.esp-badge { display: inline-block; font-size: 9px; font-style: normal; padding: 0 5px; margin-left: 5px; border-radius: var(--r-pill); background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); vertical-align: middle; }
.esp-badge-cc { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.esp-badge.esp-rg-GEO { background: #16a34a1a; color: #16a34a; border-color: #16a34a55; }
.esp-badge.esp-rg-IGSO { background: #0d94881a; color: #0d9488; border-color: #0d948855; }
.esp-badge.esp-rg-MEO { background: #2563eb1a; color: #2563eb; border-color: #2563eb55; }
.esp-badge.esp-rg-HEO { background: #f59f0022; color: #d98600; border-color: #f59f0055; }
.esp-sel { font-size: 11px; color: var(--text-muted); background: var(--surface); border-radius: var(--r-ctl, 2px); padding: 5px 7px; margin: 4px 0 2px; }
.esp-name { user-select: text; -webkit-user-select: text; cursor: text; color: var(--text); }
.esp-shape { margin-top: 3px; padding-top: 3px; border-top: 1px dashed var(--border); }
.esp-regime { font-weight: 700; }
.esp-regime.esp-rg-GEO { color: #16a34a; }
.esp-regime.esp-rg-IGSO { color: #0d9488; }
.esp-regime.esp-rg-MEO { color: #2563eb; }
.esp-regime.esp-rg-LEO { color: var(--text-muted); }
.esp-regime.esp-rg-HEO { color: #d98600; }
</style>
