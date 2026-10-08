// 球面模型图标的抽稀档（iconBatch.js 用；Worker 与单测直接调这里的纯函数）。
//
// 图标是屏幕定尺的符号：几十像素宽的星用不着上万个三角形（星座精模 3k–41k）。一颗模型按「烘好的部件」各抽一组索引：
//   · 误差按【整模型】给绝对值（米，= 档位系数 × 模型最大边长）：meshopt 默认的相对误差是按单个网格自身尺寸量的，
//     小零件各按自己的 2 % 几乎一个也简化不动；ErrorAbsolute 下小于误差的孤立碎件由 Prune 整块去掉；
//   · 先按位置焊接（generatePositionRemap）再简化：烘好的部件按硬边拆着顶点（盒子每个面各一份法向），不焊的话
//     简化器把每条硬边当边界锁死；
//   · 简化完按「面法向最接近」把每个角点换回原顶点：焊接后的代表顶点只带其中一个面的法向 / UV，直接用会把硬边抹圆、
//     电池片贴图错位。新索引仍指向原顶点表 —— 各档只换索引缓冲，顶点缓冲共用。
// 档位口径（像素误差 ≤ 1 px 选档、三角形总量兜底）在 iconBatch.js。

/** 抽稀档的误差系数（× 模型最大边长）；第 0 档是不抽稀的全精度 */
export const ICON_LOD_ERR = Object.freeze([0, 0.003, 0.008, 0.02, 0.035, 0.06])

/**
 * @param {object} S MeshoptSimplifier（已 ready）
 * @param {{pos:Float32Array, nrm?:Float32Array|null, idx:Uint32Array}[]} parts 本体系部件（与 GPU 上同一份顶点）
 * @param {number[]} errs 各档绝对误差（米），升序；对每档各出一组索引
 * @returns {(Uint32Array|null)[][]} levels[k][i]：第 k 档第 i 个部件的索引（指向原顶点）；null = 整件被剔掉
 */
export function simplifyIconParts(S, parts, errs) {
  const out = errs.map(() => new Array(parts.length).fill(null))
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const n = p.pos.length / 3
    if (!p.idx || p.idx.length < 3 || !n) continue
    const remap = S.generatePositionRemap(p.pos, 3)
    const I = new Uint32Array(p.idx.length)
    for (let k = 0; k < I.length; k++) I[k] = remap[p.idx[k]]
    // 同一位置的原顶点表（CSR）：代表顶点 → [原顶点…]
    const cnt = new Uint32Array(n + 1)
    for (let v = 0; v < n; v++) cnt[remap[v] + 1]++
    for (let v = 0; v < n; v++) cnt[v + 1] += cnt[v]
    const fill = cnt.slice(0, n), lst = new Uint32Array(n)
    for (let v = 0; v < n; v++) lst[fill[remap[v]]++] = v
    for (let l = 0; l < errs.length; l++) {
      const [ni] = S.simplify(I, p.pos, 3, 0, errs[l], ['ErrorAbsolute', 'Prune'])
      out[l][i] = ni.length >= 3 ? reassign(ni, p, cnt, lst) : null
    }
  }
  return out
}

// 焊接后的角点换回原顶点：同位置的原顶点里取法向与本三角形面法向最接近的那个（没有法向就留代表顶点）
function reassign(ni, p, cnt, lst) {
  const P = p.pos, N = p.nrm
  const o = new Uint32Array(ni.length)
  let m = 0
  for (let t = 0; t < ni.length; t += 3) {
    const a = ni[t], b = ni[t + 1], c = ni[t + 2]
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2]
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    if (!(fx * fx + fy * fy + fz * fz > 0)) continue
    for (let k = 0; k < 3; k++) {
      const r = ni[t + k]
      let best = r
      if (N && cnt[r + 1] - cnt[r] > 1) {
        let bd = -Infinity
        for (let j = cnt[r]; j < cnt[r + 1]; j++) {
          const v = lst[j]
          const d = N[v * 3] * fx + N[v * 3 + 1] * fy + N[v * 3 + 2] * fz
          if (d > bd) { bd = d; best = v }
        }
      }
      o[m + k] = best
    }
    m += 3
  }
  return m >= 3 ? o.slice(0, m) : null
}
