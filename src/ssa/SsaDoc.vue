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
// 电子报告视图：把 ssaReport.buildSsaModel() 的产物铺成一篇文档。
//
// 一切数只在模型里算一次，这里**一个数都不再算**（与 Word 端同一原则）：本组件只管排版
// —— 三型块（kv / table / figure）、章节标题编号、全篇连续的表号与图号、章锚点。
//
// ★ 根节点打 data-i18n-skip：文档区的中英译文是模型自带的（buildSsaModel 按 lang 翻好），
//   DOM 词典再翻一遍就会把已经是英文的标题、或人名 / 卫星名这类专名当中文原文二次加工
//   （见 shared/i18n/runtime.js 的 inSkip）。故本组件自己要出的那几个字（读数单位、空态）
//   一律走下面的 L(zh, en)，不指望呈现层。
// ★ 着色只有两处：emphasisRows 的行加 --accent-ui 左缘、warnCells 的格用 --warn 字色。
//   （emphasisRows 自 2026-09-17 删掉「重点所有者」后暂无产地，通路按契约留着。）
//   结果区不出现任何文字判定（达标 / 拥挤 / 正常…），模型里也不许有。
import { ref, computed } from 'vue'
import SsaChart from './SsaChart.vue'
import { tableCaption } from '../shared/lbReport.js'

const props = defineProps({
  // buildSsaModel 的产物；为空时整篇不出（空态一句陈述句由窗口壳出）
  model: { type: Object, default: null }
})

const GridTable = SsaGridTable
const lang = computed(() => ((props.model && props.model.lang) === 'en' ? 'en' : 'zh'))
const L = (zh, en) => (lang.value === 'en' ? en : zh)
const doc = computed(() => (props.model && props.model.doc) || null)
// 图题与表题同一套格式（中文全角空格、英文两个半角空格），与 Word 端 capTable 的口径一致
const figCaption = (no, title) => (lang.value === 'en' ? `Figure ${no}  ${title}` : `图 ${no}　${title}`)

// 行数到这个量级就换 ExcelGrid：静态三线表排一屏看不完的行，既没法排序也没法框选复制
const GRID_MIN_ROWS = 40
// ★ 成员表无论几行都走 ExcelGrid：它有 19 列（名称 · NORAD · 国际编号 · … · GEO 定点 · 来源），
//   正文栏宽撑不下必然横滚，而静态三线表没有冻结列 —— 滚到右半边最左的「名称」已经出去了，
//   认不出这一行是哪颗星。一般的卫星组正好在 40 颗以下，按行数分流恰好全落在没有冻结列那一档。
const isMemberTable = (b) => /\.members$/.test(String(b.tableId || ''))
// ★ 附录「口径与判据」反过来：它的第三列是整句判据，必须允许折行（.ssa-tbl 的格默认 nowrap），
//   也永远不许被推进 ExcelGrid —— 那条路逐格 nowrap 且不认 widths，57% 宽的判据列会退化成横滚长行。
const isCriteriaTable = (b) => /\.criteria$/.test(String(b.tableId || ''))

// 元信息读数（编号 / 密级 / 编制单位 / 日期）：填了的才出
const docMeta = computed(() => {
  const d = doc.value
  if (!d) return []
  return [d.docNo, d.classification, d.org, d.date].filter((s) => s != null && String(s) !== '')
})

// —— 版面模型 ——
// 表号 / 图号全篇连续，由本渲染端自己数（模型里不存序号，Word 端另有 nextTableNo 各数各的）。
// ★ 两端各数各的，规则就必须逐字同一条，否则屏上「表 12」到了 Word 里成「表 13」，两边各自看都对：
//   【占表号的只有非空的 table 块】—— kv 不占（它是定义列表 / Word 里的标签值两列，不是正文引用得到
//   的「表 N」，与 SLA 报告同口径），空表不占
//   （Word 端整块不印，屏上留一句「暂无数据。」但不占号）。改这条必须两端一起改，
//   packages/core/test/ssaDocx.test.mjs 的 screenNumbers() 复刻的就是这里。
const view = computed(() => {
  const m = props.model
  if (!m || !Array.isArray(m.sections)) return []
  let tno = 0, fno = 0
  return m.sections.map((s) => ({
    key: s.key,
    no: s.no || '',
    title: s.title || '',
    blocks: (s.blocks || []).map((b, bi) => {
      const id = s.key + '#' + bi
      if (b.type === 'table') {
        const rows = b.rows || []
        return {
          id, type: 'table', block: b, rows,
          cap: rows.length ? tableCaption(++tno, b.caption || '', lang.value) : (b.caption || ''),
          grid: !isCriteriaTable(b) && (!!b.capped || rows.length >= GRID_MIN_ROWS || isMemberTable(b)),
          wrap: isCriteriaTable(b),
          // 强调行 / 告警格按原行号成表存一次：逐格现算的话，一张表要重建上千个 Set
          emph: new Set(b.emphasisRows || []),
          warn: new Set((b.warnCells || []).map(([r, c]) => r + ':' + c))
        }
      }
      if (b.type === 'figure') {
        const f = (m.figures || {})[b.figId] || null
        return { id, type: 'figure', block: b, spec: f && f.spec ? f.spec : null, cap: figCaption(++fno, b.caption || '') }
      }
      return { id, type: 'kv', block: b, rows: b.rows || [] }
    })
  }))
})

