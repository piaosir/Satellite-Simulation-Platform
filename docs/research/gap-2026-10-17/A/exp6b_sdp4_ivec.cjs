// SDP4 对近零倾角 GEO 的倾角矢量自然漂移：随初始 RAAN 变化；再拿快照里真实 GEO 星（中星 / 倾斜运行的老星）看
const path = require('path'), zlib = require('zlib'), fs = require('fs')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const DEG = Math.PI / 180
const EPOCH = '2026-10-17T00:00:00.000Z', t0 = Date.parse(EPOCH)
function iVec(rec, ms) {
  let sx = 0, sy = 0, n = 0
  for (let k = 0; k < 48; k++) {
    const d = new Date(ms + k * 1795e3); const pv = sat.propagate(rec, d); if (!pv) continue
    const r = pv.position, v = pv.velocity
    const h = [r.y * v.z - r.z * v.y, r.z * v.x - r.x * v.z, r.x * v.y - r.y * v.x], hn = Math.hypot(...h)
    const hu = h.map((x) => x / hn), sinI = Math.hypot(hu[0], hu[1]), i = Math.atan2(sinI, hu[2]), fac = sinI > 1e-15 ? i / sinI : 1
    sx += -hu[1] * fac; sy += hu[0] * fac; n++
  }
  return [sx / n / DEG, sy / n / DEG]
}
console.log('— 合成星：i0 与 Ω0 扫描（Δi 矢量一年模长 / 方向）')
for (const i0 of [0.05, 1.0, 4.0]) {
  const row = []
  for (const O of [0, 90, 180, 270]) {
    const rec = sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: 1.00273122, ecc: 0.0001, incl: i0, raan: O, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
    const a = iVec(rec, t0), b = iVec(rec, t0 + 365.25 * 86400e3)
    row.push('Ω0=' + O + '°: ' + Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(3) + '° @' + (Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG).toFixed(0) + '°')
  }
  console.log('i0=' + i0 + '°  ' + row.join('  '))
}
// 真实 GEO：快照
const csv = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'resources/omm/csv_geo.csv.gz'))).toString('utf8')
const lines = csv.split(/\r?\n/).filter(Boolean)
const head = lines[0].split(',')
const ix = (k) => head.indexOf(k)
const recs = lines.slice(1).map((l) => l.split(',')).map((f) => ({ name: f[ix('OBJECT_NAME')], noradId: f[ix('NORAD_CAT_ID')], epoch: f[ix('EPOCH')], meanMotion: +f[ix('MEAN_MOTION')], ecc: +f[ix('ECCENTRICITY')], incl: +f[ix('INCLINATION')], raan: +f[ix('RA_OF_ASC_NODE')], argp: +f[ix('ARG_OF_PERICENTER')], ma: +f[ix('MEAN_ANOMALY')], bstar: +f[ix('BSTAR')], mdot: +f[ix('MEAN_MOTION_DOT')], mddot: +f[ix('MEAN_MOTION_DDOT')] }))
const pick = recs.filter((r) => /ZHONGXING|CHINASAT|APSTAR|TIANLIAN/i.test(r.name)).slice(0, 8)
console.log('— 快照真实星（历元处 i / Ω，SDP4 推一年后的 i 矢量变化）')
for (const r of pick) {
  const rec = sat.omm2satrec(r)
  const tE = (rec.jdsatepoch - 2440587.5) * 86400e3
  const a = iVec(rec, tE), b = iVec(rec, tE + 365.25 * 86400e3)
  console.log(r.name.padEnd(18), 'i=' + r.incl.toFixed(4), 'Ω=' + r.raan.toFixed(1), '→ 一年 Δi矢量 ' + Math.hypot(b[0] - a[0], b[1] - a[1]).toFixed(3) + '°')
}
