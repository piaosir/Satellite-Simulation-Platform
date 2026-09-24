// NASA 3D 语料 → 分发件（npm run nasa3d:build）。
//
//   node scripts/nasa3d/build.mjs [--only=slug,…] [--groups=spacecraft,…] [--concurrency=N] [--force] [--out=目录]
//                                 [--level=high|medium] [--lod2-tex=256] [--lod2-max-tris=25000] [--lod2-cull=0.01] [--lod2-strict]
//                                 [--src-dir=目录] [--include-list=文件] [--known-dims=文件] [--review-dir=build/review]
//
// 出厂档（2026-09-24 编排者定案 + 同日 lod2 预算）：meshopt level=high（lod0 全集 185 MB → 目标 ≤ 200 MB 以内；代价是法线 / 切线走
// 8 位八面体滤波，肉眼看不出）、lod2 贴图上限 256 px（lod2 只作球面图标、「低」档跟随与未下载时的预览，512 px 的贴图在 28–64 px
// 的图标里是白占）、lod2 三角形上限 2.5 万 + 零碎件剔除 1 % + 位置 12 位量化 + 删 glTF 动画（lod2 全集 40.4 → 29.4 MB，
// 目标 ≤ 30 MB；见 DEFAULT_LOD2_MAX_TRIS / LOD2_QUANT / LOD2_UV_WEIGHT 处的注释）。
// 换档（--level=medium、--lod2-tex=512、--lod2-max-tris=0 …）只为对照：每次全量运行的总量按处理选项记进 history.json，
// REPORT「处理档对照」逐档列出。
//
// 输入：.models-src/nasa/<slug>/{*.glb, meta.json}（nasa3d:fetch 落的只读原件）+ include-list.json（分组）
//       + known-dims.json（已知尺寸，反算单位）+ frame-overrides.json（逐件核过的本体朝向）+ kind-overrides.json + titles-zh.json。
//       --src-dir / --include-list / --known-dims / --frame-overrides 换输入（单测用临时小语料跑主流程；平时不用）。
//       frame-overrides.json 有坏条目（id 不过 schema.parseModelId / q 非单位 / axes 与 q 不符…）或全量运行时有目录里找不到的 id
//       （抄错、NASA 改了 slug）：那几条按缺省出、REPORT「本体朝向」列出、退出码 1——不许静默落回 +Y 天顶。
// 输出：build/models/<slug>[~n]/{lod0,lod1,lod2}.glb + meta.json（ModelMeta）+ build.json（管线出身与缓存键），
//       build/models/manifest.json（manifest v2）、build/models/REPORT.md。build/ 不进 git，原件永不改写。
//
// 全量 vs 子集：manifest.json 是 nasa3d:publish 上传的那一份，必须是全量目录。本次运行覆盖不到全部文件时——
//   --groups 没选全、或有文件既不在本次处理范围又没有可用的旧产物（--only 之外 + 换了 --level / --lod2-strict、全新 --out）——
//   只写 manifest.partial.json（带 partial:true 与原因），不动 manifest.json：子集目录一旦当全量传上云，
//   客户端库里其余模型整批消失。--only 在同一输出目录、同样选项下重跑是全量（其余条目走缓存并进 manifest）。
//   处理失败的文件不算子集（目录已尽力而为，退出码 1 提示），发布端的缩水闸会拦住因此少掉的已发布条目。
//
// 每个文件的处理顺序（DESIGN §8；顺序有讲究，改前看注释）：
//   ① 自己解 Draco（不交给 gltf-transform）：draco3dgltf 的 wasm 堆上限 2 GB，gltf-transform 全程只用一个解码模块，
//      ISS (D) IGOAL 两个 250 万顶点的图元解到第二个就 Aborted()，整个进程跟着崩。这里逐图元解，堆涨过 1 GB 就换一个
//      新模块，解坏了换新模块重试一次；解出的属性写回普通 accessor，再交给 NodeIO。
//   ② 外部贴图（6 个文件引用了 glb 外的 .jpg / .tga / .dds，NASA 没随附）：先塞 1×1 占位让 NodeIO 读得进来，读完把引用
//      它们的贴图整个 dispose（材质上的槽位随之置空，等于「没有这张贴图」），不留白图 / 错法线。
//   ③ 有 KHR_materials_pbrSpecularGlossiness 才跑 metalRough()（three 0.184 不认 SpecGloss，会退成一片灰）。
//   ④ 删相机 / 灯光（prune 只删没人引用的，glb 自带的相机 / KHR_lights_punctual 挂在节点上，得显式删）；
//      材质卫生：原件里 gltf-validator 判 Error 的越界系数与缺 TEXCOORD 修掉（sanitizeMaterials）；
//      材质兜底：无材质图元给中性浅灰、整件「退化黑」按材质名还原（applyMaterialFallbacks，理由见函数头）。
//   ⑤ 平移到几何中心（center，pivot=center）并记下偏移；不旋转（轴向交给 frame.q_model2body：缺省 +Y 天顶、逐件核过的按
//      frame-overrides.json，见 resolveFrame）；不缩放
//      （单位写进 units.scaleToMeters，原始数值留着，换一个已知尺寸重算时不用重新出件）。
//   ⑥ dedup → prune({keepExtras:true}) → weld；不 join（保留材质分组，部件分割按材质分组用）。
//   ⑦ 几何统计（在 lod0 精度上、模型单位）：三角形、表面积、包围半径、闭合性（按位置焊接后每条边恰好两个面且绕向相反）、
//      闭合时的体积与体积质心，不闭合取面积加权表面质心。换算到米在主线程做（比例可能随 known-dims 改）。
//   ⑧ 三档：lod0 不简化；lod1 simplify(0.3, 0.01)；lod2 simplify(0.1, 0.02)（error 相对网格尺度）→ prune →
//      贴图 webp（≤ 2048 / 1024 / 256，只缩不放；lod2 档可 --lod2-tex 改）→ meshopt(level:'high')（内部已含 quantize，前面不再单独量化）。
//      lod1 / lod2 简化前先去法线再焊接、简化后按 40° 折痕角重算法线（NASA 件按面法线拆顶点，不这样焊不上、减不动）；
//      lod2 另给简化器加 Prune + Permissive（跨贴图接缝塌缩、删零碎部件），--lod2-strict 关掉；lod2 预算：按整件尺度剔零碎网格、
//      超三角形上限的放宽 error 再降、删 glTF 动画、位置 12 位量化（simplifyToBudget / LOD2_QUANT）。理由见各函数头注。
// 缩略图：nasa3d:sheets 写在模型目录的 thumb.webp，按 sheets.json 的内容键核对（模型 / 标定变了就不认）后才并进 meta 与 manifest。
//
// 并行：worker_threads，一个 worker 一次处理一个文件（大文件先排）。worker 与主线程是同一个文件（按 isMainThread 分流）。
// 缓存：build.json 记 {管线版本, 原件 sha256, 三档 sha256}；原件与管线都没变、产物也还在且 sha 对得上，就不重做——
//       只重算 meta（改 known-dims / frame-overrides / 中文名 / kind 不需要重新出件）。--force 全部重做。
// 纯函数（排序 / id / 单位推断 / 已知尺寸反算 / kind 推断 / 标签别名 / 组装 meta 与 manifest）都导出，
// 单测在 packages/core/test/modelPipeline.test.mjs；以本文件为入口运行时才跑主流程（import 它不会开工）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HERE, REPO_ROOT, NASA_DIR, BUILD_ROOT, parseArgs, parseGlbHeader, readJson, writeJsonAtomic, loadIncludeList,
  assertSafeSlug, fmtBytes, fmtInt, fmtSec, formatTable, mdTable, MiB
} from './lib.mjs'
import { DEFAULT_Q_MODEL2BODY, Q_YUP_ZENITH, defaultImportQ, quatCanonical, quatAngleDeg, quatFromBodyAxes } from '../../packages/core/models/bodyFrame.mjs'
import { NASA_LICENSE, parseModelId } from '../../packages/core/models/schema.mjs'
import { checkThumbRecord, recipeHash, RECIPE_FILES, REVIEW_ROOT, summarizeSheets } from './sheets.mjs'

// ─────────────────────────────── 常量 ───────────────────────────────

/** 处理口径一变就 +1：旧产物的缓存全部作废。3：材质兜底（applyMaterialFallbacks）+ lod2 预算（零碎件剔除 + 三角形上限）。 */
export const PIPELINE_VERSION = 3

export const LOD_SPECS = Object.freeze([
  Object.freeze({ key: 'lod0', ratio: 1, error: 0, maxTex: 2048 }),
  Object.freeze({ key: 'lod1', ratio: 0.3, error: 0.01, maxTex: 1024 }),
  Object.freeze({ key: 'lod2', ratio: 0.1, error: 0.02, maxTex: 256 })
])
/** 出厂处理档（见文件头）：meshopt 档位、lod2 贴图边长上限、lod2 三角形上限、lod2 零碎件剔除阈。进 procOpts → build.json → 缓存比对。 */
export const DEFAULT_LEVEL = 'high'
export const DEFAULT_LOD2_TEX = 256
/** --lod2-tex 允许的值：2 的幂、64–2048（贴图只缩不放；非 2 的幂在老 GPU 上不能 mipmap） */
export const LOD2_TEX_CHOICES = Object.freeze([64, 128, 256, 512, 1024, 2048])
/**
 * lod2 预算（目标：lod2 全集 ≤ 30 MB）。lod2 的用途是球面图标（28–64 px）、画质「低」档的跟随视图、未下载完整模型时的预览，
 * 两道闸只作用在 lod2，lod0 / lod1 不动：
 *   · 三角形上限（DEFAULT_LOD2_MAX_TRIS）：ratio 0.1 对 ISS (D) 这类 300 万面的原件仍留 28 万面、5.8 MB；超上限的按
 *     「上限 ÷ 原面数」重设 ratio、放宽 error 再简化（simplifyToBudget）。0 = 不设上限。
 *   · 零碎件剔除（DEFAULT_LOD2_CULL，包围半径的比例）：简化的 error 是【各图元自身尺度】的比例，一颗 12 面的小螺栓在它自己
 *     的尺度上永远不算「小」，JWST (A) 1551 个图元里 496 个 ≤ 12 面、每个图元还要 3–4 个访问器 + 缓冲视图的 JSON（≈ 1 KB），
 *     JSON 比几何还大。按【整件】尺度剔掉包围半径 < 阈 × 整件半径的网格（在 64 px 图标里 < 0.2 px），剔除的三角形封顶 20 %
 *     （防止把一件由很多小件拼成的模型剔空）。节点保留（keepLeaves）：节点名在 lod2 里一个不少，关节 / 部件按名字照样找得到。
 */
export const DEFAULT_LOD2_MAX_TRIS = 25000
export const DEFAULT_LOD2_CULL = 0.01
export const LOD2_CULL_MAX_SHARE = 0.2
/**
 * lod2 另两项（固定口径，随 PIPELINE_VERSION）：
 *   · 量化位数：位置 12 位、贴图坐标 10 位（lod0 / lod1 是 meshopt high 的 14 / 12）。每个网格按自身包围盒量化，
 *     100 m 的 ISS 桁架精度 2.4 cm、256 px 贴图的坐标精度 1/4 纹素——图标与「低」档都看不出来。
 *   · 删 glTF 动画（atlas / redstone / 航天飞机每件 200 来条展开动画，lod2 合计约 1 MB）：平台里没有任何地方播放 glTF 动画
 *     （关节走 AGI_articulations / meta.articulations），lod0 / lod1 原样保留。
 */
export const LOD2_QUANT = Object.freeze({ quantizePosition: 12, quantizeTexcoord: 10 })

/**
 * 命令行 → 影响产物字节的处理选项（纯函数，单测覆盖）。缺省即出厂档；非法值抛错（带中文原因）。
 * 返回的对象进 job、进 build.json、参与缓存比对——键的顺序固定，JSON 比较才稳定。
 */
export function resolveProcOpts({ level, lod2Tex, lod2Strict, lod2MaxTris, lod2Cull } = {}) {
  const lv = level == null || level === '' ? DEFAULT_LEVEL : String(level)
  if (!['medium', 'high'].includes(lv)) throw new Error(`--level 只能是 medium 或 high，收到「${level}」`)
  const tex = lod2Tex == null || lod2Tex === '' ? DEFAULT_LOD2_TEX : Number(lod2Tex)
  if (!LOD2_TEX_CHOICES.includes(tex)) throw new Error(`--lod2-tex 只能是 ${LOD2_TEX_CHOICES.join(' / ')}，收到「${lod2Tex}」`)
  const cap = lod2MaxTris == null || lod2MaxTris === '' ? DEFAULT_LOD2_MAX_TRIS : Number(lod2MaxTris)
  if (!Number.isInteger(cap) || cap < 0 || (cap > 0 && cap < 1000)) throw new Error(`--lod2-max-tris 只能是 0（不设上限）或 ≥ 1000 的整数，收到「${lod2MaxTris}」`)
  const cull = lod2Cull == null || lod2Cull === '' ? DEFAULT_LOD2_CULL : Number(lod2Cull)
  if (!Number.isFinite(cull) || cull < 0 || cull > 0.05) throw new Error(`--lod2-cull 只能是 0–0.05（整件包围半径的比例；0 = 不剔除），收到「${lod2Cull}」`)
  return { meshoptLevel: lv, lod2Flags: lod2Strict ? [] : [...LOD2_FLAGS], lod2MaxTex: tex, lod2MaxTris: cap, lod2CullFrac: cull }
}
/** 某档实际用的贴图上限：lod2 取 job.lod2MaxTex（老 job 没带就按 LOD_SPECS），其余按 LOD_SPECS。 */
export function texLimitFor(spec, job = {}) {
  return spec.key === 'lod2' && LOD2_TEX_CHOICES.includes(job.lod2MaxTex) ? job.lod2MaxTex : spec.maxTex
}

// 许可文案全仓统一（编排者 2026-09-24 定案）：取 schema.mjs 的 NASA_LICENSE（与 schema 的 NASA 缺省来源同一个常量），转出给单测
export { NASA_LICENSE }
export const MODEL_GROUPS = Object.freeze(['spacecraft', 'deepspace', 'station', 'component', 'ground', 'crewed', 'launcher'])

// 出厂 q_model2body（= STK 映射，导出目标）：取 packages/core/models/bodyFrame.mjs 的唯一真值源，转出同名常量给单测与老调用方。
// NASA 条目【不】用它（轴映射终案 ②，编排者 2026-09-24）：美术件按 glTF 规范「+Y 朝上」建模，作者摆的「上」是天顶 →
// 缺省 NASA_DEFAULT_Q = defaultImportQ({sourceKind:'nasa'}) = Q_YUP_ZENITH；逐件核过朝向的按 frame-overrides.json（resolveFrame）。
// 管线本身不旋转几何（⑤），只把 q 写进 meta。
export { DEFAULT_Q_MODEL2BODY, Q_YUP_ZENITH }
/** NASA 条目没进覆盖表时的 q（= Q_YUP_ZENITH；经 defaultImportQ 取，与主进程导入 / 渲染端导入 / schema 兜底同一个缺省）。 */
export const NASA_DEFAULT_Q = Object.freeze(defaultImportQ({ sourceKind: 'nasa' }))

// 工程 CAD 转出、非美术重做的条目（任务书 §2.1：Hubble (B) 是 1784 节点的 CAD 装配；Cassini Assembly 页面写明「from CAD models」）
const FIDELITY_CAD = new Set(['hubble-space-telescope-b', 'cassini-assembly'])

export const KNOWN_DIMS_FILE = path.join(HERE, 'known-dims.json')
export const FRAME_OVERRIDES_FILE = path.join(HERE, 'frame-overrides.json')
export const KIND_OVERRIDES_FILE = path.join(HERE, 'kind-overrides.json')
export const TITLES_ZH_FILE = path.join(HERE, 'titles-zh.json')

const SCHEMA_URL = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'models', 'schema.mjs')).href
const MANIFEST_URL = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'models', 'manifest.mjs')).href

// ─────────────────────────────── 纯函数：文件与 id ───────────────────────────────

const stemOf = (f) => String(f).replace(/\.glb$/i, '')
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 多文件条目的文件顺序（决定 id 的 ~n）：按去掉 .glb 的主名逐码元比较。比较主名而不是整个文件名，
 * 是为了让「Cassini-Huygens (A).glb」排在「Cassini-Huygens (A) (without Cassini).glb」前面——整名比较时
 * 「 」(0x20) 小于「.」(0x2E)，派生件会抢到 nasa:<slug> 这个主 id。不用 localeCompare：结果随系统区域设置变，id 就不稳了。
 */
export function sortModelFiles(names) {
  return names.slice().sort((a, b) => cmp(stemOf(a), stemOf(b)) || cmp(a, b))
}

/** DESIGN §3.5：第 1 个 nasa:<slug>，之后 nasa:<slug>~<n>（n 从 2 起）；输出目录同名（~ 在 Windows 目录名里合法）。 */
export function modelIdsForEntry(slug, fileNames) {
  assertSafeSlug(slug)
  return sortModelFiles(fileNames).map((file, i) => ({
    file, n: i + 1, primary: i === 0,
    id: i === 0 ? `nasa:${slug}` : `nasa:${slug}~${i + 1}`,
    dir: i === 0 ? slug : `${slug}~${i + 1}`
  }))
}

// ─────────────────────────────── 纯函数：单位 ───────────────────────────────

/**
 * 包围盒量级规则（任务书 §5.3，没有已知尺寸时用）：最大边 0.3–300 视为米；300–3000 视为厘米（3–30 m）；
 * 3000–300000 视为毫米（3–300 m）；其余（< 0.3 或 > 300000）认不出，按 1 放着、标 unknown。
 * 这只是量级猜测：同一区间里英寸 / 英尺同样说得通，所以 sizeVerified 永远 false。
 * 区间边界与 packages/core/models/units.mjs 的 bboxRule 逐条一致（工作台里重新推断得出同一个数），单测交叉核对。
 */
export function guessUnitsFromSpan(span) {
  if (!(Number.isFinite(span) && span > 0)) return { unitGuess: 'unknown', scaleToMeters: 1 }
  if (span >= 0.3 && span <= 300) return { unitGuess: 'm', scaleToMeters: 1 }
  if (span > 300 && span < 3000) return { unitGuess: 'cm', scaleToMeters: 0.01 }
  if (span >= 3000 && span <= 300000) return { unitGuess: 'mm', scaleToMeters: 0.001 }
  return { unitGuess: 'unknown', scaleToMeters: 1 }
}

