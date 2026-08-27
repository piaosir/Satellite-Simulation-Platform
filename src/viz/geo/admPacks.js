// 全球行政边界数据包的加载与合并（一级 ADM1 / 二级 ADM2）。
//
// 包由 scripts/build-adm.mjs 逐国生成：src/viz/globe3d/data/adm/{ISO3}-adm{1,2}.json
//   { borders: [[[lon,lat],…], …],            通用内部界（折线）
//     labels:  [{ name_en, name_local, lon, lat }, …],
//     groups?: [{ wv:[视角id…], borders:[…], labels:[…] }] }   只在这些视角下才画
// groups 的存在是因为「某些单元在别的视角下不属于本国」——如印度的阿鲁纳恰尔在中国视角下属中国，
// 那它的邦界与邦名在中国视角就不该出现。
//
// ★ 按国切包 + 按需懒加载：勾一个国家才拉一个包，取消勾选只是不画、不卸载（再勾回来是零开销）。
//   包本身落在 resources/adm、由主进程读盘经 IPC 送来 —— 两百多个文件若走 import.meta.glob，
//   rollup 会生成两百多个 chunk，实测默认堆直接 OOM。索引与署名表小，仍是渲染端直接 import。
import INDEX from '../globe3d/data/adm/index.json' with { type: 'json' }

export const admIndex = INDEX          // { adm1: [ISO3…], adm2: [ISO3…] }
export const hasPack = (lvl, iso) => (INDEX['adm' + lvl] || []).includes(iso)

const cache = new Map()                // 'adm1:CHN' → 包
export async function loadPack(lvl, iso) {
  const k = 'adm' + lvl + ':' + iso
  if (cache.has(k)) return cache.get(k)
  if (!hasPack(lvl, iso)) return null
  const api = typeof window !== 'undefined' && window.api && window.api.adm
  if (!api) return null
  try {
    const j = await api.pack(lvl, iso)
    if (j && !j.iso) j.iso = iso        // 包里不带国别码，回填一个：mergePacks 要按国别决定「常显」
    cache.set(k, j || null)
    return j || null
  } catch (e) { console.warn('[adm] 加载失败 ' + k, e); return null }
}

// 把选中的若干国家的包并成渲染器要的一份 { borders, labels }。
//   povId    当前视角 —— groups 里 wv 不含它的那部分整块跳过
//   nameMode 'local' 本地名 | 'en' 英文 | 'off' 不出名字（只画界）
//   px/px2d  3D 世界高度 / 2D 像素字号，由调用方按层级给
//   keepIso  这些国家的标注【常显】：不参与地名避让的碰撞剔除，挤到也照画（见 KEEP_ISO 的调用方）
export function mergePacks(packs, povId, nameMode, px, px2d, keepIso) {
  const keep = new Set(keepIso || [])
  const borders = [], labels = []
  const take = (src, iso) => {
    if (!src) return
    for (const b of (src.borders || [])) borders.push(b)
    if (nameMode === 'off') return
    const k = keep.has(iso)
    for (const l of (src.labels || [])) {
      const name = nameMode === 'local' ? (l.name_local || l.name_en) : l.name_en
      if (name) labels.push({ name, lon: l.lon, lat: l.lat, px, px2d, rk: l.rk != null ? l.rk : 12, keep: k })
    }
  }
  for (const p of packs) {
    if (!p) continue
    take(p, p.iso)
    for (const g of (p.groups || [])) if (!Array.isArray(g.wv) || g.wv.includes(povId)) take(g, p.iso)
  }
  return { borders, labels: withPriority(labels) }
}

// 地名避让的排队依据 pri —— 取「到最近邻标注的距离（度）」：辖区大的单元，邻居自然远，
// 排在前面先得位；密集小区互相挤，后到的被剔掉。这是个代理量，但对「先出大的」这件事够用，
// 且不需要单元面积（逐国包里只有内部界与标注点，没有单元多边形，算不出真面积）。
// ★ 用 1° 分桶只在邻近九格里找，251 国 4596 个标注也是一遍扫完，不走 O(N²)。
const PRI_G = 1
function withPriority(labels) {
  if (labels.length < 2) { for (const l of labels) l.pri = 1e9; return labels }
  const bin = new Map()
  const key = (x, y) => x + ',' + y
  for (let i = 0; i < labels.length; i++) {
    const k = key(Math.floor(labels[i].lon / PRI_G), Math.floor(labels[i].lat / PRI_G))
    let a = bin.get(k); if (!a) bin.set(k, a = []); a.push(i)
  }
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    const gx = Math.floor(l.lon / PRI_G), gy = Math.floor(l.lat / PRI_G)
    let best = Infinity
    // 逐圈外扩：九格内找到邻居就够了；周围空荡荡（大国/孤岛）的最多扩到 8 圈，再远也判成「很重要」
    for (let r = 1; r <= 8 && !(best < r * PRI_G); r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (r > 1 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue   // 只扫新一圈
        const a = bin.get(key(gx + dx, gy + dy))
        if (!a) continue
        for (const j of a) {
          if (j === i) continue
          const dlon = (labels[j].lon - l.lon) * Math.max(Math.cos(l.lat * Math.PI / 180), 0.1)
          const d = Math.hypot(dlon, labels[j].lat - l.lat)
          if (d < best) best = d
        }
      }
    }
    l.pri = Number.isFinite(best) ? best : 1e9
  }
  return labels
}
