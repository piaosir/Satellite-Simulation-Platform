// 点精灵遮罩的 GPU 哈希表：模型图标接管的聚焦星，原位的星座点 / 在轨点要压掉（模型淡入、点淡出 —— 交叉淡入淡出）。
//
// 原来是 uniform 数组逐顶点比对至多 32 个锚点；图标颗数放开以后（一整个星链星座七千颗）逐顶点循环扛不住，改成哈希表：
//   · 锚点按 1/1024 个地球半径（≈ 6.2 km）的立方格子哈希进一张 RGBA32F 表（开放寻址、线性探测），表项 = [x, y, z, 实例号]，
//     空位实例号 = −1；
//   · 点的顶点着色器按自己的位置算格子，从哈希槽起往后探、遇空位停，坐标差在容差内即命中，再按实例号去实例表取
//     [图标透明度, 图标像素, 整颗藏, 0]；
//   · 容差（2e-5 个地球半径 ≈ 127 m，与原 uniform 版同值）跨格子边界时：锚点离格界不到容差的那一轴，相邻格子也插一份 ——
//     点只查自己那一格就够了；
//   · 建表时量最长探测距离，超过着色器的探测上限（DM_PROBES）就把表放大一倍重建 —— 表里的每一项都保证探得到。
//     放大有上限：同一格的项哈希到同一个槽、只能顺着往后排，表再大也散不开 —— 同格至多插 DM_PROBES 项，探不到的项不插
//     （那几颗原位的点不被遮，模型与点叠着画；宁可露点，不可卡死）。见 buildDotMaskTable。
// JS 建表与 GLSL 查表在同一个文件里（常量、哈希、格子换算一处定义），dotMaskLookup 是着色器的逐句 JS 镜像（单测拿它对拍）。
//
// 数值口径：锚点与点都是 llaToVec(大地纬经高) 同一算式（页面 / 聚焦几何 Worker 各算一份，存 float32），差在 1e-7 量级。
// 格子：floor(x · 1024) —— 乘 2 的幂在 float32 里是精确的，GPU 与 JS 的格子号逐位相同；再加 DM_OFF 平移成非负数，
// 着色器里 int → uint 不碰负数。哈希：Teschner 三素数异或 + murmur3 fmix32 收尾（uint 运算按 2³² 回绕，JS 用 Math.imul 镜像）。

export const DM_CELL = 1024           // 每个地球半径几格
export const DM_OFF = 16384           // 格子号平移（|坐标| < 16 个地球半径都是非负数；GEO 6.6）
export const DM_TOL = 2e-5            // 命中容差（地球半径）：dot(d, d) < DM_TOL²
export const DM_TOL2 = 4e-10           // = DM_TOL²（与着色器字面量 4.0e-10 同值；双精度平方会多出尾数）
export const DM_PROBES = 32           // 着色器探测上限（编译期常量）；建表保证最长探测距离不超过它
const MIN_BITS = 6
const ROW_BITS = 10                   // 纹理宽 = min(槽数, 1024)