const UNIT_FACTORS = [['m', 1], ['cm', 0.01], ['mm', 0.001], ['in', 0.0254], ['ft', 0.3048]]
export const SNAP_TOLERANCE = 0.1
/**
 * 已知尺寸反算出的原始比值 → 最终 scaleToMeters：离某个标准单位（m / cm / mm / in / ft）相对误差 ≤ 10 % 时吸附到该单位，
 * 否则保留原比值、unitGuess='unknown'。与 units.mjs 的 INFER_SNAP 吸附口径一致——即 guessUnits 的「已知尺寸」一档、
 * 或 scaleFromKnownDim 显式传 snapTolerance: INFER_SNAP（单测交叉核对）。注意 scaleFromKnownDim 缺省**不吸附**：那是工作台
 * 「反算」按钮的口径（用户手填带出处的尺寸，结果必须照原值）；这里是自动推断作者单位，公开尺寸本身多是约数。
 * 美术模型本身的比例就不准（翼展、杆长常被画短画长），吸附到作者用的单位比保留 0.9375 这种比值更接近原意。
 */
export function snapScale(raw) {
  if (!(Number.isFinite(raw) && raw > 0)) return { scaleToMeters: 1, unitGuess: 'unknown', snapped: false, relErr: Infinity }
  let best = null
  for (const [u, k] of UNIT_FACTORS) { const rel = Math.abs(raw / k - 1); if (!best || rel < best.rel) best = { u, k, rel } }
  if (best.rel <= SNAP_TOLERANCE) return { scaleToMeters: best.k, unitGuess: best.u, snapped: true, relErr: best.rel }
  return { scaleToMeters: raw, unitGuess: 'unknown', snapped: false, relErr: best.rel }
}

const AXES = { x: 0, y: 1, z: 2 }
const maxRelDiff = (a, b) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i]) / Math.max(Math.abs(b[i]), 1e-12)))

/**
 * 用 known-dims.json 的一条反算 scaleToMeters。
 *   kd        { measure, valueM, source, fit: 'longest' | {axis} | {axis?, extentNative}, bboxNative?, file?, inherit? }
 *   bboxSize  本文件的包围盒三边（模型单位，已解 Draco 的精确值）
 *   ctx       { file, primary, inherited }：inherited = 同条目按 kd.file 算出的结果（给 inherit 用）
 * 返回 null（这条不适用于本文件）| { ok:false, reason } | { ok:true, scaleToMeters, unitGuess, sizeVerified:true, sizeSource, fit }
 *
 * fit 三种：
 *   'longest'          包围盒最长边 ↔ valueM
 *   {axis}             包围盒该轴全长 ↔ valueM（从当前文件重算）
 *   {extentNative}     研究时量得的某个部件跨度（杆 / 反射面 / 翼尖外接圆……，包围盒里重算不出来）↔ valueM；
 *                      只在当前包围盒与研究时的 bboxNative 相差 ≤ 0.5 % 时采用——文件换过，量得的部件跨度就不作数了。
 * 原始比值再过 snapScale（±10 % 吸附到标准单位）；fit 里留 rawScale / snapped 供 REPORT 对账。
 */
export function deriveScale(kd, bboxSize, ctx = {}) {
  if (!kd || !(Number.isFinite(kd.valueM) && kd.valueM > 0) || !kd.source) return null
  const { file, primary = true, inherited = null } = ctx
  // 多文件条目：量的是 kd.file（缺省主文件）；其余文件只有 inherit 时沿用同一比例（同一建模单位）
  const target = kd.file ? file === kd.file : primary
  if (!target) {
    if (kd.inherit && inherited && inherited.ok) return { ...inherited, fit: { ...inherited.fit, inheritedFrom: kd.file || '主文件' } }
    return null
  }
  if (!Array.isArray(bboxSize) || bboxSize.length !== 3 || !bboxSize.every((v) => Number.isFinite(v) && v >= 0)) return { ok: false, reason: '包围盒无效' }
  const fit = kd.fit || 'longest'
  let extent, mode, axis = null
  if (fit === 'longest') { extent = Math.max(...bboxSize); mode = 'longest' }
  else if (fit && Number.isFinite(fit.extentNative)) {
    if (!Array.isArray(kd.bboxNative)) return { ok: false, reason: '部件跨度缺 bboxNative，无法核对文件是否换过' }
    const drift = maxRelDiff(bboxSize, kd.bboxNative)
    if (drift > 0.005) return { ok: false, reason: `包围盒 ${bboxSize.map((v) => +v.toPrecision(5)).join('×')} 与研究时 ${kd.bboxNative.join('×')} 相差 ${(drift * 100).toFixed(1)} %，部件跨度不作数` }
    extent = fit.extentNative; mode = 'part'; axis = fit.axis || null
  } else if (fit && fit.axis in AXES) {
    extent = bboxSize[AXES[fit.axis]]; mode = 'axis'; axis = fit.axis
  } else return { ok: false, reason: `fit 写法不认识：${JSON.stringify(fit)}` }
  if (!(extent > 0)) return { ok: false, reason: '对应的模型尺寸为 0' }
  const raw = kd.valueM / extent
  const s = snapScale(raw)
  return {
    ok: true, scaleToMeters: s.scaleToMeters, unitGuess: s.unitGuess, sizeVerified: true, sizeSource: kd.source,
    fit: { mode, axis, extentModel: extent, measure: kd.measure, valueM: kd.valueM, confidence: kd.confidence || null, rawScale: raw, snapped: s.snapped }
  }
}

/** 单位的最终口径：known-dims 能用就用（sizeVerified=true），否则包围盒规则（sizeVerified=false）。 */
export function resolveUnits(kd, bboxSize, ctx = {}) {
  const d = deriveScale(kd, bboxSize, ctx)
  if (d && d.ok) return { units: { scaleToMeters: d.scaleToMeters, unitGuess: d.unitGuess, sizeVerified: true, sizeSource: d.sizeSource }, fit: d.fit, reject: null }
  const g = guessUnitsFromSpan(Array.isArray(bboxSize) ? Math.max(...bboxSize) : NaN)
  return { units: { scaleToMeters: g.scaleToMeters, unitGuess: g.unitGuess, sizeVerified: false }, fit: null, reject: d && !d.ok ? d.reason : null }
}

// ─────────────────────────────── 纯函数：本体朝向（frame-overrides.json） ───────────────────────────────

// 覆盖表的 id 与目录里的 id 同一条规则（schema.parseModelId）：~n 只有 ~2..~999，没有 ~0 / ~1 / ~01——
// 自己另写一条宽松的正则，写错的 id（nasa:x~1）过了格式检查却永远对不上任何模型，静默按缺省出。
const isOverrideId = (id) => { const p = parseModelId(id); return !!p && p.prefix === 'nasa' }
/** 覆盖表里的 q 须近单位长：|‖q‖ − 1| ≤ 它。离得远说明抄错了，整条不收（不静默归一——那会把一个错数变成另一个错数）。 */
export const OVERRIDE_Q_TOL = 1e-6
/** 带 axes 时与 q 的一致性门限（度）：写表的人改了一边忘了另一边，就拦下。 */
export const OVERRIDE_AXES_TOL_DEG = 0.01

/**
 * frame-overrides.json → { entries: Map<id, {q, basis, note, refs, axes}>, skipped: Map<id, 原因>, errors: string[] }（纯函数，单测覆盖）。
 * 文件形状：{ schema: 1, entries: { "nasa:<slug>[~n]": { q:[x,y,z,w], basis, note, refs:[…], axes?:{nadir, velocity, yawDeg?} } },
 *             skipped?: { "nasa:<slug>[~n]": "不校正的原因" } }
 * 条目合法 = id 过 schema.parseModelId 且前缀为 nasa（nasa:<slug>[~n]，n ∈ 2..999）；q 四个有限数且近单位长（OVERRIDE_Q_TOL）；basis 非空串；refs 为数组（可省）；
 *   带 axes 时 quatFromBodyAxes(axes) 与 q 的夹角 ≤ OVERRIDE_AXES_TOL_DEG。不合法的整条不收、原因进 errors（REPORT 列出，退出码 1）。
 * 同一 id 既在 entries 又在 skipped → 以 entries 为准，记一条 error（表自相矛盾）。
 */
export function parseFrameOverrides(json) {
  const entries = new Map()
  const skipped = new Map()
  const errors = []
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { entries, skipped, errors: ['frame-overrides.json 不是对象'] }
  const src = json.entries && typeof json.entries === 'object' && !Array.isArray(json.entries) ? json.entries : {}
  for (const [id, e] of Object.entries(src)) {
    const bad = (why) => errors.push(`${id}：${why}`)
    if (!isOverrideId(id)) { bad('id 须形如 nasa:<slug>[~n]（n 为 2..999，第 1 个文件不带 ~）'); continue }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { bad('条目不是对象'); continue }
    const q = e.q
    if (!Array.isArray(q) || q.length !== 4 || !q.every((v) => typeof v === 'number' && Number.isFinite(v))) { bad('q 须为 4 个有限数 [x,y,z,w]'); continue }
    if (Math.abs(Math.hypot(...q) - 1) > OVERRIDE_Q_TOL) { bad(`q 不是单位四元数（‖q‖ = ${Math.hypot(...q)}）`); continue }
    if (typeof e.basis !== 'string' || !e.basis.trim()) { bad('basis 须为非空字符串（依据：visual / 资料 …）'); continue }
    if (e.refs !== undefined && !Array.isArray(e.refs)) { bad('refs 须为数组'); continue }
    let axes = null
    if (e.axes !== undefined) {
      const a = e.axes
      const qa = a && typeof a === 'object' ? quatFromBodyAxes(a.nadir, a.velocity, a.yawDeg ?? 0) : null
      if (!qa) { bad(`axes 解不出朝向：${JSON.stringify(a)}`); continue }
      const d = quatAngleDeg(qa, q)
      if (!(d <= OVERRIDE_AXES_TOL_DEG)) { bad(`axes 与 q 不一致（差 ${d.toFixed(3)}°）`); continue }
      axes = { nadir: a.nadir, velocity: a.velocity, ...(a.yawDeg ? { yawDeg: a.yawDeg } : {}) }
    }
    entries.set(id, { q: quatCanonical(q), basis: e.basis.trim(), note: typeof e.note === 'string' ? e.note : '', refs: Array.isArray(e.refs) ? e.refs.filter((r) => typeof r === 'string') : [], axes })
  }
  const sk = json.skipped && typeof json.skipped === 'object' && !Array.isArray(json.skipped) ? json.skipped : {}
  for (const [id, why] of Object.entries(sk)) {
    if (!isOverrideId(id)) { errors.push(`skipped ${id}：id 须形如 nasa:<slug>[~n]（n 为 2..999，第 1 个文件不带 ~）`); continue }
    if (entries.has(id)) { errors.push(`${id}：既在 entries 又在 skipped（以 entries 为准）`); continue }
    skipped.set(id, typeof why === 'string' ? why : '')
  }
  return { entries, skipped, errors }
}

/**
 * 条目的 frame（纯函数）：覆盖表有 → { q = 覆盖值（w ≥ 0 规范化）, verified: true }；没有 → NASA 缺省（+Y 天顶）、verified: false。
 * t 恒为 0：几何已平移到中心（⑤），质心偏置留给工作台的质量属性。
 * @param {string} id
 * @param {{entries: Map}|null} overrides parseFrameOverrides 的结果
 * @returns {{frame:{q_model2body:number[], t_model2body:number[], verified:boolean}, how:'override'|'default'}}
 */
export function resolveFrame(id, overrides) {
  const e = overrides && overrides.entries instanceof Map ? overrides.entries.get(id) : null
  if (e) return { frame: { q_model2body: e.q.slice(), t_model2body: [0, 0, 0], verified: true }, how: 'override' }
  return { frame: { q_model2body: NASA_DEFAULT_Q.slice(), t_model2body: [0, 0, 0], verified: false }, how: 'default' }
}

// ─────────────────────────────── 纯函数：分类 / 标题 / 标签 ───────────────────────────────

// 标题关键词 → kind（只在条目没进 kind-overrides.json、include-list 也没给出七组之一时用；顺序即优先级）
const KIND_RULES = [
  ['station', /\bspace station\b|\biss\b|\bmir\b|\bgateway\b|\bskylab\b|\btiangong\b/],
  ['launcher', /\brocket\b|\bsaturn v\b|\bares\b|\batlas\b|\bredstone\b|\bjupiter-c\b|\blaunch vehicle\b|\bdelta ii\b|\bfalcon\b|\bsls\b/],
  ['crewed', /\bapollo\b|\bgemini\b|\bmercury capsule\b|\bspace shuttle\b|\bcrew module\b|\bsoyuz\b|\borion\b|\blunar module\b|\bexploration vehicle\b|\bdragon\b/],
  ['ground', /\bdeep space network\b|\bdsn\b|\bdish\b|\bradome\b|\bground station\b|\bbase station\b|\bantenna\b/],
  ['component', /\bcamera\b|\bspectrograph\b|\bspectrometer\b|\binstrument\b|\bassembly\b|\bcanadarm\b|\bmanipulator\b|\brobonaut\b|\btether\b|\breplacement unit\b|\bcarrier\b|\bparts?\b|\bpayload\b|\bsystem support\b|\bdemonstration\b/],
  ['deepspace', /\brover\b|\blander\b|\bhelicopter\b|\bmars\b|\blunar\b|\bmoon\b|\bjupiter\b|\bsaturn\b|\bvenus\b|\bmercury\b|\bcomet\b|\basteroid\b|\beuropa\b|\bpluto\b|\bvoyager\b|\bpioneer\b|\bcassini\b|\bjuno\b|\bdawn\b|\bwebb\b|\bsolar probe\b|\binterplanetary\b/],
  ['spacecraft', /\bsatellites?\b|\bsat\b|\bcubesats?\b|\btelescopes?\b|\bobservator(?:y|ies)\b|\bexplorers?\b|\bmissions?\b|\bprobes?\b|\bspacecraft\b/]
]

/** 标题关键词推断 kind（测得到的纯函数）；推不出返回 'other'。 */
export function inferKindFromTitle(title) {
  const t = ` ${String(title || '').toLowerCase()} `
  for (const [kind, re] of KIND_RULES) if (re.test(t)) return kind
  return 'other'
}

/** kind 的最终口径：kind-overrides.json（人工逐条核过）> include-list 的七组 > 标题关键词。 */
export function resolveKind(slug, title, group, overrides = {}) {
  const o = overrides && overrides[slug]
  if (typeof o === 'string' && (MODEL_GROUPS.includes(o) || o === 'other')) return { kind: o, how: 'override' }
  if (MODEL_GROUPS.includes(group)) return { kind: group, how: 'group' }
  return { kind: inferKindFromTitle(title), how: 'keyword' }
}

/** 去掉标题末尾的括注（「Cassini-Huygens (A)」→「Cassini-Huygens」），判断文件名里有没有带上条目名用。 */
const titleBase = (t) => { let s = String(t || '').trim(); for (let i = 0; i < 4; i++) s = s.replace(/\s*\([^()]*\)\s*$/, ''); return s.trim() }

/**
 * 英文标题：单文件条目 = 条目标题；多文件条目每个文件按文件主名（「Satellite Kit wings 2」），
 * 主名里没带条目名的（space-shuttle-parts 的「External tank」）前面补上条目标题：「Space Shuttle Parts · External tank」。
 */
export function titleForFile(entryTitle, fileName, multi) {
  const title = String(entryTitle || '').trim()
  if (!multi) return title
  const stem = stemOf(fileName).trim()
  const base = titleBase(title).toLowerCase()
  return base && stem.toLowerCase().includes(base) ? stem : `${title} · ${stem}`
}

/** 中文名：slug/文件名 > slug（仅主文件或单文件）> 条目中文名 +（文件主名）；都没有返回 null（REPORT 列「缺中文名」）。 */
export function resolveTitleZh(slug, fileName, { primary = true, multi = false } = {}, titlesZh = {}) {
  const byFile = titlesZh[`${slug}/${fileName}`]
  if (typeof byFile === 'string' && byFile.trim()) return byFile.trim()
  const bySlug = titlesZh[slug]
  if (typeof bySlug === 'string' && bySlug.trim()) {
    if (!multi || primary) return bySlug.trim()
    return `${bySlug.trim()}（${stemOf(fileName)}）`
  }
  return null
}

// 常用缩写 / 别名（按 slug 前缀）：NORAD 目录名、通行简称。autoMatch 另有自己的规则表，这里只管搜索与匹配的候选词。
const EXTRA_ALIASES = [
  ['hubble-space-telescope', ['HST', 'Hubble']],
  ['international-space-station', ['ISS', 'ISS (ZARYA)']],
  ['james-webb-space-telescope', ['JWST', 'Webb']],
  ['tracking-and-data-relay-satellites', ['TDRS', 'TDRSS']],
  ['geostationary-operational-environmental-satellites', ['GOES']],
  ['space-systems-loral-ssl-1300', ['SSL-1300', 'SSL 1300', 'LS-1300', 'FS-1300']],
  ['global-precipitation-measurement', ['GPM', 'GPM-CORE']],
  ['chandra-x-ray-observatory', ['CXO', 'AXAF', 'Chandra']],
  ['fermi-gamma-ray', ['GLAST', 'Fermi']],
  ['gamma-ray-observatory', ['CGRO', 'GRO', 'Compton']],
  ['far-ultraviolet-spectroscopic-explorer', ['FUSE']],
  ['high-energy-transient-explorer', ['HETE']],
  ['spitzer-space-telescope', ['SIRTF', 'Spitzer']],
  ['aeronomy-of-ice-in-the-mesosphere', ['AIM']],
  ['seastar', ['OrbView-2', 'SeaWiFS']],
  ['terra', ['EOS AM-1', 'Terra']],
  ['aqua-', ['EOS PM-1', 'Aqua']],
  ['aura-', ['EOS CH-1', 'Aura']],
  ['cubesat-1-ru-generic', ['1U', 'CubeSat 1U']],
  ['cubesat-2-ru-generic', ['2U', 'CubeSat 2U']],
  ['landsat-8', ['LDCM', 'Landsat 8']],
  ['landsat-7', ['Landsat 7']],
  ['jason-continuity-of-service-sentinel-6', ['Sentinel-6', 'Jason-CS', 'Sentinel-6 Michael Freilich']],
  ['ocean-surface-topography-mission-ostm-jason-2', ['Jason-2', 'OSTM']],
  ['jason-1', ['Jason-1']],
  ['topex-poseidon', ['TOPEX', 'Poseidon', 'T/P']],
  ['mars-2020-perseverance-rover', ['Perseverance', 'M2020']],
  ['mars-exploration-rover-opportunity', ['Opportunity', 'MER-B']],
  ['deep-space-network-34-meter', ['DSN', 'DSS-34']],
  ['deep-space-network-70-meter', ['DSN', 'DSS-43']],
  ['gateway-lunar-space-station', ['Gateway', 'LOP-G']],
  ['suomi-national-polar-orbiting-partnership', ['NPP', 'SNPP', 'Suomi NPP']],
  ['hessi-rhessi', ['RHESSI', 'HESSI']],
  ['time-history-of-events', ['THEMIS']],
  ['wind', ['WIND']],
  ['van-allen-probes', ['RBSP', 'Van Allen']]
]

