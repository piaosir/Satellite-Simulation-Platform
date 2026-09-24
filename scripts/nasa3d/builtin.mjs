// 安装包内置模型子集（npm run nasa3d:builtin）：从 build/models 选常用的几件写进 resources/models（进 git，≤ 15 MiB，dist 链 check-models 把关）。
//
//   node scripts/nasa3d/builtin.mjs [--build-dir=build/models] [--review-dir=build/review] [--out=resources/models]
//                                   [--catalog=subset|full] [--templates=off|entries] [--dry-run] [--budget-mb=12]
//
// 产物（DESIGN §3.3 / §8）：
//   resources/models/manifest.json        manifest v2（内置层；sourceBuildId = 这批文件出自哪次 build，check-models --online 据它查云端是否已发布；
//                                         thumbView = 缩略图的取景口径〔显示系签名〕，check-models 据它拦显示系换向后没重出的缩略图）
//   resources/models/builtin/<sha>.glb    子集的 lod2（只这一档：球面图标、「低」档跟随、未下载时的预览够用；lod0 / lod1 照旧从云端按需拉）
//   resources/models/thumbs/<sha>.webp    缩略图
//
// 出厂口径（2026-09-24 审查后）：内置层 = 【实际随包带了模型的条目】，一条不多——
//   · 子集（BUILTIN_SUBSET）：builtin ['lod2','thumb']。
//   · 参数化模板：缺省【不进】（--templates=off）。DESIGN §8「参数化模板不需要文件（运行时生成）」；工作台（wbStore.refresh 同 id
//     清单条目会顶掉自己生成的模板条目 → 选中报「参数化模型缺少生成参数」）、3D 页（清单条目带 geometry 就不再按模板算质量）、
//     主进程（slimMeta 白名单删掉 templateId / specHash）三处都按「模板没有清单条目」写的。--templates=entries 出带缩略图的模板条目，
//     等那三处按「同 id 合并、以模板为底」改好再开（见 README）。
//   · 其余 NASA 条目：缺省【不进】（--catalog=subset）。没带模型的「目录条目」离线时照样进 3D 页 autoMatch 的可用集：ISS 会选中
//     没随包的 iss-d、TDRS 1–7 选中 tdrs-a，随包的件反而轮不到，一律退成点图标。--catalog=full 只为以后 autoMatch 按「本机能出图」
//     判可用之后再开（check-models 缺省拦目录条目，--allow-catalog 放行）。
//
// 选哪些（DESIGN §8 点名 + 编排者 2026-09-24：TDRS 一代与新一代各一）——见 BUILTIN_SUBSET；每项可给候选，按顺序取第一个在 build 里的。
//   ISS 取 D（IGOAL）：尺寸已核（108 m，A / B 只有 26 / 45 m、未核）、autoMatch 的首选候选（在线 / 离线同一件）、lod2 在三角形上限下
//   1.3 MB；B 带一块悬空碎片、A 比例差 4 倍，都退为候选。
// 前置：nasa3d:build（全量，manifest.json 不能是子集）→ nasa3d:sheets（缩略图）→ nasa3d:build 再跑一次（走缓存，核对后并入 files.thumb）。
//   缺缩略图、缩略图核对不过（sheets.json 的内容键对不上当前 meta）、模板 specHash / 取景口径（显示系）对不上、文件 sha 对不上一律报错退出，不写半套。
//
// 写盘：先在同目录的临时目录里拼好整套，校验通过再换入（旧目录改名 → 新目录改名 → 删旧）；换入遇 EPERM / EBUSY / EACCES（杀毒软件、
//   开着的开发版应用占着句柄）按退避重试；无论成败临时目录都在 finally 里删掉，resources/ 下不留 .models-tmp-*（build.files 的
//   resources/**/* 会把它打进 app.asar）。输出与上次逐字节相同（buildId 由内容决定、generatedAt 沿用）时不动文件。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, BUILD_ROOT, parseArgs, readJson, formatTable } from './lib.mjs'
import { checkThumbRecord, REVIEW_ROOT, THUMB_VIEW } from './sheets.mjs'
import { bodyToModel } from '../../packages/core/models/bodyFrame.mjs'

