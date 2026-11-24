<script setup>
// 星座侧栏：按来源分区，共用一份有序注册表与显隐状态。目录汇总视图单独收进「目录参考」。
//   · 卫星图标        显 / 隐（可多开，地图 = 所有可见集的并集）
//   · Alt + 卫星图标  仅显示这一集（其余暂隐；顶部出现「仅显示：X」，点它还原）
//   · 点行        展开 / 收起成员表（同一时刻只开一处）
//   · 聚焦        只走菜单「聚焦」（双击行聚焦已取消：点行展开时连点两下极易误触，一下把地球转走）
//   · 拖行尾把手  调整组内顺序（松手落位）；菜单提供组内上移 / 下移
//   · 改名        F2 / 菜单「重命名」（行给了 renamable 才行：卫星天线树的名字不归这里管）；行尾「⋯」与右键 = 同一份菜单，条目由宿主按种类给（menuItems(row)）
// 新建统一走顶部「＋」菜单（宿主给 addItems）。本组件只管呈现与本地 UI 态（改名 / 菜单 / 两步删除 / 拖拽 / 搜索下拉开合），
// 数据与动作全在宿主（emit 出去）。输入只查找候选，主动显示搜索结果才改变地图。
// 搜索下拉可关：Esc（焦点在搜索框里）/ 在搜索行外按下鼠标 / 点选一条结果 → 收起；再输入、点回搜索框（有关键词时）、关键词被
// 宿主改了，或宿主递增 search.openTick（标题栏搜索桥，同一个词再搜也算）→ 重新展开。结果行的「＋」（加入 / 移出选中集）不收起，可以连着攒一批。
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { sectionsOf, sectionOf } from '../viz/constellation/satSetSections.js'
import Icon from './Icon.vue'
import SatList from './SatList.vue'
import CoverageTreeIcon from './CoverageTreeIcon.vue'

const props = defineProps({
  // 有序行：{ id, kind, name, lit, count, sub, color, colorable, visible, renamable, icon, iconTitle, modified }
  //   lit = 名字是界面词（卫星天线树 / 没改过名的内置星座 / 搜索结果），跟界面语言走；否则是用户起的名字（数据），挂 data-i18n-skip 不翻
  rows: { type: Array, default: () => [] },
  searchRow: { type: Object, default: null },            // 搜索结果那一行（钉在最上，不参与排序）
  summary: { type: Object, default: () => ({}) },        // { shown, layers, dataTime, status }
  solo: { type: Object, default: null },                 // { id, name, lit }
  expanded: { type: String, default: '' },
  expItems: { type: Array, default: () => [] },
  expLoading: { type: Boolean, default: false },
  expError: { type: String, default: '' },
  expActions: { type: Array, default: () => [] },
  // { keyword, openTick, results:[{ noradId, name, groupLabel, slot, picked, syn }], finderActive }
  //   （syn：天线树虚拟星，合成号不当 NORAD 显示；openTick：宿主要求重新展开下拉并聚焦搜索框时自增）
  search: { type: Object, default: () => ({ keyword: '', results: [], finderActive: false }) },
  menuItems: { type: Function, default: null },          // (row) => [{ key, label, icon, tone, sep }]
  addItems: { type: Array, default: () => [] },          // 「＋」菜单：[{ key, label, icon, sep }]
  epoch: { type: String, default: null },                // 场景历元（有自定义星座时才给）
  defaultColor: { type: String, default: '#4dabf7' }
})
const emit = defineEmits([
  'toggle', 'solo', 'restore', 'hide-all', 'restore-hidden', 'search-show', 'expand', 'action', 'add', 'reorder',
  'color', 'color-reset', 'rename',
  'search-input', 'search-clear', 'search-pick', 'search-toggle-pick', 'open-finder',
  'epoch', 'epoch-now', 'list-action', 'list-activate'
])
const sections = computed(() => {
  const groups = sectionsOf(props.rows).map(section => ({
    ...section,
    visibleCount: section.rows.filter(row => row.visible).length
  }))
  if (props.searchRow) groups.unshift({ id: 'search', rows: [props.searchRow] })
  return groups
})
const rowIdxMap = computed(() => new Map(props.rows.map((r, i) => [r.id, i])))
const collapsed = ref(new Set(['catalog']))
function toggleSection(id) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  collapsed.value = next
}
watch(() => props.rows.map((r) => [r.id, r.visible]), (rows, old = []) => {
  const before = new Map(old)
  let next = null
  for (const [id, visible] of rows) {
    if ((!before.has(id) && old.length) || (visible && !before.get(id))) {
      const row = props.rows.find((r) => r.id === id)
      const sec = row ? sectionOf(row) : ''
      if (sec && collapsed.value.has(sec)) {
        if (!next) next = new Set(collapsed.value)
        next.delete(sec)
      }
    }
  }
  if (next) collapsed.value = next
}, { immediate: true })
watch(() => props.expanded, (id) => {
  const row = props.rows.find((r) => r.id === id)
  if (row && collapsed.value.has(sectionOf(row))) toggleSection(sectionOf(row))
})
const allCatalogVisible = computed(() => props.rows.some((r) => r.id === 'g:all' && r.visible))

