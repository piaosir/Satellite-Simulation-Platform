// ModelMeta 与绑定表的校验 / 归一自测（packages/core/models/schema.mjs）。运行：node packages/core/test/modelSchema.test.mjs
//
// 为什么测：ModelMeta 在离线管线、主进程、工作台、导出四处读写，是「四道闸」（云端 / 分享包 / 报告附件 / 导出 glb）
// 判断能否离开本机的唯一依据。钉死：① 任务书 §4.1 的每一条校验（sha256、bytes、三档 lod、bbox、单位四元数、
// 节点名唯一非空）；② STK 授权一致性两个方向都查、normalize 朝「不可分发」纠正；③ normalize 永远给出能过校验的
// 完整结构、白名单丢未知键；④ id 规则（契约 §3.5）；⑤ 绑定键（T10 + 二期 D8 的 grdsat / lbsat:<ns>:<id>）与绑定表清洗；
// ⑥ 坏输入不抛（含越界时间戳、BigInt、循环引用）；⑦ 挂点上向量的二期 D1 缺省与退化判据。
import assert from 'node:assert/strict'
import * as S from '../models/schema.mjs'
import * as BF from '../models/bodyFrame.mjs'
import * as ATT from '../models/attitude.mjs'
import * as PT from '../models/paramTemplates.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const has = (list, frag) => list.some((s) => s.includes(frag))
const SHA = (c) => c.repeat(64)
const clone = (x) => JSON.parse(JSON.stringify(x))
const near3 = (a, b, tol, msg) => { assert.ok(a.every((v, k) => Math.abs(v - b[k]) <= tol), `${msg}：${a} vs ${b}`); pass++ }

// 一条完整合法的 NASA 条目
const nasa = () => S.defaultMeta({
  id: 'nasa:tracking-and-data-relay-satellites-tdrs-a',
  title: 'Tracking and Data Relay Satellites (TDRS) (A)',
  titleZh: '跟踪与数据中继卫星 (A)',
  group: 'spacecraft',
  source: { kind: 'nasa', url: 'https://science.nasa.gov/3d-resources/tracking-and-data-relay-satellites-tdrs-a/' },
  files: { lod0: { sha256: SHA('a'), bytes: 96792, tris: 2964 }, lod1: { sha256: SHA('b'), bytes: 40000, tris: 900 }, lod2: { sha256: SHA('c'), bytes: 20000, tris: 300 }, thumb: { sha256: SHA('d'), bytes: 9000 } },
  units: { scaleToMeters: 19.51, unitGuess: 'unknown', sizeVerified: true, sizeSource: 'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1983-026B' },
  geometry: { bboxM: { min: [-8.6, -4.4, -4.6], max: [8.6, 4.4, 4.6] }, boundingRadiusM: 10.8, tris: 2964, areaM2: 310, volumeM3: null, closed: false, centroidM: [0, 0, 0] },
  parts: [{ id: 'p1', name: 'dish', role: 'reflector', nodes: ['Dish1_2:pCylinder1'], areaM2: 18.9, fitted: { kind: 'paraboloid', focalM: 1.8, diameterM: 4.9, vertexBody: [0, 0, 1], axisBody: [0, 0, 1] }, segScore: 0.93 }],
  massProps: { massKg: 2268, comBody: [0, 0, 0.1], inertiaBody: [[3000, 1, 0], [1, 2800, 0], [0, 0, 1500]], source: 'manual', confidence: 'high' },
  attachPoints: [{ name: 'SA_1', node: 'Dish1_2:pCylinder1', posBody: [1, 2, 3], dirBody: [0, 0, 1], upBody: [1, 0, 0] }],
  articulations: [{ name: 'SA_Antenna', nodes: ['Dish1_2:pCylinder1'], stages: [{ name: 'Yaw', type: 'zRotate', minimumValue: -35, maximumValue: 90, initialValue: 0 }], pointingVector: [0, 1, 0] }],
  solarPanelGroups: [{ name: 'SolarGroup', nodes: ['polySurface5'], efficiency: 14 }],
  noObscurationNodes: ['transform8'],
  tags: ['TDRS', 'relay', 'TDRS'],
  aliases: ['TDRS-1'],
  updatedAt: '2026-09-23T10:00:00.000Z',
  bogus: 'dropped'
})
const NODE_NAMES = ['RootNode', 'Dish1_2:pCylinder1', 'transform8', 'polySurface5']

// ① 合法条目
const m = nasa()
const v = S.validateMeta(m, { nodeNames: NODE_NAMES })
ok(v.ok, '完整 NASA 条目通过：' + v.errors.join('；'))
ok(!('bogus' in m), '未知顶层键丢弃（白名单）')
eq(m.tags, ['TDRS', 'relay'], 'tags 去重')
eq(m.parts[0].segScore, 0.93, '部件是本机派生数据：未知键保留（W2 扩字段不被吞）')
// 出厂四元数的数值只在 modelBodyFrame 里钉一处（2026-09-24 起 = STK 映射）；这里只认常量，映射再换也不用改
ok(S.DEFAULT_Q_MODEL2BODY === BF.DEFAULT_Q_MODEL2BODY, 'schema 转出的出厂 q 就是 bodyFrame 常量')
// 夹具带关节 / 电池片组 / 挂点（= 带 AGI 扩展）→ 缺省 q 按 defaultImportQ 取 STK 映射（轴映射终案 ②）；不带的 NASA 件见 ③ 的「缺省按来源」
eq(m.frame, { q_model2body: [...BF.Q_STK], t_model2body: [0, 0, 0], verified: false }, '缺 frame 且带 AGI 字段 → STK 映射、零平移、未核定')
eq(m.source.redistributable, true, 'NASA 缺省可分发')
ok(S.isRedistributable(m), 'isRedistributable(NASA) = true')

// 每条校验项单独打一遍
const bad = (mut, frag, msg, opts) => {
  const x = clone(m); mut(x)
  const r = S.validateMeta(x, opts)
  assert.ok(!r.ok && has(r.errors, frag), `${msg}：${JSON.stringify(r.errors)}`); pass++
}
bad((x) => { x.schema = 1 }, 'schema', 'schema ≠ 2')
bad((x) => { x.id = 'nasa:TDRS' }, 'id', 'id 大写')
bad((x) => { x.id = 'foo:bar' }, 'id', 'id 未知前缀')
bad((x) => { x.files.lod1.sha256 = SHA('A') }, 'lod1.sha256', 'sha256 大写')
bad((x) => { x.files.lod1.sha256 = 'abc' }, 'lod1.sha256', 'sha256 长度不对')
bad((x) => { x.files.lod2.bytes = 0 }, 'lod2.bytes', 'bytes = 0')
bad((x) => { x.files.lod0.bytes = 1.5 }, 'lod0.bytes', 'bytes 非整数')
bad((x) => { delete x.files.lod1 }, '三档 lod', 'NASA 缺 lod1')
bad((x) => { x.geometry.bboxM.min[1] = 9 }, 'min[1] > max[1]', 'bbox min > max')
bad((x) => { x.geometry.bboxM = { min: [0, 0] } }, 'bboxM', 'bbox 结构坏')
bad((x) => { x.frame.q_model2body = [0, 0, 0, 2] }, 'q_model2body', '四元数非单位长')
bad((x) => { x.frame.q_model2body = [0, 0, 1] }, 'q_model2body', '四元数长度不对')
bad((x) => { x.units.sizeSource = '' }, 'sizeSource', 'sizeVerified 为 true 但无出处')
bad((x) => { x.units.scaleToMeters = 0 }, 'scaleToMeters', '缩放为 0')
bad((x) => { x.units.unitGuess = 'furlong' }, 'unitGuess', '单位非法')
bad((x) => { x.kind = 'body' }, 'kind', 'kind=body（契约不收）')
bad((x) => { x.fidelity = 'hifi' }, 'fidelity', 'fidelity 非法')
bad((x) => { x.title = '  ' }, 'title', '标题空')
bad((x) => { x.source.kind = 'user' }, '不符', 'id 前缀与来源不符')
bad((x) => { x.articulations[0].name = 'SA Antenna' }, '空白', '关节名含空白（STK 规则）')
bad((x) => { x.articulations[0].stages[0].type = 'wobble' }, 'type', 'stage 类型非法')
bad((x) => { x.articulations[0].stages[0].minimumValue = 100 }, 'minimumValue > maximumValue', 'stage 范围反了')
bad((x) => { x.articulations[0].stages = [] }, 'stages', '关节无 stage')
bad((x) => { x.articulations.push(clone(x.articulations[0])) }, '重复', '关节重名')
bad((x) => { x.solarPanelGroups[0].efficiency = 120 }, 'efficiency', '效率超 100')
bad((x) => { x.attachPoints[0].dirBody = [0, 0, 0] }, '零向量', '挂点方向零向量')
bad((x) => { x.attachPoints.push(clone(x.attachPoints[0])) }, '重复', '挂点重名')
bad((x) => { x.parts[0].role = 'antenna' }, 'role', '部件角色非法')
bad((x) => { x.parts[0].fitted.focalM = -1 }, 'fitted', '拟合焦距负')
bad((x) => { x.massProps.inertiaBody[0][1] = 5 }, '不对称', '惯量不对称')
bad((x) => { x.massProps.massKg = 0 }, 'massKg', '质量 0')
bad((x) => { x.massProps.source = 'guess' }, 'massProps.source', '质量来源非法')
bad((x) => { x.tags = 'x' }, 'tags', 'tags 不是数组')
bad((x) => { x.updatedAt = 'yesterday' }, 'updatedAt', '时间串不合法')
bad((x) => { x.noObscurationNodes = ['a', 'a'] }, '重复', '不遮挡节点重复')
bad((x) => {}, '重名', '节点名不唯一（互操作硬要求）', { nodeNames: ['RootNode', 'RootNode', 'Dish1_2:pCylinder1', 'transform8', 'polySurface5'] })
bad((x) => {}, '名字为空', '节点名为空', { nodeNames: [...NODE_NAMES, ''] })
bad((x) => { x.solarPanelGroups[0].nodes = ['Nope'] }, '「Nope」不存在', '引用不存在的节点', { nodeNames: NODE_NAMES })
bad((x) => { x.source.redistributable = 'yes' }, 'redistributable', '可分发标志不是布尔')
const warnInit = S.validateMeta({ ...clone(m), articulations: [{ ...m.articulations[0], stages: [{ ...m.articulations[0].stages[0], initialValue: 500 }] }] })
ok(warnInit.ok && has(warnInit.warnings, 'initialValue'), 'initialValue 越界只警告不拦')
const tri = S.validateMeta({ ...clone(m), massProps: { ...m.massProps, inertiaBody: [[1, 0, 0], [0, 1, 0], [0, 0, 5]] } })
ok(tri.ok && has(tri.warnings, '三角不等式'), '惯量不满足三角不等式只警告')
eq(S.validateMeta('x').ok, false, '非对象 → 不通过不抛')
eq(S.validateMeta(null).errors, ['ModelMeta 不是对象'], 'null → 一条错误')

