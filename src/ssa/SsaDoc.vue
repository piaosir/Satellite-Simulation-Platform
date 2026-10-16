<script>
// 大表（成员表这类）交给 ExcelGrid 铺：排序、框选复制、列宽、冻结列一次都齐。
//
// ★ 为什么要在同一个文件里再声明一个子组件：ExcelGrid 的交互内核 useGridSelect 必须在**组件的
//   setup 里**调（内含 onMounted / onBeforeUnmount，且每张表各自一套选区与排序状态），而一篇报告
//   里可能有好几张这样的表、张数还随模型变。在 SsaDoc 的 setup 里循环调是不成立的，故把「一张大表」
//   做成组件，v-for 里每张表一个实例。
import { defineComponent, computed, h } from 'vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'

// 模型里的对齐口径（逐列 'l' | 'c' | 'r'，缺省首列左、其余右）→ ExcelGrid 的列级对齐
const ALIGN_CSS = { l: 'left', c: 'center', r: 'right' }
export const alignOf = (align, ci) => ALIGN_CSS[(align && align[ci]) || (ci === 0 ? 'l' : 'r')] || 'right'
// 单元格文本：模型里的 null 与空串都是「没有这个量」，一律印破折号 —— 全平台既有口径
// （ssaStats 的 regimeOf 无根数即回 '—'、文件管理的时间列同），不是「无 / 不适用」那种文字判定。
// ★ 必须与 Word 端 reportSsaDocx.js 的 S() 同口径：那边留空会让三线表里凭空缺一格，
//   读者分不清是没这个量还是排版掉了。
export const cellText = (v) => (v == null || v === '' ? '—' : String(v))

// 这一列是不是数值列。★ 不看模型给的对齐：ExcelGrid 的 num 列排序走数值比较，而右对齐的列里
// 有的是日期、国际编号、历元这类文本，标成 num 后 Number() 全成 NaN、整列被判为空值沉底，
// 点一下列头就把表排乱了。故逐列扫一遍真值，全是数才算数值列。
function isNumCol(rows, ci) {
  let seen = false
  for (const r of rows) {
    const v = r && r[ci]
    if (v == null || v === '') continue
    if (typeof v === 'number') { seen = true; continue }
    if (!/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(String(v).trim())) return false
    seen = true
  }
  return seen
}

export const SsaGridTable = defineComponent({
  name: 'SsaGridTable',
  props: {
    tableId: { type: String, default: '' },
    head: { type: Array, default: () => [] },
    rows: { type: Array, default: () => [] },
    align: { type: Array, default: null },
    emphasisRows: { type: Array, default: null },
    warnCells: { type: Array, default: null },
    emptyText: { type: String, default: '' }
  },
  setup(props) {
    // 列 key 只是位置代号（c0 c1 …）：模型给的是纯二维数组，没有字段名
    const cols = computed(() => props.head.map((label, ci) => ({
      key: 'c' + ci,
      label: cellText(label),
      num: isNumCol(props.rows, ci),
      align: alignOf(props.align, ci)
    })))
    // 行对象带 _ri＝模型里的原行号：排序后行的位置会变，而 emphasisRows / warnCells 说的是原行号
    const rows = computed(() => props.rows.map((r, ri) => {
      const o = { id: ri, _ri: ri }
      for (let ci = 0; ci < props.head.length; ci++) o['c' + ci] = cellText(r && r[ci])
      return o
    }))
    const text = (r, c) => (r[c.key] == null ? '' : String(r[c.key]))
    // ★ 排序取【模型里的原值】而不是屏上那串：显示层把 null 印成「—」，拿它去排会让没有该量的行
    //   混进有值的行里（useGridSelect 的比较器只让 null/''/NaN 沉底，「—」是个正经字符串）。
    const sortValue = (r, c) => {
      const v = props.rows[r._ri] && props.rows[r._ri][Number(c.key.slice(1))]
      if (v == null || v === '') return null
      return c.num ? Number(v) : v
    }
    const grid = useGridSelect({
      gridId: 'ssa/' + (props.tableId || 'tbl'),
      rows: () => rows.value,
      cols: () => cols.value,
      readOnly: true,            // 报告是算出来的，只许看与复制；readOnly 同时把列头排序打开
      cellText: text,
      sortValue
    })
    const emph = computed(() => new Set(props.emphasisRows || []))
    const warn = computed(() => new Set((props.warnCells || []).map(([r, c]) => r + ':' + c)))
    return () => h(ExcelGrid, {
      class: 'ssa-grid',
      grid,
      cols: cols.value,
      text,
      serial: true,
      emptyText: props.emptyText,
      rowClass: (r) => (emph.value.has(r._ri) ? 'ssa-emph' : null),
      cellClass: (r, c) => (warn.value.has(r._ri + ':' + c.key.slice(1)) ? 'ssa-warn' : null)
    })
  }
})
</script>

