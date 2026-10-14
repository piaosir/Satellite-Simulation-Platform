<script setup>
// 星座侧栏 · 卫星集面板：卫星天线树 / 内置星座 / 卫星组 / 导入星历 / 自定义星座 摊成【一张有序表】，每一行同一套控件与手势。
//   · 眼睛        显 / 隐（可多开，地图 = 所有可见集的并集）
//   · Alt + 眼睛  仅显示这一集（其余暂隐；顶部出现「仅显示：X」，点它还原）
//   · 点行        展开 / 收起成员表（同一时刻只开一处）
//   · 聚焦        只走菜单「聚焦」（双击行聚焦已取消：点行展开时连点两下极易误触，一下把地球转走）
//   · 拖行首把手  调顺序（松手落位）；键盘党用菜单的 上移 / 下移 / 置顶
//   · 改名        F2 / 菜单「重命名」（行给了 renamable 才行：卫星天线树的名字不归这里管）；行尾「⋯」与右键 = 同一份菜单，条目由宿主按种类给（menuItems(row)）
// 新建统一走顶部「＋」菜单（宿主给 addItems）。本组件只管呈现与本地 UI 态（改名 / 菜单 / 两步删除 / 拖拽 / 搜索下拉开合），
// 数据与动作全在宿主（emit 出去）。
// 搜索下拉可关：Esc（焦点在搜索框里）/ 在搜索行外按下鼠标 / 点选一条结果 → 收起；再输入、点回搜索框（有关键词时）、关键词被
// 宿主改了，或宿主递增 search.openTick（标题栏搜索桥，同一个词再搜也算）→ 重新展开。结果行的「＋」（加入 / 移出选中集）不收起，可以连着攒一批。
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import SatList from './SatList.vue'

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
  'toggle', 'solo', 'restore', 'expand', 'action', 'add', 'reorder',
  'color', 'color-reset', 'rename',
  'search-input', 'search-clear', 'search-pick', 'search-toggle-pick', 'open-finder',
  'epoch', 'epoch-now', 'list-action', 'list-activate'
])

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
  const hov = bodyEl.value.querySelector('.lp-row[data-idx]:hover')
  const row = hov ? props.rows[Number(hov.dataset.idx)] : props.rows.find((r) => r.id === props.expanded)
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
  menu.value = { kind: 'row', row, items, ...place(items, ev.clientX, ev.clientY) }
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
    delArm.value = row.id; clearTimeout(armT); armT = setTimeout(() => { delArm.value = '' }, 5000)
    return
  }
  emit('action', it.key, row)
}
const itemLabel = (it, row) => (row && it.key === 'delete' && delArm.value === row.id ? '确认删除' : it.label)
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
  const shown = dropOpen.value && !!(props.search && props.search.results && props.search.results.length)
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

/* —— 眼睛：普通点 = 显隐；Alt + 点 = 仅显示 —— */
function onEye(ev, row) { if (ev.altKey) emit('solo', row); else emit('toggle', row) }
const eyeTitle = (row) => (row.visible ? '隐藏（Alt + 点击：仅显示该集）' : '显示（Alt + 点击：仅显示该集）')

/* —— 拖拽排序：按住行首把手拖，松手落位 —— */
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
function rowEls() { return bodyEl.value ? Array.from(bodyEl.value.querySelectorAll('.lp-row[data-idx]')) : [] }
function dropIndexAt(y) {
  const els = rowEls()
  let idx = els.length
  for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { idx = i; break } }
  return idx
}
function onGripDown(ev, row, idx) {
  if (ev.button !== 0) return
  ev.preventDefault(); ev.stopPropagation()
  dragEl = ev.currentTarget
  try { dragEl.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
  drag.value = { id: row.id, from: idx, to: idx }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, true)
  window.addEventListener('pointercancel', onDragUp, true)
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
  if (to !== d.from) emit('reorder', d.id, to)
}
function endDrag() {
  drag.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp, true)
  window.removeEventListener('pointercancel', onDragUp, true)
  dragEl = null
}
const dropBefore = (idx) => { const d = drag.value; return !!d && d.to === idx && d.from !== idx && d.from + 1 !== idx }
const dropAfterLast = () => { const d = drag.value; return !!d && d.to === props.rows.length && d.from !== props.rows.length - 1 }
</script>

