// 卫星 3D 模型服务的纯决策层自测（electron/services/modelsLogic.js）。运行：node packages/core/test/modelsLogic.test.mjs
//
// 为什么测：模型下载、缓存淘汰、协议路径判定都在主进程里静默跑，出错没有界面反馈。这里钉死：
// ① models:// 路径白名单（host 四选一、单段、64 位小写 sha + 三种扩展名；穿越 / 大写 / 多段一律 400），
//    且与 packages/core/models/manifest.mjs 的 PROTOCOL_PATH_RE 逐字相同；
// ② LRU：超上限才淘汰、最久未用先走、60 s 内 ensure 过的与正在下载的不淘汰；
// ③ 下载状态机：每条合法迁移 + 非法迁移原样返回同一对象 + 退避 3 次后进 error；
// ④ ensure 选档：param 直出、缺档按 lod2<lod1<lod0 找已就绪、未就绪时下载 + 已就绪档作 fallback；
// ⑤ glb JSON 辅助：三角形计数、AGI 块原样摘下 / 贴回、导入路径白名单；
// ⑥ STK 判据（署名 / 无 extras.satsim 的 AGI 扩展 / 自声明）、STK 安装树路径、isInside（盘符根）；
// ⑦ 下载优先级（lod2 < thumb < lod1 < lod0）与「小件道」让道规则、preempt 迁移；
// ⑧ state.json 的 STK 目录记忆、覆盖层差量比较 sameJson。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path, { join } from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const L = require('../../../electron/services/modelsLogic.js')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }

const SHA = 'a'.repeat(64)
const SHA2 = 'b'.repeat(64)
const dirs = { user: 'U', bundle: 'B' }

// ① 协议路径白名单
{
  const r = L.resolveProtocolUrl(`models://blobs/${SHA}.glb`, dirs)
  eq([r.status, r.host, r.ext, r.files, r.contentType], [200, 'blobs', 'glb', [`U/blobs/${SHA}.glb`], 'model/gltf-binary'], 'blobs → userData/models/blobs')
  ok(/immutable/.test(r.cacheControl), 'blobs 内容寻址 → immutable')
  eq(L.resolveProtocolUrl(`models://user/${SHA}.glb`, dirs).files, [`U/user/${SHA}.glb`], 'user → userData/models/user')
  eq(L.resolveProtocolUrl(`models://builtin/${SHA}.glb`, dirs).files, [`B/builtin/${SHA}.glb`], 'builtin → resources/models/builtin')
  eq(L.resolveProtocolUrl(`models://thumbs/${SHA}.webp`, dirs).files, [`U/thumbs/${SHA}.webp`, `B/thumbs/${SHA}.webp`], 'thumbs 先本机后内置')
  eq(L.resolveProtocolUrl(`models://thumbs/${SHA}.webp`, dirs).contentType, 'image/webp', 'webp 类型')
  eq(L.resolveProtocolUrl(`models://thumbs/${SHA}.png`, dirs).contentType, 'image/png', 'png 类型')
  eq(L.resolveProtocolUrl(`models://BLOBS/${SHA}.glb`, dirs).status, 200, '主机名大小写不敏感（standard 协议 Chromium 会转小写）')
  eq(L.resolveProtocolUrl(`models://blobs/${SHA}.glb?x=1#y`, dirs).status, 200, '查询串 / 片段不影响')
  const bad = [
    'models://evil/' + SHA + '.glb', 'models://blobs/' + SHA.toUpperCase() + '.glb', 'models://blobs/' + SHA + '.gltf',
    'models://blobs/' + SHA.slice(1) + '.glb', 'models://blobs/x/' + SHA + '.glb', 'models://blobs/x/../../' + SHA + '.glb/..',
    'models://blobs/%2e%2e%2f' + SHA + '.glb', 'models://blobs/..%5c' + SHA + '.glb', 'models://blobs/', 'models://blobs', 'file:///C:/x.glb', 'not a url',
    'models://user/' + SHA + '.satsim.json', 'models://blobs/' + SHA + '.glb.part'
  ]
  for (const u of bad) eq(L.resolveProtocolUrl(u, dirs).status, 400, `非法 → 400：${u}`)
  // URL 解析先把点段消掉（Chromium 同样如此）：「../」根本到不了路径段判定，落点仍在 host 对应目录里
  eq(L.resolveProtocolUrl('models://blobs/../' + SHA + '.glb', dirs).files, [`U/blobs/${SHA}.glb`], '点段被 URL 解析吃掉，出不了 blobs 目录')
  eq(L.modelsUrl('blobs', SHA, 'glb'), `models://blobs/${SHA}.glb`, 'URL 拼法')
  eq(L.resolveProtocolUrl(L.modelsUrl('thumbs', SHA, 'webp'), dirs).status, 200, '拼出来的地址必能放行')
  // 与 manifest.mjs 对账：两份白名单必须逐字相同，否则「拼得出、放不行」
  const M = await import(pathToFileURL(join(import.meta.dirname, '../models/manifest.mjs')).href)
  eq([L.PROTOCOL_PATH_RE.source, L.PROTOCOL_PATH_RE.flags], [M.PROTOCOL_PATH_RE.source, M.PROTOCOL_PATH_RE.flags], 'PROTOCOL_PATH_RE 与 manifest.mjs 逐字相同')
  eq([...L.PROTOCOL_HOSTS], [...M.PROTOCOL_HOSTS], 'host 白名单与 manifest.mjs 相同')
  eq(L.modelsUrl('user', SHA, 'glb'), M.localUrl('user', SHA, 'glb'), 'URL 拼法与 manifest.localUrl 相同')
}