// slim：manifest 条目可缺大字段
const slim = S.slimMeta(m)
ok(!('parts' in slim) && !('attachPoints' in slim) && !('massProps' in slim) && !('spec' in slim), 'slimMeta 去掉大字段')
eq(Object.keys(slim).sort(), ['aliases', 'files', 'fidelity', 'frame', 'geometry', 'group', 'id', 'kind', 'schema', 'source', 'tags', 'title', 'titleZh', 'updatedAt', 'units'].sort(), 'slim 字段集合（契约 §3.3）')
ok(S.validateMeta(slim, { slim: true }).ok, 'slim 条目按 slim 口径通过')
ok(!S.validateMeta(slim).ok, 'slim 条目按完整口径不通过（缺 parts 等）')
eq(S.slimMeta({ ...m, builtin: ['lod2', 'thumb', 'lod9'] }).builtin, ['lod2', 'thumb'], 'slim 保留内置档位表（滤掉非法档）')

// lod 口径
const user = S.defaultMeta({ id: S.userModelId(SHA('e')), title: 'my sat', files: { lod0: { sha256: SHA('e'), bytes: 10 } } })
ok(S.validateMeta(user).ok, '本机导入只要一档')
ok(!S.validateMeta({ ...user, files: {} }).ok, '本机导入一档都没有 → 不通过')
const param = S.defaultMeta({ id: 'param:default-sat', title: 'Default satellite', spec: { bus: { shape: 'box' } } })
ok(S.validateMeta(param).ok && param.fidelity === 'parametric' && param.source.kind === 'param', '参数化模板可无文件，fidelity 缺省 parametric')
ok(!S.validateMeta(param, { lods: 'any' }).ok, 'lods 口径可由调用方收紧')
eq(user.source.redistributable, false, '本机导入缺省不可分发（上云须用户明确勾）')

// ② STK 授权一致性
const stkId = S.stkModelId(SHA('f'))
const stk = S.defaultMeta({ id: stkId, title: 'tdrs', source: { kind: 'nasa', redistributable: true, license: 'MIT' }, files: { lod0: { sha256: SHA('f'), bytes: 100 } } })
eq([stk.source.kind, stk.source.redistributable, stk.source.license], ['stk-local', false, 'AGI SLA'], 'normalize：stk: 前缀一律按 STK、不可分发、AGI SLA')
ok(S.validateMeta(stk).ok && !S.isRedistributable(stk), 'STK 条目合法且不可分发')
ok(has(S.validateMeta({ ...clone(stk), source: { ...stk.source, redistributable: true } }).errors, 'STK 模型必须为 false'), '校验：STK 标可分发 → 错误')
ok(has(S.validateMeta({ ...clone(stk), id: S.userModelId(SHA('f')) }).errors, '不符'), '校验：stk-local 来源配 user: 前缀 → 错误')
ok(!S.isRedistributable({ id: stkId, source: { kind: 'user', redistributable: true } }), 'isRedistributable：stk: 前缀即拒（哪怕来源字段被改）')
ok(!S.isRedistributable({ id: 'nasa:x', source: { kind: 'stk-local', redistributable: true } }), 'isRedistributable：stk-local 来源即拒')
ok(!S.isRedistributable({ id: 'nasa:x', source: { kind: 'nasa', redistributable: 'true' } }), 'isRedistributable：只认布尔 true')
ok(!S.isRedistributable(null), 'isRedistributable(null) = false')
ok(has(S.validateMeta({ ...clone(stk), source: { ...stk.source, license: 'x' } }).warnings, 'AGI SLA'), 'STK 许可字段不是 AGI SLA → 警告')

// ③ normalize 纠正
const n1 = S.normalizeMeta({ id: 'nasa:x', title: 'x', frame: { q_model2body: [0, 0, 0, 1.0004], verified: true }, units: { scaleToMeters: -3, sizeVerified: true } })
eq([n1.frame.q_model2body, n1.frame.verified], [[0, 0, 0, 1], true], '近单位四元数重新归一，verified 保留')
const n2 = S.normalizeMeta({ id: 'nasa:x', title: 'x', frame: { q_model2body: [0, 0, 0, 5], verified: true } })
eq([n2.frame.q_model2body, n2.frame.verified], [[...BF.Q_YUP_ZENITH], false], '离单位长太远 → 回「按来源的缺省」（NASA 件 = +Y 天顶）、verified 清掉')
// 缺省 q 按来源（轴映射终案 ②，bodyFrame.defaultImportQ）：STK / 参数化 / 带 AGI → STK 映射；NASA、用户导入、社区件 → +Y 天顶
{
  const qOf = (x) => S.normalizeMeta(x).frame.q_model2body
  eq(qOf({ id: 'nasa:x' }), [...BF.Q_YUP_ZENITH], 'nasa: 前缀、无 frame → +Y 天顶')
  eq(qOf({ id: S.userModelId(SHA('1')) }), [...BF.Q_YUP_ZENITH], 'user: 前缀 → +Y 天顶')
  eq(qOf({ id: 'community:x' }), [...BF.Q_YUP_ZENITH], 'community: 前缀 → +Y 天顶')
  eq(qOf({ id: S.stkModelId(SHA('2')) }), [...BF.Q_STK], 'stk: 前缀 → STK 映射')
  eq(qOf({ id: S.stkModelId(SHA('2')), source: { kind: 'nasa' } }), [...BF.Q_STK], 'stk: 前缀即使标了别的来源也按 STK')
  eq(qOf({ id: 'param:default-sat' }), [...BF.Q_STK], 'param: 前缀 → STK 映射（参数化根矩阵 = STK 之逆）')
  eq(qOf({ id: 'nasa:x', source: { kind: 'builtin' } }), [...BF.Q_YUP_ZENITH], 'builtin 来源按 id 前缀还原：nasa: → +Y 天顶')
  eq(qOf({ id: 'param:default-sat', source: { kind: 'builtin' } }), [...BF.Q_STK], 'builtin 来源按 id 前缀还原：param: → STK 映射')
  eq(qOf({ id: S.userModelId(SHA('3')), articulations: [{ name: 'A', nodes: ['n'], stages: [{ name: 'Yaw', type: 'zRotate', minimumValue: 0, maximumValue: 1, initialValue: 0 }] }] }), [...BF.Q_STK], '用户件带关节（AGI 扩展）→ STK 映射')
  eq(qOf({ id: 'nasa:x', attachPoints: [] }), [...BF.Q_YUP_ZENITH], '空数组不算带 AGI')
  eq(qOf({ id: 'nasa:x', frame: { q_model2body: [...BF.Q_STK] } }), [...BF.Q_STK], '有合法 q 的不按来源改写（管线 / 工作台 / 导出件写出的 q 原样保留）')
  eq(S.normalizeMeta({ id: 'nasa:x', frame: { verified: true } }).frame.verified, false, '没给 q 的 verified 清掉（缺省 q 不能算核过）')
  ok(S.validateMeta(S.defaultMeta({ id: 'nasa:x', title: 'x', files: nasa().files })).ok, '按来源补的缺省 q 能过校验')
  // importDefaultQOf：同一口径单独拿出来（工作台「出厂映射」要回到的就是它），不看 meta.frame 里现有的 q
  const cases = [{ id: 'nasa:x' }, { id: S.userModelId(SHA('1')) }, { id: 'community:x' }, { id: S.stkModelId(SHA('2')) }, { id: S.stkModelId(SHA('2')), source: { kind: 'nasa' } },
    { id: 'param:default-sat' }, { id: 'nasa:x', source: { kind: 'builtin' } }, { id: 'param:default-sat', source: { kind: 'builtin' } }, { id: 'bad id' }, {},
    { id: S.userModelId(SHA('3')), solarPanelGroups: [{ name: 'S', nodes: ['n'], efficiency: 20 }] }, { id: 'nasa:x', attachPoints: [] }]
  for (const c of cases) eq(S.importDefaultQOf(c), qOf(c), `importDefaultQOf 与 normalizeMeta 兜底同一个数：${JSON.stringify(c).slice(0, 60)}`)
  eq(S.importDefaultQOf({ id: 'nasa:x', frame: { q_model2body: [...BF.Q_STK], verified: true } }), [...BF.Q_YUP_ZENITH], 'importDefaultQOf 不看现有 frame（核过的 NASA 件，出厂仍是 +Y 天顶）')
  eq(S.importDefaultQOf(S.normalizeMeta({ id: 'param:default-sat', frame: { q_model2body: [...BF.Q_YUP_ZENITH] } })), [...BF.Q_STK], 'importDefaultQOf 吃归一后的 meta：参数化件 → STK 映射')
  for (const bad of [null, undefined, 3, 'nasa:x', []]) eq(S.importDefaultQOf(bad), [...BF.Q_YUP_ZENITH], `importDefaultQOf(${JSON.stringify(bad)}) 不抛 → +Y 天顶`)
  const r1 = S.importDefaultQOf({ id: 'nasa:x' }); r1[0] = 9
  eq(S.importDefaultQOf({ id: 'nasa:x' }), [...BF.Q_YUP_ZENITH], 'importDefaultQOf 返回新数组')
}
eq([n1.units.scaleToMeters, n1.units.sizeVerified], [1, false], '缩放非法 → 1；无出处的 sizeVerified → false')
const n3 = S.normalizeMeta({ id: 'nasa:x', geometry: { bboxM: { min: [1, 0, 0], max: [0, 1, 1] } }, solarPanelGroups: [{ name: 'A', efficiency: 150, nodes: ['n', 'n', 5] }, { name: 'B C', efficiency: 1 }], massProps: { massKg: 10, comBody: [0, 0, 0], inertiaBody: [[1, 2, 0], [4, 1, 0], [0, 0, 1]], source: 'estimate', confidence: 'high' } })
eq(n3.geometry.bboxM, { min: [0, 0, 0], max: [1, 1, 1] }, 'bbox min/max 反了 → 交换')
eq(n3.solarPanelGroups, [{ name: 'A', nodes: ['n'], efficiency: 100 }], '效率钳到 100、节点去重去非字符串、带空白的组名丢弃')
eq(n3.massProps.inertiaBody[0][1], 3, '惯量对称化（取两侧平均）')
eq(S.normalizeMeta({ id: 'nasa:x', massProps: { massKg: 10, comBody: [0, 0, 0], inertiaBody: null, source: 'estimate', confidence: 'high' } }).massProps.confidence, 'low', '估算档没有惯量 → confidence 只能是 low（§4.3）')
eq(n3.title, 'nasa:x', '无标题 → 用 id')
const n4 = S.normalizeMeta({ id: 'nasa:x', title: 'x', articulations: [{ name: 'A', nodes: ['a'], stages: [{ name: 's', type: 'xRotate', minimumValue: 5, maximumValue: -5, initialValue: 0 }, { name: 's', type: 'yRotate', minimumValue: 0, maximumValue: 1, initialValue: 0 }, { name: 't', type: 'bad', minimumValue: 0, maximumValue: 1, initialValue: 0 }] }] })
eq(n4.articulations[0].stages, [{ name: 's', type: 'xRotate', minimumValue: -5, maximumValue: 5, initialValue: 0 }], 'stage 范围反了交换、重名与坏类型丢弃')
const nd = S.normalizeMeta(42)
ok(S.validateMeta({ ...nd, id: 'param:x', source: { ...nd.source, kind: 'param' } }).ok, 'normalize(非对象) 给出结构完整的默认条目')
eq(S.normalizeMeta({ id: 'nasa:x', updatedAt: 0 }).updatedAt, '1970-01-01T00:00:00.000Z', '数字时间戳 → ISO')
ok(S.validateMeta(S.normalizeMeta(m), { nodeNames: NODE_NAMES }).ok, 'normalize 幂等后仍合法')
eq(S.normalizeMeta(S.normalizeMeta(m)), S.normalizeMeta(m), 'normalize 幂等')
eq(S.normalizeMeta({ id: 'nasa:x', title: 'x'.repeat(500) }).title.length, 200, '标题截断到 200')
eq(S.normalizeMeta({ id: 'nasa:x', files: { lod0: { sha256: SHA('A'), bytes: 5 }, lod1: { sha256: 'bad', bytes: 5 }, lodX: {} } }).files, { lod0: { sha256: SHA('a'), bytes: 5 } }, 'sha 转小写、坏档丢弃、未知档丢弃')
eq(S.normalizeMeta({ id: 'nasa:x', kind: 'body' }).kind, 'other', '非法 kind → other')

