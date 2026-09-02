// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 3D 球体共用单一来源）
import { ARCTIC_ISLAND_LAT, landColors, setLandPalette, getLandPalette } from '../landPalette.js'
// 底图的面/线/国名/点选全部由主权解算层按归属实时算出（与 3D 球体同一份），视角 = 一张归属表
import { resolvedFeatures, resolvedLines, labelSet, ensureDetail, onPovChange } from '../geo/povResolver.js'
// 五类边界线的渲染次序 / 出厂样式 / 屏幕像素虚线图案 / 缩放淡出档位：与 3D 球体共用同一份常量
import { BORDER_DEF, DASH_PX, DASH_SCALE, BORDER_DRAW, CFG_KEY, fadeFactor, admFade } from '../geo/borderStyle.js'
import { terminatorFlat } from '../terminator.js'
// 影像瓦片金字塔（EPSG:4326 / GIBS 网格）：网格数学与取片缓存，与 3D 球体共用同一份
import { TILE, span as tileSpan, tileRange, pickZoom, getTileOrParent, tileGutter, loadTiles } from '../imageryTiles.js'
// 点标记序号徽标（圈 1、圈 2）：与 3D 球体共用同一支画笔，两视图观感一致
import { paintNumBadge, BADGE_R } from '../markers/numBadge.js'
// 标记符号（圆点/方块/三角/图钉…）：同上，2D 与 3D 共用同一支画笔
import { paintMarkSymbol, symbolUp, symbolDown } from '../markers/markSymbols.js'
// 地球站符号：与 3D 球体共用同一份定义（原来两处各存一份逐字符相同的副本）
import { stationSvg, STATION_ANCHOR_X, STATION_ANCHOR_Y } from '../stationSymbol.js'
import { drawVehicle, flatHeading } from '../vehicleSymbol.js'
// 应用场景仿真的模块符号（与 3D 球、拓扑图同一支画笔）
import { drawSymbol as drawSceneSymbol } from '../scene/sceneSymbols.js'
// 注记描边色/粗细随底色现算：与 3D 球体共用单一来源
import { haloColor, haloScale, IMAGERY_HALO, IMAGERY_SCALE } from '../labelHalo.js'
// 水域注记（大洋 + 海域）：与 3D 球体共用同一份表（../geo/waterNames.js）
import { waterLabels } from '../geo/waterNames.js'
// 岛链参考线：与 3D 球体共用同一份表
import { chainList, CHAIN_DEF, CHAIN_LABEL_PX } from '../geo/islandChains.js'

const OCEAN = '#15426b'
const BG = '#070b12'
// 切口（左边缘经度）：默认西经 30°，经度范围 [LON0, LON0+360)。可由「地图设置 → 坐标系」改，
// 改后要重烘所有「世界度坐标」(x = lon − LON0) 的 Path2D —— 陆地/边界线/覆盖场/等值线/夜区都是这套坐标。
let LON0 = -30
// 参考系：'ecef' 地固（缺省，地球不动）| 'eci' 惯性（轨道面不动、地球自转着从下面滑过）。
// 地球站图标（与 3D 同一张 SVG）

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const hex = (c) => typeof c === 'number' ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : (c || '#fff')
// 经度解缠：把一条折线/环上各点搬到连续窗口，避免跨 ±180 时被画成横贯全图的假线
function unwrap(ring) {
  const out = new Array(ring.length); let prev = ring[0][0]; out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) { let lo = ring[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; out[i] = [lo, ring[i][1]]; prev = lo }
  return out
}

