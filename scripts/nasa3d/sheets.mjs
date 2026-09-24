// NASA 3D 分发件与参数化模板的缩略图 / 复核图（npm run nasa3d:sheets；Electron 离屏页，渲染与工作台同一套代码）。
//
//   electron scripts/nasa3d/sheets.mjs [--only=id|slug,…] [--nasa-only] [--templates-only] [--force] [--no-review]
//                                      [--lod=lod0] [--png=目录] [--no-fallback] [--allow-fallback] [--show]
//                                      [--build-dir=build/models] [--review-dir=build/review] [--rebind] [--parity] [--fail=id,…]
//   --fail：把这些条目当作出图失败（演练「退回官方缩图」那条路；平时不用）
//   --parity：缓存全命中、没有要出的图时也跑一次取景重画对拍闸（重新核一遍、记进 sheets.json）
//   --rebind：review 目录确实要改配另一个模型目录（见下「目录配对」）
//
// 产物：
//   build/models/<slug>[~n]/thumb.webp      512 px WebP、透明底（nasa3d:build 走缓存重跑一次就把它并进 meta.files.thumb 与 manifest）
//   build/models/_param/<模板>/thumb.webp    参数化模板的缩略图 + info.json（specHash；nasa3d:builtin --templates=entries 核对后随包）
//   build/review/<slug>[~n].png、param-<模板>.png   复核图：抬头两行（id / 名称 / 包围盒 / 单位核定）+ 三视图四宫格
//                                                  （本体轴三角、米制比例尺、挂点引线 —— thumbs.renderThreeView）
//   build/review/sheets.json                逐条记账（内容键 / 配方 / 缩略图 sha / 来源 render|official / 耗时 / 取景放大 / 画面质检）；
//                                           build 用它核对缩略图还对不对得上当前 meta（checkThumbRecord），REPORT 出「缩略图」一节
//   build/review/sheets.log                 主进程日志（Windows 下 Electron 主进程的 stdout 不一定到得了管道，照 memory 落盘）；
//                                           每次运行先把上一份轮转成 sheets.1.log … sheets.4.log（缓存全命中的一次不再冲掉真出图那次的日志）
//
// 目录配对（sheetsBinding）：review 目录（记账 + 复核图）只配一个模型目录，sheets.json 记它（buildDir，相对 review 目录）。
//   记账清理与下架文件清理按「模型目录的 manifest」定全集——配错了目录就会把另一边的真记账 / 复核图当下架件删掉（审查：
//   --build-dir 指临时 build、没给 --review-dir → 仓库 build/review 里 ~222 条记账与复核图被删，下一次真跑全部重出，
//   带贴图的件每次重渲 ~1 % 像素抖动 → 缩略图字节变、buildId 变、逼着重新发布）。所以：
//   · --build-dir 不是缺省、review 目录却是缺省的 build/review → 拒（退出码 2），要么给 --review-dir，要么 --rebind；
//   · sheets.json 记的模型目录与本次不同 → 拒，--rebind 才改配（改配那一次不清理，下一次起按新目录清）；
//   · 老记账没记过：缺省配对或记账为空 → 认下并照常清理；否则认下、这一次不清理。
// 取景重画对拍的结论（parity）跨运行保留：缓存全命中、闸没跑时沿用上一次的；出图却加了 --no-parity 时记「跳过」。
//
// 朝向：不在这里定。缩略图就是 thumbs.renderThumb 的缺省画面（view.js 的显示系 + autoViewFor 自动视角），与工作台预览的第一眼、
//   应用内重拍的缩略图同一张脸；那边的口径改了（配方哈希会变），这里重跑就跟上。页面只多做「稳健取景」（sheets-page/main.js）。
//
// 页面在 scripts/nasa3d/sheets-page/：自定义 sheet:// 协议两个 host——
//   sheet://repo/…   仓库里四棵子树（SHEET_ALLOW：页面本身、src/viz/models、packages/core/models、three）
//   sheet://build/…  --build-dir 指的目录（缺省 build/models；可以在仓库外）——模型文件从这里取
//   importmap 把 'three' / 'three/addons/' / '@core/' 指进来 —— src/viz/models 的 studio / thumbs / materials / loader / irToThree 原样加载。
// 隐藏窗口的坑（memory：spin-harness-electron-raf、canvas-pixel-diff-trap）由页面规避：OffscreenCanvas 同步渲染，不依赖 rAF / 定时器。
//
// 缓存与核对：每条记两把键——
//   contentKey = sha256(模型文件 sha + frame + 单位 + 取景口径〔取景法 | 显示系签名〕)：模型、标定或显示系变了，缩略图就是【错的】
//              （朝向 / 比例 / 上下不对）→ 必须重出；
//              build 认领 thumb.webp 前按当前 meta 重算比对（checkThumbRecord），对不上当作没有缩略图并在 REPORT 列出。
//   recipe     = 渲染链源码（thumbs / studio / materials / loader / view / gpuRelease / irToThree / 本页）+ three 版本的哈希：
//              变了只是「画法旧了」，缩略图仍然对 → 本脚本下次重出，build 照常认领、REPORT 记个数。
//   模板另把 paramBus / paramTemplates 等算进配方，内容键 = specHash。--force 全部重出。
// 判「要不要重出」（sheetPlan）分两把：
//   key       = 内容键 + 配方 → 变了整条重出（缩略图 + 复核图）；
//   reviewKey = key + 复核图抬头（reviewHeadKey：尺寸 / 朝向核定标志、中文名）→ 只有它变了就【只重出复核图】，thumb.webp 与它的 sha 不动
//               （ISS-D / TDRS-D 这类带贴图的件每次重渲有 ~1 % 像素抖动：改个中文名不该换缩略图字节、换 buildId、逼着重新发布）。
// Chromium 开关（--disable-gpu 之类）写在脚本路径前面：electron --disable-gpu scripts/nasa3d/sheets.mjs --only=…
// 取景重画对拍闸：真要出缩略图时先拿待出图的件做 renderThumb 全景 vs renderCrop 整幅逐像素对拍，分家就中止（见 PARITY_MAX_SHARE；
//   --no-parity 跳过）。候选件本身载不进 / 超时（坏文件）算「核不了」，换下一件（最多 PARITY_TRIES 件），都核不了照常出图并记账。
// 失败退回：出图失败（解不开、渲染抛错）的 NASA 条目改取官方缩图（catalog.json 的 featuredImage，按 512 方格等比放、转 WebP），
//   记进 sheets.json 与 REPORT；--no-fallback 关掉。退回的比例超过 FALLBACK_MAX_SHARE（5 %）说明是环境坏了而不是个别件坏了：
//   退出码 1（--allow-fallback 放行）。WebGL2 或 WebP 编码起不来直接中止（退出码 2），不整批退回官方图。
//
// 纯函数全部导出（单测 modelPipeline.test.mjs 在 node 里、验证台在别的 Electron 进程里 import 本文件；只有作为 electron 的入口脚本才开工）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, BUILD_ROOT, CATALOG_FILE, parseArgs, readJson, writeJsonAtomic, fmtSec, formatTable } from './lib.mjs'

export const SHEETS_VERSION = 2
export const REVIEW_ROOT = path.join(REPO_ROOT, 'build', 'review')
export const PARAM_DIR = '_param'
/** 缩略图取景口径的「取景法」部分：thumbs.renderThumb 缺省视角 + 稳健取景重画。口径改了 +1，旧缩略图全部判过期。 */
export const THUMB_VIEW_BASE = 'auto+crop-v2'
/**
 * 显示系签名：view.js 导出的「哪边朝上」——BODY_TO_DISPLAY（本体系 → 显示系的旋转）+ ZENITH_DISPLAY / NADIR_DISPLAY（天顶 / 天底在显示系的方向，
 * 相机上向若改按它们取也算进来）+ VIEW_DIRS / BODY_VIEWS（点名视角、自动取景兜底、三视图）。
 * 为什么进取景口径（→ 内容键）而不是只进配方：配方变了按「画法旧了、缩略图仍然对」处理（build / builtin 照样认领）——显示系换向
 * （2026-09-24 终案：本体 +Z 朝上 → 天顶朝上）后旧缩略图是【上下颠倒】的，不是画法旧，必须不认、必须重出。
 * 取法：真 import view.js（经 esmDataUrl：与 node 版本无关、内容定址不吃模块缓存；three 在 node / Electron 主进程里都能解析），
 * 取上面这几个导出的【值】（9 位小数、−0 归 0）再哈希——与 view.js 怎么写（.set(…) / makeRotationX / 注释 / 换行）无关，只随值变。
 * import 失败（语法错、three 解析不到）或没有 BODY_TO_DISPLAY → 退到 view.js 整个文件的哈希 'f:…'（宁可多重出一次，不放过换向）；
 * 文件不在 → 'd:none'。
 */