/* —— 行内改名 —— */
const renameId = ref('')
const renameVal = ref('')
let rnEl = null
const setRnEl = (el) => { rnEl = el }
function startRename(row) {
  if (!row || !row.renamable) return
  renameId.value = row.id; renameVal.value = row.name
  nextTick(() => { try { if (rnEl) { rnEl.focus(); rnEl.select() } } catch { /* ignore */ } })
}
// 改名走 F2 或菜单「重命名」（双击名字不改名：名字占满整行，误触面太大）。
// F2 改的是指针下那一行，指针不在行上则改展开着的那一行；焦点在文本框里的 F2 归文本框
function onRenameKey(e) {
  if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (!bodyEl.value || !bodyEl.value.getClientRects().length) return   // 星座视图没在显示
  const active = t?.closest?.('.lp-row') || bodyEl.value.querySelector('.lp-row:hover')
  const row = active ? props.rows[Number(active.dataset.idx)] : props.rows.find((r) => r.id === props.expanded)
  if (!row || !row.renamable) return
  e.preventDefault()
  startRename(row)
}
onMounted(() => window.addEventListener('keydown', onRenameKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onRenameKey))
function commitRename(row) {
  if (renameId.value !== row.id) return
  const v = renameVal.value.trim()
  renameId.value = ''
  if (v && v !== row.name) emit('rename', row, v)
}

/* —— 菜单（行菜单 / ＋菜单）+ 两步删除 —— */
const menu = ref(null)   // { kind:'row'|'add', row, items, x, y }
function place(items, x0, y0) {
  const W = 200, H = Math.min(360, items.length * 26 + 12)
  return { x: Math.max(4, Math.min(x0, window.innerWidth - W - 4)), y: Math.max(4, Math.min(y0, window.innerHeight - H - 4)) }
}
// Esc 关菜单：捕获相挂在 window 上并截停，免得同一下 Esc 再被宿主页当成别的快捷键（清选择 / 退聚焦）。
// 输入法组字中的 Esc 是撤销组字，不关。
function onMenuKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.stopPropagation(); e.preventDefault()
  closeMenu()
}
function openMenu(ev, row) {
  if (!props.menuItems) return
  const items = (props.menuItems(row) || []).filter(Boolean)
  if (!items.length) return
  const anchor = ev.currentTarget.getBoundingClientRect()
  const [x, y] = ev.type === 'click' ? [anchor.right - 200, anchor.bottom + 2] : [ev.clientX, ev.clientY]
  menu.value = { kind: 'row', row, items, ...place(items, x, y) }
  window.addEventListener('keydown', onMenuKey, true)
}
function openAdd(ev) {
  const items = (props.addItems || []).filter(Boolean)
  if (!items.length) return
  const r = ev.currentTarget.getBoundingClientRect()
  // 右缘对齐 ＋ 钮、向面板内展开：＋ 在搜索行最右，左缘对齐会把 200px 的菜单甩出侧栏压到画布上
  menu.value = { kind: 'add', row: null, items, ...place(items, r.right - 200, r.bottom + 4) }
  window.addEventListener('keydown', onMenuKey, true)
}
function closeMenu() { menu.value = null; window.removeEventListener('keydown', onMenuKey, true) }
const delArm = ref('')
let armT = 0
function onItem(it) {
  const m = menu.value; if (!m) return
  closeMenu()
  if (m.kind === 'add') { emit('add', it.key); return }
  const row = m.row
  if (it.key === 'rename') { startRename(row); return }
  if (it.key === 'delete') {
    if (delArm.value === row.id) { clearTimeout(armT); delArm.value = ''; emit('action', 'delete', row); return }
    delArm.value = row.id; clearTimeout(armT)
    armT = setTimeout(() => { delArm.value = '' }, 5000)
    return
  }
  emit('action', it.key, row)
}
const itemLabel = (it, row) => (row && it.key === 'delete' && delArm.value === row.id ? '确认删除' : it.label)
function confirmDelete(row) { delArm.value = ''; emit('action', 'delete', row) }
onBeforeUnmount(() => { clearTimeout(armT); endDrag(); window.removeEventListener('keydown', onMenuKey, true); document.removeEventListener('mousedown', onDocDown, true) })

