// ITU 区域判定：RR No.5.3–5.9（RR 2024 Vol.1 RR5-2）
//
//   Region 1：线 B（西）与线 A（东）之间，去掉其中属伊朗的部分；另含 Armenia、Azerbaijan、Russian Federation、
//             Georgia、Kazakhstan、Mongolia、Uzbekistan、Türkiye、Kyrgyzstan、Tajikistan、Turkmenistan、Ukraine
//             全境，以及线 A 与线 C 之间俄罗斯以北的海域（No.5.3，WRC-23）
//   Region 2：线 C（西）与线 B（东）之间（No.5.4）
//   Region 3：线 A（西）与线 C（东）之间，去掉上列国家与俄罗斯以北海域；另含伊朗在线 A 以西的部分（No.5.5）
//
// 三条线（No.5.7–5.9）按原文逐段实现，段间为大圆弧：
//   A：北极沿 40°E 至 40°N → 大圆至 (60°E, 北回归线) → 沿 60°E 至南极
//   B：北极沿 10°W 至 72°N → 大圆至 (50°W, 40°N) → 大圆至 (20°W, 10°S) → 沿 20°W 至南极
//   C：北极大圆至 (65°30′N, 白令海峡国界) → 大圆至 (165°E, 50°N) → 大圆至 (170°W, 10°N) → 沿 10°N 至 120°W → 沿 120°W 至南极
//   白令海峡国界在 65°30′N 处取 1867 年美俄条约线 168°58′37″W；北回归线取 23°26′（23.4333°）。
//
// 国家面（只收 RR 点名的国家，外加几个相邻的 Region 3 国家作「陆地锚」）由 scripts/build-itu-regions.mjs
// 生成：中国取 DataV（民政部行政区划）与 Region 1 国家接壤的五省区省界，其余取 Natural Earth 1:10m；抽稀容差 0.01°
// （≈1 km）：离国界 1 km 以内的站点可能判到邻国，这是数据精度。中国边境口岸（绥芬河、阿拉山口、黑河、满洲里……）
// 在 NE 1:10m 里有被划出境的，故中国面先认、且用 DataV。
// 岸边城市与近岸小岛可能落在抽稀后的面外，故不在任何收录面里的点按「最近的收录面、25 km 以内」归属
// （领海 12 nmi ≈ 22 km 再留数据误差）；陆地锚保证 Region 3 的岸边不被划走。

const GEO = require('./ituRegionGeo.json');

// 各收录国家的「本区」：No.5.3 点名国家 → 1；伊朗 → 3；5.494 / 5.496 国家都在 Region 1；陆地锚 → 3
const HOME = {};
for (const iso of GEO.sets.rr5_494 || []) HOME[iso] = 1;
for (const iso of GEO.sets.rr5_496 || []) HOME[iso] = 1;
for (const iso of GEO.sets.r1East || []) HOME[iso] = 1;
for (const iso of GEO.sets.r3West || []) HOME[iso] = 3;
for (const iso of GEO.sets.r3Anchor || []) HOME[iso] = 3;
const ALL_ISO = Object.keys(GEO.countries);
const SNAP_KM = 25;

const D2R = Math.PI / 180;
const TROPIC = 23 + 26 / 60;
const BERING_LON = -(168 + 58 / 60 + 37 / 3600);

const vec = (lat, lon) => {
  const p = lat * D2R, l = lon * D2R;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const wrap360 = (x) => ((x % 360) + 360) % 360;

// 过 P1、P2 的大圆与纬圈 lat 的交点经度，取落在 [lo, hi]（度，可跨 180°，按东向展开）内的那一个
function gcLonAtLat(p1, p2, lat, lo, hi) {
  const n = cross(vec(p1[0], p1[1]), vec(p2[0], p2[1]));
  const R = Math.hypot(n[0], n[1]);
  const c = -n[2] * Math.tan(lat * D2R) / R;
  const phi = Math.atan2(n[1], n[0]) / D2R;
  const d = Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
  const cands = [phi + d, phi - d];
  for (const x of cands) {
    for (const k of [-360, 0, 360]) {
      const v = x + k;
      if (v >= lo - 1e-9 && v <= hi + 1e-9) return v;
    }
  }
  // 数值边缘（恰在端点纬度）：取离区间中点最近的候选
  const mid = (lo + hi) / 2;
  let best = cands[0], bd = Infinity;
  for (const x of cands) for (const k of [-360, 0, 360]) { const dd = Math.abs(x + k - mid); if (dd < bd) { bd = dd; best = x + k; } }
  return best;
}

function lineA(lat) {
  if (lat >= 40) return 40;
  if (lat >= TROPIC) return gcLonAtLat([40, 40], [TROPIC, 60], lat, 40, 60);
  return 60;
}
function lineB(lat) {
  if (lat >= 72) return -10;
  if (lat >= 40) return gcLonAtLat([72, -10], [40, -50], lat, -50, -10);
  if (lat >= -10) return gcLonAtLat([40, -50], [-10, -20], lat, -50, -20);
  return -20;
}
// 东向展开到 [165, 240]（240 = 120°W）
function lineC(lat) {
  if (lat >= 65.5) return 360 + BERING_LON;
  if (lat >= 50) return gcLonAtLat([65.5, 360 + BERING_LON], [50, 165], lat, 165, 360 + BERING_LON);
  if (lat >= 10) return gcLonAtLat([50, 165], [10, 190], lat, 165, 190);
  return 240;
}

/** 只按线 A / B / C 判区（不含国家例外）。 */
function regionByLines(latDeg, lonDeg) {
  const lB = lineB(latDeg), lA = lineA(latDeg), lC = lineC(latDeg);
  const a = wrap360(lA - lB), c = wrap360(lC - lB), p = wrap360(lonDeg - lB);
  return p < a ? 1 : (p < c ? 3 : 2);
}

// —— 国家面点判定（偶奇射线，含洞；每块先过外接框）——
function inRingsFlat(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < (r[j] - r[i]) * (y - yi) / (yj - yi) + r[i]) inside = !inside;
    }
  }
  return inside;
}
function inCountry(iso, latDeg, lonDeg) {
  const c = GEO.countries[iso];
  if (!c) return false;
  const x = lonDeg, y = latDeg, b = c.bbox;
  if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
  for (const p of c.polys) {
    const q = p.bbox;
    if (x < q[0] || x > q[2] || y < q[1] || y > q[3]) continue;
    if (inRingsFlat(p.rings, x, y)) return true;
  }
  return false;
}
const normLon = (lon) => { const v = wrap360(lon + 180) - 180; return v === -180 ? 180 : v; };

