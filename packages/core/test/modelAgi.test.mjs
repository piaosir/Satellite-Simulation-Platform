// AGI 互操作自测（packages/core/models/agi.mjs）。运行：node packages/core/test/modelAgi.test.mjs
//
// 为什么测：挂点 / 关节 / 太阳翼组 / 不遮挡节点是和 STK 交换的全部语义，按节点名引用，错一个名字 STK 就静默忽略。
// 夹具绝不含任何 STK 文件（AGI 版权，契约 T15）：这里用 buildGlb 现场合成一个带 AGI 扩展的最小 glb，
// 结构照本机 STK 12 自带 tdrs.glb 实测的写法（根 articulations / solarPanelGroups，节点 isAttachPoint /
// articulationName / solarPanelGroupName / noObscuration），外加 STK 自带件里见过的无名节点挂关节。
// 钉死：① 读取（多节点联动、无名节点兜底、未定义引用告警）；② 写回（按名定位、幂等、冲突与坏名报错、extensionsUsed）；
// ③ gmdf 生成 / 读取（按 github.com/AnalyticalGraphicsInc/gmdf 的 schema 与 README 示例）；④ 合并口径（STK：有 gmdf 就只用 gmdf）；
// ⑤ 挂点位姿（视轴 = 节点 +Y、上向 = 节点 +X 的 STK 换轴口径，写出 / 读回互逆）；⑥ 经 glb patch 回填后 BIN 不变（契约 T5 的用法）。
import assert from 'node:assert/strict'
import * as A from '../models/agi.mjs'
import * as G from '../models/glb.mjs'
import * as B from '../models/bodyFrame.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const near = (a, b, tol, msg) => { a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `${msg}：${a} vs ${b}`)); pass++ }
const has = (list, frag) => list.some((s) => s.includes(frag))

// ── 合成模型 ──
const stage = (name, type, lo, hi, init = 0) => ({ name, type, minimumValue: lo, maximumValue: hi, initialValue: init })
function synthJson() {
  return {
    asset: { version: '2.0', generator: 'satsim test' },
    extensionsUsed: ['KHR_materials_emissive_strength', 'AGI_articulations', 'AGI_stk_metadata'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Bus', children: [1, 2, 3, 4, 5, 6, 7, 8] },
      { name: 'Wing +Y', translation: [0, 0, 2], children: [] },                                                                   // 1 名字带空格（节点名允许）
      { name: 'WingPY_Cells', mesh: 0, extensions: { AGI_articulations: { articulationName: 'SolarArrays' }, AGI_stk_metadata: { solarPanelGroupName: 'Main' } } },
      { name: 'WingNY_Cells', mesh: 0, extensions: { AGI_articulations: { articulationName: 'SolarArrays' }, AGI_stk_metadata: { solarPanelGroupName: 'Main' } } },
      { name: 'Dish', mesh: 0, extensions: { AGI_articulations: { articulationName: 'Dish' } } },
      { name: 'Feed_AP', translation: [0, 1, 2], extensions: { AGI_articulations: { isAttachPoint: true, extras: { keep: 1 } } } },  // 5 扩展对象里有我们不管的键
      { name: 'Boom', mesh: 0, extensions: { AGI_stk_metadata: { noObscuration: true } } },
      { mesh: 0, extensions: { AGI_articulations: { articulationName: 'Hinge' } } },                                               // 7 无名节点挂关节（STK 自带件里有）
      { name: 'Ghost', extensions: { AGI_articulations: { articulationName: 'Nope' } } }                                          // 8 引用未定义关节
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0], bufferView: 0 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
    extensions: {
      AGI_articulations: {
        articulations: [
          { name: 'SolarArrays', stages: [stage('Rotate', 'yRotate', -180, 180)], pointingVector: [0, 0, 1] },
          { name: 'Dish', stages: [stage('Az', 'yRotate', -30, 30), stage('El', 'xRotate', -10, 10, 5)] },
          { name: 'Hinge', stages: [stage('Open', 'xRotate', -135, 45)] },
          { name: 'Unused', stages: [stage('Size', 'uniformScale', 0, 1, 1)] }
        ]
      },
      AGI_stk_metadata: { solarPanelGroups: [{ name: 'Main', efficiency: 28 }] }
    }
  }
}
const BIN = new Uint8Array(36).map((_, i) => i * 7)
const glb = G.buildGlb(synthJson(), BIN)
const parsed = G.parseGlb(glb)
ok(parsed.ok, '合成 glb 可解析')

