<script setup>
// 配置列表的多级文件夹树（五个工作台共用：GEO / NGSO / 再生式 / 端到端 / 雨衰）。
// —— 纯展示组件：只接收「已按工作台过滤的扁平数组」+ 状态，派生树并 emit 交互，绝不直接碰 api.store.*。
// 存储、guardedLeave、serializeState 等差异全部留在各自父组件（经 shared/useConfigTree.js 统一），
// 这样一套组件安全服务五个 app。
//
// 数据模型：扁平数组 + parentId 邻接表。文件夹 { id, type:'folder', name, parentId }；配置项带可选 parentId。
// 派生：孤儿容错——parentId 为空或指向本作用域外的项，一律落根，避免残留 parentId 让配置凭空消失。
//
// ★ 层级几何（改过一次，别再退回去）：行的名称起点必须与深度严格单调。早先文件夹比配置多一个 13px
//   图标位，而缩进步长只有 12px，于是「文件夹里的配置」名称起点 = 24+12d，父文件夹 = 41+12d ——
//   每进一层子项名字反而向左退 5px，层级完全读不出来。现在两类行都占同一个图标位，步长 14px，
//   名称起点统一为 41+14d；再加每层一根绝对定位的导引线（父子归属跨行也看得见）。
import { ref, reactive, computed, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { flattenTree } from '../shared/useConfigTree.js'

const props = defineProps({
  items: { type: Array, default: () => [] },        // 已按工作台过滤（配置 + 文件夹）
  activeId: { type: [String, Number], default: null },   // 已载入到工作区的那一份
  focusId: { type: [String, Number], default: null },    // 键盘/右键的落点（与 activeId 分离，见 useConfigTree）
  cutId: { type: [String, Number], default: null },
  editingId: { type: [String, Number], default: null },
  editingName: { type: String, default: '' },
  expanded: { type: Object, default: () => new Set() }   // 展开的文件夹 id 集合（响应式 Set）
})
const emit = defineEmits([
  'select', 'toggle', 'delete', 'context', 'move', 'focus',
  'add-config', 'add-folder', 'rename-start', 'rename-input', 'rename-commit', 'rename-cancel'
])

const INDENT = 14   // 每层缩进（导引线位置与之绑定，改这里两处一起动）

// 可见行与 useConfigTree 的键盘导航共用同一份 flatten：两边各写一份的话，
// 「↓ 到下一行」迟早会跟眼睛看到的顺序对不上
const rows = computed(() => flattenTree(props.items, props.expanded))

// 拖拽某文件夹时其全部后代（含自身）——落入这些即成环，禁止
function descendantsOf(id) {
  const items = props.items || []
  const set = new Set([id])
  let grew = true
  while (grew) { grew = false; for (const it of items) { if (it.parentId != null && set.has(it.parentId) && !set.has(it.id)) { set.add(it.id); grew = true } } }
  return set
}

// —— 拖拽状态 ——
const rootEl = ref(null)
const dragId = ref(null)
const forbidden = ref(new Set())          // 本次拖拽禁止落入的 id（拖拽项自身/其子孙）
const dropTarget = reactive({ id: null, zone: null })   // zone: 'before' | 'after' | 'inside'
const overRoot = ref(false)
let suppressClick = false                 // 拖拽结束后抑制那一次合成 click，避免误触发 select/toggle

function onDragStart(e, row) {
  if (props.editingId === row.item.id) { e.preventDefault(); return }
  dragId.value = row.item.id
  forbidden.value = row.isFolder ? descendantsOf(row.item.id) : new Set([row.item.id])
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(row.item.id)) } catch (_) { /* 某些环境无 dataTransfer */ }
}
function zoneFor(e, row) {
  const r = e.currentTarget.getBoundingClientRect()
  const y = r.height ? (e.clientY - r.top) / r.height : 0.5
  if (row.isFolder) return y < 0.28 ? 'before' : (y > 0.72 ? 'after' : 'inside')   // 文件夹三区
  return y < 0.5 ? 'before' : 'after'                                              // 配置两区（不可 inside）
}
function onDragOver(e, row) {
  if (dragId.value == null) return
  overRoot.value = false
  // ★ 滚屏先于「能不能落这儿」的判断：刚拖起来时指针就压在自己身上（禁落项），
  //   若跟着一起 return，往上拖到视野外的目标就永远滚不动。
  autoScroll(e)
  if (forbidden.value.has(row.item.id)) { dropTarget.id = null; dropTarget.zone = null; scheduleExpand(null); return }
  e.preventDefault()
  try { e.dataTransfer.dropEffect = 'move' } catch (_) { /* ignore */ }
  dropTarget.id = row.item.id
  dropTarget.zone = zoneFor(e, row)
  // 悬停在折叠文件夹上片刻即展开：否则「拖进折叠文件夹里的某个具体位置」这件事根本做不到
  scheduleExpand(row.isFolder && dropTarget.zone === 'inside' && !props.expanded.has(row.item.id) ? row.item.id : null)
}
function onDrop(e, row) {
  e.preventDefault(); e.stopPropagation()
  const id = dragId.value
  if (id == null || forbidden.value.has(row.item.id)) { resetDrag(); return }
  const zone = zoneFor(e, row)
  if (zone === 'inside') emit('move', { dragId: id, parentId: row.item.id, anchorId: null, position: 'inside' })
  else emit('move', { dragId: id, parentId: row.item.parentId != null ? row.item.parentId : null, anchorId: row.item.id, position: zone })
  resetDrag()
}
function onRootOver(e) {
  if (dragId.value == null) return
  e.preventDefault()
  autoScroll(e)
  if (e.target === e.currentTarget) { overRoot.value = true; dropTarget.id = null; dropTarget.zone = null; scheduleExpand(null) }
}
function onRootDrop(e) {
  if (dragId.value == null) return
  e.preventDefault()
  emit('move', { dragId: dragId.value, parentId: null, anchorId: null, position: 'inside' })   // 落根空白 = 移到根末尾
  resetDrag()
}
function resetDrag() {
  dragId.value = null; dropTarget.id = null; dropTarget.zone = null; overRoot.value = false; forbidden.value = new Set()
  scheduleExpand(null); stopScroll()
  suppressClick = true; setTimeout(() => { suppressClick = false }, 0)
}

