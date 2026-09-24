// NASA 3D 离线管线（scripts/nasa3d/build.mjs · publish.mjs · scripts/lib/cos.mjs · scripts/check-models.mjs）的单测。
// 不联网：COS 请求全部由替身 https.request 接住；模型处理只用 fixtures/models 下的 6 个 NASA 小件，不碰 .models-src。
// 不联网：check-models --online 的测试指到本机 127.0.0.1 的假服务（SATSIM_CHECK_MODELS_CDN）。
// 运行：node packages/core/test/modelPipeline.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import https from 'node:https'
import util from 'node:util'
import { Writable, Readable } from 'node:stream'
import { spawnSync, execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const FIX = path.join(HERE, 'fixtures', 'models')
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href)

const B = await imp('scripts/nasa3d/build.mjs')
const BF = await imp('packages/core/models/bodyFrame.mjs')
const P = await imp('scripts/nasa3d/publish.mjs')
const COS = await imp('scripts/lib/cos.mjs')
const LIB = await imp('scripts/nasa3d/lib.mjs')
let SCHEMA = null, MANIFEST = null, UNITS = null, PT = null, PB = null
try { SCHEMA = await imp('packages/core/models/schema.mjs') } catch { /* W1 未就绪时跳过交叉核对 */ }
try { PT = await imp('packages/core/models/paramTemplates.mjs'); PB = await imp('packages/core/models/paramBus.mjs') } catch { /* W3 未就绪时跳过模板覆盖 */ }
// 用作样本的 GEO 模板：默认卫星（paramTemplates.DEFAULT_TEMPLATE_ID）；模板表万一不含它就取第一项，不写死一个可能下架的 id
const TPL_GEO = PT ? ([PT.DEFAULT_TEMPLATE_ID].find((t) => PT.TEMPLATE_IDS.includes(t)) || PT.TEMPLATE_IDS[0]) : 'default-sat'
try { MANIFEST = await imp('packages/core/models/manifest.mjs') } catch { /* 同上 */ }
try { UNITS = await imp('packages/core/models/units.mjs') } catch { /* 同上 */ }

