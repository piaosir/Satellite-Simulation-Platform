// GLB 容器：拆包 / 打包 / 只改 JSON 块（任务书 §5.7 glbPatch；设计契约 §2 glb.mjs、T5、T11）。
//
// 为什么自己写而不全交给 gltf-transform / GLTFExporter：
//   · gltf-transform 读写会丢未知扩展（AGI_*），STK 模型经它一遍就丢挂点 / 关节 / 太阳翼组（T5）；
//     所以「改元数据」这件事必须能绕开网格解码，只动 JSON 块、BIN 块逐字节不碰。
//   · 主进程扫描 STK 目录时只想读 JSON 块（几 KB），不想把几十 MB 的网格读进内存（readGlbHeaderJson）。
//   · 纯函数、零依赖，渲染端 / 主进程 / 脚本 / 单测共用同一份。
//
// 容器格式（glTF 2.0 §4.4）：12 字节头 [magic 'glTF', version 2, 总长] + 块序列，每块 [长度, 类型, 数据]；
// 第一块必须是 JSON（0x4E4F534A），第二块可选 BIN（0x004E4942），之后的未知块必须被忽略但我们原样保留。
// 块长须 4 字节对齐：JSON 用空格（0x20）补、BIN 用 0 补。
//
// ★ 回环口径：parseGlb 返回的 jsonText 是 JSON 块的「原文」（含块尾补齐的空格或 NUL），bin 是 BIN 块
//   按块长取出的全部字节（含补齐的 0）。于是 buildGlb(jsonText, bin, {extraChunks}) 与原文件逐字节相等——
//   前提是原文件自身合规（块长对齐、总长等于文件长、无尾随垃圾）。实测 NASA 213 个 + STK 23 个全部合规。
//
// 导出：
//   GLB_MAGIC, CHUNK_JSON, CHUNK_BIN, MAX_JSON_BYTES
//   parseGlb(u8)                → {ok:true, json, jsonText, bin, version, length, extraChunks, warnings} | {ok:false, error}
//   readGlbHeaderJson(prefix)   → {ok:true, json, jsonText, version, length, jsonLength, binOffset, binLength} | {ok:false, needBytes} | {ok:false, error}
//                                 （别名 readGlbJsonOnly，契约 §2 用的名字）
//   buildGlb(json, bin, opts)   → Uint8Array（参数类型不对时抛 TypeError：这是调用方写错，不是坏文件）
//   patchGlbJson(u8, fn)        → {ok:true, glb, json, changed} | {ok:false, error}
//   gltfNodeNames(json)         → string[]（原名，缺名为 ''）
//   gltfWorldMatrices(json)     → (number[16]|null)[]（列主序，按 children 表，成环为 null；迭代实现，深链不爆栈）
//   resolveWorld(n, parentOf, localOf) → 同上的公共迭代核（ir.mjs 的 nodeWorldMatrices 也用它）
//   gltfBoundsApprox(json)      → {min, max, size, span, exact:false} | null（不解网格，按 accessor min/max × 世界矩阵）

export const GLB_MAGIC = 0x46546C67   // 'glTF'
export const CHUNK_JSON = 0x4E4F534A  // 'JSON'
export const CHUNK_BIN = 0x004E4942   // 'BIN\0'

// JSON 块上限：防恶意文件声明一个 4 GB 的 JSON 块让我们去分配内存。NASA / STK 最大的 JSON 块不到 1 MB，
// 64 MB 留足了用 gltf-transform 打包的超大装配体的余量。
export const MAX_JSON_BYTES = 64 * 1024 * 1024

const HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

const utf8Encoder = new TextEncoder()
// fatal：坏 UTF-8 直接报错而不是悄悄替换成 U+FFFD（替换了就不可能逐字节回环）；
// ignoreBOM：保留 BOM 字符，否则 decode → encode 会少 3 个字节。
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function toU8(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return null
}

const pad4 = (n) => (4 - (n % 4)) % 4

// JSON.parse 前去掉块尾补齐：规范用空格，但见过的野文件有用 NUL 补的；NUL 不是 JSON 空白，不去会解析失败。
// 开头的 BOM 同理（JSON.parse 不认 U+FEFF）。
function parseJsonChunkText(text) {
  let s = text
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)
  s = s.replace(/[\u0000 \t\r\n]+$/, '')
  const json = JSON.parse(s)
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('JSON 块不是对象')
  return json
}