// ② LRU
{
  const cap = 1000
  const e = (key, bytes, lastUsed, lastEnsure) => ({ key, bytes, lastUsed, lastEnsure })
  const NOW = 10_000_000
  eq(L.pickEvictions([e('a', 400, 1), e('b', 500, 2)], { cap, now: NOW }).evict, [], '没超上限不淘汰')
  eq(L.pickEvictions([e('a', 400, 3), e('b', 500, 1), e('c', 300, 2)], { cap, now: NOW }).evict, ['b'], '超上限：最久未用先走，够了就停')
  eq(L.pickEvictions([e('a', 600, 3), e('b', 500, 1), e('c', 600, 2)], { cap, now: NOW }).evict, ['b', 'c'], '一次不够接着走第二旧的')
  eq(L.pickEvictions([e('a', 600, 3), e('b', 600, 1, NOW - 30_000), e('c', 600, 2)], { cap, now: NOW }).evict, ['c', 'a'], '60 s 内 ensure 过的（正在显示）跳过')
  eq(L.pickEvictions([e('a', 600, 3), e('b', 600, 1, NOW - 61_000)], { cap, now: NOW }).evict, ['b'], '超过 60 s 就不再保护')
  eq(L.pickEvictions([e('a', 600, 3), e('b', 600, 1)], { cap, now: NOW, busy: new Set(['b']) }).evict, ['a'], '正在下载的不淘汰')
  eq(L.pickEvictions([e('a', 600, 3), e('b', 600, undefined)], { cap, now: NOW }).evict, ['b'], '没记过 lastUsed 的当最旧')
  const all = L.pickEvictions([e('a', 800, 1, NOW), e('b', 800, 2, NOW)], { cap, now: NOW })
  eq([all.evict, all.after > cap], [[], true], '全在保护期：宁可超上限也不删正在显示的')
  eq(L.pickEvictions([e('a', 1200, 1)], { cap, now: NOW }).after, 0, 'after 为淘汰后总量')
}

// state.json 归一
{
  const s = L.normalizeState({ cap: 1, etag: 'W/"x"', entries: { [SHA + '.glb']: { lastUsed: 5 }, '../x': { lastUsed: 1 }, [SHA2 + '.webp']: { lastUsed: 'bad' } } })
  eq(s.cap, L.CAP_MIN, '上限钳到下限 256 MiB')
  eq(Object.keys(s.entries).sort(), [SHA + '.glb', SHA2 + '.webp'], '非法键丢弃')
  eq(s.entries[SHA2 + '.webp'].lastUsed, 0, '非法 lastUsed 归 0')
  eq(L.normalizeState(null).cap, 2 * 1024 ** 3, '缺省上限 2 GiB')
  eq(L.normalizeState('garbage').entries, {}, '垃圾输入 → 空账本')
  eq(L.clampCap(1e30), L.CAP_MAX, '上限封顶')
  eq(L.clampCap('abc'), L.DEFAULT_CACHE_CAP, '非数 → 缺省')
  eq(L.clampCap(5, 0), 5, '单测可放宽下限')
  const t = L.touchState(s, SHA + '.glb', 99)
  eq([t.entries[SHA + '.glb'].lastUsed, s.entries[SHA + '.glb'].lastUsed], [99, 5], 'touch 不改原对象')
  ok(L.touchState(s, 'bad', 1) === s, 'touch 非法键原样返回')
  eq(Object.keys(L.dropState(s, [SHA + '.glb']).entries), [SHA2 + '.webp'], 'drop')
}

