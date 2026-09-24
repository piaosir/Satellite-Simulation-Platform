<script setup>
// 星座侧栏 · 卫星集面板：内置星座 / 卫星组 / 导入星历 / 自定义星座 摊成【一张有序表】，每一行同一套控件与手势。
//   · 眼睛        显 / 隐（可多开，地图 = 所有可见集的并集）
//   · Alt + 眼睛  仅显示这一集（其余暂隐；顶部出现「仅显示：X」，点它还原）
//   · 点行        展开 / 收起成员表（同一时刻只开一处）
//   · 双击行      聚焦（转到它那一面并选中）
//   · 拖行首把手  调顺序（松手落位）；键盘党用菜单的 上移 / 下移 / 置顶
//   · 双击名字    改名；行尾「⋯」与右键 = 同一份菜单，条目由宿主按种类给（menuItems(row)）
// 新建统一走顶部「＋」菜单（宿主给 addItems）。本组件只管呈现与本地 UI 态（改名 / 菜单 / 两步删除 / 拖拽），
// 数据与动作全在宿主（emit 出去）。
import { ref, nextTick, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import SatList from './SatList.vue'

const props = defineProps({
  // 有序行：{ id, kind, name, count, sub, color, colorable, visible, renamable, icon, iconTitle, modified }
  rows: { type: Array, default: () => [] },
  searchRow: { type: Object, default: null },            // 搜索结果那一行（钉在最上，不参与排序）
  summary: { type: Object, default: () => ({}) },        // { shown, layers, dataTime, status }
  solo: { type: Object, default: null },                 // { id, name }
  expanded: { type: String, default: '' },
  expItems: { type: Array, default: () => [] },
  expLoading: { type: Boolean, default: false },
  expError: { type: String, default: '' },
  expActions: { type: Array, default: () => [] },
  // { keyword, results:[{ noradId, name, groupLabel, slot, picked }], finderActive }
  search: { type: Object, default: () => ({ keyword: '', results: [], finderActive: false }) },
  menuItems: { type: Function, default: null },          // (row) => [{ key, label, icon, tone, sep }]
  addItems: { type: Array, default: () => [] },          // 「＋」菜单：[{ key, label, icon, sep }]
  epoch: { type: String, default: null },                // 场景历元（有自定义星座时才给）
  defaultColor: { type: String, default: '#4dabf7' }
})
const emit = defineEmits([
  'toggle', 'solo', 'restore', 'expand', 'activate', 'action', 'add', 'reorder',
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
onBeforeUnmount(() => { clearTimeout(armT); endDrag(); window.removeEventListener('keydown', onMenuKey, true) })

/* —— 眼睛：普通点 = 显隐；Alt + 点 = 仅显示 —— */
function onEye(ev, row) { if (ev.altKey) emit('solo', row); else emit('toggle', row) }
const eyeTitle = (row) => (row.visible ? '隐藏（Alt + 点击：仅显示这一集）' : '显示（Alt + 点击：仅显示这一集）')

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
      <div class="lp-search">
        <span class="lp-si"><Icon name="search" :size="12" /></span>
        <input :value="search.keyword" placeholder="搜索名 / 编号" spellcheck="false" @input="emit('search-input', $event.target.value)" />
        <span v-if="search.keyword" class="lp-x" title="清除" @click="emit('search-clear')"><Icon name="x" :size="12" /></span>
        <button type="button" class="lp-ib" :class="{ on: search.finderActive }" title="查找卫星：按所有者 / 对象类型 / 状态 / 发射年 / 轨道区制 / 近远地点 / 倾角 / 周期" @click="emit('open-finder')"><Icon name="filter" :size="12" /></button>
        <button type="button" class="lp-ib lp-add" title="添加：新建卫星组 / 生成星座 / 导入星历 / 从目录查找 / 找回删掉的内置星座" @click="openAdd"><Icon name="plus" :size="13" /></button>
        <div v-if="search.results && search.results.length" class="lp-drop">
          <div v-for="it in search.results" :key="it.noradId" class="lp-di" :class="{ picked: it.picked }" @click="emit('search-pick', it)">
            <div class="lp-dt">
              <div class="lp-dn" data-i18n-skip>{{ it.name }}</div>
              <div class="lp-ds" data-i18n-skip>{{ it.groupLabel }} · NORAD {{ it.noradId }}<span v-if="it.slot"> · {{ it.slot }}</span></div>
            </div>
            <span class="lp-dp" :title="it.picked ? '已在选中集中，点击移出' : '加入选中集'" @click.stop="emit('search-toggle-pick', it)"><Icon :name="it.picked ? 'check' : 'plus'" :size="12" /></span>
          </div>
        </div>
      </div>
      <div class="lp-sum" data-i18n-skip>
        <span class="lp-sn">显示 {{ summary.shown ?? 0 }} 颗 · {{ summary.layers ?? 0 }} 集<template v-if="summary.dataTime"> · OMM {{ summary.dataTime }}</template><template v-if="summary.status"> · {{ summary.status }}</template></span>
        <span v-if="solo" class="lp-solo" title="点击还原之前的显示" @click="emit('restore')">仅显示：{{ solo.name }} <Icon name="x" :size="11" /></span>
      </div>
    </div>

    <div ref="bodyEl" class="lp-body" :class="{ dragging: !!drag }">
      <!-- 搜索结果：钉在最上，不参与排序 -->
      <template v-if="searchRow">
        <div
          class="lp-row pinned"
          :class="{ off: !searchRow.visible, exp: expanded === searchRow.id, solo: solo && solo.id === searchRow.id, ctx: !!(menu && menu.kind === 'row' && menu.row && menu.row.id === searchRow.id) }"
          @click="emit('expand', searchRow)" @dblclick="emit('activate', searchRow)" @contextmenu.prevent.stop="openMenu($event, searchRow)"
        >
          <span class="lp-grip none"></span>
          <span class="lp-eye" :title="eyeTitle(searchRow)" @click.stop="onEye($event, searchRow)"><Icon :name="searchRow.visible ? 'eye' : 'eye-off'" :size="13" /></span>
          <span class="lp-sw fixed"><span class="lp-swi" :style="{ background: searchRow.color || defaultColor }"></span></span>
          <span class="lp-ki" title="搜索结果"><Icon name="search" :size="12" /></span>
          <span class="lp-nm" :title="searchRow.name" data-i18n-skip>{{ searchRow.name }}</span>
          <span class="lp-cnt" data-i18n-skip>{{ searchRow.count }}</span>
          <span class="lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, searchRow)"><Icon name="ellipsis" :size="13" /></span>
          <span class="lp-chev"><Icon name="chevron-down" class="disc" :class="{ shut: expanded !== searchRow.id }" :size="12" /></span>
        </div>
        <SatList
          v-if="expanded === searchRow.id"
          :items="expItems" :reset-key="searchRow.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
          :placeholder="'在「' + searchRow.name + '」里筛选'" empty="没有命中的卫星。"
          @action="(k, p) => emit('list-action', k, p, searchRow)" @activate="(it) => emit('list-activate', it, searchRow)"
        />
      </template>
      <div v-if="!rows.length" class="lp-empty">还没有卫星集。</div>
      <template v-for="(row, idx) in rows" :key="row.id">
        <div v-if="dropBefore(idx)" class="lp-dropline"></div>
        <div
          class="lp-row" :data-idx="idx"
          :class="{ off: !row.visible, exp: expanded === row.id, solo: solo && solo.id === row.id, arm: delArm === row.id, dragsrc: drag && drag.id === row.id, ctx: !!(menu && menu.kind === 'row' && menu.row && menu.row.id === row.id) }"
          @click="emit('expand', row)" @dblclick="emit('activate', row)"
          @contextmenu.prevent.stop="openMenu($event, row)"
        >
          <span class="lp-grip" title="拖动调整顺序" @pointerdown="onGripDown($event, row, idx)" @click.stop @dblclick.stop><Icon name="grip-vertical" :size="12" /></span>
          <span class="lp-eye" :title="eyeTitle(row)" @click.stop="onEye($event, row)"><Icon :name="row.visible ? 'eye' : 'eye-off'" :size="13" /></span>
          <label v-if="row.colorable" class="lp-sw" :title="'星点颜色（' + (row.color || '未设置') + '）'" @click.stop @dblclick.stop>
            <span class="lp-swi" :class="{ unset: !row.color }" :style="row.color ? { background: row.color } : null"></span>
            <input type="color" :value="row.color || defaultColor" @input="emit('color', row, $event.target.value)" />
          </label>
          <span v-else class="lp-sw fixed"><span class="lp-swi" :style="{ background: row.color || defaultColor }"></span></span>
          <span v-if="row.icon" class="lp-ki" :title="row.iconTitle || ''"><Icon :name="row.icon" :size="12" /></span>
          <input
            v-if="renameId === row.id" :ref="setRnEl" class="lp-rn" v-model="renameVal"
            @click.stop @dblclick.stop @keydown.enter="commitRename(row)" @keydown.esc.stop="renameId = ''" @blur="commitRename(row)"
          />
          <span v-else class="lp-nm" :title="row.name" data-i18n-skip @dblclick.stop="startRename(row)">{{ row.name }}<i v-if="row.modified" class="lp-mod" title="已改动过（菜单里可重置）"></i></span>
          <span v-if="row.sub" class="lp-sub" data-i18n-skip>{{ row.sub }}</span>
          <span class="lp-cnt" data-i18n-skip>{{ row.count }}</span>
          <span class="lp-more" title="更多操作（右键同）" @click.stop="openMenu($event, row)"><Icon name="ellipsis" :size="13" /></span>
          <span class="lp-chev"><Icon name="chevron-down" class="disc" :class="{ shut: expanded !== row.id }" :size="12" /></span>
        </div>
        <SatList
          v-if="expanded === row.id"
          :items="expItems" :reset-key="row.id" :loading="expLoading" :error="expError" :actions="expActions" :rows="14"
          :placeholder="'在「' + row.name + '」里筛选'" empty="该集还没有卫星。"
          @action="(k, p) => emit('list-action', k, p, row)" @activate="(it) => emit('list-activate', it, row)"
        />
      </template>
      <div v-if="dropAfterLast()" class="lp-dropline"></div>
    </div>

    <div v-if="epoch !== null" ref="footEl" class="lp-foot" title="全部自定义星座共用的场景历元：星座定向以此为准，拖时间轴仍从此历元向后推演">
      <label>场景历元</label>
      <input class="ci" type="datetime-local" :value="epoch" @change="emit('epoch', $event.target.value)" />
      <span class="lnk" title="取当前时刻为场景历元" @click="emit('epoch-now')">当前</span>
    </div>

    <template v-if="menu">
      <div class="lp-mbd" @mousedown="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div class="lp-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <div v-if="menu.row" class="lp-mh" data-i18n-skip>{{ menu.row.name }}</div>
        <template v-for="(it, i) in menu.items" :key="(it.key || 'sep') + i">
          <div v-if="it.sep" class="lp-msep"></div>
          <div v-else class="lp-mi" :class="[it.tone || '', { warn: menu.row && it.key === 'delete' && delArm === menu.row.id, dis: it.disabled }]" @click="!it.disabled && onItem(it)">
            <Icon v-if="it.icon" :name="it.icon" :size="12" /><span>{{ itemLabel(it, menu.row) }}</span><em v-if="it.hint" data-i18n-skip>{{ it.hint }}</em>
          </div>
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
.lp-search { position: relative; display: flex; align-items: center; gap: 4px; }
.lp-search input { flex: 1; min-width: 0; height: var(--h-ctl); padding: 0 24px 0 24px; box-sizing: border-box; }
.lp-si { position: absolute; left: 7px; top: 50%; transform: translateY(-50%); color: var(--text-faint); display: inline-flex; pointer-events: none; }
.lp-x { position: absolute; right: calc(2 * var(--h-ctl) + 14px); top: 50%; transform: translateY(-50%); color: var(--text-faint); cursor: pointer; display: inline-flex; padding: 2px; }
.lp-x:hover { color: var(--text); }
.lp-ib { flex: none; width: var(--h-ctl); height: var(--h-ctl); display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text-muted); border-radius: var(--r-ctl); cursor: pointer; padding: 0; }
.lp-ib:hover { border-color: var(--field-border-hover); color: var(--text); }
/* 过滤开关开着 = 小号图标开关（spec P9）：机位色字 / 描边 + 淡罩 */
.lp-ib.on { border-color: var(--accent-ui); color: var(--accent-ui); background: var(--accent-ui-weak); }
/* ＋ 是墨色主操作，走 --primary-* token：深色下压一档，不再是近白块；悬停换 token 色而不是 brightness 滤镜。
   必须在 .lp-ib:hover 之后（否则悬停时被它的描边 / 字色盖掉）；按下由全局 button 按下罩提供，
   不写 :active 背景（会压成浅灰底纸色字） */
.lp-add { background: var(--primary-fill); border-color: var(--primary-fill); color: var(--primary-on); }
.lp-add:hover { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); color: var(--primary-on); }
.lp-drop { position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 30; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-float); animation: ui-float-in var(--dur-2) var(--ease-out); }
.lp-di { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; }
.lp-di:hover { background: var(--surface-2); }
/* 已在选中集里：与列表选中同一机位色 */
.lp-di.picked .lp-dn, .lp-di.picked .lp-dp { color: var(--accent-ui); }
.lp-dt { flex: 1; min-width: 0; }
.lp-dn { font-size: var(--fs-3); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-ds { font-size: var(--fs-1); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.lp-dp { flex: none; display: inline-flex; color: var(--text-faint); padding: 2px; border-radius: var(--r-box); }
.lp-dp:hover { color: var(--accent); background: var(--bg); }
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
.lp-row:hover { background: var(--surface-2); color: var(--text); }
/* 展开行：实底 + 机位色挂条，与下面成员面板左缘的淡挂条连成一根 */
.lp-row.exp { color: var(--text); background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent-ui); }
.lp-row.exp:hover { background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.lp-body :deep(.sl) { position: relative; box-shadow: none; scroll-margin-top: 64px; scroll-margin-bottom: 40px; }   /* scroll-margin：成员表自己滚进视口时别钻到钉住的搜索行 / 页脚底下 */
.lp-body :deep(.sl)::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
                               background: color-mix(in srgb, var(--accent-ui) 45%, transparent); pointer-events: none; z-index: 1; }
/* 展开箭头不随隐藏压暗：它本就是 --text-faint，再叠 .45 只剩 1.5:1，默认大半行是隐藏集，「能点开」的提示就没了 */
.lp-row.off .lp-nm, .lp-row.off .lp-cnt, .lp-row.off .lp-sub, .lp-row.off .lp-swi, .lp-row.off .lp-ki { opacity: .45; }
.lp-row.off:hover .lp-chev, .lp-row.off.exp .lp-chev { opacity: 1; }
/* 眼睛开关带来的显隐变化淡一下（这是状态切换，不是悬停；行本身不加过渡） */
.lp-nm, .lp-cnt, .lp-sub, .lp-swi, .lp-ki, .lp-chev { transition: opacity var(--dur-2) linear; }
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
.lp-eye:hover { color: var(--text); background: var(--bg); }
.lp-row.off .lp-eye { color: var(--text-faint); }
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
.lp-more:hover { color: var(--text); background: var(--bg); }
.lp-more:active { box-shadow: var(--press); transition-duration: 0s; }
.lp-row.arm .lp-more { color: var(--danger); }
.lp-chev { flex: none; width: 14px; display: inline-flex; justify-content: center; color: var(--text-faint); }
.lp-row.exp .lp-chev { color: var(--text); }

.lp-foot { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--border); font-size: var(--fs-2); color: var(--text-muted);
           position: sticky; bottom: 0; z-index: 3; background: var(--surface); }
