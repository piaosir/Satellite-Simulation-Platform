// NASA 3D 分发件与原件镜像上 COS（npm run nasa3d:publish）。
//
//   node scripts/nasa3d/publish.mjs [--dry-run] [--only-src | --only-build] [--concurrency=N] [--build-dir=目录] [--src-dir=目录]
//                                   [--allow-shrink] [--allow-other-bucket]
//
// 上传什么（前缀都在 updates/models/ 下——发布密钥的 CAM 策略只放行 updates/*，models/* 必 403）：
//   blobs      updates/models/blobs/<sha256>.glb|.webp     build/models 三档 glb（与缩略图，有则传）；内容寻址，immutable 一年
//   原件镜像   updates/models/src/nasa/<slug>/<原文件名>     .models-src/nasa 的只读原件 + 同名 .sha256 旁车；
//                                                         nasa3d:fetch --source=cos 从这里补下（NASA 源站国内慢 / 限速时用）
//   manifest   updates/models/manifest.<buildId>.json（不可变快照）→ 最后 updates/models/manifest.json（no-cache）
// 顺序有讲究（DESIGN §8）：探针 → blobs → 原件镜像 → manifest 快照 → manifest.json。manifest.json 最后传，
// 与 publish-cos.mjs「latest.yml 最后传」同一个理由：客户端读到新 manifest 时它引用的 blob 必须已经在桶里。
// 原件镜像里 .sha256 旁车排在它的 glb 之后、且 glb 没传上就不传旁车：桶里的旁车永远描述桶里那份 glb。
//
// 缩水闸（探针之后、传任何东西之前）：公共读 GET 云端现有 manifest.json，本次 manifest 少了云端有的 id 就拒绝（退出码 2），
//   列出会消失的 id。为什么要这一道：build 的子集运行（--groups / --only 换了选项 / 全新 --out）得到的是不完整目录，
//   build 已改为写 manifest.partial.json、不覆盖 manifest.json，但手工拷目录、改名、换 --build-dir 仍可能把子集当全量传上去——
//   传上去客户端库里其余模型整批消失、绑定全部退回图标，而本机看不出任何异常。确要缩减（下架条目）加 --allow-shrink。
//   云端读不到（网络 / 非 200 / 404 以外）或读不懂同样拒绝：比对不了就不覆盖。404 = 首次发布，放行。
//   同一道闸还比缩略图：云端带 files.thumb、本次同一 id 却没有的（thumbLost）同样拒绝——build 判缩略图过期就不写进 manifest
//   （改了 frame / 显示系、没重跑 nasa3d:sheets 时整批过期），传上去客户端库画廊整批变空卡。正确顺序 sheets → build → publish；
//   确要去掉缩略图同样加 --allow-shrink。
//
// 去重：先做不签名的公共读 HEAD（桶是公共读、私有写），200 + 字节数相同之后按可信度依次比：
//   ① 对象元数据 x-cos-meta-sha256（本脚本上传时一律写上，COS 签名不签头、HEAD 原样回带）→ 与本地 sha256 严格比；
//   ② 单次 PUT 的对象 ETag 就是内容 MD5 → 严格比；
//   ③ 都没有（分块上传的对象 ETag 是「md5-N」，不是内容哈希）：blob 按 sha256 命名、同名即同内容，只比字节数够用；
//      原件镜像按文件名寻址，NASA 重导出一个同字节数的新文件就会被误判「已在桶里」——所以原件一律重传，宁多传不留错件。
// 探针：带签名 PUT 一个固定小对象 updates/models/_probe（每次覆盖，不删：发布密钥未必有 DeleteObject）。
//   403 时按 COS 错误码区分：AccessDenied = CAM 策略没放行这个前缀（改策略），SignatureDoesNotMatch / InvalidAccessKeyId = 密钥不对。
// --dry-run：完全离线（不联网、不要凭据）——只做本地核对（manifest 自检、blob 与原件逐个重算 sha256）并打印计划与总字节；
//   缩水闸要读云端，只在实传时跑。
// 凭据：环境变量 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION（可选 COS_ACCELERATE=1 走全球加速上传）；
//   只判有无，绝不打印值。桶与地域必须是客户端钉死的那个（manifest.mjs 的 CDN_BASE），否则传上去客户端也看不到——
//   换桶测试时加 --allow-other-bucket。
// --src-dir：原件目录（缺省 .models-src/nasa；单测用它指到临时目录）。
// 退出码：0 完成；1 有文件没传上 / 本地核对不过；2 参数、凭据、桶不对、探针失败或缩水闸拦下。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createCos, runPool, DEFAULT_TIMEOUT_MS } from '../lib/cos.mjs'
import { REPO_ROOT, NASA_DIR, BUILD_ROOT, parseArgs, readSidecar, fmtBytes, formatTable, assertSafeSlug, MiB } from './lib.mjs'
import { checkManifestShape, LOD_SPECS } from './build.mjs'

