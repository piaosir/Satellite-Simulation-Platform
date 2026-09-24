// 网格原语 / 质量元抽取（packages/core/models/meshKit.mjs）的零漂移金标准 + 原语单测（三期契约 DESIGN3 §1 P0）。
//
// ① 金标准：fixtures/models/parambus.golden.json 是【抽取之前】的 paramBus（改动前副本，经 GOLDEN_REF 指给录制器）对下列输入的
//    生成结果摘要，抽取后必须逐字节相同。每例存【录制输入】cases[key].input 与摘要 cases[key].out，比对时回放 input——
//    金标准只看守生成器（paramBus + meshKit），不随 paramTemplates 的数值漂移而误报：
//    · 目录里全部可见模板（templateCatalog，= TEMPLATE_IDS，不含旧 id 别名）× fill 两档（'illustrative' / 'none'，
//      'none' 生成不了的记 SPEC_INVALID）——IR 每个网格 position / normal / uv / index 的 TypedArray 原始字节 sha256 逐条记；
//      massProps / attachPoints / articulations / solarPanelGroups / 包围盒 / 告警全文记（−0 记成 "-0"，JSON 数字往返即位级相等）。
//    · 各模板的附加件变体（侧挂 / 塔馈 / 网状 / 馈源阵 / 倾斜视轴 / 成对外槽 / 显式附加件 / 立方星展开板 / 相控阵块数 / 质量对齐两支……），
//      以及 modelParamBus 里的三份手写 spec——覆盖 paraLayout 与各原语的全部分支；这些逐节只记 sha256。
//    · 软检查（只打印、不判失败）：当前 templateSpec 现算的输入表与录制输入不同（模板改了数值 / 增删了模板）时列出差异——
//      回放照旧用录制输入；要让金标准覆盖新输入，按下面的办法重录。
//    不进金标准、现场另核的：根节点矩阵与 frame.q_model2body（bodyFrame.mjs 出厂映射）= paramBus 转出的 ROOT_MATRIX /
//    DEFAULT_Q_MODEL2BODY（接线对、数值归 modelBodyFrame 管）。
//    仍会随外部模块变的两处（归属方负责）：attachPoints.upBody 与挂点节点矩阵取自 bodyFrame.defaultUpBody（modelBodyFrame 看守）
//    与 agi.attachNodeMatrix（modelAgi 看守）——改动方有意改了这两条规则，改完负责重录本金标准并在提交说明里写明。
//    重录：UPDATE_GOLDEN=1 node packages/core/test/modelMeshKit.test.mjs（只写金标准、不跑其余断言；缺省用仓库现行 paramBus）；
//          GOLDEN_REF=<某份 paramBus.mjs 的路径> 可指定参考实现（如改动前的副本；其 import 须能解析——写绝对 file:// 地址）。
// ② 原语单测：闭合面散度体积（盒 / 柱 / 截锥）对多边形解析值、面法向与顶点法向同侧、薄壳二阶矩对解析、质量元对解析、
//    uniq / addItem / addAp 登记规则（含显式上向的临界阈值）、paraLayout 满足抛物面焦准线定义 + 前提不满足抛错、
//    paraLayout 与整星生成的反射面对账（Float32 量化内；逐位由金标准看守）、
//    buildWing / buildReflector / buildFeed 脱离整星 ctx（无 spec、无平台半边长）独立可用，不冒出 id='bus' 的假平台件。
// 不联网。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as PB from '../models/paramBus.mjs'
import { TEMPLATES, TEMPLATE_IDS, DETAIL_PRESETS, templateSpec, templateCatalog } from '../models/paramTemplates.mjs'
import * as BF from '../models/bodyFrame.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, 'fixtures', 'models', 'parambus.golden.json')
const UPDATE = process.env.UPDATE_GOLDEN === '1'
const GOLDEN_REF = UPDATE && process.env.GOLDEN_REF ? resolve(process.env.GOLDEN_REF) : null
const FILLS = ['illustrative', 'none']
const MESH_KEYS = ['position', 'normal', 'uv', 'index']

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const clone = (o) => JSON.parse(JSON.stringify(o))

// ───────── 摘要（金标准的唯一口径：录制与比对走同一个函数） ─────────

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const shaTA = (ta) => sha(Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength))
/** 转成可 JSON 往返且位级可比的形状：键排序、−0 → "-0"、非有限数 → 字符串、undefined 丢弃、TypedArray → 字节 sha256。 */
function toJ(v) {
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : (Number.isFinite(v) ? v : String(v))
  if (ArrayBuffer.isView(v)) return { $bytes: shaTA(v), $type: v.constructor.name, $len: v.length }
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJ(x)))
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined && typeof v[k] !== 'function') o[k] = toJ(v[k])
    return o
  }
  return v
}
const J = (v) => JSON.parse(JSON.stringify(toJ(v)))
const shaJ = (v) => sha(JSON.stringify(toJ(v)))

/** buildParamModel 结果 → 摘要。full = 逐网格 / 全文；否则逐节 sha256。 */
function digest(res, full) {
  const ir = res.ir
  const rows = ir.meshes.map((m) => [m.name, m.material, m.position.length / 3, m.index.length / 3, ...MESH_KEYS.map((k) => shaTA(m[k]))])
  const typed = ir.meshes.every((m) => m.position instanceof Float32Array && m.normal instanceof Float32Array && m.uv instanceof Float32Array && m.index instanceof Uint32Array)
  const nodes = ir.nodes.map((nd, i) => (i === 0 ? { ...nd, matrix: undefined } : nd))   // 根矩阵归 bodyFrame，现场另核
  const sec = (v) => (full ? J(v) : shaJ(v))
  return J({
    keys: sec(Object.keys(res).sort()),
    specHash: res.specHash,
    irHead: { units: ir.units, unitHint: ir.unitHint, sourceFormat: ir.sourceFormat, meshes: ir.meshes.length, nodes: ir.nodes.length, typed },
    materials: sec(ir.materials),
    meshes: full ? rows : shaJ(rows),
    nodes: shaJ(nodes),
    massProps: full ? res.massProps : { massKg: res.massProps.massKg, sha: shaJ(res.massProps) },
    attachPoints: sec(res.attachPoints),
    articulations: sec(res.articulations),
    solarPanelGroups: sec(res.solarPanelGroups),
    parts: shaJ(res.parts),
    frame: { ...res.frame, q_model2body: undefined },
    bbox: { bboxBody: res.bboxBody, boundingRadiusM: res.boundingRadiusM, specOriginBody: res.specOriginBody },
    spec: shaJ(res.spec),
    warnings: res.warnings
  })
}