// ③ 下载状态机
{
  let s = L.dlInitial()
  eq(s.phase, 'queued', '初态 queued')
  ok(L.dlReduce(s, { type: 'progress', received: 1 }) === s, 'queued 收 progress：非法迁移原样返回')
  s = L.dlReduce(s, { type: 'start' }); eq(s.phase, 'downloading', 'start → downloading')
  const p = L.dlReduce(s, { type: 'progress', received: 10, total: 100 })
  eq([p.received, p.total], [10, 100], 'progress 记字节')
  ok(L.dlReduce(p, { type: 'progress', received: 10, total: 100 }) === p, '同值 progress 不产生新对象（广播去重靠它）')
  s = L.dlReduce(p, { type: 'done' }); eq(s.phase, 'verifying', 'done → verifying')
  s = L.dlReduce(s, { type: 'verified' }); eq([s.phase, s.received], ['ready', 100], 'verified → ready，received 补满')
  ok(L.dlReduce(s, { type: 'cancel' }) === s, '终态收 cancel 不变')
  ok(L.dlReduce(s, { type: 'start' }) === s, '终态收 start 不变')

  // 失败退避：3 次重试后 error
  let f = L.dlReduce(L.dlInitial(), { type: 'start' })
  const phases = []
  for (let i = 0; i < 4; i++) {
    f = L.dlReduce(f, { type: 'fail', message: 'x' + i })
    phases.push(f.phase + f.attempt)
    if (f.phase === 'waiting') { f = L.dlReduce(f, { type: 'retry' }); f = L.dlReduce(f, { type: 'start' }) }
  }
  eq(phases, ['waiting1', 'waiting2', 'waiting3', 'error3'], '失败 → 退避重试 3 次 → error')
  eq(f.message, 'x3', 'error 带最后一次的原因')
  eq(L.dlReduce(L.dlReduce(L.dlInitial(), { type: 'start' }), { type: 'fail', retriable: false, message: '404' }).phase, 'error', '不可重试的失败直接 error')
  const v = L.dlReduce(L.dlReduce(L.dlReduce(L.dlInitial(), { type: 'start' }), { type: 'done' }), { type: 'fail', message: 'sha' })
  eq(v.phase, 'waiting', '校验失败（sha 不符）也进退避')
  for (const ph of ['queued', 'downloading', 'verifying', 'waiting']) {
    eq(L.dlReduce({ ...L.dlInitial(), phase: ph }, { type: 'cancel' }).phase, 'canceled', `${ph} + cancel → canceled`)
  }
  eq([L.retryDelay(1), L.retryDelay(2), L.retryDelay(3), L.retryDelay(4), L.retryDelay(0)], [1500, 3000, 6000, null, null], '退避 1.5 / 3 / 6 s，超次数 null')
}

