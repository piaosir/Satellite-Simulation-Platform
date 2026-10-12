// 信息栏扩展读数的取数与格式化（src/viz/constellation/satStateCard.js）：信息栏与视频叠加共用的那一份串。
//   ① 状态矢量 / 密切根数：位数口径、负零、帧名；复制文本全精度、与 stateVector 逐位一致
//   ② 同步轨道：真 GEO 根数 → 平经度 / 偏差 / 漂移率 / 两个矢量；保持范围越界按日轨迹极值判
//   ③ 日轨迹图几何：刻度落在版心内、路径闭合、保持框居中、当前点在图内
//   ④ 相对状态：A 相对 B 与 B 相对 A 的距离相等、距离变化率相等；同一颗星距离为零
//   ⑤ 星历信息：SGP4 / SDP4 判别、Kozai 平均运动、B*、点序列表与定点
import sat from '../../../src/viz/constellation/satellite.js'
import { stateCard, stateVectorText, syncCard, syncRaw, syncPlot, relCard, ephemInfo, fx, niceStep, FRAME_LABEL } from '../../../src/viz/constellation/satStateCard.js'
import { stateVector, frameContext } from '../../../src/shared/orbitState.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)

const LEO = { rec: sat.twoline2satrec('1 25544U 98067A   26284.50000000  .00012000  00000-0  21000-3 0  9990', '2 25544  51.6400 120.0000 0003000  90.0000 270.0000 15.50000000400000'), name: 'ISS', noradId: '25544' }
const GEO = { rec: sat.twoline2satrec('1 44067U 19012A   26280.50000000 -.00000300  00000-0  00000+0 0  9990', '2 44067   0.0400  85.0000 0002000 300.0000  60.0000  1.00270000 20000'), name: 'GEO-T', noradId: '44067' }
const T0 = Date.UTC(2026, 9, 12, 3, 4, 5)

section('① 状态矢量 / 密切根数')
{
  const c = stateCard(LEO, T0, { sv: 'J2000', osc: 'TEME' })
  ok(c && c.sv && c.osc, '两块都取得到')
  ok(c.sv.frame === 'J2000' && c.osc.frame === 'TEME' && FRAME_LABEL.FIXED === 'ECEF', '帧名')
  ok(/^-?\d+\.\d{3}$/.test(c.sv.x) && /^-?\d+\.\d{6}$/.test(c.sv.vx) && /^\d+\.\d{3}$/.test(c.sv.r), '位置 3 位、速度 6 位、地心距 3 位', JSON.stringify(c.sv))
  ok(/^\d+\.\d{7}$/.test(c.osc.e) && /^\d+\.\d{4}$/.test(c.osc.i) && /^\d+\.\d{4}$/.test(c.osc.raan) && /^\d+\.\d{3}$/.test(c.osc.a), '偏心率 7 位、角度 4 位、半长轴 3 位', JSON.stringify(c.osc))
  ok(Math.abs(Number(c.osc.i) - 51.64) < 0.2, `密切倾角 ≈ 平倾角（${c.osc.i}）`)
  ok(fx(-1e-9, 3) === '0.000' && fx(-0.0004, 3) === '0.000' && fx(-0.0006, 3) === '-0.001' && fx(NaN, 3) === '', '负零不出「-0.000」')
  const only = stateCard(LEO, T0, { sv: 'FIXED', osc: null })
  ok(only.sv && only.osc === null && only.sv.frame === 'FIXED', '只要一块就只算一块')
  // 复制文本：表头 + 一行，数值全精度、与 stateVector 逐位一致
  for (const f of ['FIXED', 'J2000', 'TEME']) {
    const txt = stateVectorText(LEO, T0, f, false), [h, row] = txt.split('\n')
    const v = row.split('\t')
    const sv = stateVector(sat.propagate(LEO.rec, new Date(T0)), f, frameContext(T0, sat.gstime))
    ok(h.split('\t').length === 8 && v.length === 8 && v[0] === new Date(T0).toISOString() && v[1] === FRAME_LABEL[f], `复制（${f}）：8 列、UTC ISO、帧名`)
    ok(Number(v[2]) === sv.r.x && Number(v[4]) === sv.r.z && Number(v[5]) === sv.v.x && Number(v[7]) === sv.v.z, `复制（${f}）：数值逐位还原`)
  }
  ok(stateVectorText(LEO, T0, 'J2000', true).startsWith('Time (UTC)\tFrame\tX (km)'), '英文表头')
  const pin = { rec: { ...LEO.rec, __fix: { r: [7000, 0, 0], sync: false } }, name: 'P' }
  const cp = stateCard(pin, T0, { sv: 'FIXED', osc: 'J2000' })
  ok(cp && cp.sv && cp.osc === null && Math.abs(Number(cp.sv.x) - 7000) < 1e-9 && cp.sv.vx === '0.000000', '非同步定点：地固位置恒定、速度 0，不出密切根数')
}