/** 格子哈希（uint32）。cx/cy/cz 是 floor(x · DM_CELL) 的整数格子号（未平移） */
export function dmHash(cx, cy, cz) {
  let h = (Math.imul(cx + DM_OFF, 73856093) ^ Math.imul(cy + DM_OFF, 19349663) ^ Math.imul(cz + DM_OFF, 83492791)) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const nextPow2Bits = (n) => { let b = MIN_BITS; while ((1 << b) < n) b++; return b }
const _cand = [[0], [0], [0]]
// 随机撞车（不同格的项挤成一长串）：表长最多比「装载率 1/2」那档再翻 GROW_MAX 次（16 倍），还放不下的项同样不插
const GROW_MAX = 4

/**
 * 建表。xyz：锚点（Float32Array 或普通数组，3n）；gid：各锚点的实例号（≥ 0）；n：锚点数。
 * prev：上一次的结果（容量够就复用它的 Float32Array，逐拍建表不分配；上一次是同格超限的，这次直接按限额插）。
 * ★ 同一格至多插 DM_PROBES 项。同格的项哈希到同一个槽、只能顺着往后排：第 DM_PROBES + 1 项离哈希槽 ≥ DM_PROBES，着色器探不到，
 *   而表放多大都还是同一个槽 —— 原来「表长翻倍直到最长探测 < 上限」在这里永不收敛，一路翻倍到分配失败（同一 ≈6 km 格里挤进
 *   ≥ 33 颗：一箭多星刚分离、还没散开的那一批），页面每拍 set() 又重来一遍。现在：超限的不插（那几颗原位的点不遮，宁可露点），
 *   任何时候都探不到的项也不插（插了白占槽、还把后面的挤得更远），建表恒收敛，表长至多 16 倍。
 * @returns {{tab:Float32Array, bits:number, twBits:number, w:number, h:number, entries:number, maxProbe:number, dropped:number, capped:boolean}}
 *   tab 长度 = 4 · 2^bits（纹理 w × h，w = 2^twBits）；dropped = 没插进表的项数（这些锚点的点不被遮）
 */
export function buildDotMaskTable(xyz, gid, n, prev) {
  // 每个锚点插几格（离格界不到容差的轴各多一格），先数总数定表长：装载率 ≤ 1/2
  let entries = 0
  for (let i = 0; i < n; i++) entries += cellsOf(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], null)
  const need = nextPow2Bits(entries * 2)
  let bits = Math.max(need, prev && prev.bits > 0 ? Math.min(prev.bits, nextPow2Bits(entries * 8)) : 0)
  const bitsMax = Math.max(bits, need + GROW_MAX)
  let cap = prev && prev.capped ? new Map() : null
  let tab = null
  for (;;) {
    const M = 1 << bits
    if (!tab || tab.length !== M * 4) tab = prev && prev.tab && prev.tab.length === M * 4 ? prev.tab : new Float32Array(M * 4)
    const r = fillDotMask(tab, M, xyz, gid, n, cap)
    // 有项放不下：先按「同格限额」重插一遍（同格超限时放大表没用）；限额之外还有放不下的才是随机撞车，表放大一倍
    if (r.dropped && !cap) { cap = new Map(); continue }
    if (r.dropped > r.capDropped && bits < bitsMax) { bits++; prev = null; continue }
    const twBits = Math.min(bits, ROW_BITS)
    return { tab, bits, twBits, w: 1 << twBits, h: M >> twBits, entries, maxProbe: r.maxProbe, dropped: r.dropped, capped: r.capDropped > 0 }
  }
}

// 填表一遍。cap：同格限额的计数表（null = 不限额，常态）。着色器从哈希槽探到第 DM_PROBES 个为止：
// 本项距哈希槽的距离 d 必须 < DM_PROBES，探到上限还没空位的不插
function fillDotMask(tab, M, xyz, gid, n, cap) {
  for (let s = 0; s < M; s++) tab[s * 4 + 3] = -1
  const mask = M - 1
  let maxProbe = 0, dropped = 0, capDropped = 0
  if (cap) cap.clear()
  for (let i = 0; i < n; i++) {
    const x = Math.fround(xyz[i * 3]), y = Math.fround(xyz[i * 3 + 1]), z = Math.fround(xyz[i * 3 + 2])
    cellsOf(x, y, z, _cand)
    for (const cx of _cand[0]) for (const cy of _cand[1]) for (const cz of _cand[2]) {
      if (cap) {
        // 格子号平移后各轴 < 2^15，拼成一个 45 位整数作键（双精度里精确）
        const key = ((cx + DM_OFF) * 32768 + (cy + DM_OFF)) * 32768 + (cz + DM_OFF)
        const c = cap.get(key) || 0
        if (c >= DM_PROBES) { dropped++; capDropped++; continue }
        cap.set(key, c + 1)
      }
      let s = dmHash(cx, cy, cz) & mask, d = 0
      while (d < DM_PROBES && tab[s * 4 + 3] >= 0) { s = (s + 1) & mask; d++ }
      if (d >= DM_PROBES) { dropped++; continue }
      tab[s * 4] = x; tab[s * 4 + 1] = y; tab[s * 4 + 2] = z; tab[s * 4 + 3] = gid[i]
      if (d > maxProbe) maxProbe = d
    }
  }
  return { maxProbe, dropped, capDropped }
}