<template>
  <div class="lp">
    <div ref="topEl" class="lp-top">
      <div ref="searchEl" class="lp-search">
        <span class="lp-si"><Icon name="search" :size="12" /></span>
        <input class="search-field" :value="search.keyword" placeholder="搜索名 / 编号" spellcheck="false" @input="onSearchInput" @focus="onSearchReopen" @click="onSearchReopen" @keydown="onSearchKey" />
        <button type="button" v-if="search.keyword" class="lp-x ibtn sm" title="清除" @click="emit('search-clear')"><Icon name="x" :size="12" /></button>
        <button type="button" class="lp-ib" :class="{ on: search.finderActive }" :aria-pressed="search.finderActive ? 'true' : 'false'" title="查找卫星：按所有者 / 对象类型 / 状态 / 发射年 / 轨道区制 / 近远地点 / 倾角 / 周期" @click="emit('open-finder')"><Icon name="filter" :size="12" /></button>
        <button type="button" class="lp-ib lp-add" title="添加：新建卫星组 / 生成卫星或星座 / 导入星历 / 从目录查找 / 找回删掉的内置星座" @click="openAdd"><Icon name="plus" :size="12" /></button>
        <div v-if="dropOpen && search.results && search.results.length" class="lp-drop menu">
          <div v-for="it in search.results" :key="it.noradId" class="lp-di" :class="{ picked: it.picked }" @click="onResultPick(it)">
            <div class="lp-dt">
              <div class="lp-dn" data-i18n-skip>{{ it.name }}</div>
              <div class="lp-ds" data-i18n-skip>{{ it.groupLabel }}<template v-if="!it.syn"> · NORAD {{ it.noradId }}</template><span v-if="it.slot"> · {{ it.slot }}</span></div>
            </div>
            <button type="button" :aria-pressed="it.picked ? 'true' : 'false'" class="lp-dp ibtn sm" :title="it.picked ? '已在选中集中，点击移出' : '加入选中集'" @click.stop="emit('search-toggle-pick', it)"><Icon :name="it.picked ? 'check' : 'plus'" :size="12" /></button>
          </div>
        </div>
      </div>
      <!-- 读数行是界面语汇 + 数字，跟界面语言走（不整行 skip）；只有「仅显示：」后面那个用户起的集名不翻（lit = 界面词才翻） -->
      <div class="lp-sum">
        <span class="lp-sn">显示 {{ summary.shown ?? 0 }} 颗 · {{ summary.layers ?? 0 }} 集<template v-if="summary.dataTime"> · OMM {{ summary.dataTime }}</template><template v-if="summary.status"> · {{ summary.status }}</template></span>
        <button type="button" v-if="solo" class="lp-solo" title="点击还原之前的显示" @click="emit('restore')"><span><span>仅显示：</span><span :data-i18n-skip="solo.lit ? null : ''">{{ solo.name }}</span></span><Icon name="x" :size="12" /></button>
      </div>
    </div>

    <div ref="bodyEl" class="lp-body" :class="{ dragging: !!drag }">
      <!-- 搜索结果：钉在最上，不参与排序 -->
      <template v-if="searchRow">
        <div
          class="lp-row pinned"
          :class="{ off: !searchRow.visible, exp: expanded === searchRow.id, solo: solo && solo.id === searchRow.id, ctx: !!(menu && menu.kind === 'row' && menu.row && menu.row.id === searchRow.id) }"
          @click="emit('expand', searchRow)" @contextmenu.prevent.stop="openMenu($event, searchRow)"
        >
          <span class="lp-grip none"></span>
          <button type="button" :aria-pressed="searchRow.visible ? 'true' : 'false'" class="lp-eye" :title="eyeTitle(searchRow)" @click.stop="onEye($event, searchRow)"><Icon :name="searchRow.visible ? 'eye' : 'eye-off'" :size="12" /></button>
          <span class="lp-sw fixed"><span class="lp-swi" :style="{ background: searchRow.color || defaultColor }"></span></span>
          <span class="lp-ki" title="搜索结果"><Icon name="search" :size="12" /></span>
          <span class="lp-nm" :title="searchRow.name" :data-i18n-skip="searchRow.lit ? null : ''">{{ searchRow.name }}</span>
          <span class="lp-cnt" data-i18n-skip>{{ searchRow.count }}</span>
          <button type="button" aria-haspopup="menu" class="lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, searchRow)"><Icon name="ellipsis" :size="12" /></button>
          <span class="lp-chev"><Icon name="chevron-down" class="disc" :class="{ shut: expanded !== searchRow.id }" :size="12" /></span>
        </div>
        <SatList
          v-if="expanded === searchRow.id"
          :items="expItems" :reset-key="searchRow.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
          :placeholder="'在「' + searchRow.name + '」里筛选'" empty="无匹配卫星。"
          @action="(k, p) => emit('list-action', k, p, searchRow)" @activate="(it) => emit('list-activate', it, searchRow)"
        />
      </template>
      <div v-if="!rows.length" class="lp-empty">暂无卫星集。</div>
      <template v-for="(row, idx) in rows" :key="row.id">
        <div v-if="dropBefore(idx)" class="lp-dropline"></div>
        <div
          class="lp-row" :data-idx="idx"
          :class="{ off: !row.visible, exp: expanded === row.id, solo: solo && solo.id === row.id, arm: delArm === row.id, dragsrc: drag && drag.id === row.id, ctx: !!(menu && menu.kind === 'row' && menu.row && menu.row.id === row.id) }"
          @click="emit('expand', row)"
          @contextmenu.prevent.stop="openMenu($event, row)"
        >
          <span class="lp-grip" title="拖动调整顺序" @pointerdown="onGripDown($event, row, idx)" @click.stop><Icon name="grip-vertical" :size="12" /></span>
          <button type="button" :aria-pressed="row.visible ? 'true' : 'false'" class="lp-eye" :title="eyeTitle(row)" @click.stop="onEye($event, row)"><Icon :name="row.visible ? 'eye' : 'eye-off'" :size="12" /></button>
          <label v-if="row.colorable" class="lp-sw" :title="'星点颜色（' + (row.color || '未设置') + '）'" @click.stop>
            <span class="lp-swi" :class="{ unset: !row.color }" :style="row.color ? { background: row.color } : null"></span>
            <input type="color" :value="row.color || defaultColor" @input="emit('color', row, $event.target.value)" />
          </label>
          <span v-else class="lp-sw fixed"><span class="lp-swi" :style="{ background: row.color || defaultColor }"></span></span>
          <span v-if="row.icon" class="lp-ki" :title="row.iconTitle || ''"><Icon :name="row.icon" :size="12" /></span>
          <input
            v-if="renameId === row.id" :ref="setRnEl" class="lp-rn" v-model="renameVal"
            @click.stop @keydown.enter="commitRename(row)" @keydown.esc.stop="renameId = ''" @blur="commitRename(row)"
          />
          <!-- 名字（连同悬停全名）是用户数据才不翻：skip 只挂内层；「已改动」小点的 title 是界面词，放在 skip 外面 -->
          <span v-else class="lp-nm"><span :title="row.name" :data-i18n-skip="row.lit ? null : ''">{{ row.name }}</span><i v-if="row.modified" class="lp-mod" title="已改动过（可在菜单中重置）"></i></span>
          <!-- 副读数全是界面语汇 + 日期（「星历 · 起 → 止」/ 格式名 · 导入日 / Walker 码「53° · 单星」），不含用户数据，不 skip -->
          <span v-if="row.sub" class="lp-sub">{{ row.sub }}</span>
          <span class="lp-cnt" data-i18n-skip>{{ row.count }}</span>
          <button type="button" aria-haspopup="menu" class="lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, row)"><Icon name="ellipsis" :size="12" /></button>
          <span class="lp-chev"><Icon name="chevron-down" class="disc" :class="{ shut: expanded !== row.id }" :size="12" /></span>
        </div>
        <SatList
          v-if="expanded === row.id"
          :items="expItems" :reset-key="row.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
          :placeholder="'在「' + row.name + '」里筛选'" empty="该集暂无卫星。"
          @action="(k, p) => emit('list-action', k, p, row)" @activate="(it) => emit('list-activate', it, row)"
        />
      </template>
      <div v-if="dropAfterLast()" class="lp-dropline"></div>
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
/* span / div 改成 <button> 后仍沿用本地外观的几类：先清 UA 内距与描边，外观由下方各自规则给 */
:where(button).lp-solo, :where(button).lp-eye, :where(button).lp-more { margin: 0; padding: 0; border: 0; background: none; color: inherit; text-align: inherit; }
.lp { display: flex; flex-direction: column; min-height: 0; height: 100%; }
/* 搜索行 / 页脚钉住：侧栏把整块面板放进自己的滚动区时，展开一组长成员表再往下滚，
   搜索框与 ＋ 会跟着滚走。sticky 让它们贴在滚动区上 / 下沿（.lp-body 自己滚时 sticky 不起作用，也无害）。 */