/**
 * 读头与 JSON 块，给主进程 STK 扫描、models 服务用：只要前缀，不读 BIN。
 * 前缀不够时返回 {ok:false, needBytes}，调用方按这个数再读一次（第一次读 20 字节就能知道 JSON 块多长）。
 * 前缀若恰好还盖住 BIN 块头，顺带给出 binOffset / binLength（否则为 null / 0）。
 */
export function readGlbHeaderJson(prefix) {
  const u8 = toU8(prefix)
  if (!u8) return { ok: false, error: '输入不是字节数组' }
  if (u8.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) return { ok: false, needBytes: HEADER_BYTES + CHUNK_HEADER_BYTES }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  if (dv.getUint32(0, true) !== GLB_MAGIC) return { ok: false, error: '不是 GLB（magic 不是 glTF）' }
  const version = dv.getUint32(4, true)
  if (version !== 2) return { ok: false, error: `GLB 版本 ${version}，只支持 2` }
  const length = dv.getUint32(8, true)
  const jsonLength = dv.getUint32(12, true)
  if (dv.getUint32(16, true) !== CHUNK_JSON) return { ok: false, error: '第一个块不是 JSON 块' }
  if (jsonLength === 0) return { ok: false, error: 'JSON 块为空' }
  if (jsonLength > MAX_JSON_BYTES) return { ok: false, error: `JSON 块 ${jsonLength} 字节，超过上限 ${MAX_JSON_BYTES}` }
  const jsonEnd = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength
  if (jsonEnd > length) return { ok: false, error: `JSON 块越过文件声明总长 ${length}` }
  if (u8.byteLength < jsonEnd) return { ok: false, needBytes: jsonEnd }
  let jsonText, json
  try {
    jsonText = utf8Decoder.decode(u8.subarray(HEADER_BYTES + CHUNK_HEADER_BYTES, jsonEnd))
    json = parseJsonChunkText(jsonText)
  } catch (e) {
    return { ok: false, error: `JSON 块解析失败：${e && e.message ? e.message : e}` }
  }
  let binOffset = null, binLength = 0
  if (jsonEnd + CHUNK_HEADER_BYTES <= length && jsonEnd + CHUNK_HEADER_BYTES <= u8.byteLength) {
    const len = dv.getUint32(jsonEnd, true)
    if (dv.getUint32(jsonEnd + 4, true) === CHUNK_BIN && jsonEnd + CHUNK_HEADER_BYTES + len <= length) {
      binOffset = jsonEnd + CHUNK_HEADER_BYTES
      binLength = len
    }
  }
  return { ok: true, json, jsonText, version, length, jsonLength, binOffset, binLength }
}

/** 设计契约 §2 里的名字；与 readGlbHeaderJson 是同一个函数。 */
export const readGlbJsonOnly = readGlbHeaderJson

/**
 * 完整拆包。bin 是 BIN 块数据的**视图**（subarray，不拷贝）——要长期持有或改动请自己 slice()。
 * 非致命问题（块长不对齐、文件比声明长、有未知块）进 warnings，不影响 ok。
 */
