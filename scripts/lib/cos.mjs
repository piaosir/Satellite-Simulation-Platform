// 腾讯云 COS 的签名与上传共用件（只供 scripts/ 下的开发者脚本用；零依赖，只用 Node 内置 https + crypto）。
//
// 从 scripts/publish-cos.mjs 原样抽出（签名、带签名请求、单次 PUT + 重试、分块并发上传），publish-cos 改为 import，
// 行为逐字不变 —— 同样的请求序列（method / host / path / 头 / 正文）与同样的终端输出。等价性靠「录制补丁」验证：
// node --import <rec.mjs> scripts/publish-cos.mjs，钉死 Date.now、拦截 https.request / https.get，改前改后逐条比对。
// 所以这里必须保持 `import https from 'node:https'` 默认导入、调用时写 https.request(...)：
// 写成 `import { request }` 的话，补丁改的是模块对象上的属性，具名绑定看不见，验证就失效了。
//
// 为什么不把 electron/services 里那几份同款签名也统一过来：那些是 CJS、跑在 Electron 31（Node 20.18）主进程里，
// 该版本 require() 不了 ESM；而且它们的有效期口径不同（ommCloud 是 +900 s）。这里只收 scripts/ 的。
//
// 本模块没有任何「导入即执行」的代码：不读环境变量、不 process.exit。ESM 的 import 先于脚本正文执行，
// 若这里读环境变量或退出，publish-cos 缺凭据时的报错文案与退出码就变了。凭据一律由调用方经 createCos() 传入。
//
// 新增（不在「逐字不变」范围内，给 scripts/nasa3d/publish.mjs 用）：
//   headPublic(key)            不签名的公共读 HEAD（桶是公共读、私有写），blob 去重用；顺带读回 x-cos-meta-sha256
//   getPublic(key)             不签名的公共读 GET（读云端现有 manifest.json，发布前比对条目有没有缩水）
//   putBuffer(key, buf, headers)  内存 body 的带签名 PUT，可带 Content-Type / Cache-Control / x-cos-meta-*（签名不签头，头可自由加）
//   probeWrite(key)            写权限探针：PUT 一个固定小对象，403 时区分 AccessDenied（策略）与 SignatureDoesNotMatch（密钥）
//   multipartUpload / initiateMultipart 增加可选 headers（只在 initiate 那一步带：COS 分块上传的对象元数据在 initiate 时定）
//   signedRequest / multipartUpload 增加可选 timeoutMs（套接字空闲超时）：缺省不设——publish-cos 的请求与原版逐字一致；
//     新代码（putBuffer / probeWrite / nasa3d:publish 的分块上传）一律传。原版没有超时，半开连接会让 runPool 永远等下去，
//     发安装包时一次只传几个对象还能人工盯着，nasa3d:publish 一次上千个对象就不行了。
import { createHmac, createHash } from 'node:crypto'
import https from 'node:https'
import { statSync, createReadStream, readFileSync } from 'node:fs'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha1', key).update(s).digest('hex')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 新代码的套接字空闲超时。Node 的 req.setTimeout 是「多久没有收发任何字节」，不是整笔请求的总时长：
// 8 MiB 分片在 1 Mbps 上行要传一分多钟，只要字节在走就不会触发；真正卡死的是半开连接（对端没了、本端还在等）。
export const DEFAULT_TIMEOUT_MS = 120000

// URL 路径需逐段编码（中文文件名会变成 %XX），但签名里用原始路径
export const encodePath = (key) => '/' + key.split('/').map(encodeURIComponent).join('/')

// 简单并发池：最多 concurrency 个 worker 同时跑，worker(i) 返回第 i 项结果
export async function runPool(count, concurrency, worker) {
  const results = new Array(count)
  let next = 0
  async function runner() {
    while (next < count) { const i = next++; results[i] = await worker(i) }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, runner))
  return results
}

/** 从 COS 的错误 XML 里取 <Code>（AccessDenied / SignatureDoesNotMatch / InvalidAccessKeyId / NoSuchBucket …），取不到返回 null。 */
export function cosErrorCode(text) {
  const m = /<Code>([^<]+)<\/Code>/.exec(String(text || ''))
  return m ? m[1] : null
}

// 给 Error 挂 status / code，但设成不可枚举：未捕获异常时 Node 用 util.inspect 打印错误对象，
// 可枚举属性会多打一段「{ status: 403, code: … }」—— publish-cos 的 stderr 就和抽出前不一样了。
function tagError(e, status, text) {
  Object.defineProperty(e, 'status', { value: status, enumerable: false, configurable: true, writable: true })
  Object.defineProperty(e, 'code', { value: cosErrorCode(text), enumerable: false, configurable: true, writable: true })
  return e
}

