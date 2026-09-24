<script setup>
// Excel 式数据网格（渲染层）：序号列 + 列头（选列/排序）+ 列边界线（拖宽/双击自适应）+ 单元格（框选/编辑/填充柄）+ 右键菜单。
// 交互内核全在 src/viz/grd/useGridSelect.js，本组件只负责把它铺成 DOM —— 对地性能表、对星性能表、
// 标记批量表格、波束批量表格共用这一份，改一处四处同步（此前是四份近乎同源的 <table> 各写一遍）。
//
// 布局口径：table-layout:fixed + 每列显式列宽（内核 widths），末尾一根无宽度的填充列吃掉剩余宽度。
// 只有定死列宽，拖拽改宽与「装不下打省略号」才成立；auto 布局下列宽永远跟着内容走，拖不动也收不窄。
import { computed, ref, reactive, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  grid: { type: Object, required: true },     // useGridSelect(...) 的返回
  cols: { type: Array, required: true },      // 与 grid 的 cfg.cols() 同一份
  text: { type: Function, required: true },   // (row, col) => 显示文本（与 cfg.cellText 同一口径）
  serial: { type: Boolean, default: true },   // 左侧序号列（点/拖选整行）
  rowClass: { type: Function, default: null },  // (row, ri) => class
  cellClass: { type: Function, default: null }, // (row, col) => class
  cellTip: { type: Function, default: null },   // (row, col) => 悬停读数（不占版面，放派生量正好）
  headTip: { type: Function, default: null },   // (col) => title
  headUnit: { type: Function, default: null },  // (col) => 单位（动态单位列覆盖 col.unit）
  emptyText: { type: String, default: '暂无数据。' },
  addLabel: { type: String, default: '' },    // 非空则在表尾渲染「＋ …」追加行按钮，点击 emit('add')
  delLabel: { type: String, default: '' },    // 非空则在追加行按钮旁渲染「删除所选行」（删的是选区跨过的那几行）
  actionsWidth: { type: Number, default: 0 }, // >0 时渲染操作列（右侧），内容走 #actions 插槽
  // 右键菜单的业务专属项（排在最上面）：({ row, rows, col }) => [{ key, label, kbd?, dis?, run }]
  // row = 活动格所在行、rows = 选区跨过的行。由本组件自己渲染——.eg-ctx-i 是 scoped 样式，用插槽从外面挂的按钮套不上它
  menuItems: { type: Function, default: null }
})
const emit = defineEmits(['add', 'row-enter', 'row-leave'])
const g = props.grid
const rows = computed(() => g.rows.value)
// ★ 一律按**显示序**渲染：冻结列被提到最左，而选区/复制/粘贴/填充/左右导航都以同一份次序遍历
//   （见 useGridSelect 的 colList）。这里若还按 props.cols 画，框出来的一片就和复制出来的一片对不上。
const vcols = computed(() => (g.visCols ? g.visCols.value : props.cols))
const unitOf = (c) => (props.headUnit ? props.headUnit(c) : c.unit)
// 列级对齐：col.align = 'left' | 'center' | 'right'，表头、格子、编辑框三处同走；不给则沿用老规则（文本左、数字右）
const ALIGN_CLS = { left: 'al', center: 'ac', right: 'ar' }
const alignClass = (c) => (c && ALIGN_CLS[c.align]) || null
const colSpanAll = computed(() => vcols.value.length + (props.serial ? 1 : 0) + (props.actionsWidth > 0 ? 1 : 0) + 1)
const menuRow = computed(() => { const r = g.rect.value; return r.r0 < 0 ? 0 : r.r1 - r.r0 + 1 })
// 业务专属菜单项：菜单开着时按活动行 / 选区行现问一次调用方
const menuActiveRow = computed(() => (g.sel.value.ri >= 0 ? rows.value[g.sel.value.ri] || null : null))
const menuRows = computed(() => { const r = g.rect.value; return r.r0 < 0 ? [] : rows.value.slice(r.r0, r.r1 + 1) })
const extraMenu = computed(() => (props.menuItems && g.menu.open ? (props.menuItems({ row: menuActiveRow.value, rows: menuRows.value, col: g.menu.col }) || []) : []))
// 枚举列下拉：当前格所在的列/行与它此刻的值（值用于给选中项打勾）
const pickCol = computed(() => (g.pick.open ? vcols.value[g.pick.ci] || null : null))
const pickRow = computed(() => (g.pick.open ? rows.value[g.pick.ri] || null : null))
const pickCurrent = computed(() => (pickCol.value && pickRow.value ? String(props.text(pickRow.value, pickCol.value)) : ''))