.lp-foot label { flex: none; }
.lp-foot .ci { flex: 1; min-width: 0; }
.lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.lnk:hover { text-decoration: underline; }

.lp-mbd { position: fixed; inset: 0; z-index: 2190; }
/* 命令菜单（spec P3）：外框四周 3px 内距、项圆角与外框同心（6 − 3 = --r-box）；项的左右内距各减 3px，
   字的 x 与原来一致、与组标题对齐。光标处弹出、位置会被夹回视口，入场只淡入不位移。 */
.lp-menu { position: fixed; z-index: 2200; width: 200px; max-height: 360px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); border-radius: var(--r-float); padding: 3px; animation: ui-fade-in var(--dur-2) var(--ease-out); }
/* 组标题：左右负边距抵掉外框内距，分隔线仍通栏 */
.lp-mh { margin: 0 -3px 3px; padding: 3px 10px 5px; font-size: var(--fs-1); color: var(--text-faint); border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lp-mi { display: flex; align-items: center; gap: 7px; padding: 4px 7px; font-size: var(--fs-3); color: var(--text); cursor: pointer; border-radius: var(--r-box); }
.lp-mi > svg { flex: none; color: var(--text-muted); }
.lp-mi.warn { color: var(--danger); }
/* 悬停 = 机位色实底纸色字（与菜单栏同一套）；图标 / 次级字跟随 */
.lp-mi:hover { background: var(--accent-ui); color: var(--bg); }
.lp-mi:hover > svg, .lp-mi:hover em { color: inherit; }
.lp-mi:hover em { opacity: .7; }
.lp-mi.danger:hover { background: var(--danger); color: var(--bg); }
.lp-mi.dis, .lp-mi.dis > svg { color: var(--text-faint); }
.lp-mi.dis { background: transparent; pointer-events: none; }
.lp-mi em { margin-left: auto; font-style: normal; font-size: var(--fs-1); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lp-msep { height: 1px; background: var(--border); margin: 3px 6px; }
</style>