<script setup>
// 电子报告视图：把 ssaReport.buildSsaModel() 的产物铺成一篇「纸面」文档（样式规范 2026-10-15 §I）。
//
// 一切数只在模型里算一次，这里**一个数都不再算**（与 Word 端同一原则）：本组件只管排版 ——
// 封面纸、每章一张纸、章内编号的表号与图号、三线表、关键指标页、章锚点。
//
// ★ 屏上即纸面（§A.3 / §I.2）：纸恒为浅色（#FFFFFF 底、#222222 墨），只有纸外的桌面随主题变暗 ——
//   报告是交付物，屏上看到的必须是打出来的样子；图在屏上与 Word 是同一张（chartSvg 'paper' 档、同一物理尺寸）。
//   纸根节点把界面主题 token（--bg / --text / --border …）就地改成浅色档，纸内嵌套的件（ExcelGrid、
//   抬头输入框）因此一律按浅色取色，不必各自认「纸」。
// ★ 纸面尺寸按 A4 @ 96 dpi（宽 794 px、左右版心边距 94 px），整页乘缩放 s：s = 数据区字号 / 11，
//   且不超过「中栏宽能放下一张纸」—— 窗口窄时整张纸等比缩小，不出横滚。不用 CSS zoom（Chromium 126
//   在 zoom 下 getBoundingClientRect 与指针坐标不一致，表格框选会错位，§C.2）。
// ★ 根节点打 data-i18n-skip：文档区的中英译文是模型自带的（buildSsaModel 按 lang 翻好），
//   DOM 词典再翻一遍会把专名当中文原文二次加工。本组件自己要出的几个字走 L(zh, en)。
// ★ 结果区不出现任何文字判定；变化量只给带符号的数，不染色、不加箭头（仓库 CLAUDE.md）。
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import SsaChart from './SsaChart.vue'
import { formatColumns, sourceLine, chapterNo } from '../shared/ssaFormat.js'

const props = defineProps({
  // buildSsaModel 的产物；为空时整篇不出（空态一句陈述句由窗口壳出）
  model: { type: Object, default: null },
  // 抬头五项（标题 / 编号 / 密级 / 编制单位 / 日期）的【当前值】，给了就在封面纸上就地可改。
  // ★ 抬头不走 model：它不参与任何计算，改一个字不该让整篇重排。值由窗口壳握着（随配置存）。
  head: { type: Object, default: null }
})
// ★ 封面纸上不放台标（2026-10-16 用户：「中国卫通 logo 出现得莫名其妙」）：台标是与链路预算几个窗口共用的
//   全局设置（lb/report/logo），本窗口里没有任何地方让人知道它从哪来；它只进 Word 页眉，由导出对话框的 LOGO 一栏管。
const emit = defineEmits(['edit-head'])

const GridTable = SsaGridTable
const lang = computed(() => ((props.model && props.model.lang) === 'en' ? 'en' : 'zh'))
const L = (zh, en) => (lang.value === 'en' ? en : zh)
const doc = computed(() => (props.model && props.model.doc) || null)