/**
 * 建一个绑定了凭据与桶的 COS 客户端。
 *   host        实际发请求的域名：accelerate 为真时走全球加速域名（只用于上传）
 *   regionHost  地域域名：复制源（x-cos-copy-source）与公共读恒用它（加速域名不能作复制源，也不保证公共读）
 */
export function createCos({ secretId, secretKey, bucket, region, accelerate = false }) {
  // 全球加速域名不含地域；常规域名带地域。二者签名算法一致（不签 Host）。
  const host = accelerate
    ? `${bucket}.cos.accelerate.myqcloud.com`
    : `${bucket}.cos.${region}.myqcloud.com`
  const regionHost = `${bucket}.cos.${region}.myqcloud.com`

  // COS 请求签名（q-sign 格式）：对 method + pathname（+ query 参数）签名，不签 header（q-header-list 空）。
  // signature 用「原始未编码」pathname 参与计算。无 params 时与旧版单 PUT 的签名串完全一致（向后兼容）。
  function authorization(method, pathname, params) {
    const now = Math.floor(Date.now() / 1000) - 60 // 留点时钟偏差余量
    const exp = now + 3600
    const signTime = `${now};${exp}`
    const signKey = hmac(secretKey, signTime)
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
      `q-ak=${secretId}`,
      `q-sign-time=${signTime}`,
      `q-key-time=${signTime}`,
      'q-header-list=',
      `q-url-param-list=${paramList}`,
      `q-signature=${signature}`
    ].join('&')
  }

  // 带签名的一次性请求（支持 query 参数与内存 body）：分块上传的 initiate / part / complete / abort 各步共用。
  // 非 2xx 时 reject 的 Error 另挂 status 与 code（COS 错误码），文案与原版一致（调用方只用 message 的首行）。
  // timeoutMs：给了（> 0）才设套接字空闲超时，超时按网络错误 reject（无 status，调用方的重试会接住）；
  //   不给就不调 req.setTimeout —— publish-cos 走的正是这条路，请求对象上的调用序列与原版一样。
  function signedRequest(method, key, { params, body, headers, timeoutMs } = {}) {
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
      const req = https.request({ host, method, path, headers: h }, (r) => {
        const chunks = []
        r.on('data', (d) => chunks.push(d))
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (r.statusCode >= 200 && r.statusCode < 300) res({ status: r.statusCode, headers: r.headers, text })
          else rej(tagError(new Error(`HTTP ${r.statusCode} ${method} ${key}\n${text.slice(0, 300)}`), r.statusCode, text))
        })
      })
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${key} 超时（${timeoutMs / 1000} s 无收发）`)))
      req.on('error', rej)
      if (body != null) req.write(body)
      req.end()
    })
  }

  // ---- 单次 PUT（小文件；也作大文件分块上传失败时的整包兜底）----
  // label：进度行与报错文案里显示的名字（publish-cos 显示文件名，不显示完整 key）。
  // headers：追加在 {Authorization, Content-Length} 之后；不传时请求头对象与键序都和原版一样。
  function putOnce(key, fullPath, { label = key, headers } = {}) {
    const pathnameRaw = '/' + key
    const requestPath = encodePath(key)
    const size = statSync(fullPath).size
    return new Promise((res, rej) => {
      let settled = false
      const done = (err) => { if (settled) return; settled = true; err ? rej(err) : res() }
      const req = https.request(
        {
          host,
          method: 'PUT',
          path: requestPath,
          headers: { Authorization: authorization('put', pathnameRaw), 'Content-Length': size, ...(headers || {}) }
        },
        (r) => {
          let body = ''
          r.on('data', (d) => (body += d))
          r.on('end', () => {
            if (r.statusCode === 200) done()
            else done(tagError(new Error(`${label} 上传失败 HTTP ${r.statusCode}\n${body}`), r.statusCode, body))
          })
        }
      )
      const stream = createReadStream(fullPath)
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
          process.stdout.write(`\r  ${label}  ${pct}%   `)
        }
      })
      stream.on('end', () => process.stdout.write('\n'))
      stream.pipe(req)
    })
  }

  // 大文件在弱网下单次 PUT 易被重置（ECONNRESET / syscall:read），失败自动重试
  async function put(key, fullPath, { tries = 4, label = key, headers } = {}) {
    for (let i = 1; i <= tries; i++) {
      try {
        await putOnce(key, fullPath, { label, headers })
        return
      } catch (e) {
        if (i === tries) throw e
        console.warn(`\n  ${label} 第 ${i} 次上传失败（${e.message.split('\n')[0]}），重试中…`)
        await sleep(1500 * i)
      }
    }
  }

  // ---- 分块并发上传（大文件）：initiate → 并发 upload part → complete；失败 abort 清理 ----
  // headers：对象元数据（Content-Type / Cache-Control / x-cos-meta-*）只能在 initiate 时给，part / complete 不带。
  // timeoutMs：见 signedRequest；四步都透传，缺省 undefined（publish-cos 的分块上传不设超时，与原版一致）。
  async function initiateMultipart(key, headers, timeoutMs) {
    const res = await signedRequest('POST', key, { params: { uploads: '' }, headers, timeoutMs })
    const m = res.text.match(/<UploadId>([^<]+)<\/UploadId>/)
    if (!m) throw new Error('初始化分块上传失败，未返回 UploadId：' + res.text.slice(0, 200))
    return m[1]
  }

  async function uploadPart(key, uploadId, partNumber, buf, tries = 4, timeoutMs) {
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await signedRequest('PUT', key, { params: { partNumber: String(partNumber), uploadId }, body: buf, timeoutMs })
        const etag = res.headers.etag || res.headers.ETag
        if (!etag) throw new Error(`分片 ${partNumber} 响应缺少 ETag`)
        return etag   // 含双引号，原样回填到 complete 的 <ETag>
      } catch (e) {
        if (i === tries) throw e
        await sleep(1000 * i)
      }
    }
  }

  async function completeMultipart(key, uploadId, etags, timeoutMs) {
    const partsXml = etags.map((et, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${et}</ETag></Part>`).join('')
    const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`
    const res = await signedRequest('POST', key, { params: { uploadId }, body, headers: { 'Content-Type': 'application/xml' }, timeoutMs })
    // COS 的 complete 可能返回 200 但 body 里其实是 <Error>（如某分片缺失），需显式校验
    if (/<Error>/.test(res.text)) throw new Error('合并分块失败：' + res.text.slice(0, 300))
  }

  async function abortMultipart(key, uploadId, timeoutMs) {
    try { await signedRequest('DELETE', key, { params: { uploadId }, timeoutMs }) } catch { /* 兜底清理，忽略失败 */ }
  }

  // src：本机文件路径（整读后切片，安装包 ~108 MB、模型原件最大 ~91 MB，开发机内存充裕，整读最稳）或 Buffer
  async function multipartUpload(key, src, { label = key, partSize = 8 * 1024 * 1024, concurrency = 4, headers, timeoutMs } = {}) {
    const data = Buffer.isBuffer(src) ? src : readFileSync(src)
    const total = data.length
    const nParts = Math.ceil(total / partSize)
    process.stdout.write(`  ${label}  分块并发上传：${nParts} 片 × ${partSize / 1024 / 1024}MB，并发 ${concurrency}\n`)
    const uploadId = await initiateMultipart(key, headers, timeoutMs)
    try {
      let done = 0
      const etags = await runPool(nParts, concurrency, async (i) => {
        const start = i * partSize
        const end = Math.min(start + partSize, total)
        const et = await uploadPart(key, uploadId, i + 1, data.subarray(start, end), 4, timeoutMs)
        done++
        process.stdout.write(`\r  ${label}  ${Math.floor((done / nParts) * 100)}%  (${done}/${nParts} 片)   `)
        return et
      })
      process.stdout.write('\n')
      await completeMultipart(key, uploadId, etags, timeoutMs)
    } catch (e) {
      await abortMultipart(key, uploadId, timeoutMs)   // 取消未完成的分块上传，避免在桶里留下碎片（会计费）
      throw e
    }
  }

  // ---- 以下为新增 ----

  /**
   * 公共读 HEAD（不签名，恒走地域域名）。resolve { status, bytes, etag, sha256, contentType, cacheControl, lastModified }，
   * 任何 HTTP 状态都 resolve（404 = 不存在），只有网络错误 / 超时才 reject。
   * sha256 = 对象元数据 x-cos-meta-sha256（nasa3d:publish 上传时写进去的内容哈希；COS 的 HEAD 会原样回带 x-cos-meta-*）。
   * 分块上传的对象 ETag 是「md5-N」、不是内容哈希，没有这个头就没法判断「同字节数、不同内容」。
   */
  function headPublic(key, { timeoutMs = 30000 } = {}) {
    return new Promise((res, rej) => {
      const req = https.request({ host: regionHost, method: 'HEAD', path: encodePath(key), headers: { 'User-Agent': 'satsim-publish' } }, (r) => {
        r.resume()
        r.on('end', () => {
          const h = r.headers || {}
          const n = Number(h['content-length'])
          const sm = String(h['x-cos-meta-sha256'] || '').trim().toLowerCase()
          res({
            status: r.statusCode,
            bytes: Number.isFinite(n) ? n : null,
            etag: h.etag || null,
            sha256: /^[0-9a-f]{64}$/.test(sm) ? sm : null,
            contentType: h['content-type'] || null,
            cacheControl: h['cache-control'] || null,
            lastModified: h['last-modified'] || null
          })
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`HEAD ${key} 超时（${timeoutMs / 1000} s）`)))
      req.on('error', rej)
      req.end()
    })
  }

  /**
   * 公共读 GET（不签名，恒走地域域名——源站，不经 CDN 缓存，读到的就是桶里此刻的对象）。
   * resolve { status, headers, body: Buffer }；任何 HTTP 状态都 resolve，网络错误 / 超时 / 超过 maxBytes 才 reject。
   * maxBytes：云端 manifest 全库约 0.5 MB，给 64 MiB 上限防止读到异常大对象把内存吃满。
   */
  function getPublic(key, { timeoutMs = 30000, maxBytes = 64 * 1024 * 1024 } = {}) {
    return new Promise((res, rej) => {
      const req = https.request({ host: regionHost, method: 'GET', path: encodePath(key), headers: { 'User-Agent': 'satsim-publish' } }, (r) => {
        const chunks = []
        let n = 0, over = false
        r.on('data', (d) => {
          if (over) return
          n += d.length
          // 先 reject 再断开：断开后响应流可能照样发 end，不能让它把截断的正文当成完整结果 resolve 出去
          if (n > maxBytes) { over = true; rej(new Error(`GET ${key} 超过 ${maxBytes} 字节`)); req.destroy(); return }
          chunks.push(d)
        })
        r.on('end', () => { if (!over) res({ status: r.statusCode, headers: r.headers || {}, body: Buffer.concat(chunks) }) })
        r.on('error', rej)
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`GET ${key} 超时（${timeoutMs / 1000} s）`)))
      req.on('error', rej)
      req.end()
    })
  }

  /**
   * 内存 body 的带签名 PUT（manifest、sha256 旁车、小 blob）。headers 例：
   *   { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'public, max-age=31536000, immutable', 'x-cos-meta-sha256': '<hex>' }
   * 失败按 put() 同款退避重试（1.5 s·i）；4xx（除 408 / 429）是权限或请求本身的问题，重试无益，直接抛。
   * 超时（DEFAULT_TIMEOUT_MS 无收发）按网络错误处理，同样重试。
   */
  async function putBuffer(key, buf, headers, { tries = 4, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
    for (let i = 1; i <= tries; i++) {
      try {
        return await signedRequest('PUT', key, { body, headers, timeoutMs })
      } catch (e) {
        const permanent = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429
        if (permanent || i === tries) throw e
        console.warn(`\n  ${key} 第 ${i} 次上传失败（${e.message.split('\n')[0]}），重试中…`)
        await sleep(1500 * i)
      }
    }
  }

  /**
   * 写权限探针：带签名 PUT 一个固定小对象（每次覆盖，不删 —— 发布密钥的策略只有 PutObject + 分块上传，未必有 DeleteObject）。
   * 返回 { ok, status, code, message }，不抛：
   *   code = 'AccessDenied'           → CAM 策略没放行这个前缀（改策略，不是改密钥）
   *   code = 'SignatureDoesNotMatch' / 'InvalidAccessKeyId' → 密钥本身不对
   *   status = 0                      → 网络不通（message 为底层错误）
   */
  async function probeWrite(key, body = 'satsim publish probe\n', { timeoutMs = 30000 } = {}) {
    try {
      const r = await signedRequest('PUT', key, { body, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, timeoutMs })
      return { ok: true, status: r.status, code: null, message: '' }
    } catch (e) {
      return { ok: false, status: e.status || 0, code: e.code || null, message: String(e.message || e).split('\n')[0] }
    }
  }

  return {
    host, regionHost,
    authorization, signedRequest, putOnce, put,
    multipartUpload, initiateMultipart, uploadPart, completeMultipart, abortMultipart,
    headPublic, getPublic, putBuffer, probeWrite
  }
}