section('② 同步轨道')
{
  const t = Date.UTC(2026, 9, 8)
  const raw = syncRaw(GEO, t)
  ok(raw && raw.track.length === 72, '窗口平均取得到（72 点）')
  ok(syncRaw(GEO, t + 20000) === raw, '同一分钟档命中缓存（不重算 72 次取位）')
  const nom = Math.round(raw.lonMean * 10) / 10
  const c = syncCard(GEO, t, nom, { ew: 0.1, ns: 0.1 })
  ok(c.lon === fx(Math.abs(raw.lonMean), 4) && c.lonH === (raw.lonMean < 0 ? '°W' : '°E'), '平经度：绝对值 4 位 + 半球')
  ok(/^[+-]?\d+\.\d{4}$/.test(c.dlon) && (Number(c.dlon) === 0 || /^[+-]/.test(c.dlon)), '经度偏差带正负号', c.dlon)
  ok(/^[+-]\d+\.\d{4}$/.test(c.drift), '漂移率带正负号', c.drift)
  ok(c.e === fx(raw.e, 7) && c.ix === fx(raw.ix, 4), '矢量读数同源')
  ok(!c.ewOut && !c.nsOut, '定点附近、倾角 0.03°：都在 ±0.1° 内')
  const far = syncCard(GEO, t, nom + 0.3, { ew: 0.1, ns: 0.1 })
  ok(far.ewOut && !far.nsOut && Math.abs(Number(far.dlon) + 0.3) < 0.06, '标称经度挪开 0.3°：经度越界着色、纬度不越界')
  const tight = syncCard(GEO, t, nom, { ew: 0.1, ns: 0.01 })
  ok(tight.nsOut, '纬度范围收到 0.01°（小于倾角）：纬度越界')
  const off = syncCard(GEO, t, nom, { ew: 0, ns: 0 })
  ok(!off.ewOut && !off.nsOut, '保持范围 0 = 不设：不着色')
  const noNom = syncCard(GEO, t, null, { ew: 0.1, ns: 0.1 })
  ok(noNom.dlon === '' && !noNom.ewOut, '没有标称经度：不出经度偏差、不判经度越界')
  ok(syncCard({ rec: { ...GEO.rec, __fix: { r: [7000, 0, 0], sync: false } } }, t, null, null) === null, '非同步定点：没有同步轨道参数')
}