// ===== 冻结列的量与条（照搬 StationGrid：偏移实测 → CSS 变量；条画在格子之上、不随横滚跑）=====
const fzH = ref(0)                    // 冻结条高度＝滚动容器可视高（天然让开底部横条）
const fzScrolled = ref(false)         // 横滚起来才投影，表明线下面压着内容（Excel 同款）
const fzDrag = reactive({ on: false, n: 0, x: 0 })
let fzRO = null, fzCands = []
const headCells = () => {
  const el = g.bodyEl.value
  return el ? { idx: el.querySelector('thead th.eg-idx'), ths: el.querySelectorAll('thead th.eg-h') } : null
}
function measureFrozen() {
  const el = g.bodyEl.value; if (!el || !g.fzOff) return
  const hc = headCells(); if (!hc) return
  // rect 而非 offsetWidth：整数取整会攒出 1px 缝
  let x = props.serial && hc.idx ? hc.idx.getBoundingClientRect().width : 0
  const offs = [x]
  const n = Math.min(g.frozenCount.value, hc.ths.length)
  for (let i = 0; i < n; i++) { x += hc.ths[i].getBoundingClientRect().width; offs.push(x) }
  const cur = g.fzOff.value
  if (cur.length !== offs.length || offs.some((v, i) => Math.abs(v - cur[i]) > 0.05)) g.fzOff.value = offs
  fzH.value = el.clientHeight
}
// 只盯序号列与各冻结列自己的尺寸：它们一变宽（内容/字号/语言）就重量，代价与表体规模无关
function reobserve() {
  const el = g.bodyEl.value
  if (!fzRO || !el) return
  fzRO.disconnect()
  fzRO.observe(el)
  const hc = headCells(); if (!hc) return
  if (hc.idx) fzRO.observe(hc.idx)
  for (let i = 0; i < Math.min(g.frozenCount.value, hc.ths.length); i++) fzRO.observe(hc.ths[i])
}
function onScroll() { const el = g.bodyEl.value; if (el) fzScrolled.value = el.scrollLeft > 0; rzLastX = -1 }
watch([() => g.frozenCount.value, vcols], () => nextTick(() => { reobserve(); measureFrozen() }))
watch(() => g.widths.value, () => nextTick(measureFrozen))   // 只是宽度变了（拖动中每帧都变）：观察对象没换，重量即可
onMounted(() => {
  fzRO = new ResizeObserver(() => measureFrozen())
  nextTick(() => { reobserve(); measureFrozen(); onScroll() })
})
onBeforeUnmount(() => { if (fzRO) { fzRO.disconnect(); fzRO = null } endFzDrag() })

// —— 拖冻结条改冻结位置 ——
// ★ 按下即把横滚归零：冻结区本就钉着不动，归零后「待冻的那几列」全在眼前，往左往右都落得到实处；
//   不归零的话，已滚出视野的列在屏幕上没有落点，往右拖会一格也走不动。
function buildCands() {
  const el = g.bodyEl.value; if (!el) return []
  const hc = headCells(); if (!hc) return []
  let x = props.serial && hc.idx ? hc.idx.getBoundingClientRect().width : 0
  const out = [{ n: 0, x }]
  const lim = el.clientWidth * 0.7           // 冻结区不许吃掉七成视野，否则滚动区无处可看
  for (let i = 0; i < hc.ths.length - 1; i++) {
    x += hc.ths[i].getBoundingClientRect().width
    if (x > lim) break
    out.push({ n: i + 1, x })
  }
  return out
}
function onFzDown(e) {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const el = g.bodyEl.value; if (!el) return
  el.scrollLeft = 0
  fzCands = buildCands()
  fzDrag.on = true; fzDrag.n = g.frozenCount.value; fzDrag.x = g.fzW.value
  window.addEventListener('mousemove', onFzMove)
  window.addEventListener('mouseup', onFzUp)
  window.addEventListener('keydown', onFzKey, true)
}
function onFzMove(e) {
  if (!fzDrag.on || !fzCands.length) return
  const el = g.bodyEl.value; if (!el) return
  const px = e.clientX - el.getBoundingClientRect().left
  let best = fzCands[0]
  for (const c of fzCands) if (Math.abs(c.x - px) < Math.abs(best.x - px)) best = c
  fzDrag.n = best.n; fzDrag.x = best.x
}
function onFzUp() { const n = fzDrag.n; endFzDrag(); g.setFreeze(n) }
function onFzKey(e) { if (e.key === 'Escape') { e.stopPropagation(); endFzDrag() } }   // Esc 取消，保持原冻结位
function endFzDrag() {
  fzDrag.on = false
  window.removeEventListener('mousemove', onFzMove)
  window.removeEventListener('mouseup', onFzUp)
  window.removeEventListener('keydown', onFzKey, true)
}