let n = 0
const ok = (cond, msg) => { assert.ok(cond, msg); n++ }
const eq = (a, b, msg) => { assert.equal(a, b, msg); n++ }
const deq = (a, b, msg) => { assert.deepEqual(a, b, msg); n++ }
const near = (a, b, tol, msg) => { assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`); n++ }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'satsim-modelpipe-'))

// ─────────────────────────────── ① 文件排序与 id（DESIGN §3.5） ───────────────────────────────
{
  const files = ['Cassini-Huygens (A) (without Hyugens).glb', 'Cassini-Huygens (A).glb', 'Cassini-Huygens (A) (without Cassini).glb']
  deq(B.sortModelFiles(files), ['Cassini-Huygens (A).glb', 'Cassini-Huygens (A) (without Cassini).glb', 'Cassini-Huygens (A) (without Hyugens).glb'], '主名比较：无后缀的主文件排第一')
  const ids = B.modelIdsForEntry('cassini-huygens-a', files)
  deq(ids.map((x) => x.id), ['nasa:cassini-huygens-a', 'nasa:cassini-huygens-a~2', 'nasa:cassini-huygens-a~3'], 'id：第 1 个无后缀，之后 ~2 ~3')
  deq(ids.map((x) => x.dir), ['cassini-huygens-a', 'cassini-huygens-a~2', 'cassini-huygens-a~3'], '输出目录同 id')
  ok(ids[0].primary && !ids[1].primary, 'primary 只给第一个')
  deq(B.modelIdsForEntry('mars-global-surveyor', ['Mars Global Surveyor (launch).glb', 'Mars Global Surveyor.glb', 'Mars Global Surveyor (MOI).glb']).map((x) => x.file),
    ['Mars Global Surveyor.glb', 'Mars Global Surveyor (MOI).glb', 'Mars Global Surveyor (launch).glb'], '逐码元比较（大写先于小写），不随系统区域设置变')
  assert.throws(() => B.modelIdsForEntry('../evil', ['x.glb']), /不安全的 slug/); n++
  if (SCHEMA) for (const x of ids) ok(SCHEMA.isValidModelId(x.id), `W1 schema 认 ${x.id}`)
}

// ─────────────────────────────── ② 单位：包围盒规则 / 吸附 / 已知尺寸反算 ───────────────────────────────
{
  const g = B.guessUnitsFromSpan
  deq(g(0.29), { unitGuess: 'unknown', scaleToMeters: 1 }, '< 0.3 认不出')
  deq(g(0.3), { unitGuess: 'm', scaleToMeters: 1 }, '0.3 起按米')
  deq(g(300), { unitGuess: 'm', scaleToMeters: 1 }, '300 仍按米')
  deq(g(300.5), { unitGuess: 'cm', scaleToMeters: 0.01 }, '300–3000 按厘米')
  deq(g(3000), { unitGuess: 'mm', scaleToMeters: 0.001 }, '3000 起按毫米')
  deq(g(300000), { unitGuess: 'mm', scaleToMeters: 0.001 }, '300000 仍按毫米')
  deq(g(300001), { unitGuess: 'unknown', scaleToMeters: 1 }, '> 300000 认不出')
  deq(g(NaN), { unitGuess: 'unknown', scaleToMeters: 1 }, 'NaN')
  if (UNITS && typeof UNITS.guessUnits === 'function') {
    for (const s of [0.1, 0.3, 5, 299.9, 300, 301, 2999, 3000, 26053.8, 300000, 5e5]) {
      const w = UNITS.guessUnits({ bboxSpanModelUnits: s })
      const m = g(s)
      ok(w.unitGuess === m.unitGuess && w.scaleToMeters === m.scaleToMeters, `与 units.mjs 包围盒规则一致：${s} → ${m.unitGuess}`)
    }
  }
  const s = B.snapScale
  deq([s(1.0409).unitGuess, s(1.0409).scaleToMeters], ['m', 1], 'Cassini 1.041 吸附到米')
  deq([s(0.2985).unitGuess, s(0.2985).scaleToMeters], ['ft', 0.3048], '0.2985 吸附到英尺')
  deq([s(0.025119).unitGuess, s(0.025119).scaleToMeters], ['in', 0.0254], 'Hubble 0.0251 吸附到英寸')
  eq(s(0.0894419).unitGuess, 'unknown', 'SSL-1300 0.0894 不吸附')
  eq(s(0.0894419).scaleToMeters, 0.0894419, '不吸附时保留原比值')
  eq(s(1.0999).unitGuess, 'm', '10 % 以内吸附')
  eq(s(1.1001).unitGuess, 'unknown', '超 10 % 不吸附')
  if (UNITS && typeof UNITS.scaleFromKnownDim === 'function') {
    // 管线是「自动推断作者单位」，对应 units.mjs 的 INFER_SNAP 口径（guessUnits 的已知尺寸一档 / scaleFromKnownDim 显式传窗口）；
    // scaleFromKnownDim 缺省不吸附，那是工作台「反算」按钮照用户给的原值——两边刻意不同，下面最后一条钉住
    eq(B.SNAP_TOLERANCE, UNITS.INFER_SNAP, '吸附窗口与 units.mjs 的 INFER_SNAP 相同')
    for (const [meas, known] of [[6.533, 6.8], [268.331, 24], [525.489, 13.2], [0.8866, 17.3], [3.2, 3], [72.9267, 73]]) {
      const w = UNITS.scaleFromKnownDim({ measuredModelUnits: meas, knownMeters: known, snapTolerance: UNITS.INFER_SNAP })
      const m = s(known / meas)
      ok(Math.abs(w.scaleToMeters - m.scaleToMeters) < 1e-12 && w.unitGuess === m.unitGuess && w.snapped === m.snapped, `与 units.mjs 反算（INFER_SNAP）一致：${known}/${meas}`)
      if (typeof UNITS.guessUnits === 'function') {
        const g2 = UNITS.guessUnits({ headerHints: { knownDim: { measuredModelUnits: meas, knownMeters: known, source: 'https://x' } } })
        ok(Math.abs(g2.scaleToMeters - m.scaleToMeters) < 1e-12 && g2.unitGuess === m.unitGuess, `与 units.mjs guessUnits 已知尺寸档一致：${known}/${meas}`)
      }
    }
    const raw = UNITS.scaleFromKnownDim({ measuredModelUnits: 6.533, knownMeters: 6.8 })
    ok(raw.snapped === false && Math.abs(raw.scaleToMeters - 6.8 / 6.533) < 1e-12 && s(6.8 / 6.533).snapped === true, 'units.mjs 缺省不吸附（工作台口径），管线按 INFER_SNAP 吸附到米')
  }

  const kdLong = { measure: 'span', valueM: 24, source: 'https://example.org/a', fit: 'longest' }
  const d1 = B.deriveScale(kdLong, [268.331, 61.27, 80.37], { file: 'a.glb', primary: true })
  ok(d1.ok && d1.fit.mode === 'longest' && Math.abs(d1.fit.rawScale - 24 / 268.331) < 1e-12, 'longest：最长边反算')
  eq(d1.sizeVerified, true, '有出处 → sizeVerified')
  eq(d1.sizeSource, 'https://example.org/a', 'sizeSource = 出处')
  const d2 = B.deriveScale({ measure: 'length', valueM: 0.1135, source: 'https://x', fit: { axis: 'y' } }, [5.1928, 2.6015, 2.1971], { primary: true })
  near(d2.scaleToMeters, 0.1135 / 2.6015, 1e-12, 'axis：取该轴全长（CubeSat 1U 本体 y 轴）')
  eq(d2.fit.axis, 'y', 'fit 记轴')
  const kdPart = { measure: 'bus', valueM: 3.5, source: 'https://x', fit: { axis: 'y', extentNative: 3.44 }, bboxNative: [8.527, 8.527, 5.0002] }
  const d3 = B.deriveScale(kdPart, [8.527, 8.527, 5.0002], { primary: true })
  ok(d3.ok && d3.fit.mode === 'part' && d3.fit.extentModel === 3.44, 'part：用研究时量得的部件跨度')
  const d4 = B.deriveScale(kdPart, [8.527, 8.527, 5.2], { primary: true })
  ok(!d4.ok && /不作数/.test(d4.reason), 'part：包围盒与研究时相差 > 0.5 % → 拒用')
  eq(B.deriveScale(kdLong, [1, 2, 3], { primary: false }), null, '多文件条目：kd 没点名文件时只管主文件')
  const kdInh = { measure: 'height', valueM: 6.8, source: 'https://x', fit: { axis: 'y', extentNative: 6.533 }, bboxNative: [17.983, 11.6626, 13.1065], file: 'C.glb', inherit: true }
  const main = B.deriveScale(kdInh, [17.983, 11.6626, 13.1065], { file: 'C.glb' })
  const other = B.deriveScale(kdInh, [1, 2.6, 2.6], { file: 'C (without Cassini).glb', inherited: main })
  ok(other.ok && other.scaleToMeters === main.scaleToMeters && other.fit.inheritedFrom === 'C.glb', 'inherit：同条目其余文件沿用同一比例')
  eq(B.deriveScale({ ...kdInh, inherit: false }, [1, 2, 3], { file: 'other.glb', inherited: main }), null, '没开 inherit 就不沿用')
  eq(B.deriveScale({ valueM: 3, fit: 'longest' }, [1, 1, 1]), null, '没有出处的条目不用')
  const r1 = B.resolveUnits(kdPart, [8.527, 8.527, 5.2], { primary: true })
  ok(r1.units.sizeVerified === false && r1.reject && r1.units.unitGuess === 'm', 'resolveUnits：known-dims 被拒 → 退回包围盒规则并记原因')
  const r2 = B.resolveUnits(null, [26053.8, 1, 1])
  deq(r2.units, { scaleToMeters: 0.001, unitGuess: 'mm', sizeVerified: false }, 'resolveUnits：没有已知尺寸 → 包围盒规则')
}

// ─────────────────────────────── ③ 数据表：known-dims / kind-overrides / titles-zh ───────────────────────────────
const knownDims = JSON.parse(fs.readFileSync(B.KNOWN_DIMS_FILE, 'utf8'))
const kindOverrides = JSON.parse(fs.readFileSync(B.KIND_OVERRIDES_FILE, 'utf8'))
const titlesZh = JSON.parse(fs.readFileSync(B.TITLES_ZH_FILE, 'utf8'))
const include = LIB.loadIncludeList()
const seven = include.entries.filter((e) => B.MODEL_GROUPS.includes(e.group))
{
  const kdKeys = Object.keys(knownDims).filter((k) => !k.startsWith('$'))
  ok(kdKeys.length >= 40, `known-dims ≥ 40 条（实有 ${kdKeys.length}）`)
  const slugs = new Set(seven.map((e) => e.slug))
  let bad = []
  for (const k of kdKeys) {
    const e = knownDims[k]
    if (!slugs.has(k)) bad.push(`${k}：不在七组里`)
    if (!(e.valueM > 0) || !['span', 'length', 'height', 'diameter', 'bus'].includes(e.measure)) bad.push(`${k}：量纲 / 数值`)
    if (!/^https?:\/\//.test(e.source || '') || !(e.sourceQuote || '').trim()) bad.push(`${k}：缺出处或引文`)
    if (typeof e.deployed !== 'boolean') bad.push(`${k}：deployed`)
    const f = e.fit
    if (!(f === 'longest' || (f && (['x', 'y', 'z'].includes(f.axis) || Number.isFinite(f.extentNative))))) bad.push(`${k}：fit`)
    if (f && Number.isFinite(f.extentNative) && !Array.isArray(e.bboxNative)) bad.push(`${k}：部件跨度缺 bboxNative`)
  }
  deq(bad, [], 'known-dims 每条都有量纲、正数值、http 出处、引文与合法 fit')
  eq(seven.length, 181, '七组 181 条')
  const kinds = new Set(['spacecraft', 'deepspace', 'station', 'component', 'ground', 'crewed', 'launcher'])
  bad = seven.filter((e) => !kinds.has(kindOverrides[e.slug])).map((e) => e.slug)
  deq(bad, [], 'kind-overrides 覆盖 181 条且都是七类之一')
  bad = seven.filter((e) => typeof titlesZh[e.slug] !== 'string' || !titlesZh[e.slug].trim()).map((e) => e.slug)
  deq(bad, [], 'titles-zh 覆盖 181 条')
  bad = Object.keys(titlesZh).filter((k) => !k.startsWith('$') && (!slugs.has(k.split('/')[0]) || (k.includes('/') && !/\.glb$/.test(k))))
  deq(bad, [], 'titles-zh 的键都是 slug 或 slug/文件名.glb')
  ok(!Object.entries(titlesZh).some(([k, v]) => !k.startsWith('$') && /[()]|地面站/.test(v)), '中文名里括注一律全角、没有「地面站」')
  eq(titlesZh['tracking-and-data-relay-satellites-tdrs-a'], '跟踪与数据中继卫星（TDRS-A）', 'TDRS-A 中文名')
  eq(titlesZh['hubble-space-telescope-a'], '哈勃空间望远镜（A 版）', '哈勃中文名')
  // W17 修订（2026-09-24）：TDRS-D 按新一代翼展收录、aqua-a 核实为 Aqua 保留、Satellite Kit 明确不收
  const td = knownDims['tracking-and-data-relay-satellites-tdrs-d']
  ok(td && td.valueM === 21 && td.fit === 'longest' && /2002-011A/.test(td.source) && /21 m/.test(td.sourceQuote), 'known-dims：TDRS-D 按新一代（第二代）翼展 21 m、最长边')
  ok(!(knownDims.$skipped || {})['tracking-and-data-relay-satellites-tdrs-d'], 'known-dims：TDRS-D 不再列在 $skipped')
  ok(knownDims['aqua-a'] && knownDims['aqua-a'].valueM === 16.7 && /Aqua \(A\)\.glb/.test(knownDims['aqua-a'].note), 'known-dims：aqua-a 保留（核实为 Aqua，说明写进 note）')
  ok(!Object.keys(knownDims).some((k) => k.startsWith('satellite-kit')) && /通用部件/.test((knownDims.$skipped || {})['satellite-kit'] || ''), 'known-dims：Satellite Kit 不收，$skipped 写明理由')
  {
    // TDRS-D 的反算：模型最长边（原生 3.022）↔ 21 m，比例离所有标准单位都远 → 不吸附、照原比值
    const u = B.resolveUnits(td, [1.7110788822174072, 0.9144180715084076, 3.022411346435547], { primary: true })
    ok(u.units.sizeVerified && u.units.unitGuess === 'unknown' && Math.abs(u.units.scaleToMeters * 3.022411346435547 - 21) < 1e-9, `TDRS-D：最长边缩放后 = 21 m（比例 ${u.units.scaleToMeters.toFixed(4)}）`)
  }
}

// ─────────────────────────────── ③-b 本体朝向：frame-overrides.json 与纯函数（W17，轴映射终案 ②） ───────────────────────────────
{
  // 缺省：NASA 件取 +Y 天顶（Q_YUP_ZENITH），经 defaultImportQ 取，与 schema 兜底同一个数
  deq(B.NASA_DEFAULT_Q, [...BF.Q_YUP_ZENITH], '管线 NASA 缺省 q = Q_YUP_ZENITH')
  deq(B.NASA_DEFAULT_Q, BF.defaultImportQ({ sourceKind: 'nasa' }), '管线 NASA 缺省 q = defaultImportQ(nasa)')
  ok(Object.isFrozen(B.NASA_DEFAULT_Q), 'NASA_DEFAULT_Q 冻结')
  // parseFrameOverrides：好条目、坏条目逐条拦、axes 与 q 一致性、skipped 与 entries 冲突
  const qa = BF.quatFromBodyAxes('+Y', '+Z')
  const P = B.parseFrameOverrides({
    schema: 1,
    entries: {
      'nasa:good': { q: qa, axes: { nadir: '+Y', velocity: '+Z' }, basis: 'visual+资料', note: 'n', refs: ['https://x'] },
      'nasa:good~2': { q: qa.map((v) => -v), basis: 'visual', refs: [] },
      'nasa:noaxes': { q: [0, 0, 0, 1], basis: 'visual' },
      'nasa:BAD': { q: [0, 0, 0, 1], basis: 'x' },
      'param:x': { q: [0, 0, 0, 1], basis: 'x' },
      'nasa:notunit': { q: [0, 0, 0, 1.01], basis: 'x' },
      'nasa:short': { q: [0, 0, 1], basis: 'x' },
      'nasa:nan': { q: [0, 0, NaN, 1], basis: 'x' },
      'nasa:nobasis': { q: [0, 0, 0, 1], basis: ' ' },
      'nasa:badrefs': { q: [0, 0, 0, 1], basis: 'x', refs: 'https://x' },
      'nasa:axesmismatch': { q: [0, 0, 0, 1], basis: 'x', axes: { nadir: '+Y', velocity: '+Z' } },
      'nasa:axesbad': { q: [0, 0, 0, 1], basis: 'x', axes: { nadir: '+Y', velocity: '+Y' } },
      'nasa:arr': [1, 2],
      'nasa:tilde1~1': { q: [0, 0, 0, 1], basis: 'x' },
      'nasa:tilde0~0': { q: [0, 0, 0, 1], basis: 'x' },
      'nasa:tilde01~01': { q: [0, 0, 0, 1], basis: 'x' },
      'nasa:tilde10~10': { q: [0, 0, 0, 1], basis: 'visual' }
    },
    skipped: { 'nasa:mir': '姿态多变', 'nasa:good': '冲突', 'oops': 'x', 'nasa:mir~1': 'x' }
  })
  deq([...P.entries.keys()].sort(), ['nasa:good', 'nasa:good~2', 'nasa:noaxes', 'nasa:tilde10~10'], 'parseFrameOverrides：只收合法条目（含 ~n 派生件、没有 axes 的）')
  deq(P.entries.get('nasa:good~2').q, qa, 'parseFrameOverrides：q 符号规范化（w ≥ 0）')
  deq(P.entries.get('nasa:good').axes, { nadir: '+Y', velocity: '+Z' }, 'parseFrameOverrides：axes 原样带出')
  eq(P.entries.get('nasa:noaxes').axes, null, '没给 axes → null')
  deq([...P.skipped.keys()], ['nasa:mir'], 'parseFrameOverrides：skipped 收合法 id；与 entries 冲突的以 entries 为准')
  for (const [id, frag] of [['nasa:BAD', 'id'], ['param:x', 'id'], ['nasa:notunit', '单位四元数'], ['nasa:short', '4 个有限数'], ['nasa:nan', '4 个有限数'], ['nasa:nobasis', 'basis'], ['nasa:badrefs', 'refs'], ['nasa:axesmismatch', '不一致'], ['nasa:axesbad', '解不出'], ['nasa:arr', '不是对象'], ['nasa:good', '既在'], ['skipped oops', 'id'], ['nasa:tilde1~1', 'id'], ['nasa:tilde0~0', 'id'], ['nasa:tilde01~01', 'id'], ['skipped nasa:mir~1', 'id']]) {
    ok(P.errors.some((e) => e.startsWith(id) && e.includes(frag)), `parseFrameOverrides：${id} → 报「${frag}」`)
  }
  deq(B.parseFrameOverrides(null).errors, ['frame-overrides.json 不是对象'], 'parseFrameOverrides：非对象 → 一条错误不抛')
  deq(B.parseFrameOverrides([]).entries.size, 0, 'parseFrameOverrides：数组 → 空')
  deq(B.parseFrameOverrides({}).errors, [], 'parseFrameOverrides：空表 → 无错')
  // resolveFrame：覆盖 → verified、缺省 → +Y 天顶未核；返回新数组
  const f1 = B.resolveFrame('nasa:good', P)
  deq(f1, { frame: { q_model2body: qa, t_model2body: [0, 0, 0], verified: true }, how: 'override' }, 'resolveFrame：覆盖表有 → q 覆盖、verified')
  const f2 = B.resolveFrame('nasa:other', P)
  deq(f2, { frame: { q_model2body: [...BF.Q_YUP_ZENITH], t_model2body: [0, 0, 0], verified: false }, how: 'default' }, 'resolveFrame：没有 → +Y 天顶、未核')
  f2.frame.q_model2body[0] = 9; f1.frame.q_model2body[0] = 9
  ok(B.NASA_DEFAULT_Q[0] === BF.Q_YUP_ZENITH[0] && P.entries.get('nasa:good').q[0] === qa[0], 'resolveFrame：返回新数组，改它不污染缺省与覆盖表')
  deq(B.resolveFrame('nasa:good', null).how, 'default', 'resolveFrame：覆盖表缺 → 缺省')

  // 真覆盖表（scripts/nasa3d/frame-overrides.json）：能解析、零坏条目；每条 id 都在语料里；q 与 axes 一致且是 24 个轴对齐朝向之一；
  // 有依据与出处；复核图路径写在 note 里；skipped 都写了原因；builtin 子集里的 NASA 件要么核过、要么写了不校正的原因
  const FO = JSON.parse(fs.readFileSync(B.FRAME_OVERRIDES_FILE, 'utf8'))
  const PO = B.parseFrameOverrides(FO)
  deq(PO.errors, [], 'frame-overrides.json：零坏条目')
  ok(PO.entries.size >= 80, `frame-overrides.json：核过 ≥ 80 条（实有 ${PO.entries.size}）`)
  // 精确 id（不只比 slug）：include-list 每条的直链去掉借用别条的（sharedGlbUrls / borrowedOwner，与 fetch 同一判据）→ 文件名 →
  // modelIdsForEntry，与 build 出 id 同一个函数。~n 超出该条文件数、写成 ~1 之类的都对不上。
  const sharedAll = LIB.sharedGlbUrls(include.entries)
  const corpusIds = new Set()
  for (const e of include.entries) {
    const names = [...new Set((e.glbs || []).filter((g) => !LIB.borrowedOwner(sharedAll, e.slug, g.url)).map((g) => LIB.fileNameFromUrl(g.url)))]
    for (const it of B.modelIdsForEntry(e.slug, names)) corpusIds.add(it.id)
  }
  ok(corpusIds.has('nasa:satellite-kit~9') && !corpusIds.has('nasa:satellite-kit~10') && corpusIds.has('nasa:aquarius-b~2') && !corpusIds.has('nasa:aqua-a~2') && !corpusIds.has('nasa:rosetta'),
    '语料 id 表：多文件条目按文件数出 ~n；借用别条的直链不算（aqua-a 的 Aquarius 件、rosetta 的 IBEX 件）')
  deq([...PO.entries.keys(), ...PO.skipped.keys()].filter((id) => !corpusIds.has(id)), [], 'frame-overrides.json：每个 id（含 ~n）都是语料里真有的模型 id')
  const isSigned = (q) => { const R = BF.quatToMat(q); return R.every((row) => row.every((v) => Math.abs(v - Math.round(v)) < 1e-12)) }
  let badQ = []
  for (const [id, e] of PO.entries) {
    if (!isSigned(e.q)) badQ.push(`${id}：不是轴对齐朝向`)
    if (!e.axes) badQ.push(`${id}：缺 axes`)
    if (!/^visual\+/.test(e.basis)) badQ.push(`${id}：basis`)
    if (!e.refs.length || !e.refs.every((r) => /^https:\/\//.test(r))) badQ.push(`${id}：refs`)
    if (!new RegExp(`\\.modelharness/w17/review/${id.slice(5)}\\.png`).test(e.note)) badQ.push(`${id}：note 里没有复核图路径`)
  }
  deq(badQ, [], 'frame-overrides.json：全是轴对齐朝向、带 axes / 依据 / https 出处 / 复核图路径')
  deq([...PO.skipped].filter(([, why]) => !why.trim()).map(([id]) => id), [], 'frame-overrides.json：skipped 每条都写了原因')
  // 随包子集从 resources/models/manifest.json 现读（不手抄名单）：子集换了件、新件没进覆盖表也没写不校正原因 → 这里红
  const bundled = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'manifest.json'), 'utf8'))
  const subsetNasa = (Array.isArray(bundled.models) ? bundled.models : []).map((m) => m && m.id).filter((id) => typeof id === 'string' && id.startsWith('nasa:'))
  ok(subsetNasa.length > 0, `随包子集里有 NASA 件（实有 ${subsetNasa.length}）`)
  deq(subsetNasa.filter((id) => !PO.entries.has(id) && !PO.skipped.has(id)), [], 'frame-overrides.json：随包子集的 NASA 件逐个有结论（核过或写明不校正）')
  // 物理口径抽查（任务书点名的几件）：天底 / 速度 / 翼轴落到本体系哪里
  const ax = (id) => PO.entries.get(id).axes
  const rot = (id, v) => BF.quatRotate(PO.entries.get(id).q, v).map((x) => Math.round(x))
  deq(ax('nasa:international-space-station-iss-d-igoal'), { nadir: '-Y', velocity: '+X' }, 'ISS-D：XVV（天底 = 模型 −Y、速度 = 模型 +X）')
  deq(rot('nasa:international-space-station-iss-d-igoal', [0, 0, 1]), [0, 1, 0], 'ISS-D：主桁架（模型 Z）→ 本体 ±Y')
  deq(rot('nasa:tracking-and-data-relay-satellites-tdrs-d', [0, 0, 1]).map(Math.abs), [0, 1, 0], 'TDRS-D：翼（模型 Z）→ 本体 ±Y（南北）')
  deq(rot('nasa:tracking-and-data-relay-satellites-tdrs-d', [0, 1, 0]), [0, 0, 1], 'TDRS-D：SA / MA 面（模型 +Y）→ 天底')
  deq(rot('nasa:geostationary-operational-environmental-satellites', [-1, 0, 0]), [0, 1, 0], 'GOES：单翼（模型 −X）→ 本体 +Y')
  deq(rot('nasa:hubble-space-telescope-a', [0, 1, 0]), [0, 0, -1], 'Hubble：口径（模型 +Y）→ −Z（天文台约定）')
  deq(rot('nasa:chandra-x-ray-observatory', [-1, 0, 0]), [0, 0, -1], 'Chandra：口径（模型 −X）→ −Z')
  ok(/惯性指向星按此显示约定/.test(PO.entries.get('nasa:hubble-space-telescope-a').note), '天文台条目的 note 写明「惯性指向星按此显示约定」')
}

// ─────────────────────────────── ④ kind / 标题 / 标签 / 署名 ───────────────────────────────
{
  const k = B.inferKindFromTitle
  eq(k('International Space Station (ISS) (A)'), 'station', '空间站')
  eq(k('Saturn V'), 'launcher', '运载火箭')
  eq(k('Atlas 6 (Friendship 7)'), 'launcher', 'Atlas')
  eq(k('Apollo Lunar Module'), 'crewed', '载人')
  eq(k('Deep Space Network 34-meter'), 'ground', '深空网')
  eq(k('Cosmic Origins Spectrograph'), 'component', '仪器')
  eq(k('Mars Reconnaissance Orbiter (MRO) (A)'), 'deepspace', '火星')
  eq(k('Tracking and Data Relay Satellites (TDRS) (A)'), 'spacecraft', '卫星')
  eq(k('Argo'), 'other', '推不出 → other')
  deq(B.resolveKind('x', 'Saturn V', 'spacecraft', { x: 'launcher' }), { kind: 'launcher', how: 'override' }, 'override 优先')
  deq(B.resolveKind('x', 'Saturn V', 'crewed', {}), { kind: 'crewed', how: 'group' }, 'include-list 七组次之')
  deq(B.resolveKind('x', 'Saturn V', 'unclassified', {}), { kind: 'launcher', how: 'keyword' }, '最后才用关键词')

  eq(B.titleForFile('Satellite Kit', 'Satellite Kit wings 2.glb', true), 'Satellite Kit wings 2', '文件名带条目名 → 用文件主名')
  eq(B.titleForFile('Space Shuttle Parts', 'External tank.glb', true), 'Space Shuttle Parts · External tank', '文件名不带条目名 → 前缀条目标题')
  eq(B.titleForFile('Cassini-Huygens (A)', 'Cassini-Huygens (A) (without Cassini).glb', true), 'Cassini-Huygens (A) (without Cassini)', '比较时去掉条目标题末尾括注')
  eq(B.titleForFile('Terra', 'Terra.glb', false), 'Terra', '单文件条目 = 条目标题')
  const tz = { a: '甲', 'a/f2.glb': '甲（二）' }
  eq(B.resolveTitleZh('a', 'f1.glb', { primary: true, multi: true }, tz), '甲', '主文件用条目中文名')
  eq(B.resolveTitleZh('a', 'f2.glb', { primary: false, multi: true }, tz), '甲（二）', '文件键优先')
  eq(B.resolveTitleZh('a', 'f3.glb', { primary: false, multi: true }, tz), '甲（f3）', '派生件没键 → 条目中文名 +（文件主名）')
  eq(B.resolveTitleZh('b', 'x.glb', {}, tz), null, '都没有 → null')

  const t1 = B.buildTagsAliases('Tracking and Data Relay Satellites (TDRS) (A)', 'tracking-and-data-relay-satellites-tdrs-a', { kind: 'spacecraft', group: 'spacecraft' })
  ok(t1.tags.includes('tracking') && t1.tags.includes('relay') && !t1.tags.includes('and') && !t1.tags.includes('a'), 'tags：拆词去停用词与单字母')
  ok(t1.aliases.includes('TDRS') && t1.aliases.includes('TDRSS') && !t1.aliases.includes('A'), 'aliases：括注缩写 + 常用别名，不收版本字母')
  const t2 = B.buildTagsAliases('TOPEX/Poseidon', 'topex-poseidon', { kind: 'spacecraft' })
  ok(t2.aliases.includes('TOPEX') && t2.aliases.includes('T/P'), 'aliases：斜杠两边')
  const t3 = B.buildTagsAliases('Aquarius (B) (compact)', 'aquarius-b', { kind: 'spacecraft' })
  ok(!t3.aliases.includes('compact'), 'aliases：小写状态描述不算别名')
  const t4 = B.buildTagsAliases('Hubble Space Telescope (A)', 'hubble-space-telescope-a', { kind: 'spacecraft' })
  ok(t4.aliases.includes('HST'), 'aliases：HST')
  eq(new Set(t1.aliases.map((a) => a.toLowerCase())).size, t1.aliases.length, 'aliases 不分大小写去重')
  eq(B.nasaCredit(['NASA/Ames Research Center']), 'NASA', '全是 NASA → NASA')
  eq(B.nasaCredit(['DigitalSpace Corporation']), 'NASA / DigitalSpace Corporation', '第三方贡献者保留署名')
  eq(B.nasaCredit([]), 'NASA', '没写贡献者 → NASA')
}

// ─────────────────────────────── ⑤ 几何统计 / 折痕法线 / 材质卫生（合成网格） ───────────────────────────────
const { Document } = await import('@gltf-transform/core')
const F = await import('@gltf-transform/functions')
function cubeDoc({ openFace = false, scale = 1 } = {}) {
  const doc = new Document()
  const buf = doc.createBuffer()
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v * 0.5 * scale)
  let idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]
  if (openFace) idx = idx.slice(6)
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buf))
  const mesh = doc.createMesh().addPrimitive(prim)
  doc.createScene().addChild(doc.createNode('cube').setMesh(mesh))
  return { doc, prim }
}
{
  const { doc } = cubeDoc({ scale: 2 })
  const s = B.geometryStats(doc)
  eq(s.tris, 12, '立方体 12 个三角形')
  near(s.area, 24, 1e-9, '边长 2 的立方体表面积 24')
  eq(s.closed, true, '闭合、绕向一致')
  near(s.volume, 8, 1e-9, '体积 8（外法线绕向为正）')
  near(Math.hypot(...s.centroid), 0, 1e-12, '体积质心在原点')
  near(s.radius, Math.sqrt(3), 1e-9, '包围半径 √3')
  eq(s.weldedVertices, 8, '按位置焊接 8 个顶点')
  const o = B.geometryStats(cubeDoc({ openFace: true }).doc)
  eq(o.closed, false, '少一个面 → 不闭合')
  eq(o.volume, null, '不闭合不给体积')
  ok(o.centroid[2] > 0, '不闭合取面积加权表面质心（缺 -z 面，质心偏 +z）')
  eq(B.countSceneTriangles(doc), 12, 'countSceneTriangles')
}
{
  const { doc, prim } = cubeDoc()
  ok(B.creaseNormals(doc, prim, 40), '折痕法线执行')
  eq(prim.getAttribute('POSITION').getCount(), 24, '立方体 8 顶点 × 3 个面向 = 24（90° 棱全部拆开）')
  const nrm = prim.getAttribute('NORMAL'), el = [0, 0, 0]
  let axisAligned = true
  for (let i = 0; i < nrm.getCount(); i++) { nrm.getElement(i, el); if (Math.abs(Math.max(...el.map(Math.abs)) - 1) > 1e-6) axisAligned = false }
  ok(axisAligned, '每个新顶点的法线都是面法线（轴向单位向量）')
  eq(prim.getIndices().getCount(), 36, '索引数不变')
  const { doc: d2, prim: p2 } = cubeDoc()
  B.creaseNormals(d2, p2, 100)
  eq(p2.getAttribute('POSITION').getCount(), 8, '折痕角 > 90° 时全平滑，不拆顶点')
}
{
  const { doc, prim } = cubeDoc()
  const tex = doc.createTexture('t').setImage(new Uint8Array([137, 80, 78, 71])).setMimeType('image/png')
  const mat = doc.createMaterial('m').setRoughnessFactor(-0.131).setMetallicFactor(1.5).setBaseColorTexture(tex)
  prim.setMaterial(mat)
  const r = B.sanitizeMaterials(doc, F.listTextureInfoByMaterial)
  eq(mat.getRoughnessFactor(), 0, 'roughness 越界夹到 0')
  eq(mat.getMetallicFactor(), 1, 'metallic 越界夹到 1')
  ok(prim.getAttribute('TEXCOORD_0') && prim.getAttribute('TEXCOORD_0').getCount() === 8, '缺的 TEXCOORD_0 补全 0')
  deq(r, { clamped: 2, texcoordsAdded: 1 }, 'sanitizeMaterials 计数')
}

// ─────────────────────────────── ⑥ 真件处理：夹具 → 三档（Draco 预解码、meshopt、确定性） ───────────────────────────────
const tc = await B.loadToolchain()
const processed = {}
{
  for (const f of ['satkit-radio-1.glb', 'tdrs-a.glb', 'cubesat-1ru.glb', 'ssl-1300.glb']) {
    const out = path.join(tmp, 'build', f.replace(/\.glb$/, ''))
    const r = await B.processModelFile(tc, { srcPath: path.join(FIX, f), outDir: out, meshoptLevel: 'medium' })
    processed[f] = { r, out }
    const src = fs.readFileSync(path.join(FIX, f))
    eq(r.src.sha256, sha256(src), `${f}：原件 sha256`)
    for (const k of ['lod0', 'lod1', 'lod2']) {
      const buf = fs.readFileSync(path.join(out, `${k}.glb`))
      eq(sha256(buf), r.lods[k].sha256, `${f} ${k}：落盘文件与记录的 sha256 一致`)
      const h = LIB.parseGlbHeader(buf)
      eq(h.length, buf.length, `${f} ${k}：GLB 头声明总长 = 文件长`)
      const req = h.json.extensionsRequired || []
      ok(req.includes('EXT_meshopt_compression') && req.every((x) => ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_texture_transform'].includes(x)), `${f} ${k}：扩展只含客户端解得开的（${req.join(',')}）`)
      ok(!(h.json.extensionsUsed || []).includes('KHR_draco_mesh_compression'), `${f} ${k}：不再带 Draco`)
    }
    ok(r.lods.lod0.tris >= r.lods.lod1.tris && r.lods.lod1.tris >= r.lods.lod2.tris && r.lods.lod2.tris > 0, `${f}：三档面数递减`)
    ok(Array.isArray(r.center) && r.center.length === 3 && r.center.every(Number.isFinite), `${f}：记下中心偏移`)
    ok(r.stats.area > 0 && r.stats.radius > 0, `${f}：面积与包围半径为正`)
  }
  const cs = processed['cubesat-1ru.glb'].r
  ok(cs.info.draco.used && cs.info.draco.ok && cs.info.draco.prims > 0, 'CubeSat 1U：Draco 图元全部解开')
  ok(!processed['tdrs-a.glb'].r.info.draco.used, 'TDRS-A（assimp 导出）本来就没有 Draco')
  // 精确包围盒与文件头统计一致（TDRS-A 节点不带旋转，accessor min/max 就是精确值）
  const hdr = LIB.summarizeGltf(LIB.parseGlbHeader(fs.readFileSync(path.join(FIX, 'tdrs-a.glb'))).json)
  for (let i = 0; i < 3; i++) near(processed['tdrs-a.glb'].r.bboxSize[i], hdr.bbox.size[i], 1e-6, `TDRS-A 包围盒第 ${i} 轴`)
  // known-dims 反算落到真件上
  const tdrs = B.resolveUnits(knownDims['tracking-and-data-relay-satellites-tdrs-a'], processed['tdrs-a.glb'].r.bboxSize, { primary: true })
  near(tdrs.units.scaleToMeters, 17.3 / 0.8866, 1e-3, 'TDRS-A：翼展 17.3 m ↔ 最长边 0.8866 单位')
  const cube = B.resolveUnits(knownDims['cubesat-1-ru-generic'], cs.bboxSize, { primary: true })
  near(cube.units.scaleToMeters, 0.1135 / 2.60154, 1e-4, 'CubeSat 1U：本体 y 轴 ↔ 113.5 mm')
  ok(cube.units.sizeVerified && /^https:/.test(cube.units.sizeSource), 'CubeSat 1U：sizeVerified + 出处')
  const ssl = B.resolveUnits(knownDims['space-systems-loral-ssl-1300'], processed['ssl-1300.glb'].r.bboxSize, { primary: true })
  near(ssl.units.scaleToMeters * Math.max(...processed['ssl-1300.glb'].r.bboxSize), 24, 1e-6, 'SSL-1300：最长边缩放后 = 24 m')
  // 确定性：同一原件再跑一次，三档逐字节相同（blob 按 sha256 命名、缓存按 sha 比对，都靠这一条）
  const again = await B.processModelFile(tc, { srcPath: path.join(FIX, 'cubesat-1ru.glb'), outDir: path.join(tmp, 'again'), meshoptLevel: 'medium' })
  for (const k of ['lod0', 'lod1', 'lod2']) eq(again.lods[k].sha256, cs.lods[k].sha256, `确定性：CubeSat ${k} 两次处理 sha256 相同`)
}
{
  // Draco 预解码直接测：解完的 accessor 数与头里声明的一致，Draco 扩展从 used / required 里拿掉
  const buf = fs.readFileSync(path.join(FIX, 'satkit-wings-3.glb'))
  const h = LIB.parseGlbHeader(new Uint8Array(buf))
  const counts = h.json.meshes.flatMap((m) => m.primitives.map((p) => h.json.accessors[p.attributes.POSITION].count))
  const r = await B.dracoPredecode(h.json, new Uint8Array(buf.buffer, buf.byteOffset + h.binOffset, h.binLength), tc.makeDracoModule)
  eq(r.failed.length, 0, 'satkit-wings-3：Draco 全部解开')
  ok(r.prims > 0 && r.points > 0, 'satkit-wings-3：有 Draco 图元')
  deq(r.json.meshes.flatMap((m) => m.primitives.map((p) => r.json.accessors[p.attributes.POSITION].count)), counts, '顶点数与头里声明的一致')
  ok(!(r.json.extensionsUsed || []).includes('KHR_draco_mesh_compression') && !(r.json.extensionsRequired || []).includes('KHR_draco_mesh_compression'), 'Draco 扩展已移除')
  ok(r.json.meshes.every((m) => m.primitives.every((p) => !p.extensions || !p.extensions.KHR_draco_mesh_compression)), '图元上的 Draco 块已删')
  eq(r.bin.byteLength % 4, 0, '新 BIN 4 字节对齐')
  let calls = 0
  const broken = async () => { calls++; return { module: { HEAPU8: new Uint8Array(1), Decoder: function () { throw new Error('boom') }, DecoderBuffer: function () {}, destroy() {} } } }
  const h2 = LIB.parseGlbHeader(new Uint8Array(buf))
  const r2 = await B.dracoPredecode(h2.json, new Uint8Array(buf.buffer, buf.byteOffset + h2.binOffset, h2.binLength), broken)
  ok(r2.failed.length === r2.prims && r2.failed.length > 0, '解码模块坏掉 → 全部记失败，不抛')
  ok(calls >= 2, '失败后换新模块重试')
  ok((r2.json.extensionsUsed || []).includes('KHR_draco_mesh_compression'), '有失败时不动 extensionsUsed（调用方整件放弃）')
}

// ─────────────────────────────── ⑦ 组装 meta / manifest ───────────────────────────────
let manifest, metas = []
{
  const entry = (slug, group, title) => ({ slug, group, title, page: `https://science.nasa.gov/3d-resources/${slug}/`, contributors: ['NASA/Ames Research Center'] })
  const cases = [
    ['nasa:tracking-and-data-relay-satellites-tdrs-a', 'tracking-and-data-relay-satellites-tdrs-a', 'tdrs-a.glb', entry('tracking-and-data-relay-satellites-tdrs-a', 'spacecraft', 'Tracking and Data Relay Satellites (TDRS) (A)')],
    ['nasa:cubesat-1-ru-generic', 'cubesat-1-ru-generic', 'cubesat-1ru.glb', entry('cubesat-1-ru-generic', 'spacecraft', 'CubeSat - 1 RU Generic')],
    ['nasa:satellite-kit~4', 'satellite-kit', 'satkit-radio-1.glb', entry('satellite-kit', 'spacecraft', 'Satellite Kit')]
  ]
  for (const [id, slug, f, e] of cases) {
    const w = processed[f].r
    const u = B.resolveUnits(knownDims[slug], w.bboxSize, { primary: !id.includes('~') })
    const multi = id.includes('~')
    const m = B.composeMeta({ id, slug, entry: e, file: multi ? 'Satellite Kit radio 1.glb' : f, multi, primary: !multi, w, units: u.units, kind: 'spacecraft', titleZh: B.resolveTitleZh(slug, 'Satellite Kit radio 1.glb', { primary: !multi, multi }, titlesZh), updatedAt: '2026-09-23T00:00:00.000Z' })
    metas.push(m)
    eq(m.schema, 2, `${id}：schema 2`)
    deq(m.frame, { q_model2body: [...BF.Q_YUP_ZENITH], t_model2body: [0, 0, 0], verified: false, importQ: [...BF.Q_YUP_ZENITH] }, `${id}：不传 frame → NASA 缺省（+Y 天顶，轴映射终案 ②）、未核；importQ = 缺省 q`)
    deq(m.source, { kind: 'nasa', url: e.page, credit: 'NASA', license: B.NASA_LICENSE, redistributable: true }, `${id}：source`)
    near(m.geometry.bboxM.max[0] + m.geometry.bboxM.min[0], 0, 1e-9, `${id}：几何中心在原点`)
    near(2 * m.geometry.bboxM.max.reduce((a, b) => Math.max(a, b)), Math.max(...w.bboxSize) * m.units.scaleToMeters, 1e-4 * Math.max(...w.bboxSize) * m.units.scaleToMeters, `${id}：bboxM = 包围盒 × scale`)
    eq(m.geometry.tris, w.lods.lod0.tris, `${id}：geometry.tris = lod0`)
    if (SCHEMA) { const v = SCHEMA.validateMeta(SCHEMA.normalizeMeta(m)); ok(v.ok, `${id}：W1 validateMeta 通过 ${v.errors.join('；')}`) }
  }
  {
    const w = processed['tdrs-a.glb'].r
    const base = { id: 'nasa:x', slug: 'x', entry: { slug: 'x', group: 'spacecraft', title: 'X', page: '', contributors: [] }, file: 'x.glb', multi: false, primary: true, w, units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false }, kind: 'spacecraft', titleZh: null, updatedAt: '2026-09-23T00:00:00.000Z' }
    deq(B.composeMeta({ ...base, thumb: { sha256: 'a'.repeat(64), bytes: 10 } }).files.thumb, { sha256: 'a'.repeat(64), bytes: 10 }, 'sheets 写了 thumb.webp → files.thumb')
    eq(B.composeMeta({ ...base, thumb: { sha256: 'bad', bytes: 10 } }).files.thumb, undefined, '缩略图 sha 不合法 → 不带')
    eq(B.composeMeta(base).titleZh, undefined, '没有中文名就不写 titleZh 键')
    const fr = { q_model2body: BF.quatFromBodyAxes('+Y', '+Z'), t_model2body: [0, 0, 0], verified: true }
    const mf = B.composeMeta({ ...base, frame: fr })
    deq(mf.frame, { ...fr, importQ: fr.q_model2body }, 'composeMeta：带 frame（resolveFrame 的结果）→ 原样写进 meta，importQ = 核定 q')
    ok(mf.frame.importQ !== mf.frame.q_model2body, 'composeMeta：importQ 与 q_model2body 不共用数组')
    ok(mf.frame.q_model2body !== fr.q_model2body, 'composeMeta：frame 拷贝一份，不与调用方共用数组')
    deq(B.composeMeta({ ...base, frame: { q_model2body: [0, 0, 0, 1] } }).frame, { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0], verified: false, importQ: [0, 0, 0, 1] }, 'composeMeta：frame 缺 t / verified → 零平移、未核')
    if (SCHEMA) deq(SCHEMA.normalizeMeta(mf).frame.importQ, fr.q_model2body, 'composeMeta 的 importQ 过 schema.normalizeMeta 保留')
  }
  eq(metas[2].title, 'Satellite Kit radio 1', '多文件派生件标题 = 文件主名')
  // 出厂 q / 许可文案全仓同一个真值源（2026-09-24 定案）：管线转出的常量就是 bodyFrame 的那个对象；许可与 schema 的 NASA 缺省同一句
  eq(B.DEFAULT_Q_MODEL2BODY, BF.DEFAULT_Q_MODEL2BODY, '管线的出厂 q 就是 bodyFrame 常量（不是抄的数）')
  eq(B.Q_YUP_ZENITH, BF.Q_YUP_ZENITH, '管线转出的 Q_YUP_ZENITH 就是 bodyFrame 常量')
  if (SCHEMA) deq(SCHEMA.normalizeMeta({ ...B.slimMetaLocal(metas[0]), frame: undefined }).frame.q_model2body, [...B.NASA_DEFAULT_Q], 'schema 兜底（NASA 件缺 frame）与管线缺省同一个 q')
  if (SCHEMA) eq(SCHEMA.defaultMeta({ id: 'nasa:x', title: 'x', source: { kind: 'nasa' } }).source.license, B.NASA_LICENSE, '许可文案：管线 = schema 缺省')
  eq(metas[2].titleZh, '卫星组件套装：无线电组件 1', '多文件派生件中文名走文件键')
  eq(metas[0].units.sizeVerified, true, 'TDRS-A 尺寸已核')
  eq(metas[2].units.sizeVerified, false, 'satellite-kit 没有已知尺寸 → 未核')
  const slim = metas.map(B.slimMetaLocal)
  ok(slim.every((s) => s.parts === undefined && s.files && s.geometry && s.units), 'slim：去掉大字段、保留列表要用的字段')
  manifest = B.buildManifest(slim, { generatedAt: '2026-09-23T00:00:00.000Z' })
  const m2 = B.buildManifest(slim.slice().reverse(), { generatedAt: '2026-09-24T00:00:00.000Z' })
  eq(manifest.buildId, m2.buildId, 'buildId 只由内容决定（与条目顺序、生成时间无关）')
  ok(/^nasa-[0-9a-f]{12}$/.test(manifest.buildId), 'buildId 形如 nasa-<12 位>')
  deq(manifest.models.map((x) => x.id), [...manifest.models.map((x) => x.id)].sort(), 'models 按 id 排序')
  const shape = B.checkManifestShape(manifest)
  ok(shape.ok, `manifest 字段自检通过 ${shape.errors.join('；')}`)
  const badM = JSON.parse(JSON.stringify(manifest))
  badM.models[0].source.redistributable = false
  badM.models[1].files.lod1.sha256 = 'xyz'
  badM.models.push(JSON.parse(JSON.stringify(badM.models[2])))
  const bs = B.checkManifestShape(badM)
  ok(!bs.ok && bs.errors.some((e) => /redistributable/.test(e)) && bs.errors.some((e) => /lod1/.test(e)) && bs.errors.some((e) => /重复/.test(e)), 'manifest 自检能拦：不可分发 / sha 不合法 / id 重复')
  if (MANIFEST) {
    const v = MANIFEST.validateManifest(manifest, { remote: true })
    ok(v.ok && !v.errors.length && v.models.length === manifest.models.length, `W1 validateManifest（远端口径）通过、不丢条目 ${v.errors.join('；')}`)
  }
}