/** 金标准输入表（顺序固定）。full=true 的是目录模板两档。 */
function goldenCases() {
  const out = []
  const push = (key, spec, full = false) => out.push({ key, spec, full })
  const ids = templateCatalog().map((c) => c.templateId)
  for (const id of ids) for (const fill of FILLS) push(`${id}@${fill}`, templateSpec(id, { fill }).spec, true)
  for (const id of ids) {
    const base = templateSpec(id).spec, lay = TEMPLATES[id].layout
    const b = base.bus, s0 = Math.min(b.xM, b.yM), hz = b.zM / 2
    // 前五个与 modelParamBus ⑥ 同口径
    const v = {
      addSide: { ...clone(base), reflectors: [...base.reflectors, { mount: 'side', diameterM: 0.9 * s0 }] },
      sideDeck: { ...clone(base), reflectors: [{ slot: '+X', diameterM: 0.9 * s0 }, { slot: 'deck+Y', diameterM: 0.5 * s0 }] },
      meshArray: { ...clone(base), reflectors: [{ slot: '-X', diameterM: 2.5 * s0, mesh: true, feedType: 'array' }, { slot: 'deck-Y', diameterM: 0.6 * s0, mesh: true }] },
      tilted: { ...clone(base), reflectors: [{ slot: '+X', diameterM: 0.8 * s0, boresightBody: [0.3, 0.2, 1] }, { slot: '-X', diameterM: 0.8 * s0, boresightBody: [0, 0, 1], offsetDirBody: [0, 1, 0.2] }] },
      extras: {
        ...clone(base),
        feeds: [{ kind: 'horn', posBody: [0, 0, hz + 0.1 * s0], dirBody: [0, 0, 1], apertureM: 0.1 * s0 }, { kind: 'patchArray', posBody: [0, 0, -hz - 0.01], dirBody: [0, 0, -1], apertureM: 0.3 * s0 }],
        booms: [{ fromBody: [0, 0, -hz], toBody: [0, 0, -hz - s0], dM: 0.02 * s0 }],
        thrusters: [{ posBody: [-b.xM / 2, 0, 0], dirBody: [-1, 0, 0], exitDM: 0.05 * s0, lengthM: 0.1 * s0 }],
        radiators: [{ face: '+X', wM: 0.5 * s0, hM: 0.5 * s0 }, { face: '-Z', wM: 0.4 * s0, hM: 0.4 * s0 }, { face: '-Y', wM: 0.3 * s0, hM: 0.2 * s0 }]
      }
    }
    if (lay === 'cubesat') {
      v.deploy = { ...clone(base), cubesat: { bodyCells: true, deployPanels: 2 }, reflectors: [{ mount: 'deck', diameterM: 4 * s0 }] }
      v.deployBare = { ...clone(base), cubesat: { bodyCells: false, deployPanels: 2 } }
    }
    if (lay === 'geo') {
      v.wingTilt = { ...clone(base), wings: base.wings.map((w) => ({ ...w, tiltDeg: 25, sidePanels: 2 })) }
      v.pair4 = {
        ...clone(base),
        reflectors: [{ slot: '+X', diameterM: 0.9 * s0 }, { slot: '+X2', diameterM: 0.7 * s0, focalM: 0.6 * s0 },
          { slot: '-X', diameterM: 0.9 * s0, offsetHM: 0.8 * s0, feedType: 'array' }, { slot: '-X2', diameterM: 0.8 * s0, mesh: true, feedApertureM: 0.2 * s0 }]
      }
      v.tower = { ...clone(base), reflectors: [{ slot: 'deck+Y', diameterM: 0.5 * s0 }, { slot: 'deck-Y', diameterM: 0.45 * s0, focalM: 0.4 * s0, feedType: 'array' }], tower: { hM: 0.9 * s0, wM: 0.25 * s0 } }
      v.bare = { ...clone(base), bus: { ...b, mli: null }, detail: { mli: false, radiators: false, thrusters: false, adapter: false, deckHorns: 0 } }
      v.massLow = { ...clone(base), massTargetKg: 1 }
      v.busMass = { ...clone(base), bus: { ...b, massKg: 1234.5 }, detail: { ...(base.detail || {}), deckHorns: 1 } }
    }
    if (lay === 'leo-flat') for (const tiles of [0, 1, 2]) v[`tiles${tiles}`] = { ...clone(base), phasedArray: { tiles }, detail: { ...(base.detail || {}), thrusters: tiles !== 1 } }
    for (const [vn, spec] of Object.entries(v)) push(`${id}/${vn}`, spec)
  }
  // modelParamBus ② 的三份手写 spec（手给焦点 + 倾斜视轴、东侧成对、立方星侧挂）
  push('hand/tilt', {
    layout: 'geo', detailPreset: 'geo', bus: { shape: 'box', xM: 2.4, yM: 2.2, zM: 3.0, mli: 'mli_gold' }, wings: [],
    reflectors: [
      { slot: '+X', diameterM: 2.3, focalM: 1.9, offsetHM: 1.6, posBody: [1.05, 0.3, 1.8], boresightBody: [0.12, -0.05, 1] },
      { slot: '-X', diameterM: 2.0, focalM: 1.7, offsetHM: null, posBody: null, boresightBody: [0, 0, 1] },
      { slot: 'deck+Y', diameterM: 1.1, focalM: 0.9, offsetHM: null, posBody: null }
    ]
  })
  push('hand/pair', { layout: 'geo', detailPreset: 'geo', bus: { shape: 'box', xM: 2.2, yM: 2.0, zM: 3.2, mli: 'mli_gold' }, wings: [], reflectors: [{ slot: '+X', diameterM: 2.0 }, { slot: '+X2', diameterM: 1.6, focalM: 1.5 }] })
  push('hand/cubesat', { ...templateSpec('cubesat-3u').spec, reflectors: [{ slot: '-X', diameterM: 0.3 }] })
  return out
}

