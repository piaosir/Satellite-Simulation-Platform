// 链路预算可视化配色（GSO / NGSO / 再生式三窗共用）。
//
// 取色不是凭感觉挑的：候选色板经 dataviz 校验器逐项跑过六项硬指标（亮度带 / 彩度下限 /
// 色盲相邻分离度 ΔE / 常色觉分离度 / 对底色对比度），亮暗两套各自对本软件真实底色
// （亮 #ffffff、暗 #1c1c1a）验证通过后才写进来。原先按「期刊风」直觉调的低饱和蓝灰
// (#3f6d8c) 与靛 (#5b5391) 双双卡在彩度下限（0.071 / 0.098 < 0.1，判定为「读起来发灰」），
// 故整体提饱和压亮度到下表——仍是印刷感的深色调，但不再寡淡。改色务必重跑校验器。
//
// 分类色只给三槽：曲线图属「全配对」场景（同坐标系里任意两条线都可能相邻比较），
// 三槽是两模式下都能清关全配对分离度下限的上限。超过三条曲线一律拆成分格小图
// （small multiples），不靠增加色相硬扛。

// 分类色（曲线用）：普鲁士蓝 / 赭橙 / 靛紫
export const SERIES_LIGHT = ['#15619b', '#b8571a', '#6a3d9a']
export const SERIES_DARK = ['#4a8fc9', '#d2792f', '#9878d8']

// 正负/达标与否一类的语义着色不走分类色，一律沿用全局语义色变量（--ok / --danger），
// 与三线表符号列（.k-gain / .k-loss 染 +/− 号）同一套语义，表与图一眼对得上。
// 红绿对色盲不友好，凡用到语义色的地方都须另备一道二级编码（方向、符号、线型），
// 不靠颜色单独承载含义。

// 当前是否暗色主题（<html data-theme="dark">，由 stores/theme.js 写入）
export function isDark() {
  try { return document.documentElement.getAttribute('data-theme') === 'dark' } catch (e) { return false }
}

// 第 i 条曲线的颜色（超出三槽回绕取模：调用方本应先拆小图，此处只作兜底不崩）
export function seriesColor(i) {
  const pal = isDark() ? SERIES_DARK : SERIES_LIGHT
  return pal[((i % pal.length) + pal.length) % pal.length]
}
