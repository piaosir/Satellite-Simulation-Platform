// 坐标格式（src/viz/geo/coordFormat.js）与大地基准（src/viz/geo/datum.js）的往返自测。运行：npm test
//
// 这两个模块只作用于【显示与输入】的呈现层 —— 平台内部一律 WGS-84 十进制度。
// 因此关键不变式只有两条：
//   ① 正反算往返回得来（任意格式 format → parse 后误差 < 1e-6 度）；
//   ② 恒等档真的是恒等（CGCS2000 一位小数都不许动，境外的 GCJ-02 也一样）。
import {
  tmForward, tmInverse, toUtm, fromUtm, toMgrs, fromMgrs, toGk, fromGk,
  formatLonLat, parseLonLat, utmZone, gkZone, FORMATS
} from '../../../src/viz/geo/coordFormat.js'
import { toDisplay, fromDisplay, wgs2gcj, gcj2wgs, outOfChina, DATUMS } from '../../../src/viz/geo/datum.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const TOL = 1e-6      // 度；≈0.1 m，比任何一处显示精度都细

// 取一批覆盖全球的点（含赤道、高纬、±180 附近、中国境内外）
const PTS = []
for (let lat = -80; lat <= 80; lat += 10) for (let lon = -175; lon <= 175; lon += 25) PTS.push([lon, lat])
PTS.push([116.3912, 39.9073], [121.4737, 31.2304], [-74.006, 40.7128], [151.2093, -33.8688],
  [179.9, 60], [-179.9, -60], [0, 0], [3, 45], [-3, -45], [110.5, 0])

// ---------- ① 横轴墨卡托往返 ----------
let worst = 0, worstAt = null
for (const [lon, lat] of PTS) {
  const z = utmZone(lon), lon0 = (z - 1) * 6 - 180 + 3
  const p = tmForward(lon, lat, lon0, 0.9996)
  const [l2, b2] = tmInverse(p.x, p.y, lon0, 0.9996)
  const d = Math.max(Math.abs(l2 - lon), Math.abs(b2 - lat))
  if (d > worst) { worst = d; worstAt = [lon, lat] }
}
ok('① 横轴墨卡托正反算往返 < 1e-6 度', worst < TOL, '最大 ' + worst.toExponential(2) + ' 度 @ ' + worstAt)

// ---------- ② UTM ----------
worst = 0; worstAt = null
for (const [lon, lat] of PTS) {
  if (lat < -80 || lat >= 84) continue
  const u = toUtm(lon, lat)
  const [l2, b2] = fromUtm(u.zone, u.north, u.e, u.n)
  const d = Math.max(Math.abs(l2 - lon), Math.abs(b2 - lat))
  if (d > worst) { worst = d; worstAt = [lon, lat] }
}
ok('② UTM 往返 < 1e-6 度', worst < TOL, '最大 ' + worst.toExponential(2) + ' 度 @ ' + worstAt)
// 已知算例：北京天安门 50T 带
{
  const u = toUtm(116.3912, 39.9073)
  // 39.9°N 落在 S 带（S 覆盖 32–40°N，T 才是 40–48°N）
  ok('②b 北京落在 UTM 50 带 S 纬度带、东坐标在带内', u.zone === 50 && u.band === 'S' && u.e > 100000 && u.e < 900000,
    u.zone + u.band + ' E=' + Math.round(u.e) + ' N=' + Math.round(u.n))
}
// 南半球假北
{
  const u = toUtm(151.2093, -33.8688)
  ok('②c 南半球加 10 000 km 假北', !u.north && u.n > 6000000 && u.n < 10000000, 'N=' + Math.round(u.n))
}

// ---------- ③ MGRS ----------
worst = 0; worstAt = null
let mgrsN = 0
for (const [lon, lat] of PTS) {
  if (lat < -80 || lat >= 84) continue
  const s = toMgrs(lon, lat, 5)
  if (!s) continue
  const r = fromMgrs(s)
  if (!r) { ok('③ MGRS 解析失败 ' + s, false); break }
  mgrsN++
  // ★ 按【米】比，不按度：MGRS 五位是 1 m 网格且向下取整，高纬处 1 m 东偏折成经度能到 5e-5 度，
  //   拿度做阈值会把「本来就该有的 1 m 量化」误判成错。
  const d = Math.hypot((r[0] - lon) * 111320 * Math.cos(lat * Math.PI / 180), (r[1] - lat) * 110540)
  if (d > worst) { worst = d; worstAt = [lon, lat, s] }
}
ok('③ MGRS 往返 < 2 m（5 位=1 m 网格、向下取整，两轴各 ≤1 m）', worst < 2, mgrsN + ' 点，最大 ' + worst.toFixed(2) + ' m @ ' + worstAt)
ok('③b MGRS 串格式正确', /^\d{1,2}[C-X][A-Z][A-V]\d{10}$/.test(toMgrs(116.3912, 39.9073, 5) || ''), toMgrs(116.3912, 39.9073, 5))
ok('③c 非法 MGRS 返回 null', fromMgrs('乱码') === null && fromMgrs('50TIK1234') === null)

