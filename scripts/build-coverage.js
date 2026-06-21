// 从 Satellitelinkbudget/CoverageCloudData 抽取 GEO 卫星覆盖数据 -> resources/coverage。
// 每个波束输出 { sat, band, beam, type, lon, bore, contours:[{g,p:[[lon,lat]...]}] }，
// 外加 index.json 汇总卫星 -> 波束（含经度/各增益等值）。坐标保留 3 位小数压缩体积。
// 用法：node scripts/build-coverage.js [源CoverageCloudData目录]
const fs = require('fs'), path = require('path')

const SRC = process.argv[2] || 'C:/Users/85256/WeChatProjects/Satellitelinkbudget/CoverageCloudData'
const OUT = path.join(__dirname, '..', 'resources', 'coverage')

function main() {
  if (!fs.existsSync(SRC)) { console.error('源目录不存在：', SRC); process.exit(1) }
  fs.mkdirSync(OUT, { recursive: true })
  const sats = {}
  const folders = fs.readdirSync(SRC).filter((f) => { try { return fs.statSync(path.join(SRC, f)).isDirectory() && f !== 'permissions' } catch { return false } })
  let nf = 0
  const round = (p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]
  for (const folder of folders) {
    const dir = path.join(SRC, folder)
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    if (!files.length) continue
    fs.mkdirSync(path.join(OUT, folder), { recursive: true })
    const beams = []
    let satLon = null
    for (const file of files) {
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) } catch { console.warn('skip', file); continue }
      const base = file.replace(/\.json$/, '')
      const parts = base.split('_')
      const type = parts.pop(), sat = parts.shift(), band = parts.shift(), beam = parts.join('_')
      const lon = (j.geoMain && j.geoMain.longitude) != null ? j.geoMain.longitude : null
      if (lon != null && satLon == null) satLon = lon
      const bore = (j.borePoints || []).map((b) => b.pos)
      const contours = (j.contours || []).filter((c) => c && c.p && c.p.length >= 2).map((c) => ({ g: c.g, p: c.p.map(round) }))
      const gains = [...new Set(contours.map((c) => c.g))].sort((a, b) => a - b)
      const outName = base + '.json'
      fs.writeFileSync(path.join(OUT, folder, outName), JSON.stringify({ sat, band, beam, type, lon, bore, contours }))
      beams.push({ key: folder + '/' + base, sat, band, beam, type, lon, gains, file: folder + '/' + outName })
      nf++
    }
    sats[folder] = { folder, displayName: folder, satName: (beams[0] || {}).sat || folder, lon: satLon, beams }
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ satellites: Object.values(sats) }))
  console.log('satellites:', Object.keys(sats).length, ' beam files:', nf)
}
main()
