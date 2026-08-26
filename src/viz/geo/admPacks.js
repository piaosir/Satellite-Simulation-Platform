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
    cache.set(k, j || null)
    return j || null
  } catch (e) { console.warn('[adm] 加载失败 ' + k, e); return null }
}

// 把选中的若干国家的包并成渲染器要的一份 { borders, labels }。
//   povId    当前视角 —— groups 里 wv 不含它的那部分整块跳过
//   nameMode 'local' 本地名 | 'en' 英文 | 'off' 不出名字（只画界）
//   px/px2d  3D 世界高度 / 2D 像素字号，由调用方按层级给
export function mergePacks(packs, povId, nameMode, px, px2d) {
  const borders = [], labels = []
  const take = (src) => {
    if (!src) return
    for (const b of (src.borders || [])) borders.push(b)
    if (nameMode === 'off') return
    for (const l of (src.labels || [])) {
      const name = nameMode === 'local' ? (l.name_local || l.name_en) : l.name_en
      if (name) labels.push({ name, lon: l.lon, lat: l.lat, px, px2d })
    }
  }
  for (const p of packs) {
    if (!p) continue
    take(p)
    for (const g of (p.groups || [])) if (!Array.isArray(g.wv) || g.wv.includes(povId)) take(g)
  }
  return { borders, labels }
}
