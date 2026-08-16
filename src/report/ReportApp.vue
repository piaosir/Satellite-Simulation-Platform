<script setup>
// 链路预算报告的打印页（隐藏窗口，主进程 printToPDF 的取材对象）。
//
// 它只做一件事：把 src/shared/lbReport.js 组装、主进程补完 summary 的那一份模型摊成 HTML。
// 一个数都不在这里算——报告里的每个数字都来自屏幕上那次计算，本页只负责排版。
//
// 版式（见 styles/lbreport.css）：
//   封面 / 目录 / 总报告   A4 纵向
//   逐链路详情            A4 横向，且是**屏幕「详细预算」区的复刻**——同一个 WaterfallTable 组件、
//                        同一套 .lbx-doc 栅格（级联主表 ‖ 图表两栏 + 参考段整幅段带），
//                        故打印出来的和用户在屏幕上核对的是同一个东西。
// 标题一律用真 <h1>/<h2>：printToPDF 开了 generateDocumentOutline，PDF 的书签目录就是由它们生成的。
import { ref, computed, onMounted, nextTick } from 'vue'
import WaterfallTable from '../linkbudget/WaterfallTable.vue'

const model = ref(null)
const api = (typeof window !== 'undefined' && window.api) ? window.api.reportPrint : null

const L = computed(() => (model.value && model.value.t) || {})
const doc = computed(() => (model.value && model.value.doc) || {})
const calc = computed(() => (model.value && model.value.calc) || {})
const links = computed(() => (model.value && model.value.links) || [])
const summary = computed(() => (model.value && model.value.summary) || { metrics: [], stats: [] })
// 方法学章节（计算链路与口径 / 引用建议书 / 物理常数），由 shared/lbReport.js 的 methodology 生成
const method = computed(() => (model.value && model.value.method) || { basis: [], refGroups: [], constants: [] })
const lang = computed(() => (model.value && model.value.lang) || 'zh')
const en = computed(() => lang.value === 'en')
// 端到端体制的详细预算是单列级联，排版另有一套（.e2-doc，见 styles/lbworkbench.css）。
// 打印页与工作台屏幕共用那一套：同一个组件、同一份规则，PDF 里的表与屏幕上核对的是同一张。
const isE2e = computed(() => !!(model.value && model.value.scheme && model.value.scheme.orbitType === 'E2E'))

// 逐参数对照是链路做列的宽表：按 8 条链路一组切成续表，用「表 n-i（续）」的题注串起来。
const CMP_CHUNK = 8
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push({ from: i, items: arr.slice(i, i + n) })
  return out
}
const cmpChunks = computed(() => chunk(links.value, CMP_CHUNK))

// 表号全文连续（模板口径），与 Word 端同一套编法：逐参数对照 → 容量与统计 → 引用建议书 →
// 物理常数；详情章的表另按「链路序号-块序号」编，不占这个号。
// 模板渲染是纯函数式的（同一份模型可能被 Vue 重算多次），故编号不能用可变计数器——
// 在这里按固定次序一次算好，各处照名字取。
const tblNo = computed(() => {
  const n = {}
  let k = 0
  n.compare = ++k
  if (summary.value.stats && summary.value.stats.length) n.capacity = ++k
  n.refs = ++k
  n.consts = ++k
  return n
})
const capTable = (no, i, total, title) => {
  const t = en.value ? 'Table' : (L.value.table || '表')
  const seq = total > 1 ? `${no}-${i + 1}` : String(no)
  const cont = i > 0 ? (L.value.continued || (en.value ? '(continued)' : '（续）')) : ''
  return en.value ? `${t} ${seq}  ${title}${cont ? ' ' + cont : ''}` : `${t} ${seq}　${title}${cont}`
}
const capFigure = (linkNo, i, title) => {
  const t = en.value ? 'Figure' : (L.value.figure || '图')
  return en.value ? `${t} ${linkNo}-${i + 1}  ${title}` : `${t} ${linkNo}-${i + 1}　${title}`
}
const linkTitle = (l) => (l.txName || '') + ' → ' + (l.rxName || '')
const detailSub = computed(() => [calc.value.satelliteName, calc.value.frequencyBand, calc.value.mode].filter(Boolean).join('　·　'))

// 目录：章节清单（页码交给 PDF 书签与页脚页码，此处不标——混合方向下靠估算标页码，
// 一旦某段因「表不许拦腰断开」提前换页就会差一页，宁可不标也不能标错）
const toc = computed(() => {
  const l = L.value
  const items = [
    { n: '', t: l.master, sub: false },
    { n: '1', t: l.compare, sub: true }, { n: '2', t: l.capacity, sub: true },
    { n: '3', t: l.refs, sub: true },
    { n: '', t: l.detail, sub: false }
  ]
  for (const lk of links.value) items.push({ n: '#' + lk.no, t: linkTitle(lk), sub: true })
  return items
})

