// 星历「缓存优先即时出图」验证台
//
// 病灶：星座页进场要的是【17 组的并集】（全部卫星 / 其他 / 全量搜索池），而每组联网最坏要付
// 3×30s 主端点 + 2×30s 补充端点＝单组封顶两分半。这一轮走完之前屏幕上一颗星都没有。
// 对策：先只读本机（用户缓存 / 内置快照）出图，联网那一版在后台跑完再整体替换。
//
// 本验证台钉住主进程这一侧的三件事：
//   ① cacheOnly 一律不发网络请求（发了就是把「先出图」这条路又变回等联网）；
//   ② cacheOnly 能把随包内置的 17 组全部交出来（无网首启的用户也有星看）；
//   ③ offlineBest 改成「先比时间戳、只读赢的那一份正文」之后，择新语义逐项不变。
// 末尾实测一遍 17 组全量 cacheOnly 的真实耗时，作为「秒级 vs 分钟级」这句话的证据。
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import os from 'os'
import zlib from 'zlib'
import https from 'https'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const BUNDLE = path.join(ROOT, 'resources', 'omm')

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg) } }
const eq = (a, b, msg) => ok(a === b, `${msg}：期望 ${b}，实得 ${a}`)

// ---- 临时目录：每个场景各一份干净的数据目录 / 内置快照目录 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ommcache-'))
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} }

const CSV_HEAD = 'OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT'
const csvOf = (tag, n = 1) => {
  const rows = []
  for (let i = 0; i < n; i++) rows.push(`${tag}-${i},2020-00${i + 1}A,2026-08-29T00:00:00,1.0027,0.0001,0.05,90,90,0,0,U,${40000 + i},999,100,0,0,0`)
  return CSV_HEAD + '\n' + rows.join('\n') + '\n'
}

// 新建一个 omm 服务实例（每次都是新的闭包 → manifest 缓存不串场）
function makeOmm({ dataDir, bundleDir }) {
  process.env.SATSIM_DATA_DIR = dataDir
  if (bundleDir) process.env.SATSIM_OMM_BUNDLE_DIR = bundleDir
  else delete process.env.SATSIM_OMM_BUNDLE_DIR
  delete require.cache[require.resolve(path.join(ROOT, 'electron/services/omm.js'))]
  const createOmm = require(path.join(ROOT, 'electron/services/omm.js'))
  return createOmm(() => ({}))   // cacheOnly 路径用不到 sgp4
}
// 写一份内置快照目录（gzip + manifest）
function writeBundle(dir, groups) {
  mkdir(dir)
  const man = { generatedAt: '2026-01-01T00:00:00.000Z', groups: {} }
  for (const [key, g] of Object.entries(groups)) {
    fs.writeFileSync(path.join(dir, `csv_${key}.csv.gz`), zlib.gzipSync(Buffer.from(g.text, 'utf8')))
    man.groups[key] = { count: 1, generatedAt: g.time }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man))
}
// 写一份用户缓存（并把 mtime 钉到指定时刻）
function writeCache(dataDir, key, text, time) {
  const d = mkdir(path.join(dataDir, 'omm'))
  const f = path.join(d, `csv_${key}.csv`)
  fs.writeFileSync(f, text)
  const t = new Date(time)
  fs.utimesSync(f, t, t)
  return f
}

// ---- 网络闸：任何一次 HTTP 外发都记账（cacheOnly 路径上出现即为失败）----
let netCalls = 0
const realGet = https.get
https.get = function (...a) { netCalls++; throw new Error('cacheOnly 路径不应联网') }

console.log('星历缓存优先（omm cacheOnly / offlineBest）')

// ===================== ① cacheOnly 一律不联网 =====================
{
  const dataDir = mkdir(path.join(TMP, 'a-data'))
  const bundleDir = path.join(TMP, 'a-bundle')
  writeBundle(bundleDir, { geo: { text: csvOf('BUNDLED', 3), time: '2026-01-01T00:00:00.000Z' } })
  const omm = makeOmm({ dataDir, bundleDir })
  netCalls = 0
  const r = await omm.fetchCsv('geo', { cacheOnly: true })
  eq(netCalls, 0, 'cacheOnly 未发起任何 HTTP 请求')
  ok(r && /BUNDLED-0/.test(r.text), 'cacheOnly 从内置快照取到正文')
  eq(r && r.fetchedAt, '2026-01-01T00:00:00.000Z', 'cacheOnly 回传的是快照自身的时间')

  // 本机什么都没有 → 返回 null（交渲染端走后台联网），仍不许联网
  const omm2 = makeOmm({ dataDir: mkdir(path.join(TMP, 'a2-data')), bundleDir: mkdir(path.join(TMP, 'a2-bundle')) })
  netCalls = 0
  const r2 = await omm2.fetchCsv('geo', { cacheOnly: true })
  eq(r2, null, '本机无缓存无快照时 cacheOnly 返回 null')
  eq(netCalls, 0, '返回 null 的那一路也没联网')
}