// ===== 列宽：整条列边界线可拖（照搬链路预算 StationGrid.vue 的那套）=====
// 光标压到任一列的右边界线 ±RZ_TOL 内就转 col-resize：**表头与数据行上都行**，不是只有表头格里靠右那一小条；
// 按下即开拖 —— 在滚动容器的 capture 阶段截住，不进格子的框选 / 列头的整列选择；拖动中列宽实时改，
// 另有一条贯穿整表高的引导线跟着光标（.eg-rzline，同冻结条画法）；双击边界线＝自动列宽；
// 被拖的列若在「整列选中」的选区里，选区内各列一起设成同一宽度（Excel：选中多列后拖任一条边界）。
// ★ 冻结条 .eg-fzbar 不在任何 td / th 里 —— rzHit 一律落空，故拖它仍是改冻结位置而不是改列宽。
const RZ_TOL = 4
const MIN_COL_W = 40                        // 与内核 MIN_W 同档（真正的钳位在 setWidths 里）
const rz = reactive({ on: false, hover: -1, x: 0 })
let rzX0 = 0, rzW0 = 0, rzRight0 = 0, rzNext = 0, rzRaf = 0, rzCols = [], rzLastX = -1, rzCi = -1
// 屏幕 x → 容器内容盒 x（引导线是 sticky 在滚动视口左沿的，故与横滚无关）。clientLeft＝左边框，.mcgrid 那台有 1px
const hostX = (clientX) => { const el = g.bodyEl.value; return el ? clientX - el.getBoundingClientRect().left - el.clientLeft : clientX }
// 光标处最近的列边界 { ci: 显示序列号, col, right: 边界线 clientX }；不在任何边界 ±RZ_TOL 内、或压在格内控件上 → null
function rzHit(e) {
  const t = e.target
  if (!t || !t.closest) return null
  const cell = t.closest('td, th')
  if (!cell) return null                     // 冻结条 / 空白处：不是格子，不接管
  const k = cell.classList
  if (k.contains('eg-idx') || k.contains('eg-act') || k.contains('eg-pad') || k.contains('eg-empty')) return null
  if (cell.closest('tr.eg-addrow')) return null
  // 格内控件贴着右缘的（填充柄、枚举列 ▾、操作按钮、编辑框）优先归它们自己
  // ★ .eg-dd 是 16px 宽、贴着格子右缘，且悬停行上整行都现形：枚举列（col.options）不要排在最末一列，
  //   否则那条边界在悬停行上只剩右侧 4px 可抓。
  if (t.closest('button, input, select, textarea, .eg-handle, .eg-dd')) return null
  const el = g.bodyEl.value, hc = headCells()
  if (!el || !hc) return null
  const fzRight = el.getBoundingClientRect().left + el.clientLeft + (g.fzW.value || 0)
  const n = Math.min(hc.ths.length, vcols.value.length)
  let best = null
  for (let i = 0; i < n; i++) {
    const r = hc.ths[i].getBoundingClientRect()
    if (r.width <= 0) continue
    // 边界横滚到冻结区底下了：屏幕上看不见，不许命中。冻结列自己的边界不在此列 ——
    // ★ 冻结区最后一列的右缘＝冻结缝，冻结条 .eg-fzbar 压在上面（[缝-3, 缝+4]）先接到鼠标，只剩最外侧 1px 落到格子上；
    //   那 1px 仍按改列宽走，否则冻结起来的列就再也拖不动宽了。
    if (!g.isFrozen(i) && r.right <= fzRight + RZ_TOL) continue
    const d = Math.abs(e.clientX - r.right)
    if (d <= RZ_TOL && (!best || d < best.d)) best = { ci: i, col: vcols.value[i], right: r.right, d }
  }
  return best
}
// 与被拖列同宽的那批列：整列选区里拖其中一条边界 → 选区内全部列；否则只有这一列。
// ★ 出的是**列对象**不是列号：列号是显示序，拖动中列集若变了（气象表的列由主窗口推过来、冻结/取消冻结）就指错人；
//   列对象只按 col.key 落宽度，换了身份也认得同一列。
function rzGroupOf(ci) {
  const vc = vcols.value
  if (!g.colSelected(ci)) return [vc[ci]].filter(Boolean)
  const out = []
  for (let i = 0; i < vc.length; i++) if (g.colSelected(i)) { if (vc[i]) out.push(vc[i]) }
  return out
}
// 补发的 click 不拦：边界 ±RZ_TOL 内没有任何带 click 的东西 —— 列头文字 .eg-ht 被 th 的 8px 内边距挡在外面，
// 格子只有 dblclick。拦了反而把容器的 @click=focusGrid 一并拦掉，拖完列宽键盘焦点就丢了。
function onRzMove(e) {
  if (rz.on || e.buttons) return             // 拖动中 / 按着键（框选、填充、列选）不改悬停态
  if (e.clientX === rzLastX) return          // 纵向移动不必重量：边界是竖线，只跟 x 走（横滚会挪边界，见 onScroll）
  rzLastX = e.clientX
  const h = rzHit(e)
  rz.hover = h ? h.ci : -1
}
function onRzLeave() { if (!rz.on) rz.hover = -1 }
function onRzDownCap(e) {
  if (e.button !== 0 || rz.on) return
  const h = rzHit(e); if (!h) return
  e.preventDefault(); e.stopPropagation()
  if (g.edit.value.ri >= 0) g.commitEdit()
  const el = g.bodyEl.value, th = headCells().ths[h.ci]
  rz.on = true; rz.hover = h.ci; rzCi = h.ci; g.resizing.value = true   // 内核的 ensureVisible 据此让开，别在拖动中把表滚走
  rzX0 = e.clientX; rzRight0 = h.right; rzW0 = th ? th.getBoundingClientRect().width : g.widthOf(h.col); rzNext = 0
  rz.x = hostX(rzRight0)
  rzCols = rzGroupOf(h.ci)
  if (el) fzH.value = el.clientHeight         // 引导线贯穿可视高（拖动中不重量）
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', onResizeUp)
}
function onRzDblCap(e) {
  if (e.button !== 0) return
  const h = rzHit(e); if (!h) return
  e.preventDefault(); e.stopPropagation()
  for (const c of rzGroupOf(h.ci)) g.autoFitCol(c)
}
function onResizeMove(e) {
  rzNext = Math.max(MIN_COL_W, Math.round(rzW0 + e.clientX - rzX0))
  rz.x = hostX(rzRight0 + rzNext - rzW0)      // 引导线＝边界线的新位置：跟光标走，撞到最小宽就停在那
  if (!rzRaf) rzRaf = requestAnimationFrame(() => {
    rzRaf = 0
    if (!rz.on) return
    g.setWidths(rzCols, rzNext)
    // ★ 宽度落地后按**实测边界**重钉一次引导线：已经横滚到最右头时收窄列，表总宽一缩、浏览器把 scrollLeft 往回夹，
    //   内容整体右移而边界其实没跟着光标走 —— 只按光标推算的话，线会离边界越来越远（偏移量＝整段拖动距离）。
    nextTick(() => {
      if (!rz.on) return
      const hc = headCells(), th = hc && hc.ths[rzCi]
      if (th) rz.x = hostX(th.getBoundingClientRect().right)
    })
  })
}
function onResizeUp() {
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeUp)
  if (rzRaf) { cancelAnimationFrame(rzRaf); rzRaf = 0 }
  document.body.style.cursor = ''
  if (rz.on && rzNext) {                      // 只点没拖：不改宽，也不落盘
    g.setWidths(rzCols, rzNext)
    g.commitWidths(rzCols.map((c) => c.key))
  }
  rz.on = false; rz.hover = -1; rzCols = []; rzCi = -1; g.resizing.value = false
}
onBeforeUnmount(onResizeUp)
</script>

