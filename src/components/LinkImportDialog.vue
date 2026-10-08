<script setup>
// 「导入链路」对话框（GSO / NGSO / 再生式 / 端到端四窗共用）：列出星座 3D 主窗里建好的图上链路，勾选后一次导入。
// 数据源 = localStorage['globe3d/markers'] 的 links + stations + points + trajectories，与 'globe3d/polygons' 的 Polygon
// （与「导入站址」读同一份，同源共享、无需 IPC）；主窗在开着时改了链路，这里随 storage 事件当场刷新。
// 本窗口导不进的链路灰显、不能勾，title 报原因（拓扑判定见 packages/core/models/mapLinks.mjs 的 linkTargets）。
// 选中项按 mapLinks.linkStrands 现造成导入载荷（纯数据：Polygon / 航迹节点按取点逐个代表点展开成支路，载具取场景时钟此刻的位置，
// 代表点的几何口径与主窗同一份 mapLinkPoints.mjs），经 'import' 交给宿主的 importChains。行尾报支路数（> 1 才报）。
// 勾选交互与 CityPicker 同一份口径（shared/ui/useCheckList.js）：点行翻勾、按住拖刷、Shift 连选、Ctrl+A。
// 对话框壳自带（lki- 前缀、z 300），不依赖任何窗口的 CSS。
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { useCheckList } from '../shared/ui/useCheckList.js'
import { pointFallbackName } from '../shared/markerNames.js'
import { linkPointName, linkPointShort } from '../shared/linkPointNames.js'
import { sceneNowMs } from '../shared/sceneClock.js'
import { linkTargets, targetReason, linkStrands, linkStrandCount, linkAutoName, hopKind, sanitizeLinks } from '../../packages/core/models/mapLinks.mjs'
import { nodePoints } from '../../packages/core/models/mapLinkPoints.mjs'

const props = defineProps({
  kind: { type: String, required: true }     // 'linkbudget' | 'ngso' | 'regen' | 'e2e'
})
const emit = defineEmits(['import', 'close'])

const MK_KEY = 'globe3d/markers', PG_KEY = 'globe3d/polygons'
const HOP_TXT = { up: '上行', down: '下行', isl: '星间微波', laser: '星间激光' }

const mk = shallowRef({ stations: [], points: [], trajectories: [], polygons: [], links: [] })
function reload() {
  let d = null, pg = null
  try { d = JSON.parse(localStorage.getItem(MK_KEY) || 'null') } catch { d = null }
  try { pg = JSON.parse(localStorage.getItem(PG_KEY) || 'null') } catch { pg = null }
  const arr = (v) => (Array.isArray(v) ? v : [])
  const stations = arr(d && d.stations), points = arr(d && d.points), trajectories = arr(d && d.trajectories)
  const polygons = arr(Array.isArray(pg) ? pg : (pg && pg.polys)).filter((p) => p && p.id && Array.isArray(p.pts))   // 旧格式为裸数组（同主窗 loadPolys）
  mk.value = { stations, points, trajectories, polygons, links: sanitizeLinks(d && d.links) }
}
const stById = computed(() => new Map(mk.value.stations.filter((s) => s && s.id != null).map((s) => [String(s.id), s])))
// 点标记只当位置端点：没起名的按兜底名「点标记N / Point N」称呼（同主窗链路视图，见 shared/markerNames.js）
const ptById = computed(() => {
  const m = new Map()
  mk.value.points.forEach((p, i) => { if (p && p.id != null) m.set(String(p.id), { name: String(p.name || '').trim() || pointFallbackName(i), lat: p.lat, lon: p.lon }) })
  return m
})
// Polygon / 航迹：'pg:<id>' | 'tj:<id>' → 对象
const areaById = computed(() => {
  const m = new Map()
  for (const p of mk.value.polygons) if (p && p.id != null) m.set('pg:' + p.id, p)
  for (const t of mk.value.trajectories) if (t && t.id != null) m.set('tj:' + t.id, t)
  return m
})
const areaName = (n, o) => (o ? (String(o.name || '').trim() || (n.k === 'pg' ? 'Polygon' : '')) : '')
// 载具代表点取哪一刻：对话框打开 / 数据刷新时读一次场景时钟（与主窗时间轴同一条时间线）
const nowMs = ref(sceneNowMs())
const ctx = computed(() => {
  const m = stById.value, pm = ptById.value, am = areaById.value, t = nowMs.value
  const area = (n) => am.get(n.k + ':' + n.id) || null
  return {
    hasStation: (id) => m.has(String(id)),
    hasPoint: (id) => pm.has(String(id)),
    satOk: (n) => !!(n && n.key),
    area,
    station: (id) => m.get(String(id)) || null,
    point: (id) => pm.get(String(id)) || null,
    nameOf: (n) => (n.k === 'st' ? ((m.get(String(n.id)) || {}).name || '') : n.k === 'pt' ? ((pm.get(String(n.id)) || {}).name || '') : (n.k === 'pg' || n.k === 'tj') ? areaName(n, area(n)) : n.name),
    // Polygon / 航迹节点取到的代表点 → 落成地面端的站名 / 支路短名（航迹点带实际高度）
    points: (n) => {
      const o = area(n)
      if (!o) return []
      const nm = areaName(n, o)
      return nodePoints(n.k, o, n.pick, t).map((c) => ({ name: linkPointName(nm, n.k, c), label: linkPointShort(n.k, c), lat: c.lat, lon: c.lon, ...(n.k === 'tj' ? { altM: c.altM } : {}) }))
    }
  }
})
const rows = computed(() => mk.value.links.map((l) => {
  const c = ctx.value
  const ok = !!linkTargets(l, c)[props.kind]
  const hops = []
  for (let i = 0; i < l.nodes.length - 1; i++) { const t = hopKind(l.nodes[i], l.nodes[i + 1]); if (t) hops.push(HOP_TXT[t]) }
  return {
    id: l.id, link: l, ok,
    name: (l.name || '').trim() || linkAutoName(l, c.nameOf),
    color: l.color || '',
    hops: hops.join(' · '),
    strands: ok ? linkStrandCount(l, c) : 0,
    why: ok ? '' : targetReason(l, props.kind, c)
  }
}))
const okRows = computed(() => rows.value.filter((r) => r.ok))
// 显示序：可导入的在前、灰显的在后——勾选内核只管前一段（下标与它对齐），全选 / 刷选不会落到灰显行上
const viewRows = computed(() => [...okRows.value, ...rows.value.filter((r) => !r.ok)])

