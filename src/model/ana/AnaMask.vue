<script setup>
// 分析 › 本体遮挡掩模（任务书 §6.4、DESIGN2 §2 / D2 / D3 / D18）：当前模型 × 选中挂点，360 × 181 条射线（本体系方向，起点 = 挂点 + 1 cm·视轴），
// 命中星体即遮挡、记最近命中距离（净空）。射线核在 bodyMask.worker.js（Worker 池，three-mesh-bvh）；角坐标与编解码唯一实现在 mask.mjs。
//   · 关节滑杆：掩模按「当前关节值」算（缺省 = 初值），滑杆同时驱动预览；签名含关节值（D3）。关节值存在 satStore（预览红色球面片、
//     万向节查掩模按同一份判签名）：拖了滑杆，这一位姿没算过的掩模就不显示，拖回来又认。
//   · 读数 / 预览只认「期望签名 = 当前输入」的掩模（satStore.maskOf）；算的途中换星 / 换模型 / 挪挂点 / 拖关节，算完的结果对不上就丢，
//     不写进别的星、别的位姿的挂点。
//   · 对日扫描（D3）：有单轴对日太阳翼时可勾，按太阳在本体系的方位量化 12 档各算一张（档 k = 翼转 k·30°），
//     落盘为 mount.maskSun = {sigs:[12], axisBody, pointingBody}，查表端（bodyRuntime）按当时太阳角取最近档。
//   · 结果 encodeMask → models.saveMask 落 userData/models/masks/<sig>.bin，mount.maskSig 写回绑定（D18）；
//     预览里画红色球面片（2 × 包围半径），「天线视角」把相机放到挂点上沿视轴看（本体半透明红，掩模边界黄线）。
// 结果区只出数字：遮挡立体角比例、最小净空、耗时（CLAUDE.md）。遮挡不接入可见性 / 对星 / 星间链路（2026-09-24 用户叫停），只在工作台里算、看、存、导出。
import { ref, computed, inject, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import ChartBox from './ChartBox.vue'
import { createBodyMaskPool, bodyGeometryFromIR } from '../../viz/models/bodyMaskPool.js'
import { threeToIR } from '../../viz/models/irToThree.js'
import { MASK_CHART_CALIBER, coneOutline } from '../../viz/models/maskChart.js'
import { maskStats, encodeMask, maskToCsv, sunScanAngleDeg, SUN_SCAN_BINS } from '@core/models/mask.mjs'
import { articulationSunAngle, rotateAboutAxis } from '@core/models/attitude.mjs'
import { panelsFromMeta } from '@core/models/power.mjs'
import { coneHalfOf, fovFullOf, maskSigFor, maskExcludeOf } from '../mountLogic.js'
import { stateFn } from '../satSources.js'
import { fmtNum } from '../wbLogic.js'

const wb = inject('wb')
const sat = inject('sat')
const ana = inject('ana')
const satView = inject('satView')
const getVp = inject('viewport')
const S = sat.st
const { cur } = wb
const api = typeof window !== 'undefined' ? window.api : null
const mnt = sat.selMount
const R2D = 180 / Math.PI
const plain = (v) => JSON.parse(JSON.stringify(v))

let pool = null
onMounted(() => { pool = createBodyMaskPool() })
onBeforeUnmount(() => { if (ctrl) ctrl.abort(); if (pool) pool.dispose(); pool = null })

// ── 关节滑杆（掩模按这组关节值算；同时驱动预览）──
const arts = computed(() => { void cur.rev; return cur.meta && Array.isArray(cur.meta.articulations) ? cur.meta.articulations.filter((a) => a && Array.isArray(a.stages) && a.stages.length) : [] })
const artVals = sat.art   // 关节名 → 各 stage 值（没动过的不在里面 = 初值）；satStore 持有、换模型清空
const valOf = (a, s, i) => { const v = artVals[a.name]; return v && Number.isFinite(v[i]) ? v[i] : (Number.isFinite(s.initialValue) ? s.initialValue : 0) }
const stepOf = (s) => (/Rotate$/.test(s.type) ? 1 : Math.max(1e-3, (s.maximumValue - s.minimumValue) / 200))
function onSlide(a, i, v) {
  const n = Number(v)
  const arr = a.stages.map((s, k) => valOf(a, s, k))
  arr[i] = n
  sat.setArt(a.name, arr)
  const vp = getVp(); if (vp) vp.setArticulation(a.name, arr)
}
function resetArts() { sat.resetArt(); const vp = getVp(); if (vp) vp.resetArticulations() }

// ── 对日扫描：单轴对日的太阳翼（power.panelsFromMeta 认出来的关节）──
const solar = computed(() => {
  void cur.rev
  if (!cur.meta) return []
  const { panels } = panelsFromMeta(JSON.parse(JSON.stringify(cur.meta)))
  const seen = new Map()
  for (const p of panels) {
    const a = p.articulation
    if (!a || !a.axisBody || seen.has(a.name)) continue
    const art = arts.value.find((x) => x.name === a.name)
    const si = art ? art.stages.findIndex((s) => /Rotate$/.test(s.type)) : -1
    if (si < 0) continue
    seen.set(a.name, { name: a.name, axis: a.axisBody, pointing: a.pointingBody || p.normalBody, lo: a.minDeg, hi: a.maxDeg, si })
  }
  return [...seen.values()]
})
const sunScan = ref(false)
watch(solar, (v) => { if (!v.length) sunScan.value = false })

// ── 计算 ──
const busy = ref(false), prog = ref(''), err = ref('')
let ctrl = null
const mode = ref('blocked')
const rec = computed(() => { void S.maskRev; void S.rev; return mnt.value ? sat.maskOf(mnt.value.id) : null })
const stats = computed(() => (rec.value ? (rec.value.stats || maskStats(rec.value.mask)) : null))
const PARAM_KINDS = ['tpl', 'param', 'gen']
/**
 * 本体几何的 IR（与关节值无关，一次算的对日扫描 13 张共用）：参数化件直接取生成器的 IR；glb 件把工作台的模型根（文件位姿，
 * 视口摆关节用的是它自己的克隆）摊成 IR。关节值由 bodyGeometryFromIR 按 AGI stage 叠上。
 */
function irOf() {
  const pr = wb.currentParam()
  if (pr && PARAM_KINDS.includes(cur.kind)) return pr.ir
  const root = wb.currentRoot()
  if (!root) throw new Error('未载入模型。')
  root.updateMatrixWorld(true)
  return threeToIR(root, { uv: false, normal: false })
}
async function saveMask(sig, mask) {
  const mm = api && api.models
  if (!mm || typeof mm.saveMask !== 'function') return false
  try { const r = await mm.saveMask({ sig, bytes: encodeMask(mask) }); return !!(r && r.ok) } catch { return false }
}
const saved = ref(null)   // true / false / null（没存过）
async function compute() {
  const m = mnt.value
  if (!m || !cur.meta || !pool) return
  if (ctrl) ctrl.abort()
  ctrl = new AbortController()
  const signal = ctrl.signal
  busy.value = true; err.value = ''; prog.value = ''; saved.value = null
  // 开算时的输入快照：模型（纯数据）· 关节值 · 挂点；签名按它算
  const model = { meta: wb.viewMeta(), kind: cur.kind, lod: cur.lod, id: cur.id }
  const meta = model.meta
  const sk = S.satKey, mid = m.id
  const state = sat.artState()
  const sig = maskSigFor(model, m, state, null)
  // 排除名单与签名同一份（maskExcludeOf：挂点排除节点 + 导入件自身反射面的三角形段）
  const mount = { posBody: m.posBody.slice(), dirBody: m.boresightBody.slice(), excludeNodes: maskExcludeOf(model, m) }
  // 算完（每个 await 之后）核对：还是这颗星、这个挂点仍在、当前输入的期望签名仍是开算时那个 —— 否则结果丢掉，不写进别的星 / 别的位姿
  const live = () => {
    if (S.satKey !== sk || signal.aborted) return false
    const x = sat.mounts.value.find((q) => q.id === mid)
    return !!x && sat.expectedSig(x) === sig
  }
  const t0 = performance.now()
  try {
    const ir = irOf()
    const geom = bodyGeometryFromIR(ir, { meta, articulationState: state })
    const res = await pool.compute(geom, mount, { signal })
    if (!live()) return
    const st = maskStats(res)
    const r0 = { sig, mask: res, originBody: res.origin, stats: st, ms: Math.round(res.stats.wallMs || (performance.now() - t0)), tris: geom.tris, rays: res.stats.rays, transient: true, stamp: Date.now() }
    sat.putMask(mid, r0)
    // 对日扫描：12 档
    let sun = null
    if (sunScan.value && solar.value.length) {
      const w0 = solar.value[0]
      const wings = solar.value.map((w) => ({ ...w, art: arts.value.find((a) => a.name === w.name) }))
      const sigs = []
      for (let k = 0; k < SUN_SCAN_BINS; k++) {
        prog.value = `${k + 1} / ${SUN_SCAN_BINS}`
        // 档 k：首翼转 k·30° 时它正对的太阳方向（本体系）；其余翼按同一个太阳各自求转角、夹到限位
        const sunB = rotateAboutAxis(w0.pointing, w0.axis, sunScanAngleDeg(k))
        const st2 = { ...state }
        for (const w of wings) {
          let ang = articulationSunAngle(w.pointing, w.axis, sunB)
          ang = Math.min(w.hi, Math.max(w.lo, ang))
          const arr = (state[w.name] || w.art.stages.map((s, i) => valOf(w.art, s, i))).slice(); arr[w.si] = ang
          st2[w.name] = arr
        }
        const g2 = bodyGeometryFromIR(ir, { meta, articulationState: st2 })
        const r2 = await pool.compute(g2, mount, { signal })
        if (!live()) return
        const s2 = maskSigFor(model, m, st2, k)
        sigs.push(s2)
        await saveMask(s2, r2)
      }
      sun = { sigs, axisBody: w0.axis.slice(), pointingBody: w0.pointing.slice() }
    }
    const ok = await saveMask(sig, res)
    if (!live()) return
    saved.value = ok
    // 落盘成功才写签名（查表端按签名取 .bin）；没落盘的结果照样留在本页缓存里（transient），预览与读数不受影响
    sat.putMask(mid, { ...r0, transient: !ok, totalMs: Math.round(performance.now() - t0), sunBins: sun ? sun.sigs.length : 0 })
    if (ok || sun) {
      sat.edit((b) => {
        const x = b.mounts.find((q) => q.id === mid)
        if (!x) return
        if (ok) x.maskSig = sig
        if (sun) x.maskSun = plain(sun); else delete x.maskSun
      }, { undo: false })
    }
    refreshEarthDisk()
  } catch (e) {
    if (e && e.name !== 'AbortError') err.value = (e && e.message) || String(e)
  } finally {
    // 被新一次「计算」顶掉的旧调用别把新的一次的忙状态清掉
    if (ctrl && ctrl.signal === signal) { busy.value = false; prog.value = ''; ctrl = null }
  }
}
function cancel() { if (ctrl) ctrl.abort() }
// 选中挂点有签名、缓存里没有时从主进程读回来：satStore 自己盯着（分析页没建出来时预览也要有）
// 换星 / 换挂点：在算的那一次作废（结果本来也对不上，早停省算力）
watch(() => [S.satKey, S.mountSel], () => { if (ctrl) ctrl.abort(); expMsg.value = ''; saved.value = null; err.value = '' })

// ── 图 ──
const earthDisk = ref(null)   // 对地律下地球盘的半角（°）与中心方向（本体 +Z）
async function earthDiskFor() {
  const law = S.binding && S.binding.attitude ? S.binding.attitude.law : 'nadir'
  if (law !== 'nadir' && law !== 'yawSteer') return null
  const orb = await sat.ensureOrbit()
  const s = orb ? stateFn(orb)(ana.win.t0) : null
  if (!s) return null
  const r = Math.hypot(...s.rEcef)
  return r > 6378.137 ? Math.asin(6378.137 / r) * R2D : null
}
// 地球盘虚线跟着输入走（不只在算完那一刻取一次）：换星 / 换挂点 / 改姿态律 / 轨道或时段变了都重取；
// 取的途中输入又变了，以最后一次为准
let diskSeq = 0
async function refreshEarthDisk() {
  const seq = ++diskSeq
  let v = null
  try { v = await earthDiskFor() } catch { v = null }
  if (seq === diskSeq) earthDisk.value = v
}
watch(() => [S.satKey, S.mountSel, S.binding && S.binding.attitude ? S.binding.attitude.law : '', S.orbitRev, ana.win.t0], refreshEarthDisk, { immediate: true })
const chartData = computed(() => (rec.value ? { blocked: rec.value.mask.blocked, clearance: rec.value.mask.clearance, hitNode: rec.value.mask.hitNode, nodeNames: rec.value.mask.nodeNames } : null))
const overlays = computed(() => {
  const m = mnt.value
  if (!m) return { marks: [], polylines: [] }
  const polylines = []
  const h = coneHalfOf(m)
  if (h) for (const seg of coneOutline(m.boresightBody, Math.min(179, h))) polylines.push({ pts: seg })
  if (earthDisk.value) for (const seg of coneOutline([0, 0, 1], earthDisk.value)) polylines.push({ pts: seg, dash: [5, 4] })
  return { marks: [{ dirBody: m.boresightBody, label: m.name || m.id }], polylines }
})
const chartRef = ref(null)

// ── 预览：球面片 / 天线视角 ──
const avOn = computed(() => !!(satView.av.value && mnt.value && satView.av.value.mountId === mnt.value.id))
const avFov = ref(null)
// 缺省视场（契约 DESIGN2 §2：视场 = 挂点 fov 或方向图 −3 dB）：fovFullOf（挂点视场 → −3 dB 全宽 → 全向 360°），夹进相机能给的 [1°, 170°]；都没有 60°
const avFovDefault = computed(() => { const f = mnt.value ? fovFullOf(mnt.value) : null; return f ? Math.max(1, Math.min(170, f)) : 60 })
function toggleAv() {
  if (avOn.value) { satView.av.value = null; return }
  satView.av.value = { mountId: mnt.value.id, fovDeg: avFov.value || avFovDefault.value }
}
function setAvFov(v) { avFov.value = v; if (avOn.value) satView.av.value = { mountId: mnt.value.id, fovDeg: v || avFovDefault.value } }
watch(() => S.mountSel, () => { if (satView.av.value && mnt.value && satView.av.value.mountId !== mnt.value.id) satView.av.value = { mountId: mnt.value.id, fovDeg: avFov.value || avFovDefault.value } })

// ── 导出 ──
const expMsg = ref('')
const expBad = ref(false)
function setExp(x) { const s = ana.exportState(x); expMsg.value = s.msg; expBad.value = s.bad }
async function exportCsv() {
  if (!rec.value) return
  setExp(await ana.exportText(ana.fileStem('掩模'), maskToCsv(rec.value.mask), 'csv', 'CSV'))
}
async function exportPng() {
  if (!chartRef.value || !rec.value) return
  let r
  try { r = await ana.exportBlob(ana.fileStem('掩模'), await chartRef.value.exportPng({ scale: 4, title: `${S.label} · ${mnt.value ? (mnt.value.name || mnt.value.id) : ''}` }), 'png', 'PNG') }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) } }
  setExp(r)
}
const pct = (v) => (v == null ? '—' : fmtNum(v * 100, 4))
</script>

