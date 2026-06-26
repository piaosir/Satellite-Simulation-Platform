<script setup>
import { computed, ref, defineAsyncComponent } from 'vue'
import { useNavStore } from './stores/nav'
import { cursor } from './stores/cursor'
import { view } from './stores/view'
import { covNav } from './stores/coveragePanels'
import { zoom } from './stores/zoom'
import { effective as displayQuality } from './stores/displayQuality'
import SettingsModal from './components/SettingsModal.vue'

// 底部状态栏缩放进度条：拖动/按钮 → 设回当前活动地图（zoom.apply）；地图滚轮缩放回填 zoom.value。
const onZoomInput = (e) => { const t = Number(e.target.value); if (zoom.apply) zoom.apply(t) }
const stepZoom = (d) => { const t = Math.max(0, Math.min(1, zoom.value + d)); if (zoom.apply) zoom.apply(t) }

// 经度在前、纬度在后，保留两位小数
const fmtCoord = (ll) => `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}  ${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}`
import LinkBudget from './pages/LinkBudget.vue'
import Configs from './pages/Configs.vue'
import History from './pages/History.vue'
import Settings from './pages/Settings.vue'
import Placeholder from './pages/Placeholder.vue'

// 重资源页面（Cesium / 高德）按需懒加载，避免其加载问题拖垮整个应用。
const ConstellationMap = defineAsyncComponent(() => import('./pages/ConstellationMap.vue'))
const ConstellationMap3D = defineAsyncComponent(() => import('./pages/ConstellationMap3D.vue'))
const ISL = defineAsyncComponent(() => import('./pages/ISL.vue'))

const nav = useNavStore()
const viewMenu = ref(false)
const settingsOpen = ref(false)
// MSAA 是 WebGL 上下文创建期参数，运行时不可改 → 把它并入当前页 key，切换 MSAA 时重挂载页面（一瞬重渲）。
// 页面状态由各自的本地缓存（reactive watch 持续保存）在重挂载时恢复，无感。
const pageKey = computed(() => `${nav.current}-msaa${displayQuality.value.msaa !== false ? 1 : 0}`)
function pickView(v) { view.flat = v; viewMenu.value = false }

