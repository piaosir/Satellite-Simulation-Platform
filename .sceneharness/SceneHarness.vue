<script setup>
// 应用场景仿真验证台。三个台子按 URL 选：
//   默认   符号台：整套模块符号铺一屏（看清晰度、辨识度、深浅两主题）
//   ?topo  拓扑台：真模板 → 真引擎 → 真拓扑渲染（看连线颜色语言与读数）
//   ?panel 面板台：真 ScenePanel + 真 SceneTopology（看整屏交互）
//   ?map   地图台：真 2D 渲染器（flatCoverage）+ 真场景层（看符号/连线在地图上的样子与放置交互）
import { ref, computed, onMounted, watch } from 'vue'
import ScenePanel from '../src/components/ScenePanel.vue'
import SceneTopology from '../src/components/SceneTopology.vue'
import { scene, loadLibrary, applyTemplate, compute } from '../src/viz/scene/sceneStore.js'
import { drawSymbol, iconOf } from '../src/viz/scene/sceneSymbols.js'
import { symbolSpec } from '../src/viz/scene/sceneSymbolMap.js'
import { createFlatCoverage } from '../src/viz/flatmap/flatCoverage.js'

const q = new URLSearchParams(location.search)
const mode = q.has('panel') ? 'panel' : (q.has('topo') ? 'topo' : (q.has('map') ? 'map' : 'sym'))
const dark = ref(document.documentElement.getAttribute('data-theme') !== 'light')
function flip() {
  dark.value = !dark.value
  document.documentElement.setAttribute('data-theme', dark.value ? 'dark' : 'light')
  if (mode === 'sym') paintAll()
}

// ── 符号台：全部 160 个模块，逐条一格，格内三档尺寸（64 / 32 / 16）──
// 这三档就是符号在软件里真正出现的尺寸：拓扑卡 36、地图 26、库列表 16。
// 明暗两主题各截一张：描边件的套边在浅底与深底上是两种效果，只看一种会漏。
const libAll = ref([])
const catFilter = ref('')
const rows = computed(() => libAll.value
  .filter((m) => !catFilter.value || m.cat === catFilter.value)
  .map((m) => ({ id: m.id, cat: m.cat, zh: m.zh, mod: m, icon: iconOf(m), badge: (symbolSpec(m).badge || '') })))
const catList = computed(() => [...new Set(libAll.value.map((m) => m.cat))].sort())
const cvs = ref([])
function paintAll() {
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#fff'
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000'
  const by = new Map(libAll.value.map((m) => [m.id, m]))
  for (const el of cvs.value) {
    if (!el) continue
    const w = 132, h = 76
    el.width = w; el.height = h
    const ctx = el.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    const mod = by.get(el.dataset.id)
    drawSymbol(ctx, mod, 38, 38, 64, ink, 0, bg)
    drawSymbol(ctx, mod, 88, 30, 32, ink, 0, bg)
    drawSymbol(ctx, mod, 118, 26, 16, ink, 0, bg)
  }
}
// ── 地图台：真 2D 渲染器 + 真场景层 ──
const mapCv = ref(null)
let flat = null
function pushToMap() {
  if (!flat) return
  const byId = new Map(scene.modules.map((m) => [m.id, m]))
  const posOf = (id) => { let m = byId.get(id), d = 0; while (m && m.place && m.place.mode === 'mounted' && m.place.hostId && d++ < 8) m = byId.get(m.place.hostId); return (m && m.place) || {} }
  const mods = scene.modules.map((m) => {
    const e = eff(m); const pl = posOf(m.id)
    const sat = e && e.cat === 'A' ? (e.sat || {}) : null
    const geo = sat && sat.orbitClass === 'GSO' && sat.orbitLongitude != null
    return { id: m.id, name: m.name, symbol: e ? e.id : '', cat: e ? e.cat : '',
      lat: geo ? 0 : (pl.lat != null ? +pl.lat : null),
      lon: geo ? +sat.orbitLongitude : (pl.lon != null ? +pl.lon : null),
      sel: !!(scene.sel && scene.sel.type === 'module' && scene.sel.id === m.id) }
  })
  const links = scene.links.map((l) => ({ aId: l.a.modId, bId: l.b.modId, tier: tierOfKey(l.medium), role: l.role,
    sel: !!(scene.sel && scene.sel.type === 'link' && scene.sel.id === l.id) }))
  flat.setScene(mods, links, { on: true, links: true, labels: true, iconPx: 26, fontPx: 13 })
}
const eff = (m) => { const b = (scene.lib || []).find((x) => x.id === m.libId); return b || null }
const tierOfKey = (k) => { const c = scene.catalog; const md = c && (c.media || []).find((x) => x.key === k); return md ? md.tier : 'power' }