/* —— 搜索下拉的开合（本地 UI 态；结果本身由宿主给） —— */
const searchEl = ref(null)
const dropOpen = ref(false)
// 外部按下：捕获相挂在 document 上，只在下拉开着时挂；落在搜索行里（输入框 / 下拉 / 行内按钮）不收
function onDocDown(e) { if (searchEl.value && searchEl.value.contains(e.target)) return; setDrop(false) }
function setDrop(v) {
  if (dropOpen.value === !!v) return
  dropOpen.value = !!v
  if (v) document.addEventListener('mousedown', onDocDown, true)
  else document.removeEventListener('mousedown', onDocDown, true)
}
function onSearchInput(ev) { const v = ev.target.value; setDrop(!!v); emit('search-input', v) }
function onSearchReopen() { if (props.search && props.search.keyword) setDrop(true) }   // 聚焦 / 点击搜索框：有关键词就重新展开
// Esc 收起：真收起了一份看得见的下拉才截停（否则照常往外走，宿主的 Esc 照旧生效）；输入法组字中的 Esc 归输入法
function onSearchKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  const shown = dropOpen.value && !!props.search.keyword
  setDrop(false)
  if (shown) { e.stopPropagation(); e.preventDefault() }
}
function onResultPick(it) { setDrop(false); emit('search-pick', it) }
// 关键词被宿主改了（标题栏「在星座中搜索」桥 / 点选后清空 / 清除）：有词就展开、空了就收起。
// immediate：面板重挂（关掉轨道向导）时关键词还在 → 照旧展开
watch(() => props.search && props.search.keyword, (k) => setDrop(!!k), { immediate: true })
// 标题栏「在星座中搜索」每调一次 openTick 自增（同一个词再搜也变）：重新展开并把焦点交给搜索框
watch(() => props.search && props.search.openTick, () => {
  if (props.search && props.search.keyword) setDrop(true)
  nextTick(() => { const el = searchEl.value && searchEl.value.querySelector('input'); if (el) { try { el.focus() } catch { /* ignore */ } } })
})

/* —— 卫星图标：普通点 = 显隐；Alt + 点 = 仅显示 —— */
function onEye(ev, row) { if (ev.altKey) emit('solo', row); else emit('toggle', row) }
const eyeTitle = (row) => (row.visible ? '隐藏此项' : '显示此项') + '；同一卫星也可能出现在其他显示项中'