// —— 悬停展开（拖拽中）——
let expandT = null, expandFor = null
function scheduleExpand(id) {
  if (expandFor === id) return
  clearTimeout(expandT); expandFor = id
  if (id == null) return
  expandT = setTimeout(() => {
    const it = (props.items || []).find((x) => x.id === id)
    if (it && it.type === 'folder' && !props.expanded.has(id)) emit('toggle', it)
  }, 600)
}

// —— 边缘自动滚屏（拖拽中）——
// HTML5 拖拽不会自己滚容器：列表一长，把项拖到视野外的目标上就成了不可能的操作。
// 滚的是本树最近的可滚动祖先（各 App 的 .lb-col-bd），不是本组件自己。
let scrollRaf = 0, scrollDir = 0
function scrollerEl() {
  let el = rootEl.value && rootEl.value.parentElement
  while (el && el.scrollHeight <= el.clientHeight + 1) el = el.parentElement
  return el
}
function autoScroll(e) {
  const box = scrollerEl()
  if (!box) return
  const r = box.getBoundingClientRect()
  const EDGE = 26
  scrollDir = (e.clientY - r.top < EDGE) ? -1 : ((r.bottom - e.clientY < EDGE) ? 1 : 0)
  if (scrollDir && !scrollRaf) tickScroll(box)
}
function tickScroll(box) {
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    if (!scrollDir || dragId.value == null) return
    box.scrollTop += scrollDir * 9
    tickScroll(box)
  })
}
function stopScroll() { scrollDir = 0; if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0 } }
onBeforeUnmount(() => { clearTimeout(expandT); stopScroll() })

