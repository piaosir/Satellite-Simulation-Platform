// 切换 COS 桶的「全球加速 / Global Acceleration」开关（桶级配置，PUT Bucket accelerate）。
// 零依赖：与 publish-cos.mjs 同一套签名实现，独立成小工具，方便发版脚本调用。
//
// 用法：
//   node scripts/cos-accelerate.mjs on    开启全球加速
//   node scripts/cos-accelerate.mjs off   关闭全球加速
//   node scripts/cos-accelerate.mjs status 查询当前状态
//
// 注意：开启/关闭在 COS 侧生效可能有数十秒延迟；发版脚本 publish-cos.mjs 走
// COS_ACCELERATE=1 时使用 <bucket>.cos.accelerate.myqcloud.com 域名，若此时桶尚未
// 真正启用加速会连接失败——故本脚本 on 之后会轮询 status 直到确认 Enabled 再退出。

import { createHmac, createHash } from 'node:crypto'
import https from 'node:https'

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env
if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION')
  process.exit(1)
}
const action = process.argv[2]
if (!['on', 'off', 'status'].includes(action)) {
  console.error('用法：node scripts/cos-accelerate.mjs on|off|status')
  process.exit(1)
}

// 桶级配置恒走常规地域域名（加速域名本身依赖该配置已生效，不能用来设置自己）
const HOST = `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com`
const sha1 = (s) => createHash('sha1').update(s).digest('hex')
const hmac = (key, s) => createHmac('sha1', key).update(s).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 与 publish-cos.mjs 完全一致的 q-sign 签名（桶根路径 '/'，query 参数 accelerate=''）
function authorization(method, params) {
  const now = Math.floor(Date.now() / 1000) - 60
  const exp = now + 3600
  const signTime = `${now};${exp}`
  const signKey = hmac(COS_SECRET_KEY, signTime)
  const keys = Object.keys(params || {}).sort()
  const paramList = keys.map((k) => k.toLowerCase()).join(';')
  const paramStr = keys
    .map((k) => `${encodeURIComponent(k.toLowerCase())}=${encodeURIComponent(params[k] == null ? '' : String(params[k]))}`)
    .join('&')
  const httpString = `${method.toLowerCase()}\n/\n${paramStr}\n\n`
  const stringToSign = `sha1\n${signTime}\n${sha1(httpString)}\n`
  const signature = hmac(signKey, stringToSign)
  return [
    'q-sign-algorithm=sha1', `q-ak=${COS_SECRET_ID}`, `q-sign-time=${signTime}`, `q-key-time=${signTime}`,
    'q-header-list=', `q-url-param-list=${paramList}`, `q-signature=${signature}`
  ].join('&')
}

function request(method, body) {
  const params = { accelerate: '' }
  return new Promise((resolve, reject) => {
    const headers = { Authorization: authorization(method, params) }
    if (body != null) { headers['Content-Type'] = 'application/xml'; headers['Content-Length'] = Buffer.byteLength(body) }
    const req = https.request({ host: HOST, method, path: '/?accelerate', headers }, (r) => {
      const chunks = []
      r.on('data', (d) => chunks.push(d))
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (r.statusCode >= 200 && r.statusCode < 300) resolve(text)
        else reject(new Error(`HTTP ${r.statusCode} ${method} /?accelerate\n${text.slice(0, 300)}`))
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

async function getStatus() {
  const text = await request('GET')
  const m = /<Status>([^<]+)<\/Status>/.exec(text)
  return m ? m[1] : 'Unknown'
}

async function main() {
  if (action === 'status') {
    console.log(`全球加速状态：${await getStatus()}`)
    return
  }
  const target = action === 'on' ? 'Enabled' : 'Suspended'
  const body = `<AccelerateConfiguration><Status>${target}</Status></AccelerateConfiguration>`
  await request('PUT', body)
  console.log(`已提交：全球加速 → ${target}，等待生效...`)
  if (action === 'on') {
    for (let i = 0; i < 20; i++) {
      await sleep(3000)
      const s = await getStatus()
      if (s === 'Enabled') { console.log('✅ 全球加速已生效'); return }
      process.stdout.write(`  仍在生效中(${s})，继续等待...\n`)
    }
    console.warn('⚠️ 等待超时，全球加速可能尚未完全生效（发版脚本会用常规域名兜底）')
  } else {
    console.log('✅ 已提交关闭')
  }
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