// normalize 承诺不抛：时间戳越界、BigInt、循环引用（主进程逐个读 user/*.satsim.json，一份坏文件不能拖垮整个目录）
const nThrow = (x) => { try { return S.normalizeMeta(x) } catch (e) { return e } }
ok(!(nThrow({ id: 'nasa:x', updatedAt: 1e16 }) instanceof Error) && S.normalizeMeta({ id: 'nasa:x', updatedAt: 1e16 }).updatedAt === null, 'updatedAt = 1e16（越出 Date 范围）→ null 不抛')
eq(S.normalizeMeta({ id: 'nasa:x', updatedAt: 1726000000000000000 }).updatedAt, null, '纳秒时间戳 → null')
eq(S.normalizeMeta({ id: 'nasa:x', updatedAt: 8.64e15 }).updatedAt, '+275760-09-13T00:00:00.000Z', 'Date 范围上界仍给 ISO')
eq(S.normalizeMeta({ id: 'nasa:x', updatedAt: '2026-09-23' }).updatedAt, '2026-09-23', '合法时间串原样')
const circ = { a: 1 }; circ.self = circ
const nb = nThrow({ id: 'nasa:x', title: 'x', spec: circ, parts: [{ id: 'p1', role: 'reflector', nodes: ['n'], areaM2: 2, big: 10n }, { id: 'p2', role: 'bus', loop: circ }, { id: 'p3', role: 'bus', ok: 1 }] })
ok(!(nb instanceof Error), 'spec / parts 带 BigInt、循环引用 → 不抛')
ok(!('spec' in nb), '拷不了的 spec 丢弃')
eq(nb.parts, [{ id: 'p1', name: 'p1', role: 'reflector', nodes: ['n'], areaM2: 2 }, { id: 'p2', name: 'p2', role: 'bus' }, { id: 'p3', name: 'p3', role: 'bus', ok: 1 }], '拷不了的部件退回已知字段（主体信息不丢），正常部件未知键照留')
ok(S.validateMeta({ ...nb, id: 'param:x', source: { ...nb.source, kind: 'param' } }).ok, '纠正后的结果能过校验')
eq(S.normalizeMeta({ id: 'nasa:x', parts: [{ id: 'p', role: 'reflector', fitted: { kind: 'plane' } }] }).parts[0].fitted, undefined, '不合规的 fitted 删掉（与 validateMeta 同口径）')

// 挂点上向量（二期契约 D1：up ↔ 天线 +y；缺省 = 本体 −Y 在视轴法平面的投影，退化取 +X）
const apN = (aps) => S.normalizeMeta({ id: 'nasa:x', title: 'x', attachPoints: aps }).attachPoints
eq(apN([{ name: 'a', posBody: [0, 0, 0] }])[0], { name: 'a', posBody: [0, 0, 0], dirBody: [0, 0, 1], upBody: [0, -1, 0] }, '缺视轴与上向：视轴 +Z（天底），上向 −Y（GEO 顺行即北）')
eq(apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 1, 0] }])[0].upBody, [1, 0, 0], '视轴 ∥ ±Y：−Y 投影退化 → 取 +X')
eq(apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [1, 0, 0] }])[0].upBody, [0, -1, 0], '视轴 +X：上向 −Y')
const tilt = apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0.6, 0.8] }])[0].upBody
ok(Math.abs(tilt[0]) < 1e-15 && Math.abs(tilt[1] + 0.8) < 1e-15 && Math.abs(tilt[2] - 0.6) < 1e-15, '斜视轴：上向 = −Y 的投影 [0, −0.8, 0.6]（与视轴正交、单位长）')
eq(apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0, 2], upBody: [0, 0, -5] }])[0].upBody, [0, -1, 0], '给定上向与视轴平行（反向也算）→ 按 D1 替换')
eq(apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0, 1], upBody: [0, 0, 0] }])[0].upBody, [0, -1, 0], '零长上向 → 按 D1 补')
eq(apN([{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0, 1], upBody: [1, 0, 0.3] }])[0].upBody, [1, 0, 0.3], '不退化的上向原样保留（不强行正交化，便于再编辑）')
bad((x) => { x.attachPoints[0].upBody = [0, 0, -3] }, '平行', '挂点上向与视轴平行 → 错误（定不出滚转）')
eq(S.normalizeMeta(S.normalizeMeta({ id: 'nasa:x', attachPoints: [{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0.6, 0.8] }] })), S.normalizeMeta({ id: 'nasa:x', attachPoints: [{ name: 'a', posBody: [0, 0, 0], dirBody: [0, 0.6, 0.8] }] }), '补上向后 normalize 仍幂等')

// ④ id 规则
eq(S.parseModelId('nasa:tdrs-c~3'), { prefix: 'nasa', body: 'tdrs-c', n: 3 }, 'nasa 多文件条目 ~n')
eq(S.parseModelId('nasa:tdrs-c'), { prefix: 'nasa', body: 'tdrs-c', n: 1 }, 'nasa 单文件')
eq(S.parseModelId('nasa:tdrs-c~1'), null, '~1 不合法（第 1 个不带后缀）')
eq(S.parseModelId('nasa:-x'), null, 'slug 不能以连字符开头')
eq(S.parseModelId('param:default-sat').prefix, 'param', 'param 模板')
eq(S.parseModelId('param:0123456789ab').body, '0123456789ab', 'param specHash')
eq(S.parseModelId('user:0123456789AB'), null, 'user: 须小写十六进制')
eq(S.parseModelId('stk:0123456789a'), null, 'stk: 须 12 位')
eq(S.parseModelId(42), null, '非字符串')
eq(S.nasaModelId('satellite-kit', 2), 'nasa:satellite-kit~2', 'nasaModelId')
eq(S.nasaModelId('Bad Slug'), null, 'nasaModelId 坏 slug')
eq(S.userModelId(SHA('A')), 'user:aaaaaaaaaaaa', 'userModelId 取前 12 位转小写')
eq(S.stkModelId('xyz'), null, 'stkModelId 坏 sha')
eq(S.paramModelId('Default-SAT'), 'param:default-sat', 'paramModelId 转小写')

// ⑤ 绑定键（T10）
eq(S.satKeyOf({ name: 'ISS (ZARYA)', noradId: '25544', group: 'stations' }), 'norad:25544', '目录星 → norad')
eq(S.satKeyOf({ name: 'X', noradId: '00025544' }), 'norad:25544', '前导零去掉')
eq(S.satKeyOf({ name: 'X', noradId: 25544 }), 'norad:25544', '数字 NORAD')
eq(S.satKeyOf({ name: 'EPH-1 ', noradId: '800001', key: ' E1 ', group: 'ci:g7', _ephGroup: 'g7' }), 'ephem:g7:E1', '星历点序列 → ephem:<组>:<key>（去空白）')
eq(S.satKeyOf({ name: 'EPH-2', noradId: '800002', _ephGroup: 'g7' }), 'ephem:g7:EPH-2', 'ephem 无 key → 用名字')
eq(S.satKeyOf({ name: 'Walker-3', noradId: '900003', group: 'cc_abc' }), 'cc:abc:Walker-3', '自定义星座 → cc:<cfgId>:<name>')
eq(S.satKeyOf({ name: 'PRN 99', noradId: '990099' }), 'name:PRN 99', '合成号段 ≥ 800000 → name:')
eq(S.satKeyOf({ noradId: '0' }), null, 'NORAD 0 且无名 → null')
eq(S.satKeyOf(null), null, '非对象 → null')
eq(S.satKeyOf({ name: 'x'.repeat(300) }), null, '键超长 → null')
ok(['norad:25544', 'ephem:g7:E1', 'cc:abc:Walker-3', 'name:PRN 99', 'lbsat:gso:sat3', 'grdsat:中星 6D', 'grdsat:卫星·2', 'grdsat:a:b'].every(S.isValidSatKey), '合法键（含二期 D8 的 grdsat / lbsat:<ns>:<id>）')
ok(!['norad:800000', 'norad:0', 'norad:01', 'ephem::x', 'custom:x', '', 'name: x', 'lbsat:12', 'lbsat:g so:x', 'lbsat::x', 'grdsat:', 'grdsat: x', 'grdsat:x '].some(S.isValidSatKey), '非法键（lbsat 必须带窗口命名空间，否则四窗 sat3 撞键）')
eq([S.grdSatKey(' 中星 6D '), S.grdSatKey(''), S.grdSatKey(null), S.grdSatKey('x'.repeat(300))], ['grdsat:中星 6D', null, null, null], 'grdSatKey：去首尾空白、空 / 超长 → null')
eq([S.lbSatKey('gso', 'sat3'), S.lbSatKey('ngso', ' 7 '), S.lbSatKey('g so', 'x'), S.lbSatKey('a:b', 'x'), S.lbSatKey('gso', '')], ['lbsat:gso:sat3', 'lbsat:ngso:7', null, null, null], 'lbSatKey：ns 不许含空白 / 冒号')
ok([S.grdSatKey('中星 6D'), S.lbSatKey('regen', 'c1')].every(S.isValidSatKey), '构造出的键都能过校验')
const bk = S.validateBindings({ schema: 1, bindings: { 'grdsat:中星 6D': { model: { id: 'param:default-sat' } }, 'lbsat:gso:sat3': {} } })
eq(Object.keys(bk.bindings.bindings), ['grdsat:中星 6D', 'lbsat:gso:sat3'], 'grdsat / lbsat 绑定不被清洗掉')
const MP = { posBody: [0, 0, 1] }   // mount 的最小合法形（只缺省其余字段）
const bt = (() => { try { return S.validateBindings({ schema: 1, bindings: { 'norad:1': { mounts: [{ id: 'ok', ...MP }, { id: 'big', v: 10n, ...MP }, { id: 'loop', self: circ, ...MP }], attitude: { law: 'target', params: { big: 1n } } } } }) } catch (e) { return e } })()
ok(!(bt instanceof Error) && bt.ok, '绑定里有 BigInt / 循环引用 → 不抛')
eq([bt.bindings.bindings['norad:1'].mounts.map((x) => x.id), bt.bindings.bindings['norad:1'].attitude], [['ok'], { law: 'target', params: {} }], '拷不了的 mount 丢弃、params 清空')
ok(has(bt.errors, 'mounts') && has(bt.errors, 'params'), '丢弃与清空都记错误')

