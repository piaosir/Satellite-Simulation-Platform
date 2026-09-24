// 模型库 manifest v2 自测（packages/core/models/manifest.mjs）。运行：node packages/core/test/modelManifest.test.mjs
//
// 为什么测：远端 manifest 是外来数据，直接决定下载什么、界面显示什么链接；内置 / 远端 / 本机三层合并决定用户看到哪一版。
// 钉死：① 地址规则（CDN 钉死、sha 与扩展白名单、原件镜像的文件名编码、models:// 协议路径正则）；② 远端校验
// 「坏条目丢弃、结构不对才整份拒」，并拒不可分发 / STK / 本机来源 / 非 http 链接，非 http 的尺寸出处清掉降为未核定；
// ③ 内置档位表只能指向真有的档；
// ④ 三层合并的优先级与「本机覆盖改不了文件与授权」；⑤ 坏输入不抛。
import assert from 'node:assert/strict'
import * as M from '../models/manifest.mjs'
import { defaultMeta, slimMeta } from '../models/schema.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const has = (list, frag) => list.some((s) => s.includes(frag))
const SHA = (c) => c.repeat(64)
const clone = (x) => JSON.parse(JSON.stringify(x))
const files3 = (a, b, c) => ({ lod0: { sha256: SHA(a), bytes: 100, tris: 10 }, lod1: { sha256: SHA(b), bytes: 50, tris: 5 }, lod2: { sha256: SHA(c), bytes: 20, tris: 2 } })
const entry = (id, extra = {}) => slimMeta(defaultMeta({ id, title: id, source: { kind: 'nasa', url: 'https://science.nasa.gov/3d-resources/x/' }, files: files3('a', 'b', 'c'), ...extra }))

// ① 地址
eq(M.CDN_BASE, 'https://update-1385987144.cos.ap-beijing.myqcloud.com/updates/models/', 'CDN_BASE 钉死（契约 §3.3）')
eq(M.MANIFEST_URL, M.CDN_BASE + 'manifest.json', 'manifest 地址')
eq(M.blobUrl(SHA('a'), 'glb'), `${M.CDN_BASE}blobs/${SHA('a')}.glb`, 'blob 地址')
eq(M.blobUrl(SHA('a'), 'webp'), `${M.CDN_BASE}blobs/${SHA('a')}.webp`, '缩略图 blob')
eq(M.blobUrl(SHA('A'), 'glb'), null, '大写 sha 拒')
eq(M.blobUrl('../../x', 'glb'), null, '路径穿越拒')
eq(M.blobUrl(SHA('a'), 'exe'), null, '扩展名白名单')
eq(M.nasaSrcUrl('tracking-and-data-relay-satellites-tdrs-a', 'Tracking and Data Relay Satellites (TDRS) (A).glb'),
  `${M.CDN_BASE}src/nasa/tracking-and-data-relay-satellites-tdrs-a/Tracking%20and%20Data%20Relay%20Satellites%20(TDRS)%20(A).glb`, '原件镜像：文件名按 URI 组件编码')
eq(M.nasaSrcUrl('ok', '../x.glb'), null, '原件文件名带斜杠拒')
eq(M.nasaSrcUrl('Bad Slug', 'x.glb'), null, 'slug 不合规拒')
eq(M.manifestVersionUrl('20260923-1'), `${M.CDN_BASE}manifest.20260923-1.json`, '不可变快照地址')
eq(M.manifestVersionUrl('a/b'), null, 'buildId 带斜杠拒')
eq(M.localUrl('blobs', SHA('a'), 'glb'), `models://blobs/${SHA('a')}.glb`, '本机地址')
eq(M.localUrl('etc', SHA('a'), 'glb'), null, 'host 白名单')
eq(M.PROTOCOL_HOSTS, ['blobs', 'user', 'builtin', 'thumbs'], '四个 host（契约 §4.1）')
ok(M.PROTOCOL_PATH_RE.test(`${SHA('0')}.png`) && !M.PROTOCOL_PATH_RE.test(`${SHA('0')}.glb/x`) && !M.PROTOCOL_PATH_RE.test(`${SHA('0')}.GLB`) && !M.PROTOCOL_PATH_RE.test('..%2f.glb'), '路径段正则：只一段、小写、三种扩展')
eq(M.parseLocalUrl(`models://thumbs/${SHA('b')}.webp?v=2#x`), { host: 'thumbs', file: `${SHA('b')}.webp`, sha: SHA('b'), ext: 'webp' }, '解析：查询串 / 片段忽略')
eq(M.parseLocalUrl(`models://BLOBS/${SHA('b')}.glb`).host, 'blobs', 'host 大小写不敏感（Chromium 标准 scheme 会转小写）')
eq(M.parseLocalUrl(`models://blobs/../${SHA('b')}.glb`), null, '多段路径拒')
eq(M.parseLocalUrl(`models://blobs/${SHA('B')}.glb`), null, '大写 sha 拒')
eq(M.parseLocalUrl(`http://blobs/${SHA('b')}.glb`), null, '别的 scheme 拒')
eq(M.parseLocalUrl(null), null, '非字符串')
ok(M.isAllowedProtocolPath('user', `${SHA('c')}.glb`) && !M.isAllowedProtocolPath('user', 'x.glb'), 'isAllowedProtocolPath')

