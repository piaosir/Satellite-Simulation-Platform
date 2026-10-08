// 视频叠加信息（HUD / burn-in）：数据 → 版块（纯函数，可单测）→ 画到 2D 上下文。
// 屏上取景预览与导出的每一帧走同一支 drawHud —— 预览里看到的就是成片里烧进去的。
//
// 版式口径（DaVinci「Data Burn-in」、Blender「Metadata → Burn Into Image」同一类东西）：
//   · 六个锚位：左上 / 上中 / 右上 / 左下 / 下中 / 右下，同一锚位的版块自上而下堆叠（下边的锚位自下而上）；
//     一列放不下就另起一列（左侧锚位往右排、右侧锚位往左排、居中锚位整组居中）。
//   · 字号按成片高度定（1080p 下「标准」约 21 px），与分辨率成比例 —— 4K 片里的字不会缩成一粒米。
//   · 底板可选（出厂关）：不垫底板时照平面图地名注记的套边体例 —— 字加粗、颜色不透明、外勾一圈实心深色描边，
//     不加投影（模糊投影在浅色底图上是一团灰雾，字反而发虚）。
//   · 只出数字与名目，不出判定性文字（CLAUDE.md）；仰角在地平线以下的那一行整行压暗，是着色不是结论。
//   · 聚焦卫星版块与右侧「卫星信息栏」同一套内容与版式：衬线星名 + 徽标，分节四列「标签｜符号｜数值右齐｜单位」，
//     符号（φ λ h a e i Ω ω M n T）衬线斜体，同信息栏 .rdk-s。
import { tzParts, tzTag } from '../../shared/tz.js'

export const HUD_POS = ['tl', 'tc', 'tr', 'bl', 'bc', 'br']
export const UI_FONT = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif'
export const DOC_FONT = '"Times New Roman", "SimSun", "宋体", serif'
export const SYM_FONT = '"Times New Roman", Times, serif'

const INK = '#EEF2F6', INK_K = 'rgba(238,242,246,0.64)', INK_F = 'rgba(238,242,246,0.46)', INK_DIM = 'rgba(238,242,246,0.42)'
const INK_H = 'rgba(238,242,246,0.86)'                                   // 节标题：靠字重跳出，不靠颜色
const WARN = '#D8A73A', WARN_K = 'rgba(216,167,58,0.78)', WARN_B = 'rgba(216,167,58,0.62)'   // 定点：全版块唯一的暖色（同信息栏 .rdk-bdg.geo）
const RULE = 'rgba(238,242,246,0.18)', RULE_DOT = 'rgba(238,242,246,0.34)'
const BDG_B = 'rgba(238,242,246,0.34)', BDG_KIND = 'rgba(238,242,246,0.62)'
// 两套墨色。有底板：字在深色半透明板上，层级靠透明度分档。没底板：字直接压在底图上 —— 半透明字面会透出底图
// （浅色底图上白字 × 0.64 近乎隐形），故一律不透明、层级靠灰度分档
const PAL_PANEL = { ink: INK, k: INK_K, f: INK_F, dim: INK_DIM, h: INK_H }
const PAL_BARE = { ink: '#FFFFFF', k: '#DCE1E6', f: '#C3CAD2', dim: '#97A0AA', h: '#F4F6F8' }
const CASING = 'rgb(8,12,18)'   // 套边色：同平面图影像档（labelHalo.js IMAGERY_HALO），深浅底图上都站得住
const p2 = (n) => String(n).padStart(2, '0')

/** 成片里的基准字号（px）：高度的 2%，乘用户的「字号」系数（0.6～2） */
export const hudFontPx = (H, size = 1) => Math.max(8, H * 0.02 * Math.min(2, Math.max(0.6, Number(size) || 1)))