// 锚点该插进哪几格（各轴 1 或 2 个格子号）；out 为 null 时只数格数
function cellsOf(x, y, z, out) {
  let k = 1
  const v = [x, y, z]
  for (let a = 0; a < 3; a++) {
    const t = v[a] * DM_CELL, c = Math.floor(t), f = t - c
    const lo = f < DM_TOL * DM_CELL, hi = f > 1 - DM_TOL * DM_CELL
    if (out) { const o = out[a]; o.length = 0; o.push(c); if (lo) o.push(c - 1); if (hi) o.push(c + 1) }
    k *= 1 + (lo ? 1 : 0) + (hi ? 1 : 0)
  }
  return k
}

/**
 * 着色器查表的逐句 JS 镜像（单测对拍用；运行时不调）。p：点位置（会先按 float32 取整，同 GPU）。
 * 返回命中的实例号列表（按探测顺序，可能有重复）。
 */
export function dotMaskLookup(t, p) {
  const out = []
  if (!t || !(t.bits >= 0)) return out
  const x = Math.fround(p[0]), y = Math.fround(p[1]), z = Math.fround(p[2])
  const M = 1 << t.bits, mask = M - 1
  let s = dmHash(Math.floor(x * DM_CELL), Math.floor(y * DM_CELL), Math.floor(z * DM_CELL)) & mask
  for (let k = 0; k < DM_PROBES; k++) {
    const g = t.tab[s * 4 + 3]
    if (g < 0) break
    const dx = Math.fround(x - t.tab[s * 4]), dy = Math.fround(y - t.tab[s * 4 + 1]), dz = Math.fround(z - t.tab[s * 4 + 2])
    if (dx * dx + dy * dy + dz * dz < DM_TOL2) out.push(g)
    s = (s + 1) & mask
  }
  return out
}

/** 图标透明度 × 图标尺寸系数 → 点被压掉多少（0 … 1）。与着色器 dmHide 同式：尺寸系数 = smoothstep(2.5, 5, 图标半径像素) */
export function dotMaskHide(alpha, px, zk, full) {
  if (full) return 1
  const r = px * zk * 0.5
  const t = Math.max(0, Math.min(1, (r - 2.5) / 2.5))
  return alpha * t * t * (3 - 2 * t)
}

/**
 * 顶点着色器片段：声明（放在 main 之前）与求值函数 dotMaskAt(p) → 点的保留系数（1 = 不遮，0 = 全遮）。
 * uniform：uDmTab / uDmInst（RGBA32F，最近邻）、uDmBits（表长指数，< 0 = 关）、uDmTwb / uDmIwb（两张表的行宽指数）、uDmZk（缩放联动系数）。
 */
export const DOT_MASK_PARS = `
uniform highp sampler2D uDmTab;
uniform highp sampler2D uDmInst;
uniform int uDmBits;
uniform int uDmTwb;
uniform int uDmIwb;
uniform float uDmZk;
uint dmHashCell( ivec3 c ) {
  uvec3 u = uvec3( c + ${DM_OFF} );
  uint h = ( u.x * 73856093u ) ^ ( u.y * 19349663u ) ^ ( u.z * 83492791u );
  h ^= h >> 16u; h *= 0x85ebca6bu; h ^= h >> 13u; h *= 0xc2b2ae35u; h ^= h >> 16u;
  return h;
}
float dotMaskAt( vec3 p ) {
  if ( uDmBits < 0 ) return 1.0;
  uint mask = ( 1u << uint( uDmBits ) ) - 1u;
  uint s = dmHashCell( ivec3( floor( p * ${DM_CELL}.0 ) ) ) & mask;
  int twm = ( 1 << uDmTwb ) - 1, iwm = ( 1 << uDmIwb ) - 1;
  float a = 1.0;
  for ( int k = 0; k < ${DM_PROBES}; k ++ ) {
    int si = int( s );
    vec4 e = texelFetch( uDmTab, ivec2( si & twm, si >> uDmTwb ), 0 );
    if ( e.w < 0.0 ) break;
    vec3 dd = p - e.xyz;
    if ( dot( dd, dd ) < 4.0e-10 ) {
      int g = int( e.w + 0.5 );
      vec4 ii = texelFetch( uDmInst, ivec2( g & iwm, g >> uDmIwb ), 0 );
      float t = clamp( ( ii.y * uDmZk * 0.5 - 2.5 ) / 2.5, 0.0, 1.0 );
      float hide = ii.z > 0.5 ? 1.0 : ii.x * t * t * ( 3.0 - 2.0 * t );
      a = min( a, 1.0 - hide );
    }
    s = ( s + 1u ) & mask;
  }
  return a;
}
`
