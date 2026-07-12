// 生成「内置 OMM 快照」——随安装包分发的兜底星历（离线且无用户缓存时用它渲染星座）。
// 从 CelesTrak 下载各分组 OMM(CSV) → gzip → 写入 resources/omm/csv_<key>.csv.gz + manifest.json。
// 发版前跑一次刷新即可（npm run omm:snapshot）。单组下载失败时保留已有的旧快照，绝不用空数据覆盖。
//
// 数据流与主进程 electron/services/omm.js 完全一致：同一组映射、同一主/补充端点、同一 valid() 判据。
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import https from 'https'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'resources', 'omm')

// 与 omm.js 的 GROUP_QUERY / SUP_FILE 逐字一致（改这里也要同步改 omm.js）。
const GROUP_QUERY = {
  starlink: 'GROUP=starlink', oneweb: 'GROUP=oneweb', kuiper: 'GROUP=kuiper',
  gps: 'GROUP=gps-ops', beidou: 'GROUP=beidou', galileo: 'GROUP=galileo',
  qianfan: 'GROUP=qianfan', guowang: 'NAME=HULIANWANG', geo: 'GROUP=geo',
  glonass: 'GROUP=glo-ops', o3b: 'NAME=O3B', iridium: 'GROUP=iridium-NEXT',
  globalstar: 'GROUP=globalstar', stations: 'GROUP=stations', planet: 'GROUP=planet',
  spire: 'GROUP=spire', active: 'GROUP=active'
}
const SUP_FILE = { starlink: 'starlink', oneweb: 'oneweb', kuiper: 'kuiper', planet: 'planet', iridium: 'iridium', gps: 'gps' }
const csvUrl = (k) => `https://celestrak.org/NORAD/elements/gp.php?${GROUP_QUERY[k]}&FORMAT=csv`
const supCsvUrl = (k) => `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=${SUP_FILE[k]}&FORMAT=csv`

const valid = (t) => t && /MEAN_MOTION/i.test(t)
const csvCount = (t) => { if (!t) return 0; const n = t.split(/\r?\n/).filter((l) => l.trim().length).length; return Math.max(0, n - 1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGetText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'satsim-snapshot' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve(buf))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// 取某组：主端点重试 3 次 → 补充端点重试 2 次（与 omm.js fetchCsv 同策略）。
async function fetchGroup(key) {
  let text = null
  for (let i = 0; i < 3 && !valid(text); i++) { if (i) await sleep(1500); text = await httpGetText(csvUrl(key)) }
  if (!valid(text) && SUP_FILE[key]) for (let i = 0; i < 2 && !valid(text); i++) { await sleep(1500); text = await httpGetText(supCsvUrl(key)) }
  return valid(text) ? text : null
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const generatedAt = new Date().toISOString()
  const groups = {}
  let okCount = 0, failCount = 0
  for (const key of Object.keys(GROUP_QUERY)) {
    process.stdout.write(`[omm-snapshot] ${key} … `)
    const text = await fetchGroup(key)
    const gzPath = path.join(OUT_DIR, `csv_${key}.csv.gz`)
    if (text) {
      const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 })
      fs.writeFileSync(gzPath, gz)
      const count = csvCount(text)
      groups[key] = { count, bytes: text.length, gzBytes: gz.length }
      okCount++
      console.log(`${count} 颗 · ${(text.length / 1024).toFixed(0)}KB → ${(gz.length / 1024).toFixed(0)}KB gz`)
    } else {
      failCount++
      // 保留旧快照：若已有 gz，沿用其数据统计（下面 manifest 合并旧值）；否则记 0。
      const had = fs.existsSync(gzPath)
      console.log(had ? '下载失败，保留旧快照' : '下载失败，无旧快照')
    }
    await sleep(800)   // 轻微限速，避免触发 CelesTrak 频控
  }

  // manifest：本次成功组用新值；失败但有旧 gz 的组，沿用旧 manifest 里的统计与其自身 generatedAt。
  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'manifest.json'), 'utf8')) } catch {}
  const prevGroups = (prev && prev.groups) || {}
  const merged = {}
  for (const key of Object.keys(GROUP_QUERY)) {
    if (groups[key]) merged[key] = { ...groups[key], generatedAt }
    else if (prevGroups[key] && fs.existsSync(path.join(OUT_DIR, `csv_${key}.csv.gz`))) merged[key] = prevGroups[key]
  }
  const manifest = { generatedAt, note: '内置 OMM 兜底快照（CelesTrak GP CSV）', groups: merged }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  const totalGz = Object.keys(GROUP_QUERY).reduce((s, k) => { try { return s + fs.statSync(path.join(OUT_DIR, `csv_${k}.csv.gz`)).size } catch { return s } }, 0)
  console.log(`\n[omm-snapshot] 完成：成功 ${okCount} 组 · 失败 ${failCount} 组 · 快照总大小 ${(totalGz / 1024 / 1024).toFixed(2)}MB`)
  console.log(`[omm-snapshot] 输出：${OUT_DIR}`)
  if (okCount === 0) process.exitCode = 1
}

main()