// —— 聚焦卫星：字段目录（与右侧「卫星信息栏」同名、同序、同符号）。面板的勾选项与成片版块共用这一份 ——
//   s = 符号（衬线斜体）；g = 节内分组（组间画点线，同信息栏 .rdk-hr）
export const SAT_SECS = [
  { k: 'id', zh: '标识', en: 'Identity', f: [
    { k: 'norad', zh: 'NORAD', en: 'NORAD' }, { k: 'kind', zh: '区制', en: 'Regime' },
    { k: 'group', zh: '卫星组', en: 'Group' }, { k: 'slot', zh: '定点', en: 'Slot' }] },
  { k: 'live', zh: '实时状态', en: 'Live Status', f: [
    { k: 'lat', zh: '纬度', en: 'Latitude', s: 'φ' }, { k: 'lon', zh: '经度', en: 'Longitude', s: 'λ' },
    { k: 'alt', zh: '轨道高度', en: 'Orbital Altitude', s: 'h' },
    { k: 'vg', zh: '对地速度', en: 'Ground Speed' }, { k: 'vi', zh: '惯性速度', en: 'Inertial Speed' },
    { k: 'trk', zh: '轨迹周期', en: 'Track Span' }] },
  { k: 'el', zh: '轨道根数（开普勒）', en: 'Orbital Elements (Keplerian)', f: [
    { k: 'a', zh: '半长轴', en: 'Semi-major Axis', s: 'a' }, { k: 'e', zh: '偏心率', en: 'Eccentricity', s: 'e' },
    { k: 'i', zh: '轨道倾角', en: 'Inclination', s: 'i' }, { k: 'raan', zh: '升交点赤经', en: 'RAAN', s: 'Ω' },
    { k: 'argp', zh: '近地点幅角', en: 'Argument of Perigee', s: 'ω' }, { k: 'ma', zh: '平近点角', en: 'Mean Anomaly', s: 'M' },
    { k: 'n', zh: '平均运动', en: 'Mean Motion', s: 'n', g: 2 }, { k: 'T', zh: '轨道周期', en: 'Orbital Period', s: 'T', g: 2 },
    { k: 'hp', zh: '近地点高度', en: 'Perigee Altitude', g: 2 }, { k: 'ha', zh: '远地点高度', en: 'Apogee Altitude', g: 2 },
    { k: 'ep', zh: '历元', en: 'Epoch', g: 3 }, { k: 'age', zh: '历元龄', en: 'Epoch Age', g: 3 }] },
  { k: 'ant', zh: '天线', en: 'Antenna', f: [{ k: 'ant', zh: '天线', en: 'Antenna' }] },
  { k: 'mdl', zh: '模型', en: 'Model', f: [
    { k: 'mName', zh: '名称', en: 'Name' }, { k: 'mDims', zh: '尺寸', en: 'Size' }, { k: 'mMass', zh: '质量', en: 'Mass' }] }
]
const FIELD = Object.fromEntries(SAT_SECS.flatMap((s) => s.f.map((f) => [f.k, f])))
/** 出厂勾选：身份徽标 + 星下点 + 高度（与改版前的三行同一份信息），其余默认关 */
export const SAT_FIELD_ON = { norad: true, kind: true, group: true, slot: true, lat: true, lon: true, alt: true }
export function satFieldDefaults() {
  const o = {}
  for (const s of SAT_SECS) for (const f of s.f) o[f.k] = !!SAT_FIELD_ON[f.k]
  return o
}
const ANT_MAX = 12   // 天线节最多列几行，再多给一行「+N」

// —— 读数格式 ——
export function fmtStamp(ms, tz, withDate = true) {
  if (!Number.isFinite(ms)) return '—'
  const q = tzParts(ms, tz)
  const tm = `${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`
  return (withDate ? `${q.y}-${p2(q.mo)}-${p2(q.d)} ` : '') + tm + ' ' + tzTag(tz, ms)
}
export function fmtElapsed(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return 'T+' + (d ? d + 'd ' : '') + `${p2(h)}:${p2(m)}:${p2(r)}`
}
export const fmtLat = (v) => (Number.isFinite(v) ? Math.abs(v).toFixed(2) + '°' + (v >= 0 ? 'N' : 'S') : '—')
export const fmtLon = (v) => (Number.isFinite(v) ? Math.abs(v).toFixed(2) + '°' + (v >= 0 ? 'E' : 'W') : '—')
const fx = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—')
function fmtSpeedX(x) {
  const v = Number(x) || 0
  return '×' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100))
}