export const BUILTIN_DIR = path.join(REPO_ROOT, 'resources', 'models')
export const CAP_BYTES = 15 * 1024 * 1024          // 与 check-models 同一条红线（15 MiB）
export const DEFAULT_BUDGET_MB = 12                // 自己留的余量线：超过它提示（不拦），给以后加件留 3 MiB
export const PARAM_DIR = '_param'
/**
 * 内置子集（manifest 按 id 排序；这里的顺序只决定「候选里先取谁」）。
 * pick：候选 id，取第一个在 build 里有的；why：选它的理由（进终端表）。
 */
export const BUILTIN_SUBSET = Object.freeze([
  { key: 'tdrs-1', pick: ['nasa:tracking-and-data-relay-satellites-trds-e', 'nasa:tracking-and-data-relay-satellites-tdrs-a'], why: 'TDRS 一代（TRW，双 4.9 m 单址天线；尺寸已核 17.3 m）' },
  { key: 'tdrs-2', pick: ['nasa:tracking-and-data-relay-satellites-tdrs-d'], why: 'TDRS 新一代（Boeing 601；唯一的新一代外形，尺寸已核 21 m 翼展）' },
  { key: 'goes', pick: ['nasa:geostationary-operational-environmental-satellites'], why: 'GOES（静止气象）' },
  { key: 'ssl1300', pick: ['nasa:space-systems-loral-ssl-1300'], why: 'SSL-1300（GEO 通信平台）' },
  { key: 'cubesat-1u', pick: ['nasa:cubesat-1-ru-generic'], why: 'CubeSat 1RU' },
  { key: 'cubesat-2u', pick: ['nasa:cubesat-2-ru-generic'], why: 'CubeSat 2RU' },
  { key: 'dsn34', pick: ['nasa:deep-space-network-34-meter'], why: 'DSN 34 m 地球站天线' },
  { key: 'iss', pick: ['nasa:international-space-station-iss-d-igoal', 'nasa:international-space-station-iss-a', 'nasa:international-space-station-iss-b'], why: 'ISS（D IGOAL：尺寸已核、autoMatch 首选）' },
  { key: 'hubble', pick: ['nasa:hubble-space-telescope-a'], why: 'Hubble（A，尺寸已核 13.2 m）' },
  { key: 'landsat8', pick: ['nasa:landsat-8'], why: 'Landsat 8' },
  { key: 'kit-body-1', pick: ['nasa:satellite-kit'], why: 'Satellite Kit 平台体 1（通用平台体）' },
  { key: 'kit-body-2', pick: ['nasa:satellite-kit~2'], why: 'Satellite Kit 平台体 2' },
  { key: 'kit-body-3', pick: ['nasa:satellite-kit~3'], why: 'Satellite Kit 平台体 3' }
])
export const NASA_TIERS = Object.freeze(['lod2', 'thumb'])
export const PARAM_TIERS = Object.freeze(['thumb'])
/** 换入重试（Windows：杀毒软件扫新文件、开着的应用占着句柄时 rename 报 EPERM / EBUSY / EACCES，过一会儿就好） */
export const RENAME_RETRY_MS = Object.freeze([50, 100, 200, 400, 800, 1600])

const SHA_RE = /^[0-9a-f]{64}$/
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
/** 字符串表去重（保序；空串与非字符串丢掉） */
export const uniq = (list) => [...new Set((Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s))]
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ─────────────────────────────── 纯函数 ───────────────────────────────

/** 命令行 → 选项（纯函数，单测覆盖）；非法值抛中文错 */
export function resolveBuiltinOpts({ catalog, templates } = {}) {
  const c = catalog == null || catalog === '' ? 'subset' : String(catalog)
  if (!['full', 'subset'].includes(c)) throw new Error(`--catalog 只能是 subset 或 full，收到「${catalog}」`)
  const t = templates == null || templates === '' ? 'off' : String(templates)
  if (!['off', 'entries'].includes(t)) throw new Error(`--templates 只能是 off 或 entries，收到「${templates}」`)
  return { catalog: c, templates: t }
}

