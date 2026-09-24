// 打包前自检：安装包里随带的内置模型子集（resources/models）必须完整、可用、可分发。运行：node scripts/check-models.mjs
//
// 为什么需要这个脚本 —— 与 check-imagery 拦的是同一类事故：resources/models 走 build.extraResources 原样拷进安装包
// （不进 app.asar），渲染端缺文件时会静默回退成点图标——好事，但也正因为如此，漏带 / 带坏这个目录【不会报错】，
// 离线用户的内置模型全变成点，谁也不会来报；而开发机上目录一直在，永远复现不出来。
// 另外两条是授权红线：STK 模型（AGI SLA）与本机导入件绝不能进安装包（DESIGN §0-1 四道闸之外的第五道：随包分发）。
//
// 九条（缺一条就中断打包）：
//   ① package.json：build.files 含 "!resources/models/**" 与 "!resources/licenses/**"（不进 asar，免得打两份），
//      extraResources 含 resources/models → models、resources/licenses → licenses（LGPL 许可原文要在安装目录里看得见）；
//      resources/licenses 下 occt-import-js 与 OCCT 两份许可原文存在且非空（occt-import-js 是 LGPL-2.1，随包分发必须附原文）
//   ② manifest.json 能解析，并通过 packages/core/models/manifest.mjs 的 validateManifest（builtin 口径）且没有丢条目
//   ③ 每条的每个随包档（builtin 列表）：builtin/<sha256>.glb 存在、字节数与 sha256 与 manifest 一致；GLB 头 magic / 版本 2 /
//      声明总长 = 文件长 / 首块是 JSON；extensionsRequired 只含客户端解得开的五个扩展。
//      条目口径（scripts/nasa3d/builtin.mjs 文件头）：内置层 = 实际随包带了模型的条目——
//        · 没带 lod 的 NASA「目录条目」缺省拦下（离线时它们照样进 3D 页 autoMatch 的可用集，选中了却拉不下来，随包件反而轮不到）；
//          --allow-catalog 放行（等 autoMatch 改成按「本机能出图」判可用之后）。
//        · 参数化模板条目（id 以 param: 开头）可有可无（DESIGN §8：模板运行时生成）；有就必须是 paramTemplates 里的模板、带缩略图
//          （④ 查），记的 specHash 与当前模板生成结果对不上只警告（缩略图过时，不影响功能）。
//      随包件 frame.verified≠true（朝向未按 frame-overrides.json 核定）只警告、不拦。
//      另查一条覆盖：autoMatch 的兜底模型（规则表都匹配不上时给的那个 id，现为 paramTemplates.DEFAULT_MODEL_ID 即 param:default-sat，参数化模板）若是 NASA 件，必须随包带 lod
//      （离线时匹配不上的星都指望它）；兜底是参数化模板就不用（运行时生成）。按 autoMatch.mjs 现算，不写死 id。
//   ④ 每条都有缩略图：thumbs/<sha256>.webp 存在、sha256 一致、是 RIFF…WEBP；thumbs/*.webp 个数 = 被引用的不同 sha 个数
//      （参数化模板同样要：任务书 §5.8「条数 = 缩略图数」；两个条目的缩略图逐字节相同时共用一份文件——航天飞机 D~4 / D~5）
//   ⑤ 没有孤儿文件：builtin/ 与 thumbs/ 下每个文件都被 manifest 引用（残留的旧版文件白占安装包体积）
//   ⑥ 总量 ≤ 15 MiB（DESIGN §0-2：安装包只内置几个最常用的）
//   ⑦ 没有 redistributable=false 的条目，没有 stk-local / user 来源（id 前缀 stk: / user: 同样拒）
//   ⑧ 缩略图取景口径：manifest 顶层 thumbView（nasa3d:builtin 写，= 出这批缩略图时的 sheets.THUMB_VIEW〔取景法 | 显示系签名〕）
//      必须等于按当前 src/viz/models/view.js 现算的 THUMB_VIEW —— 显示系换向（2026-09-24 那种「本体 +Z 朝上 → 天顶朝上」）后
//      没人重跑 sheets → build → builtin，随包缩略图就是上下颠倒的，而 ②–⑥ 查的 sha / 字节 / WebP 头全都照样对。
//      manifest 没记 thumbView（旧版 builtin 出的）只警告。
//   ⑨ 随包 NASA 件的朝向与核定表一致：entry.frame（q_model2body、verified）= build.resolveFrame(id, frame-overrides.json) ——
//      覆盖表改了某件的 q 而没重跑 build → sheets → build → builtin，随包件的姿态与缩略图都还是旧的。
//      查仓库 / --packaged 时拦下；--dir（任意目录、单测夹具）只警告。
//   --online 另加一条（dist 链用）：内置 manifest 的 sourceBuildId 对应的云端快照 updates/models/manifest.<sourceBuildId>.json
//      必须已发布（HEAD 200）。内置条目 files 里的 lod0 / lod1 按 sha 从云端拉——nasa3d:publish 传完 blobs 才传这份快照，
//      它在就说明这批 blob 都在；不在就是「先打包、后发布」，装上后联网升档一律 404。
//
// 用法：
//   node scripts/check-models.mjs                 查仓库里的 resources/models（dist 链在 check-imagery 之后调用）
//   node scripts/check-models.mjs --packaged      查打包产物 release/win-unpacked/resources/models（verify-asar 看不到 asar 外的文件）
//   node scripts/check-models.mjs --dir=<目录>     查任意目录（跳过 ①）
//   node scripts/check-models.mjs --root=<目录>    把 <目录> 当仓库根（package.json 与 resources/models 都从这里找；单测用临时根测 ①）。
//                                                 校验逻辑 packages/core/models/manifest.mjs 仍从本脚本所在仓库加载
//   node scripts/check-models.mjs --online         另查云端快照已发布（dist 链这样调；地址取 manifest.mjs 的 CDN_BASE，
//                                                 单测可用环境变量 SATSIM_CHECK_MODELS_CDN 指到本机假服务）
//   node scripts/check-models.mjs --allow-catalog  放行目录条目（见 ③）
// 逃生开关：SATSIM_SKIP_MODELS=1（打一个不带内置模型的包；客户端照样能从云端拉，只是离线时全是点图标）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CAP = 15 * 1024 * 1024   // 15 MiB（打印时 MiB 与字节都给）
const EXT_WHITELIST = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_texture_transform']
const SHA_RE = /^[0-9a-f]{64}$/