// —— 纸面缩放 s ——
const PAPER_W = 794          // A4 宽 210 mm @ 96 dpi
const rootEl = ref(null)
const scale = ref(1)
function measure() {
  const el = rootEl.value
  if (!el) return
  let fsPx = 11
  try { fsPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lb-fs')) || 11 } catch (e) { /* 默认 */ }
  const avail = Math.max(320, (el.clientWidth || PAPER_W) - 32)
  const s = Math.min(fsPx / 11, avail / PAPER_W)
  scale.value = Math.round(Math.max(0.5, Math.min(2, s)) * 1000) / 1000
}
let _ro = null, _mo = null
onMounted(() => {
  measure()
  if (window.ResizeObserver && rootEl.value) { _ro = new ResizeObserver(measure); _ro.observe(rootEl.value) }
  // 数据区字号（功能区 A− / A+）写在 <html> 的行内 --lb-fs 上：盯 style 属性
  if (window.MutationObserver) { _mo = new MutationObserver(measure); _mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] }) }
})
onBeforeUnmount(() => { if (_ro) _ro.disconnect(); if (_mo) _mo.disconnect() })

// 行数到这个量级就换 ExcelGrid（排序 / 框选复制）。★ 待拍板：样式规范 §I.4 推荐纸上一律三线表 +「表格视图」抽屉，
// 抽屉要新增图标，按规矩先问；定之前大表仍内嵌 ExcelGrid（纸内已是浅色档）。
const GRID_MIN_ROWS = 40
const isMemberTable = (b) => /\.members$/.test(String(b.tableId || ''))
// 附录「口径与判据」：判据整句折行，永不进 ExcelGrid（那条路逐格 nowrap 且不认 widths）
const isCriteriaTable = (b) => /\.criteria$/.test(String(b.tableId || ''))

// 元信息读数（只读档：没给 head 时）
const docMeta = computed(() => {
  const d = doc.value
  if (!d) return []
  return [d.docNo, d.classification, d.org, d.date].filter((s) => s != null && String(s) !== '')
})

// —— 抬头就地编辑（封面纸上）——
// 每一项就是一个长得像正文的输入框（field-sizing: content 按字宽收放），点上去就改：
// Enter / 失焦提交，Esc 撤回。空着的项显示字段名占位。
const headVal = (k) => String((props.head && props.head[k]) || '')
function onHeadKey(e) {
  if (e.isComposing) return
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur() }
  else if (e.key === 'Escape') { e.target.value = headVal(e.target.dataset.k); e.target.blur() }
}
function onHeadChange(e) {
  const el = e.target
  const k = el.dataset.k
  // 标题是 textarea（长名要折行），粘进来的换行折成空格
  emit('edit-head', { key: k, value: String(el.value || '').replace(/\s*[\r\n]+\s*/g, ' ').trim() })
  // ★ 回写一次 DOM：清空标题 / 日期会回落成自动值，而自动值若与改前相同，:value 绑定没有变化、
  //   Vue 不会去碰 DOM，框里就一直空着。等窗口壳把新值推下来之后按 prop 重填。
  nextTick(() => { el.value = headVal(k) })
}

