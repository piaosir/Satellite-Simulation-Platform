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

/**
 * 叠加信息的基准高度：min(H, W × 9/16)。16:9 及更宽的画面就是 H（与改前一位不差）；方形 / 竖屏按宽折算 ——
 * 字号与画面宽之比同 16:9，字不会比画面还宽（原来竖屏 1080×1920 的字是 16:9 的 1.8 倍高、画面却窄了一半）
 */
export const hudBaseH = (H, W) => (Number(W) > 0 ? Math.min(H, W * 0.5625) : H)
/** 成片里的基准字号（px）：基准高度的 2%，乘用户的「字号」系数（0.6～2）。W 不给 = 按高度（旧口径） */
export const hudFontPx = (H, size = 1, W) => Math.max(8, hudBaseH(H, W) * 0.02 * Math.min(2, Math.max(0.6, Number(size) || 1)))
/** 版块放不下时缩字号的下限（相对设定字号）：再小就宁可截断 */
export const HUD_FIT_MIN = 0.5

// —— 聚焦卫星：字段目录（与右侧「卫星信息栏」同名、同序、同符号）。面板的勾选项与成片版块共用这一份 ——
//   s = 符号（衬线斜体；「e_x」写法 = e 带下标 x，同信息栏 <sub>）；g = 节内分组（组间画点线，同信息栏 .rdk-hr）
//   「位置 / 速度 / 偏心率矢量 / 倾角矢量」一项出三行（x y z、ẋ ẏ ż、e eₓ e_y、i iₓ i_y），面板上的符号列照写三个
//   相对状态是一对星之间的量，不进单星卡片
export const SAT_SECS = [
  { k: 'id', zh: '标识', en: 'Identity', f: [
    { k: 'norad', zh: 'NORAD', en: 'NORAD' }, { k: 'kind', zh: '区制', en: 'Regime' },
    { k: 'group', zh: '卫星组', en: 'Group' }, { k: 'slot', zh: '定点', en: 'Slot' }] },
  { k: 'live', zh: '实时状态', en: 'Live Status', f: [
    { k: 'lat', zh: '纬度', en: 'Latitude', s: 'φ' }, { k: 'lon', zh: '经度', en: 'Longitude', s: 'λ' },
    { k: 'alt', zh: '轨道高度', en: 'Orbital Altitude', s: 'h' },
    { k: 'vg', zh: '对地速度', en: 'Ground Speed' }, { k: 'vi', zh: '惯性速度', en: 'Inertial Speed' },
    { k: 'trk', zh: '轨迹周期', en: 'Track Span' }] },
  { k: 'sv', zh: '状态矢量', en: 'State Vector', f: [
    { k: 'svPos', zh: '位置矢量', en: 'Position', s: 'x y z' }, { k: 'svVel', zh: '速度矢量', en: 'Velocity', s: 'ẋ ẏ ż' },
    { k: 'svR', zh: '地心距', en: 'Geocentric Distance', s: 'r', g: 2 }] },
  { k: 'osc', zh: '密切根数', en: 'Osculating Elements', f: [
    { k: 'oa', zh: '半长轴', en: 'Semi-major Axis', s: 'a' }, { k: 'oe', zh: '偏心率', en: 'Eccentricity', s: 'e' },
    { k: 'oi', zh: '轨道倾角', en: 'Inclination', s: 'i' }, { k: 'oraan', zh: '升交点赤经', en: 'RAAN', s: 'Ω' },
    { k: 'oargp', zh: '近地点幅角', en: 'Argument of Perigee', s: 'ω' }, { k: 'onu', zh: '真近点角', en: 'True Anomaly', s: 'ν' },
    { k: 'ou', zh: '纬度幅角', en: 'Argument of Latitude', s: 'u', g: 2 }, { k: 'oM', zh: '平近点角', en: 'Mean Anomaly', s: 'M', g: 2 }] },
  { k: 'geo', zh: '同步轨道', en: 'Geosynchronous Orbit', f: [
    { k: 'gLon', zh: '平经度', en: 'Mean Longitude', s: 'λ̄' }, { k: 'gDlon', zh: '经度偏差', en: 'Longitude Offset', s: 'Δλ' },
    { k: 'gD', zh: '漂移率', en: 'Drift Rate', s: 'D' },
    { k: 'gEv', zh: '偏心率矢量', en: 'Eccentricity Vector', s: 'e e_x e_y', g: 2 }, { k: 'gIv', zh: '倾角矢量', en: 'Inclination Vector', s: 'i i_x i_y', g: 3 }] },
  { k: 'el', zh: '星历', en: 'Ephemeris', f: [
    { k: 'prop', zh: '传播模型', en: 'Propagator' },
    { k: 'ep', zh: '历元', en: 'Epoch', g: 2 }, { k: 'age', zh: '历元龄', en: 'Epoch Age', g: 2 },
    { k: 'n', zh: '平均运动', en: 'Mean Motion', s: 'n', g: 3 }, { k: 'e', zh: '偏心率', en: 'Eccentricity', s: 'e', g: 3 },
    { k: 'i', zh: '轨道倾角', en: 'Inclination', s: 'i', g: 3 }, { k: 'raan', zh: '升交点赤经', en: 'RAAN', s: 'Ω', g: 3 },
    { k: 'argp', zh: '近地点幅角', en: 'Argument of Perigee', s: 'ω', g: 3 }, { k: 'ma', zh: '平近点角', en: 'Mean Anomaly', s: 'M', g: 3 },
    { k: 'bstar', zh: '阻力项', en: 'Drag Term', s: 'B*', g: 3 },
    { k: 'a', zh: '半长轴', en: 'Semi-major Axis', s: 'a', g: 4 }, { k: 'T', zh: '轨道周期', en: 'Orbital Period', s: 'T', g: 4 },
    { k: 'hp', zh: '近地点高度', en: 'Perigee Altitude', g: 4 }, { k: 'ha', zh: '远地点高度', en: 'Apogee Altitude', g: 4 }] },
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
  const groups = (gs) => { const out = []; for (const g of gs) { if (!g.length) continue; if (out.length) out.push({ hr: true }); out.push(...g) } return out }
  // 状态矢量 / 密切根数：参考系同信息栏（satReadout），写进节名；节名关着时挂在首行标签的角标上
  const frameSec = (rows, zh, en, fl) => {
    if (!rows.length) return
    const first = rows.find((r) => !r.hr)
    if (heads === false && first && fl) first.kt = fl
    secs.push({ title: T(zh, en) + (fl ? ' · ' + fl : ''), rows })
  }
  const sv = s.sv
  if (sv) {
    const g1 = [], g2 = []
    const tri = (k, vs, syms, u, tv) => vs.forEach((v, j) => g1.push(j ? { k: '', s: syms[j], v, u, tv } : row(k, v, { s: syms[0], u, tv })))
    if (on('svPos')) tri('svPos', [sv.x, sv.y, sv.z], ['x', 'y', 'z'], 'km', '-00000.000')
    if (on('svVel')) tri('svVel', [sv.vx, sv.vy, sv.vz], ['ẋ', 'ẏ', 'ż'], 'km/s', '-0.000000')
    if (on('svR') && sv.r) g2.push(row('svR', sv.r, { u: 'km', tv: '00000.000' }))
    frameSec(groups([g1, g2]), '状态矢量', 'State Vector', sv.frameLabel)
  }
  const osc = s.osc
  if (osc) {
    const g1 = [], g2 = []
    const A = { u: '°', tv: '000.0000' }
    if (on('oa') && osc.a) g1.push(row('oa', osc.a, { u: 'km', tv: '00000.000' }))
    if (on('oe') && osc.e) g1.push(row('oe', osc.e, { tv: '0.0000000' }))
    if (on('oi') && osc.i) g1.push(row('oi', osc.i, A))
    if (on('oraan') && osc.raan) g1.push(row('oraan', osc.raan, A))
    if (on('oargp') && osc.argp) g1.push(row('oargp', osc.argp, A))
    if (on('onu') && osc.nu) g1.push(row('onu', osc.nu, A))
    // 近赤道没有纬度幅角：同信息栏改出真经度 l
    if (on('ou')) { if (osc.u) g2.push(row('ou', osc.u, A)); else if (osc.L) g2.push({ k: T('真经度', 'True Longitude'), s: 'l', v: osc.L, ...A }) }
    if (on('oM') && osc.M) g2.push(row('oM', osc.M, A))
    frameSec(groups([g1, g2]), '密切根数', 'Osculating Elements', osc.frameLabel)
  }
  // 同步轨道（GEO / IGSO）：平经度 Δλ D ┆ e eₓ e_y ┆ i iₓ i_y；越出保持范围的值着警示色（同信息栏 .rdk-v.out）
  const geo = s.geo
  if (geo) {
    const g1 = [], g2 = [], g3 = []
    if (on('gLon') && geo.lon) g1.push(row('gLon', geo.lon, { u: geo.lonH, tv: '000.0000', tu: ['°E', '°W'] }))
    if (on('gDlon') && geo.dlon) g1.push(row('gDlon', geo.dlon, { u: '°', tv: '-0.0000', tone: geo.ewOut ? 'warn' : '' }))
    if (on('gD') && geo.drift) g1.push(row('gD', geo.drift, { u: '°/d', tv: '-0.0000' }))
    if (on('gEv') && geo.e) g2.push({ k: T('偏心率', 'Eccentricity'), s: 'e', v: geo.e, tv: '0.0000000' }, { k: '', s: 'e_x', v: geo.ex, tv: '-0.0000000' }, { k: '', s: 'e_y', v: geo.ey, tv: '-0.0000000' })
    if (on('gIv') && geo.i) g3.push({ k: T('轨道倾角', 'Inclination'), s: 'i', v: geo.i, u: '°', tv: '00.0000', tone: geo.nsOut ? 'warn' : '' }, { k: '', s: 'i_x', v: geo.ix, u: '°', tv: '-00.0000' }, { k: '', s: 'i_y', v: geo.iy, u: '°', tv: '-00.0000' })
    const rows = groups([g1, g2, g3])
    if (rows.length) secs.push({ title: T('同步轨道', 'Geosynchronous Orbit'), rows })
  }
  // 星历：传播模型 ┆ 历元 历元龄 ┆ 平根数（n e i Ω ω M B*）┆ 派生量（a T 近 远）—— 同信息栏「星历」节
  const g0 = [], g1 = [], g2 = [], g3 = []
  if (on('prop') && s.prop) g0.push({ k: L('prop'), v: s.prop, span: true })
  if (on('ep') && Number.isFinite(s.epochMs)) {
    const q = tzParts(s.epochMs, tz)
    g1.push({ k: L('ep'), kt: tzTag(tz, s.epochMs), v: `${q.y}-${p2(q.mo)}-${p2(q.d)} ${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`, span: true })
  }
  if (on('age') && s.age) g1.push(row('age', s.age, { u: 'd', tv: '000.00' }))
  if (on('n') && s.n) g2.push(row('n', s.n, { u: T('圈/日', 'rev/day') }))
  if (on('e') && s.e) g2.push(row('e', s.e))
  if (on('i') && s.i) g2.push(row('i', s.i, { u: '°' }))
  if (on('raan') && s.raan) g2.push(row('raan', s.raan, { u: '°' }))
  if (on('argp') && s.argp) g2.push(row('argp', s.argp, { u: '°' }))
  if (on('ma') && s.ma) g2.push(row('ma', s.ma, { u: '°' }))
  if (on('bstar') && s.bstar) g2.push(row('bstar', s.bstar, { u: '1/R⊕' }))
  if (on('a') && s.a) g3.push(row('a', s.a, { u: 'km' }))
  if (on('T') && s.T) g3.push(row('T', s.T, { u: 'min' }))
  if (on('hp') && s.hp) g3.push(row('hp', s.hp, { u: 'km' }))
  if (on('ha') && s.ha) g3.push(row('ha', s.ha, { u: 'km' }))
  const el = groups([g0, g1, g2, g3])
  if (el.length) secs.push({ title: T('星历', 'Ephemeris'), rows: el })
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
      rows.push([{ t: r.name, role: 'n', dim }, { t: fx(r.az, 1) + '°', role: 'v', dim, tv: '000.0°' }, { t: fx(r.el, 1) + '°', role: 'v', dim, tv: '-00.0°' }, { t: fx(r.rangeKm, 0) + ' km', role: 'v', dim, tv: '00000 km' }])
    }
    out.push({ pos: pos('aer', 'bl'), kind: 'aer', title: (data.aer.sat ? T('地球站 → ', 'Stations → ') + data.aer.sat : T('地球站', 'Stations')), rows })
  }
  if (on('field') && data.field && data.field.rows && data.field.rows.length) {
    const u = data.field.unit || ''
    const rows = data.field.rows.map((r) => [{ t: r.name, role: 'n' }, { t: fx(r.value, 2), role: 'v', dim: !Number.isFinite(r.value), tv: '-000.00' }, { t: u, role: 'u' }])
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
  // 留半个像素：列宽恰好量到最宽那条时，「x + colK − kx」这类加减会比实测字宽少 1 ULP，最宽那条就被截成「轨道…」
  const lim = maxW + 0.5
  if (ctx.measureText(s).width <= lim) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, m) + '…').width <= lim) lo = m; else hi = m - 1 }
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