function onRowClick(row) {
  if (suppressClick || props.editingId === row.item.id) return
  emit('focus', row.item)
  if (row.isFolder) emit('toggle', row.item)
  else emit('select', row.item)
}
</script>

<template>
  <div ref="rootEl" class="lb-tree" :class="{ rootdrop: overRoot }" @dragover="onRootOver" @drop="onRootDrop">
    <div v-if="!rows.length" class="lb-empty">暂无配置</div>
    <div
      v-for="row in rows" :key="row.item.id"
      class="lb-tree-row"
      :class="{
        folder: row.isFolder,
        on: !row.isFolder && row.item.id === activeId,
        focus: row.item.id === focusId,
        cut: row.item.id === cutId,
        dragging: row.item.id === dragId,
        dropbefore: dropTarget.id === row.item.id && dropTarget.zone === 'before',
        dropafter: dropTarget.id === row.item.id && dropTarget.zone === 'after',
        dropinside: dropTarget.id === row.item.id && dropTarget.zone === 'inside'
      }"
      :style="{ paddingLeft: (6 + row.depth * 14) + 'px' }"
      :draggable="editingId !== row.item.id"
      :title="row.item.name"
      @click="onRowClick(row)"
      @dblclick.stop="emit('rename-start', row.item)"
      @contextmenu.stop.prevent="emit('context', $event, row.item)"
      @dragstart="onDragStart($event, row)"
      @dragend="resetDrag"
      @dragover="onDragOver($event, row)"
      @drop="onDrop($event, row)"
    >
      <!-- 层级导引线：每层一根，绝对定位贯通整行高度（含 padding），相邻行连成一条竖线 -->
      <span v-for="d in row.depth" :key="'g' + d" class="lb-tree-guide" :style="{ left: (13 + (d - 1) * 14) + 'px' }"></span>

      <span v-if="row.isFolder" class="lb-tree-chev" @click.stop="emit('toggle', row.item)">
        <Icon :name="expanded.has(row.item.id) ? 'chevron-down' : 'chevron-right'" :size="12" />
      </span>
      <span v-else class="lb-tree-chev empty"></span>
      <!-- ★ 两类行都占这个图标位：名称起点因此与深度严格单调（见文件头注） -->
      <span class="lb-tree-fi" :class="{ cfg: !row.isFolder }">
        <Icon :name="row.isFolder ? (expanded.has(row.item.id) ? 'folder-open' : 'folder') : 'file-text'" :size="12" />
      </span>

      <input
        v-if="editingId === row.item.id"
        class="lb-tree-rename" :value="editingName" :draggable="false"
        @click.stop @dblclick.stop @dragstart.stop.prevent
        @input="emit('rename-input', $event.target.value)"
        @keyup.enter="emit('rename-commit')" @keyup.esc="emit('rename-cancel')" @blur="emit('rename-commit')"
      />
      <span v-else class="lb-tree-nm" data-i18n-skip>{{ row.item.name }}</span>

      <span v-if="row.isFolder" class="lb-tree-count">{{ row.childCount }}</span>
      <!-- 动作区悬浮在行右端，不参与流：占位的话名称就少掉三个钮的宽度，
           而这栏默认才 210px，名字当场被挤成省略号（同 LbLibrary 的 .lbl-row-acts 范式） -->
      <span v-if="editingId !== row.item.id" class="lb-tree-acts">
        <button v-if="row.isFolder" class="lb-tree-ico" title="在此新建配置" @click.stop="emit('add-config', row.item.id)"><Icon name="plus" :size="12" /></button>
        <button v-if="row.isFolder" class="lb-tree-ico" title="新建子文件夹" @click.stop="emit('add-folder', row.item.id)"><Icon name="folder-plus" :size="12" /></button>
        <button class="lb-tree-ico del" :title="row.isFolder ? '删除文件夹（含子项）' : '删除配置'" @click.stop="emit('delete', row.item)"><Icon name="x" :size="12" /></button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.lb-tree { list-style: none; margin: 0; padding: 0; min-height: 100%; user-select: none; }