const STOPWORDS = new Set(['and', 'of', 'the', 'for', 'a', 'an', 'in', 'on', 'during', 'to', 'with', 'generic', 'model', '3d', 'ru'])
const LOWER_DESCRIPTOR = /^[a-z][a-z ,-]*$/   // (compact) (unfurled) (left antenna)：状态描述，不算别名

/**
 * tags：标题拆词（小写、去停用词与纯数字）+ kind + group；aliases：括注里的缩写 / 专名（单字母版本号、年份、小写描述除外）、
 * 标题里的全大写词、斜杠两边、再加 EXTRA_ALIASES。去重不分大小写，别名保留原大小写。
 */
export function buildTagsAliases(title, slug, { kind, group, fileName } = {}) {
  const t = String(title || '')
  const tags = []
  const seenT = new Set()
  const addT = (w) => { const k = String(w).toLowerCase(); if (k && !seenT.has(k)) { seenT.add(k); tags.push(k) } }
  for (const w of t.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/)) {
    if (w.length >= 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) addT(w)
  }
  if (kind) addT(kind)
  if (group && group !== kind) addT(group)
  addT('nasa')

  const aliases = []
  const seenA = new Set()
  const addA = (a) => { const s = String(a || '').trim(); const k = s.toLowerCase(); if (s && s.length <= 128 && !seenA.has(k)) { seenA.add(k); aliases.push(s) } }
  for (const m of t.matchAll(/\(([^()]+)\)/g)) {
    const c = m[1].trim()
    if (/^[A-Z]$/.test(c) || /^\d{4}$/.test(c) || LOWER_DESCRIPTOR.test(c) || /3d model/i.test(c)) continue
    addA(c)
    if (c.includes('/')) for (const p of c.split('/')) addA(p)
  }
  for (const m of t.replace(/\([^()]*\)/g, ' ').matchAll(/\b[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*\b/g)) {
    const w = m[0]
    if (w.length >= 3 && /[A-Z]{2,}/.test(w)) { addA(w); if (w.includes('/')) for (const p of w.split('/')) if (p.length >= 3) addA(p) }
  }
  for (const [prefix, list] of EXTRA_ALIASES) if (slug === prefix || slug.startsWith(prefix)) list.forEach(addA)
  // 多文件条目的派生件：别名不继承主件的缩写之外的东西；文件主名本身也作别名（「Satellite Kit wings 2」）
  if (fileName) addA(stemOf(fileName))
  return { tags, aliases }
}

/** 署名：全是 NASA/… 的写「NASA」；有第三方贡献者（DigitalSpace Corporation 等）照原文附上——许可要求保留第三方署名。 */
export function nasaCredit(contributors) {
  const list = (Array.isArray(contributors) ? contributors : []).map((s) => String(s).trim()).filter(Boolean)
  const third = list.filter((s) => !/^NASA\b/i.test(s))
  return third.length ? `NASA / ${third.join('、')}` : 'NASA'
}

// ─────────────────────────────── 纯函数：组装 meta / manifest ───────────────────────────────

/** 有效数字 7 位：manifest 小一点、同一输入重跑逐字节一致（浮点尾数不同平台会抖）。 */
export const round7 = (v) => (Number.isFinite(v) ? (v === 0 ? 0 : Number(v.toPrecision(7))) : v)
const r3 = (a) => a.map(round7)

/**
 * 组装一条完整 ModelMeta（DESIGN §3.2）。w = worker 产出（模型单位的几何统计与三档文件），u = resolveUnits 的结果。
 * 几何换算：几何中心已平移到原点，bboxM = ±半边长 × scale；面积 × scale²、体积 × scale³（bboxM 是【模型轴】、米——本体系尺寸由 frame 现算）。
 * thumb：{sha256, bytes}（nasa3d:sheets 在模型目录里写了 thumb.webp 时由主流程读出；没有就不带）。
 * frame：resolveFrame 的 frame（不给 = NASA 缺省 q、未核）。
 */
export function composeMeta({ id, slug, entry, file, multi, primary, w, units, kind, titleZh, updatedAt, thumb = null, frame = null }) {
  const s = units.scaleToMeters
  const half = w.bboxSize.map((v) => v / 2)
  const title = titleForFile(entry.title, file, multi)
  const { tags, aliases } = buildTagsAliases(title, slug, { kind, group: entry.group, fileName: multi ? file : null })
  const files = {}
  for (const spec of LOD_SPECS) {
    const f = w.lods[spec.key]
    files[spec.key] = { sha256: f.sha256, bytes: f.bytes, tris: f.tris }
  }
  if (thumb && SHA_RE.test(thumb.sha256 || '') && thumb.bytes > 0) files.thumb = { sha256: thumb.sha256, bytes: thumb.bytes }
  const meta = {
    schema: 2,
    id,
    title,
    ...(titleZh ? { titleZh } : {}),
    kind,
    ...(MODEL_GROUPS.includes(entry.group) ? { group: entry.group } : {}),
    fidelity: FIDELITY_CAD.has(slug) ? 'cad' : 'outreach',
    source: { kind: 'nasa', url: entry.page || '', credit: nasaCredit(entry.contributors), license: NASA_LICENSE, redistributable: true },
    files,
    units: { scaleToMeters: round7(s), unitGuess: units.unitGuess, sizeVerified: units.sizeVerified === true, ...(units.sizeVerified ? { sizeSource: units.sizeSource } : {}) },
    // importQ = 出厂映射（工作台「本体轴 · 出厂映射」factoryFrameQ ① 取它）：核过的取核定 q，没进覆盖表的取 NASA 缺省。
    // 缩略图内容键（sheets.thumbContentKey）只看 q / t / 比例，多这个键不会让已出的缩略图作废
    frame: frame && Array.isArray(frame.q_model2body)
      ? { q_model2body: frame.q_model2body.slice(), t_model2body: Array.isArray(frame.t_model2body) ? frame.t_model2body.slice() : [0, 0, 0], verified: frame.verified === true, importQ: frame.q_model2body.slice() }
      : { q_model2body: NASA_DEFAULT_Q.slice(), t_model2body: [0, 0, 0], verified: false, importQ: NASA_DEFAULT_Q.slice() },
    geometry: {
      bboxM: { min: r3(half.map((h) => -h * s)), max: r3(half.map((h) => h * s)) },
      boundingRadiusM: round7(w.stats.radius * s),
      tris: w.lods.lod0.tris,
      areaM2: round7(w.stats.area * s * s),
      volumeM3: w.stats.closed && Number.isFinite(w.stats.volume) ? round7(Math.abs(w.stats.volume) * s * s * s) : null,
      closed: w.stats.closed === true,
      centroidM: r3(w.stats.centroid.map((v) => v * s))
    },
    parts: [],
    massProps: null,
    attachPoints: [],
    articulations: [],
    solarPanelGroups: [],
    noObscurationNodes: [],
    tags,
    aliases,
    updatedAt
  }
  return meta
}

// manifest 精简条目的字段（DESIGN §3.3；W1 的 schema.slimMeta 在时用它，这里是它不在时的同口径兜底）
const SLIM_KEYS = ['schema', 'id', 'title', 'titleZh', 'kind', 'group', 'fidelity', 'source', 'files', 'units', 'frame', 'geometry', 'tags', 'aliases', 'updatedAt']
export function slimMetaLocal(m) {
  const o = {}
  for (const k of SLIM_KEYS) if (m[k] !== undefined) o[k] = JSON.parse(JSON.stringify(m[k]))
  return o
}

/** buildId 只由内容决定（条目按 id 排序后整体哈希）：同一批产物重跑得到同一个 id，manifest.<buildId>.json 不会无谓地多一份。 */
export function computeBuildId(models) {
  const h = crypto.createHash('sha256').update(JSON.stringify(models)).digest('hex')
  return `nasa-${h.slice(0, 12)}`
}

export function buildManifest(slimModels, { generatedAt = new Date().toISOString() } = {}) {
  const models = slimModels.slice().sort((a, b) => cmp(a.id, b.id))
  return { schema: 2, buildId: computeBuildId(models), generatedAt, models }
}

const SHA_RE = /^[0-9a-f]{64}$/
/**
 * manifest 字段形状自检（W1 的 manifest.mjs 就绪前的兜底；就绪后两边都跑）。
 * 远端口径：只收 nasa 来源、redistributable=true，三档齐全，sha / bytes 合法，id 唯一。返回 { ok, errors }。
 */
export function checkManifestShape(m) {
  const errors = []
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest 不是对象'] }
  if (m.schema !== 2) errors.push(`schema 须为 2（得到 ${JSON.stringify(m.schema)}）`)
  if (typeof m.buildId !== 'string' || !m.buildId) errors.push('buildId 缺失')
  if (!Number.isFinite(Date.parse(m.generatedAt))) errors.push('generatedAt 不是时间')
  if (!Array.isArray(m.models)) return { ok: false, errors: [...errors, 'models 不是数组'] }
  const ids = new Set()
  m.models.forEach((x, i) => {
    const p = `models[${i}]（${x && x.id}）`
    if (!x || typeof x !== 'object') { errors.push(`${p} 不是对象`); return }
    if (!/^nasa:[a-z0-9][a-z0-9-]*[a-z0-9](~[2-9]|~[1-9][0-9]+)?$/.test(x.id || '')) errors.push(`${p} id 格式不对`)
    if (ids.has(x.id)) errors.push(`${p} id 重复`)
    ids.add(x.id)
    if (x.schema !== 2) errors.push(`${p} schema 不是 2`)
    if (!x.title) errors.push(`${p} 缺 title`)
    if (!x.source || x.source.kind !== 'nasa' || x.source.redistributable !== true) errors.push(`${p} 来源须为 nasa 且 redistributable=true`)
    for (const k of ['lod0', 'lod1', 'lod2']) {
      const f = x.files && x.files[k]
      if (!f || !SHA_RE.test(f.sha256 || '') || !(Number.isInteger(f.bytes) && f.bytes > 0) || !(Number.isInteger(f.tris) && f.tris >= 0)) errors.push(`${p} files.${k} 不完整`)
    }
    const u = x.units
    if (!u || !(u.scaleToMeters > 0) || typeof u.sizeVerified !== 'boolean' || (u.sizeVerified && !u.sizeSource)) errors.push(`${p} units 不合法`)
    const q = x.frame && x.frame.q_model2body
    if (!Array.isArray(q) || q.length !== 4 || Math.abs(Math.hypot(...q) - 1) > 1e-6) errors.push(`${p} frame.q_model2body 不是单位四元数`)
    const g = x.geometry
    if (!g || !g.bboxM || !Array.isArray(g.bboxM.min) || !Array.isArray(g.bboxM.max) || g.bboxM.min.some((v, k) => v > g.bboxM.max[k])) errors.push(`${p} geometry.bboxM 不合法`)
  })
  return { ok: errors.length === 0, errors }
}

// ─────────────────────────────── Draco 预解码（worker 内用；纯数据进出，单测用夹具测） ───────────────────────────────

const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const CTYPE = {
  5120: ['DT_INT8', Int8Array], 5121: ['DT_UINT8', Uint8Array], 5122: ['DT_INT16', Int16Array],
  5123: ['DT_UINT16', Uint16Array], 5125: ['DT_UINT32', Uint32Array], 5126: ['DT_FLOAT32', Float32Array]
}
const HEAP_RECYCLE = 1024 * MiB   // 解码模块的 wasm 堆涨过 1 GB 就换新模块（上限 2 GB，大图元一个就要 1.9 GB）

/**
 * 把 GLB 里所有 KHR_draco_mesh_compression 图元解成普通 accessor。
 *   json      glTF JSON（会被改写：accessor 挂上新 bufferView、图元去掉 Draco 扩展、extensionsUsed/Required 去掉 Draco）
 *   bin       原 BIN 块（Uint8Array）；返回的新 BIN = 原 BIN + 解出的数据（4 字节对齐），原 Draco bufferView 留着不删（没人引用，NodeIO 不读）
 *   makeModule  async () => Draco 解码模块（draco3dgltf.createDecoderModule）
 * 返回 { json, bin, prims, points, failed: [{mesh, prim, error}] }；failed 非空时调用方按「Draco 解码失败」整件放弃，不出残缺模型。
 */
export async function dracoPredecode(json, bin, makeModule) {
  const used = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : []
  if (!used.includes('KHR_draco_mesh_compression')) return { json, bin, prims: 0, points: 0, failed: [] }
  const chunks = [bin]
  let offset = bin.byteLength
  const push = (u8) => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad }
    const bv = { buffer: 0, byteOffset: offset, byteLength: u8.byteLength }
    json.bufferViews = json.bufferViews || []
    json.bufferViews.push(bv)
    chunks.push(u8); offset += u8.byteLength
    return json.bufferViews.length - 1
  }
  let M = null
  const getModule = async (fresh) => {
    if (fresh || !M || (M.HEAPU8 && M.HEAPU8.byteLength > HEAP_RECYCLE)) M = null
    if (!M) { const m = await makeModule(); M = m.module || m }
    return M
  }
  const failed = []
  let prims = 0, points = 0
  for (let mi = 0; mi < (json.meshes || []).length; mi++) {
    const mesh = json.meshes[mi]
    for (let pi = 0; pi < (mesh.primitives || []).length; pi++) {
      const p = mesh.primitives[pi]
      const ext = p.extensions && p.extensions.KHR_draco_mesh_compression
      if (!ext) continue
      prims++
      let out = null, lastErr = null
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try { out = decodeDracoPrimitive(await getModule(attempt > 0), json, bin, p, ext) } catch (e) { lastErr = e; M = null }
      }
      if (!out) { failed.push({ mesh: mi, prim: pi, error: String((lastErr && lastErr.message) || lastErr || '未知错误').slice(0, 200) }); continue }
      points += out.numPoints
      for (const [sem, arr] of out.attrs) {
        const acc = json.accessors[p.attributes[sem]]
        acc.bufferView = push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength))
        acc.byteOffset = 0
        acc.count = out.numPoints
        delete acc.sparse
      }
      if (out.indices) {
        let ai = p.indices
        if (ai == null) { json.accessors.push({ componentType: 5125, type: 'SCALAR', count: 0 }); ai = p.indices = json.accessors.length - 1 }
        const acc = json.accessors[ai]
        acc.componentType = 5125
        acc.count = out.indices.length
        acc.byteOffset = 0
        delete acc.min; delete acc.max
        acc.bufferView = push(new Uint8Array(out.indices.buffer, out.indices.byteOffset, out.indices.byteLength))
      }
      delete p.extensions.KHR_draco_mesh_compression
      if (!Object.keys(p.extensions).length) delete p.extensions
    }
  }
  if (!failed.length) {
    json.extensionsUsed = used.filter((x) => x !== 'KHR_draco_mesh_compression')
    if (!json.extensionsUsed.length) delete json.extensionsUsed
    if (Array.isArray(json.extensionsRequired)) {
      json.extensionsRequired = json.extensionsRequired.filter((x) => x !== 'KHR_draco_mesh_compression')
      if (!json.extensionsRequired.length) delete json.extensionsRequired
    }
  }
  const out = new Uint8Array(offset)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.byteLength }
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = offset
  return { json, bin: out, prims, points, failed }
}

function decodeDracoPrimitive(M, json, bin, p, ext) {
  const bv = json.bufferViews[ext.bufferView]
  const start = bv.byteOffset || 0
  const data = bin.subarray(start, start + bv.byteLength)
  const decoder = new M.Decoder()
  const buffer = new M.DecoderBuffer()
  let geom = null
  try {
    buffer.Init(new Int8Array(data.buffer, data.byteOffset, data.byteLength), data.byteLength)
    const type = decoder.GetEncodedGeometryType(buffer)
    let status
    if (type === M.TRIANGULAR_MESH) { geom = new M.Mesh(); status = decoder.DecodeBufferToMesh(buffer, geom) }
    else if (type === M.POINT_CLOUD) { geom = new M.PointCloud(); status = decoder.DecodeBufferToPointCloud(buffer, geom) }
    else throw new Error(`未知的 Draco 几何类型 ${type}`)
    if (!status.ok() || geom.ptr === 0) throw new Error(`Draco 解码失败：${status.error_msg()}`)
    const numPoints = geom.num_points()
    const attrs = []
    for (const [sem, accIdx] of Object.entries(p.attributes || {})) {
      const uid = ext.attributes ? ext.attributes[sem] : undefined
      if (uid == null) continue   // 规范允许部分属性不压缩：它有自己的 bufferView，原样留着
      const acc = json.accessors[accIdx]
      const [dtName, TA] = CTYPE[acc.componentType] || []
      const nComp = NCOMP[acc.type]
      if (!TA || !nComp) throw new Error(`${sem}：不支持的 accessor 类型 ${acc.componentType}/${acc.type}`)
      const attr = decoder.GetAttributeByUniqueId(geom, uid)
      if (!attr || attr.ptr === 0) throw new Error(`${sem}：Draco 里找不到属性 ${uid}`)
      if (attr.num_components() !== nComp) throw new Error(`${sem}：分量数 ${attr.num_components()} 与 accessor ${acc.type} 不符`)
      const n = numPoints * nComp
      const byteLength = n * TA.BYTES_PER_ELEMENT
      const ptr = M._malloc(byteLength)
      try {
        if (!decoder.GetAttributeDataArrayForAllPoints(geom, attr, M[dtName], byteLength, ptr)) throw new Error(`${sem}：取属性数据失败`)
        attrs.push([sem, new TA(M.HEAPU8.buffer, ptr, n).slice()])   // 先拷出来再 free：堆会被后续 malloc 复用 / 增长后换 buffer
      } finally { M._free(ptr) }
    }
    let indices = null
    if (type === M.TRIANGULAR_MESH) {
      const n = geom.num_faces() * 3
      const byteLength = n * 4
      const ptr = M._malloc(byteLength)
      try {
        decoder.GetTrianglesUInt32Array(geom, byteLength, ptr)
        indices = new Uint32Array(M.HEAPU8.buffer, ptr, n).slice()
      } finally { M._free(ptr) }
    }
    return { numPoints, attrs, indices }
  } finally {
    if (geom) M.destroy(geom)
    M.destroy(buffer)
    M.destroy(decoder)
  }
}