/* —— 拖拽排序：按住行尾把手拖，松手落位 —— */
const bodyEl = ref(null)
const topEl = ref(null)
const footEl = ref(null)
const drag = ref(null)   // { id, from, to }
let dragEl = null
// 真正在滚的那一层：侧栏把整块面板放进自己的滚动区时 .lp-body 并不滚（高度被内容撑开），
// 贴边自动滚动要找到那个祖先，否则拖到列表下缘什么也不发生。
function scrollHost() {
  let el = bodyEl.value
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return null
}
function rowEls() { return bodyEl.value ? Array.from(bodyEl.value.querySelectorAll('.lp-row[data-idx]')).filter((el) => !drag.value || sectionOf(props.rows[Number(el.dataset.idx)]) === drag.value.section) : [] }
function dropIndexAt(y) {
  const els = rowEls()
  let idx = els.length
  for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { idx = i; break } }
  return idx
}
function onGripDown(ev, row) {
  if (ev.button !== 0) return
  ev.preventDefault(); ev.stopPropagation()
  dragEl = ev.currentTarget
  try { dragEl.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
  const peers = props.rows.filter((r) => sectionOf(r) === sectionOf(row))
  const from = peers.findIndex((r) => r.id === row.id)
  drag.value = { id: row.id, from, to: from, section: sectionOf(row) }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, true)
  window.addEventListener('pointercancel', endDrag, true)
}
function onDragMove(ev) {
  const d = drag.value; if (!d) return
  const sc = scrollHost()
  if (sc) {   // 贴边自动滚动；上沿取钉住的搜索行下缘、下沿取钉住的页脚上缘（它们盖在滚动区上 / 下沿）
    const r = sc.getBoundingClientRect()
    const top = topEl.value ? Math.max(r.top, topEl.value.getBoundingClientRect().bottom) : r.top
    const bot = footEl.value ? Math.min(r.bottom, footEl.value.getBoundingClientRect().top) : r.bottom
    if (ev.clientY < top + 24) sc.scrollTop -= 8
    else if (ev.clientY > bot - 24) sc.scrollTop += 8
  }
  d.to = dropIndexAt(ev.clientY)
}
function onDragUp() {
  const d = drag.value
  endDrag()
  if (!d) return
  // to 是「落在第 to 行之前」；越过自己时下标要少算一位
  let to = d.to
  if (to > d.from) to -= 1
  const peers = props.rows.filter((r) => sectionOf(r) === d.section)
  if (to !== d.from && peers[to]) emit('reorder', d.id, props.rows.findIndex((r) => r.id === peers[to].id))
}
function endDrag() {
  drag.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp, true)
  window.removeEventListener('pointercancel', endDrag, true)
  dragEl = null
}
const dropBefore = (idx, section) => { const d = drag.value; return !!d && d.section === section && d.to === idx && d.from !== idx && d.from + 1 !== idx }
const dropAfterLast = (section) => { const d = drag.value; return !!d && d.section === section.id && d.to === section.rows.length && d.from !== section.rows.length - 1 }
</script>

