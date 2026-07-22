// OMM 云镜像（腾讯云 COS）的开发者侧工具：桶里那份星历的「播种」与「客户端回传凭证」的生成。
//
// 用法（PowerShell，凭证从环境变量读，绝不写进仓库）：
//   node scripts/omm-cos.mjs seed     # 把 resources/omm/*.csv.gz 传到桶的 omm/ 前缀（需 COS_SECRET_ID/KEY/BUCKET/REGION）
//   node scripts/omm-cos.mjs status   # 只读：看桶里各组现在是哪天的、多大（无需凭证）
//
// 为什么要 seed：客户端的「众包回传」只有第一个直连 CelesTrak 成功的用户跑得起来；发版当天先播一份种，
// 保证被墙的用户从第一分钟起就有云端可取。跑完 npm run omm:snapshot 后顺手 seed 一次即可。
//
// 客户端回传用的是在线分享那份 CAM 子账号密钥（electron/services/shareConfig.js），无需另配；
// 但要在腾讯云 CAM 里给该子账号的策略补上本桶 omm/* 的 PutObject/GetObject/HeadObject。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHmac, createHash } from 'node:crypto'
import https from 'node:https'

const cmd = (process.argv[2] || '').toLowerCase()
const PREFIX = 'omm/'
const SNAP_DIR = resolve('resources', 'omm')

const BUCKET = process.env.OMM_COS_BUCKET || process.env.COS_BUCKET || 'update-1385987144'
const REGION = process.env.OMM_COS_REGION || process.env.COS_REGION || 'ap-beijing'
const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`

// ---- COS q-sign 签名（与 scripts/publish-cos.mjs、electron/services/ommCloud.js 同一实现）----
function authorization(method, pathname, id, key) {
  const now = Math.floor(Date.now() / 1000) - 60
  const exp = now + 3600
  const signTime = `${now};${exp}`
  const signKey = createHmac('sha1', key).update(signTime).digest('hex')
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n\n`
  const stringToSign = `sha1\n${signTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  return [
    'q-sign-algorithm=sha1', `q-ak=${id}`, `q-sign-time=${signTime}`, `q-key-time=${signTime}`,
    'q-header-list=', 'q-url-param-list=', `q-signature=${signature}`
  ].join('&')
}

function request(method, key, body, auth) {
  return new Promise((res, rej) => {
    const headers = {}
    if (auth) headers.Authorization = auth
    if (body) { headers['Content-Length'] = body.length; headers['Content-Type'] = 'application/gzip' }
    const req = https.request({ host: HOST, method, path: '/' + key, headers, timeout: 120000 }, (r) => {
      const chunks = []
      r.on('data', (d) => chunks.push(d))
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rej)
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')) })
    if (body) req.write(body)
    req.end()
  })
}

const groupsInSnapshot = () => {
  if (!existsSync(SNAP_DIR)) return []
  return readdirSync(SNAP_DIR).filter((f) => /^csv_.+\.csv\.gz$/.test(f)).map((f) => f.slice(4, -7)).sort()
}

// ---- status：桶里各组的时间与大小（公有读，无需凭证）----
async function status() {
  const keys = groupsInSnapshot()
  if (!keys.length) { console.error('resources/omm 下没有快照，先跑 npm run omm:snapshot'); process.exit(1) }
  console.log(`桶 ${HOST} 的 ${PREFIX} 前缀：`)
  for (const k of keys) {
    const r = await request('HEAD', `${PREFIX}csv_${k}.csv.gz`)
    if (r.status === 200) {
      const kb = (parseInt(r.headers['content-length'], 10) / 1024).toFixed(0)
      console.log(`  ${k.padEnd(12)} ${String(kb).padStart(5)}KB   ${r.headers['last-modified']}`)
    } else {
      console.log(`  ${k.padEnd(12)} —— 未上传 (HTTP ${r.status})`)
    }
  }
}

// ---- seed：把本地快照传上桶（同名覆盖，桶里每组只留最新一份）----
async function seed() {
  const { COS_SECRET_ID, COS_SECRET_KEY } = process.env
  const id = process.env.OMM_COS_ID || COS_SECRET_ID
  const key = process.env.OMM_COS_KEY || COS_SECRET_KEY
  if (!id || !key) { console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY（或 OMM_COS_ID / OMM_COS_KEY）'); process.exit(1) }
  const keys = groupsInSnapshot()
  if (!keys.length) { console.error('resources/omm 下没有快照，先跑 npm run omm:snapshot'); process.exit(1) }
  console.log(`上传 ${keys.length} 组到 ${HOST}/${PREFIX}`)
  let ok = 0
  for (const g of keys) {
    const file = join(SNAP_DIR, `csv_${g}.csv.gz`)
    const buf = readFileSync(file)
    const objKey = `${PREFIX}csv_${g}.csv.gz`
    try {
      const r = await request('PUT', objKey, buf, authorization('put', '/' + objKey, id, key))
      if (r.status === 200) { ok++; console.log(`  ✅ ${g.padEnd(12)} ${(buf.length / 1024).toFixed(0)}KB`) }
      else console.error(`  ❌ ${g.padEnd(12)} HTTP ${r.status} ${r.text.slice(0, 200)}`)
    } catch (e) { console.error(`  ❌ ${g.padEnd(12)} ${e.message}`) }
  }
  console.log(`完成：${ok}/${keys.length} 组已上传`)
  if (ok < keys.length) process.exitCode = 1
}

if (cmd === 'seed') await seed()
else if (cmd === 'status') await status()
else {
  console.log('用法：node scripts/omm-cos.mjs <seed|status>')
  console.log('  seed    把 resources/omm/*.csv.gz 播种到桶的 omm/ 前缀')
  console.log('  status  查看桶里各组的时间与大小（无需凭证）')
  process.exitCode = 1
}