// ─────────────────────────────── 几何统计（worker 内，gltf-transform Document） ───────────────────────────────

/** 按位置焊接用的开放寻址哈希：键 = float32 三分量的位模式（-0 归一成 0），值 = 顶点编号。 */
class PositionHash {
  constructor(capacity) {
    let size = 16
    while (size < capacity * 2) size *= 2
    this.mask = size - 1
    this.keys = new Uint32Array(size * 3)
    this.ids = new Int32Array(size).fill(-1)
    this.count = 0
    this.f = new Float32Array(3)
    this.u = new Uint32Array(this.f.buffer)
  }
  id(x, y, z) {
    const f = this.f, u = this.u
    f[0] = x + 0; f[1] = y + 0; f[2] = z + 0
    const a = u[0], b = u[1], c = u[2]
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & this.mask
    const keys = this.keys, ids = this.ids
    for (;;) {
      const id = ids[h]
      if (id === -1) { ids[h] = this.count; keys[h * 3] = a; keys[h * 3 + 1] = b; keys[h * 3 + 2] = c; return this.count++ }
      if (keys[h * 3] === a && keys[h * 3 + 1] === b && keys[h * 3 + 2] === c) return id
      h = (h + 1) & this.mask
    }
  }
}

function sceneOf(doc) {
  const root = doc.getRoot()
  return root.getDefaultScene() || root.listScenes()[0] || null
}

/** 场景里按实例数的三角形（渲染量口径：同一网格被引用 N 次算 N 次）。 */
export function countSceneTriangles(doc) {
  const scene = sceneOf(doc)
  if (!scene) return 0
  let tris = 0
  scene.traverse((node) => {
    const mesh = node.getMesh()
    if (!mesh) return
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode()
      const idx = prim.getIndices()
      const pos = prim.getAttribute('POSITION')
      const n = idx ? idx.getCount() : (pos ? pos.getCount() : 0)
      if (mode === 4) tris += Math.floor(n / 3)
      else if (mode === 5 || mode === 6) tris += Math.max(0, n - 2)
    }
  })
  return tris
}

/**
 * 模型单位下的几何统计（世界矩阵已含 center 的平移，原点 = 包围盒中心）：
 *   { tris, area, radius, centroid:[3], closed, volume, weldedVertices }
 * 闭合性：全部三角形按位置焊接后，每条无向边恰好出现两次且两次方向相反（绕向一致）。退化三角形（焊接后两点重合）不计边。
 * 边用 Float64 打包（小号 × 2^24 + 大号）×2 + 方向位，整体数值排序后数段——比 Map 省一个数量级内存。顶点超过 2^24 个不判闭合（记 false）。
 */
export function geometryStats(doc) {
  const scene = sceneOf(doc)
  const res = { tris: 0, area: 0, radius: 0, centroid: [0, 0, 0], closed: false, volume: null, weldedVertices: 0 }
  if (!scene) return res
  const items = []
  let capacity = 0
  scene.traverse((node) => {
    const mesh = node.getMesh()
    if (!mesh) return
    const Mw = node.getWorldMatrix()
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode()
      if (mode !== 4 && mode !== 5 && mode !== 6) continue
      const pos = prim.getAttribute('POSITION')
      if (!pos) continue
      items.push({ M: Mw, prim, mode, pos })
      capacity += pos.getCount()
    }
  })
  const hash = new PositionHash(Math.max(16, capacity))
  let edges = new Float64Array(Math.max(16, capacity * 2))
  let ne = 0
  const pushEdge = (k) => { if (ne === edges.length) { const e2 = new Float64Array(edges.length * 2); e2.set(edges); edges = e2 } edges[ne++] = k }
  const SH = 16777216 // 2^24
  let edgeOk = true
  let ax = 0, ay = 0, az = 0, vol6 = 0, vx = 0, vy = 0, vz = 0, r2 = 0
  const el = [0, 0, 0]
  for (const { M, prim, mode, pos } of items) {
    const n = pos.getCount()
    const wp = new Float64Array(n * 3)
    const arr = pos.getArray()
    const fast = arr instanceof Float32Array && !pos.getNormalized() && pos.getElementSize() === 3
    for (let i = 0; i < n; i++) {
      let x, y, z
      if (fast) { x = arr[i * 3]; y = arr[i * 3 + 1]; z = arr[i * 3 + 2] } else { pos.getElement(i, el); x = el[0]; y = el[1]; z = el[2] }
      const X = M[0] * x + M[4] * y + M[8] * z + M[12]
      const Y = M[1] * x + M[5] * y + M[9] * z + M[13]
      const Z = M[2] * x + M[6] * y + M[10] * z + M[14]
      wp[i * 3] = X; wp[i * 3 + 1] = Y; wp[i * 3 + 2] = Z
      const d = X * X + Y * Y + Z * Z
      if (d > r2) r2 = d
    }
    const ids = new Uint32Array(n)
    for (let i = 0; i < n; i++) ids[i] = hash.id(wp[i * 3], wp[i * 3 + 1], wp[i * 3 + 2])
    const idxAcc = prim.getIndices()
    const ia = idxAcc ? idxAcc.getArray() : null
    const cnt = ia ? ia.length : n
    const at = (k) => (ia ? ia[k] : k)
    const nt = mode === 4 ? Math.floor(cnt / 3) : Math.max(0, cnt - 2)
    // 世界矩阵行列式为负（镜像）时绕向翻转：体积与边方向都要跟着翻
    const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2])
    const flip = det < 0
    for (let t = 0; t < nt; t++) {
      let a, b, c
      if (mode === 4) { a = at(3 * t); b = at(3 * t + 1); c = at(3 * t + 2) }
      else if (mode === 5) { if (t % 2 === 0) { a = at(t); b = at(t + 1) } else { a = at(t + 1); b = at(t) } c = at(t + 2) }
      else { a = at(0); b = at(t + 1); c = at(t + 2) }
      if (flip) { const s = b; b = c; c = s }
      const x0 = wp[a * 3], y0 = wp[a * 3 + 1], z0 = wp[a * 3 + 2]
      const x1 = wp[b * 3], y1 = wp[b * 3 + 1], z1 = wp[b * 3 + 2]
      const x2 = wp[c * 3], y2 = wp[c * 3 + 1], z2 = wp[c * 3 + 2]
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, wx = x2 - x0, wy = y2 - y0, wz = z2 - z0
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx
      const ar = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
      res.tris++
      res.area += ar
      ax += ar * (x0 + x1 + x2) / 3; ay += ar * (y0 + y1 + y2) / 3; az += ar * (z0 + z1 + z2) / 3
      // 有向四面体（原点, a, b, c）的 6 倍体积；闭合且绕向一致时求和 = 6V
      const v6 = x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2)
      vol6 += v6
      vx += v6 * (x0 + x1 + x2) / 4; vy += v6 * (y0 + y1 + y2) / 4; vz += v6 * (z0 + z1 + z2) / 4
      if (edgeOk) {
        const A = ids[a], B = ids[b], C = ids[c]
        if (A === B || B === C || A === C) continue
        if (hash.count >= SH) { edgeOk = false; continue }
        // 热路径：三条有向边逐条内联，不造临时数组（ISS 一个文件就是 300 万个三角形）
        pushEdge(A < B ? (A * SH + B) * 2 : (B * SH + A) * 2 + 1)
        pushEdge(B < C ? (B * SH + C) * 2 : (C * SH + B) * 2 + 1)
        pushEdge(C < A ? (C * SH + A) * 2 : (A * SH + C) * 2 + 1)
      }
    }
  }
  res.weldedVertices = hash.count
  res.radius = Math.sqrt(r2)
  let closed = edgeOk && ne > 0
  if (closed) {
    const e = edges.subarray(0, ne).sort()
    for (let i = 0; i < ne && closed;) {
      const key = Math.floor(e[i] / 2)
      let j = i, d0 = 0, d1 = 0
      while (j < ne && Math.floor(e[j] / 2) === key) { if (e[j] % 2) d1++; else d0++; j++ }
      if (d0 !== 1 || d1 !== 1) closed = false
      i = j
    }
  }
  res.closed = closed
  if (closed && Math.abs(vol6) > 0) {
    res.volume = vol6 / 6
    res.centroid = [vx / vol6, vy / vol6, vz / vol6]
  } else if (res.area > 0) {
    res.centroid = [ax / res.area, ay / res.area, az / res.area]
  }
  return res
}

// ─────────────────────────────── lod1 / lod2 的焊接与折痕法线（worker 内） ───────────────────────────────
//
// 为什么 lod1 / lod2 要先去法线再焊接：NASA 模型多是硬表面平面拼接，导出器按「面法线」拆顶点（MAVEN (A) 175 万三角形有 421 万顶点，
// ISS (D) 298 万三角形 641 万顶点），weld 只合并逐位相同的顶点，法线不同就合不上——网格实际上是一堆互不相连的三角形，
// meshopt 的简化只能沿边界塌缩，在 error 上限内几乎减不动（实测 ISS lod2 仍有 233 万三角形、57 MB）。
// 先丢掉 NORMAL / TANGENT，按位置（+ 贴图坐标等其余属性）焊接，简化后再按折痕角重算法线：
// 相邻面夹角 ≤ 40° 的平滑，> 40° 的拆开——箱体、桁架、太阳翼的棱角保持硬边，圆柱 / 反射面保持光滑。
// lod0 不动（原精度、原法线）。带变形目标（morph target）的图元不动（目标里也有法线，重算会对不上）。

export const CREASE_ANGLE_DEG = 40
// lod2 的简化 flag（meshoptimizer ≥ 0.22；见 processModelFile 里的说明）
export const LOD2_FLAGS = Object.freeze(['Prune', 'Permissive'])

/** 给 MeshoptSimplifier 套一层：只改 simplify 的 flags，ready / simplifyPoints / compactMesh 等原样继承（原型链）。 */
export function withSimplifyFlags(S, flags) {
  const w = Object.create(S)
  w.simplify = (indices, pos, stride, target, error, f) => S.simplify(indices, pos, stride, target, error, [...new Set([...(f || []), ...flags])])
  return w
}

/** 去掉可重算的法线 / 切线，返回被处理的图元集合（之后只给这些图元重算法线）。 */
export function stripNormalsForSimplify(doc) {
  const touched = new Set()
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4 || prim.listTargets().length) continue
      if (!prim.getAttribute('NORMAL') && !prim.getAttribute('TANGENT')) continue
      prim.setAttribute('NORMAL', null)
      prim.setAttribute('TANGENT', null)
      touched.add(prim)
    }
  }
  return touched
}

/**
 * 折痕角法线：对每个角（三角形的一个顶点），取该顶点周围与本面法线夹角 ≤ angle 的面，按面积加权平均；
 * 同一顶点上法线相同的角共用一个新顶点，不同的拆成多个顶点（其余属性照抄）。只处理 TRIANGLES 且有索引的图元。
 * doc：用来建新 accessor（挂到文档的第一个 buffer）。
 */
export function creaseNormals(doc, prim, angleDeg = CREASE_ANGLE_DEG) {
  const pos = prim.getAttribute('POSITION')
  const idxAcc = prim.getIndices()
  if (!pos || !idxAcc || prim.getMode() !== 4) return false
  const n = pos.getCount()
  const I = idxAcc.getArray()
  const nf = Math.floor(I.length / 3)
  if (!nf) return false
  const P = new Float64Array(n * 3)
  const el = [0, 0, 0]
  for (let i = 0; i < n; i++) { pos.getElement(i, el); P[i * 3] = el[0]; P[i * 3 + 1] = el[1]; P[i * 3 + 2] = el[2] }
  // 面法线：faceA = 叉积（长度 = 2×面积，作面积权），faceU = 单位法线
  const faceA = new Float64Array(nf * 3)
  const faceU = new Float64Array(nf * 3)
  for (let f = 0; f < nf; f++) {
    const a = I[3 * f] * 3, b = I[3 * f + 1] * 3, c = I[3 * f + 2] * 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const L = Math.hypot(x, y, z)
    faceA[f * 3] = x; faceA[f * 3 + 1] = y; faceA[f * 3 + 2] = z
    if (L > 0) { faceU[f * 3] = x / L; faceU[f * 3 + 1] = y / L; faceU[f * 3 + 2] = z / L }
  }
  // 顶点 → 角（CSR）
  const start = new Uint32Array(n + 1)
  for (let c = 0; c < nf * 3; c++) start[I[c] + 1]++
  for (let v = 0; v < n; v++) start[v + 1] += start[v]
  const fill = start.slice(0, n)
  const corners = new Uint32Array(nf * 3)
  for (let c = 0; c < nf * 3; c++) corners[fill[I[c]]++] = c
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const newIndex = new Uint32Array(nf * 3)
  const remap = []            // 新顶点 → 原顶点
  const normals = []          // 新顶点的法线（xyz 连排）
  const cn = [0, 0, 0]
  for (let v = 0; v < n; v++) {
    const s = start[v], e = start[v + 1]
    const made = []           // 本顶点已建的新顶点：[新号, nx, ny, nz]
    for (let i = s; i < e; i++) {
      const fa = Math.floor(corners[i] / 3)
      cn[0] = 0; cn[1] = 0; cn[2] = 0
      for (let j = s; j < e; j++) {
        const fb = Math.floor(corners[j] / 3)
        if (faceU[fa * 3] * faceU[fb * 3] + faceU[fa * 3 + 1] * faceU[fb * 3 + 1] + faceU[fa * 3 + 2] * faceU[fb * 3 + 2] >= cosT || fa === fb) {
          cn[0] += faceA[fb * 3]; cn[1] += faceA[fb * 3 + 1]; cn[2] += faceA[fb * 3 + 2]
        }
      }
      let L = Math.hypot(cn[0], cn[1], cn[2])
      if (!(L > 0)) { cn[0] = faceU[fa * 3]; cn[1] = faceU[fa * 3 + 1]; cn[2] = faceU[fa * 3 + 2]; L = Math.hypot(cn[0], cn[1], cn[2]) }
      if (!(L > 0)) { cn[0] = 0; cn[1] = 0; cn[2] = 1; L = 1 }
      const nx = cn[0] / L, ny = cn[1] / L, nz = cn[2] / L
      let id = -1
      for (const m of made) if (m[1] * nx + m[2] * ny + m[3] * nz > 0.99995) { id = m[0]; break }
      if (id < 0) { id = remap.length; remap.push(v); normals.push(nx, ny, nz); made.push([id, nx, ny, nz]) }
      newIndex[corners[i]] = id
    }
  }
  const m = remap.length
  const buffer = doc.getRoot().listBuffers()[0]
  for (const sem of prim.listSemantics()) {
    const acc = prim.getAttribute(sem)
    const src = acc.getArray()
    const k = acc.getElementSize()
    const dst = new src.constructor(m * k)
    for (let i = 0; i < m; i++) { const o = remap[i] * k; for (let t = 0; t < k; t++) dst[i * k + t] = src[o + t] }
    const na = doc.createAccessor().setType(acc.getType()).setArray(dst).setNormalized(acc.getNormalized())
    if (buffer) na.setBuffer(buffer)
    prim.setAttribute(sem, na)
  }
  const nAcc = doc.createAccessor().setType('VEC3').setArray(new Float32Array(normals))
  if (buffer) nAcc.setBuffer(buffer)
  prim.setAttribute('NORMAL', nAcc)
  const iAcc = doc.createAccessor().setType('SCALAR').setArray(m > 65535 ? newIndex : Uint16Array.from(newIndex))
  if (buffer) iAcc.setBuffer(buffer)
  prim.setIndices(iAcc)
  return true
}

// ─────────────────────────────── 材质卫生（原件自带的规范错误，gltf-validator 判 Error 的两类） ───────────────────────────────

const clamp01 = (v) => Math.min(1, Math.max(0, v))

/**
 * 修原件里 glTF-Validator 判为 Error 的两类问题（实测 4 个 NASA 原件带着，出件前修掉，免得分发件验不过）：
 *   ① 系数越界（aqua-a 的 roughnessFactor = -0.131）：roughness / metallic / baseColor / emissive 夹到 [0,1]。
 *   ② 材质要 TEXCOORD_n 而图元没有（jason-1、OSTM、QuikSCAT）：给图元补一列全 0 的 TEXCOORD_n。
 *      three 对缺 uv 的图元本来就按 uv=(0,0) 取样，补 0 后显示与原件在 three 里一致，只是不再违反规范；
 *      不改材质、不删贴图（材质常被多个图元共用，改材质会波及有 uv 的图元）。
 * 返回 { clamped, texcoordsAdded }。
 */
export function sanitizeMaterials(doc, listTextureInfoByMaterial) {
  let clamped = 0, texcoordsAdded = 0
  const root = doc.getRoot()
  for (const m of root.listMaterials()) {
    const r = m.getRoughnessFactor(), mt = m.getMetallicFactor()
    if (r !== clamp01(r)) { m.setRoughnessFactor(clamp01(r)); clamped++ }
    if (mt !== clamp01(mt)) { m.setMetallicFactor(clamp01(mt)); clamped++ }
    const bc = m.getBaseColorFactor()
    if (bc.some((v) => v !== clamp01(v))) { m.setBaseColorFactor(bc.map(clamp01)); clamped++ }
    const em = m.getEmissiveFactor()
    if (em.some((v) => v !== clamp01(v))) { m.setEmissiveFactor(em.map(clamp01)); clamped++ }
  }
  const buffer = root.listBuffers()[0]
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()
      const pos = prim.getAttribute('POSITION')
      if (!mat || !pos) continue
      const need = new Set()
      for (const info of listTextureInfoByMaterial(mat)) need.add(info.getTexCoord() || 0)
      for (const k of need) {
        const sem = `TEXCOORD_${k}`
        if (prim.getAttribute(sem)) continue
        const acc = doc.createAccessor().setType('VEC2').setArray(new Float32Array(pos.getCount() * 2))
        if (buffer) acc.setBuffer(buffer)
        prim.setAttribute(sem, acc)
        texcoordsAdded++
      }
    }
  }
  return { clamped, texcoordsAdded }
}

