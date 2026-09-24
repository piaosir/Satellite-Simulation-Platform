// 星座卫星精模的出处记账（与 paramTemplates 同一套数据纪律）。
//
// ★ 纪律：
//   · 平台级数据（整星质量、本体尺寸、太阳翼面积 / 跨度 / 板数、天线个数与口径……）逐条 {value, unit, source, quote?}，
//     source 是能打开的 URL；查不到就 NIL（value = null），生成器按示意值画并把路径记进 illustrative。
//   · 从官方照片 / 渲染图按比例量出来的（部件相对位置、没公布的边长），记 {basis:'image', image:URL, how}，不冒充公布值。
//   · 纯造型细节（倒角、螺距、线径、板边框宽、铰链大小、支杆粗细……）不是任何一方公布的数据，统一 ILL（source:'illustrative'）。
//   界面上出处只进悬停 title，不占版面（CLAUDE.md）。

/** 有出处的数值。extra: {quote, note, basis, image, how, rep}。 */
export const F = (value, unit, source, extra = {}) => ({ value, unit, source, url: typeof source === 'string' && /^https?:\/\//.test(source) ? source : null, ...extra })
/** 查不到。 */
export const NIL = (unit, note) => ({ value: null, unit, source: null, url: null, note })
/** 从图片量的比例 / 尺寸。 */
export const IMG = (value, unit, image, how, extra = {}) => ({ value, unit, source: 'image', url: image, basis: 'image', image, how, ...extra })
/** 纯造型示意值。 */
export const ILL = (value, unit, note) => ({ value, unit, source: 'illustrative', url: null, note })

/** facts 表里全部带 URL 的出处（去重、按出现顺序）——目录条目的 source.url 取第一个，悬停列全部。 */
export function factUrls(facts) {
  const out = []
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (typeof v.url === 'string' && v.url && !out.includes(v.url)) out.push(v.url)
    for (const k of Object.keys(v)) if (k !== 'url' && v[k] && typeof v[k] === 'object') walk(v[k])
  }
  walk(facts)
  return out
}
