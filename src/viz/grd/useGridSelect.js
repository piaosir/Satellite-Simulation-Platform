// 通用 Excel 式表格交互内核：框选（鼠标拖拽 / Shift 扩选）+ 键盘导航 + 区域复制 + 填充柄 + 序号列选行 +
// 列头选列/排序 + 右键菜单 + 列宽拖拽 +（可选）双击/键入编辑、区域粘贴、区域清除、插入/删除行。
// 与具体数据解耦——行/列/取值/写值全部由 cfg 注入；同一份逻辑挂在「城市输入」（可编辑）与「性能结果」（只读）等表上。
// 选区 = 锚点(ar,ac) → 活动格(ri,ci) 构成的矩形（ri=行下标，ci=列下标，均以 rows()/cols() 的当前顺序计）。
//
// 滚动/焦点口径照搬链路预算 StationGrid.vue（2026-07-25 定的那套，见其文件内注释）：
//   · 取焦点一律 focus({ preventScroll:true })——原生 focus 的「滚进视野」不认 sticky，会把刚点的格塞到
//     表头/序号列底下，还连所有可滚祖先一起滚；滚动改由 ensureVisible() 按 Excel 口径补最小差额。
//   · 滚轮竖滚只走纵向；表内纵向滚不动时把 delta 转给最近可滚祖先——Chromium 会把「只有横向能滚」的
//     容器的竖滚折成横滚，那是底部横条乱跑的根由。
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { appAlert } from '../../stores/alert.js'   // 应用内提示，替代会夺焦点的原生 alert

const DEFAULT_W = 96          // 未给 col.w 且量不出来时的列宽兜底（px）
const MIN_W = 40              // 拖拽列宽下限
const MEASURE_ROWS = 400      // 自动列宽的取样行数上限（超大表只量前 N 行，够用且不卡）