// 点到某国各面的最近距离（km，局部等距投影；只看外接框外扩 maxKm 内的面）
function distToCountryKm(iso, lat, lon, maxKm) {
  const c = GEO.countries[iso];
  if (!c) return Infinity;
  const kx = 111.32 * Math.cos(lat * D2R), ky = 110.57;
  const dLat = maxKm / ky, dLon = maxKm / Math.max(kx, 1e-6);
  const inBox = (b) => !(lon < b[0] - dLon || lon > b[2] + dLon || lat < b[1] - dLat || lat > b[3] + dLat);
  if (!inBox(c.bbox)) return Infinity;
  let best = Infinity;
  for (const p of c.polys) {
    if (!inBox(p.bbox)) continue;
    for (const r of p.rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const ax = (r[j] - lon) * kx, ay = (r[j + 1] - lat) * ky, bx = (r[i] - lon) * kx, by = (r[i + 1] - lat) * ky;
        const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
        const d = Math.hypot(ax + t * vx, ay + t * vy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** 站点落在哪个列表国家里（只认 ituRegionGeo.json 收录的国家）；不在则 null。 */
function countryIn(latDeg, lonDeg, isoList) {
  const lon = normLon(Number(lonDeg)), lat = Number(latDeg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const iso of isoList || []) if (inCountry(iso, lat, lon)) return iso;
  return null;
}

/**
 * 站点所属的收录国家：先看落在哪个面里；都不在（海上、或 1:50m 漏掉的岸边 / 小岛）则取 25 km 内最近的面。
 * 返回 { iso, snapped } 或 null（附近没有收录国家）。
 */
function nearestListedCountry(latDeg, lonDeg) {
  const lon = normLon(Number(lonDeg)), lat = Number(latDeg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const iso of ALL_ISO) if (inCountry(iso, lat, lon)) return { iso, snapped: false };
  let best = null, bd = SNAP_KM;
  for (const iso of ALL_ISO) {
    const d = distToCountryKm(iso, lat, lon, SNAP_KM);
    if (d <= bd) { bd = d; best = iso; }
  }
  return best ? { iso: best, snapped: true, km: bd } : null;
}

/**
 * ITU 区域（1 / 2 / 3）。经纬度非法返回 null。
 * 先按线 A / B / C 分区；再按 No.5.3 / 5.5 的国家例外改判：落在（或 25 km 内最近的）收录国家按其本区——
 * No.5.3 点名国家整体归 Region 1、伊朗整体归 Region 3；其余收录国家的本区与线判一致，不改变结果。
 * 线 A–C 之间、65.5°N 以北的点归 Region 1：该纬度以北线 A 与线 C 之间只有俄罗斯领土及其北侧海域
 *（No.5.3「the area to the north of Russian Federation which lies between lines A and C」；65.5°N 即线 C 改走经线处）。
 */
// 同一站址反复判（链路表批量、逐行同一收信站）走缓存；满了整表清空（只是提速，与判定结果无关）
const MEMO = new Map();
const MEMO_MAX = 4096;
function ituRegionOf(latDeg, lonDeg) {
  const lat = Number(latDeg), lon0 = Number(lonDeg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon0) || Math.abs(lat) > 90) return null;
  const lon = normLon(lon0);
  const key = lat + ',' + lon;
  const hitMemo = MEMO.get(key);
  if (hitMemo !== undefined) return hitMemo;
  let out = regionByLines(lat, lon);
  if (out === 3 && lat >= 65.5) out = 1;
  else if (out !== 2) {   // 收录国家无一在线 C–B 之间，Region 2 不受任何国家例外影响
    const hit = nearestListedCountry(lat, lon);
    if (hit && HOME[hit.iso]) out = HOME[hit.iso];
  }
  if (MEMO.size >= MEMO_MAX) MEMO.clear();
  MEMO.set(key, out);
  return out;
}

module.exports = { ituRegionOf, regionByLines, countryIn, nearestListedCountry, lineA, lineB, lineC, GEO_META: GEO.meta, GEO_SETS: GEO.sets };