const pageMap = {
  link: LinkBudget,
  constellation: ConstellationMap,
  globe3d: ConstellationMap3D,
  isl: ISL,
  configs: Configs,
  history: History,
  settings: Settings
}
const currentComponent = computed(() => pageMap[nav.current] || Placeholder)
const currentLabel = computed(
  () => nav.pages.find((p) => p.key === nav.current)?.label || ''
)
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <span class="brand">卫星仿真平台</span>
      <nav class="menu">
        <span>文件</span><span>计算</span>
        <span class="vwrap">
          <span class="vbtn" :class="{ on: viewMenu }" @click.stop="viewMenu = !viewMenu">视图 · {{ view.flat ? '2D 平面' : '3D 球体' }} ▾</span>
          <div v-if="viewMenu" class="vmenu">
            <div class="vitem" :class="{ sel: !view.flat }" @click="pickView(false)">
              <span class="ck">{{ !view.flat ? '✓' : '' }}</span><span class="vico">◐</span>3D 球体
            </div>
            <div class="vitem" :class="{ sel: view.flat }" @click="pickView(true)">
              <span class="ck">{{ view.flat ? '✓' : '' }}</span><span class="vico">▦</span>2D 平面图
            </div>
          </div>
        </span>
        <span v-if="covNav.grdAvail" class="covbtn" :class="{ on: covNav.grdOpen }" @click="covNav.toggleGrd && covNav.toggleGrd()">覆盖分析</span>
        <span v-if="covNav.covAvail" class="covbtn" :class="{ on: covNav.covOpen }" @click="covNav.toggleCov && covNav.toggleCov()">覆盖图（GXT）</span>
        <span class="setbtn" @click="settingsOpen = true">设置</span>
      </nav>
      <div v-if="viewMenu" class="vmask" @click="viewMenu = false"></div>
    </header>

    <div class="body">
      <main class="content">
        <component :is="currentComponent" :key="pageKey" :title="currentLabel" />
      </main>
    </div>

    <SettingsModal v-if="settingsOpen" @close="settingsOpen = false" />

    <footer class="statusbar">
      <span v-if="zoom.avail" class="zoomctl" title="地图缩放（拖动精细调节，滚轮亦可）">
        <span class="zlbl">缩放</span>
        <button class="zbtn" title="缩小" @click="stepZoom(-0.01)">－</button>
        <input class="zrange" type="range" min="0" max="1" step="0.001" :value="zoom.value" @input="onZoomInput" />
        <button class="zbtn" title="放大" @click="stepZoom(0.01)">＋</button>
        <span class="zpct">{{ Math.round(zoom.value * 100) }}%</span>
      </span>
      <span>当前：{{ currentLabel }}</span>
      <span class="grow">
        <span v-if="cursor.ll" class="coord">
          <svg class="cur" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 2.5 L5 19.5 L9.3 15.4 L12 21.4 L14.5 20.2 L11.9 14.4 L17.5 14 Z" fill="currentColor" stroke="rgba(0,0,0,0.55)" stroke-width="1" stroke-linejoin="round"/></svg>
          {{ fmtCoord(cursor.ll) }}
        </span>
      </span>
      <span>就绪</span>
    </footer>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.topbar {
  display: flex; align-items: center; gap: 22px; height: 38px;
  padding: 0 14px; background: var(--surface);
  border-bottom: 1px solid var(--border); flex: none;
}
.brand { font-family: var(--font-serif); font-size: 15px; letter-spacing: .4px; }
.menu { display: flex; align-items: center; gap: 18px; color: var(--text-muted); font-size: 12.5px; }
.setbtn { cursor: pointer; }
.setbtn:hover { color: var(--text); }
.vwrap { position: relative; }
.vbtn { cursor: pointer; border: 1px solid var(--border); padding: 2px 10px; border-radius: 2px; }
.vbtn:hover { color: var(--text); border-color: var(--accent); }
.vbtn.on { color: var(--text); border-color: var(--accent); }
.covbtn { cursor: pointer; border: 1px solid var(--border); padding: 2px 10px; border-radius: 2px; transition: color .12s, background .12s, border-color .12s; }
.covbtn:hover { color: var(--text); border-color: var(--accent); }
.covbtn.on { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.covbtn.on:hover { color: var(--bg); }
.vmenu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 100; min-width: 132px;
  background: var(--surface); border: 1px solid var(--border-strong);
  box-shadow: 0 6px 18px rgba(0,0,0,0.35); padding: 4px;
}
.vitem { display: flex; align-items: center; gap: 7px; padding: 6px 9px; cursor: pointer; color: var(--text-muted); font-size: 12.5px; }
.vitem:hover { background: var(--bg); color: var(--text); }
.vitem.sel { color: var(--text); }
.vitem .ck { width: 12px; color: var(--accent); }
.vitem .vico { width: 14px; text-align: center; color: var(--text-faint); }
.vitem.sel .vico { color: var(--accent); }
.vmask { position: fixed; inset: 0; z-index: 99; }
.body { display: flex; flex: 1; min-height: 0; }
.sidenav {
  width: 140px; flex: none; padding: 8px 0;
  background: var(--bg); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.navitem {
  display: flex; align-items: center; gap: 9px;
  padding: 8px 16px; border: 0; background: transparent;
  color: var(--text-muted); text-align: left; cursor: pointer;
  border-left: 2px solid transparent; font-size: 13px;
}
.navitem:hover { background: var(--surface); color: var(--text); }
.navitem.active {
  color: var(--text); background: var(--surface);
  border-left-color: var(--accent);
}
.mark { width: 14px; text-align: center; color: var(--text-faint); }
.navitem.active .mark { color: var(--text); }
.content { flex: 1; min-width: 0; overflow: auto; }
.statusbar {
  display: flex; align-items: center; gap: 18px; height: 26px;
  padding: 0 14px; background: var(--surface);
  border-top: 1px solid var(--border); flex: none;
  font-size: 11.5px; color: var(--text-faint);
}
.statusbar .grow { margin-left: auto; }
.statusbar .coord { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--accent); letter-spacing: .3px; }
.statusbar .coord .cur { vertical-align: middle; }
/* 缩放进度条：拖动精细调节，±按钮步进，右侧百分比 */
.zoomctl { display: inline-flex; align-items: center; gap: 7px; }
.zoomctl .zlbl { color: var(--text-faint); }
.zoomctl .zbtn { width: 16px; height: 16px; line-height: 14px; text-align: center; padding: 0; border: 1px solid var(--border); background: var(--bg); color: var(--text-muted); cursor: pointer; border-radius: 2px; font-size: 12px; }
.zoomctl .zbtn:hover { color: var(--text); border-color: var(--accent); }
.zoomctl .zrange { width: 120px; height: 3px; cursor: pointer; accent-color: var(--accent); }
.zoomctl .zpct { width: 34px; text-align: right; font-family: var(--font-mono); color: var(--text-muted); }
</style>