// ─────────────────────────────── 材质兜底（原件导出坏了、在任何 glTF 查看器里都画不出形状的两类） ───────────────────────────────
//
// 为什么在管线里做而不是在渲染端：分发件是工作台预览、3D 页图标 / 跟随、缩略图三处共用的同一个文件，在这里修一次，三处同一张脸；
// 渲染端（materials.js）只认得出「没有材质」，认不出「这个黑其实是导出器丢了颜色」。用户自己导入的件不经过这里（建议渲染端另做一道）。
//   ① 图元没有材质（Hubble (B) 1308 个图元全部没有、MMS (A) 唯一的图元没有，另有 30 来个文件零星几个）：glTF 规定缺省材质是
//      baseColor 1 / metallic 1 / roughness 1——白色的「粗糙金属」在影棚光下没有明暗，缩略图一片白、看不出形状。
//      给一份共用的中性浅灰漆面（非金属），名字 NEUTRAL_MATERIAL_NAME。
//   ② 整件「退化黑」（Cassini Assembly：8 个材质里 7 个 baseColor = 0 且 KHR_materials_specular.specularFactor = 0，名字却叫
//      white / aluminum / gold / silver ——导出器把颜色丢了）：这种材质不反射任何光，整件在任何查看器里都是一块黑剪影。
//      只在【退化黑材质覆盖了整件一半以上的三角形】时才动（零星的黑色件多半是有意的：black_krinkle、Main Dish-black……），
//      按材质名关键词还原成常见航天器表面（金色 MLI / 银色金属 / 白漆 / 灰 / 黑漆），并去掉 specularFactor = 0。
//   ③ 电池片正面的退化黑（POES 的 Noaa-solarpanelFace：一整面太阳翼成了不反光的黑洞，缩略图亮度均值 0.04）：名字是电池片正面的，
//      不论占比都换成电池片外观（深蓝、带光泽，与 materials.js 的 solar_cell 同量级）——电池片从来不是哑光黑。
export const NEUTRAL_MATERIAL_NAME = 'satsim-neutral'
export const DEGENERATE_SHARE = 0.5
/** 电池片正面的材质名（Noaa-solarpanelFace、…cells）：退化黑时不论占比都换成电池片外观（见 ③） */
export const SOLAR_FACE_RE = /solar.*(face|front)|cells?(?![a-z])/i
/** 材质名 → 兜底外观（线性色；与 materials.js 的材质库同一量级）。按顺序取第一个命中的；都不中取 default。 */
export const DEGENERATE_PALETTE = Object.freeze([
  Object.freeze({ re: SOLAR_FACE_RE, color: [0.02, 0.04, 0.12], metallic: 0.35, roughness: 0.18 }),
  Object.freeze({ re: /gold|mli|kapton/i, color: [0.83, 0.6, 0.25], metallic: 1, roughness: 0.3 }),
  Object.freeze({ re: /silver|alum|anod|metal|chrome|steel|titan/i, color: [0.8, 0.8, 0.82], metallic: 1, roughness: 0.35 }),
  Object.freeze({ re: /white/i, color: [0.85, 0.85, 0.85], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: /gr[ae]y/i, color: [0.4, 0.4, 0.42], metallic: 0, roughness: 0.55 }),
  Object.freeze({ re: /red|orange/i, color: [0.6, 0.18, 0.06], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: /black|dark/i, color: [0.03, 0.03, 0.03], metallic: 0, roughness: 0.5 }),
  Object.freeze({ re: null, color: [0.6, 0.6, 0.6], metallic: 0, roughness: 0.5 })
])
export function degeneratePaletteFor(name) {
  const s = String(name || '')
  return DEGENERATE_PALETTE.find((p) => !p.re || p.re.test(s))
}
const lumMax = (c) => Math.max(c[0], c[1], c[2])
/** 材质是否「退化黑」：底色近黑、没有底色贴图、不自发光、镜面反射被 specularFactor = 0 关掉。 */
export function isDegenerateBlack(mat) {
  if (!mat) return false
  if (lumMax(mat.getBaseColorFactor()) >= 0.02 || mat.getBaseColorTexture()) return false
  if (lumMax(mat.getEmissiveFactor()) >= 0.02 || mat.getEmissiveTexture()) return false
  const sp = mat.getExtension('KHR_materials_specular')
  return !!sp && sp.getSpecularFactor() === 0 && !sp.getSpecularTexture()
}
const primTris = (prim) => {
  const idx = prim.getIndices()
  const pos = prim.getAttribute('POSITION')
  if (prim.getMode() !== 4) return 0
  return Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3)
}
/**
 * 在去重 / 简化之前对整份文档做一次（三档共用同一份材质）。返回 { noMaterialPrims, degenerate:{share, fixed:[名字]} }。
 */
export function applyMaterialFallbacks(doc) {
  const root = doc.getRoot()
  let neutral = null
  let noMaterialPrims = 0, total = 0, degTris = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const t = primTris(prim)
      total += t
      const mat = prim.getMaterial()
      if (!mat) {
        if (!neutral) neutral = doc.createMaterial(NEUTRAL_MATERIAL_NAME).setBaseColorFactor([0.8, 0.8, 0.8, 1]).setMetallicFactor(0).setRoughnessFactor(0.6).setDoubleSided(true)
        prim.setMaterial(neutral)
        noMaterialPrims++
      } else if (isDegenerateBlack(mat)) degTris += t
    }
  }
  const share = total ? degTris / total : 0
  const fixed = []
  for (const mat of root.listMaterials()) {
    if (!isDegenerateBlack(mat)) continue
    if (share > DEGENERATE_SHARE || SOLAR_FACE_RE.test(mat.getName() || '')) {
      const p = degeneratePaletteFor(mat.getName())
      const a = mat.getBaseColorFactor()[3]
      mat.setBaseColorFactor([...p.color, a]).setMetallicFactor(p.metallic).setRoughnessFactor(p.roughness)
      mat.setExtension('KHR_materials_specular', null)
      fixed.push(mat.getName() || '（无名）')
    }
  }
  return { noMaterialPrims, degenerate: { share: +share.toFixed(4), fixed } }
}

// ─────────────────────────────── lod2 预算：零碎件剔除 + 三角形上限（见 DEFAULT_LOD2_MAX_TRIS 处的注释） ───────────────────────────────

/**
 * 按整件尺度剔除零碎网格（只给 lod2 用；在简化之前做，省得简化器白算）。
 * 每个网格的尺度 = 它所有实例（引用它的节点）里世界包围盒半对角线的最大值；整件尺度 = 场景包围盒半对角线。
 * 尺度 < frac × 整件尺度的网格从所有节点上摘下（节点本身留着，见 DEFAULT_LOD2_MAX_TRIS 处）；按尺度从小到大摘，
 * 摘掉的三角形累计不超过全件的 maxShare。返回 { meshes, tris, total }。
 */
export function cullSmallMeshes(doc, F, frac, maxShare = LOD2_CULL_MAX_SHARE) {
  const out = { meshes: 0, tris: 0, total: 0 }
  if (!(frac > 0)) return out
  const scene = sceneOf(doc)
  if (!scene) return out
  const b = F.getBounds(scene)
  const R = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
  if (!(R > 0)) return out
  const info = new Map()   // mesh → { r, tris, nodes }
  const lo = [0, 0, 0], hi = [0, 0, 0], p = [0, 0, 0]
  scene.traverse((node) => {
    const mesh = node.getMesh()
    if (!mesh) return
    const m = node.getWorldMatrix()
    let r = 0, tris = 0
    for (const prim of mesh.listPrimitives()) {
      tris += primTris(prim)
      const pos = prim.getAttribute('POSITION')
      if (!pos || !pos.getCount()) continue
      pos.getMin(lo); pos.getMax(hi)
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
      for (let c = 0; c < 8; c++) {
        p[0] = c & 1 ? hi[0] : lo[0]; p[1] = c & 2 ? hi[1] : lo[1]; p[2] = c & 4 ? hi[2] : lo[2]
        const X = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], Y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], Z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z
      }
      r = Math.max(r, 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0))
    }
    const e = info.get(mesh) || { r: 0, tris, nodes: [], inst: 0 }
    e.r = Math.max(e.r, r); e.nodes.push(node); e.inst++
    info.set(mesh, e)
  })
  for (const e of info.values()) out.total += e.tris * e.inst
  const cand = [...info.entries()].filter(([, e]) => e.r < frac * R).sort((a, b) => a[1].r - b[1].r)
  const budget = out.total * maxShare
  for (const [mesh, e] of cand) {
    const t = e.tris * e.inst
    if (out.tris + t > budget) break
    for (const n of e.nodes) n.setMesh(null)
    if (!mesh.listParents().some((x) => x.propertyType === 'Node')) mesh.dispose()
    out.meshes++
    out.tris += t
  }
  return out
}

/**
 * lod2 贴图坐标的权重（simplifyWithAttributes 的 attribute_weights，两个分量同权）。
 * 为什么要：lod2 给简化器加了 Permissive（允许跨贴图接缝塌缩，否则带贴图的件被接缝卡住减不动），gltf-transform 的 simplify 只喂位置，
 * 接缝两侧的 uv 塌到一起就是乱拉：ISS (D) 的太阳翼在 lod2 里成了一片斜纹（2026-09-24 复核图，上限前后都这样）。
 * 带贴图的图元改走 simplifyWithAttributes，把 TEXCOORD_0 按这个权重计进误差——拉花的塌缩代价高，简化器就绕开它们。
 * 无贴图的图元 uv 画不出来，照旧只按位置简化（与 lod1 同一条路）。
 */
export const LOD2_UV_WEIGHT = 3

/** 材质有没有贴图（任何槽位） */
const hasTexture = (F, mat) => !!mat && F.listTextureInfoByMaterial(mat).length > 0

/**
 * 按图元简化（替代 F.simplify，调用前要先 weld）：带贴图、位置与 TEXCOORD_0 都是 Float32 的三角形图元走 simplifyWithAttributes
 * （uv 权重 uvWeight）；其余交给 gltf-transform 的 simplifyPrimitive（与 F.simplify 逐图元同一条路）。简化后没三角形的图元删掉，
 * 删空的网格一并删。S 是原始 MeshoptSimplifier（带 flags 的外壳只包了 simplify）。返回 { attr, plain }（两条路各几个图元）。
 */
export function simplifyPrims(doc, F, S, { simplifier, ratio, error, flags = [], uvWeight = LOD2_UV_WEIGHT }) {
  const out = { attr: 0, plain: 0 }
  const buffer = doc.getRoot().listBuffers()[0]
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mode = prim.getMode()
      if (mode !== 4 && mode !== 5 && mode !== 6 && mode !== 0) continue
      const pos = prim.getAttribute('POSITION'), uv = prim.getAttribute('TEXCOORD_0'), idx = prim.getIndices()
      const P = pos && pos.getArray(), UV = uv && uv.getArray()
      if (mode === 4 && idx && uvWeight > 0 && P instanceof Float32Array && UV instanceof Float32Array && hasTexture(F, prim.getMaterial())) {
        const I = idx.getArray() instanceof Uint32Array ? idx.getArray() : Uint32Array.from(idx.getArray())
        const target = Math.floor((ratio * I.length) / 3) * 3
        const [dst] = S.simplifyWithAttributes(I, P, 3, UV, 2, [uvWeight, uvWeight], null, target, error, flags)
        const acc = doc.createAccessor().setType('SCALAR').setArray(dst)
        if (buffer) acc.setBuffer(buffer)
        prim.setIndices(acc)
        if (!idx.listParents().some((x) => x !== doc.getRoot() && x.propertyType !== 'Root')) idx.dispose()
        F.compactPrimitive(prim)
        const n = prim.getIndices().getCount()
        if (F.getPrimitiveVertexCount(prim, 'upload') <= 65534 && n) prim.getIndices().setArray(new Uint16Array(prim.getIndices().getArray()))
        out.attr++
      } else {
        F.simplifyPrimitive(prim, { simplifier, ratio, error })
        out.plain++
      }
      if (F.getPrimitiveVertexCount(prim, 'render') === 0) prim.dispose()
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose()
  }
  return out
}

/**
 * lod1 / lod2 的简化（从同一份基准文档克隆，基准不动）：[lod2 剔零碎件] → 去法线 → 焊接 → 简化 → 折痕法线 → prune。
 * lod2 设了三角形上限且超了：按「上限 ÷ 剔除后面数」重设 ratio，error 依次放宽到 0.05 / 0.1 / 0.2 重来，取第一个落进上限 × 1.1 的
 * （都落不进取面数最少的那次）。返回 { doc, budget }，budget 记剔除与降面过程（进 build.json 与 REPORT）。
 */
export async function simplifyToBudget(base, F, spec, { simplifier, raw = null, flags = [], uvWeight = 0, cullFrac = 0, maxTris = 0 } = {}) {
  const isL2 = spec.key === 'lod2'
  const run = async (ratio, error) => {
    const d = F.cloneDocument(base)
    const cull = isL2 && cullFrac > 0 ? cullSmallMeshes(d, F, cullFrac) : null
    const touched = stripNormalsForSimplify(d)
    // lod2 带贴图的图元按 uv 计误差（LOD2_UV_WEIGHT 处的注释）；lod1 与 lod2 其余图元与 F.simplify 同一条路
    if (raw && uvWeight > 0) {
      await d.transform(F.weld())
      simplifyPrims(d, F, raw, { simplifier, ratio, error, flags, uvWeight })
    } else await d.transform(F.weld(), F.simplify({ simplifier, ratio, error }))
    for (const prim of touched) if (!prim.isDisposed()) creaseNormals(d, prim)
    // lod2 剔了零碎件：空出来的叶节点留着（节点名一个不少）；其余照旧删空叶
    await d.transform(F.prune({ keepExtras: true, keepLeaves: !!(cull && cull.meshes) }))
    return { d, cull, tris: countSceneTriangles(d), ratio, error }
  }
  let best = await run(spec.ratio, spec.error)
  const budget = { cull: best.cull && best.cull.meshes ? { meshes: best.cull.meshes, tris: best.cull.tris } : null, cap: null }
  if (isL2 && maxTris > 0 && best.tris > maxTris * 1.1) {
    const first = best.tris
    const base0 = best.cull ? best.cull.total - best.cull.tris : countSceneTriangles(base)
    const tries = []
    for (const error of [0.05, 0.1, 0.2]) {
      const ratio = Math.min(spec.ratio, (maxTris / Math.max(1, base0)) * 0.95)
      const r = await run(ratio, error)
      tries.push({ ratio: +ratio.toPrecision(4), error, tris: r.tris })
      if (r.tris < best.tris) best = r
      if (r.tris <= maxTris * 1.1) break
    }
    budget.cap = { maxTris, before: first, after: best.tris, ratio: +best.ratio.toPrecision(4), error: best.error, tries }
  }
  return { doc: best.d, budget }
}

// ─────────────────────────────── worker：单文件处理 ───────────────────────────────

// 1×1 PNG：只为让 NodeIO 把引用了缺失外部图片的 glb 读进来，读完即连同贴图一起 dispose
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

export async function loadToolchain() {
  const [{ NodeIO, Logger }, { ALL_EXTENSIONS }, F, draco3d, meshopt, sharpMod] = await Promise.all([
    import('@gltf-transform/core'), import('@gltf-transform/extensions'), import('@gltf-transform/functions'),
    import('draco3dgltf'), import('meshoptimizer'), import('sharp')
  ])
  const { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } = meshopt
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready])
  const d3 = draco3d.default || draco3d
  // gltf-transform 的日志收进 notes（去重），不往终端刷：213 个文件的「Missing optional extension」会淹掉进度
  const notes = new Set()
  class CollectLogger extends Logger {
    constructor() { super(Logger.Verbosity.WARN) }
    warn(t) { notes.add(String(t)) }
    error(t) { notes.add('错误：' + String(t)) }
    info() {}
    debug() {}
  }
  const io = new NodeIO().setLogger(new CollectLogger()).registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder
  })
  // Emscripten 模块带 .then：直接 resolve 会被当成 thenable 递归展开，包一层再返回（DRACOLoader 也是这么做的）
  const makeDracoModule = async () => ({ module: await d3.createDecoderModule({}) })
  return { io, F, MeshoptEncoder, MeshoptSimplifier, sharp: sharpMod.default || sharpMod, makeDracoModule, notes }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(tmp, buf)
  await fsp.rename(tmp, file)
}

function stageError(stage, e) {
  const err = new Error(`${stage}：${(e && e.message) || e}`)
  err.stage = stage
  return err
}

/**
 * 处理一个原件。job = { srcPath, outDir }；返回可 JSON 化的结果（见文件头 ①–⑧）。抛错时 e.stage 标出哪一步。
 */