// —— 版面模型 ——
// 表号 / 图号【按章编】（样式规范 §D）：正文「表 3-2 / 图 3-1」、附录「表 A1」、英文「Table 3.2」。
// 筛选感知会整块跳过表图，全篇连续编号时一处少表、后面全篇连锁变号；按章编把波及限在本章。
// ★ 两端各数各的，规则必须逐字同一条：【占表号的只有非空的 table 块】—— kv / kpi 不占，空表不占
//   （Word 端整块不印，屏上留一句「暂无数据。」但不占号）。packages/core/test/ssaDocx.test.mjs 的
//   screenNumbers() 复刻的就是这里，还有一条源码 tripwire 盯着本文件只许一处在数表号。
const tableCap = (no, title) => (lang.value === 'en' ? `Table ${no}  ${title}` : `表 ${no}　${title}`)
const figCap = (no, title) => (lang.value === 'en' ? `Figure ${no}  ${title}` : `图 ${no}　${title}`)
const headText = (s) => {
  if (s.appendix) return (lang.value === 'en' ? `Appendix ${s.no}  ` : `附录 ${s.no}　`) + s.title
  return s.no ? s.no + (lang.value === 'en' ? '  ' : '　') + s.title : s.title
}
const view = computed(() => {
  const m = props.model
  if (!m || !Array.isArray(m.sections)) return []
  return m.sections.map((s) => {
    let tno = 0, fno = 0
    return {
      key: s.key,
      head: headText(s),
      front: s.key === 'summary',
      blocks: (s.blocks || []).map((b, bi) => {
        const id = s.key + '#' + bi
        if (b.type === 'table') {
          const rows = b.rows || []
          const head = b.head || []
          const cap = rows.length ? tableCap(chapterNo(s, ++tno, lang.value), b.caption || '') : (b.caption || '')
          const total = b.capped ? b.capped.total : 0
          return {
            id, type: 'table', block: b, rows, head,
            cap: cap + (total ? L(`（共 ${total} 条）`, ` (${total} rows total)`) : ''),
            grid: !isCriteriaTable(b) && (!!b.capped || rows.length >= GRID_MIN_ROWS || isMemberTable(b)),
            wrap: isCriteriaTable(b),
            dense: head.length >= 9,
            cells: formatColumns(rows, head.length, b.blankCols),
            hg: headRows(b),
            roles: b.rowRoles || {},
            src: sourceLine(b.source, lang.value),
            warn: new Set((b.warnCells || []).map(([r, c]) => r + ':' + c))
          }
        }
        if (b.type === 'figure') {
          const f = (m.figures || {})[b.figId] || null
          return { id, type: 'figure', block: b, spec: f && f.spec ? f.spec : null, mm: (f && f.mm) || [160, 80], cap: figCap(chapterNo(s, ++fno, lang.value), b.caption || '') }
        }
        if (b.type === 'kpi') return { id, type: 'kpi', block: b, groups: (b.groups || []).filter((g) => g && (g.items || []).length) }
        if (b.type === 'refs') return { id, type: 'refs', items: b.items || [] }
        return { id, type: 'kv', block: b, rows: b.rows || [] }
      })
    }
  })
})

// 分组表头 → 两行表头的格（§E.2）：组名跨组内各列（下有短线）；未入组的列跨两行、表头底对齐
function headRows(b) {
  const head = b.head || []
  const groups = Array.isArray(b.headGroups) ? b.headGroups : []
  if (!groups.length) return null
  const top = [], bottom = []
  let ci = 0
  while (ci < head.length) {
    const g = groups.find((x) => x.from === ci)
    if (g) {
      top.push({ label: g.label, span: g.to - g.from + 1, group: true, ci })
      for (let k = g.from; k <= g.to; k++) bottom.push({ label: head[k], ci: k })
      ci = g.to + 1
    } else {
      top.push({ label: head[ci], span: 1, rowspan: 2, ci })
      ci++
    }
  }
  return { top, bottom }
}

const alignOfCol = (b, ci) => alignOf(b.align, ci).slice(0, 1)   // left/center/right → l/c/r
const colWidth = (b, ci) => {
  const w = b.widths
  if (!Array.isArray(w) || !w.length) return null
  const sum = w.reduce((a, x) => a + (Number(x) || 0), 0)
  if (!(sum > 0) || !Number.isFinite(Number(w[ci]))) return null
  return ((Number(w[ci]) || 0) / sum * 100).toFixed(3) + '%'
}

// —— 章锚点 ——
// 每张纸打 data-sec="<章 key>"：目录导轨（点击滚动 / 滚动高亮）长在窗口壳 SsaApp 上，本组件只打锚点。
const secEl = (key) => (rootEl.value
  ? (Array.from(rootEl.value.querySelectorAll('[data-sec]')).find((x) => x.dataset.sec === key) || null)
  : null)

defineExpose({ secEl })
</script>