export function parseGlb(input) {
  const u8 = toU8(input)
  if (!u8) return { ok: false, error: '输入不是字节数组' }
  const head = readGlbHeaderJson(u8)
  if (!head.ok) {
    if (head.needBytes) return { ok: false, error: `文件被截断（至少需要 ${head.needBytes} 字节，只有 ${u8.byteLength}）` }
    return head
  }
  const { json, jsonText, version, length, jsonLength } = head
  const warnings = []
  if (length > u8.byteLength) return { ok: false, error: `文件被截断（声明 ${length} 字节，只有 ${u8.byteLength}）` }
  if (length < u8.byteLength) warnings.push(`文件尾部多出 ${u8.byteLength - length} 字节（已忽略）`)
  if (jsonLength % 4) warnings.push('JSON 块长度未按 4 字节对齐')
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  let off = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonLength
  let bin = null
  const extraChunks = []
  let first = true
  while (off < length) {
    if (off + CHUNK_HEADER_BYTES > length) return { ok: false, error: `偏移 ${off} 处块头不完整` }
    const cl = dv.getUint32(off, true)
    const ct = dv.getUint32(off + 4, true)
    const start = off + CHUNK_HEADER_BYTES
    if (start + cl > length) return { ok: false, error: `偏移 ${off} 处的块（${cl} 字节）越过文件总长` }
    const data = u8.subarray(start, start + cl)
    if (ct === CHUNK_BIN) {
      // 规范：BIN 块只能有一个，且紧跟 JSON 块；别处出现说明文件是坏的，不猜
      if (!first) return { ok: false, error: 'BIN 块不在 JSON 块之后，或出现了第二个 BIN 块' }
      bin = data
    } else extraChunks.push({ type: ct, data })
    if (cl % 4) warnings.push(`偏移 ${off} 处的块长度未按 4 字节对齐`)
    first = false
    off = start + cl
  }
  if (extraChunks.length) warnings.push(`有 ${extraChunks.length} 个未知块（已原样保留）`)
  return { ok: true, json, jsonText, bin, version, length, extraChunks, warnings }
}

/**
 * 打包。json 可以是对象（JSON.stringify）或字符串（原样写入，用于逐字节回环）。
 * JSON 块尾用空格补齐到 4 字节；BIN / 未知块用 0 补齐。总长回填进头。
 * @param {object|string} json
 * @param {Uint8Array|null} [bin]  null / undefined → 不写 BIN 块；长度 0 的数组 → 写一个空 BIN 块
 * @param {{extraChunks?: {type:number, data:Uint8Array}[]}} [opts]
 * @returns {Uint8Array}
 */
export function buildGlb(json, bin = null, opts = {}) {
  let text
  if (typeof json === 'string') text = json
  else if (json && typeof json === 'object' && !Array.isArray(json)) text = JSON.stringify(json)
  else throw new TypeError('buildGlb：json 须为对象或字符串')
  const binU8 = bin == null ? null : toU8(bin)
  if (bin != null && !binU8) throw new TypeError('buildGlb：bin 须为 Uint8Array / ArrayBuffer / null')
  const extra = Array.isArray(opts && opts.extraChunks) ? opts.extraChunks : []
  for (const c of extra) {
    if (!c || !Number.isInteger(c.type) || c.type < 0 || c.type > 0xFFFFFFFF || !toU8(c.data)) throw new TypeError('buildGlb：extraChunks 项须为 {type:uint32, data:Uint8Array}')
  }
  const jsonBytes = utf8Encoder.encode(text)
  if (jsonBytes.byteLength === 0) throw new TypeError('buildGlb：JSON 不能为空')
  const jsonPad = pad4(jsonBytes.byteLength)
  let total = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonBytes.byteLength + jsonPad
  if (binU8) total += CHUNK_HEADER_BYTES + binU8.byteLength + pad4(binU8.byteLength)
  for (const c of extra) { const d = toU8(c.data); total += CHUNK_HEADER_BYTES + d.byteLength + pad4(d.byteLength) }
  if (total > 0xFFFFFFFF) throw new RangeError('buildGlb：总长超过 GLB 上限 4 GiB')

  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, GLB_MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  let off = HEADER_BYTES
  dv.setUint32(off, jsonBytes.byteLength + jsonPad, true)
  dv.setUint32(off + 4, CHUNK_JSON, true)
  out.set(jsonBytes, off + CHUNK_HEADER_BYTES)
  off += CHUNK_HEADER_BYTES + jsonBytes.byteLength
  out.fill(0x20, off, off + jsonPad)
  off += jsonPad
  const writeChunk = (type, data) => {
    const p = pad4(data.byteLength)
    dv.setUint32(off, data.byteLength + p, true)
    dv.setUint32(off + 4, type, true)
    out.set(data, off + CHUNK_HEADER_BYTES)
    off += CHUNK_HEADER_BYTES + data.byteLength + p   // 补齐字节已是 0（新数组）
  }
  if (binU8) writeChunk(CHUNK_BIN, binU8)
  for (const c of extra) writeChunk(c.type, toU8(c.data))
  return out
}

