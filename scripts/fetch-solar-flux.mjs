// 生成「内置太阳射电流量快照」—— 随安装包分发的 F10.7 兜底数据（无网设备靠它算太阳亮温）。
// 从 NOAA SWPC 下载四个产品 → 合并 → 写入 resources/space-weather/solar-flux.json。
// 发版前跑一次刷新即可（npm run swpc:snapshot，已串在 npm run omm:snapshot 里一起跑）。
// 单个产品下载失败时保留已有快照里的那一份，绝不用空数据覆盖（部分刷新，同 fetch-omm-snapshot.mjs）。
//
// 解析 / 合并 / 判据一律复用 packages/core/utils/ 下与主进程同一份实现，这里不抄第二份。
import fs from 'fs'
import path from 'path'
import https from 'https'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const pick = require('../packages/core/utils/solarFluxPick.js')
const { validSolarFlux } = require('../packages/core/utils/solarFluxValid.js')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'resources', 'space-weather')
const OUT_FILE = path.join(OUT_DIR, 'solar-flux.json')

// 与 electron/services/solarFlux.js 的 SOURCES 逐字一致（改这里也要同步改那边）。
const SOURCES = {
  daily30:    { url: 'https://services.swpc.noaa.gov/products/10cm-flux-30-day.json',                     label: '30 天观测日值' },
  forecast45: { url: 'https://services.swpc.noaa.gov/text/45-day-forecast.txt',                            label: '45 天预报' },
  monthly:    { url: 'https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json',  label: '观测月均' },
  predicted:  { url: 'https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json',         label: '太阳周预测月均' }
}
const TIMEOUT = 30000
const TRIES = 3

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0 (satsim snapshot)' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve({ text: null, why: 'HTTP ' + res.statusCode }) }
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve({ text: buf, why: '' }))
    })
    req.on('error', (e) => resolve({ text: null, why: (e && e.message) || String(e) }))
    req.on('timeout', () => { req.destroy(); resolve({ text: null, why: '超时 ' + TIMEOUT / 1000 + 's' }) })
  })
}

const kb = (n) => Math.max(1, Math.round(n / 1024)) + ' KB'

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  let prev = null
  try { const t = fs.readFileSync(OUT_FILE, 'utf8'); if (validSolarFlux(t)) prev = JSON.parse(t) } catch (e) { /* 首次生成 */ }

  const fresh = {}
  let got = 0
  for (const [key, src] of Object.entries(SOURCES)) {
    let r = { text: null, why: '' }
    for (let i = 0; i < TRIES && !r.text; i++) r = await get(src.url)
    if (r.text) {
      const n = Object.keys(pick[key === 'daily30' ? 'parseDaily30' : key === 'forecast45' ? 'parseForecast45' : key === 'monthly' ? 'parseMonthly' : 'parsePredicted'](r.text)).length
      if (n) { fresh[key] = r.text; got++; console.log(`  ✓ ${src.label.padEnd(12)} ${String(n).padStart(5)} 条 · ${kb(r.text.length)}`) }
      else console.warn(`  ✗ ${src.label}：下到了但一条都解不出，保留旧快照`)
    } else {
      console.warn(`  ✗ ${src.label}：${TRIES} 次尝试均失败（${r.why}），保留旧快照`)
    }
  }
  if (!got) {
    console.error('四个产品全部失败，快照未改动')
    process.exit(prev ? 0 : 1)
  }
  const merged = pick.mergeProducts(prev, fresh, new Date().toISOString())
  const text = JSON.stringify(merged)
  if (!validSolarFlux(text)) { console.error('合并结果不满足有效性判据，快照未改动'); process.exit(1) }
  fs.writeFileSync(OUT_FILE, text)
  const n = (k) => Object.keys((merged.products[k] && merged.products[k].data) || {}).length
  console.log(`太阳射电流量快照已写入 ${path.relative(path.join(__dirname, '..'), OUT_FILE)} —— ${kb(text.length)}`)
  console.log(`  日值 ${n('daily30')} 天 · 预报 ${n('forecast45')} 天 · 观测月均 ${n('monthly')} 月 · 预测 ${n('predicted')} 月`)
}

main()
