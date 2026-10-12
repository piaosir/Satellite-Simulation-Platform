// 中国卫通测控星历报文（.eph，「地固坐标系瞬根」）+ 文本编码 + 状态序列整理的回归网。
//
// 夹具是【合成】的：版式逐字节照实物 6C-20260930.eph（表头四行、GBK、CRLF、Delphi 指数体例、零点那一行
// 「00:00:00 」只空一格、机动处「开始行 → 结束行 → 结束行重印」），数值来自一颗合成的 GEO 圆轨道（TEME 里
// 解析推进，再按 GMST 转到地固系）——实物是运营商的精密星历，不进仓库。实物本身的逐字节回环在开发时
// 实测过（4955489 字节一致，见 docs/中国卫通星历适配与星历导入导出_2026-10-12.md）。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const TC = require('../utils/textCodec.js')
const CS = require('../utils/csEph.js')
const EF = require('../utils/ephemFormats.js')
const EI = require('../utils/ephemInterp.js')
const NZ = require('../utils/ephemNormalize.js')
const FR = require('../utils/frames.js')
const T = require('../utils/timeSystems.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

/* ===================== 合成夹具 ===================== */
const MU = 398600.4418, R = 42164.17, NN = Math.sqrt(MU / (R * R * R)), INC = 0.05 * Math.PI / 180
const T0 = Date.UTC(2026, 8, 30, 23, 55, 0)
function teme(ms) {
  const u = NN * (ms - T0) / 1000 + 2.3
  const ci = Math.cos(INC), si = Math.sin(INC)
  return { p: { x: R * Math.cos(u), y: R * Math.sin(u) * ci, z: R * Math.sin(u) * si }, v: { x: -R * NN * Math.sin(u), y: R * NN * Math.cos(u) * ci, z: R * NN * Math.cos(u) * si } }
}
function ecef(ms) {
  const s = teme(ms)
  const g = sat.gstime(new Date(ms)), cT = T.julianCenturiesTT(ms)
  const p = FR.temeToEcef(s.p, g)
  const v = FR.velFromTeme(s.v, s.p, 'FIXED', cT, g)
  return [p.x * 1000, p.y * 1000, p.z * 1000, v.x * 1000, v.y * 1000, v.z * 1000]
}
// 版式按实物的规则独立再写一遍（不调被测的序列化器）
const dexp = (x) => { if (x === 0) return ' 0.00000000000000E+0000'; const m = /^(\d\.\d{14})e([+-])(\d+)$/.exec(Math.abs(x).toExponential(14)); return (x < 0 ? '-' : ' ') + m[1] + 'E' + m[2] + m[3].padStart(4, '0') }
const p2 = (n) => String(n).padStart(2, '0')
function tfield(ms) {
  const d = new Date(ms)
  const date = d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate()
  if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds()) return date + ' 00:00:00 '
  return date + ' ' + d.getUTCHours() + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + '  '
}
const line = (ms, vals) => tfield(ms) + vals.map(dexp).join('  ') + '  '
const HDR = [
  '_'.repeat(49) + '%'.repeat(14) + '_'.repeat(41),
  ' '.repeat(40),
  '_'.repeat(49) + '地固坐标系瞬根' + '_'.repeat(41) + '2026/9/30 14:59:20',
  '_______Time(UTC)_______________X_________________________Y________________________Z________________________dX_______________________dY_______________________dZ___________'
]
// 23:55 → 00:05（跨零点）→ 00:05:18 机动开始 → 600 s 后 00:15:18 机动结束（重印一行）→ 每 60 s 到 00:25:18 → 末行 00:26:00
const times = []
for (let k = 0; k <= 10; k++) times.push(T0 + k * 60000)
const MAN0 = Date.UTC(2026, 9, 1, 0, 5, 18), MAN1 = MAN0 + 600000
times.push(MAN0, MAN1, MAN1)
for (let k = 1; k <= 10; k++) times.push(MAN1 + k * 60000)
const TEND = Date.UTC(2026, 9, 1, 0, 26, 0)
times.push(TEND)
const DATA = times.map((ms) => line(ms, ecef(ms)))
const FIX_TEXT = HDR.concat(DATA).join('\r\n') + '\r\n'
const FIX_BYTES = TC.encodeGbk(FIX_TEXT).bytes