/**
 * 按 BUILTIN_SUBSET 在 build 的 manifest 里挑条目。
 * @returns {{picked:{key, id, why, fallback:boolean}[], missing:{key, pick:string[]}[]}}
 */
export function pickSubset(models, subset = BUILTIN_SUBSET) {
  const have = new Set((Array.isArray(models) ? models : []).map((m) => m && m.id))
  const picked = [], missing = []
  const seen = new Set()
  for (const s of subset) {
    const id = s.pick.find((x) => have.has(x) && !seen.has(x))
    if (!id) { missing.push({ key: s.key, pick: s.pick.slice() }); continue }
    seen.add(id)
    picked.push({ key: s.key, id, why: s.why, fallback: id !== s.pick[0] })
  }
  return { picked, missing }
}

/**
 * NASA 条目：build 的完整 meta（或 manifest 精简条目）→ 内置 manifest 条目。
 * 只留 manifest 精简字段（与 build.mjs 的 SLIM 口径一致，files 保留全部档——客户端据此从云端补 lod0 / lod1），加 builtin 档位表。
 * 缺 lod2 或缩略图抛错（不许半套）。
 */
const SLIM_KEYS = ['schema', 'id', 'title', 'titleZh', 'kind', 'group', 'fidelity', 'source', 'files', 'units', 'frame', 'geometry', 'tags', 'aliases', 'updatedAt']
export function nasaBuiltinEntry(meta, tiers = NASA_TIERS) {
  if (!meta || typeof meta !== 'object') throw new Error('meta 不是对象')
  const f = meta.files || {}
  for (const k of tiers) {
    const e = f[k]
    if (!e || !SHA_RE.test(e.sha256 || '') || !(Number.isInteger(e.bytes) && e.bytes > 0)) throw new Error(`${meta.id}：files.${k} 缺失${k === 'thumb' ? '（先跑 nasa3d:sheets，再跑一次 nasa3d:build）' : ''}`)
  }
  const o = {}
  for (const k of SLIM_KEYS) if (meta[k] !== undefined) o[k] = JSON.parse(JSON.stringify(meta[k]))
  o.builtin = tiers.slice()
  return o
}

/**
 * 本体系包围盒 → 模型轴包围盒（DESIGN §3.2 终案：geometry.bboxM 统一是【模型轴、米】，本体系尺寸由 frame 现算、不落盘）。
 * 八个角点按 v_model = Rᵀ·(v_body − t) 换过去再取极值；q 是轴对齐旋转（出厂 STK 映射、24 个轴向之一）时就是分量换位 / 变号，结果精确。
 * frame 缺 q / 非法 → null（调用方报错，不写半对的数）。
 */
export function bboxBodyToModel(b, frame) {
  const q = frame && frame.q_model2body, t = (frame && frame.t_model2body) || [0, 0, 0]
  if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) return null
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i++) {
    const v = bodyToModel([(i & 1 ? b.max : b.min)[0], (i & 2 ? b.max : b.min)[1], (i & 4 ? b.max : b.min)[2]], q, t)
    if (!v || v.some((x) => !Number.isFinite(x))) return null
    for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k] }
  }
  return { min, max }
}

/**
 * 参数化模板条目（仅 --templates=entries）：模板目录项（templateCatalog）+ 生成结果（buildTemplateModel）+ 缩略图记账（sheets 的 info.json）。
 * 几何口径按 DESIGN §3.2 终案：bboxM 与 centroidM 是【模型轴、米】（与 NASA 条目、build.mjs 同口径；paramBus 按本体系给，这里经 frame 换过去）；
 * 包围半径与轴无关；三角形 / 面积按节点实例（ir.irStats）；centroidM 取组件累加质心。
 * templateId / specHash 写进文件给 check-models 与人核对；运行时客户端按 id（param:<模板>，DESIGN §3.5）认模板。
 * 缩略图核对三项（与 NASA 条目的 checkThumbRecord 同口径）：specHash、取景口径 info.view === THUMB_VIEW（含显示系签名——
 * 模板按本体系建几何，显示系一换向缩略图就上下颠倒，specHash 却不变）、文件 sha。view 参数只给单测注入。
 */