// 一颗星 → 卡片：{ name, badges, secs:[{ title, rows }], heads }。
// 行：{ k 标签（串或分段）, kt 标签角标, s 符号, v 数值（串或分段）, u 单位, tv / tu 定宽模板, span 数值跨符号列, hr 点线 }
//   分段 = [{ t, f }]，f 为真的段按单位样式画（小一号、浅色），同信息栏 .rdk-v i。
//   tv / tu：逐帧在变的读数按模板定宽（经度 99.99 → 100.00、°N → °S），版块宽度不随数字跳。
function satCard(s, F, heads, tz, T) {
  const L = (k) => T(FIELD[k].zh, FIELD[k].en)
  const on = (k) => !!F[k]
  const badges = []
  if (on('norad') && s.norad) badges.push({ k: 'NORAD', v: s.norad })
  if (on('kind') && s.kind) badges.push({ v: s.kind, tone: 'kind' })
  if (on('group') && s.group && s.group !== s.kind) badges.push({ v: T(s.group, s.groupEn || s.group) })
  if (on('slot') && s.slot) badges.push({ k: T('定点', 'Slot'), v: s.slot, tone: 'geo' })
  const row = (k, v, o) => ({ k: L(k), s: FIELD[k].s || '', v, ...(o || {}) })
  const secs = []
  // 实时状态
  const live = []
  if (on('lat') && Number.isFinite(s.lat)) live.push(row('lat', Math.abs(s.lat).toFixed(2), { u: s.lat < 0 ? '°S' : '°N', tv: '00.00', tu: ['°N', '°S'] }))
  if (on('lon') && Number.isFinite(s.lon)) live.push(row('lon', Math.abs(s.lon).toFixed(2), { u: s.lon < 0 ? '°W' : '°E', tv: '000.00', tu: ['°E', '°W'] }))
  if (on('alt') && s.alt) live.push(row('alt', s.alt, { u: 'km', tv: '00000' }))
  if (on('vg') && s.vg) live.push(row('vg', s.vg, { u: 'km/s', tv: '00.000' }))
  if (on('vi') && s.vi) live.push(row('vi', s.vi, { u: 'km/s', tv: '00.000' }))
  if (on('trk') && s.trk) live.push(row('trk', [{ t: String(s.trk.rev) }, { t: T('圈', 'rev'), f: 1 }, { t: '· ' + s.trk.v }], { u: s.trk.u }))
  if (live.length) secs.push({ title: T('实时状态', 'Live Status'), rows: live })
  // 轨道根数：经典六根数 ┆ 派生量 ┆ 历元
  const g1 = [], g2 = [], g3 = []
  if (on('a') && s.a) g1.push(row('a', s.a, { u: 'km' }))
  if (on('e') && s.e) g1.push(row('e', s.e))
  if (on('i') && s.i) g1.push(row('i', s.i, { u: '°' }))
  if (on('raan') && s.raan) g1.push(row('raan', s.raan, { u: '°' }))
  if (on('argp') && s.argp) g1.push(row('argp', s.argp, { u: '°' }))
  if (on('ma') && s.ma) g1.push(row('ma', s.ma, { u: '°' }))
  if (on('n') && s.n) g2.push(row('n', s.n, { u: T('圈/日', 'rev/day') }))
  if (on('T') && s.T) g2.push(row('T', s.T, { u: 'min' }))
  if (on('hp') && s.hp) g2.push(row('hp', s.hp, { u: 'km' }))
  if (on('ha') && s.ha) g2.push(row('ha', s.ha, { u: 'km' }))
  if (on('ep') && Number.isFinite(s.epochMs)) {
    const q = tzParts(s.epochMs, tz)
    g3.push({ k: L('ep'), kt: tzTag(tz, s.epochMs), v: `${q.y}-${p2(q.mo)}-${p2(q.d)} ${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`, span: true })
  }
  if (on('age') && s.age) g3.push(row('age', s.age, { u: 'd', tv: '000.00' }))
  const el = []
  for (const g of [g1, g2, g3]) { if (!g.length) continue; if (el.length) el.push({ hr: true }); el.push(...g) }
  if (el.length) secs.push({ title: T('轨道根数（开普勒）', 'Orbital Elements (Keplerian)'), rows: el })
  // 天线：名称（多节点时带所属星名）｜峰值增益
  if (on('ant') && s.ants && s.ants.length) {
    const rows = s.ants.slice(0, ANT_MAX).map((a) => ({ k: a.sat ? [{ t: a.name }, { t: a.sat, f: 1 }] : a.name, v: fx(a.peak, 2), u: 'dBi' }))
    if (s.ants.length > ANT_MAX) rows.push({ k: [{ t: '+' + (s.ants.length - ANT_MAX), f: 1 }], v: '' })
    secs.push({ title: T('天线', 'Antenna'), rows })
  }
  // 模型
  const m = s.model, mr = []
  if (m) {
    if (on('mName') && m.name) mr.push({ k: L('mName'), v: m.name, span: true })
    if (on('mDims') && m.dims) {
      const v = []
      String(m.dims).split(' × ').forEach((d, i) => { if (i) v.push({ t: '×', f: 1 }); v.push({ t: d }) })
      mr.push({ k: L('mDims'), v, u: 'm' })
    }
    if (on('mMass') && m.mass) mr.push({ k: L('mMass'), v: m.mass, u: 'kg' })
  }
  if (mr.length) secs.push({ title: T('模型', 'Model'), rows: mr })
  return { name: T(s.name || '', s.nameEn || s.name || ''), badges, secs, heads: heads !== false }
}

/**
 * 叠加设置 + 本帧数据 → 版块列表。T(zh, en) 出界面语言的名目。
 * spec.items[kind] = { on, pos, ... }；data 见 useVideoExport 的 hudData（只算开着的项）。
 * 版块：{ pos, kind, title?, rows: [[{ t, role, dim?, sw? }]], card?, image?, imgH? }
 *   role：'k' 名目（左齐、浅色） / 'v' 数值（右齐） / 'u' 单位 / 'n' 名称（左齐） / 'h' 表头（右齐、浅色）
 *   card：聚焦卫星卡片（见 satCard）
 */
