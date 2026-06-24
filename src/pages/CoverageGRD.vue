<script setup>
// 覆盖图（GRD）：导入 GRD 原始场 → WGS84 投影 → 面(heatmap)+线(等值线) 实时渲染。
// 计算核心 src/viz/grd/{parse,coverage,colormap}.js（已对照 SATSOFT 验证）。
// 复用 3D(scene.js)/2D(flatCoverage.js) 渲染器，view.flat 切换。性能分层见设计文档 §4。
import { ref, reactive, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { cursor } from '../stores/cursor'
import { view } from '../stores/view'
import { createGlobeScene } from '../viz/globe3d/scene.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
import { antennaBasis, projectGrid, fieldDb, contourLines, relLevels } from '../viz/grd/coverage.js'
import { fieldRgba, colorAt, SCHEME_NAMES } from '../viz/grd/colormap.js'

const mapEl = ref(null)       // 3D 容器
const flatCanvas = ref(null)  // 2D 画布
let scene = null, flat = null

const sats = ref([])          // [{folder,satName,lon,beams:[...]}]
const activeFolder = ref('')
const activeKey = ref('')     // beam+type 唯一键
const loading = ref(false)
let beam = null               // 当前波束 { meta, P1:Float32, P2:Float32, proj }

const s = reactive({
  scheme: 'turbo', fill: true, alpha: 0.82,
  line: true, lineWidth: 1.4,
  ctype: 'rel',                       // 'rel' 相对峰值 | 'abs' 绝对
  relText: '-1,-2,-3,-4,-5', absText: '48,50,52,54',
  range: 12,                          // 填充动态范围 dB（域 = [peak-range, peak]）
  gainOffset: 0, pol: 'P1', pathLoss: 'none',
  boreLon: null, boreLat: 0, yaw: 0   // 指向（默认星下点；boreLon=null → satLon）
})

const beamList = () => { const sat = sats.value.find((x) => x.folder === activeFolder.value); return sat ? sat.beams : [] }
const keyOf = (b) => `${b.beam}_${b.type}`
const parseNums = (t) => String(t).split(/[,\s]+/).map(Number).filter((v) => v === v)
const toF32 = (a) => Float32Array.from(a, (v) => (v == null ? NaN : v))

async function loadIndex() {
  try {
    const idx = await window.api.coverageGrd.index()
    sats.value = (idx && idx.satellites) || []
    if (sats.value.length) { activeFolder.value = sats.value[0].folder; const b = beamList()[0]; if (b) await selectBeam(b) }
  } catch (e) { console.error('coverageGrd index 失败', e) }
}

async function selectBeam(b) {
  activeKey.value = keyOf(b)
  loading.value = true
  try {
    const raw = await window.api.coverageGrd.get(b.file)
    beam = {
      meta: raw.meta,
      P1: toF32(raw.P1), P2: toF32(raw.P2),
      proj: { lon: toF32(raw.lon), lat: toF32(raw.lat), slant: toF32(raw.slant), NX: raw.meta.grid.NX, NY: raw.meta.grid.NY }
    }
    s.boreLon = beam.meta.antenna.boreLon
    s.boreLat = beam.meta.antenna.boreLat
    recompute(true)
    const pk = beam.meta.peak
    if (pk && scene) scene.faceLonLat(pk[0], pk[1])
  } finally { loading.value = false }
}

// L0：指向变化时重新投影（贵，仅此时）。
function reproject() {
  if (!beam) return
  const m = beam.meta
  const basis = antennaBasis(m.satLon, s.boreLon == null ? m.satLon : s.boreLon, s.boreLat, s.yaw)
  beam.proj = projectGrid(m.grid, m.igrid, basis)
}

// L1+L2：场标量 → 面(rgba) + 线(等值线)，喂渲染器。
function recompute(refit) {
  if (!beam) return
  const setLike = { P1: beam.P1, P2: beam.P2, NX: beam.proj.NX, NY: beam.proj.NY }
  const field = fieldDb(setLike, beam.proj, { pol: s.pol, gainOffset: s.gainOffset, pathLoss: s.pathLoss })
  const hi = field.max, lo = field.max - s.range

  // 面（L2a）
  if (s.fill) {
    const rgba = fieldRgba(field.db, lo, hi, s.scheme, lo)
    const f = { lon: beam.proj.lon, lat: beam.proj.lat, NX: beam.proj.NX, NY: beam.proj.NY, rgba }
    if (flat) { flat.setField(f); flat.setFieldAlpha(s.alpha) }
    if (scene) scene.setCoverageField(f, s.alpha)
  } else { if (flat) flat.setField(null); if (scene) scene.clearCoverageField() }

  // 线（L2b）
  if (s.line) {
    const levels = s.ctype === 'rel' ? relLevels(field.max, parseNums(s.relText)) : parseNums(s.absText)
    const cs = contourLines(field, beam.proj, levels)
    const lines = []
    for (const c of cs) {
      const col = colorAt(c.g, lo, hi, s.scheme)
      for (const seg of c.segs) lines.push({ p: seg, color: col, width: s.lineWidth, closed: false })
    }
    const geom = { lines, dots: [], labels: [] }
    if (flat) flat.setGeom(geom)
    if (scene) scene.setCoverage({ lines, dots: [], labels: [], sats: [], bores: [] })
  } else {
    if (flat) flat.setGeom({ lines: [] })
    if (scene) scene.setCoverage(null)
  }
}

// 2D/3D 切换：按需创建 2D 渲染器并喂当前数据
function applyFlat(v) {
  nextTick(() => {
    if (v && !flat && flatCanvas.value) {
      flat = createFlatCoverage(flatCanvas.value)
      flat.setOnHover((ll) => { cursor.ll = ll })
      flat.setNameMode('zh')
    }
    if (v && flat) flat.resize()
    if (scene) scene.resize()
    recompute()
  })
}

let ro = null
onMounted(async () => {
  scene = createGlobeScene(mapEl.value)
  scene.setLabelMode('zh')
  scene.setOnHover((ll) => { cursor.ll = ll })
  if (view.flat) applyFlat(true)
  ro = new ResizeObserver(() => { if (scene) scene.resize(); if (flat) flat.resize() })
  if (mapEl.value && mapEl.value.parentElement) ro.observe(mapEl.value.parentElement)
  await loadIndex()
})
onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  if (scene) scene.destroy()
  if (flat) flat.destroy()
})