export const PREFIX = 'updates/models/'
export const PROBE_KEY = PREFIX + '_probe'
export const PINNED_BUCKET = 'update-1385987144'
export const PINNED_REGION = 'ap-beijing'
export const MULTIPART_THRESHOLD = 8 * MiB
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable'
export const CACHE_NONE = 'no-cache'
/** 内容哈希写在对象元数据里（HEAD 回带）；键名小写，Node 收到的响应头也是小写。 */
export const META_SHA256 = 'x-cos-meta-sha256'
const CT = { glb: 'model/gltf-binary', webp: 'image/webp', png: 'image/png', json: 'application/json; charset=utf-8', sha256: 'text/plain; charset=utf-8' }

export const blobKey = (sha, ext) => `${PREFIX}blobs/${sha}.${ext}`
export const srcKey = (slug, file) => `${PREFIX}src/nasa/${assertSafeSlug(slug)}/${file}`
export const manifestKey = (buildId) => (buildId ? `${PREFIX}manifest.${buildId}.json` : `${PREFIX}manifest.json`)

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')
const firstLine = (e) => String((e && e.message) || e).split('\n')[0]

/**
 * 远端对象与本地内容是否一致（HEAD 结果 + 本地字节 / MD5 / sha256）。纯函数，单测覆盖。判据顺序见文件头「去重」：
 *   x-cos-meta-sha256（head.sha256）> 单次 PUT 的 MD5 ETag > 只比字节数（仅 contentAddressed，即键名本身就是内容哈希时）。
 * localMd5 / opts.sha256 不给就跳过对应那一级（传后回看时分块对象没有 MD5 可比）。
 */