export function buildHudBlocks(spec, data, T) {
  const it = (spec && spec.items) || {}
  const out = []
  const on = (k) => it[k] && it[k].on
  const pos = (k, d) => (HUD_POS.includes(it[k] && it[k].pos) ? it[k].pos : d)
  if (on('title') && (data.title || data.subtitle)) {
    out.push({ pos: pos('title', 'tl'), kind: 'title', rows: [], titleText: data.title || '', subText: data.subtitle || '' })
  }
  if (on('time') && Number.isFinite(data.tMs)) {
    const o = it.time
    const rows = [[{ t: fmtStamp(data.tMs, data.tz, o.date !== false), role: 'n', big: true }]]
    const extra = []
    if (o.elapsed && Number.isFinite(data.t0)) extra.push(fmtElapsed((data.tMs - data.t0) / 1000))
    if (o.speed && data.speed > 0) extra.push(fmtSpeedX(data.speed))
    if (extra.length) rows.push([{ t: extra.join('   '), role: 'k' }])
    out.push({ pos: pos('time', 'tr'), kind: 'time', rows })
  }
  if (on('sat') && data.sats && data.sats.length) {
    const o = it.sat
    const F = { ...satFieldDefaults(), ...(o.f || {}) }
    for (const s of data.sats) out.push({ pos: pos('sat', 'tl'), kind: 'sat', rows: [], card: satCard(s, F, o.heads, data.tz, T) })
  }
  if (on('aer') && data.aer && data.aer.rows && data.aer.rows.length) {
    const rows = [[{ t: '', role: 'n' }, { t: T('方位', 'Az'), role: 'h' }, { t: T('仰角', 'El'), role: 'h' }, { t: T('斜距', 'Range'), role: 'h' }]]
    for (const r of data.aer.rows) {
      const dim = Number.isFinite(r.el) && r.el < 0
      rows.push([{ t: r.name, role: 'n', dim }, { t: fx(r.az, 1) + '°', role: 'v', dim }, { t: fx(r.el, 1) + '°', role: 'v', dim }, { t: fx(r.rangeKm, 0) + ' km', role: 'v', dim }])
    }
    out.push({ pos: pos('aer', 'bl'), kind: 'aer', title: (data.aer.sat ? T('地球站 → ', 'Stations → ') + data.aer.sat : T('地球站', 'Stations')), rows })
  }
  if (on('field') && data.field && data.field.rows && data.field.rows.length) {
    const u = data.field.unit || ''
    const rows = data.field.rows.map((r) => [{ t: r.name, role: 'n' }, { t: fx(r.value, 2), role: 'v', dim: !Number.isFinite(r.value) }, { t: u, role: 'u' }])
    out.push({ pos: pos('field', 'bl'), kind: 'field', title: data.field.title || T('场强', 'Field strength'), rows })
  }
  if (on('legend') && data.legend && data.legend.levels && data.legend.levels.length) {
    const rows = data.legend.levels.map((L) => [{ t: '', role: 'sw', sw: L.color }, { t: L.label, role: 'n' }])
    out.push({ pos: pos('legend', 'br'), kind: 'legend', title: data.legend.title || '', rows })
  }
  if (on('logo') && data.logo) out.push({ pos: pos('logo', 'tr'), kind: 'logo', rows: [], image: data.logo, imgH: Math.max(0.5, Number(it.logo.h) || 2.2) })
  return out
}

// —— 绘制 ——
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
function ellipsize(ctx, s, maxW) {
  if (ctx.measureText(s).width <= maxW) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1 }
  return s.slice(0, lo) + '…'
}

// 绘制上下文的小工具：字体串、套边字（无底板时）、发丝线、墨色表
function makePen(ctx, fs, st) {
  const fam = st.fontStack || (st.font === 'doc' ? DOC_FONT : UI_FONT)   // fontStack：宿主按界面实际字体栈（--font-ui）给
  const bare = !st.panel
  const pal = bare ? PAL_BARE : PAL_PANEL
  // 无底板整版 600（同地名注记）：常规字重的笔画只有一两个像素，外勾一圈套边后白色字面比套边还窄，读成空心字
  const font = (scale, o) => `${o && o.italic ? 'italic ' : ''}${(o && o.bold) || bare ? '600 ' : ''}${(fs * scale).toFixed(2)}px ${(o && o.fam) || fam}`
  const lw = Math.max(1, Math.round(fs / 21.6))
  function text(s, x, y, color, align, px, halo = bare) {
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic'
    if (halo) {
      // 套边：实心深色、字号的 16%（字外沿约 0.08 em）、圆角接头 —— 平面图地名同一体例；不加投影
      ctx.lineJoin = 'round'; ctx.miterLimit = 2
      ctx.lineWidth = Math.max(1.2, px * 0.16); ctx.strokeStyle = CASING
      ctx.strokeText(s, x, y)
    }
    ctx.fillStyle = color; ctx.fillText(s, x, y)
  }
  // 水平发丝线（实线 / 点线）；无底板时先垫一道实心深色宽线（同套边）
  function hline(x0, x1, y, color, dotted) {
    const yy = Math.round(y) + (lw % 2 ? 0.5 : 0)
    ctx.save()
    ctx.lineCap = 'butt'
    if (bare) {
      ctx.strokeStyle = CASING; ctx.lineWidth = lw * 3; ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke()
    }
    ctx.strokeStyle = color; ctx.lineWidth = lw
    ctx.setLineDash(dotted ? [lw, lw * 2.6] : [])
    ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke()
    ctx.restore()
  }
  return { fam, font, text, hline, lw, pal }
}

