// GLB 容器拆包 / 打包 / 只改 JSON 自测（packages/core/models/glb.mjs）。运行：node packages/core/test/modelGlb.test.mjs
//
// 为什么测：STK 模型的 AGI 扩展只能靠「只改 JSON 块、BIN 逐字节不动」保住（gltf-transform 会丢未知扩展，契约 T5）；
// 拆包再打包若差一个字节，要么 STK 读不了，要么 sha256 内容寻址全乱。这里钉死：
// ① 6 个 NASA 夹具拆 → 原样包 逐字节相等；② patch 后 BIN 不变、4 字节对齐、总长回填；③ 只读前缀的头读取
// （STK 扫描用）逐步给出 needBytes；④ 补齐规则（JSON 空格、BIN 0）、NUL 补齐 / BOM / 未知块的野文件也能逐字节回环；
// ⑤ 坏文件返回错误不抛；⑥ 不解网格的近似包围盒对得上语料报告的数；世界矩阵在 2 万层深链 / 大环上不爆栈。
// 全语料（213 个）逐字节回环的验证在开发机上另跑过（见实施报告），单测只用夹具，不碰 .models-src。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as G from '../models/glb.mjs'

let pass = 0
const ok = (c, msg) => { assert.ok(c, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }
const bytesEq = (a, b) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
const fixture = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/models/${n}`, import.meta.url)))
const u32 = (u8, off) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(off, true)

const FIX = ['satkit-wings-3.glb', 'satkit-radio-1.glb', 'tdrs-a.glb', 'goes.glb', 'ssl-1300.glb', 'cubesat-1ru.glb']

// ① 逐字节回环 + ② patch
for (const f of FIX) {
  const u8 = fixture(f)
  const p = G.parseGlb(u8)
  ok(p.ok, `${f} 拆包`)
  eq([p.version, p.length, p.warnings.length, p.extraChunks.length], [2, u8.byteLength, 0, 0], `${f} 头字段 / 合规`)
  ok(p.bin instanceof Uint8Array && p.bin.byteLength % 4 === 0, `${f} BIN 块按 4 字节对齐`)
  ok(bytesEq(G.buildGlb(p.jsonText, p.bin, { extraChunks: p.extraChunks }), u8), `${f} 拆 → 原样包 逐字节相等`)

  const r = G.patchGlbJson(u8, (j) => { j.extras = { ...(j.extras || {}), satsim: { id: 'nasa:x', 中文: '测试' } } })
  ok(r.ok && r.changed, `${f} patch 成功`)
  const q = G.parseGlb(r.glb)
  ok(q.ok && bytesEq(q.bin, p.bin), `${f} patch 后 BIN 逐字节不变`)
  eq(q.json.extras.satsim, { id: 'nasa:x', 中文: '测试' }, `${f} patch 写入 extras.satsim（含中文 UTF-8）`)
  ok(u32(r.glb, 8) === r.glb.byteLength && r.glb.byteLength % 4 === 0 && u32(r.glb, 12) % 4 === 0, `${f} patch 后总长回填、块长对齐`)
  eq({ ...q.json, extras: p.json.extras }, { ...p.json, extras: p.json.extras }, `${f} patch 不动其它 JSON 字段`)

  // ③ 前缀读取
  const h0 = G.readGlbHeaderJson(u8.subarray(0, 10))
  eq(h0, { ok: false, needBytes: 20 }, `${f} 前缀 10 字节 → 需要 20`)
  const h1 = G.readGlbHeaderJson(u8.subarray(0, 20))
  ok(!h1.ok && h1.needBytes === 20 + u32(u8, 12), `${f} 前缀 20 字节 → 需要 20 + JSON 块长`)
  const h2 = G.readGlbHeaderJson(u8.subarray(0, h1.needBytes))
  ok(h2.ok && h2.jsonText === p.jsonText && h2.binOffset === null, `${f} 前缀刚好盖住 JSON 块：拿到 JSON，BIN 未知`)
  const h3 = G.readGlbHeaderJson(u8.subarray(0, h1.needBytes + 8))
  ok(h3.ok && h3.binOffset === h1.needBytes + 8 && h3.binLength === p.bin.byteLength, `${f} 前缀多 8 字节：顺带给出 BIN 位置`)
}

// 不改（fn 返回 false）→ 原样拷贝
const tdrs = fixture('tdrs-a.glb')
const same = G.patchGlbJson(tdrs, () => false)
ok(same.ok && !same.changed && bytesEq(same.glb, tdrs) && same.glb.buffer !== tdrs.buffer, 'fn 返回 false：原样返回拷贝')
const repl = G.patchGlbJson(tdrs, (j) => ({ ...j, asset: { ...j.asset, generator: 'satsim' } }))
ok(repl.ok && G.parseGlb(repl.glb).json.asset.generator === 'satsim', 'fn 返回新对象也行')

// ④ 补齐规则与野文件
const g5 = G.buildGlb('{"a":1}', new Uint8Array([1, 2, 3, 4, 5]))
eq(Array.from(g5.subarray(20, 28)), [...Buffer.from('{"a":1}'), 0x20], 'JSON 块尾用空格补齐')
eq(u32(g5, 12), 8, 'JSON 块长含补齐')
eq(u32(g5, 28), 8, 'BIN 块长含补齐')
eq(Array.from(g5.subarray(36, 44)), [1, 2, 3, 4, 5, 0, 0, 0], 'BIN 块尾用 0 补齐')
eq([u32(g5, 8), g5.byteLength % 4], [g5.byteLength, 0], '总长回填、整体对齐')
const noBin = G.parseGlb(G.buildGlb({ asset: { version: '2.0' } }))
ok(noBin.ok && noBin.bin === null, 'bin=null → 不写 BIN 块')
const emptyBin = G.parseGlb(G.buildGlb({ asset: { version: '2.0' } }, new Uint8Array(0)))
ok(emptyBin.ok && emptyBin.bin && emptyBin.bin.byteLength === 0, '空数组 → 写一个 0 长 BIN 块')
eq(G.parseGlb(G.buildGlb({ asset: { version: '2.0' }, 名: '卫星' }, new Uint8Array(8).fill(7))).json.名, '卫星', '对象 JSON 打包 → 拆包还原')

// 手造野文件：JSON 用 NUL 补齐、带 BOM、BIN 后跟一个未知块——规范外但见过，必须能读、且逐字节回环
const craft = (jsonBytes, bin, extra) => {
  const parts = [], push = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); parts.push(h, data) }
  push(G.CHUNK_JSON, jsonBytes)
  if (bin) push(G.CHUNK_BIN, bin)
  if (extra) push(extra.type, extra.data)
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(12); head.writeUInt32LE(G.GLB_MAGIC, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8)
  return new Uint8Array(Buffer.concat([head, body]))
}
const wild = craft(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"asset":{"version":"2.0"}}'), Buffer.from([0, 0])]), Buffer.alloc(4, 9), { type: 0x12345678, data: Buffer.from([1, 2, 3, 4]) })
const pw = G.parseGlb(wild)
ok(pw.ok && pw.json.asset.version === '2.0', 'NUL 补齐 + BOM 的 JSON 块能解析')
eq([pw.extraChunks.length, pw.extraChunks[0].type, pw.warnings.length], [1, 0x12345678, 1], '未知块原样保留并记警告')
ok(bytesEq(G.buildGlb(pw.jsonText, pw.bin, { extraChunks: pw.extraChunks }), wild), 'NUL 补齐 / BOM / 未知块的文件也逐字节回环')
const pwp = G.patchGlbJson(wild, (j) => { j.x = 1 })
ok(pwp.ok && G.parseGlb(pwp.glb).extraChunks.length === 1, 'patch 保留未知块')
const tail = new Uint8Array(tdrs.byteLength + 4); tail.set(tdrs)
const pt = G.parseGlb(tail)
ok(pt.ok && pt.warnings.some((w) => w.includes('多出 4 字节')), '文件尾多余字节：能读、记警告')

// ⑤ 坏文件
const bad = (u8, msg) => { const r = G.parseGlb(u8); assert.ok(!r.ok && typeof r.error === 'string' && r.error, msg); pass++ }
bad('glTF', '字符串输入')
bad(null, 'null 输入')
bad(new Uint8Array(12), '太短')
const magic = tdrs.slice(); magic[0] = 0x78
bad(magic, 'magic 不对')
const ver = tdrs.slice(); new DataView(ver.buffer).setUint32(4, 1, true)
bad(ver, '版本 1')
bad(tdrs.subarray(0, tdrs.byteLength - 16), '截断')
const ctype = tdrs.slice(); new DataView(ctype.buffer).setUint32(16, G.CHUNK_BIN, true)
bad(ctype, '第一块不是 JSON')
bad(craft(Buffer.from('{"a":'), null, null), 'JSON 语法错')
bad(craft(Buffer.from('[1,2,3] '), null, null), 'JSON 不是对象')
bad(craft(Buffer.from([0xC3, 0x28, 0x7B, 0x7D]), null, null), '坏 UTF-8（fatal，不悄悄替换）')
const huge = tdrs.slice(); new DataView(huge.buffer).setUint32(12, G.MAX_JSON_BYTES + 4, true)
bad(huge, 'JSON 块声明超上限（防恶意大分配）')
const over = tdrs.slice(); const jl = u32(tdrs, 12); new DataView(over.buffer).setUint32(20 + jl, 0x7FFFFFF0, true)
bad(over, 'BIN 块长越界')
ok(G.parseGlb(craft(Buffer.from('{}  '), Buffer.alloc(4), null)).ok, '（对照）最小合法文件能读')
bad(craft(Buffer.from('{}  '), Buffer.alloc(4), { type: G.CHUNK_BIN, data: Buffer.alloc(4) }), '第二个 BIN 块')
const binLater = craft(Buffer.from('{}  '), null, { type: 0x1, data: Buffer.alloc(4) })
const binLater2 = new Uint8Array(Buffer.concat([Buffer.from(binLater), (() => { const h = Buffer.alloc(12); h.writeUInt32LE(4, 0); h.writeUInt32LE(G.CHUNK_BIN, 4); return h })()]))
new DataView(binLater2.buffer).setUint32(8, binLater2.byteLength, true)
bad(binLater2, 'BIN 块不紧跟 JSON 块')
eq(G.readGlbHeaderJson(42).ok, false, '头读取：非字节输入')
eq(G.patchGlbJson(tdrs, 'x').ok, false, 'patch：fn 不是函数')
eq(G.patchGlbJson(tdrs, () => { throw new Error('boom') }).ok, false, 'patch：fn 抛异常 → 错误不外抛')
eq(G.patchGlbJson(tdrs, () => 5).ok, false, 'patch：返回非对象 → 错误')
eq(G.patchGlbJson(new Uint8Array(3), () => {}).ok, false, 'patch：坏文件 → 错误')
// buildGlb 是给自己代码用的构造器：参数类型错属于调用方写错，抛 TypeError（文档已写明）
assert.throws(() => G.buildGlb(null), TypeError); pass++
assert.throws(() => G.buildGlb({}, 'bin'), TypeError); pass++
assert.throws(() => G.buildGlb('', null), TypeError); pass++

// ⑥ 近似包围盒与节点工具
const bb = (f) => G.gltfBoundsApprox(G.parseGlb(fixture(f)).json)
const tb = bb('tdrs-a.glb')
ok(Math.abs(tb.size[0] - 0.8866) < 1e-3 && Math.abs(tb.size[1] - 0.4489) < 1e-3 && Math.abs(tb.size[2] - 0.4676) < 1e-3, 'TDRS (A) 包围盒 0.8866 × 0.4489 × 0.4676（与语料报告逐点精确值一致）')
const sb = bb('ssl-1300.glb')
ok(Math.abs(sb.size[0] - 268.33) < 0.01 && Math.abs(sb.size[1] - 61.27) < 0.01 && Math.abs(sb.size[2] - 80.37) < 0.01 && sb.exact === false, 'SSL-1300 包围盒 268.33 × 61.27 × 80.37（节点绕 X 转 90°已计入）')
eq(G.gltfBoundsApprox({}), null, '无网格 → null')
eq(G.gltfBoundsApprox(null), null, '坏输入 → null')
const names = G.gltfNodeNames(G.parseGlb(tdrs).json)
eq(names[1], 'Dish1_2:pCylinder1', '节点原名原样（含冒号，不 sanitize）')
eq(G.gltfNodeNames({ nodes: [{}, { name: 'a' }] }), ['', 'a'], '缺名记空串')
const W = G.gltfWorldMatrices({ nodes: [{ children: [1], translation: [1, 0, 0] }, { children: [0], scale: [2, 2, 2] }, { translation: [0, 5, 0] }] })
ok(W[0] === null && W[1] === null && W[2][13] === 5, '成环节点 → null，其余照算')
const W2 = G.gltfWorldMatrices({ nodes: [{ children: [1], translation: [1, 0, 0], scale: [2, 2, 2] }, { translation: [0, 1, 0] }] })
eq(W2[1].slice(12, 15), [1, 2, 0], '世界矩阵 = 父 · 子（父缩放作用到子平移）')
// 深链：父下标大于子下标、2 万层（递归实现在这里爆栈）。坏 / 恶意文件只许得到 null 或正确值，不许抛
const DEEP = 20000
const deep = { nodes: Array.from({ length: DEEP }, () => ({ translation: [0, 0, 1] })) }
for (let i = 1; i < DEEP; i++) deep.nodes[i].children = [i - 1]
let WD = null
try { WD = G.gltfWorldMatrices(deep) } catch (e) { WD = e }
ok(Array.isArray(WD) && WD[0][14] === DEEP && WD[DEEP - 1][14] === 1, `反向 ${DEEP} 层父子链：不爆栈、叶节点平移累加 = ${DEEP}`)
const deepCyc = { nodes: Array.from({ length: DEEP }, (_, i) => ({ children: [(i + 1) % DEEP] })) }
deepCyc.nodes.push({ translation: [0, 0, 3] })
const WC = G.gltfWorldMatrices(deepCyc)
ok(WC.slice(0, DEEP).every((m) => m === null) && WC[DEEP][14] === 3, `${DEEP} 个节点连成一个环 → 全 null，环外节点照算`)
// 公共迭代核：父引用非法（-2）与本地矩阵非法（null）都只让自己和子孙为 null
const RW = G.resolveWorld(4, [-1, 0, -2, 2], (i) => (i === 3 ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 7, 1] : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i, 0, 0, 1]))
ok(RW[0][12] === 0 && RW[1][12] === 1 && RW[2] === null && RW[3] === null, 'resolveWorld：非法父引用 → 自己与子孙 null')

console.log(`modelGlb: ${pass} 项通过`)