<template>
  <div class="lp">
    <div ref="topEl" class="lp-top">
      <div class="lp-toolbar">
        <div ref="searchEl" class="lp-search">
          <span class="lp-si"><Icon name="search" :size="12" /></span>
          <input class="search-field" :value="search.keyword" placeholder="查找卫星名称 / NORAD 编号" aria-label="查找卫星名称或 NORAD 编号" spellcheck="false" @input="onSearchInput" @focus="onSearchReopen" @click="onSearchReopen" @keydown="onSearchKey" />
          <button type="button" v-if="search.keyword" class="lp-x ibtn sm" title="清除" @click="emit('search-clear')"><Icon name="x" :size="12" /></button>
          <button type="button" class="lp-ib" :class="{ on: search.finderActive }" :aria-pressed="search.finderActive ? 'true' : 'false'" title="查找卫星：按所有者 / 对象类型 / 状态 / 发射年 / 轨道区制 / 近远地点 / 倾角 / 周期" @click="emit('open-finder')"><Icon name="filter" :size="12" /></button>
          <div v-if="dropOpen && search.keyword" class="lp-drop menu">
            <div class="lp-search-state">{{ search.loading ? '正在查找…' : search.results?.length ? '匹配卫星' : '无匹配卫星' }}</div>
            <div v-for="it in search.results" :key="it.noradId" class="lp-di" :class="{ picked: it.picked }" @click="onResultPick(it)">
              <div class="lp-dt">
                <div class="lp-dn" data-i18n-skip>{{ it.name }}</div>
                <div class="lp-ds" data-i18n-skip>{{ it.groupLabel }}<template v-if="!it.syn"> · NORAD {{ it.noradId }}</template><span v-if="it.slot"> · {{ it.slot }}</span></div>
              </div>
              <button type="button" :aria-pressed="it.picked ? 'true' : 'false'" class="lp-dp ibtn sm" :title="it.picked ? '已在选中集中，点击移出' : '加入选中集'" @click.stop="emit('search-toggle-pick', it)"><Icon :name="it.picked ? 'check' : 'plus'" :size="12" /></button>
            </div>
            <button v-if="search.results?.length" type="button" class="lp-show-hits" @click="setDrop(false); emit('search-show')"><Icon name="eye" :size="12" />仅显示匹配卫星</button>
          </div>
        </div>
        <button type="button" class="lp-ib lp-add" title="新建卫星组、生成星座或导入星历" aria-haspopup="menu" @click="openAdd"><Icon name="plus" :size="14" /><span>添加</span></button>
      </div>
      <div v-if="summary.saveState === 'error'" class="lp-save-error" role="alert">显示设置保存失败</div>
      <!-- 读数行是界面语汇 + 数字，跟界面语言走（不整行 skip）；只有「仅显示：」后面那个用户起的集名不翻（lit = 界面词才翻） -->
      <div class="lp-sum">
        <span class="lp-sn">显示 {{ summary.shown ?? 0 }} 颗 · {{ summary.layers ?? 0 }} 项</span>
        <button v-if="!summary.allHidden" type="button" class="lp-text-btn" @click="emit('hide-all')">全部隐藏</button>
      </div>
      <div v-if="solo" class="lp-mode">
        <span class="lp-mode-name">仅显示：<span :data-i18n-skip="solo.lit ? null : ''">{{ solo.name }}</span></span>
        <button type="button" class="lp-text-btn" @click="emit('restore')">恢复之前显示</button>
      </div>
      <div v-if="summary.allHidden" class="lp-mode"><span>已全部隐藏</span><button v-if="summary.canRestoreHidden" type="button" class="lp-text-btn" @click="emit('restore-hidden')">恢复之前显示</button></div>
      <div v-if="allCatalogVisible" class="lp-warning" role="status">全量目录显示中</div>
      <div v-if="summary.status" class="lp-load-state" role="status">{{ summary.status }}</div>
      <div v-else-if="summary.dataTime" class="lp-data-time">OMM {{ summary.dataTime }}</div>
    </div>

    <div ref="bodyEl" class="lp-body" :class="{ dragging: !!drag }">
      <div v-if="!sections.length" class="lp-empty">暂无卫星集。</div>
      <section v-for="section in sections" :key="section.id" class="lp-section">
        <div v-if="section.title" class="lp-section-head">
          <button type="button" class="lp-section-toggle" :aria-expanded="!collapsed.has(section.id)" :title="section.tip" @click="toggleSection(section.id)">
            <Icon name="chevron-right" class="lp-arrow" :class="{ open: !collapsed.has(section.id) }" :size="12" />
            <span>{{ section.title }}</span><span class="lp-section-count">{{ section.visibleCount }} 显示 · {{ section.rows.length }} 项</span>
          </button>
          <button v-if="section.add" type="button" class="ibtn sm" :title="'添加' + section.title" @click="emit('add', section.add)"><Icon name="plus" :size="12" /></button>
        </div>
        <div v-if="!collapsed.has(section.id)" class="lp-branch" :class="{ pinned: !section.title }">
          <template v-for="(row, idx) in section.rows" :key="row.id">
            <div v-if="dropBefore(idx, section.id)" class="lp-dropline"></div>
            <div class="lp-row" :data-idx="rowIdxMap.get(row.id)"
                 :class="{ off: !row.visible, exp: expanded === row.id, arm: delArm === row.id, dragsrc: drag?.id === row.id, ctx: menu?.row?.id === row.id }"
                 @click="emit('expand', row)" @contextmenu.prevent.stop="openMenu($event, row)">
              <button type="button" class="lp-chev" :aria-expanded="expanded === row.id" :title="expanded === row.id ? '收起成员' : '展开成员'" @click.stop="emit('expand', row)">
                <Icon name="chevron-right" class="lp-arrow" :class="{ open: expanded === row.id }" :size="12" />
              </button>
              <button type="button" class="ibtn lp-eye" :aria-pressed="row.visible" :aria-label="(row.visible ? '隐藏' : '显示') + row.name" :title="eyeTitle(row)" @click.stop="onEye($event, row)">
                <CoverageTreeIcon kind="satellite" :visible="row.visible" />
              </button>
              <input v-if="renameId === row.id" :ref="setRnEl" v-model="renameVal" class="lp-rn" :aria-label="'重命名' + row.name"
                     @click.stop @keydown.enter="commitRename(row)" @keydown.esc.stop="renameId = ''" @blur="commitRename(row)" />
              <button v-else type="button" class="lp-nm" :aria-expanded="expanded === row.id" :title="row.name + (row.sub ? ' · ' + row.sub : '') + ' · 查看成员'" @click.stop="emit('expand', row)">
                <span :data-i18n-skip="row.lit ? null : ''">{{ row.name }}</span><i v-if="row.modified" class="lp-mod" title="已改动过（可在菜单中重置）"></i>
                <small class="lp-cnt" :title="row.count === '' ? '尚未加载' : row.count + ' 颗卫星'" data-i18n-skip>{{ row.count === '' ? '—' : row.count }}</small>
                <span v-if="row.sub" class="lp-sub">{{ row.sub }}</span>
              </button>
              <div class="lp-actions">
                <label v-if="row.colorable" class="lp-sw" :title="'星点颜色（' + (row.color || '未设置') + '）'" @click.stop>
                  <span class="lp-swi" :class="{ unset: !row.color }" :style="{ backgroundColor: row.color }"></span>
                  <input type="color" :aria-label="'星点颜色 · ' + row.name" :value="row.color || defaultColor" @input="emit('color', row, $event.target.value)" />
                </label>
                <span v-else class="lp-sw fixed"><span class="lp-swi" :style="{ backgroundColor: row.color || defaultColor }"></span></span>
                <button type="button" class="ibtn sm lp-only" :class="{ on: solo?.id === row.id }" :aria-pressed="solo?.id === row.id" :title="solo?.id === row.id ? '恢复之前显示' : '仅显示此项'" @click.stop="solo?.id === row.id ? emit('restore') : emit('solo', row)">
                  <Icon name="scan-eye" :size="13" />
                </button>
                <button type="button" aria-haspopup="menu" class="ibtn sm lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, row)"><Icon name="ellipsis" :size="14" /></button>
                <span v-if="section.rows.length > 1" class="lp-grip" title="拖动调整组内顺序" @pointerdown="onGripDown($event, row)" @click.stop><Icon name="grip-vertical" :size="12" /></span>
              </div>
            </div>
            <div v-if="delArm === row.id" class="lp-delete-confirm" role="alert">
              <span>删除此项？</span><button type="button" class="lp-text-btn" @click="delArm = ''">取消</button><button type="button" class="lp-text-btn danger" @click="confirmDelete(row)">确认删除</button>
            </div>
            <SatList v-if="expanded === row.id" :items="expItems" :reset-key="row.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
                     :placeholder="'在「' + row.name + '」里筛选'" :empty="row.kind === 'search' ? '无匹配卫星。' : '该集暂无卫星。'"
                     @action="(k, p) => emit('list-action', k, p, row)" @activate="(it) => emit('list-activate', it, row)" />
          </template>
          <div v-if="dropAfterLast(section)" class="lp-dropline"></div>
        </div>
      </section>
    </div>

    <div v-if="epoch !== null" ref="footEl" class="lp-foot" title="全部自定义星座共用的场景历元：星座定向以此为准，拖时间轴仍从此历元向后推演">
      <label>场景历元</label>
      <input class="ci" type="datetime-local" :value="epoch" @change="emit('epoch', $event.target.value)" />
      <button type="button" class="btn ghost sm" title="取当前时刻为场景历元" @click="emit('epoch-now')">当前</button>
    </div>

    <template v-if="menu">
      <div class="lp-mbd menu-mask" @mousedown="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div class="lp-menu menu" role="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <div v-if="menu.row" class="lp-mh menu-hd" :data-i18n-skip="menu.row.lit ? null : ''">{{ menu.row.name }}</div>
        <template v-for="(it, i) in menu.items" :key="(it.key || 'sep') + i">
          <div v-if="it.sep" class="lp-msep menu-sep" role="separator"></div>
          <button v-else type="button" class="lp-mi menu-item" role="menuitem" :class="[it.tone || '', { warn: menu.row && it.key === 'delete' && delArm === menu.row.id, dis: it.disabled }]" @click="!it.disabled && onItem(it)">
            <span v-if="it.icon" class="menu-ico"><Icon :name="it.icon" :size="12" /></span><span>{{ itemLabel(it, menu.row) }}</span><em v-if="it.hint" class="menu-kbd" data-i18n-skip>{{ it.hint }}</em>
          </button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lp { display: flex; flex-direction: column; min-height: 0; height: 100%; }
