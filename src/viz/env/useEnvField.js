// 环境场图层的状态与编排（侧栏「环境场」视图）。
//
// 分层：取数（主进程，一次一张栅格）→ 上色（本地，亚帧）→ 交给 2D/3D 两个渲染通道。
//   换字段 / 换格距 / 换口径 → 重新取数（走 IPC，百毫秒级，有 busy 态）
//   换配色 / 换值域 / 换档数 / 拉透明度 → 只重上色，不碰 IPC
// 等值线单独一步（提线比上色贵一个量级），只在开关打开时算。
//
// 宿主（3D 页）注入两个渲染回调，本模块不认识 THREE / canvas 之外的东西。

import { ref, computed, watch } from 'vue'
import { colorize, autoDomain, legendStops, bandEdges, valueAt, fmtValue, lutCss, rasterCanvas } from './envRaster.js'
import { buildContours, labelPoints } from './envContour.js'

const LS_KEY = 'env-field-ui'
const STEPS = [
  { v: 1, label: '1°（粗，最快）' },
  { v: 0.5, label: '0.5°' },
  { v: 0.25, label: '0.25°（默认）' },
  { v: 0.1, label: '0.1°（细，慢）' }
]
const SCHEMES = [
  { v: 'turbo', label: 'Turbo' }, { v: 'jet', label: 'Jet' }, { v: 'viridis', label: 'Viridis' },
  { v: 'inferno', label: 'Inferno' }, { v: 'gray', label: 'Gray' }
]