export function useGridSelect(cfg) {
  // cfg:
  //   rows:      () => Row[]            每行需有稳定 id（编辑/粘贴定位用）
  //   cols:      () => Col[]            { key, label, num, fix, w?, editable? }；editable !== false 且非只读表时该列可编辑
  //   readOnly?: boolean               只读表：仅框选 + 复制 + 导航 + 排序，无编辑/粘贴/清除
  //   cellText:  (row, col) => string  显示/复制文本
  //   cellRaw?:  (row, col) => any      进入编辑时的原始值（默认 row[col.key]）
  //   sortValue?:(row, col) => any      排序取值（默认数字列取 row[col.key]，文本列取 cellText）
  //   sortable?: boolean               列头点击排序（默认 = readOnly：可编辑表排序会打乱插入/粘贴的行定位，故默认关）
  //   onEdit?:   (rowId, key, value)    提交单格（外部负责写库；本模块已先 pushUndo）
  //   onPasteBlock?: (anchorRowId, startKey, text) => number   以锚点为左上角定位填充，返回填充行数
  //   onPasteAppend?:(text) => number   无选区/空表时的整块追加，返回新增行数
  //   onClear?:  (cells:{rowId,key}[])  批量清空（已先 pushUndo）
  //   onInsertRows?: (atIndex, count) => number   在下标处插入空行（已先 pushUndo）；不给则右键菜单无插入项
  //   onDeleteRows?: (rowIds[]) => number         删除这些行（已先 pushUndo）；不给则无删除项
  //   pushUndo? / dropUndo? / refresh?  撤销快照 / 撤回空操作快照 / 变更后重算
  //   undo? / redo?                     Ctrl+Z / Ctrl+Y(Ctrl+Shift+Z) 的处理（外部负责恢复+重算）
  const sel = ref({ ar: -1, ac: -1, ri: -1, ci: -1 })
  const edit = ref({ ri: -1, ci: -1 })
  const editSeed = ref(null)              // 键入进入编辑的首字符（null=保留原值并全选）
  const editTyped = ref(false)            // 本次编辑由「键入/输入法就地」进入（input 里已有内容，watch 不得重置/全选）
  // 编辑框里的内容是否【已就位】。键入进入时内容当场就有（true）；F2/双击进入要等下面的 watch 把原值写进框里。
  // ★ 没有这道闸就会丢数据：双击换格时，旧格那个正要卸载的框会先发一次 blur，而此时 edit 已指向新格，
  //   onActiveBlur→commitEdit 便拿着【还空着】的框去和新格的原值比，判成「值变了」，把新格写成空
  //   （复现：点 A 格→双击 B 格，B 格的值当场消失）。未就位一律不写。
  const editReady = ref(false)
  const editEl = ref(null)                // 活动格常驻捕获输入框的 DOM（导航态透明覆盖、编辑态可见；输入法首字母就落在它上）
  const bodyEl = ref(null)                // 网格容器（滚动容器，同时是只读表/无捕获框时的后备键盘焦点持有者）
  let dragging = false
  let rowDrag = false, rowAnchor = -1     // 序号列拖拽选行
  let colDrag = false, colAnchor = -1     // 列头拖拽选列
  // 拖拽框选时的边缘自动滚动：鼠标接近容器边缘 → 用 rAF 持续滚动容器，让选区能延伸到视口外的行/列。
  // 速度按越界距离渐进（Excel 式加速：贴着边缘慢慢挪、甩远了快滚）。
  let pointerX = 0, pointerY = 0, autoRAF = 0

  // ===== 排序（只读表默认开）=====
  const sortable = cfg.sortable === undefined ? !!cfg.readOnly : !!cfg.sortable
  const sort = ref({ key: '', dir: 0 })   // dir: 1 升 / -1 降 / 0 不排
  const sortDirOf = (key) => (sort.value.key === key ? sort.value.dir : 0)
  function setSort(col, dir) {
    if (!sortable || !col) return
    sort.value = dir ? { key: col.key, dir } : { key: '', dir: 0 }
    sel.value = { ar: -1, ac: -1, ri: -1, ci: -1 }   // 行序变了，旧的行下标已无意义
  }
  // 点列头循环：不排 → 升 → 降 → 不排（与 Excel/表格控件通行口径一致）
  function toggleSort(col) { if (col) setSort(col, sortDirOf(col.key) === 0 ? 1 : sortDirOf(col.key) === 1 ? -1 : 0) }
  function clearSort() { sort.value = { key: '', dir: 0 } }
  const sortVal = (r, c) => {
    if (cfg.sortValue) return cfg.sortValue(r, c)
    const v = r[c.key]
    if (c.num) return (typeof v === 'number' && Number.isFinite(v)) ? v : (v == null || v === '' ? null : Number(v))
    return cfg.cellText ? cfg.cellText(r, c) : v
  }
  // 排序后的行（不排时【原样返回源数组】，引用不变、零开销）
  const rows = computed(() => {
    const base = cfg.rows() || []
    const s = sort.value
    if (!sortable || !s.key || !s.dir) return base
    const col = (cfg.cols() || []).find((c) => c.key === s.key)
    if (!col) return base
    const dir = s.dir
    return base.map((r, i) => ({ r, i })).sort((a, b) => {
      const va = sortVal(a.r, col), vb = sortVal(b.r, col)
      const ea = va == null || va === '' || (typeof va === 'number' && !Number.isFinite(va))
      const eb = vb == null || vb === '' || (typeof vb === 'number' && !Number.isFinite(vb))
      if (ea && eb) return a.i - b.i
      if (ea) return 1                       // 空值恒沉底（升降序都一样，与 Excel 一致）
      if (eb) return -1
      let d
      if (typeof va === 'number' && typeof vb === 'number') d = va - vb
      else d = String(va).localeCompare(String(vb), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      return d !== 0 ? d * dir : a.i - b.i   // 同值保持原序（稳定排序）
    }).map((x) => x.r)
  })
  const rowList = () => rows.value

  // ============ 冻结列：纯呈现层，不动数据、不动任何取值 ============
  // 照搬链路预算 StationGrid 的那套（见 src/linkbudget/StationGrid.vue）。不是 Excel 的「冻结窗格」
  // （那个只能冻最左边连续一段），是 Airtable / AG Grid 那套**固定列**：任选一组列钉住，
  // 钉住的整体提到最左并按列的原序排，原位置不再有它。
  //
  // ★ 存的是一组**列 key**（不是列数）：父组件调了列序、或用户改了"显示哪些列"之后，仍钉在同一批列上。
  //   null＝用户没设过（不冻结），[]＝用户显式取消了全部冻结。
  // ★★ 关键不变式：colList() 出的是**显示序**。选区 / 复制 / 粘贴 / 填充 / 左右导航全部按它遍历 ——
  //    否则钉住的列被提到最左之后，框出来的一片和复制出来的一片就对不上了。
  const fzStore = cfg.gridId ? 'eg/freeze/' + cfg.gridId : ''
  const pinned = ref((() => {
    if (!fzStore) return null
    try {
      const raw = localStorage.getItem(fzStore)
      if (raw == null) return null
      if (raw === '') return []
      const a = JSON.parse(raw)
      return Array.isArray(a) ? a.filter((k) => typeof k === 'string') : null
    } catch (e) { return null }
  })())
  watch(pinned, (v) => {
    if (!fzStore) return
    try { v == null ? localStorage.removeItem(fzStore) : localStorage.setItem(fzStore, JSON.stringify(v)) } catch (e) { /* 配额满等忽略 */ }
  })
  const pinnedSet = computed(() => new Set(pinned.value || []))
  const isPinned = (c) => !!c && pinnedSet.value.has(c.key)
  // 显示序：钉住的整体提到最左（内部仍按列的原序），其余照旧
  const visCols = computed(() => {
    const all = cfg.cols() || []
    const on = [], off = []
    for (const c of all) (pinnedSet.value.has(c.key) ? on : off).push(c)
    return on.length ? on.concat(off) : all
  })
  // 冻结列数（显示序口径）。★ 至少留一列随滚：全冻结等于没冻结，还会把滚动区压没。
  const frozenCount = computed(() => {
    const v = visCols.value
    return Math.min(v.filter((c) => pinnedSet.value.has(c.key)).length, Math.max(0, v.length - 1))
  })
  const isFrozen = (ci) => ci < frozenCount.value
  // 写入冻结集：恒按列的原序存（先钉后钉不影响冻结区内的排列），并保证至少留一列随滚
  function setPinned(keys) {
    const want = new Set(keys)
    const all = cfg.cols() || []
    if (all.length && all.every((c) => want.has(c.key))) want.delete(all[all.length - 1].key)
    pinned.value = all.filter((c) => want.has(c.key)).map((c) => c.key)
  }
  /** 拖冻结条：把**显示序**最前 n 列钉住（滚动区第一列就在线的右边，拖到哪儿钉到哪儿） */
  function setFreeze(n) {
    const v = visCols.value
    setPinned(v.slice(0, Math.max(0, Math.min(n, v.length - 1))).map((c) => c.key))
  }
  function unfreeze() { setPinned([]) }
  // 「冻结此列」作用集＝选区跨过的列；整选区都已冻结时按钮翻成「取消冻结此列」
  const pinTargets = computed(() => {
    const r = rect.value, v = visCols.value
    if (r.c0 < 0) return []
    const out = []
    for (let c = Math.max(0, r.c0); c <= Math.min(r.c1, v.length - 1); c++) if (v[c]) out.push(v[c])
    return out
  })
  const pinAllOn = computed(() => pinTargets.value.length > 0 && pinTargets.value.every(isPinned))
  const canPin = computed(() => pinTargets.value.length > 0)
  function togglePin(cols) {
    const list = cols && cols.length ? cols : pinTargets.value
    if (!list.length) return
    const allOn = list.every(isPinned)
    const next = new Set(pinned.value || [])
    for (const c of list) { if (allOn) next.delete(c.key); else next.add(c.key) }
    setPinned(next)
  }

  // 冻结列的左偏移：**实测**列宽逐列累加（列宽随内容/字号/中英文变，写死必错位）。
  // 量出来后以 CSS 变量挂在 <table> 上：宽度一变只改这一个元素的 style，不惊动成千上万个格子
  // （每个格的 left 是常量串 var(--egfN)，不因宽度变化重渲染）。由 ExcelGrid 负责测量并写回。
  const fzOff = ref([38])                     // [序号列宽, +第1冻结列宽, …]，长度＝冻结列数+1
  const fzW = computed(() => fzOff.value[Math.min(frozenCount.value, fzOff.value.length - 1)] || 0)
  const fzVars = computed(() => {
    const o = {}
    fzOff.value.forEach((v, i) => { o['--egf' + i] = v.toFixed(2) + 'px' })
    o['--eg-fzw'] = fzW.value.toFixed(2) + 'px'
    return o
  })
  const fzStyle = (ci) => (ci < frozenCount.value ? { left: 'var(--egf' + ci + ')' } : null)

  const colList = () => visCols.value

  const rect = computed(() => {
    const s = sel.value
    return { r0: Math.min(s.ar, s.ri), r1: Math.max(s.ar, s.ri), c0: Math.min(s.ac, s.ci), c1: Math.max(s.ac, s.ci) }
  })
  const inSel = (ri, ci) => { const r = rect.value; return r.r0 >= 0 && ri >= r.r0 && ri <= r.r1 && ci >= r.c0 && ci <= r.c1 }
  const isActive = (ri, ci) => sel.value.ri === ri && sel.value.ci === ci
  const isEdit = (ri, ci) => edit.value.ri === ri && edit.value.ci === ci
  const colEditable = (c) => !cfg.readOnly && !!c && c.editable !== false
  // 整行/整列是否落在选区里（序号列与列头的高亮）
  const rowSelected = (ri) => { const r = rect.value; return r.r0 >= 0 && ri >= r.r0 && ri <= r.r1 && r.c0 === 0 && r.c1 >= colList().length - 1 }
  const colSelected = (ci) => { const r = rect.value, n = rowList().length; return n > 0 && r.r0 === 0 && r.r1 >= n - 1 && ci >= r.c0 && ci <= r.c1 }

  // ===== 列宽（table-layout:fixed + 显式列宽 → 才真的可拖、可省略号）=====
  const widths = ref({})                     // colKey → px
  const widthOf = (c) => (c ? (widths.value[c.key] || c.w || DEFAULT_W) : DEFAULT_W)
  const setWidth = (c, px) => { if (c) widths.value = { ...widths.value, [c.key]: Math.max(MIN_W, Math.round(px)) } }
  // 文本量宽：拿单元格的真实字体走 canvas 量，避免「改 table-layout 再读回布局」的抖动。
  let _mctx = null
  function measureCtx() {
    if (!_mctx) { const cv = document.createElement('canvas'); _mctx = cv.getContext('2d') }
    return _mctx
  }
  function fontOf(el, bold) {
    const cs = getComputedStyle(el)
    return (bold ? '600 ' : cs.fontWeight + ' ') + cs.fontSize + ' ' + cs.fontFamily
  }
  // 某列的自动列宽 = max(表头, 前 N 行内容) + 内边距。量不到 DOM（未上屏）时回退 col.w / 兜底值。
  function autoWidth(col) {
    const el = bodyEl.value
    if (!el || !col) return col && col.w ? col.w : DEFAULT_W
    const th = el.querySelector('thead th[data-k="' + cssEsc(col.key) + '"]')
    const td = el.querySelector('tbody td')
    const ctx = measureCtx()
    const pad = 18                                   // 左右各 8px 内边距 + 2px 余量（与 .perf-tbl td 一致）
    let w = 0
    if (th) { ctx.font = fontOf(th, true); w = ctx.measureText(th.innerText || '').width + (sortable ? 12 : 0) }
    const base = td || th
    if (base) {
      ctx.font = fontOf(base, false)
      const list = rowList()
      const n = Math.min(list.length, MEASURE_ROWS)
      for (let i = 0; i < n; i++) {
        const t = cfg.cellText ? cfg.cellText(list[i], col) : String(list[i][col.key] == null ? '' : list[i][col.key])
        const m = ctx.measureText(t).width
        if (m > w) w = m
      }
    }
    return Math.max(MIN_W, Math.min(360, Math.ceil(w + pad)))
  }
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&')
  // 列集变化（选项里勾了新列 / 换了视图）时给没量过的列补一次列宽；量过的保持用户拖过的值。
  // 口径「只增不减」：以列定义里写死的 col.w 为底（那是设计过的），装不下才按内容放宽——
  // 纯按内容量会让「当前恰好全是 —」的列缩成一条，等数据来了还是那么窄。
  function fitMissing() {
    const cols = colList()
    if (!cols.length) return
    const miss = cols.filter((c) => widths.value[c.key] == null)
    if (!miss.length) return
    const next = { ...widths.value }
    for (const c of miss) next[c.key] = Math.max(c.w || 0, autoWidth(c))
    widths.value = next
  }
  function autoFitCol(col) { if (col) setWidth(col, autoWidth(col)) }
  function autoFitAll() { const next = {}; for (const c of colList()) next[c.key] = autoWidth(c); widths.value = next }
  // 列宽拖拽（列头右缘那道把手）
  let rzCol = null, rzX = 0, rzW = 0
  const resizing = ref(false)
  function onResizeDown(e, col) {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    rzCol = col; rzX = e.clientX; rzW = widthOf(col); resizing.value = true
    const mv = (ev) => { if (rzCol) setWidth(rzCol, rzW + (ev.clientX - rzX)) }
    const up = () => { rzCol = null; resizing.value = false; window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
  }
  watch(() => colList().map((c) => c.key).join('\u0001'), () => { nextTick(fitMissing) })
  onMounted(() => nextTick(fitMissing))

  // 活动格那个常驻捕获输入框的【真实】句柄。
  // ★ 不能只信模板 :ref —— 活动格从第 5 行移到第 2 行时，Vue 先挂新行的 input（ref→元素）、再卸旧行的
  //   （ref→null），editEl 被后到的 null 抹掉；于是「往上点一格就取不到焦点」，键入无处可落，
  //   只有双击（edit 的 watch 里显式 focus）才进得去编辑。表现正是「直接输入不了，得双击」。
  //   同一时刻表内至多一个 .eg-cap（只渲染在活动格），从 DOM 里查是确定性的，与链路预算 StationGrid.capEl() 同法。
  function capEl() {
    const el = editEl.value
    if (el && el.isConnected) return el
    const root = bodyEl.value
    const q = root ? root.querySelector('input.eg-cap') : null
    if (q !== editEl.value) editEl.value = q
    return q
  }
  // 容器内的独立表单控件（加站行输入框等，非本网格的单元格编辑器）：事件不接管，否则会抢焦点/劫持按键
  const foreignControl = (e) => {
    const t = e && e.target, tag = t && t.tagName
    return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && t !== capEl()
  }
  // 焦点优先落在活动格的常驻捕获输入框（导航/编辑共用同一 <input>）——这样中文输入法从首个拼音字母起就有真实可编辑目标，
  // 不再吞首字母。点击编辑器内部：foreignControl 放行（t===editEl 返回 false），此处再 focus 同一元素无 blur、不会误提交。
  // 只读表 / RO 等无捕获框的格退回容器本身。取焦点一律 preventScroll，滚动交给 ensureVisible（见文件头）。
  function focusGrid(e) {
    if (foreignControl(e)) return
    nextTick(() => {
      const el = capEl()
      if (el) el.focus({ preventScroll: true })
      else if (bodyEl.value) bodyEl.value.focus({ preventScroll: true })
      ensureVisible()
    })
  }
  // —— 活动格可见性（Excel 口径：只补差额的最小滚动）——
  // sticky 覆盖层（上：表头；左：序号列）按「可视内容区」内缩掉，活动格才不会藏在它们后面；
  // 用 clientWidth/clientHeight 而非 rect 宽高，滚动条占位也自然扣除。鼠标框选/拖填充/拖列宽期间不介入。
  function ensureVisible() {
    if (dragging || fill.active || rowDrag || colDrag || resizing.value) return
    const el = bodyEl.value; if (!el) return
    const cell = el.querySelector('td.active'); if (!cell) return
    const head = el.querySelector('thead')
    const idx = el.querySelector('tbody td.eg-idx')
    const padTop = head ? head.offsetHeight : 0
    const padLeft = idx ? idx.offsetWidth : 0
    const cr = cell.getBoundingClientRect(), sr = el.getBoundingClientRect()
    const vl = sr.left + padLeft, vr = sr.left + el.clientWidth
    let dx = 0
    if (cr.right > vr) dx = cr.right - vr
    if (cr.left - dx < vl) dx = cr.left - vl        // 格比可视区还宽时靠左对齐（与 Excel 一致）
    if (dx) el.scrollLeft += dx
    const vt = sr.top + padTop, vb = sr.top + el.clientHeight
    let dy = 0
    if (cr.bottom > vb) dy = cr.bottom - vb
    if (cr.top - dy < vt) dy = cr.top - vt
    if (dy) el.scrollTop += dy
  }
  // 滚轮（Excel 口径）：竖滚只管纵向，横滚只认 Shift+滚轮/触控板横向手势。表内纵向滚不动时把竖滚转给
  // 最近可滚祖先——Chromium 对「只有横向能滚」的容器会把竖滚折成横滚（底部横条自己乱跑的另一半原因）。
  function scrollableAncestorY(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowY
      if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight - p.clientHeight > 1) return p
    }
    return null
  }
  function onWheel(e) {
    const el = bodyEl.value
    if (!el || e.ctrlKey || e.shiftKey) return
    const dy = e.deltaY
    if (!dy || Math.abs(e.deltaX) >= Math.abs(dy)) return
    const room = el.scrollHeight - el.clientHeight
    if (room > 1 && (dy > 0 ? el.scrollTop < room - 1 : el.scrollTop > 1)) return   // 表内还能纵滚：原生
    e.preventDefault()
    const anc = scrollableAncestorY(el)
    if (anc) anc.scrollTop += dy * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? anc.clientHeight : 1)
  }

  function setSel(ri, ci, extend) { const s = sel.value; sel.value = extend && s.ar >= 0 ? { ar: s.ar, ac: s.ac, ri, ci } : { ar: ri, ac: ci, ri, ci } }
  function cellDown(e, ri, ci) {
    if (isEdit(ri, ci)) return                        // 正在编辑此格 → 交给 input
    if (e.button !== 0) return                        // 右键：交给 contextmenu（不改选区、不起拖拽）
    e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    setSel(ri, ci, e.shiftKey); dragging = !e.shiftKey; focusGrid()
    if (dragging) { pointerX = e.clientX; pointerY = e.clientY; window.addEventListener('mousemove', onDragMove) }
  }
  function cellEnter(ri, ci) {
    if (fill.active) { fill.toR = Math.max(fill.r1, ri); return }   // 填充柄拖拽：只向下跟踪行
    if (dragging) setSel(ri, ci, true)
    else if (rowDrag) selectRows(rowAnchor, ri)
    else if (colDrag) selectCols(colAnchor, ci)
  }
  const rowHeadEnter = (ri) => { if (rowDrag) selectRows(rowAnchor, ri); else if (fill.active) fill.toR = Math.max(fill.r1, ri) }
  const colHeadEnter = (ci) => { if (colDrag) selectCols(colAnchor, ci) }
  // 边缘自动滚动一帧：按指针距边缘的深度决定速度，越靠边越快；仍在边缘带内则继续下一帧（指针静止也持续滚）。
  const edgeVel = (over, edge) => Math.min(30, 2 + (over / edge) * 18)
  function edgeAutoScroll() {
    autoRAF = 0
    if (!(dragging || fill.active || rowDrag || colDrag)) return
    const el = bodyEl.value; if (!el) return
    const r = el.getBoundingClientRect(), EDGE = 28
    const right = r.left + el.clientWidth, bottom = r.top + el.clientHeight   // 扣掉滚动条占位，鼠标压在横条上不算越界
    let dx = 0, dy = 0
    if (pointerY < r.top + EDGE) dy = -edgeVel(r.top + EDGE - pointerY, EDGE)
    else if (pointerY > bottom - EDGE) dy = edgeVel(pointerY - (bottom - EDGE), EDGE)
    if (pointerX < r.left + EDGE) dx = -edgeVel(r.left + EDGE - pointerX, EDGE)
    else if (pointerX > right - EDGE) dx = edgeVel(pointerX - (right - EDGE), EDGE)
    if (dy) el.scrollTop += dy
    if (dx) el.scrollLeft += dx
    if (dx || dy) autoRAF = requestAnimationFrame(edgeAutoScroll)
  }
  function onDragMove(e) {
    if (!(dragging || fill.active || rowDrag || colDrag)) return
    pointerX = e.clientX; pointerY = e.clientY
    if (!autoRAF) autoRAF = requestAnimationFrame(edgeAutoScroll)
  }
  function armDrag(e) { pointerX = e.clientX; pointerY = e.clientY; window.addEventListener('mousemove', onDragMove) }
  function stopDrag() {
    if (fill.active) { fill.active = false; applyFill() }
    dragging = false; rowDrag = false; colDrag = false
    window.removeEventListener('mousemove', onDragMove)
    if (autoRAF) { cancelAnimationFrame(autoRAF); autoRAF = 0 }
  }
  function up() { stopDrag() }

  // ===== 序号列（点/拖选整行；Shift 从锚点扩展）与列头（点/拖选整列）=====
  function selectRows(a, b) {
    const nc = colList().length; if (!nc) return
    sel.value = { ar: Math.min(a, b), ac: 0, ri: Math.max(a, b), ci: nc - 1 }
  }
  function selectCols(a, b) {
    const nr = rowList().length; if (!nr) return
    sel.value = { ar: 0, ac: Math.min(a, b), ri: nr - 1, ci: Math.max(a, b) }
  }
  function selectAll() {
    const nr = rowList().length, nc = colList().length
    if (nr && nc) sel.value = { ar: 0, ac: 0, ri: nr - 1, ci: nc - 1 }
  }
  function rowHeadDown(e, ri) {
    if (e.button !== 0) return
    e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    if (e.shiftKey && rowAnchor >= 0) selectRows(rowAnchor, ri)
    else { rowAnchor = ri; selectRows(ri, ri) }
    rowDrag = true; armDrag(e); focusGrid()
  }
  function colHeadDown(e, ci) {
    if (e.button !== 0) return
    e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    if (e.shiftKey && colAnchor >= 0) selectCols(colAnchor, ci)
    else { colAnchor = ci; selectCols(ci, ci) }
    colDrag = true; armDrag(e); focusGrid()
  }

  // ===== Excel 填充柄（选区右下角小方块）：拖动/双击向下填充整个选区的列，按选中行循环复制 =====
  const fill = reactive({ active: false, r0: 0, r1: 0, c0: 0, c1: 0, toR: 0 })
  const inFill = (ri, ci) => fill.active && ci >= fill.c0 && ci <= fill.c1 && ri > fill.r1 && ri <= fill.toR
  const isFillAnchor = (ri, ci) => !cfg.readOnly && ri === rect.value.r1 && ci === rect.value.c1 && rect.value.r0 >= 0
  function onFillDown(e) {
    if (cfg.readOnly || e.button !== 0) return
    e.stopPropagation(); e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    const rc = rect.value
    fill.active = true; fill.r0 = rc.r0; fill.r1 = rc.r1; fill.c0 = rc.c0; fill.c1 = rc.c1; fill.toR = rc.r1
    armDrag(e); focusGrid()
  }
  // 把选区(r0..r1 × c0..c1)按行循环向下填到 toR（不可编辑列跳过）
  function fillDownTo(r0, r1, c0, c1, toR) {
    if (cfg.readOnly || !cfg.onEdit) return
    const list = rowList(), cols = colList()
    const lo = r1 + 1, hi = Math.min(toR, list.length - 1)
    if (hi < lo) return
    const srcN = r1 - r0 + 1
    const jobs = []
    for (let ri = lo; ri <= hi; ri++) {
      const row = list[ri], src = list[r0 + ((ri - lo) % srcN)]
      if (!row || !src) continue
      for (let ci = c0; ci <= c1; ci++) {
        const c = cols[ci]; if (!colEditable(c)) continue
        const v = cfg.cellRaw ? cfg.cellRaw(src, c) : src[c.key]
        jobs.push([row.id, c.key, v == null ? '' : String(v)])
      }
    }
    if (!jobs.length) return
    cfg.pushUndo && cfg.pushUndo()
    for (const [id, key, v] of jobs) cfg.onEdit(id, key, v)
    cfg.refresh && cfg.refresh()
    sel.value = { ar: r0, ac: c0, ri: hi, ci: c1 }
  }
  function applyFill() { fillDownTo(fill.r0, fill.r1, fill.c0, fill.c1, fill.toR) }
  // Ctrl+D：把选区首行填满整个选区（Excel 口径）
  function fillDown() { const rc = rect.value; if (rc.r0 >= 0 && rc.r1 > rc.r0) fillDownTo(rc.r0, rc.r0, rc.c0, rc.c1, rc.r1) }
  function onFillDbl(e) {   // 双击填充柄 → 从选区底部一直填到最后一行
    e.stopPropagation()
    const rc = rect.value, n = rowList().length
    if (rc.r1 >= n - 1) return
    fillDownTo(rc.r0, rc.r1, rc.c0, rc.c1, n - 1)
  }

  function tryEdit(ri, ci, seed) {   // F2/双击/Backspace 进入：由 watch 用 seed/原值重置 input（键入进入走 beginActiveEdit，不经此）
    const c = colList()[ci]; if (!colEditable(c)) return
    sel.value = { ar: ri, ac: ci, ri, ci }; editSeed.value = seed; editTyped.value = false; editReady.value = false; edit.value = { ri, ci }
  }
  // 键入/输入法在活动格常驻捕获框内直接开始编辑：input 里已落有首字母/组字内容，故置 editTyped 让 watch 不重置、不全选。
  function beginActiveEdit() {
    const { ri, ci } = sel.value
    if (ri < 0 || edit.value.ri >= 0 || cfg.readOnly) return false
    const c = colList()[ci]; if (!colEditable(c)) return false
    // editTyped 让 watch 不重置 input（保留已键入内容）；editSeed 置非空('' 而非 null) 只为标记「键入进入=Excel 回车模式」
    // → 编辑中按方向键＝提交并移动（F2/双击的 null 则方向键移光标）。'' 不会被写进 input：watch 因 editTyped 提前返回。
    editTyped.value = true; editSeed.value = ''; editReady.value = true; edit.value = { ri, ci }
    return true
  }
  function onActiveCompStart() { beginActiveEdit() }
  function onActiveInput(e) { if (edit.value.ri < 0 && !beginActiveEdit()) e.target.value = '' }
  function onActiveBlur() { if (edit.value.ri >= 0) commitEdit() }   // 失焦提交；导航态失焦、内容未就位（见 editReady）不写
  function onActivePaste(e, r, key) { if (edit.value.ri < 0) { e.preventDefault(); return } cellPaste(e, r, key) }   // 导航态整块粘贴交给 gridKey.doPaste
  function onActiveClip(e) { if (edit.value.ri < 0) e.preventDefault() }   // 导航态屏蔽原生复制/剪切，交给 gridKey 的整块逻辑
  function rawText(r, c) { const v = cfg.cellRaw ? cfg.cellRaw(r, c) : r[c.key]; return v == null ? '' : String(v) }
  function commitEdit() {
    const { ri, ci } = edit.value; if (ri < 0) return
    const ready = editReady.value                       // 见 editReady：内容没就位就一律不写（否则空框会把格子抹了）
    const el = capEl(), r = rowList()[ri], c = colList()[ci]
    edit.value = { ri: -1, ci: -1 }; editSeed.value = null; editReady.value = false
    if (ready && el && r && c && el.value !== rawText(r, c)) {   // 仅值确实变化才记撤销
      cfg.pushUndo && cfg.pushUndo(); cfg.onEdit && cfg.onEdit(r.id, c.key, el.value)
    }
    if (el) el.value = ''   // 复位捕获框为空 → 回到导航态，下次「键入即替换」（值靠 ghost span 显示）
    cfg.refresh && cfg.refresh()
  }
  function cancelEdit() { const el = capEl(); if (el) el.value = ''; edit.value = { ri: -1, ci: -1 }; editSeed.value = null; editReady.value = false; focusGrid() }
  function move(dr, dc, extend) {
    const nr = rowList().length, nc = colList().length; if (!nr || !nc) return
    let ri = sel.value.ri < 0 ? 0 : sel.value.ri, ci = sel.value.ci < 0 ? 0 : sel.value.ci
    ri = Math.min(nr - 1, Math.max(0, ri + dr)); ci = Math.min(nc - 1, Math.max(0, ci + dc))
    setSel(ri, ci, extend)
  }
  // Tab/Shift+Tab：走到本行末列换到下一行首列（反向亦然），与 Excel 一致——夹在末列原地不动的话，
  // 一行填到头就得手动回首列。到表尾/表首无处可换时保持原地。
  function tabMove(back) {
    const nr = rowList().length, nc = colList().length; if (!nr || !nc) return
    const { ri, ci } = sel.value
    if (ri < 0) { setSel(0, 0, false); return }
    if (!back && ci >= nc - 1) { if (ri < nr - 1) setSel(ri + 1, 0, false); return }
    if (back && ci <= 0) { if (ri > 0) setSel(ri - 1, nc - 1, false); return }
    setSel(ri, ci + (back ? -1 : 1), false)
  }
  function rangeTSV(withHeader) {
    const list = rowList(), cols = colList(), rc = rect.value
    if (rc.r0 < 0 || !list.length) return ''
    const lines = []
    if (withHeader) { const h = []; for (let ci = rc.c0; ci <= rc.c1; ci++) { const c = cols[ci]; h.push(c ? (c.label == null ? c.key : c.label) : '') } lines.push(h.join('\t')) }
    for (let ri = rc.r0; ri <= rc.r1; ri++) {
      const r = list[ri]; if (!r) continue
      const cells = []; for (let ci = rc.c0; ci <= rc.c1; ci++) cells.push(cfg.cellText(r, cols[ci]))
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }
  // 同步优先：execCommand('copy') 必须在用户手势（keydown/click）同步栈内执行才有效；
  // 一旦 await 过 navigator.clipboard 就丢失 user activation，故把同步路径放第一位，异步 API 仅兜底。
  function writeClip(text) {
    let ok = false
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch { ok = false }
    if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch {} }
    return ok
  }
  function copySel(withHeader) { const t = rangeTSV(withHeader); if (t) { writeClip(t); focusGrid() } }
  function cutSel() { if (cfg.readOnly) return; copySel(false); clearRange() }
  function clearRange() {
    if (cfg.readOnly || !cfg.onClear) return
    const list = rowList(), cols = colList(), rc = rect.value; if (rc.r0 < 0) return
    const cells = []
    for (let ri = rc.r0; ri <= rc.r1; ri++) { const r = list[ri]; if (!r) continue; for (let ci = rc.c0; ci <= rc.c1; ci++) { const c = cols[ci]; if (colEditable(c)) cells.push({ rowId: r.id, key: c.key }) } }
    if (!cells.length) return
    cfg.pushUndo && cfg.pushUndo(); cfg.onClear(cells); cfg.refresh && cfg.refresh()
  }
  // 非编辑态 Ctrl+V：容器不可编辑时浏览器不派发 paste，故读剪贴板。有选区→按左上角定位填充；空表/未选→整块追加。
  async function doPaste() {
    if (cfg.readOnly) return
    let text = ''
    try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请用「粘贴」按钮'); return }
    if (!text || !text.trim()) return
    cfg.pushUndo && cfg.pushUndo()
    const rc = rect.value, list = rowList(), c = colList()[rc.c0]
    const anchorId = (rc.r0 >= 0 && list[rc.r0]) ? list[rc.r0].id : null
    const n = (anchorId && c && cfg.onPasteBlock) ? cfg.onPasteBlock(anchorId, c.key, text) : (cfg.onPasteAppend ? cfg.onPasteAppend(text) : 0)
    if (n) { cfg.refresh && cfg.refresh() } else { cfg.dropUndo && cfg.dropUndo() }
  }
  // 编辑中 input 内 Ctrl+V：多格块（含制表符/换行，即来自 Excel 的多单元格复制）→ 以该格定位填充；
  // 其余（含逗号的普通文本如 "Washington, DC"）与 Excel 一致，按字面粘进单元格。
  function cellPaste(e, r, key) {
    if (cfg.readOnly || !cfg.onPasteBlock) return
    const text = e.clipboardData ? e.clipboardData.getData('text') : ''
    if (!text || !/[\t\n]/.test(text.trim())) return
    e.preventDefault()
    cfg.pushUndo && cfg.pushUndo()
    const n = cfg.onPasteBlock(r ? r.id : null, key, text)
    if (n) { cfg.refresh && cfg.refresh() } else { cfg.dropUndo && cfg.dropUndo() }
  }

  // ===== 插入 / 删除行（右键菜单与工具条共用；行集 = 当前选区跨过的行）=====
  const canInsert = computed(() => !cfg.readOnly && !!cfg.onInsertRows)
  const canDelete = computed(() => !cfg.readOnly && !!cfg.onDeleteRows)
  function selRowSpan() { const rc = rect.value; return rc.r0 < 0 ? null : { lo: rc.r0, hi: Math.min(rc.r1, rowList().length - 1) } }
  function insertRows(below) {
    if (!canInsert.value) return
    const sp = selRowSpan()
    const n = rowList().length
    const count = sp ? (sp.hi - sp.lo + 1) : 1
    const at = sp ? (below ? sp.hi + 1 : sp.lo) : n
    cfg.pushUndo && cfg.pushUndo()
    const added = cfg.onInsertRows(at, count) || 0
    if (!added) { cfg.dropUndo && cfg.dropUndo(); return }
    cfg.refresh && cfg.refresh()
    const nc = colList().length
    nextTick(() => { sel.value = { ar: at, ac: 0, ri: at + added - 1, ci: Math.max(0, nc - 1) }; focusGrid() })
  }
  function deleteRows() {
    if (!canDelete.value) return
    const sp = selRowSpan(); if (!sp) return
    const list = rowList()
    const ids = []
    for (let ri = sp.lo; ri <= sp.hi; ri++) if (list[ri]) ids.push(list[ri].id)
    if (!ids.length) return
    cfg.pushUndo && cfg.pushUndo()
    const n = cfg.onDeleteRows(ids) || 0
    if (!n) { cfg.dropUndo && cfg.dropUndo(); return }
    cfg.refresh && cfg.refresh()
    nextTick(() => {   // 删完让选区落到接替的那一行（连续删除的手感连贯）
      const left = rowList().length
      if (!left) { sel.value = { ar: -1, ac: -1, ri: -1, ci: -1 }; return }
      const at = Math.min(sp.lo, left - 1)
      selectRows(at, at); focusGrid()
    })
  }

  // ===== 右键菜单 =====
  const menu = reactive({ open: false, x: 0, y: 0, col: null })
  function openMenu(e, ri, ci) {
    e.preventDefault()
    if (edit.value.ri >= 0) commitEdit()
    if (ri != null && ci != null && !inSel(ri, ci)) setSel(ri, ci, false)   // 右键落在选区外 → 选区跳到该格（与 Excel 一致）
    menu.col = ci != null ? (colList()[ci] || null) : null
    menu.x = Math.min(e.clientX, window.innerWidth - 200)
    menu.y = Math.min(e.clientY, window.innerHeight - 300)
    menu.open = true
    focusGrid()
  }
  function rowHeadMenu(e, ri) { if (!inSel(ri, 0) || !rowSelected(ri)) { rowAnchor = ri; selectRows(ri, ri) } openMenu(e, null, null) }
  function closeMenu() { menu.open = false }
  function menuDo(fn) { menu.open = false; fn() }

  function gridKey(e) {
    if (foreignControl(e)) return   // 加站行等独立输入框内的按键：交还给输入框本身
    if (e.isComposing || e.keyCode === 229) return   // 输入法组字中：放行——导航态让首字母落进捕获框，编辑态让 Enter/Esc 去确认/取消候选（勿提交单元格）
    const ctrl = e.ctrlKey || e.metaKey
    if (edit.value.ri >= 0) {                          // 编辑态：提交/取消/跳格；其余键交给 input（含原生撤销/粘贴）
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); focusGrid() }
      else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); tabMove(e.shiftKey); focusGrid() }
      else if (editSeed.value != null && e.key.startsWith('Arrow')) {
        // Excel「键入模式」（直接键入进入编辑）：方向键=提交并移动；F2/双击进入的「编辑模式」方向键仍移光标
        e.preventDefault(); commitEdit()
        move(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0)
        focusGrid()
      }
      return
    }
    if (menu.open && e.key === 'Escape') { e.preventDefault(); closeMenu(); return }
    if (ctrl && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); copySel(e.shiftKey); return }   // Ctrl+Shift+C = 连表头一起复制
    if (ctrl && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAll(); return }
    if (!cfg.readOnly && ctrl && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); cutSel(); return }
    if (!cfg.readOnly && ctrl && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); doPaste(); return }
    if (!cfg.readOnly && ctrl && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); fillDown(); return }   // Excel Ctrl+D：向下填充
    if (cfg.undo && ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); cfg.undo(); return }
    if (cfg.redo && ctrl && (e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) { e.preventDefault(); cfg.redo(); return }
    if (ctrl && e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); insertRows(false); return }   // Excel Ctrl+Shift++ 插入行
    if (ctrl && e.key === '-') { e.preventDefault(); deleteRows(); return }                                        // Excel Ctrl+- 删除行
    const { ri, ci } = sel.value; if (ri < 0) return
    const ext = e.shiftKey, J = ctrl ? Infinity : 1    // Ctrl+方向键 = 跳到边缘（对标 Excel Ctrl+Arrow）
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(-J, 0, ext); break
      case 'ArrowDown': e.preventDefault(); move(J, 0, ext); break
      case 'ArrowLeft': e.preventDefault(); move(0, -J, ext); break
      case 'ArrowRight': e.preventDefault(); move(0, J, ext); break
      case 'PageUp': { e.preventDefault(); const el = bodyEl.value; const step = el ? Math.max(1, Math.floor(el.clientHeight / 22) - 1) : 10; move(-step, 0, ext); break }
      case 'PageDown': { e.preventDefault(); const el = bodyEl.value; const step = el ? Math.max(1, Math.floor(el.clientHeight / 22) - 1) : 10; move(step, 0, ext); break }
      case ' ': if (ctrl) { e.preventDefault(); selectCols(ci, ci) } else if (e.shiftKey) { e.preventDefault(); selectRows(ri, ri) } break   // Excel：Ctrl+空格选整列 / Shift+空格选整行
      case 'Home': e.preventDefault(); if (ctrl) setSel(0, 0, ext); else setSel(ri, 0, ext); break
      case 'End': { e.preventDefault(); const nr = rowList().length, nc = colList().length; if (nr && nc) { if (ctrl) setSel(nr - 1, nc - 1, ext); else setSel(ri, nc - 1, ext) } break }
      case 'Enter': e.preventDefault(); move(ext ? -1 : 1, 0, false); break
      case 'Tab': e.preventDefault(); tabMove(ext); break
      case 'F2': if (!cfg.readOnly) { e.preventDefault(); tryEdit(ri, ci, null) } break
      case 'Delete': if (!cfg.readOnly) { e.preventDefault(); clearRange() } break
      case 'Backspace': if (!cfg.readOnly) { e.preventDefault(); tryEdit(ri, ci, '') } break   // Excel：Backspace=清空活动格并进入编辑
      default: break
        // 可见字符 / 输入法：不在此合成编辑、不 preventDefault——放行让按键自然落进活动格那个已获焦的常驻捕获框，
        // 由其 @input/@compositionstart（onActiveInput/onActiveCompStart）就地进入编辑。这样中文输入法从第一个拼音字母起就有真实 <input> 目标，不吞首字母。
    }
  }
  // 进入编辑后初始化 input：值在此【一次性命令式】写入，模板不得绑 :value——单向绑定会在组件任意
  // 重渲染（实时时钟每秒都在触发）时把绑定值刷回 DOM，吞掉正在键入的内容。键入进入→光标末尾；F2/双击进入→全选。
  watch(() => edit.value, (v) => {
    if (v.ri < 0) return
    if (editTyped.value) { editTyped.value = false; return }   // 键入/输入法就地进入：input 里已有刚键入内容，勿重置/全选（否则清掉正在组字的拼音）
    nextTick(() => {
      if (edit.value.ri < 0) return          // 这一拍里已被提交/取消：别再把原值回填进导航态的框（下次键入就成了追加）
      const el = capEl(); if (!el) return
      const r = rowList()[v.ri], c = colList()[v.ci]
      el.value = editSeed.value != null ? String(editSeed.value) : (r && c ? rawText(r, c) : '')
      editReady.value = true                 // 内容就位，此后失焦/回车才允许提交
      el.focus({ preventScroll: true })
      if (editSeed.value == null) el.select()
      else { const n = el.value.length; el.setSelectionRange(n, n) }
    })
  })
  // 活动格变化（键盘导航 / 鼠标框选）后把焦点移到新活动格的常驻捕获框，让输入法始终有真实编辑目标；编辑中不抢焦点。
  watch(() => [sel.value.ri, sel.value.ci], () => {
    if (edit.value.ri >= 0) return
    nextTick(() => {
      const el = capEl()
      if (el) el.focus({ preventScroll: true })
      else if (bodyEl.value) bodyEl.value.focus({ preventScroll: true })
      ensureVisible()
    })
  })
  onMounted(() => window.addEventListener('mouseup', up))
  onBeforeUnmount(() => { window.removeEventListener('mouseup', up); stopDrag() })

  return {
    readOnly: !!cfg.readOnly,
    sel, edit, editSeed, editEl, bodyEl, rect, rows, inSel, isActive, isEdit, colEditable,
    rowSelected, colSelected, selectAll,
    focusGrid, ensureVisible, onWheel, cellDown, cellEnter, tryEdit, commitEdit, cancelEdit, gridKey, cellPaste,
    copySel, cutSel, doPaste, clearRange, tabMove,
    onActiveInput, onActiveCompStart, onActiveBlur, onActivePaste, onActiveClip,
    // 序号列 / 列头
    rowHeadDown, colHeadDown, rowHeadMenu, rowHeadEnter, colHeadEnter,
    // 排序
    sortable, sort, sortDirOf, setSort, toggleSort, clearSort,
    // 列宽
    widths, widthOf, setWidth, autoFitCol, autoFitAll, onResizeDown, resizing,
    // 填充柄
    fill, inFill, isFillAnchor, onFillDown, onFillDbl, fillDown,
    // 行增删 + 右键菜单
    canInsert, canDelete, insertRows, deleteRows, menu, openMenu, closeMenu, menuDo,
    // 冻结列（显示序由 visCols 统一给出，选区/复制/粘贴/填充全按它遍历）
    visCols, frozenCount, isFrozen, isPinned, pinned, pinTargets, pinAllOn, canPin,
    togglePin, setFreeze, unfreeze, fzOff, fzVars, fzStyle, fzW
  }
}