export async function displaySignature(repoRoot = REPO_ROOT) {
  const file = path.join(repoRoot, 'src', 'viz', 'models', 'view.js')
  let buf
  try { buf = fs.readFileSync(file) } catch { return 'd:none' }
  const fh = crypto.createHash('sha256').update(buf).digest('hex')
  let mod
  try { mod = await import(esmDataUrl(file)) } catch { return 'f:' + fh.slice(0, 12) }
  const shape = displayShape(mod)
  return shape ? 'd:' + crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12) : 'f:' + fh.slice(0, 12)
}
/**
 * 把 Vite 源码里的 ESM .js 当 ESM 载入，与 node 版本无关 → data: URL（内容定址：同一内容同一模块、改了内容自然是新模块）。
 * 为什么不直接 import(file)：仓库 package.json 没有 "type":"module"，src/**.js 是「无类型的 .js」——node 22 会嗅出 ESM 语法重解析（还告警），
 * Electron 31 的 node 20 不嗅、按 CommonJS 载入直接语法错。sheets 在 Electron 里、build / builtin 在 node 里，两边签名必须一模一样
 * （2026-09-24 实测：直接 import 时 Electron 退到 'f:'、node 得 'd:'，build 把 227 张缩略图全判「取景口径变了」）。
 * 做法：读源码，把静态 / 动态 import 的说明符改成绝对地址——相对路径的 .mjs、或所在包声明了 type:module 的 .js → file: URL；
 * 其余相对 .js → 递归转成 data: URL；裸说明符（three）按本仓库 node_modules 解析成 file: URL；解析不了的原样留着（真 import 时报错 → 调用方退 'f:'）。
 */
export function esmDataUrl(file, memo = new Map()) {
  const abs = path.resolve(file)
  if (memo.has(abs)) return memo.get(abs) || pathToFileURL(abs).href   // 成环：退回 file:（极少见，真遇上由 import 报错兜）
  memo.set(abs, null)
  const src = fs.readFileSync(abs, 'utf8').replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\2/g, (all, pre, q, spec) => {
    const u = resolveEsmSpec(spec, abs, memo)
    return u ? `${pre}${q}${u}${q}` : all
  })
  const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64')
  memo.set(abs, url)
  return url
}
function resolveEsmSpec(spec, from, memo) {
  if (/^(node:|file:|data:)/.test(spec)) return null
  if (/^\.{1,2}\//.test(spec)) {
    const t = path.resolve(path.dirname(from), spec)
    if (!fs.existsSync(t)) return null
    if (/\.mjs$/i.test(t) || (/\.js$/i.test(t) && pkgTypeOf(t) === 'module')) return pathToFileURL(t).href
    if (/\.js$/i.test(t)) return esmDataUrl(t, memo)
    return pathToFileURL(t).href
  }
  try { return import.meta.resolve(spec) } catch { return null }
}
function pkgTypeOf(file) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    try { return JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).type || 'commonjs' } catch { /* 没有或读不了：往上找 */ }
    if (path.dirname(d) === d) return 'commonjs'
  }
}
/** view.js 模块 → 签名用的纯数据（BODY_TO_DISPLAY 不是 16 个有限数 → null）。导出给单测。 */
export function displayShape(mod) {
  const m = mod && mod.BODY_TO_DISPLAY
  const el = m && (ArrayBuffer.isView(m.elements) || Array.isArray(m.elements) ? m.elements : Array.isArray(m) ? m : null)
  if (!el || el.length !== 16 || !Array.from(el).every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return { b2d: numShape(el), zenith: numShape(mod.ZENITH_DISPLAY), nadir: numShape(mod.NADIR_DISPLAY), views: numShape(mod.VIEW_DIRS), bodyViews: numShape(mod.BODY_VIEWS) }
}
const r9 = (v) => Math.round(v * 1e9) / 1e9 || 0   // || 0：−0 与 0 同签名
/** 值 → 只含数的 JSON 形（数组 / 类型数组 / three 的 Vector3·Quaternion·Matrix / 按键排序的对象；函数、字符串丢掉）；没有数 → null */
function numShape(v, depth = 0) {
  if (v == null || depth > 4) return null
  if (typeof v === 'number') return Number.isFinite(v) ? r9(v) : null
  if (typeof v !== 'object') return null
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => r9(x))
  if (v.isMatrix4 || v.isMatrix3) return Array.from(v.elements, (x) => r9(x))
  if (v.isQuaternion) return [v.x, v.y, v.z, v.w].map(r9)
  if (v.isVector3) return [v.x, v.y, v.z].map(r9)
  if (Array.isArray(v)) return v.map((x) => numShape(x, depth + 1))
  const o = {}
  let any = false
  for (const k of Object.keys(v).sort()) { const s = numShape(v[k], depth + 1); if (s !== null) { o[k] = s; any = true } }
  return any ? o : null
}
export const DISPLAY_SIG = await displaySignature()
/** 缩略图取景口径（进内容键）= 取景法 | 显示系签名 */
export const THUMB_VIEW = `${THUMB_VIEW_BASE}|${DISPLAY_SIG}`
/** 缩略图用哪一档出：lod0（原精度；贴图 2048） */
export const THUMB_LOD = 'lod0'
/** 缩略图边长（与 sheets-page/main.js 的 THUMB 同值；对拍闸按它的边长比） */
export const THUMB_SIZE = 512
/** 退回官方缩图的比例上限（超过即判环境问题，退出码 1） */
export const FALLBACK_MAX_SHARE = 0.05
/**
 * 取景重画对拍闸（开工前跑一次，--no-parity 跳过）：sheets-page/main.js 的 renderCrop 逐行抄 thumbs.renderThumb 的相机与布光
 * （mount → 自动视角 → 灯组随视角 → fitPerspective），thumbs.js / studio.js 那边一改（显示系换向、灯组跟半球…）两边就会悄悄分家——
 * 取景放大过的那几十张与其余的光照 / 朝向对不上，而配方哈希只会让它们「一起重出」、发现不了分家。
 * 所以每次真要出缩略图时，先拿待出图的件做整幅对拍：renderThumb 全景 vs renderCrop(整幅框) 逐像素，任一通道差 > PARITY_TOL
 * 的像素超过 PARITY_MAX_SHARE 就中止（退出码 2），提示去同步 renderCrop。2026-09-24 实测对得上时 0 / 262144（最大差 1）。
 * 候选件自己载不进 / 超时只算「核不了」、换下一件（runParityGate，最多 PARITY_TRIES 件）——坏文件不该被报成两边分家。
 */
