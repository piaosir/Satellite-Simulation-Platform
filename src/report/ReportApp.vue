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

// 分节视图（与主进程 report.js 的 sectionsOf 同一套切法）：再生式一份配置装了几个模块时每节各一张
// 对照表 / 统计表、详情按模块分组；不分节（或只有一节）就是一个匿名节，节标题不出、编号不变。
const secs = computed(() => {
  const m = model.value
  const raw = m && Array.isArray(m.sections) && m.sections.length > 1 ? m.sections : null
  if (!raw) return [{ title: '', links: links.value, summary: summary.value, single: true }]
  return raw.map((s, i) => ({
    title: s.title || '', regenMode: s.regenMode || '',
    links: links.value.filter((l) => l && l.sec === i),
    summary: s.summary || { metrics: [], stats: [] }, single: false
  }))
})
const multi = computed(() => secs.value.length > 1)
const secsWithStats = computed(() => secs.value.filter((s) => s.summary.stats && s.summary.stats.length))
// 逐参数对照是链路做列的宽表：按 8 条链路一组切成续表，用「表 n-i（续）」的题注串起来。
const CMP_CHUNK = 8
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push({ from: i, items: arr.slice(i, i + n) })
  return out
}
const chunksOf = (s) => chunk(s.links, CMP_CHUNK)
const secTitle = (s, base) => base + (multi.value && s.title ? '　·　' + s.title : '')

// 表号全文连续（模板口径），与 Word 端同一套编法：逐参数对照（分节时每节一张）→ 容量与统计（每节一张）
// → 引用建议书 → 物理常数 → SLA；详情章的表另按「链路序号-块序号」编，不占这个号。
// 模板渲染是纯函数式的（同一份模型可能被 Vue 重算多次），故编号不能用可变计数器——
// 在这里按固定次序一次算好，各处照名字取。
const tblNo = computed(() => {
  const n = { compare: [], capacity: [] }
  let k = 0
  secs.value.forEach(() => n.compare.push(++k))
  secs.value.forEach((s) => n.capacity.push(s.summary.stats && s.summary.stats.length ? ++k : 0))
  n.refs = ++k
  n.consts = ++k
  if (hasSla.value) n.sla = ++k
  // 第 5 章：逐星「质量特性」一张、「挂点布局」一张（续表共用一个号），接在 SLA 之后——与 Word 端同一次序
  n.layout = layoutDoc.value.map((d) => ({ mass: d.mass ? ++k : 0, mount: d.mount && d.mount.chunks.length ? ++k : 0 }))
  return n
})
// 第 5 章「卫星本体与天线布局」（二期契约 D14–D16）：排版计划在渲染端 lbReport.bodyLayoutDoc 定死，这里只排；
// 没有布局块 ⇒ 整章不出、目录不列、表号图号不占。图号全局连续（图 1、图 2…；D15），不用「图 5-i」——
// 那会与 #5 链路详情的图撞号。redistributable=false 的星不出图（组块时已丢，这里再兜一道），数字表照出。
const layoutDoc = computed(() => {
  const m = model.value
  if (!m || !m.hasLayout || !Array.isArray(m.layoutDoc)) return []
  return m.layoutDoc.filter((d) => d && (d.figure || d.mass || d.mount))
})
const hasLayout = computed(() => layoutDoc.value.length > 0)
const layoutMulti = computed(() => layoutDoc.value.length > 1)
const layoutViews = (d) => {
  const s = ((model.value && model.value.bodyLayout && model.value.bodyLayout.sats) || [])[d.sat] || {}
  return d.figure && s.views && s.views.dataUrl && s.redistributable !== false ? s.views : null
}
const figNo = computed(() => { let f = 0; return layoutDoc.value.map((d) => (layoutViews(d) ? ++f : 0)) })
const capFigureNo = (no, title) => {
  const t = en.value ? 'Figure' : (L.value.figure || '图')
  return en.value ? `${t} ${no}  ${title}` : `${t} ${no}　${title}`
}
// SLA 建议（§4）：矩阵由主进程按各链路的条款并集转置好（见 report.js 的 buildSlaMatrix）；
// 一条链路都没勾条款 ⇒ hasSla 为假 ⇒ 整节不出、目录不列、表号不占。
const hasSla = computed(() => !!(model.value && model.value.hasSla && model.value.slaMatrix && model.value.slaMatrix.rows.length))
const slaMatrix = computed(() => (hasSla.value ? model.value.slaMatrix : null))
const slaParams = computed(() => (model.value && model.value.slaParams) || [])
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
// 逐链路 SLA 明细：把条款行按组切开，组名单独占一行（与总报告矩阵、Excel、Word 同一手法）
function slaDetailRows(l) {
  const out = []
  let grp = ''
  for (const r of ((l.sla && l.sla.rows) || [])) {
    if (r.groupLabel && r.groupLabel !== grp) { grp = r.groupLabel; out.push({ group: true, label: grp }) }
    out.push({ group: false, label: r.label + (r.sub ? '　' + r.sub : ''), basis: r.basis, suggest: r.suggest, adopt: r.adopt, unit: r.unit })
  }
  return out
}
// 详情页副标题：分节时写这条链路所属模块的名字（「计算方式」逐条在输入清单的「计算设置」块里）
const secOfLink = (l) => (multi.value && l && l.sec != null ? secs.value[l.sec] : null)
const detailSub = (l) => {
  const s = secOfLink(l)
  return [calc.value.satelliteName, calc.value.frequencyBand, s ? s.title : calc.value.mode].filter(Boolean).join('　·　')
}
// 分节时第一条链路前出一页模块名（同一节的其余链路不再重复）
const secHeadBefore = (l, i) => { const s = secOfLink(l); return s && (i === 0 || secOfLink(links.value[i - 1]) !== s) ? s.title : '' }

