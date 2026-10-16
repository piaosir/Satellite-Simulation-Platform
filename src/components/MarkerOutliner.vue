<script setup>
// 地图标记 · 对象树（STK Object Browser / QGIS 图层面板口径）：三个图层（点标记 / 地球站 / 航迹）→ 各自的对象。
// 选中项的属性由宿主画在树下方的检查器里（对象树 + 属性检查器，设计稿 docs/地图标记面板重设计_2026-10-16.md）。
// 行的外观与手势照抄星座侧栏「卫星集」（SatLayersPanel）：24px 行、眼睛、⋯ 与右键同一份菜单、顶部 ＋。
//   · 单击 = 选中；双击对象 = 地图上定位；双击图层 = 展开 / 收起
//   · 键盘（树有焦点）：↑↓ 选中上 / 下一行，←→ 收起 / 展开，Enter 定位，Space 显隐，Delete 删除，F2 改名
//   · 记号只加在少数一方：可见是常态不标，隐藏（斜杠眼 + 压暗）/ 调整位置 / 绘制中才显形
// 本组件只管呈现与本地 UI 态（菜单 / 两步确认 / 键盘），数据与动作全在宿主（emit 出去）。
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import MarkLegend from './MarkLegend.vue'

const props = defineProps({
  // [{ key, name, visible, eyeTitle, total, count, open, legend, tools:[{ k, icon, title }],
  //    items:[{ id, mk, name, dim, sub, visible, eyeTitle, legend, tools }] }]
  //   name：图层名是界面词（跟语言走）；对象名是数据或已按语言生成的兜底名（dim = 兜底名，淡一档）
  groups: { type: Array, default: () => [] },
  sel: { type: Object, default: null },            // { g, id }；id 为空 = 选中图层行
  query: { type: String, default: '' },
  menuItems: { type: Function, default: null },    // (node) => [{ key, label, icon, tone, sep, on, confirm, disabled }]
  addItems: { type: Array, default: () => [] }     // 「＋」菜单：[{ key, label, icon, sep }]
})
const emit = defineEmits(['select', 'expand', 'toggle', 'action', 'add', 'query', 'table', 'locate'])

const keyOf = (n) => (n ? (n.id != null && n.id !== '' ? n.g + ':' + n.id : n.g) : '')
const selKey = computed(() => keyOf(props.sel))
const isSel = (g, id) => selKey.value === keyOf({ g, id })
const anyMatch = computed(() => props.groups.some((g) => g.items.length))

// 键盘走的是「看得见的行」：图层行 + 展开着的图层下的对象行
const flat = computed(() => {
  const out = []
  for (const g of props.groups) {
    out.push({ g: g.key })
    if (g.open) for (const it of g.items) out.push({ g: g.key, id: it.id })
  }
  return out
})

/* —— 菜单（行菜单 / ＋菜单）+ 两步确认 —— */
const menu = ref(null)   // { kind:'row'|'add', node, title, items, x, y }
function place(items, x0, y0) {
  const W = 208, H = Math.min(400, items.length * 26 + 40)
  return { x: Math.max(4, Math.min(x0, window.innerWidth - W - 4)), y: Math.max(4, Math.min(y0, window.innerHeight - H - 4)) }
}
// Esc 关菜单：捕获相截停，免得同一下 Esc 再被宿主当成别的快捷键；输入法组字中的 Esc 归输入法
function onMenuKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.stopPropagation(); e.preventDefault()
  closeMenu()
}
function nodeTitle(n) {
  const g = props.groups.find((x) => x.key === n.g)
  if (!g) return ''
  if (n.id == null || n.id === '') return g.name
  const it = g.items.find((x) => x.id === n.id)
  return it ? it.name : ''
}
function openMenu(ev, node) {
  if (!props.menuItems) return
  const items = (props.menuItems(node) || []).filter(Boolean)
  if (!items.length) return
  emit('select', node)
  menu.value = { kind: 'row', node, title: nodeTitle(node), items, ...place(items, ev.clientX, ev.clientY) }
  window.addEventListener('keydown', onMenuKey, true)
}
function openAdd(ev) {
  const items = (props.addItems || []).filter(Boolean)
  if (!items.length) return
  const r = ev.currentTarget.getBoundingClientRect()
  // 右缘对齐 ＋ 钮、向面板内展开（＋ 在顶栏最右，左缘对齐会把菜单甩出侧栏压到画布上）
  menu.value = { kind: 'add', node: null, title: '', items, ...place(items, r.right - 208, r.bottom + 4) }
  window.addEventListener('keydown', onMenuKey, true)
}
function closeMenu() { menu.value = null; window.removeEventListener('keydown', onMenuKey, true) }
const arm = ref('')      // 两步确认：待确认的「节点键|菜单项键」
let armT = 0
function onItem(it) {
  const m = menu.value
  if (!m || it.disabled) return
  if (m.kind === 'add') { closeMenu(); emit('add', it.key); return }
  if (it.confirm) {
    const k = keyOf(m.node) + '|' + it.key
    if (arm.value !== k) { arm.value = k; clearTimeout(armT); armT = setTimeout(() => { arm.value = '' }, 5000); return }   // 菜单不关，同一项再点一下才执行
    clearTimeout(armT); arm.value = ''
  }
  closeMenu()
  emit('action', it.key, m.node)
}
const armed = (it) => !!(menu.value && menu.value.node && arm.value === keyOf(menu.value.node) + '|' + it.key)

