// 把 release/ 里的更新文件上传到腾讯云 COS 的 /updates/ 目录。
//
// 零依赖实现：只用 Node 内置 https + crypto 调用 COS REST 接口，自行计算 q-sign 签名，
// 不依赖任何第三方 SDK，稳定且无安全漏洞负担。
//
// 用法（PowerShell）：
//   $env:COS_SECRET_ID="你的SecretId"; $env:COS_SECRET_KEY="你的SecretKey"
//   $env:COS_BUCKET="update-1385987144"; $env:COS_REGION="ap-beijing"
//   # 可选：开启全球加速（需先在 COS 控制台为该桶启用「全球加速 / Global Acceleration」）
//   $env:COS_ACCELERATE="1"
//   node scripts/publish-cos.mjs
//
// 跨洲上传提速两板斧（均不改变桶位置，国内用户的自动更新下载完全不受影响）：
//   1. 全球加速：COS_ACCELERATE=1 → 上传就近接入腾讯边缘节点，再走腾讯内部骨干网回北京桶，
//      替换掉拥塞的国际公网那一段。签名不签 Host 头，故换加速域名后签名逻辑无需任何改动。
//   2. 分块并发：大文件（安装包 ~108MB）切片并行 PUT。高 RTT 弱网下单条 TCP 流被 窗口/RTT 卡死，
//      多流并发能成倍打满管道；且失败只需重传单个分片，而非整包。
//
// 凭证从环境变量读取，绝不写进仓库。建议用腾讯云 CAM 子账号密钥，权限只给该桶。
//
// 上传的文件：
//   - latest.yml            ← 客户端据此判断版本（必传）
//   - *-Setup.exe           ← NSIS 安装包
//   - *-Setup.exe.blockmap  ← 差量更新用，显著减小下次更新下载量

import { readdirSync, statSync, readFileSync, createReadStream } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHmac, createHash } from 'node:crypto'
import https from 'node:https'

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, COS_ACCELERATE } = process.env
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION')
  process.exit(1)
}

const ACCEL = COS_ACCELERATE === '1' || COS_ACCELERATE === 'true'
// 全球加速域名不含地域；常规域名带地域。二者签名算法一致（不签 Host）。
const HOST = ACCEL
  ? `${COS_BUCKET}.cos.accelerate.myqcloud.com`
  : `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`
const RELEASE_DIR = resolve('release')
const PREFIX = 'updates/'
const PART_SIZE = 8 * 1024 * 1024            // 分片大小 8MB（COS 单片下限 1MB，末片可小于此）
const CONCURRENCY = 4                        // 并发分片数：高 RTT 链路用多流填满管道
const MULTIPART_THRESHOLD = 8 * 1024 * 1024  // 超过此大小走分块并发，否则单次 PUT

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha1', key).update(s).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// COS 请求签名（q-sign 格式）：对 method + pathname（+ query 参数）签名，不签 header（q-header-list 空）。
// signature 用「原始未编码」pathname 参与计算。无 params 时与旧版单 PUT 的签名串完全一致（向后兼容）。
function authorization(method, pathname, params) {
  const now = Math.floor(Date.now() / 1000) - 60 // 留点时钟偏差余量
  const exp = now + 3600
  const signTime = `${now};${exp}`
  const signKey = hmac(COS_SECRET_KEY, signTime)
  const keys = Object.keys(params || {}).sort()
  const paramList = keys.map((k) => k.toLowerCase()).join(';')
  const paramStr = keys
    .map((k) => `${encodeURIComponent(k.toLowerCase())}=${encodeURIComponent(params[k] == null ? '' : String(params[k]))}`)
    .join('&')
  const httpString = `${method.toLowerCase()}\n${pathname}\n${paramStr}\n\n`
  const stringToSign = `sha1\n${signTime}\n${sha1(httpString)}\n`
  const signature = hmac(signKey, stringToSign)
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${COS_SECRET_ID}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    'q-header-list=',
    `q-url-param-list=${paramList}`,
    `q-signature=${signature}`
  ].join('&')
}