// 量一个版块：返回 { w, h, need, draw(x, y) }。fs = 基准字号；need = 一个字都不截所需的宽（与 maxW 比，大于它 drawHud 就缩字号）
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
      w, h: h + pad * 2, need: Math.max(w1, w2),   // 标题字面可用满 maxW（见下面 ellipsize）
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
  // 列宽三套：colN 实测最宽（放得下就用它，一个字都不截）；colC 旧口径（单列封顶 0.6·maxW —— 缩到下限仍放不下时兜底）；
  // colT 含定宽模板（逐帧在变的读数按最宽可能算 need，缩不缩字号不随数字跳）
  const colN = new Array(ncol).fill(0), colC = new Array(ncol).fill(0), colT = new Array(ncol).fill(0)
  const big = (c) => c.big ? 1.3 : 1
  for (const r of rows) {
    r.forEach((c, i) => {
      if (c.role === 'sw') { const sw = fs * 1.6; colN[i] = Math.max(colN[i], sw); colC[i] = Math.max(colC[i], sw); colT[i] = Math.max(colT[i], sw); return }
      setF(big(c), c.big)
      const cw = ctx.measureText(c.t || '').width
      colN[i] = Math.max(colN[i], cw)
      colC[i] = Math.max(colC[i], Math.min(maxW * 0.6, cw))
      colT[i] = Math.max(colT[i], cw, c.tv ? ctx.measureText(c.tv).width : 0)
    })
  }
  const cgap = fs * 0.7
  let tw = 0
  if (b.title) { setF(0.92, true); tw = ctx.measureText(b.title).width }
  const sumW = (cw) => cw.reduce((a, v, i) => a + v + (i && v ? cgap : 0), 0)
  const need = Math.max(sumW(colT), tw) + padX * 2
  const colW = need <= maxW ? colN : colC
  const bodyW = sumW(colW)
  const innerW = Math.min(maxW - padX * 2, Math.max(bodyW, tw))
  const rowH = rows.map((r) => (r.some((c) => c.big) ? fs * 1.62 : lh))
  const th = b.title ? fs * 1.36 : 0
  const h = pad * 2 + th + rowH.reduce((a, v) => a + v, 0)
  return {
    w: innerW + padX * 2, h, need,
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
  // 符号「e_x」= e 带下标 x（同信息栏 <sub>）：下标 0.68 号、基线下沉 0.24 em
  F.symSub = pen.font(C.sym * 0.68, { italic: true, fam: SYM_FONT })
  const symParts = (s) => { const i = s.indexOf('_'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''] }
  const symW = (s) => { const [b, sb] = symParts(s); return W(F.sym, b) + (sb ? fs * 0.04 + W(F.symSub, sb) : 0) }
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
    if (r.s) colS = Math.max(colS, symW(r.s))
    if (!r.span) colV = Math.max(colV, runsW(r.v, F.v), tplW(r.tv, F.v))
    if (r.u) colU = Math.max(colU, W(F.u, r.u), tplW(r.tu, F.u))
  }
  const gKS = colS ? fs * 0.6 : 0, gSV = fs * 0.9, gVU = colU ? fs * 0.32 : 0
  // 跨列数值（历元、模型名）：占符号列 + 数值列，不够再把数值列撑宽
  let spanNeed = 0
  for (const r of rows) if (!r.hr && r.span) spanNeed = Math.max(spanNeed, runsW(r.v, F.v) + fs * 0.6 - (gKS + colS + gSV + colV))
  // 标识区：星名 + 徽标（徽标超宽就折行）
  const bdgPadX = fs * C.bdg * 0.45, bdgGap = fs * C.bdg * 0.42, bdgH = fs * C.bdg * 1.5, bdgKG = fs * C.bdg * 0.38
  const bw = card.badges.map((b) => (b.k ? W(F.bdgK, b.k) + bdgKG : 0) + W(F.bdg, b.v) + bdgPadX * 2)
  const nameW = card.name ? W(F.name, card.name) : 0
  const headW = card.heads ? card.secs.reduce((m, s) => Math.max(m, W(F.head, s.title)), 0) : 0
  const bdgW1 = bw.reduce((a, v, i) => a + v + (i ? bdgGap : 0), 0)
  // need = 一个字都不截所需的卡片宽：标签列不封顶、跨列数值整条放下；星名、节名、最宽的一枚徽标（徽标会折行，不按一行算）
  const need = Math.max(rows.length ? colK + gKS + colS + gSV + colV + Math.max(0, spanNeed) + gVU + colU : 0, nameW, headW, bw.length ? Math.max(...bw) : 0) + padX * 2
  const fits = need <= maxW
  // 放得下：标签列按实测、跨列数值整条放下；缩到下限仍放不下：旧口径（标签列封顶 0.55、跨列撑到卡片上限为止，其余截断）
  if (!fits) colK = Math.min(colK, cap * 0.55)
  if (spanNeed > 0) colV += fits ? spanNeed : Math.min(spanNeed, Math.max(0, cap - (colK + gKS + colS + gSV + colV + gVU + colU)))
  const tableW = rows.length ? colK + gKS + colS + gSV + colV + gVU + colU : 0
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
    w: innerW + padX * 2, h, need,
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
            const s = ellipsize(ctx, q.t, Math.max(fs, colK - (kx - x)))   // 先减后加：首段恰为 colK，不吃浮点短缺
            pen.text(s, kx, base, q.f ? pen.pal.f : pen.pal.k, 'left', fs * (q.f ? C.unit : C.body))
            kx += ctx.measureText(s).width + runGap
          })
          if (r.kt) { ctx.font = F.u; pen.text(r.kt, kx - runGap + fs * 0.35, base, pen.pal.f, 'left', fs * C.unit) }
          // 符号（含下标）
          if (r.s) {
            const [sb0, sb1] = symParts(r.s)
            ctx.font = F.sym; pen.text(sb0, xS, base, pen.pal.ink, 'left', fs * C.sym)
            if (sb1) { const bw = ctx.measureText(sb0).width; ctx.font = F.symSub; pen.text(sb1, xS + bw + fs * 0.04, base + fs * 0.24, pen.pal.ink, 'left', fs * C.sym * 0.68) }
          }
          // 数值：右齐到数值列右沿；分段从右往左排。tone 'warn' = 越出位置保持范围（着色，不出文字）
          const vInk = r.tone === 'warn' ? WARN : pen.pal.ink
          const vr = runsOf(r.v)
          const vMax = r.span ? xV - (x + colK + fs * 0.6) : colV
          let total = runsW(vr, F.v)
          if (vr.length === 1 && total > vMax) {
            ctx.font = F.v
            const s = ellipsize(ctx, vr[0].t, vMax)
            pen.text(s, xV, base, vInk, 'right', fs)
          } else {
            let vx = xV - total
            vr.forEach((q) => {
              ctx.font = q.f ? F.u : F.v
              pen.text(q.t, vx, base, q.f ? pen.pal.f : vInk, 'left', fs * (q.f ? C.unit : C.body))
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
 *
 * 放不下时的统筹（字号调大、方形 / 竖屏、叠加项开得多时）—— 放得下的版式一笔不动：
 *   ① 单个版块高于可用高度、或宽于 maxW（need = 一个字都不截所需的宽）：按两个比例里小的那个缩字号重排；
 *   ② 一组（一个锚位）分列后总宽超出画面可用宽：降这一组的版块宽度上限与字号再排；
 *   ③ 两组互相压：一上一下（同侧或斜对）分可用高度；同一行（左 / 中 / 右有几组算几组）一起分可用宽度，降 maxW 再排，
 *      居中组整组平移到左右两组之间。分法：各自先给够缩到下限时的长度，余量按「自然长度 − 下限长度」的比例分 ——
 *      小版块（时间读数）不会被大的一组（几张卡片）挤到截断。逐对处理到不再相压为止。
 *   下限 HUD_FIT_MIN（相对设定字号）：按宽度缩、按统筹分到的高度缩都不低于它；只是单块高过整幅可用高度时同原来，按比例缩到放下为止。
 *   缩到下限仍放不下的（叠加项开得太多），宁可截断 / 出界，也不把字缩到看不清
 */
export function drawHud(ctx, W, H, blocks, st, area) {
  const style = { size: 1, panel: false, opacity: 0.62, font: 'ui', ...(st || {}) }
  const A = area && area.w > 0 && area.h > 0 ? area : { x: 0, y: 0, w: W, h: H }
  const baseH = hudBaseH(H, W)
  const fs = hudFontPx(H, style.size, W)
  const m = area ? Math.round(fs * 0.7) : Math.round(baseH * 0.028), gap = fs * 0.55, maxW = A.w * 0.46
  const boxes = []
  ctx.save()
  // 名目已按界面语言出好；站名 / 星名是用户数据，不许被 DOM 呈现层的 canvas 补丁「翻译」。
  // ★ 只在画 HUD 这一段打标、画完复原：2D 出帧时同一个上下文先画地图，地图注记要照屏上那样走翻译
  const skip0 = ctx.__i18nSkip
  ctx.__i18nSkip = true
  const pen = makePen(ctx, fs, style)
  const groups = {}
  for (const b of blocks) (groups[b.pos] = groups[b.pos] || []).push(b)
  const avail = A.h - m * 2, availW = A.w - m * 2
  const fsMin = fs * HUD_FIT_MIN
  // 同一版块、同一字号与宽度上限的排版结果在这一趟里复用（统筹时会反复试排）
  const memo = new Map()
  const layoutM = (b, f, mw) => {
    let mb = memo.get(b)
    if (!mb) memo.set(b, (mb = new Map()))
    const key = f + '|' + mw
    let lb = mb.get(key)
    if (!lb) { lb = layoutBlock(ctx, b, f, style, mw, f === fs ? pen : makePen(ctx, f, style)); mb.set(key, lb) }
    return lb
  }
  // ① 一个版块：按字号 f 排；高于 hh / 宽于 mw 就按两个比例里小的那个缩字号重排（版式全按字号成比例，一两轮即放得下）。
  //    只超出整幅可用高度时与原来逐位相同（f · hh / h · 0.995、不设下限）
  const fitBlock = (b, f, mw, hh) => {
    let lb = layoutM(b, f, mw)
    if (lb.logo) return lb
    for (let i = 0; i < 4; i++) {
      const overH = hh > 0 && lb.h > hh, overW = lb.need > mw
      if (!overH && !overW) break
      const byW = overW && (!overH || mw / lb.need < hh / lb.h)
      const fl = byW || hh < avail ? fsMin : 0
      if (f <= fl) break
      f = Math.max(fl, byW ? f * mw / lb.need * 0.995 : f * hh / lb.h * 0.995)
      lb = layoutM(b, f, mw)
    }
    return lb
  }
  // 一组（一个锚位）：版块自上而下（列表顺序）塞进一列，放不下另起一列
  const pack = (L, hh) => {
    const cols = []
    let col = null
    for (const lb of L) {
      if (!col || (col.items.length && col.h + gap + lb.h > hh)) { col = { items: [], w: 0, h: 0 }; cols.push(col) }
      col.h += (col.items.length ? gap : 0) + lb.h; col.w = Math.max(col.w, lb.w); col.items.push(lb)
    }
    return { cols, totalW: cols.reduce((a, c, i) => a + c.w + (i ? gap : 0), 0), colH: cols.reduce((a, c) => Math.max(a, c.h), 0) }
  }
  // 组的状态：k 整组字号系数、mw 版块宽度上限、hh 可用高度；lay 按它们重排，trial 试排不落定
  const lay = (s) => { s.g = pack(s.list.map((b) => fitBlock(b, s.k === 1 ? fs : fs * s.k, s.mw, s.hh)), s.hh); return s }
  const trial = (s, k, mw, hh) => lay({ list: s.list, k, mw, hh }).g
  // 摆位：左侧锚位往右排列、右侧往左、居中整组居中；底部锚位贴底。
  // 居中组避让同一行的左右两组：放得下就整组平移到两组之间（不缩字号），放不下照旧居中（交给下面的统筹缩）
  const place = (p, g) => {
    const out = [], bottom = p[0] === 'b', hz = p[1]
    let cx = hz === 'l' ? A.x + m : hz === 'r' ? A.x + A.w - m : A.x + (A.w - g.totalW) / 2
    if (hz === 'c') {
      const L = S[p[0] + 'l'], R = S[p[0] + 'r']
      const lo = L ? A.x + m + L.g.totalW + gap : A.x + m, hi = R ? A.x + A.w - m - R.g.totalW - gap : A.x + A.w - m
      if (g.totalW <= hi - lo + 0.5) cx = Math.min(Math.max(cx, lo), hi - g.totalW)
    }
    for (const c of g.cols) {
      const colX = hz === 'r' ? cx - c.w : cx
      let y = bottom ? A.y + A.h - m - c.h : A.y + m
      for (const lb of c.items) {
        out.push({ lb, x: hz === 'l' ? colX : hz === 'r' ? colX + c.w - lb.w : colX + (c.w - lb.w) / 2, y })
        y += lb.h + gap
      }
      cx = hz === 'r' ? colX - gap : colX + c.w + gap
    }
    return out
  }
  const S = {}
  for (const p of HUD_POS) if (groups[p] && groups[p].length) S[p] = lay({ list: groups[p], k: 1, mw: maxW, hh: avail })
  // ② 一组的总宽压进 wb：先把版块宽度上限降到 wb，还宽（多列）就逐轮按比例降整组字号
  const fitW = (s, wb) => {
    s.mw = Math.min(s.mw, Math.max(1, wb))
    lay(s)
    for (let i = 0; i < 6 && s.g.totalW > wb + 0.5 && s.k > HUD_FIT_MIN; i++) { s.k = Math.max(HUD_FIT_MIN, s.k * wb / s.g.totalW * 0.995); lay(s) }
  }
  // 几组分一段长度 T：各自先给够缩到下限时的长度 ms，余量按「自然长度 ns − 下限长度」的比例分 —— 小版块（时间读数）不会被
  // 大的一组（几张卡片）挤到截断；下限都给不够时按下限的比例分（都缩到下限，仍放不下的只能截断 / 出界）
  const shareN = (T, ms, ns) => {
    const lo = ms.reduce((a, v) => a + v, 0)
    if (!(lo < T)) { const k = T / Math.max(1e-9, lo); return ms.map((v) => v * k) }
    const ds = ns.map((v, i) => Math.max(0, v - ms[i])), dd = ds.reduce((a, v) => a + v, 0), E = T - lo
    return ms.map((v, i) => v + (dd > 0 ? E * ds[i] / dd : E / ms.length))
  }
  // 一组能让出的最小高度：缩到下限、又不至于因为另起太多列而宽过画面的那个可用高度（二分；最低 = 缩到下限时最高的那一块）
  const minH = (s) => {
    let lo = trial(s, HUD_FIT_MIN, s.mw, 1).colH, hi = avail
    if (lo >= hi || trial(s, HUD_FIT_MIN, s.mw, lo).totalW <= availW + 0.5) return Math.min(lo, hi)
    if (trial(s, HUD_FIT_MIN, s.mw, hi).totalW > availW + 0.5) return hi
    for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (trial(s, HUD_FIT_MIN, s.mw, mid).totalW <= availW + 0.5) hi = mid; else lo = mid }
    return hi
  }
  const hit = (a, b) => Math.min(a.x + a.lb.w, b.x + b.lb.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.lb.h, b.y + b.lb.h) - Math.max(a.y, b.y) > 0.5
  const stuck = new Set()   // 缩到下限仍压着的那几对：不再折腾
  for (let it = 0; it < 16; it++) {
    const P = HUD_POS.filter((p) => S[p])
    const wide = P.find((p) => S[p].g.totalW > availW + 0.5 && S[p].k > HUD_FIT_MIN)
    if (wide) { fitW(S[wide], availW); continue }
    // ③ 两组互相压（逐对找第一对）
    const B = {}
    for (const p of P) B[p] = place(p, S[p].g)
    let pair = null
    find: for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        if (stuck.has(P[i] + P[j])) continue
        for (const a of B[P[i]]) for (const b of B[P[j]]) if (hit(a, b)) { pair = [P[i], P[j]]; break find }
      }
    }
    if (!pair) break
    const [p, q] = pair, a = S[p], b = S[q]
    const was = [a.g.totalW, a.g.colH, b.g.totalW, b.g.colH].join()
    if (p[0] !== q[0]) {
      // 一上一下（同侧或斜对）：分可用高度（中间留一个间距）。下限长度见 minH
      const t = p[0] === 't' ? a : b, d = p[0] === 't' ? b : a
      const [hT, hB] = shareN(avail - gap, [minH(t), minH(d)], [trial(t, t.k, t.mw, avail).colH, trial(d, d.k, d.mw, avail).colH])
      t.hh = Math.min(t.hh, hT); d.hh = Math.min(d.hh, hB)
      lay(t); lay(d)
    } else {
      // 同一行：这一行里的组（左 / 中 / 右，有几个算几个）一起分可用宽度（降 maxW 再排）；居中组会平移到两侧之间（见 place）
      const R = ['l', 'c', 'r'].map((h) => S[p[0] + h]).filter(Boolean)
      const Ws = shareN(availW - gap * (R.length - 1), R.map((s) => trial(s, HUD_FIT_MIN, maxW, s.hh).totalW), R.map((s) => trial(s, s.k, maxW, s.hh).totalW))
      R.forEach((s, i) => fitW(s, Ws[i]))
    }
    if ([a.g.totalW, a.g.colH, b.g.totalW, b.g.colH].join() === was) stuck.add(p + q)
  }
  for (const p of HUD_POS) {
    if (!S[p]) continue
    for (const { lb, x: bx, y } of place(p, S[p].g)) {
      if (style.panel && !lb.logo) {
        ctx.fillStyle = `rgba(12,16,22,${Math.max(0, Math.min(1, style.opacity))})`
        rrect(ctx, bx, y, lb.w, lb.h, fs * 0.38); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = Math.max(1, baseH / 1080); ctx.stroke()
      }
      lb.draw(bx, y)
      boxes.push({ pos: p, x: bx, y, w: lb.w, h: lb.h })
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