// ① 读取
const r = A.readAgiFromGltfJson(parsed.json)
eq(A.agiCounts(r), { attachPoints: 1, articulations: 4, solarPanelGroups: 1, noObscurationNodes: 1 }, '四类数量')
eq(r.attachPoints, [{ name: 'Feed_AP', node: 'Feed_AP', nodeIndex: 5 }], '挂点 = 节点原名')
eq(r.articulations[0], { name: 'SolarArrays', nodes: ['WingPY_Cells', 'WingNY_Cells'], stages: [stage('Rotate', 'yRotate', -180, 180)], pointingVector: [0, 0, 1] }, '多节点引用同一关节全部收进 nodes（联动）')
eq(r.articulations[1].stages.map((s) => s.name), ['Az', 'El'], 'stage 顺序保留（STK 按出现顺序施加）')
eq(r.articulations[2].nodes, ['node_7'], '无名节点按 node_<下标> 记')
eq(r.solarPanelGroups, [{ name: 'Main', efficiency: 28, nodes: ['WingPY_Cells', 'WingNY_Cells'] }], '太阳翼组')
eq(r.noObscurationNodes, ['Boom'], '不遮挡节点')
eq(r.nodeCount, 9, '节点数')
ok(has(r.warnings, 'Nope') && has(r.warnings, '#7 无名') && has(r.warnings, 'Unused'), '未定义引用 / 无名节点 / 无节点关节 都进警告')
eq(r.errors, [], '合法文件无错误')

// 坏结构不抛
const weird = synthJson()
weird.extensions.AGI_articulations.articulations.push({ name: 'Bad Name', stages: [stage('s', 'yRotate', 0, 1)] }, { name: 'NoStages', stages: [] }, 'str', { name: 'Dish', stages: [stage('x', 'xRotate', 0, 1)] })
weird.extensions.AGI_articulations.articulations[0].stages.push({ name: 'half', type: 'xRotate' }, { name: 'odd', type: 'wobble', minimumValue: 0, maximumValue: 1, initialValue: 0 })
weird.extensions.AGI_articulations.articulations[0].pointingVector = [0, 0, 0]
weird.extensions.AGI_stk_metadata.solarPanelGroups.push({ name: 'NoEff' }, { name: 'Over', efficiency: 150 })
weird.nodes[4].extensions.AGI_articulations = 'oops'
const rw = A.readAgiFromGltfJson(weird)
ok(has(rw.warnings, '含空白') && has(rw.errors, 'NoStages') && has(rw.errors, '不是对象') && has(rw.warnings, 'Dish」重复'), '坏关节：空白名告警、无 stage 丢弃、非对象丢弃、重名只取第一条')
ok(has(rw.warnings, 'half') && has(rw.warnings, 'wobble') && has(rw.warnings, 'pointingVector'), '坏 stage / 未知类型 / 零 pointingVector 进警告')
eq(rw.articulations[0].stages.map((s) => s.name), ['Rotate', 'odd'], '缺字段的 stage 丢弃，未知类型原样保留')
ok(has(rw.errors, 'NoEff') && has(rw.warnings, '150'), '太阳翼组缺效率丢弃、超 0–100 告警')
eq(A.readAgiFromGltfJson(null).errors.length, 1, '非对象 JSON → 错误')
eq(A.readAgiFromGltfJson({ extensions: { AGI_articulations: [] } }).errors.length, 1, '根扩展不是对象 → 错误')
eq(A.agiCounts(A.readAgiFromGltfJson({ asset: { version: '2.0' } })), { attachPoints: 0, articulations: 0, solarPanelGroups: 0, noObscurationNodes: 0 }, '无 AGI 的普通 glTF → 全零')
const dupNames = { nodes: [{ name: 'X', extensions: { AGI_articulations: { isAttachPoint: true } } }, { name: 'X' }] }
ok(has(A.readAgiFromGltfJson(dupNames).warnings, '不唯一'), '被引用的节点名不唯一 → 警告')