// 绑定表清洗
const B = S.validateBindings({
  schema: 1,
  prefs: { geoDefault: 'nasa:space-systems-loral-ssl-1300', showModels: false },
  bindings: {
    'norad:25544': { model: { id: 'nasa:international-space-station-iss-b', iconPx: 40.4, frameOverride: { q: [0, 0, 0, -1], t: [0, 0, 1] } }, mounts: [{ id: 'm1', ...MP }, 5], attitude: { law: 'yawSteer', params: { k: 1 } } },
    'norad:41866': { model: { id: 'bad id', iconPx: 1000 }, attitude: { law: 'spin' }, massProps: { massKg: -1 } },
    'norad:41867': { model: { frameOverride: { q: [1, 1, 1, 1], t: [0, 0] } } },
    'bogus key': { model: { id: 'auto' } },
    'name:X': 'nope'
  }
})
ok(B.ok, '整份结构对 → ok')
eq(B.bindings.prefs, { geoDefault: 'nasa:space-systems-loral-ssl-1300', showModels: false }, 'prefs')
eq(B.bindings.bindings['norad:25544'], { model: { id: 'nasa:international-space-station-iss-b', iconPx: 40, frameOverride: { q: [0, 0, 0, 1], t: [0, 0, 1] } }, mounts: [S.defaultMount({ id: 'm1', ...MP })], attitude: { law: 'yawSteer', params: { k: 1 } } }, '合法条目：图标取整、四元数规范化、非对象 mount 丢弃、mount 补齐缺省')
eq(B.bindings.bindings['norad:41866'], { model: { id: 'auto' }, mounts: [], attitude: { law: 'nadir', params: {} } }, '坏字段纠正为缺省')
eq(B.bindings.bindings['norad:41867'].model, { id: 'auto' }, '坏 frameOverride 丢弃')
ok(!('bogus key' in B.bindings.bindings) && !('name:X' in B.bindings.bindings), '坏键 / 坏值丢弃')
ok(has(B.errors, 'bogus key') && has(B.errors, 'iconPx') && has(B.errors, 'spin') && has(B.errors, 'massProps') && has(B.errors, 'mounts'), '每处纠正都记错误')
eq(S.validateBindings(B.bindings), { ok: true, errors: [], bindings: B.bindings }, '清洗结果再校验：零错误、不变（幂等）')
eq(JSON.parse(JSON.stringify(B.bindings)), B.bindings, '结果是纯数据（可直接过 IPC）')
eq(S.validateBindings({ schema: 2 }).ok, false, 'schema ≠ 1 → 整份拒（调用方据此拒写）')
eq(S.validateBindings('x').ok, false, '非对象 → 整份拒')
eq(S.validateBindings({ schema: 1 }).bindings, { schema: 1, prefs: { geoDefault: 'param:default-sat', showModels: true }, bindings: {} }, '空表 → 缺省 prefs')
// GEO 默认出厂值 = 默认卫星（与 autoMatch 的 GEO 缺省同一个值）；老绑定表里的旧模板 id 静默升级（模型库按 === 比对）
eq(S.DEFAULT_PREFS.geoDefault, PT.DEFAULT_MODEL_ID, 'DEFAULT_PREFS.geoDefault = paramTemplates.DEFAULT_MODEL_ID')
ok(Object.isFrozen(S.DEFAULT_PREFS), 'DEFAULT_PREFS 冻结')
for (const old of ['param:dfh4', 'param:dfh4e', 'param:dfh5']) {
  const r = S.validateBindings({ schema: 1, prefs: { geoDefault: old }, bindings: { 'norad:1': { model: { id: old } } } })
  eq([r.ok, r.errors, r.bindings.prefs.geoDefault, r.bindings.bindings['norad:1'].model.id], [true, [], PT.DEFAULT_MODEL_ID, PT.DEFAULT_MODEL_ID], `旧模板 id ${old} → 现行 id（geoDefault 与绑定 model.id 都升级、不记错）`)
  eq(S.validateBindings(r.bindings), { ok: true, errors: [], bindings: r.bindings }, `升级后再校验不变（幂等）：${old}`)
}
eq(S.validateBindings({ schema: 1, prefs: { geoDefault: 'param:0123456789abcdef' }, bindings: { 'norad:1': { model: { id: 'nasa:goes' } } } }).bindings,
  { schema: 1, prefs: { geoDefault: 'param:0123456789abcdef', showModels: true }, bindings: { 'norad:1': { model: { id: 'nasa:goes' }, mounts: [], attitude: { law: 'nadir', params: {} } } } }, '非旧模板的 id 原样保留')
ok(has(S.validateBindings({ schema: 1, prefs: { geoDefault: 'x y' } }).errors, 'geoDefault'), 'geoDefault 非法 → 回缺省并记错')
eq(S.validateBindings({ schema: 1, bindings: { 'norad:1': { model: { id: null } } } }).bindings.bindings['norad:1'].model.id, null, 'model.id = null（用户选「无」）保留')

// ⑧ 许可文案（编排者 2026-09-24 全仓统一）与 NASA credit 规则
eq(S.NASA_LICENSE, 'NASA Images and Media Usage Guidelines（美国公有领域；不得暗示 NASA 背书；保留第三方贡献者署名）', '许可文案')
eq([m.source.license, m.source.credit], [S.NASA_LICENSE, 'NASA'], 'NASA 缺省来源：统一许可文案、credit = NASA')
eq(S.defaultMeta({ id: 'nasa:x', title: 'x', source: { kind: 'nasa', credit: 'NASA / DigitalSpace Corporation' } }).source.credit, 'NASA / DigitalSpace Corporation', '第三方贡献者署名原样保留（credit 规则不变）')

// ⑨ parts[].triRanges / solarGroup / attachPoint（segment.mjs 产出的形状）
const segPart = { id: 'sa', role: 'solarArray', triRanges: [{ node: 'wing', mesh: 3, ranges: [[0, 12], [40, 8]] }], solarGroup: 'SolarGroup', attachPoint: 'SA_1' }
const withSeg = S.normalizeMeta({ ...clone(m), parts: [...clone(m.parts), segPart] })
eq(withSeg.parts[1].triRanges, [{ node: 'wing', ranges: [[0, 12], [40, 8]], mesh: 3 }], 'triRanges 合规 → 原样（节点名 / mesh / 区间）')
eq([withSeg.parts[1].solarGroup, withSeg.parts[1].attachPoint], ['SolarGroup', 'SA_1'], '关联名原样')
ok(S.validateMeta(withSeg, { nodeNames: [...NODE_NAMES, 'wing'] }).ok, '带 triRanges 的部件过校验：' + S.validateMeta(withSeg, { nodeNames: [...NODE_NAMES, 'wing'] }).errors.join('；'))
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'wing', ranges: [[0, -1]] }] }) }, 'ranges[0]', 'triRanges 区间负数')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'wing', ranges: [[0.5, 2]] }] }) }, '非负整数对', 'triRanges 区间小数')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'wing', ranges: [[0, 1, 2]] }] }) }, '非负整数对', 'triRanges 区间不是一对')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: '', ranges: [[0, 1]] }] }) }, '.node', 'triRanges 节点名空')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'wing', ranges: [] }] }) }, 'ranges', 'triRanges 区间表空')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'wing', mesh: -1, ranges: [[0, 1]] }] }) }, '.mesh', 'triRanges mesh 负')
bad((x) => { x.parts.push({ ...segPart, triRanges: 'x' }) }, 'triRanges', 'triRanges 不是数组')
bad((x) => { x.parts.push({ ...segPart, solarGroup: 5 }) }, 'solarGroup', 'solarGroup 非字符串')
bad((x) => { x.parts.push({ ...segPart, attachPoint: '' }) }, 'attachPoint', 'attachPoint 空串')
bad((x) => { x.parts.push({ ...segPart, triRanges: [{ node: 'ghost', ranges: [[0, 1]] }] }) }, '「ghost」不存在', 'triRanges 引用不存在的节点', { nodeNames: [...NODE_NAMES, 'wing'] })
const dang = S.validateMeta({ ...clone(withSeg), parts: [{ ...segPart, solarGroup: 'Nope', attachPoint: 'Nope2' }] })
ok(dang.ok && has(dang.warnings, '「Nope」不存在') && has(dang.warnings, '「Nope2」不存在'), '关联名指向不存在的组 / 挂点：只警告')
const nTR = S.normalizeMeta({ id: 'nasa:x', parts: [{ id: 'p', role: 'bus', triRanges: [{ node: 'a', ranges: [[0, 3], [-1, 2], [1.5, 1], 'x'] }, { node: '', ranges: [[0, 1]] }, { node: 'b', ranges: [['a', 1]] }, { node: 'c', mesh: 'x', ranges: [[2, 2]] }, 7], solarGroup: 3, attachPoint: '' }] }).parts[0]
eq(nTR.triRanges, [{ node: 'a', ranges: [[0, 3]] }, { node: 'c', ranges: [[2, 2]] }], 'normalize：坏区间逐个丢、坏条目整条丢、坏 mesh 删键')
ok(!('solarGroup' in nTR) && !('attachPoint' in nTR), 'normalize：非字符串 / 空的关联名删掉')
ok(!('triRanges' in S.normalizeMeta({ id: 'nasa:x', parts: [{ id: 'p', role: 'bus', triRanges: [{ node: 'a', ranges: [[-1, 1]] }] }] }).parts[0]), 'triRanges 全坏 → 删键')
eq(S.normalizeMeta(withSeg), withSeg, '带 triRanges 的 normalize 幂等')

