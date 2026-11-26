export const MARK_STYLE_DEF = {
  // 点标记：符号 / 颜色 / 透明度 / 大小 / 描边
  ptShape: 'circle', ptColor: '#ffd24a', ptOpacity: 1, ptDot: 3.5, ptEdge: 0.18, ptEdgeColor: '#ffffff',
  // 序号徽标（圈 1、圈 2）：序号＝点标记表格的行号（数组下标 +1，坐标留空的行照样占号），
  // 图上第 7 号就是表里第 7 行。关掉退回普通符号。
  ptIdxOn: true, ptIdx: 16, idxFill: '#ffd24a', idxFillOpacity: 0.62, idxRing: '#ffffff', idxInk: '#1b1205',
  // 名称 / 坐标标注（名称默认显示——没起名的点什么也不出；坐标默认不显示；两者同一行、共用下面这套字样）
  ptNameOn: true, ptLabelOn: false, ptFont: 14, ptLabelColor: '#ffffff', ptLabelOpacity: 1, ptLabelPos: 'up', ptBold: false,
  // 地球站：符号恒是那枚 Noto 天线（六色写实件，不换形状也不着色 —— 它是这层唯一的符号）
  stOpacity: 1, stIcon: 16,
  stLabelOn: false, stFont: 17, stLabelColor: '#ffffff', stLabelOpacity: 1, stLabelPos: 'down', stBold: false,
  // 航迹：线（航行/飞行两档色，某条航迹可自带覆盖色）+ 航点圆点 + 载具图标 + 航迹名
  tjSea: '#ff6a4a', tjFlight: '#5ad1ff', tjWidth: 2.2, tjOpacity: 0.95, tjDash: 'solid',
  tjDot: 4, tjDotSea: '#ff9a5a', tjDotFlight: '#5ad1ff',
  tjIconOn: true, tjIconPx: 26, tjIconSea: '#ff6a4a', tjIconFlight: '#5ad1ff',
  tjNameOn: false, tjNameFont: 13, tjNameColor: '#ffffff', tjNameBold: false,
  // 飞行航迹 3D 按实际高度画；「延伸到地面」＝航迹线到地面之间一道半透明垂幕（真实比例下高度靠它才看得出来）
  tjCurtain: true
}

export function restoreMarkerStyle(markStyle, s) {
  // 标记层样式：老存档把尺寸/显隐散成一堆 mk* 键，先按其迁移；新的 markStyle 对象随后覆盖
  if (Number.isFinite(s.mkPt)) markStyle.ptFont = s.mkPt
  if (Number.isFinite(s.mkPtDot)) markStyle.ptDot = s.mkPtDot
  if (Number.isFinite(s.mkPtIdx)) markStyle.ptIdx = s.mkPtIdx
  if (Number.isFinite(s.mkStIcon)) markStyle.stIcon = s.mkStIcon
  if (Number.isFinite(s.mkStFont)) markStyle.stFont = s.mkStFont
  // 圆点大小口径换过一次：老的 mkTrajDot 是半径系数（可见直径 = 值 × 18/32 × 2.5），新的 mkTrajDotPx
  // 直接就是直径。老存档按同一条换算折过来，屏上大小不变。
  if (Number.isFinite(s.mkTrajDotPx)) markStyle.tjDot = s.mkTrajDotPx
  else if (Number.isFinite(s.mkTrajDot)) markStyle.tjDot = Math.max(1, Math.min(60, Math.round(s.mkTrajDot * (18 / 32) * 2.5)))
  if (Number.isFinite(s.mkTrajIcon)) markStyle.tjIconPx = s.mkTrajIcon
  if (typeof s.mkPtShow === 'boolean') markStyle.ptLabelOn = s.mkPtShow
  if (typeof s.mkPtIdxShow === 'boolean') markStyle.ptIdxOn = s.mkPtIdxShow
  if (typeof s.mkStShow === 'boolean') markStyle.stLabelOn = s.mkStShow
  if (typeof s.mkTrajIconShow === 'boolean') markStyle.tjIconOn = s.mkTrajIconShow
  // 逐字段按类型合并（旧存档没这一项时全留出厂值 / 迁移值）
  if (s.markStyle && typeof s.markStyle === 'object') {
    for (const [k, v] of Object.entries(s.markStyle)) {
      const d = MARK_STYLE_DEF[k]
      if (d === undefined) continue
      if (typeof d === 'boolean') { if (typeof v === 'boolean') markStyle[k] = v }
      else if (typeof d === 'number') { if (Number.isFinite(v)) markStyle[k] = v }
      else if (typeof v === 'string' && v) markStyle[k] = v
    }
  }
}

export const pointLegend = (markStyle, p, i) => (markStyle.ptIdxOn
  ? { type: 'badge', text: i + 1, badge: { fill: (p && p.color) || markStyle.idxFill, fillOpacity: markStyle.idxFillOpacity, ring: markStyle.idxRing, ink: markStyle.idxInk } }
  : { type: 'symbol', shape: markStyle.ptShape, fill: (p && p.color) || markStyle.ptColor, opacity: markStyle.ptOpacity, edge: markStyle.ptEdge, edgeColor: markStyle.ptEdgeColor })
export const trackColor = (markStyle, t) => t.color || (t.kind === 'flight' ? markStyle.tjFlight : markStyle.tjSea)
export const trackLegend = (markStyle, t) => ({ type: 'icon', icon: t.kind === 'flight' ? 'plane' : 'ship', color: trackColor(markStyle, t) })