// ② 写回
const stripped = synthJson()
for (const n of stripped.nodes) delete n.extensions
delete stripped.extensions
stripped.extensionsUsed = ['KHR_materials_emissive_strength']
const ap = A.applyAgiToGltfJson(stripped, r)
eq(ap.errors, [], '写回无错误（无名节点按 node_7 认回下标）')
const r2 = A.readAgiFromGltfJson(ap.json)
eq([r2.attachPoints, r2.articulations, r2.solarPanelGroups, r2.noObscurationNodes], [r.attachPoints, r.articulations, r.solarPanelGroups, r.noObscurationNodes], '读 → 写 → 读 四类逐项相等')
eq(ap.json.extensionsUsed, ['KHR_materials_emissive_strength', 'AGI_articulations', 'AGI_stk_metadata'], 'extensionsUsed 追加两项、原有项保持')
ok(!('extensionsRequired' in ap.json), '不进 extensionsRequired（规范建议可选）')
ok(!('extensions' in stripped), '输入 JSON 不被改动')
eq(A.applyAgiToGltfJson(ap.json, r).json, ap.json, '幂等：对结果再写一次不变')
const again = A.applyAgiToGltfJson(synthJson(), r)
eq(again.json.nodes[5].extensions.AGI_articulations, { extras: { keep: 1 }, isAttachPoint: true }, '节点扩展里我们不管的键保留')
eq(again.json.extensionsUsed, ['KHR_materials_emissive_strength', 'AGI_articulations', 'AGI_stk_metadata'], '已在表里的扩展名保持原位')
// 清空
const cleared = A.applyAgiToGltfJson(synthJson(), A.emptyAgi())
ok(cleared.json.nodes.every((n, i) => i === 5 ? n.extensions.AGI_articulations.extras : !n.extensions), '写空：所有 AGI 节点键删掉（只剩别人的 extras）')
eq(cleared.json.extensionsUsed, ['KHR_materials_emissive_strength', 'AGI_articulations'], '写空：仍有扩展对象的保留声明，没了的删声明')
ok(!cleared.json.extensions, '写空：根扩展整段删掉')
// 报错与冲突
const e1 = A.applyAgiToGltfJson(stripped, {
  attachPoints: [{ name: 'Missing' }],
  articulations: [
    { name: 'Has Space', nodes: ['Dish'], stages: [stage('a', 'xRotate', 0, 1)] },
    { name: 'A1', nodes: ['Dish', 'Nowhere'], stages: [stage('a', 'xRotate', 0, 1), stage('a', 'yRotate', 0, 1), stage('b c', 'yRotate', 0, 1), stage('t', 'twist', 0, 1)] },
    { name: 'A2', nodes: ['Dish'], stages: [stage('z', 'zRotate', 0, 1)] },
    { name: 'A1', nodes: ['Boom'], stages: [stage('a', 'xRotate', 0, 1)] }
  ],
  solarPanelGroups: [{ name: 'G1', efficiency: 30, nodes: ['Boom'] }, { name: 'G2', efficiency: 30, nodes: ['Boom'] }, { name: 'G3', efficiency: -1, nodes: ['Dish'] }],
  noObscurationNodes: ['Bus']
})
ok(has(e1.errors, 'Missing') && has(e1.errors, 'Nowhere'), '找不到的节点记错误')
ok(has(e1.errors, 'Has Space') && has(e1.errors, 'stage 名「a」重复') && has(e1.errors, 'b c') && has(e1.errors, 'twist'), '坏名 / 重名 stage / 未知类型记错误并跳过')
ok(has(e1.errors, '已挂关节「A1」') && has(e1.errors, '已在太阳翼组「G1」') && has(e1.errors, 'A1」重复') && has(e1.errors, 'G3'), '一节点一关节、一节点一组；重名关节；效率越界')
const e1r = A.readAgiFromGltfJson(e1.json)
eq(e1r.articulations.map((a) => [a.name, a.nodes, a.stages.map((s) => s.name)]), [['A1', ['Dish'], ['a']], ['A2', [], ['z']]], '合法部分照写（A2 节点被 A1 先占）')
eq(e1r.noObscurationNodes, ['Bus'], '不遮挡节点照写')
eq(A.applyAgiToGltfJson('x', r).json, null, '坏 JSON → null + 错误')
const dupTarget = { nodes: [{ name: 'T' }, { name: 'T' }] }
const dt = A.applyAgiToGltfJson(dupTarget, { attachPoints: [{ name: 'T' }] })
ok(dt.json.nodes.every((n) => n.extensions.AGI_articulations.isAttachPoint) && has(dt.warnings, '2 个'), '同名节点全部命中（gmdf 语义）并告警')