// ② 远端校验
const good = entry('nasa:tdrs-a')
const remote = {
  schema: 2, buildId: '20260923-1', generatedAt: '2026-09-23T12:00:00Z', cdnBase: 'https://evil.example/',
  models: [
    good,
    { ...entry('nasa:goes'), injected: '<script>' },
    clone(good),                                                                                           // 重复 id
    { ...entry('nasa:x1'), source: { ...good.source, redistributable: false } },                           // 不可分发
    slimMeta(defaultMeta({ id: 'stk:0123456789ab', title: 'tdrs', files: { lod0: { sha256: SHA('f'), bytes: 1 } } })), // STK
    slimMeta(defaultMeta({ id: 'user:0123456789ab', title: 'u', source: { kind: 'user', redistributable: true }, files: { lod0: { sha256: SHA('f'), bytes: 1 } } })), // 本机
    { ...entry('nasa:x2'), source: { ...good.source, url: 'javascript:alert(1)' } },                        // 危险链接
    { ...entry('nasa:x3'), files: { ...good.files, lod1: { sha256: 'zz', bytes: 1 } } },                   // 坏 sha
    { ...entry('nasa:x4'), files: { lod0: good.files.lod0 } },                                             // 缺档
    'garbage',
    slimMeta(defaultMeta({ id: 'param:default-sat', title: 'Default satellite' }))                         // 参数化模板：无文件、可分发
  ]
}
const vr = M.validateManifest(remote, { remote: true })
ok(vr.ok, '结构对 → ok（坏条目只丢弃）')
eq(vr.models.map((x) => x.id), ['nasa:tdrs-a', 'nasa:goes', 'param:default-sat'], '只留合格条目，顺序不变')
eq(vr.errors.length, 8, '每个丢弃都记一条错误')
ok(has(vr.errors, 'id 重复') && has(vr.errors, '不可分发') && has(vr.errors, '本机来源') && has(vr.errors, 'http(s)') && has(vr.errors, 'sha256') && has(vr.errors, '三档'), '丢弃原因可读')
ok(!('injected' in vr.models[1]), '多塞的字段经 slimMeta 白名单滤掉')
ok(has(vr.warnings, 'cdnBase'), '远端 cdnBase 忽略并警告')
eq([vr.buildId, vr.generatedAt], ['20260923-1', '2026-09-23T12:00:00Z'], 'buildId / generatedAt')
const local = M.validateManifest(remote)
ok(local.models.some((x) => x.id === 'stk:0123456789ab') && local.models.some((x) => x.id === 'nasa:x2'), '非远端口径不拒本机来源 / 链接（本机层自己的数据）')
// 整份拒
eq(M.validateManifest(null).ok, false, 'null → 整份拒')
eq(M.validateManifest({ schema: 1, models: [] }).ok, false, 'schema 1 → 整份拒')
eq(M.validateManifest({ schema: 2, models: {} }).ok, false, 'models 不是数组 → 整份拒')
eq(M.validateManifest({ schema: 2, models: new Array(M.MAX_MANIFEST_MODELS + 1).fill(good) }).ok, false, '条目数超上限 → 整份拒')
const empty = M.validateManifest({ schema: 2, models: [] })
ok(empty.ok && empty.models.length === 0 && has(empty.warnings, 'buildId'), '空库合法、缺 buildId 只警告')
// 尺寸出处（units.sizeSource）也是会被渲染成链接的字段：远端非 http(s) 的清掉、降为未核定，条目留下
const SRC_OK = 'https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1983-026B'
const sized = (id, sizeSource) => entry(id, { units: { scaleToMeters: 0.5, unitGuess: 'unknown', sizeVerified: true, sizeSource } })
const vs = M.validateManifest({ schema: 2, models: [sized('nasa:s1', 'javascript:alert(1)'), sized('nasa:s2', SRC_OK), sized('nasa:s3', 'data:text/html,<b>x</b>'), sized('nasa:s4', 'NASM 展品页（存档）')] }, { remote: true })
eq(vs.models.map((x) => x.id), ['nasa:s1', 'nasa:s2', 'nasa:s3', 'nasa:s4'], '远端 sizeSource 不合规：条目不丢')
eq(vs.models.map((x) => [x.units.sizeVerified, x.units.sizeSource]), [[false, undefined], [true, SRC_OK], [false, undefined], [false, undefined]], '远端：非 http(s) 出处清掉、sizeVerified 置 false；http(s) 原样')
ok(vs.errors.length === 3 && vs.errors.every((e) => e.includes('sizeSource')), '每处清除记一条错误')
ok(vs.models.every((x) => !JSON.stringify(x).includes('javascript:') && !JSON.stringify(x).includes('data:text')), '输出里不再有危险链接')
const vsLocal = M.validateManifest({ schema: 2, models: [sized('nasa:s4', 'NASM 展品页（存档）')] })
eq(vsLocal.models[0].units.sizeSource, 'NASM 展品页（存档）', '非远端口径：纯文字出处保留（本机数据；渲染链接前另过 isHttpUrl）')
ok(M.isHttpUrl(SRC_OK) && M.isHttpUrl('HTTP://A.B/c') && !M.isHttpUrl('javascript:alert(1)') && !M.isHttpUrl('https://a b') && !M.isHttpUrl('//x.y/z') && !M.isHttpUrl(null) && !M.isHttpUrl('https://' + 'x'.repeat(3000)), 'isHttpUrl：只认无空白的 http(s) 绝对地址、有长度上限')