<template>
  <MdSec id="a-mask" title="本体遮挡掩模" :summary="stats ? pct(stats.blockedFrac) + ' %' : ''" :tip="MASK_CHART_CALIBER">
    <template #actions>
      <button class="lb-mini" :disabled="!rec" title="导出 CSV（az, el, blocked, clearanceM；逐格）" @click="exportCsv"><Icon name="file-down" :size="12" />CSV</button>
      <button class="lb-mini" :disabled="!rec" title="导出 PNG（白底、报告字体、4 倍）" @click="exportPng"><Icon name="image" :size="12" />PNG</button>
    </template>
    <div class="md-acts">
      <button class="lb-mini primary" :disabled="!mnt || !cur.meta || busy" title="按当前模型、选中挂点与关节值计算（Worker 池）" @click="compute"><Icon name="calculator" :size="13" />计算</button>
      <button v-if="busy" class="lb-mini" title="取消" @click="cancel"><Icon name="x" :size="13" />取消</button>
      <span v-if="busy" class="md-state"><span class="an-spin"></span><span data-i18n-skip>{{ prog }}</span></span>
      <label v-if="solar.length" class="md-chkrow an-chk" title="按太阳在本体系中的方位量化为 12 档（太阳翼每转 30° 一档）分别计算，查表时取与当前太阳角最接近的一档">
        <input v-model="sunScan" type="checkbox" />对日扫描
      </label>
    </div>
    <div v-if="err" class="md-state bad">{{ err }}</div>
    <div v-if="saved === false && rec" class="md-state warn" title="掩模文件未写入磁盘（主进程通道不可用或写入失败）；预览与读数不受影响">未保存</div>

    <!-- 关节 -->
    <div v-if="arts.length" class="an-arts">
      <div v-for="a in arts" :key="a.name" class="an-art">
        <span class="an-an" :title="a.name" data-i18n-skip>{{ a.name }}</span>
        <template v-for="(s, i) in a.stages" :key="s.name">
          <input class="an-sl" type="range" :min="s.minimumValue" :max="s.maximumValue" :step="stepOf(s)" :value="valOf(a, s, i)" :disabled="sunScan && solar.some((w) => w.name === a.name) && /Rotate$/.test(s.type)"
                 :title="s.name + '：' + s.minimumValue + ' … ' + s.maximumValue" @input="onSlide(a, i, $event.target.value)" />
          <span class="an-v" data-i18n-skip>{{ fmtNum(valOf(a, s, i), 4) }}</span>
        </template>
      </div>
      <div class="md-acts"><span class="sp"></span><button class="lb-mini" title="全部关节恢复初值" @click="resetArts"><Icon name="undo-2" :size="12" />复位</button></div>
    </div>

    <template v-if="rec">
      <div class="md-kvs">
        <div class="md-kv" title="遮挡网格立体角之和 / 4π（按立体角加权）"><span class="k">遮挡立体角</span><span class="v" data-i18n-skip>{{ pct(stats.blockedFrac) }}</span><span class="u">%</span></div>
        <div class="md-kv" title="遮挡网格中最近的命中距离（挂点至本体最近点）"><span class="k">最小净空</span><span class="v" data-i18n-skip>{{ stats.minClearanceM == null ? '—' : fmtNum(stats.minClearanceM, 4) }}</span><span class="u">m</span></div>
        <div v-if="rec.ms != null" class="md-kv" title="BVH 构建 + 射线求交（Worker 池墙钟时间）"><span class="k">耗时</span><span class="v" data-i18n-skip>{{ rec.ms }}</span><span class="u">ms</span></div>
        <div v-if="rec.sunBins" class="md-kv" title="按太阳翼转角量化的档数（每档一张掩模）"><span class="k">对日扫描</span><span class="v" data-i18n-skip>{{ rec.sunBins }}</span><span class="u">档</span></div>
        <div v-if="rec.sunBins" class="md-kv" :title="'对日扫描 ' + rec.sunBins + ' 档 + 当前关节状态 1 张，合计墙钟时间'"><span class="k">合计耗时</span><span class="v" data-i18n-skip>{{ rec.totalMs }}</span><span class="u">ms</span></div>
        <div v-if="rec.tris" class="md-kv"><span class="k">三角形</span><span class="v" data-i18n-skip>{{ rec.tris }}</span></div>
      </div>
      <div class="md-acts">
        <div class="lbu-seg an-seg">
          <button :class="{ on: mode === 'blocked' }" title="遮挡网格实心填充" @click="mode = 'blocked'">遮挡</button>
          <button :class="{ on: mode === 'clearance' }" title="遮挡网格按最近遮挡距离着色" @click="mode = 'clearance'">净空</button>
        </div>
        <span class="sp"></span>
        <label class="md-chkrow an-chk" title="在预览中绘制掩模球面片（半径 = 2 × 包围球半径，球心 = 射线起点）"><input v-model="satView.maskOn.value" type="checkbox" />球面片</label>
      </div>
      <ChartBox ref="chartRef" kind="mask" :data="chartData" :overlays="overlays" :mode="mode" />
    </template>
    <div class="srow an-av">
      <button class="lb-mini" :class="{ on: avOn }" :disabled="!mnt || !cur.meta" title="相机置于挂点并沿视轴观察：本体半透明红色、掩模边界黄线、视场圈青线" @click="toggleAv"><Icon name="scan-eye" :size="13" />天线视角</button>
      <label class="an-l" title="天线视角的竖直视场（全角）；缺省 = 挂点视场，未设置时取方向图 −3 dB 全宽（全向天线 170°），限定在 1°–170°">视场</label>
      <NumIn :model-value="avFov" :min="1" :max="170" :sig="4" allow-empty :placeholder="String(Math.round(avFovDefault * 10) / 10)" @commit="setAvFov" />
      <span class="u">°</span>
    </div>
    <div v-if="expMsg" class="md-state" :class="{ ok: !expBad, bad: expBad }">{{ expMsg }}</div>
  </MdSec>
</template>

<style scoped>
.an-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: an-spin .7s linear infinite; }
@keyframes an-spin { to { transform: rotate(360deg); } }
.an-chk { min-height: 0; }
.an-arts { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--r-box); }
.an-art { display: flex; align-items: center; gap: 6px; }
.an-an { flex: none; width: 88px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-2); font-family: var(--font-mono); color: var(--text-muted); }
.an-sl { flex: 1; min-width: 40px; }
.an-v { flex: none; min-width: 44px; text-align: right; font-size: var(--fs-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.an-seg > button { height: var(--h-ctl); padding: 0 10px; }
.an-av { margin-top: 2px; }
.an-l { min-width: 0 !important; }
.an-av :deep(.md-num) { flex: 0 1 70px; }
</style>