// 目录：章节清单（页码交给 PDF 书签与页脚页码，此处不标——混合方向下靠估算标页码，
// 一旦某段因「表不许拦腰断开」提前换页就会差一页，宁可不标也不能标错）
const toc = computed(() => {
  const l = L.value
  const items = [{ n: '', t: l.master, sub: false }, { n: '1', t: l.compare, sub: true }]
  if (multi.value) secs.value.forEach((s, i) => items.push({ n: '1.' + (i + 1), t: s.title, sub: true }))
  if (secsWithStats.value.length) {
    items.push({ n: '2', t: l.capacity, sub: true })
    if (multi.value) for (const s of secsWithStats.value) items.push({ n: '2.' + (secs.value.indexOf(s) + 1), t: s.title, sub: true })
  }
  items.push({ n: '3', t: l.refs, sub: true })
  if (hasSla.value) items.push({ n: '4', t: l.sla, sub: true })
  if (hasLayout.value) {
    items.push({ n: '5', t: l.layout, sub: true })
    // 逐星小节与分节时的 1.n / 2.n 同级（本目录只分两档：章名与其下各条）
    if (layoutMulti.value) layoutDoc.value.forEach((d, i) => items.push({ n: '5.' + (i + 1), t: d.title, sub: true }))
  }
  items.push({ n: '', t: l.detail, sub: false })
  for (const s of secs.value) {
    if (multi.value) items.push({ n: '', t: s.title, sub: true })
    for (const lk of s.links) items.push({ n: '#' + lk.no, t: linkTitle(lk), sub: true })
  }
  return items
})