const argv = process.argv.slice(2)
const dirArg = (argv.find((a) => a.startsWith('--dir=')) || '').slice(6)
const rootArg = (argv.find((a) => a.startsWith('--root=')) || '').slice(7)
const root = rootArg ? resolve(rootArg) : REPO
const packaged = argv.includes('--packaged')
const online = argv.includes('--online')
const allowCatalog = argv.includes('--allow-catalog')
const LICENSE_FILES = ['license.occt-import-js.txt', 'license.occt.txt']
const DIR = dirArg ? dirArg : packaged ? join(root, 'release', 'win-unpacked', 'resources', 'models') : join(root, 'resources', 'models')
const checkPackageJson = !dirArg && !packaged

const die = (lines) => {
  console.error('\n✗ 打包中断：内置模型子集不完整或不可分发\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  重新生成：npm run nasa3d:build 出分发件 → npm run nasa3d:builtin 选内置子集写进 resources/models（≤ 15 MiB，进 git）')
  console.error('  确实要打一个不含内置模型的包：设 SATSIM_SKIP_MODELS=1 —— 客户端仍可从云端下载，但离线时模型全部退回点图标。\n')
  process.exit(1)
}

if (process.env.SATSIM_SKIP_MODELS === '1') {
  console.log('⚠ 已设 SATSIM_SKIP_MODELS=1，跳过内置模型自检。')
  console.log('⚠ 离线用户的卫星模型会全部退回点图标（云端可用时照常下载）。')
  process.exit(0)
}

const errs = []
const where = relative(root, DIR) || DIR

