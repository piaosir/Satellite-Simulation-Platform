// 视频叠加信息（src/viz/video/hud.js）：数据 → 版块、读数格式、锚位布局（假 2D 上下文量字宽）。
// 运行：npm test -- videoHud
import { buildHudBlocks, drawHud, fmtStamp, fmtElapsed, fmtLat, fmtLon, hudFontPx, hudBaseH, SAT_SECS, satFieldDefaults } from '../../../src/viz/video/hud.js'

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
const T = (zh) => zh
const items = (o) => ({
  time: { on: false, pos: 'tr', date: true }, title: { on: false, pos: 'tl' }, sat: { on: false, pos: 'tl' }, aer: { on: false, pos: 'bl', ids: [] },
  field: { on: false, pos: 'bl', ids: [] }, legend: { on: false, pos: 'br' }, logo: { on: false, pos: 'br', h: 2 }, progress: { on: false }, ...o
})
// 假 2D 上下文：字宽 = 字数 × 字号 × 0.55；绘制调用一律空转
const fakeCtx = () => ({
  font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', lineJoin: '', lineCap: '', miterLimit: 0, shadowColor: '', shadowBlur: 0,
  save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, rect() {}, clip() {}, fill() {}, stroke() {}, setLineDash() {},
  fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {}, drawImage() {},
  measureText(s) { const px = Number((/([\d.]+)px/.exec(this.font) || [0, 12])[1]); return { width: String(s).length * px * 0.55 } }
})
const allOn = () => { const o = {}; for (const s of SAT_SECS) for (const f of s.f) o[f.k] = true; return o }
const ONEWEB = {
  name: 'ONEWEB-0719', norad: '55179', kind: 'LEO', group: 'OneWeb', lat: 39.74, lon: -118.72, alt: '1198', vg: '7.251', vi: '7.259', trk: { rev: 1.5, v: '2.73', u: 'h' },
  a: '7569', e: '0.00020', i: '87.92', raan: '343.73', argp: '93.98', ma: '266.16', n: '13.1840', T: '109.2', hp: '1189', ha: '1192',
  epochMs: Date.UTC(2026, 9, 7, 1, 2, 3), age: '0.52',
  ants: [{ name: 'Ku-1', sat: '', peak: 38.456 }], model: { name: 'OneWeb Gen1', dims: '1.00 × 1.20 × 1.30', mass: '150' }
}