.lp-top { flex: none; padding: 8px 12px 6px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px;
          position: sticky; top: 0; z-index: 4; background: var(--surface); }   /* 比页脚高一档：搜索下拉在它的层叠上下文里，不能被页脚盖住 */
.lp-search { position: relative; display: flex; align-items: center; gap: 4px; }
.lp-search input { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 24px 0 24px; box-sizing: border-box; }
.lp-si { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.lp-x { position: absolute; right: calc(2 * var(--h-ctl) + 12px); top: 50%; transform: translateY(-50%); }
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
/* 「仅显示：X」是状态标（spec P10 收成 --r-ctl），与 .lp-row.solo 的名字同一机位色 */
.lp-solo { display: inline-flex; align-items: center; gap: 3px; height: 16px; padding: 0 6px; border-radius: var(--r-ctl);
           background: var(--accent-ui-weak); color: var(--accent-ui); cursor: pointer; white-space: nowrap; transition: var(--t-state); }
.lp-solo:hover { background: color-mix(in srgb, var(--accent-ui) 24%, transparent); }
.lp-solo:active { box-shadow: var(--press); transition-duration: 0s; }

.lp-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 10px; }
.lp-body.dragging { cursor: grabbing; user-select: none; }
.lp-empty { padding: 4px 12px 6px 30px; font-size: var(--fs-2); color: var(--text-faint); }
/* 插入线：机位色、左端让出把手列（4 内距 + 14 把手 + 6 间距 = 24，从眼睛列起画），
   z-index 压在相邻行悬停底色之上 */