// ① 打包配置
if (checkPackageJson) {
  let pkg
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) } catch (e) { die([`package.json 解析失败：${e.message}`]) }
  const b = pkg.build || {}
  if (!Array.isArray(b.files) || !b.files.includes('!resources/models/**')) errs.push('① package.json 的 build.files 缺 "!resources/models/**"——内置模型会被打进 app.asar，再由 extraResources 拷一份，安装包白胖一倍')
  const er = Array.isArray(b.extraResources) ? b.extraResources : []
  if (!er.some((x) => x && x.from === 'resources/models' && x.to === 'models')) errs.push('① package.json 的 build.extraResources 缺 { "from": "resources/models", "to": "models" }——内置模型不会进安装包')
  if (!Array.isArray(b.files) || !b.files.includes('!resources/licenses/**')) errs.push('① package.json 的 build.files 缺 "!resources/licenses/**"——许可原文会被打进 app.asar（安装目录里看不见）')
  if (!er.some((x) => x && x.from === 'resources/licenses' && x.to === 'licenses')) errs.push('① package.json 的 build.extraResources 缺 { "from": "resources/licenses", "to": "licenses" }——LGPL 许可原文不在安装目录里')
  for (const f of LICENSE_FILES) {
    const p = join(root, 'resources', 'licenses', f)
    if (!existsSync(p) || statSync(p).size === 0) errs.push(`① 缺 resources/licenses/${f}（occt-import-js / OCCT 是 LGPL-2.1，随包分发必须附许可原文：从 node_modules/occt-import-js/dist/ 拷）`)
  }
}

if (!existsSync(DIR)) {
  die([...errs, `找不到 ${where}（内置模型子集还没生成）。`])
}

// ② manifest
const mPath = join(DIR, 'manifest.json')
if (!existsSync(mPath)) die([...errs, `找不到 ${where}/manifest.json。`])
let manifest
try { manifest = JSON.parse(readFileSync(mPath, 'utf8')) } catch (e) { die([...errs, `manifest.json 解析失败：${e.message}`]) }
let validated = null
try {
  const mod = await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'manifest.mjs')).href)
  validated = mod.validateManifest(manifest, { builtin: true })
} catch (e) {
  errs.push(`② 加载 packages/core/models/manifest.mjs 失败，无法校验：${e.message}`)
}
if (validated) {
  if (!validated.ok) errs.push(`② validateManifest 拒绝整份 manifest：${validated.errors.join('；')}`)
  else {
    for (const e of validated.errors) errs.push(`② ${e}`)
    const n = Array.isArray(manifest.models) ? manifest.models.length : 0
    if (validated.models.length !== n) errs.push(`② validateManifest 丢了 ${n - validated.models.length} 条（见上）`)
  }
}
const models = Array.isArray(manifest.models) ? manifest.models : []
if (!models.length) errs.push('② manifest 里一条模型都没有')

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const listFiles = (sub) => { const d = join(DIR, sub); return existsSync(d) ? readdirSync(d).filter((f) => statSync(join(d, f)).isFile()) : [] }

/** GLB 头：magic 'glTF'、版本 2、声明总长 = 文件长、首块 JSON；返回 JSON（只读前 20 + JSON 长度字节）。 */
function glbJson(p, size) {
  const buf = readFileSync(p)
  if (buf.length < 20) throw new Error('不足 20 字节')
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('magic 不是 glTF')
  if (buf.readUInt32LE(4) !== 2) throw new Error(`版本 ${buf.readUInt32LE(4)}，不是 2`)
  if (buf.readUInt32LE(8) !== size) throw new Error(`头里声明 ${buf.readUInt32LE(8)} 字节，文件 ${size} 字节`)
  const jl = buf.readUInt32LE(12)
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('首块不是 JSON')
  if (20 + jl > size) throw new Error('JSON 块越界')
  return JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'))
}