export const PARITY_TOL = 2
export const PARITY_MAX_SHARE = 0.001
/** 对拍闸最多试几件：候选件载不进 / 超时（文件坏、GPU 慢）算「核不了」换下一件，不当成分家 */
export const PARITY_TRIES = 3
/** sheet://repo 只放行的仓库子树（前缀按 / 分隔；任何 .. 段一律拒）。模型文件走 sheet://build（见文件头） */
export const SHEET_ALLOW = Object.freeze([
  'scripts/nasa3d/sheets-page/', 'src/viz/models/', 'packages/core/models/', 'node_modules/three/'
])
export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg'
})
/** 出图配方：渲染链源码（改了它们，缩略图的样子就可能变 → 全部重出） */
export const RECIPE_FILES = Object.freeze([
  'scripts/nasa3d/sheets-page/main.js', 'scripts/nasa3d/sheets-page/crop.mjs', 'scripts/nasa3d/sheets-page/index.html',
  'src/viz/models/thumbs.js', 'src/viz/models/studio.js', 'src/viz/models/materials.js', 'src/viz/models/loader.js',
  'src/viz/models/view.js', 'src/viz/models/gpuRelease.js', 'src/viz/models/irToThree.js',
  'packages/core/models/bodyFrame.mjs', 'node_modules/three/package.json'
])
/** 模板另加：几何生成器（spec 不变而生成器改了，画面同样会变） */
export const RECIPE_FILES_PARAM = Object.freeze([
  'packages/core/models/paramBus.mjs', 'packages/core/models/paramTemplates.mjs', 'packages/core/models/agi.mjs',
  'packages/core/models/ir.mjs', 'packages/core/models/glb.mjs'
])
export const USERDATA_PREFIX = 'satsim-nasa3d-sheets-'

// ─────────────────────────────── 纯函数 ───────────────────────────────

/** 一段 URL 路径 → 逐段解码后的段表；有空段 / . / .. / 反斜杠 / 冒号 / NUL 返回 null（防 %2e%2e 之类绕过） */
function safeSegments(pathname) {
  const segs = String(pathname).split('/').slice(1)
  if (!segs.length) return null
  const dec = []
  for (const s of segs) {
    let d
    try { d = decodeURIComponent(s) } catch { return null }
    if (!d || d === '.' || d === '..' || /[\\/:\0]/.test(d)) return null
    dec.push(d)
  }
  return dec
}
const inside = (abs, root) => { const r = path.resolve(root); return abs === r || abs.startsWith(r + path.sep) }

/**
 * sheet:// 地址 → 绝对路径；不放行返回 null。
 *   sheet://repo/<rel>   rel 必须落在 SHEET_ALLOW 的某棵子树里
 *   sheet://build/<rel>  rel 相对 buildDir（缺省 BUILD_ROOT；--build-dir 可以在仓库外）
 */
export function resolveSheetPath(repoRoot, url, { buildDir = null } = {}) {
  let u
  try { u = new URL(String(url)) } catch { return null }
  if (u.protocol !== 'sheet:') return null
  const dec = safeSegments(u.pathname)
  if (!dec) return null
  if (u.hostname === 'repo') {
    const rel = dec.join('/')
    if (!SHEET_ALLOW.some((p) => rel.startsWith(p))) return null
    const abs = path.resolve(repoRoot, ...dec)
    return inside(abs, repoRoot) ? abs : null
  }
  if (u.hostname === 'build') {
    const root = buildDir || path.join(repoRoot, 'build', 'models')
    const abs = path.resolve(root, ...dec)
    return inside(abs, root) && abs !== path.resolve(root) ? abs : null
  }
  return null
}
/** buildDir 下的文件 → sheet://build/… 地址（逐段 encode） */
export function sheetBuildUrl(buildDir, file) {
  return 'sheet://build/' + path.relative(buildDir, file).split(path.sep).map(encodeURIComponent).join('/')
}

export const contentTypeFor = (file) => CONTENT_TYPES[path.extname(String(file)).toLowerCase()] || 'application/octet-stream'

/** 复核图文件名：nasa:<slug>[~n] → <slug>[~n].png；param:<模板> → param-<模板>.png；其余不认 → null */
export function reviewFileName(id) {
  const s = String(id || '')
  let m = /^nasa:([a-z0-9-]+(?:~[0-9]+)?)$/.exec(s)
  if (m) return `${m[1]}.png`
  m = /^param:([a-z0-9][a-z0-9._-]*)$/.exec(s)
  if (m) return `param-${m[1]}.png`
  return null
}
/** nasa:<slug>[~n] → build/models 下的目录名（与 build.mjs 的 dir 同口径）；不是 NASA id → null */
export function nasaDirOf(id) {
  const m = /^nasa:([a-z0-9-]+(?:~[0-9]+)?)$/.exec(String(id || ''))
  return m ? m[1] : null
}

/** 出图配方哈希：按文件名排序后逐个 (相对路径, 内容) 进 sha256；缺文件记 '<missing>'（照样有稳定结果）。 */
export function recipeHash(repoRoot, files) {
  const h = crypto.createHash('sha256').update(`sheets-v${SHEETS_VERSION}\n`)
  for (const rel of files.slice().sort()) {
    h.update(rel + '\n')
    try { h.update(fs.readFileSync(path.join(repoRoot, rel))) } catch { h.update('<missing>') }
    h.update('\n')
  }
  return h.digest('hex').slice(0, 16)
}

/** 内容键：模型文件 sha（模板 = specHash）+ 画面相关的 meta（frame 的 q / t、比例）+ 取景口径。与渲染代码无关。 */
export function thumbContentKey({ src, frame, units, view = THUMB_VIEW }) {
  const f = frame || {}
  const s = JSON.stringify({ src: src || null, q: f.q_model2body || null, t: f.t_model2body || null, scale: units ? units.scaleToMeters ?? null : null, view })
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24)
}
/**
 * 缓存键（本脚本判「要不要重出」用）：
 *   sheetKey({content, recipe})              缩略图键（记账的 key）：内容键 + 配方；
 *   sheetKey({content, recipe, review: hk})  复核图键（记账的 reviewKey）：再加复核图抬头（reviewHeadKey）——
 *     抬头里有「尺寸已核 / 朝向已核」、中文名这类不进内容键的 meta 字段，改了它们而几何没变时只重出复核图（sheetPlan）。
 * review：false / 缺 / '' = 不含复核图；true = 老口径；非空字符串 = 抬头键。
 */
export function sheetKey({ content, recipe, review }) {
  const r = typeof review === 'string' && review ? review : !!review
  return crypto.createHash('sha256').update(JSON.stringify({ content, recipe, review: r })).digest('hex').slice(0, 24)
}
/** 复核图抬头 → 短哈希（进复核图键） */
export function reviewHeadKey(head) {
  return 'h:' + crypto.createHash('sha256').update(JSON.stringify(Array.isArray(head) ? head : [])).digest('hex').slice(0, 16)
}
/**
 * 一条要做什么：'full'（缩略图 + 复核图一起重出）/ 'review'（只重出复核图，thumb.webp 不动）/ 'none'（缓存命中）。
 *   s          sheets.json 里这一条（可缺）；key / reviewKey 本次算的两把键（reviewKey 在不出复核图时为 null）
 *   thumbSha   磁盘上 thumb.webp 的 sha256（没有文件 = null）；reviewExists 复核图 PNG 在不在
 * 退回官方缩图的条目本来就没有复核图：不因为复核图而重来（键没变就是同一个失败，--force 再试）。
 */
export function sheetPlan({ s, key, reviewKey = null, missing = false, force = false, thumbSha = null, reviewExists = false }) {
  if (missing || force) return 'full'
  if (!s || s.key !== key || !s.thumbSha || !thumbSha || thumbSha !== s.thumbSha) return 'full'
  if (reviewKey && s.source === 'render' && (s.reviewKey !== reviewKey || !reviewExists)) return 'review'
  return 'none'
}

/**
 * 缩略图记账核对（build 认领 thumb.webp 前、builtin 随包前都调）：
 *   rec     sheets.json 里这一条；meta 当前的 ModelMeta（取 files[rec.lod].sha256、frame、units）；fileSha 磁盘上 thumb.webp 的 sha256；
 *   recipe  当前配方哈希（可缺：缺就不判配方）。
 * → { ok, reason?, recipeStale }：ok=false 时 reason 为中文原因（进 REPORT）；配方不同只记 recipeStale（画法旧了，缩略图仍对）。
 */
