// 卫通 / 亚太共位星对：SGP4 推 3 天，最小星间距离、径向 / 法向分离（RIC），说明共位分析的现实需求
const path = require('path'), zlib = require('zlib'), fs = require('fs')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const csv = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'resources/omm/csv_geo.csv.gz'))).toString('utf8')
const lines = csv.split(/\r?\n/).filter(Boolean), head = lines[0].split(','), ix = (k) => head.indexOf(k)
const by = {}
for (const l of lines.slice(1)) { const f = l.split(','); by[f[ix('OBJECT_NAME')]] = { noradId: f[ix('NORAD_CAT_ID')], epoch: f[ix('EPOCH')], meanMotion: +f[ix('MEAN_MOTION')], ecc: +f[ix('ECCENTRICITY')], incl: +f[ix('INCLINATION')], raan: +f[ix('RA_OF_ASC_NODE')], argp: +f[ix('ARG_OF_PERICENTER')], ma: +f[ix('MEAN_ANOMALY')], bstar: +f[ix('BSTAR')], mdot: +f[ix('MEAN_MOTION_DOT')], mddot: +f[ix('MEAN_MOTION_DDOT')] } }
const pairs = [['APSTAR-6D', 'APSTAR-6E'], ['APSTAR-6C', 'APSTAR-6D'], ['ZHONGXING-10R', 'CHINASAT 16 (SJ-13)'], ['ZHONGXING-2A', 'ZHONGXING-2E'], ['ZHONGXING-2E', 'ZHONGXING-11'], ['ZHONGXING-26', 'ZHONGXING-6D'], ['ZHONGXING-1D', 'ZHONGXING-2D'], ['ZHONGXING-3A', 'CHINASAT 9B']]
const t0 = Date.parse('2026-10-16T00:00:00Z')
for (const [a, b] of pairs) {
  if (!by[a] || !by[b]) { console.log('缺 ' + a + ' / ' + b); continue }
  const ra = sat.omm2satrec(by[a]), rb = sat.omm2satrec(by[b])
  let dmin = Infinity, tmin = 0, Rmin = Infinity, Cmax = 0
  for (let k = 0; k <= 3 * 1440; k += 2) {
    const d = new Date(t0 + k * 60e3)
    const pa = sat.propagate(ra, d), pb = sat.propagate(rb, d)
    const r = pa.position, v = pa.velocity, s = pb.position
    const dr = [s.x - r.x, s.y - r.y, s.z - r.z], dist = Math.hypot(...dr)
    const rn = Math.hypot(r.x, r.y, r.z), R = [r.x / rn, r.y / rn, r.z / rn]
    const h = [r.y * v.z - r.z * v.y, r.z * v.x - r.x * v.z, r.x * v.y - r.y * v.x], hn = Math.hypot(...h), C = h.map((x) => x / hn)
    const dR = dr[0] * R[0] + dr[1] * R[1] + dr[2] * R[2], dC = dr[0] * C[0] + dr[1] * C[1] + dr[2] * C[2]
    if (dist < dmin) { dmin = dist; tmin = k }
    Cmax = Math.max(Cmax, Math.abs(dC))
  }
  console.log((a + ' × ' + b).padEnd(40), '3 天内最小距离 ' + dmin.toFixed(1) + ' km（第 ' + (tmin / 60).toFixed(1) + ' h），最大法向分离 ' + Cmax.toFixed(1) + ' km')
}