// ⑩ mount（二期 D1 / D8 / D10 / D18、任务书 §4.2）
const nm = (x) => S.normalizeMount(x)
const m0 = nm({ id: 'feed', posBody: [1, 0.5, 1.2] })
eq(m0.errors, ['mount.boresightBody：缺失，按本体 +Z（天底）'], '缺视轴 → 记错、按 +Z')
eq(m0.mount, { id: 'feed', name: 'feed', attachPoint: null, posBody: [1, 0.5, 1.2], boresightBody: [0, 0, 1], upBody: [0, -1, 0], sysTempK: 500, gimbal: { type: 'none', limits: { ...S.DEFAULT_GIMBAL_LIMITS } }, antennaRef: null, excludeNodes: [] }, '缺省：天底视轴、上向 = D1（本体 −Y）、T_sys 500 K、无万向节、无天线、空排除表')
eq(S.DEFAULT_SYS_TEMP_K, 500, 'T_sys 缺省 500 K（D10）')
eq(m0.mount.upBody, BF.defaultUpBody([0, 0, 1]), '对地挂点上向与 bodyFrame.defaultUpBody 逐位相同（D1 零跳变）')
const full = {
  id: 'SA1', name: '单址天线 1', attachPoint: 'SA_E_Attachpoint', posBody: [5.2, 0, 2.4], boresightBody: [0, 0, 2], upBody: [1, 0, 0.5], fovDeg: 3.2, sysTempK: 650,
  gimbal: { type: 'azel', limits: { a1Min: -30, a1Max: 30, a2Min: 60, a2Max: 90 }, rateDegS: 0.5 },
  antennaRef: { kind: 'grd', id: 'tdrs|SA-E' }, excludeNodes: ['SA_E_Dish', 'SA_E_Boom'], maskSig: 'a'.repeat(64), note: { by: 'user' }
}
const mf = nm(full)
eq(mf.errors, [], '完整 mount：零错误')
eq(mf.mount.boresightBody, [0, 0, 1], '视轴存单位向量')
eq(mf.mount.upBody, [1, 0, 0], '上向去掉视轴分量后归一（与视轴正交）')
eq([mf.mount.fovDeg, mf.mount.sysTempK, mf.mount.gimbal, mf.mount.antennaRef, mf.mount.excludeNodes, mf.mount.maskSig, mf.mount.attachPoint],
  [3.2, 650, full.gimbal, full.antennaRef, full.excludeNodes, full.maskSig, 'SA_E_Attachpoint'], '合法字段原样')
eq(mf.mount.note, { by: 'user' }, '未知键（纯数据）照留：并行开发的消费端扩字段不被吞')
eq(nm(mf.mount), { mount: mf.mount, errors: [] }, 'normalizeMount 幂等、零错误')
const tilted = nm({ id: 't', posBody: [0, 0, 0], boresightBody: [0.3, -0.4, 0.866] }).mount
ok(Math.abs(Math.hypot(...tilted.boresightBody) - 1) < 1e-15 && Math.abs(tilted.upBody.reduce((s, u, k) => s + u * tilted.boresightBody[k], 0)) < 1e-15, '斜视轴：单位长、上向 ⊥ 视轴')
eq(nm(tilted), { mount: tilted, errors: [] }, '斜视轴：幂等（单位长不再除模、正交不再投影，末位不跳）')
eq(nm({ id: 'y', posBody: [0, 0, 0], boresightBody: [0, 1, 0] }).mount.upBody, [1, 0, 0], '视轴 ∥ ±Y：上向退化取 +X（D1）')
// 逐字段坏值：丢弃 / 回缺省并记错，不抛
const badM = (patch, frag, check, msg) => {
  const r = nm({ ...clone(full), ...patch })
  assert.ok(r.mount && has(r.errors, frag), `${msg}：${JSON.stringify(r.errors)}`)
  if (check) assert.ok(check(r.mount), `${msg}：${JSON.stringify(r.mount)}`)
  pass++
}
badM({ id: '' }, '.id', (x) => x.id === 'mount_1', 'id 空 → 补 mount_1')
badM({ id: 'x'.repeat(65) }, '.id', (x) => x.id === 'mount_1', 'id 超长 → 补')
badM({ name: 7 }, '.name', (x) => x.name === 'SA1', 'name 非字符串 → 用 id')
badM({ attachPoint: 5 }, '.attachPoint', (x) => x.attachPoint === null, 'attachPoint 非字符串 → null')
badM({ boresightBody: [0, 0, 0] }, 'boresightBody', (x) => x.boresightBody.join() === '0,0,1', '视轴零向量 → +Z')
badM({ boresightBody: [1, NaN, 0] }, 'boresightBody', (x) => x.boresightBody.join() === '0,0,1', '视轴 NaN → +Z')
badM({ upBody: [0, 0, -3] }, 'upBody', (x) => x.upBody.join() === BF.defaultUpBody([0, 0, 1]).join(), '上向与视轴平行 → D1')
badM({ upBody: 'north' }, 'upBody', (x) => x.upBody.join() === '0,-1,0', '上向非法 → D1')
badM({ fovDeg: 0 }, 'fovDeg', (x) => !('fovDeg' in x), '视场 0 → 丢弃')
badM({ fovDeg: 400 }, 'fovDeg', (x) => !('fovDeg' in x), '视场 > 360 → 丢弃')
badM({ sysTempK: -5 }, 'sysTempK', (x) => x.sysTempK === 500, 'T_sys 负 → 500')
badM({ sysTempK: '300' }, 'sysTempK', (x) => x.sysTempK === 500, 'T_sys 字符串 → 500')
badM({ gimbal: { type: 'hexapod' } }, 'gimbal.type', (x) => x.gimbal.type === 'none', '万向节类型非法 → none')
badM({ gimbal: 'azel' }, 'gimbal', (x) => x.gimbal.type === 'none', '万向节非对象 → none')
badM({ gimbal: { type: 'xy', limits: { a1Min: 40, a1Max: -40 } } }, '已交换', (x) => x.gimbal.limits.a1Min === -40 && x.gimbal.limits.a1Max === 40 && x.gimbal.limits.a2Min === -90, '限位反了 → 交换；缺的按全程')
badM({ gimbal: { type: 'xy', limits: { a2Max: 720 } } }, 'a2Max', (x) => x.gimbal.limits.a2Max === 90, '限位越界 → 缺省')
badM({ gimbal: { type: 'azel', rateDegS: 0 } }, 'rateDegS', (x) => !('rateDegS' in x.gimbal), '角速率 0 → 丢弃')
badM({ antennaRef: { kind: 'horn', id: 'x' } }, 'antennaRef', (x) => x.antennaRef === null, '天线引用 kind 非法 → null')
badM({ antennaRef: { kind: 'grd', id: '  ' } }, 'antennaRef.id', (x) => x.antennaRef === null, 'GRD 引用 id 空 → null')
badM({ antennaRef: { kind: 'param' } }, 'spec', (x) => x.antennaRef === null, '参数化引用缺 spec → null')
badM({ antennaRef: { kind: 'param', spec: { diameterM: 2.4, freqGHz: 12, efficiency: 65, gainDbi: 48, extra: 'k' } } }, 'efficiency', (x) => x.antennaRef.spec.diameterM === 2.4 && !('efficiency' in x.antennaRef.spec) && x.antennaRef.spec.extra === 'k', '参数化口径：坏字段（效率 65 不是 0–1）逐个丢，其余与未知键照留')
badM({ excludeNodes: ['a', '', 'a', 3] }, 'excludeNodes', (x) => x.excludeNodes.join() === 'a', '排除节点：空 / 重复 / 非字符串丢弃')
badM({ excludeNodes: 'a' }, 'excludeNodes', (x) => x.excludeNodes.length === 0, '排除节点非数组 → 清空')
badM({ maskSig: '../../evil' }, 'maskSig', (x) => !('maskSig' in x), '掩模签名带路径分隔符 → 丢弃（主进程拼路径安全）')
badM({ maskSig: 'A'.repeat(64) }, 'maskSig', (x) => !('maskSig' in x), '掩模签名大写 → 丢弃（NTFS 不分大小写会撞文件）')
badM({ maskSig: 'abc' }, 'maskSig', (x) => !('maskSig' in x), '掩模签名太短 → 丢弃')
eq(nm({ ...clone(full), antennaRef: { kind: 'lbAntenna', id: ' lbsat:gso:sat3 ' } }).mount.antennaRef, { kind: 'lbAntenna', id: 'lbsat:gso:sat3' }, '链路预算库引用：id 去首尾空白')
eq(nm({ ...clone(full), gimbal: { type: 'azel', rateDegS: null } }).mount.gimbal, { type: 'azel', limits: { ...S.DEFAULT_GIMBAL_LIMITS } }, 'rateDegS = null 视同缺省，不记错')
// 整条丢弃的三种情况
for (const [x, frag, msg] of [[{ id: 'a' }, 'posBody', '缺 posBody'], [{ id: 'a', posBody: [0, 0] }, 'posBody', 'posBody 长度不对'], [5, '不是对象', '非对象'], [{ id: 'a', posBody: [0, 0, 0], big: 1n }, '纯数据', 'BigInt']]) {
  const r = nm(x)
  assert.ok(r.mount === null && has(r.errors, frag), `${msg}：${JSON.stringify(r.errors)}`); pass++
}
eq(S.defaultMount({ id: 'n1', posBody: [0, 0, 1] }), nm({ id: 'n1', posBody: [0, 0, 1], boresightBody: [0, 0, 1] }).mount, 'defaultMount：缺省视轴 +Z 不记错')
// defaultMount 恒返回对象：undefined / null 值视同没给、坏 posBody 回原点、拷不了的未知键退到只留已知键（「从挂点套用」时挂点缺位姿不白屏）
const dm0 = S.defaultMount()
for (const [p, msg] of [[{ name: 'x', posBody: undefined }, 'posBody: undefined'], [{ posBody: null }, 'posBody: null'], [{ posBody: [1, 2] }, 'posBody 长度不对'], [{ posBody: 'a' }, 'posBody 非数组'], [5, '非对象'], [null, 'null']]) {
  const d = S.defaultMount(p)
  assert.ok(d && d.posBody.join() === '0,0,0' && d.boresightBody.join() === '0,0,1', `defaultMount(${msg})：${JSON.stringify(d)}`); pass++
}
eq(S.defaultMount({ name: 'x', posBody: undefined }).name, 'x', 'defaultMount：其余字段照用')
eq(S.defaultMount({ id: 'k', boresightBody: null, upBody: undefined, fovDeg: null }), { ...dm0, id: 'k', name: 'k' }, 'defaultMount：null / undefined 的已知键回缺省，不记成坏值')
eq(S.defaultMount({ id: 'k', fovDeg: 4, big: 1n }), { ...dm0, id: 'k', name: 'k', fovDeg: 4 }, 'defaultMount：未知键拷不了（BigInt）→ 只留已知键')
eq(S.defaultMount({ id: 'k', gimbal: { x: 1n } }), dm0, 'defaultMount：已知键也拷不了 → 纯缺省')
eq(S.defaultMount({ id: 'm9', posBody: [1, 2, 3], boresightBody: [0, 1, 0] }), nm({ id: 'm9', posBody: [1, 2, 3], boresightBody: [0, 1, 0] }).mount, 'defaultMount：合法 partial 与 normalizeMount 同一结果')
// 原型污染：JSON.parse 把 "__proto__" 建成自有键；归一时若按赋值拷，会把它换成原型，被丢弃的 maskSig / fovDeg 从原型上读回未校验的值
const PJ = JSON.parse('{"schema":1,"bindings":{"norad:25544":{"mounts":[{"id":"a","posBody":[0,0,0],"boresightBody":[0,0,1],"__proto__":{"maskSig":"../../../evil","fovDeg":-5},"constructor":{"prototype":{"x":1}},"note":{"__proto__":{"polluted":1}}}],"attitude":{"law":"sun","params":{"__proto__":{"axis":"../x"},"prototype":1}}}}}')
const PR = S.validateBindings(PJ)
const pm = PR.bindings.bindings['norad:25544'].mounts[0]
eq([pm.maskSig, pm.fovDeg, 'maskSig' in pm, 'fovDeg' in pm], [undefined, undefined, false, false], '__proto__ 夹带的 maskSig / fovDeg 不从原型冒出（D18 路径安全）')
eq([Object.getPrototypeOf(pm), Object.getPrototypeOf(pm.note), Object.getPrototypeOf(PR.bindings.bindings['norad:25544'].attitude.params)], [Object.prototype, Object.prototype, Object.prototype], 'mount / 未知键里的嵌套对象 / 姿态参数：原型仍是 Object.prototype')
eq([Object.hasOwn(pm, 'constructor'), Object.hasOwn(pm.note, '__proto__'), Object.hasOwn(PR.bindings.bindings['norad:25544'].attitude.params, 'prototype')], [false, false, false], '保留名各层都剥掉')
ok(has(PR.errors, 'mounts[0].__proto__：保留名') && has(PR.errors, 'mounts[0].constructor：保留名') && has(PR.errors, 'attitude.params.__proto__：保留名') && has(PR.errors, 'attitude.params.prototype：保留名'), '保留名丢弃并记错（带路径）')
eq(S.validateBindings(PR.bindings), { ok: true, errors: [], bindings: PR.bindings }, '剥掉保留名的结果再校验：零错误、不变')
const PM2 = nm(JSON.parse('{"id":"b","posBody":[0,0,0],"boresightBody":[0,0,1],"antennaRef":{"kind":"param","spec":{"diameterM":1,"__proto__":{"efficiency":9}}}}'))
eq([PM2.mount.antennaRef.spec, Object.getPrototypeOf(PM2.mount.antennaRef.spec) === Object.prototype, has(PM2.errors, 'spec.__proto__')], [{ diameterM: 1 }, true, true], '参数化天线口径：__proto__ 夹带的坏效率不生效')
const PMeta = S.normalizeMeta(JSON.parse('{"id":"param:x","kind":"param","source":{"kind":"param"},"parts":[{"id":"p1","role":"bus","__proto__":{"triRanges":"bad"},"constructor":1}],"spec":{"a":1,"__proto__":{"b":2}}}'))
eq([PMeta.parts[0].triRanges, Object.hasOwn(PMeta.parts[0], 'constructor'), Object.getPrototypeOf(PMeta.parts[0]) === Object.prototype, PMeta.spec], [undefined, false, true, { a: 1 }], 'normalizeMeta 的部件 / spec：保留名剥掉、原型不变')
// 绑定表里：id 唯一（重复加后缀、缺的按序号补）、上限、非数组
const BM = S.validateBindings({ schema: 1, bindings: { 'norad:2': { mounts: [{ posBody: [0, 0, 0], boresightBody: [0, 0, 1] }, { id: 'x', posBody: [1, 0, 0], boresightBody: [0, 0, 1] }, { id: 'x', posBody: [2, 0, 0], boresightBody: [0, 0, 1] }, { id: 'mount_1', posBody: [3, 0, 0], boresightBody: [0, 0, 1] }, { id: 'q' }] } } })
eq(BM.bindings.bindings['norad:2'].mounts.map((x) => [x.id, x.name]), [['mount_1', 'mount_1'], ['x', 'x'], ['x_2', 'x_2'], ['mount_1_2', 'mount_1_2']], 'mount id 唯一化；缺 posBody 的整条丢')
ok(has(BM.errors, 'mounts[0].id') && has(BM.errors, 'mounts[2].id') && has(BM.errors, 'mounts[4].posBody'), '每处纠正记错误（带下标路径）')
eq(S.validateBindings(BM.bindings), { ok: true, errors: [], bindings: BM.bindings }, 'mount 清洗结果再校验：零错误、不变')
const many = S.validateBindings({ schema: 1, bindings: { 'norad:3': { mounts: Array.from({ length: 70 }, (_, i) => ({ id: 'm' + i, posBody: [i, 0, 0], boresightBody: [0, 0, 1] })) } } })
eq([many.bindings.bindings['norad:3'].mounts.length, has(many.errors, '超过 64 条')], [64, true], 'mount 上限 64 条')
ok(has(S.validateBindings({ schema: 1, bindings: { 'norad:4': { mounts: 'x' } } }).errors, 'mounts：须为数组'), 'mounts 非数组 → 清空并记错')