/* —— 键盘 —— */
const treeEl = ref(null)
function onKey(e) {
  if (menu.value || e.isComposing) return
  const t = e.target
  if (t && t !== treeEl.value && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
  const rows = flat.value
  const i = rows.findIndex((n) => keyOf(n) === selKey.value)
  const cur = i >= 0 ? rows[i] : null
  const isGrp = cur && (cur.id == null || cur.id === '')
  const grp = cur ? props.groups.find((g) => g.key === cur.g) : null
  const go = (n) => { if (n) { e.preventDefault(); emit('select', n) } }
  switch (e.key) {
    case 'ArrowDown': go(rows[Math.min(rows.length - 1, i + 1)] || rows[0]); break
    case 'ArrowUp': go(rows[Math.max(0, i - 1)] || rows[0]); break
    case 'Home': go(rows[0]); break
    case 'End': go(rows[rows.length - 1]); break
    case 'ArrowRight':
      if (!cur) break
      e.preventDefault()
      if (isGrp && grp && !grp.open && grp.total) emit('expand', grp.key)
      else if (isGrp && grp && grp.open && grp.items.length) emit('select', { g: grp.key, id: grp.items[0].id })
      break
    case 'ArrowLeft':
      if (!cur) break
      e.preventDefault()
      if (!isGrp) emit('select', { g: cur.g })
      else if (grp && grp.open) emit('expand', grp.key)
      break
    case 'Enter':
      if (!cur) break
      e.preventDefault()
      if (isGrp) emit('expand', cur.g); else emit('locate', cur)
      break
    case ' ':
      if (!cur) break
      e.preventDefault(); emit('toggle', cur)
      break
    case 'Delete':
      if (!cur || isGrp) break
      e.preventDefault(); emit('action', 'delete', cur)
      break
    case 'F2':
      if (!cur || isGrp) break
      e.preventDefault(); emit('action', 'rename', cur)
      break
  }
}

// 选中项换了（键盘 / 地图上点中 / 新建）：滚进树的可视区（只滚树自己，不带动整个侧栏）
watch(selKey, (k) => nextTick(() => {
  const box = treeEl.value
  const el = box && k ? box.querySelector(`[data-key="${CSS.escape(k)}"]`) : null
  if (!el) return
  const b = box.getBoundingClientRect(), r = el.getBoundingClientRect()
  if (r.top < b.top) box.scrollTop -= b.top - r.top
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom
}))

onBeforeUnmount(() => { clearTimeout(armT); window.removeEventListener('keydown', onMenuKey, true) })
</script>

<template>
  <div class="mko">
    <div class="mko-top">
      <div class="mko-search">
        <span class="mko-si"><Icon name="search" :size="12" /></span>
        <input class="search-field" :value="query" placeholder="搜索名称 / 坐标" spellcheck="false" @input="emit('query', $event.target.value)" @keydown.esc.stop="emit('query', '')" />
        <button v-if="query" type="button" class="mko-x ibtn sm" title="清除" @click="emit('query', '')"><Icon name="x" :size="12" /></button>
      </div>
      <button type="button" class="mko-ib" title="批量表格（Excel：增删改 / 批量粘贴 / 导入导出）" @click="emit('table')"><Icon name="table" :size="12" /></button>
      <button type="button" class="mko-ib mko-add" aria-haspopup="menu" title="新建标记" @click="openAdd"><Icon name="plus" :size="12" /></button>
    </div>

    <div ref="treeEl" class="mko-tree" role="tree" aria-label="地图标记" tabindex="0" @keydown="onKey">
      <template v-for="g in groups" :key="g.key">
        <div
          class="mko-row grp" role="treeitem" :data-key="g.key"
          :aria-expanded="g.open ? 'true' : 'false'" :aria-selected="isSel(g.key) ? 'true' : 'false'"
          :class="{ off: !g.visible, sel: isSel(g.key), ctx: !!(menu && menu.node && keyOf(menu.node) === g.key) }"
          @click="emit('select', { g: g.key })" @dblclick="emit('expand', g.key)" @contextmenu.prevent.stop="openMenu($event, { g: g.key })"
        >
          <button type="button" class="mko-tw" :class="{ none: !g.total }" tabindex="-1" :title="g.open ? '收起' : '展开'" @click.stop="emit('expand', g.key)" @dblclick.stop><Icon name="chevron-down" class="disc" :class="{ shut: !g.open }" :size="12" /></button>
          <button type="button" class="mko-eye" tabindex="-1" :aria-pressed="g.visible ? 'true' : 'false'" :title="g.eyeTitle" @click.stop="emit('toggle', { g: g.key })" @dblclick.stop><Icon :name="g.visible ? 'eye' : 'eye-off'" :size="12" /></button>
          <MarkLegend class="mko-lg" v-bind="g.legend" />
          <span class="mko-nm">{{ g.name }}</span>
          <button v-for="t in g.tools" :key="t.k" type="button" class="mko-tool" tabindex="-1" :title="t.title" @click.stop="emit('action', t.k, { g: g.key })" @dblclick.stop><Icon :name="t.icon" :size="12" /></button>
          <span class="mko-cnt" data-i18n-skip>{{ query ? g.count + '/' + g.total : g.total }}</span>
          <button type="button" class="mko-more" tabindex="-1" aria-haspopup="menu" title="更多操作（右键同）" @click.stop="openMenu($event, { g: g.key })" @dblclick.stop><Icon name="ellipsis" :size="12" /></button>
        </div>
        <template v-if="g.open">
          <div
            v-for="it in g.items" :key="it.id"
            class="mko-row it" role="treeitem" :data-key="g.key + ':' + it.id" :data-mk="it.mk"
            :aria-selected="isSel(g.key, it.id) ? 'true' : 'false'"
            :class="{ off: !it.visible, goff: !g.visible, sel: isSel(g.key, it.id), ctx: !!(menu && menu.node && keyOf(menu.node) === g.key + ':' + it.id) }"
            @click="emit('select', { g: g.key, id: it.id })" @dblclick="emit('locate', { g: g.key, id: it.id })" @contextmenu.prevent.stop="openMenu($event, { g: g.key, id: it.id })"
          >
            <button type="button" class="mko-eye" tabindex="-1" :aria-pressed="it.visible ? 'true' : 'false'" :title="it.eyeTitle" @click.stop="emit('toggle', { g: g.key, id: it.id })" @dblclick.stop><Icon :name="it.visible ? 'eye' : 'eye-off'" :size="12" /></button>
            <MarkLegend class="mko-lg" v-bind="it.legend" />
            <span class="mko-nm" :class="{ dim: it.dim }" data-i18n-skip>{{ it.name }}</span>
            <button v-for="t in it.tools" :key="t.k" type="button" class="mko-tool" tabindex="-1" :title="t.title" @click.stop="emit('action', t.k, { g: g.key, id: it.id })" @dblclick.stop><Icon :name="t.icon" :size="12" /></button>
            <span class="mko-sub" data-i18n-skip>{{ it.sub }}</span>
            <button type="button" class="mko-more" tabindex="-1" aria-haspopup="menu" title="更多操作（右键同）" @click.stop="openMenu($event, { g: g.key, id: it.id })" @dblclick.stop><Icon name="ellipsis" :size="12" /></button>
          </div>
        </template>
      </template>
      <div v-if="query && !anyMatch" class="mko-empty">无匹配标记。</div>
    </div>

    <template v-if="menu">
      <div class="mko-mbd menu-mask" @mousedown="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div class="mko-menu menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <div v-if="menu.title" class="mko-mh menu-hd" :data-i18n-skip="menu.node && menu.node.id ? '' : null">{{ menu.title }}</div>
        <template v-for="(it, i) in menu.items" :key="(it.key || 'sep') + i">
          <div v-if="it.sep" class="menu-sep" role="separator"></div>
          <button v-else type="button" class="mko-mi menu-item" role="menuitem" :class="[it.tone || '', { warn: armed(it), dis: it.disabled }]" @click="onItem(it)">
            <span class="menu-ico"><Icon :name="it.on ? 'check' : (it.icon || 'circle')" :size="12" :class="{ blank: !it.on && !it.icon }" /></span><span>{{ armed(it) ? '确认删除' : it.label }}</span><em v-if="it.hint" class="menu-kbd" data-i18n-skip>{{ it.hint }}</em>
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
:where(button).mko-tw, :where(button).mko-eye, :where(button).mko-more, :where(button).mko-tool { margin: 0; padding: 0; border: 0; background: none; color: inherit; text-align: inherit; }
.mko { display: flex; flex-direction: column; min-height: 0; }

/* 顶栏：吸在侧栏滚动区上沿（同卫星集 .lp-top） */
.mko-top { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.mko-search { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }
.mko-search input { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 24px; box-sizing: border-box; }
.mko-si { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.mko-x { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); }
.mko-ib { flex: none; width: var(--h-ctl); height: var(--h-ctl); display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-muted); border-radius: var(--r-ctl); cursor: pointer; padding: 0; }
.mko-ib:hover { border-color: var(--field-border-hover); color: var(--text); }
/* ＋ 是墨色主操作（同卫星集 .lp-add） */
.mko-add { background: var(--primary-fill); border-color: var(--primary-fill); color: var(--primary-on); }
.mko-add:hover { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); color: var(--primary-on); }