/**
 * 只改 JSON 块、BIN 与未知块逐字节不动。
 * fn(json) 可以原地改并返回 undefined，也可以返回一个新对象；返回 false 表示不改（原样返回输入字节的拷贝）。
 * fn 抛异常或返回非对象 → {ok:false, error}，不外抛。
 */
export function patchGlbJson(input, fn) {
  if (typeof fn !== 'function') return { ok: false, error: 'patchGlbJson：fn 须为函数' }
  const p = parseGlb(input)
  if (!p.ok) return p
  let next
  try {
    const r = fn(p.json)
    if (r === false) return { ok: true, glb: toU8(input).slice(), json: p.json, changed: false }
    next = r === undefined ? p.json : r
  } catch (e) {
    return { ok: false, error: `改写 JSON 失败：${e && e.message ? e.message : e}` }
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { ok: false, error: '改写结果不是对象' }
  try {
    const glb = buildGlb(next, p.bin, { extraChunks: p.extraChunks })
    return { ok: true, glb, json: next, changed: true }
  } catch (e) {
    return { ok: false, error: `重新打包失败：${e && e.message ? e.message : e}` }
  }
}

/** 节点原名表（下标对齐 json.nodes）；缺名记 ''。按节点名的逻辑（AGI / gmdf / parts）一律以它为准。 */
export function gltfNodeNames(json) {
  const nodes = json && Array.isArray(json.nodes) ? json.nodes : []
  return nodes.map((n) => (n && typeof n.name === 'string' ? n.name : ''))
}

// ─────────────────────────────── 不解网格的近似包围盒 ───────────────────────────────

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function mul4(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

const finiteArr = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v))

// glTF 节点局部矩阵（列主序）：有 matrix 用 matrix，否则 T·R·S
function localMatrix(n) {
  if (finiteArr(n.matrix, 16)) return n.matrix.slice()
  const t = finiteArr(n.translation, 3) ? n.translation : [0, 0, 0]
  const q = finiteArr(n.rotation, 4) ? n.rotation : [0, 0, 0, 1]
  const s = finiteArr(n.scale, 3) ? n.scale : [1, 1, 1]
  const [x, y, z, w] = q
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ]
}

// normalized 整型 accessor 的 min/max 是整数原值，按 glTF §3.11 换回浮点
function dequant(acc, v) {
  if (!acc.normalized) return v
  switch (acc.componentType) {
    case 5120: return Math.max(v / 127, -1)
    case 5121: return v / 255
    case 5122: return Math.max(v / 32767, -1)
    case 5123: return v / 65535
    default: return v
  }
}

/**
 * 每个节点的世界矩阵（列主序，= 父世界 · 本地；本地按 matrix 或 T·R·S）。父子关系取 children 表；
 * 一个节点被多个父节点引用（不合规）时取第一个；成环的节点给 null。不在任何场景里的节点照样算（按根处理），
 * 因为 AGI 挂点可能挂在没进场景的辅助节点上，STK 会忽略它，但我们至少能给出位置供人判断。
 * 迭代实现（不递归）：恶意或畸形文件可以造出上万层的父子链，递归会爆调用栈（实测 2 万层即 RangeError），
 * 而这个函数在主进程 STK 扫描 / 导入的路径上，坏输入只许返回 null，不许抛。
 * @returns {(number[]|null)[]}
 */
export function gltfWorldMatrices(json) {
  const nodes = json && Array.isArray(json.nodes) ? json.nodes : []
  const parent = new Array(nodes.length).fill(-1)
  nodes.forEach((n, i) => {
    for (const c of (n && Array.isArray(n.children) ? n.children : [])) {
      if (Number.isInteger(c) && c >= 0 && c < nodes.length && parent[c] === -1 && c !== i) parent[c] = i
    }
  })
  return resolveWorld(nodes.length, parent, (i) => {
    const n = nodes[i]
    return n && typeof n === 'object' ? localMatrix(n) : null
  })
}

/**
 * 按父链求世界矩阵的公共迭代核（glb 的 children 表与 IR 的 parent 字段都归到这里）。
 * parentOf[i]：父下标，-1 = 根，-2 = 父引用非法（该节点记 null）；localOf(i)：本地矩阵，null = 节点本身非法。
 * 规则与原递归版逐项相同：父为 null 或链上成环 → null；每个节点只算一次，总代价 O(n)。
 * 做法：从 i 沿父链往上走，直到碰到已算完的节点 / 根 / 本轮已走过的节点（= 环），再沿记下的路径往下乘回来。
 */