.lb-tree.rootdrop { box-shadow: inset 0 0 0 1.5px var(--accent-ui); border-radius: var(--r-ctl); }

.lb-tree-row {
  position: relative; display: flex; align-items: flex-start; gap: 4px;
  padding: 5px 6px; font-size: var(--fs-3); cursor: pointer;
  border-radius: var(--r-ctl); color: var(--text-muted);
}
.lb-tree-row:hover { background: var(--surface-2); color: var(--text); }
.lb-tree-row.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent-ui); }
.lb-tree-row.folder { color: var(--text); }
/* 焦点项＝键盘与右键的落点，与「已载入」（.on）分开：右键时看得出在对哪一行操作 */
.lb-tree-row.focus { box-shadow: inset 0 0 0 1px var(--border-strong); }
.lb-tree-row.on.focus { box-shadow: inset 2px 0 0 var(--accent-ui), inset 0 0 0 1px var(--border-strong); }
.lb-tree-row.cut { opacity: .5; }
.lb-tree-row.dragging { opacity: .4; }
/* 拖放指示：插入线（before/after）用 inset box-shadow 不占位；落入文件夹用环 + 底色 */
.lb-tree-row.dropbefore { box-shadow: inset 0 2px 0 var(--accent-ui); }
.lb-tree-row.dropafter { box-shadow: inset 0 -2px 0 var(--accent-ui); }
.lb-tree-row.dropinside { background: var(--surface-2); box-shadow: inset 0 0 0 1.5px var(--accent-ui); }

/* 层级导引线：top/bottom 拉满整行（含 5px 上下 padding），逐行首尾相接 */
.lb-tree-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--border); pointer-events: none; }
.lb-tree-row:hover .lb-tree-guide, .lb-tree-row.on .lb-tree-guide { background: var(--border-strong); }

/* 图标在第一行文本的高度内居中（行是 flex-start，名称可能换行） */
.lb-tree-chev { flex: none; width: 14px; height: 1.35em; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); }
.lb-tree-chev:not(.empty):hover { color: var(--text); background: var(--bg); }
/* 文件夹＝骨架（accent），配置＝内容（弱一档）：类型一眼可分，又不喧宾夺主 */
.lb-tree-fi { flex: none; height: 1.35em; display: inline-flex; align-items: center; color: var(--accent); }
.lb-tree-fi.cfg { color: var(--text-faint); }
.lb-tree-row.on .lb-tree-fi.cfg { color: var(--accent); }
/* 名称过长时换行、不截断（这栏默认 210px，配置名常带站名+口径，一省略就认不出是哪条）。
   折行第二行从本 span 的左缘起，也就是名称起点——层级不会因此断掉。 */
.lb-tree-nm { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
/* 计数徽标紧跟名称（空文件夹显示 0，与「未展开」区分开）；hover 时让位给动作区 */
.lb-tree-count { flex: none; margin-top: 1px; font-size: var(--fs-1); line-height: 1; padding: 2px 5px; border-radius: var(--r-pill); background: var(--surface-2); color: var(--text-faint); }
.lb-tree-row.on .lb-tree-count { background: var(--bg); }
.lb-tree-row:hover .lb-tree-count { visibility: hidden; }

/* 动作区：绝对定位悬浮，自带底色遮住其下的文字（行 hover 底色同为 --surface-2，接得上） */
.lb-tree-acts { position: absolute; top: 3px; right: 4px; display: none; align-items: center; gap: 1px; padding: 1px 2px; border-radius: var(--r-ctl); background: var(--surface-2); }
.lb-tree-row:hover .lb-tree-acts { display: inline-flex; }
.lb-tree-ico { flex: none; font: inherit; padding: 0 3px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); display: inline-flex; align-items: center; }
.lb-tree-ico:hover { color: var(--text); }
.lb-tree-ico.del:hover { color: var(--danger); }

.lb-tree-rename { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-3); padding: 2px 5px; background: var(--field-bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-tree-rename:focus { outline: none; }

.lb-empty { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; padding: 12px 6px; }
</style>