<template>
  <div class="eg-scroll" :class="{ 'rz-hover': rz.hover >= 0 || rz.on }" :ref="el => g.bodyEl.value = el" tabindex="0"
       @keydown="g.gridKey" @wheel="g.onWheel" @click="g.focusGrid" @scroll="onScroll"
       @mousemove="onRzMove" @mouseleave="onRzLeave" @mousedown.capture="onRzDownCap" @dblclick.capture="onRzDblCap">
    <!-- 冻结线覆盖条：sticky 钉在滚动视口左沿再按实测偏移平移，故**不随横滚跑**；
         height:0 不占流，线体在内部的 <i> 上。拖它改冻结位置，双击取消全部冻结。 -->
    <div v-if="g.frozenCount.value" class="eg-fzbar" :class="{ scrolled: fzScrolled, drag: fzDrag.on }"
         :style="{ transform: 'translateX(' + (fzDrag.on ? fzDrag.x : g.fzW.value) + 'px)' }"
         :title="'已冻结 ' + g.frozenCount.value + ' 列 · 拖动改冻结位置 · 双击取消冻结'"
         @mousedown="onFzDown" @dblclick.stop="g.unfreeze()"><i :style="{ height: fzH + 'px' }"></i></div>
    <!-- 拖列宽时跟着光标走、贯穿整表高的引导线：同冻结条画法（sticky 钉在滚动视口左沿再 translateX），故不随横滚跑 -->
    <div v-if="rz.on" class="eg-rzline" :style="{ transform: 'translateX(' + rz.x + 'px)' }"><i :style="{ height: fzH + 'px' }"></i></div>
    <table class="eg-tbl" :style="g.fzVars.value">
      <colgroup>
        <col v-if="serial" style="width:38px" />
        <col v-for="c in vcols" :key="c.key" :style="{ width: g.widthOf(c) + 'px' }" />
        <col v-if="actionsWidth > 0" :style="{ width: actionsWidth + 'px' }" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th v-if="serial" class="eg-idx eg-corner" title="全选" @mousedown.left.prevent="g.selectAll(); g.focusGrid()"></th>
          <th v-for="(c, ci) in vcols" :key="c.key" class="eg-h" :data-k="c.key"
              :class="[{ n: c.num, colsel: g.colSelected(ci), sortable: g.sortable, froz: g.isFrozen(ci) }, alignClass(c)]"
              :style="g.fzStyle(ci)"
              :title="headTip ? headTip(c) : (c.tip || c.label)"
              @mousedown.left="g.colHeadDown($event, ci)" @mouseenter="g.colHeadEnter(ci)"
              @contextmenu="g.openMenu($event, null, ci)">
            <span class="eg-ht" @click="g.toggleSort(c)">{{ c.label }}<i v-if="unitOf(c)" class="eg-u">({{ unitOf(c) }})</i><em v-if="c.na">*</em>
              <Icon v-if="g.sortDirOf(c.key)" class="eg-sort" :name="g.sortDirOf(c.key) > 0 ? 'chevron-up' : 'chevron-down'" :size="12" />
            </span>
          </th>
          <th v-if="actionsWidth > 0" class="eg-act"></th>
          <th class="eg-pad"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, ri) in rows" :key="r.id" :class="[rowClass ? rowClass(r, ri) : null, { on: g.rowSelected(ri) }]"
            @mouseenter="emit('row-enter', r)" @mouseleave="emit('row-leave', r)">
          <td v-if="serial" class="eg-idx" title="点选整行 · 拖拽选多行 · 右键插入/删除行"
              @mousedown.left="g.rowHeadDown($event, ri)" @mouseenter="g.rowHeadEnter(ri)"
              @contextmenu="g.rowHeadMenu($event, ri)">{{ ri + 1 }}</td>
          <td v-for="(c, ci) in vcols" :key="c.key" class="eg-c"
              :class="[{ n: c.num, ed: g.cellEditable(r, c), sel: g.inSel(ri, ci), active: g.isActive(ri, ci), editing: g.isEdit(ri, ci), fillp: g.inFill(ri, ci), froz: g.isFrozen(ci) }, alignClass(c), cellClass ? cellClass(r, c) : null]"
              :style="g.fzStyle(ci)" :title="cellTip ? cellTip(r, c) : null"
              @mousedown="g.cellDown($event, ri, ci)" @mouseenter="g.cellEnter(ri, ci)"
              @dblclick="g.tryEdit(ri, ci, null)" @contextmenu="g.openMenu($event, ri, ci)">
            <span class="eg-v">{{ text(r, c) }}</span>
            <!-- 活动格常驻捕获输入框：始终存在并持有键盘/输入法焦点。导航态透明覆盖在值上、pointer-events:none 让鼠标框选穿透；
                 键入/输入法组字即翻成不透明可见编辑框——中文输入法从第一个拼音字母起就落在真实 <input>，不吞首字母。
                 值由内核命令式写入（不绑 :value——实时时钟每秒重渲染会把绑定值刷回，吞掉正在键入的内容）。 -->
            <input v-if="g.isActive(ri, ci) && g.cellEditable(r, c)" :ref="el => g.editEl.value = el"
                   class="eg-cap" :class="[{ n: c.num, editing: g.isEdit(ri, ci) }, alignClass(c)]" tabindex="-1"
                   @input="g.onActiveInput" @compositionstart="g.onActiveCompStart"
                   @blur="g.onActiveBlur" @paste="g.onActivePaste($event, r, c.key)"
                   @copy="g.onActiveClip" @cut="g.onActiveClip" />
            <span v-if="g.isFillAnchor(ri, ci) && !g.isEdit(ri, ci)" class="eg-handle" title="拖动/双击向下填充"
                  @mousedown.left.stop.prevent="g.onFillDown" @dblclick.stop="g.onFillDbl"></span>
            <!-- 枚举列：格右侧一枚 ▾（只在活动格与悬停行露出，免得整列挂满箭头）。
                 单击即开列表——这类格没有「自由文本」这一层，点开就是它唯一的编辑动作。 -->
            <span v-if="g.colOptions(c) && g.cellEditable(r, c)" class="eg-dd" title="从列表中选择"
                  @mousedown.left.stop.prevent="g.openPick(ri, ci, '')"><Icon name="chevron-down" :size="11" /></span>
          </td>
          <td v-if="actionsWidth > 0" class="eg-act"><slot name="actions" :row="r" :ri="ri" /></td>
          <td class="eg-pad"></td>
        </tr>
        <tr v-if="!rows.length"><td class="eg-empty" :colspan="colSpanAll">{{ emptyText }}</td></tr>
        <!-- 表尾追加行：热区只在标签本身，不是整行——整行热区紧挨底部横向滚动条，够一下滚动条就白加一行 -->
        <tr v-if="addLabel || delLabel" class="eg-addrow"><td :colspan="colSpanAll">
          <!-- sticky 钉在容器上而不是逐颗按钮上：两颗各自 sticky 到同一个 left，横滚起来会叠在一起 -->
          <span class="eg-addwrap">
          <button v-if="addLabel" type="button" class="eg-addlbl" @mousedown.stop @click="emit('add')"><Icon name="plus" :size="12" /> {{ addLabel }}</button>
          <!-- 删除整行原本只在右键菜单里，那条路既藏得深、又刚被 z-index 埋过一次；摆在追加行旁边最顺手。
               行数是运行时读数，单开一个 <i> 装 —— 按钮文案保持定串，翻译与断言都好对。 -->
          <button v-if="delLabel && g.canDelete.value" type="button" class="eg-addlbl del" :disabled="!menuRow"
                  @mousedown.stop @click="g.deleteRows()"><Icon name="trash" :size="12" /> {{ delLabel }}<i v-if="menuRow" class="eg-addn">{{ menuRow }}</i></button>
          </span>
        </td></tr>
      </tbody>
    </table>

    <!-- 枚举列的下拉：同样 Teleport 到 body。列表之外还给一个具名插槽，
         让「按参数现造一项」这种业务专属的入口（如按族 + 星座阶数 M 组合出调制方式）挂在列表下方，
         而不必把那套东西塞进这个通用组件。 -->
    <Teleport to="body">
      <div v-if="g.pick.open" class="eg-pick-mask" @mousedown="g.closePick()" @contextmenu.prevent="g.closePick()" @wheel.prevent>
        <div class="eg-pick" :class="{ up: g.pick.up }"
             :style="{ left: g.pick.x + 'px', minWidth: g.pick.w + 'px', [g.pick.up ? 'bottom' : 'top']: g.pick.y + 'px' }"
             @mousedown.stop>
          <div v-if="g.pick.filter" class="eg-pick-f">{{ g.pick.filter }}</div>
          <div class="eg-pick-l">
            <button v-for="(o, i) in g.pickList.value" :key="o.value" type="button" class="eg-pick-i"
                    :class="{ hi: i === g.pick.hi, on: pickCurrent === String(o.value) }"
                    @mouseenter="g.pick.hi = i" @click="g.choosePick(o.value)">
              <span class="eg-pick-t">{{ o.label == null ? o.value : o.label }}</span>
              <i v-if="o.note" class="eg-pick-n">{{ o.note }}</i>
            </button>
          </div>
          <slot name="pick-foot" :col="pickCol" :row="pickRow" :apply="g.choosePick" />
        </div>
      </div>
    </Teleport>

    <!-- 右键菜单：Teleport 到 body —— 浮窗本体 overflow:hidden，菜单留在窗内会被裁掉 -->
    <Teleport to="body">
      <div v-if="g.menu.open" class="eg-ctx-mask" @mousedown="g.closeMenu()" @contextmenu.prevent="g.closeMenu()">
        <div class="eg-ctx" :style="{ left: g.menu.x + 'px', top: g.menu.y + 'px' }" @mousedown.stop @contextmenu.stop.prevent>
          <template v-if="extraMenu.length">
            <button v-for="it in extraMenu" :key="it.key" class="eg-ctx-i" :disabled="!!it.dis" @click="g.menuDo(it.run)"><span>{{ it.label }}</span><kbd v-if="it.kbd">{{ it.kbd }}</kbd></button>
            <div class="eg-ctx-sep"></div>
          </template>
          <button class="eg-ctx-i" @click="g.menuDo(() => g.copySel(false))"><span>复制</span><kbd>Ctrl+C</kbd></button>
          <button class="eg-ctx-i" @click="g.menuDo(() => g.copySel(true))"><span>复制（含表头）</span><kbd>Ctrl+Shift+C</kbd></button>
          <template v-if="!g.readOnly">
            <button class="eg-ctx-i" @click="g.menuDo(g.cutSel)"><span>剪切</span><kbd>Ctrl+X</kbd></button>
            <button class="eg-ctx-i" @click="g.menuDo(g.doPaste)"><span>粘贴</span><kbd>Ctrl+V</kbd></button>
            <button class="eg-ctx-i" @click="g.menuDo(g.clearRange)"><span>清除内容</span><kbd>Del</kbd></button>
            <button class="eg-ctx-i" :disabled="menuRow < 2" @click="g.menuDo(g.fillDown)"><span>向下填充</span><kbd>Ctrl+D</kbd></button>
          </template>
          <template v-if="g.canInsert.value || g.canDelete.value">
            <div class="eg-ctx-sep"></div>
            <button v-if="g.canInsert.value" class="eg-ctx-i" @click="g.menuDo(() => g.insertRows(false))">在上方插入 {{ menuRow }} 行</button>
            <button v-if="g.canInsert.value" class="eg-ctx-i" @click="g.menuDo(() => g.insertRows(true))"><span>在下方插入 {{ menuRow }} 行</span><kbd>Ctrl+Shift++</kbd></button>
            <button v-if="g.canDelete.value" class="eg-ctx-i danger" @click="g.menuDo(g.deleteRows)"><span>删除 {{ menuRow }} 行</span><kbd>Ctrl+-</kbd></button>
          </template>
          <template v-if="g.sortable && g.menu.col">
            <div class="eg-ctx-sep"></div>
            <button class="eg-ctx-i" :class="{ on: g.sortDirOf(g.menu.col.key) > 0 }" @click="g.menuDo(() => g.setSort(g.menu.col, 1))">升序</button>
            <button class="eg-ctx-i" :class="{ on: g.sortDirOf(g.menu.col.key) < 0 }" @click="g.menuDo(() => g.setSort(g.menu.col, -1))">降序</button>
            <button class="eg-ctx-i" :disabled="!g.sort.value.dir" @click="g.menuDo(g.clearSort)">取消排序</button>
          </template>
          <div class="eg-ctx-sep"></div>
          <button class="eg-ctx-i" :disabled="!g.canPin.value"
                  :title="g.pinAllOn.value ? '取消冻结所选列' : '把所选列钉在最左，横滚时不动'"
                  @click="g.menuDo(() => g.togglePin())">{{ g.pinAllOn.value ? '取消冻结此列' : '冻结此列' }}</button>
          <button class="eg-ctx-i" :disabled="!g.frozenCount.value" @click="g.menuDo(g.unfreeze)">取消全部冻结</button>
          <div class="eg-ctx-sep"></div>
          <button v-if="g.menu.col" class="eg-ctx-i" @click="g.menuDo(() => g.autoFitCol(g.menu.col))">自动列宽</button>
          <button class="eg-ctx-i" @click="g.menuDo(g.autoFitAll)">全部列自适应</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 枚举列的 ▾ 把手：常态隐形，活动格与悬停行才露出（整列挂满箭头会盖住内容、也吵） */