// ⑪ 姿态律 {law, params}：参数键与 attitude.mjs（消费端）逐键同口径；只校验不补缺省
const na = (x) => S.normalizeAttitude(x)
eq(na(undefined), { attitude: { law: 'nadir', params: {} }, errors: [] }, '缺省 nadir、无参数、不记错')
for (const law of ['nadir', 'yawSteer', 'sun', 'inertial', 'target']) eq(na({ law }).attitude, { law, params: {} }, `${law}：无参数时不补缺省（消费端按 ATTITUDE_PARAM_DEFAULTS 算）`)
eq([...S.ATTITUDE_LAWS], [...ATT.ATT_LAWS], '律名表 = attitude.mjs')
eq([...S.ATTITUDE_SECONDARY], [...ATT.ATT_SECONDARY], '次约束表 = attitude.mjs')
eq(na({ law: 'sun', params: { axis: [0, 2, 0], secondary: 'velocity', secondaryAxis: '-Y' } }).attitude.params, { axis: [0, 1, 0], secondary: 'velocity', secondaryAxis: [0, -1, 0] }, '轴给向量 → 单位向量；轴给字符串 → 换成向量（attitude.mjs 只认数值）')
eq(na({ law: 'target', params: { axis: '+X' } }).attitude.params.axis, [1, 0, 0], "target：'+X' → [1,0,0]")
const aBad = na({ law: 'sun', params: { axis: '+W', secondary: 'moon', secondaryAxis: [0, 0, 0], keep: 1 } })
eq(aBad.attitude.params, { keep: 1 }, '坏轴 / 坏次约束 / 零向量次轴 → 丢弃（消费端按缺省算），别的键照留')
ok(has(aBad.errors, 'params.axis') && has(aBad.errors, 'params.secondary') && has(aBad.errors, 'secondaryAxis'), '坏参数记错')
eq(na({ law: 'nadir', params: { yawBiasDeg: 180 } }).attitude.params, { yawBiasDeg: 180 }, 'nadir：固定偏航')
ok(has(na({ law: 'nadir', params: { yawBiasDeg: 'x' } }).errors, 'yawBiasDeg'), 'nadir：偏航非数 → 丢弃记错')
eq(na({ law: 'yawSteer', params: { sunSide: '-X' } }).attitude.params, { sunSide: '-X' }, "yawSteer：sunSide '-X'")
ok(has(na({ law: 'yawSteer', params: { sunSide: 'left' } }).errors, 'sunSide'), 'yawSteer：sunSide 非法记错')
eq(na({ law: 'inertial', params: { eulerDeg: { yaw: 10, pitch: -5 } } }).attitude.params, { eulerDeg: { yaw: 10, pitch: -5 } }, 'inertial：欧拉角写法（缺的分量按 0）')
ok(has(na({ law: 'inertial', params: { eulerDeg: { yaw: 'a' } } }).errors, 'eulerDeg'), 'inertial：欧拉角非数记错')
eq(na({ law: 'target', params: { target: { kind: 'station', latDeg: 39.9, lonDeg: 243.6, name: '北京站' } } }).attitude.params.target, { kind: 'station', latDeg: 39.9, lonDeg: 243.6 - 360, altM: 0, name: '北京站' }, '地球站：经度归到 (−180, 180]、高度缺省 0')
eq(na({ law: 'target', params: { target: { kind: 'station', latDeg: 39.9, lonDeg: 116.4 } } }).attitude.params.target.lonDeg, 116.4, '区间内的经度原样（不经取模引入末位误差）')
eq(na({ law: 'target', params: { target: { kind: 'sat', satKey: 'norad:25544' } } }).attitude.params.target, { kind: 'sat', satKey: 'norad:25544' }, '目标星：合法绑定键')
eq(na({ law: 'target', params: { target: { kind: 'ecef', ecefKm: [6378, 0, 0] } } }).attitude.params.target, { kind: 'ecef', ecefKm: [6378, 0, 0] }, '固定 ECEF 点')
eq(na({ law: 'target', params: { target: null } }).attitude.params, { target: null }, '目标待选（null）保留、不记错')
for (const [t, frag, msg] of [[{ kind: 'station', latDeg: 91, lonDeg: 0 }, '经纬度', '纬度越界'], [{ kind: 'sat', satKey: 'custom:x' }, 'satKey', '目标星键非法'], [{ kind: 'ecef', ecefKm: [0, 0, 0] }, 'ecefKm', 'ECEF 零向量'], [{ kind: 'moon' }, 'kind', '目标类型非法'], ['x', '对象或 null', '目标非对象']]) {
  const r = na({ law: 'target', params: { target: t } })
  assert.ok(r.attitude.params.target === null && has(r.errors, frag), `${msg}：${JSON.stringify(r.errors)}`); pass++
}
eq(na({ law: 'target', params: { target: { kind: 'station', latDeg: 0, lonDeg: 0, altM: 'x' } } }).attitude.params.target.altM, 0, '高度非法 → 0')
eq(na({ law: 'inertial', params: { q: [0, 0, 0, -1.0000004] } }).attitude.params.q, [0, 0, 0, 1], 'inertial：近单位四元数归一 + 符号规范化')
const qBad = na({ law: 'inertial', params: { q: [1, 2] } })
ok(has(qBad.errors, 'params.q') && !('q' in qBad.attitude.params), 'inertial：坏四元数丢弃记错')
const qr = [0.1, -0.7, 0.3, 0.64]; const qn = Math.hypot(...qr); const qu = qr.map((x) => x / qn)
const i1 = na({ law: 'inertial', params: { q: qu } }).attitude
eq(na(i1).attitude, i1, 'inertial：一般单位四元数再归一逐位不变（幂等）')
eq(na({ law: 'nadir', params: { axis: '+X', keep: [1, 2] } }).attitude.params, { axis: [1, 0, 0], keep: [1, 2] }, '别的律的参数照留（同口径校验）；扩展键照留')
ok(has(na({ law: 'nadir', params: 5 }).errors, 'params'), 'params 非对象 → 清空并记错')
ok(has(na('nadir').errors, 'attitude'), 'attitude 非对象 → nadir 并记错')
// 归一后的参数喂 attitude.mjs：sun 律 +X 轴（字符串写法）真的指太阳（字符串若原样留着，消费端会静默退回 −Z）
{
  const params = na({ law: 'sun', params: { axis: '+X' } }).attitude.params
  const sun = [0.3, 0.8, -0.52].map((v, _, a) => v / Math.hypot(...a))
  const bb = ATT.attitudeBasisEcef('sun', params, { rEcef: [42164, 0, 0], vInertialEcef: [0, 3.0747, 0], sunEcef: sun })
  near3(bb.X, sun, 1e-12, 'sun 律 +X 指太阳（经归一的参数）')
}