export function remoteMatches(head, bytes, localMd5, { sha256: localSha = null, contentAddressed = false } = {}) {
  if (!head || head.status !== 200 || head.bytes !== bytes) return false
  if (head.sha256) return !localSha || head.sha256 === localSha
  const et = String(head.etag || '').replace(/^W\//, '').replace(/"/g, '')
  if (/^[0-9a-f]{32}$/i.test(et)) return !localMd5 || et.toLowerCase() === localMd5
  return contentAddressed === true
}

/** 探针结果 → 一句中文诊断（纯函数）。 */
export function explainProbe(p) {
  if (p.ok) return '写权限正常'
  if (p.status === 0) return `网络不通：${p.message}`
  if (p.code === 'AccessDenied') return 'HTTP 403 AccessDenied：密钥有效，但 CAM 策略没放行 updates/models/*（改策略，不是换密钥）'
  if (p.code === 'SignatureDoesNotMatch' || p.code === 'InvalidAccessKeyId') return `HTTP ${p.status} ${p.code}：密钥本身不对（SecretId / SecretKey 不匹配或已停用）`
  if (p.code === 'NoSuchBucket') return 'NoSuchBucket：桶名或地域写错了'
  return `HTTP ${p.status} ${p.code || ''}：${p.message}`
}

/**
 * 云端 manifest 与本次 manifest 的 id 对账（纯函数）。
 * 返回 { ok:false, error }（云端结构不对，比不了）| { ok:true, remoteCount, localCount, missing:[云端有、本次没有的 id，排序], added,
 *   thumbLost:[两边都有、云端带 files.thumb 本次却没有的 id，排序] }。
 */
export function diffManifestIds(remote, local) {
  if (!remote || typeof remote !== 'object' || !Array.isArray(remote.models)) return { ok: false, error: '云端 manifest.json 结构不对（models 不是数组）' }
  const ids = (m) => new Set((Array.isArray(m && m.models) ? m.models : []).map((x) => x && x.id).filter((x) => typeof x === 'string'))
  const thumbs = (m) => new Set((Array.isArray(m && m.models) ? m.models : []).filter((x) => x && typeof x.id === 'string' && x.files && x.files.thumb).map((x) => x.id))
  const r = ids(remote), l = ids(local)
  const missing = [...r].filter((id) => !l.has(id)).sort()
  let added = 0
  for (const id of l) if (!r.has(id)) added++
  const lt = thumbs(local)
  const thumbLost = [...thumbs(remote)].filter((id) => l.has(id) && !lt.has(id)).sort()
  return { ok: true, remoteCount: r.size, localCount: l.size, missing, added, thumbLost }
}

/**
 * 缩水闸：读云端 manifest.json 与本次比。返回
 *   { pass:true, first:true }                       云端还没有（404，首次发布）
 *   { pass:boolean, diff }                          比对得出（pass = 没有缺失）
 *   { pass:false, error }                           读不到 / 读不懂，比对不了
 */
export async function checkShrink(cos, manifest) {
  let r
  try { r = await cos.getPublic(manifestKey(null)) } catch (e) { return { pass: false, error: `读不到云端 manifest.json（${firstLine(e)}）` } }
  if (r.status === 404) return { pass: true, first: true }
  if (r.status !== 200) return { pass: false, error: `读云端 manifest.json 得到 HTTP ${r.status}` }
  let remote
  try { remote = JSON.parse(r.body.toString('utf8')) } catch { return { pass: false, error: '云端 manifest.json 不是合法 JSON' } }
  const diff = diffManifestIds(remote, manifest)
  if (!diff.ok) return { pass: false, error: diff.error }
  return { pass: diff.missing.length === 0 && diff.thumbLost.length === 0, diff }
}

/**
 * 分发件计划：manifest 里每条三档（+ 缩略图）→ { key, path, bytes, sha256, md5, contentType, contentAddressed:true }；同一 sha 只传一次。
 * 本地逐个重算 sha256，与 manifest 对不上直接记错（传上去就是按 sha 命名的错文件，客户端校验必失败）。
 */
export async function planBlobs(manifest, buildDir) {
  const items = new Map()
  const errors = []
  for (const m of manifest.models) {
    const dir = path.join(buildDir, m.id.replace(/^nasa:/, ''))
    const want = LOD_SPECS.map((s) => [s.key, 'glb', path.join(dir, `${s.key}.glb`)])
    if (m.files && m.files.thumb) want.push(['thumb', 'webp', path.join(dir, 'thumb.webp')])
    for (const [k, ext, p] of want) {
      const f = m.files && m.files[k]
      if (!f) { errors.push(`${m.id}：manifest 缺 files.${k}`); continue }
      if (items.has(f.sha256)) continue
      let buf
      try { buf = await fsp.readFile(p) } catch { errors.push(`${m.id}：本地缺 ${path.relative(REPO_ROOT, p)}`); continue }
      const h = sha256(buf)
      if (h !== f.sha256 || buf.byteLength !== f.bytes) { errors.push(`${m.id}：${k} 本地文件与 manifest 不符（sha ${h.slice(0, 12)}… / ${buf.byteLength} B，manifest ${f.sha256.slice(0, 12)}… / ${f.bytes} B）`); continue }
      items.set(f.sha256, { kind: 'blob', key: blobKey(f.sha256, ext), path: p, bytes: buf.byteLength, sha256: h, md5: md5(buf), contentType: CT[ext], cacheControl: CACHE_IMMUTABLE, contentAddressed: true, label: `${m.id} ${k}` })
    }
  }
  return { items: [...items.values()], errors }
}

/**
 * 原件镜像计划：<nasaDir>/<slug>/ 下每个 glb 与它的 .sha256 旁车（旁车必须与文件实算一致才传）。
 * 条目 role = 'glb' | 'sidecar'；旁车的 of = 它那个 glb 的 label（glb 没传上时旁车暂缓）。按文件名寻址，contentAddressed=false。
 */
export async function planSources(nasaDir) {
  const items = []
  const errors = []
  let slugs = []
  try { slugs = (await fsp.readdir(nasaDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort() } catch { errors.push(`找不到原件目录 ${nasaDir}`) }
  for (const slug of slugs) {
    const dir = path.join(nasaDir, slug)
    for (const f of (await fsp.readdir(dir)).filter((x) => x.toLowerCase().endsWith('.glb')).sort()) {
      const p = path.join(dir, f)
      const buf = await fsp.readFile(p)
      const h = sha256(buf)
      const side = readSidecar(p)
      if (!side) { errors.push(`${slug}/${f}：缺 .sha256 旁车`); continue }
      if (side !== h) { errors.push(`${slug}/${f}：旁车 ${side.slice(0, 12)}… 与实算 ${h.slice(0, 12)}… 不符`); continue }
      const label = `${slug}/${f}`
      items.push({ kind: 'src', role: 'glb', key: srcKey(slug, f), path: p, bytes: buf.byteLength, sha256: h, md5: md5(buf), contentType: CT.glb, cacheControl: CACHE_NONE, contentAddressed: false, label })
      const sp = p + '.sha256'
      const sbuf = await fsp.readFile(sp)
      items.push({ kind: 'src', role: 'sidecar', of: label, key: srcKey(slug, f + '.sha256'), path: sp, bytes: sbuf.byteLength, sha256: sha256(sbuf), md5: md5(sbuf), contentType: CT.sha256, cacheControl: CACHE_NONE, contentAddressed: false, label: `${label}.sha256` })
    }
  }
  return { items, errors }
}

async function loadManifestValidator() {
  try { return await import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'models', 'manifest.mjs')).href) } catch { return null }
}

