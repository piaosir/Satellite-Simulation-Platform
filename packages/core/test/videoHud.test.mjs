// 视频叠加信息（src/viz/video/hud.js）：数据 → 版块、读数格式、锚位布局（假 2D 上下文量字宽）。
// 运行：npm test -- videoHud
import { buildHudBlocks, drawHud, fmtStamp, fmtElapsed, fmtLat, fmtLon, hudFontPx, SAT_SECS, satFieldDefaults } from '../../../src/viz/video/hud.js'

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
  ok('③ 四节齐全、节名同信息栏', c.secs.map((x) => x.title).join('|') === '实时状态|轨道根数（开普勒）|天线|模型', c.secs.map((x) => x.title).join('|'))
  ok('③ 徽标：NORAD / 区制 / 卫星组', c.badges.map((x) => x.v).join(',') === '55179,LEO,OneWeb')
  const live = c.secs[0].rows
  ok('③ 实时状态：纬度 φ 经度 λ 轨道高度 h 对地速度 惯性速度 轨迹周期', live.map((x) => x.k + (x.s ? ' ' + x.s : '')).join('|') === '纬度 φ|经度 λ|轨道高度 h|对地速度|惯性速度|轨迹周期')
  ok('③ 西经：数值取绝对值、单位 °W；数值与单位都带定宽模板', live[1].v === '118.72' && live[1].u === '°W' && live[1].tv === '000.00' && live[1].tu.includes('°E'))
  ok('③ 轨迹周期分段：圈数 + 小号「圈」 + 时长，单位 h', Array.isArray(live[5].v) && live[5].v.map((q) => q.t).join(' ') === '1.5 圈 · 2.73' && live[5].v[1].f && live[5].u === 'h')
  const el = c.secs[1].rows
  ok('③ 轨道根数：a e i Ω ω M ┆ n T 近 远 ┆ 历元 历元龄', el.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' ') === 'a e i Ω ω M ┆ n T 近地点高度 远地点高度 ┆ 历元 历元龄', el.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' '))
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
  ok('③ 只勾 i、M、历元龄：组间点线照留（经典根数 ┆ 历元）', g.map((r) => (r.hr ? '┆' : (r.s || r.k))).join(' ') === 'i M ┆ 历元龄')
  const E = (zh, en) => en
  const ce = buildHudBlocks({ items: items({ sat: { on: true, pos: 'tl', f: allOn() } }) }, { tz: 'utc', sats: [{ ...ONEWEB, name: '中星26', nameEn: 'CS26', group: '其他', groupEn: 'Other' }] }, E)[0].card
  ok('③ 英文：标签换英文、符号不变、星名 / 内置组名取译名', ce.name === 'CS26' && ce.badges[2].v === 'Other' && ce.secs[0].rows[0].k === 'Latitude' && ce.secs[0].rows[0].s === 'φ' && ce.secs[1].title === 'Orbital Elements (Keplerian)' && ce.secs[1].rows.find((r) => r.s === 'n').u === 'rev/day')
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

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
