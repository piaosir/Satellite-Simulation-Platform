// 从 DataV GeoAtlas 生成中国「省界」+ 省名标注 -> src/viz/globe3d/data/china-provinces.json
//
// 关键：DataV 与底图国境线(Natural Earth)是两套数据，沿海/国境处对不上。
// 因此只保留「内部省界」（相邻两省共享的边），丢弃只属于一个省的外缘边（= 国境/海岸，由底图提供）。
// 这样省界不再与国境线重叠/错位，岛屿省（台湾/海南）无内部边自然不画。省名仍全部标注。
//
// 用法：先把 100000_full.json 下到 scripts/_china_prov_raw.json，再 node scripts/build-provinces.js
const fs = require('fs'), path = require('path')

const RAW = path.join(__dirname, '_china_prov_raw.json')
const OUT = path.join(__dirname, '..', 'src', 'viz', 'globe3d', 'data', 'china-provinces.json')

const shortName = (n) => n
  .replace('特别行政区', '').replace('维吾尔自治区', '').replace('壮族自治区', '')
  .replace('回族自治区', '').replace('自治区', '').replace(/省$/, '').replace(/市$/, '')

const round = (p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]
const ek = (a, b) => {
  const ka = a[0].toFixed(5) + ',' + a[1].toFixed(5), kb = b[0].toFixed(5) + ',' + b[1].toFixed(5)
  return ka < kb ? ka + '|' + kb : kb + '|' + ka
}
const polysOf = (g) => g.type === 'Polygon' ? [g.coordinates] : g.coordinates

function main() {
  const j = JSON.parse(fs.readFileSync(RAW, 'utf8'))
  // 第一遍：统计每条边出现次数（共享=内部省界）
  const cnt = new Map()
  for (const f of j.features) {
    const g = f.geometry; if (!g) continue
    for (const rings of polysOf(g)) for (const ring of rings)
      for (let i = 0; i + 1 < ring.length; i++) { const k = ek(ring[i], ring[i + 1]); cnt.set(k, (cnt.get(k) || 0) + 1) }
  }
  // 第二遍：仅输出内部边（去重）+ 省名标注
  const emitted = new Set(), borders = [], labels = []
  for (const f of j.features) {
    const name = f.properties.name; if (!name) continue
    const c = f.properties.centroid || f.properties.center
    if (c) labels.push({ name: shortName(name), lon: c[0], lat: c[1] })
    const g = f.geometry; if (!g) continue
    for (const rings of polysOf(g)) for (const ring of rings)
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i], b = ring[i + 1], k = ek(a, b)
        if ((cnt.get(k) || 0) >= 2 && !emitted.has(k)) { emitted.add(k); borders.push([round(a), round(b)]) }
      }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ borders, labels }))
  console.log('labels:', labels.length, ' internal border segments:', borders.length, ' bytes:', fs.statSync(OUT).size)
}
main()