/* ===================== 编码 ===================== */
section('编码')
{
  const d = TC.decodeText(FIX_BYTES)
  ok(d.encoding === 'gb18030', 'GBK 文本识别为 gb18030', d.encoding)
  ok(d.text === FIX_TEXT, 'GBK 解码还原原文')
  ok(Buffer.compare(Buffer.from(TC.encodeGbk(d.text).bytes), Buffer.from(FIX_BYTES)) === 0, 'GBK 编码回写逐字节一致')
  ok(TC.decodeText(Buffer.from('﻿abc', 'utf8')).text === 'abc', 'UTF-8 BOM 剥掉')
  ok(TC.decodeText(Buffer.from('中星6C', 'utf8')).encoding === 'utf-8', '合法 UTF-8 按 UTF-8 认')
  ok(TC.decodeText(Buffer.from([0xFF, 0xFE, 0x41, 0x00])).text === 'A', 'UTF-16LE BOM')
  ok(TC.gbkWidth('地固坐标系瞬根') === 14 && TC.gbkWidth('%%') === 2, 'GBK 显示宽度')
  const mix = '中星6C · ZHONGXING-6C'
  ok(new TextDecoder('gbk').decode(TC.encodeGbk(mix).bytes) === mix && TC.encodeGbk(mix).unmapped === 0, '中英混排 GBK 往返')
  ok(TC.encodeGbk('😀').unmapped === 1, '表外字符计数（写成 ?）')
}

/* ===================== 嗅探与解析 ===================== */
section('嗅探与解析')
const parsed = EF.parseEphemeris(TC.decodeText(FIX_BYTES).text, null, { name: '6C-20261001' })
const S = parsed.sats[0]
{
  ok(EF.detectFormat(FIX_TEXT) === 'cs-eph', 'detectFormat = cs-eph', EF.detectFormat(FIX_TEXT))
  ok(parsed.format === 'cs-eph' && !parsed.errors.length, '解析无错', JSON.stringify(parsed.errors))
  ok(parsed.warnings.length === 0, '规范文件不出告警', JSON.stringify(parsed.warnings))
  ok(S.name === '6C-20261001', '标题是占位符 → 用文件名', S.name)
  ok(S.frame === 'FIXED', '帧 = 地固（表头「地固坐标系瞬根」）', S.frame)
  ok(S.interp.method === 'hermite', '带速度 → Hermite', S.interp.method)
  ok(S.meta.unitPos === 'm' && S.meta.unitVel === 'm/s', '单位 m / m/s（按量级与差分判）', S.meta.unitPos + ' / ' + S.meta.unitVel)
  ok(S.meta.timeScale === 'UTC', '时标 UTC')
  ok(S.meta.kinematic.frame === 'FIXED' && S.meta.kinematic.ratio > 100, '动力学判据：地固（惯性残差 / 地固残差 > 100）', JSON.stringify(S.meta.kinematic))
  ok(S.meta.created === '2026/9/30 14:59:20', '生成时刻剥出', S.meta.created)
  ok(S.t.length === times.length, '重复行成段界：两行都留（后一个顺延 1 ms）', S.t.length + ' vs ' + times.length)
  ok(S.spans && S.spans.length === 2 && S.spans[0][1] === MAN1 && S.spans[1][0] === MAN1 + 1, '机动结束处拆两段', JSON.stringify(S.spans))
  ok(S.meta.gaps.length === 1 && S.meta.gaps[0].dtS === 600 && !S.meta.gaps[0].split, '600 s 机动窗口记为间断、可桥接（GEO Hermite 误差 < 1 km）', JSON.stringify(S.meta.gaps))
  ok(S.meta.dupTimes.length === 1 && S.meta.dupTimes[0] === MAN1, '原文重印行记账', JSON.stringify(S.meta.dupTimes))
  // 数值：位置 km、速度 km/s，与夹具逐值一致（m → km 除 1000）
  const e0 = ecef(T0)
  near(S.p[0], e0[0] / 1000, 1e-10, 'X[0] km（15 位有效数字的打印分辨率 1e-10 km）')
  near(S.v[2], e0[5] / 1000, 1e-15, 'dZ[0] km/s')
}