function summarize(items) {
  const n = items.length
  const bytes = items.reduce((s, x) => s + x.bytes, 0)
  const big = items.filter((x) => x.bytes > MULTIPART_THRESHOLD).length
  return { n, bytes, big }
}

const uploadHeaders = (it) => ({ 'Content-Type': it.contentType, 'Cache-Control': it.cacheControl, [META_SHA256]: it.sha256 })

async function uploadOne(cos, it) {
  const buf = await fsp.readFile(it.path)
  // 读盘时再核一次：计划与上传之间文件被改过（nasa3d:fetch 并行在跑之类），元数据里的 sha 就会与内容不符
  if (sha256(buf) !== it.sha256) throw new Error('本地文件在计划之后被改过，重跑本命令')
  const headers = uploadHeaders(it)
  const multipart = buf.byteLength > MULTIPART_THRESHOLD
  if (multipart) await cos.multipartUpload(it.key, buf, { label: it.label, headers, timeoutMs: DEFAULT_TIMEOUT_MS })
  else await cos.putBuffer(it.key, buf, headers)
  // 传完用公共读回看一次：字节数 +（元数据 sha / 单次 PUT 的 MD5）对得上才算数——CAM 放行了写却没放行读、上传被截断，
  // 这里就能看出来。刚传的对象按「内容寻址」口径看（没有 sha 头也只比字节数）：这一步查的是传没传全，不是去重
  const h = await cos.headPublic(it.key)
  if (!remoteMatches(h, buf.byteLength, multipart ? null : it.md5, { sha256: it.sha256, contentAddressed: true })) throw new Error(`传后回看不符（HEAD ${h.status}，${h.bytes} B${h.sha256 && h.sha256 !== it.sha256 ? '，sha256 元数据不符' : ''}）`)
}

/** 一组对象：HEAD 去重 → 传缺的。返回 { uploaded, skipped, failed: [{label, error}], bytesUp }。 */
async function syncGroup(cos, name, items, concurrency) {
  const res = { uploaded: 0, skipped: 0, failed: [], bytesUp: 0 }
  let done = 0
  await runPool(items.length, concurrency, async (i) => {
    const it = items[i]
    let tag
    try {
      const h = await cos.headPublic(it.key)
      if (remoteMatches(h, it.bytes, it.md5, { sha256: it.sha256, contentAddressed: it.contentAddressed })) { res.skipped++; tag = '已在桶里' }
      else { await uploadOne(cos, it); res.uploaded++; res.bytesUp += it.bytes; tag = `已上传 ${fmtBytes(it.bytes)}` }
    } catch (e) {
      res.failed.push({ label: it.label, error: firstLine(e) })
      tag = `✗ ${firstLine(e)}`
    }
    done++
    console.log(`  [${name} ${String(done).padStart(4)}/${items.length}] ${it.label}  ${tag}`)
  })
  return res
}

const mergeResults = (a, b) => ({ uploaded: a.uploaded + b.uploaded, skipped: a.skipped + b.skipped, failed: [...a.failed, ...b.failed], bytesUp: a.bytesUp + b.bytesUp })