onMounted(async () => {
  try { model.value = api ? await api.model() : null } catch (e) { model.value = null }
  await nextTick()
  // 图是 data: URL，解码仍是异步的：不等它们解码完就打印，页面上会是一片空白的图框
  const imgs = Array.from(document.images || [])
  await Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : im.decode().catch(() => {}))))
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  window.__reportReady = true
  if (api) { try { api.ready() } catch (e) { /* 主进程会走轮询兜底 */ } }
})
</script>

<template>
  <!-- data-i18n-skip：本窗口是交付文档（printToPDF 抓 DOM），整篇语汇由生成报告时的 model 决定，
       不再经界面层二次改写——报表语言已跟随平台语言，两者本就一致，此处只是不让 DOM 翻译插手排版 -->
  <div v-if="model" class="rp" data-i18n-skip>
    <!-- ——— 封面（A4 纵向，结构照《技术文档标准模板》第一节）———
         （logo）→ 密级 / 文档编号 → 留白 → 报告名（唯一的一行主标题）→ 留白 → 编制单位 / 成文日期。
         ★ 不要副标题：体制名与报告名里的「链路预算」重复，用户 2026-08-02 点名要去掉。
         排版按 PDF 自己的逻辑（标题放大到 24pt），Word 那份才严格照模板的 16pt —— 用户定的口径。 -->
    <!-- logo 不在这里：它是页眉，每一页（含封面）右上角都有，由 printToPDF 的 headerTemplate 画
         （见 electron/services/reportPdf.js）。放正文里只会让封面出现两枚。 -->
    <section class="rp-sheet">
      <div class="rp-cover">
        <div class="rp-cv-meta">
          <div><b>{{ L.cvClass }}</b>：{{ doc.classification }}</div>
          <div><b>{{ L.cvDocNo }}</b>：{{ doc.docNo }}</div>
        </div>

        <div class="rp-cv-mid">
          <h1 class="rp-cv-title">{{ doc.title }}</h1>
        </div>

        <div class="rp-cv-bot">
          <div v-if="doc.org" class="rp-cv-org">{{ doc.org }}</div>
          <div class="rp-cv-date">{{ doc.date }}</div>
        </div>
      </div>
    </section>

    <!-- ——— 目录（A4 纵向）——— -->
    <section class="rp-sheet">
      <div class="rp-title">{{ L.contents }}</div>
      <div class="rp-toc">
        <div v-for="(it, i) in toc" :key="i" class="rp-toc-i" :class="{ sub: it.sub }">
          <span v-if="it.n" class="rp-toc-n">{{ it.n }}</span>
          <span class="rp-toc-t">{{ it.t }}</span>
          <span class="rp-toc-d"></span>
        </div>
      </div>
    </section>

    <!-- ——— 总报告 §1 逐参数对照（A4 横向）———
         这张表天生是宽表：链路做列，列数随链路数长。放在纵向 174mm 版心上会把列头压成三行，
         横向 269mm 才排得开；工程报告里宽表单开横向页是常规做法。 -->
    <section class="rp-sheet rp-land">
      <h1 class="rp-h1">{{ L.master }}</h1>
      <h2 class="rp-h2">1　{{ L.compare }}</h2>
      <template v-for="(ck, ci) in cmpChunks" :key="ci">
        <div class="rp-caption">{{ capTable(tblNo.compare, ci, cmpChunks.length, L.compare) }}</div>
        <table class="rp-tb">
          <thead>
            <tr>
              <th class="id">{{ L.param }}</th>
              <th v-for="(l, li) in ck.items" :key="li" class="num">#{{ l.no }}　{{ linkTitle(l) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(m, mi) in summary.metrics" :key="mi">
              <td class="id">{{ m.label }}</td>
              <td v-for="(l, li) in ck.items" :key="li" class="num">{{ m.values[ck.from + li] }}</td>
            </tr>
          </tbody>
        </table>
      </template>
    </section>

    <!-- ——— 容量与统计 / 计算模型与参考（A4 纵向）——— -->
    <section class="rp-sheet">
      <template v-if="summary.stats && summary.stats.length">
        <h2 class="rp-h2">2　{{ L.capacity }}</h2>
        <div v-if="summary.statsTitle" class="rp-note">{{ summary.statsTitle }}</div>
        <div class="rp-caption">{{ capTable(tblNo.capacity, 0, 1, L.capacity) }}</div>
        <table class="rp-tb">
          <thead><tr><th class="lbl">{{ L.param }}</th><th class="num">{{ L.value }}</th></tr></thead>
          <tbody>
            <tr v-for="(s, si) in summary.stats" :key="si"><td class="lbl">{{ s.label }}</td><td class="num">{{ s.value }}</td></tr>
          </tbody>
        </table>
      </template>

      <h2 class="rp-h2">3　{{ L.refs }}</h2>

      <h3 class="rp-h3">3.1　{{ L.mBasis }}</h3>
      <template v-for="(b, bi) in method.basis" :key="bi">
        <div class="rp-mb-t">{{ b.title }}</div>
        <p class="rp-p">{{ b.text }}</p>
      </template>

      <h3 class="rp-h3">3.2　{{ L.mRefs }}</h3>
      <div class="rp-caption">{{ capTable(tblNo.refs, 0, 1, L.mRefs) }}</div>
      <table class="rp-tb rp-refs">
        <thead><tr><th class="lbl">{{ L.mId }}</th><th class="lbl">{{ L.mTitle }}</th><th class="lbl">{{ L.mUse }}</th></tr></thead>
        <tbody>
          <template v-for="(g, gi) in method.refGroups" :key="gi">
            <tr class="rp-grp"><td class="lbl" colspan="3">{{ g.group }}</td></tr>
            <tr v-for="(r, ri) in g.items" :key="gi + '-' + ri">
              <td class="lbl id">{{ r.id }}</td><td class="lbl">{{ r.title }}</td><td class="lbl">{{ r.use }}</td>
            </tr>
          </template>
        </tbody>
      </table>

      <h3 class="rp-h3">3.3　{{ L.mConst }}</h3>
      <div class="rp-caption">{{ capTable(tblNo.consts, 0, 1, L.mConst) }}</div>
      <table class="rp-tb">
        <thead><tr>
          <th class="lbl">{{ L.param }}</th><th class="id">{{ L.mSymbol }}</th>
          <th class="num">{{ L.mValue }}</th><th class="unit">{{ L.unit }}</th><th class="lbl">{{ L.mSrc }}</th>
        </tr></thead>
        <tbody>
          <tr v-for="(c, ci) in method.constants" :key="ci">
            <td class="lbl" data-i18n-skip>{{ c.name }}</td><td class="id">{{ c.symbol }}</td>
            <td class="num">{{ c.value }}</td><td class="unit">{{ c.unit }}</td><td class="lbl">{{ c.src }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ——— 逐链路详情（A4 横向，屏幕排版复刻）——— -->
    <section v-for="l in links" :key="l.no" class="rp-detail rp-land">
      <div class="rp-detail-hd">
        <span class="rp-detail-no">#{{ l.no }}</span>
        <h1 class="rp-detail-name">{{ linkTitle(l) }}</h1>
        <span class="rp-detail-sub">{{ detailSub }}</span>
      </div>

      <div v-if="l.error" class="rp-fail">{{ L.calcFailed }}：{{ l.error }}　—　{{ L.noResult }}</div>

      <!-- 输入参数：与 Excel 详情表同一个次序与形态（先输入、后结果；每块竖排三列），
           块按栏流铺开，横向页上三栏一屏放得下 -->
      <template v-else-if="(l.inputs || []).length">
        <h3 class="rp-h3">{{ L.inputs }}</h3>
        <!-- 详情章的表号按「链路序号-块序号」编（与图号同一套），不占全文连续号 -->
        <div class="rp-inputs">
          <div v-for="(blk, bi) in l.inputs" :key="bi">
            <div class="rp-caption">{{ capTable(l.no + '-' + (bi + 1), 0, 1, blk.title) }}</div>
            <table class="rp-tb">
              <thead><tr><th class="lbl">{{ L.param }}</th><th class="num">{{ L.value }}</th><th class="unit">{{ L.unit }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, ri) in blk.rows" :key="ri">
                  <td class="lbl">{{ row.label }}</td><td class="num">{{ row.value }}</td><td class="unit">{{ row.unit }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <h3 class="rp-h3 rp-results">{{ L.results }}</h3>
      </template>

      <div v-if="!l.error" class="lbx-doc rp-doc" :class="{ 'e2-doc': isE2e }">
        <div class="lbx-doc-main"><WaterfallTable :segments="l.segments || []" pick="cascade" :lang="lang" /></div>
        <div v-if="(l.figures || []).length" class="lbx-doc-side">
          <figure v-for="(f, fi) in l.figures" :key="fi" class="rp-fig">
            <img :src="f.dataUrl" alt="" />
            <figcaption>{{ capFigure(l.no, fi, f.title) }}</figcaption>
          </figure>
        </div>
        <div class="lbx-doc-ref"><WaterfallTable :segments="l.segments || []" pick="rest" :lang="lang" /></div>
      </div>
    </section>

  </div>
</template>
