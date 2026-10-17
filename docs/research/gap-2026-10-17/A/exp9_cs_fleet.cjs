// 快照里中星 / 亚太星的倾角分布（历元处平根数）与定点经度
const path = require('path'), zlib = require('zlib'), fs = require('fs')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const csv = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'resources/omm/csv_geo.csv.gz'))).toString('utf8')
const lines = csv.split(/\r?\n/).filter(Boolean), head = lines[0].split(','), ix = (k) => head.indexOf(k)
const rows = lines.slice(1).map((l) => l.split(',')).filter((f) => /ZHONGXING|CHINASAT|APSTAR/i.test(f[ix('OBJECT_NAME')]))
const out = rows.map((f) => {
  const r = { noradId: f[ix('NORAD_CAT_ID')], epoch: f[ix('EPOCH')], meanMotion: +f[ix('MEAN_MOTION')], ecc: +f[ix('ECCENTRICITY')], incl: +f[ix('INCLINATION')], raan: +f[ix('RA_OF_ASC_NODE')], argp: +f[ix('ARG_OF_PERICENTER')], ma: +f[ix('MEAN_ANOMALY')], bstar: +f[ix('BSTAR')], mdot: +f[ix('MEAN_MOTION_DOT')], mddot: +f[ix('MEAN_MOTION_DDOT')] }
  const rec = sat.omm2satrec(r), d = new Date((rec.jdsatepoch - 2440587.5) * 86400e3)
  const pv = sat.propagate(rec, d), lon = sat.eciToGeodetic(pv.position, sat.gstime(d)).longitude * 180 / Math.PI
  return { name: f[ix('OBJECT_NAME')], i: r.incl, e: r.ecc, lon, n: r.meanMotion, ep: r.epoch.slice(0, 10) }
}).sort((a, b) => b.i - a.i)
console.log('共 ' + out.length + ' 颗；i>0.1°: ' + out.filter((x) => x.i > 0.1).length + ' 颗')
for (const x of out) console.log(x.name.padEnd(20), ('i=' + x.i.toFixed(3)).padEnd(9), ('e=' + x.e.toFixed(5)).padEnd(10), ('λ=' + x.lon.toFixed(2)).padEnd(10), 'n=' + x.n.toFixed(5), x.ep)