// ③ 内置档位表
const bi = M.validateManifest({ schema: 2, buildId: 'b1', builtin: ['lod2', 'thumb'], models: [good, { ...entry('nasa:goes'), builtin: ['lod2', 'lod1'] }] }, { builtin: true })
eq(bi.models.map((x) => x.builtin), [['lod2'], ['lod2', 'lod1']], '条目没写 builtin 用顶层缺省；缺 thumb 文件的档位剔掉')
ok(has(bi.warnings, 'thumb'), '指向不存在档位 → 警告')
ok(!('builtin' in M.validateManifest({ schema: 2, models: [{ ...good, builtin: ['lod2'] }] }).models[0]), '非内置口径不带 builtin')

// ④ 合并
const A_builtin = { ...entry('nasa:a', { files: files3('1', '2', '3') }), builtin: ['lod2'] }
const A_remote = entry('nasa:a', { files: files3('4', '5', '6') })
const B_remote = entry('nasa:b')
const A_user = { ...clone(A_remote), frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0], verified: true }, files: files3('7', '7', '7'), source: { ...A_remote.source, redistributable: false, license: 'hacked' }, parts: [{ id: 'p', role: 'bus' }] }
const C_user = slimMeta(defaultMeta({ id: 'user:0123456789ab', title: 'mine', files: { lod0: { sha256: SHA('9'), bytes: 3 } } }))
const inputs = clone({ A_builtin, A_remote, B_remote, A_user, C_user })
const merged = M.mergeManifests({ builtin: { schema: 2, models: [A_builtin] }, remote: [A_remote, B_remote, clone(B_remote)], user: [A_user, C_user] })
eq(merged.map((x) => [x.id, x.origin]), [['nasa:a', 'user'], ['nasa:b', 'remote'], ['user:0123456789ab', 'user']], '同 id 本机 > 远端 > 内置；位置按首次出现')
const a = merged[0]
eq([a.frame.verified, a.parts.length], [true, 1], '本机覆盖层的元数据生效')
eq(a.files, A_remote.files, '本机覆盖改不了 files（取下层）')
eq(a.source, A_remote.source, '本机覆盖改不了授权（取下层）')
eq([a.overridesId, a.builtin, a.builtinFiles.lod2.sha256], [true, ['lod2'], SHA('3')], '内置 lod2 仍可作来源（随包文件 sha 与远端不同也保留）')
ok(!('builtin' in merged[1]) && !('overridesId' in merged[1]), '纯远端条目无 builtin / overridesId')
ok(!('builtin' in merged[2]) && !('overridesId' in merged[2]), '纯本机条目无 builtin / overridesId')
eq(clone({ A_builtin, A_remote, B_remote, A_user, C_user }), inputs, '输入不被改动')
merged[0].files.lod0.bytes = 1
eq(A_remote.files.lod0.bytes, 100, '输出是深拷贝')
const onlyB = M.mergeManifests({ builtin: [A_builtin] })
eq([onlyB[0].origin, onlyB[0].builtinFiles], ['builtin', { lod2: A_builtin.files.lod2 }], '只有内置层')
const remoteOverBuiltin = M.mergeManifests({ builtin: [A_builtin], remote: [A_remote] })[0]
eq([remoteOverBuiltin.origin, remoteOverBuiltin.files.lod2.sha256, remoteOverBuiltin.builtinFiles.lod2.sha256], ['remote', SHA('6'), SHA('3')], '远端覆盖内置：files 用远端，内置文件另记')
eq(M.mergeManifests(), [], '无参数 → 空')
eq(M.mergeManifests({ builtin: 'x', remote: [null, { id: 'bad id' }], user: 7 }), [], '坏输入全跳过不抛')

console.log(`modelManifest: ${pass} 项通过`)