// ⑪b 与生产端 / 消费端对口径：mask.maskSignature 的产物过 MASK_SIG_RE；mountTemplates 全部模板零错误、幂等
{
  const { maskSignature } = await import('../models/mask.mjs')
  const sig = maskSignature({ modelSha: 'ab'.repeat(32), lod: 'lod1', frame: { q_model2body: [...BF.DEFAULT_Q_MODEL2BODY], t_model2body: [0, 0, 0] }, mountPos: [1, 0, 1.6], excludeNodes: ['a'] })
  ok(S.MASK_SIG_RE.test(sig), `掩模签名 ${sig} 过 MASK_SIG_RE`)
  eq(nm({ id: 'm', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: sig }).mount.maskSig, sig, '掩模签名原样留在 mount 上')
  const { MOUNT_TEMPLATES } = await import('../models/mountTemplates.mjs')
  let nMt = 0
  for (const t of MOUNT_TEMPLATES) for (const mm of t.mounts) {
    const r = nm(JSON.parse(JSON.stringify(mm)))
    assert.deepEqual(r.errors, [], `${t.id}/${mm.id}：${JSON.stringify(r.errors)}`)
    assert.deepEqual(nm(r.mount), { mount: r.mount, errors: [] }, `${t.id}/${mm.id} 幂等`)
    nMt++
  }
  ok(nMt > 0, `挂点模板 ${nMt} 条全部零错误、幂等`)
  for (const t of MOUNT_TEMPLATES) {
    const r = S.normalizeAttitude(JSON.parse(JSON.stringify(t.attitude)))
    assert.deepEqual(r.errors, [], `${t.id} 姿态律：${JSON.stringify(r.errors)}`)
  }
  pass++
}

// ⑫ 乱数据不抛、结果能过自身（模糊测试 500 例：清洗一次后再清洗零错误且不变）
let fz = 20260924
const fr = () => { fz = (fz * 1664525 + 1013904223) >>> 0; return fz / 4294967296 }
const junk = () => [undefined, null, 0, -1, 1e9, NaN, 'x', '', [], [1, 2], [0, 0, 0], [fr(), fr() - 0.5, fr()], {}, { kind: 'grd', id: 'a|b' }, { type: 'azel' }, true][Math.floor(fr() * 16)]
const keys = ['id', 'name', 'attachPoint', 'posBody', 'boresightBody', 'upBody', 'fovDeg', 'sysTempK', 'gimbal', 'antennaRef', 'excludeNodes', 'maskSig']
for (let k = 0; k < 500; k++) {
  const mounts = Array.from({ length: 1 + Math.floor(fr() * 4) }, () => { const o = { posBody: fr() < 0.8 ? [fr(), fr(), fr()] : junk() }; for (const key of keys) if (fr() < 0.5) o[key] = junk(); return o })
  const att = { law: ['nadir', 'yawSteer', 'sun', 'inertial', 'target', 'spin'][Math.floor(fr() * 6)], params: fr() < 0.5 ? { axis: junk(), secondary: junk(), target: junk(), q: junk() } : junk() }
  let r1
  try { r1 = S.validateBindings({ schema: 1, bindings: { 'norad:9': { mounts, attitude: att } } }) } catch (e) { assert.fail('模糊测试抛了：' + e.message) }
  const r2 = S.validateBindings(r1.bindings)
  assert.deepEqual(r2.errors, [], `第 ${k} 例：清洗结果再清洗仍报错 ${JSON.stringify(r2.errors)}`)
  assert.deepEqual(r2.bindings, r1.bindings, `第 ${k} 例：不幂等`)
  assert.deepEqual(JSON.parse(JSON.stringify(r1.bindings)), r1.bindings, `第 ${k} 例：不是纯数据`)
}
pass++

