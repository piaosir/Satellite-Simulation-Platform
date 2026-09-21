<script setup>
// 「查找卫星」对话框（STK Standard Object Database / KeepTrack Find Satellites 同款）：
// 左栏条件（关键词 + 编目四项 + 几何五项），右栏结果表；结果可「显示为图层」「存为卫星组」「加入组」。
// 条件的判定逻辑不在这里（shared/satFilter.js），本组件只铺格子、收结果、发动作。
import { ref } from 'vue'
import Icon from './Icon.vue'
import SatList from './SatList.vue'
import SatFilterBar from './SatFilterBar.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  keyword: { type: String, default: '' },
  filters: { type: Object, default: null },
  satcat: { type: Object, default: null },
  pool: { type: Array, default: () => [] },
  results: { type: Array, default: () => [] },     // SatList 行：{ id, name, lc, sub, tip, dot }
  matched: { type: Number, default: 0 },
  groups: { type: Array, default: () => [] },      // [{ id, name, count }] 供「加入组」
  resetKey: { type: String, default: '' }
})
const emit = defineEmits(['update:keyword', 'update:filters', 'close', 'show', 'save-group', 'add-to-group', 'activate', 'clear'])

const ACTIONS = [
  { key: 'show', label: '显示为图层', icon: 'eye', title: '把全部命中（或选中的那些）作为「搜索结果」图层显示到地图上', always: true },
  { key: 'save', label: '存为卫星组', icon: 'folder-plus', title: '把全部命中（或选中的那些）存成一个卫星组', always: true },
  { key: 'addto', label: '加入组', icon: 'layers', title: '把选中的卫星加入某个卫星组' }
]
const addMenu = ref(null)   // { sats, x, y }
// SatList 的 action 载荷：{ items:[已选行], x, y, right }；items 为空 = 「全部命中」（always 型动作才会在无选中时触发）
function onAction(key, p) {
  const sats = (p && p.items) || []
  if (key === 'show') { emit('show', sats); return }
  if (key === 'save') { emit('save-group', sats); return }
  if (key === 'addto') addMenu.value = { sats, x: Math.min(p.x || 0, window.innerWidth - 210), y: Math.min(p.y || 0, window.innerHeight - 220) }
}
function addTo(g) { const m = addMenu.value; addMenu.value = null; if (m) emit('add-to-group', g, m.sats) }
</script>

<template>
  <div v-if="open" class="fd-mask" @mousedown.self="emit('close')">
    <div class="fd" role="dialog" aria-modal="true">
      <header class="fd-hd">
        <span class="fd-t">查找卫星</span>
        <span class="fd-n" data-i18n-skip>命中 {{ matched }} 颗</span>
        <button class="winx" type="button" aria-label="关闭" title="关闭" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </header>
      <div class="fd-body">
        <div class="fd-crit">
          <div class="fd-kw">
            <span class="fd-si"><Icon name="search" :size="12" /></span>
            <input :value="keyword" placeholder="名称 / 编号 / 星座" spellcheck="false" @input="emit('update:keyword', $event.target.value)" />
            <span v-if="keyword" class="fd-x" title="清除关键词" @click="emit('update:keyword', '')"><Icon name="x" :size="12" /></span>
          </div>
          <SatFilterBar expanded :model-value="filters" :satcat="satcat" :pool="pool" :matched="-1" @update:model-value="(f) => emit('update:filters', f)" />
          <div class="fd-cf"><span class="lnk" title="清空关键词与全部条件" @click="emit('clear')"><Icon name="x" :size="12" /> 清空条件</span></div>
        </div>
        <div class="fd-res">
          <SatList
            :items="results" :reset-key="resetKey" :actions="ACTIONS" :rows="18"
            placeholder="在结果里筛选" empty="没有命中的卫星。"
            @action="onAction" @activate="(it) => emit('activate', it)"
          />
        </div>
      </div>
    </div>
    <template v-if="addMenu">
      <div class="fd-mbd" @mousedown="addMenu = null"></div>
      <div class="fd-menu" :style="{ left: addMenu.x + 'px', top: addMenu.y + 'px' }">
        <div class="fd-mh" data-i18n-skip>加入 {{ addMenu.sats.length }} 颗</div>
        <div class="fd-mi new" @click="addTo(null)"><Icon name="folder-plus" :size="12" /><span>新建组</span></div>
        <div v-for="g in groups" :key="g.id" class="fd-mi" @click="addTo(g)"><Icon name="layers" :size="12" /><span data-i18n-skip>{{ g.name }}</span><em data-i18n-skip>{{ g.count }}</em></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fd-mask { position: fixed; inset: 0; z-index: 1200; background: color-mix(in srgb, var(--bg) 55%, transparent); display: flex; align-items: center; justify-content: center; }
.fd { width: min(760px, 94%); height: min(560px, 92%); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3); border-radius: var(--r-float); overflow: hidden; }
.fd-hd { display: flex; align-items: center; gap: 10px; padding: 0 0 0 14px; height: 36px; border-bottom: 1px solid var(--border); }
.fd-t { font-weight: 600; font-size: var(--fs-4); color: var(--text); }
.fd-n { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.winx { margin-left: auto; width: 44px; height: 36px; border: 0; background: transparent; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.winx:hover { background: #c42b1c; color: #fff; }
.fd-body { flex: 1; min-height: 0; display: flex; }
.fd-crit { flex: 0 0 300px; border-right: 1px solid var(--border); overflow-y: auto; padding: 10px 0 8px; display: flex; flex-direction: column; }
.fd-kw { position: relative; padding: 0 12px 6px; }
.fd-kw input { width: 100%; box-sizing: border-box; height: var(--h-ctl); padding: 0 24px 0 24px; }
.fd-si { position: absolute; left: 19px; top: 50%; transform: translateY(calc(-50% - 3px)); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.fd-x { position: absolute; right: 19px; top: 50%; transform: translateY(calc(-50% - 3px)); color: var(--text-faint); cursor: pointer; display: inline-flex; padding: 2px; }
.fd-crit :deep(.satfb) { border-top: 0; }
.fd-cf { margin-top: auto; padding: 8px 12px 0; font-size: var(--fs-2); }
.lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; }
.fd-res { flex: 1; min-width: 0; padding: 6px 8px; display: flex; flex-direction: column; }
.fd-res :deep(.sl) { flex: 1; }
.fd-mbd { position: fixed; inset: 0; z-index: 2190; }
.fd-menu { position: fixed; z-index: 2200; width: 200px; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-box); padding: 3px 0; }
.fd-mh { padding: 3px 10px 5px; font-size: var(--fs-1); color: var(--text-faint); border-bottom: 1px solid var(--border); margin-bottom: 3px; }
.fd-mi { display: flex; align-items: center; gap: 7px; padding: 4px 10px; font-size: var(--fs-3); color: var(--text); cursor: pointer; }
.fd-mi:hover { background: var(--surface-2); }
.fd-mi.new { color: var(--accent); }
.fd-mi em { margin-left: auto; font-style: normal; color: var(--text-faint); font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
</style>