<template>
  <div ref="rootEl" class="ssa-doc" data-i18n-skip :style="{ '--paper-s': scale }">
    <template v-if="model">
      <!-- 封面纸（§B.3 / §I.1）：密级与编号左上、台标右上、报告名居中、单位与日期居下；抬头五项就地编辑 -->
      <article class="ssa-sheet ssa-cover">
        <template v-if="head">
          <div class="ssa-cv-top">
            <div class="ssa-cv-meta">
              <label class="ssa-cv-kv"><span class="ssa-cv-k">{{ L('密　　级', 'Classification') }}</span>
                <input class="ssa-ed" type="text" data-k="classification" spellcheck="false" :value="head.classification || ''" :placeholder="L('密级', 'Classification')" @keydown="onHeadKey" @change="onHeadChange" /></label>
              <label class="ssa-cv-kv"><span class="ssa-cv-k">{{ L('文档编号', 'Doc. No.') }}</span>
                <input class="ssa-ed" type="text" data-k="docNo" spellcheck="false" :value="head.docNo || ''" :placeholder="L('编号', 'Document No.')" @keydown="onHeadKey" @change="onHeadChange" /></label>
            </div>
          </div>
          <h1 class="ssa-cv-title">
            <textarea class="ssa-ed ssa-title-in" data-k="title" rows="1" spellcheck="false"
              :value="head.title || ''" :placeholder="L('报告名称', 'Report title')" :title="L('报告名称', 'Report title')"
              @keydown="onHeadKey" @change="onHeadChange"></textarea>
          </h1>
          <div class="ssa-cv-foot">
            <input class="ssa-ed ssa-cv-org" type="text" data-k="org" spellcheck="false" :value="head.org || ''" :placeholder="L('编制单位', 'Organisation')" :title="L('编制单位', 'Organisation')" @keydown="onHeadKey" @change="onHeadChange" />
            <input class="ssa-ed ssa-cv-date" type="text" data-k="date" spellcheck="false" :value="head.date || ''" :placeholder="L('日期', 'Date')" :title="L('日期', 'Date')" @keydown="onHeadKey" @change="onHeadChange" />
            <div v-if="model.data && model.data.asOfText" class="ssa-cv-asof">{{ L('数据截至', 'Data as of') }}　{{ model.data.asOfText }}</div>
          </div>
        </template>
        <template v-else-if="doc">
          <h1 class="ssa-cv-title"><span>{{ doc.title }}</span></h1>
          <div v-if="docMeta.length" class="ssa-cv-foot">{{ docMeta.join('　·　') }}</div>
        </template>
      </article>

      <!-- 每章一张纸（§B.6 章另起页的屏上等价物） -->
      <article v-for="s in view" :key="s.key" :data-sec="s.key" class="ssa-sheet" :class="{ 'is-front': s.front }">
        <h2 class="ssa-h1" :class="{ front: s.front }">{{ s.head }}</h2>

        <template v-for="b in s.blocks" :key="b.id">
          <!-- ① 关键指标（§G）：每组一行四格，每格「标签 / 数值 / 对照行」；无框无底纹，组间细线 -->
          <div v-if="b.type === 'kpi'" class="ssa-blk ssa-kpi">
            <div v-if="b.block.caption" class="ssa-kpi-cap">{{ b.block.caption }}</div>
            <section v-for="(g, gi) in b.groups" :key="gi" class="ssa-kpi-g">
              <div class="ssa-kpi-gt"><span>{{ g.title }}</span><span class="ssa-kpi-ref">{{ L('对照', 'vs') }}　{{ g.refLabel }}</span></div>
              <div class="ssa-kpi-row">
                <div v-for="(it, ii) in g.items" :key="ii" class="ssa-kpi-i">
                  <div class="ssa-kpi-l">{{ it.label }}</div>
                  <div class="ssa-kpi-v">{{ it.value }}</div>
                  <div v-if="it.note" class="ssa-kpi-d">{{ it.note }}</div>
                  <div v-else-if="it.ref != null" class="ssa-kpi-d">
                    <span>{{ it.ref }}</span>
                    <span v-if="it.delta" class="ssa-kpi-dd">{{ it.delta }}</span>
                    <span v-if="it.pct" class="ssa-kpi-dd">{{ it.pct }}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- ② 键值读数：两列，无线（§J.3 kvBlock） -->
          <div v-else-if="b.type === 'kv'" class="ssa-blk">
            <div v-if="b.block.caption" class="ssa-kv-cap">{{ b.block.caption }}</div>
            <dl class="ssa-kv">
              <template v-for="(kv, i) in b.rows" :key="i">
                <dt>{{ cellText(kv[0]) }}</dt>
                <dd>{{ cellText(kv[1]) }}</dd>
              </template>
            </dl>
          </div>

          <!-- ③ 表：表题在上居中、三线表、来源行在下（§E）；大表暂走 ExcelGrid -->
          <div v-else-if="b.type === 'table'" class="ssa-blk ssa-tblblk">
            <div class="ssa-cap">{{ b.cap }}</div>
            <GridTable
              v-if="b.grid" :table-id="b.block.tableId || b.id" :head="b.head" :rows="b.rows"
              :align="b.block.align || null" :emphasis-rows="b.block.emphasisRows || null"
              :warn-cells="b.block.warnCells || null" :empty-text="L('暂无数据。', 'No data.')" />
            <div v-else class="ssa-tblwrap">
              <table class="ssa-tbl" :class="{ 'ssa-wrap': b.wrap, dense: b.dense }">
                <colgroup v-if="b.block.widths">
                  <col v-for="(h, ci) in b.head" :key="ci" :style="{ width: colWidth(b.block, ci) }" />
                </colgroup>
                <thead v-if="b.hg">
                  <tr>
                    <th v-for="c in b.hg.top" :key="'t' + c.ci" :colspan="c.span" :rowspan="c.rowspan || 1"
                        :class="[c.group ? 'grp' : 'a-' + alignOfCol(b.block, c.ci)]"><span v-if="c.group" class="grp-l">{{ c.label }}</span><template v-else>{{ c.label }}</template></th>
                  </tr>
                  <tr>
                    <th v-for="c in b.hg.bottom" :key="'b' + c.ci" :class="'a-' + alignOfCol(b.block, c.ci)">{{ c.label }}</th>
                  </tr>
                </thead>
                <thead v-else>
                  <tr><th v-for="(h, ci) in b.head" :key="ci" :class="'a-' + alignOfCol(b.block, ci)">{{ h }}</th></tr>
                </thead>
                <tbody>
                  <tr v-if="!b.rows.length"><td class="ssa-empty" :colspan="b.head.length || 1">{{ L('暂无数据。', 'No data.') }}</td></tr>
                  <tr v-for="(r, ri) in b.cells" :key="ri" :class="b.roles[ri] ? 'r-' + b.roles[ri] : ''">
                    <td v-for="(v, ci) in r" :key="ci" :class="['a-' + alignOfCol(b.block, ci), { warn: b.warn.has(ri + ':' + ci) }]">{{ v }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="b.src" class="ssa-src">{{ b.src }}</div>
          </div>

          <!-- ④ 图：同一张纸面图（与 Word 同 spec、同物理尺寸），图题在下居中 -->
          <div v-else-if="b.type === 'figure'" class="ssa-blk">
            <SsaChart :spec="b.spec" :caption="b.cap" :lang="lang" :mm="b.mm" :scale="scale" />
          </div>

          <!-- ⑤ 参考文献（附录 C，GB/T 7714 顺序编码制） -->
          <ol v-else-if="b.type === 'refs'" class="ssa-blk ssa-refs">
            <li v-for="(t, i) in b.items" :key="i"><span class="ssa-ref-n">[{{ i + 1 }}]</span>{{ t }}</li>
          </ol>
        </template>
      </article>
    </template>
  </div>
</template>

<style scoped>
/* —— 桌面与纸（§I.1）。尺寸一律 calc(N px × --paper-s)，N 为 A4 @ 96 dpi 下的值 —— */
.ssa-doc { --s: var(--paper-s, 1); min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 8px 0 24px; }
.ssa-sheet {
  /* 纸面 token 恒浅（§I.2）；同时把界面主题 token 就地改成浅色档：纸内嵌套的件（ExcelGrid、输入框）按此取色 */
  color-scheme: light;
  --paper-ink: #222222; --paper-ink-2: #595959; --paper-rule: #222222; --paper-bg: #FFFFFF;
  --bg: #FFFFFF; --text: #222222; --text-muted: #595959; --text-faint: #8C8C8C;
  --border: #D9D9D9; --border-strong: #BFBFBF; --surface: #FFFFFF; --surface-2: #F2F2F2;
  --field-bg: #FFFFFF; --field-border: #BFBFBF; --wash-hover: rgba(0, 0, 0, .04); --lb-rule: #D9D9D9; --lb-rule-strong: #222222;
  box-sizing: border-box; flex: none;
  width: calc(794px * var(--s)); padding: calc(85px * var(--s)) calc(94px * var(--s)) calc(76px * var(--s));
  background: var(--paper-bg); color: var(--paper-ink);
  border: 1px solid rgba(0, 0, 0, .10); box-shadow: 0 1px 2px rgba(0, 0, 0, .06);
  font-family: var(--font-ui); font-size: calc(14px * var(--s)); line-height: 1.6;
  display: flex; flex-direction: column; gap: calc(14px * var(--s));
}
.ssa-blk { min-width: 0; }

/* —— 封面纸 —— */
.ssa-cover { min-height: calc(420px * var(--s)); justify-content: space-between; }
.ssa-cv-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.ssa-cv-meta { display: flex; flex-direction: column; gap: calc(2px * var(--s)); font-size: calc(16px * var(--s)); }
.ssa-cv-kv { display: flex; align-items: baseline; gap: .3em; cursor: text; }
.ssa-cv-k::after { content: '：'; }
.ssa-cv-title { margin: 0; text-align: center; font-size: calc(27px * var(--s)); font-weight: 700; line-height: 1.3; color: var(--paper-ink); }
.ssa-cv-foot { display: flex; flex-direction: column; align-items: center; gap: calc(4px * var(--s)); font-size: calc(21px * var(--s)); }
.ssa-cv-asof { font-size: calc(16px * var(--s)); color: var(--paper-ink-2); font-variant-numeric: tabular-nums; }

/* 抬头输入框：平时与纸上文字同形（无框无底、字宽收放），悬停出淡底、聚焦出输入底 + 全局焦点环 */
.ssa-ed {
  font: inherit; color: inherit; letter-spacing: inherit; font-variant-numeric: inherit; text-align: inherit;
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
  padding: 0 3px; margin: 0 -3px; min-width: 2ch; max-width: calc(100% + 6px);
  field-sizing: content; cursor: text; transition: var(--t-state);
}
.ssa-ed:hover { background: var(--wash-hover); }
.ssa-ed:focus { background: var(--field-bg); border-color: var(--field-border); }
.ssa-ed::placeholder { color: var(--text-faint); opacity: 1; }
.ssa-title-in { display: block; width: calc(100% + 6px); line-height: 1.3; resize: none; overflow: hidden; text-align: center; }

/* —— 章标题（§C.2：19 px 700，无下划线；前置页标题 21 px 居中） —— */
.ssa-h1 { margin: 0 0 calc(4px * var(--s)); font-size: calc(19px * var(--s)); font-weight: 700; line-height: 1.35; color: var(--paper-ink); }
.ssa-h1.front { text-align: center; font-size: calc(21px * var(--s)); }

/* —— 关键指标（§G.4）：4 列栅格，组间 1 px、首尾 2 px 线 —— */
.ssa-kpi-cap { text-align: center; font-size: calc(12px * var(--s)); color: var(--paper-ink-2); font-variant-numeric: tabular-nums; margin-bottom: calc(8px * var(--s)); }
.ssa-kpi-g { border-top: 1px solid var(--paper-rule); padding: calc(6px * var(--s)) 0 calc(10px * var(--s)); }
.ssa-kpi-g:first-of-type { border-top-width: 2px; }
.ssa-kpi-g:last-of-type { border-bottom: 2px solid var(--paper-rule); }
.ssa-kpi-gt { display: flex; justify-content: space-between; gap: 1em; font-size: calc(12px * var(--s)); font-weight: 600; color: var(--paper-ink-2); margin-bottom: calc(4px * var(--s)); }
.ssa-kpi-ref { font-weight: 400; }
.ssa-kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); column-gap: calc(12px * var(--s)); }
.ssa-kpi-i { min-width: 0; display: flex; flex-direction: column; gap: calc(1px * var(--s)); }
.ssa-kpi-l { font-size: calc(12px * var(--s)); font-weight: 600; color: var(--paper-ink); }
.ssa-kpi-v { font-family: Arial, var(--font-ui); font-size: calc(27px * var(--s)); font-weight: 700; line-height: 1.15; color: var(--paper-ink); font-variant-numeric: tabular-nums; }
.ssa-kpi-d { display: flex; flex-wrap: wrap; gap: 0 .6em; font-size: calc(12px * var(--s)); color: var(--paper-ink-2); font-variant-numeric: tabular-nums; }