/* 树：高度封顶自己滚，检查器始终跟在下面不被挤出视野 */
.mko-tree { max-height: min(46vh, 520px); overflow-y: auto; padding: 4px 0 6px; outline: none; }
.mko-row { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 2px 8px 2px 6px; font-size: var(--fs-3); color: var(--text); white-space: nowrap; cursor: default; user-select: none; }
.mko-row.it { padding-left: 26px; }   /* 箭头列 14 + 间距 6 + 行首 6：对象的眼睛落在图层眼睛的正下方 */
.mko-row.grp:not(:first-child) { margin-top: 2px; }
.mko-row:hover { background: var(--wash-hover); }
/* 选中：实底 + 机位色挂条（同卫星集展开行）；树有键盘焦点时再加一圈贴身框 */
.mko-row.sel { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent-ui); }
.mko-row.sel:hover { background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.mko-tree:focus-visible .mko-row.sel { box-shadow: inset 2px 0 0 var(--accent-ui), inset 0 0 0 1px color-mix(in srgb, var(--accent-ui) 60%, transparent); }
.mko-row.ctx { box-shadow: inset 0 0 0 1px var(--border-strong); }
.mko-row.sel.ctx { box-shadow: inset 2px 0 0 var(--accent-ui), inset 0 0 0 1px var(--border-strong); }
/* 隐藏（自己或所在图层）：名称 / 小样 / 读数压暗；眼睛不压，留着点回来的提示 */
.mko-row.off :is(.mko-nm, .mko-lg, .mko-sub, .mko-cnt), .mko-row.goff :is(.mko-nm, .mko-lg, .mko-sub) { opacity: .45; }
.mko-nm, .mko-lg, .mko-sub, .mko-cnt { transition: opacity var(--dur-2) linear; }

.mko-tw { flex: none; width: 14px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; }
.mko-tw:hover { color: var(--text); }
.mko-tw.none { visibility: hidden; }
.mko-eye { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); cursor: pointer; transition: var(--t-state); }
.mko-eye:hover { color: var(--text); background: var(--wash-hover); }
.mko-eye:active { box-shadow: var(--press); transition-duration: 0s; }
/* 对象行的眼睛：可见是常态 → 悬停 / 选中才显形；隐藏的常显斜杠眼（少数一方才带记号） */
.mko-row.it:not(.off) .mko-eye { opacity: 0; }
.mko-row.it:hover .mko-eye, .mko-row.it.sel .mko-eye { opacity: 1; color: var(--text-muted); }
.mko-row.off .mko-eye { color: var(--text-muted); }
.mko-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mko-nm.dim { color: var(--text-muted); }
.mko-sub { flex: none; max-width: 52%; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.mko-cnt { flex: none; min-width: 22px; text-align: right; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
/* 状态记号（调整位置 / 绘制中）：开着才出现，机位色；点它 = 关掉 */
.mko-tool { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--accent-ui); border-radius: var(--r-box); cursor: pointer; transition: var(--t-state); }
.mko-tool:hover { background: var(--wash-hover); }
.mko-more { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); opacity: 0; cursor: pointer; transition: var(--t-state); }
.mko-row:hover .mko-more, .mko-row.ctx .mko-more { opacity: 1; }
.mko-more:hover { color: var(--text); background: var(--wash-hover); }
.mko-more:active { box-shadow: var(--press); transition-duration: 0s; }
.mko-empty { padding: 4px 12px 6px 32px; font-size: var(--fs-2); color: var(--text-faint); }

/* 命令菜单：外观走 controls.css 的菜单基线；这里只留定位、标题行、待确认红字 */
.mko-menu { position: fixed; width: 208px; min-width: 0; max-height: 400px; }
.mko-mh { margin: 0 -4px 4px; padding: 3px 14px 5px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mko-mi.warn { color: var(--danger); }
.mko-mi.dis { pointer-events: none; opacity: var(--dis-opacity, .45); }
.mko-mi.danger { color: var(--danger); }
.mko-mi em { font-style: normal; font-variant-numeric: tabular-nums; }
.menu-ico .blank { visibility: hidden; }
</style>