// 量一个版块：返回 { w, h, draw(x, y) }。fs = 基准字号
function layoutBlock(ctx, b, fs, st, maxW, pen) {
  const pad = st.panel ? fs * 0.6 : fs * 0.15, padX = st.panel ? fs * 0.75 : fs * 0.15
  const lh = fs * 1.34
  const setF = (scale, bold) => { ctx.font = pen.font(scale, { bold }) }
  if (b.kind === 'logo') {
    const img = b.image, ih = fs * b.imgH, iw = img && img.height ? ih * img.width / img.height : ih
    return { w: iw + pad * 2, h: ih + pad * 2, draw(x, y) { if (img) ctx.drawImage(img, x + pad, y + pad, iw, ih) }, logo: true }
  }
  if (b.kind === 'sat' && b.card) return layoutCard(ctx, b.card, fs, st, maxW, pen)
  if (b.kind === 'title') {
    setF(1.55, true); const w1 = b.titleText ? ctx.measureText(b.titleText).width : 0
    setF(1.0, false); const w2 = b.subText ? ctx.measureText(b.subText).width : 0
    const h = (b.titleText ? fs * 1.95 : 0) + (b.subText ? lh : 0)
    const w = Math.min(maxW, Math.max(w1, w2)) + padX * 2
    return {
      w, h: h + pad * 2,
      draw(x, y) {
        let yy = y + pad
        if (b.titleText) { setF(1.55, true); pen.text(ellipsize(ctx, b.titleText, maxW), x + padX, yy + fs * 1.55 * 0.92, pen.pal.ink, 'left', fs * 1.55); yy += fs * 1.95 }
        if (b.subText) { setF(1.0, false); pen.text(ellipsize(ctx, b.subText, maxW), x + padX, yy + fs * 0.98, pen.pal.k, 'left', fs) }
      }
    }
  }
  // 表格类（时间 / 站星几何 / 场强 / 图例）
  const rows = b.rows || []
  const ncol = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const colW = new Array(ncol).fill(0)
  const big = (c) => c.big ? 1.3 : 1
  for (const r of rows) {
    r.forEach((c, i) => {
      if (c.role === 'sw') { colW[i] = Math.max(colW[i], fs * 1.6); return }
      setF(big(c), c.big)
      colW[i] = Math.max(colW[i], Math.min(maxW * 0.6, ctx.measureText(c.t || '').width))
    })
  }
  const cgap = fs * 0.7
  let tw = 0
  if (b.title) { setF(0.92, true); tw = ctx.measureText(b.title).width }
  const bodyW = colW.reduce((a, v, i) => a + v + (i && v ? cgap : 0), 0)
  const innerW = Math.min(maxW - padX * 2, Math.max(bodyW, tw))
  const rowH = rows.map((r) => (r.some((c) => c.big) ? fs * 1.62 : lh))
  const th = b.title ? fs * 1.36 : 0
  const h = pad * 2 + th + rowH.reduce((a, v) => a + v, 0)
  return {
    w: innerW + padX * 2, h,
    draw(x, y) {
      let yy = y + pad
      if (b.title) { setF(0.92, true); pen.text(ellipsize(ctx, b.title, innerW), x + padX, yy + fs * 0.95, pen.pal.k, 'left', fs * 0.92); yy += th }
      rows.forEach((r, ri) => {
        const base = yy + rowH[ri] * 0.74
        let cx = x + padX
        r.forEach((c, i) => {
          const w = colW[i]
          if (c.role === 'sw') {
            const sh = fs * 0.72
            ctx.fillStyle = c.sw || '#888'; ctx.fillRect(cx, yy + (rowH[ri] - sh) / 2, w - fs * 0.35, sh)
            ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = Math.max(1, fs * 0.05); ctx.strokeRect(cx, yy + (rowH[ri] - sh) / 2, w - fs * 0.35, sh)
          } else if (c.t) {
            setF(big(c), c.big)
            const col = c.dim ? pen.pal.dim : (c.role === 'k' || c.role === 'h' || c.role === 'u') ? pen.pal.k : pen.pal.ink
            const right = c.role === 'v' || c.role === 'h'
            const s = ellipsize(ctx, c.t, Math.max(w, fs))
            pen.text(s, right ? cx + w : cx, base, col, right ? 'right' : 'left', fs * big(c))
          }
          cx += w + (w ? cgap : 0)
        })
        yy += rowH[ri]
      })
    }
  }
}