export function checkThumbRecord(rec, meta, fileSha, recipe = null) {
  if (!fileSha) return { ok: false, reason: '没有 thumb.webp', recipeStale: false }
  if (!rec || !rec.thumbSha) return { ok: false, reason: 'sheets.json 里没有这一条的出图记账（先跑 nasa3d:sheets）', recipeStale: false }
  if (rec.thumbSha !== fileSha) return { ok: false, reason: 'thumb.webp 与 sheets.json 记的 sha 不符（文件被换过）', recipeStale: false }
  if (!rec.contentKey || !rec.lod) return { ok: false, reason: '老版本记账（没有内容键）：重跑 nasa3d:sheets', recipeStale: false }
  const f = meta && meta.files && meta.files[rec.lod]
  if (!f || !f.sha256) return { ok: false, reason: `meta 里没有 ${rec.lod}`, recipeStale: false }
  const want = thumbContentKey({ src: f.sha256, frame: meta.frame, units: meta.units, view: rec.view || THUMB_VIEW })
  if (rec.view !== THUMB_VIEW) return { ok: false, reason: `取景口径变了（${rec.view || '—'} → ${THUMB_VIEW}）：重跑 nasa3d:sheets`, recipeStale: false }
  if (want !== rec.contentKey) return { ok: false, reason: '模型文件或标定（frame / 单位）在出图之后变了：重跑 nasa3d:sheets', recipeStale: false }
  return { ok: true, recipeStale: !!(recipe && rec.recipe && rec.recipe !== recipe) }
}

/**
 * 记账清理：只删既不是 NASA 条目（全量 build manifest 里的 id）也不是模板（TEMPLATE_IDS 全集）的条目——
 * 与本次跑了哪些无关（--nasa-only / --templates-only / --only 不许把另一半的记账删掉）。返回删掉的 id。
 */
export function pruneSheetEntries(entries, nasaIds, templateIds) {
  const live = new Set([...(nasaIds || []), ...(templateIds || []).map((t) => `param:${t}`)])
  const gone = []
  for (const id of Object.keys(entries || {})) if (!live.has(id)) { delete entries[id]; gone.push(id) }
  return gone
}
/**
 * 下架件留下的文件：记账清掉了、文件还在 —— 翻 build/review 复核时会撞见旧显示系（上下颠倒）的下架件
 * （2026-09-24 实测：三个旧模板下架后复核图与 _param 目录都还在）。
 *   复核图目录：只删【本次记账清理删掉的那几条】（goneIds，pruneSheetEntries 的返回）的复核图 reviewFileName(id)——
 *               记账能证明是本脚本出的；不按「名字像复核图就删」（审查：--review-dir 指到共用目录时 contact.png 这类小写 png 也会被删）。
 *               sheets.json / sheets*.log / 别人放的东西一概不碰。
 *   <buildDir>/_param/：不在模板表里、且里面只有本脚本产物（info.json / thumb.webp）的子目录 → 删。
 *   NASA 的 <buildDir>/<slug>/ 归 build.mjs 管，不碰。
 * 调用方只在目录配对确认过（sheetsBinding 的 prune）时调。list / rm 可注入（单测）。返回 { review:[文件名], param:[目录名] }。
 */
export function sweepOrphanSheetFiles({ reviewDir, buildDir, goneIds, templateIds, list = (d) => fs.readdirSync(d), rm = (p) => fs.rmSync(p, { recursive: true, force: true }) } = {}) {
  const gone = new Set((goneIds || []).map(reviewFileName).filter(Boolean))
  const tpl = new Set(templateIds || [])
  const out = { review: [], param: [] }
  const ls = (d) => { try { return d ? list(d) : [] } catch { return [] } }
  for (const f of gone.size ? ls(reviewDir) : []) {
    if (!gone.has(f)) continue
    rm(path.join(reviewDir, f)); out.review.push(f)
  }
  const pdir = buildDir ? path.join(buildDir, PARAM_DIR) : null
  for (const t of ls(pdir)) {
    if (tpl.has(t)) continue
    const inside = ls(path.join(pdir, t))
    if (!inside.length || !inside.every((f) => f === 'info.json' || f === 'thumb.webp')) continue
    rm(path.join(pdir, t)); out.param.push(t)
  }
  return out
}

/** 两个目录路径是否同一个（Windows 不分大小写；分隔符归一、去尾分隔符） */
const samePath = (a, b) => {
  const n = (p) => path.normalize(String(p)).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}
/** sheets.json 里记的模型目录：相对 review 目录、/ 分隔（仓库整个搬家时两边一起动，仍对得上） */
export const bindingOf = (reviewDir, buildDir) => path.relative(path.resolve(reviewDir), path.resolve(buildDir)).split(path.sep).join('/') || '.'
/**
 * 目录配对（见文件头「目录配对」）：
 *   prevBind    sheets.json 记的 buildDir（bindingOf 的形状；老记账没有 → null）
 *   hadEntries  sheets.json 里原来有没有记账
 *   defaults    缺省的两个目录（单测注入）
 * → { ok:true, prune, bind } | { ok:false, reason }；prune = 这一次能不能做记账清理与下架文件清理。
 */
export function sheetsBinding({ prevBind = null, buildDir, reviewDir, rebind = false, hadEntries = false, defaults = { buildDir: BUILD_ROOT, reviewDir: REVIEW_ROOT } }) {
  const bind = bindingOf(reviewDir, buildDir)
  const defBuild = samePath(path.resolve(buildDir), path.resolve(defaults.buildDir))
  const defReview = samePath(path.resolve(reviewDir), path.resolve(defaults.reviewDir))
  const recorded = typeof prevBind === 'string' && prevBind ? prevBind : null
  const same = recorded !== null && samePath(path.resolve(reviewDir, recorded), path.resolve(buildDir))
  if (recorded !== null && !same && !rebind) {
    return { ok: false, reason: `${path.join(reviewDir, 'sheets.json')} 记的模型目录是 ${path.resolve(reviewDir, recorded)}，本次 --build-dir 是 ${path.resolve(buildDir)}：review 目录与模型目录不配对（照跑会改写这里的记账、按另一个 manifest 删复核图）。给 --review-dir 另开一个目录；确实要改配就加 --rebind` }
  }
  if (recorded === null && defReview && !defBuild && !rebind) {
    return { ok: false, reason: `--build-dir 指到 ${path.resolve(buildDir)}，review 目录却是缺省的 ${path.resolve(reviewDir)}：临时 build 的记账与复核图不许写进仓库的 build/review（记账清理会按临时 build 的 manifest 删掉真记账与复核图）。同时给 --review-dir；确实要这样配就加 --rebind` }
  }
  const prune = same || (recorded === null && !rebind && (!hadEntries || (defBuild && defReview)))
  return { ok: true, prune, bind }
}
/**
 * 日志轮转：file → <名>.1<扩展> → … → <名>.<keep><扩展>（最老的丢掉）。文件不在就什么都不做；返回轮转了没有。fsx 可注入（单测）。
 * 为什么：每次运行都截断 sheets.log 时，缓存全命中的第二遍会冲掉真出图那一遍的日志（审查：run.mjs 的第二遍把 225 张出图、对拍 0/262144 的记录冲没了）。
 */
export function rotateLog(file, keep = 4, fsx = { exists: fs.existsSync, rename: fs.renameSync, rm: (p) => fs.rmSync(p, { force: true }) }) {
  if (!fsx.exists(file)) return false
  const ext = path.extname(file), base = file.slice(0, file.length - ext.length)
  const nth = (i) => `${base}.${i}${ext}`
  if (fsx.exists(nth(keep))) fsx.rm(nth(keep))
  for (let i = keep - 1; i >= 1; i--) if (fsx.exists(nth(i))) fsx.rename(nth(i), nth(i + 1))
  fsx.rename(file, nth(1))
  return true
}

/**
 * 每次运行用一个带进程号的临时 userData（与别的验证台隔开 GPU 缓存）；退出时 GPU 进程还占着缓存文件，删不干净。
 * 启动时顺手清掉【进程已经不在】的同前缀旧目录。alive(pid) 注入（单测用替身）。返回 { removed:[名], kept:[名] }。
 */