export function createFlatCoverage(canvas) {
  let ctx = canvas.getContext('2d')   // 绘制目标上下文：导出时临时切到离屏 canvas / svgcanvas（见 exportRender）
  // 导出兼容模式：svgcanvas/canvas2svg 忽略 Path2D 与 evenodd 入参，故导出时把陆地/覆盖填充/等值线
  // 改为「子路径回放」（moveTo/lineTo），实时绘制仍走 Path2D 缓存（更快）。compat 同时用于离屏高清 PNG，
  // 保证 PNG 与 PDF 完全一致。textFont/textFontLatin：导出可指定字体族名（PDF 用注册名匹配嵌入的中文/西文面）。
  let compat = false
  // 地图注记的深色套边（casing）：粗细 = 字号 × CASE_K，下限 CASE_MIN（px）。
  // ★ 全平台一档：3D 球体的 makeLabelSprite / makeWaterLabel / makeCovLabel 按各自画布字号折算出同一比值
  //   （那边同名的三个常数在 globe3d/scene.js 顶部，改这里就得改那里）—— 同一个地名
  //   在平面图与球面上必须一样粗。
  // ★ 屏幕与出图同值，不再对导出另乘系数：所见即所得，PNG/PDF 与在屏一致。
  // ★ 字号越小套边越细（三档）：小字被自己的套边糊住比没有套边更难认。
  // ★ 别再往细里调：注记是白字，压在【浅色陆地】上时套边是它唯一的对比来源 —— 实测 0.07 那一档在
  //   出厂米绿陆地上基本看不见字。下面这三档是逐档实拍比出来的下限（深海 / 三档陆地 / Turbo 覆盖场
  //   红橙蓝黄绿 / 夜区，共八种底色全测），再细就有底色扛不住。
  // ★ 这三档是【浅底】的基准值；深底再乘 haloScale（见 ../labelHalo.js）收到 0.75 —— 那里字与底
  //   已经有对比，套边只需勾个边缘，再粗就是在啃笔画了。
  const CASE_K = 0.15, CASE_MIN = 1.2        // 默认档：国名 / 大洋名 / 波束名 / 数值 / 标记注记
  const CASE_K_P = 0.13, CASE_MIN_P = 1.0    // 一级行政区
  const CASE_K_C = 0.11, CASE_MIN_C = 0.9    // 二级行政区（字最小，套边最细）
  // 地图注记字体：无衬线，独立一档，【不跟】界面字体走。
  // ★ 原来这一串是 global.css --font-ui 的手工镜像；2026-08-29 界面字体做成设置项（设置 →
  //   界面字体）后两者分家 —— 用户把界面换成 TNR + 宋体，地图注记也不跟。理由就是下面这段：
  // ★ 这一层【刻意不跟】全平台的 --font-doc 衬线栈（TNR + 宋体）：那一栈是给报表正文定的，
  //   放到地图上是最恶劣的排版环境——字号常年 10~16px、四面被边界线穿插、还压着深色套边。
  //   宋体是明朝体，横画设计线宽约 0.04 em，13px 下只有 0.5px，抗锯齿后摊成两条浅灰，再被
  //   套边一挤就没了；黑体横竖等宽（约 0.08~0.10 em），同样字号下笔画立得住。制图惯例
  //   （SATSOFT / STK / 各家地图册）这一层一概是无衬线。报表 / Word / PDF 那条路另传 fontFamily，不受影响。
  let textFont = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif'
  // 导出 PDF 专用：西文/数字单独的族名。PDF 的字体按资源整体选用、不像浏览器逐字形回落，故拉丁与中文
  // 各嵌一套，此处按「这条文本里有没有汉字」二选一。null=不分面（屏幕/PNG 走上面的完整回退栈即可）。
  let textFontLatin = null
  const CJK_RE = /[⺀-鿿㐀-䶿豈-﫿　-〿＀-￯]/   // 汉字/假名/中文标点/全角
  // 渲染分辨率倍率（与 3D 同一画质档位）：null=跟随系统 DPR；否则按下面的规则【吸附到 DPR 的整数倍】。
  // ★ 决定文字锐不锐的从来不是倍率高低，是 eff/DPR —— 合成器把画布缩到屏幕的那个比例。等于 1
  //   （像素对位）或 2（2×2 盒式降采样）才不引入重采样；1.5 / 1.33 这类非整数比会把同一根竖笔
  //   这一列渲成 2 px、下一列渲成 1 px，中文小字整片发毛，套边边缘尤其明显。
  //   旧式子 min(rs, dpr×1.5) 在【100% 缩放 + 出厂「高」档 200%】上正好给出 1.5 —— 最坏的那一档。
  // ★ 故改成 eff = dpr × n，n = floor(rs / dpr) 钳在 [1, SS_MULT_MAX]。取 floor 不取 round：
  //   性能档位只能比用户要的便宜、不能更贵（100% 缩放下「中」档 1.5 若四舍五入到 2.0，等于把一个
  //   降档选项偷偷变成 1.78 倍开销）。
  //   实效（出厂「高」档 200%）：100% 缩放 1.5→2.0（比例 2，代价是像素 1.78×，换来字锐）；
  //   125% 缩放 1.875→1.25（比例 1，反而省 56%）；150% 缩放 2.0→1.5（比例 1，省 44%）；
  //   200% 缩放 2.0 不变（本来就是 1:1）。
  // ★ rs < dpr 时原样放行、不吸附：那是用户主动降档省性能（75% 档），吸到 1.0 等于把该档废掉。
  // ★ 3D 球体那边仍是「不吸附的常数封顶 2」（见 globe3d/scene.js 的 SS_CAP）—— 那条路上文字是
  //   精灵纹理、几何有 MSAA，像素栅格对位的收益远没有这里大，故不一并改。
  let renderScale = null
  const SS_MULT_MAX = 2   // 吸附后最多渲到物理像素密度的几倍
  const effDpr = () => {
    const dpr = window.devicePixelRatio || 1
    if (renderScale == null) return Math.max(1, dpr)
    if (renderScale < dpr) return Math.max(0.25, renderScale)
    const n = Math.min(Math.max(1, Math.floor(renderScale / dpr)), SS_MULT_MAX)
    return Math.min(dpr * n, 4)
  }
  let dpr = effDpr()
  let cw = 1, ch = 1, base = 1, scale = 1, tx = 0, ty = 0
  let geom = null
  let fieldLayers = [], fieldAlpha = 0.8   // GRD 覆盖多层（每层=一个天线：分带填充 Path2D + 逐档等值线，独立于 geom）
  let fieldLineAlpha = 1                  // 等值线透明度：与填充那份(fieldAlpha)分开——只填充半透、线仍要看得清是常态
  let covGridLayers = [], covGridAlpha = 0.82   // STK Coverage 覆盖分析【专用通道】：FOM 分带热力图（各胞元四角），独立于 GRD 覆盖场
  // 环境场【专用通道】：一张等经纬位图（ITU 降雨率/零度等温线/海拔…）+ 逐档等值线。
  // 位图不走分带多边形——连续场用栅格一次 drawImage 即可，缩放平移零成本、也不受多边形数量拖累。
  let envImg = null, envBBox = null, envAlpha = 0.78, envSmooth = true
  let envContours = []   // [{ level, text, color, width, lines:[[[lon,lat]...]], labels:[{lon,lat,a}] }]
  // 晨昏线 / 夜区：随时间轴每次推进重算，只存当次的点列（约 360 点，逐帧直接 trace，不烘 Path2D
  // ——量级比覆盖分带小两三个数量级，缓存收益还不如省掉 compat 分支的复杂度）
  let termData = null, termOpts = {}
  // GRD 全局标注选项（与 3D 同步）：波束名 / 峰值点 / 数值标签
  let fieldOpts = { showName: true, nameSize: 16, nameColor: '#ffffff', showBore: true, boreSize: 0.5, boreColor: '#ffffff', showPeak: false, peakSize: 5, peakColor: '#cfd6df', showVal: false, valSize: 12, valColor: '#ffffff' }
  let nameMode = 'off', provVisible = false, prov = null, cityVisible = false, city = null
  // 水域注记两档（大洋 / 海域），各自的档位 'zh' | 'en' | 'off'；waterOff = { id: true } 逐条关掉的那些。
  // 表本身是常量，过滤结果按需缓存 —— 每帧重算 77 条不贵，但没必要。
  let oceanMode = 'off', seaMode = 'off', waterOff = {}
  let oceanLbl = waterLabels('ocean'), seaLbl = waterLabels('sea')
  // 岛链参考线：整层开关 + 逐条显隐 + 一套样式（线与名同色）。默认整层不画。
  const chainCfg = { on: false, ...CHAIN_DEF }
  let chainOff = {}
  let chains = chainList()
  // 名字走与地名同一套避让（chainLbl 是喂给 drawLabelLayer 的形状）
  const chainLbls = () => chains.map((c) => ({ zh: c.zh, en: c.en, lon: c.label[0], lat: c.label[1], px: CHAIN_LABEL_PX, pri: 1e9 }))
  let chainLbl = chainLbls()
  // 国界(海岸线)/省界/地级市界线样式：线宽为恒定屏幕 px、颜色十六进制、透明度 0–1（与 3D 同步）
  // 五类边界线 + 两级行政区的样式：出厂值与 3D 球体同源（src/viz/geo/borderStyle.js）
  let borderStyle = { ...BORDER_DEF }
  let borderPaths = null   // 五类线烘成的世界度坐标 Path2D（换视角/换精度档/改线型时作废）
  // 地名颜色/透明度：五档（国家名 / 省名 / 地级市名 / 大洋名 / 海域名）各自分开
  let labelStyle = {
    countryColor: '#eef2f6', countryOpacity: 1, provColor: '#ffe6a8', provOpacity: 1, cityColor: '#cdd6e0', cityOpacity: 1,
    oceanColor: '#96c3e6', oceanOpacity: 1, seaColor: '#86b0d4', seaOpacity: 1
  }
  // 注记套边：颜色与粗细都按【当前底色】现算（见 ../labelHalo.js）。陆上的注记按陆地基调、
  // 大洋名按海色 —— 那是两个独立设置项，可以一浅一深。开了真彩影像则一律退回恒定近黑。
  const landBg = () => { const sc = getLandPalette().scheme; return sc === 'morandi' ? '#8fa89b' : sc }
  const curHalo = () => (imgOn ? IMAGERY_HALO : haloColor(landBg()))
  const curHaloK = () => (imgOn ? IMAGERY_SCALE : haloScale(landBg()))
  const oceanHalo = () => (imgOn ? IMAGERY_HALO : haloColor(oceanColor))
  const oceanHaloK = () => (imgOn ? IMAGERY_SCALE : haloScale(oceanColor))
  let oceanColor = OCEAN   // 大海填充色（可调，限蓝色系），与 3D 球体同步
  // 影像底图：整幅等经纬世界影像（见 viz/imagery.js 的取向约定）。开启后顶替「海色 + 陆地填充」这两层，
  // 边界线/地名/覆盖场照旧叠其上。imgBright=亮度乘子，压暗是为了让冷蓝灰那族地物线在真彩影像上还看得清。
  // imgEl=整幅档的那张图；imgSet=瓦片档的集名（非空即走瓦片，此时 imgEl 不参与）。
  // 两档并存而不是二选一：瓦片档需要离线包（resources/imagery，约 300 MB，不进 git），
  // 没装包的开发机/精简安装仍能用整幅档，不至于「影像」这一整块功能直接消失。
  let imgOn = false, imgEl = null, imgBright = 1, imgSet = null, imgMaxZ = 7
  // 导出时能不能画位图影像。compat 同时服务两条导出路径（PNG 走真 canvas、PDF 走 svgcanvas 录制），
  // 而影像只对前者成立 —— 后者会把整幅图 base64 塞进 SVG，文件大到不可用。故不能只看 compat。
  let rasterOut = false
  let mk = { points: [], stations: [], trajectories: [] }
  let focusSats = []    // 聚焦卫星星下点列表 [{ lat, lon }...]（多选=每颗各一个图标，同款同大小，不分主次）
  let selGeomList = []  // 聚焦卫星几何列表 [{ footprint:[{lat,lon}...], track:[{lat,lon}...], sub:{lat,lon} }...]，与 3D 同源（多颗同时叠画）
  // 聚焦卫星显示样式（与 3D 同一份设置，由 3D 页 setFocusStyle 推入；线宽/图标尺寸口径与 3D 同为屏幕 px）
  const focusCfg = {
    trkOn: true, trkColor: '#e8c074', trkWidth: 1.6, trkOpacity: 1, trkDash: 'solid',
    fpOn: true, fpColor: '#b8e6fa', fpWidth: 1.6, fpOpacity: 1, fpDash: 'dash',
    fpFillColor: '#b8e6fa', fpFillOpacity: 0,
    subOn: true, subPx: 30, subColor: '#ffffff'
  }
  // 线型 → canvas 虚线数组（屏幕 px；3D 那份按世界弧长切段，两边观感对齐即可，不求逐段一致）。
  // ★ 四档必须与侧栏 DASH_OPTS 一一对上：这张表少一档不会报错，只会让那一档【静默画成实线】——
  //   曾经缺 dashdot，于是聚焦卫星与航迹选「点划线」时 3D 出点划、2D 出实线，同一条线两副样子。
  const DASH_2D = { dash: [7, 5], dot: [1.2, 4], dashdot: [9, 3.5, 1.6, 3.5] }
  let satLayer = null   // 卫星/仰角线独立图层 { lines, dots, labels, sats }（与 geom/field 互不干扰）
  const sizes = { beamFont: 16, contourFont: 12, dotSize: 5, showBore: true, nameScale: 1, provScale: 1, cityScale: 1, oceanScale: 1, seaScale: 1, satIcon: 30 }
  const SAT_ICON_K = 0.85   // 卫星图标：同地球站 ST_ICON_K，2D 观感偏大于 3D，收一档对齐（经验系数，可微调）
  // 标记层样式（点标记 / 地球站 / 航迹）：与 3D 球体同一份设置，由页面 setMarkStyle 推入。
  // 尺寸口径全是【屏幕 px @100% 缩放】，上图时再乘克制版联动系数 iz（见 drawAboveContent）。
  // 逐条覆盖（某个点/某个站自己的颜色与形状）由页面在载荷里解析好后逐条带过来，这里只认 item 上的值。
  const markCfg = {
    ptShape: 'circle', ptColor: '#ffd24a', ptOpacity: 1, ptDot: 3.5, ptEdge: 0.18, ptEdgeColor: '#ffffff',
    ptIdx: 16, idxFill: '#ffd24a', idxFillOpacity: 0.62, idxRing: '#ffffff', idxInk: '#1b1205',
    ptFont: 14, ptLabelColor: '#ffffff', ptLabelOpacity: 1, ptLabelPos: 'up',
    stOpacity: 1, stIcon: 16, stFont: 17, stLabelColor: '#ffffff', stLabelOpacity: 1, stLabelPos: 'down',
    tjWidth: 2.2, tjOpacity: 0.95, tjDash: 'solid', tjDot: 4, tjIconOn: true, tjIconPx: 26,
    tjNameOn: false, tjNameFont: 13, tjNameColor: '#ffffff'
  }
  const PT_DOT_K = 18 / 32 * 2.2     // 点标记：滑块值 → 视觉直径（沿用 3D 圆点精灵的占比换算，两视图同大小）
  // 与 3D 球体标记观感对齐：3D 的文字/圆点精灵都含画布留白（makeCovLabel 字号50→画布高66；dot 直径18的圆居中于32画布），
  // 其屏幕尺寸按整张画布计 → 实际可见的字/点偏小。2D 直接按字号/半径作画、无留白，故乘同等系数收小，两视图一致。
  const MK_FONT_K = 50 / 66      // 文字：3D 实际字高 = 字号 × 50/66 ≈ 0.76
  const ST_ICON_K = 0.85         // 地球站图标：2D 观感略大于 3D，收一档对齐（经验系数，可微调）
  // 克制版缩放联动系数：点标记/地球站/航迹这类实心图标按 √scale 缓增（满速会在大缩放下膨成色块）。
  // ★ 画图与命中判定共用这一支 —— 图上多大就按多大抓，两处各算一遍迟早走偏。
  const izNow = () => Math.sqrt(scale)
  // 逐条覆盖：载荷里带了自己的颜色/形状就用自己的，否则跟整层设置
  const ptSymOf = (p) => ({ shape: markCfg.ptShape, fill: p.color || markCfg.ptColor, opacity: markCfg.ptOpacity, edge: markCfg.ptEdge, edgeColor: markCfg.ptEdgeColor })
  const ptBadgeOf = (p) => ({ fill: p.color || markCfg.idxFill, fillOpacity: markCfg.idxFillOpacity, ring: markCfg.idxRing, ink: markCfg.idxInk })
  // 各自的视觉直径（屏幕 px，含缩放联动）
  const ptDiam = (iz) => Math.max(0.5, (markCfg.ptDot != null ? markCfg.ptDot : 3.5) * iz * PT_DOT_K)
  const idxDiam = (iz) => Math.max(0.5, (markCfg.ptIdx != null ? markCfg.ptIdx : 16) * iz)
  const stBox = (iz) => Math.max(1, (markCfg.stIcon != null ? markCfg.stIcon : 16) * iz * ST_ICON_K)
  // 地球站符号在锚点上/下各占多少 px（址点在图形里的位置，见 stationSymbol.js 的 ANCHOR）
  const stExtent = (box) => ({ up: box * STATION_ANCHOR_Y, down: box * (1 - STATION_ANCHOR_Y), half: box * 0.5 })
  // 标注摆位：pos 上/下/左/右。up/down=符号在锚点上下各占的 px，half=半宽，fh=字高，
  // gap0=主标签与符号之间的余白，step=第二行相对第一行的行距，line=第几行（0 主标签 / 1 第二行）。
  // 左右档走 textAlign 定位（不必量文本宽度），纵向居中；上下档沿用各自原有的距离公式。
  function labelAt(pos, ext, fh, gap0, step, line) {
    if (pos === 'left') return { dx: -(ext.half + fh * 0.42), dy: line * (fh * 1.2), align: 'right' }
    if (pos === 'right') return { dx: ext.half + fh * 0.42, dy: line * (fh * 1.2), align: 'left' }
    if (pos === 'down') return { dx: 0, dy: gap0 + line * step }
    return { dx: 0, dy: -(gap0 + line * step) }
  }

  // 地球站图标（Noto 天线，六色写实件；不着色、不换形状 —— 它是这层唯一的符号）
  const stationImg = new Image(); let stationReady = false
  stationImg.onload = () => { stationReady = true; invalidateStatic(); requestDraw() }
  stationImg.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(stationSvg())))

  // 预处理底图：陆地多边形（按国家配色）+ 国家名 + 大洋名。可经 setMapDetail 换源(10m/50m)重建。
  // 边界抽稀（thin>0，单位度）：与 3D 一致地稀疏化各环顶点，低画质档减少 Path2D 顶点。
  const decimateRing = (ring, minD) => {
    if (!minD || ring.length < 3) return ring
    const out = [ring[0]]; let last = ring[0]
    for (let i = 1; i < ring.length - 1; i++) { const p = ring[i]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minD) { out.push(p); last = p } }
    out.push(ring[ring.length - 1]); return out
  }
  let land = [], clabels = [], borderLines = null
  let mapDetail0 = '10m', mapThin = 0
  function buildBaseGeo(feats, thin) {
    land = []; clabels = []
    borderLines = null
    feats.forEach((f, i) => {
      if (!f.geometry) return
      const id = String(f.id)
      const idx = f.idx != null ? f.idx : i     // 取色序号按【归属】定，争议叠加与其基础面取同一号
      const { base: fill, arctic } = landColors(id, idx)
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      const shapes = [], iceShapes = []   // 普通陆地色 / 北极岛屿冰白（按多边形质心纬度分流）
      for (const rings of polys) {
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        const xy = []   // 导出回放用：该多边形各环的「世界度坐标」点列（x=lon-LON0, y=90-lat）
        for (const ring of rings) {
          const u = thin > 0 ? decimateRing(unwrap(ring), thin) : unwrap(ring)
          const r = new Array(u.length)
          for (let i = 0; i < u.length; i++) { const x = u[i][0] - LON0, y = 90 - u[i][1]; if (x < lo) lo = x; if (x > hi) hi = x; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y); r[i] = [x, y] }
          path.closePath()
          xy.push(r)
        }
        // 北极岛屿（外环质心纬度 ≥ ARCTIC_ISLAND_LAT）整块染冰白；其余按国家色。与 3D 球体同口径，不再纬度渐变。
        const o = rings[0]; let sy = 0; for (const p of o) sy += p[1]
        const shape = { lo, hi, path, rings: xy }
        ;((sy / o.length) >= ARCTIC_ISLAND_LAT ? iceShapes : shapes).push(shape)
      }
      if (shapes.length) land.push({ shapes, fill })
      if (iceShapes.length) land.push({ shapes: iceShapes, fill: arctic })   // 逐国设色时 arctic=用户色（整国一色）
    })
    // 国家名：位置/线度来自解算器的 labelSet（按归属合并，per-POV 改名与 hide 在那里做）；
    // 线度→像素字号的映射式子与换源前一字不改
    // pri = 国家「视觉大小」：地名避让按它排队，大国先得位、小国撞上就让（见 drawLabelLayer）
    for (const l of labelSet('zh', mapDetail0)) clabels.push({ zh: l.zh, en: l.en, lon: l.lon, lat: l.lat, px: clamp(Math.round(10 + l.ext * 0.22), 10, 20), pri: l.ext })
  }
  buildBaseGeo(resolvedFeatures('10m'), 0)
  // 视角/用户覆写改动由解算器广播回来：底图面/线/国名整份重建 + 静态层快照作废
  const offPov = onPovChange(() => {
    borderPaths = null
    buildBaseGeo(resolvedFeatures(mapDetail0), mapThin)
    invalidateStatic(); requestDraw()
  })

  // 合帧：把一帧内的多次重绘请求合并成一次 rAF 渲染（拖拽/缩放不再被高频事件淹没）。
  let rafId = 0
  function requestDraw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; draw() }) }

  // 静态层快照（拖拽波束/调覆盖参数提速核心）：底图(海陆/冰盖/网格)与标注(省界/国家名/标记/卫星层)在拖拽中
  // 完全不变，却原本每帧重画（含上百国家名描边文字，开销大）。把它们渲到离屏缓冲，只在视图变换或静态数据
  // 变化时重建；覆盖图(GRD 填充/等值线)夹在二者之间，故拆「below(field 之下) + above(field 之上)」两张快照。
  // 拖拽/改场只重绘覆盖层，复合 = blit(below) + 覆盖填充/线 + blit(above) + 覆盖标注 + 聚焦星。
  let belowCanvas = null, belowCtx = null, aboveCanvas = null, aboveCtx = null
  let staticValid = false
  function invalidateStatic() { staticValid = false }

  function fit() { base = Math.min(cw / 360, ch / 180); scale = 1; tx = (cw - 360 * base) / 2; ty = (ch - 180 * base) / 2 }
  const k = () => base * scale
  // 世界矩形（屏幕 px）：整幅图就这一张，x∈[tx, tx+360k]、y∈[ty, ty+180k]。
  // ★ 一切绘制都裁到它 —— 平面图是【一张完整的世界地图】，不是可以无限横向翻页的瓦片地图。
  //   经度环绕的 ±360 副本仍然要画：跨接缝的国家（如俄罗斯）本体在右边出界，靠左边那份副本补齐，
  //   裁剪之后两半正好拼成一张，画面上只有一个中国、一个俄罗斯。
  const worldRect = () => { const kk = k(); return { x: tx, y: ty, w: 360 * kk, h: 180 * kk } }
  // ★ 不夹紧平移（用户口径）：拖到哪儿是哪儿，允许把整张图拖出画布 —— 双击 / 「复位」一键 fit 回来。
  //   曾经加过 clampPan（贴边即止），实机上手感是「拖不动」，已取消。
  const WXN = (lon) => (((lon - LON0) % 360) + 360) % 360
  const PX = (lon) => WXN(lon) * k() + tx
  const PY = (lat) => (90 - lat) * k() + ty

  // 陆地：把 pan/zoom 烘进变换矩阵，直接填充缓存的 Path2D（每帧零顶点遍历）。
  // 经度环绕用 -360/0/360 三档偏移，按视口裁剪只画可见副本；描边线宽除以缩放保持 0.8px 恒定。
  // 仅填充陆地（海岸线与其余四类边界线移到覆盖之上的 drawBorders）。覆盖填充叠在陆地填充之上、按 alpha 混合 → 覆盖区底色随之透出。
  // 影像底图：一次 drawImage 铺整幅（缩放采样交给浏览器，随 pan/zoom 零顶点遍历）。
  // ★ 错位：本模块的世界度坐标是 x=lon−LON0，而图像左边缘恒是 −180° → 整幅图落在世界
  //   x ∈ [shift, shift+360]，shift 即 −180° 在世界坐标里的位置。LON0=−30 时 shift=210，
  //   于是屏幕上看到的是「图像右段 + 图像左段」拼起来的一张 —— 与 drawLand 的三档环绕同理，
  //   只是这里按视口精确算需要哪几档，不写死 −360/0/360（放大后一档就够，多画两次是纯浪费）。
  // 返回值＝这一帧到底画出东西没有。瓦片档在离线包缺失时会一片都取不到，调用方据此回退到
  // 矢量底图 —— 不是「黑一块」而是像没开影像一样，用户看得懂、也不至于以为软件坏了。
  function drawImagery() {
    if (imgSet) return drawImageryTiles()
    if (!imgEl) return false
    const kk = k()
    const shift = (((-180 - LON0) % 360) + 360) % 360
    const wl = -tx / kk, wr = (cw - tx) / kk           // 视口世界 X 范围
    let n0 = Math.floor((wl - shift) / 360), n1 = Math.floor((wr - shift) / 360)
    if (!Number.isFinite(n0) || !Number.isFinite(n1)) return false
    if (n1 - n0 > 8) n1 = n0 + 8                        // 极端 pan/缩小的兜底，正常至多两三档
    const f = ctx.filter
    if (imgBright !== 1) ctx.filter = 'brightness(' + imgBright + ')'
    for (let n = n0; n <= n1; n++) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + (shift + n * 360) * kk), dpr * ty)
      ctx.drawImage(imgEl, 0, 0, 360, 180)
    }
    ctx.filter = f
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
    return true
  }

  // 瓦片档：按当前缩放选级、只画视口内那几十片。整幅档是「一次 drawImage 铺 360×180」，
  // 这里是「按 (z,row,col) 逐片贴」，环绕分档与 shift 的口径完全照旧，只是粒度从一整张变成一片。
  //
  // ★ 两个非做不可的细节：
  //   1. 选级按【设备像素】：传 CSS px 会让高 DPR 屏永远低选一级、白糊一层（那正是「买了高分屏
  //      反而更糊」的经典成因）。
  //   2. 片边界【round 到整设备像素】再画：世界坐标下相邻片是严丝合缝的，但落到屏幕上若两片各自
  //      带小数边，浏览器会在缝上留下半透明的一线或叠画一线 —— 就是那种「海面上有网格」的现象。
  //      两片共用同一个 round 结果，缝就必然对齐。
  // 拆成「排布 imageryPlan」与「画 drawImageryTiles」两步：导出那条要先照排布把片【等到位】
  // 再画（见 ensureImagery），否则同步渲染只画得出当时恰好在缓存里的片 —— 那正是「导出全球图
  // 缺一大块」的成因：导出时 fit() 重算 base、dpr 换成放大倍率，选级比屏上深好几级，
  // 而那一级的片一张都没加载过。
  function imageryPlan() {
    const kk = k()
    if (!(kk > 0)) return null
    const shift = (((-180 - LON0) % 360) + 360) % 360
    const wl = -tx / kk, wr = (cw - tx) / kk           // 视口世界 X（度）
    const wt = -ty / kk, wb = (ch - ty) / kk           // 视口世界 Y（度，= 90−lat）
    if (!Number.isFinite(wl) || !Number.isFinite(wr) || !Number.isFinite(wt)) return null
    const north = 90 - Math.max(0, wt), south = 90 - Math.min(180, wb)
    if (!(south < north)) return null                   // 世界矩形完全在视口外
    const z = pickZoom(1 / (kk * dpr), imgMaxZ)
    const s = tileSpan(z)
    const rr = tileRange(z, -180, 180, north, south)
    let n0 = Math.floor((wl - shift) / 360), n1 = Math.floor((wr - shift) / 360)
    if (!Number.isFinite(n0) || !Number.isFinite(n1)) return null
    if (n1 - n0 > 8) n1 = n0 + 8
    const W = cw * dpr, H = ch * dpr
    const items = []
    for (let n = n0; n <= n1; n++) {
      const bandX = shift + n * 360                     // 图像 −180° 在世界 X 里的位置
      const lonW = Math.max(-180, wl - bandX - 180), lonE = Math.min(180, wr - bandX - 180)
      if (!(lonE > lonW)) continue
      const cc = tileRange(z, lonW, lonE, north, south)
      for (let r = rr.r0; r <= rr.r1; r++) {
        const y0 = Math.round((ty + r * s * kk) * dpr), y1 = Math.round((ty + (r + 1) * s * kk) * dpr)
        if (y1 <= 0 || y0 >= H || y1 <= y0) continue
        for (let c = cc.c0; c <= cc.c1; c++) {
          const wx = bandX + c * s                      // 该片西边缘的世界 X
          const x0 = Math.round((tx + wx * kk) * dpr), x1 = Math.round((tx + (wx + s) * kk) * dpr)
          if (x1 <= 0 || x0 >= W || x1 <= x0) continue
          items.push({ r, c, x0, y0, x1, y1 })
        }
      }
    }
    return { z, items }
  }

  function drawImageryTiles() {
    const plan = imageryPlan()
    if (!plan || !plan.items.length) return false
    const f = ctx.filter
    if (imgBright !== 1) ctx.filter = 'brightness(' + imgBright + ')'
    ctx.setTransform(1, 0, 0, 1, 0, 0)                  // 转设备像素：片边界要落在整像素上（见上）
    const G = tileGutter(imgSet)                        // 自切的离线包烘了 1px gutter
    let painted = 0
    for (const it of plan.items) {
      const t = getTileOrParent(imgSet, plan.z, it.r, it.c, onTileReady)
      if (!t) continue                                  // 连祖先都没有：这一片本帧留空，到货后重绘
      ctx.drawImage(t.img,
        G + t.u0 * TILE, G + t.v0 * TILE, (t.u1 - t.u0) * TILE, (t.v1 - t.v0) * TILE,
        it.x0, it.y0, it.x1 - it.x0, it.y1 - it.y0)
      painted++
    }
    ctx.filter = f
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
    return painted > 0
  }

  // 瓦片到货 → 重绘。★ 必须去抖：影像画在 below 静态快照里，而重建那张快照要连上百个国家名一起
  // 重画；几十片在几百毫秒里陆续到货，若逐片触发就是几十次全量静态重建，观感上就是「加载时卡死」。
  let tileTimer = 0
  function onTileReady() {
    if (tileTimer) return
    tileTimer = setTimeout(() => { tileTimer = 0; invalidateStatic(); requestDraw() }, 60)
  }
  function drawLand() {
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk   // 视口世界 X 范围（未含 off）
    for (const off of [-360, 0, 360]) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (compat) {
        // 导出：按填充色合并成「每色一条 path」（节点数不变，但 <path> 元素从「多边形数」降到「颜色数」）。
        // svg2pdf 逐节点 getComputedStyle 是导出耗时主因——10m 底图有数千多边形，不合并会产生数千节点。
        const byColor = new Map()
        for (const c of land) for (const sh of c.shapes) { if (sh.hi + off < wl || sh.lo + off > wr) continue; let a = byColor.get(c.fill); if (!a) { a = []; byColor.set(c.fill, a) } a.push(sh) }
        for (const [fill, shs] of byColor) { ctx.fillStyle = fill; ctx.beginPath(); for (const sh of shs) for (const r of sh.rings) { for (let i = 0; i < r.length; i++) i === 0 ? ctx.moveTo(r[i][0], r[i][1]) : ctx.lineTo(r[i][0], r[i][1]); ctx.closePath() } ctx.fill('evenodd') }
      } else for (const c of land) {
        let colored = false
        for (const sh of c.shapes) {
          if (sh.hi + off < wl || sh.lo + off > wr) continue
          if (!colored) { ctx.fillStyle = c.fill; colored = true }
          ctx.fill(sh.path, 'evenodd')
        }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
  }
  // 五类边界线（coast / claim / loc / indefinite / admin0），画在覆盖填充【之上】，
  // 使地理骨架在覆盖区内外连续 → 覆盖像染进地图、与底图平级。
  // 与陆地填充同一套「世界度坐标 Path2D + 三档经度环绕 + 视口裁剪」，故拖拽时零顶点遍历。
  // ★ 线宽与虚线图案都除以 kk：canvas 的 lineWidth / lineDash 都算在用户空间，除掉缩放即得恒定屏幕像素。
  function bakeBorders() {
    const L = resolvedLines(mapDetail0)
    const out = {}
    for (const cls of BORDER_DRAW) {
      const list = []
      for (const poly of (L[cls] || [])) {
        if (!poly || poly.length < 2) continue
        const u = unwrap(poly)
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        for (let i = 0; i < u.length; i++) {
          const x = u[i][0] - LON0, y = 90 - u[i][1]
          if (x < lo) lo = x
          if (x > hi) hi = x
          i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
        }
        list.push({ lo, hi, path })
      }
      out[cls] = list
    }
    borderPaths = out
    return out
  }
  function drawBorders() {
    const kk = k()
    const P = borderPaths || bakeBorders()
    const wl = -tx / kk, wr = (cw - tx) / kk
    for (const cls of BORDER_DRAW) {
      const list = P[cls]
      if (!list || !list.length) continue
      const key = CFG_KEY[cls]
      ctx.strokeStyle = borderStyle[key + 'Color']
      ctx.lineWidth = borderStyle[key + 'Width'] / kk
      ctx.globalAlpha = borderStyle[key + 'Opacity']
      const px = DASH_PX[borderStyle[key + 'Dash'] || 'solid']
      ctx.setLineDash(px ? px.map((v) => v * (DASH_SCALE[cls] || 1) / kk) : [])
      for (const off of [-360, 0, 360]) {
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        for (const sh of list) { if (sh.hi + off < wl || sh.lo + off > wr) continue; ctx.stroke(sh.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([])
  }
  // ★ 原先这里有一个「南极极冠」：把 −82° 以南整条横带无条件涂成陆地色，用来补老底图（world-atlas）
  //   在极点处留下的圆形空洞。换成主权解算层之后，南极大陆的环三档都自己走到了 −90°（10m 有 724 个
  //   lat=−90 的点），空洞早就没有了 —— 那条横带只剩下副作用：把深入到 −85° 的罗斯海、威德尔海
  //   整片糊成陆地，海陆边界被切成一条横贯全图的直线，冰架前缘的海岸线孤零零浮在陆地色上。
  //   3D 球体那边早已改用 antarcticaFillRings 收口（见 globe3d/scene.js），这里是漏网的另一半，删掉即可。
  //   北极岛屿由 buildBaseGeo 按「多边形整块」染冰白（与 3D 同口径），不需要极冠。
  // 卫星图标（矢量复刻聚焦卫星 SVG：双侧 3×2 太阳能板 + 中央星体）。按 color 填充、size 缩放。
  // 仰角线卫星与聚焦卫星共用此函数 —— 平面图上卫星统一为同一枚图标，颜色随各自设置。
  const SAT_BLOCKS = [[8, 41], [21, 41], [34, 41], [8, 63], [21, 63], [34, 63], [76, 41], [89, 41], [102, 41], [76, 63], [89, 63], [102, 63]]
  function drawSatIcon(lon, lat, size, color) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
    const x = PX(lon), y = PY(lat), s = size || sizes.satIcon || 30
    ctx.save()
    ctx.translate(x, y); ctx.rotate(-20 * Math.PI / 180); ctx.scale(s / 120, s / 120); ctx.translate(-60, -60)
    ctx.fillStyle = color || '#ffffff'; ctx.strokeStyle = 'rgba(8,12,18,0.92)'; ctx.lineWidth = 4; ctx.lineJoin = 'round'
    const rrect = (rx, ry, rw, rh, r) => {
      ctx.beginPath(); ctx.moveTo(rx + r, ry)
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r); ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r)
      ctx.arcTo(rx, ry + rh, rx, ry, r); ctx.arcTo(rx, ry, rx + rw, ry, r)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    for (const [bx, by] of SAT_BLOCKS) rrect(bx, by, 10, 16, 3)
    rrect(49, 35, 22, 50, 10)
    ctx.restore()
  }
  function drawGrid() {
    if (borderStyle.gridOn === false) return
    const kk = k(), x0 = tx, x1 = tx + 360 * kk
    const step = borderStyle.gridStep > 0 ? borderStyle.gridStep : 15
    ctx.save()
    ctx.strokeStyle = borderStyle.gridColor; ctx.lineWidth = borderStyle.gridWidth; ctx.globalAlpha = borderStyle.gridOpacity
    const px = DASH_PX[borderStyle.gridDash || 'solid']
    ctx.setLineDash(px || [])            // ★ 屏幕坐标画的（不像边界线走缩放矩阵），图案不用除 kk
    ctx.beginPath()
    for (let lon = -180; lon <= 180; lon += step) {
      const wx = WXN(lon)
      ctx.moveTo(wx * kk + tx, PY(90)); ctx.lineTo(wx * kk + tx, PY(-90))
      // 接缝那条经线 WXN=0 只画在左边缘，右边缘（+360）得补一条，否则整张图右边没有收口线
      if (wx < 1e-9) { const xr = 360 * kk + tx; ctx.moveTo(xr, PY(90)); ctx.lineTo(xr, PY(-90)) }
    }
    for (let lat = -90 + step; lat <= 90 - step + 1e-9; lat += step) { const y = PY(lat); ctx.moveTo(x0, y); ctx.lineTo(x1, y) }
    ctx.stroke()
    ctx.restore()
  }

  // 岛链参考线。线宽/虚线周期都是【屏幕像素】（drawPolyline 走屏幕坐标），与边界线同一口径。
  // ★ 表里的顶点已在经纬度平面加密过（见 geo/islandChains.js），故这里直连即可，
  //   与 3D 那边补大圆之后的走向仍然一致。
  function drawChains() {
    if (!chainCfg.on || !chains.length) return
    const sa = ctx.globalAlpha
    ctx.globalAlpha = sa * (chainCfg.opacity != null ? chainCfg.opacity : 1)
    const dash = DASH_PX[chainCfg.dash || 'solid']
    for (const c of chains) drawPolyline(c.pts, chainCfg.color, chainCfg.width, false, dash || null)
    ctx.globalAlpha = sa
  }
  function drawPolyline(p, color, width, closed, dash) {
    const kk = k()
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    if (dash) ctx.setLineDash(dash)
    ctx.beginPath(); let started = false, pwx = 0
    for (let i = 0; i < p.length; i++) {
      const a = p[i], lon = Array.isArray(a) ? a[0] : a.lon, lat = Array.isArray(a) ? a[1] : a.lat
      const wx = WXN(lon), x = wx * kk + tx, y = (90 - lat) * kk + ty
      if (started && Math.abs(wx - pwx) > 180) { ctx.stroke(); ctx.beginPath(); started = false }
      started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); pwx = wx
    }
    ctx.stroke()
    if (dash) ctx.setLineDash([])
  }
  function drawText(text, lon, lat, px, color, opt) {
    const o = opt || {}
    const x = PX(lon) + (o.dx || 0), y = PY(lat) + (o.dy || 0)
    const fam = (textFontLatin && !CJK_RE.test(text)) ? textFontLatin : textFont
    ctx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${fam}`
    ctx.textAlign = o.align || 'center'; ctx.textBaseline = 'middle'
    // 文字描边套色(casing)：沿字形勾一圈与底色同调的窄边，把字从背景里「切」出来——专业制图标准，不用底色色块
    // 粗细 = px×strokeScale（缺省 CASE_K），下限 strokeMin（缺省 CASE_MIN）；行政区名传更细的档
    const sScale = o.strokeScale != null ? o.strokeScale : CASE_K, sMin = o.strokeMin != null ? o.strokeMin : CASE_MIN
    const lw = Math.max(sMin, px * sScale * (o.haloK != null ? o.haloK : curHaloK()))
    // o.rot：字随线转（等值线标注用）。转轴放在锚点上，故转后就地画在原点。
    const rot = o.rot ? o.rot * Math.PI / 180 : 0
    if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot) }
    const tx0 = rot ? 0 : x, ty0 = rot ? 0 : y
    // ★ o.opacity 作用于【整个注记】：套边与字面一起淡。曾经只淡字面、套边留满，那等于把滑杆调反了：
    //   白字面淡下去之后剩的是满强度的深色套边，越往「透明」拉，浅底图上的字反而越深越扎眼
    //   （0 处不是消失，是一圈深色空心字）。且 3D 侧的注记是「字面+套边烘成一张贴图、整张改
    //   material.opacity」，即整个注记同步淡入淡出 —— 两视图必须同一口径。
    //   （旧注释担心的「淡掉套边=抹掉浅底上唯一的对比来源」在现在的出厂值下不成立：三级地名
    //   出厂透明度一律 1.0，轻重改由【颜色明度】给；拉低透明度就是要它淡。）
    const op = o.opacity != null ? o.opacity : 1
    const sa = ctx.globalAlpha
    if (op < 1) ctx.globalAlpha = sa * op
    if (lw > 0) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = lw; ctx.strokeStyle = o.halo || curHalo(); ctx.strokeText(text, tx0, ty0) }
    ctx.fillStyle = color; ctx.fillText(text, tx0, ty0)
    if (op < 1) ctx.globalAlpha = sa
    if (rot) ctx.restore()
  }
  // ============ 地名避让 ============
  // 地名字号原本是纯「世界尺寸」（随缩放线性变大），位置也随缩放线性拉开 —— 整幅版面是相似放大，
  // 重叠率与缩放【无关】：英国那 232 个地方议会区、马耳他那 68 个地方议会，放到多大都还是糊成一坨。
  // 两条一起才管用：
  //   ① 字号钳到屏幕像素区间 —— 有了上限，放大才真的腾得出地方（字不再跟着一起变大）；
  //   ② 屏幕空间贪心避让 —— 按优先级逐个摆，撞上已摆的就跳过；放大后间距拉开，先前被剔掉的自己会回来。
  // 优先级：层级为主（大洋名 > 国家名 > 一级行政区 > 二级行政区），同层内比 pri
  //（pri = 该标注到最近邻标注的距离，由 admPacks.mergePacks 预算；辖区大的邻居远、先得位）。
  // ★ 下限是「太小就不画」，不是「撑大到这个数」：字号倍率能调到 0.1，撑大就等于把那个档位废掉。
  //   门槛压到 2.5px：倍率是用户自己设的，设成 0.2 就是要那一片小字，这一层只拦真正的单像素噪点。
  //   （曾取 5px，配上出厂的省名 0.6 / 市名 0.2 倍率，等于把中国地级市这一层在 ×6 以下整层关掉。）
  const LB_DROP = 2.5, LB_MAX = 22     // 地名字号：低于 LB_DROP 像素不画，高于 LB_MAX 像素封顶
  const LB_DROP_KEEP = 1.2             // 常显标注的下限只剩物理的那一条：再小 canvas 连一个像素都画不出
  // 碰撞盒：半高取 0.5 em（CJK 字面框正好一个 em，textBaseline=middle 时上下各半），加半像素间隙。
  // 别用「行高」那种 0.62 —— 那是给排版留的行距，用在避让上等于凭空把每个名字撑大四分之一，
  // 挤掉的全是港澳这种「小而重要」的邻居。
  const LB_HK = 0.5, LB_PADX = 1, LB_PADY = 0.5
  // ★ 标注一律画在单元质心上，不做「撞了挪一格」的候选位偏移：位置准确是第一位的，
  //   名字挪出辖区（香港的字落到深圳湾）比少显示一个更糟。位置不动，改成【允许适度重叠】：
  //   判定盒按下面两个系数收缩，相邻名字可以互相侵入这么多而仍然都画。
  //   横向放到 35%（中文横排，左右挨紧还认得出）；纵向只放 12%（上下压住笔画就废了）。
  //   标定依据（1600×900，出厂倍率）：不许重叠时香港要放到 ×24 才与澳门共存，这一档提前到 ×14；
  //   中国地级市 ×6 从 291/331 提到 307/331。再放宽收益就没了，只是越来越糊。
  const LB_OVX = 0.65, LB_OVY = 0.88
  const SLOT_G = 64                    // 占位表网格边长（px）
  const newSlots = () => new Map()
  const slotRange = (s, x0, y0, x1, y1, fn) => {
    for (let i = Math.floor(x0 / SLOT_G); i <= Math.floor(x1 / SLOT_G); i++) {
      for (let j = Math.floor(y0 / SLOT_G); j <= Math.floor(y1 / SLOT_G); j++) { if (fn(i + ',' + j)) return true }
    }
    return false
  }
  const slotFits = (s, x0, y0, x1, y1) => !slotRange(s, x0, y0, x1, y1, (k) => {
    const arr = s.get(k)
    if (!arr) return false
    for (const r of arr) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return true
    return false
  })
  const slotAdd = (s, x0, y0, x1, y1) => { slotRange(s, x0, y0, x1, y1, (k) => { let a = s.get(k); if (!a) s.set(k, a = []); a.push([x0, y0, x1, y1]); return false }) }
  // 文本屏幕宽度估算。★ 不调 measureText：这一层每次视图变化都要重排几千条，逐条量文本太贵，
  // 而避让只需要包围盒量级 —— 汉字按 1 em、其余按 0.55 em 估已经够准。
  const textW = (t, px) => { let w = 0; for (const ch of t) w += CJK_RE.test(ch) ? 1 : 0.55; return w * px }
  // 一层地名：钳字号 → 视口剔除 → 按 pri 降序 → 逐个避让 → 画。slots 三层共用，故层间也不会互撞。
  function drawLabelLayer(list, slots, nameOf, scaleK, zf, color, opt) {
    const arr = []
    for (const l of list) {
      // ★ 封顶只作用于【地图缩放带来的增长】，不作用于【用户拉的字号倍率】：
      //   倍率是用户的直接意图，拉了就得跟着走；封顶要管的是「放大地图时字与间距同比涨、
      //   避让永远腾不出地方」那件事。所以先对 px×zf 封顶，再乘倍率。
      const fs = Math.round(Math.min((l.px || 12) * zf, LB_MAX) * scaleK)
      if (fs < (l.keep ? LB_DROP_KEEP : LB_DROP)) continue   // 太小：不画，也不占位
      const x = PX(l.lon), y = PY(l.lat)
      if (x < -160 || x > cw + 160 || y < -40 || y > ch + 40) continue
      const name = nameOf(l)
      if (!name) continue
      arr.push({ l, name, fs, x, y, hw: (textW(name, fs) / 2) * LB_OVX + LB_PADX, hh: fs * LB_HK * LB_OVY + LB_PADY })
    }
    // 排队：先看 rk（NE 的 labelrank，越小越该先标；构建期写进包里），再看 pri（到最近邻的距离）
    arr.sort((a, b) => ((b.l.keep ? 1 : 0) - (a.l.keep ? 1 : 0)) ||
      ((a.l.rk || 12) - (b.l.rk || 12)) || ((b.l.pri || 0) - (a.l.pri || 0)))
    for (const e of arr) {
      // 常显（KEEP_ISO 的国家）：不判碰撞，挤到也画；但照常登记占位，免得别人再压上来
      if (!e.l.keep && !slotFits(slots, e.x - e.hw, e.y - e.hh, e.x + e.hw, e.y + e.hh)) continue
      slotAdd(slots, e.x - e.hw, e.y - e.hh, e.x + e.hw, e.y + e.hh)
      drawText(e.name, e.l.lon, e.l.lat, e.fs, color, opt)
    }
  }
  function dot(lon, lat, r, fill, ring) {
    const x = PX(lon), y = PY(lat)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill()
    if (ring) { ctx.lineWidth = Math.max(1, r * 0.35); ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke() }
  }
  // 峰值点标记：细十字（对齐 SATSOFT §11.1 Contour Dialog 的 Beam Peak Label「+」；3D 侧 makeCovCross 同款）。
  // 叉心＝那个点，两条细臂不遮挡下面的等值线/填充。span = 十字全长(px)。
  // ★ 线宽【恒定屏幕像素】，不随 span 走：按比例给线宽的话，放大几档笔画就跟着变粗，十字成了一个又粗又笨
  //   的实心加号（SATSOFT 的十字自始至终是一根细线）。与等值线同档线宽，故也不需要深色套边——等值线自己也没有。
  const CROSS_W = 1.3            // 十字线宽（屏幕 px），与 3D 侧 scene.js 的 CROSS_W 同值
  function cross(lon, lat, span, color) {
    const x = PX(lon), y = PY(lat), a = span * 0.5
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.lineWidth = CROSS_W; ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a)
    ctx.stroke()
    ctx.restore()
  }

  // GRD 分带填充：与 3D 同源——由 bandGeometry 逐三角形切出的各档环带多边形（lon/lat）。每档把全部多边形
  // 烘成一个「世界度坐标」Path2D（x=lon-LON0, y=90-lat，仅在 setField 时一次），同档多边形并入一条 path
  // 一次 fill → 相邻三角形无 AA 缝隙。draw() 随 pan/zoom 只用 setTransform 平移缩放矢量填充（清晰、分辨率无关），
  // 并在 -360/0/+360 三档经度环绕各填一份 → 跨东经180° 无缝。地平/接缝裁剪已在 bandGeometry 内完成。
  // 一层覆盖在「世界 X」(=lon-LON0) 上的经度跨度，供 drawField 的 ±360 环绕做视口裁剪（只填可见副本）。
  function layerBounds(L) {
    let lo = Infinity, hi = -Infinity
    const upd = (lon) => { const x = lon - LON0; if (x < lo) lo = x; if (x > hi) hi = x }
    if (L.fillBands) for (const fb of L.fillBands) { const v = fb.verts; for (let i = 0; i < v.length; i += 2) upd(v[i]) }
    if (L.segGroups) for (const grp of L.segGroups) for (const sg of (grp.segs || [])) { upd(sg[0][0]); upd(sg[1][0]) }
    if (lo > hi) return null
    return { lo, hi }
  }
  function buildFillPaths(fillBands) {
    return fillBands.map((fb) => {
      const path = new Path2D()
      const verts = fb.verts, counts = fb.counts
      let vi = 0
      for (let j = 0; j < counts.length; j++) {
        const plen = counts[j]
        // 扁平缓冲上就近解缠（跨 ±180° 的多边形不会被直线横扫全图）：首点原值，后续相对滚动 prev 取最近副本
        let prev = verts[vi * 2]
        path.moveTo(prev - LON0, 90 - verts[vi * 2 + 1])
        for (let q = 1; q < plen; q++) {
          let lo = verts[(vi + q) * 2]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360
          path.lineTo(lo - LON0, 90 - verts[(vi + q) * 2 + 1]); prev = lo
        }
        path.closePath()
        vi += plen
      }
      return { color: 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')', path }
    })
  }
  // 等值线：与填充同策略——每档一条「世界坐标」Path2D（x=lon-LON0, y=90-lat），仅在 setField/patchField 时烘一次。
  // draw() 随 pan/zoom 只用 setTransform 平移缩放矢量描边（每帧零路径构建），±360 环绕在 drawField 内按视口裁剪。
  // 段两端就近解缠（跨 ±180° 不被直线横扫全图）。线宽在描边时 /kk 保持恒定屏幕 px。
  function buildSegPaths(segGroups) {
    return segGroups.map((grp) => {
      const path = new Path2D()
      for (const sg of (grp.segs || [])) {
        let a = sg[0][0], b = sg[1][0]; while (b - a > 180) b -= 360; while (b - a < -180) b += 360
        path.moveTo(a - LON0, 90 - sg[0][1]); path.lineTo(b - LON0, 90 - sg[1][1])
      }
      return { color: grp.color || 'rgba(255,255,255,0.9)', width: grp.width || 1.2, path }
    })
  }

  // 导出回放：把一档填充环带 / 一组等值线段描进当前路径（与 buildFillPaths/buildSegPaths 同款就近解缠）。
  function traceFillBand(fb) {
    const verts = fb.verts, counts = fb.counts
    let vi = 0; ctx.beginPath()
    for (let j = 0; j < counts.length; j++) {
      const plen = counts[j]; let prev = verts[vi * 2]
      ctx.moveTo(prev - LON0, 90 - verts[vi * 2 + 1])
      for (let q = 1; q < plen; q++) { let lo = verts[(vi + q) * 2]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; ctx.lineTo(lo - LON0, 90 - verts[(vi + q) * 2 + 1]); prev = lo }
      ctx.closePath(); vi += plen
    }
  }
  function traceSegGroup(grp) {
    ctx.beginPath()
    for (const sg of (grp.segs || [])) { let a = sg[0][0], b = sg[1][0]; while (b - a > 180) b -= 360; while (b - a < -180) b += 360; ctx.moveTo(a - LON0, 90 - sg[0][1]); ctx.lineTo(b - LON0, 90 - sg[1][1]) }
  }

  // 夜区填充 + 晨昏分界线。世界坐标 x=lon−LON0、y=90−lat，与覆盖层同一套 setTransform + ±360 环绕。
  // 采样起点已在 terminatorFlat 里对齐到 LON0（地图接缝）→ 世界 X 单调 0→360，多边形不会被接缝撕开。
  // 画在 drawEnvRaster 之前（即所有数据层之下、底图之上）：夜区是「打光」不是「数据」，
  // 只该压暗底图，不该把覆盖场/等值线一起蒙灰；国界地名在 aboveCanvas，天然压在其上。
  function drawTerminator() {
    if (!termData) return
    const kk = k(), wl = -tx / kk, wr = (cw - tx) / kk
    const o = termOpts
    ctx.save()
    for (const off of [-360, 0, 360]) {
      if (off + 360 < wl || off > wr) continue          // 该副本整幅落在视口外
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (o.night !== false) {
        ctx.globalAlpha = o.nightOpacity != null ? o.nightOpacity : 0.42
        ctx.fillStyle = o.nightColor || '#0a1120'
        ctx.beginPath()
        const ng = termData.night
        ctx.moveTo(ng[0][0] - LON0, 90 - ng[0][1])
        for (let i = 1; i < ng.length; i++) ctx.lineTo(ng[i][0] - LON0, 90 - ng[i][1])
        ctx.closePath(); ctx.fill()
      }
      if (o.line !== false) {
        ctx.globalAlpha = o.lineOpacity != null ? o.lineOpacity : 0.75
        ctx.strokeStyle = o.lineColor || '#ffd27a'
        ctx.lineWidth = (o.lineWidth || 1.2) / kk       // 除以缩放 → 恒定屏幕像素宽
        ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath()
        const ln = termData.line
        ctx.moveTo(ln[0][0] - LON0, 90 - ln[0][1])
        for (let i = 1; i < ln.length; i++) ctx.lineTo(ln[i][0] - LON0, 90 - ln[i][1])
        ctx.stroke()
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }

  function drawField() {
    const kk = k()
    // 填充：把 pan/zoom 烘进变换矩阵，直接填充缓存的世界坐标 Path2D（每帧零顶点遍历），-360/0/+360 三档环绕。
    // 环绕副本按视口裁剪：放大到某区域时三份里通常只有一份可见 → 大足迹填充成本直降到 1/3（拖拽开填充提速核心）。
    const wl = -tx / kk, wr = (cw - tx) / kk
    ctx.save(); ctx.globalAlpha = fieldAlpha
    for (const L of fieldLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const fb of (L.fillBands || [])) { ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
    // 逐档等值线（多层，每层每档一色）：复用缓存的世界坐标 Path2D，setTransform 平移缩放矢量描边（每帧零构建），
    // ±360 环绕按视口裁剪只描可见副本（与填充同策略）。线宽 /kk 保持恒定屏幕 px。
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.save(); ctx.globalAlpha = fieldLineAlpha
    for (const L of fieldLayers) {
      if (!L.segPaths || !L.segPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const grp of (L.segGroups || [])) { if (!grp.segs || !grp.segs.length) continue; ctx.strokeStyle = grp.color || 'rgba(255,255,255,0.9)'; ctx.lineWidth = (grp.width || 1.2) / kk; traceSegGroup(grp); ctx.stroke() }
        else for (const sp of L.segPaths) { ctx.strokeStyle = sp.color; ctx.lineWidth = sp.width / kk; ctx.stroke(sp.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }
  // STK Coverage FOM 热力图填充：与 drawField 填充同款（缓存的世界坐标 Path2D + setTransform + ±360 环绕视口裁剪），
  // 用独立 covGridLayers / covGridAlpha，画在 GRD 覆盖场【之下】（叠加时 GRD 天线足迹在其上）。无等值线。
  // 环境场栅格：整张等经纬位图一次 drawImage，按 ±360 环绕补副本（与分带填充同样的三档裁剪）。
  // 位图边界不受缩放影响 → 放大后看到的是数据本身的格子，不再有矢量层的重建成本。
  // 矢量 PDF 那条路（svgcanvas）把位图转成 <image>，但不认 globalAlpha —— 直接画会比 PNG 深一截。
  // 故导出时把整层透明度先烘进一张临时位图，两条导出路径才逐像素一致。缓存随图/透明度失效。
  let envFade = null, envFadeKey = ''
  function envImageForDraw() {
    if (!compat || !(envAlpha < 0.999)) return envImg
    const key = envImg.width + 'x' + envImg.height + '@' + envAlpha
    if (envFadeKey !== key) {
      const c = document.createElement('canvas')
      c.width = envImg.width; c.height = envImg.height
      const g = c.getContext('2d'); g.globalAlpha = envAlpha; g.drawImage(envImg, 0, 0)
      envFade = c; envFadeKey = key
    }
    return envFade
  }
  function drawEnvRaster() {
    if (!envImg || !envBBox) return
    const kk = k(), bb = envBBox
    const x0 = WXN(bb.lonMin), w = (bb.lonMax - bb.lonMin) * kk
    const y = PY(bb.latMax), h = (bb.latMax - bb.latMin) * kk
    const img = envImageForDraw()
    ctx.save(); ctx.globalAlpha = img === envImg ? envAlpha : 1
    // 分级填色要看得见硬边界（那条边界就是等值线），故插值开关跟着显示模式走
    const sm = ctx.imageSmoothingEnabled
    ctx.imageSmoothingEnabled = envSmooth
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    for (const off of [-360, 0, 360]) {
      const x = (x0 + off) * kk + tx
      if (x > cw || x + w < 0) continue
      ctx.drawImage(img, x, y, w, h)
    }
    ctx.imageSmoothingEnabled = sm; ctx.globalAlpha = 1; ctx.restore()
  }
  // 环境场等值线（+ 沿线数值标注）：画在场之上，仍压在国界/地名之下
  function drawEnvContours() {
    if (!envContours.length) return
    const iz = Math.sqrt(scale)
    for (const g of envContours) {
      for (const ln of (g.lines || [])) drawPolyline(ln, g.color, Math.max(0.1, (g.width || 1) / Math.max(1, iz * 0.9)))
    }
    for (const g of envContours) {
      if (!g.text) continue
      for (const an of (g.labels || [])) drawText(g.text, an.lon, an.lat, Math.max(7, 11 * (k() / 13.1)), g.labelColor || '#ffffff', { rot: an.a, strokeScale: CASE_K * 1.15 })
    }
  }
  function drawCovGrid() {
    if (!covGridLayers.length) return
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk
    ctx.save(); ctx.globalAlpha = covGridAlpha
    for (const L of covGridLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of [-360, 0, 360]) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const fb of (L.fillBands || [])) { ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }
  // GRD 标注层（波束名 / 峰值点 / 数值标签）：画在填充+等值线之上，随各层 bore/segGroups 数据
  function drawFieldOverlays() {
    const o = fieldOpts
    // 覆盖分析(GRD)注记：十字(峰值点)与文字(波束名/峰值/数值)一律按【世界尺寸】联动。
    // 文字为何用世界尺寸：3D 侧这三种标签都由 makeCovLabel(hpx=字号/533) 生成 = 世界尺寸精灵（随缩放线性变化、含每度像素）。
    // 旧实现 2D 文字用「字号 × iz」——既非世界尺寸律(iz=√scale)、又漏掉每度像素 base → 切到 3D 后 2D 明显偏大(默认视角约 2.6×)。
    // 改为与 3D 同源：2D 世界尺寸 px = hpx × 750 × zf(=k()/13.1)，与卫星层数值标签、地名标定完全一致，两视图恒同大。
    const zf = k() / 13.1
    const covFont = (size) => Math.round(size / 533 * 750 * zf)   // 字号(valSize/peakSize/nameSize) → 2D 世界尺寸 px，与 3D makeCovLabel(字号/533) 一致
    for (const L of fieldLayers) {
      if (o.showVal) for (const grp of (L.segGroups || [])) { if (grp.txt == null) continue; for (const an of (grp.labels || [])) drawText(String(grp.txt), an[0], an[1], covFont(o.valSize || 12), o.valColor || '#ffffff') }
      const b = L.bore; if (!b) continue
      // b.hit=false ＝ 峰值方向越过地平（对星壳层视图＝没打到那层壳）：十字与峰值电平一律不画，
      // b.lon/lat 此时只是该方向的地平/相切点，仅作波束名的锚。
      const hit = b.hit !== false
      // b.onEarth=false ＝ 波束整个越过地平，画面上这一层一条线一片色都没有 → 名字也不画
      // （只留一个孤零零的名字浮在洋面上，是从前的残留）。对星壳层那份不给这一位 → 默认放行。
      const named = o.showName && L.name && b.onEarth !== false
      // 十字全长(px) = 世界尺寸 × 750 × zf = boreSize × BORE_SPAN(0.024, 见 scene.js) × 750 × zf
      // → boreSize × 18 × zf。两视图恒同大；圆点那版走的是「克制版 iz」，与 3D 对不上，一并归位。
      const span = (o.boreSize != null ? o.boreSize : 0.5) * 18 * zf
      const crossOn = o.showBore && hit
      const peakOn = o.showPeak && hit && b.peak != null
      const pf = covFont(o.peakSize || 5), nf = covFont(o.nameSize || 16)
      const lift = (crossOn ? span * 0.5 : 0) + 1.125 * zf     // 让开十字上臂 + 一点空隙
      if (crossOn) cross(b.lon, b.lat, span, o.boreColor || '#ffffff')
      // 峰值读数与波束名自上而下码在十字【上方】（SATSOFT 排布：波束名 / 读数 / ＋）；读数只印数字不带单位
      if (peakOn) drawText(b.peak.toFixed(2), b.lon, b.lat, pf, o.peakColor || '#cfd6df', { dy: -(lift + pf * 0.5) })
      if (named) drawText(L.name, b.lon, b.lat, nf, o.nameColor || '#ffffff', { dy: -(lift + (peakOn ? pf * 1.15 : 0) + nf * 0.5) })
    }
  }

  // field 之下的底图（海陆/冰盖/网格）。渲到主画布后由 renderStaticLayers 拷到 belowCanvas。
  function drawBelowContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 影像模式：整幅影像顶替海色 + 陆地填充。
    // 导出时分两路：PNG（raster:true，真 canvas）照画影像；PDF/SVG 矢量导出不画 ——
    // 位图会被 svgcanvas 整幅 base64 塞进 SVG，文件大到不可用，那条路仍出矢量底图。
    // drawImagery 返回 false ＝ 这一帧一片都没取到（瓦片档但离线包缺失/还没到货）→ 回退矢量底图。
    // 判据放在「画完之后」而不是「画之前探测」：探测要么多一次异步往返、要么要维护一个可用性状态机，
    // 而这里天然自愈 —— 包补上了下一帧就自己切回影像。
    if (imgOn && (imgSet || imgEl) && (!compat || rasterOut) && drawImagery()) {
      /* 影像已铺满，海色与陆地填充这两层被顶替 */
    } else {
      ctx.fillStyle = oceanColor; ctx.fillRect(rx, ry, rw, rh)
      drawLand()
    }
    ctx.restore()
  }
  // field 之上的标注（省界/标记/国家名/卫星层点标注等）。透明背景，叠在覆盖填充之上。
  // 各类数据线（GXT 波束线/仰角线/聚焦卫星线）不在此层——见 drawDataLines（压在国界省界之下）。
  // 航迹是例外：整层（线+圆点+图标）在此层的【地名之后】画，见 drawTrajLayer。
  function drawAboveContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 随缩放联动系数：mz=scale（与国家名同率，用于数值/覆盖/卫星层等注记）；scale=1 即当前大小。
    // iz=√scale 是「克制版」联动：点标记/地球站/航迹这类实心图标若按 mz 满速放大，2D 缩放幅度大(可达60×)会膨成大色块，
    // 故按 √scale 缓增——仍随缩放变化、scale=1 时不变，但放大时增长更温和、不至于过大。
    const mz = scale, iz = izNow()
    // 经纬网 + 行政区界 + 五类边界线画在覆盖填充之上：地理骨架贯穿覆盖区内外，覆盖与底图融为一体（平级），
    // 不再像贴纸浮在上面。次序从下往上：经纬网 → 二级行政区 → 一级行政区 → 海岸 → 主张 → 停火 → 未定 → 国界。
    drawGrid()
    // 缩放分级：全球视角下二级行政区完全淡出、一级降到 0.3（政治五类不参与——国界在任何尺度都在）
    const admF = admFade(borderStyle.fade ? fadeFactor(1 / k()) : 1)
    // 二级行政区界（画在一级之下，一级更醒目）
    if (cityVisible && city && admF.adm2 > 0.01) {
      ctx.globalAlpha = borderStyle.cityOpacity * admF.adm2
      for (const ring of city.borders) drawPolyline(ring, borderStyle.cityColor, borderStyle.cityWidth)
      ctx.globalAlpha = 1
    }
    // 一级行政区界
    if (provVisible && prov) {
      ctx.globalAlpha = borderStyle.provOpacity * admF.adm1
      for (const ring of prov.borders) drawPolyline(ring, borderStyle.provColor, borderStyle.provWidth)
      ctx.globalAlpha = 1
    }
    drawBorders()   // 海岸 → 主张 → 停火 → 未定 → 国界（国界压在最上面）
    drawChains()    // 岛链参考线：叠在全部底图线之上（它是注记，不该被国界盖住）
    // 覆盖数据标注（GXT 波束线本体已移入 drawDataLines：与 GRD 等值线/Polygon 边线同层、压在国界省界之下）
    if (geom) {
      if (sizes.showBore) for (const d of (geom.dots || [])) dot(d.lon, d.lat, Math.max(1, sizes.dotSize) * iz, '#fff')   // GXT 波束中心点：克制版联动
    }
    // 航迹整层（线 + 圆点 + 载具图标）已挪到地名层之后 —— 见下方 drawTrajLayer 的调用处。
    // 点标记 + 地球站（符号/颜色/大小/描边可调，逐条可覆盖；按克制版 iz 联动）
    const si = stBox(iz), ptD = ptDiam(iz)
    // 序号徽标（p.idx 非空即开）：圆本身就是记号，圈心＝该点位置，故不再另画圆点。
    // 直径按 iz 联动、3D 侧按 zoomK 联动，同一条尺寸律（见 scene.setMarkers）。
    const idxD = idxDiam(iz)
    const idxFont = textFontLatin || textFont   // 编号是纯数字 → 走西文面（出 PDF 时字体族名跟着换）
    for (const p of mk.points) {
      if (p.idx) paintNumBadge(ctx, PX(p.lon), PY(p.lat), idxD, p.idx, idxFont, ptBadgeOf(p))
      else paintMarkSymbol(ctx, PX(p.lon), PY(p.lat), ptD, ptSymOf(p))
    }
    // 纵向锚点走 STATION_ANCHOR_Y（符号里那颗白色址点），不再是方框底边 —— 3D 侧的
    // sprite.center 用 1−STATION_ANCHOR_Y 对齐同一处，两视图的站址才落在同一个像素上。
    if (stationReady) {
      const sa = ctx.globalAlpha
      if (markCfg.stOpacity < 1) ctx.globalAlpha = sa * Math.max(0, markCfg.stOpacity)
      for (const s of mk.stations) ctx.drawImage(stationImg, PX(s.lon) - si * STATION_ANCHOR_X, PY(s.lat) - si * STATION_ANCHOR_Y, si, si)
      ctx.globalAlpha = sa
    }
    // 地名层：字号随缩放联动，且与 3D 球体的「世界尺寸」地名严格一致。
    // 原理：3D 地名是世界尺寸（固定地理度数），其屏幕 px = 地理度数 × 每度像素。2D 同覆盖下每度像素 = k()。
    // 故 2D 字号 = 地理度数 × k()。标定：3D 普通省名 hpx=0.02→1.146°，对应 2D 基准 l.px=15 → 系数 k()/13.1。
    // 这样把"每度像素"折进 zf：font = l.px × 倍率 × (k()/13.1)，与窗口尺寸无关、与 3D 一致。
    // 标记/波束/数值/覆盖/卫星层等注记文字：随缩放联动（乘 mz=scale，scale=1 即当前大小，与国家名同率缩放）；
    // 卫星图标改按 mz 联动（与卫星名标签同率缩放，避免图标/标签缩放不一致），不同于地球站/点标记的克制版 iz。
    const ns = sizes.nameScale || 1, zf = k() / 13.1
    // 五层地名共用一张占位表，按「大洋名 → 国家名 → 海域名 → 一级 → 二级」的先后顺序摆位：先摆的占住地方，
    // 后摆的撞上就不画。层间也因此不会互相压 —— 省名不会盖在国名上。
    // ★ 海域名排在国家名【之后】：边缘海/海湾比国家一级，挤不掉国名；但它画在水面上，与国名很少真撞。
    // ★ 水域注记（大洋 + 海域）画在海上 → 套边按【海色】那一档算（海色与陆色是两个独立设置项，可以一浅一深）
    const water = { italic: true, halo: oceanHalo(), haloK: oceanHaloK() }
    const slots = newSlots()
    // 岛链名第一批摆位：这一层是用户特意打开的，不该被底图地名挤掉
    if (chainCfg.on && chainCfg.name !== 'off') {
      drawLabelLayer(chainLbl, slots, (l) => (chainCfg.name === 'en' ? l.en : l.zh), chainCfg.nameSize || 1, zf, chainCfg.color, { ...water, opacity: chainCfg.opacity })
    }
    if (oceanMode !== 'off') {
      drawLabelLayer(oceanLbl, slots, (l) => (oceanMode === 'en' ? l.en : l.zh), sizes.oceanScale || 1, zf, labelStyle.oceanColor, { ...water, opacity: labelStyle.oceanOpacity })
    }
    if (nameMode !== 'off') {
      drawLabelLayer(clabels, slots, (l) => (nameMode === 'en' ? l.en : l.zh), ns, zf, labelStyle.countryColor, { opacity: labelStyle.countryOpacity })
    }
    if (seaMode !== 'off') {
      drawLabelLayer(seaLbl, slots, (l) => (seaMode === 'en' ? l.en : l.zh), sizes.seaScale || 1, zf, labelStyle.seaColor, { ...water, opacity: labelStyle.seaOpacity })
    }
    if (provVisible && prov) {
      drawLabelLayer(prov.labels, slots, (l) => l.name, sizes.provScale || 1, zf, labelStyle.provColor, { strokeScale: CASE_K_P, strokeMin: CASE_MIN_P, opacity: labelStyle.provOpacity })
    }
    if (cityVisible && city) {   // 二级最后摆：一级不在场的地方它才有位子
      drawLabelLayer(city.labels, slots, (l) => l.name, sizes.cityScale || 1, zf, labelStyle.cityColor, { strokeScale: CASE_K_C, strokeMin: CASE_MIN_C, opacity: labelStyle.cityOpacity })
    }
    // ★ 航迹层压在【地名之上】：制图分工是「面在文字下、线/点在文字上」——
    //   填充面盖住文字是整片消失，细线穿过文字只吃掉几个像素、字还认得出；反过来一个带套边的地名
    //   压在航迹上一次吃掉几十像素的线，而线的连续性本身就是信息（有没有拐、是一条还是两条、
    //   末点是不是真到那儿）。载具图标＝当前位置，等同「本船符号」，更不能被底图地名盖住。
    //   线/圆点/图标必须同层：只提点不提线会把航迹切断、圆点却浮在字上，比整层压下去更怪。
    drawTrajLayer(iz, ST_ICON_K)
    drawSceneLayer(iz, ST_ICON_K)   // 场景层与航迹同层序（地名之上）
    if (geom) {   // GXT 覆盖图标签（波束名/数值）：克制版联动 iz
      for (const l of (geom.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.03) * 533 * iz), l.color || '#fff')
    }
    // 坐标在圆点上方、仰角在下方：与 3D 侧 setMarkers 的 sprite center.y（-0.35 / 1.35）同口径。
    // 换算：sprite 屏幕高 H = pf / MK_FONT_K，字在其中垂直居中，center.y = c 时字心距锚点 (0.5 - c)·H；
    // 2D textBaseline='middle'，dy 即字心偏移，canvas 向上为负 → dy = ∓(0.5 - c)·H = ∓0.85·H。
    // 点标记是用户点/拖出来的，标签在下方会被鼠标指针（箭头本体在热点右下）当场压住。
    const MK_UP = 0.85 / MK_FONT_K   // ≈1.122：字心到锚点的距离 ÷ 字高
    // 位置可选上/下/左/右（markCfg.ptLabelPos / stLabelPos）；出厂仍是「坐标在上、仰角在下」那一档。
    // ★ 仰角只在【坐标也摆在下方】时才让到第二行，其余档位一律留在符号正下方 —— 它是另一件事
    //   （聚焦某颗星才出现），跟着坐标一起跑会让人以为两行是一体的。
    const ptPos = markCfg.ptLabelPos || 'up', stPos = markCfg.stLabelPos || 'down'
    for (const p of mk.points) {
      const pf = markCfg.ptFont * iz * MK_FONT_K   // 点标记文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      const sh = markCfg.ptShape
      // 带序号徽标时字心要让开圈（外沿比例 BADGE_R，与 3D 同一支）；没有徽标按该形状自己的外沿
      const eUp = p.idx ? idxD * BADGE_R : symbolUp(sh) * ptD, eDn = p.idx ? idxD * BADGE_R : symbolDown(sh) * ptD
      const ext = { up: eUp, down: eDn, half: (p.idx ? idxD : ptD) * 0.5 }
      const dU = Math.max(pf * MK_UP, eUp + pf * 0.7), dD = Math.max(pf * 0.9 * MK_UP, eDn + pf * 0.63)
      if (p.label) {
        const a = labelAt(ptPos, ext, pf, ptPos === 'down' ? dD : dU, pf * 1.2, 0)
        drawText(p.label, p.lon, p.lat, pf, markCfg.ptLabelColor, { dx: a.dx, dy: a.dy, align: a.align, opacity: markCfg.ptLabelOpacity })
      }
      if (p.el) {   // 聚焦卫星仰角：亮白，标记下方（坐标也在下方时让到第二行）
        const a = labelAt('down', ext, pf * 0.9, dD, pf * 1.2, (ptPos === 'down' && p.label) ? 1 : 0)
        drawText(p.el, p.lon, p.lat, pf * 0.9, '#ffffff', { dx: a.dx, dy: a.dy })
      }
    }
    for (const s of mk.stations) {
      const sf = markCfg.stFont * iz * MK_FONT_K   // 地球站文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      // 锚点在址点上，符号还有一截落在锚点下方（址点那颗圆的下半 / 几何符号的下半），
      // 字要整体让开这一截，否则与址点叠在一起
      const ext = stExtent(si)
      const gapD = ext.down + sf * 0.5 + 0.5 * iz, gapU = ext.up + sf * 0.5 + 0.5 * iz, step = sf + 3 * iz
      if (s.name) {
        const a = labelAt(stPos, ext, sf, stPos === 'up' ? gapU : gapD, step, 0)
        drawText(s.name, s.lon, s.lat, sf, markCfg.stLabelColor, { dx: a.dx, dy: a.dy, align: a.align, opacity: markCfg.stLabelOpacity })
      }
      if (s.el) {   // 聚焦卫星仰角：亮白，恒在名称之下
        const a = labelAt('down', ext, sf * 0.9, gapD, step, (stPos === 'down' && s.name) ? 1 : 0)
        drawText(s.el, s.lon, s.lat, sf * 0.9, '#ffffff', { dx: a.dx, dy: a.dy })
      }
    }
    // 卫星 / 仰角线独立图层：等仰角线 + 卫星图标 + 名称（在覆盖/标记之上、聚焦图标之下）
    if (satLayer) {
      // 卫星层所有线（Polygon 边线随 drawSatPolyLines、仰角线等随 drawDataLines）均画在 below/above 之间
      // → 压在国界/省界/地名之下，与之共存；这里只画点/标签/卫星图标
      // d.px：屏幕恒定像素半径（Polygon 顶点手柄，不随缩放变大）；否则沿用世界联动尺寸
      for (const d of (satLayer.dots || [])) {
        const dx = PX(d.lon), dy2 = PY(d.lat)   // 视口外剔除：波束合成大群（数百点）放大后大多在屏外，逐点画纯浪费
        if (dx < -24 || dx > cw + 24 || dy2 < -24 || dy2 > ch + 24) continue
        dot(d.lon, d.lat, d.px != null ? Math.max(1, d.px) : Math.max(2, d.r != null ? d.r : 4) * mz, hex(d.color != null ? d.color : 0xffd27a), true)
      }
      for (const l of (satLayer.labels || [])) {   // 世界尺寸字号：与 3D makeCovLabel 同源（套用地名标定 hpx0.02↔px15，zf=k()/13.1），2D/3D 一致
        const px = Math.round((l.hpx || 0.026) * 750 * zf)
        if (l.cullPx && px < l.cullPx) continue    // 自适应编号：小于可读下限的糊点直接不画（缩小看大群时天量文字全免）
        const lx2 = PX(l.lon), ly2 = PY(l.lat)
        const mw = px * (String(l.text == null ? '' : l.text).length * 0.4 + 1)
        if (lx2 < -mw || lx2 > cw + mw || ly2 < -px || ly2 > ch + px) continue   // 视口外剔除（含文字宽裕量）
        drawText(l.text, l.lon, l.lat, px, l.color || '#fff')
      }
      for (const s of (satLayer.sats || [])) { if (s.lon == null || s.lat == null || s.iconShow === false) continue; drawSatIcon(s.lon, s.lat, (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K, hex(s.color != null ? s.color : 0xffd27a)) }   // 颜色/大小随各星设置；图标按 mz 联动，与卫星名标签同率缩放；iconShow 单独控制显隐
      for (const s of (satLayer.sats || [])) {
        if (!s.name || s.lon == null || s.lat == null || s.labelShow === false) continue
        const ls = (s.labelSize || 9) * mz
        // 名称紧贴图标：间隙=0，只留图标半高的偏移（无图标时名称直接锚在星位置）
        drawText(s.name, s.lon, s.lat, ls, hex(s.color != null ? s.color : 0xffd27a), { dy: -(s.iconShow !== false ? (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K * 0.5 : 0) })
      }
    }
    ctx.restore()
  }
  // 重建两张静态快照：分别渲到主画布再拷到离屏缓冲（below 不透明含底色；above 透明叠加）。
  function renderStaticLayers() {
    const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
    const bw = belowCanvas.width, bh = belowCanvas.height
    // below：海陆/冰盖/网格（含背景底色）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
    drawBelowContent(rx, ry, rw, rh)
    belowCtx.setTransform(1, 0, 0, 1, 0, 0); belowCtx.clearRect(0, 0, bw, bh); belowCtx.drawImage(canvas, 0, 0)
    // above：省界/覆盖数据/标记/国家名/卫星层（透明）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
    drawAboveContent(rx, ry, rw, rh)
    aboveCtx.setTransform(1, 0, 0, 1, 0, 0); aboveCtx.clearRect(0, 0, bw, bh); aboveCtx.drawImage(canvas, 0, 0)
  }

  // Polygon 区域填充：画在 GRD 覆盖场之前（叠加规则 2D/3D 统一：叠加区只显示覆盖图颜色，
  // Polygon 在该处只剩边线——边线由 drawSatPolyLines 画在覆盖之后）。100% 不透明也不遮国界/地名
  // （above 层在其后）。填充用世界度坐标（x=WXN 就近解缠, y=90-lat），±360 环绕副本各填一份
  // （跨东经 180° 无缝），调用方已裁剪到地图矩形。实时走 Path2D + 变换矩阵；导出 compat 模式
  // （svgcanvas 忽略 Path2D）改屏幕坐标子路径回放，与陆地/覆盖填充同策略。
  function drawSatFills() {
    if (!satLayer) return
    const kk = k()
    ctx.save()
    for (const f of (satLayer.fills || [])) {
      if (!f.p || f.p.length < 3) continue
      const W = []
      let prev = WXN(f.p[0][0]), lo = prev, hi = prev
      W.push([prev, 90 - f.p[0][1]])
      for (let i = 1; i < f.p.length; i++) {
        let wx = WXN(f.p[i][0])
        while (wx - prev > 180) wx -= 360
        while (wx - prev < -180) wx += 360
        if (wx < lo) lo = wx
        if (wx > hi) hi = wx
        W.push([wx, 90 - f.p[i][1]]); prev = wx
      }
      let path = null
      if (!compat) {
        path = new Path2D()
        path.moveTo(W[0][0], W[0][1])
        for (let i = 1; i < W.length; i++) path.lineTo(W[i][0], W[i][1])
        path.closePath()
      }
      ctx.fillStyle = hex(f.color); ctx.globalAlpha = f.opacity != null ? f.opacity : 0.18
      for (const s of [-360, 0, 360]) {
        if (hi + s < 0 || lo + s > 360) continue   // 该副本完全在地图外 → 跳过
        if (compat) {
          ctx.beginPath()
          ctx.moveTo((W[0][0] + s) * kk + tx, W[0][1] * kk + ty)
          for (let i = 1; i < W.length; i++) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty)
          ctx.closePath(); ctx.fill()
        } else {
          ctx.save(); ctx.translate(tx + s * kk, ty); ctx.scale(kk, kk); ctx.fill(path); ctx.restore()
        }
      }
    }
    ctx.restore()
  }
  // Polygon 边线（under:true 的线）：画在 GRD 覆盖之后（叠加区仍可见）、above 层之前（被国界/地名
  // 压在下面）
  function drawSatPolyLines() {
    if (!satLayer) return
    for (const ln of (satLayer.lines || [])) if (ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.1, ln.width || 1.4))
  }
  // 航迹整层：折线 + 逐航点圆点 + 航迹头载具图标。★三样必须同层同序，画在 above 层的地名之后
  // （调用处在 drawAboveContent 的地名层之下方，理由见那里的注释）。仰角线/覆盖圈等仍留在
  // drawDataLines：那些是「场」的边界、性质近参考层，与国界同层合适；航迹是实体轨迹，不一样。
  // iz=克制版缩放联动、stIconK=图标尺寸律，均由调用处（drawAboveContent）传入，口径与那边一致。
  // ═══ 应用场景仿真 · 场景层 ═══
  // 与航迹同一层序（画在地名之上）：连线的连续性本身就是信息，被地名切断就读不出拓扑了。
  // 数据由页面推入（setScene），几何一律用与标记层同一套 PX/PY 投影 —— 不另立一套。
  let scLayer = { mods: [], links: [], cfg: {} }
  const SC_TIER_COLOR = { satellite: '#3d7fbf', power: '#c8c8c2', constraint: '#c8c8c2', contract: '#d8a73a', supply: '#8a8a84' }
  // ★ 场景符号走【点要素】的口径，不走地名那条「按底图明度分档」的口径 —— 两者不是一回事：
  //   地名恒压在自己那块陆地上，故可以按陆色定深浅；场景模块（船、浮标、机巢、信关站）
  //   哪儿都可能落，同一图上一半在陆一半在海，单挑一档必有一半读不出来。
  //   平台自己的点要素（vehicleSymbol 的船机、stationSymbol 的地球站、地球站标注）一律是
  //   「白面 + 深色套边」——套边把符号从任何底色里切出来，两种底都成立。这里随同一条。
  const sceneInk = () => '#ffffff'
  const sceneHalo = () => (imgOn ? IMAGERY_HALO : 'rgba(6,11,18,0.82)')
  function drawSceneLayer(iz, stIconK) {
    const cfg = scLayer.cfg || {}
    if (cfg.on === false) return
    const byId = new Map(scLayer.mods.map((m) => [m.id, m]))
    const ink = cfg.ink || sceneInk()
    const halo = cfg.case || sceneHalo()
    // ① 连线（三档判据各一档画法，与拓扑图同一套颜色语言）
    if (cfg.links !== false) {
      const sa = ctx.globalAlpha
      for (const l of scLayer.links) {
        const a = byId.get(l.aId), b = byId.get(l.bId)
        if (!a || !b) continue
        const col = SC_TIER_COLOR[l.tier] || '#c8c8c2'
        // ★ 一端定不出位置（NGSO 卫星没有历元就没有星下点）：不画一条假线，
        //   而是从有位置那端向天顶画一段短标 + 对端名字 —— 「这条链在这里上天」是真的，
        //   「它现在在天上哪个位置」不是本视图能说的。GEO 有星下点，由页面按定点经度给出。
        const ga = a.lat != null && a.lon != null, gb = b.lat != null && b.lon != null
        if (ga !== gb) {
          const g = ga ? a : b, o = ga ? b : a
          const x = PX(g.lon), y = PY(g.lat)
          const len = 22 * iz * stIconK
          ctx.save()
          ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4])
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - len); ctx.stroke()
          ctx.setLineDash([])
          ctx.restore()
          if (cfg.labels !== false && o.name) {
            drawText('↑ ' + o.name, g.lon, g.lat, 11 * iz * MK_FONT_K, ink,
              { dy: -(len + 8 * iz), halo })
          }
          continue
        }
        if (!ga || !gb) continue
        const w = l.tier === 'satellite' ? 2.2 : 1.5
        const dash = l.tier === 'contract' ? [7, 5] : (l.role === 'backup' ? [6, 4] : null)
        ctx.globalAlpha = sa * (l.sel ? 1 : 0.85)
        drawPolyline([{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }], l.sel ? '#3d7fbf' : col, l.sel ? w + 1 : w, false, dash)
      }
      ctx.globalAlpha = sa
    }
    // ② 模块符号
    const si = (cfg.iconPx != null ? cfg.iconPx : 26) * iz * stIconK
    const sa2 = ctx.globalAlpha
    ctx.globalAlpha = sa2 * Math.max(0, Math.min(1, cfg.opacity != null ? cfg.opacity : 1))
    for (const m of scLayer.mods) {
      if (m.lat == null || m.lon == null) continue
      const x = PX(m.lon), y = PY(m.lat)
      if (m.sel) {
        ctx.save(); ctx.strokeStyle = '#3d7fbf'; ctx.lineWidth = Math.max(1.2, si * 0.06)
        ctx.beginPath(); ctx.arc(x, y, si * 0.62, 0, Math.PI * 2); ctx.stroke(); ctx.restore()
      }
      drawSceneSymbol(ctx, m.symbol, x, y, si, m.color || ink, 0, halo)
    }
    ctx.globalAlpha = sa2
    // ③ 名称。★ 同一站址上常常摞着好几个模块（信关站与数据中心都在北京、机巢里的件都在一个点），
    //    名字若都摆在同一位置就是一团糊 —— 按共址顺序逐条往下错开一行。
    if (cfg.labels !== false) {
      const nf = (cfg.fontPx != null ? cfg.fontPx : 13) * iz * MK_FONT_K
      const seen = new Map()
      for (const m of scLayer.mods) {
        if (m.lat == null || m.lon == null || !m.name) continue
        const k = m.lat.toFixed(3) + ',' + m.lon.toFixed(3)
        const n = seen.get(k) || 0; seen.set(k, n + 1)
        drawText(m.name, m.lon, m.lat, nf, cfg.labelColor || ink,
          { dy: si * 0.56 + nf * 0.85 + n * nf * 1.22, halo })
      }
    }
  }
  /** 屏幕坐标 → 命中的场景模块 id（页面用来做选中与拖拽） */
  function sceneHitAt(clientX, clientY, iz, stIconK) {
    const r = canvas.getBoundingClientRect()
    const sx = (clientX - r.left), sy = (clientY - r.top)
    const si = ((scLayer.cfg && scLayer.cfg.iconPx != null ? scLayer.cfg.iconPx : 26) * (iz || 1) * (stIconK || 1))
    let best = null
    for (const m of scLayer.mods) {
      if (m.lat == null || m.lon == null) continue
      // PX/PY 出的是位图坐标（含 dpr），指针给的是 CSS 坐标 —— 换算到同一把尺再比
      const d = Math.hypot(sx - PX(m.lon) / dpr, sy - PY(m.lat) / dpr)
      if (d <= (si / dpr) * 0.62 && (!best || d < best.d)) best = { id: m.id, d }
    }
    return best ? best.id : null
  }

  function drawTrajLayer(iz, stIconK) {
    // 线：颜色由页面逐条给（整层按航行/飞行两档，某条航迹可自带覆盖色），线粗/透明度/线型是整层设置
    const sa0 = ctx.globalAlpha
    ctx.globalAlpha = sa0 * Math.max(0, Math.min(1, markCfg.tjOpacity != null ? markCfg.tjOpacity : 0.95))
    const tjDash = DASH_2D[markCfg.tjDash] || null
    for (const t of mk.trajectories) if (t.pts && t.pts.length > 1) drawPolyline(t.pts, hex(t.color != null ? t.color : 0xff5a5a), Math.max(0.1, markCfg.tjWidth != null ? markCfg.tjWidth : 2.2), false, tjDash)
    ctx.globalAlpha = sa0
    // 圆点大小可调 markCfg.tjDot（0＝不画），按克制版 iz 联动。
    // ★ tjDot 与 tjIconPx 同一把尺（都是【屏幕 px @100% 缩放】、同一档位区间），
    //   但圆点按【该数的一半】作直径 —— 同一个数下实心圆比图标那种镂空剪影重得多，等大时圆点抢戏。
    //   点标记的 ptDot 仍是老的半径口径（滑块上的数不等于屏幕尺寸），两者不要互相抄。
    const trajD = (markCfg.tjDot != null ? markCfg.tjDot : 4) * iz / 2
    if (trajD > 0) {
      for (const t of mk.trajectories) {
        const c = hex(t.dotColor != null ? t.dotColor : (t.color != null ? t.color : 0xff9a5a))
        for (const p of (t.pts || [])) paintMarkSymbol(ctx, PX(p.lon), PY(p.lat), trajD, { shape: 'circle', fill: c, opacity: markCfg.tjOpacity, edge: 0.18, edgeColor: 'rgba(255,255,255,0.92)' })
      }
    }
    // 航迹头（末航点）上的载具图标：航行＝船、飞行＝飞机，形状与 3D 同一份（viz/vehicleSymbol.js）。
    // 朝向取末段在【图上】的走向 —— 2D 的航迹是按经纬度直连画的，图标得贴着那条线（口径见 flatHeading）。
    if (markCfg.tjIconOn !== false && (markCfg.tjIconPx == null || markCfg.tjIconPx > 0)) {
      const vi = (markCfg.tjIconPx != null ? markCfg.tjIconPx : 26) * iz * stIconK   // 与地球站图标同一条尺寸律
      const sa = ctx.globalAlpha
      ctx.globalAlpha = sa * Math.max(0, Math.min(1, markCfg.tjOpacity != null ? markCfg.tjOpacity : 0.95))
      for (const t of mk.trajectories) {
        const tp = t.pts || []; if (!tp.length) continue
        const hd = tp[tp.length - 1]
        drawVehicle(ctx, t.kind, PX(hd.lon), PY(hd.lat), vi, flatHeading(tp[tp.length - 2], hd), hex(t.iconColor != null ? t.iconColor : (t.color != null ? t.color : 0xff5a5a)))
      }
      ctx.globalAlpha = sa
    }
    // 航迹名（默认不画）：锚在航迹头上，让开载具图标那一截
    if (markCfg.tjNameOn && markCfg.tjNameFont > 0) {
      const nf = markCfg.tjNameFont * iz * MK_FONT_K
      const vi = (markCfg.tjIconOn !== false ? (markCfg.tjIconPx != null ? markCfg.tjIconPx : 26) : 0) * iz * stIconK
      for (const t of mk.trajectories) {
        const tp = t.pts || []; if (!tp.length || !t.name) continue
        const hd = tp[tp.length - 1]
        drawText(t.name, hd.lon, hd.lat, nf, markCfg.tjNameColor, { dy: -(vi * 0.5 + nf * 0.7) })
      }
    }
  }
  // 数据线统一层（GXT 波束线 / 仰角线等卫星层线 / 聚焦卫星足迹与轨迹）：与 GRD 等值线、
  // Polygon 边线同一画法同一层——画在覆盖之上、above 快照（国界/省界/市界/地名）之下 → 与国界省界共存，
  // 边界压在线上仍清晰可见。各线的圆点/标签仍留在 above 层或顶层（属标注，不遮边界线）。
  // ★航迹不在此层（已提到地名之上，见 drawTrajLayer）。
  function drawDataLines() {
    if (geom) for (const ln of (geom.lines || [])) if (ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color), Math.max(0.1, ln.width || 1.6))
    if (satLayer) for (const ln of (satLayer.lines || [])) if (!ln.under && ln.p && ln.p.length > 1) drawPolyline(ln.p, hex(ln.color != null ? ln.color : 0x66ddff), Math.max(0.1, ln.width || 1.4))   // 下限 0.1：跟随全库统一的线粗最细档
    // 聚焦卫星几何（实时，不入快照）：覆盖范围 + 星下点轨迹，样式与 3D 球体同一份设置；多选=每颗都画
    const sa = ctx.globalAlpha
    for (const g of selGeomList) {
      if (focusCfg.fpOn && g.footprint && g.footprint.length > 1) {
        ctx.globalAlpha = sa * Math.max(0, Math.min(1, focusCfg.fpOpacity))
        drawPolyline(g.footprint, focusCfg.fpColor, Math.max(0.1, focusCfg.fpWidth), false, DASH_2D[focusCfg.fpDash] || null)
      }
      if (focusCfg.trkOn && g.track && g.track.length > 1) {
        ctx.globalAlpha = sa * Math.max(0, Math.min(1, focusCfg.trkOpacity))
        drawPolyline(g.track, focusCfg.trkColor, Math.max(0.1, focusCfg.trkWidth), false, DASH_2D[focusCfg.trkDash] || null)
      }
    }
    ctx.globalAlpha = sa
  }
  // 覆盖圈填充（与 Polygon 区域填充同一层band：画在 GRD 覆盖场之前）。世界度坐标 + ±360 环绕副本，
  // 与 drawSatFills 同策略；★足迹可以套住极点（极轨星过极区就是），此时解缠后经度跨满 360° 且首尾不闭合
  //   —— 必须补两点收到极点边上，否则 canvas 自动收口成一条横穿地图的直边、填出一块假区域。
  function drawFocusFills() {
    if (!focusCfg.fpOn || !(focusCfg.fpFillOpacity > 0)) return
    const kk = k()
    ctx.save()
    ctx.fillStyle = focusCfg.fpFillColor; ctx.globalAlpha = Math.max(0, Math.min(1, focusCfg.fpFillOpacity))
    for (const g of selGeomList) {
      const ring = g.footprint
      if (!ring || ring.length < 3) continue
      const W = []
      let prev = WXN(ring[0].lon), lo = prev, hi = prev, latSum = 0
      W.push([prev, 90 - ring[0].lat]); latSum += ring[0].lat
      for (let i = 1; i < ring.length; i++) {
        let wx = WXN(ring[i].lon)
        while (wx - prev > 180) wx -= 360
        while (wx - prev < -180) wx += 360
        if (wx < lo) lo = wx
        if (wx > hi) hi = wx
        W.push([wx, 90 - ring[i].lat]); prev = wx; latSum += ring[i].lat
      }
      // 绕极判据：解缠后首尾经度差满一圈（足迹环按方位等分生成，绕极时必然单调走满 360°）
      if (Math.abs(W[W.length - 1][0] - W[0][0]) > 300) {
        const north = g.sub && Number.isFinite(g.sub.lat) ? g.sub.lat >= 0 : latSum >= 0
        const py = north ? 0 : 180   // y = 90 - lat
        W.push([W[W.length - 1][0], py], [W[0][0], py])
      }
      for (const s of [-360, 0, 360]) {
        if (hi + s < 0 || lo + s > 360) continue   // 该副本完全在地图外 → 跳过
        ctx.beginPath()
        ctx.moveTo((W[0][0] + s) * kk + tx, W[0][1] * kk + ty)
        for (let i = 1; i < W.length; i++) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty)
        ctx.closePath(); ctx.fill()
      }
    }
    ctx.restore()
  }
  // 聚焦卫星星下点图标（最上层）：按 iz=√scale 克制联动（与 2D 导出/地球站/航迹一致，防止高倍放大时
  // 膨大、更贴 3D）；多选=每颗各一个。大小/颜色取聚焦设置，单点可用 px/colorHex 覆盖（对星分析用）。
  function drawFocusIcons() {
    if (!focusCfg.subOn) return
    const iz = Math.sqrt(scale) * SAT_ICON_K
    // ★ 颗数多时改画实心点：卫星图形是十来个圆角矩形，canvas 上实测 30~60 µs/个 —— 三千颗一次重绘就是
    //   100 ms 以上，平移/缩放会拖住整张图；而那个密度下图形本身也糊成一团。点保留位置与颜色，
    //   一颗都不丢（3D 端已合批成贴图点层，不受此限）。
    const dotMode = focusSats.length > 300
    for (const p of focusSats) {
      const px = Number(p.px) > 0 ? Number(p.px) : focusCfg.subPx
      const color = p.color || focusCfg.subColor
      if (dotMode) {
        const r = Math.max(1, px * iz * 0.14)
        ctx.beginPath(); ctx.arc(PX(p.lon), PY(p.lat), r, 0, Math.PI * 2)
        ctx.fillStyle = color; ctx.fill()
        ctx.lineWidth = Math.max(0.6, r * 0.5); ctx.strokeStyle = 'rgba(8,12,18,0.92)'; ctx.stroke()
      } else drawSatIcon(p.lon, p.lat, px * iz, color)
    }
  }

  function draw() {
    if (cw < 2 || ch < 2 || !belowCanvas) return
    if (!staticValid) { renderStaticLayers(); staticValid = true }
    const bw = belowCanvas.width, bh = belowCanvas.height
    const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
    // 复合：blit below（不透明）→ Polygon 填充 + 覆盖填充/线（夹在中间）→ blit above（透明）→ 覆盖标注 → 聚焦星
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, bw, bh); ctx.drawImage(belowCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawTerminator()     // 夜区遮罩 + 晨昏线（最底：是「打光」不是数据，只压暗底图、不蒙灰数据层）
    drawEnvRaster()      // ITU 环境场栅格（气象/地形是背景量，谁都压得住它）
    drawEnvContours()    // 环境场等值线 + 数值标注（紧跟其场，不与覆盖层混层）
    drawSatFills()       // Polygon 区域填充（覆盖场之下：叠加区只显示覆盖图颜色）
    drawFocusFills()     // 聚焦卫星覆盖圈填充（同上一层band，紧跟 Polygon 填充）
    drawCovGrid()        // STK Coverage FOM 热力图（Polygon 填充之上、GRD 覆盖场之下）
    drawField()          // GRD 覆盖填充面 + 等值线（在底图/Polygon 填充之上、标注之下）
    drawSatPolyLines()   // Polygon 边线（覆盖之上、国界/地名之下：叠加区仍见边线）
    drawDataLines()      // 波束线/仰角线/聚焦卫星线（同上：覆盖之上、国界省界之下，与边界共存；航迹另见 drawTrajLayer）
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(aboveCanvas, 0, 0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawFieldOverlays()   // GRD 波束名/峰值点/数值标签（覆盖层之上）
    drawFocusIcons()      // 聚焦卫星星下点图标（最上层）
    ctx.restore()
  }

  // ---- 缩放进度（底部状态栏进度条）：scale[0.9,60] 对数映射到 t∈[0,1]，t=0 缩小到底、t=1 放大到底。
  // 对数映射 → 进度条每格的缩放倍率恒定，放大时绝对步进更细，支持精细化缩放。
  const SMIN = 0.9, SMAX = 60, _lnS0 = Math.log(SMIN), _lnS1 = Math.log(SMAX)
  // ★ 进度条满格是 1.2（读数 120%）：0–100% 那一段的映射一格不改（scale=60 仍是 100%），
  //   100–120% 是顺着同一条对数轴再往里延的放大余量 → 上限 60 → exp(lnSMIN + 1.2·(lnSMAX−lnSMIN)) ≈ 139×。
  const TMAX = 1.2
  const SCAP = Math.exp(_lnS0 + TMAX * (_lnS1 - _lnS0))
  const scaleToT = () => (Math.log(scale) - _lnS0) / (_lnS1 - _lnS0)
  let onZoom = null
  // ---- 交互 ----
  function onWheel(e) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(scale * Math.exp(-e.deltaY * 0.0015), SMIN, SCAP)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; invalidateStatic(); requestDraw()
    if (onZoom) onZoom(scaleToT())
  }
  // 进度条设缩放：绕画布中心缩放（锚定中心世界点），t∈[0,1]
  function setZoomT(t) {
    const mx = cw / 2, my = ch / 2, kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = clamp(Math.exp(_lnS0 + Math.max(0, Math.min(TMAX, t)) * (_lnS1 - _lnS0)), SMIN, SCAP)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; invalidateStatic(); requestDraw()
  }
  let dragging = false, lx = 0, ly = 0
  let beamDragMode = false, onBeamDrag = null, beamDragging = false   // 拖拽波束（不平移地图）
  let labelDragMode = false, onLabelDrag = null, labelDragging = false   // 拖拽等值线数值标签（沿线滑动，不平移地图）
  // 协调区多边形 hold-to-draw：绘制态下左键按住沿路径拖动，按屏幕像素阈值连续加点（不平移地图）。
  // 回调 onPolyDraw(lonlat, 'start'|'move'|'end')；右键加点（onRightClick）仍并存。
  let polyDrawMode = false, onPolyDraw = null, polyDrawing = false, drawLX = 0, drawLY = 0
  const POLY_DRAW_MIN2 = 14 * 14   // 相邻加点最小屏幕间距²（px）：按住走一段才落一个点
  // 顶点编辑（Polygon 调整顶点 / 整体拖动）：editVerts={ pts:[[lon,lat],...], px, move }。
  //  - move=false：按下命中半径内的顶点即拖动该点（回调 onVertexDrag(index, lonlat, 'start'|'move'|'end')）；
  //  - move=true：按下落在多边形内部即整体拖动（回调 onPolyMove(dlon, dlat, 'start'|'move'|'end')，增量制）。
  // 未命中则照常平移地图。
  let editVerts = null, onVertexDrag = null, vertDragging = -1
  let onPolyMove = null, moveDragging = false, moveLast = null
  // 放置模式（波束合成）：左键点击落点（按下武装 → 拖过阈值解除=平移 → 原地抬起触发 onPlace）
  let placeMode = false, onPlace = null, placeArmed = false, placeSX = 0, placeSY = 0
  // 框选模式（站点栅编辑）：左键拖矩形。'start'/'move' 回屏幕像素（页面画橡皮筋），'end' 回两角经纬（夹到地图边）；
  // 原地点击（未拖过阈值）'end' 回 null＝清选。框选期间不平移。
  let boxMode = false, onBoxSelect = null, boxDragging = false, boxSX = 0, boxSY = 0
  function vertexAt(clientX, clientY) {
    if (!editVerts || !editVerts.pts || !editVerts.pts.length) return -1
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    let best = -1, bd = Math.max(7, (editVerts.px || 3) + 5)   // 命中半径：顶点半径+5px、下限 7px
    editVerts.pts.forEach((p, i) => {
      const d = Math.hypot(PX(p[0]) - mx, PY(p[1]) - my)
      if (d < bd) { bd = d; best = i }
    })
    return best
  }
  // ===== 标记拖拽（点标记 / 地球站 / 航点：光标压在符号上按住即拖）=====
  // markerDragOn 由页面【按类别】开：{ point, station, waypoint }。三类都只在各自的「调整位置 / 调点」态下为真 ——
  // 不在那个态里，压在标记上按住＝照常平移地图，不会把标记误挪走。每项取值：true＝整类可拖，false＝一律不可拖，
  // 字符串＝只有归属它的那些可拖（航点用航迹 id：正在调点的那条才动，别的航迹不受影响）。
  // 命中回调 onMarkerDrag(target, lonlat, 'start'|'move'|'end')，
  // target = { kind:'point'|'station'|'waypoint', id, tid }（tid 仅航点：所属航迹）。
  // ★ 命中半径按【图上真实画多大】算（同一支 ptDiam/idxDiam/stBox），符号调大了抓取区跟着大，
  //   下限 HIT_MIN 是手感底线：出厂圆点上屏只有 4px 宽，按真实尺寸判等于抓不住，压在上面也点不中。
  const HIT_MIN = 11    // 命中半径下限（屏幕 px）：与 3D 侧同值
  let markerDragOn = { point: false, station: false, waypoint: false }
  let onMarkerDrag = null, markerDragging = null, markerGrab = null
  const markerDragAny = () => !!(markerDragOn.point || markerDragOn.station || markerDragOn.waypoint)
  // 该标记此刻可不可拖：true＝整类开；字符串＝只认归属它的那一条（owner，航点即所属航迹 id）
  const dragOk = (kind, owner) => { const v = markerDragOn[kind]; return v === true || (!!v && v === owner) }
  // 按下那一刻「标记与光标」的经纬差：拖动期间保持这个差，标记不会先跳到光标底下再跟着走
  // （地球站/图钉这类立在锚点上的符号，抓的往往是形体上半，不保差就是按下即位移大半个图标）。
  const shortLon = (d) => ((d + 540) % 360) - 180
  function markerLL(t) {
    if (!t) return null
    if (t.kind === 'point') return mk.points.find((p) => p.id === t.id)
    if (t.kind === 'station') return mk.stations.find((x) => x.id === t.id)
    const tr = mk.trajectories.find((x) => x.id === t.tid)
    return tr ? (tr.pts || []).find((q) => q.id === t.id) : null
  }
  // 光标经纬 + 起手差 → 标记应落到的经纬
  function dragLL(ll) {
    if (!ll) return null
    if (!markerGrab) return ll
    return { lat: Math.max(-90, Math.min(90, ll.lat + markerGrab.dLat)), lon: shortLon(ll.lon + markerGrab.dLon) }
  }
  function markerAt(clientX, clientY) {
    if (!markerDragAny()) return null
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    const iz = izNow()
    let best = null, bd = Infinity
    const test = (lon, lat, d, target) => {
      const hit = Math.max(HIT_MIN, d * 0.5 + 4)
      const dd = Math.hypot(PX(lon) - mx, PY(lat) - my)
      if (dd <= hit && dd < bd) { bd = dd; best = target }
    }
    // 次序＝图上的压盖次序反过来：地球站画在最上，先抓它；航点在最下，最后
    const si = stBox(iz), ptD = ptDiam(iz), idxD = idxDiam(iz)
    if (dragOk('station')) for (const s of mk.stations) if (s.id) {
      const ext = stExtent(si)
      // 天线/图钉这类「立在锚点上」的符号：抓取点按其形体中心（针尖上方半个身位），不然只有针尖那一点能抓
      test(s.lon, s.lat + (ext.up - ext.down) * 0.5 / Math.max(1e-6, k()), Math.max(ext.up + ext.down, ext.half * 2), { kind: 'station', id: s.id })
    }
    if (dragOk('point')) for (const p of mk.points) if (p.id) {
      const sh = markCfg.ptShape, d = p.idx ? idxD : ptD
      const up = p.idx ? d * BADGE_R : symbolUp(sh) * d, dn = p.idx ? d * BADGE_R : symbolDown(sh) * d
      test(p.lon, p.lat + (up - dn) * 0.5 / Math.max(1e-6, k()), Math.max(up + dn, d), { kind: 'point', id: p.id })
    }
    const trajD = (markCfg.tjDot != null ? markCfg.tjDot : 4) * iz / 2
    if (markerDragOn.waypoint) for (const t of mk.trajectories) {
      if (!t.id || !dragOk('waypoint', t.id)) continue
      for (const p of (t.pts || [])) if (p.id) test(p.lon, p.lat, trajD, { kind: 'waypoint', id: p.id, tid: t.id })
    }
    return best
  }
  // 屏幕坐标是否落在编辑多边形内（射线法，投影后逐边判交）
  function pointInEditPoly(clientX, clientY) {
    if (!editVerts || !editVerts.pts || editVerts.pts.length < 3) return false
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    const pts = editVerts.pts; let inside = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = PX(pts[i][0]), yi = PY(pts[i][1]), xj = PX(pts[j][0]), yj = PY(pts[j][1])
      if ((yi > my) !== (yj > my) && mx < (xj - xi) * (my - yi) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  function onDown(e) {
    if (editVerts && e.button === 0) {
      if (editVerts.move) {
        if (pointInEditPoly(e.clientX, e.clientY)) {
          moveDragging = true; canvas.setPointerCapture(e.pointerId)
          moveLast = screenToLonLat(e.clientX, e.clientY)
          if (onPolyMove) onPolyMove(0, 0, 'start')
          return
        }
      } else {
        const vi = vertexAt(e.clientX, e.clientY)
        if (vi >= 0) { vertDragging = vi; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onVertexDrag) onVertexDrag(vi, ll, 'start'); return }
      }
    }
    // ★ 标记拖拽排在绘制态/放置态【之前】：那两个是「按下即落点」，而光标正压在一枚可拖的标记上时，
    //   要的多半是把它挪一挪，不是在它身上再叠一个点。抓取区只有十来个像素，误触概率低于「拖不动」的困扰。
    if (markerDragAny() && e.button === 0) {
      const t = markerAt(e.clientX, e.clientY)
      if (t) {
        markerDragging = t; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
        const ll = screenToLonLat(e.clientX, e.clientY)
        const m = markerLL(t)
        markerGrab = (ll && m && Number.isFinite(m.lat)) ? { dLat: m.lat - ll.lat, dLon: shortLon(m.lon - ll.lon) } : null
        if (ll && onMarkerDrag) onMarkerDrag(t, dragLL(ll), 'start')
        return
      }
    }
    if (polyDrawMode && e.button === 0) {   // 绘制态：左键按住起笔，沿路径连续加点
      polyDrawing = true; canvas.setPointerCapture(e.pointerId)
      drawLX = e.clientX; drawLY = e.clientY
      const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'start')
      return
    }
    if (beamDragMode && e.button === 0) { beamDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'start'); return }
    if (labelDragMode && e.button === 0) { labelDragging = true; canvas.setPointerCapture(e.pointerId); const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'start'); return }
    if (boxMode && e.button === 0) {   // 框选：起框并捕获（不平移）
      boxDragging = true; boxSX = e.clientX; boxSY = e.clientY
      canvas.setPointerCapture(e.pointerId)
      if (onBoxSelect) onBoxSelect('start', { x0: boxSX, y0: boxSY, x1: boxSX, y1: boxSY })
      return
    }
    if (placeMode && e.button === 0) { placeArmed = true; placeSX = e.clientX; placeSY = e.clientY }   // 武装放置（不 return：拖动仍平移）
    // 仅左键平移并夺指针捕获。右键/中键只用于 contextmenu（Polygon 加点 / 右键菜单）——若在此为右键 setPointerCapture，
    // 其 pointerup 会被 preventDefault 的 contextmenu 手势吞掉（Chromium 行为），捕获永不释放，此后点任何输入框都被
    // canvas 截走 → 「画完 Polygon 后输入框不能聚焦」。故非左键直接返回，绝不捕获。
    if (e.button !== 0) return
    dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
  }
  function onMove(e) {
    if (boxDragging) {
      if (onBoxSelect) onBoxSelect('move', { x0: boxSX, y0: boxSY, x1: e.clientX, y1: e.clientY })
      if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))
      return
    }
    if (placeArmed && Math.abs(e.clientX - placeSX) + Math.abs(e.clientY - placeSY) > 6) placeArmed = false   // 拖过阈值 → 是平移不是点击
    if (moveDragging) {
      const ll = screenToLonLat(e.clientX, e.clientY)
      if (ll && moveLast && onPolyMove) {
        let dlon = ll.lon - moveLast.lon; dlon = ((dlon + 540) % 360) - 180   // 跨 ±180° 取短路增量
        onPolyMove(dlon, ll.lat - moveLast.lat, 'move'); moveLast = ll
      }
    }
    else if (vertDragging >= 0) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onVertexDrag) onVertexDrag(vertDragging, ll, 'move') }
    else if (beamDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onBeamDrag) onBeamDrag(ll, 'move') }
    else if (labelDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onLabelDrag) onLabelDrag(ll, 'move') }
    else if (polyDrawing) {   // 绘制态：光标每移过阈值距离落一个点
      const dx = e.clientX - drawLX, dy = e.clientY - drawLY
      if (dx * dx + dy * dy >= POLY_DRAW_MIN2) { drawLX = e.clientX; drawLY = e.clientY; const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onPolyDraw) onPolyDraw(ll, 'move') }
    }
    else if (markerDragging) { const ll = screenToLonLat(e.clientX, e.clientY); if (ll && onMarkerDrag) onMarkerDrag(markerDragging, dragLL(ll), 'move') }
    else if (dragging) { tx += e.clientX - lx; ty += e.clientY - ly; lx = e.clientX; ly = e.clientY; invalidateStatic(); requestDraw() }
    else if (editVerts) {   // 悬停提示：可拖顶点 / 可拖多边形内部（cursor 可覆盖命中态提示，如删除模式用 'pointer' 而非 'move'）
      canvas.style.cursor = (editVerts.move ? pointInEditPoly(e.clientX, e.clientY) : vertexAt(e.clientX, e.clientY) >= 0) ? (editVerts.cursor || 'move') : 'grab'
    }
    // 悬停到可拖的标记上变手型（各模态自己的光标优先，不抢）
    else if (!beamDragMode && !labelDragMode && !boxMode) {
      const on = markerDragAny() && !!markerAt(e.clientX, e.clientY)
      canvas.style.cursor = on ? 'move' : (polyDrawMode || placeMode ? 'crosshair' : 'grab')
    }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp(e) {
    if (boxDragging) {
      boxDragging = false
      if (e && onBoxSelect) {
        const moved = Math.abs(e.clientX - boxSX) + Math.abs(e.clientY - boxSY) > 6
        const add = !!(e.ctrlKey || e.metaKey)   // Ctrl/⌘ = 累加（框选并入 / 点击增减）
        onBoxSelect('end', moved ? { a: screenToLonLatClamp(boxSX, boxSY), b: screenToLonLatClamp(e.clientX, e.clientY), add } : { add, at: screenToLonLatClamp(boxSX, boxSY) })   // 原地点击带落点：命中站点=单选
      } else if (onBoxSelect) onBoxSelect('end', null)
    }
    if (placeArmed) { placeArmed = false; const ll = screenToLonLat(placeSX, placeSY); if (ll && onPlace) onPlace(ll) }   // 原地抬起 = 点击放置
    if (vertDragging >= 0 && onVertexDrag) onVertexDrag(null, null, 'end')
    if (moveDragging && onPolyMove) onPolyMove(0, 0, 'end')
    if (beamDragging && onBeamDrag) onBeamDrag(null, 'end')
    if (labelDragging && onLabelDrag) onLabelDrag(null, 'end')
    if (polyDrawing && onPolyDraw) onPolyDraw(null, 'end')
    if (markerDragging && onMarkerDrag) onMarkerDrag(markerDragging, null, 'end')
    markerDragging = null; markerGrab = null
    dragging = false; beamDragging = false; labelDragging = false; vertDragging = -1; moveDragging = false; moveLast = null; polyDrawing = false
    canvas.style.cursor = (polyDrawMode || placeMode) ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')
    // 显式释放指针捕获（不只依赖 pointerup 的隐式释放）：pointercancel / 抬起点在画布外等边角情形下隐式释放可能不发生，
    // 残留捕获会把之后所有点击截给 canvas，导致输入框点不进。有 e.pointerId 就按其释放，无（onLeave 调用）则整体兜底。
    try {
      if (e && e.pointerId != null) { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) }
    } catch { /* ignore */ }
  }
  function onLeave() { placeArmed = false; onUp(); if (onHover) onHover(null) }       // 移出地图：清空读数（放置武装作废，避免离屏误落点）
  function onDbl() { fit(); invalidateStatic(); requestDraw(); if (onZoom) onZoom(scaleToT()) }
  // 屏幕坐标 -> 经纬度（夹到地图边缘，框选角点用：框拖出地图外也取有效角）
  function screenToLonLatClamp(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk
    const wy = Math.max(0, Math.min(180, (clientY - r.top - ty) / kk))
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  // 屏幕坐标 -> 经纬度（投影逆运算）；超出地图范围返回 null
  function screenToLonLat(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk, wy = (clientY - r.top - ty) / kk
    if (wy < 0 || wy > 180 || wx < 0 || wx > 360) return null   // 世界矩形之外（信箱留白）没有经纬度
    let lon = wx + LON0; lon = ((lon % 360) + 540) % 360 - 180
    return { lat: 90 - wy, lon }
  }
  let onRightClick = null, onHover = null
  function onCtx(e) { e.preventDefault(); if (onRightClick) onRightClick(screenToLonLat(e.clientX, e.clientY), { x: e.clientX, y: e.clientY }) }
  // 放置模式（波束合成）：左键「点击」（按下→未拖动→抬起）回调 onPlace(ll)；拖动仍平移地图。
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)   // 指针被系统取消（如触控/被抢占）：同样跑清理，释放捕获、复位拖拽状态
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('dblclick', onDbl)
  canvas.addEventListener('contextmenu', onCtx)
  canvas.style.cursor = 'grab'

  // 画布位图尺寸 = CSS 尺寸 × effDpr()。窗口尺寸变化与 DPR 变化都从这里进。
  function resizeNow() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0, h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0
    if (!w || !h) return
    const firstFit = cw < 2 || ch < 2; cw = w; ch = h; dpr = effDpr()
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr)   // 仅在尺寸真正变化时重设位图，避免无谓清空
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
    // 离屏静态快照缓冲随主画布尺寸（设备像素）创建/重建
    if (!belowCanvas) { belowCanvas = document.createElement('canvas'); belowCtx = belowCanvas.getContext('2d'); aboveCanvas = document.createElement('canvas'); aboveCtx = aboveCanvas.getContext('2d') }
    if (belowCanvas.width !== canvas.width || belowCanvas.height !== canvas.height) { belowCanvas.width = canvas.width; belowCanvas.height = canvas.height; aboveCanvas.width = canvas.width; aboveCanvas.height = canvas.height }
    invalidateStatic()
    if (firstFit) fit()
    draw()   // 同步立即重绘：canvas.width 重设会清空画布，若只 requestDraw 会隔一帧露出深色底 → 黑一下
  }
  // DPR 监听：窗口拖到另一块缩放不同的显示器、或系统改了显示缩放时，devicePixelRatio 变而 CSS 尺寸不变
  // —— ResizeObserver 那条路一声不响，位图密度就永远停在旧 DPR 上。而吸附式 effDpr 全靠 DPR 取值，
  //   停在旧值等于比例又变回非整数，正是这次要治的那件事。
  // ★ matchMedia 的 resolution 查询是唯一听得见这件事的接口；一个查询只盯一个具体的 dppx 值，
  //   故每次触发后必须照新 DPR 重新挂一次。
  let offDpr = null
  function watchDpr() {
    if (offDpr) { offDpr(); offDpr = null }
    let mq
    try { mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)') } catch { return }
    const on = () => { watchDpr(); resizeNow() }
    mq.addEventListener('change', on)
    offDpr = () => mq.removeEventListener('change', on)
  }
  watchDpr()

  // 一级行政区数据（与 3D setProvinces 同款格式）。★ 可反复调用：多选国家时上层并成一份重新喂进来。
  function setProvinces(data) {
    prov = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 15, pri: l.pri, rk: l.rk, keep: l.keep })) } : null
    invalidateStatic(); requestDraw()
  }

  // 二级行政区数据（同上）。地名密集 → 基准 px 偏小（小空间）
  function setCities(data) {
    city = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 11, pri: l.pri, rk: l.rk, keep: l.keep })) } : null
    invalidateStatic(); requestDraw()
  }

  return {
    setGeom(g) { geom = g; invalidateStatic(); requestDraw() },
    // GRD 覆盖多层：layers=[{fillBands:[{color:[r,g,b], verts:Float64Array[x,y,...], counts:Int32Array}]|null, segGroups:[...]}]；
    // opts={alpha}。setField 时把每层 fillBands 烘成各档世界坐标 Path2D 缓存（fillPaths），draw 只设变换矢量填充。整体替换。
    setField(layers, opts) {
      fieldLayers = (layers || []).map((L) => ({ ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: L.segGroups ? buildSegPaths(L.segGroups) : null, bounds: layerBounds(L) }))
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; if (opts.lineAlpha != null) fieldLineAlpha = opts.lineAlpha; fieldOpts = { ...fieldOpts, ...opts } }
      requestDraw()
    },
    // 拖拽热路径：只替换给定层（聚焦天线各波束，按 id 匹配），其余层缓存的 fillPaths 原样保留 → 不再每帧全量重建。
    patchField(layers, opts) {
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; if (opts.lineAlpha != null) fieldLineAlpha = opts.lineAlpha; fieldOpts = { ...fieldOpts, ...opts } }
      for (const L of (layers || [])) {
        const entry = { ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: L.segGroups ? buildSegPaths(L.segGroups) : null, bounds: layerBounds(L) }
        const i = L.id != null ? fieldLayers.findIndex((x) => x.id === L.id) : -1
        if (i >= 0) fieldLayers[i] = entry; else fieldLayers.push(entry)
      }
      requestDraw()
    },
    setFieldAlpha(a) { fieldAlpha = a; requestDraw() },   // 仅覆盖层透明度，静态快照不变
    setFieldLineAlpha(a) { fieldLineAlpha = a; requestDraw() },   // 等值线透明度（同上：不动静态快照，也不重烘 Path2D）
    // STK Coverage 覆盖分析【专用通道】：layer={fillBands:[{color:[r,g,b],verts,counts}]}, opts={alpha}。整体替换（单层）。
    // ---- 环境场（ITU 气象/地形栅格 + 等值线）----
    // img = 等经纬位图（canvas/ImageBitmap），bbox = 其覆盖的经纬范围；smooth=false 走最近邻（分级填色看硬边界）
    setEnvRaster(img, opts) {
      const o = opts || {}
      envImg = img || null
      envBBox = img ? (o.bbox || { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }) : null
      if (o.alpha != null) envAlpha = o.alpha
      if (o.smooth != null) envSmooth = !!o.smooth
      envFadeKey = ''   // 图变了 → 导出用的烘透明度副本作废
      requestDraw()
    },
    setEnvAlpha(a) { envAlpha = a; envFadeKey = ''; requestDraw() },
    setEnvContours(groups) { envContours = Array.isArray(groups) ? groups : []; requestDraw() },
    clearEnv() { envImg = null; envBBox = null; envContours = []; envFadeKey = ''; requestDraw() },
    // ---- 晨昏线 / 夜区 ----
    // date = UTC 时刻（跟随时间轴，非系统时钟）；传 null 清层。opts 同 3D：
    // { night, line, nightColor, nightOpacity, lineColor, lineWidth, lineOpacity, steps }
    // 采样起点钉在 LON0（地图接缝）—— 否则夜区多边形横跨接缝、填充被撕成两半。
    // steps 默认 1440（0.25°/段）：平面图能放大到 60×，360 段（1°/段）在高倍下会看出折线棱角。
    // 逐帧只是 1440 次 lineTo，与覆盖分带填充比可忽略，故直接给足而不做自适应。
    setTerminator(date, opts) {
      if (opts) termOpts = { ...termOpts, ...opts }
      termData = date ? terminatorFlat(date, { steps: (termOpts.steps || 1440), lon0: LON0 }) : null
      requestDraw()
    },
    clearTerminator() { termData = null; requestDraw() },
    setCovGrid(layer, opts) {
      covGridLayers = (layer && layer.fillBands && layer.fillBands.length) ? [{ ...layer, fillPaths: buildFillPaths(layer.fillBands), bounds: layerBounds(layer) }] : []
      if (opts && opts.alpha != null) covGridAlpha = opts.alpha
      requestDraw()
    },
    clearCovGrid() { covGridLayers = []; requestDraw() },
    setCovGridAlpha(a) { covGridAlpha = a; requestDraw() },
    setSizes(s) { Object.assign(sizes, s || {}); invalidateStatic(); requestDraw() },
    setNameMode(m) { nameMode = m; invalidateStatic(); requestDraw() },
    // 水域注记：{ ocean, sea } 两档各自的 'zh' | 'en' | 'off'（只给一个就只改那一个）
    setWaterMode(m) {
      if (!m) return
      if (m.ocean != null) oceanMode = m.ocean
      if (m.sea != null) seaMode = m.sea
      invalidateStatic(); requestDraw()
    },
    // 逐条显隐：{ id: true } 即关掉那一条（表里的其余条目照画）
    setWaterOff(o) {
      waterOff = { ...(o || {}) }
      oceanLbl = waterLabels('ocean', waterOff); seaLbl = waterLabels('sea', waterOff)
      invalidateStatic(); requestDraw()
    },
    // 岛链：{ on, off, color, width, opacity, dash, name, nameSize } 一次给，只改给到的那几项
    setChains(o) {
      if (!o) return
      if (o.off) { chainOff = { ...o.off }; chains = chainList(chainOff); chainLbl = chainLbls() }
      for (const k of ['on', 'color', 'width', 'opacity', 'dash', 'name', 'nameSize']) if (o[k] != null) chainCfg[k] = o[k]
      invalidateStatic(); requestDraw()
    },
    setProvinces,
    setProvincesVisible(v) { provVisible = !!v; invalidateStatic(); requestDraw() },
    setCities,
    setCitiesVisible(v) { cityVisible = !!v; invalidateStatic(); requestDraw() },
    // 国界/省界线样式（与 3D 同步）：{ natColor, natWidth, natOpacity, provColor, provWidth, provOpacity }
    // ★「线型换没换」按【值】比，不按「键在不在」：调用方传的是整份样式快照，每个 *Dash 键恒在，
    //   按键判等于每次都作废 borderPaths —— 拖一下颜色就把五类线的 Path2D 整份重烘（10m 档 48 万个
    //   lineTo）。与 3D 的 setBorderStyle 同一个根因，见那边的注释。
    setBorderStyle(s) {
      if (!s) return
      const reDash = Object.keys(s).some((k) => /Dash$/.test(k) && s[k] !== borderStyle[k])
      Object.assign(borderStyle, s)
      if (reDash) borderPaths = null   // 线型换了要重烘（虚线图案本身不入 path，但这里顺手清一次最省心）
      invalidateStatic(); requestDraw()
    },
    // 地名颜色/透明度（与 3D 同步）：{ countryColor, countryOpacity, provColor, provOpacity }
    setLabelStyle(s) { Object.assign(labelStyle, s || {}); invalidateStatic(); requestDraw() },
    // 大海填充色（与 3D 同步，限蓝色系）
    setOceanColor(c) { if (c) { oceanColor = c; invalidateStatic(); requestDraw() } },
    // 影像底图。两档二选一：
    //   set  = 瓦片档集名（如 'bmng'）；给了它就走金字塔，img 不再参与
    //   img  = 整幅档已解码的等经纬 HTMLImageElement（传 null 卸载）
    // on=开关、bright=亮度乘子、maxZ=瓦片档最深级（离线包只切到 L6 时传 6，免得一路请求必然 404 的 L7）。
    setImagery(o) {
      if (!o) return
      if (o.set !== undefined) imgSet = o.set || null
      if (o.img !== undefined) imgEl = o.img || null
      if (o.on != null) imgOn = !!o.on
      if (o.maxZ != null && Number.isFinite(o.maxZ)) imgMaxZ = Math.max(0, Math.min(11, o.maxZ | 0))   // 上限 11：GIBS 的 31.25m 矩阵集到 L11（30.6 m/px），是其真彩天花板
      if (o.bright != null) imgBright = Math.max(0.05, Math.min(2, Number(o.bright) || 1))
      invalidateStatic(); requestDraw()
    },
    // 大地颜色（基调方案 + 逐国覆盖，与 3D 同步）：写入公共色板状态后重建陆地 Path2D 并重绘静态层
    setLandColors(s) { setLandPalette(s); buildBaseGeo(resolvedFeatures(mapDetail0), mapThin); invalidateStatic(); requestDraw() },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => scaleToT(),
    setZoom: (t) => setZoomT(t),
    setOnZoom(fn) { onZoom = fn },
    // 完整视图记忆：缩放 scale + 画面中心的「世界坐标」(cx=lon-LON0, cy=90-lat)。
    // 用世界中心点而非 tx/ty → 窗口尺寸变化后仍能复原到同一地理中心。setView 需在 resize 后调用（base 已就绪）。
    getView() { const kk = k(); return { scale, cx: (cw / 2 - tx) / kk, cy: (ch / 2 - ty) / kk } },
    // 键盘方向键：把视窗中心按屏幕像素平移（dxPx 右为正 → 中心东移，dyPx 下为正 → 中心南移）。
    // tx/ty 为 CSS 像素平移量（与鼠标拖拽同一坐标系），故与缩放无关：每次移动固定屏幕距离。
    panByPixels(dxPx, dyPx) {
      const dx = Number.isFinite(dxPx) ? dxPx : 0, dy = Number.isFinite(dyPx) ? dyPx : 0
      if (!dx && !dy) return
      tx -= dx; ty -= dy
      invalidateStatic(); requestDraw()
    },
    setView(v) {
      if (!v || !Number.isFinite(v.scale)) return
      scale = clamp(v.scale, SMIN, SCAP)
      const kk = k()
      if (Number.isFinite(v.cx)) tx = cw / 2 - v.cx * kk
      if (Number.isFinite(v.cy)) ty = ch / 2 - v.cy * kk
      invalidateStatic(); requestDraw()
    },
    // 渲染分辨率倍率（画质档位）：改后重建位图。this.resize 重算 dpr/位图尺寸并重绘。
    setRenderScale(n) { renderScale = Number.isFinite(n) ? n : null; this.resize() },
    // 底图精细化（与 3D 同步）：'10m'/'50m'/'110m' + thin 抽稀阈值。换源重建陆地面与五类边界线。50m/110m 懒加载。
    async setMapDetail(detail, thin) {
      const t = (thin != null) ? thin : mapThin
      if (detail === mapDetail0 && t === mapThin) return
      try { await ensureDetail(detail) }
      catch (e) { console.warn(detail + ' 底图加载失败，保持当前精度', e); return }
      mapDetail0 = detail; mapThin = t
      borderPaths = null
      buildBaseGeo(resolvedFeatures(detail), t)
      invalidateStatic(); requestDraw()
    },
    // 切口经度（左边缘经度，−180..180）。★ 面板上填的是【画面中心】，切口 = 中心 − 180（见 stores/mapCrs）。
    // 世界度坐标 x = lon − LON0 是烘在 Path2D 里的，
    // 故改切口要把陆地/边界线/覆盖场/等值线全部重烘，再 fit 一次把新接缝放到边上。
    setLon0(v) {
      const nv = Number(v)
      if (!Number.isFinite(nv)) return
      const w = ((nv + 180) % 360 + 360) % 360 - 180
      if (Math.abs(w - LON0) < 1e-9) return
      LON0 = w
      borderPaths = null
      buildBaseGeo(resolvedFeatures(mapDetail0), mapThin)
      fieldLayers = fieldLayers.map((L) => ({ ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: L.segGroups ? buildSegPaths(L.segGroups) : null, bounds: layerBounds(L) }))
      termData = null   // 夜区采样起点钉在 LON0，下一拍 setTerminator 会按新切口重算
      fit()
      invalidateStatic(); requestDraw()
    },
    getLon0: () => LON0,
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || labelDragMode) ? 'move' : 'grab') },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    setLabelDragMode(v) { labelDragMode = !!v; labelDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || beamDragMode) ? 'move' : 'grab') },
    setOnLabelDrag(fn) { onLabelDrag = fn },
    // 协调区多边形 hold-to-draw 模式：开启后左键按住沿路径连续加点
    setPolyDrawMode(v) { polyDrawMode = !!v; polyDrawing = false; canvas.style.cursor = v ? 'crosshair' : (beamDragMode ? 'move' : 'grab') },
    setOnPolyDraw(fn) { onPolyDraw = fn },
    // Polygon 顶点编辑/整体拖动：v={ pts:[[lon,lat],...], px 顶点半径, move 整体拖动模式 } 开启
    // （pts 传引用，外部改动即时生效）；null 关闭
    setEditVerts(v) {
      const nv = (v && v.pts) ? v : null
      // 拖拽进行中被重新喂入（外部数据变动重建了顶点快照——如波束合成「调整中心」拖动时，深监听会 redrawSats+syncEdit
      // 逐帧回刷 editVerts）：若新旧顶点数一致，保住当前拖拽索引/整体拖动态，别把正在进行的拖动掐断，否则按住只跳一下
      // 就断、无法连续调整。仅在清空 / 切换到不同长度的编辑目标时才复位拖拽状态。
      const keepDrag = !!nv && !!editVerts && (vertDragging >= 0 || moveDragging) && nv.pts.length === editVerts.pts.length
      editVerts = nv
      if (!keepDrag) { vertDragging = -1; moveDragging = false; moveLast = null }
      if (!editVerts) canvas.style.cursor = placeMode ? 'crosshair' : (beamDragMode ? 'move' : 'grab')
    },
    setOnVertexDrag(fn) { onVertexDrag = fn },
    // 放置模式（波束合成）：左键点击落点；拖动仍平移
    // 应用场景仿真：模块 + 连线（几何走与标记层同一套投影）
    setScene(mods, links, cfg) {
      scLayer = { mods: mods || [], links: links || [], cfg: cfg || {} }
      requestDraw()
    },
    sceneHitAt,
    setPlaceMode(v) { placeMode = !!v; placeArmed = false; canvas.style.cursor = placeMode ? 'crosshair' : (polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')) },
    setOnPlace(fn) { onPlace = fn },
    // 框选模式（站点栅编辑）：左键拖矩形选站；开启期间不平移
    setBoxSelectMode(v) { boxMode = !!v; boxDragging = false; canvas.style.cursor = boxMode ? 'crosshair' : (placeMode || polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : 'grab')) },
    setOnBoxSelect(fn) { onBoxSelect = fn },
    setOnPolyMove(fn) { onPolyMove = fn },
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; invalidateStatic(); requestDraw() },
    // 标记层样式（与 3D 同一份设置，见 markCfg）
    setMarkStyle(cfg) { Object.assign(markCfg, cfg || {}); invalidateStatic(); requestDraw() },
    // 标记直接拖拽：开关 + 回调（target, lonlat, 'start'|'move'|'end'）
    // 布尔＝三类一起开关；对象＝逐类开关 { point, station, waypoint }（页面按「调整位置 / 调点」态给，
    // 每项 true / false / 归属 id，见 dragOk）
    setMarkerDrag(v) {
      const o = (v && typeof v === 'object') ? v : { point: !!v, station: !!v, waypoint: !!v }
      const norm = (x) => (typeof x === 'string' ? x : !!x)
      markerDragOn = { point: norm(o.point), station: norm(o.station), waypoint: norm(o.waypoint) }
      if (markerDragging && !dragOk(markerDragging.kind, markerDragging.tid)) { markerDragging = null; markerGrab = null }
    },
    setOnMarkerDrag(fn) { onMarkerDrag = fn },
    // p：单个 {lat,lon} 或数组，兼容旧单选调用；聚焦星每帧实时绘制，不在快照内
    setFocusSat(p) { focusSats = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon)); requestDraw() },
    // g：单个 {footprint,track} 或数组（多选=每颗都画），随时间实时，不入快照
    setSelGeom(g) { selGeomList = Array.isArray(g) ? g.filter(Boolean) : (g ? [g] : []); requestDraw() },
    // 聚焦卫星显示样式（轨道线只在 3D 有，这里收轨迹/覆盖圈/星下点图标三项）
    setFocusStyle(s) { Object.assign(focusCfg, s || {}); requestDraw() },
    setSatLayer(spec) { satLayer = spec; invalidateStatic(); requestDraw() },
    resize() { resizeNow() },
    reset() { fit(); invalidateStatic(); requestDraw() },
    // 当前屏幕视图的逻辑尺寸（CSS px）：供「所见即所得」导出按当前画面比例/范围出图
    viewportSize: () => ({ w: cw, h: ch }),
    // 整幅世界图在当前屏幕画布上 fit 后的逻辑尺寸（CSS px，严格 2:1）：全球图导出以此为逻辑大小、
    // 只提像素倍率 → 恒定屏幕 px 的线宽/图标/注记与在屏整幅图完全同比例（所见即所得）。画布未就绪返回 null。
    fittedWorldSize() { const sb = Math.min(cw / 360, ch / 180); return (cw > 50 && ch > 50) ? { w: 360 * sb, h: 180 * sb } : null },
    // 导出平面图到任意 2D 上下文：离屏高清 canvas → PNG；svgcanvas → SVG/PDF。
    // opts: { width, height, pixelScale=1, background=true, fontFamily, fontFamilyLatin, view=false, raster=false }。
    //   raster=true：输出目标是真 canvas（PNG），影像底图照画；缺省 false 供 svgcanvas 录制（PDF/SVG），影像跳过。
    //   fontFamily=中文面族名，fontFamilyLatin=西文面族名（仅 PDF 需分面，见 textFontLatin 注释）。
    //   view=false：整幅世界图，fit 一次性绘制；view=true：所见即所得，按当前屏幕缩放/平移出图。绘后恢复在屏视图。
    // compat=true 走子路径回放（不依赖 Path2D / evenodd 入参）→ PNG 与 PDF 完全一致。
    // 导出前预载影像瓦片。★ 必须在 exportRender 之前 await —— exportRender 是同步的，
    //   跳过的片没有第二次机会；而导出时 fit() 重算 base、dpr 换成放大倍率，选级比屏上深好几级，
    //   那一级的片往往一张都没加载过 → 导出的图上缺一大块（正是这个 BUG）。
    //   这里把 exportRender 的视图状态先套上去算出排布，等片到位后再还原，故与实际画的那一批完全一致。
    async ensureImagery(opts) {
      if (!imgOn || !imgSet) return
      const o = opts || {}
      const SV = { dpr, cw, ch, base, scale, tx, ty }
      dpr = o.pixelScale || 1
      if (o.view !== true) { cw = o.width || cw; ch = o.height || ch; fit() }
      let plan = null
      try { plan = imageryPlan() } finally {
        dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty
      }
      if (plan && plan.items.length) await loadTiles(imgSet, plan.z, plan.items)
    },
    exportRender(targetCtx, opts) {
      const o = opts || {}
      // view=true：所见即所得，保留当前 base/scale/tx/ty 与屏幕 cw/ch，仅按 pixelScale 放大输出；
      // 否则：整幅世界图，重置 cw/ch=W/H 后 fit() 一次。
      const viewMode = o.view === true
      const W = o.width || 1600, H = o.height || (W / 2), ps = o.pixelScale || 1
      const SV = { ctx, dpr, cw, ch, base, scale, tx, ty, font: textFont, fontLatin: textFontLatin }
      ctx = targetCtx; dpr = ps; compat = true; rasterOut = o.raster === true
      if (o.fontFamily) textFont = o.fontFamily
      if (o.fontFamilyLatin) textFontLatin = o.fontFamilyLatin
      if (viewMode) { /* 保留当前屏幕视图（cw/ch/base/scale/tx/ty 不变） */ }
      else { cw = W; ch = H; fit() }
      const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (o.background !== false) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch) }
      drawBelowContent(rx, ry, rw, rh)
      // 层序必须与 draw() 逐字一致（所见即所得）：晨昏线夜区打头，与屏幕上同为最底层
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); drawTerminator(); drawEnvRaster(); drawEnvContours(); drawSatFills(); drawFocusFills(); drawCovGrid(); drawField(); drawSatPolyLines(); drawDataLines(); ctx.restore()
      drawAboveContent(rx, ry, rw, rh)
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
      drawFieldOverlays()
      drawFocusIcons()
      ctx.restore()
      ctx = SV.ctx; dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty; textFont = SV.font; textFontLatin = SV.fontLatin; compat = false; rasterOut = false
      staticValid = false; requestDraw()
    },
    // 销毁：退订主权解算层的广播（不退的话卸载后的画布仍会被换视角触发重建）与 DPR 监听，再摘画布事件。
    // ★ 这里原本有【两个 destroy 键落在同一个对象字面量里】，后一个把前一个整个盖掉 —— offPov()
    //   从来没被调用过，卸载后的实例仍挂在主权解算层的广播上。已并成这一个。
    destroy() {
      if (rafId) cancelAnimationFrame(rafId)
      offPov()
      if (offDpr) { offDpr(); offDpr = null }
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
