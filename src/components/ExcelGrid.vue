<script setup>
// Excel 式数据网格（渲染层）：序号列 + 列头（选列/排序/拖宽）+ 单元格（框选/编辑/填充柄）+ 右键菜单。
// 交互内核全在 src/viz/grd/useGridSelect.js，本组件只负责把它铺成 DOM —— 对地性能表、对星性能表、
// 标记批量表格、波束批量表格共用这一份，改一处四处同步（此前是四份近乎同源的 <table> 各写一遍）。
//
// 布局口径：table-layout:fixed + 每列显式列宽（内核 widths），末尾一根无宽度的填充列吃掉剩余宽度。
// 只有定死列宽，拖拽改宽与「装不下打省略号」才成立；auto 布局下列宽永远跟着内容走，拖不动也收不窄。
import { computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  grid: { type: Object, required: true },     // useGridSelect(...) 的返回
  cols: { type: Array, required: true },      // 与 grid 的 cfg.cols() 同一份
  text: { type: Function, required: true },   // (row, col) => 显示文本（与 cfg.cellText 同一口径）
  serial: { type: Boolean, default: true },   // 左侧序号列（点/拖选整行）
  rowClass: { type: Function, default: null },  // (row, ri) => class
  cellClass: { type: Function, default: null }, // (row, col) => class
  headTip: { type: Function, default: null },   // (col) => title
  headUnit: { type: Function, default: null },  // (col) => 单位（动态单位列覆盖 col.unit）
  emptyText: { type: String, default: '暂无数据。' },
  addLabel: { type: String, default: '' },    // 非空则在表尾渲染「＋ …」追加行按钮，点击 emit('add')
  actionsWidth: { type: Number, default: 0 }  // >0 时渲染操作列（右侧），内容走 #actions 插槽
})
const emit = defineEmits(['add', 'row-enter', 'row-leave'])
const g = props.grid
const rows = computed(() => g.rows.value)
const unitOf = (c) => (props.headUnit ? props.headUnit(c) : c.unit)
const colSpanAll = computed(() => props.cols.length + (props.serial ? 1 : 0) + (props.actionsWidth > 0 ? 1 : 0) + 1)
const menuRow = computed(() => { const r = g.rect.value; return r.r0 < 0 ? 0 : r.r1 - r.r0 + 1 })
</script>