async function main() {
  const args = parseArgs(process.argv.slice(2), { 'dry-run': 'bool', 'only-src': 'bool', 'only-build': 'bool', concurrency: 'int', 'build-dir': 'string', 'src-dir': 'string', 'allow-shrink': 'bool', 'allow-other-bucket': 'bool', help: 'bool' })
  if (args.help) {
    console.log('用法：node scripts/nasa3d/publish.mjs [--dry-run] [--only-src | --only-build] [--concurrency=N] [--build-dir=目录] [--src-dir=目录] [--allow-shrink] [--allow-other-bucket]')
    console.log('  --allow-shrink  允许本次 manifest 比云端少条目（下架模型）或少缩略图；缺省发现缩水就拒绝')
    return 0
  }
  if (args.onlySrc && args.onlyBuild) { console.error('--only-src 与 --only-build 不能同时给'); return 2 }
  const doBuild = !args.onlySrc
  const doSrc = !args.onlyBuild
  const buildDir = args.buildDir ? path.resolve(args.buildDir) : BUILD_ROOT
  const srcDir = args.srcDir ? path.resolve(args.srcDir) : NASA_DIR
  const conc = Math.max(1, Math.min(8, args.concurrency || 3))
  const env = process.env
  const haveCreds = !!(env.COS_SECRET_ID && env.COS_SECRET_KEY && env.COS_BUCKET && env.COS_REGION)

  // ── 本地核对与计划（dry-run 与实传共用） ──
  let manifest = null, manifestBuf = null
  const localErrors = []
  let blobs = { items: [], errors: [] }
  if (doBuild) {
    const mp = path.join(buildDir, 'manifest.json')
    try { manifestBuf = await fsp.readFile(mp); manifest = JSON.parse(manifestBuf.toString('utf8')) } catch (e) {
      const partial = fs.existsSync(path.join(buildDir, 'manifest.partial.json'))
      console.error(`读不了 ${path.relative(REPO_ROOT, mp) || mp}：${e.message}（${partial ? '目录里只有 manifest.partial.json——上次 build 是子集运行，不能发布；不带 --groups / --only 全量跑一次 npm run nasa3d:build' : '先跑 npm run nasa3d:build'}）`)
      return 2
    }
    // build 的子集运行只写 manifest.partial.json；带 partial 标记的 manifest 出现在这里说明被人改名 / 拷过来了
    if (manifest && manifest.partial === true) localErrors.push('manifest：带 partial 标记（build 子集运行的产物），不是全量目录，不能发布')
    const shape = checkManifestShape(manifest)
    if (!shape.ok) localErrors.push(...shape.errors.map((e) => `manifest：${e}`))
    const mv = await loadManifestValidator()
    if (mv && typeof mv.validateManifest === 'function') {
      const r = mv.validateManifest(manifest, { remote: true })
      if (!r.ok || r.errors.length || r.models.length !== manifest.models.length) localErrors.push(...(r.errors.length ? r.errors : ['validateManifest 丢了条目']).map((e) => `validateManifest：${e}`))
    }
    if (!localErrors.length) {
      blobs = await planBlobs(manifest, buildDir)
      localErrors.push(...blobs.errors)
    }
  }
  let srcs = { items: [], errors: [] }
  if (doSrc) {
    srcs = await planSources(srcDir)
    localErrors.push(...srcs.errors)
  }
  const sb = summarize(blobs.items), ss = summarize(srcs.items)
  const manifests = doBuild ? [{ key: manifestKey(manifest.buildId), bytes: manifestBuf.byteLength }, { key: manifestKey(null), bytes: manifestBuf.byteLength }] : []
  const host = env.COS_BUCKET && env.COS_REGION ? `${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com` : '（未设 COS_BUCKET / COS_REGION）'
  console.log(`NASA 3D 发布${args.dryRun ? '（dry-run：不联网、不上传）' : ''} → ${host}/${PREFIX}`)
  console.log(formatTable(['步骤', '对象', '文件', '总字节', '其中 > 8 MiB（分块）'], [
    ['① 探针', PROBE_KEY, 1, '21 B', 0],
    ...(doBuild ? [['② blobs', `${PREFIX}blobs/<sha256>.glb|.webp`, sb.n, fmtBytes(sb.bytes), sb.big]] : []),
    ...(doSrc ? [['③ 原件镜像', `${PREFIX}src/nasa/<slug>/<文件>`, ss.n, fmtBytes(ss.bytes), ss.big]] : []),
    ...(doBuild ? [['④ manifest 快照', manifests[0].key, 1, fmtBytes(manifests[0].bytes), 0], ['⑤ manifest', manifests[1].key, 1, fmtBytes(manifests[1].bytes), 0]] : []),
    ['合计', '', 1 + sb.n + ss.n + manifests.length, fmtBytes(sb.bytes + ss.bytes + manifests.reduce((s, x) => s + x.bytes, 0) + 21), sb.big + ss.big]
  ], ['l', 'l', 'r', 'r', 'r']))
  if (doBuild) console.log(`manifest：${manifest.models.length} 条（带缩略图 ${manifest.models.filter((m) => m && m.files && m.files.thumb).length}）· buildId ${manifest.buildId} · 生成于 ${manifest.generatedAt}`)
  console.log(`凭据：${haveCreds ? '环境变量已设' : '环境变量未设齐（COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION）'}${env.COS_ACCELERATE === '1' || env.COS_ACCELERATE === 'true' ? ' · 全球加速上传' : ''}`)
  if (localErrors.length) {
    console.error(`\n✗ 本地核对有 ${localErrors.length} 处问题，不上传：`)
    for (const e of localErrors.slice(0, 50)) console.error('  ' + e)
    if (localErrors.length > 50) console.error(`  …另 ${localErrors.length - 50} 处`)
    return 1
  }
  console.log(`本地核对：${[doBuild ? 'manifest 自检通过、blob 逐个重算 sha256 与 manifest 一致' : '', doSrc ? '原件逐个重算 sha256 与旁车一致' : ''].filter(Boolean).join('；')}。`)
  if (args.dryRun) {
    const sample = [...blobs.items.slice(0, 2), ...srcs.items.slice(0, 2)].map((x) => `  ${x.key}  ${fmtBytes(x.bytes)}  ${x.contentType} · ${x.cacheControl}`)
    if (sample.length) console.log('键名示例：\n' + sample.join('\n'))
    console.log(`去重在实传时按公共读 HEAD 判定（dry-run 不联网，上表是全量）${doBuild ? '；缩水闸（与云端 manifest.json 比对条目与缩略图）也只在实传时跑' : ''}。`)
    return 0
  }

  // ── 实传 ──
  if (!haveCreds) { console.error('缺少环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION'); return 2 }
  if ((env.COS_BUCKET !== PINNED_BUCKET || env.COS_REGION !== PINNED_REGION) && !args.allowOtherBucket) {
    console.error(`桶 / 地域不是客户端钉死的 ${PINNED_BUCKET} / ${PINNED_REGION}（manifest.mjs 的 CDN_BASE），传上去客户端读不到。换桶测试加 --allow-other-bucket。`)
    return 2
  }
  const cos = createCos({ secretId: env.COS_SECRET_ID, secretKey: env.COS_SECRET_KEY, bucket: env.COS_BUCKET, region: env.COS_REGION, accelerate: env.COS_ACCELERATE === '1' || env.COS_ACCELERATE === 'true' })
  const probe = await cos.probeWrite(PROBE_KEY)
  console.log(`① 探针 ${PROBE_KEY}：${explainProbe(probe)}`)
  if (!probe.ok) return 2

  if (doBuild) {
    const s = await checkShrink(cos, manifest)
    if (s.first) console.log(`  缩水闸：云端还没有 manifest.json（首次发布），本次 ${manifest.models.length} 条`)
    else if (s.diff) {
      const d = s.diff
      const line = `云端 ${d.remoteCount} 条 → 本次 ${d.localCount} 条（新增 ${d.added}，缺 ${d.missing.length}，丢缩略图 ${d.thumbLost.length}）`
      const listOf = (a) => a.slice(0, 50).map((id) => `    ${id}`).join('\n') + (a.length > 50 ? `\n    …另 ${a.length - 50} 条` : '')
      if (s.pass) console.log(`  缩水闸：${line}`)
      else if (!args.allowShrink) {
        if (d.missing.length) {
          console.error(`\n✗ 缩水闸：${line}。以下条目会从云端库消失，客户端绑定到它们的卫星全部退回图标：\n${listOf(d.missing)}`)
          console.error('  多半是 build 子集运行的产物被当成了全量目录。不带 --groups / --only 全量跑一次 npm run nasa3d:build 再发；确要下架这些条目加 --allow-shrink。')
        }
        if (d.thumbLost.length) {
          console.error(`\n✗ 缩水闸：${line}。以下条目云端有缩略图、本次没有，传上去库画廊变空卡：\n${listOf(d.thumbLost)}`)
          console.error('  多半是改了本体朝向 / 显示系后缩略图判过期、还没重跑。按 npm run nasa3d:sheets → nasa3d:build → 再发；确要去掉缩略图加 --allow-shrink。')
        }
        return 2
      } else {
        if (d.missing.length) console.warn(`  ⚠ 缩水闸：${line}，已按 --allow-shrink 放行。下架的条目：\n${listOf(d.missing)}`)
        if (d.thumbLost.length) console.warn(`  ⚠ 缩水闸：${line}，已按 --allow-shrink 放行。去掉缩略图的条目：\n${listOf(d.thumbLost)}`)
      }
    } else if (!args.allowShrink) {
      console.error(`\n✗ 缩水闸：${s.error}，无法比对本次是否少了条目，不上传。确认要覆盖云端 manifest 加 --allow-shrink。`)
      return 2
    } else console.warn(`  ⚠ 缩水闸：${s.error}，已按 --allow-shrink 跳过比对`)
  }

  const results = []
  let failed = 0
  if (doBuild) {
    const r = await syncGroup(cos, 'blob', blobs.items, conc)
    results.push(['② blobs', r]); failed += r.failed.length
  }
  if (doSrc) {
    // 先 glb 后旁车；glb 没传上的，它的旁车这轮不动（桶里的旁车必须描述桶里那份 glb）
    const r1 = await syncGroup(cos, '原件', srcs.items.filter((x) => x.role !== 'sidecar'), conc)
    const bad = new Set(r1.failed.map((f) => f.label))
    const held = srcs.items.filter((x) => x.role === 'sidecar' && bad.has(x.of))
    const r2 = await syncGroup(cos, '旁车', srcs.items.filter((x) => x.role === 'sidecar' && !bad.has(x.of)), conc)
    for (const h of held) r2.failed.push({ label: h.label, error: '对应原件没传上，旁车暂缓' })
    const r = mergeResults(r1, r2)
    results.push(['③ 原件镜像', r]); failed += r.failed.length
  }
  if (doBuild) {
    if (failed) {
      console.error(`\n✗ 有 ${failed} 个对象没传上，manifest 不发布（否则客户端会读到引用了缺失 blob 的 manifest）。重跑本命令即可续传（已在桶里的自动跳过）。`)
    } else {
      const mSha = sha256(manifestBuf), mMd5 = md5(manifestBuf)
      for (const [i, m] of manifests.entries()) {
        const cache = i === 0 ? CACHE_IMMUTABLE : CACHE_NONE
        try {
          const h = await cos.headPublic(m.key)
          if (i === 0 && remoteMatches(h, manifestBuf.byteLength, mMd5, { sha256: mSha })) { console.log(`  ${m.key}  已在桶里`); continue }
          await cos.putBuffer(m.key, manifestBuf, { 'Content-Type': CT.json, 'Cache-Control': cache, [META_SHA256]: mSha })
          const back = await cos.headPublic(m.key)
          if (!remoteMatches(back, manifestBuf.byteLength, mMd5, { sha256: mSha })) throw new Error(`传后回看不符（HEAD ${back.status}）`)
          console.log(`  ${m.key}  已上传 ${fmtBytes(manifestBuf.byteLength)}（${cache}）`)
        } catch (e) {
          failed++
          console.error(`  ✗ ${m.key}：${firstLine(e)}`)
          break   // 快照没传上就别动 manifest.json
        }
      }
    }
  }
  console.log('')
  console.log(formatTable(['步骤', '上传', '跳过（已在桶里）', '失败', '上传字节'], results.map(([n, r]) => [n, r.uploaded, r.skipped, r.failed.length, fmtBytes(r.bytesUp)]), ['l', 'r', 'r', 'r', 'r']))
  for (const [, r] of results) for (const f of r.failed.slice(0, 20)) console.error(`  ✗ ${f.label}：${f.error}`)
  if (!failed && doBuild) console.log(`✅ 发布完成：${CDN_HINT}manifest.json → buildId ${manifest.buildId}`)
  else if (!failed) console.log('✅ 原件镜像完成')
  return failed ? 1 : 0
}

const CDN_HINT = `https://${PINNED_BUCKET}.cos.${PINNED_REGION}.myqcloud.com/${PREFIX}`

const isDirectRun = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()
if (isDirectRun) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(`✗ ${e && e.stack ? e.stack : e}`); process.exitCode = 2 })
}
