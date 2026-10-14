<script setup>
// 「查找卫星」对话框（STK Standard Object Database / KeepTrack Find Satellites 同款）：
// 左栏条件（关键词 + 编目四项 + 几何五项），右栏结果表；结果可「显示为图层」「存为卫星组」「加入组」。
// 条件的判定逻辑不在这里（shared/satFilter.js），本组件只铺格子、收结果、发动作。
import { ref, watch, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
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
  { key: 'addto', label: '加入组', icon: 'folder-input', title: '把选中的卫星加入某个卫星组' }
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

// 外壳是 AppDialog（Esc / 关闭钮关、点遮罩不关；z 与其它模态同档）。
// Esc 由内到外：「加入组」菜单开着先关菜单（window 捕获相截停，AppDialog 收不到）；
// 对话框里自己用 Esc 的控件先让它处理、这一下不关框：结果筛选框有字 = 清字；结果表有选中 = 清选择；
// 数字框 = 丢草稿并失焦（下一下 Esc 再关对话框）。判定要在控件处理之前（处理完字已清空），
// 故在正文捕获相记一笔，AppDialog 冒泡段发来的 close 见这笔就不关（整个派发结束后清掉）。
let keepOpen = false
function onBodyEsc(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  const t = e.target
  if (t instanceof Element && ((t.matches('.slf input') && t.value) || (t.matches('.slvp') && t.closest('.sl.hassel')) || t.matches('.satfb input'))) {
    keepOpen = true
    setTimeout(() => { keepOpen = false }, 0)
  }
}
function onClose() { if (!keepOpen) emit('close') }
function onMenuEsc(e) {
  if (e.key !== 'Escape' || e.isComposing || !addMenu.value) return
  e.stopPropagation(); addMenu.value = null
}
watch(addMenu, (m) => (m ? window.addEventListener('keydown', onMenuEsc, true) : window.removeEventListener('keydown', onMenuEsc, true)))
watch(() => props.open, (o) => { if (!o) addMenu.value = null })
onBeforeUnmount(() => window.removeEventListener('keydown', onMenuEsc, true))
</script>

<template>
  <AppDialog :open="open" title="查找卫星" width="min(760px, 94vw)" flush dialog-class="fd-dlg" @close="onClose">
      <template #head><span class="fd-n">命中 {{ matched }} 颗</span></template>
      <div class="fd-body" @keydown.capture="onBodyEsc">
        <div class="fd-crit">
          <div class="fd-kw">
            <span class="fd-si"><Icon name="search" :size="12" /></span>
            <input class="search-field" :value="keyword" placeholder="名称 / 编号 / 星座" spellcheck="false" @input="emit('update:keyword', $event.target.value)" />
            <span v-if="keyword" class="fd-x" title="清除关键词" @click="emit('update:keyword', '')"><Icon name="x" :size="12" /></span>
          </div>
          <SatFilterBar expanded :model-value="filters" :satcat="satcat" :pool="pool" :matched="-1" @update:model-value="(f) => emit('update:filters', f)" />
          <div class="fd-cf"><span class="lnk" title="清空关键词与全部条件" @click="emit('clear')"><Icon name="x" :size="12" /> 清空条件</span></div>
        </div>
        <div class="fd-res">
          <SatList
            :items="results" :reset-key="resetKey" :actions="ACTIONS" :rows="18"
            placeholder="在结果中筛选" empty="无匹配卫星。"
            @action="onAction" @activate="(it) => emit('activate', it)"
          />
        </div>
      </div>
  </AppDialog>
  <!-- 「加入组」菜单挂到 body（z 走 --z-menu，压在对话框之上；不进框体，免得被正文滚动区裁掉） -->
  <Teleport to="body">
    <template v-if="open && addMenu">
      <div class="fd-mbd menu-mask" @mousedown="addMenu = null"></div>
      <div class="fd-menu menu" role="menu" :style="{ left: addMenu.x + 'px', top: addMenu.y + 'px' }">
        <div class="fd-mh menu-hd" data-i18n-skip>加入 {{ addMenu.sats.length }} 颗</div>
        <button type="button" class="fd-mi menu-item new" role="menuitem" @click="addTo(null)"><span class="menu-ico"><Icon name="folder-plus" :size="12" /></span><span>新建组</span></button>
        <button type="button" v-for="g in groups" :key="g.id" class="fd-mi menu-item" role="menuitem" @click="addTo(g)"><span class="menu-ico"><Icon name="layers" :size="12" /></span><span data-i18n-skip>{{ g.name }}</span><em class="menu-kbd" data-i18n-skip>{{ g.count }}</em></button>
      </div>
    </template>
  </Teleport>
</template>

<style>
/* 框体定高（结果表要撑满）：dialogClass 落在 AppDialog 内部元素上，scoped 够不着，故不 scoped */
.adlg.fd-dlg { height: min(560px, calc(100vh - 48px)); }
</style>

<style scoped>
/* 外壳归 AppDialog；题条里关闭钮前的命中数 */
.fd-n { flex: none; align-self: center; padding: 0 10px; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fd-body { height: 100%; min-height: 0; display: flex; }
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
/* 「加入组」菜单：外观走 controls.css 的菜单基线（.menu / .menu-item / .menu-hd / .menu-ico / .menu-kbd / .menu-mask）；
   这里只留定位与宽高、组标题的通栏底线、「新建组」机位色字（悬停让给基线蓝块） */
.fd-menu { position: fixed; width: 200px; min-width: 0; max-height: 280px; }
.fd-mh { margin: 0 -4px 4px; padding: 3px 14px 5px; border-bottom: 1px solid var(--border); }
.fd-mi.new { color: var(--accent); }
.fd-mi em { font-style: normal; font-variant-numeric: tabular-nums; }
</style>
