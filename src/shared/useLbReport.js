// 「导出报告」的一套流程（GSO / NGSO / 再生式 / 端到端 四窗共用）。
//
// 四个工作台是镜像代码，同一段流程照抄四份必然漂移（改一处忘三处），故收在这里，各窗只把
// 自己的数据源传进来。流程本身很短，难点全在「图」上：
//   1. 逐条链路把「详细预算」切过去，等图表区把这条链路的场扫完、几何摆好，再取一张 4 倍 PNG；
//   2. 组模型（元信息 + 逐链路结果 + 输入清单 + 图件）；
//   3. 交给主进程出 .xlsx / .docx / .pdf。
// 取图走的是图上「出图」按钮同一条渲染路径（见 LbVizPane.captureFigures），所以报告里的图
// 与用户自己导出来的是同一张；图表区关着（或这条链路画不出图）就没有图——没有就是没有。
//
// ★ 分节（2026-09-07 起，再生式）：一份配置可以装几个计算模块（上行 / 下行 / 星间微波 / 星间激光），
//   报告讲的是【整份配置】而不是屏幕上正看着的那个模块。分节窗口多交三样东西：
//     sections()          → [{ key, regenMode, links }]，按配置里的模块次序；
//     activateSection(k)  → 把工作台切到该模块（取图要靠图表区画出这一节的链路）；
//     beforeReport(step)  → 导出前把没算过 / 已过期的模块补算（结果不齐的报告不叫整份配置）。
//   模型里各链路带 sec（节下标）、全篇 #N 连续编号；不分节的窗口一个字都不用改。
import { reactive, ref } from 'vue'
import { buildReportModel, buildInputDigest, calcBlock, carrierIdentity, regenModeName } from './lbReport.js'
import { buildSlaReportModel } from './lbSlaReport.js'   // 独立《服务等级指标（SLA）》报告的模型
import { isUnitAdaptive } from './lbUnitMode.js'   // 结果显示单位档（功能区「单位」）：报告与屏幕同口径

