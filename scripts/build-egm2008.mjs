// EGM2008 重力场系数：NGA 官方原件 → 截断到 70×70 → packages/core/utils/prop/data/egm2008_70.js
// （prop/forces/gravity.js 消费）。
//
// 原件：NGA（美国国家地理空间情报局）EGM2008「Spherical Harmonics」压缩包
//   https://earth-info.nga.mil/php/download.php?file=egm-08spherical
//   入口页 https://earth-info.nga.mil/index.php?dir=wgs84&action=wgs84 →「Earth Gravitational Model 2008
//   (EGM2008) Data and Apps」→「EGM2008 Spherical Harmonics (104MB)」。
//   EGM2008_Spherical_Harmonics.zip  109 351 360 字节
//     SHA-256 65a9072f337f156e8cbd76ffd773f536e6fb0de18697ea6726ecdb790fac0fbd（2026-10-17 下载）
//   包内 EGM2008_to2190_TideFree  242 534 633 字节（解压后）
//     SHA-256 7e448aac4e1b8e63955890cbca08286018ecc6d203e074a64ba5bde21851438a
//   包内 README_WGS84_2.pdf 的口径：完全归一化、无量纲的 C̄nm / S̄nm；GM = 3986004.415e8 m³/s²，
//   a = 6378136.3 m；C̄20 为「Tide Free」（无潮汐）体系；每行 {n, m, C̄, S̄, σC̄, σS̄}，格式 (2i5, 2d25.15, 2d20.10)，
//   指数用 Fortran 的 D；S̄n0 写作 0；n = 0、1 不在文件里（C̄00 = 1，其余为 0）。
//   引用：Pavlis, N.K., S.A. Holmes, S.C. Kenyon, J.K. Factor (2008), An Earth Gravitational Model to Degree 2160: EGM2008,
//   EGU General Assembly, Vienna。
//   许可：NGA 公开下载、无需注册；该页对 EGM2008 数据未附使用条款（同页只有 GeoTrans 软件单列 Terms of Use，
//   2026-10-17 核对）。
//
// 输出：CommonJS 模块，C̄ / S̄ 各一个 Float64（小端）数组的 base64，按三角下标 k = n(n+1)/2 + m 排（n = 0…70，
//   含 n = 0、1 的占位行），共 2556 项 × 8 字节 = 20448 字节一份，base64 后约 27 KB。系数原样存双精度（D25.15 → double
//   是十进制到二进制的最近舍入，不再截位）。另存一份打包字节的 SHA-256，单测拿它核对数据文件没被改动。
//   零潮汐（zero-tide）C̄20 不在这里折算 —— 换算依赖 k20 取值，放在 gravity.js 里按 IERS 2010 式 (6.13) 做。
//
// 用法：
//   node scripts/build-egm2008.mjs                      # 缓存目录无原件则用 curl 下载（浏览器 UA），校验 SHA-256 后生成
//   node scripts/build-egm2008.mjs --zip <本地 zip>      # 用已下载的原件
//   node scripts/build-egm2008.mjs --src <缓存目录>       # 缺省 <系统临时目录>/ssp-egm2008-src（不放仓库里，免得留 104 MB 未跟踪文件）
//   node scripts/build-egm2008.mjs --check              # 只核对：重新生成的内容与仓库里的数据文件逐字节一致
//
// 解压不依赖系统 unzip（Windows 上没有）：自己读 zip 中央目录，按本地文件头定位数据段，用 zlib.inflateRaw 流式解压，
// 一边算整份文件的 SHA-256，一边只解析 n ≤ 70 的行。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'packages', 'core', 'utils', 'prop', 'data', 'egm2008_70.js')
const URL = 'https://earth-info.nga.mil/php/download.php?file=egm-08spherical'
const ZIP_NAME = 'EGM2008_Spherical_Harmonics.zip'
const ZIP_SIZE = 109351360
const ZIP_SHA256 = '65a9072f337f156e8cbd76ffd773f536e6fb0de18697ea6726ecdb790fac0fbd'
const ENTRY = 'EGM2008_to2190_TideFree'
const ENTRY_SIZE = 242534633
const ENTRY_SHA256 = '7e448aac4e1b8e63955890cbca08286018ecc6d203e074a64ba5bde21851438a'
const ENTRY_RECORDS = 2401333
const NMAX = 70
const GM = 3986004.415e8      // m³/s²（README_WGS84_2.pdf 式 (2)）
const AE = 6378136.3          // m
// 浏览器 UA：NGA 站点对非浏览器 UA 时有拦截（任务书要求官方数据一律带浏览器 UA 下载）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const args = process.argv.slice(2)
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const CHECK = args.includes('--check')
const SRC = path.resolve(argVal('--src') || path.join(os.tmpdir(), 'ssp-egm2008-src'))