/* 搜索行 / 页脚钉住：侧栏把整块面板放进自己的滚动区时，展开一组长成员表再往下滚，
   搜索框与 ＋ 会跟着滚走。sticky 让它们贴在滚动区上 / 下沿（.lp-body 自己滚时 sticky 不起作用，也无害）。 */
.lp-top { flex: none; padding: 8px 12px 6px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px;
          position: sticky; top: 0; z-index: 4; background: var(--surface); }   /* 比页脚高一档：搜索下拉在它的层叠上下文里，不能被页脚盖住 */
.lp-search { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; gap: 4px; }
.lp-search input { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 24px 0 24px; box-sizing: border-box; }
.lp-si { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.lp-x { position: absolute; right: calc(var(--h-ctl) + 8px); top: 50%; transform: translateY(-50%); }
.lp-ib { flex: none; width: var(--h-ctl); height: var(--h-ctl); display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-muted); border-radius: var(--r-ctl); cursor: pointer; padding: 0; }
.lp-ib:hover { border-color: var(--field-border-hover); color: var(--text); }
/* 过滤开关开着 = 小号图标开关（spec P9）：机位色字 / 描边 + 淡罩 */
.lp-ib.on { border-color: var(--accent-ui); color: var(--accent-ui); background: var(--accent-ui-weak); }
/* ＋ 是墨色主操作，走 --primary-* token：深色下压一档，不再是近白块；悬停换 token 色而不是 brightness 滤镜。
   必须在 .lp-ib:hover 之后（否则悬停时被它的描边 / 字色盖掉）；按下由全局 button 按下罩提供，
   不写 :active 背景（会压成浅灰底纸色字） */