const referenced = { builtin: new Set(), thumbs: new Set() }
let withThumb = 0
for (const m of models) {
  const tag = m && m.id ? m.id : '（无 id）'
  const files = (m && m.files) || {}
  // ⑦ 授权
  const kind = m && m.source && m.source.kind
  if (!m || !m.source || m.source.redistributable !== true) errs.push(`⑦ ${tag}：source.redistributable 不是 true，不许随包分发`)
  if (kind === 'stk-local' || kind === 'user' || /^(stk|user):/.test(String(m && m.id))) errs.push(`⑦ ${tag}：${kind || m.id} 来源不许随包分发（STK 受 AGI SLA 约束；本机导入件来路不明）`)
  // ③ 随包档
  const tiers = Array.isArray(m && m.builtin) ? m.builtin : (Array.isArray(manifest.builtin) ? manifest.builtin : [])
  for (const k of tiers) {
    if (k === 'thumb') continue
    const f = files[k]
    if (!f || !SHA_RE.test(f.sha256 || '')) { errs.push(`③ ${tag}：builtin 列了 ${k}，但 files.${k} 缺或 sha256 不合法`); continue }
    const name = `${f.sha256}.glb`
    referenced.builtin.add(name)
    const p = join(DIR, 'builtin', name)
    if (!existsSync(p)) { errs.push(`③ ${tag}：缺 builtin/${name}`); continue }
    const size = statSync(p).size
    if (size !== f.bytes) errs.push(`③ ${tag}：builtin/${name} ${size} 字节，manifest 记 ${f.bytes}`)
    else if (sha256File(p) !== f.sha256) errs.push(`③ ${tag}：builtin/${name} 的 sha256 与文件名 / manifest 不符（文件坏了或被换过）`)
    try {
      const j = glbJson(p, size)
      const bad = (j.extensionsRequired || []).filter((x) => !EXT_WHITELIST.includes(x))
      if (bad.length) errs.push(`③ ${tag}：${k} 要求客户端不支持的扩展 ${bad.join('、')}`)
    } catch (e) { errs.push(`③ ${tag}：builtin/${name} 不是合法 GLB（${e.message}）`) }
  }
  // ④ 缩略图
  const t = files.thumb
  if (!t || !SHA_RE.test(t.sha256 || '')) { errs.push(`④ ${tag}：缺 files.thumb`); continue }
  withThumb++
  const tname = `${t.sha256}.webp`
  referenced.thumbs.add(tname)
  const tp = join(DIR, 'thumbs', tname)
  if (!existsSync(tp)) { errs.push(`④ ${tag}：缺 thumbs/${tname}`); continue }
  const tb = readFileSync(tp)
  if (tb.length !== t.bytes) errs.push(`④ ${tag}：thumbs/${tname} ${tb.length} 字节，manifest 记 ${t.bytes}`)
  else if (createHash('sha256').update(tb).digest('hex') !== t.sha256) errs.push(`④ ${tag}：thumbs/${tname} 的 sha256 不符`)
  if (!(tb.length >= 12 && tb.toString('ascii', 0, 4) === 'RIFF' && tb.toString('ascii', 8, 12) === 'WEBP')) errs.push(`④ ${tag}：thumbs/${tname} 不是 WebP（缺 RIFF…WEBP 头）`)
}
const thumbFiles = listFiles('thumbs').filter((f) => f.toLowerCase().endsWith('.webp'))
if (thumbFiles.length !== referenced.thumbs.size) errs.push(`④ manifest 引用 ${referenced.thumbs.size} 张不同的缩略图，thumbs/*.webp 有 ${thumbFiles.length} 个`)