section('③ 日轨迹图')
{
  const t = Date.UTC(2026, 9, 8)
  const raw = syncRaw(GEO, t), nom = Math.round(raw.lonMean * 10) / 10
  const W = 270, H = 136
  const p = syncPlot(raw, { lon: raw.track[36].lon, lat: raw.track[36].lat }, nom, { ew: 0.1, ns: 0.1 }, W, H)
  ok(p && p.path.startsWith('M') && !p.path.includes('Z') && (p.path.match(/L/g) || []).length === 71, '路径：72 点、不强行闭合（首尾开口 = 一日漂移）')
  {
    const tk = (s) => syncPlot(raw, { lon: raw.track[0].lon, lat: raw.track[0].lat }, nom, { ew: s, ns: s }, W, H).ticksX.map((q) => q.t)
    ok(tk(0.05).includes('0.025') && tk(0.5).includes('0.25'), '刻度 2.5 档多给一位小数（0.025 / 0.25 不被四舍五入成 0.03 / 0.3）', tk(0.05).join(' '))
  }
  const inX = (x) => x >= p.plot.x - 0.05 && x <= p.plot.x + p.plot.w + 0.05, inY = (y) => y >= p.plot.y - 0.05 && y <= p.plot.y + p.plot.h + 0.05
  ok(p.ticksX.every((q) => inX(q.x)) && p.ticksY.every((q) => inY(q.y)), '刻度都在版心内')
  ok(p.ticksX.length >= 3 && p.ticksY.length >= 3 && p.ticksX.some((q) => q.t === '0') && p.ticksY.some((q) => q.t === '0'), '两轴各至少三档、含 0')
  ok(p.box && Math.abs(p.box.x + p.box.w / 2 - p.ox) < 0.2 && Math.abs(p.box.y + p.box.h / 2 - p.oy) < 0.2, '保持框以标称点为中心')
  ok(p.dot && inX(p.dot.x) && inY(p.dot.y), '当前点在图内')
  ok(syncPlot(raw, null, null, null, 30, 30) === null, '太窄不画')
  const p2 = syncPlot(raw, null, null, { ew: 0.1, ns: 0.1 }, W, H)
  ok(p2 && p2.box === null, '没有标称经度：以平经度为中心、不画框')
  ok(niceStep(0.0509) === 0.05 && niceStep(0.13) === 0.1 && niceStep(0.023) === 0.025 && niceStep(3.7) === 5, '刻度步长取最近的 1 / 2 / 2.5 / 5 × 10ⁿ')
}

section('④ 相对状态')
{
  const ab = relCard(LEO, GEO, T0), ba = relCard(GEO, LEO, T0)
  ok(ab && ba && ab.range === ba.range && ab.rate === ba.rate, 'A→B 与 B→A：距离、距离变化率相等')
  ok(Math.abs(Number(ab.theta) - Number(ba.theta)) < 1e-9, '地心张角对称')
  const self = relCard(LEO, LEO, T0)
  ok(self.range === '0.000' && self.R === '0.000' && self.dR === '0.000000', '同一颗：全零（不出负零）')
  ok(/^\d+\.\d{3}$/.test(ab.range) && /^-?\d+\.\d{6}$/.test(ab.rate) && /^\d+\.\d{4}$/.test(ab.theta), '位数：距离 3 位、速率 6 位、角 4 位')
  const R2 = Number(ab.R) ** 2 + Number(ab.I) ** 2 + Number(ab.C) ** 2
  ok(Math.abs(Math.sqrt(R2) - Number(ab.range)) < 0.01, 'R² + I² + C² = 距离²')
}

section('⑤ 星历信息')
{
  const a = ephemInfo(LEO), b = ephemInfo(GEO)
  ok(a.kind === 'gp' && a.prop === 'SGP4' && b.prop === 'SDP4', '近地 SGP4、深空 SDP4')
  ok(a.n === '15.50000000' && b.n === '1.00270000', `平均运动还原 TLE 原文（${a.n} / ${b.n}）`)
  ok(a.bstar === '2.1000e-4' && b.bstar === '0', `B*（${a.bstar} / ${b.bstar}）`)
  const tab = { __ephem: true, n: 3, t: new Float64Array([0, 60000, 120000]), p: new Float64Array(9), method: 'hermite', samples: 2, t0: 0, t1: 120000, srcFrame: 'FIXED' }
  const e = ephemInfo({ eph: tab })
  ok(e.kind === 'ephem' && e.method === 'hermite' && e.n === 3 && e.frame === 'FIXED' && e.t1 === 120000, '点序列：插值方式 / 点数 / 时段 / 原帧')
  ok(ephemInfo({ rec: { ...GEO.rec, __fix: { r: [42164, 0, 0], sync: true } } }).kind === 'fix', '定点星')
}

console.log(`\nsatStateCard：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