// ④ ensure 选档
{
  eq(L.lodOrder('lod0'), ['lod0', 'lod1', 'lod2'], 'lod0：往粗走')
  eq(L.lodOrder('lod1'), ['lod1', 'lod2', 'lod0'], 'lod1：先粗后细')
  eq(L.lodOrder('lod2'), ['lod2', 'lod1', 'lod0'], 'lod2：没有更粗的，往细走')
  eq(L.lodOrder('bogus'), ['lod2', 'lod1', 'lod0'], '非法档按 lod2')
  const f3 = { lod0: { sha256: SHA }, lod1: { sha256: SHA2 }, lod2: { sha256: 'c'.repeat(64) } }
  const plan = (o) => L.planEnsure({ id: 'nasa:x', lod: 'lod2', meta: { files: f3 }, ready: () => false, downloadable: true, ...o })
  eq(L.planEnsure({ id: 'param:default-sat', lod: 'lod2', meta: null }), { kind: 'param' }, 'param: 直接 param')
  eq(plan({ meta: null }), { kind: 'missing' }, '没有条目 → missing')
  eq(plan({ meta: { files: {} } }), { kind: 'missing' }, '没有任何档 → missing')
  eq(plan({ meta: { files: { lod0: { sha256: 'short' } } } }), { kind: 'missing' }, 'sha 非法的档不算')
  eq(plan({ ready: (l) => l === 'lod2' }), { kind: 'ready', lod: 'lod2' }, '请求档就绪 → ready')
  eq(plan({ lod: 'lod0', ready: (l) => l === 'lod2' }), { kind: 'download', lod: 'lod0', fallback: 'lod2' }, '请求档没下 → 下它，已就绪的最近一档作 fallback')
  eq(plan({ lod: 'lod1', ready: (l) => l !== 'lod1' }), { kind: 'download', lod: 'lod1', fallback: 'lod2' }, 'fallback 按 lodOrder：lod1 先找 lod2')
  eq(plan({ lod: 'lod0' }), { kind: 'download', lod: 'lod0' }, '一档都没就绪 → 只下载')
  eq(plan({ lod: 'lod0', ready: (l) => l === 'lod1', downloadable: false }), { kind: 'ready', lod: 'lod1' }, '离线 / 本机件不下载：有就绪的就先用它')
  eq(plan({ lod: 'lod0', downloadable: false }), { kind: 'missing' }, '离线且一档都没有 → missing')
  const onlyL0 = { files: { lod0: { sha256: SHA } } }
  eq(L.planEnsure({ id: 'user:aaaaaaaaaaaa', lod: 'lod2', meta: onlyL0, ready: () => true, downloadable: false }), { kind: 'ready', lod: 'lod0' }, '缺档（本机导入只有 lod0）→ 降到有的那档')
  const onlyL2 = { files: { lod2: { sha256: SHA } } }
  eq(L.planEnsure({ id: 'nasa:x', lod: 'lod0', meta: onlyL2, ready: () => true, downloadable: true }), { kind: 'ready', lod: 'lod2' }, '缺档（只有 lod2）→ 用 lod2')
}