export function resolveWorld(n, parentOf, localOf) {
  const out = new Array(n).fill(null)
  const state = new Uint8Array(n) // 0 未算 1 本轮路径上 2 完成
  const path = []
  for (let i = 0; i < n; i++) {
    if (state[i] === 2) continue
    path.length = 0
    let j = i
    let base = null, top = 'cycle'
    for (;;) {
      if (state[j] === 2) { base = out[j]; top = 'solved'; break }
      if (state[j] === 1) { top = 'cycle'; break }
      state[j] = 1
      path.push(j)
      const p = parentOf[j]
      if (p === -1) { top = 'root'; break }
      if (!(Number.isInteger(p) && p >= 0 && p < n)) { top = 'bad'; break }
      j = p
    }
    let w = null
    for (let k = path.length - 1; k >= 0; k--) {
      const idx = path[k]
      const local = localOf(idx)
      if (!local) w = null
      else if (k === path.length - 1) w = top === 'root' ? local : (top === 'solved' && base ? mul4(base, local) : null)
      else w = w ? mul4(w, local) : null
      out[idx] = w
      state[idx] = 2
    }
  }
  return out
}

/**
 * 近似包围盒：场景树逐节点求世界矩阵，把每个 primitive 的 POSITION accessor min/max 的 8 个角点变换后取外包。
 * 为什么够用：accessor min/max 是规范要求必填的（Draco 压缩的也有），所以不解码就能拿到；
 * 有旋转时比真实包围盒略大（角点外包），单位推断只看量级，影响不到结论。exact 恒为 false。
 * 缺 accessor min/max 的 primitive 跳过；什么都拿不到返回 null。
 */
export function gltfBoundsApprox(json) {
  if (!json || typeof json !== 'object') return null
  const nodes = Array.isArray(json.nodes) ? json.nodes : []
  const meshes = Array.isArray(json.meshes) ? json.meshes : []
  const accessors = Array.isArray(json.accessors) ? json.accessors : []
  const scenes = Array.isArray(json.scenes) ? json.scenes : []
  const scene = scenes[Number.isInteger(json.scene) ? json.scene : 0]
  let roots = scene && Array.isArray(scene.nodes) ? scene.nodes : null
  if (!roots) {
    const child = new Set()
    for (const n of nodes) for (const c of (n && Array.isArray(n.children) ? n.children : [])) child.add(c)
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i))
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const visiting = new Set()
  const walk = (i, parent, depth) => {
    const n = nodes[i]
    if (!n || typeof n !== 'object' || visiting.has(i) || depth > 256) return
    visiting.add(i)
    const m = mul4(parent, localMatrix(n))
    const mesh = Number.isInteger(n.mesh) ? meshes[n.mesh] : null
    for (const p of (mesh && Array.isArray(mesh.primitives) ? mesh.primitives : [])) {
      const ai = p && p.attributes ? p.attributes.POSITION : undefined
      const acc = Number.isInteger(ai) ? accessors[ai] : null
      if (!acc || !finiteArr(acc.min, 3) || !finiteArr(acc.max, 3)) continue
      const lo = acc.min.map((v) => dequant(acc, v)), hi = acc.max.map((v) => dequant(acc, v))
      for (let k = 0; k < 8; k++) {
        const x = k & 1 ? hi[0] : lo[0], y = k & 2 ? hi[1] : lo[1], z = k & 4 ? hi[2] : lo[2]
        const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
        for (let a = 0; a < 3; a++) { if (w[a] < min[a]) min[a] = w[a]; if (w[a] > max[a]) max[a] = w[a] }
      }
    }
    for (const c of (Array.isArray(n.children) ? n.children : [])) walk(c, m, depth + 1)
    visiting.delete(i)
  }
  for (const r of roots) if (Number.isInteger(r)) walk(r, IDENT, 0)
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
  return { min, max, size, span: Math.max(size[0], size[1], size[2]), exact: false }
}