.eg-tbl td.eg-c .eg-dd { position: absolute; right: 0; top: 0; bottom: 0; width: 16px; display: none;
  align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; background: inherit; }
.eg-tbl td.eg-c.active .eg-dd, .eg-tbl tbody tr:hover td.eg-c .eg-dd { display: flex; }
.eg-tbl td.eg-c .eg-dd:hover { color: var(--accent-ui); }
/* 特异度提醒：基础格样式写的是 `.eg-tbl th, .eg-tbl td`（0,1,1），凡要覆盖它的（内边距/溢出）
   都必须带 .eg-tbl 前缀，否则 `.eg-c { padding:0 }`（0,1,0）压不过去，表现为内边距叠两层。 */
.eg-scroll { overflow: auto; outline: none; }
.eg-tbl { table-layout: fixed; width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-3); }
.eg-tbl th, .eg-tbl td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
.eg-tbl th { position: sticky; top: 0; z-index: 3; background: var(--bg); color: var(--text-muted); font-weight: 600; user-select: none; }
/* 表头底线是栏目线（三线表的 --lb-rule；非链路预算窗口没这个变量时退到 --border-strong），不再与行间淡线同一档 */
.eg-tbl thead th { border-bottom: 1px solid var(--lb-rule, var(--border-strong)); }
.eg-tbl th.n, .eg-tbl td.n { text-align: right; font-family: var(--font-mono); }
/* 列级对齐（col.align）压过上面「数字右」的缺省；.eg-v 与表头的 .eg-ht 都是块级/行内级盒，从格子继承 text-align */
.eg-tbl th.al, .eg-tbl td.al { text-align: left; }
.eg-tbl th.ac, .eg-tbl td.ac { text-align: center; }
.eg-tbl th.ar, .eg-tbl td.ar { text-align: right; }
.eg-tbl td { color: var(--text); }
.eg-u { font-style: normal; color: var(--text-faint); font-weight: 400; font-size: .9em; margin-left: 2px; }
.eg-tbl th.eg-h em { color: var(--text-faint); font-style: normal; }
/* 列头：省略号交给内部的 .eg-ht，故 th 自身 overflow 放开即可（列宽把手已撤，改为整条边界线可拖，见 .eg-rzline）。
   ★ 不许在这里写 position:relative —— 它比基础规则的 position:sticky 更具体，会把粘性表头打回普通流
   （症状：滚动时表头跟着滚走）。 */