export function sweepStaleUserData(dir, alive, { prefix = USERDATA_PREFIX, rm = (p) => fs.rmSync(p, { recursive: true, force: true }), list = (d) => fs.readdirSync(d) } = {}) {
  const out = { removed: [], kept: [] }
  let names = []
  try { names = list(dir) } catch { return out }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue
    const pid = Number(n.slice(prefix.length))
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) { out.kept.push(n); continue }
    try { rm(path.join(dir, n)); out.removed.push(n) } catch { out.kept.push(n) }
  }
  return out
}
/** 进程还在不在（signal 0 只探测不发信号；EPERM = 在但无权限） */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 官方缩图地址：catalog 的 featuredImage 是 assets.science.nasa.gov 的动态图（?w=1920&h=1080&fit=clip…），
 * 改成 768 边长、等比不裁，省流量；不是这个域名的原样返回。非 http(s) 返回 null。
 */
export function officialThumbUrl(featured) {
  let u
  try { u = new URL(String(featured || '')) } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  if (/(^|\.)science\.nasa\.gov$/i.test(u.hostname) && u.pathname.includes('/dynamicimage/')) {
    u.search = ''
    u.searchParams.set('w', '768'); u.searchParams.set('h', '768'); u.searchParams.set('fit', 'clip')
  }
  return u.toString()
}

/**
 * 复核图抬头两行（纯文字，给人看的）：
 *   ① id · 中文名（英文名）
 *   ② 包围盒 a × b × c m（模型轴；已核 / 未核）· 比例 · 本体映射 q（朝向已核 / 未核）· 三角形
 */
export function reviewHead(meta, extra = {}) {
  const t = meta.titleZh ? `${meta.titleZh}（${meta.title}）` : (meta.title || '')
  const b = meta.geometry && meta.geometry.bboxM
  const dims = b ? b.max.map((v, k) => +(v - b.min[k]).toPrecision(3)).join(' × ') + ' m' : '—'
  const u = meta.units || {}
  const f = meta.frame || {}
  const q = Array.isArray(f.q_model2body) ? f.q_model2body.map((v) => +(+v).toFixed(4)).join(', ') : '—'
  const line2 = [`包围盒 ${dims}（${u.sizeVerified ? '已核' : '未核'}）`, `比例 ${u.scaleToMeters ?? '—'}（${u.unitGuess || '—'}）`, `q_model2body [${q}]（朝向${f.verified === true ? '已核' : '未核'}）`]
  if (extra.tris != null) line2.push(`${Number(extra.tris).toLocaleString('en-US')} 三角形`)
  return [`${meta.id} · ${t}`, line2.join(' · ')]
}

/** sheets.json → 统计（build.mjs 的 REPORT「缩略图」一节也用）。qa 标记按类归集。 */
export function summarizeSheets(state) {
  const e = state && state.entries ? Object.entries(state.entries) : []
  const out = { total: e.length, render: 0, official: 0, failed: [], official_ids: [], templates: 0, flagged: { tiny: [], dark: [], flat: [] }, zoomed: 0, zoomMax: 1 }
  for (const [id, v] of e) {
    if (id.startsWith('param:')) out.templates++
    if (!v || !v.thumbSha) { out.failed.push({ id, error: (v && v.error) || '没有缩略图' }); continue }
    if (v.source === 'official') { out.official++; out.official_ids.push({ id, error: v.renderError || '' }) } else out.render++
    for (const f of (v.qa && v.qa.flags) || []) if (out.flagged[f]) out.flagged[f].push(id)
    if (v.zoom > 1.02) { out.zoomed++; out.zoomMax = Math.max(out.zoomMax, v.zoom) }
  }
  return out
}

/**
 * 本脚本在 argv 里的位置（-1 = 不是入口）。`electron --disable-gpu scripts/nasa3d/sheets.mjs …` 这样把 Chromium 开关写在脚本前面时，
 * 脚本不在 argv[1]——只认 argv[1] 的话主流程不开工、进程空等到超时（2026-09-24 实测）。跳过以 - 开头的项，找第一个指向本文件的。
 */
export function entryArgIndex(argv, selfUrl) {
  const me = String(selfUrl).toLowerCase()
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (!a || a.startsWith('-')) continue
    let u = ''
    try { u = pathToFileURL(path.resolve(a)).href.toLowerCase() } catch { continue }
    return u === me ? i : -1
  }
  return -1
}

/** 退回官方缩图比例是否超标（环境问题）：n 本次出图条数、k 退回条数 */
export function fallbackTooMany(k, n, max = FALLBACK_MAX_SHARE) { return n > 0 && k / n > max }

/**
 * 取景重画对拍闸的判定（见 PARITY_MAX_SHARE）：r = 页面 selfCheck 的结果 {diffPx, maxDiff, n} 或 {error}。
 * → { ok, share, reason? }，三态：
 *   true  像素差在门限内 → 放行；
 *   false 真对出了差（diffPx / n > max）→ renderCrop 与 renderThumb 分家，中止；
 *   null  核不了（页面报错 / 载不进 / 超时 / 结果不成形）——这件本身坏了不等于两边分家，换下一件（runParityGate）。
 */
export function parityVerdict(r, max = PARITY_MAX_SHARE) {
  if (!r || typeof r !== 'object') return { ok: null, share: null, reason: '对拍没有结果' }
  if (r.error) return { ok: null, share: null, reason: `对拍出错：${r.error}` }
  if (!(Number.isInteger(r.n) && r.n > 0) || !Number.isInteger(r.diffPx) || r.diffPx < 0) return { ok: null, share: null, reason: '对拍结果不成形' }
  const share = r.diffPx / r.n
  if (share > max) return { ok: false, share, reason: `整幅对拍 ${r.diffPx} / ${r.n} 像素不同（${(share * 100).toFixed(3)} % > ${(max * 100).toFixed(3)} %，最大差 ${r.maxDiff}）` }
  return { ok: true, share }
}
/**
 * 对拍闸流程：按顺序试 cands 的前 tries 件，check(job) → selfCheck 结果（抛错按 {error} 算）。
 *   第一件核得了的定结论：ok=true 放行、ok=false 中止；核不了（parityVerdict ok=null）换下一件。
 *   都核不了 → ok=null（照常出图：坏件自己会走「退回官方缩图」，环境坏了有 fallbackTooMany 兜）。
 * → { ok, id?, r?, verdict?, tried:[{id, reason}] }
 */
export async function runParityGate(cands, check, { tries = PARITY_TRIES, max = PARITY_MAX_SHARE, onSkip = null } = {}) {
  const tried = []
  for (const j of (cands || []).slice(0, Math.max(1, tries))) {
    let r
    try { r = await check(j) } catch (e) { r = { error: (e && e.message) || String(e) } }
    const v = parityVerdict(r, max)
    if (v.ok === null) { tried.push({ id: j.id, reason: v.reason }); if (onSkip) onSkip(j, v); continue }
    return { ok: v.ok, id: j.id, r, verdict: v, tried }
  }
  return { ok: null, tried }
}

// ─────────────────────────────── 主流程（只在 Electron 里） ───────────────────────────────

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