const sel = ref(new Set())
const listEl = ref(null)
const L = useCheckList({
  rows: () => okRows.value,
  idOf: (r) => r.id,
  isOn: (id) => sel.value.has(id),
  current: () => [...sel.value],
  commit: (ids) => { const ok = new Set(okRows.value.map((r) => r.id)); sel.value = new Set(ids.filter((id) => ok.has(id))) },
  el: () => listEl.value,
  rowSelector: '.lki-item',
  headSelector: '.lki-all'
})
const selCount = computed(() => okRows.value.filter((r) => sel.value.has(r.id)).length)

function payloadsOf(ids) {
  nowMs.value = sceneNowMs()   // 载具代表点取导入这一刻（ctx 随之重算）
  const want = new Set(ids), out = []
  for (const r of okRows.value) {
    if (!want.has(r.id)) continue
    for (const p of linkStrands(r.link, ctx.value)) out.push(JSON.parse(JSON.stringify(p)))
  }
  return out
}
// 已选链路共展开成几条支路（> 已选条数时页脚报）
const selStrands = computed(() => okRows.value.reduce((a, r) => a + (sel.value.has(r.id) ? (r.strands || 1) : 0), 0))
function doImport(ids) {
  const list = payloadsOf(ids)
  if (!list.length) return
  emit('import', list)
  emit('close')
}
function importSelected() { doImport([...sel.value]) }
function onDbl(r) { if (r.ok) doImport([r.id]) }
function onListKey(e) {
  if (e.key === 'Enter' && selCount.value) { e.preventDefault(); importSelected(); return }
  L.onKey(e)
}
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault(); e.stopPropagation()
  emit('close')
}
function onStorage(e) { if (!e || e.key === MK_KEY || e.key === PG_KEY) { nowMs.value = sceneNowMs(); reload() } }
onMounted(() => {
  reload()
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('storage', onStorage)
  nextTick(() => { if (listEl.value) listEl.value.focus({ preventScroll: true }) })
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('storage', onStorage)
})
</script>