/** 一例 → {d: 摘要, res}；生成不了的记错误码（res = null）。pb = 被测 / 参考的 paramBus 模块。 */
function runCase(pb, spec, full) {
  let res
  try { res = pb.buildParamModel(spec) } catch (e) { return { d: J({ error: e.code || 'THROW', message: e.code ? undefined : e.message }), res: null } }
  return { d: digest(res, full), res }
}

// ───────── 录制模式 ─────────

if (UPDATE) {
  // 录制时的前提都是硬的：目录 = TEMPLATE_IDS；输入 JSON 往返无损（否则回放的不是生成器当时见到的那份）
  assert.deepStrictEqual(templateCatalog().map((c) => c.templateId), [...TEMPLATE_IDS], '目录 = TEMPLATE_IDS（不含旧 id 别名）')
  const REF = GOLDEN_REF ? await import(pathToFileURL(GOLDEN_REF).href) : PB
  const cases = goldenCases()
  const out = {}
  for (const c of cases) {
    const input = JSON.parse(JSON.stringify(c.spec))
    assert.deepStrictEqual(input, c.spec, `${c.key}：输入 JSON 往返有损（含 undefined / −0 / 非有限数）`)
    const { d } = runCase(REF, input, c.full)
    // 目录两档里只有 fill:'none' 允许生成不了；变体与手写 spec 必须能生成（否则覆盖是假的）
    if (d.error && !c.key.endsWith('@none')) throw new Error(`金标准录制：${c.key} 生成失败 ${d.error} ${d.message || ''}`)
    out[c.key] = { full: c.full, input, out: d }
  }
  mkdirSync(dirname(GOLDEN), { recursive: true })
  // ref：录制用的实现（P0 基线 = meshKit 抽取前的 paramBus 副本经 GOLDEN_REF 录制；之后缺省用仓库现行）
  const meta = { what: 'paramBus.buildParamModel 摘要（比对时回放 input）', ref: GOLDEN_REF ? `GOLDEN_REF:${basename(GOLDEN_REF)}` : 'repo:packages/core/models/paramBus.mjs', node: process.version, cases: cases.length, templateIds: TEMPLATE_IDS }
  const body = Object.entries(out).map(([k, v]) => `${JSON.stringify(k)}:{"full":${v.full},"input":${JSON.stringify(v.input)},\n "out":${JSON.stringify(v.out)}}`).join(',\n')
  writeFileSync(GOLDEN, `{"meta":${JSON.stringify(meta)},\n"cases":{\n${body}\n}}\n`)
  const gen = Object.values(out).filter((v) => !v.out.error).length
  console.log(`金标准已写：${cases.length} 例（可生成 ${gen} 例，参考实现 ${meta.ref}）→ ${GOLDEN}`)
  process.exit(0)
}

// ───────── ① 金标准逐字节相等（回放录制输入） ─────────

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
const gcases = Object.entries(golden.cases).map(([key, v]) => ({ key, ...v }))

t('金标准：fixture 结构（每例带录制输入与摘要；目录模板 × 两档齐全）', () => {
  assert.ok(gcases.length === golden.meta.cases && gcases.length > 0, '例数与 meta 一致')
  for (const c of gcases) {
    assert.equal(typeof c.full, 'boolean', `${c.key}.full`)
    assert.ok(c.input && typeof c.input === 'object' && !Array.isArray(c.input), `${c.key}.input`)
    assert.ok(c.out && typeof c.out === 'object', `${c.key}.out`)
  }
  const full = gcases.filter((c) => c.full).map((c) => c.key)
  assert.deepStrictEqual(full, golden.meta.templateIds.flatMap((id) => FILLS.map((f) => `${id}@${f}`)), '目录模板 × 两档')
})

// 软检查：当前 templateSpec 现算的输入表 vs 录制输入（只打印，不判失败——金标准看守的是生成器，不是模板数值）
{
  const notes = []
  try {
    const ids = templateCatalog().map((c) => c.templateId)
    if (JSON.stringify(ids) !== JSON.stringify([...TEMPLATE_IDS])) notes.push('目录 ≠ TEMPLATE_IDS')
    const cur = new Map(goldenCases().map((c) => [c.key, c.spec]))
    const changed = gcases.filter((c) => cur.has(c.key) && shaJ(cur.get(c.key)) !== shaJ(c.input)).map((c) => c.key)
    const added = [...cur.keys()].filter((k) => !(k in golden.cases))
    const gone = gcases.filter((c) => !cur.has(c.key)).map((c) => c.key)
    const ls = (a) => `${a.length}${a.length ? `（${a.slice(0, 4).join('、')}${a.length > 4 ? '…' : ''}）` : ''}`
    if (changed.length || added.length || gone.length) notes.push(`输入表与录制时不同：变 ${ls(changed)}、新增 ${ls(added)}、缺 ${ls(gone)}`)
  } catch (e) {
    notes.push(`现算输入表失败：${e.message}`)
  }
  if (notes.length) console.log(`  注意（不判失败，回放用录制输入；要覆盖新输入就确认生成器无意漂移后重录）：${notes.join('；')}`)
}

const cmp = (label, filter) => t(label, () => {
  let k = 0, bytes = 0
  for (const c of gcases.filter(filter)) {
    const g = c.out
    const { d, res } = runCase(PB, clone(c.input), c.full)
    assert.deepStrictEqual(Object.keys(d).sort(), Object.keys(g).sort(), `${c.key}：摘要节不同`)
    for (const s of Object.keys(g)) assert.deepStrictEqual(d[s], g[s], `${c.key} · ${s} 与金标准不同`)
    if (res) {
      // 根矩阵 / 出厂 q 不进金标准：现场核对接线 = paramBus 转出的 bodyFrame 真值
      assert.equal(res.ir.nodes[0].name, 'satellite')
      assert.deepStrictEqual(res.ir.nodes[0].matrix, [...PB.ROOT_MATRIX], `${c.key} 根矩阵`)
      assert.deepStrictEqual(res.frame.q_model2body, [...PB.DEFAULT_Q_MODEL2BODY], `${c.key} frame.q`)
      for (const m of res.ir.meshes) for (const key of MESH_KEYS) bytes += m[key].byteLength
      k++
    }
  }
  console.log(`  ${label.split('：')[0]}：${k} 例生成、IR 字节 ${(bytes / 1048576).toFixed(1)} MiB 逐字节相等`)
})
cmp('金标准·目录模板：全部可见模板 × fill 两档，IR 网格逐字节 / specHash / 质量特性 / 挂点 / 关节 / 太阳翼组相同', (c) => c.full)
cmp('金标准·变体：附加件 / 反射面各分支 / 立方星 / 相控阵 / 质量对齐 / 手写 spec，逐节 sha256 相同', (c) => !c.full)