export function paramBuiltinEntry({ cat, r, stats, info, thumb, view = THUMB_VIEW }) {
  if (!info || info.specHash !== r.specHash) throw new Error(`${cat.id}：缩略图是按 specHash ${info ? info.specHash : '（无）'} 出的，当前模板 ${r.specHash}——重跑 nasa3d:sheets`)
  if (info.view !== view) throw new Error(`${cat.id}：缩略图是按取景口径 ${info.view || '（无）'} 出的，当前 ${view}（显示系换过？）——重跑 nasa3d:sheets`)
  if (!thumb || !SHA_RE.test(thumb.sha256 || '') || thumb.sha256 !== info.thumbSha) throw new Error(`${cat.id}：缩略图文件与 info.json 记的 sha 不符——重跑 nasa3d:sheets`)
  const r7 = (v) => (Number.isFinite(v) ? (v === 0 ? 0 : Number(v.toPrecision(7))) : v)
  const bm = bboxBodyToModel(r.bboxBody, r.frame)
  const cm = r.massProps && Array.isArray(r.massProps.comBody) ? bodyToModel(r.massProps.comBody, r.frame && r.frame.q_model2body, (r.frame && r.frame.t_model2body) || [0, 0, 0]) : null
  if (!bm || !cm) throw new Error(`${cat.id}：模板 frame / 包围盒 / 质心不成形，换不到模型轴`)
  return {
    schema: 2,
    id: cat.id,
    title: cat.title,
    titleZh: cat.titleZh,
    kind: cat.kind || 'spacecraft',
    group: cat.group || 'spacecraft',
    fidelity: 'parametric',
    source: JSON.parse(JSON.stringify(cat.source)),
    files: { thumb: { sha256: thumb.sha256, bytes: thumb.bytes } },
    units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
    frame: JSON.parse(JSON.stringify(r.frame)),
    geometry: {
      bboxM: { min: bm.min.map(r7), max: bm.max.map(r7) },
      boundingRadiusM: r7(r.boundingRadiusM),
      tris: stats.tris,
      areaM2: r7(stats.areaM2),
      volumeM3: null,
      closed: false,
      centroidM: cm.map(r7)
    },
    // 去重：templateCatalog 给 GEO 布局的模板会出两个「geo」（layout 名 + 类别词），validateMeta 判重复即整条丢弃
    tags: uniq(cat.tags),
    aliases: uniq(cat.aliases),
    updatedAt: info.renderedAt || null,
    builtin: PARAM_TIERS.slice(),
    templateId: cat.templateId,
    specHash: r.specHash
  }
}

/**
 * buildId 只由条目内容决定（按 id 排序后整体哈希）。
 * thumbView：这批缩略图的取景口径（sheets.THUMB_VIEW = 取景法 | 显示系签名；每条都已按它核过——NASA 件 checkThumbRecord、模板 paramBuiltinEntry）。
 * 记在顶层给 check-models 用：view.js 的显示系再换向而没人重跑 sheets → build → builtin 时，dist 链据它拦下（缩略图会上下颠倒）。
 * 不进 buildId（缩略图重出了，sha 变、buildId 自然变；只补记这个字段不该换 buildId）。validateManifest 不认的顶层键照样放行。
 */
export function builtinManifest(models, { generatedAt = new Date().toISOString(), sourceBuildId = null, thumbView = null } = {}) {
  const list = models.slice().sort((a, b) => cmp(a.id, b.id))
  const buildId = `builtin-${sha256(JSON.stringify(list)).slice(0, 12)}`
  return { schema: 2, buildId, generatedAt, ...(sourceBuildId ? { sourceBuildId } : {}), ...(thumbView ? { thumbView } : {}), models: list }
}

