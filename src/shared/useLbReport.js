// 「导出报告」的一套流程（GSO / NGSO / 再生式三窗共用）。
//
// 三个工作台是镜像代码，同一段流程照抄三份必然漂移（改一处忘两处），故收在这里，各窗只把
// 自己的数据源传进来。流程本身很短，难点全在「图」上：
//   1. 逐条链路把「详细预算」切过去，等图表区把这条链路的场扫完、几何摆好，再取一张 4 倍 PNG；
//   2. 组模型（元信息 + 逐链路结果 + 输入清单 + 图件）；
//   3. 交给主进程出 .xlsx / .pdf。
// 取图走的是图上「出图」按钮同一条渲染路径（见 LbVizPane.captureFigures），所以报告里的图
// 与用户自己导出来的是同一张；图表区关着（或这条链路画不出图）就没有图——没有就是没有。
import { reactive, ref } from 'vue'
import { buildReportModel, buildInputDigest, calcBlock } from './lbReport.js'
import { buildSlaReportModel } from './lbSlaReport.js'   // 独立《服务等级指标（SLA）》报告的模型
import { isUnitAdaptive } from './lbUnitMode.js'   // 结果显示单位档（功能区「单位」）：报告与屏幕同口径

// 报告里图件的像素倍率。图上那个「出图」按钮用 4 倍，是因为它出的图不知道会被放到多大；
// 报告里的图位是定死的（PDF 里限高 82 mm、Excel 里 460 px 宽），2 倍已合 550 dpi 以上，
// 再往上只是把一份带着几十张图的模型撑成上百 MB 过 IPC——300 dpi 之外印不出任何差别。
const FIG_SCALE = 2

export function useLbReport(o) {
  const dlg = reactive({ open: false, busy: false, progress: null })
  // 同一个对话框壳两种口径：'full' = 链路预算报告，'sla' = 独立的《服务等级指标（SLA）》报告。
  // busy / progress 共用（一次只出一份），提交按 variant 分派。
  const variant = ref('full')

  function open() {
    if (!o.links().length) { o.toast('请先执行「计算」生成结果'); return }
    variant.value = 'full'
    dlg.progress = null
    dlg.open = true
  }

  function openSla() {
    if (!o.links().length) { o.toast('请先执行「计算」生成结果'); return }
    if (!o.slaCount || !o.slaCount()) { o.toast('请先在「SLA 建议」里勾选要列入的条款'); return }
    variant.value = 'sla'
    dlg.progress = null
    dlg.open = true
  }

  // 逐条链路取图。切链路 → 等图就绪 → 取图；任何一条取不到就跳过。
  // 结束时把「详细预算」还回用户原来看的那条链路（导出不该改变他的现场）。
  async function harvestFigures(onStep) {
    const out = {}
    const viz = o.vizRef()
    const links = o.links()
    if (!o.showViz() || !viz) return out
    const keep = o.selected()
    try {
      for (let i = 0; i < links.length; i++) {
        const l = links[i]
        if (onStep) onStep(i, l)
        if (!l || l.error || !l.data) continue
        o.setSelected(i)
        await o.nextTick()
        // 图表区跟着 selected 走：切完先让它把新入参吃进去，再等它算完
        await new Promise((r) => setTimeout(r, 30))
        try { out[i] = await viz.captureFigures({ scale: FIG_SCALE }) } catch (e) { out[i] = [] }
      }
    } finally {
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
      // 含 SLA 时先把档位扫描 / 日凌这些【惰性算的会话态】补齐：它们只在用得着时才算，导出前必须到位，
      // 否则报告里的条款数随「有没有开过 SLA 弹窗」变
      if (opts.withSla && o.beforeSla) await o.beforeSla()
      const lang = o.lang()
      const en = lang === 'en'
      const links = o.links()
      const total = links.length
      const calc = o.calc()

      let figures = {}
      if (opts.withFigures) {
        figures = await harvestFigures((i, l) => {
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
        regenMode: o.regenMode ? o.regenMode() : 'uplink',
        doc: opts.doc,
        appVersion: o.appVersion(),
        satelliteName: calc.satelliteName || '',
        frequencyBand: calc.frequencyBand || '',
        calc,
        links: links.map((l, i) => {
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
            figures: (figures[i] || []).map((f) => ({ title: f.title, dataUrl: f.dataUrl }))
          }
          // 各体制特有的附加料（NGSO 平台几何 / 再生式星间几何 + 站址），供「几何关系」sheet 用
          return o.extraLink ? Object.assign(base, o.extraLink(l, i)) : base
        })
      })

      const r = await api.report.exportReport({ model, formats: opts.formats, defaultName: o.defaultName(en) })
      if (r && r.ok) { o.toast('已生成：' + (r.files || []).join('　')); dlg.open = false }
      else if (r && !r.canceled) o.setError('导出失败：' + (r.error || '未知错误'))
    } catch (e) {
      o.setError('导出失败：' + ((e && e.message) || String(e)))
    } finally { dlg.busy = false; dlg.progress = null }
  }

  // 《服务等级指标（SLA）》：不取图、不组瀑布、不带输入清单，只把各链的 SLA 块与档位表组成模型。
  // 一条条款都没勾（对话框按钮已禁用）时再兜一道：模型 hasSla 为假，主进程会直接拒。
  async function runSla(opts) {
    const api = o.api
    if (!api) { o.setError('导出需在桌面客户端中运行'); return }
    if (o.slaCount && !o.slaCount()) { o.setError('没有任何链路勾选了 SLA 条款'); return }
    dlg.busy = true
    try {
      if (o.beforeSla) await o.beforeSla()   // 档位扫描 / 日凌是惰性会话态，出报告前补齐
      const lang = o.lang()
      const en = lang === 'en'
      const links = o.links()
      const calc = o.calc()
      dlg.progress = { text: en ? 'Laying out and writing files…' : '排版与写盘…', done: links.length, total: links.length }
      const model = buildSlaReportModel({
        lang,
        adaptUnits: isUnitAdaptive(),
        doc: opts.doc,
        appVersion: o.appVersion(),
        orbitType: o.orbitType,
        regenMode: o.regenMode ? o.regenMode() : 'uplink',
        calc: Object.assign({ satelliteName: calc.satelliteName || '', frequencyBand: calc.frequencyBand || '' }, calc),
        slaParams: o.slaParams ? o.slaParams() : [],
        composition: o.slaComposition ? o.slaComposition() : [],
        monthly: o.slaMonthly ? o.slaMonthly() : 0,
        // ★ 只在宿主真给了判定器时才带这两个键：恒传 false 会把模型里「按链路自动判有没有 DVB / 3GPP」
        //   那一步挡死，引用标准表从此永远缺 EN 302 307 与 3GPP（四窗都没注入过判定器）。
        ...(o.slaHasDvb ? { hasDvb: !!o.slaHasDvb() } : {}),
        ...(o.slaHasNtn ? { hasNtn: !!o.slaHasNtn() } : {}),
        links: links.map((l, i) => Object.assign({
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
    } finally { dlg.busy = false; dlg.progress = null }
  }

  // 提交按 variant 分派：两份报告共用同一个对话框壳
  const submit = (opts) => ((opts && opts.variant === 'sla') ? runSla(opts) : run(opts))

  return {
    reportDlg: dlg, reportVariant: variant,
    openReportDialog: open, openSlaReportDialog: openSla,
    runReport: run, runSlaReport: runSla, submitReport: submit
  }
}