// ─────────────────────────────── ⑧ scripts/lib/cos.mjs（替身 https，不联网） ───────────────────────────────
const realRequest = https.request
// 替身 https.request：记下每个请求（含 req.setTimeout 设的毫秒数，没设为 null）。handler 返回 {hang:true} 时不回响应、
// 直接触发已登记的超时回调（模拟半开连接到点）；autoDestroy 关掉，否则请求写完就自毁，超时里的 destroy(err) 发不出 error
function fakeHttps(handler) {
  const log = []
  https.request = (opts, cb) => {
    const chunks = []
    let toMs = null, toCb = null
    const req = new Writable({
      autoDestroy: false,
      write(c, _e, done) { chunks.push(Buffer.from(c)); done() },
      final(done) {
        const body = Buffer.concat(chunks)
        const e = { method: opts.method, host: opts.host, path: opts.path, headers: { ...(opts.headers || {}) }, body, timeoutMs: toMs }
        log.push(e)
        const r = handler(e, log.length)
        done()
        if (r.hang) { setImmediate(() => (toCb ? toCb() : req.destroy(new Error('替身：挂起但没设超时')))); return }
        setImmediate(() => { const res = Readable.from([Buffer.from(r.text || '')]); res.statusCode = r.status; res.headers = r.headers || {}; cb(res) })
      }
    })
    req.setTimeout = (ms, f) => { toMs = ms; toCb = f; return req }
    return req
  }
  return log
}
{
  const realNow = Date.now
  Date.now = () => 1790000000000
  try {
    const cos = COS.createCos({ secretId: 'AKIDTEST', secretKey: 'KEY', bucket: 'b-1', region: 'ap-beijing', accelerate: true })
    eq(cos.host, 'b-1.cos.accelerate.myqcloud.com', '加速域名只用于上传')
    eq(cos.regionHost, 'b-1.cos.ap-beijing.myqcloud.com', '公共读恒用地域域名')
    const a = cos.authorization('put', '/updates/x', { uploadId: 'U', partNumber: '2' })
    ok(a.includes('q-sign-time=1789999940;1790003540') && a.includes('q-url-param-list=partnumber;uploadid') && a.includes('q-header-list=&'), '签名：时间窗 now-60…+3600、参数名小写排序、不签头')
    eq(cos.authorization('put', '/updates/x'), cos.authorization('put', '/updates/x', {}), '无参数与空参数签名一致（向后兼容）')
    eq(COS.encodePath('updates/models/src/nasa/a/b c (A).glb'), '/updates/models/src/nasa/a/b%20c%20(A).glb', 'encodePath 逐段编码')

    let log = fakeHttps((e) => (e.method === 'HEAD' ? { status: 200, headers: { 'content-length': '123', etag: '"abc"', 'x-cos-meta-sha256': 'AB'.repeat(32) } } : { status: 200 }))
    const h = await cos.headPublic('updates/models/blobs/x.glb')
    deq([h.status, h.bytes, h.etag], [200, 123, '"abc"'], 'headPublic 读状态 / 字节 / ETag')
    eq(h.sha256, 'ab'.repeat(32), 'headPublic 读回 x-cos-meta-sha256（转小写）')
    ok(log[0].host === cos.regionHost && !log[0].headers.Authorization && log[0].method === 'HEAD', 'headPublic：不签名、走地域域名')
    fakeHttps(() => ({ status: 200, headers: { 'content-length': '1', 'x-cos-meta-sha256': 'not-a-sha' } }))
    eq((await cos.headPublic('k')).sha256, null, 'x-cos-meta-sha256 不是 64 位十六进制 → null')

    log = fakeHttps(() => ({ status: 200, text: '{"schema":2}' }))
    const g = await cos.getPublic('updates/models/manifest.json')
    ok(g.status === 200 && g.body.toString() === '{"schema":2}' && log[0].method === 'GET' && !log[0].headers.Authorization && log[0].host === cos.regionHost, 'getPublic：不签名、地域域名、读回正文')
    eq(log[0].timeoutMs, 30000, 'getPublic 设了超时')
    fakeHttps(() => ({ status: 404, text: '<Error><Code>NoSuchKey</Code></Error>' }))
    eq((await cos.getPublic('x')).status, 404, 'getPublic：404 照常 resolve')
    fakeHttps(() => ({ status: 200, text: 'x'.repeat(100) }))
    let gerr = null
    try { await cos.getPublic('x', { maxBytes: 10 }) } catch (e) { gerr = e }
    ok(gerr && /超过/.test(gerr.message), 'getPublic：超过 maxBytes → reject')

    log = fakeHttps(() => ({ status: 200 }))
    await cos.putBuffer('updates/models/manifest.json', Buffer.from('{}'), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-cos-meta-sha256': 'c'.repeat(64) })
    ok(log[0].method === 'PUT' && log[0].headers.Authorization && log[0].headers['Content-Type'] === 'application/json' && log[0].headers['Cache-Control'] === 'no-cache' && log[0].headers['Content-Length'] === 2, 'putBuffer：带签名、Content-Type / Cache-Control / Content-Length')
    eq(log[0].headers['x-cos-meta-sha256'], 'c'.repeat(64), 'putBuffer：对象元数据头原样带上')
    eq(log[0].host, cos.host, 'putBuffer 走上传域名')
    eq(log[0].timeoutMs, COS.DEFAULT_TIMEOUT_MS, 'putBuffer：缺省设空闲超时')

    // 超时开关：signedRequest 不给 timeoutMs 就不调 req.setTimeout（publish-cos 的请求与原版一致靠这一条）
    log = fakeHttps(() => ({ status: 200 }))
    await cos.signedRequest('PUT', 'k', { body: 'x' })
    await cos.signedRequest('PUT', 'k', { body: 'x', timeoutMs: 7000 })
    deq(log.map((e) => e.timeoutMs), [null, 7000], 'signedRequest：只有给了 timeoutMs 才设超时')
    fakeHttps(() => ({ hang: true }))
    let terr = null
    try { await cos.putBuffer('k', Buffer.from('x'), {}, { tries: 1, timeoutMs: 50 }) } catch (e) { terr = e }
    ok(terr && /超时/.test(terr.message) && terr.status === undefined, '半开连接：到点按网络错误 reject（无 status，可重试），不会永远挂住')
    fakeHttps(() => ({ hang: true }))
    const pr = await cos.probeWrite('updates/models/_probe', 'x', { timeoutMs: 50 })
    ok(!pr.ok && pr.status === 0 && /超时/.test(pr.message), '探针超时 → status 0（网络不通）')

    log = fakeHttps((e, i) => (i === 1 ? { status: 500, text: '<Error><Code>InternalError</Code></Error>' } : { status: 200 }))
    const warn = console.warn; console.warn = () => {}
    await cos.putBuffer('k', Buffer.from('x'), {}, { tries: 2 }).finally(() => { console.warn = warn })
    eq(log.length, 2, 'putBuffer：5xx 重试一次后成功')

    log = fakeHttps(() => ({ status: 403, text: '<Error><Code>AccessDenied</Code><Message>no</Message></Error>' }))
    let err = null
    try { await cos.putBuffer('k', Buffer.from('x'), {}, { tries: 4 }) } catch (e) { err = e }
    ok(err && err.status === 403 && err.code === 'AccessDenied', '4xx 不重试，错误带 status / code')
    eq(log.length, 1, '403 只请求一次')
    ok(!Object.keys(err).includes('status') && !util.inspect(err).includes("code: 'AccessDenied'"), 'status / code 不可枚举：未捕获时 stderr 与抽出前逐字一致')
    ok(/^HTTP 403 PUT k\n/.test(err.message), '报错文案与 publish-cos 原版一致')

    fakeHttps(() => ({ status: 403, text: '<Error><Code>AccessDenied</Code></Error>' }))
    deq(await cos.probeWrite('updates/models/_probe'), { ok: false, status: 403, code: 'AccessDenied', message: 'HTTP 403 PUT updates/models/_probe' }, 'probeWrite：AccessDenied')
    fakeHttps(() => ({ status: 403, text: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }))
    eq((await cos.probeWrite('updates/models/_probe')).code, 'SignatureDoesNotMatch', 'probeWrite：SignatureDoesNotMatch')
    log = fakeHttps(() => ({ status: 200 }))
    deq(await cos.probeWrite('updates/models/_probe'), { ok: true, status: 200, code: null, message: '' }, 'probeWrite：成功')
    ok(log[0].headers.Authorization && log[0].method === 'PUT', '探针是带签名的 PUT')

    // 分块上传带对象元数据：头只在 initiate 那一步
    log = fakeHttps((e) => (/uploads=/.test(e.path) ? { status: 200, text: '<InitiateMultipartUploadResult><UploadId>U1</UploadId></InitiateMultipartUploadResult>' } : /partNumber/.test(e.path) ? { status: 200, headers: { etag: '"p"' } } : { status: 200, text: '<CompleteMultipartUploadResult/>' }))
    const out = process.stdout.write.bind(process.stdout); process.stdout.write = () => true
    try { await cos.multipartUpload('updates/models/blobs/big.glb', Buffer.alloc(2 * 1024 * 1024 + 5), { partSize: 1024 * 1024, headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'public, max-age=31536000, immutable' } }) } finally { process.stdout.write = out }
    const init = log.find((e) => /uploads=/.test(e.path)), parts = log.filter((e) => /partNumber/.test(e.path))
    ok(init.headers['Content-Type'] === 'model/gltf-binary' && init.headers['Cache-Control'].includes('immutable'), 'multipartUpload：Content-Type / Cache-Control 在 initiate 上')
    ok(parts.length === 3 && parts.every((e) => !e.headers['Content-Type']), 'multipartUpload：3 片、分片不带对象元数据')
    ok(log.every((e) => e.timeoutMs === null), 'multipartUpload 不给 timeoutMs：四步都不设超时（publish-cos 的分块上传与原版一致）')
    log = fakeHttps((e) => (/uploads=/.test(e.path) ? { status: 200, text: '<InitiateMultipartUploadResult><UploadId>U2</UploadId></InitiateMultipartUploadResult>' } : /partNumber/.test(e.path) ? { status: 200, headers: { etag: '"p"' } } : { status: 200, text: '<CompleteMultipartUploadResult/>' }))
    process.stdout.write = () => true
    try { await cos.multipartUpload('k', Buffer.alloc(1024 * 1024 + 1), { partSize: 1024 * 1024, timeoutMs: 9000 }) } finally { process.stdout.write = out }
    ok(log.length === 4 && log.every((e) => e.timeoutMs === 9000), 'multipartUpload 给了 timeoutMs：initiate / 每片 / complete 都带上')
  } finally {
    https.request = realRequest
    Date.now = realNow
  }
}

// ─────────────────────────────── ⑨ publish.mjs 纯函数与计划 ───────────────────────────────
{
  const md5 = crypto.createHash('md5').update('abc').digest('hex')
  const shaA = sha256('abc'), shaB = sha256('abd')
  ok(P.remoteMatches({ status: 200, bytes: 3, etag: `"${md5}"` }, 3, md5), '单次 PUT 对象：字节 + MD5 一致 → 跳过')
  ok(!P.remoteMatches({ status: 200, bytes: 3, etag: '"00000000000000000000000000000000"' }, 3, md5), 'MD5 不同 → 重传')
  ok(P.remoteMatches({ status: 200, bytes: 3, etag: '"abc-3"' }, 3, md5, { contentAddressed: true }), '分块对象、键名即内容哈希（blob）→ 只比字节')
  ok(!P.remoteMatches({ status: 200, bytes: 3, etag: '"abc-3"' }, 3, md5), '分块对象、按文件名寻址（原件）且没有 sha 元数据 → 重传（同字节数不同内容认不出）')
  ok(P.remoteMatches({ status: 200, bytes: 3, etag: '"abc-3"', sha256: shaA }, 3, md5, { sha256: shaA }), '分块对象带 x-cos-meta-sha256 且一致 → 跳过')
  ok(!P.remoteMatches({ status: 200, bytes: 3, etag: '"abc-3"', sha256: shaB }, 3, md5, { sha256: shaA }), '分块对象 sha 元数据不同（NASA 重导出、字节数不变）→ 重传')
  ok(!P.remoteMatches({ status: 200, bytes: 3, etag: `"${md5}"`, sha256: shaB }, 3, md5, { sha256: shaA, contentAddressed: true }), 'sha 元数据优先于 MD5 / 内容寻址')
  ok(!P.remoteMatches({ status: 200, bytes: 4, etag: '"abc-3"' }, 3, md5, { contentAddressed: true }), '字节不同 → 重传')
  ok(!P.remoteMatches({ status: 404, bytes: null }, 3, md5), '404 → 传')
  // 缩水闸的对账
  const dm = P.diffManifestIds({ models: [{ id: 'nasa:a' }, { id: 'nasa:b' }, { id: 'nasa:c' }] }, { models: [{ id: 'nasa:a' }, { id: 'nasa:d' }] })
  deq([dm.ok, dm.remoteCount, dm.localCount, dm.missing, dm.added], [true, 3, 2, ['nasa:b', 'nasa:c'], 1], 'diffManifestIds：列出云端有、本次没有的 id')
  deq(P.diffManifestIds({ models: [{ id: 'nasa:a' }] }, { models: [{ id: 'nasa:a' }, { id: 'nasa:b' }] }).missing, [], '只增不减 → 无缺失')
  ok(!P.diffManifestIds({ schema: 2 }, { models: [] }).ok, '云端结构不对 → 比不了')
  // 缩略图也对账：云端带 files.thumb、本次同 id 却没有 → thumbLost（改了朝向 / 显示系、没重跑 sheets 时整批过期的情形）
  {
    const T = { sha256: 'e'.repeat(64), bytes: 9 }
    const rem = { models: [{ id: 'nasa:a', files: { thumb: T } }, { id: 'nasa:b', files: { thumb: T } }, { id: 'nasa:c', files: {} }, { id: 'nasa:gone', files: { thumb: T } }] }
    const loc = { models: [{ id: 'nasa:b', files: {} }, { id: 'nasa:a', files: {} }, { id: 'nasa:c', files: { thumb: T } }] }
    const dt = P.diffManifestIds(rem, loc)
    deq([dt.missing, dt.thumbLost], [['nasa:gone'], ['nasa:a', 'nasa:b']], 'diffManifestIds：thumbLost 只列两边都有、云端有缩略图本次没有的 id（排序；下架的归 missing、新增缩略图不算）')
    deq(P.diffManifestIds(rem, rem).thumbLost, [], '缩略图没少 → thumbLost 空')
    deq(P.diffManifestIds({ models: [{ id: 'nasa:a' }] }, { models: [{ id: 'nasa:a' }] }).thumbLost, [], '两边都没缩略图 → 不算丢')
  }
  {
    const sdir = path.join(tmp, 'plansrc', 'kit')
    fs.mkdirSync(sdir, { recursive: true })
    for (const f of ['B.glb', 'A.glb']) { const b = Buffer.from(f); fs.writeFileSync(path.join(sdir, f), b); fs.writeFileSync(path.join(sdir, f + '.sha256'), `${sha256(b)}  ${f}\n`) }
    const ps = await P.planSources(path.join(tmp, 'plansrc'))
    deq(ps.items.map((x) => [x.role, x.label, x.of || null]), [['glb', 'kit/A.glb', null], ['sidecar', 'kit/A.glb.sha256', 'kit/A.glb'], ['glb', 'kit/B.glb', null], ['sidecar', 'kit/B.glb.sha256', 'kit/B.glb']], 'planSources：glb 与旁车配对（旁车记 of）')
    ok(ps.items.every((x) => x.contentAddressed === false && /^[0-9a-f]{64}$/.test(x.sha256)), 'planSources：原件按文件名寻址、带 sha256')
  }
  ok(/策略/.test(P.explainProbe({ ok: false, status: 403, code: 'AccessDenied', message: '' })), '探针诊断：AccessDenied 是策略问题')
  ok(/密钥/.test(P.explainProbe({ ok: false, status: 403, code: 'SignatureDoesNotMatch', message: '' })), '探针诊断：签名不符是密钥问题')
  ok(/网络/.test(P.explainProbe({ ok: false, status: 0, code: null, message: 'ECONNRESET' })), '探针诊断：网络')
  eq(P.blobKey('a'.repeat(64), 'glb'), `updates/models/blobs/${'a'.repeat(64)}.glb`, 'blob 键')
  eq(P.srcKey('tdrs-a', 'T (A).glb'), 'updates/models/src/nasa/tdrs-a/T (A).glb', '原件镜像键（与 fetch.mjs --source=cos、manifest.mjs nasaSrcUrl 同一对象）')
  if (MANIFEST && MANIFEST.nasaSrcUrl) eq(decodeURIComponent(new URL(MANIFEST.nasaSrcUrl('tdrs-a', 'T (A).glb')).pathname).slice(1), P.srcKey('tdrs-a', 'T (A).glb'), '与 W1 nasaSrcUrl 指向同一个键')
  eq(P.manifestKey('nasa-0123456789ab'), 'updates/models/manifest.nasa-0123456789ab.json', 'manifest 快照键')
  eq(P.manifestKey(null), 'updates/models/manifest.json', 'manifest 键')
  // 计划：按 manifest 找本地文件并逐个重算 sha
  const bdir = path.join(tmp, 'pubbuild')
  const mm = JSON.parse(JSON.stringify(manifest))
  const dirOf = { 'nasa:tracking-and-data-relay-satellites-tdrs-a': 'tdrs-a', 'nasa:cubesat-1-ru-generic': 'cubesat-1ru', 'nasa:satellite-kit~4': 'satkit-radio-1' }
  for (const m of mm.models) fs.cpSync(path.join(tmp, 'build', dirOf[m.id]), path.join(bdir, m.id.replace(/^nasa:/, '')), { recursive: true })
  const plan = await P.planBlobs(mm, bdir)
  deq(plan.errors, [], 'planBlobs：本地文件齐、sha 对')
  eq(plan.items.length, 9, 'planBlobs：3 条 × 3 档')
  ok(plan.items.every((x) => x.contentType === 'model/gltf-binary' && x.cacheControl.includes('immutable') && /blobs\/[0-9a-f]{64}\.glb$/.test(x.key)), 'planBlobs：键 / 类型 / immutable')
  ok(plan.items.every((x) => x.contentAddressed === true && x.key.includes(x.sha256)), 'planBlobs：内容寻址、sha256 与键一致')
  fs.appendFileSync(path.join(bdir, 'cubesat-1-ru-generic', 'lod2.glb'), Buffer.from([0]))
  const plan2 = await P.planBlobs(mm, bdir)
  ok(plan2.errors.length === 1 && /不符/.test(plan2.errors[0]), 'planBlobs：文件被改过 → 记错，不传')
}