/**
 * 条目 → 要落盘的文件：{rel:'builtin/<sha>.glb'|'thumbs/<sha>.webp', sha256, bytes, id, tier}。
 * lod 按 builtin 档位表带；缩略图每条都带。同一 sha 只落一份（航天飞机 D~4 / D~5 两个部件的缩略图逐字节相同）。
 */
export function plannedFiles(models) {
  const out = []
  const seen = new Set()
  const add = (m, k, f) => {
    const rel = k === 'thumb' ? `thumbs/${f.sha256}.webp` : `builtin/${f.sha256}.glb`
    if (seen.has(rel)) return
    seen.add(rel)
    out.push({ rel, sha256: f.sha256, bytes: f.bytes, id: m.id, tier: k })
  }
  for (const m of models) {
    for (const k of m.builtin || []) if (k !== 'thumb' && m.files && m.files[k]) add(m, k, m.files[k])
    if (m.files && m.files.thumb) add(m, 'thumb', m.files.thumb)
  }
  return out
}

/**
 * rename 带退避重试：只对 Windows 上「句柄被占着」的三种错误重试（EPERM / EBUSY / EACCES），其余错误原样抛。
 * rename / wait 注入（单测用替身）；返回重试了几次。
 */
export async function renameWithRetry(from, to, { rename = fsp.rename, wait = (ms) => new Promise((r) => setTimeout(r, ms)), delays = RENAME_RETRY_MS } = {}) {
  for (let i = 0; ; i++) {
    try { await rename(from, to); return i } catch (e) {
      if (!e || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= delays.length) throw e
      await wait(delays[i])
    }
  }
}

/**
 * 把拼好的临时目录换成 outDir（旧目录先改名留作回滚），失败回滚；临时目录与旧目录无论成败都删掉。
 * fsx 注入（单测用替身：rename / rm / exists）。
 */
export async function swapInto(tmp, outDir, { fsx = { rename: fsp.rename, rm: (p) => fsp.rm(p, { recursive: true, force: true }), exists: fs.existsSync }, wait } = {}) {
  const old = path.join(path.dirname(outDir), `.models-old-${process.pid}`)
  const had = fsx.exists(outDir)
  let moved = false
  try {
    if (had) { await renameWithRetry(outDir, old, { rename: fsx.rename, wait }); moved = true }
    try { await renameWithRetry(tmp, outDir, { rename: fsx.rename, wait }) } catch (e) {
      if (moved) { await renameWithRetry(old, outDir, { rename: fsx.rename, wait }); moved = false }
      throw e
    }
  } finally {
    await fsx.rm(tmp)
    if (moved) await fsx.rm(old)
  }
}