.lp-dropline { position: relative; z-index: 1; height: 2px; margin: -1px 8px -1px 24px; background: var(--accent-ui); border-radius: var(--r-ctl); }

.lp-row { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 4px; min-height: 24px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
/* 可见集墨色、隐藏集灰：一眼分出地图上现在有哪几集。★ 不要写 .lp-row.off { color } —— 会压掉隐藏行的悬停墨色 */
.lp-row:not(.off) { color: var(--text); }
.lp-row:hover { background: var(--wash-hover); color: var(--text); }
/* 展开行：实底 + 机位色挂条，与下面成员面板左缘的淡挂条连成一根 */
.lp-row.exp { color: var(--text); background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent-ui); }
.lp-row.exp:hover { background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.lp-body :deep(.sl) { position: relative; box-shadow: none; scroll-margin-top: 64px; scroll-margin-bottom: 40px; }   /* scroll-margin：成员表自己滚进视口时别钻到钉住的搜索行 / 页脚底下 */
.lp-body :deep(.sl)::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
                               background: color-mix(in srgb, var(--accent-ui) 45%, transparent); pointer-events: none; z-index: 1; }
/* 展开箭头不随隐藏压暗：它本就是 --text-faint，再叠 .45 只剩 1.5:1，默认大半行是隐藏集，「能点开」的提示就没了 */
.lp-row.off .lp-nm, .lp-row.off .lp-cnt, .lp-row.off .lp-sub, .lp-row.off .lp-swi, .lp-row.off .lp-ki { opacity: .45; }
.lp-row.off:hover .lp-chev, .lp-row.off.exp .lp-chev { opacity: 1; }
/* 显示中的集整行亮着：种类图标 / 颗数比常态提一档，与压暗的隐藏行拉开 */
.lp-row:not(.off) .lp-ki, .lp-row:not(.off) .lp-cnt { color: var(--text-muted); }
/* 眼睛开关带来的显隐变化淡一下（这是状态切换，不是悬停；行本身不加过渡）。
   种类图标 / 颗数不随悬停变色，颜色只在显隐时变，故可连颜色一起过渡；名字的颜色跟着行悬停走，不能带 */