// URL 路径需逐段编码（中文文件名会变成 %XX），但签名里用原始路径
const encodePath = (key) => '/' + key.split('/').map(encodeURIComponent).join('/')

// 带签名的一次性请求（支持 query 参数与内存 body）：分块上传的 initiate / part / complete / abort 各步共用。
function signedRequest(method, key, { params, body, headers } = {}) {
  const pathnameRaw = '/' + key
  let path = encodePath(key)
  if (params && Object.keys(params).length) {
    path += '?' + Object.keys(params).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k] == null ? '' : String(params[k]))}`)
      .join('&')
  }
  const h = { Authorization: authorization(method, pathnameRaw, params), ...(headers || {}) }
  if (body != null) h['Content-Length'] = Buffer.byteLength(body)
  return new Promise((res, rej) => {
    const req = https.request({ host: HOST, method, path, headers: h }, (r) => {
      const chunks = []
      r.on('data', (d) => chunks.push(d))
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (r.statusCode >= 200 && r.statusCode < 300) res({ status: r.statusCode, headers: r.headers, text })
        else rej(new Error(`HTTP ${r.statusCode} ${method} ${key}\n${text.slice(0, 300)}`))
      })
    })
    req.on('error', rej)
    if (body != null) req.write(body)
    req.end()
  })
}

// ---- 单次 PUT（小文件：latest.yml / blockmap；也作大文件分块上传失败时的整包兜底）----
function putOnce(file) {
  const key = PREFIX + file
  const pathnameRaw = '/' + key
  const requestPath = encodePath(key)
  const full = join(RELEASE_DIR, file)
  const size = statSync(full).size
  return new Promise((res, rej) => {
    let settled = false
    const done = (err) => { if (settled) return; settled = true; err ? rej(err) : res() }
    const req = https.request(
      {
        host: HOST,
        method: 'PUT',
        path: requestPath,
        headers: { Authorization: authorization('put', pathnameRaw), 'Content-Length': size }
      },
      (r) => {
        let body = ''
        r.on('data', (d) => (body += d))
        r.on('end', () => {
          if (r.statusCode === 200) done()
          else done(new Error(`${file} 上传失败 HTTP ${r.statusCode}\n${body}`))
        })
      }
    )
    const stream = createReadStream(full)
    // 任一端出错都要中止对端，避免句柄泄漏与未处理 error 事件导致进程崩溃
    req.on('error', (e) => { stream.destroy(); done(e) })
    stream.on('error', (e) => { req.destroy(); done(e) })
    let uploaded = 0
    let lastPct = -1
    stream.on('data', (chunk) => {
      uploaded += chunk.length
      const pct = Math.floor((uploaded / size) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        process.stdout.write(`\r  ${file}  ${pct}%   `)
      }
    })
    stream.on('end', () => process.stdout.write('\n'))
    stream.pipe(req)
  })
}

// 大文件在弱网下单次 PUT 易被重置（ECONNRESET / syscall:read），失败自动重试
async function put(file, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      await putOnce(file)
      return
    } catch (e) {
      if (i === tries) throw e
      console.warn(`\n  ${file} 第 ${i} 次上传失败（${e.message.split('\n')[0]}），重试中…`)
      await sleep(1500 * i)
    }
  }
}

// ---- 分块并发上传（大文件：安装包）：initiate → 并发 upload part → complete；失败 abort 清理 ----
async function initiateMultipart(key) {
  const res = await signedRequest('POST', key, { params: { uploads: '' } })
  const m = res.text.match(/<UploadId>([^<]+)<\/UploadId>/)
  if (!m) throw new Error('初始化分块上传失败，未返回 UploadId：' + res.text.slice(0, 200))
  return m[1]
}

async function uploadPart(key, uploadId, partNumber, buf, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await signedRequest('PUT', key, { params: { partNumber: String(partNumber), uploadId }, body: buf })
      const etag = res.headers.etag || res.headers.ETag
      if (!etag) throw new Error(`分片 ${partNumber} 响应缺少 ETag`)
      return etag   // 含双引号，原样回填到 complete 的 <ETag>
    } catch (e) {
      if (i === tries) throw e
      await sleep(1000 * i)
    }
  }
}

async function completeMultipart(key, uploadId, etags) {
  const partsXml = etags.map((et, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${et}</ETag></Part>`).join('')
  const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`
  const res = await signedRequest('POST', key, { params: { uploadId }, body, headers: { 'Content-Type': 'application/xml' } })
  // COS 的 complete 可能返回 200 但 body 里其实是 <Error>（如某分片缺失），需显式校验
  if (/<Error>/.test(res.text)) throw new Error('合并分块失败：' + res.text.slice(0, 300))
}

async function abortMultipart(key, uploadId) {
  try { await signedRequest('DELETE', key, { params: { uploadId } }) } catch { /* 兜底清理，忽略失败 */ }
}

// 简单并发池：最多 concurrency 个 worker 同时跑，worker(i) 返回第 i 项结果
async function runPool(count, concurrency, worker) {
  const results = new Array(count)
  let next = 0
  async function runner() {
    while (next < count) { const i = next++; results[i] = await worker(i) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, runner))
  return results
}

async function multipartUpload(file) {
  const key = PREFIX + file
  const data = readFileSync(join(RELEASE_DIR, file))   // 安装包 ~108MB，开发机内存充裕，整读后切片最稳
  const total = data.length
  const nParts = Math.ceil(total / PART_SIZE)
  process.stdout.write(`  ${file}  分块并发上传：${nParts} 片 × ${PART_SIZE / 1024 / 1024}MB，并发 ${CONCURRENCY}\n`)
  const uploadId = await initiateMultipart(key)
  try {
    let done = 0
    const etags = await runPool(nParts, CONCURRENCY, async (i) => {
      const start = i * PART_SIZE
      const end = Math.min(start + PART_SIZE, total)
      const et = await uploadPart(key, uploadId, i + 1, data.subarray(start, end))
      done++
      process.stdout.write(`\r  ${file}  ${Math.floor((done / nParts) * 100)}%  (${done}/${nParts} 片)   `)
      return et
    })
    process.stdout.write('\n')
    await completeMultipart(key, uploadId, etags)
  } catch (e) {
    await abortMultipart(key, uploadId)   // 取消未完成的分块上传，避免在桶里留下碎片（会计费）
    throw e
  }
}

// 只上传与自动更新相关的文件（不传 portable 等无关产物）
const files = readdirSync(RELEASE_DIR).filter(
  (f) => f === 'latest.yml' || /-Setup\.exe$/.test(f) || /-Setup\.exe\.blockmap$/.test(f)
)
if (files.length === 0) {
  console.error('release/ 下没找到 latest.yml / *-Setup.exe，先运行 npm run dist')
  process.exit(1)
}

console.log(`准备上传 ${files.length} 个文件到 ${HOST}/${PREFIX}${ACCEL ? '（全球加速已开启）' : ''}`)
// latest.yml 最后传：确保安装包先到位，避免客户端读到新版本号却下载不到包
const ordered = files.sort((a) => (a === 'latest.yml' ? 1 : -1))
for (const f of ordered) {
  const size = statSync(join(RELEASE_DIR, f)).size
  if (size > MULTIPART_THRESHOLD) {
    try {
      await multipartUpload(f)
    } catch (e) {
      // 分块路径若因签名/网络等异常失败，回退到验证过的整包单 PUT（最坏退化为旧行为：慢但可用）
      console.warn(`\n  ${f} 分块上传失败（${e.message.split('\n')[0]}），回退整包上传…`)
      await put(f)
    }
  } else {
    await put(f)
  }
}
console.log('✅ 上传完成')