// ─────────────────────────────── 主流程 ───────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2), { 'build-dir': 'string', 'review-dir': 'string', out: 'string', catalog: 'string', templates: 'string', 'dry-run': 'bool', 'budget-mb': 'number', help: 'bool' })
  if (args.help) { console.log('用法：node scripts/nasa3d/builtin.mjs [--build-dir=build/models] [--review-dir=build/review] [--out=resources/models] [--catalog=subset|full] [--templates=off|entries] [--dry-run] [--budget-mb=12]'); return 0 }
  const opt = resolveBuiltinOpts({ catalog: args.catalog, templates: args.templates })
  const buildDir = args.buildDir ? path.resolve(args.buildDir) : BUILD_ROOT
  const reviewDir = args.reviewDir ? path.resolve(args.reviewDir) : REVIEW_ROOT
  const outDir = args.out ? path.resolve(args.out) : BUILTIN_DIR
  const budget = (args.budgetMb || DEFAULT_BUDGET_MB) * 1024 * 1024
  const core = (rel) => import(pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'models', rel)).href)
  const [M, PT, PB, IR] = await Promise.all([core('manifest.mjs'), core('paramTemplates.mjs'), core('paramBus.mjs'), core('ir.mjs')])

  const man = readJson(path.join(buildDir, 'manifest.json'))
  if (!man || !Array.isArray(man.models)) throw new Error(`读不到 ${path.relative(REPO_ROOT, path.join(buildDir, 'manifest.json'))}：先跑 npm run nasa3d:build`)
  if (man.partial) throw new Error('build 的 manifest.json 标着 partial（子集运行），不能从它选内置件——全量跑一次 nasa3d:build')
  const sheets = readJson(path.join(reviewDir, 'sheets.json'), null)

  // NASA 条目：缩略图再核一次（build 认领时核过；这里防「build 之后又动了 sheets.json / thumb.webp」）
  const nasaEntry = (m, dir, tiers) => {
    const e = nasaBuiltinEntry(m, tiers)
    const chk = checkThumbRecord(sheets && sheets.entries ? sheets.entries[m.id] : null, m, e.files.thumb.sha256)
    if (!chk.ok) throw new Error(`${m.id}：缩略图核对不过（${chk.reason}）`)
    return e
  }
  const { picked, missing } = pickSubset(man.models)
  if (missing.length) throw new Error(`内置子集里这些在 build 里一个候选都没有：${missing.map((x) => `${x.key}（${x.pick.join(' / ')}）`).join('；')}`)
  const entries = []
  const sources = new Map()   // rel → 源文件
  const rows = []
  for (const p of picked) {
    const dir = p.id.slice('nasa:'.length)
    const meta = readJson(path.join(buildDir, dir, 'meta.json'))
    if (!meta) throw new Error(`${p.id}：读不到 ${dir}/meta.json`)
    const e = nasaEntry(meta, dir, NASA_TIERS)
    entries.push(e)
    sources.set(`builtin/${e.files.lod2.sha256}.glb`, path.join(buildDir, dir, 'lod2.glb'))
    sources.set(`thumbs/${e.files.thumb.sha256}.webp`, path.join(buildDir, dir, 'thumb.webp'))
    const b = e.geometry && e.geometry.bboxM
    rows.push({ id: p.id, what: p.why + (p.fallback ? '（候选顶替）' : ''), lod2: e.files.lod2.bytes, thumb: e.files.thumb.bytes, tris: e.files.lod2.tris,
      size: b ? b.max.map((v, k) => +(v - b.min[k]).toPrecision(3)).join(' × ') : '—', verified: !!(e.units && e.units.sizeVerified), frameVerified: !!(e.frame && e.frame.verified === true) })
  }
  // 其余 NASA 条目：目录 + 缩略图（仅 --catalog=full，见文件头）
  let catalogOnly = 0
  if (opt.catalog === 'full') {
    const inSubset = new Set(picked.map((p) => p.id))
    for (const m of man.models) {
      if (inSubset.has(m.id)) continue
      const dir = m.id.slice('nasa:'.length)
      const e = nasaEntry(m, dir, ['thumb'])
      delete e.builtin
      entries.push(e)
      sources.set(`thumbs/${e.files.thumb.sha256}.webp`, path.join(buildDir, dir, 'thumb.webp'))
      catalogOnly++
    }
  }
  // 参数化模板（仅 --templates=entries，见文件头）
  let nTpl = 0
  if (opt.templates === 'entries') {
    const cats = new Map(PT.templateCatalog().map((c) => [c.templateId, c]))
    for (const tid of PT.TEMPLATE_IDS) {
      const cat = cats.get(tid)
      const r = PB.buildTemplateModel(tid)
      const st = IR.irStats(r.ir)
      const pdir = path.join(buildDir, PARAM_DIR, tid)
      const info = readJson(path.join(pdir, 'info.json'))
      let thumb = null
      try { const b = await fsp.readFile(path.join(pdir, 'thumb.webp')); thumb = { sha256: sha256(b), bytes: b.byteLength } } catch { /* 下面报 */ }
      if (!thumb) throw new Error(`${cat.id}：没有缩略图 ${path.relative(REPO_ROOT, path.join(pdir, 'thumb.webp'))}——先跑 npm run nasa3d:sheets`)
      const e = paramBuiltinEntry({ cat, r, stats: { tris: st.tris, areaM2: st.areaM2 }, info, thumb })
      entries.push(e)
      sources.set(`thumbs/${thumb.sha256}.webp`, path.join(pdir, 'thumb.webp'))
      rows.push({ id: cat.id, what: `参数化模板 ${cat.titleZh}`, lod2: 0, thumb: thumb.bytes, tris: st.tris, size: '—', verified: false, frameVerified: true })
      nTpl++
    }
  }

  // manifest：内容没变沿用上次的 generatedAt（逐字节相同 → git 无改动）
  let manifest = builtinManifest(entries, { sourceBuildId: man.buildId, thumbView: THUMB_VIEW })
  const prev = readJson(path.join(outDir, 'manifest.json'))
  if (prev && prev.buildId === manifest.buildId && Number.isFinite(Date.parse(prev.generatedAt))) manifest.generatedAt = prev.generatedAt
  const v = M.validateManifest(manifest, { builtin: true })
  if (!v.ok || v.errors.length || v.models.length !== manifest.models.length) throw new Error(`validateManifest（builtin 口径）不通过：${[...v.errors].join('；') || `丢了 ${manifest.models.length - v.models.length} 条`}`)
  const lostTiers = v.warnings.filter((w) => /builtin 档位/.test(w))
  if (lostTiers.length) throw new Error(`builtin 档位表与 files 对不上：${lostTiers.join('；')}`)

  // 文件：校验源文件 sha → 算总量
  const plan = plannedFiles(manifest.models)
  let total = 0
  for (const f of plan) {
    const src = sources.get(f.rel)
    const b = await fsp.readFile(src)
    if (b.byteLength !== f.bytes || sha256(b) !== f.sha256) throw new Error(`${f.id}：${path.relative(REPO_ROOT, src)} 与 meta 记的 sha / 字节不符（build 之后又改过？重跑 nasa3d:build）`)
    total += f.bytes
  }
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  total += Buffer.byteLength(manifestText)
  const mib = (n) => (n / 1024 / 1024).toFixed(2)
  console.log(formatTable(['id', '说明', 'lod2 KB', '缩略图 KB', 'lod2 三角形', '包围盒 m（模型轴）', '尺寸核定', '朝向核定'], rows.map((r) => [r.id, r.what, r.lod2 ? (r.lod2 / 1024).toFixed(1) : '—', (r.thumb / 1024).toFixed(1), r.tris.toLocaleString('en-US'), r.size, r.verified ? '已核' : '未核', r.frameVerified ? '已核' : '未核']), ['l', 'l', 'r', 'r', 'r', 'r', 'l', 'l']))
  console.log('')
  const sumOf = (pred) => plan.filter(pred).reduce((a, f) => a + f.bytes, 0)
  console.log(formatTable(['构成', '个数', 'MiB'], [
    ['子集 lod2（builtin/*.glb）', plan.filter((f) => f.tier !== 'thumb').length, mib(sumOf((f) => f.tier !== 'thumb'))],
    ['缩略图（thumbs/*.webp）', plan.filter((f) => f.tier === 'thumb').length, mib(sumOf((f) => f.tier === 'thumb'))],
    ['manifest.json', 1, mib(Buffer.byteLength(manifestText))]
  ], ['l', 'r', 'r']))
  console.log(`内置层：${manifest.models.length} 条（子集 ${picked.length} · 参数化模板 ${nTpl} · 目录条目 ${catalogOnly}）· 文件 ${plan.length} 个 · 合计 ${mib(total)} MiB（${total} 字节）/ 上限 15 MiB · 余量线 ${mib(budget)} MiB · buildId ${manifest.buildId}（源 ${man.buildId}）`)
  const unverified = rows.filter((r) => r.lod2 && !r.verified)
  if (unverified.length) console.log(`⚠ 子集里尺寸未核的：${unverified.map((r) => `${r.id}（${r.size} m）`).join('、')}——真实比例的跟随视图里大小不可信，补 known-dims.json 后重跑 build`)
  const frameUnverified = rows.filter((r) => r.lod2 && !r.frameVerified)
  if (frameUnverified.length) console.log(`⚠ 子集里朝向未核的（frame.verified≠true）：${frameUnverified.map((r) => r.id).join('、')}——3D 页跟随视图里的姿态按缺省映射摆，补 scripts/nasa3d/frame-overrides.json 后重跑 build → sheets → build → builtin`)
  if (opt.catalog === 'full') console.log('⚠ --catalog=full：目录条目离线时会进 3D 页 autoMatch 的可用集（见文件头）；check-models 缺省拦它们（--allow-catalog 放行）')
  if (opt.templates === 'entries') console.log('⚠ --templates=entries：工作台 / 3D 页 / 主进程要先按「同 id 合并、以模板为底」改好（见文件头）')
  console.log(`⚠ 发版前先 npm run nasa3d:publish 把源 build ${man.buildId} 传上云（dist 链的 check-models --online 会查 manifest.${man.buildId}.json）`)
  if (total > CAP_BYTES) throw new Error(`总量 ${mib(total)} MiB 超过 15 MiB 上限`)
  if (total > budget) console.log(`⚠ 总量超过余量线 ${mib(budget)} MiB（仍在上限内）`)
  if (args.dryRun) { console.log('（--dry-run：不写盘）'); return 0 }

  // 与现状逐字节相同就不动
  const same = await (async () => {
    try {
      if ((await fsp.readFile(path.join(outDir, 'manifest.json'), 'utf8')) !== manifestText) return false
      const want = new Set(plan.map((f) => f.rel.replace('/', path.sep)))
      const have = []
      for (const sub of ['builtin', 'thumbs']) for (const n of fs.existsSync(path.join(outDir, sub)) ? fs.readdirSync(path.join(outDir, sub)) : []) have.push(path.join(sub, n))
      const top = fs.readdirSync(outDir).filter((n) => !['manifest.json', 'builtin', 'thumbs'].includes(n))
      if (top.length || have.length !== want.size || !have.every((h) => want.has(h))) return false
      for (const f of plan) { const b = await fsp.readFile(path.join(outDir, f.rel)); if (sha256(b) !== f.sha256) return false }
      return true
    } catch { return false }
  })()
  if (same) { console.log(`✓ ${path.relative(REPO_ROOT, outDir)} 已是最新（逐字节相同，未改动）`); return 0 }

  // 拼到临时目录 → 换入（swapInto：重试 + finally 清临时目录）
  const parent = path.dirname(outDir)
  await fsp.mkdir(parent, { recursive: true })
  const tmp = path.join(parent, `.models-tmp-${process.pid}`)
  try {
    await fsp.rm(tmp, { recursive: true, force: true })
    await fsp.mkdir(path.join(tmp, 'builtin'), { recursive: true })
    await fsp.mkdir(path.join(tmp, 'thumbs'), { recursive: true })
    for (const f of plan) await fsp.copyFile(sources.get(f.rel), path.join(tmp, f.rel))
    await fsp.writeFile(path.join(tmp, 'manifest.json'), manifestText, 'utf8')
  } catch (e) { await fsp.rm(tmp, { recursive: true, force: true }); throw e }
  await swapInto(tmp, outDir)
  console.log(`✓ 已写 ${path.relative(REPO_ROOT, outDir)}：manifest.json + builtin/ ${plan.filter((f) => f.tier !== 'thumb').length} 个 glb + thumbs/ ${plan.filter((f) => f.tier === 'thumb').length} 张 webp`)
  console.log('  下一步：npm run check:models')
  return 0
}

const isDirectRun = !!process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()
if (isDirectRun) main().then((c) => { process.exitCode = c }, (e) => { console.error(`✗ ${e && e.message ? e.message : e}`); process.exitCode = 1 })