// ─────────────────────────────── ⑩ check-models.mjs（子进程跑，--dir 指到临时目录） ───────────────────────────────
// 夹具目录 = 真内置层的缩影：两个带 lod2 的子集条目 + autoMatch 兜底 nasa:satellite-kit（带 lod2）。条目口径见 scripts/nasa3d/builtin.mjs 文件头：
// 内置层只收实际随包带了模型的条目；目录条目缺省拦（--allow-catalog 放行）；模板条目可有可无，有就须是已知模板、带缩略图。
let N = 0
{
  const dir = path.join(tmp, 'resmodels')
  const fakeWebp = (tag) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.from(tag)])
  const TPL = PT && SCHEMA ? PT.TEMPLATE_IDS : []
  const make = ({ kit = true, kitTiers = ['lod2', 'thumb'], templates = false, sourceBuildId = 'nasa-0123456789ab' } = {}) => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(dir, 'builtin'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true })
    const models = []
    // 朝向按仓库真核定表（frame-overrides.json）摆——真 builtin 产物就是这样；check-models ⑨ 查仓库 / --root 时拦对不上的
    const ov = B.parseFrameOverrides(JSON.parse(fs.readFileSync(B.FRAME_OVERRIDES_FILE, 'utf8')))
    const addNasa = (m, sub, id, tiers) => {
      if (tiers && tiers.includes('lod2')) fs.writeFileSync(path.join(dir, 'builtin', `${m.files.lod2.sha256}.glb`), fs.readFileSync(path.join(tmp, 'build', sub, 'lod2.glb')))
      const webp = fakeWebp(id)
      fs.writeFileSync(path.join(dir, 'thumbs', `${sha256(webp)}.webp`), webp)
      models.push({ ...B.slimMetaLocal(m), id, frame: B.resolveFrame(id, ov).frame, files: { ...m.files, thumb: { sha256: sha256(webp), bytes: webp.length } }, ...(tiers ? { builtin: tiers } : {}) })
    }
    addNasa(metas[0], 'tdrs-a', metas[0].id, ['lod2', 'thumb'])
    addNasa(metas[1], 'cubesat-1ru', metas[1].id, ['lod2', 'thumb'])
    if (kit) addNasa(metas[2], 'satkit-radio-1', 'nasa:satellite-kit', kitTiers)
    if (templates) {
      for (const tid of TPL) {
        const pm = SCHEMA.slimMeta(SCHEMA.defaultMeta({ id: `param:${tid}`, title: tid, kind: 'spacecraft', source: { kind: 'param', url: '', credit: 'satsim', license: 'param', redistributable: true } }))
        const webp = fakeWebp(`param:${tid}`)
        fs.writeFileSync(path.join(dir, 'thumbs', `${sha256(webp)}.webp`), webp)
        pm.files = { thumb: { sha256: sha256(webp), bytes: webp.length } }
        pm.builtin = ['thumb']
        pm.templateId = tid
        pm.specHash = PB.specHash(PT.templateSpec(tid).spec)
        models.push(pm)
      }
    }
    const man = { schema: 2, buildId: 'builtin-test', generatedAt: '2026-09-23T00:00:00.000Z', ...(sourceBuildId ? { sourceBuildId } : {}), models }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man))
    return man
  }
  const save = (man) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man))
  const run = (...extra) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${dir}`, ...extra], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
  let man = make()
  N = man.models.length
  let r = run()
  eq(r.status, 0, `check-models：完整目录通过 ${r.stderr}`)
  ok(new RegExp(`内置模型就绪：${N} 条（随包带模型 3 条）`).test(r.stdout), 'check-models：打印条数、随包带模型条数与体积')
  fs.writeFileSync(path.join(dir, 'builtin', `${'f'.repeat(64)}.glb`), 'x')
  r = run()
  ok(r.status === 1 && /⑤/.test(r.stderr), 'check-models ⑤：孤儿文件拦下')
  man = make()
  man.models[0].source.redistributable = false
  save(man)
  r = run()
  ok(r.status === 1 && /⑦/.test(r.stderr), 'check-models ⑦：不可分发条目拦下')
  make()
  fs.writeFileSync(path.join(dir, 'builtin', `${metas[1].files.lod2.sha256}.glb`), fs.readFileSync(path.join(tmp, 'build', 'tdrs-a', 'lod2.glb')))
  r = run()
  ok(r.status === 1 && /③/.test(r.stderr), 'check-models ③：文件与 sha 不符拦下')
  make()
  fs.rmSync(path.join(dir, 'thumbs'), { recursive: true })
  r = run()
  ok(r.status === 1 && /④/.test(r.stderr), 'check-models ④：缺缩略图拦下')
  make()
  fs.writeFileSync(path.join(dir, 'builtin', 'pad.bin'), Buffer.alloc(16 * 1024 * 1024))
  r = run()
  ok(r.status === 1 && /⑥/.test(r.stderr), 'check-models ⑥：超 15 MiB 拦下')
  const r0 = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${path.join(tmp, 'nope')}`], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
  ok(r0.status === 1 && /找不到/.test(r0.stderr), 'check-models：目录不存在 → 中断')
  const rs = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${path.join(tmp, 'nope')}`], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '1' } })
  eq(rs.status, 0, 'check-models：SATSIM_SKIP_MODELS=1 放行')

  // 覆盖规则：autoMatch 的兜底若是 NASA 件须随包带 lod（现兜底是参数化的默认卫星模型 → 不强求 satellite-kit）；
  // 模板条目可有可无（有就须是已知模板、带缩略图；specHash 过时只警告）
  // 兜底 id 取 autoMatch 转出的 DEFAULT_MODEL_ID（= paramTemplates 的唯一真值，2026-09-24 起 param:default-sat），不抄数
  const AMM = await imp('packages/core/models/autoMatch.mjs')
  const fb = AMM.match({ name: 'SATSIM CHECK MODELS PROBE', orbitKind: 'LEO' }, {}).id
  ok(fb === AMM.DEFAULT_MODEL_ID && /^param:/.test(fb), `autoMatch 兜底 = DEFAULT_MODEL_ID 且是参数化（运行时生成）：${fb}`)
  make({ kit: false })
  r = run()
  ok(r.status === 0 && !/兜底模型/.test(r.stderr), `check-models ③：兜底是参数化 → 不要求随包 satellite-kit ${r.stderr}`)
  ok(!/参数化模板/.test(run().stderr), 'check-models：内置层没有模板条目 → 不拦（DESIGN §8：模板运行时生成）')
  if (TPL.length) {
    man = make({ templates: true })
    r = run()
    ok(r.status === 0 && new RegExp(`内置模型就绪：${N + TPL.length} 条（随包带模型 3 条）· ${N + TPL.length} 条有缩略图`).test(r.stdout), `check-models：带全部模板条目（--templates=entries 的产物）→ 通过 ${r.stderr}`)
    const geoTpl = man.models.find((m) => m.id === `param:${TPL_GEO}`)
    delete geoTpl.files.thumb
    save(man)
    fs.rmSync(path.join(dir, 'thumbs', `${sha256(fakeWebp(`param:${TPL_GEO}`))}.webp`))
    r = run()
    ok(r.status === 1 && new RegExp(`④ param:${TPL_GEO}`).test(r.stderr) && !new RegExp(`③ param:${TPL_GEO}`).test(r.stderr), 'check-models：参数化模板缺缩略图 → ④ 拦下（③ 不报：模板不要求 lod）')
    man = make({ templates: true })
    man.models.find((m) => m.id === `param:${TPL_GEO}`).specHash = '0'.repeat(16)
    save(man)
    r = run()
    ok(r.status === 0 && new RegExp(`⚠ param:${TPL_GEO} 的缩略图按 specHash 0{16} 出`).test(r.stdout), `check-models：模板 specHash 过时 → 只警告、放行 ${r.stderr}`)
    man = make({ templates: true })
    man.models.find((m) => m.id === `param:${TPL_GEO}`).id = 'param:0123456789ab'
    save(man)
    r = run()
    ok(r.status === 1 && /③ param:0123456789ab：不是 paramTemplates 里的模板/.test(r.stderr), 'check-models ③：用户另存的参数化模型（不是模板）→ 拦下')
  }
  // 目录条目（没有档位表、只带缩略图）：缺省拦下（离线 autoMatch 会选中它们）；--allow-catalog 放行，两条共用一张缩略图放行
  man = make()
  {
    const webp = fakeWebp('catalog-only')
    fs.writeFileSync(path.join(dir, 'thumbs', `${sha256(webp)}.webp`), webp)
    const th = { sha256: sha256(webp), bytes: webp.length }
    man.models.push({ ...B.slimMetaLocal(metas[0]), id: 'nasa:catalog-only-a', files: { ...metas[0].files, thumb: th } })
    man.models.push({ ...B.slimMetaLocal(metas[0]), id: 'nasa:catalog-only-b', files: { ...metas[0].files, thumb: th } })
    save(man)
  }
  r = run()
  ok(r.status === 1 && /③ 2 条没带模型的目录条目（如 nasa:catalog-only-a、nasa:catalog-only-b）/.test(r.stderr), 'check-models ③：目录条目缺省拦下')
  r = run('--allow-catalog')
  ok(r.status === 0 && new RegExp(`内置模型就绪：${N + 2} 条（随包带模型 3 条）· ${N + 2} 条有缩略图（${N + 1} 张）`).test(r.stdout), `check-models --allow-catalog：目录条目只带缩略图、两条共用一张缩略图 → 通过 ${r.stderr}`)
  man.models[man.models.length - 1].builtin = ['lod1']
  save(man)
  r = run('--allow-catalog')
  ok(r.status === 1 && /③ nasa:catalog-only-b：缺 builtin[\\/]/.test(r.stderr), 'check-models ③：档位表列了 lod1 而随包没有 → 拦下')

  // --online：本机假 CDN（SATSIM_CHECK_MODELS_CDN），manifest.<sourceBuildId>.json 在 → 通过；不在 / 没有 sourceBuildId → 拦下。
  // 子进程要异步起（spawnSync 会把本进程的假服务一起卡住）
  {
    const http = await import('node:http')
    const hits = []
    const srv = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = req.url === '/updates/models/manifest.nasa-0123456789ab.json' ? 200 : 404; res.end() })
    await new Promise((ok2) => srv.listen(0, '127.0.0.1', ok2))
    const cdn = `http://127.0.0.1:${srv.address().port}/updates/models/`
    const runOnline = () => new Promise((resolve) => {
      execFile(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${dir}`, '--online'], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '', SATSIM_CHECK_MODELS_CDN: cdn } },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }))
    })
    try {
      make()
      r = await runOnline()
      ok(r.status === 0 && /云端快照 manifest\.nasa-0123456789ab\.json 已发布/.test(r.stdout) && hits.includes('HEAD /updates/models/manifest.nasa-0123456789ab.json'), `check-models --online：源 build 已发布（HEAD 200）→ 通过 ${r.stderr}`)
      make({ sourceBuildId: 'nasa-ffffffffffff' })
      r = await runOnline()
      ok(r.status === 1 && /在线 云端没有 manifest\.nasa-ffffffffffff\.json（HTTP 404）/.test(r.stderr), 'check-models --online：源 build 没发布 → 拦下（先 publish 再打包）')
      make({ sourceBuildId: null })
      r = await runOnline()
      ok(r.status === 1 && /没有合法的 sourceBuildId/.test(r.stderr), 'check-models --online：内置 manifest 没有 sourceBuildId → 拦下')
    } finally { srv.close() }
  }

  // ① 打包配置：--root 指到临时仓库根（假 package.json + resources/models + resources/licenses），manifest.mjs 仍从本仓库加载
  {
    const root = path.join(tmp, 'fakeroot')
    fs.rmSync(root, { recursive: true, force: true })
    make()
    fs.cpSync(dir, path.join(root, 'resources', 'models'), { recursive: true })
    fs.mkdirSync(path.join(root, 'resources', 'licenses'), { recursive: true })
    for (const f of ['license.occt-import-js.txt', 'license.occt.txt']) fs.writeFileSync(path.join(root, 'resources', 'licenses', f), 'GNU LESSER GENERAL PUBLIC LICENSE')
    const good = { name: 'x', build: { files: ['**/*', '!resources/models/**', '!resources/licenses/**'], extraResources: [{ from: 'resources/models', to: 'models' }, { from: 'resources/licenses', to: 'licenses' }] } }
    const runRoot = (pkg) => {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
      return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--root=${root}`], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
    }
    r = runRoot(good)
    ok(r.status === 0 && new RegExp(`内置模型就绪：${N} 条`).test(r.stdout), `check-models ①：打包配置齐全 → 通过 ${r.stderr}`)
    // ⑧ 缩略图取景口径（显示系）：没记只警告；记了且对不上当前 view.js 现算的 THUMB_VIEW → 拦（审查：显示系换向后没重出的缩略图照样过 dist）
    {
      const SHv = (await imp('scripts/nasa3d/sheets.mjs')).THUMB_VIEW
      const mp = path.join(root, 'resources', 'models', 'manifest.json')
      const m0 = fs.readFileSync(mp)
      const setTop = (o) => fs.writeFileSync(mp, JSON.stringify({ ...JSON.parse(m0), ...o }))
      ok(r.status === 0 && /⚠ manifest 没记 thumbView/.test(r.stdout), 'check-models ⑧：manifest 没记 thumbView（旧版 builtin）→ 只警告')
      setTop({ thumbView: SHv })
      r = runRoot(good)
      ok(r.status === 0 && !/thumbView/.test(r.stdout + r.stderr), `check-models ⑧：thumbView = 当前取景口径 → 通过、不警告 ${r.stderr}`)
      setTop({ thumbView: `${SHv.split('|')[0]}|d:000000000000` })
      r = runRoot(good)
      ok(r.status === 1 && /⑧ 随包缩略图的取景口径 .*\|d:000000000000 ≠ 当前/.test(r.stderr) && /nasa3d:sheets → nasa3d:build → nasa3d:builtin/.test(r.stderr), 'check-models ⑧：显示系换过、缩略图没重出 → 拦下')
      // ⑨ 随包件朝向 = 核定表：查仓库 / --root 时拦，--dir 只警告
      const man9 = JSON.parse(m0)
      const t9 = man9.models.find((m) => m.id === metas[0].id)
      const want9 = B.resolveFrame(t9.id, B.parseFrameOverrides(JSON.parse(fs.readFileSync(B.FRAME_OVERRIDES_FILE, 'utf8')))).frame
      ok(t9 && want9.verified === true, 'check-models ⑨ 夹具：TDRS-A 在核定表里（已核）')
      t9.frame = { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0], verified: false }
      fs.writeFileSync(mp, JSON.stringify(man9))
      r = runRoot(good)
      ok(r.status === 1 && r.stderr.includes(`⑨ 1 条随包件的朝向与 scripts/nasa3d/frame-overrides.json 对不上：${metas[0].id}（随包 [0, 0, 0, 1] 未核 → 核定表 [`), `check-models ⑨：覆盖表改了 q 而随包件没重出 → 拦下 ${r.stderr}`)
      const rd = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${path.join(root, 'resources', 'models')}`], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
      ok(rd.status === 0 && /⚠ 1 条随包件的朝向与 scripts\/nasa3d\/frame-overrides\.json 对不上/.test(rd.stdout), 'check-models ⑨：--dir（任意目录）只警告')
      fs.writeFileSync(mp, m0)
    }
    r = runRoot({ ...good, build: { ...good.build, files: ['**/*', '!resources/licenses/**'] } })
    ok(r.status === 1 && /① .*build\.files 缺 "!resources\/models\/\*\*"/.test(r.stderr), 'check-models ①：build.files 缺 models 排除项拦下')
    r = runRoot({ ...good, build: { ...good.build, extraResources: [{ from: 'resources/imagery', to: 'imagery' }, { from: 'resources/licenses', to: 'licenses' }] } })
    ok(r.status === 1 && /① .*extraResources 缺 \{ "from": "resources\/models"/.test(r.stderr), 'check-models ①：extraResources 缺 models 拦下')
    r = runRoot({ ...good, build: { files: ['**/*', '!resources/models/**'], extraResources: [{ from: 'resources/models', to: 'models' }] } })
    ok(r.status === 1 && /① .*build\.files 缺 "!resources\/licenses\/\*\*"/.test(r.stderr) && /① .*extraResources 缺 \{ "from": "resources\/licenses"/.test(r.stderr), 'check-models ①：许可原文没走 extraResources（打进了 asar）→ 拦下')
    fs.rmSync(path.join(root, 'resources', 'licenses', 'license.occt.txt'))
    r = runRoot(good)
    ok(r.status === 1 && /① 缺 resources\/licenses\/license\.occt\.txt/.test(r.stderr), 'check-models ①：LGPL 许可原文缺一份 → 拦下')
    fs.rmSync(path.join(root, 'resources'), { recursive: true })
    r = runRoot(good)
    ok(r.status === 1 && /找不到 resources[\\/]models/.test(r.stderr), 'check-models：内置子集未生成 → 中断')
    // 仓库真 package.json 的 ① 各项已登记（dist 链上这一条必须过）
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    ok(pkg.build.files.includes('!resources/models/**') && pkg.build.extraResources.some((x) => x.from === 'resources/models' && x.to === 'models'), '仓库 package.json：models 的 build.files 与 extraResources 已按 ① 登记')
    ok(pkg.build.files.includes('!resources/licenses/**') && pkg.build.extraResources.some((x) => x.from === 'resources/licenses' && x.to === 'licenses'), '仓库 package.json：licenses 走 extraResources（安装目录里看得见）')
    ok(pkg.build.files.includes('!packages/core/test/**'), '仓库 package.json：单测不进安装包')
    ok(/check-imagery\.mjs && node scripts\/check-models\.mjs --online/.test(pkg.scripts.dist), '仓库 package.json：dist 链 check-imagery 之后接 check-models --online')
    for (const f of ['license.occt-import-js.txt', 'license.occt.txt']) {
      const a = fs.readFileSync(path.join(REPO, 'resources', 'licenses', f)), b0 = fs.readFileSync(path.join(REPO, 'node_modules', 'occt-import-js', 'dist', f))
      ok(a.equals(b0) && /LESSER GENERAL PUBLIC LICENSE/.test(a.toString('utf8')), `resources/licenses/${f} 与 node_modules/occt-import-js/dist 里的原文逐字节相同`)
    }
  }
}

// ─────────────────────────────── ⑪ build.mjs 主流程（子进程，临时小语料） ───────────────────────────────
// --src-dir / --include-list / --known-dims / --out 全指到临时目录：不依赖 .models-src，也不碰 build/models
const BUILD = path.join(REPO, 'scripts', 'nasa3d', 'build.mjs')
const bOut = path.join(tmp, 'bout')
let runBuild, readM, m1
{
  deq(B.partialReasons({}), [], 'partialReasons：全量')
  ok(B.partialReasons({ missingGroups: ['station'] })[0].includes('station'), 'partialReasons：--groups 没选全')
  ok(/2 个文件/.test(B.partialReasons({ notBuilt: ['a', 'b'] })[0]), 'partialReasons：有文件既没处理也没旧产物')

  const corpus = path.join(tmp, 'corpus')
  const src = path.join(corpus, 'src')
  const ents = [
    ['tracking-and-data-relay-satellites-tdrs-a', 'spacecraft', 'Tracking and Data Relay Satellites (TDRS) (A)', [['Tracking and Data Relay Satellites (TDRS) (A).glb', 'tdrs-a.glb']]],
    ['cubesat-1-ru-generic', 'spacecraft', 'CubeSat - 1 RU Generic', [['CubeSat - 1 RU Generic.glb', 'cubesat-1ru.glb']]],
    ['satellite-kit', 'spacecraft', 'Satellite Kit', [['Satellite Kit radio 1.glb', 'satkit-radio-1.glb'], ['Satellite Kit wings 3.glb', 'satkit-wings-3.glb']]],
    ['test-station', 'station', 'Test Station', [['Test Station.glb', 'satkit-radio-1.glb']]]
  ]
  for (const [slug, , title, files] of ents) {
    fs.mkdirSync(path.join(src, slug), { recursive: true })
    for (const [name, fx] of files) fs.copyFileSync(path.join(FIX, fx), path.join(src, slug, name))
    fs.writeFileSync(path.join(src, slug, 'meta.json'), JSON.stringify({ slug, title, page: `https://science.nasa.gov/3d-resources/${slug}/`, contributors: ['NASA/Ames Research Center'], files: files.map(([file]) => ({ file })) }))
  }
  const incFile = path.join(corpus, 'include-list.json')
  fs.writeFileSync(incFile, JSON.stringify({ generated: 'test', source: 'test', groups: { include: ['spacecraft', 'station'], optional: [] }, entries: ents.map(([slug, group, title]) => ({ slug, group, title, include: true, glbs: [] })) }))
  // satellite-kit：known-dims 点名的是派生件 wings 3（n=2），主文件 radio 1 靠 inherit 沿用——主流程必须先算 wings
  const kdFile = path.join(corpus, 'known-dims.json')
  fs.writeFileSync(kdFile, JSON.stringify({
    'satellite-kit': { measure: 'span', valueM: 3, deployed: true, source: 'https://example.org/kit', sourceQuote: 'q', fit: 'longest', file: 'Satellite Kit wings 3.glb', inherit: true },
    'cubesat-1-ru-generic': knownDims['cubesat-1-ru-generic']
  }))
  // 本体朝向覆盖表：tdrs-a 与派生件 satellite-kit~2 核过，test-station 标明不校正；其余走 +Y 天顶缺省
  const foFile = path.join(corpus, 'frame-overrides.json')
  const qTdrs = BF.quatFromBodyAxes('+Y', '+Z'), qKit = BF.quatFromBodyAxes('+Z', '+X')
  fs.writeFileSync(foFile, JSON.stringify({ schema: 1, entries: {
    'nasa:tracking-and-data-relay-satellites-tdrs-a': { q: qTdrs, axes: { nadir: '+Y', velocity: '+Z' }, basis: 'visual+资料', note: 't', refs: ['https://example.org/t'] },
    'nasa:satellite-kit~2': { q: qKit, axes: { nadir: '+Z', velocity: '+X' }, basis: 'visual+资料', note: 'k', refs: [] }
  }, skipped: { 'nasa:test-station': '测试：不校正' } }))
  runBuild = (...extra) => spawnSync(process.execPath, [BUILD, `--src-dir=${src}`, `--include-list=${incFile}`, `--known-dims=${kdFile}`, `--frame-overrides=${foFile}`, '--concurrency=2', ...extra], { encoding: 'utf8' })
  readM = (dir, name = 'manifest.json') => { const p = path.join(dir, name); return fs.existsSync(p) ? { buf: fs.readFileSync(p), json: JSON.parse(fs.readFileSync(p, 'utf8')) } : null }
  const ALL = ['nasa:cubesat-1-ru-generic', 'nasa:satellite-kit', 'nasa:satellite-kit~2', 'nasa:test-station', 'nasa:tracking-and-data-relay-satellites-tdrs-a']

  let r = runBuild(`--out=${bOut}`)
  eq(r.status, 0, `build 全量：退出码 0 ${r.stderr.slice(-400)}`)
  m1 = readM(bOut)
  deq(m1 && m1.json.models.map((x) => x.id), ALL, 'build 全量：manifest.json 五条（多文件条目第 2 个为 ~2）')
  ok(m1.json.partial === undefined && !fs.existsSync(path.join(bOut, 'manifest.partial.json')), 'build 全量：没有 partial 标记、没有 partial 文件')
  const metaOf = (d) => JSON.parse(fs.readFileSync(path.join(bOut, d, 'meta.json'), 'utf8'))
  const bjOf = (d) => JSON.parse(fs.readFileSync(path.join(bOut, d, 'build.json'), 'utf8'))
  const kitP = metaOf('satellite-kit'), kitW = metaOf('satellite-kit~2')
  ok(kitW.units.sizeVerified && bjOf('satellite-kit~2').fit.mode === 'longest' && !bjOf('satellite-kit~2').fit.inheritedFrom, 'inherit：wings 3 按 known-dims 最长边反算')
  ok(kitP.units.sizeVerified && kitP.units.scaleToMeters === kitW.units.scaleToMeters && kitP.units.sizeSource === 'https://example.org/kit', 'inherit：主文件 radio 1 沿用同一比例与出处（处理顺序先 kd.file 后其余）')
  eq(bjOf('satellite-kit').fit.inheritedFrom, 'Satellite Kit wings 3.glb', 'inherit：build.json 记下沿用自哪个文件')
  eq(metaOf('test-station').units.sizeVerified, false, '没有已知尺寸的条目 → 未核')
  // 本体朝向：覆盖表有的 → q 覆盖、verified；没有的 → +Y 天顶缺省、未核；build.json 记来源；manifest 同步；REPORT 出「本体朝向」一节
  deq(metaOf('tracking-and-data-relay-satellites-tdrs-a').frame, { q_model2body: qTdrs, t_model2body: [0, 0, 0], verified: true, importQ: qTdrs }, 'frame-overrides：tdrs-a 按覆盖表、verified、importQ = 核定 q')
  deq(metaOf('satellite-kit~2').frame, { q_model2body: qKit, t_model2body: [0, 0, 0], verified: true, importQ: qKit }, 'frame-overrides：派生件 ~2 按自己的 id 覆盖')
  for (const d of ['satellite-kit', 'cubesat-1-ru-generic', 'test-station']) deq(metaOf(d).frame, { q_model2body: [...BF.Q_YUP_ZENITH], t_model2body: [0, 0, 0], verified: false, importQ: [...BF.Q_YUP_ZENITH] }, `frame-overrides：${d} 没核 → +Y 天顶缺省、未核`)
  deq(m1.json.models.find((x) => x.id === 'nasa:tracking-and-data-relay-satellites-tdrs-a').frame.importQ, qTdrs, 'manifest 的 frame 带 importQ（与 meta 同步）')
  deq([bjOf('tracking-and-data-relay-satellites-tdrs-a').frameFrom, bjOf('satellite-kit').frameFrom], ['override', 'default'], 'build.json 记朝向来源')
  ok(m1.json.models.find((x) => x.id === 'nasa:tracking-and-data-relay-satellites-tdrs-a').frame.verified === true && m1.json.models.find((x) => x.id === 'nasa:test-station').frame.verified === false, 'manifest 的 frame 与 meta 同步')
  {
    const rep = fs.readFileSync(path.join(bOut, 'REPORT.md'), 'utf8')
    ok(/## 本体朝向（frame-overrides\.json）/.test(rep) && /朝向已核（覆盖表）\s*\|\s*2 个文件/.test(rep) && /test-station\s*\|\s*测试：不校正/.test(rep) && /目录里没有的 id\s*\|\s*0/.test(rep), 'REPORT：本体朝向一节（核过条数、不校正原因、表里有目录里没有的 id = 0）')
    ok(/朝向已核 \/ 缺省\s*\|?\s*2 \/ 3/.test(r.stdout), '终端汇总：朝向已核 / 缺省')
  }
  {
    // 坏覆盖表：坏条目不收（按缺省出）、REPORT 列出、退出码 1；另开输出目录，不动上面的产物
    const foBad = path.join(corpus, 'frame-overrides.bad.json')
    fs.writeFileSync(foBad, JSON.stringify({ schema: 1, entries: { 'nasa:tracking-and-data-relay-satellites-tdrs-a': { q: [0, 0, 0, 2], basis: 'x' } } }))
    const bBad = path.join(tmp, 'bout-badfo')
    const rb = spawnSync(process.execPath, [BUILD, `--src-dir=${src}`, `--include-list=${incFile}`, `--known-dims=${kdFile}`, `--frame-overrides=${foBad}`, '--concurrency=2', `--out=${bBad}`], { encoding: 'utf8' })
    eq(rb.status, 1, 'frame-overrides 有坏条目 → 退出码 1')
    const mb = JSON.parse(fs.readFileSync(path.join(bBad, 'tracking-and-data-relay-satellites-tdrs-a', 'meta.json'), 'utf8'))
    deq([mb.frame.q_model2body, mb.frame.verified], [[...BF.Q_YUP_ZENITH], false], '坏条目不收 → 按缺省出、未核')
    ok(/覆盖表坏条目（未收，按缺省出）/.test(fs.readFileSync(path.join(bBad, 'REPORT.md'), 'utf8')) && /frame-overrides\.json 有 1 条坏条目/.test(rb.stdout), '坏条目在 REPORT 与终端都有提示')
  }
  {
    // 覆盖表里有、目录里没有的 id（抄错 / NASA 改了 slug）：全量运行退出码 1、REPORT 与终端都列出；子集运行不判（本来就没覆盖全）
    const foStale = path.join(corpus, 'frame-overrides.stale.json')
    const stale = JSON.parse(fs.readFileSync(foFile, 'utf8'))
    stale.entries['nasa:gone-from-corpus'] = { q: [0, 0, 0, 1], basis: 'visual+资料' }
    fs.writeFileSync(foStale, JSON.stringify(stale))
    const bStale = path.join(tmp, 'bout-stalefo')
    const runStale = (...extra) => spawnSync(process.execPath, [BUILD, `--src-dir=${src}`, `--include-list=${incFile}`, `--known-dims=${kdFile}`, `--frame-overrides=${foStale}`, '--concurrency=2', `--out=${bStale}`, ...extra], { encoding: 'utf8' })
    const rs = runStale()
    eq(rs.status, 1, 'frame-overrides 有目录里没有的 id → 全量运行退出码 1')
    ok(/nasa:gone-from-corpus/.test(fs.readFileSync(path.join(bStale, 'REPORT.md'), 'utf8')) && /1 个 id 在本次目录里找不到/.test(rs.stdout), '表里有、目录里没有的 id 在 REPORT 与终端都列出')
    deq(JSON.parse(fs.readFileSync(path.join(bStale, 'tracking-and-data-relay-satellites-tdrs-a', 'meta.json'), 'utf8')).frame.verified, true, '其余条目照常按覆盖表出')
    const rp = runStale('--groups=spacecraft')
    eq(rp.status, 0, `子集运行不判表里有、目录里没有的 id → 退出码 0 ${rp.stderr.slice(-300)}`)
  }
  ok(/lod0（目标 ≤ 200 MB）\s*\|?\s*[\d.]+ MB（[\d.]+ MiB）/.test(r.stdout), '终端汇总：体积按十进制 MB 并附 MiB')

  // 审查复现 ①：--groups 没选全 → 只写 manifest.partial.json，共享的 manifest.json 一字不动
  r = runBuild(`--out=${bOut}`, '--groups=spacecraft')
  eq(r.status, 0, `build --groups：退出码 0 ${r.stderr.slice(-400)}`)
  ok(readM(bOut).buf.equals(m1.buf), 'build --groups：manifest.json 逐字节不变')
  const p2 = readM(bOut, 'manifest.partial.json')
  ok(p2 && p2.json.partial === true && p2.json.models.length === 4 && /station/.test(p2.json.partialReasons.join()), 'build --groups：manifest.partial.json 带 partial 与原因、只含所选分组')
  ok(/子集运行/.test(r.stdout), 'build --groups：终端提示子集运行')

  // --only 同目录同选项 + --force：其余条目走缓存并进 manifest → 全量；重做的文件逐字节相同 → updatedAt / generatedAt / buildId 都不变
  r = runBuild(`--out=${bOut}`, '--only=cubesat-1-ru-generic', '--force')
  eq(r.status, 0, `build --only --force：退出码 0 ${r.stderr.slice(-400)}`)
  ok(/待处理 1（/.test(r.stdout), 'build --only --force：只处理 1 个文件')
  ok(readM(bOut).buf.equals(m1.buf), 'build --only：manifest.json 与全量逐字节相同（缓存条目并入、updatedAt 与 generatedAt 保持）')
  ok(!fs.existsSync(path.join(bOut, 'manifest.partial.json')), 'build：全量写成功后清掉旧的 manifest.partial.json')

  // 审查复现 ②：全新 --out 只跑一个条目 → 其余没有旧产物 → 子集，不写 manifest.json
  const fresh = path.join(tmp, 'bout-fresh')
  r = runBuild(`--out=${fresh}`, '--only=cubesat-1-ru-generic')
  eq(r.status, 0, `build 全新 --out + --only：退出码 0 ${r.stderr.slice(-400)}`)
  const pf = readM(fresh, 'manifest.partial.json')
  ok(!fs.existsSync(path.join(fresh, 'manifest.json')) && pf && pf.json.models.length === 1 && /4 个文件/.test(pf.json.partialReasons.join()), 'build 全新 --out：只写 manifest.partial.json（1 条，原因：4 个文件没有旧产物）')
}