// ⑤ glb JSON 辅助
{
  const json = {
    accessors: [{ count: 36 }, { count: 24 }, { count: 6 }, { count: 5 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }, { primitives: [{ attributes: { POSITION: 2 } }, { attributes: { POSITION: 3 }, mode: 5 }, { attributes: { POSITION: 3 }, mode: 1 }] }],
    nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 1 }, {}]
  }
  eq(L.countTris(json), 12 + 12 + (2 + 3), '三角形：索引 /3、无索引按顶点 /3、strip n-2、线不计；按节点实例累加')
  eq(L.countTris({ accessors: [{ count: 9 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }), 3, '没有节点引用时按网格本身算')
  eq(L.countTris(null), 0, '垃圾输入 → 0')

  const src = {
    extensionsUsed: ['AGI_articulations', 'AGI_stk_metadata', 'KHR_x'],
    extensions: { AGI_articulations: { articulations: [{ name: 'SA', stages: [{ name: 'Yaw', type: 'zRotate', minimumValue: -1, maximumValue: 1, initialValue: 0, future: 7 }] }] }, AGI_stk_metadata: { solarPanelGroups: [{ name: 'G', efficiency: 28 }] }, KHR_x: {} },
    nodes: [
      { name: 'Body' },
      { name: 'AP1', extensions: { AGI_articulations: { isAttachPoint: true } } },
      { name: 'Wing', extensions: { AGI_articulations: { articulationName: 'SA' }, AGI_stk_metadata: { solarPanelGroupName: 'G', noObscuration: true }, KHR_y: {} } }
    ]
  }
  const raw = L.extractAgiRaw(src)
  eq(Object.keys(raw.root).sort(), ['AGI_articulations', 'AGI_stk_metadata'], '只摘 AGI 两个根扩展')
  eq(Object.keys(raw.nodes).sort(), ['AP1', 'Wing'], '按节点名摘')
  eq(raw.root.AGI_articulations.articulations[0].stages[0].future, 7, '原样摘（不认识的字段也在）')
  ok(!('KHR_y' in raw.nodes.Wing), '别的扩展不摘')
  // gltf-transform 写回后：节点顺序变了、AGI 全丢
  const after = { asset: { version: '2.0' }, nodes: [{ name: 'Wing' }, { name: 'Body' }, { name: 'AP1' }, { name: 'New' }] }
  const { json: back, missing } = L.applyAgiRaw(after, raw)
  eq(back.nodes[0].extensions, { AGI_articulations: { articulationName: 'SA' }, AGI_stk_metadata: { solarPanelGroupName: 'G', noObscuration: true } }, '按名贴回（顺序变了也对得上）')
  eq(back.nodes[2].extensions, { AGI_articulations: { isAttachPoint: true } }, '挂点贴回')
  eq(back.extensions, raw.root, '根扩展贴回')
  eq(back.extensionsUsed.sort(), ['AGI_articulations', 'AGI_stk_metadata'], 'extensionsUsed 登记')
  eq(missing, [], '无对不上的节点')
  ok(!after.nodes[0].extensions, '贴回不改入参')
  eq(L.applyAgiRaw({ nodes: [{ name: 'X' }] }, raw).missing.sort(), ['AP1', 'Wing'], '对不上的节点名报出来')
  eq(L.extractAgiRaw({ nodes: [{ name: 'a' }] }), null, '没有 AGI → null')
  eq(L.applyAgiRaw({ a: 1 }, null).json, { a: 1 }, 'raw 为空原样返回')

  eq(L.countAgiRaw(src), { nodes: 3, attachPoints: 1, articulations: 1, solarPanelGroups: 1 }, 'AGI 纯计数')
  eq(L.countAgiRaw(src, { AGI_articulations: { attachPoints: ['Body', 'Wing'] } }).attachPoints, 2, '.gmdf 旁车在就以旁车为准')

  ok(L.looksLikeStk({ asset: { copyright: 'Copyright 2019 Analytical Graphics, Inc.' } }), 'AGI 版权 → STK')
  ok(L.looksLikeStk({ asset: { copyright: '© Ansys Government Initiatives' } }), 'Ansys → STK')
  ok(!L.looksLikeStk({ asset: { generator: 'Khronos glTF Blender I/O' } }), '没署名、没 AGI 扩展 → 不是')
  ok(!L.looksLikeStk(null), '垃圾输入 → 不是')
}

// ⑥ STK 判据（授权闸：普通导入 / saveImported / 导出兜底共用）
{
  const AGI = 'Copyright 2019 Analytical Graphics, Inc.'
  const ours = { source: { kind: 'user', redistributable: true } }
  eq(L.stkReason({ asset: { copyright: AGI } }), 'copyright', '署名 → copyright')
  // 本机 STK 12 的 cubesat_1.5u/2u/3u… 10 个 glb 没有 copyright，但都登记了 AGI_articulations
  eq(L.stkReason({ asset: { version: '2.0', generator: 'Khronos glTF Blender I/O v1.2.75' }, extensionsUsed: ['AGI_articulations', 'AGI_stk_metadata'] }), 'agi-ext', '无署名、登记了 AGI 扩展 → agi-ext')
  eq(L.stkReason({ extensions: { AGI_articulations: {} } }), 'agi-ext', '只有根级扩展也算')
  eq(L.stkReason({ nodes: [{ name: 'a' }, { name: 'b', extensions: { AGI_stk_metadata: {} } }] }), 'agi-ext', 'extensionsUsed 漏登记、只挂在节点上也算')
  eq(L.stkReason({ extensionsUsed: ['AGI_future_thing'] }), 'agi-ext', '任何 AGI_* 扩展都算')
  eq(L.stkReason({ extensionsUsed: ['AGI_articulations'], extras: { satsim: ours } }), null, '本工具导出的件（有 extras.satsim）：AGI 扩展是自己写的')
  eq(L.stkReason({ extras: { satsim: { source: { kind: 'stk-local' } } } }), 'satsim-declared', 'extras.satsim 自称 stk-local')
  eq(L.stkReason({ extras: { satsim: { source: { kind: 'user', redistributable: false } } } }), 'satsim-declared', 'extras.satsim 自称不可再分发')
  eq(L.stkReason({ extras: { satsim: { id: 'stk:0123456789ab' } } }), 'satsim-declared', 'extras.satsim 的 id 是 stk:')
  eq(L.stkReason({ asset: { copyright: AGI }, extras: { satsim: ours } }), 'copyright', '署名优先：加个 extras.satsim 洗不掉')
  eq(L.stkReason({ extensionsUsed: ['KHR_materials_unlit', 'EXT_meshopt_compression'], nodes: [{ extensions: { KHR_x: {} } }] }), null, '别的扩展不算')
  eq([L.stkReason(null), L.stkReason('x'), L.stkReason({ extras: { satsim: [1] }, extensionsUsed: ['AGI_articulations'] })], [null, null, 'agi-ext'], '垃圾输入不抛；extras.satsim 不是对象 = 没有')
  ok(L.looksLikeStk({ extensionsUsed: ['AGI_articulations'] }) && !L.looksLikeStk({ extensionsUsed: ['AGI_articulations'], extras: { satsim: ours } }), 'looksLikeStk = stkReason 非空')

  const DEF = 'C:\\Program Files\\AGI\\STK 12\\STKData\\VO\\Models'
  ok(L.isStkPath(DEF + '\\Space\\cubesat_3u.glb', [DEF]), '默认 STK 目录下')
  ok(L.isStkPath('c:/program files/agi/stk 12/stkdata/vo/models/space/x.glb', []), '正斜杠、小写也认')
  ok(L.isStkPath('D:\\Apps\\AGI\\STK 11\\Data\\x.glb', []), '别的盘、别的版本的 AGI\\STK* 安装树')
  ok(L.isStkPath('E:\\backup\\STKData\\VO\\Models\\x.glb', []), '路径段里有 STKData')
  ok(L.isStkPath('E:\\mine\\models\\sub\\x.glb', ['E:\\mine\\models\\']), 'dirs 前缀（结尾分隔符无所谓）')
  ok(!L.isStkPath('E:\\mine\\models2\\x.glb', ['E:\\mine\\models']), '前缀比较补分隔符：models 吃不掉 models2')
  ok(!L.isStkPath('E:\\my-stkdata-copy\\x.glb', []), '段内子串不算')
  ok(!L.isStkPath('D:\\nasa\\goes.glb', [DEF]) && !L.isStkPath('', [DEF]) && !L.isStkPath(null), '别处 / 空 → 不是')

  const w = path.win32
  ok(L.isInside('C:\\', 'C:\\Models\\Space\\a.glb', w), '盘符根做基准也对（旧写法 startsWith(base + sep) 拼成 C:\\\\，全判非法）')
  ok(L.isInside('C:\\STK\\Models', 'C:\\STK\\Models\\Space\\a.glb', w), '子目录里')
  ok(!L.isInside('C:\\STK\\Models', 'C:\\STK\\Models', w), '基准本身不算')
  ok(!L.isInside('C:\\STK\\Models', 'C:\\STK\\Models2\\a.glb', w), '兄弟目录不算')
  ok(!L.isInside('C:\\STK\\Models', 'C:\\STK\\a.glb', w), '上一级不算')
  ok(!L.isInside('C:\\STK\\Models', 'D:\\STK\\Models\\a.glb', w), '跨盘不算')
  ok(L.isInside('C:\\STK\\Models', 'C:\\STK\\Models\\..foo.glb', w), '以 .. 开头的文件名不是上跳')
  ok(L.isInside('/a', '/a/b/c.glb', path.posix) && !L.isInside('/a', '/b/c.glb', path.posix), 'posix 同理')
}

// ⑦ 下载优先级与让道
{
  eq(['lod2', 'thumb', 'lod1', 'lod0', 'bogus'].map(L.dlPriority), [0, 1, 2, 3, 3], '优先级：lod2 < thumb < lod1 < lod0（未知按 lod0）')
  const J = (name, prio, seq) => ({ name, prio, seq })
  eq(L.pickNextJob([J('a', 3, 1), J('b', 0, 5), J('c', 0, 2)]).name, 'c', '先按档、同档按 seq（先来先走）')
  eq(L.pickNextJob([J('a', 2, 1), J('b', 2, -3)]).name, 'b', '再次 ensure 的挪到本档队首（负 seq）')
  eq([L.pickNextJob([]), L.pickNextJob(null)], [null, null], '空队列 → null')
  const A = (name, prio, startedAt, phase = 'downloading', preempting = false) => ({ name, prio, startedAt, phase, preempting })
  eq(L.pickPreempt([A('x', 3, 1), A('y', 3, 2)], J('s', 0, 1)).name, 'y', '两道全是 lod0、lod2 在等：最后开工的那个让道')
  eq(L.pickPreempt([A('x', 3, 5), A('y', 2, 9)], J('s', 1, 1)).name, 'x', 'lod0 先于 lod1 让道；缩略图也算小件')
  eq(L.pickPreempt([A('x', 3, 1), A('y', 3, 2)], J('b', 2, 1)), null, '等着的是大件：不抢')
  eq(L.pickPreempt([A('x', 0, 1), A('y', 3, 2)], J('s', 0, 1)), null, '道上已有小件：等它下完就轮到')
  eq(L.pickPreempt([A('x', 3, 1), A('y', 3, 2, 'verifying')], J('s', 0, 1)), null, '有一条道在校验、马上腾出：不抢')
  eq(L.pickPreempt([A('x', 3, 1), A('y', 3, 2, 'downloading', true)], J('s', 0, 1)), null, '已有一个在让道途中：一次只让一个')
  eq([L.pickPreempt([], J('s', 0, 1)), L.pickPreempt([A('x', 3, 1)], null)], [null, null], '空 → null')

  const d = L.dlReduce(L.dlReduce(L.dlInitial(), { type: 'start' }), { type: 'progress', received: 50, total: 100 })
  const pre = L.dlReduce(d, { type: 'preempt' })
  eq([pre.phase, pre.received, pre.total, pre.attempt], ['queued', 50, 100, 0], 'downloading + preempt → queued：已收字节、重试次数不变')
  eq(L.dlReduce(L.dlReduce(pre, { type: 'start' }), { type: 'progress', received: 60, total: 100 }).received, 60, '让道后照常再开工')
  for (const ph of ['queued', 'verifying', 'waiting', 'ready', 'error', 'canceled']) {
    const s = { ...L.dlInitial(), phase: ph }
    ok(L.dlReduce(s, { type: 'preempt' }) === s, `${ph} 收 preempt：原样返回`)
  }
}

// ⑧ state.json 的 STK 目录记忆 / 覆盖层差量比较
{
  eq(L.normalizeState({ stkDirs: ['D:\\STK', 'D:\\STK', 5, '', 'x'.repeat(2000), 'E:\\M'] }).stkDirs, ['D:\\STK', 'E:\\M'], 'stkDirs 归一：去重、丢非串 / 空 / 超长')
  eq([L.normalizeState(null).stkDirs, L.normalizeState({ stkDirs: 'x' }).stkDirs], [[], []], '缺省空')
  let r = L.rememberStkDir(L.normalizeState(null), 'D:\\A')
  r = L.rememberStkDir(r, 'D:\\B')
  eq(r.stkDirs, ['D:\\B', 'D:\\A'], '最近的在前')
  ok(L.rememberStkDir(r, 'd:/b/') === r, '同一目录（大小写 / 斜杠 / 结尾分隔符不同）已在最前 → 原样返回（不触发写盘）')
  eq(L.rememberStkDir(r, 'd:\\a').stkDirs, ['d:\\a', 'D:\\B'], '已记过的挪到最前、不重复')
  let many = L.normalizeState(null)
  for (let i = 0; i < 12; i++) many = L.rememberStkDir(many, 'D:\\S' + i)
  eq([many.stkDirs.length, many.stkDirs[0]], [L.MAX_STK_DIRS, 'D:\\S11'], `封顶 ${L.MAX_STK_DIRS} 条`)
  ok(L.rememberStkDir(r, '') === r, '空串不记')

  ok(L.sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), 'sameJson：键序无关')
  ok(!L.sameJson({ a: 1 }, { a: 1, b: 2 }) && !L.sameJson([1, 2], [2, 1]) && !L.sameJson(null, {}) && !L.sameJson(1, '1'), 'sameJson：不同就是不同')
  ok(L.sameJson({ a: 1, b: undefined }, { a: 1 }) && L.sameJson(null, null) && L.sameJson([], []), 'sameJson：undefined 键当没有')
}