onMounted(async () => {
  if (mode === 'map') {
    await loadLibrary()
    await applyTemplate(tpl.value)
    await compute()
    flat = createFlatCoverage(mapCv.value)
    pushToMap()
    return
  }
  if (mode === 'sym') {
    const r = await fetch('/api/scene/libList', { method: 'POST', body: '{}' }).then((x) => x.json())
    libAll.value = r.modules || []
    await new Promise((res) => setTimeout(res, 30)); paintAll()
  }
  else {
    await loadLibrary()
    await applyTemplate(tpl.value)
    await compute()
  }
})
const tpl = ref('tpl.lowalt.nest')
const tplList = computed(() => scene.templates)
watch(tpl, async (v) => { await applyTemplate(v); await compute(); if (mode === 'map') pushToMap() })
watch(() => [scene.modules, scene.links, scene.sel], () => { if (mode === 'map') pushToMap() }, { deep: true })
</script>

<template>
  <div class="hw">
    <div class="hh">
      <b>应用场景仿真验证台</b>
      <span class="tabs">
        <a :class="{ on: mode === 'sym' }" href="?">符号</a>
        <a :class="{ on: mode === 'topo' }" href="?topo">拓扑</a>
        <a :class="{ on: mode === 'map' }" href="?map">地图</a>
        <a :class="{ on: mode === 'panel' }" href="?panel">面板</a>
      </span>
      <select v-if="mode !== 'sym'" v-model="tpl">
        <option v-for="t in tplList" :key="t.id" :value="t.id">{{ t.zh }}</option>
      </select>
      <span class="sp"></span>
      <button @click="flip">{{ dark ? '浅色' : '深色' }}</button>
    </div>

    <!-- 符号台 -->
    <template v-if="mode === 'sym'">
      <div class="symbar">
        <span class="tg" :class="{ on: !catFilter }" @click="catFilter = ''">全部 {{ libAll.length }}</span>
        <span v-for="c in catList" :key="c" class="tg" :class="{ on: catFilter === c }" @click="catFilter = c">{{ c }}</span>
      </div>
      <div class="syms">
        <div v-for="r in rows" :key="r.id" class="symc">
          <canvas ref="cvs" :data-id="r.id"></canvas>
          <div class="sn">{{ r.zh }}</div>
          <div class="sk">{{ r.icon }}<em v-if="r.badge"> + {{ r.badge }}</em></div>
        </div>
      </div>
    </template>

    <!-- 地图台 -->
    <div v-if="mode === 'map'" class="mapw"><canvas ref="mapCv"></canvas></div>

    <!-- 拓扑台 -->
    <div v-else-if="mode === 'topo'" class="topow"><SceneTopology /></div>

    <!-- 面板台 -->
    <div v-else-if="mode === 'panel'" class="panelw">
      <div class="side"><ScenePanel /></div>
      <div class="main"><SceneTopology /></div>
    </div>
  </div>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font-family: var(--font-ui, system-ui); font-size: var(--fs-4); }
</style>
<style scoped>
.hw { display: flex; flex-direction: column; height: 100vh; }
.hh { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border-strong); background: var(--surface); flex: none; }
.tabs { display: flex; gap: 2px; }
.tabs a { padding: 3px 12px; border: 1px solid var(--field-border); color: var(--text-muted); text-decoration: none; }
.tabs a.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.sp { flex: 1; }
.symbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 14px; border-bottom: 1px solid var(--border); flex: none; }
.tg { padding: 1px 9px; border: 1px solid var(--border); color: var(--text-muted); cursor: pointer; font-size: 11px; border-radius: 9px; }
.tg.on { background: var(--accent-ui); border-color: var(--accent-ui); color: var(--bg); }
.syms { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1px; background: var(--border); padding: 1px; align-content: start; }
.symc { background: var(--bg); padding: 6px 4px 8px; text-align: center; }
.symc canvas { width: 132px; height: 76px; }
.sk { font-family: ui-monospace, monospace; font-size: 10px; color: var(--accent-ui); line-height: 1.3; word-break: break-all; }
.sk em { font-style: normal; color: var(--text-faint); }
.sn { font-size: 11px; color: var(--text); line-height: 1.4; margin-top: 2px; }
.sn em { font-style: normal; }
.topow { flex: 1; min-height: 0; }
.mapw { flex: 1; min-height: 0; position: relative; }
.mapw canvas { width: 100%; height: 100%; display: block; }
.panelw { flex: 1; display: flex; min-height: 0; }
.side { width: 340px; flex: none; overflow-y: auto; border-right: 1px solid var(--border-strong); background: var(--surface); }
.main { flex: 1; min-width: 0; }
</style>