// ③ gmdf
const gb = A.buildGmdf(r)
eq(gb.gmdf, {
  AGI_articulations: {
    attachPoints: ['Feed_AP'],
    articulations: [
      { name: 'SolarArrays', modelNodes: ['WingPY_Cells', 'WingNY_Cells'], stages: [stage('Rotate', 'yRotate', -180, 180)], pointingVector: [0, 0, 1] },
      { name: 'Dish', modelNodes: ['Dish'], stages: [stage('Az', 'yRotate', -30, 30), stage('El', 'xRotate', -10, 10, 5)] },
      { name: 'Hinge', modelNodes: ['node_7'], stages: [stage('Open', 'xRotate', -135, 45)] }
    ]
  },
  AGI_stk_metadata: { solarPanelGroups: [{ name: 'Main', efficiency: 28, modelNodes: ['WingPY_Cells', 'WingNY_Cells'] }], noObscurationNodes: ['Boom'] }
}, 'gmdf 结构（按节点名；无节点的关节因 modelNodes minItems 1 跳过）')
ok(has(gb.errors, 'Unused'), '跳过的关节记错误')
eq(Object.keys(gb.gmdf.AGI_articulations.articulations[0]), ['name', 'modelNodes', 'stages', 'pointingVector'], '键序照 README 示例')
const rg = A.readGmdf('﻿' + JSON.stringify(gb.gmdf, null, 4))
eq([rg.attachPoints, rg.articulations, rg.solarPanelGroups, rg.noObscurationNodes],
  [[{ name: 'Feed_AP', node: 'Feed_AP' }], r.articulations.filter((a) => a.nodes.length), r.solarPanelGroups, r.noObscurationNodes], 'gmdf 写 → 读（带 BOM 文本）逐项相等')
eq(A.buildGmdf(A.emptyAgi()).gmdf, null, '什么都没有 → 不写旁车')
eq(A.buildGmdf({ solarPanelGroups: [{ name: 'S', efficiency: 20, nodes: [] }] }).gmdf, null, '组没有节点 → 跳过 → 空')
// gmdf README 原文示例
const readme = { AGI_articulations: { attachPoints: ['Antenna-Node'], articulations: [{ name: 'Vehicle', modelNodes: ['Vehicle-Node'], stages: [stage('MoveX', 'xTranslate', -1000.0, 1000.0), stage('Size', 'uniformScale', 0, 1, 1)] }] }, AGI_stk_metadata: { solarPanelGroups: [{ name: 'Panel1', efficiency: 14.0, modelNodes: ['SolarPanels-Node'] }] } }
const rr = A.readGmdf(readme)
eq([rr.attachPoints[0].node, rr.articulations[0].nodes, rr.articulations[0].stages.length, rr.solarPanelGroups[0].nodes, rr.errors], ['Antenna-Node', ['Vehicle-Node'], 2, ['SolarPanels-Node'], []], 'gmdf README 示例')
eq(A.readGmdf({ AGI_stk_metadata: { noObscurationNodes: ['Diagonal'] } }).noObscurationNodes, ['Diagonal'], 'gmdf 官方 ObscurationTest 样例')
ok(has(A.readGmdf('{bad').errors, '不是合法 JSON'), '坏 JSON → 错误')
ok(has(A.readGmdf(7).errors, '不是对象'), '非对象 → 错误')
ok(has(A.readGmdf({ AGI_articulations: { attachPoints: 'x', articulations: 3 } }).errors, '不是数组'), '坏结构 → 错误')
ok(has(A.readGmdf({ AGI_articulations: { attachPoints: ['a', 5, 'a'] } }).warnings, '[1]'), 'gmdf 名单里的非字符串跳过并告警、重复去掉')

// ④ 合并
const gm = A.readGmdf({ AGI_stk_metadata: { noObscurationNodes: ['Dish'] }, AGI_articulations: { articulations: [{ name: 'Dish', modelNodes: ['Dish'], stages: [stage('Only', 'zRotate', -5, 5)] }] } })
const ms = A.mergeAgi(r, gm)
eq([ms.source, A.agiCounts(ms)], ['gmdf', { attachPoints: 0, articulations: 1, solarPanelGroups: 0, noObscurationNodes: 1 }], 'STK 口径：有 gmdf 就整份用 gmdf，内嵌全部忽略')
ok(has(ms.warnings, '按 STK 规则忽略'), '忽略内嵌时给出警告')
const mu = A.mergeAgi(r, gm, { mode: 'union' })
eq([mu.source, mu.articulations.map((a) => a.name), mu.articulations[1].stages[0].name, mu.noObscurationNodes], ['union', ['SolarArrays', 'Dish', 'Hinge', 'Unused'], 'Only', ['Boom', 'Dish']], 'union：按名合并、gmdf 同名优先、不遮挡取并集')
eq(A.mergeAgi(r, null).source, 'embedded', '无 gmdf → 用内嵌')
eq(A.mergeAgi(null, null).source, 'none', '都没有 → none')
const mc = A.mergeAgi(r, null)
mc.articulations[0].nodes.push('X')
ok(!r.articulations[0].nodes.includes('X'), '合并结果是深拷贝，不连带改输入')