async function main(electron) {
  const { BrowserWindow, protocol, net } = electron
  const args = parseArgs(process.argv.slice(entryArgIndex(process.argv, import.meta.url) + 1), {
    only: 'list', 'nasa-only': 'bool', 'templates-only': 'bool', force: 'bool', 'no-review': 'bool', lod: 'string',
    png: 'string', 'no-fallback': 'bool', 'allow-fallback': 'bool', show: 'bool', 'build-dir': 'string', 'review-dir': 'string', fail: 'list',
    'no-parity': 'bool', parity: 'bool', rebind: 'bool', help: 'bool'
  })
  if (args.help) {
    console.log('用法：electron scripts/nasa3d/sheets.mjs [--only=id|slug,…] [--nasa-only] [--templates-only] [--force] [--no-review] [--lod=lod0] [--png=目录] [--no-fallback] [--allow-fallback] [--no-parity] [--parity] [--show] [--build-dir=目录] [--review-dir=目录] [--rebind]')
    return 0
  }
  const buildDir = args.buildDir ? path.resolve(args.buildDir) : BUILD_ROOT
  const reviewDir = args.reviewDir ? path.resolve(args.reviewDir) : REVIEW_ROOT
  const lod = args.lod || THUMB_LOD
  if (!['lod0', 'lod1', 'lod2'].includes(lod)) throw new Error(`--lod 只能是 lod0 / lod1 / lod2，收到「${args.lod}」`)
  const review = !args.noReview
  // 目录配对（见文件头）：在写任何东西（日志也算）之前判
  const stateFile = path.join(reviewDir, 'sheets.json')
  const prev = readJson(stateFile, null)
  const hadEntries = !!(prev && prev.entries && typeof prev.entries === 'object' && Object.keys(prev.entries).length)
  const bindV = sheetsBinding({ prevBind: prev && prev.buildDir, buildDir, reviewDir, rebind: !!args.rebind, hadEntries })
  if (!bindV.ok) { console.error(`✗ ${bindV.reason}`); return 2 }
  await fsp.mkdir(reviewDir, { recursive: true })
  const logFile = path.join(reviewDir, 'sheets.log')
  const log = (s) => { console.log(s); try { fs.appendFileSync(logFile, s + '\n') } catch { /* 日志写不进不影响出图 */ } }
  try { rotateLog(logFile) } catch { /* 轮转不了（文件被占着）就照旧截断 */ }
  fs.writeFileSync(logFile, `# nasa3d:sheets ${new Date().toISOString()}\n`)
  if (!bindV.prune) log(`⚠ 目录配对${args.rebind ? '改配（--rebind）' : '刚认下（老记账没记过模型目录）'}：这一次不做记账清理与下架文件清理，下一次起按 ${bindV.bind} 清`)
  const T0 = Date.now()

  // ── 任务清单
  const manifest = readJson(path.join(buildDir, 'manifest.json'))
  if (!manifest || !Array.isArray(manifest.models)) throw new Error(`读不到 ${path.join(buildDir, 'manifest.json')}：先跑 npm run nasa3d:build`)
  const onlySet = args.only && args.only.length ? new Set(args.only) : null
  const want = (id, dir) => !onlySet || onlySet.has(id) || (dir && onlySet.has(dir)) || (dir && onlySet.has(dir.replace(/~\d+$/, '')))
  const recipe = recipeHash(REPO_ROOT, RECIPE_FILES)
  const recipeParam = recipeHash(REPO_ROOT, [...RECIPE_FILES, ...RECIPE_FILES_PARAM])
  // parity：上一次对拍闸的结论先沿用（这一次闸真跑了才改写）——缓存全命中的一遍不该把「当前这批缩略图过过闸」的记录冲掉
  const state = { version: SHEETS_VERSION, view: THUMB_VIEW, recipe, recipeParam, buildDir: bindV.bind, ...(prev && prev.parity ? { parity: prev.parity } : {}), entries: prev && prev.entries && typeof prev.entries === 'object' ? prev.entries : {} }
  const catalog = readJson(CATALOG_FILE, null)
  const featured = new Map((catalog && Array.isArray(catalog.entries) ? catalog.entries : []).map((e) => [e.slug, e.featuredImage || null]))
  // 模板全集总要读（记账清理按全集，与 --nasa-only 无关）
  const PT = await import(new URL('../../packages/core/models/paramTemplates.mjs', import.meta.url).href)
  const PB = await import(new URL('../../packages/core/models/paramBus.mjs', import.meta.url).href)

  const jobs = []
  if (!args.templatesOnly) {
    for (const m of manifest.models) {
      const dir = nasaDirOf(m.id)
      if (!dir || !want(m.id, dir)) continue
      const f = m.files && m.files[lod]
      const file = path.join(buildDir, dir, `${lod}.glb`)
      if (!f || !fs.existsSync(file)) { jobs.push({ kind: 'nasa', id: m.id, dir, missing: `缺 ${lod}.glb` }); continue }
      const content = thumbContentKey({ src: f.sha256, frame: m.frame, units: m.units })
      const head = reviewHead(m)
      const key = sheetKey({ content, recipe })
      const reviewKey = review ? sheetKey({ content, recipe, review: reviewHeadKey(head) }) : null
      jobs.push({ kind: 'nasa', id: m.id, dir, meta: m, content, key, reviewKey, recipe, head, url: sheetBuildUrl(buildDir, file) })
    }
  }
  if (!args.nasaOnly) {
    for (const tid of PT.TEMPLATE_IDS) {
      const id = `param:${tid}`
      if (!want(id, tid)) continue
      const t = PT.TEMPLATES[tid]
      const specHash = PB.specHash(PT.templateSpec(tid).spec)
      const content = thumbContentKey({ src: specHash, frame: null, units: null })
      const head = [`${id} · ${t.titleZh}（${t.title}）`, `参数化模板 · specHash ${specHash}`]
      const key = sheetKey({ content, recipe: recipeParam })
      const reviewKey = review ? sheetKey({ content, recipe: recipeParam, review: reviewHeadKey(head) }) : null
      jobs.push({ kind: 'param', id, templateId: tid, title: t.title, titleZh: t.titleZh, content, key, reviewKey, recipe: recipeParam, specHash, head })
    }
  }
  const outThumb = (j) => (j.kind === 'nasa' ? path.join(buildDir, j.dir, 'thumb.webp') : path.join(buildDir, PARAM_DIR, j.templateId, 'thumb.webp'))
  for (const j of jobs) {
    let thumbSha = null
    if (!j.missing && !args.force) { try { thumbSha = sha256(fs.readFileSync(outThumb(j))) } catch { /* 没有文件 */ } }
    j.plan = sheetPlan({ s: state.entries[j.id], key: j.key, reviewKey: j.reviewKey, missing: !!j.missing, force: !!args.force, thumbSha,
      reviewExists: !!j.reviewKey && fs.existsSync(path.join(reviewDir, reviewFileName(j.id))) })
  }
  const todo = jobs.filter((j) => j.plan !== 'none')
  const nReviewOnly = todo.filter((j) => j.plan === 'review').length
  log(`nasa3d:sheets：NASA ${jobs.filter((j) => j.kind === 'nasa').length} 条 · 模板 ${jobs.filter((j) => j.kind === 'param').length} 条 · 待出图 ${todo.length}（缓存命中 ${jobs.length - todo.length}；其中只重出复核图 ${nReviewOnly}）· 档 ${lod} · 取景 ${THUMB_VIEW} · 配方 ${recipe}/${recipeParam} · 模型目录 ${buildDir}`)

  // ── 协议 + 离屏窗口
  protocol.handle('sheet', async (req) => {
    const file = resolveSheetPath(REPO_ROOT, req.url, { buildDir })
    if (!file) return new Response('forbidden', { status: 403 })
    try {
      const buf = await fsp.readFile(file)
      return new Response(buf, { status: 200, headers: { 'content-type': contentTypeFor(file), 'access-control-allow-origin': '*', 'cache-control': 'no-store' } })
    } catch { return new Response('not found', { status: 404 }) }
  })
  const win = new BrowserWindow({ show: !!args.show, width: 640, height: 640, webPreferences: { backgroundThrottling: false, offscreen: false } })
  // 页面告警按文字去重：同一句只记第一次，结尾报次数（WebGL 的同一类告警每条模型都会来一遍，逐条记会淹掉进度）
  const pageWarn = new Map()
  win.webContents.on('console-message', (_e, level, message) => {
    if (level < 2) return
    const k = String(message).replace(/0x[0-9A-F]+|[0-9A-F]{8,}/gi, '…').slice(0, 300)
    const n = (pageWarn.get(k) || 0) + 1
    pageWarn.set(k, n)
    if (n === 1) log(`  [page] ${message}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => log(`  [page] 渲染进程退出：${d.reason}`))
  await win.loadURL('sheet://repo/scripts/nasa3d/sheets-page/index.html')
  const call = async (fn, arg, ms = 180000) => {
    let timer
    const tmo = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${fn} 超时 ${ms / 1000} s`)), ms) })
    try { return await Promise.race([win.webContents.executeJavaScript(`window.sheetsReady.then(() => window.sheets.${fn}(${JSON.stringify(arg ?? null)}))`, true), tmo]) } finally { clearTimeout(timer) }
  }
  const env = await call('probe')
  log(`环境：WebGL2 ${env.webgl2 ? '有' : '无'} · WebP 编码 ${env.webp ? '有' : '无'} · three r${env.three} · GPU ${env.gpu}`)
  // 环境坏了就整批停下：否则每条都「出图失败 → 退回官方缩图」，产物看着齐全、其实全是 16:9 暗底图
  if (!env.webgl2 || !env.webp) {
    log(`✗ ${!env.webgl2 ? 'WebGL2 起不来' : 'WebP 编码不可用'}：中止（不整批退回官方缩图）。检查显卡驱动 / 远程桌面 / --disable-gpu 之类的启动参数。`)
    try { await call('shutdown', null, 30000) } catch { /* ignore */ }
    return 2
  }

  // 取景重画对拍闸（见 PARITY_MAX_SHARE / runParityGate）：有缩略图要出才对拍（只重出复核图不走 renderCrop），
  // 按待出图顺序试（NASA 件按文件、模板按生成）；候选件载不进 / 超时换下一件，不当成分家
  const usable = (j) => !j.missing && !(args.fail && args.fail.includes(j.id))
  const rendering = todo.filter((j) => j.plan === 'full' && usable(j))
  // --parity：没有要出的图也核一次（拿在册的件试），把结论补记进 sheets.json
  const cands = rendering.length ? rendering : args.parity ? jobs.filter(usable) : []
  if (rendering.length && args.noParity) state.parity = { ok: null, skipped: '--no-parity', at: new Date().toISOString() }
  if (cands.length && !args.noParity) {
    const g = await runParityGate(cands, (ref) => call('selfCheck', ref.kind === 'nasa'
      ? { id: ref.id, url: ref.url, meta: { id: ref.id, frame: ref.meta.frame, units: ref.meta.units, attachPoints: [] }, size: THUMB_SIZE, tol: PARITY_TOL }
      : { templateId: ref.templateId, size: THUMB_SIZE, tol: PARITY_TOL }), { onSkip: (j, v) => log(`  取景重画对拍核不了 ${j.id}（${v.reason}）：这件本身的问题，换下一件`) })
    const at = new Date().toISOString()
    if (g.ok === null) {
      state.parity = { ok: null, reason: `试了 ${g.tried.length} 件都核不了`, tried: g.tried, at }
      log(`⚠ 取景重画对拍：试了 ${g.tried.length} 件都核不了（${g.tried.map((t) => t.id).join('、')}）——照常出图；坏件各自退回官方缩图，退回过多仍按环境问题拦`)
    } else {
      const ref = cands.find((j) => j.id === g.id)
      state.parity = { id: g.id, recipe: ref && ref.recipe, ok: g.ok, diffPx: g.r.diffPx, maxDiff: g.r.maxDiff, n: g.r.n, tried: g.tried, at }
      if (!g.ok) {
        log(`✗ 取景重画对拍不过（${g.id}）：${g.verdict.reason}。sheets-page/main.js 的 renderCrop 与 thumbs.renderThumb 分家了（thumbs.js / studio.js / view.js 改过相机、布光或显示系？）——` +
          '按 renderThumb 现在的写法同步 renderCrop 再跑；确认不在乎取景放大那几十张与其余不一致才加 --no-parity。')
        try { await call('shutdown', null, 30000) } catch { /* ignore */ }
        return 2
      }
      log(`取景重画对拍：${g.id} 整幅 ${g.r.diffPx} / ${g.r.n} 像素不同（最大差 ${g.r.maxDiff}）· 通过`)
    }
  }

  const pngDir = args.png ? path.resolve(args.png) : null
  if (pngDir) await fsp.mkdir(pngDir, { recursive: true })
  const writeOut = async (j, r, source, renderError = null) => {
    const buf = Buffer.from(r.thumb, 'base64')
    const out = outThumb(j)
    await fsp.mkdir(path.dirname(out), { recursive: true })
    await fsp.writeFile(out, buf)
    if (r.review) await fsp.writeFile(path.join(reviewDir, reviewFileName(j.id)), Buffer.from(r.review, 'base64'))
    if (pngDir) {
      const p = await call('webpToPng', { b64: r.thumb })
      if (p && p.png) await fsp.writeFile(path.join(pngDir, reviewFileName(j.id)), Buffer.from(p.png, 'base64'))
    }
    const rec = {
      key: j.key, reviewKey: r.review ? j.reviewKey : null, contentKey: j.content, recipe: j.recipe, view: THUMB_VIEW, lod: j.kind === 'nasa' ? lod : null, source,
      thumbSha: sha256(buf), thumbBytes: buf.byteLength, zoom: r.zoom ?? null, crop: r.crop || null, qa: r.qa || null, tris: r.tris ?? null, ms: r.ms || null, at: new Date().toISOString()
    }
    if (renderError) rec.renderError = renderError
    if (j.kind === 'param') {
      rec.specHash = r.specHash || j.specHash
      await writeJsonAtomic(path.join(buildDir, PARAM_DIR, j.templateId, 'info.json'), { templateId: j.templateId, specHash: rec.specHash, thumbSha: rec.thumbSha, thumbBytes: rec.thumbBytes, view: THUMB_VIEW, recipe: recipeParam, renderedAt: rec.at })
    }
    state.entries[j.id] = rec
    return rec
  }

  const failures = []
  const fallbacks = []
  const reviewFails = []
  let done = 0
  const t1 = Date.now()
  for (const j of todo) {
    done++
    const tag = `[${String(done).padStart(3)}/${todo.length}] ${j.id.padEnd(58).slice(0, 58)}`
    // 只重出复核图（抬头变了、缩略图键没变）：thumb.webp 与记账里的缩略图字段一概不动；失败只告警（缩略图照样对），reviewKey 不更新、下次再试
    if (j.plan === 'review') {
      let r
      const o = { review: true, thumb: false, head: j.head }
      try {
        r = j.kind === 'nasa'
          ? await call('renderNasa', { ...o, id: j.id, url: j.url, meta: { id: j.id, frame: j.meta.frame, units: j.meta.units, attachPoints: [] } })
          : await call('renderTemplate', { ...o, templateId: j.templateId })
      } catch (e) { r = { error: e.message } }
      if (r && !r.error && r.review) {
        await fsp.writeFile(path.join(reviewDir, reviewFileName(j.id)), Buffer.from(r.review, 'base64'))
        state.entries[j.id] = { ...state.entries[j.id], reviewKey: j.reviewKey, reviewAt: new Date().toISOString() }
        log(`  ${tag} ✓ 只重出复核图 ${fmtSec((r.ms.load || 0) + (r.ms.review || 0))}（缩略图不动）`)
      } else {
        reviewFails.push({ id: j.id, error: (r && r.error) || '没有复核图' })
        log(`  ${tag} ⚠ 复核图重出失败（${reviewFails[reviewFails.length - 1].error}）：缩略图不动，下次再试`)
      }
      continue
    }
    let r
    if (j.missing) r = { error: j.missing }
    else if (args.fail && args.fail.includes(j.id)) r = { error: '演练：按 --fail 当作出图失败' }
    else if (j.kind === 'nasa') {
      const meta = { id: j.id, frame: j.meta.frame, units: j.meta.units, attachPoints: [] }
      try { r = await call('renderNasa', { id: j.id, url: j.url, meta, review, head: j.head }) } catch (e) { r = { error: e.message } }
    } else {
      try { r = await call('renderTemplate', { templateId: j.templateId, review, head: j.head }) } catch (e) { r = { error: e.message } }
    }
    if (r && !r.error) {
      await writeOut(j, r, 'render')
      const q = r.qa && r.qa.flags && r.qa.flags.length ? ` · 质检 ${r.qa.flags.join('/')}` : ''
      log(`  ${tag} ✓ ${fmtSec((r.ms.load || 0) + (r.ms.thumb || 0) + (r.ms.review || 0))}（载 ${r.ms.load} / 缩 ${r.ms.thumb} / 复 ${r.ms.review} ms）${r.zoom > 1.02 ? ` · 取景 ×${r.zoom.toFixed(2)}` : ''}${q}`)
      continue
    }
    const err = (r && r.error) || '未知错误'
    // 退回官方缩图（只 NASA 条目有）
    const slug = j.dir ? j.dir.replace(/~\d+$/, '') : null
    const url = !args.noFallback && j.kind === 'nasa' ? officialThumbUrl(featured.get(slug)) : null
    if (url) {
      try {
        const res = await net.fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buf = Buffer.from(await res.arrayBuffer())
        const o = await call('officialThumb', { b64: buf.toString('base64'), mime: res.headers.get('content-type') || 'image/png' })
        if (o && !o.error) {
          await writeOut(j, o, 'official', err)
          fallbacks.push({ id: j.id, error: err, url })
          log(`  ${tag} ↺ 出图失败（${err}），改用官方缩图`)
          continue
        }
        throw new Error(o && o.error)
      } catch (e) { failures.push({ id: j.id, error: `${err}；官方缩图也取不到：${e.message}` }) }
    } else failures.push({ id: j.id, error: err })
    state.entries[j.id] = { key: j.key, contentKey: j.content, error: failures[failures.length - 1].error, at: new Date().toISOString() }
    log(`  ${tag} ✗ ${failures[failures.length - 1].error}`)
  }
  const workMs = Date.now() - t1
  // 清掉已不在清单里的记账（条目下架 / 模板改名）——按全集，与本次跑了哪些无关；目录配对确认过才清（见文件头）
  const gone = bindV.prune ? pruneSheetEntries(state.entries, manifest.models.map((m) => m.id), PT.TEMPLATE_IDS) : []
  if (gone.length) log(`清掉 ${gone.length} 条已下架的记账：${gone.join('、')}`)
  const orphan = bindV.prune ? sweepOrphanSheetFiles({ reviewDir, buildDir, goneIds: gone, templateIds: PT.TEMPLATE_IDS }) : { review: [], param: [] }
  if (orphan.review.length || orphan.param.length) log(`清掉下架件的文件：复核图 ${orphan.review.length} 张${orphan.review.length ? `（${orphan.review.join('、')}）` : ''} · 模板缩略图目录 ${orphan.param.length} 个${orphan.param.length ? `（${orphan.param.join('、')}）` : ''}`)
  await writeJsonAtomic(stateFile, state)
  try { await call('shutdown', null, 30000) } catch { /* 退出前的清理失败不影响产物 */ }

  const sum = summarizeSheets(state)
  const nFull = todo.length - nReviewOnly
  const rendered = nFull - failures.length - fallbacks.length
  log('')
  log(formatTable(['项', '数值'], [
    ['本次出图', `${rendered} 成功 · ${fallbacks.length} 退回官方缩图 · ${failures.length} 失败（共 ${nFull}）`],
    ['只重出复核图', `${nReviewOnly - reviewFails.length} 成功 · ${reviewFails.length} 失败（共 ${nReviewOnly}）`],
    ['本次耗时', `${fmtSec(workMs)}（平均 ${todo.length ? Math.round(workMs / todo.length) : 0} ms / 条）`],
    ['全部记账', `${sum.total} 条：自渲染 ${sum.render} · 官方缩图 ${sum.official} · 缺 ${sum.failed.length}（其中模板 ${sum.templates}）`],
    ['稳健取景重画', `${sum.zoomed} 条（最大 ×${sum.zoomMax.toFixed(2)}）`],
    ['画面质检标记', `过小 ${sum.flagged.tiny.length} · 过暗 ${sum.flagged.dark.length} · 发白无明暗 ${sum.flagged.flat.length}`],
    ['总耗时', fmtSec(Date.now() - T0)]
  ], ['l', 'l']))
  for (const [k, ids] of Object.entries(sum.flagged)) if (ids.length) log(`质检 ${k}：${ids.join('、')}`)
  for (const f of failures) log(`✗ ${f.id}：${f.error}`)
  for (const f of reviewFails) log(`⚠ ${f.id} 复核图：${f.error}`)
  for (const [k, n] of pageWarn) if (n > 1) log(`  [page] ×${n}：${k}`)
  if (fallbackTooMany(fallbacks.length, nFull) && !args.allowFallback) {
    log(`✗ ${fallbacks.length}/${nFull} 条退回了官方缩图（> ${FALLBACK_MAX_SHARE * 100} %）：多半是环境问题而不是个别件坏了。确认要这样发布就加 --allow-fallback。`)
    return 1
  }
  if (sum.render + sum.official > 0) log('下一步：npm run nasa3d:build（走缓存，核对后把 thumb.webp 并进 meta 与 manifest）→ npm run nasa3d:builtin')
  return failures.length ? 1 : 0
}