watch(() => view.flat, (v) => applyFlat(v))
// 显示层设置（便宜）→ 仅 recompute
watch(() => [s.scheme, s.fill, s.alpha, s.line, s.lineWidth, s.ctype, s.relText, s.absText, s.range, s.gainOffset, s.pol, s.pathLoss], () => recompute())
// 指向（贵）→ reproject + recompute
watch(() => [s.boreLon, s.boreLat, s.yaw], () => { reproject(); recompute() })
</script>

<template>
  <div class="grd">
    <div class="maparea">
      <div ref="mapEl" class="globe" v-show="!view.flat"></div>
      <canvas ref="flatCanvas" class="flat" v-show="view.flat"></canvas>
    </div>

    <aside class="panel">
      <div class="sec">
        <div class="title">覆盖图（GRD）</div>
        <label class="row"><span>卫星</span>
          <select v-model="activeFolder">
            <option v-for="x in sats" :key="x.folder" :value="x.folder">{{ x.folder }} · {{ x.lon }}°E</option>
          </select>
        </label>
        <div class="beams">
          <button v-for="b in beamList()" :key="keyOf(b)" class="beam" :class="{ on: activeKey === keyOf(b) }" @click="selectBeam(b)">
            <span class="bn">{{ b.beam }}</span><span class="bt" :class="b.type">{{ b.type }}</span>
            <span class="bp">{{ b.peakDb }}dB</span>
          </button>
        </div>
        <div v-if="beam" class="meta">峰值 {{ beam.meta.peakDb }} dB @ {{ beam.meta.peak[0] }}, {{ beam.meta.peak[1] }} · igrid{{ beam.meta.igrid }} · {{ beam.meta.grid.NX }}×{{ beam.meta.grid.NY }}</div>
      </div>

      <div class="sec">
        <div class="title">填充面</div>
        <label class="row"><span>显示</span><input type="checkbox" v-model="s.fill" /></label>
        <label class="row"><span>配色</span><select v-model="s.scheme"><option v-for="n in SCHEME_NAMES" :key="n" :value="n">{{ n }}</option></select></label>
        <label class="row"><span>透明度</span><input type="range" min="0.2" max="1" step="0.02" v-model.number="s.alpha" /><b>{{ s.alpha.toFixed(2) }}</b></label>
        <label class="row"><span>动态范围</span><input type="range" min="3" max="25" step="1" v-model.number="s.range" /><b>{{ s.range }}dB</b></label>
      </div>

      <div class="sec">
        <div class="title">等值线</div>
        <label class="row"><span>显示</span><input type="checkbox" v-model="s.line" /></label>
        <label class="row"><span>类型</span>
          <select v-model="s.ctype"><option value="rel">相对峰值</option><option value="abs">绝对值</option></select>
        </label>
        <label class="row" v-if="s.ctype === 'rel'"><span>电平(dB)</span><input v-model="s.relText" /></label>
        <label class="row" v-else><span>电平(dB)</span><input v-model="s.absText" /></label>
        <label class="row"><span>线宽</span><input type="range" min="0.5" max="3" step="0.1" v-model.number="s.lineWidth" /><b>{{ s.lineWidth.toFixed(1) }}</b></label>
      </div>

      <div class="sec">
        <div class="title">参数</div>
        <label class="row"><span>增益偏置</span><input type="number" step="0.5" v-model.number="s.gainOffset" /><b>dB</b></label>
        <label class="row"><span>极化</span><select v-model="s.pol"><option>P1</option><option>P2</option><option>RSS</option><option>P1/P2</option><option>P2/P1</option></select></label>
        <label class="row"><span>路径损耗</span><select v-model="s.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></label>
      </div>

      <div class="sec">
        <div class="title">指向（默认星下点）</div>
        <label class="row"><span>boresight 经</span><input type="number" step="0.5" v-model.number="s.boreLon" /></label>
        <label class="row"><span>boresight 纬</span><input type="number" step="0.5" v-model.number="s.boreLat" /></label>
        <label class="row"><span>yaw</span><input type="number" step="1" v-model.number="s.yaw" /></label>
        <div class="meta">改指向触发重投影(L0)。星下点 = {{ beam ? beam.meta.satLon : '-' }}°E</div>
      </div>
      <div v-if="loading" class="loading">载入中…</div>
    </aside>
  </div>
