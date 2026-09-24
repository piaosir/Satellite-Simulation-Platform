// 把 release/ 里的更新文件上传到腾讯云 COS 的 /updates/ 目录。
//
// 零依赖实现：只用 Node 内置 https + crypto 调用 COS REST 接口，自行计算 q-sign 签名，
// 不依赖任何第三方 SDK，稳定且无安全漏洞负担。
// 签名 / 单次 PUT / 分块并发上传在 scripts/lib/cos.mjs（与 scripts/nasa3d/publish.mjs 共用）；
// 抽出时逐字搬运，本脚本的请求序列与终端输出与抽出前一致（录制补丁逐条比对过，见 lib 头注）。
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

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import https from 'node:https'
import { createCos, encodePath } from './lib/cos.mjs'

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, COS_ACCELERATE } = process.env
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION')
  process.exit(1)
}

const ACCEL = COS_ACCELERATE === '1' || COS_ACCELERATE === 'true'
// 全球加速域名不含地域；常规域名带地域。二者签名算法一致（不签 Host）。
const cos = createCos({ secretId: COS_SECRET_ID, secretKey: COS_SECRET_KEY, bucket: COS_BUCKET, region: COS_REGION, accelerate: ACCEL })
const HOST = cos.host
const RELEASE_DIR = resolve('release')
const PREFIX = 'updates/'
const PART_SIZE = 8 * 1024 * 1024            // 分片大小 8MB（COS 单片下限 1MB，末片可小于此）
const CONCURRENCY = 4                        // 并发分片数：高 RTT 链路用多流填满管道
const MULTIPART_THRESHOLD = 8 * 1024 * 1024  // 超过此大小走分块并发，否则单次 PUT

// 固定下载地址：安装包除了按版本号命名的那一份，再在桶内复制一份到固定键名（服务端复制，零上传）。
// 小程序「仿真平台」页、关于窗口、对外分享写的都是这一个地址，不随版本号变：
//   https://<bucket>.cos.<region>.myqcloud.com/updates/satsim-setup.exe
// 浏览器落盘时文件名仍是「卫星仿真平台-x.y.z-Setup.exe」——靠复制时改写的 Content-Disposition（RFC 5987 filename*）。
// 自动更新只认 latest.yml 里列的文件，不认识这个对象，互不影响。
const STABLE_FILE = 'satsim-setup.exe'
const STABLE_URL = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${PREFIX}${STABLE_FILE}`

// 签名、带签名请求、单次 PUT、分块上传都在 lib/cos.mjs；这里只把「文件名」绑成 key + 本机路径，
// 进度行与重试警告仍显示文件名（label），signedRequest 的报错仍显示完整 key —— 与抽出前一致。
const signedRequest = cos.signedRequest
const put = (file) => cos.put(PREFIX + file, join(RELEASE_DIR, file), { label: file })
const multipartUpload = (file) => cos.multipartUpload(PREFIX + file, join(RELEASE_DIR, file), { label: file, partSize: PART_SIZE, concurrency: CONCURRENCY })

// ---- 固定下载地址：PUT Object - Copy（x-cos-copy-source），桶内服务端复制，不经本机 ----
// 源对象是公读的，故复制只要求本密钥对 updates/* 有 PutObject（发布密钥本就有）。
async function copyToStable(setupFile) {
  const srcKey = PREFIX + setupFile
  const dstKey = PREFIX + STABLE_FILE
  // 复制源恒用常规域名（加速域名不能作 copy-source）；本请求自身仍走 HOST
  const source = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com${encodePath(srcKey)}`
  const disposition = `attachment; filename="${STABLE_FILE}"; filename*=UTF-8''${encodeURIComponent(setupFile)}`
  const res = await signedRequest('PUT', dstKey, {
    headers: {
      'x-cos-copy-source': source,
      'x-cos-metadata-directive': 'Replaced',
      'Content-Type': 'application/x-msdownload',
      'Content-Disposition': disposition,
      'Content-Length': 0
    }
  })
  // 与 complete 同款：COS 可能 200 但 body 是 <Error>
  if (/<Error>/.test(res.text) || !/<ETag>/.test(res.text)) throw new Error('复制到固定地址失败：' + res.text.slice(0, 300))
  console.log(`  固定下载地址已指向 ${setupFile}\n  ${STABLE_URL}`)
}

// COS 上当前发布的安装包文件名（latest.yml 的 path；公读，无需签名）
function fetchPublishedSetup() {
  return new Promise((res, rej) => {
    https.get({ host: `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`, path: encodePath(PREFIX + 'latest.yml') }, (r) => {
      let t = ''
      r.on('data', (d) => (t += d))
      r.on('end', () => {
        const m = /^path:\s*(.+?)\s*$/m.exec(t)
        if (r.statusCode !== 200 || !m) return rej(new Error(`读取 latest.yml 失败（HTTP ${r.statusCode}）`))
        res(m[1].replace(/^['"]|['"]$/g, ''))
      })
    }).on('error', rej)
  })
}

// 只上传与自动更新相关的文件（不传 portable 等无关产物）。
// 安装包/blockmap 还要求文件名包含当前 package.json 版本号：release/ 目录不会在构建前自动清空，
// 若目录里残留着上一次（旧版本号）的 Setup.exe，正则若不带版本号会把新旧两个版本都上传到 COS。
// --stable-only：不上传任何文件，只把 COS 上当前发布的安装包（latest.yml 的 path）复制到固定下载地址。
// 用于补做（旧版发布时还没有这一步）或上一次发布末尾复制失败后的修复。
if (process.argv.includes('--stable-only')) {
  const setup = await fetchPublishedSetup()
  console.log(`当前发布的安装包：${setup}`)
  await copyToStable(setup)
  process.exit(0)
}

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
const setupRe = new RegExp(`-${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-Setup\\.exe(\\.blockmap)?$`)
const allFiles = readdirSync(RELEASE_DIR)
const files = allFiles.filter((f) => f === 'latest.yml' || setupRe.test(f))
const skipped = allFiles.filter((f) => /-Setup\.exe(\.blockmap)?$/.test(f) && !setupRe.test(f))
if (skipped.length) {
  console.warn(`⚠️  忽略 release/ 下 ${skipped.length} 个非当前版本（${version}）的安装包，未上传：\n  ${skipped.join('\n  ')}`)
}
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

// 固定下载地址跟上这一版。失败不算发布失败（自动更新已经可用），但要喊出来：否则固定地址会停在旧版
const setupFile = files.find((f) => /-Setup\.exe$/.test(f))
if (setupFile) {
  try { await copyToStable(setupFile) } catch (e) {
    console.warn(`⚠️  固定下载地址未更新（${e.message.split('\n')[0]}）。稍后单独执行：node scripts/publish-cos.mjs --stable-only`)
  }
}