// ③ 续：兜底模型随包有 lod；目录条目缺省拦下；模板条目（有的话）必须是已知模板、缩略图是否过时（只警告）
const warns = []
const byId = new Map(models.filter((m) => m && m.id).map((m) => [m.id, m]))
const lodTiersOf = (m) => (Array.isArray(m && m.builtin) ? m.builtin : (Array.isArray(manifest.builtin) ? manifest.builtin : [])).filter((k) => k !== 'thumb')
let fallbackId = null
try {
  const AM = await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'autoMatch.mjs')).href)
  fallbackId = AM.match({ name: 'SATSIM CHECK MODELS PROBE', orbitKind: 'LEO' }, {}).id
} catch (e) { errs.push(`③ 加载 packages/core/models/autoMatch.mjs 失败，无法核对兜底模型：${e.message}`) }
if (fallbackId && /^nasa:/.test(fallbackId)) {
  const fb = byId.get(fallbackId)
  if (!fb || !lodTiersOf(fb).length) errs.push(`③ ${fallbackId}（autoMatch 的兜底模型）没有随包的 lod 档——离线时匹配不上的星会全部退回点图标`)
}
const isParam = (m) => /^param:/.test(String(m && m.id)) || (m && m.source && m.source.kind === 'param')
const catalogOnly = models.filter((m) => m && m.id && !isParam(m) && !lodTiersOf(m).length)
if (catalogOnly.length && !allowCatalog) {
  errs.push(`③ ${catalogOnly.length} 条没带模型的目录条目（如 ${catalogOnly.slice(0, 3).map((m) => m.id).join('、')}）：离线时会进 3D 页 autoMatch 的可用集，` +
    '选中了却拉不下来、随包件反而轮不到（重跑 npm run nasa3d:builtin，缺省只出子集；确要随包就加 --allow-catalog）')
}
// 随包件的朝向核定（只警告）：frame.verified≠true 的件在 3D 页跟随视图里按缺省映射摆（NASA 件 = 作者 +Y 朝天顶），
// 对地天线 / 太阳翼方向未必对；核定表是 scripts/nasa3d/frame-overrides.json（build 应用）
const frameUnverified = models.filter((m) => m && !isParam(m) && lodTiersOf(m).length && !(m.frame && m.frame.verified === true))
if (frameUnverified.length) warns.push(`${frameUnverified.length} 条随包件朝向未核（frame.verified≠true）：${frameUnverified.map((m) => m.id).join('、')}`)
const params = models.filter(isParam)
if (params.length) {
  try {
    const PT = await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'paramTemplates.mjs')).href)
    const PB = await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'paramBus.mjs')).href)
    for (const m of params) {
      const tid = String(m.id).replace(/^param:/, '')
      if (!PT.TEMPLATE_IDS.includes(tid)) { errs.push(`③ ${m.id}：不是 paramTemplates 里的模板（内置层只收模板，用户另存的参数化模型不许随包）`); continue }
      if (m.specHash) {
        let cur = null
        try { cur = PB.specHash(PT.templateSpec(tid).spec) } catch { /* 模板生成不了：交给 paramBus 自己的单测 */ }
        if (cur && cur !== m.specHash) warns.push(`${m.id} 的缩略图按 specHash ${m.specHash} 出，当前模板 ${cur}（缩略图过时：重跑 nasa3d:sheets → nasa3d:builtin --templates=entries）`)
      }
    }
  } catch (e) { errs.push(`③ 加载 packages/core/models/paramTemplates.mjs 失败，无法核对模板条目：${e.message}`) }
}

// ⑧ 缩略图取景口径（见文件头）：sheets.mjs 顶层按本仓库 view.js 现算 THUMB_VIEW（node 里就能算，build / builtin 同一个数）
if (models.length) {
  let curView = null
  try { curView = (await import(pathToFileURL(join(REPO, 'scripts', 'nasa3d', 'sheets.mjs')).href)).THUMB_VIEW } catch (e) { warns.push(`加载 scripts/nasa3d/sheets.mjs 失败，没核缩略图取景口径：${e.message}`) }
  if (curView) {
    if (typeof manifest.thumbView !== 'string' || !manifest.thumbView) warns.push('manifest 没记 thumbView（旧版 nasa3d:builtin 出的）：核不了随包缩略图是不是按当前显示系出的——重跑 npm run nasa3d:builtin 补上')
    else if (manifest.thumbView !== curView) errs.push(`⑧ 随包缩略图的取景口径 ${manifest.thumbView} ≠ 当前 ${curView}：显示系（src/viz/models/view.js）或取景法换过、缩略图没重出（会上下颠倒 / 朝向不对）——重跑 npm run nasa3d:sheets → nasa3d:build → nasa3d:builtin`)
  }
}
// ⑨ 随包 NASA 件的朝向 = 当前核定表（见文件头）
{
  const nasa = models.filter((m) => m && /^nasa:/.test(String(m.id)) && lodTiersOf(m).length)
  if (nasa.length) {
    try {
      const B = await import(pathToFileURL(join(REPO, 'scripts', 'nasa3d', 'build.mjs')).href)
      const BF = await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'bodyFrame.mjs')).href)
      const ov = B.parseFrameOverrides(JSON.parse(readFileSync(B.FRAME_OVERRIDES_FILE, 'utf8')))
      const drift = []
      for (const m of nasa) {
        const want = B.resolveFrame(m.id, ov).frame
        const f = m.frame || {}
        const q = Array.isArray(f.q_model2body) && f.q_model2body.length === 4 ? f.q_model2body : null
        const d = q ? BF.quatAngleDeg(q, want.q_model2body) : Infinity
        if (!(d <= 1e-3) || (f.verified === true) !== want.verified) drift.push(`${m.id}（随包 ${q ? `[${q.map((v) => +(+v).toFixed(4)).join(', ')}]` : '无 q'}${f.verified === true ? ' 已核' : ' 未核'} → 核定表 [${want.q_model2body.map((v) => +v.toFixed(4)).join(', ')}]${want.verified ? ' 已核' : ' 缺省'}）`)
      }
      if (drift.length) {
        const msg = `${drift.length} 条随包件的朝向与 scripts/nasa3d/frame-overrides.json 对不上：${drift.join('；')}——重跑 npm run nasa3d:build → nasa3d:sheets → nasa3d:build → nasa3d:builtin`
        if (dirArg) warns.push(msg); else errs.push(`⑨ ${msg}`)
      }
    } catch (e) { warns.push(`核不了随包件朝向与 frame-overrides.json（${e.message}）`) }
  }
}