</template>

<style scoped>
.grd { display: flex; height: 100%; min-height: 0; }
.maparea { flex: 1; min-width: 0; position: relative; background: #070b12; }
.globe, .flat { position: absolute; inset: 0; width: 100%; height: 100%; }
.panel { width: 290px; flex: none; overflow-y: auto; background: var(--surface); border-left: 1px solid var(--border); padding: 6px 0; }
.sec { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.title { font-family: var(--font-serif); font-size: 13px; color: var(--text); margin-bottom: 7px; }
.row { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12px; color: var(--text-muted); }
.row > span { width: 78px; flex: none; }
.row > b { width: 40px; text-align: right; font-family: var(--font-mono); color: var(--text); font-weight: 500; }
.row input[type=range] { flex: 1; }
.row input[type=number], .row input:not([type]), .row select { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 2px 6px; font-size: 12px; border-radius: 2px; }
.beams { display: flex; flex-direction: column; gap: 3px; margin-top: 6px; }
.beam { display: flex; align-items: center; gap: 6px; padding: 4px 7px; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); cursor: pointer; border-radius: 2px; font-size: 12px; }
.beam:hover { color: var(--text); border-color: var(--accent); }
.beam.on { color: var(--text); border-color: var(--accent); background: var(--surface); }
.beam .bn { flex: 1; text-align: left; }
.beam .bt { font-size: 10px; padding: 0 4px; border-radius: 2px; border: 1px solid var(--border); }
.beam .bt.EIRP { color: #f1b829; } .beam .bt.GT { color: #5dcaa5; }
.beam .bp { font-family: var(--font-mono); color: var(--text-faint); font-size: 11px; }
.meta { font-size: 11px; color: var(--text-faint); margin-top: 6px; line-height: 1.5; }
.loading { padding: 8px 12px; color: var(--accent); font-size: 12px; }
</style>