// ─────────────────────────────── ⑫ publish.mjs 主流程（子进程 + 有状态的假 COS，不联网） ───────────────────────────────
// 假 COS 以 --import 模块注入：给 node:https 默认导出的 request 打补丁（cos.mjs 用默认导入，补丁看得见），
// 桶状态（对象字节 / ETag / x-cos-meta-sha256 / 小对象正文）与请求日志经 FAKECOS_STATE 这个 JSON 文件进出，
// fail 规则按方法 + 键名正则注入错误。环境变量只给假凭据：不继承本机真实 COS_*（发版机上是设了的）。
const FAKE = path.join(tmp, 'fakecos.mjs')
fs.writeFileSync(FAKE, `
import https from 'node:https'
import { Writable, Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync } from 'node:fs'
const STATE = process.env.FAKECOS_STATE
const st = JSON.parse(readFileSync(STATE, 'utf8'))
const store = new Map(Object.entries(st.store || {}))
const fails = (st.fail || []).map((r) => ({ ...r, left: r.times ?? 1e9 }))
const log = [], uploads = new Map()
let seq = 0
const md5 = (b) => createHash('md5').update(b).digest('hex')
const sha = (b) => createHash('sha256').update(b).digest('hex')
function put(key, body, h, etag) {
  store.set(key, { bytes: body.length, etag, meta: h['x-cos-meta-sha256'] || null, sha: sha(body), ct: h['Content-Type'] || null, cache: h['Cache-Control'] || null, ...(body.length < (4 << 20) ? { body64: body.toString('base64') } : {}) })
}
function handle(e, body) {
  const u = new URL('https://x' + e.path)
  const key = decodeURIComponent(u.pathname.slice(1))
  const q = u.searchParams
  for (const r of fails) if (r.left > 0 && (!r.method || r.method === e.method) && new RegExp(r.path).test(key)) { r.left--; return { status: r.status, text: '<Error><Code>' + (r.code || 'InternalError') + '</Code></Error>' } }
  if (e.method === 'HEAD' || e.method === 'GET') {
    const o = store.get(key)
    if (!o) return { status: 404, text: '' }
    const headers = { 'content-length': String(o.bytes), etag: '"' + o.etag + '"' }
    if (o.meta) headers['x-cos-meta-sha256'] = o.meta
    return { status: 200, headers, text: e.method === 'GET' ? Buffer.from(o.body64 || '', 'base64') : '' }
  }
  if (!e.headers.Authorization) return { status: 403, text: '<Error><Code>AccessDenied</Code></Error>' }
  if (e.method === 'POST' && q.has('uploads')) { const id = 'U' + (++seq); uploads.set(id, { key, parts: new Map(), headers: e.headers }); return { status: 200, text: '<InitiateMultipartUploadResult><UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>' } }
  if (e.method === 'PUT' && q.has('uploadId')) { uploads.get(q.get('uploadId')).parts.set(Number(q.get('partNumber')), body); return { status: 200, headers: { etag: '"' + md5(body) + '"' }, text: '' } }
  if (e.method === 'POST' && q.has('uploadId')) {
    const up = uploads.get(q.get('uploadId'))
    const all = Buffer.concat([...up.parts.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]))
    put(up.key, all, up.headers, md5(all) + '-' + up.parts.size)
    return { status: 200, text: '<CompleteMultipartUploadResult/>' }
  }
  if (e.method === 'DELETE') return { status: 204, text: '' }
  if (e.method === 'PUT') { put(key, body, e.headers, md5(body)); return { status: 200, headers: { etag: '"' + md5(body) + '"' }, text: '' } }
  return { status: 400, text: '<Error><Code>Unexpected</Code></Error>' }
}
https.request = (opts, cb) => {
  const chunks = []
  let toMs = null
  const req = new Writable({
    write(c, _e, done) { chunks.push(Buffer.from(c)); done() },
    final(done) {
      const body = Buffer.concat(chunks)
      const e = { method: opts.method || 'GET', path: opts.path, headers: { ...(opts.headers || {}) } }
      const r = handle(e, body)
      const u = new URL('https://x' + e.path)
      log.push({ method: e.method, host: opts.host, key: decodeURIComponent(u.pathname.slice(1)), query: u.search, signed: !!e.headers.Authorization, ct: e.headers['Content-Type'] || null, cache: e.headers['Cache-Control'] || null, meta: e.headers['x-cos-meta-sha256'] || null, timeoutMs: toMs, bodyLen: body.length, status: r.status })
      done()
      setImmediate(() => { const res = Readable.from([Buffer.from(r.text || '')]); res.statusCode = r.status; res.headers = r.headers || {}; cb(res) })
    }
  })
  req.setTimeout = (ms) => { toMs = ms; return req }
  return req
}
process.on('exit', () => writeFileSync(STATE, JSON.stringify({ store: Object.fromEntries(store), log })))
`)
const PUBLISH = path.join(REPO, 'scripts', 'nasa3d', 'publish.mjs')
const pubEnvBase = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^COS_/.test(k)))
const FAKE_CREDS = { COS_SECRET_ID: 'AKIDTESTONLY', COS_SECRET_KEY: 'SECRETTESTONLY', COS_BUCKET: P.PINNED_BUCKET, COS_REGION: P.PINNED_REGION }
let pubSeq = 0
function runPub(args, { store = {}, fail = [], env = FAKE_CREDS } = {}) {
  const stFile = path.join(tmp, `cos-state-${++pubSeq}.json`)
  fs.writeFileSync(stFile, JSON.stringify({ store, fail }))
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(FAKE).href, PUBLISH, ...args], { encoding: 'utf8', env: { ...pubEnvBase, ...env, FAKECOS_STATE: stFile } })
  const st = JSON.parse(fs.readFileSync(stFile, 'utf8'))
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, store: st.store || {}, log: st.log || [] }
}
const writes = (log) => log.filter((e) => e.method !== 'HEAD' && e.method !== 'GET')
{
  const bargs = ['--only-build', `--build-dir=${bOut}`]
  const man = m1.json
  const mKeySnap = P.manifestKey(man.buildId), mKey = P.manifestKey(null)
  const blobKeys = new Set()
  for (const m of man.models) for (const k of ['lod0', 'lod1', 'lod2']) blobKeys.add(P.blobKey(m.files[k].sha256, 'glb'))

  // 首传：探针 → 缩水闸（GET，404=首次）→ blobs → manifest 快照 → manifest.json
  let r = runPub(bargs)
  eq(r.status, 0, `publish 首传：退出码 0 ${r.stderr.slice(-400)}`)
  const w = writes(r.log)
  ok(w[0].key === P.PROBE_KEY && w[0].method === 'PUT' && w[0].signed, 'publish：第一个写请求是带签名的探针')
  ok(r.log[1].method === 'GET' && r.log[1].key === mKey && r.log[1].status === 404 && !r.log[1].signed, 'publish：探针之后、传任何东西之前公共读 GET 云端 manifest.json')
  const blobPuts = w.filter((e) => e.key.startsWith(`${P.PREFIX}blobs/`))
  eq(blobPuts.length, blobKeys.size, `publish：blob 逐个上传（${blobKeys.size} 个，同 sha 只传一次）`)
  ok(blobPuts.every((e) => e.cache === P.CACHE_IMMUTABLE && e.ct === 'model/gltf-binary' && e.key.includes(e.meta) && e.timeoutMs === COS.DEFAULT_TIMEOUT_MS), 'publish：blob 带 immutable / Content-Type / x-cos-meta-sha256 / 超时')
  deq(w.slice(-2).map((e) => [e.key, e.cache]), [[mKeySnap, P.CACHE_IMMUTABLE], [mKey, P.CACHE_NONE]], 'publish：最后两个写请求依次是 manifest 快照（immutable）与 manifest.json（no-cache）')
  ok(w.findIndex((e) => e.key === mKeySnap) > Math.max(...blobPuts.map((e) => w.indexOf(e))), 'publish：manifest 排在所有 blob 之后')
  eq(r.store[mKey].meta, sha256(m1.buf), 'publish：云端 manifest.json 的 sha 元数据 = 本地文件')
  const s1 = r.store

  // 重跑：全部去重跳过；快照已在桶里；manifest.json 照传（no-cache，内容相同）
  r = runPub(bargs, { store: s1 })
  eq(r.status, 0, `publish 重跑：退出码 0 ${r.stderr.slice(-400)}`)
  deq(writes(r.log).map((e) => e.key), [P.PROBE_KEY, mKey], 'publish 重跑：blob 与快照全部去重跳过，只重写 manifest.json')
  ok(/缩水闸：云端 5 条 → 本次 5 条（新增 0，缺 0，丢缩略图 0）/.test(r.stdout), 'publish 重跑：缩水闸打印对账')

  // 审查复现：云端 manifest 比本次多条目（本次是子集）→ 缩水闸拒绝，一个对象都不传
  const ghost = JSON.parse(JSON.stringify(man))
  ghost.models.push({ ...ghost.models[0], id: 'nasa:ghost-model' })
  const ghostBuf = Buffer.from(JSON.stringify(ghost))
  const s2 = { ...s1, [mKey]: { bytes: ghostBuf.length, etag: crypto.createHash('md5').update(ghostBuf).digest('hex'), body64: ghostBuf.toString('base64') } }
  r = runPub(bargs, { store: s2 })
  eq(r.status, 2, 'publish 缩水：退出码 2')
  ok(/缩水闸：云端 6 条 → 本次 5 条（新增 0，缺 1，丢缩略图 0）/.test(r.stderr) && /nasa:ghost-model/.test(r.stderr), 'publish 缩水：列出会消失的 id')
  deq(writes(r.log).map((e) => e.key), [P.PROBE_KEY], 'publish 缩水：除探针外没有任何写请求')
  r = runPub([...bargs, '--allow-shrink'], { store: s2 })
  ok(r.status === 0 && r.store[mKey].meta === sha256(m1.buf) && /--allow-shrink 放行/.test(r.stderr + r.stdout), 'publish --allow-shrink：放行并覆盖云端 manifest.json')
  // 审查复现（W17a）：云端条目带缩略图、本次同 id 没有（改了 frame 后缩略图整批判过期、没重跑 sheets）→ 同一道闸拒绝，一个对象都不传
  {
    ok(man.models.every((m) => !m.files.thumb), '前提：本次 build 目录没有缩略图')
    const withThumb = JSON.parse(JSON.stringify(man))
    withThumb.models[0].files.thumb = { sha256: 'f'.repeat(64), bytes: 1234 }
    const tb = Buffer.from(JSON.stringify(withThumb))
    const s3 = { ...s1, [mKey]: { bytes: tb.length, etag: crypto.createHash('md5').update(tb).digest('hex'), body64: tb.toString('base64') } }
    r = runPub(bargs, { store: s3 })
    eq(r.status, 2, 'publish 丢缩略图：退出码 2')
    ok(/丢缩略图 1）/.test(r.stderr) && r.stderr.includes(man.models[0].id) && /nasa3d:sheets/.test(r.stderr), 'publish 丢缩略图：列出 id、提示先重跑 sheets')
    deq(writes(r.log).map((e) => e.key), [P.PROBE_KEY], 'publish 丢缩略图：除探针外没有任何写请求')
    r = runPub([...bargs, '--allow-shrink'], { store: s3 })
    ok(r.status === 0 && r.store[mKey].meta === sha256(m1.buf) && /去掉缩略图的条目/.test(r.stderr + r.stdout), 'publish 丢缩略图 + --allow-shrink：放行')
  }
  // 云端 manifest 读不懂 → 比不了 → 拒绝
  r = runPub(bargs, { store: { ...s1, [mKey]: { bytes: 3, etag: 'x', body64: Buffer.from('{{{').toString('base64') } } })
  ok(r.status === 2 && /不是合法 JSON/.test(r.stderr) && writes(r.log).length === 1, 'publish：云端 manifest.json 读不懂 → 退出码 2、不传')
  // GET 失败（5xx）→ 比不了 → 拒绝
  r = runPub(bargs, { fail: [{ method: 'GET', path: 'manifest\\.json$', status: 503 }] })
  ok(r.status === 2 && /HTTP 503/.test(r.stderr) && writes(r.log).length === 1, 'publish：读云端 manifest 得 5xx → 退出码 2、不传')

  // blob 失败 → manifest 一份都不发（403 不重试，免得单测里等退避）
  const firstBlob = [...blobKeys][0]
  r = runPub(bargs, { fail: [{ method: 'PUT', path: firstBlob.replace(/[.]/g, '\\.') + '$', status: 403, code: 'AccessDenied' }] })
  eq(r.status, 1, 'publish blob 失败：退出码 1')
  ok(!writes(r.log).some((e) => e.key === mKey || e.key === mKeySnap) && /manifest 不发布/.test(r.stderr), 'publish blob 失败：manifest 快照与 manifest.json 都不传')

  // 快照传失败 → manifest.json 不动
  r = runPub(bargs, { fail: [{ method: 'PUT', path: `manifest\\.${man.buildId}\\.json$`, status: 403, code: 'AccessDenied' }] })
  ok(r.status === 1 && !writes(r.log).some((e) => e.key === mKey), 'publish：快照没传上 → manifest.json 不动')

  // 凭据 / 桶 / 探针
  r = runPub(bargs, { env: { ...FAKE_CREDS, COS_BUCKET: 'other-1234567890' } })
  ok(r.status === 2 && r.log.length === 0 && /钉死/.test(r.stderr), 'publish：桶不是钉死的那个 → 退出码 2、零请求')
  r = runPub(bargs, { env: { COS_SECRET_ID: 'x' } })
  ok(r.status === 2 && r.log.length === 0 && /缺少环境变量/.test(r.stderr), 'publish：凭据不齐 → 退出码 2、零请求')
  r = runPub(bargs, { fail: [{ method: 'PUT', path: '_probe$', status: 403, code: 'AccessDenied' }] })
  ok(r.status === 2 && r.log.length === 1 && /CAM 策略/.test(r.stdout), 'publish：探针 AccessDenied → 退出码 2、只发了探针')

  // dry-run：零请求
  r = runPub([...bargs, '--dry-run'])
  ok(r.status === 0 && r.log.length === 0 && /缩水闸/.test(r.stdout), 'publish --dry-run：不联网（零请求），提示缩水闸只在实传时跑')

  // 带 partial 标记的 manifest（子集产物被改名成 manifest.json）→ 本地核对不过
  const pdir = path.join(tmp, 'pub-partial')
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({ ...man, partial: true }))
  r = runPub(['--only-build', `--build-dir=${pdir}`])
  ok(r.status === 1 && /partial/.test(r.stderr) && r.log.length === 0, 'publish：manifest 带 partial 标记 → 退出码 1、零请求')
  // 目录里只有 manifest.partial.json → 提示先全量 build
  const pdir2 = path.join(tmp, 'pub-partial2')
  fs.mkdirSync(pdir2, { recursive: true })
  fs.writeFileSync(path.join(pdir2, 'manifest.partial.json'), '{}')
  r = runPub(['--only-build', `--build-dir=${pdir2}`])
  ok(r.status === 2 && /子集运行/.test(r.stderr), 'publish：只有 manifest.partial.json → 退出码 2 并说明原因')
}
{
  // 原件镜像：>8 MiB 走分块；按文件名寻址，靠 x-cos-meta-sha256 认出「字节数相同、内容不同」
  const sdir = path.join(tmp, 'pubsrc')
  const big = crypto.randomBytes(9 * 1024 * 1024 + 7)
  const small = Buffer.from('small glb bytes')
  const put = (slug, f, b) => { fs.mkdirSync(path.join(sdir, slug), { recursive: true }); fs.writeFileSync(path.join(sdir, slug, f), b); fs.writeFileSync(path.join(sdir, slug, f + '.sha256'), `${sha256(b)}  ${f}\n`) }
  put('big-one', 'Big (A).glb', big)
  put('small-one', 'S.glb', small)
  const sargs = ['--only-src', `--src-dir=${sdir}`]
  const bigKey = P.srcKey('big-one', 'Big (A).glb'), bigSide = bigKey + '.sha256'
  const smallKey = P.srcKey('small-one', 'S.glb'), smallSide = smallKey + '.sha256'

  let r = runPub(sargs)
  eq(r.status, 0, `publish --only-src 首传：退出码 0 ${r.stderr.slice(-400)}`)
  let w = writes(r.log)
  ok(!r.log.some((e) => e.method === 'GET'), 'publish --only-src：不读云端 manifest（不传 manifest 就不需要缩水闸）')
  const init = w.find((e) => e.key === bigKey && /uploads/.test(e.query))
  ok(init && init.meta === sha256(big) && init.ct === 'model/gltf-binary', 'publish：大原件走分块，x-cos-meta-sha256 在 initiate 上')
  ok(w.filter((e) => e.key === bigKey).every((e) => e.timeoutMs === COS.DEFAULT_TIMEOUT_MS), 'publish：分块上传每一步都带超时')
  ok(w.findIndex((e) => e.key === bigSide) > w.findLastIndex((e) => e.key === bigKey) && w.findIndex((e) => e.key === smallSide) > w.findIndex((e) => e.key === smallKey), 'publish：旁车排在它的 glb 之后')
  eq(r.store[bigKey].meta, sha256(big), '云端大原件带 sha 元数据')
  const s1 = r.store

  r = runPub(sargs, { store: s1 })
  deq(writes(r.log).map((e) => e.key), [P.PROBE_KEY], 'publish --only-src 重跑：全部去重跳过')

  // 审查复现：NASA 重导出了一个字节数相同、内容不同的大原件 → 旧版只比字节会跳过；现在比 sha 元数据 → 重传
  const stale = { ...s1, [bigKey]: { ...s1[bigKey], meta: sha256(Buffer.from('old content')), etag: 'deadbeefdeadbeefdeadbeefdeadbeef-2' } }
  r = runPub(sargs, { store: stale })
  ok(r.status === 0 && writes(r.log).some((e) => e.key === bigKey && /uploads/.test(e.query)) && r.store[bigKey].meta === sha256(big), 'publish：同字节数、sha 元数据不同的大原件 → 重传')
  // 没有 sha 元数据的分块对象（按文件名寻址）→ 认不出内容 → 重传
  const nometa = { ...s1, [bigKey]: { ...s1[bigKey], meta: null, etag: 'deadbeefdeadbeefdeadbeefdeadbeef-2' } }
  r = runPub(sargs, { store: nometa })
  ok(r.status === 0 && writes(r.log).some((e) => e.key === bigKey && /uploads/.test(e.query)), 'publish：分块原件没有 sha 元数据 → 重传')

  // glb 没传上 → 它的旁车这轮不动
  r = runPub(sargs, { fail: [{ method: 'PUT', path: 'small-one/S\\.glb$', status: 403, code: 'AccessDenied' }] })
  ok(r.status === 1 && !writes(r.log).some((e) => e.key === smallSide) && /旁车暂缓/.test(r.stderr), 'publish：glb 失败 → 旁车暂缓、退出码 1')
}

// ⑪ 续：换处理选项只重做一个条目 → 其余条目缓存不可用 → 子集；manifest.json 不动，而磁盘上那个条目的三档已变，
// 发布端 planBlobs 逐个重算 sha 会拦下（第二道闸）
{
  // 出厂档已是 high / lod2 256（2026-09-24）：换回 medium 才算「换处理选项」
  const r = runBuild(`--out=${bOut}`, '--only=cubesat-1-ru-generic', '--level=medium')
  eq(r.status, 0, `build --only --level=medium：退出码 0 ${r.stderr.slice(-400)}`)
  ok(readM(bOut).buf.equals(m1.buf), 'build 换选项的 --only：manifest.json 不动')
  const pp = readM(bOut, 'manifest.partial.json')
  ok(pp && pp.json.models.length === 1 && /4 个文件/.test(pp.json.partialReasons.join()), 'build 换选项的 --only：只写 manifest.partial.json')
  const d = runPub(['--only-build', `--build-dir=${bOut}`, '--dry-run'])
  ok(d.status === 1 && /本地文件与 manifest 不符/.test(d.stderr), 'publish：旧 manifest.json 指向的文件已被改写 → 本地核对拦下')
}

// ─────────────────────────────── ⑬ 离线管线后半（W9）：build 处理档 / lod2 预算 / 材质兜底 / sheets / 稳健取景 / builtin ───────────────────────────────
const SH = await imp('scripts/nasa3d/sheets.mjs')
const CROP = await imp('scripts/nasa3d/sheets-page/crop.mjs')
const BI = await imp('scripts/nasa3d/builtin.mjs')
{
  // build：出厂处理档（2026-09-24：high + lod2 贴图 256 + lod2 ≤ 2.5 万面 + 剔除 < 1 %）
  deq(B.resolveProcOpts({}), { meshoptLevel: 'high', lod2Flags: ['Prune', 'Permissive'], lod2MaxTex: 256, lod2MaxTris: 25000, lod2CullFrac: 0.01 }, 'resolveProcOpts：缺省 = 出厂档')
  deq(B.resolveProcOpts({ level: 'medium', lod2Tex: '512', lod2Strict: true, lod2MaxTris: '0', lod2Cull: '0' }), { meshoptLevel: 'medium', lod2Flags: [], lod2MaxTex: 512, lod2MaxTris: 0, lod2CullFrac: 0 }, 'resolveProcOpts：命令行覆盖（字符串数值也认；0 = 关）')
  deq(Object.keys(B.resolveProcOpts({})), ['meshoptLevel', 'lod2Flags', 'lod2MaxTex', 'lod2MaxTris', 'lod2CullFrac'], 'resolveProcOpts：键序固定（build.json 缓存比对用 JSON 串）')
  assert.throws(() => B.resolveProcOpts({ level: 'max' }), /--level 只能是/); n++
  assert.throws(() => B.resolveProcOpts({ lod2Tex: 300 }), /--lod2-tex 只能是/); n++
  assert.throws(() => B.resolveProcOpts({ lod2MaxTris: 500 }), /--lod2-max-tris 只能是/); n++
  assert.throws(() => B.resolveProcOpts({ lod2MaxTris: 1.5e4 + 0.5 }), /--lod2-max-tris 只能是/); n++
  assert.throws(() => B.resolveProcOpts({ lod2Cull: 0.2 }), /--lod2-cull 只能是/); n++
  const lod2 = B.LOD_SPECS.find((x) => x.key === 'lod2'), lod0 = B.LOD_SPECS.find((x) => x.key === 'lod0')
  eq(lod2.maxTex, B.DEFAULT_LOD2_TEX, 'LOD_SPECS 的 lod2 上限 = 出厂 256')
  eq(B.texLimitFor(lod2, { lod2MaxTex: 512 }), 512, 'texLimitFor：lod2 按 job 覆盖')
  eq(B.texLimitFor(lod2, {}), 256, 'texLimitFor：老 job 没带 → LOD_SPECS')
  eq(B.texLimitFor(lod0, { lod2MaxTex: 64 }), 2048, 'texLimitFor：别的档不受 lod2 选项影响')
  eq(B.optsLabel({ meshoptLevel: 'medium', lod2Flags: ['Prune', 'Permissive'] }), 'medium · lod2 贴图 512 px', 'optsLabel：老 build.json 没 lod2MaxTex / 预算键 → 当时的 512、不设预算')
  eq(B.optsLabel(B.resolveProcOpts({ lod2Strict: true })), 'high · lod2 贴图 256 px · lod2 ≤ 2.5 万面 · 剔除 < 1 % · lod2 strict', 'optsLabel：预算与 strict 注明')
  eq(B.PIPELINE_VERSION, 3, '管线版本 3（材质兜底 + lod2 预算：旧缓存全部作废）')
  // history：每种处理档留最近一次、按时间排
  let h = B.updateHistory(null, { at: '2026-09-23T01:00:00Z', opts: { a: 1 }, lod0: 1 })
  h = B.updateHistory(h, { at: '2026-09-23T02:00:00Z', opts: { a: 2 }, lod0: 2 })
  h = B.updateHistory(h, { at: '2026-09-23T03:00:00Z', opts: { a: 1 }, lod0: 3 })
  deq(h.map((x) => [x.opts.a, x.lod0]), [[2, 2], [1, 3]], 'updateHistory：同处理档覆盖、按时间排序')
  // glbComposition：JSON 块 / 贴图 / 几何 三项 + 块头 = 文件长
  const lod2Buf = fs.readFileSync(path.join(tmp, 'build', 'tdrs-a', 'lod2.glb'))
  const c1 = B.glbComposition(new Uint8Array(lod2Buf))
  eq(c1.json + c1.bin + 20 + (c1.bin ? 8 : 0), c1.total, 'glbComposition：JSON + BIN + 块头 = 文件长')
  eq(c1.images + c1.geometry, c1.bin, 'glbComposition：贴图 + 几何 = BIN')
  const ssl = B.glbComposition(new Uint8Array(fs.readFileSync(path.join(tmp, 'build', 'ssl-1300', 'lod0.glb'))))
  const sslJson = LIB.parseGlbHeader(fs.readFileSync(path.join(tmp, 'build', 'ssl-1300', 'lod0.glb'))).json
  const imgBytes = [...new Set((sslJson.images || []).map((im) => im.bufferView))].reduce((s, v) => s + sslJson.bufferViews[v].byteLength, 0)
  eq(ssl.images, imgBytes, 'glbComposition：贴图字节 = images 引用的 bufferView 之和（同一 view 只算一次）')
  assert.throws(() => B.glbComposition(new Uint8Array(30)), /GLB|magic/); n++
}