// ① 读数格式
{
  const t = Date.UTC(2026, 9, 7, 4, 5, 6)
  ok('① UTC 档：2026-10-07 04:05:06 UTC', fmtStamp(t, 'utc') === '2026-10-07 04:05:06 UTC')
  ok('① 固定 +8 档且不带日期：12:05:06 UTC+8', fmtStamp(t, 480, false) === '12:05:06 UTC+8')
  ok('① 经过时间：T+00:12:34 / 跨天 T+1d 02:00:00', fmtElapsed(754) === 'T+00:12:34' && fmtElapsed(93600) === 'T+1d 02:00:00')
  ok('① 经纬度：南纬 / 西经', fmtLat(-12.345) === '12.35°S' && fmtLon(-0.12) === '0.12°W' && fmtLon(116.4) === '116.40°E')
  ok('① 1080p 标准字号 21.6 px、4K 43.2 px、系数夹在 [0.6, 2]', Math.abs(hudFontPx(1080, 1) - 21.6) < 1e-9 && Math.abs(hudFontPx(2160, 1) - 43.2) < 1e-9 && hudFontPx(1080, 9) === hudFontPx(1080, 2))
}
// ② 版块：只出开着且有数据的项；位置跟设置；聚焦卫星出厂 = 身份徽标 + 纬度 / 经度 / 轨道高度
{
  const spec = { items: items({ time: { on: true, pos: 'tl', date: true, elapsed: true, speed: true }, sat: { on: true, pos: 'tr' } }) }
  const data = { tMs: Date.UTC(2026, 0, 1), t0: Date.UTC(2026, 0, 1) - 3600e3, tz: 'utc', speed: 600, sats: [{ name: 'ZX-26', norad: '57731', kind: 'GEO', group: 'GEO', slot: '125.0°E', lat: 0.01, lon: 125, alt: '35786', vg: '0.001', vi: '3.075' }] }
  const b = buildHudBlocks(spec, data, T)
  ok('② 时间 + 卫星两个版块、位置跟设置', b.length === 2 && b[0].kind === 'time' && b[0].pos === 'tl' && b[1].kind === 'sat' && b[1].pos === 'tr')
  ok('② 时间版块第二行：经过时间 + 倍速', b[0].rows[1][0].t === 'T+01:00:00   ×600')
  const c = b[1].card
  ok('② 卫星卡片：星名 + 徽标 NORAD / 区制 / 定点（组名与区制同名不出）', c.name === 'ZX-26' && c.badges.map((x) => x.v).join(',') === '57731,GEO,125.0°E' && c.badges[0].k === 'NORAD' && c.badges[2].tone === 'geo')
  const r = c.secs[0].rows
  ok('② 出厂三行：纬度 φ / 经度 λ / 轨道高度 h，半球字母进单位列', c.secs.length === 1 && r.map((x) => x.s).join('') === 'φλh' && r[0].v === '0.01' && r[0].u === '°N' && r[1].v === '125.00' && r[1].u === '°E' && r[2].v === '35786' && r[2].u === 'km')
  ok('② 出厂勾选表覆盖目录里每个字段', Object.keys(satFieldDefaults()).length === SAT_SECS.reduce((a, s) => a + s.f.length, 0))
  ok('② 没数据的开着项不出版块', buildHudBlocks({ items: items({ aer: { on: true, pos: 'bl', ids: [] }, field: { on: true, pos: 'bl' } }) }, {}, T).length === 0)
}
// ③ 字段全开 = 右侧信息栏的全部读数：节、顺序、符号、组间点线、跨列与分段
{
  const spec = { items: items({ sat: { on: true, pos: 'tl', f: allOn(), heads: true } }) }
  const c = buildHudBlocks(spec, { tz: 'utc', sats: [ONEWEB] }, T)[0].card
  ok('③ 四节齐全、节名同信息栏', c.secs.map((x) => x.title).join('|') === '实时状态|星历|天线|模型', c.secs.map((x) => x.title).join('|'))
  ok('③ 徽标：NORAD / 区制 / 卫星组', c.badges.map((x) => x.v).join(',') === '55179,LEO,OneWeb')
  const live = c.secs[0].rows
  ok('③ 实时状态：纬度 φ 经度 λ 轨道高度 h 对地速度 惯性速度 轨迹周期', live.map((x) => x.k + (x.s ? ' ' + x.s : '')).join('|') === '纬度 φ|经度 λ|轨道高度 h|对地速度|惯性速度|轨迹周期')
  ok('③ 西经：数值取绝对值、单位 °W；数值与单位都带定宽模板', live[1].v === '118.72' && live[1].u === '°W' && live[1].tv === '000.00' && live[1].tu.includes('°E'))
  ok('③ 轨迹周期分段：圈数 + 小号「圈」 + 时长，单位 h', Array.isArray(live[5].v) && live[5].v.map((q) => q.t).join(' ') === '1.5 圈 · 2.73' && live[5].v[1].f && live[5].u === 'h')
  const el = c.secs[1].rows
  ok('③ 星历：历元 历元龄 ┆ n e i Ω ω M ┆ a T 近 远（同信息栏「星历」节）', el.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' ') === '历元 历元龄 ┆ n e i Ω ω M ┆ a T 近地点高度 远地点高度', el.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' '))
  const ep = el.find((r) => r.k === '历元')
  ok('③ 历元按显示时区、时区角标挂标签后、数值跨符号列', ep.v === '2026-10-07 01:02:03' && ep.kt === 'UTC' && ep.span === true)
  ok('③ 平均运动单位 圈/日、偏心率无单位', el.find((r) => r.s === 'n').u === '圈/日' && !el.find((r) => r.s === 'e').u)
  const ant = c.secs[2].rows[0], md = c.secs[3].rows
  ok('③ 天线：名称 | 峰值两位小数 | dBi', ant.k === 'Ku-1' && ant.v === '38.46' && ant.u === 'dBi')
  ok('③ 模型：名称跨列、尺寸按 × 分段、质量 kg', md[0].span && md[0].v === 'OneWeb Gen1' && md[1].v.filter((q) => q.f).length === 2 && md[1].u === 'm' && md[2].v === '150' && md[2].u === 'kg')
  ok('③ 卡片里没有判定性文字', !/达标|受限|合格|可见|不可见/.test(JSON.stringify(c)))
  const none = {}; for (const k of Object.keys(allOn())) none[k] = false
  const c0 = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: none } }) }, { tz: 'utc', sats: [ONEWEB] }, T)[0].card
  ok('③ 字段全关：只剩星名', c0.badges.length === 0 && c0.secs.length === 0 && c0.name === 'ONEWEB-0719')
  const g = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: { ...none, i: true, ma: true, age: true } } }) }, { tz: 'utc', sats: [ONEWEB] }, T)[0].card.secs[0].rows
  ok('③ 只勾 i、M、历元龄：组间点线照留（历元 ┆ 平根数）', g.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' ') === '历元龄 ┆ i M')
  const E = (zh, en) => en
  const ce = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: allOn() } }) }, { tz: 'utc', sats: [{ ...ONEWEB, name: '中星26', nameEn: 'CS26', group: '其他', groupEn: 'Other' }] }, E)[0].card
  ok('③ 英文：标签换英文、符号不变、星名 / 内置组名取译名', ce.name === 'CS26' && ce.badges[2].v === 'Other' && ce.secs[0].rows[0].k === 'Latitude' && ce.secs[0].rows[0].s === 'φ' && ce.secs[1].title === 'Ephemeris' && ce.secs[1].rows.find((r) => r.s === 'n').u === 'rev/day')
}
// ③ᵇ 状态矢量 / 密切根数 / 同步轨道 / 星历补项：与信息栏同名同序同符号；参考系进节名（节名关时挂首行角标）；下标符号；越界着色
{
  const SV = { frame: 'J2000', frameLabel: 'J2000', x: '-4123.456', y: '5123.789', z: '1234.567', vx: '1.234567', vy: '-2.345678', vz: '6.789012', r: '6789.123' }
  const OSC = { frame: 'TEME', frameLabel: 'TEME', a: '7569.123', e: '0.0002000', i: '87.9200', raan: '343.7300', argp: '93.9800', nu: '266.1600', u: '0.1400', M: '266.1800', L: '' }
  const GEO = { lon: '110.5123', lonH: '°E', dlon: '+0.0123', drift: '-0.0021', e: '0.0002345', ex: '0.0001000', ey: '-0.0002121', i: '0.0456', ix: '0.0100', iy: '0.0445', ewOut: true, nsOut: false }
  const S = { ...ONEWEB, sv: SV, osc: OSC, geo: GEO, prop: 'SGP4', bstar: '2.1000e-4' }
  const c = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: allOn(), heads: true } }) }, { tz: 'utc', sats: [S] }, T)[0].card
  ok('③ᵇ 七节、顺序同信息栏（实时状态 → 状态矢量 → 密切根数 → 同步轨道 → 星历 → 天线 → 模型）', c.secs.map((x) => x.title).join('|') === '实时状态|状态矢量 · J2000|密切根数 · TEME|同步轨道|星历|天线|模型', c.secs.map((x) => x.title).join('|'))
  const sym = (rows) => rows.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' ')
  ok('③ᵇ 状态矢量：x y z ẋ ẏ ż ┆ r，标签只挂每组首行', sym(c.secs[1].rows) === 'x y z ẋ ẏ ż ┆ r' && c.secs[1].rows[0].k === '位置矢量' && c.secs[1].rows[1].k === '' && c.secs[1].rows[3].k === '速度矢量' && c.secs[1].rows[3].u === 'km/s', sym(c.secs[1].rows))
  ok('③ᵇ 状态矢量：逐帧在变的读数带定宽模板（含负号位）', c.secs[1].rows[0].tv === '-00000.000' && c.secs[1].rows[3].tv === '-0.000000')
  ok('③ᵇ 密切根数：a e i Ω ω ν ┆ u M', sym(c.secs[2].rows) === 'a e i Ω ω ν ┆ u M', sym(c.secs[2].rows))
  ok('③ᵇ 同步轨道：λ̄ Δλ D ┆ e e_x e_y ┆ i i_x i_y（下标写法）', sym(c.secs[3].rows) === 'λ̄ Δλ D ┆ e e_x e_y ┆ i i_x i_y', sym(c.secs[3].rows))
  ok('③ᵇ 同步轨道：越出经度保持范围的 Δλ 着警示色、倾角未越界不着色', c.secs[3].rows[1].tone === 'warn' && !c.secs[3].rows.find((r) => r.s === 'i').tone)
  ok('③ᵇ 平经度单位按半球、定宽模板', c.secs[3].rows[0].u === '°E' && c.secs[3].rows[0].tu.includes('°W'))
  ok('③ᵇ 星历：传播模型 ┆ 历元 历元龄 ┆ n e i Ω ω M B* ┆ a T 近 远', sym(c.secs[4].rows) === '传播模型 ┆ 历元 历元龄 ┆ n e i Ω ω M B* ┆ a T 近地点高度 远地点高度' && c.secs[4].rows[0].v === 'SGP4' && c.secs[4].rows[0].span, sym(c.secs[4].rows))
  const noU = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: { ...allOn() }, heads: false } }) }, { tz: 'utc', sats: [{ ...S, osc: { ...OSC, u: '', L: '12.3456' } }] }, T)[0].card
  ok('③ᵇ 节名关：参考系挂在首行标签角标上', noU.secs[1].rows[0].kt === 'J2000' && noU.secs[2].rows[0].kt === 'TEME')
  ok('③ᵇ 近赤道没有纬度幅角：改出真经度 l', noU.secs[2].rows.some((r) => r.s === 'l' && r.v === '12.3456'))
  const E = (zh, en) => en
  const ce = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: allOn() } }) }, { tz: 'utc', sats: [S] }, E)[0].card
  ok('③ᵇ 英文节名', ce.secs.map((x) => x.title).join('|') === 'Live Status|State Vector · J2000|Osculating Elements · TEME|Geosynchronous Orbit|Ephemeris|Antenna|Model', ce.secs.map((x) => x.title).join('|'))
  ok('③ᵇ 目录：新字段键全局唯一', new Set(SAT_SECS.flatMap((s) => s.f.map((f) => f.k))).size === SAT_SECS.reduce((a, s) => a + s.f.length, 0))
  ok('③ᵇ 卡片里没有判定性文字', !/达标|受限|合格|越界|超出/.test(JSON.stringify(c)))
  // 字段全开的单张卡片比 1080p 画面还高：整体缩字号放进画面（版式按字号成比例）
  const ctx = fakeCtx()
  const b = drawHud(ctx, 1920, 1080, buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: allOn(), heads: true } }) }, { tz: 'utc', sats: [S] }, T), { size: 1.4 })
  ok('③ᵇ 超高卡片缩放后整张落在画面内', b.length === 1 && b[0].y >= 0 && b[0].y + b[0].h <= 1080 - Math.round(1080 * 0.028) + 1e-6, JSON.stringify(b[0]))
}
// ④ 站星几何 / 场强 / 图例
{
  const b = buildHudBlocks({ items: items({ aer: { on: true, pos: 'bl', ids: [] } }) }, { aer: { sat: 'S1', rows: [{ name: '北京', az: 120.4, el: 33.2, rangeKm: 37000 }, { name: '圣保罗', az: 10, el: -4, rangeKm: 41000 }] } }, T)
  const rows = b[0].rows
  ok('④ 站星几何：表头 + 两行', rows.length === 3 && rows[0][1].t === '方位')
  ok('④ 仰角 < 0 的行压暗，其余不压', rows[2].every((c) => c.dim) && !rows[1].some((c) => c.dim))
  ok('④ 没有「可见 / 不可见」这类字样', !JSON.stringify(b).match(/可见|不可见|visible/))
  const b2 = buildHudBlocks({ items: items({ field: { on: true, pos: 'br' }, legend: { on: true, pos: 'br' } }) }, { field: { title: 'A · B', unit: 'dBW/m²', rows: [{ name: 'X', value: -118.257 }, { name: 'Y', value: NaN }] }, legend: { title: 'A · B (dB)', levels: [{ color: '#f00', label: '-3' }, { color: '#0f0', label: '-6' }] } }, T)
  ok('④ 场强数值两位小数、单位单独一列；取不到值的压暗为「—」', b2[0].rows[0][1].t === '-118.26' && b2[0].rows[0][2].t === 'dBW/m²' && b2[0].rows[1][1].t === '—' && b2[0].rows[1][1].dim)
  ok('④ 图例：色块 + 标签', b2[1].kind === 'legend' && b2[1].rows[0][0].sw === '#f00' && b2[1].rows[1][1].t === '-6')
}
// ⑤ 布局：版块全在画面内、同一锚位不重叠、底部锚位贴底；底板开关两档都能画
{
  const ctx = fakeCtx()
  const spec = { items: items({ time: { on: true, pos: 'br', date: true }, field: { on: true, pos: 'br' }, sat: { on: true, pos: 'tl' } }) }
  const data = { tMs: Date.UTC(2026, 0, 1), tz: 'utc', sats: [{ name: 'A', lat: 1, lon: 2, alt: '550' }, { name: 'B', lat: 3, lon: 4, alt: '560' }], field: { title: 'F', unit: 'dB', rows: [{ name: 'p', value: 1 }] } }
  const W = 1920, H = 1080
  for (const panel of [true, false]) {
    const boxes = drawHud(ctx, W, H, buildHudBlocks(spec, data, T), { size: 1, panel })
    const tag = panel ? '（底板）' : '（无底板）'
    ok('⑤ 四个版块都画了' + tag, boxes.length === 4)
    ok('⑤ 全在画面内' + tag, boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H))
    const br = boxes.filter((b) => b.pos === 'br'), tl = boxes.filter((b) => b.pos === 'tl')
    const noOverlap = (L) => L.every((a, i) => L.every((b, j) => i === j || a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x))
    ok('⑤ 同一锚位不重叠（左上两颗星、右下两块）' + tag, noOverlap(br) && noOverlap(tl) && tl.length === 2 && br.length === 2)
    ok('⑤ 右下：贴右边距、最后一个版块贴底' + tag, br.every((b) => Math.abs(b.x + b.w - (W - Math.round(H * 0.028))) < 1e-6) && br.some((b) => Math.abs(b.y + b.h - (H - Math.round(H * 0.028))) < 1e-6))
  }
  // 画 HUD 期间打 __i18nSkip（站名 / 星名不许被界面翻译补丁改写），画完复原（2D 出帧同一上下文先画地图，地图注记照常翻译）
  let seen = null
  const ctx2 = { ...fakeCtx(), fillText() { if (seen === null) seen = this.__i18nSkip } }
  drawHud(ctx2, W, H, buildHudBlocks(spec, data, T), { size: 1, panel: true })
  ok('⑤ HUD 文字落笔时 __i18nSkip 为真、画完复原', seen === true && !ctx2.__i18nSkip)
}
// ⑥ 一列放不下就另起一列；给了图框内区就只排在内区里
{
  const ctx = fakeCtx()
  const sats = [0, 1, 2, 3, 4, 5].map((i) => ({ ...ONEWEB, name: 'S' + i }))
  const spec = { items: items({ sat: { on: true, pos: 'tl', f: allOn(), heads: true } }) }
  const W = 1920, H = 1080
  const boxes = drawHud(ctx, W, H, buildHudBlocks(spec, { tz: 'utc', sats }, T), { size: 1 })
  const xs = [...new Set(boxes.map((b) => Math.round(b.x)))]
  ok('⑥ 六张全字段卡片在 1080p 左上分成多列、列内自上而下', xs.length > 1 && boxes.every((b) => b.y + b.h <= H))
  const noOverlap = boxes.every((a, i) => boxes.every((b, j) => i === j || a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x))
  ok('⑥ 分列后互不重叠', noOverlap)
  const br = drawHud(ctx, W, H, buildHudBlocks({ items: items({ sat: { on: true, pos: 'br', f: allOn() } }) }, { tz: 'utc', sats }, T), { size: 1 })
  ok('⑥ 右下锚位往左排列：第二列在第一列左边', br.length === 6 && Math.min(...br.map((b) => b.x)) < br[0].x)
  const area = { x: 120, y: 30, w: 1500, h: 900 }
  const ab = drawHud(ctx, W, H, buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl' }, time: { on: true, pos: 'br', date: true } }) }, { tMs: 0, tz: 'utc', sats: [ONEWEB] }, T), { size: 1 }, area)
  ok('⑥ 图框内区：版块都落在内区里', ab.length === 2 && ab.every((b) => b.x >= area.x && b.y >= area.y && b.x + b.w <= area.x + area.w && b.y + b.h <= area.y + area.h))
}
// ⑦ 逐帧在变的读数不让版块宽度跳：经度 99.99 → 100.00、北纬 → 南纬，卡片宽度不变
{
  const ctx = fakeCtx()
  const spec = { items: items({ sat: { on: true, pos: 'tl' } }) }
  const w = (lat, lon, alt) => drawHud(ctx, 1920, 1080, buildHudBlocks(spec, { tz: 'utc', sats: [{ name: 'X', lat, lon, alt }] }, T), { size: 1 })[0].w
  ok('⑦ 定宽模板：经度位数、半球、高度位数变了宽度都不变', w(1.5, 99.99, '550') === w(-1.5, 100.0, '1200') && w(1.5, 99.99, '550') === w(-89.99, -179.99, '35786'))
}

// —— ⑧–⑪ 大字号显示不全（字号 1.5× / 2×、方形 / 竖屏）——
// 实测字宽的假 2D 上下文：Arial（西文）/ 等线（中文 1 em）字宽表、宽度按单精度取整（同浏览器的 TextMetrics）；
// 记下每一笔落到画布上的调用与落笔时的状态（形状只记颜色 / 线宽 / 虚线，文字另记字体 / 对齐 / 颜色）——「逐笔相同」就比这份记录
const EMW = { ' ': 0.278, '.': 0.278, ',': 0.278, ':': 0.278, '-': 0.333, '−': 0.584, '+': 0.584, '°': 0.4, '×': 0.584, '·': 0.278, '…': 1, '/': 0.278, '(': 0.333, ')': 0.333, '*': 0.389, '²': 0.333 }
const EMU = { A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722, I: 0.278, J: 0.5, K: 0.667, L: 0.556, M: 0.833, N: 0.722, O: 0.778, P: 0.667, Q: 0.778, R: 0.722, S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667, Y: 0.667, Z: 0.611 }
const emOf = (ch, serif) => (/[⺀-鿿　-〿＀-￯]/.test(ch) ? 1 : /[0-9]/.test(ch) ? (serif ? 0.5 : 0.556) : EMW[ch] != null ? EMW[ch] : EMU[ch] != null ? EMU[ch] : /[a-z]/.test(ch) ? (serif ? 0.45 : 0.5) : /[̀-ͯ]/.test(ch) ? 0 : /[Ͱ-Ͽ]/.test(ch) ? 0.55 : 0.6)
function textW(font, s) {
  const px = Number((/([\d.]+)px/.exec(font) || [0, 12])[1]), fam = font.split('px')[1] || ''
  const serif = /Times|serif/.test(fam) && !/Arial/.test(fam)
  let em = 0
  for (const ch of String(s)) em += emOf(ch, serif)
  return Math.fround(em * px * (/\b600\b/.test(font) ? 1.04 : 1))
}
function recCtx() {
  const log = []
  let path = [], dash = []
  const ctx = {
    font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic', lineJoin: 'miter', miterLimit: 10, lineCap: 'butt', _st: [],
    save() { this._st.push([this.font, this.fillStyle, this.strokeStyle, this.lineWidth, this.textAlign, this.textBaseline, this.lineJoin, this.miterLimit, this.lineCap, dash]) },
    restore() { const s = this._st.pop(); if (s) [this.font, this.fillStyle, this.strokeStyle, this.lineWidth, this.textAlign, this.textBaseline, this.lineJoin, this.miterLimit, this.lineCap, dash] = s },
    beginPath() { path = [] }, moveTo(x, y) { path.push('M', x, y) }, lineTo(x, y) { path.push('L', x, y) }, arcTo(a, b, c, d, r) { path.push('A', a, b, c, d, r) },
    closePath() { path.push('Z') }, rect(x, y, w, h) { path.push('R', x, y, w, h) }, setLineDash(d) { dash = (d || []).slice() },
    clip() { log.push(['clip', path.join()]) }, fill() { log.push(['fill', path.join(), this.fillStyle]) }, stroke() { log.push(['stroke', path.join(), this.strokeStyle, this.lineWidth, dash.join()]) },
    fillRect(x, y, w, h) { log.push(['fillRect', x, y, w, h, this.fillStyle]) }, strokeRect(x, y, w, h) { log.push(['strokeRect', x, y, w, h, this.strokeStyle, this.lineWidth]) },
    fillText(s, x, y) { log.push(['fillText', s, x, y, this.font, this.textAlign, this.fillStyle]) },
    strokeText(s, x, y) { log.push(['strokeText', s, x, y, this.font, this.textAlign, this.strokeStyle, this.lineWidth, this.lineJoin]) },
    drawImage() {}, measureText(s) { return { width: textW(this.font, s) } }
  }
  return { ctx, log }
}
const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 } return h.toString(16).padStart(8, '0') }
const T_EN = (zh, en) => en
const FX_T = Date.UTC(2026, 9, 12, 0, 30, 0)
const FX_SATS = [
  { name: 'ONEWEB-0719', norad: '55179', kind: 'LEO', group: 'OneWeb', lat: 39.74, lon: -118.72, alt: '1198' },
  { name: 'STARLINK-31415', norad: '58123', kind: 'LEO', group: 'Starlink', lat: -12.5, lon: 101.33, alt: '550' },
  { name: '中星26号', nameEn: 'ZHONGXING-26', norad: '57731', kind: 'GEO', group: 'GEO', slot: '125.0°E', lat: 0.01, lon: 125, alt: '35786' }
]
const FX_AER = { sat: 'ONEWEB-0719', rows: [['北京', 123.4, 32.1, 1834], ['喀什', 201.7, 12.5, 2650], ['三亚地面站', 88.2, -4.2, 3410], ['Beijing Ground Station 01', 250.1, 45.3, 1402]].map(([name, az, el, rangeKm]) => ({ name, az, el, rangeKm })) }
const FX_FIELD = { title: '中星26号 · Ka 多波束天线', unit: 'dBW/m²', rows: [['北京', -118.32], ['喀什', -121.07], ['三亚地面站', -119.6]].map(([name, value]) => ({ name, value })) }
const FX_LEGEND = { title: '中星26号 · Ka 多波束天线 (dB)', levels: [-1, -2, -3, -4, -6, -8, -10, -15].map((v) => ({ color: '#36c', label: String(v) })) }
const fxData = (ns) => ({ tMs: FX_T, t0: FX_T, tz: 480, sats: FX_SATS.slice(0, ns), title: '中星26号 Ka 频段多波束覆盖演示', subtitle: '2026 年 10 月 12 日 · 北京时间', aer: FX_AER, field: FX_FIELD, legend: FX_LEGEND })
const satOn = (pos) => ({ on: true, pos, max: 3, heads: true, f: satFieldDefaults() })
// 出厂叠加项（useVideoExport.defaultVideoSettings）：时间（右上，带日期）+ 聚焦卫星（左上，出厂字段），其余关
const factoryItems = () => items({ time: { on: true, pos: 'tr', date: true, elapsed: false, speed: false }, sat: satOn('tl') })
// 画一帧并体检：截断（落笔文字带 …）、文字 / 版块出画面、版块两两重叠
function hudCheck(W, H, size, its, ns, Tf, panel) {
  const { ctx, log } = recCtx()
  const boxes = drawHud(ctx, W, H, buildHudBlocks({ items: its }, fxData(ns), Tf), { size, panel, fontStack: 'Arial, DengXian' })
  const texts = log.filter((q) => q[0] === 'fillText')
  const trunc = texts.filter((q) => q[1].includes('…')).map((q) => q[1])
  const out = texts.filter((q) => {
    const w = textW(q[4], q[1]), px = Number(/([\d.]+)px/.exec(q[4])[1]), x0 = q[5] === 'right' ? q[2] - w : q[5] === 'center' ? q[2] - w / 2 : q[2]
    return x0 < -0.5 || x0 + w > W + 0.5 || q[3] - px * 0.8 < -0.5 || q[3] + px * 0.2 > H + 0.5
  }).map((q) => q[1])
  const outB = boxes.filter((b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > W + 0.5 || b.y + b.h > H + 0.5).length
  let ov = 0
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5) ov++
  }
  return { trunc, out, outB, ov, texts: texts.map((q) => q[1]), boxes }
}
const tagOf = (W, H, size, Tf, panel) => `${W}×${H} ${size}× ${Tf === T ? '中' : '英'}${panel ? ' 底板' : ''}`
// ⑧ 出厂设置（16:9 任一分辨率、字号 1×、出厂开关、中英文、底板开 / 关、1 颗 / 3 颗星）逐笔绘制与修改前相同。
//    期望值是修改前的 hud.js 用同一个假上下文画出来的整份落笔记录的哈希（每个分辨率 8 种组合连起来算一个）
{
  const EXPECT = { '1280x720': 'd74f2b6f', '1920x1080': 'a5229d4a', '2560x1440': 'd305ccb3', '3840x2160': 'dbc74ff5' }
  for (const [res, want] of Object.entries(EXPECT)) {
    const [W, H] = res.split('x').map(Number)
    let all = ''
    for (const Tf of [T, T_EN]) for (const panel of [false, true]) for (const ns of [1, 3]) {
      const { ctx, log } = recCtx()
      const boxes = drawHud(ctx, W, H, buildHudBlocks({ items: factoryItems() }, { tMs: FX_T, t0: FX_T, tz: 480, sats: FX_SATS.slice(0, ns) }, Tf), { size: 1, panel, fontStack: 'Arial, DengXian' })
      all += JSON.stringify([log, boxes])
    }
    ok('⑧ 出厂 ' + res + '：逐笔绘制与修改前相同（中英 × 底板开关 × 1 / 3 颗星）', fnv(all) === want, fnv(all) + ' vs ' + want)
  }
  ok('⑧ 字号基准：16:9 及更宽 = 画面高（与修改前一位不差），方形 / 竖屏按宽折算（字号与画面宽之比同 16:9）',
    hudFontPx(1080, 1, 1920) === hudFontPx(1080, 1) && hudFontPx(2160, 2, 3840) === hudFontPx(2160, 2) && hudFontPx(1080, 1, 2560) === hudFontPx(1080, 1) &&
    hudBaseH(1080, 1920) === 1080 && Math.abs(hudFontPx(1920, 1, 1080) - 12.15) < 1e-9 && Math.abs(hudFontPx(1080, 1, 1080) - 12.15) < 1e-9 &&
    Math.abs(hudFontPx(1920, 2, 1080) / 1080 - hudFontPx(1080, 2, 1920) / 1920) < 1e-12)
  // 浮点短缺：标签列宽恰好量到最宽那条，「x + colK − kx」比实测字宽少 1 ULP，修改前在 1080p · 1.3× 把「轨道高度」截成「轨道…」
  const r = hudCheck(1920, 1080, 1.3, factoryItems(), 1, T, false)
  ok('⑧ 浮点短缺不再误截：1080p · 1.3× 出厂卡片标签完整', !r.trunc.length && r.texts.includes('轨道高度'), JSON.stringify(r.trunc))
}
// ⑨ 2×：16:9 / 1080×1080 / 1080×1920 下时间读数、标题、卡片、站星几何全部不截断、不出画面、互不重叠
{
  const its = items({ title: { on: true, pos: 'tl' }, time: { on: true, pos: 'tr', date: true }, sat: satOn('tl'), aer: { on: true, pos: 'bl', ids: [] } })
  for (const [W, H] of [[1920, 1080], [1080, 1080], [1080, 1920]]) {
    const bad = []
    for (const Tf of [T, T_EN]) for (const panel of [false, true]) {
      const r = hudCheck(W, H, 2, its, 1, Tf, panel)
      const whole = r.texts.includes('2026-10-12 08:30:00 UTC+8') && r.texts.includes('中星26号 Ka 频段多波束覆盖演示') && r.texts.includes('Beijing Ground Station 01') && r.texts.includes(Tf === T ? '轨道高度' : 'Orbital Altitude')
      if (r.trunc.length || r.out.length || r.outB || r.ov || !whole) bad.push(tagOf(W, H, 2, Tf, panel) + ' ' + JSON.stringify({ trunc: r.trunc, out: r.out.slice(0, 3), outB: r.outB, ov: r.ov, whole }))
    }
    ok(`⑨ 2× ${W}×${H}：时间 / 标题 / 卡片 / 站星几何不截断、不出画面、互不重叠（中英 × 底板开关）`, !bad.length, bad.join(' ‖ '))
  }
  // 放得下就按设定字号画（不是一律缩回 1×）：16:9 · 2× 只开时间读数，1.3 × 43.2 = 56.16 px、整条画出
  const { ctx, log } = recCtx()
  drawHud(ctx, 1920, 1080, buildHudBlocks({ items: items({ time: { on: true, pos: 'tr', date: true } }) }, fxData(0), T), { size: 2, fontStack: 'Arial, DengXian' })
  const q = log.find((x) => x[0] === 'fillText' && x[1].startsWith('2026-10-12'))
  ok('⑨ 2× 放得下就不缩：时间读数按 56.16 px 整条画出', !!q && q[1] === '2026-10-12 08:30:00 UTC+8' && q[4].includes('56.16px'), q && q[1] + ' @ ' + q[4])
}
// ⑩ 左上 + 左下（同侧上下两组）、左上 + 右上（同一行左右两组）在 1.5× / 2×、三种画幅下互不重叠、不截断、不出画面
{
  const lr = items({ sat: satOn('tl'), aer: { on: true, pos: 'bl', ids: [] }, field: { on: true, pos: 'bl' } })
  const tt = items({ title: { on: true, pos: 'tl' }, sat: satOn('tl'), time: { on: true, pos: 'tr', date: true, elapsed: true }, legend: { on: true, pos: 'tr' } })
  for (const [name, its] of [['左上 3 颗星 + 左下 站星几何 / 场强', lr], ['左上 标题 + 3 颗星 + 右上 时间 / 图例', tt]]) {
    const bad = []
    for (const [W, H] of [[1920, 1080], [1080, 1080], [1080, 1920]]) for (const size of [1.5, 2]) for (const Tf of [T, T_EN]) for (const panel of [false, true]) {
      const r = hudCheck(W, H, size, its, 3, Tf, panel)
      if (r.ov || r.outB || r.out.length || r.trunc.length) bad.push(tagOf(W, H, size, Tf, panel) + ' ' + JSON.stringify({ ov: r.ov, outB: r.outB, out: r.out.slice(0, 2), trunc: r.trunc }))
    }
    ok('⑩ ' + name + '：互不重叠、不截断、不出画面（1.5× / 2× × 三种画幅 × 中英 × 底板开关）', !bad.length, bad.slice(0, 3).join(' ‖ '))
  }
  // 放得下的时候不统筹：左上一颗星 + 右上时间（出厂）在 2× 下两块都按设定字号画，位置贴各自的角
  const r = hudCheck(1920, 1080, 2, factoryItems(), 1, T, false)
  const m = Math.round(1080 * 0.028)
  ok('⑩ 放得下就不动：2× 出厂两块各贴各的角', r.boxes.length === 2 && r.boxes[0].x === m && r.boxes[0].y === m && Math.abs(r.boxes[1].x + r.boxes[1].w - (1920 - m)) < 1e-6 && r.boxes[1].y === m)
}
// ⑪ 居中锚位避让：上中的标题与左上的卡片、右上的时间放得下就整组平移到两者之间，不缩字号、不压
{
  const its = items({ title: { on: true, pos: 'tc' }, sat: satOn('tl'), time: { on: true, pos: 'tr', date: true } })
  const bad = []
  for (const [W, H] of [[1920, 1080], [1080, 1080], [1080, 1920]]) for (const size of [1, 1.5, 2]) {
    const r = hudCheck(W, H, size, its, 1, T, false)
    if (r.ov || r.outB || r.out.length || r.trunc.length) bad.push(tagOf(W, H, size, T, false) + ' ' + JSON.stringify({ ov: r.ov, outB: r.outB, trunc: r.trunc }))
  }
  ok('⑪ 上中标题 + 左上卡片 + 右上时间：互不重叠、不截断（三种画幅 × 1× / 1.5× / 2×）', !bad.length, bad.join(' ‖ '))
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