export function useEnvField(host) {
  const H = host || {}

  const open = ref(false)
  const on = ref(true)                    // 图层显示总开关
  const defs = ref([])                    // 字段注册表（主进程给）
  const key = ref('rain')
  const optRainy = ref(0), optP = ref(1)  // 随字段出现的口径参数（P.836 晴/雨天、P.840 超越概率）
  const stepDeg = ref(0.25)
  const scheme = ref('turbo'), invert = ref(false)
  const bands = ref(0)                    // 0 = 连续渐变；>0 = 分级填色档数
  const domainMode = ref('p2p98')         // p2p98 | minmax | manual
  const manualLo = ref(''), manualHi = ref('')
  const alpha = ref(0.78)
  const landOnly = ref(false)
  const contourOn = ref(false), contourStep = ref(''), contourLabel = ref(true)
  const busy = ref(false), msg = ref('')
  const field = ref(null)                 // 当前栅格（含 values/stats/bbox/精度标注）
  const contours = ref([])                // [{level, lines, ...}]

  let canvas = null                       // 位图画布（复用，换配色不重新分配）
  let reqSeq = 0                          // 取数并发序号：慢的那次回来时若已不是最新，丢弃

  const def = computed(() => defs.value.find((d) => d.key === key.value) || null)
  const fieldOpt = computed(() => (def.value && def.value.opt) || null)

  // ---- 值域 ----
  const stats = computed(() => {
    const f = field.value
    if (!f) return null
    return (landOnly.value && f.statsLand) ? f.statsLand : f.stats
  })
  const domain = computed(() => {
    const s = stats.value
    if (!s) return null
    if (domainMode.value === 'manual') {
      const lo = Number(manualLo.value), hi = Number(manualHi.value)
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) return [lo, hi]
    }
    return autoDomain(s, domainMode.value === 'minmax' ? 'minmax' : 'p2p98')
  })

  const legend = computed(() => {
    const f = field.value, d = domain.value
    if (!f || !d) return null
    return {
      stops: legendStops(scheme.value, invert.value, bands.value),
      edges: bands.value > 0 ? bandEdges(d[0], d[1], bands.value) : null,
      lo: d[0], hi: d[1], unit: f.unit, label: f.label, dec: f.dec
    }
  })

  const srcNote = computed(() => {
    const f = field.value
    if (!f) return ''
    const grid = f.step >= 1 ? f.step.toFixed(0) : f.step.toFixed(3).replace(/0+$/, '')
    return `${f.rec} · 数据 ${f.precision} · 出图 ${grid}°`
  })

  const fmt = (v) => fmtValue(v, field.value ? field.value.dec : 2)

  // ---- 取数 ----
  async function load() {
    if (!window.api?.env?.field) { msg.value = '取数通道不可用'; return }
    const seq = ++reqSeq
    busy.value = true; msg.value = ''
    const k = key.value
    const wantMask = landOnly.value || (def.value && def.value.seaHint === false)
    try {
      const res = await window.api.env.field(k, {
        step: Number(stepDeg.value) || 0.25,
        mask: wantMask,
        rainy: Number(optRainy.value) || 0,
        p: Number(optP.value) || 1
      })
      if (seq !== reqSeq) return                     // 已被更新的请求超车，丢弃
      if (!res || res.error) { msg.value = (res && res.message) || '取数失败'; field.value = null; H.draw?.(null); return }
      field.value = res
      if (!res.ready) msg.value = `${res.label}：${res.precision}`
      else if (res.fallback) msg.value = `${res.label}：全精度数据缺失，已用 ${res.precision}`
      else msg.value = `${(res.nx * res.ny / 1e4).toFixed(0)} 万点 · ${res.ms} ms`
      // 未被用户钉住时，配色跟着字段走（海拔用 Gray、水汽用 Viridis…各有惯例）
      if (!userScheme && res.scheme && scheme.value !== res.scheme) { autoScheme = res.scheme; scheme.value = res.scheme }
      if (landOnly.value && !res.land) landOnly.value = false   // 海拔数据未就绪 → 掩膜不可用
      redraw()
    } catch (e) {
      if (seq === reqSeq) { msg.value = e.message || String(e); field.value = null; H.draw?.(null) }
    } finally {
      if (seq === reqSeq) busy.value = false
    }
  }

  // ---- 上色 + 提交渲染 ----
  function redraw() {
    const f = field.value, d = domain.value
    if (!f || !d || !on.value) { H.draw?.(null); H.drawContours?.([]); return }
    const rgba = colorize(f.values, f.land, {
      lo: d[0], hi: d[1], scheme: scheme.value, invert: invert.value,
      bands: bands.value, landOnly: landOnly.value, opacity: 1
    })
    canvas = rasterCanvas(rgba, f.nx, f.ny, canvas)
    H.draw?.({ canvas, bbox: f.bbox, alpha: alpha.value, smooth: bands.value === 0 })
    redrawContours()
  }

  function redrawContours() {
    const f = field.value, d = domain.value
    if (!f || !d || !on.value || !contourOn.value) { contours.value = []; H.drawContours?.([]); return }
    // 陆地模式下海面值（海拔为水深、雨量为洋面值）不参与提线，否则岸线附近全是碎线
    let z = f.values
    if (landOnly.value && f.land) {
      z = new Float32Array(f.values.length)
      for (let i = 0; i < z.length; i++) z[i] = f.land[i] ? f.values[i] : NaN
    }
    const t0 = Date.now()
    const step = Number(contourStep.value)
    const cs = buildContours({ ...f, values: z }, {
      lo: d[0], hi: d[1],
      step: Number.isFinite(step) && step > 0 ? step : (f.contourStep || undefined),
      count: 8
    })
    contours.value = cs
    const span = (d[1] - d[0]) || 1
    H.drawContours?.(cs.map((g) => {
      const u = Math.max(0, Math.min(1, (g.level - d[0]) / span))
      return {
        level: g.level,
        text: contourLabel.value ? fmt(g.level) : '',
        color: lutCss(scheme.value, invert.value, u, 0.55),
        labelColor: lutCss(scheme.value, invert.value, u, 1.0),
        width: 1.1,
        lines: g.lines,
        labels: contourLabel.value ? labelPoints(g.lines, { max: 3 }) : []
      }
    }))
    if (cs.length) msg.value = `等值线 ${cs.length} 档 · ${Date.now() - t0} ms`
  }

  // 状态栏读数：取自**已显示的那张栅格**（双线性），格距比原生数据粗时与引擎取数会有微差
  function readAt(lat, lon) {
    const f = field.value
    if (!f || !on.value) return null
    const v = valueAt(f, lat, lon)
    if (!Number.isFinite(v)) return null
    return { short: f.short, label: f.label, unit: f.unit, text: fmtValue(v, f.dec), value: v, step: f.step }
  }

  // ---- 面板开关 ----
  async function openPanel() {
    open.value = true
    if (!defs.value.length && window.api?.env?.defs) {
      try {
        const d = await window.api.env.defs()
        if (Array.isArray(d)) defs.value = d
      } catch { /* 通道不可用时下面 load 会报 */ }
    }
    if (!field.value) await load(); else redraw()
  }
  function close() {
    open.value = false
    // 面板收起不撤图层：切到别的视图仍看得见环境场（与覆盖等其它叠加层同样的约定）
  }
  function clearLayer() {
    field.value = null; contours.value = []
    H.draw?.(null); H.drawContours?.([])
  }

  // ---- 联动 ----
  // 配色「钉住」：用户手动选过一次，之后换字段就不再自动改配色；自动写入的那次不算用户选择
  // （不能靠标志位挡——Vue 的 watch 是异步冲刷，回调跑到时标志早复位了，故按值比对）
  let userScheme = false, autoScheme = ''
  watch(scheme, (v) => { if (v !== autoScheme) userScheme = true })
  watch([key, stepDeg, optRainy, optP], () => { if (open.value || field.value) load() })
  watch(landOnly, (v) => {
    if (v && field.value && !field.value.land) load()   // 掩膜没取过 → 重取一次
    else redraw()
  })
  watch([scheme, invert, bands, domainMode, manualLo, manualHi, on], () => redraw())
  watch(alpha, (a) => { if (on.value) H.setAlpha?.(a) })
  watch([contourOn, contourStep, contourLabel], () => redrawContours())
  // 换字段时把等值线级差交还给该字段的默认值（10 mm/h 与 0.5 km 显然不能共用一个数）
  watch(key, () => { contourStep.value = '' })

  // ---- 设置记忆（只记界面选择，不记数据）----
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    if (s && typeof s === 'object') {
      if (s.key) key.value = s.key
      // 只有「用户钉过的配色」才恢复；否则让配色继续跟着字段走
      if (s.scheme && s.schemeLocked) { scheme.value = s.scheme; userScheme = true }
      if (Number.isFinite(s.step)) stepDeg.value = s.step
      if (Number.isFinite(s.alpha)) alpha.value = s.alpha
      if (Number.isFinite(s.bands)) bands.value = s.bands
      if (s.domainMode) domainMode.value = s.domainMode
      invert.value = !!s.invert; landOnly.value = !!s.landOnly
      contourOn.value = !!s.contourOn; contourLabel.value = s.contourLabel !== false
    }
  } catch { /* 首次运行无缓存 */ }
  watch([key, scheme, stepDeg, alpha, bands, domainMode, invert, landOnly, contourOn, contourLabel], () => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        key: key.value, scheme: scheme.value, schemeLocked: userScheme, step: Number(stepDeg.value), alpha: alpha.value,
        bands: bands.value, domainMode: domainMode.value, invert: invert.value, landOnly: landOnly.value,
        contourOn: contourOn.value, contourLabel: contourLabel.value
      }))
    } catch { /* 隐私模式等写不进去，忽略 */ }
  })

  return {
    // 状态
    open, on, defs, key, optRainy, optP, stepDeg, scheme, invert, bands,
    domainMode, manualLo, manualHi, alpha, landOnly,
    contourOn, contourStep, contourLabel,
    busy, msg, field, contours,
    // 派生
    def, fieldOpt, stats, domain, legend, srcNote,
    // 常量表
    STEPS, SCHEMES,
    // 方法
    openPanel, close, load, redraw, clearLayer, readAt, fmt
  }
}