.lp-nm, .lp-sub, .lp-swi, .lp-chev { transition: opacity var(--dur-2) linear; }
.lp-cnt, .lp-ki { transition: opacity var(--dur-2) linear, color var(--dur-2) linear; }
.lp-row.solo .lp-nm { color: var(--accent-ui); }
/* 右键 / ⋯ 菜单正对着的那一行：菜单开着时标出来，免得不知道在改哪一集 */
.lp-row.ctx { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-strong); }
.lp-row.exp.ctx { box-shadow: inset 2px 0 0 var(--accent-ui), inset 0 0 0 1px var(--border-strong); }
.lp-row.arm { box-shadow: inset 2px 0 0 var(--danger); }
/* 与 .exp.ctx 同权重、写在后面：展开行上开「确认删除」菜单时仍是红挂条 */
.lp-row.arm.ctx { box-shadow: inset 2px 0 0 var(--danger), inset 0 0 0 1px var(--border-strong); }
.lp-row.dragsrc { opacity: .4; background: var(--surface-2); }
.lp-row.pinned { border-bottom: 1px solid var(--border); margin-bottom: 3px; }
.lp-grip { flex: none; width: 14px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); opacity: 0; cursor: grab; touch-action: none; transition: opacity var(--dur-1) linear; }
.lp-grip.none { visibility: hidden; }
.lp-row:hover .lp-grip { opacity: 1; }
.lp-body.dragging .lp-grip { opacity: 1; }
/* 眼睛 / ⋯ 是 span 充当按钮，吃不到全局 button 的状态过渡与按下罩，就地补（spec P8）；
   --t-state 里含 opacity，⋯ 的悬停显形照样 80ms */
.lp-eye { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-muted); border-radius: var(--r-box); transition: var(--t-state); }
.lp-eye:hover { color: var(--text); background: var(--wash-hover); }
/* 显示中 = 机位色实底钮（同工具栏 .tbtn.on 的「开」），整列一眼读出地图上开着哪几集。
   原来两态只差眼睛上那道斜杠：记号长在占多数的隐藏集身上，少数的显示集反倒是「缺一笔」的那个，
   缺特征的目标只能逐行找（Treisman 搜索不对称）—— 记号必须加在少数一方。 */
.lp-row:not(.off) .lp-eye { background: var(--accent-fill); color: var(--accent-on); }
.lp-row:not(.off) .lp-eye:hover { background: var(--accent-fill-hover); color: var(--accent-on); }
/* 隐藏 = 眼睛随整行压暗（与种类图标同档），悬停该行才回到可点的亮度 */
.lp-row.off .lp-eye { color: var(--text-faint); opacity: .45; }
.lp-row.off:hover .lp-eye { opacity: 1; }
.lp-row.off .lp-eye:hover { color: var(--text); }
.lp-eye:active { box-shadow: var(--press); transition-duration: 0s; }
.lp-sw { position: relative; flex: none; width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.lp-sw.fixed { cursor: default; }
.lp-sw input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.lp-swi { width: 10px; height: 10px; border-radius: var(--r-ctl); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 25%, transparent); }
/* 未设色：斜纹维持原画法 —— 它是老用户认得的「未设色」记号，换成单斜线就是换了一枚图标 */
.lp-swi.unset { background: repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in srgb, var(--text) 30%, transparent) 2px 3px); }
.lp-ki { flex: none; display: inline-flex; color: var(--text-faint); }
.lp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.lp-mod { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: var(--warn); margin-left: 5px; vertical-align: middle; }
/* 改名框：左移 描边 1 + 内距 4 = 5px，字落在原名字的同一 x 上，进入改名时名字不跳 */
.lp-rn { flex: 1; min-width: 0; height: 20px; margin-left: -5px; font: inherit; padding: 0 4px; border: 1px solid var(--accent-ui); background: var(--field-bg); color: var(--text); border-radius: var(--r-ctl); user-select: text; }
/* 全局 2px 焦点环在 24px 行里会顶到上下行；描边已是机位色，焦点只再加 1px 贴身环 */
.lp-rn:focus-visible { outline: none !important; box-shadow: 0 0 0 1px var(--accent-ui); }
.lp-sub { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-variant-numeric: tabular-nums; max-width: 42%; overflow: hidden; text-overflow: ellipsis; }
.lp-cnt { flex: none; min-width: 34px; text-align: right; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lp-more { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); opacity: 0; transition: var(--t-state); }
.lp-row:hover .lp-more, .lp-row.arm .lp-more { opacity: 1; }
.lp-more:hover { color: var(--text); background: var(--wash-hover); }
.lp-more:active { box-shadow: var(--press); transition-duration: 0s; }
.lp-row.arm .lp-more { color: var(--danger); }
.lp-chev { flex: none; width: 14px; display: inline-flex; justify-content: center; color: var(--text-faint); }
.lp-row.exp .lp-chev { color: var(--text); }

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
</style>
