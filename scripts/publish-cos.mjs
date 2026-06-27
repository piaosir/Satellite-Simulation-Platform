// 把 release/ 里的更新文件上传到腾讯云 COS 的 /updates/ 目录。
//
// 零依赖实现：只用 Node 内置 https + crypto 调用 COS REST 接口（PUT Object），
// 自行计算 COS 请求签名，不依赖任何第三方 SDK，稳定且无安全漏洞负担。
//
// 用法（PowerShell）：
//   $env:COS_SECRET_ID="你的SecretId"; $env:COS_SECRET_KEY="你的SecretKey"
//   $env:COS_BUCKET="update-1385987144"; $env:COS_REGION="ap-beijing"
//   node scripts/publish-cos.mjs
//
// 凭证从环境变量读取，绝不写进仓库。建议用腾讯云 CAM 子账号密钥，权限只给该桶。
//
// 上传的文件：
//   - latest.yml            ← 客户端据此判断版本（必传）
//   - *-Setup.exe           ← NSIS 安装包
//   - *-Setup.exe.blockmap  ← 差量更新用，显著减小下次更新下载量

import { readdirSync, statSync, createReadStream } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHmac, createHash } from 'node:crypto'
import https from 'node:https'

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION')
  process.exit(1)
}

const HOST = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`
const RELEASE_DIR = resolve('release')
const PREFIX = 'updates/'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha1', key).update(s).digest('hex')

// COS 请求签名（q-sign 格式）。signature 用「原始未编码」pathname 参与计算。
function authorization(method, pathname) {
  const now = Math.floor(Date.now() / 1000) - 60 // 留点时钟偏差余量
  const exp = now + 3600
  const signTime = `${now};${exp}`
  const signKey = hmac(COS_SECRET_KEY, signTime)
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n\n` // 无 query、无签名头
  const stringToSign = `sha1\n${signTime}\n${sha1(httpString)}\n`
  const signature = hmac(signKey, stringToSign)
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${COS_SECRET_ID}`,
    `q-sign-time=${signTime}`,
    `q-key-time=${signTime}`,
    'q-header-list=',
    'q-url-param-list=',
    `q-signature=${signature}`
  ].join('&')
}

// URL 路径需逐段编码（中文文件名会变成 %XX），但签名里用原始路径
const encodePath = (key) => '/' + key.split('/').map(encodeURIComponent).join('/')

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
      await new Promise((r) => setTimeout(r, 1500 * i))
    }
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

console.log(`准备上传 ${files.length} 个文件到 ${HOST}/${PREFIX}`)
// latest.yml 最后传：确保安装包先到位，避免客户端读到新版本号却下载不到包
const ordered = files.sort((a) => (a === 'latest.yml' ? 1 : -1))
for (const f of ordered) {
  await put(f)
}
console.log('✅ 上传完成')