// 只在「electron scripts/nasa3d/sheets.mjs」直接跑时开工；node 单测、别的 Electron 验证台 import 本文件只拿纯函数
const isEntry = entryArgIndex(process.argv, import.meta.url) > 0
if (process.versions.electron && isEntry) {
  const electron = createRequire(import.meta.url)('electron')
  if (!electron || typeof electron !== 'object' || !electron.app) {
    console.error('✗ 取不到 Electron 主进程 API：环境变量 ELECTRON_RUN_AS_NODE 是否被设成了 1？')
    process.exit(2)
  }
  const { app, protocol } = electron
  // 独立的 userData：`electron x.mjs` 的应用名是默认的 "Electron"，与仓库里别的验证台 / 脚本共用一份 GPU 缓存目录，
  // 同时跑就报「Unable to move the cache」；进程号隔开。退出时 GPU 进程还占着缓存文件、app.exit 也不发 quit 事件，
  // 自己的目录删不干净——每次启动先清掉进程已经不在的旧目录（sweepStaleUserData），积不起来。
  const tmp = os.tmpdir()
  const swept = sweepStaleUserData(tmp, pidAlive)
  const ud = path.join(tmp, `${USERDATA_PREFIX}${process.pid}`)
  app.setPath('userData', ud)
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'   // 本页只加载仓库里的文件，CSP 告警只会淹掉日志
  // 必须在 ready 之前：standard + supportFetchAPI（页面 fetch 模型文件）+ corsEnabled（模块脚本跨「源」加载：repo 与 build 两个 host）
  protocol.registerSchemesAsPrivileged([{ scheme: 'sheet', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
  app.commandLine.appendSwitch('ignore-gpu-blocklist')   // 与 main.js 同：老显卡驱动在黑名单里时 WebGL 会退软件光栅
  const finish = (code) => {
    for (const w of electron.BrowserWindow.getAllWindows()) { try { w.destroy() } catch { /* ignore */ } }
    try { fs.rmSync(ud, { recursive: true, force: true }) } catch { /* GPU 进程还占着：下次启动时清 */ }
    app.exit(code)
  }
  app.whenReady().then(() => {
    if (swept.removed.length) console.log(`清掉 ${swept.removed.length} 个旧的临时 userData（${USERDATA_PREFIX}*）`)
    return main(electron)
  }).then(
    (code) => finish(code),
    (e) => { console.error(`✗ ${e && e.stack ? e.stack : e}`); try { fs.appendFileSync(path.join(REVIEW_ROOT, 'sheets.log'), `✗ ${e && e.stack ? e.stack : e}\n`) } catch { /* ignore */ } finish(2) }
  )
  app.on('window-all-closed', () => { /* 批处理自己决定何时退出 */ })
}
