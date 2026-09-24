<script setup>
// 「查找卫星」对话框（STK Standard Object Database / KeepTrack Find Satellites 同款）：
// 左栏条件（关键词 + 编目四项 + 几何五项），右栏结果表；结果可「显示为图层」「存为卫星组」「加入组」。
// 条件的判定逻辑不在这里（shared/satFilter.js），本组件只铺格子、收结果、发动作。
import { ref, watch, onBeforeUnmount } from 'vue'
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

// Esc：先关「加入组」菜单，再关对话框。捕获相挂在 window 上并截停 —— 宿主页的 Esc（清选择 / 退聚焦）
// 不再跟着触发；输入法组字中的 Esc 是撤销组字，不关。
// 对话框里自己用 Esc 的控件先让它处理（捕获相截停会让它们收不到）：
// 结果筛选框有字 = 清字；结果表有选中 = 清选择；数字框 = 丢草稿并失焦（下一下 Esc 再关对话框）。
const fdEl = ref(null)
function onEsc(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  if (addMenu.value) { e.stopPropagation(); addMenu.value = null; return }
  const t = e.target
  if (t instanceof Element && fdEl.value && fdEl.value.contains(t) &&
      ((t.matches('.slf input') && t.value) || (t.matches('.slvp') && t.closest('.sl.hassel')) || t.matches('.satfb input'))) return
  e.stopPropagation()
  emit('close')
}
watch(() => props.open, (o) => (o ? window.addEventListener('keydown', onEsc, true) : window.removeEventListener('keydown', onEsc, true)), { immediate: true })
onBeforeUnmount(() => window.removeEventListener('keydown', onEsc, true))
</script>

<template>
  <div v-if="open" class="fd-mask" @mousedown.self="emit('close')">
    <div ref="fdEl" class="fd" role="dialog" aria-modal="true">
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
/* 遮罩走全软件同一档暗罩 --scrim（原乳白罩是全软件唯一的浅罩），瞬时出现不动画 */
.fd-mask { position: fixed; inset: 0; z-index: 1200; background: var(--scrim); display: flex; align-items: center; justify-content: center; }
.fd { width: min(760px, 94%); height: min(560px, 92%); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3); border-radius: var(--r-card); overflow: hidden; animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.fd-hd { display: flex; align-items: center; gap: 10px; padding: 0 0 0 12px; height: 36px; border-bottom: 1px solid var(--border); }
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
/* 上内距 4：结果表筛选框顶 = 4 + .sl 描边 1 + .slh 内距 5 = 10 = 左栏关键词框顶，两栏第一行齐平 */
.fd-res { flex: 1; min-width: 0; padding: 4px 8px 6px; display: flex; flex-direction: column; }
/* 对话框里没有「上面那一行」可挂，结果表自成一个四边框的块 */
.fd-res :deep(.sl) { flex: 1; border: 1px solid var(--border); }
.fd-mbd { position: fixed; inset: 0; z-index: 2190; }
/* 命令菜单（spec P3）：同星座侧栏 .lp-menu —— 四周 3px 内距、项圆角同心、项左右内距各减 3px 字不动 */
.fd-menu { position: fixed; z-index: 2200; width: 200px; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-float); padding: 3px; animation: ui-fade-in var(--dur-2) var(--ease-out); }
.fd-mh { margin: 0 -3px 3px; padding: 3px 10px 5px; font-size: var(--fs-1); color: var(--text-faint); border-bottom: 1px solid var(--border); }
.fd-mi { display: flex; align-items: center; gap: 7px; padding: 4px 7px; font-size: var(--fs-3); color: var(--text); cursor: pointer; border-radius: var(--r-box); }
.fd-mi > svg { flex: none; color: var(--text-muted); }
.fd-mi:hover { background: var(--accent-ui); color: var(--bg); }
.fd-mi:hover > svg, .fd-mi:hover em { color: inherit; }
.fd-mi:hover em { opacity: .7; }
.fd-mi.new { color: var(--accent); }
.fd-mi.new:hover { color: var(--bg); }
.fd-mi em { margin-left: auto; font-style: normal; color: var(--text-faint); font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
</style>
