<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { useNavStore } from './stores/nav'
import { cursor } from './stores/cursor'

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
        <span>文件</span><span>计算</span><span>视图</span><span>帮助</span>
      </nav>
    </header>

    <div class="body">
      <main class="content">
        <component :is="currentComponent" :title="currentLabel" />
      </main>
    </div>

    <footer class="statusbar">
      <span>● 离线模式</span>
      <span>当前：{{ currentLabel }}</span>
      <span class="grow">
        <span v-if="cursor.ll" class="coord">
          <svg class="cur" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M5 2.5 L5 19.5 L9.3 15.4 L12 21.4 L14.5 20.2 L11.9 14.4 L17.5 14 Z" fill="currentColor" stroke="rgba(0,0,0,0.55)" stroke-width="1" stroke-linejoin="round"/></svg>
          {{ fmtCoord(cursor.ll) }}
        </span>
        <span v-else>模型 ITU-R P.618-13 / P.676-13 / P.840-9</span>
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
.menu { display: flex; gap: 18px; color: var(--text-muted); font-size: 12.5px; }
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
</style>