<template>
  <div class="eg-scroll" :ref="el => g.bodyEl.value = el" tabindex="0"
       @keydown="g.gridKey" @wheel="g.onWheel" @click="g.focusGrid">
    <table class="eg-tbl">
      <colgroup>
        <col v-if="serial" style="width:38px" />
        <col v-for="c in cols" :key="c.key" :style="{ width: g.widthOf(c) + 'px' }" />
        <col v-if="actionsWidth > 0" :style="{ width: actionsWidth + 'px' }" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th v-if="serial" class="eg-idx eg-corner" title="全选" @mousedown.left.prevent="g.selectAll(); g.focusGrid()"></th>
          <th v-for="(c, ci) in cols" :key="c.key" class="eg-h" :data-k="c.key"
              :class="{ n: c.num, colsel: g.colSelected(ci), sortable: g.sortable }"
              :title="headTip ? headTip(c) : (c.tip || c.label)"
              @mousedown.left="g.colHeadDown($event, ci)" @mouseenter="g.colHeadEnter(ci)"
              @contextmenu="g.openMenu($event, null, ci)">
            <span class="eg-ht" @click="g.toggleSort(c)">{{ c.label }}<i v-if="unitOf(c)" class="eg-u">({{ unitOf(c) }})</i><em v-if="c.na">*</em>
              <Icon v-if="g.sortDirOf(c.key)" class="eg-sort" :name="g.sortDirOf(c.key) > 0 ? 'chevron-up' : 'chevron-down'" :size="10" />
            </span>
            <span class="eg-rz" title="拖拽改列宽 · 双击自适应" @mousedown.left.stop="g.onResizeDown($event, c)" @dblclick.stop="g.autoFitCol(c)"></span>
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
          <td v-for="(c, ci) in cols" :key="c.key" class="eg-c"
              :class="[{ n: c.num, ed: g.colEditable(c), sel: g.inSel(ri, ci), active: g.isActive(ri, ci), editing: g.isEdit(ri, ci), fillp: g.inFill(ri, ci) }, cellClass ? cellClass(r, c) : null]"
              @mousedown="g.cellDown($event, ri, ci)" @mouseenter="g.cellEnter(ri, ci)"
              @dblclick="g.tryEdit(ri, ci, null)" @contextmenu="g.openMenu($event, ri, ci)">
            <span class="eg-v">{{ text(r, c) }}</span>
            <!-- 活动格常驻捕获输入框：始终存在并持有键盘/输入法焦点。导航态透明覆盖在值上、pointer-events:none 让鼠标框选穿透；
                 键入/输入法组字即翻成不透明可见编辑框——中文输入法从第一个拼音字母起就落在真实 <input>，不吞首字母。
                 值由内核命令式写入（不绑 :value——实时时钟每秒重渲染会把绑定值刷回，吞掉正在键入的内容）。 -->
            <input v-if="g.isActive(ri, ci) && g.colEditable(c)" :ref="el => g.editEl.value = el"
                   class="eg-cap" :class="{ n: c.num, editing: g.isEdit(ri, ci) }" tabindex="-1"
                   @input="g.onActiveInput" @compositionstart="g.onActiveCompStart"
                   @blur="g.onActiveBlur" @paste="g.onActivePaste($event, r, c.key)"
                   @copy="g.onActiveClip" @cut="g.onActiveClip" />
            <span v-if="g.isFillAnchor(ri, ci) && !g.isEdit(ri, ci)" class="eg-handle" title="拖动/双击向下填充"
                  @mousedown.left.stop.prevent="g.onFillDown" @dblclick.stop="g.onFillDbl"></span>
          </td>
          <td v-if="actionsWidth > 0" class="eg-act"><slot name="actions" :row="r" :ri="ri" /></td>
          <td class="eg-pad"></td>
        </tr>
        <tr v-if="!rows.length"><td class="eg-empty" :colspan="colSpanAll">{{ emptyText }}</td></tr>
        <!-- 表尾追加行：热区只在标签本身，不是整行——整行热区紧挨底部横向滚动条，够一下滚动条就白加一行 -->
        <tr v-if="addLabel" class="eg-addrow"><td :colspan="colSpanAll">
          <button type="button" class="eg-addlbl" @mousedown.stop @click="emit('add')"><Icon name="plus" :size="11" /> {{ addLabel }}</button>
        </td></tr>
      </tbody>
    </table>

    <!-- 右键菜单：Teleport 到 body —— 浮窗本体 overflow:hidden，菜单留在窗内会被裁掉 -->
    <Teleport to="body">
      <div v-if="g.menu.open" class="eg-ctx-mask" @mousedown="g.closeMenu()" @contextmenu.prevent="g.closeMenu()">
        <div class="eg-ctx" :style="{ left: g.menu.x + 'px', top: g.menu.y + 'px' }" @mousedown.stop @contextmenu.stop.prevent>
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
          <button v-if="g.menu.col" class="eg-ctx-i" @click="g.menuDo(() => g.autoFitCol(g.menu.col))">自动列宽</button>
          <button class="eg-ctx-i" @click="g.menuDo(g.autoFitAll)">全部列自适应</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 特异度提醒：基础格样式写的是 `.eg-tbl th, .eg-tbl td`（0,1,1），凡要覆盖它的（内边距/溢出）
   都必须带 .eg-tbl 前缀，否则 `.eg-c { padding:0 }`（0,1,0）压不过去，表现为内边距叠两层。 */
.eg-scroll { overflow: auto; outline: none; }
.eg-tbl { table-layout: fixed; width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11.5px; }
.eg-tbl th, .eg-tbl td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
.eg-tbl th { position: sticky; top: 0; z-index: 3; background: var(--panel, var(--bg)); color: var(--text-muted); font-weight: 600; user-select: none; }
.eg-tbl th.n, .eg-tbl td.n { text-align: right; font-family: var(--font-mono); }
.eg-tbl td { color: var(--text); }
.eg-u { font-style: normal; color: var(--text-faint); font-weight: 400; font-size: .9em; margin-left: 2px; }
.eg-tbl th.eg-h em { color: var(--text-faint); font-style: normal; }
/* 列头：overflow 必须放开，否则右缘那道列宽把手（-3px 出檐）被裁掉；省略号交给内部的 .eg-ht。
   ★ 不许在这里写 position:relative —— 它比基础规则的 position:sticky 更具体，会把粘性表头打回普通流
   （症状：滚动时表头跟着滚走）。sticky 本身就是定位元素，把手用 absolute 已经能锚在它上面。 */