export async function processModelFile(tc, job) {
  const t0 = performance.now()
  const { io, F, MeshoptEncoder, MeshoptSimplifier, sharp, makeDracoModule } = tc
  tc.notes.clear()
  const notes = []
  const srcBuf = await fsp.readFile(job.srcPath)
  const src = { bytes: srcBuf.byteLength, sha256: sha256(srcBuf) }
  let h
  try { h = parseGlbHeader(new Uint8Array(srcBuf.buffer, srcBuf.byteOffset, srcBuf.byteLength)) } catch (e) { throw stageError('读 GLB 头', e) }
  const json = h.json
  const info = {
    generator: (json.asset && json.asset.generator) || null,
    draco: { used: (json.extensionsUsed || []).includes('KHR_draco_mesh_compression'), prims: 0, points: 0, ok: null },
    specGloss: (json.extensionsUsed || []).includes('KHR_materials_pbrSpecularGlossiness'),
    externalImages: 0, textures: 0, animations: (json.animations || []).length, cameras: (json.cameras || []).length, lights: 0
  }
  const bin0 = h.binOffset != null ? new Uint8Array(srcBuf.buffer, srcBuf.byteOffset + h.binOffset, h.binLength) : new Uint8Array(0)
  // ① Draco
  let bin = bin0
  if (info.draco.used) {
    const r = await dracoPredecode(json, bin0, makeDracoModule)
    info.draco.prims = r.prims; info.draco.points = r.points; info.draco.ok = r.failed.length === 0
    if (r.failed.length) {
      const e = new Error(`Draco 解码失败 ${r.failed.length}/${r.prims} 个图元：${r.failed.map((f) => `mesh${f.mesh}/prim${f.prim} ${f.error}`).join('；')}`)
      e.stage = 'Draco'
      e.draco = info.draco
      throw e
    }
    bin = r.bin
  }
  // ② 外部贴图占位
  const resources = { '@glb.bin': bin }
  const extUris = new Set()
  for (const im of json.images || []) {
    if (im.uri && !/^data:/i.test(im.uri) && im.bufferView == null) { extUris.add(im.uri); resources[im.uri] = Buffer.from(PNG_1PX, 'base64') }
  }
  info.externalImages = extUris.size
  let doc
  try { doc = await io.readJSON({ json, resources }) } catch (e) { throw stageError('NodeIO 读入', e) }
  const root = doc.getRoot()
  for (const tex of root.listTextures()) if (extUris.has(tex.getURI())) tex.dispose()
  if (extUris.size) notes.push(`外部贴图 ${extUris.size} 张随件缺失，已移除引用：${[...extUris].join('、')}`)
  // ③ SpecGloss → MetalRough
  if (info.specGloss) {
    try { await doc.transform(F.metalRough()) } catch (e) { throw stageError('metalRough', e) }
  }
  // ④ 相机 / 灯光
  for (const c of root.listCameras()) c.dispose()
  const lightsExt = root.listExtensionsUsed().find((x) => x.extensionName === 'KHR_lights_punctual')
  if (lightsExt) {
    for (const n of root.listNodes()) if (n.getExtension('KHR_lights_punctual')) { info.lights++; n.setExtension('KHR_lights_punctual', null) }
    lightsExt.dispose()
  }
  // 材质卫生（越界系数、缺 TEXCOORD）
  const san = sanitizeMaterials(doc, F.listTextureInfoByMaterial)
  if (san.clamped) notes.push(`材质系数越界 ${san.clamped} 处，已夹到 [0,1]`)
  if (san.texcoordsAdded) notes.push(`材质要贴图坐标而图元没有 ${san.texcoordsAdded} 处，已补全 0 的 TEXCOORD`)
  // 材质兜底（无材质图元 → 中性浅灰；整件退化黑 → 按名字还原）
  const fb = applyMaterialFallbacks(doc)
  info.materialFallback = fb
  if (fb.noMaterialPrims) notes.push(`${fb.noMaterialPrims} 个图元没有材质，已给中性浅灰（${NEUTRAL_MATERIAL_NAME}）`)
  if (fb.degenerate.fixed.length) notes.push(`退化黑材质覆盖 ${(fb.degenerate.share * 100).toFixed(0)} % 的三角形，按名字还原 ${fb.degenerate.fixed.length} 个：${fb.degenerate.fixed.join('、')}`)
  // ⑤ 包围盒（精确：已解压的顶点 × 世界矩阵）与居中
  const scene = sceneOf(doc)
  if (!scene) throw stageError('场景', new Error('glb 里没有场景'))
  const b0 = F.getBounds(scene)
  if (![...b0.min, ...b0.max].every(Number.isFinite)) throw stageError('包围盒', new Error('没有可见几何'))
  const center = [0, 1, 2].map((i) => (b0.min[i] + b0.max[i]) / 2)
  const bboxSize = [0, 1, 2].map((i) => b0.max[i] - b0.min[i])
  try { await doc.transform(F.center({ pivot: 'center' })) } catch (e) { throw stageError('center', e) }
  // ⑥ 清理
  try { await doc.transform(F.dedup(), F.prune({ keepExtras: true }), F.weld()) } catch (e) { throw stageError('dedup/prune/weld', e) }
  info.textures = root.listTextures().length
  // ⑦ 统计
  const stats = geometryStats(doc)
  // ⑧ 三档
  await fsp.mkdir(job.outDir, { recursive: true })
  const lods = {}
  for (const spec of LOD_SPECS) {
    const t1 = performance.now()
    let d = null
    let budget = null
    if (spec.ratio < 1) {
      // lod2 只作图标与未下载时的预览：给简化器加 Permissive（允许跨贴图坐标接缝塌缩）+ Prune（整块删掉小于误差的零碎部件）。
      // 不加时带贴图的 ISS (D) 被接缝卡在 114 万面 / 28 MB，MAVEN (A) 卡在 34 万面；加了两个都落到目标 0.1 附近（实测 0.094 / 0.099）。
      // gltf-transform 的 simplify 不透出这两个 flag，用一个只改 simplify 调用、其余成员原样继承的外壳传进去。
      // lod2 另有预算两道闸（零碎件剔除 + 三角形上限，simplifyToBudget）。
      const isL2 = spec.key === 'lod2'
      const flags = isL2 ? (Array.isArray(job.lod2Flags) ? job.lod2Flags : LOD2_FLAGS) : []
      const simplifier = flags.length ? withSimplifyFlags(MeshoptSimplifier, flags) : MeshoptSimplifier
      try {
        const r = await simplifyToBudget(doc, F, spec, {
          simplifier, raw: MeshoptSimplifier, flags, uvWeight: isL2 ? LOD2_UV_WEIGHT : 0,
          cullFrac: isL2 ? job.lod2CullFrac || 0 : 0, maxTris: isL2 ? job.lod2MaxTris || 0 : 0
        })
        d = r.doc
        budget = r.budget
      } catch (e) {
        notes.push(`${spec.key} 简化失败，按原精度出：${e.message}`)
        d = null
      }
    }
    if (!d) d = F.cloneDocument(doc)
    if (spec.key === 'lod2') {
      const anims = d.getRoot().listAnimations()
      if (anims.length) {
        for (const a of anims) a.dispose()
        await d.transform(F.prune({ keepExtras: true, keepLeaves: true }))
        budget = { ...(budget || { cull: null, cap: null }), animations: anims.length }
      }
    }
    if (d.getRoot().listTextures().length) {
      const tex = texLimitFor(spec, job)
      try { await d.transform(F.textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex] })) } catch (e) { notes.push(`${spec.key} 贴图压缩失败，保留原贴图：${e.message}`) }
    }
    const tris = countSceneTriangles(d)
    let glb
    try {
      await d.transform(F.meshopt({ encoder: MeshoptEncoder, level: job.meshoptLevel === 'medium' ? 'medium' : 'high', ...(spec.key === 'lod2' ? LOD2_QUANT : {}) }))
      glb = await io.writeBinary(d)
    } catch (e) { throw stageError(`${spec.key} meshopt/写出`, e) }
    const buf = Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength)
    await writeAtomic(path.join(job.outDir, `${spec.key}.glb`), buf)
    const hh = parseGlbHeader(new Uint8Array(glb.buffer, glb.byteOffset, glb.byteLength))
    lods[spec.key] = {
      bytes: buf.byteLength, sha256: sha256(buf), tris,
      extensionsRequired: hh.json.extensionsRequired || [], textures: (hh.json.textures || []).length, ms: Math.round(performance.now() - t1),
      ...(budget && (budget.cull || budget.cap || budget.animations) ? { budget } : {})
    }
  }
  for (const n of tc.notes) notes.push(n)
  return { src, bboxSize, center, stats, lods, info, notes, ms: Math.round(performance.now() - t0) }
}

// worker 入口（与主流程同一个文件）
if (!isMainThread && workerData && workerData.role === 'nasa3d-build') {
  const tc = await loadToolchain()
  parentPort.on('message', async (job) => {
    try {
      const result = await processModelFile(tc, job)
      parentPort.postMessage({ key: job.key, ok: true, result })
    } catch (e) {
      parentPort.postMessage({ key: job.key, ok: false, error: String((e && e.message) || e), stage: (e && e.stage) || null, draco: (e && e.draco) || null })
    }
  })
  parentPort.postMessage({ ready: true })
}

// ─────────────────────────────── 主流程 ───────────────────────────────

function loadJsonFile(file, what) {
  const j = readJson(file)
  if (!j || typeof j !== 'object') throw new Error(`${what} 读不出：${file}`)
  return j
}

/**
 * 收集要处理的文件：include-list 分组 × <srcDir>/<slug>/meta.json 的自有文件（借用他条目的直链不算）。
 * 另返回 missingGroups：缺省分组（include + optional）里本次没选的——非空即子集运行。
 */
function collectEntries({ groups, only, srcDir = NASA_DIR, includeFile }) {
  const inc = loadIncludeList(includeFile)
  const defaults = [...inc.include, ...inc.optional]
  const wanted = new Set(groups && groups.length ? groups : defaults)
  for (const g of wanted) if (!MODEL_GROUPS.includes(g)) throw new Error(`--groups 里的「${g}」不是七组之一（${MODEL_GROUPS.join(' / ')}）`)
  const missingGroups = defaults.filter((g) => !wanted.has(g))
  const entries = []
  const skipped = []
  for (const e of inc.entries) {
    if (!wanted.has(e.group)) continue
    const dir = path.join(srcDir, e.slug)
    const meta = readJson(path.join(dir, 'meta.json'))
    if (!meta) { skipped.push({ slug: e.slug, reason: '没有 meta.json（未下载）' }); continue }
    const own = (meta.files || []).map((f) => f.file).filter((f) => fs.existsSync(path.join(dir, f)))
    if (!own.length) {
      skipped.push({ slug: e.slug, reason: (meta.borrowed && meta.borrowed.length) ? `只有借用他条目的直链（${meta.borrowed.map((b) => b.owner).join('、')}）` : '没有已落盘的 glb' })
      continue
    }
    entries.push({ slug: e.slug, group: e.group, title: meta.title || e.title, page: meta.page || '', contributors: meta.contributors || [], files: own, modified: meta.modified || null })
  }
  if (only && only.length) {
    const known = new Set(entries.map((e) => e.slug))
    for (const s of only) if (!known.has(s)) throw new Error(`--only 里的「${s}」不在所选分组的已下载条目里`)
  }
  return { entries, skipped, missingGroups }
}

/**
 * 本次 manifest 是否只是子集（纯函数，单测覆盖）。返回原因列表，空 = 全量。
 *   missingGroups  缺省分组里本次没选的（--groups）
 *   notBuilt       不在本次处理范围、也没有可用旧产物的文件 id
 * 处理失败不算：见文件头「全量 vs 子集」。
 */
export function partialReasons({ missingGroups = [], notBuilt = [] } = {}) {
  const out = []
  if (missingGroups.length) out.push(`--groups 没选全（缺 ${missingGroups.join(' / ')}）`)
  if (notBuilt.length) out.push(`${notBuilt.length} 个文件不在本次处理范围、也没有可用旧产物（--only 之外且换了处理选项，或全新 --out）`)
  return out
}

/** 体积目标按十进制 MB 判（200 MB = 2×10⁸ 字节）；lib.mjs 的 fmtBytes 是 1024 进位，另附 MiB 对账。 */
const fmtMB = (n) => `${(n / 1e6).toFixed(2)} MB（${(n / MiB).toFixed(2)} MiB）`
const mb2 = (n) => (n / 1e6).toFixed(2)

/**
 * 一个 GLB 的体积构成（REPORT「lod2 构成」用；纯函数）：
 *   json      JSON 块（节点 / 访问器 / 材质表……JWST 这类上千节点的件，这块能到几百 KB）
 *   images    被 images[].bufferView 引用的字节（WebP 贴图本体）
 *   geometry  BIN 块其余部分（meshopt 压缩后的顶点 / 索引 + 对齐填充）
 *   total     文件总长；json + bin + 20/28 字节块头 = total
 * 不是 GLB 抛错。
 */
export function glbComposition(u8) {
  const h = parseGlbHeader(u8)
  const bin = h.binLength || 0
  const views = Array.isArray(h.json.bufferViews) ? h.json.bufferViews : []
  let images = 0
  const seen = new Set()
  for (const im of Array.isArray(h.json.images) ? h.json.images : []) {
    const v = im && Number.isInteger(im.bufferView) ? im.bufferView : -1
    if (v < 0 || seen.has(v) || !views[v]) continue
    seen.add(v)
    images += views[v].byteLength || 0
  }
  images = Math.min(images, bin)
  return { total: u8.byteLength, json: h.jsonLength, bin, images, geometry: bin - images }
}

/**
 * 处理选项 → 对照表的一格名字（「high · lod2 贴图 256 px · lod2 ≤ 5 万面 · 剔除 < 0.6 %」；Prune/Permissive 关掉时注明 strict）。
 * 老 build.json 没有的键按当时的口径：lod2MaxTex 缺 = 512；lod2MaxTris / lod2CullFrac 缺 = 不设（不出现在名字里）。
 */
export function optsLabel(o = {}) {
  const tex = LOD2_TEX_CHOICES.includes(o.lod2MaxTex) ? o.lod2MaxTex : 512
  const parts = [o.meshoptLevel || 'medium', `lod2 贴图 ${tex} px`]
  if (o.lod2MaxTris > 0) parts.push(`lod2 ≤ ${+(o.lod2MaxTris / 1e4).toFixed(2)} 万面`)
  if (o.lod2CullFrac > 0) parts.push(`剔除 < ${+(o.lod2CullFrac * 100).toFixed(2)} %`)
  if (Array.isArray(o.lod2Flags) && !o.lod2Flags.length) parts.push('lod2 strict')
  return parts.join(' · ')
}

/**
 * history.json 的更新（纯函数）：每种处理选项只留最近一次全量运行的总量；按时间排序。
 * entry = { at, buildId, opts, files, failed, lod0, lod1, lod2 }（字节）。子集运行不进来（调用方把关）。
 */
export function updateHistory(history, entry) {
  const key = (e) => JSON.stringify(e.opts || null)
  const list = (Array.isArray(history) ? history : []).filter((e) => e && typeof e === 'object' && key(e) !== key(entry))
  list.push(entry)
  return list.sort((a, b) => cmp(String(a.at || ''), String(b.at || '')))
}

async function verifyCache(outDir, srcSha, opts) {
  const b = readJson(path.join(outDir, 'build.json'))
  if (!b || b.pipelineVersion !== PIPELINE_VERSION || !b.worker || !b.worker.src || b.worker.src.sha256 !== srcSha) return null
  if (JSON.stringify(b.opts || null) !== JSON.stringify(opts)) return null   // 处理选项变了（--level / --lod2-strict）也要重做
  for (const spec of LOD_SPECS) {
    const f = b.worker.lods && b.worker.lods[spec.key]
    const p = path.join(outDir, `${spec.key}.glb`)
    if (!f || !fs.existsSync(p)) return null
    const buf = await fsp.readFile(p)
    if (buf.byteLength !== f.bytes || sha256(buf) !== f.sha256) return null
  }
  return b
}

function runPool(jobs, concurrency, onDone) {
  return new Promise((resolve) => {
    const queue = jobs.slice()
    const results = new Map()
    let active = 0
    let startupFailures = 0
    const fail = (job, error, stage) => { const m = { key: job.key, ok: false, error, stage }; results.set(job.key, m); onDone(job, m) }
    const spawn = () => {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { role: 'nasa3d-build' } })
      let cur = null
      let ready = false
      const next = () => {
        cur = queue.shift() || null
        if (!cur) { w.terminate(); return }
        w.postMessage(cur)
      }
      w.on('message', (m) => {
        if (m.ready) { ready = true; startupFailures = 0; next(); return }
        results.set(m.key, m)
        onDone(cur, m)
        next()
      })
      w.on('error', (e) => {
        // wasm abort 之类没接住的异常：这个 worker 死掉，当前文件记失败，换一个新 worker 接着跑
        if (cur) fail(cur, `worker 崩溃：${e.message}`, 'worker')
        cur = null
        if (!ready && ++startupFailures >= 3) {
          // 工具链本身加载不了（依赖没装 / 原生库坏了）：再开 worker 也是一样，剩下的全部记失败，别死循环
          for (const j of queue.splice(0)) fail(j, `工具链加载失败：${e.message}`, '工具链加载')
        }
      })
      w.on('exit', () => {
        active--
        if (queue.length) { active++; spawn() } else if (active === 0) resolve(results)
      })
    }
    const n = Math.max(1, Math.min(concurrency, jobs.length))
    if (!jobs.length) { resolve(results); return }
    active = n
    for (let i = 0; i < n; i++) spawn()
  })
}