<template>
  <div class="lki-mask" @mousedown.self="emit('close')">
    <div class="lki-dlg" role="dialog">
      <div class="lki-hd">
        <span>导入链路</span>
        <button type="button" class="lki-x" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>
      <div class="lki-body">
        <div ref="listEl" class="lki-list" :class="{ painting: L.painting.value }" tabindex="0"
             title="点一行翻勾选 · 按住拖＝刷选 · Shift 点＝连选 · Ctrl+A 全选 · 双击＝直接导入该链路" @keydown="onListKey">
          <div v-if="okRows.length" class="lki-row lki-all" @mousedown="L.onHeadDown">
            <input type="checkbox" :checked="L.allOn()" :indeterminate.prop="L.anyOn() && !L.allOn()" />
            <span class="lki-alln">(全选)</span>
            <span class="lki-pk">{{ selCount }}/{{ okRows.length }}</span>
          </div>
          <div v-for="(r, i) in viewRows" :key="r.id" class="lki-row lki-item" :class="{ on: L.isOn(r.id), cur: L.cur.value === i, off: !r.ok }"
               :title="r.ok ? r.name : r.why" @mousedown="r.ok && L.onRowDown($event, i)" @dblclick="onDbl(r)">
            <input type="checkbox" :checked="r.ok && L.isOn(r.id)" :disabled="!r.ok" />
            <span class="lki-sw" :style="r.color ? { background: r.color } : null"></span>
            <span class="lki-nm" data-i18n-skip>{{ r.name }}</span>
            <span class="lki-hops">{{ r.hops }}</span>
            <span v-if="r.strands > 1" class="lki-st" title="支路数（导入后的行数 / 链数）">×{{ r.strands }}</span>
          </div>
          <div v-if="!rows.length" class="lki-empty">暂无链路。</div>
        </div>
      </div>
      <div class="lki-ft">
        <span class="lki-cnt"><span>可导入</span> {{ okRows.length }}/{{ rows.length }}<span class="lki-sep">·</span><span>已选</span> {{ selCount }}<template v-if="selStrands > selCount"><span class="lki-sep">·</span><span>支路</span> {{ selStrands }}</template></span>
        <button type="button" class="lki-btn ghost" @click="emit('close')">取消</button>
        <button type="button" class="lki-btn" :disabled="!selCount" @click="importSelected">导入<template v-if="selCount">（{{ selCount }}）</template></button>
      </div>
    </div>
  </div>
</template>

<style>
/* 壳与 CityPicker 同一套（cpk- → lki-）：遮罩 + 标题条 + 页脚，不吃宿主窗口的 CSS */
.lki-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.lki-dlg { width: 560px; max-width: calc(100% - 32px); max-height: 86%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-3); animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.lki-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); color: var(--text); flex: none; }
.lki-hd .lki-x { margin-left: auto; cursor: pointer; display: inline-flex; border: 0; background: transparent; padding: 2px; border-radius: var(--r-ctl); color: var(--text-faint); }
.lki-hd .lki-x:hover { color: var(--text); background: var(--wash-hover); }
.lki-body { padding: 12px 14px; min-height: 0; display: flex; flex-direction: column; }
.lki-list { position: relative; height: min(52vh, 420px); min-height: 180px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); outline: none; background: var(--bg); }
.lki-list:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
.lki-row { display: flex; align-items: center; gap: 7px; padding: 3px 8px; font-size: var(--fs-3); color: var(--text-muted); user-select: none; }
.lki-row + .lki-row { border-top: 1px solid var(--border); }
.lki-row:hover { background: var(--surface); }
.lki-row.on { background: color-mix(in srgb, var(--accent-ui) 13%, transparent); }
.lki-row.on:hover { background: color-mix(in srgb, var(--accent-ui) 20%, transparent); }
.lki-row.cur { outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -1px; }
.lki-row.off, .lki-row.off .lki-nm { color: var(--text-faint); }
.lki-row.off:hover { background: transparent; }
.lki-row input[type=checkbox] { pointer-events: none; flex: none; }
.lki-row.lki-all { position: sticky; top: 0; z-index: 1; background: var(--surface); border-bottom: 1px solid var(--border); }
.lki-row.lki-all + .lki-row { border-top: 0; }
.lki-row .lki-alln { flex: 1; color: var(--text); font-weight: 600; }
.lki-row .lki-pk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.lki-sw { flex: none; width: 10px; height: 10px; border-radius: 2px; background: var(--text-faint); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent); }
.lki-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lki-row.on .lki-nm { color: var(--text); }
.lki-hops { flex: none; color: var(--text-faint); font-size: var(--fs-2); white-space: nowrap; }
.lki-st { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.lki-empty { padding: 18px; text-align: center; color: var(--text-faint); font-size: var(--fs-3); }
.lki-ft { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex: none; }
.lki-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; margin-right: auto; }
.lki-cnt .lki-sep { margin: 0 6px; }
.lki-btn { display: inline-flex; align-items: center; justify-content: center; height: var(--h-ctl-lg); padding: 0 18px;
           font-size: var(--fs-3); white-space: nowrap; cursor: pointer; user-select: none; color: var(--primary-on);
           background: var(--primary-fill); border: 1px solid var(--primary-fill); border-radius: var(--r-ctl); }
.lki-btn:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.lki-btn.ghost { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
.lki-btn.ghost:hover:not(:disabled) { background: var(--bg); border-color: var(--line-hover); }
.lki-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