// ⑤ 挂点位姿。轴向口径（按本机 STK 12 核定，见 agi.mjs「挂点节点的轴向口径」）：视轴 = 节点局部 +Y，上向 = 节点局部 +X。
// 用 STK 映射（glTF +Y ↦ 本体 +Z 天底）写死期望值，出厂映射另用 modelToBody 对拍——出厂值换不换都不影响这组断言。
const QSTK = B.Q_MODEL2BODY_STK
const poses = A.attachPointPoses(parsed.json, r.attachPoints, { q_model2body: QSTK, scaleToMeters: 2 })
near(poses[0].posBody, [4, 0, 2], 1e-12, '位置：Feed_AP 平移 (0,1,2) × 2 → STK 映射下本体 (4, 0, 2)')
near(poses[0].dirBody, [0, 0, 1], 1e-12, '视轴：节点 +Y → 本体 +Z（天底）')
near(poses[0].upBody, [0, 1, 0], 1e-12, '上向：节点 +X → 本体 +Y')
const pd = A.attachPointPoses(parsed.json, r.attachPoints, { scaleToMeters: 2 })[0]
near(pd.dirBody, B.quatRotate(B.DEFAULT_Q_MODEL2BODY, [0, 1, 0]), 1e-12, '缺省 frame：按出厂映射换节点 +Y')
near(pd.upBody, B.quatRotate(B.DEFAULT_Q_MODEL2BODY, [1, 0, 0]), 1e-12, '缺省 frame：按出厂映射换节点 +X')
const p2 = A.attachPointPoses(parsed.json, [{ name: 'node_7' }, { name: 'Nobody' }], { q_model2body: [0, 0, 0, 1], t_model2body: [1, 1, 1] })
ok(p2[0].posBody && p2[0].posBody.every((v) => v === 1) && !p2[1].posBody, '无名节点按下标兜底；找不到的原样返回不带位姿')
eq(A.attachPointPoses(null, 'x'), [], '坏输入 → 空数组')
// STK tdrs.glb 的实测结构（数值自己合成，不含 STK 文件）：两副对称安装的 SA 天线挂点绕口面法向差 180°，
// 局部 +Y 都是 glTF +Y（口面朝向），局部 +Z 一个 +X 一个 −X。视轴取 +Y 时两者同朝天底；若取 +Z 会指向相反的横向。
const col = (x, y, z, p = [0, 0, 0]) => [...x, 0, ...y, 0, ...z, 0, ...p, 1]
const tdrsLike = {
  nodes: [
    { name: 'SA_E_Attachpoint', matrix: col([0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 2.493, 5.18]), extensions: { AGI_articulations: { isAttachPoint: true } } },
    { name: 'SA_W_Attachpoint', matrix: col([0, 0, 1], [0, 1, 0], [-1, 0, 0], [0, 2.493, -3.275]), extensions: { AGI_articulations: { isAttachPoint: true } } }
  ]
}
const [pe, pw] = A.attachPointPoses(tdrsLike, A.readAgiFromGltfJson(tdrsLike).attachPoints, { q_model2body: QSTK })
eq([pe.dirBody, pw.dirBody], [[0, 0, 1], [0, 0, 1]], '对称安装的 SA_E / SA_W：视轴都朝天底')
eq([pe.upBody, pw.upBody], [[-1, 0, 0], [1, 0, 0]], '上向随安装滚转相反（这正是两者的差别）')
// 写出 ↔ 读回：attachNodeMatrix 是 attachPointPoses 的逆（节点挂在「本体 → 模型」根节点下，与参数化模型同构）
const transpose16 = (Rm) => [Rm[0][0], Rm[0][1], Rm[0][2], 0, Rm[1][0], Rm[1][1], Rm[1][2], 0, Rm[2][0], Rm[2][1], Rm[2][2], 0, 0, 0, 0, 1]
let seed = 7
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1 }
let worst = 0
for (let k = 0; k < 200; k++) {
  const qv = B.quatNormalize([rnd(), rnd(), rnd(), rnd()])
  const pos = [rnd() * 5, rnd() * 5, rnd() * 5], dir = [rnd(), rnd(), rnd()], up = [rnd(), rnd(), rnd()]
  const j = { nodes: [{ name: 'root', matrix: transpose16(B.quatToMat(qv)), children: [1] }, { name: 'ap', matrix: A.attachNodeMatrix(pos, dir, up) }] }
  const got = A.attachPointPoses(j, [{ name: 'ap' }], { q_model2body: qv })[0]
  const d = B.quatRotate([0, 0, 0, 1], dir).map((x) => x / Math.hypot(...dir))
  const k2 = up[0] * d[0] + up[1] * d[1] + up[2] * d[2]
  const u0 = [up[0] - k2 * d[0], up[1] - k2 * d[1], up[2] - k2 * d[2]], ul = Math.hypot(...u0)
  const u = u0.map((x) => x / ul)
  for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(got.posBody[i] - pos[i]), Math.abs(got.dirBody[i] - d[i]), Math.abs(got.upBody[i] - u[i]))
}
ok(worst < 1e-12, `attachNodeMatrix → attachPointPoses 往返 200 组随机位姿（最大误差 ${worst.toExponential(1)}）`)
const mNode = A.attachNodeMatrix([1, 2, 3], [0, 0, 5], [0, 0, 1])
eq([mNode.slice(0, 3), mNode.slice(4, 7), mNode.slice(8, 11), mNode.slice(12, 16)], [[0, -1, 0], [0, 0, 1], [-1, 0, 0], [1, 2, 3, 1]], '写出：上向与视轴平行 → 按 D1 补 −Y；局部 +Y = 视轴、+Z = up × dir')
eq([A.attachNodeMatrix([0, 0], [0, 0, 1]), A.attachNodeMatrix([0, 0, 0], [0, 0, 0]), A.attachNodeMatrix([0, 0, 0], 'z')], [null, null, null], '写出：坏位置 / 零视轴 → null')
// 非均匀缩放（父缩放 × 子旋转）会让两根局部轴不正交：上向仍去掉视轴分量后归一
const skew = { nodes: [{ name: 'P', scale: [1, 5, 1], children: [1] }, { name: 'S', rotation: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)] }] }
const ps = A.attachPointPoses(skew, [{ name: 'S' }], { q_model2body: [0, 0, 0, 1] })[0]
ok(Math.abs(Math.hypot(...ps.dirBody) - 1) < 1e-12 && Math.abs(Math.hypot(...ps.upBody) - 1) < 1e-12 && Math.abs(ps.dirBody[0] * ps.upBody[0] + ps.dirBody[1] * ps.upBody[1] + ps.dirBody[2] * ps.upBody[2]) < 1e-12, '剪切的节点：视轴 / 上向单位长且正交')
const flat = A.attachPointPoses({ nodes: [{ name: 'Z', scale: [0, 1, 1] }, { name: 'Y0', scale: [1, 0, 1] }] }, [{ name: 'Z' }, { name: 'Y0' }], { q_model2body: QSTK })
eq([flat[0].dirBody, flat[0].upBody], [[0, 0, 1], [0, -1, 0]], '局部 +X 缩成 0：上向按 D1 在本体系补')
ok(flat[1].posBody && !flat[1].dirBody && !flat[1].upBody, '局部 +Y 缩成 0：只给位置，不编视轴')

// ⑥ 契约 T5 的用法：从 glb 摘出 AGI → 经过会丢扩展的处理 → patch 回填，BIN 不变
const lost = G.patchGlbJson(glb, (j) => { for (const n of j.nodes) delete n.extensions; delete j.extensions; j.extensionsUsed = [] })
const back = G.patchGlbJson(lost.glb, (j) => A.applyAgiToGltfJson(j, r).json)
const pb = G.parseGlb(back.glb)
ok(back.ok && Buffer.compare(Buffer.from(pb.bin), Buffer.from(BIN)) === 0, 'patch 回填后 BIN 逐字节不变')
eq(A.agiCounts(A.readAgiFromGltfJson(pb.json)), A.agiCounts(r), '回填后 AGI 四类数量复原')
ok(A.agiNameOk('Solar_1') && !A.agiNameOk('Solar 1') && !A.agiNameOk('') && !A.agiNameOk(3), 'AGI 名字规则（非空、无空白）')
eq(A.STAGE_TYPES.length, 10, 'stage 类型 10 种（规范原文）')

console.log(`modelAgi: ${pass} 项通过`)
