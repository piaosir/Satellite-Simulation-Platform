// 边界线的显示规范（渲染次序 / 出厂样式 / 线型图案 / 缩放淡出）—— 3D 球体与 2D 平面图共用这一份，
// 两个视图因此不可能长歪：同一类线在两边是同一个颜色、同一个线宽、同一个屏幕虚线周期、同一档淡出。
//
// 五类线：coast 海岸 · admin0 国界 · indefinite 未定界 · loc 停火线 · claim 主张线。
// 分类由 povResolver 按归属实时派生（见那边的规则表），本文件只管「画成什么样」。

// 渲染次序（从下往上压）。★ 与改造前不同：改造前是省界 6.6 压在「国界+海岸」6.5 之上；
// 国界从海岸线里分出来之后，它应当是最上面那条 —— 一级/二级行政区反而要退到国界与海岸之下。
export const ORDER = { grid: 6.30, adm2: 6.40, adm1: 6.45, coast: 6.50, claim: 6.55, loc: 6.60, indefinite: 6.65, admin0: 6.70 }

// 出厂默认。全部线同一族【冷蓝灰】，层级靠【明度 + 线宽 + 线型】排 —— 越重要的线越深越粗：
//   ★ 国界与海岸线【同色】、且【线粗一律 0.7】（都是用户定的口径）：一张图上只有一种线色、一种粗细，
//     全靠【明度 + 线型】分主次 —— 细匀的发丝线在高分屏与出图上都干净，不会糊成一片。
//     由此主张线（南海十段线）与国界在出厂态下长得一模一样：中国标准地图上这两者本就是同一套线符，
//     要让它更醒目就把主张线的线粗单独调上去（面板里一格就能改）。
//   ★ 这个色比任何一档海色都深，故在浅蓝海上是一条利落的水边线；在深蓝海上又比海色浅，照样看得见。
//     （曾经的 #8fa6b8 比深海色还浅、线还最粗，海岸线成了整幅图最抢眼的一圈「毛边」，层级正好反了。）
//
// ★ 主张线（南海十段线）是【实线】。它本来就是十段实的短线 —— 再套一层虚线图案，每一段都被
//   打成几个小点，画面上只剩一串灰色麻点。中国标准地图上这条线与国界同色、比国界略粗，本表照此。
//
// 经纬网（grid）也在这张表里：它同样是一条线，同样该能改样式、能关掉。
export const BORDER_DEF = {
  coastColor: '#5f86a3', coastWidth: 0.7, coastOpacity: 0.90, coastDash: 'solid',
  admin0Color: '#5f86a3', admin0Width: 0.7, admin0Opacity: 1.00, admin0Dash: 'solid',
  indefColor: '#5f86a3', indefWidth: 0.7, indefOpacity: 0.90, indefDash: 'dash',
  locColor: '#7799ae', locWidth: 0.7, locOpacity: 0.85, locDash: 'dashdot',
  claimColor: '#5f86a3', claimWidth: 0.7, claimOpacity: 1.00, claimDash: 'solid',
  provColor: '#8aa5b8', provWidth: 0.7, provOpacity: 0.85,
  cityColor: '#a3b7c6', cityWidth: 0.7, cityOpacity: 0.70,
  gridOn: true, gridColor: '#607488', gridWidth: 0.7, gridOpacity: 0.28, gridDash: 'solid', gridStep: 15,
  fade: true
}
// 经纬网可选间隔（度）。3D 的网格几何按它重建，2D 是画线时的步长。
export const GRID_STEPS = [5, 10, 15, 30]

// 线型的【屏幕像素】图案（画-空交替，长度任意）。3D 按相机距离、2D 按缩放各自反推成自身单位 →
// 任意缩放下虚线视觉周期恒定，且两个视图看起来是同一种线。
export const DASH_PX = { solid: null, dash: [7, 5], dot: [1.2, 3.2], dashdot: [9, 3.5, 1.6, 3.5] }
// 逐类的虚线周期倍率（1 = 用 DASH_PX 原值）。留着这张表是为了将来再要「同一种线型两种疏密」时有地方挂；
// ★ claim 曾经是 0.5（半周期短虚）—— 那是把十段线打成麻点的直接原因，已去掉。
export const DASH_SCALE = {}

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