.eg-tbl th.eg-h { overflow: visible; }
.eg-ht { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.eg-tbl th.eg-h.sortable .eg-ht { cursor: pointer; }
.eg-tbl th.eg-h.sortable:hover { color: var(--text); }
.eg-tbl th.eg-h.colsel { background: color-mix(in srgb, var(--accent) 22%, var(--panel, var(--bg))); color: var(--text); }
.eg-sort { color: var(--accent); flex: none; }
/* 列宽把手：贴在列头右缘，鼠标压上去才现形 */
.eg-rz { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 4; }
.eg-rz:hover { background: color-mix(in srgb, var(--accent) 55%, transparent); }
/* 序号列：sticky 左固定，点/拖选整行 */
.eg-tbl th.eg-idx, .eg-tbl td.eg-idx { position: sticky; left: 0; z-index: 2; padding: 3px 4px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; background: var(--panel, var(--bg)); cursor: pointer; user-select: none; }
.eg-tbl thead th.eg-idx { z-index: 5; cursor: cell; }
.eg-tbl tbody tr.on > td.eg-idx { color: var(--accent); font-weight: 700; background: color-mix(in srgb, var(--accent) 14%, var(--panel, var(--bg))); }
.eg-tbl td.eg-idx:hover { color: var(--text-muted); }
/* 单元格：relative + overflow 放开，让捕获输入框/填充柄在格内定位且不被裁；文本省略号交给 .eg-v */
.eg-tbl td.eg-c { position: relative; padding: 0; overflow: visible; cursor: cell; user-select: none; }
.eg-v { display: block; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eg-v:empty::before { content: '\00a0'; }   /* 空格占位保住行高（空单元格没有文本行盒） */
.eg-tbl td.eg-c.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.eg-tbl td.eg-c.active { box-shadow: inset 0 0 0 2px var(--accent); z-index: 1; }
.eg-tbl td.eg-c.fillp { outline: 1px dashed var(--accent); outline-offset: -1px; }
.eg-tbl tbody tr:hover > td { background: color-mix(in srgb, var(--text) 5%, transparent); }
.eg-tbl tbody tr:hover > td.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
/* Excel 填充柄：选区右下角小方块 */
.eg-handle { position: absolute; right: -2px; bottom: -2px; width: 6px; height: 6px; background: var(--accent); border: 1px solid var(--bg); cursor: crosshair; z-index: 6; }
/* 常驻捕获输入框（见模板注释） */
.eg-cap { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; border: 0; padding: 3px 8px; font: inherit; line-height: normal; background: transparent; color: transparent; caret-color: transparent; pointer-events: none; z-index: 3; }
.eg-cap.n { font-family: var(--font-mono); text-align: right; }
.eg-cap:focus { outline: none; }
.eg-cap.editing { background: var(--surface, var(--bg)); color: var(--text); caret-color: var(--text); pointer-events: auto; z-index: 5; }
.eg-tbl th.eg-act, .eg-tbl td.eg-act { text-align: center; padding: 0 4px; overflow: visible; cursor: default; }
.eg-tbl th.eg-pad, .eg-tbl td.eg-pad { padding: 0; }
.eg-tbl td.eg-empty { text-align: center; color: var(--text-faint); padding: 16px 12px; cursor: default; font-style: italic; }
.eg-tbl tr.eg-addrow td { padding: 2px 6px; border-bottom: 0; overflow: visible; }
.eg-addlbl { position: sticky; left: 6px; display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 11px; padding: 2px 7px; cursor: pointer; color: var(--text-faint); background: transparent; border: 1px solid transparent; border-radius: 4px; }
.eg-addlbl:hover { color: var(--accent); border-color: var(--border); }
</style>

<style>
/* 右键菜单 Teleport 到 body，不能用 scoped（scoped 只给组件自身 DOM 打标记，Teleport 出去的节点拿不到） */
.eg-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.eg-ctx { position: fixed; min-width: 176px; padding: 4px; background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, .45); display: flex; flex-direction: column; }
.eg-ctx-i { display: flex; align-items: center; gap: 12px; width: 100%; font: inherit; font-size: 12px; text-align: left; padding: 4px 9px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: 4px; white-space: nowrap; }
.eg-ctx-i > span { flex: 1; }
.eg-ctx-i kbd { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); }
.eg-ctx-i:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.eg-ctx-i:disabled { opacity: .4; cursor: default; }
.eg-ctx-i.danger:hover { background: color-mix(in srgb, #ff6a6a 22%, transparent); }
.eg-ctx-i.on { color: var(--accent); }
.eg-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
</style>
