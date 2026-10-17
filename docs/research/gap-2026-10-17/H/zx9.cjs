// 用平台内置 satellite.js + 随包 GEO 快照里的 ZHONGXING-9（i≈0.97°）算北京站 24 h 视向摆幅与固定天线指向损失
const path = require('path'), zlib = require('zlib'), fs = require('fs')
const root = process.argv[2]
const S = require(path.join(root, 'packages/core/vendor/satellite.js'))
const csv = zlib.gunzipSync(fs.readFileSync(path.join(root, 'resources/omm/csv_geo.csv.gz'))).toString('utf8').split(/\r?\n/)
const head = csv[0].split(','); const idx = (k) => head.indexOf(k)
const pick = (name) => { const l = csv.find((x) => x.startsWith(name + ',')); const c = l.split(','); const o = {}; head.forEach((k, i) => { o[k] = c[i] }); return o }
function satrecOf(o) {
  const omm = { noradId: o.NORAD_CAT_ID, epoch: o.EPOCH, meanMotion: +o.MEAN_MOTION, ecc: +o.ECCENTRICITY, incl: +o.INCLINATION, raan: +o.RA_OF_ASC_NODE, argp: +o.ARG_OF_PERICENTER, ma: +o.MEAN_ANOMALY, bstar: +o.BSTAR, mdot: +o.MEAN_MOTION_DOT, mddot: +o.MEAN_MOTION_DDOT }
  return S.omm2satrec(omm)
}
const site = { longitude: 116.4 * Math.PI / 180, latitude: 39.9 * Math.PI / 180, height: 0.05 }
function track(o, t0) {
  const rec = satrecOf(o), out = []
  for (let k = 0; k <= 1440; k += 2) {
    const t = new Date(t0 + k * 60e3); const pv = S.propagate(rec, t); const g = S.gstime(t)
    const ecf = S.eciToEcf(pv.position, g); const la = S.ecfToLookAngles(site, ecf); const gd = S.eciToGeodetic(pv.position, g)
    out.push({ az: la.azimuth * 180 / Math.PI, el: la.elevation * 180 / Math.PI, lon: S.degreesLong(gd.longitude), lat: S.degreesLat(gd.latitude) })
  }
  return out
}
function sep(a, b) { const r = Math.PI / 180; const c = Math.sin(a.el * r) * Math.sin(b.el * r) + Math.cos(a.el * r) * Math.cos(b.el * r) * Math.cos((a.az - b.az) * r); return Math.acos(Math.min(1, c)) / r }
const t0 = Date.UTC(2026, 9, 16, 0, 0, 0)
for (const nm of ['ZHONGXING-9', 'ZHONGXING-6E', 'ZHONGXING-26']) {
  const o = pick(nm); const tr = track(o, t0)
  const az = tr.map((p) => p.az), el = tr.map((p) => p.el), lat = tr.map((p) => p.lat), lon = tr.map((p) => p.lon)
  // 固定天线对准日均方向（取方位/仰角中点）后的最大偏离
  const c = { az: (Math.max(...az) + Math.min(...az)) / 2, el: (Math.max(...el) + Math.min(...el)) / 2 }
  const mx = Math.max(...tr.map((p) => sep(p, c)))
  const loss = (f, D) => { const th = 70 * (0.299792458 / f) / D; return 12 * (mx / th) ** 2 }
  console.log(`${nm} i=${(+o.INCLINATION).toFixed(4)}° 星下点纬度 ${Math.min(...lat).toFixed(3)}~${Math.max(...lat).toFixed(3)}° 经度 ${Math.min(...lon).toFixed(3)}~${Math.max(...lon).toFixed(3)}°；北京视向 方位 ${Math.min(...az).toFixed(3)}~${Math.max(...az).toFixed(3)}° 仰角 ${Math.min(...el).toFixed(3)}~${Math.max(...el).toFixed(3)}°；对中后最大偏离 ${mx.toFixed(3)}°；固定天线日最大指向损失 Ku12G·0.6m ${loss(12, 0.6).toFixed(2)} dB / Ku12G·1.2m ${loss(12, 1.2).toFixed(2)} dB / C4G·3.7m ${loss(4, 3.7).toFixed(2)} dB`)
}