// 报告里图件的像素倍率。图上那个「出图」按钮用 4 倍，是因为它出的图不知道会被放到多大；
// 报告里的图位是定死的（PDF 里限高 82 mm、Excel 里 460 px 宽），2 倍已合 550 dpi 以上，
// 再往上只是把一份带着几十张图的模型撑成上百 MB 过 IPC——300 dpi 之外印不出任何差别。
const FIG_SCALE = 2
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export function useLbReport(o) {
  const dlg = reactive({ open: false, busy: false, progress: null })
  // 同一个对话框壳两种口径：'full' = 链路预算报告，'sla' = 独立的《服务等级指标（SLA）》报告。
  // busy / progress 共用（一次只出一份），提交按 variant 分派。
  const variant = ref('full')

  // 有没有东西可报：分节窗口按「有链路行」算（导出前 beforeReport 会把没算过的模块补算），
  // 其余窗口按已有结果算（没算过就没有数）。
  const hasWork = () => (o.canReport ? !!o.canReport() : o.links().length > 0)
  const emptyHint = () => (o.canReport ? '没有可报告的链路' : '请先执行「计算」生成结果')

  function open() {
    if (!hasWork()) { o.toast(emptyHint()); return }
    variant.value = 'full'
    dlg.progress = null
    dlg.open = true
  }

  function openSla() {
    if (!hasWork()) { o.toast(emptyHint()); return }
    if (!o.slaCount || !o.slaCount()) { o.toast('请先在「SLA 建议」里勾选要列入的条款'); return }
    variant.value = 'sla'
    dlg.progress = null
    dlg.open = true
  }

  // 统一成节列表：分节窗口给 sections()，其余窗口就是一个匿名节（key 为空 = 不切模块）
  function collect() {
    if (o.sections) return (o.sections() || []).map((s) => ({ key: s.key, regenMode: s.regenMode || s.key, links: s.links || [] }))
    return [{ key: '', regenMode: o.regenMode ? o.regenMode() : 'uplink', links: o.links() }]
  }
  // 摊平成导出序：si 节下标、li 节内下标（取图时 setSelected 用节内下标，各节自记自己的选中行）
  const flatten = (secs) => secs.flatMap((s, si) => s.links.map((l, li) => ({ l, si, li, s })))
  const sectionsFor = (secs, lang) => (o.sections
    ? secs.map((s) => ({ key: s.key, regenMode: s.regenMode, title: regenModeName(s.regenMode, lang), count: s.links.length }))
    : null)
  const stepper = () => (text, done, total) => { dlg.progress = { text, done, total } }

  // 逐条链路取图。切节 → 切链路 → 等图就绪 → 取图；任何一条取不到就跳过。
  // 结束时把「详细预算」还回用户原来看的那一节那条链路（导出不该改变他的现场）。
  async function harvestFigures(flat, onStep) {
    const out = {}
    const viz = o.vizRef()
    if (!o.showViz() || !viz) return out
    const keep = o.selected()
    const keepSec = o.activeSection ? o.activeSection() : ''
    let curSec = keepSec
    try {
      for (let i = 0; i < flat.length; i++) {
        const { l, li, s } = flat[i]
        if (onStep) onStep(i, l)
        if (!l || l.error || !l.data) continue
        if (o.activateSection && s.key && s.key !== curSec) { await o.activateSection(s.key); curSec = s.key; await o.nextTick() }
        o.setSelected(li)
        await o.nextTick()
        // 图表区跟着 selected 走：切完先让它把新入参吃进去，再等它算完
        await wait(30)
        try { out[i] = await viz.captureFigures({ scale: FIG_SCALE }) } catch (e) { out[i] = [] }
      }
    } finally {
      if (o.activateSection && keepSec && keepSec !== curSec) { await o.activateSection(keepSec); await o.nextTick() }
      o.setSelected(keep)
      await o.nextTick()
    }
    return out
  }

  async function run(opts) {
    const api = o.api
    if (!api) { o.setError('导出需在桌面客户端中运行'); return }
    dlg.busy = true
    try {
      const lang = o.lang()
      const en = lang === 'en'
      // 分节窗口：先把没算过 / 已过期的模块补齐——报告讲整份配置，结果不齐就不是整份
      if (o.beforeReport) await o.beforeReport(stepper())
      // 含 SLA 时再把档位扫描 / 日凌这些【惰性算的会话态】补齐：它们只在用得着时才算，导出前必须到位，
      // 否则报告里的条款数随「有没有开过 SLA 弹窗」变
      if (opts.withSla && o.beforeSla) await o.beforeSla()
      const secs = collect()
      const flat = flatten(secs)
      const total = flat.length
      if (!total) { o.setError(en ? 'Nothing to report' : '没有可报告的链路'); return }
      const calc = o.calc()

      let figures = {}
      if (opts.withFigures) {
        figures = await harvestFigures(flat, (i, l) => {
          dlg.progress = {
            text: (en ? 'Rendering figures: ' : '取图：') + (l ? (l.txName || '') + ' → ' + (l.rxName || '') : ''),
            done: i, total
          }
        })
      }
      dlg.progress = { text: en ? 'Laying out and writing files…' : '排版与写盘…', done: total, total }

      // 「计算设置」块：求解策略随载波逐链路而定（o.calcFor），故逐条各出各的；
      // 未提供 calcFor 的窗口沿用全批次同一份。
      const cbOf = (l) => (o.calcFor ? calcBlock(Object.assign({}, calc, o.calcFor(l)), lang) : calcBlock(calc, lang))
      // SLA 建议（§4）：各窗用 lbSla.slaReportBlock 出纯数据（标签已按 lang 翻好、值已按单位档格式化）。
      // 对话框没勾「含 SLA 建议」就整个不带 —— hasSla 随之为假，三份文件里那一节连同目录条目一起消失。
      const slaOf = (l) => (opts.withSla && o.slaFor ? o.slaFor(l) : null)
      const model = buildReportModel({
        lang,
        adaptUnits: isUnitAdaptive(),
        slaParams: opts.withSla && o.slaParams ? o.slaParams() : null,
        orbitType: o.orbitType,
        regenMode: secs[0].regenMode,
        sections: sectionsFor(secs, lang),
        // doc 里带着对话框选的报告字体（doc.fonts，出厂值时为 null → 主进程走模板默认）
        doc: opts.doc,
        appVersion: o.appVersion(),
        satelliteName: calc.satelliteName || '',
        frequencyBand: calc.frequencyBand || '',
        calc,
        links: flat.map(({ l, si }, i) => {
          const p = o.paramsFor(l)
          const inputs = p ? buildInputDigest(o.fieldGroups, p, lang) : []
          const cb = cbOf(l)
          if (cb) inputs.push(cb)
          const base = {
            no: i + 1, rowId: l.rowId, txName: l.txName, rxName: l.rxName,
            ok: !!l.ok, error: l.error || '',
            data: l.data ? JSON.parse(JSON.stringify(l.data)) : null,
            inputs,
            sla: slaOf(l),
            // 载波身份（总报告「逐参数对照」头两行）：各窗只交出这条链路用的载波表单（端到端逐段一份），
            // 「标准」名在 lbReport.carrierIdentity 统一解析；「调制编码」主进程直接取引擎回显，不从这里走
            carrier: o.carrierOf ? carrierIdentity(o.carrierOf(l), o.basebandOpts ? o.basebandOpts() : null, lang) : null,
            figures: (figures[i] || []).map((f) => ({ title: f.title, dataUrl: f.dataUrl }))
          }
          if (o.sections) base.sec = si
          // 各体制特有的附加料（NGSO 平台几何 / 再生式星间几何 + 站址），供「几何关系」sheet 用
          return o.extraLink ? Object.assign(base, o.extraLink(l, i)) : base
        })
      })

      const r = await api.report.exportReport({ model, formats: opts.formats, defaultName: o.defaultName(en) })
      if (r && r.ok) { o.toast('已生成：' + (r.files || []).join('　')); dlg.open = false }
      else if (r && !r.canceled) o.setError('导出失败：' + (r.error || '未知错误'))
    } catch (e) {
      o.setError('导出失败：' + ((e && e.message) || String(e)))
    } finally {
      dlg.busy = false; dlg.progress = null
      if (o.afterReport) { try { await o.afterReport() } catch (e) { /* 现场还原失败不影响已出的文件 */ } }
    }
  }

  // 《服务等级指标（SLA）》：不取图、不组瀑布、不带输入清单，只把各链的 SLA 块与档位表组成模型。
  // 一条条款都没勾（对话框按钮已禁用）时再兜一道：模型 hasSla 为假，主进程会直接拒。
  async function runSla(opts) {
    const api = o.api
    if (!api) { o.setError('导出需在桌面客户端中运行'); return }
    if (o.slaCount && !o.slaCount()) { o.setError('没有任何链路勾选了 SLA 条款'); return }
    dlg.busy = true
    try {
      const lang = o.lang()
      const en = lang === 'en'
      if (o.beforeReport) await o.beforeReport(stepper())   // 分节窗口：没算过 / 过期的模块先补算
      if (o.beforeSla) await o.beforeSla()   // 档位扫描 / 日凌是惰性会话态，出报告前补齐
      const secs = collect()
      const flat = flatten(secs)
      const calc = o.calc()
      dlg.progress = { text: en ? 'Laying out and writing files…' : '排版与写盘…', done: flat.length, total: flat.length }
      // 可用度构成（§5）：分节时逐模块各出一份，行名前缀该节的名字（各模块计入的环节各不相同）
      let composition = []
      if (o.slaComposition) {
        if (o.sections && secs.length > 1) {
          for (const s of secs) {
            const title = regenModeName(s.regenMode, lang)
            for (const c of (o.slaComposition(s.key) || [])) composition.push(Object.assign({}, c, { label: title + ' · ' + c.label }))
          }
        } else composition = o.slaComposition(secs[0].key) || []
      }
      const model = buildSlaReportModel({
        lang,
        adaptUnits: isUnitAdaptive(),
        doc: opts.doc,
        appVersion: o.appVersion(),
        orbitType: o.orbitType,
        regenMode: o.sections ? secs.map((s) => s.regenMode) : secs[0].regenMode,
        calc: Object.assign({ satelliteName: calc.satelliteName || '', frequencyBand: calc.frequencyBand || '' }, calc),
        slaParams: o.slaParams ? o.slaParams() : [],
        composition,
        monthly: o.slaMonthly ? o.slaMonthly() : 0,
        // ★ 只在宿主真给了判定器时才带这两个键：恒传 false 会把模型里「按链路自动判有没有 DVB / 3GPP」
        //   那一步挡死，引用标准表从此永远缺 EN 302 307 与 3GPP（四窗都没注入过判定器）。
        ...(o.slaHasDvb ? { hasDvb: !!o.slaHasDvb() } : {}),
        ...(o.slaHasNtn ? { hasNtn: !!o.slaHasNtn() } : {}),
        links: flat.map(({ l }, i) => Object.assign({
          no: i + 1, rowId: l.rowId, txName: l.txName, rxName: l.rxName,
          ok: !!l.ok, error: l.error || '',
          data: l.data ? JSON.parse(JSON.stringify(l.data)) : null,
          sla: o.slaFor ? o.slaFor(l) : null
        }, o.slaExtra ? o.slaExtra(l, i) : null))
      })
      if (!model.hasSla) { o.setError('没有任何链路勾选了 SLA 条款'); return }
      const r = await api.report.exportReport({
        model: JSON.parse(JSON.stringify(model)), formats: opts.formats,
        defaultName: (o.slaDefaultName ? o.slaDefaultName(en) : o.defaultName(en))
      })
      if (r && r.ok) { o.toast('已生成：' + (r.files || []).join('　')); dlg.open = false }
      else if (r && !r.canceled) o.setError('导出失败：' + (r.error || '未知错误'))
    } catch (e) {
      o.setError('导出失败：' + ((e && e.message) || String(e)))
    } finally {
      dlg.busy = false; dlg.progress = null
      if (o.afterReport) { try { await o.afterReport() } catch (e) { /* 同上 */ } }
    }
  }

  // 提交按 variant 分派：两份报告共用同一个对话框壳
  const submit = (opts) => ((opts && opts.variant === 'sla') ? runSla(opts) : run(opts))

  return {
    reportDlg: dlg, reportVariant: variant,
    openReportDialog: open, openSlaReportDialog: openSla,
    runReport: run, runSlaReport: runSla, submitReport: submit
  }
}