/* —— 键值读数（§J.3）：两列无线，标签 600 次级墨、值正文墨 —— */
.ssa-kv-cap { font-size: calc(14px * var(--s)); font-weight: 600; margin-bottom: calc(4px * var(--s)); }
.ssa-kv { display: grid; grid-template-columns: max-content 1fr; gap: calc(2px * var(--s)) 1.4em; margin: 0; font-size: calc(12px * var(--s)); align-items: baseline; }
.ssa-kv dt { font-weight: 600; color: var(--paper-ink-2); white-space: nowrap; }
.ssa-kv dd { margin: 0; min-width: 0; color: var(--paper-ink); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

/* —— 表（§E）：表题居中在上、三线（顶底 2 px / 栏目 1 px / 合计上 1 px）、来源行在下 —— */
.ssa-cap { text-align: center; font-size: calc(14px * var(--s)); font-weight: 600; color: var(--paper-ink); margin-bottom: calc(5px * var(--s)); font-variant-numeric: tabular-nums; }
.ssa-tblwrap { overflow-x: auto; }
.ssa-tbl { width: 100%; border-collapse: collapse; font-size: calc(12px * var(--s)); line-height: 1.35; font-variant-numeric: tabular-nums; border-top: 2px solid var(--paper-rule); border-bottom: 2px solid var(--paper-rule); }
.ssa-tbl.dense { font-size: calc(11px * var(--s)); }
.ssa-tbl th, .ssa-tbl td { padding: calc(3px * var(--s)) calc(7px * var(--s)); white-space: nowrap; }
.ssa-tbl th { font-weight: 600; color: var(--paper-ink); vertical-align: bottom; }
.ssa-tbl thead tr:last-child th, .ssa-tbl thead th[rowspan="2"] { border-bottom: 1px solid var(--paper-rule); }
.ssa-tbl th.grp { text-align: center; padding-bottom: calc(2px * var(--s)); }
.ssa-tbl .grp-l { display: block; padding-bottom: calc(2px * var(--s)); margin: 0 calc(4px * var(--s)); border-bottom: 1px solid var(--paper-rule); }
.ssa-tbl .a-l { text-align: left; } .ssa-tbl .a-c { text-align: center; } .ssa-tbl .a-r { text-align: right; }
.ssa-tbl tr.r-total td { border-top: 1px solid var(--paper-rule); font-weight: 600; }
.ssa-tbl tr.r-group td { padding-top: calc(7px * var(--s)); }
.ssa-tbl tbody tr:hover td { background: #F2F2F2; }
.ssa-tbl td.warn { color: #B8333D; }
.ssa-wrap th, .ssa-wrap td { white-space: normal; line-height: 1.5; vertical-align: top; }
.ssa-empty { color: var(--paper-ink-2); }
.ssa-src { margin-top: calc(4px * var(--s)); font-size: calc(12px * var(--s)); color: var(--paper-ink-2); }
.ssa-grid { max-height: 62vh; border: 1px solid var(--border); }
:deep(td.ssa-warn), :deep(td.ssa-warn .eg-v) { color: #B8333D; }

/* —— 参考文献（§H.3）：悬挂缩进 —— */
.ssa-refs { margin: 0; padding: 0; list-style: none; font-size: calc(14px * var(--s)); line-height: 1.5; }
.ssa-refs li { padding-left: 2.4em; text-indent: -2.4em; margin-bottom: calc(4px * var(--s)); overflow-wrap: anywhere; }
.ssa-ref-n { display: inline-block; width: 2.4em; text-indent: 0; font-variant-numeric: tabular-nums; }
</style>