/* ===================== 写出：逐字节 ===================== */
section('写出')
{
  const out = EF.serializeEphemeris([S], 'cs-eph', { header: S.meta.header, dupTimes: S.meta.dupTimes })
  ok(out === FIX_TEXT, '原表头复用：文本逐字节等于夹具')
  ok(Buffer.compare(Buffer.from(TC.encodeGbk(out).bytes), Buffer.from(FIX_BYTES)) === 0, 'GBK 字节逐字节等于夹具')
  const gen = CS.serializeCsEph(S, { title: '%'.repeat(14), createdMs: Date.UTC(2026, 8, 30, 6, 59, 20) })
  const gl = gen.split('\r\n'), fl = FIX_TEXT.split('\r\n')
  ok(gl.length === fl.length && gl[0] === fl[0] && gl[1] === fl[1] && gl[3] === fl[3], '新生成表头：第 1/2/4 行与样本版式一致')
  ok(gl[2].startsWith('_'.repeat(49) + '地固坐标系瞬根' + '_'.repeat(41)), '第 3 行帧标题与下划线宽度一致')
  ok(gl.slice(4).join('\n') === fl.slice(4).join('\n'), '数据行逐字节一致（含零点那行、机动重印行）')
  ok(fl.some((l) => / 00:00:00 -?\d|00:00:00  /.test(l)) && gen.includes('2026/10/1 00:00:00 '), '零点行「00:00:00」后只空一格')
  // Delphi 指数体例的几个边角
  ok(CS.delphiExp(0) === ' 0.00000000000000E+0000', '零')
  ok(CS.delphiExp(-1.5e-7) === '-1.50000000000000E-0007', '负的小数')
  ok(CS.delphiExp(42164170.123) === ' 4.21641701230000E+0007', '正的大数')
  let threw = ''
  try { CS.serializeCsEph(Object.assign({}, S, { frame: 'J2000' })) } catch (e) { threw = e.message }
  ok(/只写地固系/.test(threw), '非地固帧直接写 .eph 点名拒绝（调用方须先换帧）', threw)
  // 别的格式经 serializeEphemeris 写 .eph：自动换到地固系
  const temeSat = EF.convertSat(S, 'TEME')
  const viaTeme = EF.serializeEphemeris([temeSat], 'cs-eph', { header: S.meta.header })
  const back = EF.parseEphemeris(viaTeme).sats[0]
  let dmax = 0
  for (let i = 0; i < S.p.length; i++) dmax = Math.max(dmax, Math.abs(back.p[i] - S.p[i]))
  ok(dmax < 1e-9, 'TEME 源写成 .eph 再读回：位置差 < 1e-9 km', dmax)
}

/* ===================== 插值表 ===================== */
section('建表与取位')
{
  const tab = EI.buildTable(S)
  ok(tab && tab.n === S.t.length && tab.method === 'hermite', '建表：点数不变、Hermite')
  // 合成轨道是解析的：任意时刻插值 vs 真值（TEME）
  let worst = 0
  for (let ms = T0 + 30000; ms < TEND; ms += 37000) {
    const r = EI.evalTable(tab, ms), tr = teme(ms)
    worst = Math.max(worst, Math.hypot(r.x - tr.p.x, r.y - tr.p.y, r.z - tr.p.z))
  }
  ok(worst < 1e-3, '60 s 采样 + 600 s 机动缺口：插值误差 < 1 m', worst)
}