async function loadCoreModels() {
  const out = { schema: null, manifest: null }
  try { out.schema = await import(SCHEMA_URL) } catch { /* W1 还没写好：用本文件的兜底口径 */ }
  try { out.manifest = await import(MANIFEST_URL) } catch { /* 同上 */ }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    only: 'list', groups: 'list', concurrency: 'int', force: 'bool', out: 'string', level: 'string', 'lod2-tex': 'string', 'lod2-strict': 'bool',
    'lod2-max-tris': 'string', 'lod2-cull': 'string', 'src-dir': 'string', 'include-list': 'string', 'known-dims': 'string', 'frame-overrides': 'string', 'review-dir': 'string', help: 'bool'
  })
  if (args.help) {
    console.log('用法：node scripts/nasa3d/build.mjs [--only=slug,…] [--groups=spacecraft,…] [--concurrency=N] [--force] [--out=目录] [--level=high|medium] [--lod2-tex=256] [--lod2-max-tris=50000] [--lod2-cull=0.006] [--lod2-strict]')
    console.log(`  --level        meshopt 档位（缺省 ${DEFAULT_LEVEL}：法线 / 切线走 8 位八面体滤波，更小；medium 为 DESIGN §8 原口径，只作对照）`)
    console.log(`  --lod2-tex     lod2 贴图边长上限（缺省 ${DEFAULT_LOD2_TEX}；可选 ${LOD2_TEX_CHOICES.join(' / ')}）`)
    console.log(`  --lod2-max-tris lod2 三角形上限（缺省 ${DEFAULT_LOD2_MAX_TRIS}；0 = 不设）`)
    console.log(`  --lod2-cull    lod2 剔除包围半径 < 该比例 × 整件半径的零碎网格（缺省 ${DEFAULT_LOD2_CULL}；0 = 不剔）`)
    console.log('  --lod2-strict  lod2 与 lod1 同法简化（不加 Prune / Permissive）')
    console.log('  --src-dir / --include-list / --known-dims / --frame-overrides  换输入（缺省 .models-src/nasa、scripts/nasa3d 下的同名文件）')
    console.log('  --review-dir   nasa3d:sheets 的记账目录（缺省 build/review；缩略图按其中 sheets.json 核对后才认领）')
    console.log('  子集运行（--groups 没选全 / 有文件既没处理也没旧产物）只写 manifest.partial.json，不覆盖 manifest.json')
    return 0
  }
  const T0 = Date.now()
  const outRoot = args.out ? path.resolve(args.out) : BUILD_ROOT
  const srcDir = args.srcDir ? path.resolve(args.srcDir) : NASA_DIR
  const knownDims = loadJsonFile(args.knownDims ? path.resolve(args.knownDims) : KNOWN_DIMS_FILE, 'known-dims.json')
  // 本体朝向覆盖表（逐件核过的 q；没进表的 NASA 件取 +Y 天顶缺省、verified=false）。表里有坏条目：那几条不收、REPORT 列出、退出码 1
  const frameOv = parseFrameOverrides(loadJsonFile(args.frameOverrides ? path.resolve(args.frameOverrides) : FRAME_OVERRIDES_FILE, 'frame-overrides.json'))
  const kindOverrides = loadJsonFile(KIND_OVERRIDES_FILE, 'kind-overrides.json')
  const titlesZh = loadJsonFile(TITLES_ZH_FILE, 'titles-zh.json')
  const core = await loadCoreModels()
  const { entries, skipped, missingGroups } = collectEntries({ groups: args.groups, only: args.only, srcDir, includeFile: args.includeList ? path.resolve(args.includeList) : undefined })
  const onlySet = args.only && args.only.length ? new Set(args.only) : null
  // 影响产物字节的处理选项：进 job、进 build.json、参与缓存比对
  const procOpts = resolveProcOpts({ level: args.level, lod2Tex: args.lod2Tex, lod2Strict: args.lod2Strict, lod2MaxTris: args.lod2MaxTris, lod2Cull: args.lod2Cull })

  // 展开成文件级任务；缓存命中的不进队
  const items = []
  for (const e of entries) {
    const list = modelIdsForEntry(e.slug, e.files)
    for (const it of list) {
      const srcPath = path.join(srcDir, e.slug, it.file)
      items.push({ ...it, slug: e.slug, entry: e, multi: list.length > 1, srcPath, outDir: path.join(outRoot, it.dir), srcBytes: fs.statSync(srcPath).size })
    }
  }
  const jobs = []
  const cached = new Map()
  for (const it of items) {
    if (onlySet && !onlySet.has(it.slug)) {
      const c = readJson(path.join(it.outDir, 'build.json'))
      if (c && c.pipelineVersion === PIPELINE_VERSION && c.worker && JSON.stringify(c.opts || null) === JSON.stringify(procOpts)) cached.set(it.id, c)
      continue
    }
    if (!args.force) {
      const srcSha = sha256(await fsp.readFile(it.srcPath))
      const c = await verifyCache(it.outDir, srcSha, procOpts)
      if (c) { cached.set(it.id, c); continue }
    }
    jobs.push({ key: it.id, srcPath: it.srcPath, outDir: it.outDir, bytes: it.srcBytes, ...procOpts })
  }
  jobs.sort((a, b) => b.bytes - a.bytes)   // 大件先跑，尾巴短
  const conc = args.concurrency || Math.max(1, Math.min(6, os.cpus().length - 2))
  console.log(`NASA 3D build：${entries.length} 条、${items.length} 个文件；缓存命中 ${cached.size}，待处理 ${jobs.length}（${fmtBytes(jobs.reduce((s, j) => s + j.bytes, 0))}）· worker ${conc} · 输出 ${path.relative(REPO_ROOT, outRoot) || outRoot}`)
  if (!core.schema) console.log('⚠ packages/core/models/schema.mjs 加载不了：meta 用本脚本的兜底口径组装，不做 validateMeta')
  if (!core.manifest) console.log('⚠ packages/core/models/manifest.mjs 还不存在：manifest 只做字段形状自检（checkManifestShape）')

  // sharp 先在主线程加载一次再开 worker（Windows 上 sharp 的原生库在多个线程里首次加载可能失败）
  await import('sharp')
  let done = 0
  const t1 = Date.now()
  const results = await runPool(jobs, conc, (job, m) => {
    done++
    const tag = m.ok ? `✓ ${fmtSec(m.result.ms)}` : `✗ ${m.stage || ''} ${m.error.slice(0, 160)}`
    console.log(`  [${String(done).padStart(3)}/${jobs.length}] ${job.key.padEnd(60).slice(0, 60)} ${fmtBytes(job.bytes).padStart(10)}  ${tag}`)
  })
  const workMs = Date.now() - t1

  // 缩略图记账（nasa3d:sheets 的 sheets.json）：认领 thumb.webp 前逐条核对（checkThumbRecord），对不上的当没有
  const reviewDir = args.reviewDir ? path.resolve(args.reviewDir) : REVIEW_ROOT
  const sheetsState = readJson(path.join(reviewDir, 'sheets.json'), null)
  const sheetsRecipe = recipeHash(REPO_ROOT, RECIPE_FILES)

  // 组装 meta / build.json / manifest
  const nowIso = new Date().toISOString()
  const metas = []
  const failures = []
  const notBuilt = []
  const rows = []
  const inheritedByEntry = new Map()
  // 先处理每个条目里 known-dims 指定的那个文件（inherit 要用它的结果）
  const ordered = items.slice().sort((a, b) => {
    const kd = knownDims[a.slug]
    const pa = kd && kd.file ? (a.file === kd.file ? 0 : 1) : (a.primary ? 0 : 1)
    const kb = knownDims[b.slug]
    const pb = kb && kb.file ? (b.file === kb.file ? 0 : 1) : (b.primary ? 0 : 1)
    return cmp(a.slug, b.slug) || pa - pb || a.n - b.n
  })
  for (const it of ordered) {
    const r = results.get(it.id)
    let w = null
    if (r && r.ok) w = r.result
    else if (r && !r.ok) { failures.push({ id: it.id, file: `${it.slug}/${it.file}`, stage: r.stage, error: r.error, draco: r.draco }); continue }
    else if (cached.has(it.id)) w = cached.get(it.id).worker
    else { notBuilt.push(it.id); continue }   // --only 之外、以前也没出过件：不算失败，manifest 里没有它
    const kd = knownDims[it.slug] && !String(it.slug).startsWith('$') ? knownDims[it.slug] : null
    const u = resolveUnits(kd, w.bboxSize, { file: it.file, primary: it.primary, inherited: inheritedByEntry.get(it.slug) || null })
    if (kd && u.fit && (kd.file ? it.file === kd.file : it.primary)) inheritedByEntry.set(it.slug, { ok: true, scaleToMeters: u.units.scaleToMeters, unitGuess: u.units.unitGuess, sizeVerified: true, sizeSource: u.units.sizeSource, fit: u.fit })
    const kind = resolveKind(it.slug, it.entry.title, it.entry.group, kindOverrides)
    const titleZh = resolveTitleZh(it.slug, it.file, { primary: it.primary, multi: it.multi }, titlesZh)
    const fr = resolveFrame(it.id, frameOv)
    // 缩略图由 nasa3d:sheets 写到模型目录的 thumb.webp；这里核对后认领（重跑 build 走缓存，两秒把它并进 meta 与 manifest）。
    // 核对 = sheets.json 里这一条的内容键（lod 文件 sha + frame + 单位 + 取景口径）按【当前】meta 重算对得上、thumbSha 与文件一致；
    // 对不上（改了 known-dims / 原件换了版本 / build 之后没重跑 sheets）当作没有缩略图，REPORT 列出原因——过期的图不进 manifest。
    const thumbPath = path.join(it.outDir, 'thumb.webp')
    let thumb = null
    let thumbCheck = { ok: false, reason: '没有 thumb.webp', recipeStale: false }
    if (fs.existsSync(thumbPath)) {
      const tb = await fsp.readFile(thumbPath)
      const cand = { sha256: sha256(tb), bytes: tb.byteLength }
      let probe = composeMeta({ id: it.id, slug: it.slug, entry: it.entry, file: it.file, multi: it.multi, primary: it.primary, w, units: u.units, kind: kind.kind, titleZh, updatedAt: null, frame: fr.frame })
      if (core.schema) probe = core.schema.normalizeMeta(probe)
      thumbCheck = checkThumbRecord(sheetsState && sheetsState.entries ? sheetsState.entries[it.id] : null, probe, cand.sha256, sheetsRecipe)
      if (thumbCheck.ok) thumb = cand
    }
    // updatedAt 只在文件（三档 + 缩略图）真变了时刷新：重跑 build 不该让 manifest 无谓地变（buildId 由内容决定）
    const prev = readJson(path.join(it.outDir, 'meta.json'))
    const sameFiles = prev && prev.files && LOD_SPECS.every((s) => prev.files[s.key] && prev.files[s.key].sha256 === w.lods[s.key].sha256) &&
      ((prev.files.thumb && prev.files.thumb.sha256) || null) === (thumb && thumb.sha256)
    let meta = composeMeta({ id: it.id, slug: it.slug, entry: it.entry, file: it.file, multi: it.multi, primary: it.primary, w, units: u.units, kind: kind.kind, titleZh, updatedAt: sameFiles && prev.updatedAt ? prev.updatedAt : nowIso, thumb, frame: fr.frame })
    if (core.schema) {
      const norm = core.schema.normalizeMeta(meta)
      const v = core.schema.validateMeta(norm)
      if (!v.ok) { failures.push({ id: it.id, file: `${it.slug}/${it.file}`, stage: 'validateMeta', error: v.errors.join('；') }); continue }
      meta = norm
    }
    await writeJsonAtomic(path.join(it.outDir, 'meta.json'), meta)
    const buildInfo = {
      pipelineVersion: PIPELINE_VERSION, opts: procOpts, id: it.id, slug: it.slug, file: it.file, sourcePath: path.relative(REPO_ROOT, it.srcPath).replace(/\\/g, '/'),
      builtAt: r && r.ok ? nowIso : (cached.get(it.id) && cached.get(it.id).builtAt) || nowIso,
      centerOffset: w.center.map((v) => -v), units: u.units, fit: u.fit, fitRejected: u.reject, kindFrom: kind.how, frameFrom: fr.how, worker: w
    }
    await writeJsonAtomic(path.join(it.outDir, 'build.json'), buildInfo)
    metas.push(meta)
    rows.push({ it, meta, w, u, kind, titleZh, fresh: !!(r && r.ok), thumbCheck, fr })
  }

  const slim = metas.map((m) => (core.schema && core.schema.slimMeta ? core.schema.slimMeta(m) : slimMetaLocal(m)))
  const reasons = partialReasons({ missingGroups, notBuilt })
  const partial = reasons.length > 0
  const manifestName = partial ? 'manifest.partial.json' : 'manifest.json'
  let manifest = buildManifest(slim, { generatedAt: nowIso })
  // 同一 buildId（内容没变）沿用上次的 generatedAt：重跑得到逐字节相同的 manifest，
  // 云端 manifest.<buildId>.json 这份 immutable 快照也就不会被同名不同字节地重传一遍
  const prevManifest = readJson(path.join(outRoot, manifestName))
  if (prevManifest && prevManifest.buildId === manifest.buildId && Number.isFinite(Date.parse(prevManifest.generatedAt))) manifest.generatedAt = prevManifest.generatedAt
  if (partial) manifest = { schema: manifest.schema, buildId: manifest.buildId, generatedAt: manifest.generatedAt, partial: true, partialReasons: reasons, models: manifest.models }
  const shape = checkManifestShape(manifest)
  let coreCheck = null
  if (core.manifest && typeof core.manifest.validateManifest === 'function') {
    try { coreCheck = core.manifest.validateManifest(manifest, { remote: true }) } catch (e) { coreCheck = { ok: false, errors: [`validateManifest 抛错：${e.message}`] } }
    // W1 的口径：整份结构对就 ok=true，坏条目丢弃并记进 errors——对发布来说丢条目同样是问题，所以三条都得满足才算干净
    coreCheck.clean = coreCheck.ok && !(coreCheck.errors || []).length && (coreCheck.models || []).length === manifest.models.length
  }
  await writeJsonAtomic(path.join(outRoot, manifestName), manifest)
  // 全量写成功后，上次子集运行留下的 partial 文件作废（留着只会让人以为还有一份待处理的目录）
  if (!partial) await fsp.rm(path.join(outRoot, 'manifest.partial.json'), { force: true })

  // 统计与报告
  const sum = (k) => rows.reduce((s, r) => s + r.w.lods[k].bytes, 0)
  const maxOf = (k) => rows.reduce((b, r) => (!b || r.w.lods[k].bytes > b.bytes ? { id: r.it.id, bytes: r.w.lods[k].bytes } : b), null)
  const dracoFiles = rows.filter((r) => r.w.info.draco.used).length + failures.filter((f) => f.draco && f.draco.used).length
  const dracoOk = rows.filter((r) => r.w.info.draco.used && r.w.info.draco.ok).length
  const dracoFail = failures.filter((f) => f.stage === 'Draco')
  const specGloss = rows.filter((r) => r.w.info.specGloss)
  const unverified = rows.filter((r) => !r.meta.units.sizeVerified)
  const verified = rows.filter((r) => r.meta.units.sizeVerified)
  const fitRejected = rows.filter((r) => r.u.reject)
  const noZh = rows.filter((r) => !r.titleZh)
  const kindByKeyword = rows.filter((r) => r.kind.how === 'keyword')
  const frameVerified = rows.filter((r) => r.fr.how === 'override')
  // 覆盖表里有、本次目录里没有的 id（改名 / 下架 / 写错）：只在全量运行时有意义（子集运行本来就没覆盖全）
  const allIds = new Set(items.map((it) => it.id))
  const frameStale = [...frameOv.entries.keys(), ...frameOv.skipped.keys()].filter((id) => !allIds.has(id))
  const totalMs = Date.now() - T0
  const summary = {
    entries: new Set(rows.map((r) => r.it.slug)).size, files: rows.length, failed: failures.length,
    dracoFiles, dracoOk, lod0: sum('lod0'), lod1: sum('lod1'), lod2: sum('lod2'),
    max: { lod0: maxOf('lod0'), lod1: maxOf('lod1'), lod2: maxOf('lod2') },
    srcBytes: rows.reduce((s, r) => s + r.w.src.bytes, 0), totalMs, workMs, verified: verified.length
  }

  // 处理档对照：全量运行才记（子集的总量不可比）。每种处理选项只留最近一次
  const histFile = path.join(outRoot, 'history.json')
  let history = readJson(histFile, [])
  if (!partial) {
    history = updateHistory(history, { at: nowIso, buildId: manifest.buildId, opts: procOpts, files: rows.length, failed: failures.length, lod0: summary.lod0, lod1: summary.lod1, lod2: summary.lod2 })
    await writeJsonAtomic(histFile, history)
  }
  // lod2 构成（目标 ≤ 30 MB 达不到时看钱花在哪：JSON 块 / 贴图 / 几何）
  const comp = []
  for (const r of rows) {
    try { comp.push({ id: r.it.id, ...glbComposition(new Uint8Array(await fsp.readFile(path.join(r.it.outDir, 'lod2.glb')))), tris: r.w.lods.lod2.tris, textures: r.w.lods.lod2.textures }) } catch { /* 文件读不了的已在缓存校验里拦过 */ }
  }
  const compSum = comp.reduce((s, c) => ({ json: s.json + c.json, images: s.images + c.images, geometry: s.geometry + c.geometry, total: s.total + c.total }), { json: 0, images: 0, geometry: 0, total: 0 })
  // 缩略图（nasa3d:sheets 的记账 sheets.json）：自渲染 / 退回官方缩图 / 缺 / 过期（核对没过）/ 画面质检标记
  const thumbRows = rows.map((r) => {
    const s = sheetsState && sheetsState.entries ? sheetsState.entries[r.it.id] : null
    return {
      id: r.it.id, has: !!(r.meta.files && r.meta.files.thumb), source: s && s.thumbSha ? s.source : null, error: s ? (s.renderError || s.error || '') : '',
      zoom: s && s.zoom, qa: s && s.qa, check: r.thumbCheck || null
    }
  })
  // lod2 预算落在哪些件上（剔零碎件 / 降面 / 删动画）；材质兜底落在哪些件上
  const budgetRows = rows.filter((r) => r.w.lods.lod2.budget).map((r) => ({ id: r.it.id, b: r.w.lods.lod2.budget, tris0: r.w.lods.lod0.tris, tris2: r.w.lods.lod2.tris }))
  const fbRows = rows.filter((r) => r.w.info.materialFallback && (r.w.info.materialFallback.noMaterialPrims || r.w.info.materialFallback.degenerate.fixed.length))

  const report = []
  report.push('# NASA 3D build 报告', '')
  report.push(`生成 ${nowIso} · buildId \`${manifest.buildId}\` · 管线版本 ${PIPELINE_VERSION} · 处理档 ${optsLabel(procOpts)} · 耗时 ${fmtSec(totalMs)}（处理 ${jobs.length} 个文件用 ${fmtSec(workMs)}，缓存命中 ${cached.size}）`, '')
  if (partial) report.push(`**子集运行**：只写了 \`manifest.partial.json\`，\`manifest.json\` 未改动（${reasons.join('；')}）。`, '')
  report.push('体积单位：下表与逐文件表的 KB / MB 为 1024 进位（即 KiB / MiB）；两项体积目标按十进制 MB 判，另附 MiB。', '')
  report.push('## 总量', '')
  report.push(mdTable(['项', '数值'], [
    ['条目（有产物）', summary.entries], ['文件（有产物）', summary.files], ['失败', failures.length], ['跳过的条目', skipped.length],
    ...(notBuilt.length ? [['未构建（不在本次范围且无旧产物）', notBuilt.length]] : []),
    ['manifest', partial ? `manifest.partial.json（子集，${manifest.models.length} 条）` : `manifest.json（全量，${manifest.models.length} 条）`],
    ['原件总量', fmtBytes(summary.srcBytes)],
    ['Draco 文件 / 解码成功', `${dracoFiles} / ${dracoOk}`],
    ['SpecGloss 转换', specGloss.length],
    ['lod0 总量（目标 ≤ 200 MB）', fmtMB(summary.lod0)], ['lod1 总量', fmtMB(summary.lod1)], ['lod2 总量（目标 ≤ 30 MB）', fmtMB(summary.lod2)],
    ['最大 lod0', summary.max.lod0 ? `${summary.max.lod0.id} ${fmtMB(summary.max.lod0.bytes)}` : '—'],
    ['最大 lod1', summary.max.lod1 ? `${summary.max.lod1.id} ${fmtMB(summary.max.lod1.bytes)}` : '—'],
    ['最大 lod2', summary.max.lod2 ? `${summary.max.lod2.id} ${fmtMB(summary.max.lod2.bytes)}` : '—'],
    ['尺寸已核（known-dims）', `${verified.length} 个文件`], ['尺寸未核', `${unverified.length} 个文件`],
    ['manifest 字段自检', shape.ok ? '通过' : `${shape.errors.length} 处问题`],
    ['manifest.mjs validateManifest', coreCheck ? (coreCheck.clean ? `通过（${(coreCheck.models || []).length} 条）` : `${(coreCheck.errors || []).length} 处问题`) : '模块未就绪，未跑']
  ], ['l', 'r']), '')
  if (history.length) {
    report.push('## 处理档对照', '')
    report.push('同一语料、不同处理选项各自最近一次全量运行的总量（十进制 MB；目标 lod0 ≤ 200、lod2 ≤ 30）。本次为加粗行。', '')
    report.push(mdTable(['处理档', '时间', 'buildId', '文件 / 失败', 'lod0 MB', 'lod1 MB', 'lod2 MB'], history.map((h) => {
      const cur = !partial && JSON.stringify(h.opts) === JSON.stringify(procOpts)
      const b = (s) => (cur ? `**${s}**` : s)
      return [b(optsLabel(h.opts)), h.at, `\`${h.buildId}\``, `${h.files} / ${h.failed}`, b(mb2(h.lod0)), b(mb2(h.lod1)), b(mb2(h.lod2))]
    }), ['l', 'l', 'l', 'r', 'r', 'r', 'r']), '')
  }
  if (comp.length) {
    report.push('## lod2 构成', '')
    report.push(mdTable(['项', 'MB', '占比'], [
      ['JSON 块（节点 / 访问器 / 材质表）', mb2(compSum.json), `${(compSum.json / compSum.total * 100).toFixed(1)} %`],
      ['贴图（WebP）', mb2(compSum.images), `${(compSum.images / compSum.total * 100).toFixed(1)} %`],
      ['几何（meshopt 压缩后 + 对齐）', mb2(compSum.geometry), `${(compSum.geometry / compSum.total * 100).toFixed(1)} %`],
      ['合计（含块头）', mb2(compSum.total), '100 %']
    ], ['l', 'r', 'r']), '')
    if (budgetRows.length) {
      const capped = budgetRows.filter((x) => x.b.cap), culled = budgetRows.filter((x) => x.b.cull), anim = budgetRows.filter((x) => x.b.animations)
      report.push(`lod2 预算（${optsLabel(procOpts)}；位置 ${LOD2_QUANT.quantizePosition} 位 / 贴图坐标 ${LOD2_QUANT.quantizeTexcoord} 位量化，删 glTF 动画）：` +
        `降面 ${capped.length} 件 · 剔零碎件 ${culled.length} 件（${fmtInt(culled.reduce((a, x) => a + x.b.cull.meshes, 0))} 个网格、${fmtInt(culled.reduce((a, x) => a + x.b.cull.tris, 0))} 个三角形）· 删动画 ${anim.length} 件（${fmtInt(anim.reduce((a, x) => a + x.b.animations, 0))} 条）。`, '')
      if (capped.length) {
        report.push(mdTable(['id', 'lod0 三角形', '按 0.1 简化后', '降面后', 'ratio', 'error', '剔零碎件（网格 / 三角形）'], capped.map((x) => [
          x.id, fmtInt(x.tris0), fmtInt(x.b.cap.before), fmtInt(x.b.cap.after), x.b.cap.ratio, x.b.cap.error, x.b.cull ? `${x.b.cull.meshes} / ${fmtInt(x.b.cull.tris)}` : '—'
        ]), ['l', 'r', 'r', 'r', 'r', 'r', 'r']), '')
      }
    }
    report.push('lod2 最大的 15 个文件：', '')
    report.push(mdTable(['id', '总 KB', 'JSON KB', '贴图 KB', '几何 KB', '三角形', '贴图数'], comp.slice().sort((a, b) => b.total - a.total).slice(0, 15).map((c) => [
      c.id, (c.total / 1e3).toFixed(0), (c.json / 1e3).toFixed(0), (c.images / 1e3).toFixed(0), (c.geometry / 1e3).toFixed(0), fmtInt(c.tris), c.textures
    ]), ['l', 'r', 'r', 'r', 'r', 'r', 'r']), '')
  }
  {
    const has = thumbRows.filter((t) => t.has)
    const official = thumbRows.filter((t) => t.has && t.source === 'official')
    const missing = thumbRows.filter((t) => !t.has)
    const zoomed = thumbRows.filter((t) => t.has && t.zoom > 1.02)
    const recipeStale = thumbRows.filter((t) => t.has && t.check && t.check.recipeStale)
    const sum = summarizeSheets(sheetsState)
    const flaggedHere = (f) => thumbRows.filter((t) => t.has && t.qa && Array.isArray(t.qa.flags) && t.qa.flags.includes(f))
    report.push('## 缩略图（nasa3d:sheets）', '')
    report.push('朝向与第一眼视角 = thumbs.renderThumb 缺省（view.js 显示系 + autoViewFor），与工作台预览、应用内重拍同一张脸；本体只剩一小块的件按稳健取景重画那一块（setViewOffset，不放大像素）。', '')
    report.push(mdTable(['项', '数值'], [
      ['有缩略图（files.thumb，核对通过）', `${has.length} / ${thumbRows.length}`],
      ['自渲染（512 px WebP）', has.length - official.length],
      ['退回 NASA 官方缩图', official.length],
      ['缺 / 过期（没认领）', missing.length],
      ['出图配方已变（画法旧了，缩略图仍对：下次 sheets 重出）', recipeStale.length],
      ['稳健取景重画：放大 > 1× / ≥ 3× / 最大', `${zoomed.length} / ${zoomed.filter((t) => t.zoom >= 3).length} / ×${zoomed.reduce((m, t) => Math.max(m, t.zoom), 1).toFixed(2)}`],
      ['画面质检：过小 / 过暗 / 发白无明暗', `${flaggedHere('tiny').length} / ${flaggedHere('dark').length} / ${flaggedHere('flat').length}`],
      ['sheets.json 记账', `${sum.total} 条（含模板 ${sum.templates}）`]
    ], ['l', 'r']), '')
    for (const [f, what] of [['tiny', '过小（不透明像素 < 3 %）'], ['dark', '过暗（亮度均值 < 0.1）'], ['flat', '发白无明暗（亮度均值 > 0.7 且标准差 < 0.05）']]) {
      const list = flaggedHere(f)
      if (list.length) report.push(`质检${what}：`, '', mdTable(['id', '占画面', '亮度均值', '亮度标准差', '取景放大'], list.map((t) => [t.id, t.qa.coverage, t.qa.meanL, t.qa.stdL, t.zoom ? `×${(+t.zoom).toFixed(2)}` : '—']), ['l', 'r', 'r', 'r', 'r']), '')
    }
    if (zoomed.length) report.push('稳健取景重画的条目（放大倍数从大到小，前 30）：', '', mdTable(['id', '放大', '占画面'], zoomed.slice().sort((a, b) => b.zoom - a.zoom).slice(0, 30).map((t) => [t.id, `×${(+t.zoom).toFixed(2)}`, t.qa ? t.qa.coverage : '—']), ['l', 'r', 'r']), '')
    if (official.length) report.push('退回官方缩图的条目：', '', mdTable(['id', '出图失败原因'], official.map((t) => [t.id, t.error || '—']), ['l', 'l']), '')
    if (missing.length) report.push('缺缩略图或核对没过的条目（先跑 npm run nasa3d:sheets，再跑一次 build）：', '', mdTable(['id', '原因'], missing.map((t) => [t.id, (t.check && t.check.reason) || t.error || '—']), ['l', 'l']), '')
  }
  if (fbRows.length) {
    report.push('## 材质兜底', '')
    report.push(`无材质图元 → 中性浅灰（${NEUTRAL_MATERIAL_NAME}）；整件退化黑（baseColor = 0 且 specularFactor = 0 的材质覆盖 > ${DEGENERATE_SHARE * 100} % 三角形）→ 按材质名还原。`, '')
    report.push(mdTable(['id', '无材质图元', '退化黑占比', '按名字还原的材质'], fbRows.map((r) => {
      const f = r.w.info.materialFallback
      return [r.it.id, f.noMaterialPrims || '—', f.degenerate.share ? `${(f.degenerate.share * 100).toFixed(0)} %` : '—', f.degenerate.fixed.join('、') || '—']
    }), ['l', 'r', 'r', 'l']), '')
  }
  const byGroup = {}
  for (const r of rows) {
    const g = byGroup[r.it.entry.group] || (byGroup[r.it.entry.group] = { n: 0, src: 0, l0: 0, l1: 0, l2: 0, tris: 0 })
    g.n++; g.src += r.w.src.bytes; g.l0 += r.w.lods.lod0.bytes; g.l1 += r.w.lods.lod1.bytes; g.l2 += r.w.lods.lod2.bytes; g.tris += r.w.lods.lod0.tris
  }
  report.push('## 分组', '')
  report.push(mdTable(['分组', '文件', '原件', 'lod0', 'lod1', 'lod2', '三角形（lod0）'], MODEL_GROUPS.filter((g) => byGroup[g]).map((g) => [g, byGroup[g].n, fmtBytes(byGroup[g].src), fmtBytes(byGroup[g].l0), fmtBytes(byGroup[g].l1), fmtBytes(byGroup[g].l2), fmtInt(byGroup[g].tris)])), '')
  report.push('## 失败清单', '')
  report.push(failures.length ? mdTable(['id', '文件', '阶段', '原因'], failures.map((f) => [f.id, f.file, f.stage || '', f.error]), ['l', 'l', 'l', 'l']) : '无。', '')
  report.push('## Draco 解码失败清单', '')
  report.push(dracoFail.length ? mdTable(['id', '原因'], dracoFail.map((f) => [f.id, f.error]), ['l', 'l']) : `无（${dracoOk} 个 Draco 文件全部解开）。`, '')
  report.push('## SpecGloss 转换清单', '')
  report.push(specGloss.length ? specGloss.map((r) => `- ${r.it.id}`).join('\n') : '无（语料里没有 KHR_materials_pbrSpecularGlossiness）。', '')
  report.push('## 跳过的条目', '')
  report.push(skipped.length ? mdTable(['slug', '原因'], skipped.map((s) => [s.slug, s.reason]), ['l', 'l']) : '无。', '')
  report.push('## 尺寸已核（known-dims）', '')
  report.push('原始比值 = 官方值 ÷ 对应模型尺寸；离 m / cm / mm / in / ft 相对误差 ≤ 10 % 时吸附到该单位（与 units.mjs 的 INFER_SNAP 吸附口径一致），否则保留原比值。', '')
  report.push(mdTable(['id', '量', '官方值 m', '对应模型', '模型尺寸', '原始比值', 'scaleToMeters', '单位', '缩放后对应尺寸 m', '出处'], verified.map((r) => {
    const f = r.u.fit || {}
    const how = f.inheritedFrom ? `沿用 ${f.inheritedFrom}` : f.mode === 'longest' ? '最长边' : f.mode === 'axis' ? `${f.axis} 轴全长` : `部件跨度${f.axis ? `（${f.axis}）` : ''}`
    const s = r.meta.units.scaleToMeters
    return [r.it.id, f.measure || '', f.valueM ?? '', how, f.extentModel != null ? +f.extentModel.toPrecision(6) : '', f.rawScale != null ? +f.rawScale.toPrecision(5) : '',
      +s.toPrecision(6), r.meta.units.unitGuess, f.extentModel != null ? +(f.extentModel * s).toPrecision(4) : '', r.meta.units.sizeSource]
  }), ['l', 'l', 'r', 'l', 'r', 'r', 'r', 'l', 'r', 'l']), '')
  if (fitRejected.length) {
    report.push('### known-dims 有条目但没用上', '')
    report.push(mdTable(['id', '原因'], fitRejected.map((r) => [r.it.id, r.u.reject]), ['l', 'l']), '')
  }
  report.push('## 尺寸未核（按包围盒量级规则）', '')
  report.push(mdTable(['id', '标题', '最大边（模型单位）', 'unitGuess', 'scaleToMeters', '折合最大边 m'], unverified.map((r) => {
    const span = Math.max(...r.w.bboxSize)
    return [r.it.id, r.meta.title, +span.toPrecision(6), r.meta.units.unitGuess, r.meta.units.scaleToMeters, +(span * r.meta.units.scaleToMeters).toPrecision(4)]
  }), ['l', 'l', 'r', 'l', 'r', 'r']), '')
  if (noZh.length) report.push('## 缺中文名', '', noZh.map((r) => `- ${r.it.id}`).join('\n'), '')
  if (kindByKeyword.length) report.push('## kind 由标题关键词推断（待补 kind-overrides.json）', '', kindByKeyword.map((r) => `- ${r.it.id}：${r.meta.kind}`).join('\n'), '')
  report.push('## 本体朝向（frame-overrides.json）', '')
  report.push(`缺省 q = +Y 天顶（Q_YUP_ZENITH ${JSON.stringify(NASA_DEFAULT_Q)}：glTF +Y ↦ 本体 −Z 天顶、+Z ↦ +X 速度）；覆盖表逐件核过的写 frame.verified = true。`, '')
  report.push(mdTable(['项', '数值'], [
    ['朝向已核（覆盖表）', `${frameVerified.length} 个文件`],
    ['缺省 +Y 天顶（未核）', `${rows.length - frameVerified.length} 个文件`],
    ['覆盖表标明不校正（skipped）', `${[...frameOv.skipped.keys()].filter((id) => allIds.has(id)).length} 条`],
    ['覆盖表坏条目（未收）', frameOv.errors.length],
    ['覆盖表里有、目录里没有的 id', partial ? '（子集运行不判）' : frameStale.length]
  ], ['l', 'r']), '')
  if (frameVerified.length) report.push(mdTable(['id', 'q_model2body', '天底 / 速度（模型轴）', '依据'], frameVerified.map((r) => {
    const e = frameOv.entries.get(r.it.id)
    return [r.it.id, JSON.stringify(r.meta.frame.q_model2body), e.axes ? `${e.axes.nadir} / ${e.axes.velocity}${e.axes.yawDeg ? ` · 偏航 ${e.axes.yawDeg}°` : ''}` : '—', e.basis]
  }), ['l', 'l', 'l', 'l']), '')
  const skippedHere = [...frameOv.skipped].filter(([id]) => allIds.has(id))
  if (skippedHere.length) report.push('标明不校正的条目：', '', mdTable(['id', '原因'], skippedHere.map(([id, why]) => [id, why || '—']), ['l', 'l']), '')
  if (frameOv.errors.length) report.push('覆盖表坏条目（未收，按缺省出）：', '', frameOv.errors.map((e) => `- ${e}`).join('\n'), '')
  if (!partial && frameStale.length) report.push('覆盖表里有、目录里没有的 id：', '', frameStale.map((id) => `- ${id}`).join('\n'), '')
  const withNotes = rows.filter((r) => r.w.notes && r.w.notes.length)
  if (withNotes.length) {
    report.push('## 处理备注（外部贴图缺失、被丢弃的未知扩展、简化 / 贴图回退）', '')
    for (const r of withNotes) report.push(`- ${r.it.id}：${[...new Set(r.w.notes)].join('；')}`)
    report.push('')
  }
  if (!shape.ok || (coreCheck && !coreCheck.clean)) {
    report.push('## manifest 自检问题', '')
    for (const e of [...shape.errors, ...((coreCheck && coreCheck.errors) || [])]) report.push(`- ${e}`)
    report.push('')
  }
  report.push('## 逐文件', '')
  report.push(mdTable(['id', 'kind', '中文名', '原件', 'lod0', 'lod1', 'lod2', '三角形 lod0/1/2', '尺寸', '闭合'], rows.slice().sort((a, b) => cmp(a.it.id, b.it.id)).map((r) => [
    r.it.id, r.meta.kind, r.titleZh || '', fmtBytes(r.w.src.bytes), fmtBytes(r.w.lods.lod0.bytes), fmtBytes(r.w.lods.lod1.bytes), fmtBytes(r.w.lods.lod2.bytes),
    `${fmtInt(r.w.lods.lod0.tris)} / ${fmtInt(r.w.lods.lod1.tris)} / ${fmtInt(r.w.lods.lod2.tris)}`,
    r.meta.geometry.bboxM.max.map((v) => +(2 * v).toPrecision(3)).join('×') + ' m' + (r.meta.units.sizeVerified ? '' : '（未核）'),
    r.meta.geometry.closed ? '是' : '否'
  ]), ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l']), '')
  await fsp.writeFile(path.join(outRoot, 'REPORT.md'), report.join('\n'), 'utf8')

  // 终端汇总
  console.log('')
  console.log(formatTable(['项', '数值'], [
    ['条目 / 文件', `${summary.entries} / ${summary.files}`], ['失败', failures.length],
    ...(notBuilt.length ? [['未构建（不在本次范围且无旧产物）', notBuilt.length]] : []),
    ['Draco 文件 / 解码成功', `${dracoFiles} / ${dracoOk}`], ['SpecGloss 转换', specGloss.length],
    ['lod0（目标 ≤ 200 MB）', fmtMB(summary.lod0)], ['lod1', fmtMB(summary.lod1)], ['lod2（目标 ≤ 30 MB）', fmtMB(summary.lod2)],
    ['最大 lod0', summary.max.lod0 ? `${summary.max.lod0.id} ${fmtMB(summary.max.lod0.bytes)}` : '—'],
    ['尺寸已核 / 未核', `${verified.length} / ${unverified.length}`],
    ['朝向已核 / 缺省', `${frameVerified.length} / ${rows.length - frameVerified.length}${frameOv.errors.length ? `（覆盖表坏条目 ${frameOv.errors.length}）` : ''}`],
    [manifestName, `${manifest.models.length} 条 · ${manifest.buildId} · 自检 ${shape.ok ? '通过' : shape.errors.length + ' 处问题'}${coreCheck ? ` · validateManifest ${coreCheck.clean ? '通过' : '有问题'}` : ''}`],
    ['耗时', fmtSec(totalMs)]
  ], ['l', 'l']))
  if (partial) console.log(`⚠ 子集运行：只写 ${path.relative(REPO_ROOT, path.join(outRoot, manifestName)) || manifestName}，manifest.json 未改动（${reasons.join('；')}）。发布前不带 --groups 全量跑一次。`)
  console.log(`报告：${path.relative(REPO_ROOT, path.join(outRoot, 'REPORT.md'))}`)
  if (frameOv.errors.length) console.log(`⚠ frame-overrides.json 有 ${frameOv.errors.length} 条坏条目（按缺省出，见 REPORT「本体朝向」）`)
  // 覆盖表里有、目录里没有的 id：全量运行时与坏条目同等对待（退出码 1）——id 抄错 / NASA 改了 slug 时那一件静默落回缺省朝向，
  // 脚本和 CI 却看到干净退出。子集运行本来就没覆盖全，不判。
  const staleFail = !partial && frameStale.length > 0
  if (staleFail) console.log(`⚠ frame-overrides.json 有 ${frameStale.length} 个 id 在本次目录里找不到（改名 / 下架 / 写错；见 REPORT「本体朝向」）`)
  return failures.length || frameOv.errors.length || staleFail || !shape.ok || (coreCheck && !coreCheck.clean) ? 1 : 0
}

// 只有「node build.mjs」直接跑才开工；单测 import 本文件只拿纯函数。Windows 盘符大小写可能不一致，比较时统一小写
const isDirectRun = isMainThread && !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()
if (isDirectRun) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(`✗ ${e && e.stack ? e.stack : e}`); process.exitCode = 2 })
}