.lp-add { background: var(--primary-fill); border-color: var(--primary-fill); color: var(--primary-on); }
.lp-add:hover { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); color: var(--primary-on); }
/* 搜索结果下拉：浮层外观走菜单基线 .menu（结果行是带「加入 / 移出」小钮的列表行，不套 .menu-item）；这里只留挂在搜索框下的定位与高度 */
.lp-drop { position: absolute; left: 0; right: 0; top: calc(100% + 2px); min-width: 0; max-height: 280px; padding: 0; animation-name: ui-float-in; }
.lp-di { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; }
.lp-di:hover { background: var(--wash-hover); }
/* 已在选中集里：与列表选中同一机位色 */
.lp-di.picked .lp-dn, .lp-di.picked .lp-dp { color: var(--accent-ui); }
.lp-dt { flex: 1; min-width: 0; }
.lp-dn { font-size: var(--fs-3); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-ds { font-size: var(--fs-1); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
/* 行高钉整像素：1.5 × 11px = 16.5px，读数行与「仅显示」小标的上下缘落在半像素上发虚 */
.lp-sum { display: flex; align-items: center; gap: 8px; font-size: var(--fs-2); color: var(--text-faint); line-height: 16px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.lp-sn { white-space: nowrap; }

.lp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 8px; }
.lp-body.dragging { cursor: grabbing; user-select: none; }
.lp-empty { padding: 6px 0; font-size: var(--fs-2); color: var(--text-faint); }
.lp-section { padding: 5px 0; }
.lp-section + .lp-section { border-top: 1px solid var(--border); }
.lp-section-head, .lp-section-toggle { display: flex; align-items: center; gap: 6px; }
.lp-section-toggle, .lp-chev, .lp-nm { border: 0; background: transparent; padding: 0; color: inherit; font: inherit; cursor: pointer; }
.lp-section-toggle { flex: 1; min-width: 0; min-height: 26px; color: var(--text); text-align: left; font-size: var(--fs-3); font-weight: 600; }
.lp-section-count { margin-left: auto; font-size: var(--fs-1); color: var(--text-faint); font-weight: 400; font-variant-numeric: tabular-nums; }
.lp-arrow { flex: none; color: var(--text-faint); transition: transform var(--dur-2); }
.lp-arrow.open { transform: rotate(90deg); }
.lp-branch { margin-left: 6px; padding-left: 5px; border-left: 1px solid var(--border); }
.lp-branch.pinned { margin: 0; padding: 0; border: 0; }
.lp-row { display: flex; align-items: center; gap: 5px; padding: 3px 2px; min-height: 30px; box-sizing: border-box;
          color: var(--text); border-radius: var(--r-box); cursor: pointer; }
.lp-row.off { color: var(--text-muted); }
.lp-row:hover, .lp-row.ctx { background: var(--wash-hover); }
.lp-row.exp { box-shadow: inset 2px 0 var(--accent-ui); }
.lp-row.exp .lp-nm, .lp-nm:hover { color: var(--accent-ui); }
.lp-row.arm { box-shadow: inset 2px 0 var(--danger); }
.lp-row.dragsrc { opacity: .45; }
.lp-chev { display: grid; place-items: center; flex: none; width: 16px; height: 24px; }
.lp-eye { flex: none; width: 24px; height: 24px; padding: 0; }
.lp-nm { flex: 1; min-width: 0; text-align: left; font-size: var(--fs-4); line-height: 1.3; overflow-wrap: anywhere; }
.lp-mod { display: inline-block; width: 5px; height: 5px; margin-left: 4px; border-radius: 50%; background: var(--warn); vertical-align: middle; }
.lp-cnt, .lp-sub { color: var(--text-faint); font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.lp-cnt { margin-left: 4px; font-family: var(--font-mono); white-space: nowrap; }
.lp-sub { display: block; font-size: var(--fs-1); margin-top: 2px; }
.lp-rn { flex: 1; min-width: 0; }
.lp-actions { flex: none; display: flex; align-items: center; gap: 1px; padding-left: 4px; border-left: 1px solid var(--border); }
.lp-sw, .lp-grip { display: inline-grid; place-items: center; height: 22px; }
.lp-sw { position: relative; width: 18px; }
.lp-sw input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.lp-sw:focus-within { outline: 1px solid var(--accent-ui); border-radius: var(--r-ctl); }
.lp-swi { width: 10px; height: 10px; border-radius: var(--r-ctl); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 25%, transparent); }
.lp-swi.unset { background: repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in srgb, var(--text) 30%, transparent) 2px 3px); }
.lp-grip { width: 13px; color: var(--text-faint); opacity: 0; cursor: grab; touch-action: none; }
.lp-row:hover .lp-grip, .lp-row:focus-within .lp-grip, .lp-body.dragging .lp-grip { opacity: 1; }
.lp-dropline { position: relative; height: 2px; margin: -1px 0; background: var(--accent-ui); }
.lp-body :deep(.sl) { margin: 1px 0 5px 10px; border: 0; border-left: 1px solid var(--border); scroll-margin-block: 72px 40px; }
.lp-body :deep(.slm) { flex-wrap: wrap; gap: 4px; }
.lp-body :deep(.sln) { flex: 1 0 auto; }