/* ===================== 鲁棒性：各种变体 ===================== */
section('变体')
{
  // ① 没有表头，只有数据行：地固系按动力学判
  const r1 = EF.parseEphemeris(DATA.join('\n'))
  ok(r1.format === 'cs-eph' && r1.sats.length === 1 && r1.sats[0].frame === 'FIXED', '无表头：照认、按动力学判地固', r1.format + ' / ' + (r1.sats[0] && r1.sats[0].frame))
  ok(r1.sats[0].meta.headerless === true, '记 headerless')
  // ② km 与 km/s（量级判），Tab 分隔、LF 行尾、带小数秒、短横日期
  const kmLines = times.slice(0, 11).map((ms) => {
    const v = ecef(ms).map((x) => x / 1000)
    const d = new Date(ms)
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.000\t` + v.map((x) => x.toExponential(10)).join('\t')
  })
  const r2 = EF.parseEphemeris(HDR.join('\n') + '\n' + kmLines.join('\n') + '\n')
  ok(r2.sats[0] && r2.sats[0].meta.unitPos === 'km' && r2.sats[0].meta.unitVel === 'km/s', 'km / km/s 自动认', r2.sats[0] && r2.sats[0].meta.unitPos + ' ' + r2.sats[0].meta.unitVel)
  near(r2.sats[0].p[0], ecef(T0)[0] / 1000, 1e-6, '数值不受单位影响')
  // ③ 北京时：减 8 h
  const bjt = HDR.slice(0, 3).concat([HDR[3].replace('Time(UTC)', 'Time(BJT)')]).concat(DATA).join('\r\n')
  const r3 = EF.parseEphemeris(bjt)
  ok(r3.sats[0].t[0] === T0 - 8 * 3600000, '北京时表头：时刻减 8 h', r3.sats[0].t[0] - T0)
  // ④ 位置 m、速度却给 km/s（单位不配套）：按差分标定
  const mixLines = times.slice(0, 11).map((ms) => { const v = ecef(ms); return line(ms, [v[0], v[1], v[2], v[3] / 1000, v[4] / 1000, v[5] / 1000]) })
  const r4 = EF.parseEphemeris(HDR.join('\r\n') + '\r\n' + mixLines.join('\r\n'))
  ok(r4.sats[0].meta.unitVel === 'km/s', '速度单位按位置差分标定', r4.sats[0].meta.unitVel)
  near(r4.sats[0].v[0], ecef(T0)[3] / 1000, 1e-15, '标定后速度值正确')
  // ⑤ 速度列是垃圾：忽略速度、退 Lagrange，告警
  const junk = times.slice(0, 11).map((ms, i) => { const v = ecef(ms); return line(ms, [v[0], v[1], v[2], 1e3 * Math.sin(i), 7, -3]) })
  const r5 = EF.parseEphemeris(HDR.join('\r\n') + '\r\n' + junk.join('\r\n'))
  ok(!r5.sats[0].v && r5.sats[0].interp.method === 'lagrange', '速度列不可信：丢速度、走 Lagrange')
  ok(r5.warnings.some((w) => /速度/.test(w)), '并点名告警', JSON.stringify(r5.warnings))
  // ⑥ 坏行与乱序：跳过并点名、按时刻重排
  const shuffled = DATA.slice(0, 11)
  ;[shuffled[3], shuffled[4]] = [shuffled[4], shuffled[3]]
  shuffled.splice(6, 0, '2026/10/1 0:1x:00  1 2 3 4 5 6', '2026/13/1 0:00:00  1 2 3 4 5 6')
  const r6 = EF.parseEphemeris(HDR.join('\r\n') + '\r\n' + shuffled.join('\r\n'))
  ok(r6.sats.length === 1 && r6.sats[0].t.length === 11, '坏行跳过、其余 11 行都在', r6.sats[0] && r6.sats[0].t.length)
  ok(r6.warnings.some((w) => /无法解析/.test(w)) && r6.warnings.some((w) => /不单调/.test(w)), '坏行与乱序都点名', JSON.stringify(r6.warnings))
  for (let i = 1; i < r6.sats[0].t.length; i++) if (!(r6.sats[0].t[i] > r6.sats[0].t[i - 1])) { ok(false, '重排后严格递增'); break }
  // ⑦ 同一时刻两个不同状态（脉冲机动）：拆段、两状态都留
  const j = DATA.slice(0, 11)
  const vv = ecef(times[5]); vv[3] += 0.5
  j.splice(6, 0, line(times[5], vv))
  const r7 = EF.parseEphemeris(HDR.join('\r\n') + '\r\n' + j.join('\r\n'))
  ok(r7.sats[0].spans && r7.sats[0].spans.length === 2 && r7.sats[0].meta.jumps.length === 1, '脉冲机动：两段 + 一次跳变', JSON.stringify(r7.sats[0].meta.jumps))
  near(r7.sats[0].meta.jumps[0].dvKmps, 0.5e-3, 1e-12, '跳变量 = 0.5 m/s')
  // ⑧ 大缺口（6 h，GEO Hermite 估计误差 670 km）：拆段，不桥接
  const big = DATA.slice(0, 6).concat(times.slice(0, 6).map((ms) => line(ms + 6 * 3600000, ecef(ms + 6 * 3600000))))
  const r8 = EF.parseEphemeris(HDR.join('\r\n') + '\r\n' + big.join('\r\n'))
  ok(r8.sats[0].spans && r8.sats[0].spans.length === 2 && r8.sats[0].meta.gaps.some((g) => g.split), '6 h 缺口拆段', JSON.stringify(r8.sats[0].meta.gaps.map((g) => [g.dtS, g.split])))
  // ⑨ 表头写着惯性系、数据却是地固：按动力学改判并告警
  const lie = [HDR[0], HDR[1], HDR[2].replace('地固坐标系瞬根', 'J2000坐标系瞬根'), HDR[3]].concat(DATA).join('\r\n')
  const r9 = EF.parseEphemeris(lie)
  ok(r9.sats[0].frame === 'FIXED' && r9.warnings.some((w) => /动力学/.test(w)), '表头与数据矛盾：按动力学改判地固', r9.sats[0].frame + ' ' + JSON.stringify(r9.warnings))
  // ⑩ 惯性系变体（J2000 表头 + 惯性数据）
  const inLines = times.slice(0, 11).map((ms) => { const s = teme(ms); return line(ms, [s.p.x * 1000, s.p.y * 1000, s.p.z * 1000, s.v.x * 1000, s.v.y * 1000, s.v.z * 1000]) })
  const r10 = EF.parseEphemeris([HDR[0], HDR[1], HDR[2].replace('地固坐标系瞬根', 'J2000坐标系瞬根'), HDR[3]].concat(inLines).join('\r\n'))
  ok(r10.sats[0].frame === 'J2000' && !r10.warnings.length, 'J2000 表头 + 惯性数据：按 J2000', r10.sats[0].frame + ' ' + JSON.stringify(r10.warnings))
  // ⑪ 瞬时根数变体：a e i Ω ω M（度）→ 二体换算成状态矢量
  const el = { a: 42164.17, e: 0.0003, i: 0.05, O: 10, w: 20 }
  const elLines = times.slice(0, 11).map((ms) => {
    const M = (NN * (ms - T0) / 1000 * 180 / Math.PI + 5) % 360
    return tfield(ms) + [el.a, el.e, el.i, el.O, el.w, M].map((x) => x.toFixed(10)).join('  ')
  })
  const r11 = EF.parseEphemeris(['_'.repeat(49) + 'J2000惯性系瞬根' + '_'.repeat(41), '_______Time(UTC)______a(km)_____e______i______Ω______ω______M___'].concat(elLines).join('\r\n'))
  ok(r11.format === 'cs-eph' && r11.sats[0] && r11.sats[0].meta.elements === true && r11.sats[0].frame === 'J2000', '瞬时根数变体：识别并按 J2000', JSON.stringify(r11.errors))
  const st0 = CS.keplerToState(el.a, el.e, el.i * Math.PI / 180, el.O * Math.PI / 180, el.w * Math.PI / 180, 5 * Math.PI / 180, true)
  near(r11.sats[0].p[0], st0.p[0], 1e-9, '根数换算位置 X')
  // ⑫ 平根报文：点名拒收
  const r12 = EF.parseEphemeris(['_'.repeat(49) + 'J2000平根' + '_'.repeat(41), '_______Time(UTC)______a_____e______i______Ω______ω______M___'].concat(elLines).join('\r\n'))
  ok(r12.sats.length === 0 && r12.errors.some((e) => /平根/.test(e)), '平根数拒收', JSON.stringify(r12.errors))
  // ⑬ 不是这种格式的东西不误认
  ok(EF.detectFormat('OBJECT_NAME,OBJECT_ID,EPOCH\nISS,1998-067A,2026-01-01T00:00:00') !== 'cs-eph', 'OMM CSV 不误认')
  ok(EF.detectFormat('1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004') !== 'cs-eph', 'TLE 不误认')
  ok(EF.detectFormat('hello\n2026/9/30 1:17:00 1 2 3') === '', '前面有别的文字、又没有表头：不认')
}

/* ===================== 表头：标题含泛称 / 口径记账 / 报错只陈述状态 ===================== */
section('表头')
{
  // 标题写成「中星6C星历」「ZX6C轨道根数」：标题是标题，第 3 行才是坐标系行（帧、生成时刻都在那一行）
  for (const title of ['中星6C星历', 'ZX6C轨道根数']) {
    const h0 = '_'.repeat(49) + title + '_'.repeat(Math.max(1, 55 - TC.gbkWidth(title)))
    const r = EF.parseEphemeris([h0].concat(HDR.slice(1)).concat(DATA).join('\r\n') + '\r\n', null, { name: 'file' })
    const s = r.sats[0]
    ok(s && s.name === title && s.meta.title === title, '标题「' + title + '」→ 星名', s && s.name)
    ok(s && s.frame === 'FIXED' && s.meta.frameText === '地固坐标系瞬根' && s.meta.created === '2026/9/30 14:59:20', '标题「' + title + '」：坐标系行与生成时刻照认', s && JSON.stringify([s.frame, s.meta.frameText, s.meta.created]))
    ok(!r.warnings.length, '标题「' + title + '」：不误报「表头未标坐标系」', JSON.stringify(r.warnings))
  }
  // 原表头口径记账（同格式导出决定能否复用原表头）：时标 / 单位 / 列布局
  ok(S.meta.colsStd === true, '标准六列表头：colsStd')
  const three = times.slice(0, 11).map((ms) => { const v = ecef(ms); return line(ms, [v[0], v[1], v[2]]) })
  const r3c = EF.parseEphemeris([HDR[0], HDR[1], HDR[2], '_______Time(UTC)_______________X_________________________Y________________________Z___________'].concat(three).join('\r\n'))
  ok(r3c.sats[0] && r3c.sats[0].meta.colsStd === false && !r3c.sats[0].v, '只有 X Y Z 三列：colsStd = false', r3c.sats[0] && String(r3c.sats[0].meta.colsStd))
  // 报错只陈述状态
  const elLine = (ms) => tfield(ms) + [42164.17, 0.0003, 0.05, 10, 20, 5].map((x) => x.toFixed(10)).join('  ')
  const rFix = EF.parseEphemeris(['_'.repeat(49) + '地固坐标系瞬时根数' + '_'.repeat(41), '_______Time(UTC)______a(km)_____e______i______Ω______ω______M___'].concat(times.slice(0, 11).map(elLine)).join('\r\n'))
  ok(rFix.sats.length === 0 && rFix.errors[0] === '瞬时根数报文的表头为地固系，不受支持', '根数配地固系表头：拒收，报错只陈述状态', JSON.stringify(rFix.errors))
  const rMean = EF.parseEphemeris(['_'.repeat(49) + 'J2000平根' + '_'.repeat(41), '_______Time(UTC)______a_____e______i______Ω______ω______M___'].concat(times.slice(0, 11).map(elLine)).join('\r\n'))
  ok(rMean.errors[0] === '平根数报文不受支持（J2000平根）', '平根报文：报错只陈述状态', JSON.stringify(rMean.errors))
}

/* ===================== 整理器单测 ===================== */
section('ephemNormalize')
{
  const rows = [{ ms: 0, p: [7000, 0, 0], v: [0, 7.5, 0] }, { ms: 60000, p: [6990, 450, 0], v: [-0.5, 7.4, 0] }, { ms: 60000, p: [6990, 450, 0], v: [-0.5, 7.4, 0] }, { ms: 120000, p: [6960, 900, 0], v: [-1, 7.3, 0] }]
  const a = NZ.normalizeRows(rows, {})
  ok(a.t.length === 3 && !a.spans && a.report.dupTimes.length === 1, '状态相同的重复行：并成一行、不拆段（dupIsBoundary 关）')
  const b = NZ.normalizeRows(rows, { dupIsBoundary: true })
  ok(b.t.length === 4 && b.spans && b.spans.length === 2 && b.t[2] === 60001, '状态相同的重复行：按格式约定当段界（顺延 1 ms）')
  const c = NZ.normalizeRows(rows.map((r, i) => (i === 1 ? Object.assign({}, r, { cut: false }) : r)), { boundaries: [120000] })
  ok(c.spans === null || c.spans.length >= 1, '显式段界落在末行：不出空段')
  ok(NZ.bridgeErrKm(600, 42164) < 1 && NZ.bridgeErrKm(6 * 3600, 42164) > 100, '桥接误差估计：GEO 10 min 可桥、6 h 不可')
  const kin = NZ.kinematicFrame(S.t, S.p)
  ok(kin.frame === 'FIXED', 'kinematicFrame 认地固', JSON.stringify(kin))
  const tt = EI.buildTable(S)
  ok(NZ.kinematicFrame(tt.t, tt.p).frame === 'INERTIAL', '同一份数据换到 TEME：认惯性')
}

console.log('\ncsEph: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