onMounted(async () => {
  try { model.value = api ? await api.model() : null } catch (e) { model.value = null }
  // 报告字体（导出报告对话框「字体」，随模型 doc.fonts 带来的两条 CSS 栈）：盖掉 lbreport.css :root 的模板缺省。
  // 写在 <html> 上而不是 .rp 上——body 的 font-family 也读这两个变量，页面里没有任何一处在它之外。
  // 没带 fonts（出厂值）就一个字都不动，页面照旧是模板口径。
  const fonts = model.value && model.value.doc && model.value.doc.fonts
  if (fonts && fonts.cssBody && fonts.cssHead) {
    document.documentElement.style.setProperty('--rp-font-body', fonts.cssBody)
    document.documentElement.style.setProperty('--rp-font-head', fonts.cssHead)
  }
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
    <!-- 分节（再生式多模块）：每个模块一张对照表（上行 / 下行 / 星间的指标行各不相同），小节 1.n 与模块次序对应 -->
    <section class="rp-sheet rp-land">
      <h1 class="rp-h1">{{ L.master }}</h1>
      <h2 class="rp-h2">1　{{ L.compare }}</h2>
      <template v-for="(s, si) in secs" :key="si">
        <h3 v-if="multi" class="rp-h3">1.{{ si + 1 }}　{{ s.title }}</h3>
        <template v-for="(ck, ci) in chunksOf(s)" :key="ci">
          <div class="rp-caption">{{ capTable(tblNo.compare[si], ci, chunksOf(s).length, secTitle(s, L.compare)) }}</div>
          <table class="rp-tb">
            <thead>
              <tr>
                <th class="id">{{ L.param }}</th>
                <th v-for="(l, li) in ck.items" :key="li" class="num">#{{ l.no }}　{{ linkTitle(l) }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(m, mi) in s.summary.metrics" :key="mi">
                <td class="id">{{ m.label }}</td>
                <td v-for="(l, li) in ck.items" :key="li" class="num">{{ m.values[ck.from + li] }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </section>

    <!-- ——— 容量与统计 / 计算模型与参考（A4 纵向）——— -->
    <section class="rp-sheet">
      <template v-if="secsWithStats.length">
        <h2 class="rp-h2">2　{{ L.capacity }}</h2>
        <template v-for="s in secsWithStats" :key="secs.indexOf(s)">
          <h3 v-if="multi" class="rp-h3">2.{{ secs.indexOf(s) + 1 }}　{{ s.title }}</h3>
          <div v-if="s.summary.statsTitle" class="rp-note">{{ s.summary.statsTitle }}</div>
          <div class="rp-caption">{{ capTable(tblNo.capacity[secs.indexOf(s)], 0, 1, secTitle(s, L.capacity)) }}</div>
          <table class="rp-tb">
            <thead><tr><th class="lbl">{{ L.param }}</th><th class="num">{{ L.value }}</th></tr></thead>
            <tbody>
              <tr v-for="(st, si) in s.summary.stats" :key="si"><td class="lbl">{{ st.label }}</td><td class="num">{{ st.value }}</td></tr>
            </tbody>
          </table>
        </template>
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

      <!-- SLA 建议：条款（含单位）做行、链路做列，格里是采用值（留空即建议值）。
           分组行走 .rp-grp（与 3.2 的类别行同一手法：黑体不加粗，三线表不许底纹）。 -->
      <template v-if="hasSla">
        <h2 class="rp-h2">4　{{ L.sla }}</h2>
        <div class="rp-caption">{{ capTable(tblNo.sla, 0, 1, L.sla) }}</div>
        <table class="rp-tb">
          <thead><tr>
            <th class="lbl">{{ L.slaTerm }}</th>
            <th v-for="l in links" :key="l.no" class="num">#{{ l.no }}　{{ linkTitle(l) }}</th>
          </tr></thead>
          <tbody>
            <template v-for="(row, ri) in slaMatrix.rows" :key="ri">
              <tr v-if="row.group" class="rp-grp"><td class="lbl" :colspan="1 + links.length">{{ row.label }}</td></tr>
              <tr v-else>
                <td class="lbl">{{ row.label }}</td>
                <td v-for="(v, vi) in row.values" :key="vi" class="num">{{ v || '—' }}</td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-if="slaParams.length" class="rp-note">{{ L.slaParams }}　{{ slaParams.map((x) => x.label + ' ' + x.value + (x.unit ? ' ' + x.unit : '')).join('　·　') }}</div>
      </template>

      <!-- 第 5 章「卫星本体与天线布局」：另起一页；每星 三视图 + 透视（纵向四宫格）→ 质量特性表 → 挂点布局表（续表共用表号）。
           分组行走 .rp-grp（三线表不许底纹，层次靠黑体）；挂点表参数做行、挂点做列，格里只有数。 -->
      <template v-if="hasLayout">
        <h2 class="rp-h2 rp-layout-h">5　{{ L.layout }}</h2>
        <div v-for="(d, di) in layoutDoc" :key="di" class="rp-layout-sat">
          <h3 v-if="layoutMulti" class="rp-h3">5.{{ di + 1 }}　{{ d.title }}</h3>
          <figure v-if="layoutViews(d)" class="rp-fig rp-layout">
            <img :src="layoutViews(d).dataUrl" alt="" />
            <figcaption>{{ capFigureNo(figNo[di], d.figure.caption) }}</figcaption>
          </figure>
          <template v-if="d.mass">
            <div class="rp-caption">{{ capTable(tblNo.layout[di].mass, 0, 1, d.mass.title) }}</div>
            <table class="rp-tb rp-layout-tb">
              <thead><tr><th v-for="(h, hi) in d.mass.head" :key="hi" :class="d.mass.align[hi] === 'right' ? 'num' : 'lbl'" :style="{ width: d.mass.widths[hi] + '%' }">{{ h }}</th></tr></thead>
              <tbody>
                <template v-for="(r, ri) in d.mass.rows" :key="ri">
                  <tr v-if="d.mass.keyRows[ri]" class="rp-grp"><td class="lbl" :colspan="d.mass.head.length">{{ r[0] }}</td></tr>
                  <tr v-else><td v-for="(c, ci) in r" :key="ci" :class="d.mass.align[ci] === 'right' ? 'num' : 'lbl'">{{ c }}</td></tr>
                </template>
              </tbody>
            </table>
          </template>
          <template v-if="d.mount">
            <template v-for="(ck, ci) in d.mount.chunks" :key="'m' + ci">
              <div class="rp-caption">{{ capTable(tblNo.layout[di].mount, ci, d.mount.chunks.length, d.mount.title) }}</div>
              <table class="rp-tb rp-layout-tb rp-keep" :style="ck.widthPct < 100 ? { width: ck.widthPct + '%', marginLeft: 'auto', marginRight: 'auto' } : null">
                <thead><tr><th v-for="(h, hi) in ck.head" :key="hi" :class="ck.align[hi] === 'right' ? 'num' : 'lbl'" :style="{ width: ck.widths[hi] + '%' }">{{ h }}</th></tr></thead>
                <tbody>
                  <template v-for="(r, ri) in ck.rows" :key="ri">
                    <tr v-if="ck.keyRows[ri]" class="rp-grp"><td class="lbl" :colspan="ck.head.length">{{ r[0] }}</td></tr>
                    <tr v-else><td v-for="(c, cj) in r" :key="cj" :class="ck.align[cj] === 'right' ? 'num' : 'lbl'">{{ c }}</td></tr>
                  </template>
                </tbody>
              </table>
            </template>
          </template>
        </div>
      </template>
    </section>

    <!-- ——— 逐链路详情（A4 横向，屏幕排版复刻）———
         分节时每个模块的第一条链路前出一行模块名（真 <h2>，进 PDF 书签），副标题写所属模块 -->
    <section v-for="(l, li) in links" :key="l.no" class="rp-detail rp-land">
      <h2 v-if="secHeadBefore(l, li)" class="rp-h2 rp-detail-sec">{{ secHeadBefore(l, li) }}</h2>
      <div class="rp-detail-hd">
        <span class="rp-detail-no">#{{ l.no }}</span>
        <h1 class="rp-detail-name">{{ linkTitle(l) }}</h1>
        <span class="rp-detail-sub">{{ detailSub(l) }}</span>
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

      <!-- SLA 建议：条款 / 计算依据 / 建议值 / 采用值 / 单位 五列三线表，接在级联表之后 -->
      <template v-if="!l.error && (l.sla && l.sla.rows || []).length">
        <h3 class="rp-h3 rp-sla-h">{{ L.sla }}</h3>
        <div class="rp-caption">{{ capTable(l.no + '-' + ((l.inputs || []).length + 1), 0, 1, L.sla) }}</div>
        <table class="rp-tb rp-sla">
          <thead><tr>
            <th class="lbl">{{ L.slaTerm }}</th><th class="num">{{ L.slaBasis }}</th>
            <th class="num">{{ L.slaSuggest }}</th><th class="num">{{ L.slaAdopt }}</th><th class="unit">{{ L.unit }}</th>
          </tr></thead>
          <tbody>
            <template v-for="(row, ri) in slaDetailRows(l)" :key="ri">
              <tr v-if="row.group" class="rp-grp"><td class="lbl" colspan="5">{{ row.label }}</td></tr>
              <tr v-else>
                <td class="lbl">{{ row.label }}</td><td class="num">{{ row.basis }}</td>
                <td class="num">{{ row.suggest }}</td><td class="num">{{ row.adopt }}</td><td class="unit">{{ row.unit }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
    </section>

  </div>
</template>