// ---------- ④ 高斯-克吕格 ----------
for (const w of [3, 6]) {
  worst = 0; worstAt = null
  for (const [lon, lat] of PTS) {
    if (Math.abs(lat) > 84) continue
    const g = toGk(lon, lat, w)
    const [l2, b2] = fromGk(g.zone, g.e, g.n, w)
    const d = Math.max(Math.abs(l2 - lon), Math.abs(b2 - lat))
    if (d > worst) { worst = d; worstAt = [lon, lat] }
  }
  ok('④ 高斯-克吕格 ' + w + '° 带往返 < 1e-6 度', worst < TOL, '最大 ' + worst.toExponential(2) + ' 度 @ ' + worstAt)
}
ok('④b 北京在 3° 带第 39 带、6° 带第 20 带（中国习惯，从 0°E 起编）',
  gkZone(116.3912, 3) === 39 && gkZone(116.3912, 6) === 20, '3°带号=' + gkZone(116.3912, 3) + ' 6°带号=' + gkZone(116.3912, 6))
{
  const g = toGk(116.3912, 39.9073, 3)
  ok('④c 东坐标冠带号且带内偏移合理', Math.abs(g.eZoned - (g.zone * 1000000 + g.e)) < 1e-6 && g.e > 100000 && g.e < 900000,
    '带 ' + g.zone + ' E=' + Math.round(g.eZoned))
  ok('④d 带号东坐标能被反解回来', Math.abs(fromGk(g.zone, g.eZoned, g.n, 3)[0] - 116.3912) < TOL)
}

// ---------- ⑤ 格式化 → 解析 全链路 ----------
for (const f of FORMATS) {
  let w = 0, at = null, n = 0
  for (const [lon, lat] of PTS) {
    if (Math.abs(lat) > 80) continue
    const s = formatLonLat(lon, lat, f.k, 6)
    if (!s) continue
    const r = parseLonLat(s, f.k)
    if (!r) { at = [lon, lat, s]; w = 99; break }
    n++
    const d = Math.max(Math.abs(r[0] - lon), Math.abs(r[1] - lat))
    if (d > w) { w = d; at = [lon, lat, s] }
  }
  // 度分秒/UTM/GK 的显示串本身是取整过的：秒取到 1e-4″≈3 mm，UTM/GK 取到 1 m，MGRS 取到 1 m
  const lim = f.k === 'deg' ? 1e-6 : f.k === 'dms' ? 1e-6 : 1e-4
  ok('⑤ ' + f.zh + '：format → parse 往返 < ' + lim, w < lim, n + ' 点，最大 ' + w.toExponential(2) + ' 度 @ ' + at)
}
// 半球字母、次序、负号三种写法都认
ok('⑤b 解析认「纬 经」纯数字', (() => { const r = parseLonLat('39.9073 116.3912', 'deg'); return r && Math.abs(r[0] - 116.3912) < 1e-9 && Math.abs(r[1] - 39.9073) < 1e-9 })())
ok('⑤c 解析认半球字母且不管次序', (() => { const r = parseLonLat('116.3912°E 39.9073°N', 'deg'); return r && Math.abs(r[0] - 116.3912) < 1e-9 && Math.abs(r[1] - 39.9073) < 1e-9 })())
ok('⑤d 解析认负号与 S/W', (() => { const r = parseLonLat('-33.8688 151.2093', 'deg'); return r && Math.abs(r[1] + 33.8688) < 1e-9 })() &&
  (() => { const r = parseLonLat('33.8688°S 151.2093°E', 'deg'); return r && Math.abs(r[1] + 33.8688) < 1e-9 })())
ok('⑤e 空串与乱码返回 null', parseLonLat('', 'deg') === null && parseLonLat('乱码', 'utm') === null)

// ---------- ⑥ 大地基准 ----------
ok('⑥ 三档齐备', DATUMS.length === 3 && DATUMS.map((d) => d.k).join(',') === 'wgs84,cgcs2000,gcj02')
// CGCS2000 与 WGS-84 都必须是【严格恒等】：差在厘米量级，做变换等于拿噪声冒充精度
let ident = true
for (const [lon, lat] of PTS) for (const k of ['wgs84', 'cgcs2000']) {
  const d = toDisplay(lon, lat, k)
  if (d[0] !== lon || d[1] !== lat) ident = false
  const b = fromDisplay(lon, lat, k)
  if (b[0] !== lon || b[1] !== lat) ident = false
}
ok('⑥b WGS-84 / CGCS2000 严格恒等（一位小数都不动）', ident)
// GCJ-02：境内确有偏移、境外恒等、往返可回
{
  const [gx, gy] = wgs2gcj(116.3912, 39.9073)
  const shift = Math.hypot((gx - 116.3912) * 111320 * Math.cos(39.9073 * Math.PI / 180), (gy - 39.9073) * 110540)
  ok('⑥c GCJ-02 在北京的偏移量在百米量级', shift > 100 && shift < 800, shift.toFixed(0) + ' m')
  let w = 0
  for (const [lon, lat] of PTS.concat([[116.39, 39.9], [121.47, 31.23], [87.6, 43.8], [113.5, 22.2]])) {
    if (outOfChina(lon, lat)) continue
    const g = wgs2gcj(lon, lat)
    const b = gcj2wgs(g[0], g[1])
    w = Math.max(w, Math.abs(b[0] - lon), Math.abs(b[1] - lat))
  }
  ok('⑥d GCJ-02 迭代反算往返 < 1e-9 度', w < 1e-9, '最大 ' + w.toExponential(2) + ' 度')
  const out = wgs2gcj(-74.006, 40.7128)
  ok('⑥e 境外不偏移', out[0] === -74.006 && out[1] === 40.7128)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