// 相对宽度权重 → 百分比（不给就让浏览器按内容分）
const colWidth = (b, ci) => {
  const w = b.widths
  if (!Array.isArray(w) || !w.length) return null
  const sum = w.reduce((a, x) => a + (Number(x) || 0), 0)
  if (!(sum > 0) || !Number.isFinite(Number(w[ci]))) return null
  return ((Number(w[ci]) || 0) / sum * 100).toFixed(3) + '%'
}
const alignCls = (b, ci) => 'ssa-' + alignOf(b.align, ci).slice(0, 1)   // left/center/right → ssa-l/ssa-c/ssa-r

// —— 章锚点 ——
// 每章的 <section> 打 data-sec="<章 key>"，与链路预算分节（LbSection 的 <section data-sec>）同一枚
// 标记：目录导轨（点击滚动 / 滚动高亮）长在窗口壳 SsaApp 上 —— 滚动容器是它那层 .lbx-flow，
// 导轨也在它的三栏里，故本组件只负责把锚点打出来，不再自建一条轨、更不自建滚动面
// （在它的滚动面里再套一个滚动面，结果是两条滚动条互相吃事件）。
const rootEl = ref(null)
// 按章 key 取它的 <section>（给要自己滚的调用方用）。不用属性选择器：组章 key 是 g:<组 id>，
// 组 id 是外来串，拼进选择器还得转义。
const secEl = (key) => (rootEl.value
  ? (Array.from(rootEl.value.querySelectorAll('[data-sec]')).find((x) => x.dataset.sec === key) || null)
  : null)

defineExpose({ secEl })
</script>