// ⑬-a 材质兜底 / lod2 预算（合成 gltf-transform 文档）
{
  const { Document } = await import('@gltf-transform/core')
  const { KHRMaterialsSpecular } = await import('@gltf-transform/extensions')
  const F = await import('@gltf-transform/functions')
  const { MeshoptSimplifier } = await import('meshoptimizer')
  await MeshoptSimplifier.ready
  // 盒子：中心 c、半边长 h；grid：n×n 细分的平板（三角形多、可简化），带 uv
  const box = (doc, buf, c, h) => {
    const P = [], I = []
    for (let k = 0; k < 8; k++) P.push(c[0] + (k & 1 ? h : -h), c[1] + (k & 2 ? h : -h), c[2] + (k & 4 ? h : -h))
    for (const f of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) I.push(f[0], f[1], f[2], f[0], f[2], f[3])
    return doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf)).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(I)).setBuffer(buf))
  }
  const grid = (doc, buf, nq, size, bump = 0) => {
    const P = [], UV = [], I = []
    for (let j = 0; j <= nq; j++) for (let i = 0; i <= nq; i++) { P.push((i / nq - 0.5) * size, bump * Math.sin(i * 0.7) * Math.cos(j * 0.9), (j / nq - 0.5) * size); UV.push(i / nq, j / nq) }
    for (let j = 0; j < nq; j++) for (let i = 0; i < nq; i++) { const a = j * (nq + 1) + i; I.push(a, a + nq + 1, a + 1, a + 1, a + nq + 1, a + nq + 2) }
    return doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(UV)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(I)).setBuffer(buf))
  }
  const newDoc = () => { const doc = new Document(); const buf = doc.createBuffer(); const scene = doc.createScene(); doc.getRoot().setDefaultScene(scene); return { doc, buf, scene } }
  const addNode = (doc, scene, name, prim) => { const node = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)); scene.addChild(node); return node }

  // ① 无材质 → 中性浅灰；少量退化黑（有意的黑件）不动；电池片正面的退化黑不论占比都换
  {
    const { doc, buf, scene } = newDoc()
    const specExt = doc.createExtension(KHRMaterialsSpecular)
    const degBlack = (name) => doc.createMaterial(name).setBaseColorFactor([0, 0, 0, 1]).setExtension('KHR_materials_specular', specExt.createSpecular().setSpecularFactor(0))
    addNode(doc, scene, 'bare', box(doc, buf, [0, 0, 0], 1))
    const big = box(doc, buf, [5, 0, 0], 1); big.setMaterial(doc.createMaterial('paint').setBaseColorFactor([0.8, 0.8, 0.8, 1])); addNode(doc, scene, 'big', big)
    const big2 = box(doc, buf, [9, 0, 0], 1); big2.setMaterial(doc.createMaterial('paint2').setBaseColorFactor([0.7, 0.7, 0.7, 1])); addNode(doc, scene, 'big2', big2)
    const blk = box(doc, buf, [0, 5, 0], 1); blk.setMaterial(degBlack('black_krinkle')); addNode(doc, scene, 'blk', blk)
    const sol = box(doc, buf, [0, 9, 0], 1); sol.setMaterial(degBlack('Noaa-solarpanelFace')); addNode(doc, scene, 'sol', sol)
    ok(B.isDegenerateBlack(blk.getMaterial()) && !B.isDegenerateBlack(big.getMaterial()), 'isDegenerateBlack：底色 0 + specularFactor 0 才算')
    const fb = B.applyMaterialFallbacks(doc)
    eq(fb.noMaterialPrims, 1, 'applyMaterialFallbacks：无材质图元计数')
    const bare = doc.getRoot().listNodes().find((x) => x.getName() === 'bare').getMesh().listPrimitives()[0].getMaterial()
    ok(bare && bare.getName() === B.NEUTRAL_MATERIAL_NAME && bare.getMetallicFactor() === 0 && bare.getBaseColorFactor()[0] === 0.8, 'applyMaterialFallbacks：无材质 → 中性浅灰非金属')
    near(fb.degenerate.share, 0.4, 1e-9, 'applyMaterialFallbacks：退化黑占比按三角形算')
    deq(fb.degenerate.fixed, ['Noaa-solarpanelFace'], 'applyMaterialFallbacks：占比 ≤ 50 % 时有意的黑件不动，电池片正面照换')
    ok(blk.getMaterial().getBaseColorFactor()[0] === 0 && blk.getMaterial().getExtension('KHR_materials_specular'), 'applyMaterialFallbacks：black_krinkle 原样')
    ok(sol.getMaterial().getBaseColorFactor()[2] > 0.1 && !sol.getMaterial().getExtension('KHR_materials_specular'), 'applyMaterialFallbacks：电池片正面 → 深蓝带光泽、去掉 specularFactor 0')
  }
  {
    const { doc, buf, scene } = newDoc()
    const specExt = doc.createExtension(KHRMaterialsSpecular)
    const degBlack = (name) => doc.createMaterial(name).setBaseColorFactor([0, 0, 0, 1]).setExtension('KHR_materials_specular', specExt.createSpecular().setSpecularFactor(0))
    const names = ['white', 'anod_aluminum', 'gold', 'grey', 'red_orange', 'black', 'thing']
    names.forEach((nm, i) => { const p = box(doc, buf, [i * 3, 0, 0], 1); p.setMaterial(degBlack(nm)); addNode(doc, scene, nm, p) })
    const fb = B.applyMaterialFallbacks(doc)
    eq(fb.degenerate.share, 1, 'applyMaterialFallbacks：整件退化黑（Cassini Assembly 式）')
    const col = (nm) => doc.getRoot().listMaterials().find((m) => m.getName() === nm)
    ok(col('white').getBaseColorFactor()[0] > 0.8 && col('anod_aluminum').getMetallicFactor() === 1 && col('gold').getBaseColorFactor()[0] > col('gold').getBaseColorFactor()[2] * 2 &&
      col('black').getBaseColorFactor()[0] < 0.05 && col('thing').getBaseColorFactor()[0] === 0.6 && col('red_orange').getBaseColorFactor()[0] > 0.5, 'applyMaterialFallbacks：按名字还原（白 / 金属 / 金 / 黑 / 红 / 缺省灰）')
    ok(doc.getRoot().listMaterials().every((m) => !m.getExtension('KHR_materials_specular')), 'applyMaterialFallbacks：还原后去掉 specularFactor 0')
    eq(B.degeneratePaletteFor('James_Webb:sacells_blinn').re, B.SOLAR_FACE_RE, 'degeneratePaletteFor：…cells → 电池片外观')
    ok(!B.SOLAR_FACE_RE.test('Solar-edge-back') && B.SOLAR_FACE_RE.test('Noaa-solarpanelFace') && B.SOLAR_FACE_RE.test('cell'), 'SOLAR_FACE_RE：电池片正面认、太阳翼背面 / 侧边不认')
  }
  // ② 零碎件剔除：整件尺度 1 % 以下的网格摘掉、节点留着；剔除的三角形封顶 20 %
  {
    const { doc, buf, scene } = newDoc()
    addNode(doc, scene, 'hull', grid(doc, buf, 30, 20))   // 1800 面：螺栓只占 2 %，不碰封顶
    const bolts = []
    for (let i = 0; i < 3; i++) bolts.push(addNode(doc, scene, `bolt${i}`, box(doc, buf, [9, i * 2 - 2, 9], 0.05)))
    addNode(doc, scene, 'panel', box(doc, buf, [0, 12, 0], 2))
    const c = B.cullSmallMeshes(doc, F, 0.01)
    eq(c.meshes, 3, 'cullSmallMeshes：三颗螺栓（半对角 0.087 m < 1 % × 整件）摘掉')
    eq(c.tris, 36, 'cullSmallMeshes：摘掉的三角形计数')
    ok(bolts.every((x) => !x.getMesh()) && doc.getRoot().listNodes().length === 5, 'cullSmallMeshes：节点留着（名字一个不少），只摘网格')
    ok(doc.getRoot().listNodes().find((x) => x.getName() === 'panel').getMesh(), 'cullSmallMeshes：大于阈的件不动')
    const d2 = newDoc()
    addNode(d2.doc, d2.scene, 'hull', grid(d2.doc, d2.buf, 10, 20))   // 200 面 + 6 颗螺栓 72 面：封顶 20 % = 54 面 → 只摘 4 颗
    for (let i = 0; i < 6; i++) addNode(d2.doc, d2.scene, `b${i}`, box(d2.doc, d2.buf, [9, i, 9], 0.05))
    const c2 = B.cullSmallMeshes(d2.doc, F, 0.01, 0.2)
    ok(c2.tris / c2.total <= 0.2 && c2.meshes === 4, `cullSmallMeshes：剔除封顶 20 % 三角形（${c2.meshes} 件 / ${c2.tris} 面）`)
    eq(B.cullSmallMeshes(newDoc().doc, F, 0.01).meshes, 0, 'cullSmallMeshes：空文档不出错')
  }
  // ③ 三角形上限：超上限的放宽 error 再降；带贴图的图元走 uv 计误差的简化
  {
    const { doc, buf, scene } = newDoc()
    addNode(doc, scene, 'dense', grid(doc, buf, 120, 10, 0.3))   // 28 800 个三角形
    const spec = B.LOD_SPECS.find((x) => x.key === 'lod2')
    const S = B.withSimplifyFlags(MeshoptSimplifier, B.LOD2_FLAGS)
    const r = await B.simplifyToBudget(doc, F, spec, { simplifier: S, raw: MeshoptSimplifier, flags: [...B.LOD2_FLAGS], uvWeight: 0, maxTris: 1500 })
    const t = B.countSceneTriangles(r.doc)
    ok(r.budget.cap && t <= 1500 * 1.1 && r.budget.cap.before > 1500 * 1.1 && r.budget.cap.after === t, `simplifyToBudget：超上限 → 放宽 error 再降（${r.budget.cap.before} → ${t}）`)
    eq(B.countSceneTriangles(doc), 28800, 'simplifyToBudget：基准文档不动')
    const r0 = await B.simplifyToBudget(doc, F, spec, { simplifier: S, maxTris: 0 })
    ok(!r0.budget.cap, 'simplifyToBudget：不设上限 → 不降面')
    // uv 计误差：带贴图的图元走 simplifyWithAttributes，无贴图的照旧
    const d3 = newDoc()
    const tex = d3.doc.createTexture('t').setImage(new Uint8Array([137, 80, 78, 71])).setMimeType('image/png')
    const pT = grid(d3.doc, d3.buf, 40, 10, 0.3); pT.setMaterial(d3.doc.createMaterial('tx').setBaseColorTexture(tex)); addNode(d3.doc, d3.scene, 'tx', pT)
    const pP = grid(d3.doc, d3.buf, 40, 10, 0.3); pP.setMaterial(d3.doc.createMaterial('plain')); addNode(d3.doc, d3.scene, 'plain', pP)
    await d3.doc.transform(F.weld())
    const sp = B.simplifyPrims(d3.doc, F, MeshoptSimplifier, { simplifier: S, ratio: 0.1, error: 0.05, flags: [...B.LOD2_FLAGS], uvWeight: B.LOD2_UV_WEIGHT })
    deq(sp, { attr: 1, plain: 1 }, 'simplifyPrims：带贴图 → uv 计误差；无贴图 → simplifyPrimitive')
    ok(B.countSceneTriangles(d3.doc) < 2 * 3200, 'simplifyPrims：两条路都减了面')
    ok(B.LOD2_QUANT.quantizePosition === 12 && B.LOD2_QUANT.quantizeTexcoord === 10, 'LOD2_QUANT：lod2 位置 12 位 / uv 10 位')
  }
  // ④ 夹具真件按出厂档处理：lod2 在上限内、材质兜底有记录、两次处理逐字节相同（缓存 / blob 命名都靠确定性）
  const po = B.resolveProcOpts({})
  const pr = await B.processModelFile(tc, { srcPath: path.join(FIX, 'ssl-1300.glb'), outDir: path.join(tmp, 'ssl-budget'), ...po })
  ok(pr.lods.lod2.tris <= po.lod2MaxTris * 1.1 && pr.lods.lod2.tris > 0, `夹具 SSL-1300 出厂档：lod2 在三角形上限内（${pr.lods.lod2.tris}）`)
  ok(pr.info.materialFallback && Number.isInteger(pr.info.materialFallback.noMaterialPrims), '夹具 SSL-1300：材质兜底有记录')
  const pr2 = await B.processModelFile(tc, { srcPath: path.join(FIX, 'ssl-1300.glb'), outDir: path.join(tmp, 'ssl-budget2'), ...po })
  ok(['lod0', 'lod1', 'lod2'].every((k) => pr2.lods[k].sha256 === pr.lods[k].sha256), '出厂档确定性：SSL-1300 两次处理三档逐字节相同')
}