.eg-tbl th.eg-h { overflow: visible; }
.eg-ht { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.eg-tbl th.eg-h.sortable .eg-ht { cursor: pointer; }
.eg-tbl th.eg-h.sortable:hover { color: var(--text); }
.eg-tbl th.eg-h.colsel { background: color-mix(in srgb, var(--accent-ui) 22%, var(--bg)); color: var(--text); }
.eg-sort { color: var(--accent-ui); flex: none; }
/* 列边界线拖拽：光标压在任一列右边界 ±4px 内，整个容器转 col-resize（格子自带的 cell / pointer 光标要 !important 才压得过）；
   拖动中 .eg-rzline 是跟着光标走、贯穿整表高的引导线。scoped 下 `*` 只罩得住本组件的节点，插槽里的（操作列按钮）罩不着——
   那几列本就不接管边界拖拽，正好。 */
.eg-scroll.rz-hover, .eg-scroll.rz-hover * { cursor: col-resize !important; }
.eg-rzline { position: sticky; top: 0; left: 0; height: 0; width: 0; z-index: 9; pointer-events: none; }
.eg-rzline > i { position: absolute; top: 0; left: -1px; width: 2px; display: block; background: var(--accent); opacity: .85; }
/* 序号列：sticky 左固定，点/拖选整行 */
.eg-tbl th.eg-idx, .eg-tbl td.eg-idx { position: sticky; left: 0; z-index: 2; padding: 3px 4px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-1); background: var(--bg); cursor: pointer; user-select: none; }
.eg-tbl thead th.eg-idx { z-index: 5; cursor: cell; }
/* 悬停行的序号格：下面那条通用行悬停是透明罩，落在粘性序号格上会让横滚过去的格子透出来——这里混进不透明底。
   必须写在 tr.on 之前（同特异度，靠后者胜），选中行的实底不被悬停盖掉 */
