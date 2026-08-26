// Natural Earth / geoBoundaries 原始数据下载 + 本地缓存（scripts/_ne/，不进仓库）。
// NE 走官方 naciscdn 的 shapefile zip：同内容比 GeoJSON 小一个量级，且直连稳定。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { shapefileFromZip } from './shapefile.mjs'

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '_ne')
const NACIS = 'https://naciscdn.org/naturalearth/'

export function download(url, dest, tries = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (n, u) => {
      const tmp = dest + '.part'
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const f = fs.createWriteStream(tmp)
      const rq = https.get(u, { headers: { 'user-agent': 'satsim-basemap-build' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { f.close(); fs.rmSync(tmp, { force: true }); r.resume(); return attempt(n, new URL(r.headers.location, u).toString()) }
        if (r.statusCode !== 200) { f.close(); fs.rmSync(tmp, { force: true }); r.resume(); return n > 1 ? setTimeout(() => attempt(n - 1, u), 1500) : reject(new Error(u + ' -> ' + r.statusCode)) }
        r.pipe(f)
        f.on('finish', () => f.close(() => { fs.renameSync(tmp, dest); resolve(dest) }))
      })
      rq.setTimeout(120000, () => rq.destroy(new Error('timeout')))
      rq.on('error', (e) => { f.close(); fs.rmSync(tmp, { force: true }); n > 1 ? setTimeout(() => attempt(n - 1, u), 1500) : reject(e) })
    }
    attempt(tries, url)
  })
}

export async function cached(url, name) {
  const dest = path.join(CACHE, name)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 512) return dest
  process.stdout.write('  下载 ' + name + ' … ')
  await download(url, dest)
  console.log((fs.statSync(dest).size / 1e6).toFixed(2) + ' MB')
  return dest
}

// scale: '110m' | '50m' | '10m'；layer: 'admin_0_map_units' 等（不含 ne_ 前缀与比例尺）
export async function neLayer(scale, layer, kind = 'cultural') {
  const name = `ne_${scale}_${layer}`
  const zip = await cached(`${NACIS}${scale}/${kind}/${name}.zip`, name + '.zip')
  return shapefileFromZip(fs.readFileSync(zip))
}