// --online：源 build 的云端快照已发布（见文件头）
let onlineNote = ''
if (online) {
  let cdn = process.env.SATSIM_CHECK_MODELS_CDN || ''
  if (!cdn) {
    try { cdn = (await import(pathToFileURL(join(REPO, 'packages', 'core', 'models', 'manifest.mjs')).href)).CDN_BASE } catch (e) { errs.push(`在线 加载 CDN_BASE 失败：${e.message}`) }
  }
  const sid = typeof manifest.sourceBuildId === 'string' ? manifest.sourceBuildId : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sid)) errs.push('在线 内置 manifest 没有合法的 sourceBuildId（重跑 npm run nasa3d:builtin）')
  else if (cdn) {
    const url = `${cdn.replace(/\/?$/, '/')}manifest.${sid}.json`
    let status = 0, why = ''
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 15000)
      try { status = (await fetch(url, { method: 'HEAD', signal: ac.signal, cache: 'no-store' })).status } finally { clearTimeout(t) }
    } catch (e) { why = (e && e.name === 'AbortError') ? '15 s 超时' : ((e && e.cause && e.cause.code) || (e && e.message) || String(e)) }
    if (status === 200) onlineNote = ` · 云端快照 manifest.${sid}.json 已发布`
    else errs.push(`在线 云端没有 manifest.${sid}.json（${status ? `HTTP ${status}` : why}）：先 npm run nasa3d:publish 把这批分发件传上云，再打包——否则装上后联网升档（lod0 / lod1）一律 404`)
  }
}

// ⑤ 孤儿
for (const [sub, set] of Object.entries(referenced)) {
  for (const f of listFiles(sub)) if (!set.has(f)) errs.push(`⑤ ${sub}/${f} 没被 manifest 引用（残留文件，删掉或重跑 nasa3d:builtin）`)
}
for (const f of readdirSync(DIR)) {
  if (!['manifest.json', 'builtin', 'thumbs'].includes(f)) errs.push(`⑤ ${where}/${f} 不该出现在内置模型目录里`)
}

// ⑥ 总量
let total = 0
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else total += s.size } }
walk(DIR)
const mib = (n) => (n / 1024 / 1024).toFixed(2)
if (total > CAP) errs.push(`⑥ 总量 ${mib(total)} MiB（${total} 字节）超过上限 15 MiB（${CAP} 字节）`)

if (errs.length) die(errs)
for (const w of warns) console.log(`⚠ ${w}`)
const withLod = models.filter((m) => Array.isArray(m.builtin) && m.builtin.some((k) => k !== 'thumb')).length
console.log(`✓ 内置模型就绪：${models.length} 条（随包带模型 ${withLod} 条）· ${withThumb} 条有缩略图（${referenced.thumbs.size} 张）· ${mib(total)} MiB / 15 MiB（${total} / ${CAP} 字节）${onlineNote}`)
console.log(`  随包路径：build.extraResources → resources/models（不进 app.asar，见 package.json）${packaged ? ' · 已查打包产物' : ''}`)