// ===================== ② offlineBest 择新语义（改法前后必须逐项一致）=====================
{
  const B = '2026-01-01T00:00:00.000Z'   // 内置快照时间（固定）
  const cases = [
    { name: '只有内置快照 → 用内置', cache: null, want: 'BUNDLED' },
    { name: '缓存比内置新 → 用缓存', cache: '2026-06-01T00:00:00.000Z', want: 'CACHED' },
    { name: '缓存比内置旧 → 用内置', cache: '2025-06-01T00:00:00.000Z', want: 'BUNDLED' },
    { name: '缓存与内置同时刻 → 用缓存（不拿内置盖用户的）', cache: B, want: 'CACHED' }
  ]
  for (const c of cases) {
    const dataDir = mkdir(path.join(TMP, 'b-' + cases.indexOf(c)))
    const bundleDir = path.join(TMP, 'bb-' + cases.indexOf(c))
    writeBundle(bundleDir, { geo: { text: csvOf('BUNDLED'), time: B } })
    if (c.cache) writeCache(dataDir, 'geo', csvOf('CACHED'), c.cache)
    const omm = makeOmm({ dataDir, bundleDir })
    const r = await omm.fetchCsv('geo', { cacheOnly: true })
    ok(r && r.text.includes(c.want + '-0'), c.name)
  }
  // 缓存时间更新但文件是坏的（截断 / 非 OMM）→ 回头读内置，不能整组丢掉
  {
    const dataDir = mkdir(path.join(TMP, 'b-bad')), bundleDir = path.join(TMP, 'bb-bad')
    writeBundle(bundleDir, { geo: { text: csvOf('BUNDLED'), time: B } })
    writeCache(dataDir, 'geo', 'not,an,omm,file\n1,2,3,4\n', '2026-06-01T00:00:00.000Z')
    const omm = makeOmm({ dataDir, bundleDir })
    const r = await omm.fetchCsv('geo', { cacheOnly: true })
    ok(r && r.text.includes('BUNDLED-0'), '缓存较新但内容无效 → 回落内置快照')
  }
  // ★ 无缓存时「缓存时间」必须是 0，不是 2000-01-01。
  // 陷阱（2026-09-01 修）：`Date.parse(x || 0)` 在缺时间时算的是 Date.parse("0") —— V8 把它解析成
  // 2000-01-01 而不是 NaN，于是「没有缓存」被当成「缓存是 2000 年的」，按 0 判空的分支全部失效。
  // 下面这一档正是当年会走错分支的那一格（内置快照比 2000 年还老）：靠兜底链侥幸没出错，但语义是反的。
  {
    const dataDir = mkdir(path.join(TMP, 'b-y2k')), bundleDir = path.join(TMP, 'bb-y2k')
    writeBundle(bundleDir, { geo: { text: csvOf('BUNDLED'), time: '1999-01-01T00:00:00.000Z' } })
    const omm = makeOmm({ dataDir, bundleDir })   // 刻意不写用户缓存
    const r = await omm.fetchCsv('geo', { cacheOnly: true })
    ok(r && r.text.includes('BUNDLED-0'), '无缓存 + 内置快照早于 2000 年 → 仍用内置（缓存时间按 0 而不是 Y2K 算）')
  }
  // 无 manifest（只有 .gz 文件）：内置时间未知，缓存有效就用缓存
  {
    const dataDir = mkdir(path.join(TMP, 'b-noman')), bundleDir = mkdir(path.join(TMP, 'bb-noman'))
    fs.writeFileSync(path.join(bundleDir, 'csv_geo.csv.gz'), zlib.gzipSync(Buffer.from(csvOf('BUNDLED'), 'utf8')))
    writeCache(dataDir, 'geo', csvOf('CACHED'), '2025-01-01T00:00:00.000Z')
    const omm = makeOmm({ dataDir, bundleDir })
    const r = await omm.fetchCsv('geo', { cacheOnly: true })
    ok(r && r.text.includes('CACHED-0'), '内置快照无 manifest（时间未知）→ 用用户缓存')
  }
}