.eg-tbl tbody tr:hover > td.eg-idx { background: color-mix(in srgb, var(--text) 5%, var(--bg)); }
.eg-tbl tbody tr.on > td.eg-idx { color: var(--accent-ui); font-weight: 700; background: color-mix(in srgb, var(--accent-ui) 14%, var(--bg)); }
.eg-tbl td.eg-idx:hover { color: var(--text-muted); }
/* 冻结列：粘性左固定。★ 底色必须**与面板色混合**而不是用透明 —— 横滚时冻结列底下压着内容，
   任何一处透明都会把滚过去的格子透出来。这与序号列 .eg-idx 的成例一致。
   层级：序号列(6) > 冻结表头(5) > 普通表头(3) > 序号格(3) > 冻结格(2) > 活动格(1)。 */
.eg-tbl th.eg-h.froz, .eg-tbl td.eg-c.froz { position: sticky; background-color: var(--bg); }
.eg-tbl thead th.eg-h.froz { z-index: 5; }
.eg-tbl tbody td.eg-c.froz { z-index: 2; }
.eg-tbl thead th.eg-idx { z-index: 6; }
.eg-tbl tbody tr:hover > td.eg-c.froz { background-color: color-mix(in srgb, var(--text) 5%, var(--bg)); }
.eg-tbl td.eg-c.froz.sel, .eg-tbl tbody tr:hover > td.eg-c.froz.sel { background-color: color-mix(in srgb, var(--accent-ui) 16%, var(--bg)); }
.eg-tbl th.eg-h.froz.colsel { background-color: color-mix(in srgb, var(--accent-ui) 22%, var(--bg)); }
/* 冻结线覆盖条：sticky 钉在滚动视口左沿，再用 transform 平移到实测偏移处 —— 故不随横滚跑。
   height:0 不占流；线体、命中区、投影都在内部的 <i> 上。 */
.eg-fzbar { position: sticky; top: 0; left: 0; height: 0; width: 0; z-index: 8; }
.eg-fzbar > i { position: absolute; top: 0; left: -3px; width: 7px; cursor: col-resize; display: block; }
.eg-fzbar > i::before { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 1px; background: var(--border-strong, var(--border)); }
.eg-fzbar:hover > i::before, .eg-fzbar.drag > i::before { background: var(--accent); }
/* 投影：横滚起来才现，表明线下面压着内容（Excel 同款） */
.eg-fzbar > i::after { content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 8px; pointer-events: none; opacity: 0; transition: opacity .12s;
  background: linear-gradient(to right, color-mix(in srgb, var(--text) 15%, transparent), transparent); }