function sha256File(f) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(f, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; h.update(buf.subarray(0, n)) }
  } finally { fs.closeSync(fd) }
  return h.digest('hex')
}

function ensureZip() {
  const given = argVal('--zip')
  if (given) return path.resolve(given)
  fs.mkdirSync(SRC, { recursive: true })
  const f = path.join(SRC, ZIP_NAME)
  if (fs.existsSync(f) && fs.statSync(f).size === ZIP_SIZE) return f
  console.log(`下载 ${URL}\n  → ${f}（约 104 MB）`)
  const r = spawnSync('curl', ['-sS', '-L', '--fail', '--retry', '3', '-A', UA, '-o', f, URL], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('curl 下载失败（退出码 ' + r.status + '）')
  return f
}

/* ===================== 最小 zip 读取（只认 deflate / stored，非 zip64） ===================== */
function findEntry(zipFile, name) {
  const fd = fs.openSync(zipFile, 'r')
  try {
    const size = fs.fstatSync(fd).size
    // 中央目录结束记录（EOCD）在文件尾 22 字节 + 至多 64 KB 注释里
    const tailLen = Math.min(size, 22 + 65535)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) throw new Error('不是 zip：找不到中央目录结束记录')
    const cdCount = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdOff)
    let p = 0
    for (let k = 0; k < cdCount; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名不对')
      const method = cd.readUInt16LE(p + 10)
      const compSize = cd.readUInt32LE(p + 20)
      const rawSize = cd.readUInt32LE(p + 24)
      const nLen = cd.readUInt16LE(p + 28), xLen = cd.readUInt16LE(p + 30), cLen = cd.readUInt16LE(p + 32)
      const lhOff = cd.readUInt32LE(p + 42)
      const nm = cd.toString('latin1', p + 46, p + 46 + nLen)
      if (nm === name) {
        const lh = Buffer.alloc(30)
        fs.readSync(fd, lh, 0, 30, lhOff)
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地文件头签名不对')
        const dataOff = lhOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28)
        return { method, compSize, rawSize, dataOff }
      }
      p += 46 + nLen + xLen + cLen
    }
    throw new Error('zip 里没有 ' + name)
  } finally { fs.closeSync(fd) }
}

// 流式解压 + 全文件 SHA-256 + 解析 n ≤ NMAX 的行
function readCoefficients(zipFile) {
  const e = findEntry(zipFile, ENTRY)
  if (e.rawSize !== ENTRY_SIZE) throw new Error(`${ENTRY} 解压后大小 ${e.rawSize}，应为 ${ENTRY_SIZE}`)
  const N = (NMAX + 1) * (NMAX + 2) / 2
  const C = new Float64Array(N), S = new Float64Array(N)
  const seen = new Uint8Array(N)
  C[0] = 1; seen[0] = seen[1] = seen[2] = 1      // C̄00 = 1；n = 1 三项恒为 0（地心原点）
  const hash = crypto.createHash('sha256')
  let carry = '', lines = 0, rawBytes = 0, done = false
  const eat = (line) => {
    if (!line.trim()) return
    lines++
    if (done) return
    const tok = line.trim().split(/\s+/)
    const n = +tok[0], m = +tok[1]
    if (n > NMAX) { done = true; return }
    const c = Number(tok[2].replace(/[dD]/, 'e')), s = Number(tok[3].replace(/[dD]/, 'e'))
    if (!(n >= 2 && m >= 0 && m <= n) || !Number.isFinite(c) || !Number.isFinite(s)) throw new Error('行看不懂：' + line)
    const k = n * (n + 1) / 2 + m
    if (seen[k]) throw new Error(`重复的 (n, m) = (${n}, ${m})`)
    seen[k] = 1; C[k] = c; S[k] = s
  }
  return new Promise((resolve, reject) => {
    const src = fs.createReadStream(zipFile, { start: e.dataOff, end: e.dataOff + e.compSize - 1 })
    const inf = e.method === 8 ? zlib.createInflateRaw() : null
    if (e.method !== 8 && e.method !== 0) return reject(new Error('不支持的压缩方法 ' + e.method))
    const out = inf ? src.pipe(inf) : src
    src.on('error', reject)
    out.on('error', reject)
    out.on('data', (chunk) => {
      hash.update(chunk)
      rawBytes += chunk.length
      const txt = carry + chunk.toString('latin1')
      const parts = txt.split('\n')
      carry = parts.pop()
      for (const ln of parts) eat(ln)
    })
    out.on('end', () => {
      if (carry) eat(carry)
      const missing = []
      for (let k = 0; k < N; k++) if (!seen[k]) missing.push(k)
      if (missing.length) return reject(new Error('缺系数，三角下标：' + missing.slice(0, 10).join(',')))
      resolve({ C, S, sha256: hash.digest('hex'), rawBytes, lines })
    })
  })
}