// —— 聚焦卫星卡片（右侧信息栏的成片版）——
// 比例（× 基准字号）：星名 1.3 衬线｜徽标 0.74｜节标题 0.84 半粗｜标签 / 数值 1.0｜符号 1.14 衬线斜体｜单位 0.8
const C = { name: 1.3, bdg: 0.74, head: 0.84, body: 1, sym: 1.14, unit: 0.8 }
function layoutCard(ctx, card, fs, st, maxW, pen) {
  const pad = st.panel ? fs * 0.62 : fs * 0.15, padX = st.panel ? fs * 0.8 : fs * 0.15
  const F = {
    name: pen.font(C.name, { fam: DOC_FONT }), bdg: pen.font(C.bdg), bdgK: pen.font(C.bdg), head: pen.font(C.head, { bold: true }),
    k: pen.font(C.body), sym: pen.font(C.sym, { italic: true, fam: SYM_FONT }), v: pen.font(C.body), u: pen.font(C.unit)
  }
  const W = (font, s) => { ctx.font = font; return ctx.measureText(s).width }
  const runGap = fs * 0.22
  const runsOf = (x) => (Array.isArray(x) ? x : [{ t: x == null ? '' : String(x) }])
  const runsW = (x, main) => runsOf(x).reduce((a, r, i) => a + W(r.f ? F.u : main, r.t) + (i ? runGap : 0), 0)
  const tplW = (tp, font) => (tp == null ? 0 : (Array.isArray(tp) ? tp : [tp]).reduce((m, s) => Math.max(m, W(font, s)), 0))
  const cap = maxW - padX * 2
  // 列宽：标签｜符号｜数值｜单位（全卡各节共用一套，数值右沿跨节对齐）
  const rows = card.secs.flatMap((s) => s.rows)
  let colK = 0, colS = 0, colV = 0, colU = 0
  for (const r of rows) {
    if (r.hr) continue
    colK = Math.max(colK, runsW(r.k, F.k) + (r.kt ? fs * 0.35 + W(F.u, r.kt) : 0))
    if (r.s) colS = Math.max(colS, W(F.sym, r.s))
    if (!r.span) colV = Math.max(colV, runsW(r.v, F.v), tplW(r.tv, F.v))
    if (r.u) colU = Math.max(colU, W(F.u, r.u), tplW(r.tu, F.u))
  }
  colK = Math.min(colK, cap * 0.55)
  const gKS = colS ? fs * 0.6 : 0, gSV = fs * 0.9, gVU = colU ? fs * 0.32 : 0
  // 跨列数值（历元、模型名）：占符号列 + 数值列，不够再把数值列撑宽（撑到卡片上限为止，再长的模型名截断）
  let spanNeed = 0
  for (const r of rows) if (!r.hr && r.span) spanNeed = Math.max(spanNeed, runsW(r.v, F.v) + fs * 0.6 - (gKS + colS + gSV + colV))
  if (spanNeed > 0) colV += Math.min(spanNeed, Math.max(0, cap - (colK + gKS + colS + gSV + colV + gVU + colU)))
  const tableW = rows.length ? colK + gKS + colS + gSV + colV + gVU + colU : 0
  // 标识区：星名 + 徽标（徽标超宽就折行）
  const bdgPadX = fs * C.bdg * 0.45, bdgGap = fs * C.bdg * 0.42, bdgH = fs * C.bdg * 1.5, bdgKG = fs * C.bdg * 0.38
  const bw = card.badges.map((b) => (b.k ? W(F.bdgK, b.k) + bdgKG : 0) + W(F.bdg, b.v) + bdgPadX * 2)
  const nameW = card.name ? W(F.name, card.name) : 0
  const headW = card.heads ? card.secs.reduce((m, s) => Math.max(m, W(F.head, s.title)), 0) : 0
  const bdgW1 = bw.reduce((a, v, i) => a + v + (i ? bdgGap : 0), 0)
  const innerW = Math.min(cap, Math.max(tableW, nameW, bdgW1, headW, fs * 4))
  if (tableW && innerW > tableW) colV += innerW - tableW           // 数值列吃掉多余宽度：右沿贴卡片右缘（同信息栏 1fr）
  const lines = []                                                // 徽标按行
  let cur = [], cw = 0
  card.badges.forEach((b, i) => {
    const w = Math.min(bw[i], innerW)
    if (cur.length && cw + bdgGap + w > innerW) { lines.push(cur); cur = []; cw = 0 }
    cur.push({ b, w }); cw += (cw ? bdgGap : 0) + w
  })
  if (cur.length) lines.push(cur)
  // 竖向节奏
  const nameH = card.name ? fs * 1.62 : 0
  const bdgBlockH = lines.length ? lines.length * bdgH + (lines.length - 1) * fs * 0.3 + (nameH ? fs * 0.22 : 0) : 0
  const idH = nameH + bdgBlockH
  const rowH = fs * 1.42, hrH = fs * 0.62, headH = fs * 1.5
  const ruleGapA = fs * 0.5, ruleGapB = card.heads ? fs * 0.18 : fs * 0.32
  let bodyH = 0
  card.secs.forEach((sec, si) => {
    if (si || idH) bodyH += ruleGapA + ruleGapB
    if (card.heads) bodyH += headH
    for (const r of sec.rows) bodyH += r.hr ? hrH : rowH
  })
  const h = pad * 2 + idH + bodyH
  return {
    w: innerW + padX * 2, h,
    draw(x0, y0) {
      const x = x0 + padX, xR = x + innerW
      let y = y0 + pad
      if (card.name) {
        ctx.font = F.name
        pen.text(ellipsize(ctx, card.name, innerW), x, y + fs * C.name * 0.98, pen.pal.ink, 'left', fs * C.name)
        y += nameH
      }
      if (lines.length) {
        if (nameH) y += fs * 0.22
        lines.forEach((ln, li) => {
          let bx = x
          for (const { b, w } of ln) {
            const geo = b.tone === 'geo'
            if (!st.panel) { ctx.fillStyle = 'rgba(10,14,20,0.5)'; ctx.fillRect(bx, y, w, bdgH) }
            ctx.strokeStyle = geo ? WARN_B : b.tone === 'kind' ? BDG_KIND : BDG_B
            ctx.lineWidth = pen.lw
            const o = pen.lw % 2 ? 0.5 : 0
            ctx.strokeRect(Math.round(bx) + o, Math.round(y) + o, Math.round(w) - pen.lw, Math.round(bdgH) - pen.lw)
            const base = y + bdgH * 0.5 + fs * C.bdg * 0.36
            let tx = bx + bdgPadX
            ctx.save(); ctx.beginPath(); ctx.rect(bx, y, w, bdgH); ctx.clip()
            if (b.k) { ctx.font = F.bdgK; pen.text(b.k, tx, base, geo ? WARN_K : pen.pal.f, 'left', fs * C.bdg, false); tx += W(F.bdgK, b.k) + bdgKG }
            ctx.font = F.bdg; pen.text(b.v, tx, base, geo ? WARN : pen.pal.ink, 'left', fs * C.bdg, false)
            ctx.restore()
            bx += w + bdgGap
          }
          y += bdgH + (li < lines.length - 1 ? fs * 0.3 : 0)
        })
      }
      const xS = x + colK + gKS, xV = xS + colS + gSV + colV, xU = xV + gVU
      card.secs.forEach((sec, si) => {
        if (si || idH) {
          y += ruleGapA
          pen.hline(x, xR, y, RULE, false)
          y += ruleGapB
        }
        if (card.heads) {
          ctx.font = F.head
          pen.text(ellipsize(ctx, sec.title, innerW), x, y + headH * 0.68, pen.pal.h, 'left', fs * C.head)
          y += headH
        }
        for (const r of sec.rows) {
          if (r.hr) { pen.hline(x, xR, y + hrH / 2, RULE_DOT, true); y += hrH; continue }
          const base = y + rowH * 0.72
          // 标签（+ 角标）
          let kx = x
          const kRuns = runsOf(r.k)
          kRuns.forEach((q, i) => {
            ctx.font = q.f ? F.u : F.k
            const s = ellipsize(ctx, q.t, Math.max(fs, x + colK - kx))
            pen.text(s, kx, base, q.f ? pen.pal.f : pen.pal.k, 'left', fs * (q.f ? C.unit : C.body))
            kx += ctx.measureText(s).width + runGap
          })
          if (r.kt) { ctx.font = F.u; pen.text(r.kt, kx - runGap + fs * 0.35, base, pen.pal.f, 'left', fs * C.unit) }
          // 符号
          if (r.s) { ctx.font = F.sym; pen.text(r.s, xS, base, pen.pal.ink, 'left', fs * C.sym) }
          // 数值：右齐到数值列右沿；分段从右往左排
          const vr = runsOf(r.v)
          const vMax = r.span ? xV - (x + colK + fs * 0.6) : colV
          let total = runsW(vr, F.v)
          if (vr.length === 1 && total > vMax) {
            ctx.font = F.v
            const s = ellipsize(ctx, vr[0].t, vMax)
            pen.text(s, xV, base, pen.pal.ink, 'right', fs)
          } else {
            let vx = xV - total
            vr.forEach((q) => {
              ctx.font = q.f ? F.u : F.v
              pen.text(q.t, vx, base, q.f ? pen.pal.f : pen.pal.ink, 'left', fs * (q.f ? C.unit : C.body))
              vx += ctx.measureText(q.t).width + runGap
            })
          }
          if (r.u) { ctx.font = F.u; pen.text(r.u, xU, base, pen.pal.f, 'left', fs * C.unit) }
          y += rowH
        }
      })
    }
  }
}