// ⑬ 三期装配 / 实体（DESIGN3 E1–E6；P3 契约 §2.1）：asm / ent 前缀、实体三类 kind、装配文档与 id 的双向约束、importQ、类别优先的导入缺省
{
  // id 规则：asm:<12 位小写十六进制>（与 assembly.ASM_ID_RE 同式，对账在 modelAsmMeta）、ent:<模板 id>（与 A3 的 ENTITY_ID_RE 同式）
  eq(S.parseModelId('asm:0123456789ab'), { prefix: 'asm', body: '0123456789ab' }, 'asm: 12 位小写十六进制')
  for (const b of ['asm:0123456789AB', 'asm:0123456789a', 'asm:0123456789abc', 'asm:', 'asm:g123456789ab', 'ASM:0123456789ab']) eq(S.parseModelId(b), null, `asm 非法：${b}`)
  eq(S.parseModelId('ent:a320neo'), { prefix: 'ent', body: 'a320neo' }, 'ent: 模板 id')
  eq(S.parseModelId('ent:b777-300er').body, 'b777-300er', 'ent: 允许连字符')
  ok(S.parseModelId('ent:' + 'a'.repeat(48)) !== null, 'ent: 至多 48 位')
  for (const b of ['ent:A320', 'ent:-x', 'ent:', 'ent:a_b', 'ent:a.b', 'ent:' + 'a'.repeat(49)]) eq(S.parseModelId(b), null, `ent 非法：${b}`)
  ok(S.parseModelId('param:0123456789ab').prefix === 'param' && S.parseModelId('user:0123456789ab').prefix === 'user', '老前缀不受影响')

  // 实体三类 kind / group；地球站沿用 ground（不另设 station 别名）
  for (const k of ['aircraft', 'ship', 'vehicle']) ok(S.MODEL_KINDS.includes(k) && S.MODEL_GROUPS.includes(k), `kind / group 含 ${k}`)
  ok(S.MODEL_KINDS.includes('ground') && S.MODEL_KINDS.includes('station'), 'ground（地球站）与 station（空间站）都还在')
  eq(S.ASM_DOMAIN_KINDS, { spacecraft: 'spacecraft', ground: 'ground', aircraft: 'aircraft', ship: 'ship', vehicle: 'vehicle' }, 'ASM_DOMAIN_KINDS：领域 → kind')
  ok(Object.isFrozen(S.ASM_DOMAIN_KINDS) && Object.values(S.ASM_DOMAIN_KINDS).every((k) => S.MODEL_KINDS.includes(k) && S.MODEL_GROUPS.includes(k)), 'ASM_DOMAIN_KINDS 冻结、值都是合法 kind / group')

  // 一条完整合法的装配件
  const spec = { kind: 'assembly', schema: 1, domain: 'aircraft', name: '测试机', comps: [{ id: 'fus', type: 'prim.box', params: {}, parent: null }] }
  const asm = () => S.normalizeMeta({
    id: 'asm:0123456789ab', title: '测试机', titleZh: '测试机', kind: 'aircraft', group: 'aircraft', fidelity: 'parametric',
    source: { kind: 'user', redistributable: true }, files: { lod0: { sha256: SHA('e'), bytes: 100, tris: 12 } },
    units: { scaleToMeters: 1, unitGuess: 'm', sizeVerified: false },
    frame: { q_model2body: [...BF.Q_YUP_ZENITH], t_model2body: [0, 0, 0], verified: true, importQ: [...BF.Q_YUP_ZENITH] },
    spec, tags: ['assembly', 'aircraft']
  })
  const a0 = asm()
  const va = S.validateMeta(a0)
  ok(va.ok && va.warnings.length === 0, `完整装配件通过、无告警：${va.errors.join('；')}${va.warnings.join('；')}`)
  eq([a0.source.kind, a0.source.redistributable, a0.kind, a0.group, a0.spec.kind], ['user', true, 'aircraft', 'aircraft', 'assembly'], '装配件字段原样保留')
  ok(S.isRedistributable(a0), '装配件（user、可分发）isRedistributable')
  eq(S.normalizeMeta(a0), a0, '装配件 normalizeMeta 幂等')
  eq(S.normalizeMeta({ id: 'asm:0123456789ab' }).source.kind, 'user', 'asm: 缺来源 → 按前缀补 user')
  eq(S.normalizeMeta({ id: 'ent:a320neo' }).source.kind, 'builtin', 'ent: 缺来源 → 按前缀补 builtin')
  // 前缀 ↔ 来源
  const badA = (mut, frag, msg, opts) => { const x = clone(a0); mut(x); const r = S.validateMeta(x, opts); assert.ok(!r.ok && has(r.errors, frag), `${msg}：${JSON.stringify(r.errors)}`); pass++ }
  badA((x) => { x.source.kind = 'nasa' }, 'id 前缀 asm: 与来源 nasa 不符', 'asm: 只收 user 来源')
  badA((x) => { x.source.kind = 'builtin' }, 'id 前缀 asm: 与来源 builtin 不符', 'asm: 不收 builtin')
  // 四条新规则
  badA((x) => { delete x.spec }, 'spec：装配件须带装配文档', 'asm: 缺装配文档')
  badA((x) => { x.spec = { kind: 'satellite' } }, 'spec：装配件须带装配文档', 'asm: 的 spec 不是装配文档')
  ok(S.validateMeta((() => { const x = clone(a0); delete x.spec; return x })(), { slim: true }).ok, 'manifest 精简条目（slim）缺 spec 不报')
  badA((x) => { x.frame.importQ = [0, 0, 0, 2] }, 'frame.importQ', 'importQ 非单位长')
  badA((x) => { x.frame.importQ = [0, 0, 1] }, 'frame.importQ', 'importQ 三元')
  badA((x) => { x.frame.importQ = 'q' }, 'frame.importQ', 'importQ 不是数组')
  const paramAsm = clone(a0); paramAsm.id = 'param:0123456789ab'; paramAsm.source = { kind: 'param', url: '', credit: '', license: '', redistributable: true }
  const vp = S.validateMeta(paramAsm)
  ok(!vp.ok && has(vp.errors, 'spec：装配文档只能配 asm: id'), `param: 带装配文档 → 报错（防 buildParamModel 静默退回成点）：${JSON.stringify(vp.errors)}`)
  const userAsm = clone(a0); userAsm.id = 'user:0123456789ab'
  ok(has(S.validateMeta(userAsm).errors, 'spec：装配文档只能配 asm: id'), 'user: 带装配文档 → 报错')
  const entAsm = clone(a0); entAsm.id = 'ent:a320neo'; entAsm.source = { kind: 'builtin', url: '', credit: '', license: 'param', redistributable: true }
  const ve = S.validateMeta(entAsm)
  ok(ve.ok, `ent:（实体模板运行时预览）带装配文档放行：${ve.errors.join('；')}`)
  const kindOff = clone(a0); kindOff.kind = 'spacecraft'
  const vk = S.validateMeta(kindOff)
  ok(vk.ok && has(vk.warnings, 'kind：装配领域 aircraft 应为 aircraft'), `kind 与领域不符 → 只告警：${JSON.stringify(vk.warnings)}`)
  const domOff = clone(a0); domOff.spec.domain = 'mars'
  ok(S.validateMeta(domOff).ok && S.validateMeta(domOff).warnings.length === 0, '领域认不出（装配文档自己的事）→ 不告警')
  const plainParam = S.validateMeta(S.defaultMeta({ id: 'param:default-sat', title: 'x', spec: { bus: {} } }))
  ok(!has(plainParam.errors, '装配'), '普通整星 spec 的 param: 不受影响')

  // importQ：normalizeMeta 放行（同一道模长门 + 符号规范化）/ 丢弃；不补缺省
  const fq = (iq) => S.normalizeMeta({ id: 'user:0123456789ab', frame: { q_model2body: [0, 0, 0, 1], importQ: iq } }).frame
  eq(fq([...BF.Q_STK]).importQ, [...BF.Q_STK], 'importQ 单位长原样保留')
  eq(fq([0, 0, 0, -1]).importQ, [0, 0, 0, 1], 'importQ 符号规范化（w ≥ 0）')
  near3(fq([0, 0, 0.612, 0.816]).importQ, [0, 0, 0.6, 0.8], 1e-12, 'importQ 近单位长（JSON 截断）重新归一')
  for (const b of [[0, 0, 0, 5], [0, 0, 1], [0, 0, 0, NaN], 'x', null, { 0: 1 }]) ok(!('importQ' in fq(b)), `importQ 丢弃：${JSON.stringify(b)}`)
  ok(!('importQ' in S.normalizeMeta({ id: 'user:0123456789ab' }).frame), '缺 importQ 不补缺省')
  const fq2 = fq([0.5, 0.5, 0.5, 0.5])
  eq(S.normalizeMeta({ id: 'user:0123456789ab', frame: fq2 }).frame, fq2, 'importQ 归一幂等')
  ok(S.validateMeta(S.normalizeMeta({ ...clone(a0), frame: { ...a0.frame, importQ: [0, 0, 0.612, 0.816] } })).ok, '归一后的 importQ 过校验')
  eq(S.slimMeta(a0).frame.importQ, [...BF.Q_YUP_ZENITH], 'slimMeta（manifest 精简条目）带着 frame.importQ')

  // 导入缺省：类别优先（DESIGN3 E5）
  eq(S.importDefaultQOf({ id: 'stk:0123456789ab', kind: 'aircraft' }), [...BF.Q_YUP_ZENITH], 'STK 飞机件 → +Y 天顶')
  eq(S.importDefaultQOf({ id: 'stk:0123456789ab', kind: 'spacecraft' }), [...BF.Q_STK], 'STK 卫星件 → STK 映射')
  eq(S.importDefaultQOf({ id: 'stk:0123456789ab' }), [...BF.Q_STK], 'STK 件不给 kind → STK 映射（与改前同）')
  for (const k of ['ground', 'ship', 'vehicle']) eq(S.importDefaultQOf({ id: 'stk:0123456789ab', kind: k, articulations: [{ name: 'a' }] }), [...BF.Q_YUP_ZENITH], `STK ${k} 件（带 AGI）→ +Y 天顶`)
  eq(S.importDefaultQOf({ id: 'param:default-sat', kind: 'vehicle' }), [...BF.Q_YUP_ZENITH], '类别胜过参数化来源')
  eq(S.normalizeMeta({ id: 'stk:0123456789ab', kind: 'ship', title: 'ship' }).frame.q_model2body, [...BF.Q_YUP_ZENITH], 'normalizeMeta 兜底同口径（STK 船件缺 q → +Y 天顶）')
  eq(S.normalizeMeta({ id: 'asm:0123456789ab', kind: 'aircraft' }).frame.q_model2body, [...BF.Q_YUP_ZENITH], '装配件缺 q 兜底 → +Y 天顶')

  // isAssemblySpec / asmModelRefs
  ok(S.isAssemblySpec({ kind: 'assembly' }) && !S.isAssemblySpec(null) && !S.isAssemblySpec([]) && !S.isAssemblySpec('assembly') && !S.isAssemblySpec({ kind: 'Assembly' }), 'isAssemblySpec 只认 kind = assembly 的对象')
  for (const b of [null, undefined, 3, 'x', [], {}, { comps: 'x' }, { comps: {} }]) eq(S.asmModelRefs(b), [], `asmModelRefs(${JSON.stringify(b)}) → []`)
  eq(S.asmModelRefs({ kind: 'assembly', comps: [
    null, 5, { id: 'a' }, { id: 'b', params: null }, { id: 'c', type: 'model', params: { modelId: 'stk:0123456789ab' } },
    { id: 'd', type: 'prim.box', params: { modelId: 'nasa:x' } }, { id: 'e', type: 'model', params: { modelId: 'stk:0123456789ab' } },
    { id: 'f', type: 'model', params: { modelId: '' } }, { id: 'g', type: 'model', params: { modelId: 7 } }, { id: 'h', type: 'veh.cotm.flat', params: { model: 'kymeta-u8' } }
  ] }), ['stk:0123456789ab', 'nasa:x', S.ASM_REF_UNRESOLVED], 'asmModelRefs：收模型 id、去重保序；modelId 给了却不是非空字符串 → 哨兵；别的参数（如 model 枚举）不是模型 id 不算')
  // 失败即关：模型 id 放在别的键名 / 嵌套里照样算；model 组件没有 modelId → 哨兵；数组 / 对象 modelId → 哨兵 + 里面的 id
  eq(S.asmModelRefs({ comps: [{ type: 'x', params: { model: 'stk:0123456789ab' } }] }), ['stk:0123456789ab'], '别名键 model')
  eq(S.asmModelRefs({ comps: [{ type: 'x', params: { ref: 'user:0123456789ab', modelID: 'nasa:iss' } }] }), ['user:0123456789ab', 'nasa:iss'], '别名键 ref / modelID')
  eq(S.asmModelRefs({ comps: [{ type: 'x', params: { a: { b: [{ c: 'stk:0123456789ab' }] } } }] }), ['stk:0123456789ab'], '嵌套')
  eq(S.asmModelRefs({ comps: [{ type: 'model', params: { modelId: ['stk:0123456789ab'] } }] }), [S.ASM_REF_UNRESOLVED, 'stk:0123456789ab'], '数组 modelId')
  eq(S.asmModelRefs({ comps: [{ type: 'model', params: { modelId: { id: 'stk:0123456789ab' } } }] }), [S.ASM_REF_UNRESOLVED, 'stk:0123456789ab'], '对象 modelId')
  eq(S.asmModelRefs({ comps: [{ type: 'model', params: {} }, { type: 'model' }] }), [S.ASM_REF_UNRESOLVED], 'model 组件没有 modelId → 哨兵')
  ok(!S.isValidModelId(S.ASM_REF_UNRESOLVED), '哨兵不是合法 id（目录里永远查不到）')
  eq(S.asmModelRefs(spec), [], '纯组件文档没有引用')

  // 绑定表：卫星可绑装配件 / 实体模板（3D 球按 id 取模型）
  const bAsm = S.validateBindings({ schema: 1, bindings: { 'norad:1': { model: { id: 'asm:0123456789ab' } }, 'norad:2': { model: { id: 'ent:a320neo' } }, 'norad:3': { model: { id: 'asm:XYZ' } } } })
  eq([bAsm.bindings.bindings['norad:1'].model.id, bAsm.bindings.bindings['norad:2'].model.id, bAsm.bindings.bindings['norad:3'].model.id], ['asm:0123456789ab', 'ent:a320neo', 'auto'], '绑定表收 asm: / ent:，坏 id 按 auto')
}

console.log(`modelSchema: ${pass} 项通过`)