.lp-foot { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--border); font-size: var(--fs-2); color: var(--text-muted);
           position: sticky; bottom: 0; z-index: 3; background: var(--surface); }
.lp-foot label { flex: none; }
.lp-foot .ci { flex: 1; min-width: 0; }

/* 命令菜单：外观走 controls.css 的菜单基线（.menu / .menu-item / .menu-hd / .menu-ico / .menu-kbd / .menu-sep / .menu-mask）。
   这里只留定位、宽高、组标题（行名）的通栏底线与省略号、删除待确认态红字、禁用项不吃指针。 */
.lp-menu { position: fixed; width: 200px; min-width: 0; max-height: 360px; }
/* 组标题：左右负边距抵掉外框内距，分隔线仍通栏 */
.lp-mh { margin: 0 -4px 4px; padding: 3px 14px 5px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-mi.warn { color: var(--danger); }
.lp-mi.dis { pointer-events: none; }
.lp-mi em { font-style: normal; font-variant-numeric: tabular-nums; }

.lp-toolbar { display: flex; align-items: center; gap: 6px; }
.lp-save-error, .lp-text-btn.danger { color: var(--danger); font-size: var(--fs-2); }
.lp-add { width: auto; gap: 3px; padding: 0 7px; font-size: var(--fs-2); }
.lp-sum { justify-content: space-between; }
.lp-text-btn { flex: none; border: 0; background: transparent; padding: 2px 4px; border-radius: var(--r-ctl); font-size: var(--fs-2); color: var(--accent-ui); cursor: pointer; }
.lp-text-btn:hover { background: var(--wash-hover); }
.lp-mode { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 3px 6px; background: var(--accent-ui-weak); border-radius: var(--r-ctl); font-size: var(--fs-2); }
.lp-mode-name { min-width: 0; overflow-wrap: anywhere; }
.lp-warning { color: var(--warn); font-size: var(--fs-1); }
.lp-load-state, .lp-data-time { color: var(--text-faint); font-size: var(--fs-1); overflow-wrap: anywhere; }
.lp-search-state { padding: 7px 9px; font-size: var(--fs-2); color: var(--text-faint); }
.lp-show-hits { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; padding: 8px; border: 0; border-top: 1px solid var(--border); background: var(--surface); color: var(--accent-ui); cursor: pointer; font-size: var(--fs-2); position: sticky; bottom: 0; }
.lp-show-hits:hover { background: var(--surface-2); }
.lp-delete-confirm { display: flex; align-items: center; gap: 6px; margin: 0 8px 6px 24px; padding: 4px 6px; border: 1px solid var(--danger); border-radius: var(--r-ctl); font-size: var(--fs-2); }
.lp-delete-confirm > span { flex: 1; color: var(--danger); }
</style>