// ⑬-b sheets 纯函数
{
  const R = REPO
  // 协议：repo 只放四棵源码子树；模型文件走 build（--build-dir 可在仓库外）
  eq(SH.resolveSheetPath(R, 'sheet://repo/src/viz/models/thumbs.js'), path.join(R, 'src', 'viz', 'models', 'thumbs.js'), 'sheet://repo：白名单子树放行')
  eq(SH.resolveSheetPath(R, 'sheet://repo/node_modules/three/build/three.module.js'), path.join(R, 'node_modules', 'three', 'build', 'three.module.js'), 'sheet://repo：three 放行')
  eq(SH.resolveSheetPath(R, 'sheet://repo/build/models/satellite-kit~2/lod0.glb'), null, 'sheet://repo：build/models 不再从 repo 取（改走 sheet://build）')
  eq(SH.resolveSheetPath(R, 'sheet://build/satellite-kit~2/lod0.glb'), path.join(R, 'build', 'models', 'satellite-kit~2', 'lod0.glb'), 'sheet://build：缺省映射 build/models（多文件条目目录名 ~ 放行）')
  const outside = path.join(tmp, '模型 目录', 'models-alt')
  eq(SH.resolveSheetPath(R, SH.sheetBuildUrl(outside, path.join(outside, 'iss~2', 'lod0.glb')), { buildDir: outside }), path.join(outside, 'iss~2', 'lod0.glb'), 'sheet://build：--build-dir 在仓库外、路径含中文与空格 → 放行（审查：以前全部 403 后静默退回官方图）')
  // URL 解析把 %2e%2e 当点段、在根上夹住：出不了 build 目录（只会落在它里面）
  eq(SH.resolveSheetPath(R, 'sheet://build/%2e%2e/%2e%2e/x.glb', { buildDir: outside }), path.join(outside, 'x.glb'), 'sheet://build：%2e%2e 在根上夹住，出不了 --build-dir')
  for (const bad of ['sheet://repo/package.json', 'sheet://repo/src/viz/models/../../../package.json', 'sheet://repo/build/models/%2e%2e/%2e%2e/package.json',
    'sheet://build/x%2f..%2f..%2fpackage.json', 'sheet://build/a%5c..%5cb', 'sheet://other/src/viz/models/thumbs.js', 'file:///C:/x', 'sheet://repo/', 'sheet://build/', 'sheet://repo/electron/main.js', 'sheet://build/C:%5cWindows']) {
    eq(SH.resolveSheetPath(R, bad, { buildDir: outside }), null, `sheet://：拒绝 ${bad}`)
  }
  eq(SH.contentTypeFor('a/b.mjs'), 'text/javascript; charset=utf-8', 'content-type：模块脚本必须是 JS 类型')
  eq(SH.contentTypeFor('x.WASM'), 'application/wasm', 'content-type：wasm（大小写不敏感）')
  eq(SH.contentTypeFor('x.bin'), 'application/octet-stream', 'content-type：未知 → octet-stream')
  eq(SH.reviewFileName('nasa:satellite-kit~3'), 'satellite-kit~3.png', 'reviewFileName：NASA 派生件')
  eq(SH.reviewFileName('param:cubesat-1.5u'), 'param-cubesat-1.5u.png', 'reviewFileName：模板')
  eq(SH.reviewFileName('user:abc'), null, 'reviewFileName：其余不认')
  eq(SH.nasaDirOf('nasa:tracking-and-data-relay-satellites-tdrs-c~2'), 'tracking-and-data-relay-satellites-tdrs-c~2', 'nasaDirOf')
  eq(SH.nasaDirOf('param:default-sat'), null, 'nasaDirOf：非 NASA → null')
  // 出图配方哈希：稳定、随内容变、缺文件也有稳定结果
  const rd = path.join(tmp, 'recipe')
  fs.mkdirSync(rd, { recursive: true })
  fs.writeFileSync(path.join(rd, 'a.js'), 'A'); fs.writeFileSync(path.join(rd, 'b.js'), 'B')
  const h1 = SH.recipeHash(rd, ['a.js', 'b.js'])
  eq(SH.recipeHash(rd, ['b.js', 'a.js']), h1, 'recipeHash：与列表顺序无关')
  fs.writeFileSync(path.join(rd, 'b.js'), 'B2')
  ok(SH.recipeHash(rd, ['a.js', 'b.js']) !== h1, 'recipeHash：渲染链源码一改就变')
  eq(SH.recipeHash(rd, ['a.js', 'nope.js']), SH.recipeHash(rd, ['a.js', 'nope.js']), 'recipeHash：缺文件结果稳定')
  ok(SH.RECIPE_FILES.includes('src/viz/models/thumbs.js') && SH.RECIPE_FILES.includes('src/viz/models/view.js'), '出图配方含 thumbs / view（朝向口径一变全部重出）')
  // 两把键：内容键（模型 / 标定 / 取景口径）与缓存键（内容 + 配方 + 复核图）
  const k0 = { src: 'a'.repeat(64), frame: { q_model2body: [0.5, 0.5, 0.5, 0.5], t_model2body: [0, 0, 0] }, units: { scaleToMeters: 1 } }
  const ck = SH.thumbContentKey(k0)
  eq(SH.thumbContentKey({ ...k0 }), ck, 'thumbContentKey：同输入同键')
  for (const [what, d] of [['比例', { units: { scaleToMeters: 0.0254 } }], ['本体映射', { frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0] } }], ['模型文件', { src: 'b'.repeat(64) }], ['取景口径', { view: 'x' }]]) {
    ok(SH.thumbContentKey({ ...k0, ...d }) !== ck, `thumbContentKey：${what}变了就判过期`)
  }
  const kk = SH.sheetKey({ content: ck, recipe: 'r1', review: true })
  ok(SH.sheetKey({ content: ck, recipe: 'r2', review: true }) !== kk && SH.sheetKey({ content: ck, recipe: 'r1', review: false }) !== kk, 'sheetKey：配方 / 复核图变了就重出')
  // 显示系签名进取景口径（换向后旧缩略图上下颠倒 = 错，不是「画法旧了」）——真 import view.js 取导出的【值】，与写法无关
  const vd = path.join(tmp, 'vsig'), vf = path.join(vd, 'src', 'viz', 'models', 'view.js')
  eq(await SH.displaySignature(vd), 'd:none', 'displaySignature：没有 view.js → d:none')
  fs.mkdirSync(path.dirname(vf), { recursive: true })
  const NL = String.fromCharCode(10)
  const M_OLD = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1], M_NEW = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
  const putView = (...lines) => fs.writeFileSync(vf, lines.join(NL) + NL)
  putView(`export const BODY_TO_DISPLAY = { elements: [${M_OLD}] }`, 'export const ZENITH_DISPLAY = [0, -1, 0]')
  const sOld = await SH.displaySignature(vd)
  ok(/^d:[0-9a-f]{12}$/.test(sOld), `displaySignature：取到 BODY_TO_DISPLAY → d:<哈希>（${sOld}）`)
  putView('// 换一种写法：算出来的、类型数组、−0、1e-13 抖动、多一个函数导出', `const e = [${M_OLD.map((v) => (v === 0 ? '-0' : v))}]`,
    'export const BODY_TO_DISPLAY = (() => ({ isMatrix4: true, elements: Float64Array.from(e) }))()', 'export const ZENITH_DISPLAY = Object.freeze([0, -1, 1e-13])', 'export function helper () { return 1 }')
  eq(await SH.displaySignature(vd), sOld, 'displaySignature：只随值变——写法（.set / 算出来 / 注释 / −0 / 小数抖动）换了签名不变（审查：不绑 W10 的写法）')
  putView(`export const BODY_TO_DISPLAY = { elements: [${M_NEW}] }`, 'export const ZENITH_DISPLAY = [0, 1, 0]')
  const sNew = await SH.displaySignature(vd)
  ok(/^d:[0-9a-f]{12}$/.test(sNew) && sNew !== sOld, 'displaySignature：换向（天顶朝上）→ 签名变')
  putView(`export const BODY_TO_DISPLAY = { elements: [${M_OLD}] }`, 'export const ZENITH_DISPLAY = [0, 1, 0]')
  ok(![sOld, sNew].includes(await SH.displaySignature(vd)), 'displaySignature：矩阵没动、只改天顶方向（相机上向若按它取）→ 签名也变')
  putView(`export const BODY_TO_DISPLAY = { elements: [${M_OLD}] }`, 'export const ZENITH_DISPLAY = [0, -1, 0]', 'export const VIEW_DIRS = { iso: [0.7, 0.4, 0.5] }')
  ok(await SH.displaySignature(vd) !== sOld, 'displaySignature：点名视角（VIEW_DIRS）变了 → 签名变')
  putView("import { x } from 'satsim-no-such-package-xyz'", `export const BODY_TO_DISPLAY = { elements: [${M_OLD}] }`)
  ok(/^f:[0-9a-f]{12}$/.test(await SH.displaySignature(vd)), 'displaySignature：import 失败（依赖解析不到）→ 退到文件哈希（宁可多重出）')
  putView(`export const BODY_TO_DISPLAY = { elements: [${M_OLD.slice(1)}] }`)
  ok(/^f:[0-9a-f]{12}$/.test(await SH.displaySignature(vd)), 'displaySignature：BODY_TO_DISPLAY 不是 16 个数 → 退到文件哈希')
  putView('export const BODY_TO_DISPLAY = {{')
  ok(/^f:[0-9a-f]{12}$/.test(await SH.displaySignature(vd)), 'displaySignature：语法错 → 退到文件哈希')
  eq(SH.displayShape({ ZENITH_DISPLAY: [0, 1, 0] }), null, 'displayShape：没有 BODY_TO_DISPLAY → null')
  const liveSig = await SH.displaySignature(REPO)
  ok(SH.THUMB_VIEW === `${SH.THUMB_VIEW_BASE}|${SH.DISPLAY_SIG}` && SH.DISPLAY_SIG === liveSig && /^[df]:[0-9a-f]{12}$/.test(liveSig), `取景口径 = 取景法 | 当前显示系签名（${SH.DISPLAY_SIG}）`)
  const VJ = await imp('src/viz/models/view.js')
  ok(SH.displayShape(VJ) !== null, 'displayShape：仓库 view.js 在 node 里 import 得进、导出的 BODY_TO_DISPLAY 取得到值（thumbs.js 按这个名字取，契约）')
  eq('d:' + sha256(JSON.stringify(SH.displayShape(VJ))).slice(0, 12), SH.DISPLAY_SIG, 'displaySignature：经 data: URL 载入与直接 import 取到的值一致')
  {
    // esmDataUrl：无类型 .js（Electron 31 的 node 20 按 CommonJS 载入会语法错）→ data: URL；相对 .js 递归、.mjs / 裸说明符 → file:
    const ed = path.join(tmp, 'esm-graph')
    fs.mkdirSync(path.join(ed, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(ed, 'sub', 'leaf.js'), 'export const LEAF = [0, 1, 0]' + NL)
    fs.writeFileSync(path.join(ed, 'sub', 'lib.mjs'), 'export const K = 7' + NL)
    fs.writeFileSync(path.join(ed, 'entry.js'), ["import { LEAF } from './sub/leaf.js'", "import { K } from './sub/lib.mjs'", "import * as C from 'node:crypto'",
      "// 注释里的 from './nope.js' 解析不到就原样留着", 'export const OUT = { leaf: LEAF, k: K, h: typeof C.createHash }'].join(NL) + NL)
    const u = SH.esmDataUrl(path.join(ed, 'entry.js'))
    const srcOut = Buffer.from(u.slice(u.indexOf(',') + 1), 'base64').toString('utf8')
    ok(u.startsWith('data:text/javascript;base64,') && /from 'data:text\/javascript;base64,/.test(srcOut) && srcOut.includes(pathToFileURL(path.join(ed, 'sub', 'lib.mjs')).href) && srcOut.includes("'node:crypto'") && srcOut.includes("from './nope.js'"),
      'esmDataUrl：相对 .js → data:（递归）、.mjs → file:、node: 与解析不到的原样')
    deq((await import(u)).OUT, { leaf: [0, 1, 0], k: 7, h: 'function' }, 'esmDataUrl：载得进、值对')
    eq(SH.esmDataUrl(path.join(ed, 'entry.js')), u, 'esmDataUrl：内容定址（同内容同地址）')
  }
  ok(SH.thumbContentKey({ ...k0, view: `${SH.THUMB_VIEW_BASE}|d:a` }) !== SH.thumbContentKey({ ...k0, view: `${SH.THUMB_VIEW_BASE}|d:b` }), 'thumbContentKey：显示系换向 → 内容键变（旧缩略图不认）')
  // 两把缓存键：缩略图键（内容 + 配方）与复核图键（再加抬头）——只改抬头只重出复核图（审查：别让改中文名换掉缩略图字节）
  const hk1 = SH.reviewHeadKey(['a', 'b 尺寸未核']), hk2 = SH.reviewHeadKey(['a', 'b 尺寸已核'])
  ok(hk1 !== hk2 && hk1 === SH.reviewHeadKey(['a', 'b 尺寸未核']) && /^h:[0-9a-f]{16}$/.test(hk1), 'reviewHeadKey：抬头文字定键、稳定')
  ok(SH.sheetKey({ content: ck, recipe: 'r1', review: hk1 }) !== SH.sheetKey({ content: ck, recipe: 'r1', review: hk2 }), 'sheetKey：复核图键随抬头（核定标志）变')
  ok(SH.sheetKey({ content: ck, recipe: 'r1' }) === SH.sheetKey({ content: ck, recipe: 'r1', review: false }) && SH.sheetKey({ content: ck, recipe: 'r1', review: false }) === SH.sheetKey({ content: ck, recipe: 'r1', review: '' }), 'sheetKey：缩略图键与抬头无关')
  {
    const tk = SH.sheetKey({ content: ck, recipe: 'r1' }), rk1 = SH.sheetKey({ content: ck, recipe: 'r1', review: hk1 }), rk2 = SH.sheetKey({ content: ck, recipe: 'r1', review: hk2 })
    const s0 = { key: tk, reviewKey: rk1, thumbSha: 't'.repeat(64), source: 'render' }
    const plan = (o) => SH.sheetPlan({ s: s0, key: tk, reviewKey: rk1, thumbSha: s0.thumbSha, reviewExists: true, ...o })
    eq(plan({}), 'none', 'sheetPlan：两把键都对得上、文件都在 → 命中')
    eq(plan({ reviewKey: rk2 }), 'review', 'sheetPlan：只有抬头变了 → 只重出复核图（缩略图字节不动）')
    eq(plan({ reviewExists: false }), 'review', 'sheetPlan：复核图文件丢了 → 只重出复核图')
    eq(plan({ reviewKey: null, reviewExists: false }), 'none', 'sheetPlan：--no-review → 不因复核图重来')
    eq(plan({ s: { ...s0, source: 'official' }, reviewKey: rk2 }), 'none', 'sheetPlan：退回官方缩图的条目没有复核图 → 不因抬头重来')
    eq(plan({ key: SH.sheetKey({ content: ck, recipe: 'r2' }) }), 'full', 'sheetPlan：配方变了 → 整条重出')
    eq(plan({ key: SH.sheetKey({ content: 'x', recipe: 'r1' }), reviewKey: rk2 }), 'full', 'sheetPlan：内容键变了 → 整条重出（不是只出复核图）')
    ok(['e'.repeat(64), null].every((t) => plan({ thumbSha: t }) === 'full') && plan({ s: null }) === 'full' && plan({ s: { ...s0, thumbSha: null } }) === 'full', 'sheetPlan：缩略图被换过 / 没有文件 / 没记账 → 整条重出')
    ok(plan({ force: true }) === 'full' && plan({ missing: true }) === 'full', 'sheetPlan：--force / 缺 lod 文件 → full')
    const oldKey = SH.sheetKey({ content: ck, recipe: 'r1', review: hk1 })
    eq(plan({ s: { ...s0, key: oldKey, reviewKey: undefined } }), 'full', 'sheetPlan：老记账（键里混着抬头）→ 整条重出一次')
  }
  // 取景重画对拍闸：三态 + 换件
  ok(SH.parityVerdict({ diffPx: 0, maxDiff: 1, n: 262144 }).ok === true && SH.parityVerdict({ diffPx: 262, maxDiff: 9, n: 262144 }).ok === true, 'parityVerdict：≤ 0.1 % 像素不同 → 放行')
  ok(SH.parityVerdict({ diffPx: 263, maxDiff: 9, n: 262144 }).ok === false && /像素不同/.test(SH.parityVerdict({ diffPx: 5000, maxDiff: 80, n: 262144 }).reason), 'parityVerdict：超过 0.1 % → 拦（renderCrop 与 renderThumb 分家）')
  ok([null, {}, { error: 'x' }, { diffPx: 0, n: 0 }, { diffPx: -1, n: 9 }, { diffPx: 1.5, n: 9 }].every((r) => SH.parityVerdict(r).ok === null), 'parityVerdict：出错 / 不成形 → 核不了（null，不当成分家）')
  {
    const J = (id) => ({ id })
    const res = { a: { error: '取文件 HTTP 404' }, b: { diffPx: 0, maxDiff: 1, n: 262144 }, c: { diffPx: 9000, maxDiff: 90, n: 262144 }, t: 'throw' }
    const calls = []
    const check = async (j) => { calls.push(j.id); if (res[j.id] === 'throw') throw new Error('selfCheck 超时 180 s'); return res[j.id] }
    let g = await SH.runParityGate([J('a'), J('b'), J('c')], check)
    ok(g.ok === true && g.id === 'b' && calls.join() === 'a,b' && g.tried.length === 1 && /404/.test(g.tried[0].reason), 'runParityGate：第一件坏文件核不了 → 换下一件，核得了就定结论（审查：不再误报分家）')
    calls.length = 0
    g = await SH.runParityGate([J('t'), J('c'), J('b')], check)
    ok(g.ok === false && g.id === 'c' && calls.join() === 't,c', 'runParityGate：超时换件；真对出差 → 拦，不再往下试')
    calls.length = 0
    g = await SH.runParityGate([J('a'), J('t'), J('a'), J('b')], check)
    ok(g.ok === null && g.tried.length === SH.PARITY_TRIES && calls.length === SH.PARITY_TRIES, `runParityGate：最多试 ${SH.PARITY_TRIES} 件，都核不了 → null（照常出图）`)
    ok((await SH.runParityGate([], check)).ok === null, 'runParityGate：没有候选 → null')
  }
  eq(SH.THUMB_SIZE, 512, '缩略图边长与页面同值')
  // checkThumbRecord：build 认领 / builtin 随包前的核对
  const meta = { files: { lod0: { sha256: 'a'.repeat(64) } }, frame: k0.frame, units: k0.units }
  const rec = { thumbSha: 'f'.repeat(64), contentKey: ck, lod: 'lod0', view: SH.THUMB_VIEW, recipe: 'r1' }
  deq(SH.checkThumbRecord(rec, meta, 'f'.repeat(64), 'r1'), { ok: true, recipeStale: false }, 'checkThumbRecord：对得上 → 认领')
  deq(SH.checkThumbRecord(rec, meta, 'f'.repeat(64), 'r9'), { ok: true, recipeStale: true }, 'checkThumbRecord：配方变了 → 照样认领、记「画法旧了」')
  const bad = (r, m, s) => SH.checkThumbRecord(r, m, s, 'r1')
  ok(!bad(rec, { ...meta, units: { scaleToMeters: 0.3048 } }, 'f'.repeat(64)).ok && /标定/.test(bad(rec, { ...meta, units: { scaleToMeters: 0.3048 } }, 'f'.repeat(64)).reason), 'checkThumbRecord：改了 known-dims（比例变）→ 过期不认')
  ok(!bad(rec, { ...meta, files: { lod0: { sha256: 'b'.repeat(64) } } }, 'f'.repeat(64)).ok, 'checkThumbRecord：原件换了版本（lod0 sha 变）→ 过期不认')
  ok(/sha 不符/.test(bad(rec, meta, 'e'.repeat(64)).reason), 'checkThumbRecord：thumb.webp 被换过 → 不认')
  ok(/没有这一条/.test(bad(null, meta, 'f'.repeat(64)).reason) && /没有 thumb/.test(bad(rec, meta, null).reason), 'checkThumbRecord：没记账 / 没文件 → 不认')
  ok(/老版本记账/.test(bad({ thumbSha: 'f'.repeat(64), key: 'x' }, meta, 'f'.repeat(64)).reason), 'checkThumbRecord：老版本记账（没有内容键）→ 不认')
  ok(/取景口径变了/.test(bad({ ...rec, view: 'zenith' }, meta, 'f'.repeat(64)).reason), 'checkThumbRecord：取景口径变了 → 不认')
  ok(/取景口径变了/.test(SH.checkThumbRecord({ ...rec, view: `${SH.THUMB_VIEW_BASE}|d:old` }, meta, 'f'.repeat(64), 'r1').reason), 'checkThumbRecord：显示系换过 → 不认、要求重跑 sheets')
  // 记账清理按全集（审查：--nasa-only 以前会把 14 个模板的记账删光）
  const ents = { 'nasa:a': {}, 'nasa:gone': {}, 'param:default-sat': {}, 'param:old': {} }
  deq(SH.pruneSheetEntries(ents, ['nasa:a'], ['default-sat', 'ssl1300']).sort(), ['nasa:gone', 'param:old'], 'pruneSheetEntries：只删下架的 NASA 条目与改名的模板')
  deq(Object.keys(ents).sort(), ['nasa:a', 'param:default-sat'], 'pruneSheetEntries：模板记账与本次跑没跑无关')
  // 下架件的文件：复核图只删本次记账清理删掉的那几条（记账能证明是本脚本出的）、别人的文件不碰；_param 只删只含本脚本产物的非在册目录
  {
    const fsTree = {
      R: ['a.png', 'gone.png', 'gone~2.png', 'param-ssl1300.png', 'param-retired-geo.png', 'contact.png', 'orphan-no-ledger.png', 'sheets.json', 'sheets.log', 'Notes.PNG', 'my notes.png'],
      [path.join('B', SH.PARAM_DIR)]: ['ssl1300', 'retired-geo', 'keep-mine', 'empty'],
      [path.join('B', SH.PARAM_DIR, 'retired-geo')]: ['info.json', 'thumb.webp'],
      [path.join('B', SH.PARAM_DIR, 'keep-mine')]: ['thumb.webp', 'x.blend'],
      [path.join('B', SH.PARAM_DIR, 'empty')]: []
    }
    const gone = []
    const list = (d) => { if (!(d in fsTree)) throw new Error('ENOENT'); return fsTree[d] }
    const r = SH.sweepOrphanSheetFiles({ reviewDir: 'R', buildDir: 'B', goneIds: ['nasa:gone', 'nasa:gone~2', 'param:retired-geo', 'nasa:never-rendered'], templateIds: ['ssl1300'], list, rm: (p) => gone.push(p) })
    deq(r, { review: ['gone.png', 'gone~2.png', 'param-retired-geo.png'], param: ['retired-geo'] }, 'sweepOrphanSheetFiles：本次清掉记账的复核图与下架模板目录删掉，在册 / 别人的文件留着')
    deq(gone, [path.join('R', 'gone.png'), path.join('R', 'gone~2.png'), path.join('R', 'param-retired-geo.png'), path.join('B', SH.PARAM_DIR, 'retired-geo')], 'sweepOrphanSheetFiles：只 rm 这几条路径')
    const g2 = []
    deq(SH.sweepOrphanSheetFiles({ reviewDir: 'R', buildDir: null, goneIds: [], templateIds: [], list, rm: (p) => g2.push(p) }), { review: [], param: [] }, 'sweepOrphanSheetFiles：没清掉记账 → 复核图目录一张不删（审查：共用目录里的 contact.png / 没记账的小写 png 以前按名字形状也删）')
    eq(g2.length, 0, 'sweepOrphanSheetFiles：没清掉记账时一次 rm 都没有')
    deq(SH.sweepOrphanSheetFiles({ reviewDir: path.join(tmp, 'nope-r'), buildDir: path.join(tmp, 'nope-b'), goneIds: ['nasa:x'], templateIds: [] }), { review: [], param: [] }, 'sweepOrphanSheetFiles：目录不存在不出错')
  }
  // 目录配对（审查：--build-dir 指临时 build、没给 --review-dir → 按临时 manifest 删掉仓库 build/review 的真记账与复核图）
  {
    const root = path.join(tmp, 'bind')
    const defaults = { buildDir: path.join(root, 'build', 'models'), reviewDir: path.join(root, 'build', 'review') }
    const other = path.join(root, '临时 build')
    const bind = (o) => SH.sheetsBinding({ defaults, buildDir: defaults.buildDir, reviewDir: defaults.reviewDir, ...o })
    deq(bind({ hadEntries: true }), { ok: true, prune: true, bind: '../models' }, 'sheetsBinding：缺省配对、老记账没记过 → 认下、照常清理')
    deq(bind({ prevBind: '../models', hadEntries: true }), { ok: true, prune: true, bind: '../models' }, 'sheetsBinding：记过、同一目录 → 清理')
    const r1 = bind({ buildDir: other, hadEntries: true })
    ok(!r1.ok && /--review-dir/.test(r1.reason) && /--rebind/.test(r1.reason), `sheetsBinding：--build-dir 非缺省 + 缺省 review 目录 → 拒 ${r1.reason}`)
    ok(!bind({ buildDir: other, hadEntries: false }).ok, 'sheetsBinding：review 目录是空的也拒（临时 build 的记账不许写进仓库 build/review）')
    const r2 = bind({ prevBind: '../models', buildDir: other, hadEntries: true })
    ok(!r2.ok && r2.reason.includes(path.resolve(defaults.buildDir)) && r2.reason.includes(path.resolve(other)), 'sheetsBinding：记的目录与本次不同 → 拒，两个目录都报出来')
    deq(bind({ prevBind: '../models', buildDir: other, hadEntries: true, rebind: true }), { ok: true, prune: false, bind: SH.bindingOf(defaults.reviewDir, other) }, 'sheetsBinding：--rebind 改配 → 放行、这一次不清理')
    deq(bind({ prevBind: SH.bindingOf(defaults.reviewDir, other), buildDir: other, hadEntries: true }), { ok: true, prune: true, bind: SH.bindingOf(defaults.reviewDir, other) }, 'sheetsBinding：改配之后下一次 → 按新目录清理')
    const rv = path.join(root, 'rev-x')
    deq(SH.sheetsBinding({ defaults, buildDir: other, reviewDir: rv, hadEntries: false }), { ok: true, prune: true, bind: SH.bindingOf(rv, other) }, 'sheetsBinding：两个都给、review 目录是新的 → 放行并清理')
    deq(SH.sheetsBinding({ defaults, buildDir: other, reviewDir: rv, hadEntries: true }), { ok: true, prune: false, bind: SH.bindingOf(rv, other) }, 'sheetsBinding：两个都给、老记账没记过 → 认下、这一次不清理')
    ok((bind({ prevBind: '../MODELS/', hadEntries: true }).prune === true) === (process.platform === 'win32'), 'sheetsBinding：Windows 下路径不分大小写、尾分隔符不算')
    eq(SH.bindingOf(path.join(root, 'a', 'review'), path.join(root, 'a', 'review')), '.', 'bindingOf：同一目录 → .')
  }
  // 日志轮转：sheets.log → sheets.1.log → … → sheets.4.log，最老的丢掉
  {
    const d = path.join(tmp, 'rot')
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true })
    const f = path.join(d, 'sheets.log')
    eq(SH.rotateLog(f), false, 'rotateLog：没有日志 → 不动')
    for (let i = 1; i <= 6; i++) { fs.writeFileSync(f, `run ${i}`); if (i < 6) SH.rotateLog(f) }
    deq(fs.readdirSync(d).sort(), ['sheets.1.log', 'sheets.2.log', 'sheets.3.log', 'sheets.4.log', 'sheets.log'], 'rotateLog：留 4 份旧的 + 当前')
    deq(['sheets.log', 'sheets.1.log', 'sheets.4.log'].map((n) => fs.readFileSync(path.join(d, n), 'utf8')), ['run 6', 'run 5', 'run 2'], 'rotateLog：新的在前、最老的（run 1）丢掉')
  }
  // 旧临时 userData：进程不在的清掉，在的 / 不认得的留着
  const removed = []
  const sw = SH.sweepStaleUserData('T', (pid) => pid === 222, { list: () => [`${SH.USERDATA_PREFIX}111`, `${SH.USERDATA_PREFIX}222`, `${SH.USERDATA_PREFIX}x`, 'other'], rm: (p) => removed.push(path.basename(p)) })
  deq([sw.removed, sw.kept, removed], [[`${SH.USERDATA_PREFIX}111`], [`${SH.USERDATA_PREFIX}222`, `${SH.USERDATA_PREFIX}x`], [`${SH.USERDATA_PREFIX}111`]], 'sweepStaleUserData：只清进程已不在的同前缀目录')
  deq(SH.sweepStaleUserData(path.join(tmp, 'nope-dir'), () => false), { removed: [], kept: [] }, 'sweepStaleUserData：目录不存在不出错')
  eq(SH.pidAlive(process.pid), true, 'pidAlive：本进程在')
  ok(SH.fallbackTooMany(12, 227) && !SH.fallbackTooMany(11, 227) && !SH.fallbackTooMany(0, 0), 'fallbackTooMany：退回官方缩图 > 5 % 判环境问题')
  const shAbs = path.join(REPO, 'scripts', 'nasa3d', 'sheets.mjs'), shUrl = pathToFileURL(shAbs).href
  deq([SH.entryArgIndex(['electron', shAbs, '--only=x'], shUrl), SH.entryArgIndex(['electron', '--disable-gpu', '--disable-software-rasterizer', shAbs, '--force'], shUrl), SH.entryArgIndex(['electron', path.join(REPO, '.modelharness', 'x.mjs'), shAbs], shUrl), SH.entryArgIndex(['node'], shUrl)], [1, 3, -1, -1], 'entryArgIndex：Chromium 开关写在脚本前也认得出入口；别的验证台 import 本文件不开工')
  const ou = new URL(SH.officialThumbUrl('https://assets.science.nasa.gov/dynamicimage/assets/science/cds/3d/resources/model/x/X%20Y.png?w=1920&h=1080&fit=clip&crop=faces%2Cfocalpoint'))
  deq([ou.searchParams.get('w'), ou.searchParams.get('h'), ou.searchParams.get('fit'), ou.searchParams.get('crop')], ['768', '768', 'clip', null], 'officialThumbUrl：NASA 动态图改 768 边长、不裁')
  eq(SH.officialThumbUrl('https://example.org/a.png?w=1'), 'https://example.org/a.png?w=1', 'officialThumbUrl：别的域名原样')
  eq(SH.officialThumbUrl('javascript:alert(1)'), null, 'officialThumbUrl：非 http(s) → null')
  const hd = SH.reviewHead({ id: 'nasa:x', title: 'X', titleZh: '某星', geometry: { bboxM: { min: [-1, -2, -3], max: [1, 2, 3] } }, units: { scaleToMeters: 0.3048, unitGuess: 'ft', sizeVerified: true }, frame: { q_model2body: [0.5, 0.5, 0.5, 0.5] } })
  ok(hd[0] === 'nasa:x · 某星（X）' && /包围盒 2 × 4 × 6 m（已核）/.test(hd[1]) && /比例 0\.3048（ft）/.test(hd[1]), 'reviewHead：抬头两行')
  ok(/q_model2body \[0\.5, 0\.5, 0\.5, 0\.5\]（朝向未核）/.test(hd[1]), 'reviewHead：朝向未核（frame.verified 缺）')
  ok(/（朝向已核）/.test(SH.reviewHead({ id: 'nasa:x', title: 'X', frame: { q_model2body: [0, 0, 0, 1], verified: true } })[1]), 'reviewHead：朝向已核（frame.verified=true）')
  const ss = SH.summarizeSheets({ entries: { 'nasa:a': { thumbSha: 'x', source: 'render', zoom: 4.5, qa: { flags: ['tiny'] } }, 'nasa:b': { thumbSha: 'y', source: 'official', renderError: 'e' }, 'nasa:c': { error: 'boom' }, 'param:p': { thumbSha: 'z', source: 'render', qa: { flags: ['dark', 'flat'] } } } })
  ok(ss.total === 4 && ss.render === 2 && ss.official === 1 && ss.failed.length === 1 && ss.failed[0].error === 'boom' && ss.templates === 1, 'summarizeSheets：自渲染 / 官方缩图 / 缺 / 模板')
  deq([ss.flagged.tiny, ss.flagged.dark, ss.flagged.flat, ss.zoomed, ss.zoomMax], [['nasa:a'], ['param:p'], ['param:p'], 1, 4.5], 'summarizeSheets：质检标记归集、取景重画计数')
}

// ⑬-c 稳健取景（crop.mjs）与画面质检
{
  const W = 300
  const A = new Uint8Array(W * W)
  const fill = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) A[y * W + x] = 255 }
  fill(140, 140, 170, 170)                                  // 本体 30×30
  fill(10, 154, 290, 157)                                   // 横向线天线：3 px 粗，贯穿全宽
  fill(154, 5, 157, 295)                                    // 纵向线天线
  const c = CROP.contentSquare(A, W)
  ok(c.zoom > 6 && c.zoom < 10, `contentSquare：细杆不撑取景，按本体取框（×${c.zoom.toFixed(2)}，框交给页面重画，不再封顶 3×）`)
  ok(c.x <= 140 && c.y <= 140 && c.x + c.side >= 170 && c.y + c.side >= 170, 'contentSquare：裁切框包住本体')
  ok((c.side - 30) / 2 >= 30 * 0.1, 'contentSquare：本体四周留足边距（每边 ≥ 10 %，1.14 时 MMS 本体上下沿被裁）')
  ok(c.x >= 0 && c.y >= 0 && c.x + c.side <= W + 1e-9 && c.y + c.side <= W + 1e-9, 'contentSquare：裁切框不出画面')
  A.fill(0); fill(145, 145, 155, 155); fill(10, 149, 290, 151)   // 本体 10×10（腐蚀后还剩 6×6）+ 细杆
  const tiny = CROP.contentSquare(A, W)
  near(tiny.zoom, CROP.MAX_ZOOM, 1e-9, 'contentSquare：本体极小 → 放大到理智上限 16×')
  near(CROP.contentSquare(A, W, { maxZoom: 4 }).zoom, 4, 1e-9, 'contentSquare：上限可调')
  A.fill(0); fill(30, 40, 270, 260)
  deq(CROP.contentSquare(A, W), { x: 0, y: 0, side: W, zoom: 1 }, 'contentSquare：本体占满画面 → 不裁')
  A.fill(0); fill(10, 150, 290, 152); fill(150, 10, 152, 290)
  deq(CROP.contentSquare(A, W), { x: 0, y: 0, side: W, zoom: 1 }, 'contentSquare：整件都是细杆（腐蚀后什么都不剩）→ 不裁')
  A.fill(0); fill(0, 0, 60, 60); fill(0, 0, 290, 2)
  const cc = CROP.contentSquare(A, W)
  ok(cc.x === 0 && cc.y === 0 && cc.zoom > 1, 'contentSquare：本体贴边 → 框夹回画面内')
  A.fill(0); fill(100, 120, 200, 150)
  const cw = CROP.contentSquare(A, W)
  ok(Math.abs(cw.x + cw.side / 2 - 150) < 2 && Math.abs(cw.y + cw.side / 2 - 135) < 2, 'contentSquare：扁长本体按长边取正方形、居中')
  // 画面质检
  const Q = 64
  const img = (fn) => { const px = new Uint8ClampedArray(Q * Q * 4); for (let i = 0; i < Q * Q; i++) { const v = fn(i % Q, Math.floor(i / Q)); if (v) { px[i * 4] = v[0]; px[i * 4 + 1] = v[1]; px[i * 4 + 2] = v[2]; px[i * 4 + 3] = 255 } } return px }
  deq(CROP.thumbQa(img(() => null), Q).flags, ['tiny'], 'thumbQa：空画面 → tiny')
  deq(CROP.thumbQa(img((x, y) => (x > 10 && x < 50 && y > 10 && y < 50 ? [4, 4, 6] : null)), Q).flags, ['dark'], 'thumbQa：死黑 → dark')
  deq(CROP.thumbQa(img((x, y) => (x > 10 && x < 50 && y > 10 && y < 50 ? [240, 240, 240] : null)), Q).flags, ['flat'], 'thumbQa：一片白没有明暗 → flat')
  const good = CROP.thumbQa(img((x, y) => (x > 10 && x < 50 && y > 10 && y < 50 ? [x * 5, y * 4, 90] : null)), Q)
  ok(!good.flags.length && good.coverage > 0.3 && good.stdL > 0.05, 'thumbQa：有明暗的正常画面不标')
}