// 其它小工具
{
  eq(L.safeRel('Space/tdrs.glb'), 'Space/tdrs.glb', '相对路径放行')
  eq(L.safeRel('Space\\tdrs.GLB'), 'Space/tdrs.GLB', '反斜杠归一、扩展名大小写不敏感')
  for (const b of ['../x.glb', 'Space/../../x.glb', 'C:/x.glb', '/etc/x.glb', '\\\\host\\x.glb', 'Space/x.mdl', '', './x.glb', 'a//b.glb']) eq(L.safeRel(b), null, `STK 路径拒绝：${b}`)
  eq(['a.step', 'b.STP', 'c.iges', 'd.IGS', 'e.brep', 'f.glb', 'g'].map(L.cadKind), ['step', 'step', 'iges', 'iges', 'brep', null, null], 'CAD 格式识别')
  // STK 类别 → kind（DESIGN3 E5/E6：Air → 飞机、Sea → 船、Land 按路径分地球站 / 车辆；本机 STK 12 实测目录）
  eq(['Space', 'Missiles', 'Air', 'Sea', 'Facility', 'facilities', 'Land', 'Other', ''].map((c) => L.stkKind(c)),
    ['spacecraft', 'launcher', 'aircraft', 'ship', 'ground', 'ground', 'vehicle', 'other', 'other'], 'STK 类别 → kind（不给路径时 Land 按车辆）')
  eq([
    ['Land', 'Land/facility.glb'], ['Land', 'Land/groundvehicle.glb'], ['Land', 'Land/lunar_boulder.glb'], ['Land', 'Land/lunar_module.glb'],
    ['land', 'Land/Facility/big_dish.glb'], ['Land', 'Land/SatComFacility.GLB'], ['Land', 'facility.glb'], ['Land', 'Land\\facility.glb'],
    ['Air', 'Air/c-130_hercules.glb'], ['Air', 'Air/facility.glb'], ['Sea', 'Sea/ship.glb'], ['Space', 'Space/facility.glb'], ['Missiles', 'Missiles/missile.glb']
  ].map(([c, rel]) => L.stkKind(c, rel)), [
    'ground', 'vehicle', 'vehicle', 'vehicle',
    'ground', 'ground', 'ground', 'ground',
    'aircraft', 'aircraft', 'ship', 'spacecraft', 'launcher'
  ], 'STK Land 目录：路径（子目录 / 文件名）含 facility → 地球站，其余 → 车辆；别的类别不看路径')
  ok(L.stkKind('Land', 'Land/facility_x/tank.glb') === 'ground' && L.stkKind('Land', 'Land/vehicles/truck.glb') === 'vehicle', 'Land 子目录名参与判断')
  eq(L.sanitizeTarget({ tab: 'model', modelId: 'nasa:x', satKey: 'norad:1', evil: () => 1 }), { tab: 'model', modelId: 'nasa:x', satKey: 'norad:1' }, 'modelwb:open 目标只收三个字段')
  eq(L.sanitizeTarget({ tab: 5 }), null, '字段类型不对 → null')
  eq(L.sanitizeTarget(null), null, '空 → null')
  eq(L.idToFileStem('nasa:ssl-1300~2'), 'nasa%3Assl-1300~2', 'id → 文件名（冒号转义）')
  ok(!/[:\\/*?"<>|]/.test(L.idToFileStem('a:b/c\\d*e')), '转义后无 Windows 非法字符')
  eq(L.parseContentRange('bytes 100-199/1000'), { start: 100, end: 199, total: 1000 }, 'Content-Range')
  eq(L.parseContentRange('bytes 0-9/*'), { start: 0, end: 9, total: null }, 'Content-Range 总长未知')
  eq(L.parseContentRange('junk'), null, 'Content-Range 非法')
  eq([L.hdr({ a: ['x', 'y'] }, 'a'), L.hdr({ a: 'z' }, 'a'), L.hdr(null, 'a')], ['x', 'z', undefined], '响应头取值（net 数组 / https 字符串）')
  const th = L.makeThrottle(200)
  eq([th(0), th(100), th(199, true), th(250), th(399), th(450)], [true, false, true, false, true, false], '进度节流 ≥ 200 ms，终态强制放行')
  const glbHead = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0, 0, 0, 0])
  ok(L.isGlb(glbHead), 'glb 头')
  ok(!L.isGlb(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0, 0, 0, 0, 0])), 'glb v1 不认')
  ok(!L.isGlb(new Uint8Array(4)), '太短不认')
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  ok(L.isWebp(webp) && !L.isWebp(glbHead), 'WebP 头')
}

console.log(`modelsLogic: ${pass} 项通过`)
