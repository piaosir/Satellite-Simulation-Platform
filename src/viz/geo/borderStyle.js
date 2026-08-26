// 边界线的显示规范（渲染次序 / 出厂样式 / 线型图案 / 缩放淡出）—— 3D 球体与 2D 平面图共用这一份，
// 两个视图因此不可能长歪：同一类线在两边是同一个颜色、同一个线宽、同一个屏幕虚线周期、同一档淡出。
//
// 五类线：coast 海岸 · admin0 国界 · indefinite 未定界 · loc 停火线 · claim 主张线。
// 分类由 povResolver 按归属实时派生（见那边的规则表），本文件只管「画成什么样」。

// 渲染次序（从下往上压）。★ 与改造前不同：改造前是省界 6.6 压在「国界+海岸」6.5 之上；
// 国界从海岸线里分出来之后，它应当是最上面那条 —— 一级/二级行政区反而要退到国界与海岸之下。
export const ORDER = { grid: 6.30, adm2: 6.40, adm1: 6.45, coast: 6.50, claim: 6.55, loc: 6.60, indefinite: 6.65, admin0: 6.70 }

// 出厂默认（1.6b 二）。色系分两族：
//   自然要素 —— 只有 coast，独立于政治线的冷灰蓝色系，最细；
//   政治要素 —— admin0 / indefinite / loc / claim / ADM1 / ADM2 共用一个基色系（原 natColor 的灰），
//              彼此靠【线型与线宽】区分，低等级靠【透明度】退后，不靠换颜色。
export const BORDER_DEF = {
  coastColor: '#8fa6b8', coastWidth: 1.0, coastOpacity: 0.85, coastDash: 'solid',
  admin0Color: '#a8a8a8', admin0Width: 1.6, admin0Opacity: 1.00, admin0Dash: 'solid',
  indefColor: '#a8a8a8', indefWidth: 1.6, indefOpacity: 0.95, indefDash: 'dash',
  locColor: '#a8a8a8', locWidth: 1.4, locOpacity: 0.90, locDash: 'dashdot',
  claimColor: '#a8a8a8', claimWidth: 1.8, claimOpacity: 0.90, claimDash: 'dash',
  provColor: '#a8a8a8', provWidth: 1.0, provOpacity: 0.80,
  cityColor: '#a8a8a8', cityWidth: 0.7, cityOpacity: 0.60,
  fade: true
}

// 线型的【屏幕像素】图案（画-空交替，长度任意）。3D 按相机距离、2D 按缩放各自反推成自身单位 →
// 任意缩放下虚线视觉周期恒定，且两个视图看起来是同一种线。
export const DASH_PX = { solid: null, dash: [6, 4], dot: [1.2, 3.2], dashdot: [8, 3, 1.5, 3] }
// 主张线取 dash 的半周期（短虚）：它与 indefinite 的区分手段之一，不为此另立一档枚举。
export const DASH_SCALE = { claim: 0.5 }
// ★ claim 的 1.8 = 基准 1.2 × 1.5、下限 1 —— 沿用原 nanhaiDashes.js 的惯例（南海十段线比一般政治线略粗）。
//   原文件把倍数挂在【那一条线】上，这里落到【整类】上：目前 claim 类只有南海十段线一条，结果一模一样；
//   将来若再加别的主张线，它也会拿到这个宽度（要逐线不同就得把 claim 拆成按宽度分组的多批，代价不值）。

export const BORDER_CLASSES = ['coast', 'admin0', 'indefinite', 'loc', 'claim']
// 2D 没有 renderOrder，只能靠画的先后 —— 这就是按 ORDER 从低到高排好的那一份
export const BORDER_DRAW = ['coast', 'claim', 'loc', 'indefinite', 'admin0']
// cls → borderCfg 的字段前缀（indefinite 的字段名缩成 indef，免得每处都写一长串）
export const CFG_KEY = { coast: 'coast', admin0: 'admin0', indefinite: 'indef', loc: 'loc', claim: 'claim' }

// 缩放淡出档位（1.6b 三），判据是「每屏幕像素多少度」——3D 由相机距离折算、2D 由缩放折算，
// 同一口径 → 两个视图的淡出时机一致。≥FADE_FAR 全球视角，≤FADE_NEAR 城市级，中间线性过渡（对数插值）。
export const FADE_FAR = 0.08, FADE_NEAR = 0.02
export const fadeFactor = (degPerPx) => {
  if (!(degPerPx > 0)) return 1
  const t = (Math.log(FADE_FAR) - Math.log(degPerPx)) / (Math.log(FADE_FAR) - Math.log(FADE_NEAR))
  return Math.max(0, Math.min(1, t))
}
// 一级行政区不完全消失（全球视角降到 0.3），二级完全淡出
export const admFade = (t) => ({ adm1: 0.3 + 0.7 * t, adm2: t })
