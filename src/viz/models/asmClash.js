// 装配穿插检测（P3，CONTRACT §5.7）：只在松手 / 提交后跑，时间切片（每片 ≤ 8 ms，setTimeout(0) 续），新的拖动开始即作废。
//
// 宽相：各件本体系 AABB 两两相交（asmSnap.aabbPairs），跳过「父子安装对」（贴合面共面相交会全报）；
// 窄相：两件网格逐对先比世界包围盒，再 bvhA.intersectsGeometry(geomB, M_B→A · 收缩)（B 也有 boundsTree 时走 BVH × BVH），命中即停。
// ★ 接触不算穿插：B 的网格先绕自身包围盒中心各轴收进 δ = 2 mm + 0.2 % 尺寸（各面往里退 δ）再求交——
//   端对端接起来的杆件、贴在别的件面上的件、铰座与杆这类「表面相碰」的不报，真正扎进去超过 δ 的照报。
//   只相碰的对（整星模板里 18 对全是这种）一律报出来，红一片等于没报。
// 镜像派生件的矩阵行列式为 −1：三角形求交与朝向无关，照常成立。
// ★ 杆件端点是接头：杆（items[i].rod = 半径 > 0，编辑器按「root 在原点、tip 在 +Z 端」认）的两端各收进
//   两倍杆径 + δ（对面也是杆时再加两倍对面半径——两杆在接点成角相会，端帽互相吃进去的深度按两根的粗细算），
//   只收最长轴（杆的轴向）、封顶 45 % 杆长。杆端落在平台体顶板 / 塔顶 / 另一根杆上、从铰座里伸出来都不报；
//   杆身扎进别的件照报。只有一边是杆时把杆换到 B 位（只有 B 能收缩）。
import * as THREE from 'three'
import { aabbPairs } from '@core/models/asmSnap.mjs'

// 杆端嵌入容差（半径的倍数 = 两倍杆径）：杆端插进接头件 / 斜着落在面上时吃进去的深度是 r / sin(夹角)，15° 斜落约 3.9 r
const ROD_EMBED = 4

export function createClashRunner() {
  let token = 0, busy = false
  const _inv = new THREE.Matrix4(), _m = new THREE.Matrix4(), _sh = new THREE.Matrix4(), _t = new THREE.Matrix4()
  const _ba = new THREE.Box3(), _bb = new THREE.Box3(), _c = new THREE.Vector3(), _e = new THREE.Vector3()
  /** 网格局部系的收缩矩阵：绕包围盒中心各轴缩到每面退 δ（太薄的轴不缩）；endAllow > 0 时最长轴两端各退 endAllow（杆端接头）。 */
  function shrinkOf(g, out, endAllow = 0) {
    if (!g.boundingBox) g.computeBoundingBox()
    const b = g.boundingBox
    b.getCenter(_c); b.getSize(_e)
    const d = 0.002 + 0.002 * _e.length()
    let kx = _e.x > 4 * d ? 1 - 2 * d / _e.x : 1, ky = _e.y > 4 * d ? 1 - 2 * d / _e.y : 1, kz = _e.z > 4 * d ? 1 - 2 * d / _e.z : 1
    if (endAllow > 0) {
      const ax = _e.x >= _e.y && _e.x >= _e.z ? 0 : _e.y >= _e.z ? 1 : 2, L = ax === 0 ? _e.x : ax === 1 ? _e.y : _e.z
      const k = 1 - 2 * Math.min(endAllow + d, 0.45 * L) / L
      if (ax === 0) kx = k; else if (ax === 1) ky = k; else kz = k
    }
    out.makeTranslation(_c.x, _c.y, _c.z).multiply(_t.makeScale(kx, ky, kz)).multiply(_t.makeTranslation(-_c.x, -_c.y, -_c.z))
    return out
  }

  function meshBox(mesh, out) {
    const g = mesh.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    return out.copy(g.boundingBox).applyMatrix4(mesh.matrixWorld)
  }
  function pairHits(A0, B0) {
    const swap = A0.rod > 0 && !(B0.rod > 0)
    const A = swap ? B0 : A0, B = swap ? A0 : B0
    const endAllow = B.rod > 0 ? ROD_EMBED * B.rod + (A.rod > 0 ? 2 * A.rod : 0) : 0
    for (const ma of A.meshes) {
      const bvh = ma.geometry && ma.geometry.boundsTree
      if (!bvh) continue
      meshBox(ma, _ba)
      _inv.copy(ma.matrixWorld).invert()
      for (const mb of B.meshes) {
        if (!mb.geometry) continue
        if (!meshBox(mb, _bb).intersectsBox(_ba)) continue
        _m.multiplyMatrices(_inv, mb.matrixWorld).multiply(shrinkOf(mb.geometry, _sh, endAllow))
        if (bvh.intersectsGeometry(mb.geometry, _m)) return true
      }
    }
    return false
  }
  return {
    /**
     * @param {{meshes:THREE.Mesh[], box:Float64Array|number[], rod?:number}[]} items 可见件（网格世界矩阵须是新的；box = 本体系 AABB 6 元；
     *   rod = 杆件半径（米，杆件才给）：两端按接头放宽）
     * @param {(i:number, j:number) => boolean} skip 跳过的对（父子安装对）
     * @param {(pairs:number[][]) => void} done 完成回调（被作废时不调）
     * @param {number} [sliceMs]
     */
    run(items, skip, done, sliceMs = 8) {
      const my = ++token
      const n = items.length
      const boxes = new Float64Array(6 * n)
      for (let i = 0; i < n; i++) for (let k = 0; k < 6; k++) boxes[6 * i + k] = items[i].box[k]
      const cands = aabbPairs(boxes, n, skip)
      const hits = []
      let ci = 0
      busy = true
      const step = () => {
        if (my !== token) return
        const t0 = performance.now()
        while (ci < cands.length) {
          const [i, j] = cands[ci++]
          if (pairHits(items[i], items[j])) hits.push([i, j])
          if (performance.now() - t0 > sliceMs && ci < cands.length) { setTimeout(step, 0); return }
        }
        busy = false
        done(hits)
      }
      step()
    },
    cancel() { token++; busy = false },
    get busy() { return busy }
  }
}