/**
 * 把版块画进 ctx（坐标系 = 成片像素 W × H，调用方已置好变换）。
 * st = { size, panel, opacity, font, fontStack }；area = 版块可用的矩形（缺省整幅；开了经纬图框时是图框内区）。
 * 返回各锚位占用的矩形（单测 / 预览命中用）
 */
export function drawHud(ctx, W, H, blocks, st, area) {
  const style = { size: 1, panel: false, opacity: 0.62, font: 'ui', ...(st || {}) }
  const A = area && area.w > 0 && area.h > 0 ? area : { x: 0, y: 0, w: W, h: H }
  const fs = hudFontPx(H, style.size)
  const m = area ? Math.round(fs * 0.7) : Math.round(H * 0.028), gap = fs * 0.55, maxW = A.w * 0.46
  const boxes = []
  ctx.save()
  // 名目已按界面语言出好；站名 / 星名是用户数据，不许被 DOM 呈现层的 canvas 补丁「翻译」。
  // ★ 只在画 HUD 这一段打标、画完复原：2D 出帧时同一个上下文先画地图，地图注记要照屏上那样走翻译
  const skip0 = ctx.__i18nSkip
  ctx.__i18nSkip = true
  const pen = makePen(ctx, fs, style)
  const groups = {}
  for (const b of blocks) (groups[b.pos] = groups[b.pos] || []).push(b)
  const avail = A.h - m * 2
  for (const p of HUD_POS) {
    const list = groups[p]; if (!list || !list.length) continue
    const L = list.map((b) => layoutBlock(ctx, b, fs, style, maxW, pen))
    // 分列：自上而下（列表顺序）塞进一列，放不下另起一列
    const cols = []
    let col = null
    for (const lb of L) {
      if (!col || (col.items.length && col.h + gap + lb.h > avail)) { col = { items: [], w: 0, h: 0 }; cols.push(col) }
      col.h += (col.items.length ? gap : 0) + lb.h; col.w = Math.max(col.w, lb.w); col.items.push(lb)
    }
    const totalW = cols.reduce((a, c, i) => a + c.w + (i ? gap : 0), 0)
    const bottom = p[0] === 'b', hz = p[1]
    let cx = hz === 'l' ? A.x + m : hz === 'r' ? A.x + A.w - m : A.x + (A.w - totalW) / 2
    for (const c of cols) {
      const colX = hz === 'r' ? cx - c.w : cx
      let y = bottom ? A.y + A.h - m - c.h : A.y + m
      for (const lb of c.items) {
        const bx = hz === 'l' ? colX : hz === 'r' ? colX + c.w - lb.w : colX + (c.w - lb.w) / 2
        if (style.panel && !lb.logo) {
          ctx.fillStyle = `rgba(12,16,22,${Math.max(0, Math.min(1, style.opacity))})`
          rrect(ctx, bx, y, lb.w, lb.h, fs * 0.38); ctx.fill()
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = Math.max(1, H / 1080); ctx.stroke()
        }
        lb.draw(bx, y)
        boxes.push({ pos: p, x: bx, y, w: lb.w, h: lb.h })
        y += lb.h + gap
      }
      cx = hz === 'r' ? colX - gap : colX + c.w + gap
    }
  }
  ctx.__i18nSkip = skip0
  ctx.restore()
  return boxes
}

/** 时间进度条：贴底一条细线（整幅宽，开了经纬图框时贴图框内区的底），frac ∈ [0, 1] */
export function drawProgress(ctx, W, H, frac, area) {
  const A = area && area.w > 0 && area.h > 0 ? area : { x: 0, y: 0, w: W, h: H }
  const h = Math.max(2, Math.round(H * 0.006))
  ctx.save()
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(A.x, A.y + A.h - h, A.w, h)
  ctx.fillStyle = 'rgba(77,163,255,0.95)'; ctx.fillRect(A.x, A.y + A.h - h, A.w * Math.max(0, Math.min(1, frac)), h)
  ctx.restore()
}