// ===================== ③ 只读赢的那一份正文 =====================
// 病灶：两份都读出来只为比一个时间戳。active 组明文约 5MB，而「先出图」要一口气过 17 组。
{
  const dataDir = mkdir(path.join(TMP, 'c-data')), bundleDir = path.join(TMP, 'c-bundle')
  writeBundle(bundleDir, { geo: { text: csvOf('BUNDLED'), time: '2026-01-01T00:00:00.000Z' } })
  writeCache(dataDir, 'geo', csvOf('CACHED'), '2026-06-01T00:00:00.000Z')   // 缓存更新 → 内置那份不该被解压
  const omm = makeOmm({ dataDir, bundleDir })
  const realGunzip = zlib.gunzipSync
  let gunzips = 0
  zlib.gunzipSync = function (...a) { gunzips++; return realGunzip.apply(zlib, a) }
  try { await omm.fetchCsv('geo', { cacheOnly: true }) } finally { zlib.gunzipSync = realGunzip }
  eq(gunzips, 0, '缓存更新时不解压内置快照')

  // 反向：内置更新 → 不该读用户缓存的正文（stat 取时间可以，readFileSync 不该发生）
  const dataDir2 = mkdir(path.join(TMP, 'c2-data')), bundleDir2 = path.join(TMP, 'c2-bundle')
  writeBundle(bundleDir2, { geo: { text: csvOf('BUNDLED'), time: '2026-06-01T00:00:00.000Z' } })
  const cf = writeCache(dataDir2, 'geo', csvOf('CACHED'), '2025-01-01T00:00:00.000Z')
  const omm2 = makeOmm({ dataDir: dataDir2, bundleDir: bundleDir2 })
  const realRead = fs.readFileSync
  let cacheReads = 0
  fs.readFileSync = function (p, ...a) { if (String(p) === cf) cacheReads++; return realRead.call(fs, p, ...a) }
  try { await omm2.fetchCsv('geo', { cacheOnly: true }) } finally { fs.readFileSync = realRead }
  eq(cacheReads, 0, '内置更新时不读用户缓存正文')
}

// ===================== ④ 真实内置快照：17 组全量 cacheOnly =====================
// 这是星座页进场那一屏真正要走的一轮 —— 无网首启的用户全靠它。
if (fs.existsSync(path.join(BUNDLE, 'manifest.json'))) {
  const man = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'manifest.json'), 'utf8'))
  const keys = Object.keys(man.groups || {})
  const omm = makeOmm({ dataDir: mkdir(path.join(TMP, 'd-data')), bundleDir: BUNDLE })
  netCalls = 0
  const t0 = Date.now()
  const got = await Promise.all(keys.map((k) => omm.fetchCsv(k, { cacheOnly: true }).catch(() => null)))
  const ms = Date.now() - t0
  const miss = keys.filter((k, i) => !got[i] || !got[i].text)
  eq(netCalls, 0, '全量 cacheOnly 一次网络请求都没发')
  eq(miss.length, 0, `随包内置的 ${keys.length} 组全部取到` + (miss.length ? `（缺 ${miss.join('、')}）` : ''))
  const sats = got.reduce((n, r) => n + (r ? r.text.split('\n').filter((l) => l.trim()).length - 1 : 0), 0)
  console.log(`  · 全量 17 组 cacheOnly：${(sats / 1000).toFixed(1)} 千条 / ${(got.reduce((n, r) => n + (r ? r.text.length : 0), 0) / 1048576).toFixed(1)} MB，耗时 ${ms} ms`)
  ok(ms < 15000, `全量 cacheOnly 应在秒级内完成（实测 ${ms} ms）`)
} else {
  console.log('  · 跳过：resources/omm 无内置快照（先跑 npm run omm:snapshot）')
}

// ===================== ⑤ 源码级看门狗：Date.parse(x || 0) 这个写法不许再出现 =====================
// 它不报错、不改结果（兜底链正好把它兜住了），只是把「没有时间」悄悄变成 2000-01-01 —— 下一个人
// 照着这行写别的判据时才会炸，且炸在完全无关的地方。故在源码层直接钉死，而不是等行为测出问题。
{
  ok(Date.parse(0) === Date.parse('0') && Number.isFinite(Date.parse(0)),
    'JS 事实：Date.parse(0) 解析的是字符串 "0"，得到 2000-01-01 而非 NaN')
  // 只扫代码，注释里那句「不能写 Date.parse(x || 0)」是说明，不是违例
  const src = fs.readFileSync(path.join(ROOT, 'electron/services/omm.js'), 'utf8').replace(/\/\/[^\n]*/g, '')
  const hits = [...src.matchAll(/Date\.parse\([^)]*\|\|\s*0\s*\)/g)].map((m) => m[0])
  ok(hits.length === 0, `omm.js 里不该有 Date.parse(… || 0)：${hits.join(' / ')}`)
}

https.get = realGet
cleanup()
console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