.eg-fzbar.scrolled > i::after { opacity: 1; }
/* 单元格：relative + overflow 放开，让捕获输入框/填充柄在格内定位且不被裁；文本省略号交给 .eg-v */
.eg-tbl td.eg-c { position: relative; padding: 0; overflow: visible; cursor: cell; user-select: none; }
.eg-v { display: block; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eg-v:empty::before { content: '\00a0'; }   /* 空格占位保住行高（空单元格没有文本行盒） */
.eg-tbl td.eg-c.sel { background: color-mix(in srgb, var(--accent-ui) 16%, transparent); }
.eg-tbl td.eg-c.active { box-shadow: inset 0 0 0 2px var(--accent); z-index: 1; }
.eg-tbl td.eg-c.fillp { outline: 1px dashed var(--accent); outline-offset: -1px; }
.eg-tbl tbody tr:hover > td { background: color-mix(in srgb, var(--text) 5%, transparent); }
.eg-tbl tbody tr:hover > td.sel { background: color-mix(in srgb, var(--accent-ui) 16%, transparent); }
/* Excel 填充柄：选区右下角小方块 */
.eg-handle { position: absolute; right: -2px; bottom: -2px; width: 6px; height: 6px; background: var(--accent); border: 1px solid var(--bg); cursor: crosshair; z-index: 6; }
/* 常驻捕获输入框（见模板注释） */
.eg-cap { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; border: 0; border-radius: 0; padding: 3px 8px; font: inherit; line-height: normal; background: transparent; color: transparent; caret-color: transparent; pointer-events: none; z-index: 3; }
.eg-cap.n { font-family: var(--font-mono); text-align: right; }
.eg-cap.al { text-align: left; }
.eg-cap.ac { text-align: center; }
.eg-cap.ar { text-align: right; }
.eg-cap:focus { outline: none; }
.eg-cap.editing { background: var(--surface, var(--bg)); color: var(--text); caret-color: var(--text); pointer-events: auto; z-index: 5; }
.eg-tbl th.eg-act, .eg-tbl td.eg-act { text-align: center; padding: 0 4px; overflow: visible; cursor: default; }
.eg-tbl th.eg-pad, .eg-tbl td.eg-pad { padding: 0; }
.eg-tbl td.eg-empty { text-align: center; color: var(--text-faint); padding: 16px 12px; cursor: default; font-style: normal; }
.eg-tbl tr.eg-addrow td { padding: 2px 6px; border-bottom: 0; overflow: visible; }
.eg-addwrap { position: sticky; left: 6px; display: inline-flex; align-items: center; gap: 4px; }
.eg-addlbl { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: var(--fs-2); height: var(--h-ctl); white-space: nowrap; padding: 0 7px; cursor: pointer; color: var(--text-faint); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl); }
.eg-addlbl:hover:not(:disabled) { color: var(--accent); border-color: var(--border); }
</style>

<style>
/* 右键菜单 Teleport 到 body，不能用 scoped（scoped 只给组件自身 DOM 打标记，Teleport 出去的节点拿不到） */
/* ★ 右键菜单 Teleport 到 body，与调用它的浮窗是【同级】，故 z-index 要压得过最高的那层浮窗：
   文件管理对话框是 2000，原来的 400 会让菜单整个藏在对话框底下（看着像右键没反应）。
   3000 与下面的枚举列下拉同档（两者互斥，不会同时开），仍低于激活遮罩的 4000。 */
.eg-addlbl.del { color: var(--text-faint); }
.eg-addlbl.del:hover:not(:disabled) { color: var(--danger); }
.eg-addlbl:disabled { opacity: .4; cursor: default; }
.eg-addn { font-style: normal; margin-left: 5px; font-family: var(--font-mono); color: var(--text-faint); }
.eg-ctx-mask { position: fixed; inset: 0; z-index: 3000; }
/* 命令菜单（P3）：菜单级投影 --shadow-2（--shadow-3 只给模态框），光标处出现故只淡入；
   外框内距 4px → 项圆角 --r-ctl 同心；悬停机位色实底（与菜单栏一致），快捷键跟着反白、压一档 */
.eg-ctx { position: fixed; min-width: 176px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float); box-shadow: var(--shadow-2); display: flex; flex-direction: column; animation: ui-fade-in var(--dur-2) var(--ease-out); }
.eg-ctx-i { display: flex; align-items: center; gap: 12px; width: 100%; font: inherit; font-size: var(--fs-3); text-align: left; padding: 4px 9px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl); white-space: nowrap; }
.eg-ctx-i > span { flex: 1; }
.eg-ctx-i kbd { font-family: var(--font-code); font-size: var(--fs-1); color: var(--text-faint); }
.eg-ctx-i:hover:not(:disabled) { background: var(--accent-ui); color: var(--bg); }
.eg-ctx-i:hover:not(:disabled) kbd { color: inherit; opacity: .7; }
.eg-ctx-i:disabled { opacity: .4; cursor: default; }
.eg-ctx-i.danger:hover:not(:disabled) { background: var(--danger); color: var(--bg); }
.eg-ctx-i.on { color: var(--accent-ui); }
/* 枚举列下拉浮层 */
.eg-pick-mask { position: fixed; inset: 0; z-index: 3000; }
.eg-pick { position: fixed; z-index: 3001; max-height: 260px; max-width: 340px; overflow: hidden; display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); box-shadow: var(--shadow-2); }
.eg-pick-f { flex: none; padding: 3px 8px; font-size: var(--fs-2); color: var(--text-faint); border-bottom: 1px solid var(--border); font-family: var(--font-mono); }
.eg-pick-l { flex: 1; min-height: 0; overflow: auto; padding: 3px 0; }
.eg-pick-i { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 10px; border: 0; background: none;
  color: var(--text-muted); font-size: var(--fs-3); text-align: left; cursor: pointer; }
.eg-pick-i.hi { background: color-mix(in srgb, var(--accent-ui) 16%, transparent); color: var(--text); }
.eg-pick-i.on { color: var(--accent); }
.eg-pick-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eg-pick-n { flex: none; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.eg-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
</style>