const b64 = (f64) => Buffer.from(f64.buffer, f64.byteOffset, f64.byteLength).toString('base64')
// 76 列折行，免得单行几万字符拖慢编辑器 / diff
const wrap = (s) => s.match(/.{1,76}/g).map((x) => "  '" + x + "'").join(' +\n')

function render(C, S) {
  const packed = Buffer.concat([Buffer.from(C.buffer), Buffer.from(S.buffer)])
  const digest = crypto.createHash('sha256').update(packed).digest('hex')
  return `// 本文件由 scripts/build-egm2008.mjs 生成，勿手改。来源、校验和与口径见该脚本头注。
//
// EGM2008（NGA）完全归一化球谐系数 C̄nm / S̄nm，截断到 n = m = ${NMAX}，C̄20 为 tide-free（原件口径）。
// 存法：Float64（小端）按三角下标 k = n(n+1)/2 + m（n = 0…${NMAX}）连排后 base64；C̄00 = 1，n = 1 三项为 0。
// 原件 ${ZIP_NAME}（SHA-256 ${ZIP_SHA256}）
//   → ${ENTRY}（SHA-256 ${ENTRY_SHA256}）。
'use strict'

module.exports = {
  model: 'EGM2008',
  source: '${URL}',
  zipSha256: '${ZIP_SHA256}',
  fileSha256: '${ENTRY_SHA256}',
  tideSystem: 'tide-free',
  gm: ${GM},            // m^3/s^2
  ae: ${AE},               // m
  nmax: ${NMAX},
  count: ${C.length},
  packedSha256: '${digest}', // C 的字节后接 S 的字节，整体 SHA-256
  C: (
${wrap(b64(C))}
  ),
  S: (
${wrap(b64(S))}
  )
}
`
}

async function main() {
  const zip = ensureZip()
  const st = fs.statSync(zip)
  if (st.size !== ZIP_SIZE) throw new Error(`zip 大小 ${st.size}，应为 ${ZIP_SIZE}（NGA 若改版，请人工核对后更新本脚本的常量）`)
  const zsha = sha256File(zip)
  if (zsha !== ZIP_SHA256) throw new Error(`zip SHA-256 = ${zsha}，应为 ${ZIP_SHA256}`)
  console.log('zip SHA-256 一致：' + zsha)
  const r = await readCoefficients(zip)
  if (r.sha256 !== ENTRY_SHA256) throw new Error(`${ENTRY} SHA-256 = ${r.sha256}，应为 ${ENTRY_SHA256}`)
  if (r.rawBytes !== ENTRY_SIZE || r.lines !== ENTRY_RECORDS) throw new Error(`${ENTRY} ${r.rawBytes} 字节 / ${r.lines} 行，应为 ${ENTRY_SIZE} / ${ENTRY_RECORDS}`)
  console.log(`${ENTRY} SHA-256 一致：${r.sha256}（${r.lines} 行）`)
  // 解析抽查：C̄20 即原件首行（tide-free）
  if (r.C[3] !== -0.484165143790815e-3) throw new Error('C̄20 与原件首行不符：' + r.C[3])
  const txt = render(r.C, r.S)
  if (CHECK) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
    if (cur.replace(/\r\n/g, '\n') !== txt) { console.error('数据文件与原件重算结果不一致：' + OUT); process.exit(1) }
    console.log('核对通过：' + path.relative(ROOT, OUT))
    return
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, txt)
  console.log(`写出 ${path.relative(ROOT, OUT)}（${(txt.length / 1024).toFixed(1)} KB）`)
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1) })