// ⑬-d builtin 纯函数
{
  const fake = (ids) => ids.map((id) => ({ id }))
  deq(BI.resolveBuiltinOpts({}), { catalog: 'subset', templates: 'off' }, 'resolveBuiltinOpts：缺省只出子集、不出模板条目（审查：模板条目让工作台选模板报错、目录条目让离线 autoMatch 选中没随包的件）')
  assert.throws(() => BI.resolveBuiltinOpts({ catalog: 'all' }), /--catalog 只能是/); n++
  assert.throws(() => BI.resolveBuiltinOpts({ templates: 'on' }), /--templates 只能是/); n++
  const ps = BI.pickSubset(fake(BI.BUILTIN_SUBSET.flatMap((x) => x.pick)))
  ok(ps.missing.length === 0 && ps.picked.every((p) => !p.fallback) && ps.picked.length === BI.BUILTIN_SUBSET.length, 'pickSubset：候选齐全时各取第一候选')
  eq(ps.picked.find((p) => p.key === 'iss').id, 'nasa:international-space-station-iss-d-igoal', 'pickSubset：ISS 首选 D（尺寸已核、autoMatch 首选；B 带悬空碎片）')
  const ps2 = BI.pickSubset(fake(['nasa:international-space-station-iss-a', 'nasa:satellite-kit']))
  ok(ps2.picked.find((p) => p.key === 'iss').id === 'nasa:international-space-station-iss-a' && ps2.picked.find((p) => p.key === 'iss').fallback, 'pickSubset：首选没有 → 候选顶替并标出')
  ok(ps2.missing.some((m) => m.key === 'goes') && !ps2.missing.some((m) => m.key === 'kit-body-1'), 'pickSubset：一个候选都没有 → 记缺')
  deq(BI.pickSubset(fake(['nasa:a']), [{ key: 'x', pick: ['nasa:a'] }, { key: 'y', pick: ['nasa:a'] }]).missing.map((m) => m.key), ['y'], 'pickSubset：同一件不给两项')
  ok(BI.BUILTIN_SUBSET.filter((s) => s.pick.some((p) => /tdrs|trds/.test(p))).length === 2, 'BUILTIN_SUBSET：TDRS 一代与新一代各一')
  deq(BI.uniq(['geo', 'param', 'geo', '', 3, 'comsat']), ['geo', 'param', 'comsat'], 'uniq：去重保序、丢空')
  // NASA 条目
  const withThumb = { ...metas[0], files: { ...metas[0].files, thumb: { sha256: 'c'.repeat(64), bytes: 9 } } }
  const ne = BI.nasaBuiltinEntry(withThumb)
  ok(ne.parts === undefined && ne.attachPoints === undefined && ne.files.lod0 && ne.files.lod1 && ne.files.lod2 && ne.files.thumb, 'nasaBuiltinEntry：精简字段、files 保留全部档（客户端据此从云端补 lod0 / lod1）')
  deq(ne.builtin, ['lod2', 'thumb'], 'nasaBuiltinEntry：档位表')
  assert.throws(() => BI.nasaBuiltinEntry(metas[0]), /files\.thumb 缺失/); n++
  if (SCHEMA) ok(SCHEMA.validateMeta(ne, { slim: true }).ok, 'nasaBuiltinEntry：过 validateMeta（slim）')
  // 参数化模板条目（--templates=entries）
  if (PT && PB && SCHEMA) {
    const IRM = await imp('packages/core/models/ir.mjs')
    const cat = PT.templateCatalog().find((t) => t.templateId === TPL_GEO)
    const r = PB.buildTemplateModel(TPL_GEO)
    const st = IRM.irStats(r.ir)
    const thumb = { sha256: 'd'.repeat(64), bytes: 1234 }
    const info = { specHash: r.specHash, thumbSha: thumb.sha256, view: SH.THUMB_VIEW, renderedAt: '2026-09-24T00:00:00.000Z' }
    const pe = BI.paramBuiltinEntry({ cat, r, stats: { tris: st.tris, areaM2: st.areaM2 }, info, thumb })
    ok(SCHEMA.validateMeta(pe, { slim: true }).ok, `paramBuiltinEntry：过 validateMeta（slim）${SCHEMA.validateMeta(pe, { slim: true }).errors.join('；')}`)
    deq(Object.keys(pe.files), ['thumb'], 'paramBuiltinEntry：只带缩略图（几何运行时生成）')
    ok(cat.tags.length > new Set(cat.tags).size && pe.tags.length === new Set(pe.tags).size, 'paramBuiltinEntry：templateCatalog 的重复 tag（geo）去掉')
    ok(pe.templateId === TPL_GEO && pe.specHash === r.specHash && pe.fidelity === 'parametric', 'paramBuiltinEntry：templateId / specHash / fidelity')
    assert.throws(() => BI.paramBuiltinEntry({ cat, r, stats: st, info: { ...info, specHash: '0'.repeat(16) }, thumb }), /重跑 nasa3d:sheets/); n++
    assert.throws(() => BI.paramBuiltinEntry({ cat, r, stats: st, info, thumb: { ...thumb, sha256: 'e'.repeat(64) } }), /sha 不符/); n++
    assert.throws(() => BI.paramBuiltinEntry({ cat, r, stats: st, info: { ...info, view: `${SH.THUMB_VIEW_BASE}|d:000000000000` }, thumb }), /取景口径[\s\S]*重跑 nasa3d:sheets/); n++
    assert.throws(() => BI.paramBuiltinEntry({ cat, r, stats: st, info: { specHash: info.specHash, thumbSha: info.thumbSha }, thumb }), /取景口径 （无）/); n++
    ok(BI.paramBuiltinEntry({ cat, r, stats: st, info: { ...info, view: 'v2' }, thumb, view: 'v2' }).id === cat.id, 'paramBuiltinEntry：取景口径对得上才认（审查：显示系换向后模板缩略图上下颠倒，specHash 不变）')
    // 几何口径：bboxM / centroidM 是模型轴（DESIGN §3.2 终案），从 paramBus 的本体系经 frame 换过去；包围半径与轴无关
    const BFM = await imp('packages/core/models/bodyFrame.mjs')
    const bm = pe.geometry.bboxM
    for (let i = 0; i < 8; i++) {
      const vm = [(i & 1 ? bm.max : bm.min)[0], (i & 2 ? bm.max : bm.min)[1], (i & 4 ? bm.max : bm.min)[2]]
      const vb = BFM.modelToBody(vm, r.frame.q_model2body, r.frame.t_model2body)
      ok(vb.every((x, k) => x >= r.bboxBody.min[k] - 1e-5 * (1 + Math.abs(x)) && x <= r.bboxBody.max[k] + 1e-5 * (1 + Math.abs(x))), `paramBuiltinEntry：模型轴包围盒角点 ${i} 换回本体系落在本体包围盒上`)
    }
    const volM = bm.max.reduce((a, v, k) => a * (v - bm.min[k]), 1), volB = r.bboxBody.max.reduce((a, v, k) => a * (v - r.bboxBody.min[k]), 1)
    near(volM, volB, 1e-5 * volB, 'paramBuiltinEntry：模型轴包围盒体积 = 本体系（轴对齐旋转，不外扩）')
    const cmb = BFM.modelToBody(pe.geometry.centroidM, r.frame.q_model2body, r.frame.t_model2body)
    ok(cmb.every((x, k) => Math.abs(x - r.massProps.comBody[k]) <= 1e-5 * (1 + Math.abs(x))), 'paramBuiltinEntry：centroidM 是模型轴（换回本体系 = 组件累加质心）')
    ok(!BI.bboxBodyToModel(r.bboxBody, { q_model2body: [0, 0, 0, 0] }) && !BI.bboxBodyToModel(null, r.frame) && !BI.bboxBodyToModel({ min: [0, 0, 0], max: [1, 1, 1] }, {}), 'bboxBodyToModel：q 非法 / 缺包围盒 → null')
    deq(BI.bboxBodyToModel({ min: [-1, -2, -3], max: [1, 2, 3] }, { q_model2body: [0, 0, 0, 1] }), { min: [-1, -2, -3], max: [1, 2, 3] }, 'bboxBodyToModel：单位四元数原样')
    const v = MANIFEST.validateManifest({ schema: 2, buildId: 'b', generatedAt: '2026-09-24T00:00:00Z', models: [pe, ne] }, { builtin: true })
    ok(v.ok && !v.errors.length && v.models.length === 2, 'validateManifest（builtin）：模板条目 + NASA 条目都收')
  }
  // manifest 与落盘计划
  const e1 = { id: 'nasa:b', builtin: ['lod2', 'thumb'], files: { lod0: { sha256: '1'.repeat(64), bytes: 5 }, lod2: { sha256: '2'.repeat(64), bytes: 3 }, thumb: { sha256: '9'.repeat(64), bytes: 1 } } }
  const e2 = { id: 'nasa:a', files: { lod2: { sha256: '3'.repeat(64), bytes: 3 }, thumb: { sha256: '9'.repeat(64), bytes: 1 } } }
  const e3 = { id: 'param:p', builtin: ['thumb'], files: { thumb: { sha256: '8'.repeat(64), bytes: 2 } } }
  const pf = BI.plannedFiles([e1, e2, e3])
  deq(pf.map((f) => f.rel), [`builtin/${'2'.repeat(64)}.glb`, `thumbs/${'9'.repeat(64)}.webp`, `thumbs/${'8'.repeat(64)}.webp`], 'plannedFiles：lod 按档位表、缩略图每条都带、同 sha 只落一份；目录条目不带 lod')
  const bm1 = BI.builtinManifest([e1, e2], { generatedAt: 'x', sourceBuildId: 'nasa-1' }), bm2 = BI.builtinManifest([e2, e1], { generatedAt: 'y' })
  ok(bm1.buildId === bm2.buildId && /^builtin-[0-9a-f]{12}$/.test(bm1.buildId) && bm1.models[0].id === 'nasa:a' && bm1.sourceBuildId === 'nasa-1', 'builtinManifest：buildId 只由内容决定、按 id 排序、记源 buildId')
  // 换入：EPERM / EBUSY / EACCES 退避重试，其余错误直接抛；失败回滚、临时目录一定删
  const err = (code) => Object.assign(new Error(code), { code })
  let calls = 0
  eq(await BI.renameWithRetry('a', 'b', { rename: async () => { if (++calls < 3) throw err('EPERM') }, wait: async () => {} }), 2, 'renameWithRetry：EPERM 两次后成功 → 重试 2 次')
  await assert.rejects(BI.renameWithRetry('a', 'b', { rename: async () => { throw err('ENOENT') }, wait: async () => {} }), /ENOENT/); n++
  calls = 0
  await assert.rejects(BI.renameWithRetry('a', 'b', { rename: async () => { calls++; throw err('EBUSY') }, wait: async () => {} }), /EBUSY/); n++
  eq(calls, BI.RENAME_RETRY_MS.length + 1, 'renameWithRetry：重试有上限')
  const sw = path.join(tmp, 'swap')
  const outD = path.join(sw, 'models'), tmpD = path.join(sw, '.models-tmp-x')
  const reset = () => { fs.rmSync(sw, { recursive: true, force: true }); fs.mkdirSync(outD, { recursive: true }); fs.mkdirSync(tmpD, { recursive: true }); fs.writeFileSync(path.join(outD, 'v'), 'old'); fs.writeFileSync(path.join(tmpD, 'v'), 'new') }
  reset()
  await BI.swapInto(tmpD, outD, { wait: async () => {} })
  ok(fs.readFileSync(path.join(outD, 'v'), 'utf8') === 'new' && fs.readdirSync(sw).length === 1, 'swapInto：换入成功、旧目录删掉、不留临时目录')
  reset()
  const fsx = { rename: async (a, b) => { if (a === tmpD) throw err('EXDEV'); return fs.promises.rename(a, b) }, rm: (p) => fs.promises.rm(p, { recursive: true, force: true }), exists: fs.existsSync }
  await assert.rejects(BI.swapInto(tmpD, outD, { fsx, wait: async () => {} }), /EXDEV/); n++
  ok(fs.readFileSync(path.join(outD, 'v'), 'utf8') === 'old' && fs.readdirSync(sw).length === 1, 'swapInto：换入失败 → 旧目录回滚、临时目录照样删掉（审查：resources/ 下曾留 .models-tmp-*）')
}

// ⑬-e 真内置层（resources/models，进 git 的那份）：离线时 3D 页 autoMatch 能选中随包件（审查：目录条目让 ISS / TDRS 选中没随包的件）
if (PT) {
  const AM = await imp('packages/core/models/autoMatch.mjs')
  const bm = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'manifest.json'), 'utf8'))
  const withLod = new Set(bm.models.filter((m) => (m.builtin || []).some((k) => k !== 'thumb')).map((m) => m.id))
  eq(withLod.size, bm.models.length, '内置层每条都随包带了模型（没有目录条目）')
  ok(!bm.models.some((m) => /^param:/.test(m.id)), '内置层没有模板条目（DESIGN §8：模板运行时生成；工作台 / 3D 页按「模板没有清单条目」写）')
  // 3D 页 loadModelLib 的可用集 = 清单 id ∪ 模板目录（PARAM_CATALOG）；离线且没缓存远端清单时清单 = 内置层
  const available = new Set([...bm.models.map((m) => m.id), ...PT.TEMPLATE_IDS.map((t) => `param:${t}`)])
  const cases = [
    [{ name: 'ISS (ZARYA)', noradId: 25544, orbitKind: 'LEO' }, 'nasa:international-space-station-iss-d-igoal'],
    [{ name: 'TDRS 3', orbitKind: 'GEO' }, 'nasa:tracking-and-data-relay-satellites-trds-e'],
    [{ name: 'TDRS 11', orbitKind: 'GEO' }, 'nasa:tracking-and-data-relay-satellites-tdrs-d'],
    [{ name: 'GOES 16', orbitKind: 'GEO' }, 'nasa:geostationary-operational-environmental-satellites'],
    [{ name: 'HST', noradId: 20580, orbitKind: 'LEO' }, 'nasa:hubble-space-telescope-a'],
    [{ name: 'LANDSAT 8', orbitKind: 'LEO' }, 'nasa:landsat-8'],
    [{ name: 'LANDSAT 9', orbitKind: 'LEO' }, 'nasa:landsat-8']
  ]
  for (const [sat, want] of cases) {
    const hit = AM.match(sat, { available })
    eq(hit.id, want, `离线 autoMatch：${sat.name} → ${want}（随包）`)
    ok(withLod.has(hit.id), `离线 autoMatch：${sat.name} 选中的件随包带了模型`)
  }
  const geo = AM.match({ name: 'ZHONGXING-9B', orbitKind: 'GEO' }, { available })
  ok(/^param:/.test(geo.id), `离线 autoMatch：GEO 通信星 → 参数化（${geo.id}）`)
  const bi = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs')], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
  eq(bi.status, 0, `仓库 resources/models 过 check-models ${bi.stderr}`)
}

// ⑬ 续：builtin.mjs 主流程（子进程，临时 build 目录 + 临时 sheets 记账 → 临时 out）+ check-models 对产物放行
if (PT && PB && SCHEMA) {
  const bdir = path.join(tmp, 'bi-build'), rdir = path.join(tmp, 'bi-review'), odir = path.join(tmp, 'bi-out', 'models')
  fs.rmSync(bdir, { recursive: true, force: true })
  fs.mkdirSync(rdir, { recursive: true })
  const webpOf = (tag) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.from(tag)])
  // 底子：satellite-kit 三件用 metas[2]（尺寸未核）+ 它自己的 lod2，其余用 metas[0]（TDRS-A，尺寸已核）——
  // 这样子集里真有尺寸未核的件，下面才测得到「⚠ 子集里尺寸未核的」那一行（审查：以前全用 metas[0]，那行从来不出，断言只碰巧命中说明列）
  const kitRe = /^nasa:satellite-kit(?:~\d+)?$/
  const baseOf = (id) => (kitRe.test(id) ? { meta: metas[2], lod2: path.join(tmp, 'build', 'satkit-radio-1', 'lod2.glb') } : { meta: metas[0], lod2: path.join(tmp, 'build', 'tdrs-a', 'lod2.glb') })
  const models = []
  const sheets = { version: SH.SHEETS_VERSION, entries: {} }
  const saveSheets = () => fs.writeFileSync(path.join(rdir, 'sheets.json'), JSON.stringify(sheets))
  const put = (id) => {
    const dir = path.join(bdir, id.slice(5))
    const base = baseOf(id)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(base.lod2, path.join(dir, 'lod2.glb'))
    const w = webpOf(id)
    fs.writeFileSync(path.join(dir, 'thumb.webp'), w)
    const m = { ...base.meta, id, files: { ...base.meta.files, thumb: { sha256: sha256(w), bytes: w.length } } }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(m))
    models.push(B.slimMetaLocal(m))
    sheets.entries[id] = { thumbSha: sha256(w), lod: 'lod0', view: SH.THUMB_VIEW, contentKey: SH.thumbContentKey({ src: m.files.lod0.sha256, frame: m.frame, units: m.units }), source: 'render' }
  }
  for (const s of BI.BUILTIN_SUBSET) put(s.pick[0])
  put('nasa:catalog-only-x')
  saveSheets()
  fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify(B.buildManifest(models, { generatedAt: '2026-09-24T00:00:00.000Z' })))
  for (const tid of PT.TEMPLATE_IDS) {
    const d = path.join(bdir, '_param', tid)
    fs.mkdirSync(d, { recursive: true })
    const w = webpOf(`param:${tid}`)
    fs.writeFileSync(path.join(d, 'thumb.webp'), w)
    fs.writeFileSync(path.join(d, 'info.json'), JSON.stringify({ templateId: tid, specHash: PB.specHash(PT.templateSpec(tid).spec), thumbSha: sha256(w), thumbBytes: w.length, view: SH.THUMB_VIEW, renderedAt: '2026-09-24T00:00:00.000Z' }))
  }
  const BIN = path.join(REPO, 'scripts', 'nasa3d', 'builtin.mjs')
  const runBI = (...extra) => spawnSync(process.execPath, [BIN, `--build-dir=${bdir}`, `--review-dir=${rdir}`, `--out=${odir}`, ...extra], { encoding: 'utf8' })
  const chkOut = (...extra) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-models.mjs'), `--dir=${odir}`, ...extra], { encoding: 'utf8', env: { ...process.env, SATSIM_SKIP_MODELS: '' } })
  const nSub = BI.BUILTIN_SUBSET.length, nT = PT.TEMPLATE_IDS.length
  let r = runBI()
  eq(r.status, 0, `builtin 主流程（缺省）：退出码 0 ${r.stderr}`)
  let out = JSON.parse(fs.readFileSync(path.join(odir, 'manifest.json'), 'utf8'))
  eq(out.models.length, nSub, 'builtin 缺省：只出子集（不出目录条目、不出模板条目）')
  ok(out.models.every((m) => (m.builtin || []).includes('lod2')) && /^nasa-[0-9a-f]{12}$/.test(out.sourceBuildId), 'builtin 缺省：每条都带 lod2、记源 buildId')
  eq(fs.readdirSync(path.join(odir, 'builtin')).length, 2, 'builtin：同 sha 的 lod2 只落一份（TDRS-A 底子 10 件共一份 + satellite-kit 底子 3 件共一份）')
  eq(fs.readdirSync(path.join(odir, 'thumbs')).length, nSub, 'builtin：每条一张缩略图')
  eq(fs.readdirSync(path.dirname(odir)).length, 1, 'builtin：写完不留 .models-tmp-* / .models-old-*')
  {
    const warn = (r.stdout.split('\n').find((l) => l.startsWith('⚠ 子集里尺寸未核的：')) || '')
    const kits = BI.BUILTIN_SUBSET.map((s) => s.pick[0]).filter((id) => kitRe.test(id))
    ok(kits.length === 3 && kits.every((id) => warn.includes(`${id}（`)), `builtin：⚠ 行列出全部尺寸未核的子集件（satellite-kit 三件）${warn}`)
    ok(!/tracking-and-data-relay|landsat-8|hubble/.test(warn), 'builtin：尺寸已核的件不进 ⚠ 行')
    ok(/nasa3d:publish/.test(r.stdout), 'builtin：提示发版前先 publish')
    eq(out.thumbView, SH.THUMB_VIEW, 'builtin：manifest 顶层记缩略图取景口径 thumbView（check-models 据它拦显示系换向后没重出的缩略图）')
  }
  let chk = chkOut()
  eq(chk.status, 0, `builtin 产物（缺省）过 check-models ${chk.stderr}`)
  const before = fs.readFileSync(path.join(odir, 'manifest.json'))
  r = runBI()
  ok(r.status === 0 && /已是最新/.test(r.stdout) && fs.readFileSync(path.join(odir, 'manifest.json')).equals(before), 'builtin：重跑逐字节相同、不动文件')
  // 旧口径（全目录 + 模板条目）仍可出，但 check-models 缺省拦目录条目
  r = runBI('--catalog=full', '--templates=entries')
  eq(r.status, 0, `builtin --catalog=full --templates=entries：退出码 0 ${r.stderr}`)
  out = JSON.parse(fs.readFileSync(path.join(odir, 'manifest.json'), 'utf8'))
  eq(out.models.length, nSub + 1 + nT, 'builtin --catalog=full --templates=entries：子集 + 目录条目 + 全部模板')
  ok(!out.models.find((m) => m.id === 'nasa:catalog-only-x').builtin, 'builtin --catalog=full：目录条目没有档位表')
  chk = chkOut()
  ok(chk.status === 1 && /目录条目/.test(chk.stderr), 'check-models：全目录的产物缺省拦下')
  eq(chkOut('--allow-catalog').status, 0, 'check-models --allow-catalog：全目录 + 模板条目的产物放行')
  r = runBI('--dry-run')
  ok(r.status === 0 && new RegExp(`内置层：${nSub} 条（子集 ${nSub} · 参数化模板 0 · 目录条目 0）`).test(r.stdout), 'builtin --dry-run：只算、不写盘')
  r = runBI()
  eq(r.status, 0, 'builtin：回到缺省口径')
  const back = fs.readFileSync(path.join(odir, 'manifest.json'))
  const strip = (buf) => { const j = JSON.parse(buf); delete j.generatedAt; return JSON.stringify(j) }
  ok(strip(back) === strip(before) && JSON.parse(back).buildId === JSON.parse(before).buildId, 'builtin：回到缺省后与第一次内容相同（buildId 同；generatedAt 只在 buildId 没变时沿用）')
  // 缩略图核对不过（sheets.json 的内容键对不上当前 meta：改了 known-dims 之类）→ 报错、产物不动
  const keep = sheets.entries['nasa:landsat-8'].contentKey
  sheets.entries['nasa:landsat-8'].contentKey = '0'.repeat(24); saveSheets()
  r = runBI()
  ok(r.status === 1 && /nasa:landsat-8：缩略图核对不过（模型文件或标定/.test(r.stderr) && fs.readFileSync(path.join(odir, 'manifest.json')).equals(back), 'builtin：缩略图过期 → 报错、产物不动')
  sheets.entries['nasa:landsat-8'].contentKey = keep; saveSheets()
  // 缺缩略图 / 模板过时 / 子集缺件：报错退出，产物目录不动
  fs.rmSync(path.join(bdir, 'landsat-8', 'thumb.webp'))
  const lm = JSON.parse(fs.readFileSync(path.join(bdir, 'landsat-8', 'meta.json'), 'utf8')); delete lm.files.thumb
  fs.writeFileSync(path.join(bdir, 'landsat-8', 'meta.json'), JSON.stringify(lm))
  r = runBI()
  ok(r.status === 1 && /nasa:landsat-8：files\.thumb 缺失/.test(r.stderr) && fs.readFileSync(path.join(odir, 'manifest.json')).equals(back), 'builtin：子集缺缩略图 → 报错、产物不动')
  put('nasa:landsat-8'); saveSheets()
  const inf = path.join(bdir, '_param', TPL_GEO, 'info.json')
  const i0 = fs.readFileSync(inf)
  fs.writeFileSync(inf, JSON.stringify({ ...JSON.parse(i0), specHash: '0'.repeat(16) }))
  r = runBI('--templates=entries')
  ok(r.status === 1 && new RegExp(`param:${TPL_GEO}：缩略图是按 specHash 0{16} 出的`).test(r.stderr), 'builtin --templates=entries：模板缩略图过时 → 报错')
  fs.writeFileSync(inf, i0)
  const mj = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'))
  fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ ...mj, models: mj.models.filter((m) => m.id !== 'nasa:geostationary-operational-environmental-satellites') }))
  r = runBI()
  ok(r.status === 1 && /goes/.test(r.stderr), 'builtin：子集件在 build 里一个候选都没有 → 报错')
  fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ ...mj, partial: true }))
  r = runBI()
  ok(r.status === 1 && /partial/.test(r.stderr), 'builtin：build 的 manifest 是子集 → 拒绝')
  assert.throws(() => BI.resolveBuiltinOpts({ catalog: 'x' })); n++
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`modelPipeline: ${n} 项通过`)
