// 轨道服务（主进程）：加载 TLE → SGP4 传播 → 返回经纬高。
// 离线优先：优先用缓存/内置样例；联网仅在显式刷新且可达时尝试 CelesTrak。
const https = require('https')
const fs = require('fs')
const path = require('path')

// 内置样例 TLE（保证完全离线也能渲染星座）：ISS、两颗 Starlink、一颗 GEO。
const SAMPLE = `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000
2 25544  51.6400 100.0000 0006703  90.0000 270.0000 15.50000000000000
STARLINK-1007
1 44713U 19074A   24001.50000000  .00002182  00000-0  16717-3 0  9001
2 44713  53.0540 200.0000 0001423  90.0000 270.0000 15.06000000000000
STARLINK-1130
1 44937U 20001A    24001.50000000  .00001500  00000-0  12000-3 0  9002
2 44937  53.0530 280.0000 0001500  80.0000 280.0000 15.06000000000000
DEMO-GEO
1 40000U 14001A    24001.50000000  .00000000  00000-0  00000-0 0  9003
2 40000   0.0300  95.0000 0002000  90.0000 270.0000  1.00270000000000`

const CELESTRAK = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`

// 与小程序 tleStore 完全一致的分组 -> CelesTrak GP 查询映射（OMM CSV）。
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

module.exports = function createOmm(getCore) {
  const groups = {} // group -> [{ name, satrec }]

  function cacheDir() {
    const base = process.env.SATSIM_DATA_DIR ||
      path.join(require('electron').app.getPath('userData'), 'data')
    const d = path.join(base, 'omm')
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const cacheFile = (g) => path.join(cacheDir(), `${g}.tle`)

  function parse(group, text) {
    const sgp4 = getCore().sgp4
    if (!sgp4) return 0
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
    const list = []
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = lines[i]
      const l1 = lines[i + 1]
      const l2 = lines[i + 2]
      if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue
      try {
        const satrec = sgp4.twoline2satrec(l1, l2)
        list.push({ name: (name || '').trim(), satrec })
      } catch { /* skip malformed */ }
    }
    groups[group] = list
    return list.length
  }

  function fetchText(group) {
    return new Promise((resolve) => {
      const req = https.get(CELESTRAK(group), { timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(buf))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  // 加载分组：online=true 时尝试联网→写缓存，失败回退缓存，再回退样例。
  async function load(group = 'sample', online = false) {
    if (group === 'sample') return { group, count: parse('sample', SAMPLE), source: 'sample' }
    let text = null
    let source = 'cache'
    if (online) {
      text = await fetchText(group)
      if (text) { try { fs.writeFileSync(cacheFile(group), text) } catch {} ; source = 'network' }
    }
    if (!text) { try { text = fs.readFileSync(cacheFile(group), 'utf8') } catch {} }
    if (!text) { source = 'sample'; text = SAMPLE; group = 'sample' }
    return { group, count: parse(group, text), source }
  }

  function httpGetText(url) {
    return new Promise((resolve) => {
      let net = null
      try { net = require('electron').net } catch {}
      // 优先用 Electron net：走 Chromium 网络栈，遵循系统代理/VPN —— 国内访问 celestrak 的关键。
      if (net && typeof net.request === 'function') {
        let buf = '', done = false
        const req = net.request(url)
        req.setHeader('User-Agent', 'satsim-desktop')
        req.on('response', (res) => {
          if (res.statusCode !== 200) {
            console.warn('[omm] net HTTP', res.statusCode, url)
            res.on('data', () => {}); res.on('end', () => resolve(null)); return
          }
          res.on('data', (c) => (buf += c))
          res.on('end', () => { done = true; resolve(buf) })
        })
        req.on('error', (e) => { console.warn('[omm] net error:', e.message, '|', url); resolve(null) })
        setTimeout(() => { if (!done) { try { req.abort() } catch {} ; console.warn('[omm] net timeout |', url); resolve(null) } }, 30000)
        try { req.end() } catch (e) { console.warn('[omm] net end err', e.message); resolve(null) }
        return
      }
      // 回退：Node https（仅用于无 Electron 的测试环境，不走系统代理）。
      const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'satsim-desktop' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null) }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(buf))
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  const csvCacheFile = (k) => path.join(cacheDir(), `csv_${k}.csv`)

  const valid = (t) => t && /MEAN_MOTION/i.test(t)
  const isToday = (d) => { const n = new Date(), t = new Date(d); return n.getFullYear() === t.getFullYear() && n.getMonth() === t.getMonth() && n.getDate() === t.getDate() }

  // 取某组 OMM CSV 文本：本地有“今天”的缓存 → 直接用（一天一次）；否则联网（主端点重试3次→补充端点重试2次）→ 命中落盘；再失败回退任意本地缓存（离线优先）。
  async function fetchCsv(key) {
    if (!GROUP_QUERY[key]) throw new Error('unknown group: ' + key)
    const cf = csvCacheFile(key)
    // 一天一次：缓存文件是今天写的就直接用，不再联网
    try { const st = fs.statSync(cf); if (isToday(st.mtime)) { const c = fs.readFileSync(cf, 'utf8'); if (valid(c)) { console.log('[omm] 用今日缓存:', key); return c } } } catch {}
    console.log('[omm] fetchCsv 开始:', key, '->', csvUrl(key))
    let text = null
    for (let i = 0; i < 3 && !valid(text); i++) text = await httpGetText(csvUrl(key))
    if (!valid(text) && SUP_FILE[key]) {
      console.log('[omm] 主端点失败，转补充端点:', supCsvUrl(key))
      for (let i = 0; i < 2 && !valid(text); i++) text = await httpGetText(supCsvUrl(key))
    }
    if (valid(text)) { console.log('[omm] fetchCsv 成功:', key, text.length, 'bytes'); try { fs.writeFileSync(csvCacheFile(key), text) } catch {} ; return text }
    try { const c = fs.readFileSync(csvCacheFile(key), 'utf8'); if (valid(c)) { console.log('[omm] 用本地缓存:', key); return c } } catch {}
    console.error('[omm] fetchCsv 彻底失败:', key)
    throw new Error('celestrak.org 不可达且无本地缓存（国内访问该站通常需系统代理/VPN）')
  }

  function positions(group, iso) {
    const sgp4 = getCore().sgp4
    const list = groups[group]
    if (!sgp4 || !list) return []
    const date = iso ? new Date(iso) : new Date()
    const gmst = sgp4.gstime(date)
    const out = []
    for (const s of list) {
      try {
        const pv = sgp4.propagate(s.satrec, date)
        if (!pv || !pv.position) continue
        const gd = sgp4.eciToGeodetic(pv.position, gmst)
        out.push({
          name: s.name,
          lon: sgp4.degreesLong(gd.longitude),
          lat: sgp4.degreesLat(gd.latitude),
          altKm: gd.height
        })
      } catch { /* skip */ }
    }
    return out
  }

  return { load, positions, fetchCsv }
}