// ───────── ② meshKit 原语 ─────────

const K = await import('../models/meshKit.mjs')
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}，容差 ${tol}）`)
const nearV = (a, b, tol, msg) => { assert.equal(a.length, b.length, `${msg} 长度`); for (let i = 0; i < a.length; i++) near(a[i], b[i], tol, `${msg}[${i}]`) }
const relNear = (a, b, rel, msg) => near(a, b, rel * Math.max(1, Math.abs(b)), msg)

/** 闭合三角网的有向体积（散度定理，外法向绕序为正）。 */
function signedVolume(mb) {
  let V = 0
  const P = (i) => [mb.p[3 * i], mb.p[3 * i + 1], mb.p[3 * i + 2]]
  for (let q = 0; q < mb.idx.length; q += 3) V += K.dot(P(mb.idx[q]), K.cross(P(mb.idx[q + 1]), P(mb.idx[q + 2]))) / 6
  return V
}
/** 每个三角形的几何法向（绕序）与三个顶点法向同侧；返回最小点积。 */
function minWindingDot(mb) {
  let mn = Infinity
  for (let q = 0; q < mb.idx.length; q += 3) {
    const [a, b, c] = [0, 1, 2].map((j) => mb.idx[q + j])
    const P = (i) => [mb.p[3 * i], mb.p[3 * i + 1], mb.p[3 * i + 2]]
    const g = K.nrm(K.cross(K.sub(P(b), P(a)), K.sub(P(c), P(a))))
    for (const i of [a, b, c]) mn = Math.min(mn, K.dot(g, [mb.n[3 * i], mb.n[3 * i + 1], mb.n[3 * i + 2]]))
  }
  return mn
}
const polyArea = (r, seg) => (seg / 2) * r * r * Math.sin((2 * Math.PI) / seg)

t('结构：原语与质量元只在 meshKit 定义一次；meshKit 零 three / 零模板依赖；paramBus 转出组件复用入口', () => {
  const src = (f) => readFileSync(join(HERE, '..', 'models', f), 'utf8')
  const pb = src('paramBus.mjs'), mk = src('meshKit.mjs')
  for (const re of [/class MB\b/, /function quad\(/, /function box\(/, /function frustum\(/, /function annulus\(/, /function horn\(/, /function shellProps\(/,
    /function rotInertia\(/, /const pAxis =/, /const boxComp =/, /const plateComp =/, /function rodComp\(/, /function shellComp\(/, /const pointComp =/, /function addAp\(/, /function uniq\(/, /function addItem\(/]) {
    assert.ok(!re.test(pb), `paramBus 不再自带 ${re}`)
    assert.ok(re.test(mk), `meshKit 定义 ${re}`)
  }
  assert.ok(/from '\.\/meshKit\.mjs'/.test(pb), 'paramBus import meshKit')
  assert.ok(/paraLayout\(/.test(pb), 'reflectorLayout 尾部调 paraLayout')
  const imports = [...mk.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepStrictEqual(imports, ['./bodyFrame.mjs'], 'meshKit 只依赖 bodyFrame（defaultUpBody）')
  for (const f of ['buildWing', 'buildReflector', 'buildFeed', 'resolveDensity', 'nonFiniteReport', 'canon', 'fnv1a64Hex']) assert.equal(typeof PB[f], 'function', `paramBus 转出 ${f}`)
  assert.equal(PB.SOLAR_EFFICIENCY_DEFAULT, 28)
  for (const f of ['MB', 'quad', 'box', 'frustum', 'annulus', 'horn', 'tube', 'shellProps', 'rotInertia', 'pAxis', 'boxComp', 'plateComp', 'rodComp', 'shellComp', 'pointComp', 'addAp', 'paraLayout', 'createCtx', 'uniq', 'addItem', 'colMajor', 'worldPositions', 'meshArea', 'perpPair']) {
    assert.equal(typeof K[f], 'function', `meshKit 导出 ${f}`)
  }
  for (const c of [K.EX, K.EY, K.EZ, K.IDR, K.BOX_FACES]) assert.ok(Object.isFrozen(c), '共享常量冻结')
  assert.equal(PB.specHash(templateSpec('default-sat').spec), PB.fnv1a64Hex(PB.canon(PB.normalizeSpec(templateSpec('default-sat').spec))), 'specHash = FNV(canon(normalize))')
})

t('MB / quad / box：法向单位且朝外、绕序与法向同侧、uv 米制；闭合盒散度体积 = 8abc', () => {
  const mb = new K.MB()
  K.quad(mb, [1, 2, 3], [0.5, 0, 0], [0, 0.25, 0])
  assert.equal(mb.vcount, 4); assert.equal(mb.tcount, 2)
  nearV([mb.n[0], mb.n[1], mb.n[2]], [0, 0, 1], 0, 'quad 法向 = u×v')
  assert.deepStrictEqual(mb.uv, [0, 0, 1, 0, 1, 0.5, 0, 0.5], 'uv 米制（2|u| × 2|v|）')
  const v0 = mb.v([0, 0, 0], [0, 0, 5]); nearV(mb.n.slice(3 * v0, 3 * v0 + 3), [0, 0, 1], 0, '顶点法向归一')
  const h = [0.7, 1.1, 1.9], c = [0.3, -0.2, 0.5], bm = new K.MB()
  K.box(bm, c, h)
  assert.equal(bm.tcount, 12)
  relNear(signedVolume(bm), 8 * h[0] * h[1] * h[2], 1e-13, '盒体积')
  near(minWindingDot(bm), 1, 1e-12, '盒绕序')
  for (let i = 0; i < bm.vcount; i++) {
    const p = bm.p.slice(3 * i, 3 * i + 3), nn = bm.n.slice(3 * i, 3 * i + 3)
    assert.ok(K.dot(nn, K.sub(p, c)) > 0, '盒面法向朝外')
  }
  const open = new K.MB(); K.box(open, [0, 0, 0], h, ['+x', '-x', '+y', '-y', '+z'])
  assert.equal(open.tcount, 10, '缺省面可选')
})

t('frustum / tube / annulus / horn：闭合截锥散度体积 = 多边形棱台解析值；绕序与法向一致（含内壁、背面环）', () => {
  const seg = 24, p0 = [0.1, 0.2, -0.3], d = K.nrm([0.3, -0.4, 1]), H = 1.7, p1 = K.madd(p0, d, H)
  const tb = new K.MB(); K.tube(tb, p0, p1, 0.4, seg)
  relNear(signedVolume(tb), polyArea(0.4, seg) * H, 1e-12, '柱体积')
  assert.ok(minWindingDot(tb) > 0, '柱绕序')
  const fr = new K.MB(); K.frustum(fr, p0, 0.5, p1, 0.2, seg, true, true)
  const A0 = polyArea(0.5, seg), A1 = polyArea(0.2, seg)
  relNear(signedVolume(fr), (H / 3) * (A0 + A1 + Math.sqrt(A0 * A1)), 1e-12, '截锥体积')
  assert.ok(minWindingDot(fr) > 0, '截锥绕序')
  const inw = new K.MB(); K.frustum(inw, p0, 0.5, p1, 0.2, seg, false, false, true)
  assert.ok(minWindingDot(inw) > 0, '内壁（inward）绕序跟着法向翻')
  for (let i = 0; i < inw.vcount; i++) {
    const p = inw.p.slice(3 * i, 3 * i + 3), rad = K.reject(K.sub(p, p0), d)
    assert.ok(K.dot(inw.n.slice(3 * i, 3 * i + 3), rad) < 0, '内壁法向朝轴')
  }
  for (const face of [d, K.scl(d, -1)]) {
    const an = new K.MB(); K.annulus(an, p1, d, 0.2, 0.3, seg, face)
    assert.equal(an.tcount, 2 * seg)
    assert.ok(minWindingDot(an) > 0.999999, `环朝 ${face === d ? '+d' : '−d'} 绕序`)
  }
  const hn = new K.MB(); K.horn(hn, [0, 0, 2], [0, 0, 3], 0.15, 0.4, 20)
  assert.ok(minWindingDot(hn) > 0, '喇叭绕序')
  let zmin = Infinity, zmax = -Infinity
  for (let i = 2; i < hn.p.length; i += 3) { zmin = Math.min(zmin, hn.p[i]); zmax = Math.max(zmax, hn.p[i]) }
  near(zmax, 2, 1e-15, '喇叭口面在 aperture'); near(zmin, 1.6, 1e-15, '喉部 = aperture − len·dir')
  const [e1, e2] = K.perpPair(d)
  near(K.dot(e1, d), 0, 1e-15, 'perpPair ⟂'); near(K.dot(e2, d), 0, 1e-15, 'perpPair ⟂'); near(K.dot(e1, e2), 0, 1e-15, 'perpPair 互⟂'); near(K.len(e1), 1, 1e-15, 'perpPair 单位')
})

t('shellProps / worldPositions：闭合薄壳盒的面积、质心、惯量对解析值；旋转平移后 = R·I·Rᵀ、质心 = t', () => {
  const [a, b, c] = [0.6, 0.9, 1.4], areal = 2.5, mb = new K.MB()
  K.box(mb, [0, 0, 0], [a, b, c])
  // 六块薄板各自对质心 + 平行轴
  const fx = 4 * b * c * areal, fy = 4 * a * c * areal, fz = 4 * a * b * areal
  const Ixx = 2 * fx * ((2 * b) ** 2 + (2 * c) ** 2) / 12 + 2 * fy * ((2 * c) ** 2 / 12 + b * b) + 2 * fz * ((2 * b) ** 2 / 12 + c * c)
  const Iyy = 2 * fy * ((2 * a) ** 2 + (2 * c) ** 2) / 12 + 2 * fx * ((2 * c) ** 2 / 12 + a * a) + 2 * fz * ((2 * a) ** 2 / 12 + c * c)
  const Izz = 2 * fz * ((2 * a) ** 2 + (2 * b) ** 2) / 12 + 2 * fx * ((2 * b) ** 2 / 12 + a * a) + 2 * fy * ((2 * a) ** 2 / 12 + b * b)
  const sp = K.shellProps(Float64Array.from(mb.p), mb.idx, areal)
  relNear(sp.area, 8 * (a * b + b * c + a * c), 1e-14, '面积'); relNear(sp.massKg, 8 * (a * b + b * c + a * c) * areal, 1e-14, '质量')
  nearV(sp.com, [0, 0, 0], 1e-15, '质心')
  nearV(sp.I, [Ixx, 0, 0, 0, Iyy, 0, 0, 0, Izz], 1e-12 * Izz, '惯量')
  const R = K.rotAboutLocalY([K.nrm([1, 1, 0]), K.nrm([-1, 1, 0]), K.EZ], 30), tt = [1, -2, 3]
  const sw = K.shellProps(K.worldPositions(mb, R, tt), mb.idx, areal)
  nearV(sw.com, tt, 1e-13, '平移后质心')
  nearV(sw.I, K.rotInertia(R, Ixx, Iyy, Izz), 1e-11 * Izz, 'R·diag·Rᵀ')
  near(K.meshArea(mb.p, mb.idx), sp.area, 1e-13, 'meshArea')
  assert.deepStrictEqual(K.shellProps([], [], 1), { area: 0, massKg: 0, com: [0, 0, 0], I: K.m3zero() }, '空网格')
})

t('质量元：盒 / 板 / 杆 / 质点对解析；质量 ≤ 0 不登记；pAxis / rotInertia', () => {
  const ctx = K.createCtx({ dens: { boomLinear: 2 } })
  for (const k of ['items', 'names', 'comps', 'parts', 'aps', 'arts', 'spg', 'warnings']) assert.ok(k in ctx, `ctx.${k}`)
  K.boxComp(ctx, 'b', 12, [1, 2, 3], [0.5, 1, 1.5])
  assert.deepStrictEqual(ctx.comps[0], { name: 'b', kind: 'box', massKg: 12, com: [1, 2, 3], I: [12 * (4 + 9) / 12, 0, 0, 0, 12 * (1 + 9) / 12, 0, 0, 0, 12 * (1 + 4) / 12] })
  K.plateComp(ctx, 'p', 3, [0, 0, 0], K.IDR, 2, 4)
  nearV(ctx.comps[1].I, [3 * 16 / 12, 0, 0, 0, 3 * 4 / 12, 0, 0, 0, 3 * 20 / 12], 1e-15, '板（局部 x 宽、y 长）')
  K.rodComp(ctx, 'r', [0, 0, 0], [0, 0, 3])
  const r = ctx.comps[2]; near(r.massKg, 6, 0, '杆质量 = 线密度·长'); nearV(r.com, [0, 0, 1.5], 0, '杆质心')
  nearV(r.I, [6 * 9 / 12, 0, 0, 0, 6 * 9 / 12, 0, 0, 0, 0], 1e-15, '杆惯量')
  K.rodComp(ctx, 'r0', [1, 1, 1], [1, 1, 1]); K.pointComp(ctx, 'z', 0, [0, 0, 0]); K.boxComp(ctx, 'neg', -1, [0, 0, 0], [1, 1, 1])
  assert.equal(ctx.comps.length, 3, '零长杆 / 零质量 / 负质量不登记')
  K.pointComp(ctx, 'q', 2, [1, 0, 0]); assert.deepStrictEqual(ctx.comps[3].I, K.m3zero())
  nearV(K.pAxis(2, [1, 2, 0]), [8, -4, 0, -4, 2, 0, 0, 0, 10], 0, 'pAxis = m(|d|²I − ddᵀ)')
  const R = K.rotAboutLocalY(K.IDR, 90)
  nearV(K.rotInertia(R, 1, 2, 3), [3, 0, 0, 0, 2, 0, 0, 0, 1], 1e-15, '绕 y 转 90° 交换 xx / zz')
})

t('uniq / addItem / addAp：重名抛错、部件登记节点、挂点上向（显式投影 / 缺省 D1 / 平行退化）', () => {
  const ctx = K.createCtx({})
  const it = K.addItem(ctx, { name: 'a', role: 'bus', part: { id: 'P', name: '件', role: 'bus' }, mat: 'aluminum', mb: new K.MB() })
  assert.equal(it.R, K.IDR); assert.deepStrictEqual(it.t, [0, 0, 0])
  K.addItem(ctx, { name: 'b', role: 'boom', part: { id: 'P' }, mat: 'carbon', mb: new K.MB() })
  assert.deepStrictEqual(ctx.parts.get('P'), { id: 'P', name: '件', role: 'bus', nodes: ['a', 'b'], areaM2: 0 })
  assert.throws(() => K.addItem(ctx, { name: 'a', mb: new K.MB() }), /重复/)
  assert.throws(() => K.uniq(ctx, ''), /为空/)
  K.addAp(ctx, 'ap1', [1, 2, 3], [0, 0, 2])
  assert.deepStrictEqual(ctx.aps[0], { name: 'ap1', posBody: [1, 2, 3], dirBody: [0, 0, 1], upBody: BF.defaultUpBody([0, 0, 1]) })
  K.addAp(ctx, 'ap2', [0, 0, 0], [0, 0, 1], [1, 0, 1])
  nearV(ctx.aps[1].upBody, [1, 0, 0], 0, '显式上向去掉视轴分量')
  K.addAp(ctx, 'ap3', [0, 0, 0], [0, 0, 1], [0, 0, -3])
  assert.deepStrictEqual(ctx.aps[2].upBody, BF.defaultUpBody([0, 0, 1]), '上向 ∥ 视轴 → D1 缺省')
  assert.throws(() => K.addAp(ctx, 'ap1', [0, 0, 0], [1, 0, 0]), /重复/, '挂点与节点同一名字空间')
})

t('addAp 显式上向的临界阈值：去掉视轴分量后长 1e-4 仍取投影、1e-8 回退 D1（阈值 1e-6）', () => {
  const ctx = K.createCtx({})
  // 视轴 +Z：D1 缺省 = 本体 −Y 投影，与 +X 可区分
  const d1z = BF.defaultUpBody([0, 0, 1])
  assert.ok(K.dot(d1z, [1, 0, 0]) < 0.5, 'D1(+Z) 与 +X 可区分')
  K.addAp(ctx, 'z4', [0, 0, 0], [0, 0, 1], [1e-4, 0, 1])
  assert.deepStrictEqual(ctx.aps[0].upBody, [1, 0, 0], '投影长 1e-4 > 1e-6 → 取投影')
  K.addAp(ctx, 'z8', [0, 0, 0], [0, 0, 1], [1e-8, 0, 1])
  assert.deepStrictEqual(ctx.aps[1].upBody, d1z, '投影长 1e-8 < 1e-6 → D1')
  // 斜视轴：up = 3d + ε·e（e ⟂ d 单位）
  const d = K.nrm([0.3, -0.4, 1]), [e] = K.perpPair(d), d1 = BF.defaultUpBody(d)
  assert.ok(K.dot(d1, e) < 0.99, 'D1(d) 与 e 可区分')
  K.addAp(ctx, 's4', [0, 0, 0], d, K.madd(K.scl(d, 3), e, 1e-4))
  nearV(ctx.aps[2].upBody, e, 1e-9, '斜视轴、投影长 1e-4 → 取投影')
  K.addAp(ctx, 's8', [0, 0, 0], d, K.madd(K.scl(d, 3), e, 1e-8))
  assert.deepStrictEqual(ctx.aps[3].upBody, d1, '斜视轴、投影长 1e-8 → D1')
})

t('paraLayout：焦准线定义 |P−F| = f + (P−V)·a、法向单位且 ⟂ 切向、Pc / nc / V / e2 口径', () => {
  const F = [0.4, -0.2, 2.1], a = K.nrm([0.1, 0.05, 1]), u = K.nrm(K.reject([1, 0, 0], a)), f = 1.3, D = 2.2, dc = 1.5
  const L = K.paraLayout(F, a, u, f, D, dc, 0.5)
  assert.equal(L.k, 0.5); assert.equal(K.paraLayout(F, a, u, f, D, dc).k, 1, 'k 缺省 1')
  for (const key of ['F', 'a', 'u', 'f', 'D', 'dc']) assert.deepStrictEqual(L[key], { F, a, u, f, D, dc }[key])
  nearV(L.V, K.madd(F, a, -f), 0, 'V = F − f·a'); nearV(L.e2, K.cross(a, u), 0, 'e2 = a×u')
  nearV(L.P(0, 0), L.V, 1e-15, 'P(0,0) = V')
  assert.deepStrictEqual(L.Pc, L.P(dc, 0)); assert.deepStrictEqual(L.nc, L.N(dc, 0))
  for (const [x1, x2] of [[dc, 0], [dc + 0.9, 0.3], [dc - 1.1, -0.8], [0.2, 1.05]]) {
    const p = L.P(x1, x2), nn = L.N(x1, x2), h = 1e-6
    near(K.len(K.sub(p, F)), f + K.dot(K.sub(p, L.V), a), 1e-13, `焦准线 (${x1},${x2})`)
    near(K.len(nn), 1, 1e-15, '法向单位')
    near(K.dot(nn, K.nrm(K.sub(L.P(x1 + h, x2), L.P(x1 - h, x2)))), 0, 1e-8, '⟂ ∂P/∂x1')
    near(K.dot(nn, K.nrm(K.sub(L.P(x1, x2 + h), L.P(x1, x2 - h)))), 0, 1e-8, '⟂ ∂P/∂x2')
    assert.ok(K.dot(nn, K.sub(F, p)) > 0, '法向朝焦点一侧（凹面）')
  }
})

t('paraLayout 前提不满足抛错（只查不归一）：非单位轴 / 非单位偏置 / 不正交 / f ≤ 0 / D ≤ 0 / 非有限', () => {
  const F = [0, 0, 1.5], a = [0, 0, 1], u = [1, 0, 0]
  assert.doesNotThrow(() => K.paraLayout(F, a, u, 1.2, 1.6, 1.1))
  const bad = [
    [[F, [0, 0, 2], u, 1, 1, 1], /母轴 a 须为单位向量/],
    [[F, a, [2, 0, 0], 1, 1, 1], /偏置方向 u 须为单位向量/],
    [[F, a, K.nrm([1, 0, 0.01]), 1, 1, 1], /须与母轴 a 正交/],
    [[F, a, u, 0, 1, 1], /焦距 f 须为正有限数/],
    [[F, a, u, -1, 1, 1], /焦距 f/],
    [[F, a, u, NaN, 1, 1], /焦距 f/],
    [[F, a, u, 1, 0, 1], /口径 D/],
    [[F, a, u, 1, 1, NaN], /偏置 dc/],
    [[F, a, u, 1, 1, 1, 0], /附件缩放 k/],
    [[[0, NaN, 0], a, u, 1, 1, 1], /焦点 F/],
    [[F, [0, 0, 1, 0], u, 1, 1, 1], /母轴 a/]
  ]
  for (const [args, re] of bad) assert.throws(() => K.paraLayout(...args), (e) => re.test(e.message) && /^meshKit\.paraLayout：.*（生成器内部错误）$/.test(e.message), `${re}`)
  // 容差 1e-9 远宽于 nrm / reject 的舍入：整星路径式样（nrm 后再 reject 再 nrm）不误伤
  const a2 = K.nrm([0.12, -0.05, 1]), u2 = K.nrm(K.reject(K.nrm([1, 0.3, 0]), a2))
  assert.doesNotThrow(() => K.paraLayout(F, a2, u2, 1.9, 2.3, 1.6))
})

t('paraLayout 与整星生成对账：默认卫星东侧反射面网格首点 = paraLayout.Pc（Float32 量化内）、顶点一致', () => {
  const r = PB.buildTemplateModel('default-sat')
  const part = r.parts.find((p) => p.id === 'reflector_1')
  const o = r.specOriginBody, fit = part.fitted
  const F = K.add(fit.focusBody, o), a = fit.axisBody
  const s = PB.normalizeSpec(r.spec).reflectors[0]
  assert.equal(s.slot, '+X')
  const L = K.paraLayout(F, a, K.nrm(K.reject([1, 0, 0], a)), fit.focalM, fit.diameterM, fit.offsetM)
  const m = r.ir.meshes.find((x) => x.name === 'reflector_1')
  // 焦点由输出坐标 + 原点平移回 spec 坐标，可能差 1 ulp——网格首点按 Float32 量化容差比
  nearV(Array.from(m.position.slice(0, 3)), L.Pc, 1e-6, '网格首点（口径中心）')
  nearV(K.add(fit.vertexBody, o), L.V, 1e-12, '顶点')
})

t('组件复用：buildWing / buildReflector / buildFeed 脱离整星 ctx（无 spec、无平台半边长）独立生成', () => {
  const D = DETAIL_PRESETS.geo
  const ctx = K.createCtx({ dens: PB.resolveDensity(), D })
  assert.equal(ctx.spec, undefined)
  const opt = { sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM, articulate: true }
  const w = { side: '-Y', panels: 3, panelHM: 2, panelWM: 1.5, sidePanels: 0, yokeLenM: 1, gapM: 0.05, tiltDeg: 0, efficiency: 30, hingeBody: [0, 0, 0] }
  const wr = PB.buildWing(ctx, w, opt)
  nearV(wr.hinge, [0, 0, 0], 0, '铰点')
  nearV(wr.tipBody, [0, -(D.sadaLenM + 1 + 3 * 2 + 2 * 0.05), 0], 1e-12, '翼尖（−Y 翼沿 −Y 伸）')
  assert.deepStrictEqual(ctx.spg, [{ name: 'wing_-Y', nodes: ['wing_-Y_1_cells', 'wing_-Y_2_cells', 'wing_-Y_3_cells'], efficiency: 30 }])
  assert.equal(ctx.arts.length, 1); assert.equal(ctx.arts[0].stages[0].type, 'yRotate')
  assert.ok(ctx.aps.some((x) => x.name === 'wing_-Y_axis' && x.dirBody[1] === -1))
  nearV(ctx.parts.get('wing_-Y').normalBody, [0, 0, -1], 0, '电池面朝 −Z（天顶）')
  // 部件：组件模式下 SADA 单独成件，不冒出 id='bus' 的假平台件；不给 sadaMassKg 就不记 SADA 质量元
  assert.deepStrictEqual([...ctx.parts.keys()], ['wing_-Y_sada', 'wing_-Y_yoke', 'wing_-Y'])
  assert.deepStrictEqual(ctx.parts.get('wing_-Y_sada'), { id: 'wing_-Y_sada', name: '太阳翼驱动机构 -Y', role: 'bus', nodes: ['wing_-Y_sada'], areaM2: 0 })
  for (const p of ctx.parts.values()) assert.ok(/^[^\x00-\x7f]/.test(p.name), `部件名是中文：${p.name}`)
  assert.ok(!ctx.comps.some((q) => q.name === 'wing_-Y_sada'), '不给 sadaMassKg 不记 SADA 质量')
  assert.throws(() => PB.buildWing(K.createCtx({ dens: PB.resolveDensity() }), { ...w, hingeBody: undefined }, opt), /未给 hingeBody/, '组件用法漏给铰点 → 明确报错')
  // sadaMassKg：实心圆柱质量元（+Y 翼，铰点平移）；sadaPart 显式给 {id:'bus'} = 整星口径
  const cm = K.createCtx({ dens: PB.resolveDensity(), D })
  const hb = [0.2, 1.1, -0.3], mS = 4.2
  PB.buildWing(cm, { ...w, side: '+Y', hingeBody: hb }, { ...opt, sadaMassKg: mS, sadaPart: { id: 'bus' } })
  assert.deepStrictEqual(cm.parts.get('bus').nodes, ['wing_+Y_sada'], '显式 sadaPart')
  const qS = cm.comps.find((q) => q.name === 'wing_+Y_sada')
  assert.equal(qS.kind, 'cylinder'); assert.equal(qS.massKg, mS)
  const rS = D.sadaDM / 2, lS = D.sadaLenM + 0.01, iT = mS * (3 * rS * rS + lS * lS) / 12
  nearV(qS.com, [hb[0], hb[1] + (D.sadaLenM - 0.01) / 2, hb[2]], 1e-15, 'SADA 质心（沿 +Y 伸出）')
  nearV(qS.I, [iT, 0, 0, 0, mS * rS * rS / 2, 0, 0, 0, iT], 1e-15, 'SADA 惯量（轴向 = 本体 Y）')
  for (const bad of [0, -1, NaN, '3']) {
    const cb = K.createCtx({ dens: PB.resolveDensity(), D })
    PB.buildWing(cb, w, { ...opt, sadaMassKg: bad })
    assert.ok(!cb.comps.some((q) => q.name === 'wing_-Y_sada'), `sadaMassKg=${bad} 不登记`)
  }
  // 整星口径不变：GEO 默认卫星两翼 SADA 并进平台体、不单独记质量
  const whole = PB.buildTemplateModel('default-sat')
  assert.ok(['wing_+Y_sada', 'wing_-Y_sada'].every((nm) => whole.parts.find((p) => p.id === 'bus').nodes.includes(nm)), '整星 SADA 在平台体部件里')
  assert.ok(!whole.parts.some((p) => /_sada$/.test(p.id)) && !whole.massProps.components.some((q) => /_sada$/.test(q.name)), '整星不单独成件 / 不单独记质量')
  // 反射面 + 馈源：paraLayout 直接喂，L 不带平台半边长 h → 馈源不画支架
  const a = [0, 0, 1], u = [1, 0, 0], f = 1.2, Dm = 1.6, dc = 1.1, F = [0, 0, 1.5]
  const L = { ...K.paraLayout(F, a, u, f, Dm, dc, 1), mesh: false }
  const c2 = K.createCtx({ dens: PB.resolveDensity(), D })
  const sp = PB.buildReflector(c2, {}, 0, L)
  assert.ok(sp.area > Math.PI * (Dm / 2) ** 2, '抛物面面积 > 口径面积')
  PB.buildFeed(c2, { feedType: 'horn' }, 0, L, null)
  assert.deepStrictEqual(c2.items.map((x) => x.name), ['reflector_1', 'reflector_1_back', 'reflector_1_rim', 'feed_1'], '无平台 → 无馈源支架')
  const ap = c2.aps.find((x) => x.name === 'reflector_1_focus'); nearV(ap.posBody, F, 0, '焦点挂点'); nearV(ap.dirBody, a, 0, '视轴')
  assert.equal(c2.parts.get('reflector_1').fitted.focalM, f)
  nearV(c2.parts.get('feed_1').normalBody, K.nrm(K.sub(L.Pc, F)), 0, '喇叭朝口径中心')
  const c3 = K.createCtx({ dens: PB.resolveDensity(), D })
  PB.buildFeed(c3, { feedType: 'array' }, 0, { ...L, h: [1, 1, 1] }, null)
  assert.deepStrictEqual(c3.items.map((x) => x.name), ['feed_1', 'feed_1_support'], '给了平台半边长照旧画支架')
  // 密度覆盖
  assert.equal(PB.resolveDensity({ panelAreal: 9 }).panelAreal, 9); assert.equal(PB.resolveDensity({ panelAreal: NaN }).panelAreal, PB.DENSITY.panelAreal.value)
})

t('colMajor：列主序 4×4、抹 −0', () => {
  const m = K.colMajor([[0, 1, 0], [-1, 0, 0], [0, 0, 1]], [1, -0, 3])
  assert.deepStrictEqual(m, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 3, 1])
  assert.ok(!m.some((x) => Object.is(x, -0)))
})

console.log(`modelMeshKit: ${n} 项通过`)
