<script setup>
// 配置列表的多级文件夹树（GEO / NGSO 链路预算共用）。
// —— 纯展示组件：只接收「已按模块过滤的扁平数组」+ 状态，派生树并 emit 交互，绝不直接碰 api.store.*。
// 存储、guardedLeave、serializeState/orbitType 等差异全部留在各自父组件，这样一套组件安全服务两个 app。
//
// 数据模型：扁平数组 + parentId 邻接表。文件夹 { id, type:'folder', name, parentId }；配置项带可选 parentId。
// 派生：孤儿容错——parentId 为空或指向本作用域外的项，一律落根，避免残留 parentId 让配置凭空消失。
import { ref, reactive, computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  items: { type: Array, default: () => [] },        // 已按模块过滤（配置 + 文件夹）
  activeId: { type: [String, Number], default: null },
  cutId: { type: [String, Number], default: null },
  editingId: { type: [String, Number], default: null },
  editingName: { type: String, default: '' },
  expanded: { type: Object, default: () => new Set() }   // 展开的文件夹 id 集合（响应式 Set）
})
const emit = defineEmits([
  'select', 'toggle', 'delete', 'context', 'move',
  'add-config', 'add-folder', 'rename-start', 'rename-input', 'rename-commit', 'rename-cancel'
])