<template>
  <div v-if="model" ref="rootEl" class="ssa-doc" data-i18n-skip>
    <article class="lbx-doc ssa-body">
      <header v-if="doc && doc.title" class="ssa-head">
        <h1 class="ssa-title">{{ doc.title }}</h1>
        <div v-if="docMeta.length" class="ssa-meta">{{ docMeta.join('　·　') }}</div>
      </header>

      <section v-for="s in view" :key="s.key" :data-sec="s.key" class="ssa-sec">
        <h2 class="ssa-h2"><span v-if="s.no" class="ssa-h2-no">{{ s.no }}</span>{{ s.title }}</h2>

        <template v-for="b in s.blocks" :key="b.id">
          <!-- ① 键值对 -->
          <div v-if="b.type === 'kv'" class="ssa-blk">
            <div v-if="b.block.caption" class="lbx-sla-cap">{{ b.block.caption }}</div>
            <dl class="ssa-kv">
              <template v-for="(kv, i) in b.rows" :key="i">
                <dt class="lbx-kv-l">{{ cellText(kv[0]) }}</dt>
                <dd class="lbx-kv-v">{{ cellText(kv[1]) }}</dd>
              </template>
            </dl>
          </div>

          <!-- ② 表（三线表；大表走 ExcelGrid） -->
          <div v-else-if="b.type === 'table'" class="ssa-blk">
            <div class="ssa-cap">
              <span class="ssa-cap-t">{{ b.cap }}</span>
              <span v-if="b.block.source" class="ssa-cap-src">{{ b.block.source }}</span>
              <span v-if="b.block.capped" class="ssa-cap-n">{{ b.block.capped.shown }} / {{ b.block.capped.total }}{{ L(' 条', ' rows') }}</span>
            </div>
            <GridTable
              v-if="b.grid" :table-id="b.block.tableId || b.id" :head="b.block.head || []" :rows="b.rows"
              :align="b.block.align || null" :emphasis-rows="b.block.emphasisRows || null"
              :warn-cells="b.block.warnCells || null" :empty-text="L('暂无数据。', 'No data.')" />
            <div v-else class="ssa-tblwrap">
              <table class="lbx-sla-tbl ssa-tbl" :class="{ 'ssa-wrap': b.wrap }">
                <colgroup v-if="b.block.widths">
                  <col v-for="(h, ci) in (b.block.head || [])" :key="ci" :style="{ width: colWidth(b.block, ci) }" />
                </colgroup>
                <thead>
                  <tr>
                    <th v-for="(h, ci) in (b.block.head || [])" :key="ci" :class="alignCls(b.block, ci)">{{ cellText(h) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!b.rows.length"><td class="ssa-empty" :colspan="(b.block.head || []).length || 1">{{ L('暂无数据。', 'No data.') }}</td></tr>
                  <tr v-for="(r, ri) in b.rows" :key="ri" class="lbx-sla-r" :class="{ 'ssa-emph': b.emph.has(ri) }">
                    <td
                      v-for="(v, ci) in r" :key="ci"
                      :class="[alignCls(b.block, ci), { 'ssa-warn': b.warn.has(ri + ':' + ci) }]">{{ cellText(v) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- ③ 图 -->
          <div v-else-if="b.type === 'figure'" class="ssa-blk">
            <SsaChart :spec="b.spec" :caption="b.cap" :lang="lang" />
          </div>
        </template>
      </section>
    </article>
  </div>
</template>

<style scoped>
/* 滚动面与内外边距归窗口壳（SsaApp 的 .ssa-flow）管，这里只管文档本身 */
.ssa-doc { min-width: 0; }
/* .lbx-doc 本身是「主栏 + 侧栏」的分栏容器（flex-wrap），报告是通栏文档：各章一律独占整行 */
.ssa-body { max-width: 72em; }
.ssa-body > .ssa-sec, .ssa-body > .ssa-head { flex: 1 1 100%; min-width: 0; }

.ssa-head { border-bottom: 2px solid var(--lb-rule-strong); padding-bottom: 6px; }
.ssa-title { margin: 0; font-size: calc(var(--lb-fs) + 7px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); }
.ssa-meta { margin-top: 3px; font-size: var(--lb-fs); color: var(--text-faint); font-variant-numeric: tabular-nums; }

.ssa-sec { display: flex; flex-direction: column; gap: 12px; }
.ssa-h2 {
  display: flex; align-items: baseline; gap: .6em; margin: 6px 0 0;
  font-size: calc(var(--lb-fs) + 3px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text);
  padding-bottom: 3px; border-bottom: 1px solid var(--lb-rule);
}
.ssa-h2-no { font-variant-numeric: tabular-nums; color: var(--text-muted); }
.ssa-blk { min-width: 0; }

/* 键值对：两列定义列表，标签 / 取值的字号与色阶沿用 .lbx-kv-* */
.ssa-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 1.2em; margin: 0; align-items: baseline; }
.ssa-kv dt { white-space: nowrap; }
.ssa-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }

/* 表题在表上方（与 Word 端 capTable 一致）；数据来源与截断读数跟在题注后 */
.ssa-cap { display: flex; align-items: baseline; gap: 10px; margin-bottom: .35em; flex-wrap: wrap; }
.ssa-cap-t { font-size: var(--lb-fs); font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.ssa-cap-src { font-size: calc(var(--lb-fs) - 1px); letter-spacing: var(--ls-label); color: var(--text-faint); }
.ssa-cap-n { margin-left: auto; font-size: calc(var(--lb-fs) - 1px); color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }

.ssa-tblwrap { overflow-x: auto; }
.ssa-tbl th, .ssa-tbl td { white-space: nowrap; }
/* 逐列对齐：表头与数据列同走一份（2026-09-07 定的口径，三线表表头随数据列对齐） */
.ssa-tbl th.ssa-l, .ssa-tbl td.ssa-l { text-align: left; }
.ssa-tbl th.ssa-c, .ssa-tbl td.ssa-c { text-align: center; }
.ssa-tbl th.ssa-r, .ssa-tbl td.ssa-r { text-align: right; }
/* 附录「口径与判据」：判据格是整句话，不折行就只能横滚着读（其余表都是短串，靠上面那条 nowrap 保持整齐） */
.ssa-wrap th, .ssa-wrap td { white-space: normal; line-height: 1.55; }
.ssa-empty { color: var(--text-faint); padding: 4px 6px; }

/* 着色两处（全篇只此两处）：强调行左缘 / 告警格字色 */
.ssa-tbl tr.ssa-emph > td:first-child { box-shadow: inset 2px 0 0 var(--accent-ui); }
.ssa-tbl td.ssa-warn { color: var(--warn); }
/* ExcelGrid 的 DOM 在子组件里，scoped 选择器盖不到，故这两条走 :deep */
.ssa-grid { max-height: 62vh; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
:deep(tr.ssa-emph > td:first-child) { box-shadow: inset 2px 0 0 var(--accent-ui); }
:deep(td.ssa-warn), :deep(td.ssa-warn .eg-v) { color: var(--warn); }
</style>