// —— 派生可见行（深度优先，折叠的文件夹不展开其子）——
const rows = computed(() => {
  const items = props.items || []
  const ids = new Set(items.map((i) => i.id))
  const childrenOf = new Map()
  const roots = []
  for (const it of items) {
    const p = (it.parentId != null && ids.has(it.parentId)) ? it.parentId : null   // 孤儿容错
    if (p == null) roots.push(it)
    else { if (!childrenOf.has(p)) childrenOf.set(p, []); childrenOf.get(p).push(it) }
  }
  const out = []
  const walk = (list, depth) => {
    for (const it of list) {
      const kids = childrenOf.get(it.id) || []
      const isFolder = it.type === 'folder'
      out.push({ item: it, depth, isFolder, childCount: kids.length })
      if (isFolder && kids.length && props.expanded.has(it.id)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return out
})

// 拖拽某文件夹时其全部后代（含自身）——落入这些即成环，禁止
function descendantsOf(id) {
  const items = props.items || []
  const set = new Set([id])
  let grew = true
  while (grew) { grew = false; for (const it of items) { if (it.parentId != null && set.has(it.parentId) && !set.has(it.id)) { set.add(it.id); grew = true } } }
  return set
}

// —— 拖拽状态 ——
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
  if (forbidden.value.has(row.item.id)) { dropTarget.id = null; dropTarget.zone = null; return }
  e.preventDefault()
  try { e.dataTransfer.dropEffect = 'move' } catch (_) { /* ignore */ }
  dropTarget.id = row.item.id
  dropTarget.zone = zoneFor(e, row)
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
  if (e.target === e.currentTarget) { overRoot.value = true; dropTarget.id = null; dropTarget.zone = null }
}
function onRootDrop(e) {
  if (dragId.value == null) return
  e.preventDefault()
  emit('move', { dragId: dragId.value, parentId: null, anchorId: null, position: 'inside' })   // 落根空白 = 移到根末尾
  resetDrag()
}
function resetDrag() {
  dragId.value = null; dropTarget.id = null; dropTarget.zone = null; overRoot.value = false; forbidden.value = new Set()
  suppressClick = true; setTimeout(() => { suppressClick = false }, 0)
}

function onRowClick(row) {
  if (suppressClick || props.editingId === row.item.id) return
  if (row.isFolder) emit('toggle', row.item)
  else emit('select', row.item)
}
</script>

<template>
  <div class="lb-tree" :class="{ rootdrop: overRoot }" @dragover="onRootOver" @drop="onRootDrop">
    <div v-if="!rows.length" class="lb-empty">暂无配置<br />＋ 添加配置 · ▸ 新建文件夹分组</div>
    <div
      v-for="row in rows" :key="row.item.id"
      class="lb-tree-row"
      :class="{
        folder: row.isFolder,
        on: !row.isFolder && row.item.id === activeId,
        cut: row.item.id === cutId,
        dragging: row.item.id === dragId,
        dropbefore: dropTarget.id === row.item.id && dropTarget.zone === 'before',
        dropafter: dropTarget.id === row.item.id && dropTarget.zone === 'after',
        dropinside: dropTarget.id === row.item.id && dropTarget.zone === 'inside'
      }"
      :style="{ paddingLeft: (6 + row.depth * 12) + 'px' }"
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
      <span v-if="row.isFolder" class="lb-tree-chev" @click.stop="emit('toggle', row.item)">
        <Icon :name="expanded.has(row.item.id) ? 'chevron-down' : 'chevron-right'" :size="13" />
      </span>
      <span v-else class="lb-tree-chev empty"></span>
      <span v-if="row.isFolder" class="lb-tree-fi">
        <Icon :name="expanded.has(row.item.id) ? 'folder-open' : 'folder'" :size="13" />
      </span>

      <input
        v-if="editingId === row.item.id"
        class="lb-tree-rename" :value="editingName" :draggable="false"
        @click.stop @dblclick.stop @dragstart.stop.prevent
        @input="emit('rename-input', $event.target.value)"
        @keyup.enter="emit('rename-commit')" @keyup.esc="emit('rename-cancel')" @blur="emit('rename-commit')"
      />
      <span v-else class="lb-tree-nm">{{ row.item.name }}</span>

      <span v-if="row.isFolder && row.childCount" class="lb-tree-count">{{ row.childCount }}</span>
      <span v-if="editingId !== row.item.id" class="lb-tree-sp"></span>
      <template v-if="editingId !== row.item.id">
        <button v-if="row.isFolder" class="lb-tree-ico" title="新建子文件夹" @click.stop="emit('add-folder', row.item.id)"><Icon name="folder-plus" :size="12" /></button>
        <button class="lb-tree-ico del" :title="row.isFolder ? '删除文件夹（含子项）' : '删除配置'" @click.stop="emit('delete', row.item)"><Icon name="x" :size="12" /></button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lb-tree { list-style: none; margin: 0; padding: 0; min-height: 100%; user-select: none; }
.lb-tree.rootdrop { box-shadow: inset 0 0 0 1.5px var(--accent); border-radius: var(--r-ctl); }

.lb-tree-row {
  position: relative; display: flex; align-items: flex-start; gap: 4px;
  padding: 5px 6px; font-size: 12px; cursor: pointer;
  border-radius: var(--r-ctl); color: var(--text-muted);
}
.lb-tree-row:hover { background: var(--surface-2); color: var(--text); }
.lb-tree-row.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.lb-tree-row.folder { color: var(--text); }
.lb-tree-row.cut { opacity: .5; }
.lb-tree-row.dragging { opacity: .4; }
/* 拖放指示：插入线（before/after）用 inset box-shadow 不占位；落入文件夹用环 + 底色 */
.lb-tree-row.dropbefore { box-shadow: inset 0 2px 0 var(--accent); }
.lb-tree-row.dropafter { box-shadow: inset 0 -2px 0 var(--accent); }
.lb-tree-row.dropinside { background: var(--surface-2); box-shadow: inset 0 0 0 1.5px var(--accent); }

.lb-tree-chev { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 3px; }
.lb-tree-chev:not(.empty):hover { color: var(--text); background: var(--bg); }
.lb-tree-fi { flex: none; display: inline-flex; align-items: center; color: var(--accent); }
/* 名称自然宽度、过长时换行（不横向滚动、不截断）；min-width:0 允许在 flex 里收缩换行 */
.lb-tree-nm { flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; line-height: 1.3; }
/* 计数徽标紧跟名称；spacer 放其后把操作按钮顶到右缘 */
.lb-tree-count { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 8px; background: var(--surface-2); color: var(--text-faint); }
.lb-tree-sp { flex: 1 1 auto; min-width: 4px; align-self: stretch; }
.lb-tree-row.on .lb-tree-count, .lb-tree-row:hover .lb-tree-count { background: var(--bg); }

.lb-tree-ico { flex: none; font: inherit; padding: 0 3px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); opacity: 0; display: inline-flex; align-items: center; }
.lb-tree-row:hover .lb-tree-ico { opacity: 1; }
.lb-tree-ico:hover { color: var(--text); }
.lb-tree-ico.del:hover { color: var(--danger); }

.lb-tree-rename { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 2px 5px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-tree-rename:focus { outline: none; }

.lb-empty { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; padding: 12px 6px; }
</style>
