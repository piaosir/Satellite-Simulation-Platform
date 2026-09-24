// 平面覆盖图渲染器（2D Canvas，等距圆柱投影 / plate carrée，从西经30°切开）。
// 底图（陆地配色/国界/国家名/大洋名/省界省名/标记）与 3D 球体保持一致；叠加覆盖图数据。
// 不画星座、卫星点、卫星名、卫星连线。配色常量与 globe3d/scene.js 同源。
// 陆地配色（LAND/CHINA/ICE/基调方案/逐国覆盖）统一收拢到 ../landPalette.js（与 3D 球体共用单一来源）
import { ARCTIC_ISLAND_LAT, landColors, setLandPalette, getLandPalette } from '../landPalette.js'
// 底图的面/线/国名/点选全部由主权解算层按归属实时算出（与 3D 球体同一份），视角 = 一张归属表
import { resolvedFeatures, resolvedLines, labelSet, ensureDetail, hasDetail, onPovChange } from '../geo/povResolver.js'
// 五类边界线的渲染次序 / 出厂样式 / 屏幕像素虚线图案 / 缩放淡出档位：与 3D 球体共用同一份常量
import { BORDER_DEF, DASH_PX, DASH_SCALE, BORDER_DRAW, CFG_KEY, fadeFactor, admFade } from '../geo/borderStyle.js'
import { terminatorFlat, solarGeometry, nightRamp } from '../terminator.js'
// 影像瓦片金字塔（EPSG:4326 / GIBS 网格）：网格数学与取片缓存，与 3D 球体共用同一份
import { TILE, span as tileSpan, tileRange, pickZoom, getTileOrParent, getTileFallback, ancestorHit, prefetchParents, tileStats, tileGutter, tileImgSize, loadTiles, warm as warmTiles, MISS_TTL } from '../imageryTiles.js'
// 投影档瓦片影像：同一份三角网按片分桶（纯几何，见其文件头）
import { binByTiles, tileUvToPx, tileWindow } from '../geo/tileBins.js'
// 点标记序号徽标（圈 1、圈 2）：与 3D 球体共用同一支画笔，两视图观感一致
import { paintNumBadge, BADGE_R } from '../markers/numBadge.js'
// 标记符号（圆点/方块/三角/图钉…）：同上，2D 与 3D 共用同一支画笔
import { paintMarkSymbol, symbolUp, symbolDown, PT_DOT_K } from '../markers/markSymbols.js'   // PT_DOT_K：点标记滑块值 → 视觉直径（3D / 页面同一份）
// 地球站符号：与 3D 球体共用同一份定义（原来两处各存一份逐字符相同的副本）
import { stationSvg, STATION_ANCHOR_X, STATION_ANCHOR_Y } from '../stationSymbol.js'
import { drawVehicle, flatHeading } from '../vehicleSymbol.js'
// 运动档载具的屏幕朝向（沿大圆前进一小步投到图上）：P4 标记实体
import { aheadPoint } from '../../../packages/core/models/entityRuntime.mjs'
// 注记描边色/粗细随底色现算：与 3D 球体共用单一来源
import { haloColor, haloScale, IMAGERY_HALO, IMAGERY_SCALE } from '../labelHalo.js'
// 水域注记（大洋 + 海域）：与 3D 球体共用同一份表（../geo/waterNames.js）
import { waterLabels } from '../geo/waterNames.js'
// 岛链参考线：与 3D 球体共用同一份表
import { chainList, CHAIN_DEF, CHAIN_LABEL_PX } from '../geo/islandChains.js'
import { seamCrossing } from '../geo/lineGeom.js'
// 2D 投影（世界平面的定义）—— 出厂等距圆柱，与换投影前逐位相同
import { makeProjection, DEFAULT_PROJECTION, isProjection, projParams } from '../geo/projection.js'
// 影像重投影的三角网规划器：CPU 路（导出 / 无 WebGL2 / 环境场栅格）与 GPU 路共用同一份
import { planRasterMesh, COARSE as MESH_BLOCK } from '../geo/rasterMesh.js'
// 投影档影像的 GPU 后端（屏上绘制时启用；导出 / 无 WebGL2 / 深缩放退回 warpTri）
import { createGlRaster, GL_TEX_MAX } from './glRaster.js'
// GRD 分带填充的 GPU 后端（等距圆柱 + 屏上绘制时启用；导出/投影档/无 WebGL2 时退回 Path2D）
import { createGlField, GL_MAX_LEVELS, meshLattice } from './glField.js'
// 线的 GPU 后端（同一上下文上的第二个程序）：线段打包器 + 颜色解析；程序本身由 glField().lines() 持有
import { createLinePacker, parseColor } from './glLines.js'
// 等值线拼链（每链一个子路径烘 Path2D）：与几何层的数值标签 / 导出用的是同一个 stitchLoops
import { stitchLoops } from '../grd/coverage.js'
// 静态快照的调度口径（重不重建 / 何时补建 / 盖不住时垫哪张）：纯函数拆在这里，见其文件头
import {
  REBUILD_FAST_MS, PROBE_FRAMES, UNKNOWN_COST, NOMINAL_MIN, viewCls as clsOf, makeCostTable,
  quantPan, makePanQuant, idleMsFor, hotMsFor, nominalFromGaps, placeSnapshot, worldCover as coverOf,
  uncoveredMode, needsRestRebuild,
  coversSubset, pickFallbackIdx, clipRects, stripRects
} from './rebuildPolicy.js'
import { geoArea, geoContains, geoRotation } from 'd3-geo'
// 南极洲极区收口：与 3D 球体同源（见 buildBaseGeo 的 ATA 分支）
import { antarcticaFillRings } from '../globe3d/antarctica.js'
// 导出（compat）时陆地面的分组：基础面按色合并、争议叠加面逐面单独填（纯函数，见其文件头）
import { groupLandForExport } from './landGroups.js'
// 滚轮缩放口径（一格 = 状态栏缩放读数走几个百分点）：与 3D 球体共用同一份
import { wheelNotches, stepZoomT } from '../../shared/wheelStep.js'

const OCEAN = '#15426b'
const BG = '#070b12'
// 切口（左边缘经度）：默认西经 30°，经度范围 [LON0, LON0+360)。可由「地图设置 → 坐标系」改，
// 改后要重烘所有「世界度坐标」(x = lon − LON0) 的 Path2D —— 陆地/边界线/覆盖场/等值线/夜区都是这套坐标。
let LON0 = -30

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const hex = (c) => typeof c === 'number' ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : (c || '#fff')
// 经度解缠：把一条折线/环上各点搬到连续窗口，避免跨 ±180 时被画成横贯全图的假线
function unwrap(ring) {
  const out = new Array(ring.length); let prev = ring[0][0]; out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) { let lo = ring[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; out[i] = [lo, ring[i][1]]; prev = lo }
  return out
}

export function createFlatCoverage(canvas) {
  // ---- 投影 ----
  // 世界平面 = 投影定义的那一张平面（见 geo/projection.js）。出厂等距圆柱，
  // 此时 PJ.identity 为真 —— 下面每一处都走【换投影前那条一行没改的老路】，逐位相同。
  // 四个投影档另走 d3 烘焙：它顺带做了日界线切割与自适应加密，且内容恒在平面盒子里
  // → 不再需要 ±360 环绕副本（PJ.periodX = 0）。
  // 逐投影的可调参数（中心纬度 / 圆锥标准纬线，见 geo/projection.js 的 PROJ_PARAMS）。
  // 与 LON0 平级：改了同样要整份重烘。
  let PJOPT = {}
  let PJ = makeProjection(DEFAULT_PROJECTION, LON0, PJOPT)
  // 「这张平面是哪一张」的指纹：投影档 + 切口 + 中心纬度 + 标准纬线。
  // ★ 所有按平面缓存的东西（图廓 / 经纬网 / 栅格重投影）都拿它当键的前缀 ——
  //   参数是可调的，只靠「改参数时记得手动清缓存」迟早会漏一处，漏了就是拿旧平面的图去画新平面。
  const planeKey = () => PJ.kind + '/' + PJ.lon0 + '/' + PJ.lat0 + '/' + (PJ.par ? PJ.par.join(',') : '')
  const _pw = [0, 0]
  // 经纬 → 世界平面（复用出参，当场用掉）
  const WPT = (lon, lat) => PJ.fwd(lon, lat, _pw)
  // 横向环绕副本的偏移档：只有周期平面（等距圆柱）才有 ±360 三档。
  const WRAP3 = [-360, 0, 360], WRAP1 = [0]
  const wraps = () => (PJ.periodX ? WRAP3 : WRAP1)
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
  // ---- GRD 分带填充的 GPU 后端（见 ./glField.js）----
  // 'gl'：等距圆柱 + 屏上绘制 + WebGL2 可用 + 电平数 ≤ 上限。此时几何层只送网格（fieldMesh），
  //       填充逐像素在 GPU 上分档，成本随屏幕像素走。
  // 'paths'：老路（bandGeometry 的分带多边形 → Path2D）。导出（PNG/PDF 必须逐字节一致）、
  //       四个投影档、上下文丢失、档数超限一律走它。★ 几何层每次都问 fieldBackend()，不缓存。
  let glf = null, glFail = false
  let exporting = false           // 导出流程显式置位（compat 是 exportRender 内才置的，来不及给几何层看）
  let onBackendChange = null
  let glDenied = false            // 几何层自己不出网格（电平数超上限）：别再拿 'gl' 去催它重算，否则死循环
  const glField = () => {
    if (glFail || dead) return null
    if (!glf) {
      try { glf = createGlField() } catch { glFail = true; return null }
      if (!glf.available()) { glFail = true; glf = null; return null }
      glf.setOnContextChange(() => { requestDraw(); notifyBackend(); resetGlLines() })
      glf.resize(canvas.width, canvas.height)
    }
    return glf.available() ? glf : null
  }
  // ---- 线的 GPU 路（等值线 / 聚焦星轨迹与覆盖圈 / 波束线 / 仰角线）：见 glLines.js 文件头 ----
  // 闸门：屏上绘制（导出恒走 Canvas2D 描边，PNG/PDF 逐字节不变）且 WebGL2 可用且线程序建得出来。
  // glLinesOn 是开发/验证台的总开关（关掉即整条 Canvas2D 老路，用来做 A/B 逐像素对拍与计时）。
  let glLinesOn = true
  const glLines = () => { if (!glLinesOn) return null; const g = glField(); return g ? g.lines() : null }
  const lnOk = () => !compat && !exporting && !!glLines()
  const DL_KEY = 'data'          // 数据线集合（波束线 + 仰角线 + 聚焦几何）在线程序里的 id
  let dlMeta = null, dlDirty = true   // 数据线集合：上传后的元数据（趟区间 / 跨度）；内容或平面变了就重打包
  // 上下文丢失 / 恢复：显存里的线集合全没了，等值线层按当前状态重传、数据线下一帧重打包
  function resetGlLines() { dlMeta = null; dlDirty = true; for (const L of fieldLayers) { L._lnKey = null; L._lnMeta = null; L._lnPlaneKey = null } syncFieldLines() }
  // nLevels：本次要画多少档（几何层传入）。uniform 数组是定长的 → 超上限退回 CPU 路。
  function fieldBackend(nLevels) {
    // 导出恒走 CPU 路：exportRender 的 compat 分支只认 fillBands，PNG/PDF 逐字节一致是硬约束。
    // 六个投影档【都】走 GPU（等距圆柱在着色器里现算平面坐标，其余五档 CPU 预投，见 glField.js）。
    if (exporting || compat) return 'paths'
    if (nLevels != null && nLevels > GL_MAX_LEVELS) return 'paths'
    return glField() ? 'gl' : 'paths'
  }
  // 现有层是按哪个后端建的（送来的层带 fieldMesh 即 'gl'）；与 fieldBackend() 不一致时通知宿主重算一轮。
  const layersBackend = () => (fieldLayers.length ? (fieldLayers.some((L) => L.fieldMesh) ? 'gl' : 'paths') : null)
  function notifyBackend() {
    if (!onBackendChange) return
    const have = layersBackend()
    if (!have) return
    const want = fieldBackend()
    if (have === want || (want === 'gl' && glDenied)) return
    queueMicrotask(() => {
      const h = layersBackend(), w = fieldBackend()
      if (h && h !== w && !(w === 'gl' && glDenied)) onBackendChange(w)
    })
  }
  let covGridLayers = [], covGridAlpha = 0.82   // STK Coverage 覆盖分析【专用通道】：FOM 分带热力图（各胞元四角），独立于 GRD 覆盖场
  // 环境场【专用通道】：一张等经纬位图（ITU 降雨率/零度等温线/海拔…）+ 逐档等值线。
  // 位图不走分带多边形——连续场用栅格一次 drawImage 即可，缩放平移零成本、也不受多边形数量拖累。
  let envImg = null, envBBox = null, envAlpha = 0.78, envSmooth = true
  let envContours = []   // [{ level, text, color, width, lines:[[[lon,lat]...]], labels:[{lon,lat,a}] }]
  // 晨昏线：随时间轴每次推进重算，只存当次的点列（约 1440 点，逐帧直接 trace，不烘 Path2D
  // ——量级比覆盖分带小两三个数量级，缓存收益还不如省掉 compat 分支的复杂度）。termDate 留着给换平面后就地重算
  let termData = null, termOpts = {}, termDate = null
  // 晨昏效果（夜区柔和压暗）：只存日下点与样式，栅格按需重算（见 drawNightShade）
  let nightSub = null, nightOpts = { color: '#030814', opacity: 0.72 }
  let nightEq = null, nightPj = null
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
    oceanColor: '#96c3e6', oceanOpacity: 1, seaColor: '#86b0d4', seaOpacity: 1,
    countryBold: false, provBold: false, cityBold: false, oceanBold: false, seaBold: false   // 五档各自的字重（与 3D 同步；2D 逐次画字现取，不必重烘）
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
  // 导出时能不能【逐片】画位图影像：只有输出目标是真 canvas（PNG）时成立 —— svgcanvas 会把每一片
  // 各自 base64 成一个 <image>，SVG 体积炸掉，且片边被取整后海面上会留一格一格的白缝。故不能只看 compat。
  let rasterOut = false
  // 矢量导出（PDF）的影像底图：整层【预合成】成的一张位图（见 bakeImagery），由 exportRender 递进来。
  // 非空即顶替逐片绘制 —— 于是矢量 PDF 也有影像底图，而不是悄悄掉回矢量海陆。
  let vecImg = null
  let mk = { points: [], stations: [], trajectories: [] }
  // 运动档载具（P4：航迹带起始时刻 + 速度，随仿真时钟沿大圆走）：航迹 id → { lat, lon, headingDeg, gen }（条目复用）。
  // 没有条目的航迹（静止档）照旧把载具画在末航点、朝向按末段在图上的走向 —— 与改动前逐像素相同。
  const vehStates = new Map()
  let vehGen = 0
  // 拖放落点高亮（页面 dragover 期间给）：{ kind, id, px, color } | null；每帧按该实体【当前】屏幕位置画（实时层，不进快照）
  let dropHl = null
  // 挂了 3D 模型的站 / 点 / 载具：平面图画这件模型的俯视图（页面注入的出图器，见下方 sprAt 与 viz/flatmap/entitySprites.js）
  // 性能指标表的城市层（每张开着的表一层）：[{ key, color, width, markOn, labelOn, labelPt, labelAlign,
  //   items:[{ lon, lat, ring:[[lon,lat],…]|null, text }] }]。与标记同住文字快照（页面按表推、随天线移动重推）
  let cityBoxes = []
  let boreRings = []   // 对星指向天线的目标星高亮环 [{ lat, lon, color, px }]（星下点处画空心环）
  let focusSats = []    // 聚焦卫星星下点列表 [{ lat, lon }...]（多选=每颗各一个图标，同款同大小，不分主次）
  let selGeomList = []  // 聚焦卫星几何列表 [{ footprint:[{lat,lon}...], track:[{lat,lon}...], sub:{lat,lon} }...]，与 3D 同源（多颗同时叠画）
  // 聚焦卫星显示样式（与 3D 同一份设置，由 3D 页 setFocusStyle 推入；线宽/图标尺寸口径与 3D 同为屏幕 px）
  const focusCfg = {
    trkOn: true, trkColor: '#e8c074', trkWidth: 1.6, trkOpacity: 1, trkDash: 'solid',
    trkMode: 'line', trkFillColor: '#e8c074', trkFillOpacity: 0.3,   // 轨迹形式：line＝轨迹线；swath＝轨迹面（两缘按线样式描、带内按填充色/透明度）
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
    ptFont: 14, ptLabelColor: '#ffffff', ptLabelOpacity: 1, ptLabelPos: 'up', ptBold: false,
    stOpacity: 1, stIcon: 16, stFont: 17, stLabelColor: '#ffffff', stLabelOpacity: 1, stLabelPos: 'down', stBold: false,
    tjWidth: 2.2, tjOpacity: 0.95, tjDash: 'solid', tjDot: 4, tjIconOn: true, tjIconPx: 26,
    tjNameOn: false, tjNameFont: 13, tjNameColor: '#ffffff', tjNameBold: false
  }
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

  // ── 标记实体的模型俯视图 ──
  // 载荷带 m2d = {id, px} 的站 / 点 / 载具（挂了 3D 模型且「卫星模型 · 显示」开着，页面给）不画通用符号，画这件模型的正射俯视图：
  // 出图器由页面经 setEntitySprites 注入（viz/flatmap/entitySprites.js：同一份模型、同一套打光与深色描边，与 3D 球上的模型图标一致）。
  // px = 包围球直径（与 3D 同一个值 = 这一类标记自己的图标大小，页面 entIconPxOf），这里再乘它顶替的那枚符号在平面图上的同一套系数：
  // 克制版 iz，站 / 载具另乘 ST_ICON_K（两者的平面图符号都乘它，模型图不乘就比同一个设置下的符号大 18 %）。
  // 出图器这一档还没出好时照画通用符号，一帧都不空着。
  // ★ 画图、标注让位、拖拽 / 拖放命中都走 sprAt 这一支（命中用 'peek'：只看已出的图）—— 图上画多大就按多大抓、让多远
  let entSpr = null
  const stAims = new Map()   // 站 id → { az, el, park, gen }：挂了模型的站此刻对星的画面口径方位 / 仰角（页面 setStationAims 每拍推）
  let aimGen = 0
  const _spq = { id: '', kind: '', ent: '', rot: 0, aim: null, px: 0, scale: 1 }
  // kind：'station' | 'point' | 'aircraft' | 'ship'；ent：实体键（出图器按它记跨帧状态）；rot：本体 +X 在图上的朝向（弧度，屏幕正上起顺时针）
  function sprAt(kind, ent, e, rot, iz, mode) {
    const m = e && e.m2d
    if (!entSpr || !m || !m.id) return null
    _spq.id = m.id; _spq.kind = kind; _spq.ent = ent; _spq.rot = rot
    _spq.aim = kind === 'station' ? (stAims.get(e.id) || null) : null
    _spq.px = (m.px > 0 ? m.px : 28) * iz * (kind === 'point' ? 1 : ST_ICON_K)
    _spq.scale = compat && !rasterOut ? Math.max(4, dpr) : dpr   // 矢量 PDF 里它是位图：按 4 倍出，放大看不糊
    return entSpr.get(_spq, mode || (compat ? 'sync' : 'draw'))
  }
  // 画一张：锚点平移 → 补转角零头 → 按描述铺开（CSS px）
  function drawSpr(sp, x, y) {
    ctx.save()
    ctx.translate(x, y)
    if (sp.rot) ctx.rotate(sp.rot)
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(sp.canvas, sp.dx, sp.dy, sp.dw, sp.dh)
    ctx.restore()
  }
  // 这一趟画不画模型图：导出一律画；屏上只在平面图真显示着时画 —— 3D 视图下平面图画布是 display:none，页面每拍照样推标记、
  // 它照样重画文字层，那时出的图谁也看不见（切回平面图时页面 feedFlat 重推标记，文字层当场重画）
  const sprLive = () => !!entSpr && (compat || canvas.clientWidth > 0)
  // 视口外（含一整枚的余量）不要图：屏外的站 / 载具不值得出一张图
  const sprVisible = (x, y, e, iz) => {
    const mg = Math.max(64, 1.5 * (e.m2d.px > 0 ? e.m2d.px : 28) * iz)
    return x > -mg && x < cw + mg && y > -mg && y < ch + mg
  }
  // 正北在图上的朝向（弧度，屏幕正上起顺时针）：等距圆柱恒为 0；投影档沿经线前进一小步投到图上取走向（同 vehScreenRot）
  const _nq = { lat: 0, lon: 0, headingDeg: 0 }
  function northRot(lat, lon, x, y) {
    if (PJ.identity) return 0
    _nq.lat = lat; _nq.lon = lon
    return vehScreenRot(_nq, x, y)
  }
  // 模型图的标注让位 / 命中几何（CSS px，相对锚点）：{ up, down, half } 与 stExtent 同形；cx / cy = 形体中心偏移，d = 直径
  const sprExt = (sp) => ({ up: sp.u, down: sp.d, half: Math.max(sp.l, sp.r) })
  const sprHit = (sp) => ({ cx: (sp.r - sp.l) * 0.5, cy: (sp.d - sp.u) * 0.5, d: Math.max(sp.l + sp.r, sp.u + sp.d) })

  // 预处理底图：陆地多边形（按国家配色）+ 国家名 + 大洋名。可经 setMapDetail 换源(10m/50m)重建。
  // 边界抽稀（thin>0，单位度）：与 3D 一致地稀疏化各环顶点，低画质档减少 Path2D 顶点。
  const decimateRing = (ring, minD) => {
    if (!minD || ring.length < 3) return ring
    const out = [ring[0]]; let last = ring[0]
    for (let i = 1; i < ring.length - 1; i++) { const p = ring[i]; if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minD) { out.push(p); last = p } }
    out.push(ring[ring.length - 1]); return out
  }
  // ---- d3 烘焙的录制器（只在投影档用）----
  // Path2D 本身就有 moveTo/lineTo/closePath，d3 的 geoPath 也只用这三个 —— 但导出（compat）
  // 那条要点列回放，视口裁剪要 x 跨度，故包一层同时记三份，一次投影出三种产物。
  function projRec(wantPts) {
    const path = new Path2D()
    const subs = wantPts ? [] : null
    let cur = null
    return {
      path, subs, lo: Infinity, hi: -Infinity,
      moveTo(x, y) { path.moveTo(x, y); if (subs) { cur = [[x, y]]; subs.push(cur) } this.pt(x) },
      lineTo(x, y) { path.lineTo(x, y); if (cur) cur.push([x, y]); this.pt(x) },
      closePath() { path.closePath() },
      arc(x, y, r) { path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); this.pt(x) },
      pt(x) { if (x < this.lo) this.lo = x; if (x > this.hi) this.hi = x }
    }
  }
  // 一组折线 → GeoJSON（投影档把什么都归成 GeoJSON 交给 d3，它顺带把日界线切割与长段加密一并做了）
  const asLines = (list) => ({ type: 'MultiLineString', coordinates: list })
  // ★ 绕向归正 —— 投影档最容易栽的一个坑。
  //   d3 按【球面】口径判多边形内外：环的左侧是内部，故绕向反了填的就是补集（整个球减去这一块）。
  //   底图里实测有 4 个小岛环（巴哈马 / 马尔代夫）是反的，d3 把它们算成 area = 4π —— 一张世界地图
  //   被这几个小岛整个涂满，症状是「海陆颜色反了」。平面口径下（换投影前）不存在这回事：
  //   那边是 evenodd，绕向无关。
  //   判据用面积：真实地物没有超过半球的，故 area > 2π 必是绕反了，整份环列（外环+洞）一起翻。
  const orientRings = (rings, insidePt) => {
    const geo = { type: 'Polygon', coordinates: rings }
    const bad = insidePt ? !geoContains(geo, insidePt) : geoArea(geo) > 2 * Math.PI
    return bad ? rings.map((r) => r.slice().reverse()) : rings
  }
  const asPoly = (rings, insidePt) => ({ type: 'Polygon', coordinates: orientRings(rings, insidePt) })

  let land = [], clabels = [], borderLines = null
  let mapDetail0 = '10m', mapThin = 0
  // 「拖着转」进行中（setRotateMode + 拖动期间为真）：底图临时降到 110m 骨架。
  // 实测一次全量重烘 50m 档 44 ms（≈23 fps，转起来是顿的），110m 档 5.6 ms —— 转动要跟手就得降这一档。
  // 覆盖场与影像另有出路：它们烘在旧平面上，重烘太贵，转动期间整层不画（见 drawField / drawImagery）。
  let rotLive = false
  // 全图背板烘制期间也临时降到 110m（见 ensureBackplate / withLiteGeo），与「拖着转」同一档、同一条通路。
  let liteBake = false
  const curDetail = () => ((rotLive || liteBake) ? '110m' : mapDetail0)
  const curThin = () => ((rotLive || liteBake) ? 0 : mapThin)
  // 按档缓存的底图几何（面 / 国名 / 五类线的 Path2D）：背板要在 10m 与 110m 之间来回切，
  // 每次都 buildBaseGeo 一遍 10m（48 万点进 Path2D）是几十毫秒，缓存后切换只是换四个引用。
  // 键带 planeKey：换平面时旧几何整份作废（rebuildPlane / 视角广播 / 换配色处一并清空）。
  const geoCache = new Map()
  const geoKeyOf = (d, t) => d + '|' + t + '|' + planeKey()
  function withLiteGeo(fn) {
    if (rotLive || liteBake || mapDetail0 === '110m') { fn(); return }
    const k0 = geoKeyOf(mapDetail0, mapThin), k1 = geoKeyOf('110m', 0)
    geoCache.set(k0, { land, clabels, borderLines, borderPaths })
    liteBake = true
    try {
      const hit = geoCache.get(k1)
      if (hit) { land = hit.land; clabels = hit.clabels; borderLines = hit.borderLines; borderPaths = hit.borderPaths }
      else { borderPaths = null; const f110 = resolvedFeatures('110m'); buildBaseGeo(f110, 0) }
      fn()
      geoCache.set(k1, { land, clabels, borderLines, borderPaths })
    } finally {
      const back = geoCache.get(k0)
      land = back.land; clabels = back.clabels; borderLines = back.borderLines; borderPaths = back.borderPaths
      liteBake = false
    }
  }
  function buildBaseGeo(feats, thin) {
    land = []; clabels = []
    borderLines = null
    feats.forEach((f, i) => {
      if (!f.geometry) return
      const id = String(f.id)
      const idx = f.idx != null ? f.idx : i     // 取色序号按【归属】定，争议叠加与其基础面取同一号
      const over = !!f.over                     // 争议叠加面（落在宿主面之内）：导出时不并入同色 path，见 landGroups.js
      const { base: fill, arctic } = landColors(id, idx)
      // ★ 南极洲：海岸线收口到南极点，与 3D 球体走同一个 antarcticaFillRings（globe3d/antarctica.js）。
      //   不能照普通国家那样直接 closePath：110m 档的 ATA 主环首尾同为 (180, −84.71)，逐点解缠后
      //   末点落在 −180，closePath 就沿 −84.71° 直连一整圈 —— −84.71° 到 −90° 不在多边形内，
      //   画面底部一条 5.3° 高的横带是海色（附录 A 的十一点判：该档五个极区点全判在外）。
      //   10m / 50m 的环自身走到 −90°，没这个问题，但三档一律走收口件 —— 两个视图同源比分档写法靠得住。
      //   ★ 这里【不】再过 unwrap：收口件返回的环已经解缠，而主环末尾那两枚 −90° 顶点正是
      //     横跨满经度的（它们之间差一整圈），再解缠一次会把它们抓到一块、极冠当场没。
      //   三档的 fillRings 实测无洞环、互不嵌套，故逐环各成一个 shape（evenodd 在这里等于并集），
      //   导出合并同色 path 的 compat 路径也跟着成立。
      if (id === 'ATA' && PJ.identity) {
        const shs = []
        for (const ring of antarcticaFillRings(f)) {
          const u = thin > 0 ? decimateRing(ring, thin) : ring
          if (u.length < 3) continue
          let lo = Infinity, hi = -Infinity
          const path = new Path2D(), r = new Array(u.length)
          for (let i = 0; i < u.length; i++) { const x = u[i][0] - LON0, y = 90 - u[i][1]; if (x < lo) lo = x; if (x > hi) hi = x; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y); r[i] = [x, y] }
          path.closePath()
          shs.push({ lo, hi, path, rings: [r] })
        }
        if (shs.length) land.push({ shapes: shs, fill, over })
        return
      }
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
      const shapes = [], iceShapes = []   // 普通陆地色 / 北极岛屿冰白（按多边形质心纬度分流）
      for (const rings of polys) {
        let lo = Infinity, hi = -Infinity
        let path, xy
        if (PJ.identity) {
          path = new Path2D()
          xy = []   // 导出回放用：该多边形各环的「世界度坐标」点列（x=lon-LON0, y=90-lat）
          for (const ring of rings) {
            const u = thin > 0 ? decimateRing(unwrap(ring), thin) : unwrap(ring)
            const r = new Array(u.length)
            for (let i = 0; i < u.length; i++) { const x = u[i][0] - LON0, y = 90 - u[i][1]; if (x < lo) lo = x; if (x > hi) hi = x; i === 0 ? path.moveTo(x, y) : path.lineTo(x, y); r[i] = [x, y] }
            path.closePath()
            xy.push(r)
          }
        } else {
          // ★ 投影档【不】解缠：d3 要的是规范的 ±180 经度，它自己做球面多边形裁剪 ——
          //   跨日界线的面被【切】成两块而不是横扫全图，绕极的面（南极洲）自动补上极点。
          //   实测三个世界投影档的南极极冠 0 漏填，故投影档不再走 antarcticaFillRings。
          const co = thin > 0 ? rings.map((r) => decimateRing(r, thin)) : rings
          const rec = projRec(true)
          PJ.path(asPoly(co), rec)
          path = rec.path; xy = rec.subs; lo = rec.lo; hi = rec.hi
          if (!(lo <= hi)) continue                       // 被裁光了（如 Mercator 的 ±85° 以外）
        }
        // 北极岛屿（外环质心纬度 ≥ ARCTIC_ISLAND_LAT）整块染冰白；其余按国家色。与 3D 球体同口径，不再纬度渐变。
        const o = rings[0]; let sy = 0; for (const p of o) sy += p[1]
        const shape = { lo, hi, path, rings: xy }
        ;((sy / o.length) >= ARCTIC_ISLAND_LAT ? iceShapes : shapes).push(shape)
      }
      if (shapes.length) land.push({ shapes, fill, over })
      if (iceShapes.length) land.push({ shapes: iceShapes, fill: arctic, over })   // 逐国设色时 arctic=用户色（整国一色）
    })
    // 国家名：位置/线度来自解算器的 labelSet（按归属合并，per-POV 改名与 hide 在那里做）；
    // 线度→像素字号的映射式子与换源前一字不改
    // pri = 国家「视觉大小」：地名避让按它排队，大国先得位、小国撞上就让（见 drawLabelLayer）
    for (const l of labelSet('zh', curDetail())) clabels.push({ zh: l.zh, en: l.en, lon: l.lon, lat: l.lat, px: clamp(Math.round(10 + l.ext * 0.22), 10, 20), pri: l.ext })
  }
  buildBaseGeo(resolvedFeatures('10m'), 0)
  // 全图背板要 110m 骨架：起手就把那份拉进来（几百 KB 的懒加载 chunk），第一次拖过余量时已经在手。
  // 没到之前 ensureBackplate 返回 null，那一次走老路（同步重建 / 海色垫底），不会拿 10m 冒充 110m 烘一张贵的。
  ensureDetail('110m').then(() => {
    // 到手后趁空闲把 110m 的面与线烘进 geoCache（第一次要几十毫秒），免得第一次拖过余量时当场付这笔
    const ric = (typeof window !== 'undefined' && window.requestIdleCallback) || ((f) => setTimeout(f, 800))
    ric(() => { try { withLiteGeo(() => { if (!borderPaths) bakeBorders() }) } catch { /* 预热失败不影响功能 */ } })
  }).catch(() => {})

  // ── 世界平面变了：换档 / 换切口 / 换参数走的是同一条通路 ──────────────────────
  // 烘在平面坐标里的（陆地 / 五类边界线 / 覆盖填充 / 等值线）整份重造，
  // 按平面缓存的（图廓 / 经纬网 / 栅格重投影）作废 —— 后三者的键都以 planeKey() 打头，
  // 这里清一遍是双保险。
  //   refit  重新 fit（换档时平面尺寸变了要；换参数不 fit，否则拖着转每帧画面都跳一下）
  //   term   夜区数据作废（只有换切口要 —— 它的采样起点钉在 LON0）
  //   fast   转动进行中的轻量档（见 rotLive）
  const optNum = (v) => (Number.isFinite(v) ? +v : null)
  // ★ 只比【本档认的】参数（projParams：方位等距认 lat0、阿尔伯斯认两条标准纬线、其余一个都不认）：
  //   跟随星下点时 lat0 每拍都在变，等距圆柱下全比的话每拍白重建一次（rebuildPlane 把四层缓存清光）。
  const optKey = (o, kind) => projParams(kind || PJ.kind).map((k) => optNum(o && o[k])).join(',')
  const samePlaneOpts = (o, kind) => optKey(o, kind) === optKey(PJOPT, kind)
  function rebuildPlane(kind, opts, o) {
    const op = o || {}
    const H0 = PJ.H
    PJOPT = { lat0: optNum(opts && opts.lat0), par1: optNum(opts && opts.par1), par2: optNum(opts && opts.par2) }
    PJ = makeProjection(kind, LON0, PJOPT)
    rotLive = !!op.fast
    borderPaths = null; admPaths = null; gridPath = null; gridKey = ''; sphPath = null; sphKey = ''; sphOps = null; sphOpsKey = ''
    rpKey = ''; rpBox = null; rmKey = ''; rmBox = null; rmKeyT = ''; rmBoxT = null; rmBinsT = null
    geoCache.clear(); meshBlockCache.clear()
    buildBaseGeo(resolvedFeatures(curDetail()), curThin())
    // 覆盖场在转动期间不画，也就不必重烘 —— 松手那一次（fast=false）把它补回来。
    if (!rotLive) {
      fieldLayers = fieldLayers.map((L) => ({ ...L, fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null, segPaths: null, bounds: layerBounds(L) }))
      reprojectGlLayers()                       // GPU 层：投影档要按新平面重投顶点（等距圆柱只改 uniform）
      syncFieldLines()                          // 等值线的 GPU 线集合同理（投影档重投；等距圆柱不动）
      dlDirty = true                            // 数据线集合：投影档要按新平面重投；等距圆柱重打包一次也无妨（几毫秒）
      fieldLayers = fieldLayers.map((L) => ({ ...L, bounds: layerBounds(L) }))   // 重投后跨度才是新的
    }
    if (op.term) termData = null
    // fit 的判据是【平面尺寸变没变】而不是「改了什么」：换档、改标准纬线（扇面高度会变）要重新摆进画布，
    // 而方位等距改中心纬度平面恒是 360×360 —— 那时 fit 一下等于把用户放大看的那块弹回全图。
    if (op.refit === true || (op.refit !== false && Math.abs(PJ.H - H0) > 1e-6)) fit()
    // 换投影档会改后端（GPU 路只做等距圆柱）→ 通知宿主重算一轮几何，把填充换成另一种产物
    if (!rotLive) notifyBackend()
    invalidateStatic(); requestDraw()
  }

  // 视角/用户覆写改动由解算器广播回来：底图面/线/国名整份重建 + 静态层快照作废
  const offPov = onPovChange(() => {
    borderPaths = null; admPaths = null; geoCache.clear()
    buildBaseGeo(resolvedFeatures(curDetail()), curThin())
    invalidateStatic(); requestDraw()
  })

  // 合帧：把一帧内的多次重绘请求合并成一次 rAF 渲染（拖拽/缩放不再被高频事件淹没）。
  let rafId = 0
  // dead：destroy() 之后置真。卸载后仍可能有到期的定时器（瓦片到货去抖 / 负缓存解锁）想重绘，
  // 一帧 draw 会经 glRaster() 把刚 dispose 掉的 WebGL 上下文再建一个 —— 浏览器的上下文数有硬上限。
  let dead = false
  function requestDraw() { if (dead || rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; draw() }) }

  // 静态层快照（拖拽波束/调覆盖参数提速核心）：底图(海陆/冰盖/网格)与标注(省界/国家名/标记/卫星层)在拖拽中
  // 完全不变，却原本每帧重画（含上百国家名描边文字，开销大）。把它们渲到离屏缓冲，只在视图变换或静态数据
  // 变化时重建；覆盖图(GRD 填充/等值线)夹在二者之间，故拆「below(field 之下) + above(field 之上)」两张快照。
  // 拖拽/改场只重绘覆盖层，复合 = blit(below) + 覆盖填充/线 + blit(above) + 覆盖标注 + 聚焦星。
  //
  // ★ 2026-09-06：平移 / 缩放【不再】作废快照 —— 那才是「静态层每帧重建」的根因。
  //   快照按【带余量的虚拟视口】烘（余量 = 视口的 OVER，且只在世界矩形真伸出视口时才留），
  //   平移只搬位图、缩放期按比例缩位图，静止后（或盖不住时）才重建一次。判定见 snapPlace()。
  let belowCanvas = null, belowCtx = null, aboveCanvas = null, aboveCtx = null
  // ★ 2026-09-07 第三张：文字 / 标记 / 卫星层（above 里线之后的那一半）单独一张快照。
  //   理由有二：① 随时间走的东西（标记仰角、卫星图标、航迹头）每拍都变，原来一变就作废整份静态层 ——
  //   10m 一次 100 多毫秒、还把回退快照清光；拆出来之后它们只重画这一张（几毫秒，见 invalidateText）；
  //   ② 增量条带重建（见 renderStaticLayers）只对面与线成立 —— 地名避让是按整幅算的，条带里画半个字不成，
  //   文字这一张每次整份重画，本来就便宜。
  let textCanvas = null, textCtx = null, textValid = false
  let staticValid = false
  // 回退快照（§4.4）：重建时若旧的那张在世界坐标里【不是】新的子集（典型：从全图放大进来，旧的是全图），
  // 就把它整对挪到这里留着 —— 缩回去时先贴它垫底，画面永远有东西，不出现深色空环、也不用同步重建。
  // 上限 2 对（每对 ≈ 32 MB），按覆盖面积保留最大的；内容变（invalidateStatic）与 resize 时全清。
  const FALLBACK_MAX = 2
  let fallbacks = []
  let sparePairs = []
  function dropFallbacks() { for (const f of fallbacks) sparePairs.push(f); fallbacks.length = 0; if (sparePairs.length > 2) sparePairs.length = 2 }
  // 快照烘制时的视图指纹：k / 平移量（CSS）/ 四周余量（设备像素，恒为整数）
  let snapK = 0, snapTx = 0, snapTy = 0, snapMxDev = 0, snapMyDev = 0
  let snapGen = -1            // 烘这张快照时的内容代（§4.5）：与 staticGen 相同才留得住当回退
  let lastRebuildMs = 0
  // 余量占视口的比例（每边）。
  // ★ 上限钉在 RP_PAD（0.20）之下：投影档的影像重投影按【真视口】外扩 RP_PAD 烘一块
  //   （见 reprojectRaster 里的 realView），余量比它大就会在快照边上露出没影像的一条。
  const OVER = 0.18
  const OVER_Q = 64          // 余量量化到 64 设备像素：免得每次重建都换一次画布尺寸（换尺寸＝重新分配 + 清空）
  // ---- 重建代价：按【光栅】口径量，不按主线程口径 ----------------------------------------
  // Chromium 把 canvas 光栅甩到别的线程，renderStaticLayers() 末尾那个 lastRebuildMs 只记下
  // 「记录绘制指令」的时间（1.5～6 ms），真实代价落在【后面那两个真正绘制的帧】里 —— 下一帧要等
  // 上一帧的光栅排完才能开始，而这份等待是记在【回调开始之前】的，帧内计时一点都读不到。
  // ★ 空 rAF 探针不行：它不画东西，光栅队列不会在它身上排队（验证台实测连排三个空 rAF 全是 0，
  //   而随后两个【会画的】帧读到 231 ms）。故探针口径 = 「重建帧起点 → 后两个绘制帧起点」的间隔，
  //   各自扣掉 nominal（这台机器一帧本来就要等多久：真机 = 一个刷新周期，验证台无 vsync ≈ 0）。
  //   静止时后面没有帧可数 —— 由 armProbe 补两帧【逐像素相同的重绘】把这次重建的光栅账结掉，
  //   顺带把那份顶住从「用户下一次手势的第一帧」挪到静止期（§4.1）。
  let rasterGapMs = 0
  let rasterNominal = NOMINAL_MIN   // 一帧本来就要等多久（真机＝一个刷新周期），钳在 [4, 20]
  let costEst = 0
  let probeLeft = 0, probeAcc = 0, probeT = 0, probeCls = '', probeChase = 0, probeSync = 0
  // 单调计数（只增不减）：轮询式探针会漏帧，计数不会 —— 「静止之后到底还画不画」只能靠它数。
  let drawSeq = 0, rebuildSeq = 0
  // nominal 只从【连排的空 rAF】的时间戳差估（6 帧取中位数）；DPR 变化与窗口重新获得焦点时重估
  // （换显示器＝换刷新率）。
  // ★ 别再拿 draw() 的间隔估：resizeNow 是同步 draw()，与同一拍里挂着的 rAF draw 间隔 0～3 ms，
  //   一次就把 nominal 钉死在下限，于是真机上所有类永远判「贵」（§11.4）。
  // ★ 必须挑【空闲时】量：主线程忙着（启动期解析底图、手势中、探针帧未结账）时量到的是「忙」，
  //   而 nominal 偏大 ＝ 重建代价被低估 ＝ 手势里插一次整份重建，正是两头不对称里危险的那头。
  //   实测验证台上刚 reload 就量得到 14.5 ms（真值 ≈ 0）。故走 requestIdleCallback + 忙则改期。
  //   量出来之前 nominal 停在下限，代价一律偏贵（安全的那头）。
  let nominalBusy = false
  function measureNominal() {
    if (nominalBusy) return
    nominalBusy = true
    const run = () => {
      if (dragging || probeLeft > 0 || idleTimer) { setTimeout(run, 400); return }
      const ts = []
      const step = () => requestAnimationFrame((t) => {
        ts.push(typeof t === 'number' ? t : performance.now())
        if (ts.length < 6) { step(); return }
        const gaps = []
        for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1])
        rasterNominal = nominalFromGaps(gaps, rasterNominal)
        nominalBusy = false
      })
      step()
    }
    const ric = typeof window !== 'undefined' && window.requestIdleCallback
    if (ric) ric(run, { timeout: 4000 }); else setTimeout(run, 1500)
  }
  measureNominal()
  function probeTick(t0) {
    const gap = t0 - probeT
    rasterGapMs = +gap.toFixed(2)
    probeAcc += Math.max(0, gap - rasterNominal)
    probeT = t0
    if (probeLeft <= 1) probeDone(); else probeLeft--
  }
  function probeDone() {
    if (probeLeft <= 0) return
    probeLeft = 0; probeChase = 0
    // 帧间隔是【起点到起点】，本身已经把重建那一帧的同步耗时包在里面（Chromium 切回同步光栅
    // 模式时那就是全部代价）——故这里取大而不是相加，别把它算两遍。
    // 一帧都没催出来（chase 用尽）时 probeAcc 是 0，那就只剩主线程读数兜底。
    costEst = +Math.max(probeAcc, probeSync).toFixed(2); noteCost(probeCls, costEst)
  }
  // 静止时把探针要的那几帧催出来（手势中自然帧会先把它们用掉，这里就一次都不催）。
  // ★ 催不动就当场结账：探针悬着不结，下一次手势的头几帧会被算到这一次重建头上。
  function armProbe() {
    if (probeLeft <= 0) return
    if (probeChase > 12) { probeDone(); return }
    probeChase++
    requestAnimationFrame(() => { if (probeLeft > 0) { requestDraw(); armProbe() } })
  }
  // 烘快照期间的【真视口】：虚拟视口只该影响「画多大一块」，不该把影像重投影的烘图框也撑大 ——
  // 那会挪动重采样相位，静止画面就与改造前不逐像素相同了。见 reprojectRaster。
  let realView = null
  // 代价按【视角类】记：底图档 + 影像开关 + 投影 + 屏上分辨率（半倍频程一档）。
  // 换到没量过的类一律当作贵（走缩位图，静止后量到再说）。迟滞与判据见 rebuildPolicy.js。
  const costTab = makeCostTable()
  const noteCost = (cls, cost) => costTab.note(cls, cost)
  const viewCls = () => clsOf(curDetail(), imgOn, PJ.kind, k() * dpr)
  const clsCheap = (cls) => costTab.cheap(cls)
  const clsCost = (cls) => costTab.cost(cls)
  // ---- 「内容作废」与「视图补建」分家（§4.5）--------------------------------------------
  // invalidateStatic 的 29 处调用【全部】是内容变了：代号 +1、回退快照作废。
  // 只有 scheduleRebuild 到期那一条是视图补建：内容没变，代号不动、回退快照留着。
  let staticGen = 0
  function invalidateStatic() { staticValid = false; textValid = false; staticGen++; dropFallbacks() }
  function rebuildAtRest() { staticValid = false }
  // 只有文字 / 标记 / 卫星层变了：面与线那两张不动、内容代不动、回退快照留着（它们 above 里合进去的旧文字
  // 只在盖不住那一圈露一下，≤ 350 ms 就被补建盖掉）。下一帧只重画 textCanvas（见 renderTextLayer）。
  function invalidateText() { textValid = false }
  // 手势热度：按着指针拖 / 刚滚过轮不足一个 idle。热着就不补建 —— 补建的光栅会顶住下一格。
  // ★ 慢速滚轮（手滚一格 100～300 ms）必须整串算作【一次手势】：按 idleMs() 判热，两格之间
  //   就会补一次建，下一格的帧要等它的光栅（实测一格 47 ms）。故【贵】的视角热窗口拉到 ZOOM_RUN_MS，
  //   盖住整个滚轮节奏；【便宜】的视角照 idleMs()，一格滚完就清晰（那一次重建本来就 < 8 ms，
  //   落在格间也不顶谁）。
  let lastZoomAt = -1e9
  const panQ = makePanQuant()          // §4.2：交互平移的整设备像素量化（带残差，见 rebuildPolicy）
  function noteZoom() { lastZoomAt = performance.now(); panQ.reset() }
  const hotMs = () => hotMsFor(clsCheap(viewCls()), idleMs())
  const gestureHot = () => dragging || (performance.now() - lastZoomAt) < hotMs()
  // 自适应静止阈值：便宜的视角 110 ms 后就清晰，贵的视角多等一点、避开滚轮格间隔。
  const idleMs = () => idleMsFor(clsCost(viewCls()))
  // 手势静止后的一次重建（缩位图 / 位移落不到整设备像素时）。★ 只重建，不改视图。
  let idleTimer = 0
  let tilesDirty = false          // 手势中到货的瓦片：不当场作废，静止补建时一并收
  function scheduleRebuild() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(idleFire, idleMs())
  }
  function idleFire() {
    idleTimer = 0
    if (gestureHot()) {
      // 手还热：再等一拍。例外 —— 按住不动（拖动中停顿）且盖不住、又能走增量条带（≈ 20 ms）时就补一次：
      // 指尖底下停着一圈 110m 背板不好看，而条带那点代价顶不住再拖的第一帧。
      const pause = dragging && !rotDragging && staticValid && !snapPlace().covers && stripAble()
      if (!pause) { idleTimer = setTimeout(idleFire, 60); return }
    }
    // ★ 瓦片到货只是【多了几片影像】，不是换了内容：两条路都走 rebuildAtRest —— 走 invalidateStatic
    //   会 gen++ 并清空回退快照，正好把「缩回去时垫底的那张全图」清光，缩回全图又露空环（§11.2）。
    tilesDirty = false; rebuildAtRest()
    requestDraw()
  }

  function fit() { panQ.reset(); const W = PJ.W, H = PJ.H; base = Math.min(cw / W, ch / H); scale = 1; tx = (cw - W * base) / 2; ty = (ch - H * base) / 2 }
  const k = () => base * scale
  // 世界矩形（屏幕 px）：整幅图就这一张，x∈[tx, tx+360k]、y∈[ty, ty+180k]。
  // ★ 一切绘制都裁到它 —— 平面图是【一张完整的世界地图】，不是可以无限横向翻页的瓦片地图。
  //   经度环绕的 ±360 副本仍然要画：跨接缝的国家（如俄罗斯）本体在右边出界，靠左边那份副本补齐，
  //   裁剪之后两半正好拼成一张，画面上只有一个中国、一个俄罗斯。
  const worldRect = () => { const kk = k(); return { x: tx, y: ty, w: PJ.W * kk, h: PJ.H * kk } }
  // ★ 不夹紧平移（用户口径）：拖到哪儿是哪儿，允许把整张图拖出画布 —— 双击 / 「复位」一键 fit 回来。
  //   曾经加过 clampPan（贴边即止），实机上手感是「拖不动」，已取消。
  const WXN = (lon) => (((lon - LON0) % 360) + 360) % 360
  // 点 → 屏幕。★ 两个都要经绯两个参数：非圆柱投影下 x 也随纬度变、y 也随经度变，
  //   只递一个在等距圆柱下碰巧对、换投影就错。点层（地名/标记/星位）才走这两个，
  //   一屏几百个点，一点投两次的代价可忽（烘 Path2D 的热路径走 WPT，一点只投一次）。
  const PX = (lon, lat) => PJ.fwd(lon, lat || 0, _pw)[0] * k() + tx
  const PY = (lat, lon) => PJ.fwd(lon === undefined ? PJ.lon0 : lon, lat, _pw)[1] * k() + ty

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
  // ---- 栅格重投影（只在投影档走）----
  // 影像底图与环境场栅格都是【等经纬位图】，换了投影不能再一次 drawImage 铺完。
  // 做法是【网格仿射拉伸】，不是逐像素反算 —— 三条理由，每一条都是踩出来的：
  //
  //   ① 逐像素要 getImageData 读源图，源一旦跨域（离线包走 imagery:// 自定义协议，验证台上是
  //      另一个端口）画布就被污染、getImageData 当场抛安全错。抛了就回退矢量底图，症状是
  //      「开了影像却还是矢量图」，一句报错都没有。网格拉伸只用 drawImage，不碰像素。
  //   ② 逐像素是 CPU 的活，一屏一百万次逆算 + 一百万次采样；drawImage 是 GPU 的活，
  //      一格一次、几十到几千次。这就是「开影像特别卡」与「拖得动」的差别。
  //   ③ 一格多大由【投影的曲率】定（见下面的 RP_TOL）：圆柱与伪圆柱的纬线是直线，一整块就是
  //      一次仿射，整幅几十次 drawImage 就够；圆锥（Albers）的纬线是圆弧，按半径细分。
  //      ★ 别再改回「固定像素数」那一档 —— 那样圆锥一屏要三万多个三角形，卡的就是它。
  //
  // 另外两件让它不重烘的事：
  //   · 烘的是【平面空间】的一块（外扩 RP_PAD 一圈），不是屏幕。拖动只要没拖出这一圈就直接复用。
  //   · 分辨率档取 2 的幂，缩放连续变化时不会每帧换一档、白重烘。
  const RP_PAD = 0.20          // 可见矩形外扩比例：拖动余量
  // ── 一格多大：按【投影在这一块的曲率】定，不按固定像素数（判据与循环都在 ../geo/rasterMesh.js）──
  // 判据：把一段弧用直线代替，最大偏差（弓高）≤ RP_TOL 个烘图像素。弓高随跨度平方增长，
  // 故量一次参考跨度的弓高就能直接解出允许跨度，不必二分。这一条同时管住三件事：
  //   · 圆柱 / 伪圆柱的纬线是直线（弓高恒 0）→ 一块一格，与旧的 lonStep = 15° 相同；
  //   · 圆锥（Albers）的纬线是圆弧 → 按半径给步长。旧口径一律 0.5°×0.25°，实测一屏 3.7 万个
  //     三角形、每个都是 save + clip + setTransform + drawImage + restore —— 那就是
  //     「阿尔伯斯开了影像很卡」的全部成因，而按曲率给只要几百个；
  //   · 纬向同理：Mercator 低纬的 y 近乎线性、高纬才弯，行高随之变，不必全图按最坏处切。
  // 烘图像素预算（不是边长上限）。烘的是「可见区 ×1.4」那一块、按【屏幕分辨率】烘，
  // 故它的自然大小恒是画布的 1.4 倍边长 ≈ 2 倍面积；预算只在超大画布 / 超高 DPR 时才咬住。
  // ★ 曾经写成「边长 ≤ 2400」，那是按屏幕尺寸一刀切 —— 画布一宽就把烘图压到比屏幕还粗，
  //   放大后怎么调都糊。判据必须是「烘图不低于屏幕分辨率」，内存另用预算兜。
  const RP_BUDGET = 36e6       // ≈ 144 MB 的 RGBA
  let rpCanvas = null, rpCtx = null, rpKey = '', rpBox = null, rpSeq = 0
  // 整幅源图原样用，不按切口「滚」一遍。
  // ★ 曾经滚过：整幅世界图另存一张、把 lon0 那一列转到左边缘，为的是让「一条横贯全幅的带」
  //   在源图上是一块连续矩形。代价是【每个实例多一张 5120×2560 的离屏画布（52 MB）】——
  //   多开几个 2D 视图就把画布内存耗光、浏览器拒绝分配、canvas 整个变白。
  //   改成按 ≤15° 的块走网格之后，没有哪一格会跨源图的 ±180，滚这一步就不需要了。
  // ── 反向网格档的【源图降档】────────────────────────────────────────────────
  // warpTri 每个三角形都要 drawImage 整张源图（靠 clip 裁），实测耗时几乎正比于源图面积：
  // 同样一万个三角形，16K 源要 936 ms、8K 源只要 467 ms（拟合出来是「29 μs 固定开销 +
  // 0.45 μs/MPix」）。方位等距的三角形数是别的档的十倍，这一项就被放大十倍。
  // 而屏上真正用得着的分辨率是 res 个像素/度（全平面视图才 2~3），16K 是 45.5 —— 过采样十几倍。
  // 故按「目标分辨率 ×2」先缩一张（2 的幂，够用即可），放大到超过原图时自然用回原图。
  // ★ 只给反向网格档用：别的档三角形本来就少，没必要为它们多担一次缩放和一张画布。
  let thumbCv = null, thumbId = 0
  function srcThumb(img, sw, sh, res) {
    // 目标要 res 个像素/度，缩略图给 want/360，1:1 就够 —— 再多的源像素也显示不出来。
    // 向上取 2 的幂，实际平均落在 1.4 倍过采样，档位又少：
    //   res ≤ 5.7 → 2048，≤ 11.4 → 4096，≤ 22.8 → 8192，再往上直接用 16K 原图。
    // ★ 系数别给大：每跨一档就要重缩一张，而一次 16K 的 drawImage 是 550 ms。
    const want = 2 ** Math.ceil(Math.log2(Math.max(512, 360 * res)))
    if (!(want < sw)) return null                      // 已经够粗，用原图
    const id = img.__rpId || 0
    // 手上这张只要【不比要的粗】就接着用 —— 往回缩放（res 变小）时一次都不用重建
    if (thumbCv && thumbId === id && thumbCv.width >= want) return thumbCv
    const h = Math.max(1, Math.round(sh * want / sw))
    if (!thumbCv) thumbCv = document.createElement('canvas')
    thumbCv.width = want; thumbCv.height = h
    const c = thumbCv.getContext('2d')
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, want, h)
    c.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high'
    c.drawImage(img, 0, 0, want, h)
    thumbId = id
    return thumbCv
  }
  const wholeSource = (src, bb) => {
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height
    if (!(w > 0 && h > 0)) return null
    if (!src.__rpId) src.__rpId = ++rpSeq
    return bb
      ? { img: src, lonMin: bb.lonMin, lonMax: bb.lonMax, latMin: bb.latMin, latMax: bb.latMax }
              : { img: src, lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
  }
  // 一个三角形的纹理映射：把源图上的三点仿射到目标三点，裁到目标三角形之内。
  // 三点唯一确定一个仿射 → 三角网可以逼近任意光滑形变，这是标准做法（也是 GPU 干的事）。
  // ★ 三角形【按边法线】外扩 pad 像素后再裁。
  //   为什么非做不可：canvas 的 clip 是抗锯齿的，相邻两个三角形各自裁到公共边上，
  //   两边各覆盖约半个像素 → 合起来仍不满一格，缝上透出底色。整幅图于是布满一层细网格线
  //   （用户报的「底图能看到类似拼接线的细线」就是它）。让每个三角形都胀出去一点、彼此叠上，缝就没了。
  //   ★ 必须按【边法线】外扩，不能按质心等比放大：网格里有大量又扁又长的三角（高纬处一条带
  //     宽几百像素、高十几像素），等比放大对短边胀得远远不够，缝照旧在。
  const TRI_PAD = 0.75
  const _op = [[0, 0], [0, 0], [0, 0]]
  function offsetTri(d0, d1, d2, out) {
    // 逐边求「向外平移 pad」的直线，再两两求交得到新顶点。外侧＝背离对角顶点的那一侧。
    const A = [d0, d1, d2]
    const ln = []
    for (let i = 0; i < 3; i++) {
      const a = A[i], b = A[(i + 1) % 3], c = A[(i + 2) % 3]
      let nx = b[1] - a[1], ny = -(b[0] - a[0])
      const L = Math.hypot(nx, ny)
      if (!L) return false
      nx /= L; ny /= L
      if (nx * (c[0] - a[0]) + ny * (c[1] - a[1]) > 0) { nx = -nx; ny = -ny }   // 指向对角顶点的反面
      ln.push([nx, ny, nx * a[0] + ny * a[1] + TRI_PAD])
    }
    // ★ 极扁的三角（一条带宽几百像素、高十几）两边近乎平行，尖角处的斜接点跑到很远 ——
    //   不加限制的话一个三角的裁剪区能盖满全图，整张图被它一个仿射涂白（实测就是这样白的）。
    //   但也不能因此整个放弃：放弃了长边上的缝照旧在。故按【斜接限长】钳住位移 ——
    //   长边整条都被盖住，只有尖角那一丁点略欠，肉眼无从分辨。
    const LIM = TRI_PAD * 6
    for (let i = 0; i < 3; i++) {
      const l1 = ln[(i + 2) % 3], l2 = ln[i]                                   // 顶点 i 由它两侧的边决定
      const det = l1[0] * l2[1] - l1[1] * l2[0]
      if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return false
      let qx = (l1[2] * l2[1] - l2[2] * l1[1]) / det
      let qy = (l1[0] * l2[2] - l2[0] * l1[2]) / det
      if (!Number.isFinite(qx) || !Number.isFinite(qy)) return false
      let dx = qx - A[i][0], dy = qy - A[i][1]
      const L = Math.hypot(dx, dy)
      if (L > LIM) { dx = dx / L * LIM; dy = dy / L * LIM }
      out[i][0] = A[i][0] + dx; out[i][1] = A[i][1] + dy
    }
    return true
  }
  // 瓦片路专用：三角形先在【片内 uv 空间】裁到有效窗（u ≤ fx、v ≤ fy），再按同一个仿射映到目标。
  // 为什么要裁：L0–L2 的边缘片在世界之外补了边（tileClip 的 fx/fy < 1），跨接缝的三角形有一份复制
  // 落在最后一列，它越过 180° 的那一截若不裁就会把补边（复制出来的边缘像素）画到本该由第 0 列
  // 那份复制画的地方上，且后画的盖前画的。仿射把直线映成直线，故在 uv 空间裁出的多边形映到目标
  // 仍是多边形，直接当 clip 用；两份复制在 uv 空间共用同一条界线 → 无缝。L3 起 fx = fy = 1，
  // 走 warpTri 那条（带 TRI_PAD 胀边）。
  function clipPolyHalf(poly, axis, lim) {          // 保留 poly[i][axis] ≤ lim 的那一半（Sutherland–Hodgman 一条边）
    const out = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const ina = a[axis] <= lim, inb = b[axis] <= lim
      if (ina) out.push(a)
      if (ina !== inb) { const t = (lim - a[axis]) / (b[axis] - a[axis]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
    }
    return out
  }
  function warpTriClip(g, img, s0, s1, s2, d0, d1, d2, uv, win, hit, G) {
    let poly = [uv[0], uv[1], uv[2]]
    if (win[0] < 1) poly = clipPolyHalf(poly, 0, win[0])
    if (poly.length >= 3 && win[1] < 1) poly = clipPolyHalf(poly, 1, win[1])
    if (poly.length < 3) return
    const sx1 = s1[0] - s0[0], sy1 = s1[1] - s0[1], sx2 = s2[0] - s0[0], sy2 = s2[1] - s0[1]
    const det = sx1 * sy2 - sy1 * sx2
    if (!det || !Number.isFinite(det) || Math.abs(det) < 0.02) return
    const dx1 = d1[0] - d0[0], dy1 = d1[1] - d0[1], dx2 = d2[0] - d0[0], dy2 = d2[1] - d0[1]
    const a = (dx1 * sy2 - dx2 * sy1) / det, b = (dy1 * sy2 - dy2 * sy1) / det
    const c = (dx2 * sx1 - dx1 * sx2) / det, d = (dy2 * sx1 - dy1 * sx2) / det
    const e = d0[0] - a * s0[0] - c * s0[1], f = d0[1] - b * s0[0] - d * s0[1]
    g.save()
    g.beginPath()
    for (let i = 0; i < poly.length; i++) {
      const sp = tileUvToPx(poly[i][0], poly[i][1], hit, G)
      const X = a * sp[0] + c * sp[1] + e, Y = b * sp[0] + d * sp[1] + f
      if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y)
    }
    g.closePath(); g.clip()
    g.setTransform(a, b, c, d, e, f)
    g.drawImage(img, 0, 0)
    g.restore()
  }
  function warpTri(g, img, s0, s1, s2, d0, d1, d2) {
    const sx1 = s1[0] - s0[0], sy1 = s1[1] - s0[1], sx2 = s2[0] - s0[0], sy2 = s2[1] - s0[1]
    const det = sx1 * sy2 - sy1 * sx2
    // ★ 源三角形近乎退化就别画：行列式趋零 → 下面的 a,b,c,d 爆炸 → drawImage 要把整张 16K 源图
    //   按一个天文尺度变换之后再裁进几个像素，单个三角形能吃掉好几毫秒。方位等距圆周那一圈
    //   （四角钳到圆上、经纬挤成一条）尽是这种格，实测把整幅烘图从 1.4 秒拖到 11.7 秒；
    //   而它们本来也贴不出什么内容 —— 源面积不到百分之一个像素。
    if (!det || !Number.isFinite(det) || Math.abs(det) < 0.02) return
    const dx1 = d1[0] - d0[0], dy1 = d1[1] - d0[1], dx2 = d2[0] - d0[0], dy2 = d2[1] - d0[1]
    const a = (dx1 * sy2 - dx2 * sy1) / det, b = (dy1 * sy2 - dy2 * sy1) / det
    const c = (dx2 * sx1 - dx1 * sx2) / det, d = (dy2 * sx1 - dy1 * sx2) / det
    const e = offsetTri(d0, d1, d2, _op) ? _op : [d0, d1, d2]
    g.save()
    g.beginPath()
    g.moveTo(e[0][0], e[0][1]); g.lineTo(e[1][0], e[1][1]); g.lineTo(e[2][0], e[2][1]); g.closePath()
    g.clip()
    g.setTransform(a, b, c, d, d0[0] - a * s0[0] - c * s0[1], d0[1] - b * s0[0] - d * s0[1])
    g.drawImage(img, 0, 0)
    g.restore()
  }
  // 要铺的那块平面矩形（CPU 与 GPU 两条路共用同一个取景，网格才对得上）。
  // ★ 视口取【真视口】而非烘快照时的虚拟视口：烘图框一变，重采样的相位就跟着变，静止画面
  //   与改造前不再逐像素相同。快照的那圈余量由 RP_PAD 兜（OVER < RP_PAD，见 renderStaticLayers）。
  function rasterFrame(kk) {
    const RV = realView || { cw, ch, tx, ty }
    const vx0 = (-RV.tx) / kk, vx1 = (RV.cw - RV.tx) / kk, vy0 = (-RV.ty) / kk, vy1 = (RV.ch - RV.ty) / kk
    const padX = (vx1 - vx0) * RP_PAD, padY = (vy1 - vy0) * RP_PAD
    const bx0 = Math.max(0, vx0 - padX), bx1 = Math.min(PJ.W, vx1 + padX)
    const by0 = Math.max(0, vy0 - padY), by1 = Math.min(PJ.H, vy1 + padY)
    if (!(bx1 > bx0 && by1 > by0)) return null
    return { bx0, bx1, by0, by1, vx0, vx1, vy0, vy1 }
  }
  function reprojectRaster(src, srcBBox, smooth) {
    if (!src) return null
    const kk = k()
    if (!(kk > 0)) return null
    const F = rasterFrame(kk)
    if (!F) return null
    const { bx0, bx1, by0, by1, vx0, vx1, vy0, vy1 } = F
    // ★ 烘图分辨率 = 屏幕分辨率，只在超出像素预算时才降。
    //   曾经写成 2^round(log2(...))：round 会往下取，实测放大 39× 时屏幕要 76.9 px/度、
    //   烘图只给 64，差 1.2 倍；再叠上边长封顶就成了 2.7 倍。量化本是为了「缩放时别每帧重烘」，
    //   但缩放本来就会改变可见框、缓存照样失效 —— 量化只换来糊，不换来快。
    let res = Math.max(1e-6, kk * dpr)
    const npx = (bx1 - bx0) * (by1 - by0) * res * res
    if (npx > RP_BUDGET) res *= Math.sqrt(RP_BUDGET / npx)
    const S = wholeSource(src, srcBBox)
    if (!S) return null
    const key = planeKey() + '/' + res + '/' + (src.__rpId || 0) + '/' + (smooth ? 1 : 0)
    // ★ 复用判据里的视口必须【先钳到平面范围】，再与烘图矩形比 —— 烘图矩形本身就是钳过的
    //   （上面 bx0..by1 那四行）。不钳的话，全图视角（信箱留白，vx0 < 0、vx1 > PJ.W）永远
    //   比不过 rpBox ⊂ [0,W]×[0,H] 这一层，条件恒假 → 每一帧平移都整份重烘一遍
    //   （方位等距 + 16K 实测 8 次平移 8 次重烘、每帧 300 ms）。放大到视口落进图幅内时
    //   两者本来就相等，故这一条只会让【原本该命中却没命中】的那些命中，不会放宽任何真需要重烘的情形。
    const qx0 = Math.max(0, vx0), qx1 = Math.min(PJ.W, vx1)
    const qy0 = Math.max(0, vy0), qy1 = Math.min(PJ.H, vy1)
    if (rpKey === key && rpBox && qx0 >= rpBox.x0 - 1e-6 && qx1 <= rpBox.x1 + 1e-6 && qy0 >= rpBox.y0 - 1e-6 && qy1 <= rpBox.y1 + 1e-6) return rpCanvas
    const W = Math.max(1, Math.round((bx1 - bx0) * res)), H = Math.max(1, Math.round((by1 - by0) * res))
    const _t0 = performance.now()
    globalThis.__bakeStat = { res, kkdpr: kk * dpr, boxW: bx1 - bx0, boxH: by1 - by0, W, H, screenW: cw * dpr, screenH: ch * dpr }
    if (!rpCanvas) { rpCanvas = document.createElement('canvas'); rpCtx = rpCanvas.getContext('2d') }
    if (rpCanvas.width !== W || rpCanvas.height !== H) { rpCanvas.width = W; rpCanvas.height = H }
    const g = rpCtx
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, W, H)
    g.imageSmoothingEnabled = smooth !== false
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high'
    const sw = S.img.naturalWidth || S.img.width, sh = S.img.naturalHeight || S.img.height
    const bpx = (wx) => (wx - bx0) * res, bpy = (wy) => (wy - by0) * res
    // ── 网格来自共用的规划器（../geo/rasterMesh.js）—— GPU 路拿的是同一份，两条路几何逐字相同 ──
    const M = planRasterMesh(PJ, { bx0, bx1, by0, by1, res, S })
    // 源图降档（见 srcThumb）：只给反向网格档用 —— 别的档三角形本来就少，没必要为它们多担一次缩放。
    // 拿不到缩略图（分辨率已经要到原图那一档）就照原图走。
    let IMG = S.img, IW = sw, IH = sh
    if (PJ.invGrid) {
      const TH = srcThumb(S.img, sw, sh, res)
      if (TH) { IMG = TH; IW = TH.width; IH = TH.height }
    }
    const SA = [0, 0], SB = [0, 0], SC = [0, 0], DA = [0, 0], DB = [0, 0], DC = [0, 0]
    for (let t = 0; t < M.n; t++) {
      const i = t * 6
      SA[0] = M.uv[i] * IW; SA[1] = M.uv[i + 1] * IH
      SB[0] = M.uv[i + 2] * IW; SB[1] = M.uv[i + 3] * IH
      SC[0] = M.uv[i + 4] * IW; SC[1] = M.uv[i + 5] * IH
      DA[0] = bpx(M.xy[i]); DA[1] = bpy(M.xy[i + 1])
      DB[0] = bpx(M.xy[i + 2]); DB[1] = bpy(M.xy[i + 3])
      DC[0] = bpx(M.xy[i + 4]); DC[1] = bpy(M.xy[i + 5])
      warpTri(g, IMG, SA, SB, SC, DA, DB, DC)
    }
    const tris = M.n
    g.setTransform(1, 0, 0, 1, 0, 0)
    globalThis.__bakeStat.tris = tris
    globalThis.__bakeStat.ms = +(performance.now() - _t0).toFixed(1)
    if (!tris) { rpBox = null; rpKey = ''; return null }
    rpKey = key
    rpBox = { x0: bx0, y0: by0, x1: bx1, y1: by1 }
    return rpCanvas
  }
  // ---- 投影档【瓦片】影像（《2D 投影档高精影像》§4）----
  // 同一份三角网（planRasterMesh，S = 整幅世界）按片分桶（../geo/tileBins.js）：GPU 每桶一次 drawArrays
  // 绑该片纹理、片外 discard；CPU（导出 / 无 WebGL2）每桶换一张源图逐三角 warpTri。
  // 选级与等距圆柱 imageryPlan 同一个式子 → 同一缩放六投影同级。网格键带 z 与集名；到货【不】改键
  // （GPU 只换纹理），CPU 路的键另带到货代（到货就得重烘）。
  let rmKeyT = '', rmBoxT = null, rmBinsT = null, rmTilesT = null, rmCountT = 0
  let tileGen = 0
  const tileZ = (kk) => pickZoom(1 / (kk * dpr), imgMaxZ)
  const WORLD_S = { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
  function planTileBins(F, res, z) {
    const M = planRasterMesh(PJ, { bx0: F.bx0, bx1: F.bx1, by0: F.by0, by1: F.by1, res, S: WORLD_S })
    return binByTiles(M, z, imgSet)
  }
  // 屏上 GPU 路的分桶网格：【按块缓存】+ 放宽容差。
  // 反向网格（方位等距）的规划器本来就按 MESH_BLOCK（15 平面单位）的固定块走，块的三角形与视框无关 ——
  // 一块的规划就是「把 planRasterMesh 的框缩到那一块」；于是平移只规划新进入的块，其余从缓存拼。
  // 实测 t=0.3 全图一次重规划 75～104 ms（3.8～5 万三角形、规划器占八成、分桶排序 6 ms）→ 拼接 ≈ 1 ms。
  // 正向档（圆柱 / 伪圆柱 / 圆锥）本来就只有一两千个三角形、3 ms，不缓存（块会在切口 / 接缝上重叠）。
  // 容差 GPU_TOL=1.2 px（导出的 CPU 路仍是 RP_TOL=0.6，不动）：影像位置差 1 px 肉眼分不出，三角形少一半。
  const GPU_TOL = 1.2
  const MESH_BLOCK_MAX = 900          // 每块 ≈ 10～30 KB（float32 × 12 × 三角形数），封顶约 20 MB
  const meshBlockCache = new Map()
  const emptyBins = () => ({ xy: new Float64Array(0), uv: new Float64Array(0), n: 0, bins: [], tiles: [] })
  // budgetMs：本帧最多花多少毫秒规划缺的块；花完还没齐就返回 null（调用方先用整盘粗网格顶着、下一帧接着规划）。
  // 一次规划整个视框实测 91 ms（3.4 万三角形）—— 那是松手后的一顿；分到每帧 8 ms 就看不见了。
  function planTileBinsCached(F, res, z, budgetMs = Infinity) {
    if (!PJ.invGrid) {
      const M = planRasterMesh(PJ, { bx0: F.bx0, bx1: F.bx1, by0: F.by0, by1: F.by1, res, S: WORLD_S, tol: GPU_TOL })
      return withBinBoxes(M.n ? binByTiles(M, z, imgSet) : emptyBins())
    }
    const CP = MESH_BLOCK, pre = planeKey() + '/' + res + '/' + z + '/' + imgSet + '/'
    const _t0 = performance.now()
    const parts = []
    let total = 0
    for (let px = Math.floor(F.bx0 / CP) * CP; px < F.bx1; px += CP) {
      for (let py = Math.floor(F.by0 / CP) * CP; py < F.by1; py += CP) {
        const key = pre + px + ',' + py
        let e = meshBlockCache.get(key)
        if (e) { meshBlockCache.delete(key); meshBlockCache.set(key, e) }   // LRU 触碰
        else {
          if (performance.now() - _t0 > budgetMs) return null
          const M = planRasterMesh(PJ, { bx0: px, bx1: px + CP, by0: py, by1: py + CP, res, S: WORLD_S, tol: GPU_TOL })
          const B = M.n ? binByTiles(M, z, imgSet) : emptyBins()
          e = { xy: new Float32Array(B.xy), uv: new Float32Array(B.uv), n: B.n, bins: B.bins, tiles: B.tiles }
          meshBlockCache.set(key, e)
          while (meshBlockCache.size > MESH_BLOCK_MAX) meshBlockCache.delete(meshBlockCache.keys().next().value)
        }
        if (e.n) { parts.push(e); total += e.n }
      }
    }
    const xy = new Float32Array(total * 6), uv = new Float32Array(total * 6)
    const bins = [], tiles = [], seen = new Set()
    let off = 0
    for (const e of parts) {
      xy.set(e.xy, off * 6); uv.set(e.uv, off * 6)
      for (const b of e.bins) bins.push({ z: b.z, r: b.r, c: b.c, first: b.first + off, count: b.count })
      for (const t of e.tiles) { const kk = t.r * 100000 + t.c; if (!seen.has(kk)) { seen.add(kk); tiles.push(t) } }
      off += e.n
    }
    return withBinBoxes({ xy, uv, n: total, bins, tiles })
  }
  // 每桶的平面包围盒（bx0..by1）：画之前按视口裁桶 —— 整盘网格的桶铺满全世界，不裁就会为屏外的片发请求
  function withBinBoxes(B) {
    const xy = B.xy
    for (const b of B.bins) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let t = b.first; t < b.first + b.count; t++) {
        const i = t * 6
        for (let v = 0; v < 3; v++) { const x = xy[i + v * 2], y = xy[i + v * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
      }
      b.bx0 = x0; b.bx1 = x1; b.by0 = y0; b.by1 = y1
    }
    return B
  }
  // 整盘粗网格：整个平面（[0,W]×[0,H]）按 fit 那一档的分辨率规划一次（每个平面一份），按 z 分桶各存一份。
  // 方位等距 1280×720 @1.5 实测 2.2 万三角形，规划一次十几毫秒，之后换级只是分桶（≈ 3 ms）。
  const diskRes = () => 2 ** Math.ceil(Math.log2(Math.max(0.5, base * dpr)))
  const diskKeyOf = (z) => planeKey() + '/disk' + diskRes() + '/z' + z + '/' + imgSet
  let diskMesh = null, diskMeshKey = ''
  const diskBinsByZ = new Map()      // z → 分桶结果（LRU，最近用的在末尾）
  const DISK_KEEP = 3                // 最多留几档：每档几 MB 的 Float32，maxZ 调高时按 4× 递增，不封顶就是几百 MB
  let diskIdleT = 0, imgNotReady = false
  // hot=true（手势帧）：本档没分过桶时【不在这一帧分】（每档 13～50 ms，正落在滚轮里），先拿已分好的最近
  // 一档顶着 —— 桶自带级号与行列号，画出来只是级号粗 / 细一档；静止后那一帧按本档补齐。
  // 整盘网格本身（planRasterMesh，一个平面一次）与「一档都没有」时照旧同步算：一次性代价，比露矢量底图划算。
  function diskBins(z, hot) {
    const key = planeKey() + '/' + diskRes() + '/' + imgSet
    if (diskMeshKey !== key) {
      diskMesh = planRasterMesh(PJ, { bx0: 0, bx1: PJ.W, by0: 0, by1: PJ.H, res: diskRes(), S: WORLD_S, tol: GPU_TOL })
      diskMeshKey = key; diskBinsByZ.clear()
    }
    let B = diskBinsByZ.get(z)
    if (B) { diskBinsByZ.delete(z); diskBinsByZ.set(z, B); return B }
    if (hot && diskBinsByZ.size) {
      let best = null, bd = Infinity
      for (const [zz, BB] of diskBinsByZ) { const d = Math.abs(zz - z) + (zz > z ? 0.5 : 0); if (d < bd) { bd = d; best = BB } }
      if (!diskIdleT) {
        diskIdleT = setTimeout(function fire() {
          diskIdleT = 0
          if (dead) return
          if (gestureHot()) { diskIdleT = setTimeout(fire, 90); return }
          requestDraw()                                   // 静止了：重画这一帧会按本档分桶（hot=false）
        }, 90)
      }
      return best
    }
    const R = diskMesh.n ? binByTiles(diskMesh, z, imgSet) : emptyBins()
    B = withBinBoxes({ xy: new Float32Array(R.xy), uv: new Float32Array(R.uv), n: R.n, bins: R.bins, tiles: R.tiles })
    B.z = z
    diskBinsByZ.set(z, B)
    while (diskBinsByZ.size > DISK_KEEP) diskBinsByZ.delete(diskBinsByZ.keys().next().value)
    return B
  }
  // 片纹理每帧上传限额：手势中 4 片（≈ 8 ms），静止 12 片
  const TEX_UPLOADS_HOT = 4, TEX_UPLOADS_IDLE = 12
  // 静止时精确网格的分帧规划：每帧最多花这么多毫秒
  const PLAN_BUDGET_MS = 8
  // 与 reprojectRaster 同一套烘图分辨率口径（屏幕分辨率，只在超出像素预算时才降）
  function bakeRes(F, kk) {
    let res = Math.max(1e-6, kk * dpr)
    const npx = (F.bx1 - F.bx0) * (F.by1 - F.by0) * res * res
    if (npx > RP_BUDGET) res *= Math.sqrt(RP_BUDGET / npx)
    return res
  }
  function reprojectRasterTiles() {
    if (!imgSet) return null
    const kk = k()
    if (!(kk > 0)) return null
    const F = rasterFrame(kk)
    if (!F) return null
    const { bx0, bx1, by0, by1, vx0, vx1, vy0, vy1 } = F
    const res = bakeRes(F, kk)
    const z = tileZ(kk)
    const key = planeKey() + '/' + res + '/tiles/' + imgSet + '/z' + z + '/g' + tileGen
    const qx0 = Math.max(0, vx0), qx1 = Math.min(PJ.W, vx1)
    const qy0 = Math.max(0, vy0), qy1 = Math.min(PJ.H, vy1)
    if (rpKey === key && rpBox && qx0 >= rpBox.x0 - 1e-6 && qx1 <= rpBox.x1 + 1e-6 && qy0 >= rpBox.y0 - 1e-6 && qy1 <= rpBox.y1 + 1e-6) return rpCanvas
    const W = Math.max(1, Math.round((bx1 - bx0) * res)), H = Math.max(1, Math.round((by1 - by0) * res))
    const _t0 = performance.now()
    if (!rpCanvas) { rpCanvas = document.createElement('canvas'); rpCtx = rpCanvas.getContext('2d') }
    if (rpCanvas.width !== W || rpCanvas.height !== H) { rpCanvas.width = W; rpCanvas.height = H }
    const g = rpCtx
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, W, H)
    g.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high'
    const B = planTileBins(F, res, z)
    const G = tileGutter(imgSet)
    const bpx = (wx) => (wx - bx0) * res, bpy = (wy) => (wy - by0) * res
    // ★ 源图是一片 514²，不是整幅：warpTri 的「0.45 μs/MPix」那一项归零，故不用也不能用 srcThumb
    //   （它假定源宽 = 360°）。
    const SA = [0, 0], SB = [0, 0], SC = [0, 0], DA = [0, 0], DB = [0, 0], DC = [0, 0]
    const UV = [[0, 0], [0, 0], [0, 0]]
    let painted = 0
    for (const bin of B.bins) {
      const hit = getTileOrParent(imgSet, bin.z, bin.r, bin.c, onTileReady)
      if (!hit) continue                                   // 连祖先都没有：这一桶留空（海色垫在下面），到货后重烘
      const win = tileWindow(bin.z, bin.r, bin.c)
      const clip = win[0] < 1 || win[1] < 1
      for (let t = bin.first; t < bin.first + bin.count; t++) {
        const i = t * 6
        let sp = tileUvToPx(B.uv[i], B.uv[i + 1], hit, G); SA[0] = sp[0]; SA[1] = sp[1]
        sp = tileUvToPx(B.uv[i + 2], B.uv[i + 3], hit, G); SB[0] = sp[0]; SB[1] = sp[1]
        sp = tileUvToPx(B.uv[i + 4], B.uv[i + 5], hit, G); SC[0] = sp[0]; SC[1] = sp[1]
        DA[0] = bpx(B.xy[i]); DA[1] = bpy(B.xy[i + 1])
        DB[0] = bpx(B.xy[i + 2]); DB[1] = bpy(B.xy[i + 3])
        DC[0] = bpx(B.xy[i + 4]); DC[1] = bpy(B.xy[i + 5])
        if (clip) {
          UV[0][0] = B.uv[i]; UV[0][1] = B.uv[i + 1]; UV[1][0] = B.uv[i + 2]; UV[1][1] = B.uv[i + 3]; UV[2][0] = B.uv[i + 4]; UV[2][1] = B.uv[i + 5]
          warpTriClip(g, hit.img, SA, SB, SC, DA, DB, DC, UV, win, hit, G)
        } else warpTri(g, hit.img, SA, SB, SC, DA, DB, DC)
      }
      painted++
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    globalThis.__bakeStat = { path: 'tiles', z, res, W, H, tris: B.n, bins: B.bins.length, painted, ms: +(performance.now() - _t0).toFixed(1) }
    if (!painted) { rpBox = null; rpKey = ''; return null }
    rpKey = key
    rpBox = { x0: bx0, y0: by0, x1: bx1, y1: by1 }
    return rpCanvas
  }
  // 把烘好的那块贴上去：它在【平面坐标】里有确定位置，按当前变换一次 drawImage 即可 ——
  // 拖动/缩放只走这一步，不重烘（复用条件见 reprojectRaster 的键）。
  function blitReprojected(c, alpha, bright, smooth) {
    if (!c || !rpBox) return false
    const kk = k()
    const sm = ctx.imageSmoothingEnabled, f = ctx.filter
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.imageSmoothingEnabled = smooth !== false
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    if (bright != null && bright !== 1) ctx.filter = 'brightness(' + bright + ')'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.drawImage(c, rpBox.x0 * kk + tx, rpBox.y0 * kk + ty, (rpBox.x1 - rpBox.x0) * kk, (rpBox.y1 - rpBox.y0) * kk)
    ctx.filter = f
    ctx.imageSmoothingEnabled = sm
    ctx.restore()
    return true
  }
  // ---- 投影档影像的 GPU 路（见 ./glRaster.js）----
  // 网格与 CPU 路同一个 planRasterMesh，只是把「贴图」这一步交给 GPU：平移 / 缩放期间不重建网格、
  // 不重传纹理，只改 uniform。换平面或分辨率跨一档才重规划一次。
  let glr = null, glrFail = false
  const glRaster = () => {
    if (glrFail || dead) return null
    if (!glr) {
      try { glr = createGlRaster() } catch { glrFail = true; return null }
      if (!glr.available()) { glrFail = true; glr = null; return null }
      glr.setOnContextChange(() => { invalidateStatic(); requestDraw() })
    }
    return glr.available() ? glr : null
  }
  let rmKey = '', rmBox = null      // 网格缓存的键与覆盖范围（与 rpKey / rpBox 同一套复用判据）
  function drawImageryGL() {
    // 导出恒走 CPU 路：PNG/PDF 逐字节一致是硬约束，判据与 fieldBackend 同款
    if (exporting || compat) return false
    const kk = k()
    if (!(kk > 0)) return false
    const g = glRaster()
    if (!g) return false
    const sw = imgEl.naturalWidth || imgEl.width, sh = imgEl.naturalHeight || imgEl.height
    if (!(sw > 0 && sh > 0)) return false
    // 分辨率量化到 2 的幂：缩放连续变化时不会每帧换一档、白重规划
    const res = 2 ** Math.ceil(Math.log2(Math.max(0.5, kk * dpr)))
    // 纹理沿用 srcThumb 的分档（与 CPU 路同一张缩略图，缓存也是同一份）。
    // 要到 8192 以上（深缩放）就让给 CPU 路 —— 那时可见区很小、warpTri 本来就便宜。
    if (!imgEl.__rpId) imgEl.__rpId = ++rpSeq
    const TH = srcThumb(imgEl, sw, sh, kk * dpr)
    const TEX = TH || imgEl
    const tw = TH ? TH.width : sw
    if (tw > GL_TEX_MAX) return false
    const tk = imgEl.__rpId + '/' + tw
    if (!g.hasTexture(tk) && !g.setTexture(tk, TEX)) return false
    const F = rasterFrame(kk)
    if (!F) return false
    const mk = planeKey() + '/' + res
    // 复用判据与 reprojectRaster 一模一样：钳过的视口落在上次规划的框里就直接用
    const qx0 = Math.max(0, F.vx0), qx1 = Math.min(PJ.W, F.vx1)
    const qy0 = Math.max(0, F.vy0), qy1 = Math.min(PJ.H, F.vy1)
    const hit = g.hasMesh(mk) && rmKey === mk && rmBox &&
      qx0 >= rmBox.x0 - 1e-6 && qx1 <= rmBox.x1 + 1e-6 && qy0 >= rmBox.y0 - 1e-6 && qy1 <= rmBox.y1 + 1e-6
    if (!hit) {
      const _t0 = performance.now()
      const M = planRasterMesh(PJ, { bx0: F.bx0, bx1: F.bx1, by0: F.by0, by1: F.by1, res, S: { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 } })
      const _t1 = performance.now()
      if (!M.n || !g.setMesh(mk, M.xy, M.uv, M.n)) { rmKey = ''; rmBox = null; return false }
      rmKey = mk; rmBox = { x0: F.bx0, y0: F.by0, x1: F.bx1, y1: F.by1 }
      globalThis.__rmStat = { tris: M.n, res, tex: tw, planMs: +(_t1 - _t0).toFixed(1), ms: +(performance.now() - _t0).toFixed(1) }
    }
    g.resize(Math.round(cw * dpr), Math.round(ch * dpr))
    if (!g.render({ k: kk, tx, ty, dpr })) return false
    // 合成：GL 画布与当前渲染目标同为设备像素尺寸，1:1 贴一次（与 drawFieldGL 同一套）。
    // 亮度仍走 ctx.filter，与 CPU 路同一条乘法，不在着色器里另算一遍。
    const f = ctx.filter
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (imgBright !== 1) ctx.filter = 'brightness(' + imgBright + ')'
    ctx.drawImage(g.canvas(), 0, 0)
    ctx.filter = f
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // 恢复屏幕坐标，后续图层照旧
    return true
  }
  // 投影档瓦片影像的 GPU 路：网格（分桶后）按【可见框 + RP_PAD】缓存，复用判据与 drawImageryGL 同款；
  // 到货只换纹理、不改键；一帧一个 z（不做逐片 LOD）。返回 false ＝ 一桶都没画出来（缺包 / 还没到货）。
  function drawImageryTilesGL() {
    if (exporting || compat) return false      // 导出恒走 CPU 路（PNG/PDF 逐字节一致）
    const kk = k()
    if (!(kk > 0)) return false
    const g = glRaster()
    if (!g) return false
    const F = rasterFrame(kk)
    if (!F) return false
    const res = 2 ** Math.ceil(Math.log2(Math.max(0.5, kk * dpr)))   // 与整幅路同：量化到 2 的幂，缩放连续变化时不换网格
    const z = tileZ(kk)
    const qx0 = Math.max(0, F.vx0), qx1 = Math.min(PJ.W, F.vx1)
    const qy0 = Math.max(0, F.vy0), qy1 = Math.min(PJ.H, F.vy1)
    // ★ 整盘粗网格（见 diskBins）顶两种场合：① 宽视角（res 不超过它的两倍：弓高误差 ≤ 2.4 px，肉眼分不出，
    //   而精确规划一次 55～112 ms）；② 手势期精确网格没命中（缩出框 / 换级）—— 不在手势里规划，先用它画，
    //   静止后那一帧再换精确网格。这一条把缩放期的重规划从「每换一档一次」压到 0。
    const dr = diskRes()
    const wide = res <= dr * 2
    const mk = wide ? diskKeyOf(z) : planeKey() + '/' + res + '/z' + z + '/' + imgSet
    let hit = g.hasBinMesh(mk) && rmKeyT === mk && rmBoxT &&
      qx0 >= rmBoxT.x0 - 1e-6 && qx1 <= rmBoxT.x1 + 1e-6 && qy0 >= rmBoxT.y0 - 1e-6 && qy1 <= rmBoxT.y1 + 1e-6
    let planMs = 0, replanned = false, temp = false, zDraw = z
    if (!hit) {
      const _t0 = performance.now()
      let B = null
      if (!wide && !gestureHot()) {
        // 静止：分帧规划精确网格（每帧 ≤ PLAN_BUDGET_MS），没齐就先用整盘粗网格顶着、下一帧接着
        B = planTileBinsCached(F, res, z, PLAN_BUDGET_MS)
        if (!B) requestDraw()
      }
      if (B) {
        if (!B.n || !g.setBinMesh(mk, B.xy, B.uv, B.n)) { rmKeyT = ''; rmBoxT = null; rmBinsT = null; return false }
        rmKeyT = mk; rmBoxT = { x0: F.bx0, y0: F.by0, x1: F.bx1, y1: F.by1 }; rmBinsT = B.bins; rmTilesT = B.tiles; rmCountT = B.n
        replanned = true
      } else {
        temp = !wide
        // 手势里本档还没分桶时 D 是最近一档的桶（见 diskBins），级号以 D.z 为准
        const D = diskBins(z, gestureHot())
        const mkD = diskKeyOf(D.z)
        if (!(g.hasBinMesh(mkD) && rmKeyT === mkD)) {
          if (!D.n || !g.setBinMesh(mkD, D.xy, D.uv, D.n)) { rmKeyT = ''; rmBoxT = null; rmBinsT = null; imgNotReady = D.z !== z; return false }
          rmKeyT = mkD; rmBoxT = { x0: 0, y0: 0, x1: PJ.W, y1: PJ.H }; rmBinsT = D.bins; rmTilesT = D.tiles; rmCountT = D.n
          replanned = true
        }
        zDraw = D.z
      }
      planMs = performance.now() - _t0
    }
    // 只画与视口相交的桶（整盘网格的桶铺满全世界，不裁就会为屏外的片发请求）
    const px = (F.vx1 - F.vx0) * 0.05, py = (F.vy1 - F.vy0) * 0.05
    const vis = rmBinsT.filter((b) => b.bx1 >= F.vx0 - px && b.bx0 <= F.vx1 + px && b.by1 >= F.vy0 - py && b.by0 <= F.vy1 + py)
    if (replanned) prefetchParents(imgSet, zDraw, vis, onTileReady)   // 缩小一档要的父片顺手拉进来（只管屏上的）
    g.resize(Math.round(cw * dpr), Math.round(ch * dpr))
    const G = tileGutter(imgSet), N = tileImgSize(imgSet)
    let exact = 0
    const _t1 = performance.now()
    const painted = g.renderBins({ k: kk, tx, ty, dpr }, vis, (bin) => {
      const t = getTileFallback(imgSet, bin.z, bin.r, bin.c, onTileReady)
      if (!t) return null
      if (t.exact) exact++
      const w = tileWindow(bin.z, bin.r, bin.c)
      const alt = ancestorHit(imgSet, bin.z, bin.r, bin.c)   // 纹理上传超额时先画祖先片（一般早就传过）
      if (t.children) {
        // 四个子片拼一片：uUvOff=−(i,j)、uUvScale=2（见 glRaster 的 FRAG_TILE），片元着色器按子片窗口丢弃
        return { draws: t.children.map((c) => ({ img: c.img, u0: -c.i, v0: -c.j, u1: 2 - c.i, v1: 2 - c.j, sub: true })), alt, fx: w[0], fy: w[1], G, N }
      }
      return { img: t.img, u0: t.u0, v0: t.v0, u1: t.u1, v1: t.v1, alt: t.exact ? alt : null, fx: w[0], fy: w[1], G, N }
    }, gestureHot() ? TEX_UPLOADS_HOT : TEX_UPLOADS_IDLE)
    if (g.skippedUploads() > 0) requestDraw()   // 欠着的上传下一帧接着传
    const _t2 = performance.now()
    globalThis.__rmStat = { path: 'tiles', z: zDraw, zWant: z, tris: rmCountT, bins: vis.length, binsAll: rmBinsT.length, tiles: rmTilesT.length, tilesExact: exact, painted, texMB: g.tileTexMB(), texCount: g.tileTexCount(), replanned, disk: rmKeyT === diskKeyOf(zDraw), temp, skipped: g.skippedUploads(), planMs: +planMs.toFixed(1), submitMs: +(_t2 - _t1).toFixed(1), ms: +(_t2 - _t1 + planMs).toFixed(1) }
    if (!painted) return false
    // 合成：与 drawImageryGL 同一套（亮度仍走 ctx.filter）
    const f = ctx.filter
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (imgBright !== 1) ctx.filter = 'brightness(' + imgBright + ')'
    ctx.drawImage(g.canvas(), 0, 0)
    ctx.filter = f
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    globalThis.__rmStat.blitMs = +(performance.now() - _t2).toFixed(1)
    return true
  }
  // ── 实时影像（2026-09-07）────────────────────────────────────────────────
  // 瓦片档在屏上不再烘进静态快照，而是每帧画在快照之下（快照里世界留透明，见 drawBelowContent）。
  // 条件：瓦片档、屏上（非导出 / 非 compat / 非矢量 PDF 底图）、不在「拖着转」（那时整层退回矢量）、
  // 没判成离线包缺失，且投影档要有 WebGL2（CPU 重投影每帧几十毫秒，那条路仍走快照）。
  let imgLiveOff = false, imgLiveOffTimer = 0
  const imgLiveNow = () => imgOn && !!imgSet && !exporting && !compat && !vecImg && !rotLive && !imgLiveOff && (PJ.identity || !!glRaster())
  // 判成「离线包缺失」之后的自愈有两条路：片到货（onTileReady）立即解锁；一片都没到（404 只写负缓存、不发
  // onReady）就等负缓存过期（imageryTiles 的 MISS_TTL）自动解锁再试 —— 否则某一级整片缺失时整层退回矢量
  // 底图之后就再也回不来。
  function lockImgLive() {
    if (imgLiveOff) return
    imgLiveOff = true
    invalidateStatic()
    if (imgLiveOffTimer) clearTimeout(imgLiveOffTimer)
    imgLiveOffTimer = setTimeout(() => {
      imgLiveOffTimer = 0
      if (dead || !imgLiveOff) return
      imgLiveOff = false; invalidateStatic(); requestDraw()
    }, MISS_TTL + 200)
  }
  // draw() 里每帧调：先铺海色（图廓内），再贴影像；一片都取不到时用矢量陆地顶着（到货即换），
  // 连在飞的都没有 → 离线包缺失，退回快照里的矢量底图（与原先「drawImagery 返回 false 走矢量」同一自愈口径）。
  function drawImageryLive() {
    const _wr = worldRect()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(_wr.x, _wr.y, _wr.w, _wr.h); ctx.clip()
    let ok = false
    imgNotReady = false
    try { ok = drawImagery() } catch (e) { ok = false; console.warn('实时影像绘制失败', e) }
    if (!ok) {
      drawLand()
      // imgNotReady：这一帧只是网格 / 分桶还没备好（手势里不做整盘分桶），不是包缺失，别锁
      if (!imgNotReady && !tileStats().loading) lockImgLive()
    }
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return ok
  }
  function drawImagery() {
    if (rotLive) return false    // 转动进行中：整幅影像重投影是每帧几十毫秒，先退回矢量底图（返回 false 即走那条路）
    if (vecImg) { ctx.drawImage(vecImg, 0, 0, cw, ch); return true }   // 矢量导出：整层已合成为一张，与页面 1:1
    if (!PJ.identity) {
      // 投影档：瓦片档按片分桶贴（选级与等距圆柱同式，见 drawImageryTilesGL / reprojectRasterTiles）；
      // 整幅档（16K / 8K）下面那两行【一行不动】—— 它们的出图要与改前逐像素 / 逐字节相同。
      if (imgSet) {
        if (drawImageryTilesGL()) return true
        return blitReprojected(reprojectRasterTiles(), 1, imgBright, true)
      }
      if (!imgEl) return false
      if (drawImageryGL()) return true
      return blitReprojected(reprojectRaster(imgEl, null, true), 1, imgBright, true)
    }
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

  let lastPlanZ = -1
  function drawImageryTiles() {
    const plan = imageryPlan()
    if (!plan || !plan.items.length) return false
    if (plan.z !== lastPlanZ) { lastPlanZ = plan.z; prefetchParents(imgSet, plan.z, plan.items, onTileReady) }   // 换级：父片顺手拉进来
    const f = ctx.filter
    if (imgBright !== 1) ctx.filter = 'brightness(' + imgBright + ')'
    ctx.setTransform(1, 0, 0, 1, 0, 0)                  // 转设备像素：片边界要落在整像素上（见上）
    const G = tileGutter(imgSet)                        // 自切的离线包烘了 1px gutter
    let painted = 0
    for (const it of plan.items) {
      const t = (exporting || compat) ? getTileOrParent(imgSet, plan.z, it.r, it.c, onTileReady) : getTileFallback(imgSet, plan.z, it.r, it.c, onTileReady)
      if (!t) continue                                  // 连祖先都没有：这一片本帧留空，到货后重绘
      if (t.children) {
        // 四个子片各占一角（中线取整到设备像素，四角共用同一条线才不留缝）
        const xm = Math.round((it.x0 + it.x1) / 2), ym = Math.round((it.y0 + it.y1) / 2)
        for (const c of t.children) {
          const x0 = c.i ? xm : it.x0, x1 = c.i ? it.x1 : xm, y0 = c.j ? ym : it.y0, y1 = c.j ? it.y1 : ym
          if (x1 > x0 && y1 > y0) ctx.drawImage(c.img, G, G, TILE, TILE, x0, y0, x1 - x0, y1 - y0)
        }
        painted++
        continue
      }
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
  // ★ 手势中到货【不作废】：作废＝下一帧整份重建，代价按 §4.1 的光栅口径付，正撞在手势里。
  //   只记 tilesDirty，静止补建时一并收（补建本来就重画瓦片）。放大跨级时几批连着来更是如此。
  let tileTimer = 0
  function onTileReady() {
    tileGen++                        // CPU 路（投影档瓦片）的烘图键带它：到货就得重烘
    // 曾判「离线包缺失」退回过矢量底图：有片到货就是包在，回到实时影像
    if (imgLiveOff) { imgLiveOff = false; invalidateStatic(); requestDraw(); return }
    // ★ 实时影像：影像不在快照里，到货只是下一帧多贴几片 —— 一次 requestDraw 就够，不排补建、不重置 idle
    if (imgLiveNow()) { requestDraw(); return }
    if (gestureHot()) { tilesDirty = true; scheduleRebuild(); return }
    if (tileTimer) return
    // ★ 走 rebuildAtRest 而不是 invalidateStatic：瓦片到货只是【多了几片影像】，不是换了内容 ——
    //   按内容作废会把回退快照一并清掉（放大之后瓦片陆续到货，正好把「缩回去时垫底的那张全图」
    //   清得一张不剩），于是缩回全图又露空环。少几片影像的回退快照垫在下面完全够用。
    // ★ 到期时再判一次热：去抖期间用户可能已经开始滚轮了（实测 50m+瓦片 慢滚 8 格里漏进 2 次
    //   补建，其中一格 62 ms —— 就是【手势之前】挂上的这个定时器到期打的）。
    tileTimer = setTimeout(function fire() {
      tileTimer = 0
      if (gestureHot()) { tilesDirty = true; scheduleRebuild(); return }
      rebuildAtRest(); requestDraw()
    }, 120)
  }
  function drawLand() {
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk   // 视口世界 X 范围（未含 off）
    for (const off of wraps()) {
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (compat) {
        // 导出：基础面按填充色合并成「每色一条 path」（节点数不变，但 <path> 元素从「多边形数」降到「颜色数」）。
        // svg2pdf 逐节点 getComputedStyle 是导出耗时主因——10m 底图有数千多边形，不合并会产生数千节点。
        // ★ 争议叠加面（over）落在宿主面之内，与宿主同色时并进同一条 path 会被 evenodd 抠成洞 —— 藏南 / 典角
        //   在导出的 PNG/PDF 上成了海色补丁、屏上却没有（屏上逐面 fill(Path2D)，叠加面只是盖上去）。
        //   故叠加面不并色、逐面单独填；分组口径与理由见 landGroups.js。
        const { groups, overs } = groupLandForExport(land, off, wl, wr)
        const trace = (sh) => { for (const r of sh.rings) { for (let i = 0; i < r.length; i++) i === 0 ? ctx.moveTo(r[i][0], r[i][1]) : ctx.lineTo(r[i][0], r[i][1]); ctx.closePath() } }
        for (const g of groups) { ctx.fillStyle = g.fill; ctx.beginPath(); for (const sh of g.shapes) trace(sh); ctx.fill('evenodd') }
        for (const o of overs) { ctx.fillStyle = o.fill; ctx.beginPath(); trace(o.shape); ctx.fill('evenodd') }
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
    const L = resolvedLines(curDetail())
    const out = {}
    for (const cls of BORDER_DRAW) {
      const list = []
      if (!PJ.identity) {
        // 投影档：一类线一次烘完（d3 按子路径切开）。导出回放与视口裁剪都要逐段的点列与跨度，
        // 故一个子路径拆成一条（与等距圆柱下「一条 poly 一条」同形）。
        const rec = projRec(true)
        PJ.path(asLines((L[cls] || []).filter((q) => q && q.length >= 2)), rec)
        for (const sp of (rec.subs || [])) {
          if (sp.length < 2) continue
          let lo = Infinity, hi = -Infinity
          const pts = new Float64Array(sp.length * 2)
          const path = new Path2D()
          for (let i = 0; i < sp.length; i++) {
            const x = sp[i][0], y = sp[i][1]
            if (x < lo) lo = x
            if (x > hi) hi = x
            i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
            pts[i * 2] = x; pts[i * 2 + 1] = y
          }
          list.push({ lo, hi, path, pts })
        }
        out[cls] = list
        continue
      }
      for (const poly of (L[cls] || [])) {
        if (!poly || poly.length < 2) continue
        const u = unwrap(poly)
        let lo = Infinity, hi = -Infinity
        const path = new Path2D()
        const pts = new Float64Array(u.length * 2)   // 导出回放用（见 drawBorders 的 compat 分支），与 path 同一份坐标
        for (let i = 0; i < u.length; i++) {
          const x = u[i][0] - LON0, y = 90 - u[i][1]
          if (x < lo) lo = x
          if (x > hi) hi = x
          i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)
          pts[i * 2] = x; pts[i * 2 + 1] = y
        }
        list.push({ lo, hi, path, pts })
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
      for (const off of wraps()) {
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        // ★ 导出（compat）必须按点列回放，不能给 stroke() 递 Path2D：svgcanvas 的 stroke() 忽略入参，
        //   转而把【上一个元素】的路径重描一遍 —— 五类线在矢量 PDF 里整个消失（图上只剩色块，没有
        //   一条海岸线与国界），顺带把上一条 path（多半是经纬网）的线型改成边界线的。同 drawLand，
        //   一类合并成一条 path：节点数是 svg2pdf 逐节点 getComputedStyle 的耗时主因。
        if (compat) {
          const vis = list.filter((sh) => !(sh.hi + off < wl || sh.lo + off > wr))
          if (!vis.length) continue
          ctx.beginPath()
          for (const sh of vis) { const p = sh.pts; ctx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]) }
          ctx.stroke()
        } else for (const sh of list) { if (sh.hi + off < wl || sh.lo + off > wr) continue; ctx.stroke(sh.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([])
  }
  // 一级 / 二级行政区界（投影档）：把 d3 的那一趟【烘一次】，每帧只回放坐标。
  // ★ 治的是什么：原来这两层走 drawPolyline → drawPolylineProj，【每帧逐环过一遍 d3 的 geoPath】
  //   （日界线裁剪 + 按曲率自适应加密）。CHN 的地级市界有 4.5 万段，投影档下光这一项就能吃掉一整帧，
  //   而 d3 的输出只随【平面】变，与 pan/zoom 无关 —— 正是该烘的东西。
  // ★ 烘的是【调用序列】不是 Path2D。Path2D 是用户空间坐标、由 CTM 整体变换后光栅化，
  //   而这一层原本是「逐点算好屏幕坐标再 lineTo」—— 两条路的抗锯齿覆盖不逐位相同
  //   （实测阿尔伯斯全图差 4958 个像素、最大 16/255）。回放同一串 ctx 调用才逐像素相同。
  //   五类边界线那边本来就是 Path2D，不受这一条约束、也不动。
  // ★ 等距圆柱那条不动：它是屏幕坐标直连（没有 d3），且改了就要动导出那条路。
  // ★ 导出（compat）一律仍走 drawPolyline：PNG/PDF 逐字节一致是硬约束。
  let admPaths = null   // { prov:[{lo,hi,ops}], city:[…] }（换平面 / 换数据 / 换视角时作废）
  // d3 的输出录成 [op, x, y] 三元组流：0=moveTo 1=lineTo 2=closePath
  function recOps() {
    const ops = []
    let bad = false
    return { ops, isBad: () => bad, moveTo(x, y) { ops.push(0, x, y) }, lineTo(x, y) { ops.push(1, x, y) }, closePath() { ops.push(2, 0, 0) }, arc() { bad = true } }
  }
  function bakeAdmOne(list) {
    const out = []
    for (const ring of (list || [])) {
      if (!ring || ring.length < 2) continue
      const co = new Array(ring.length)
      for (let i = 0; i < ring.length; i++) { const a = ring[i]; co[i] = Array.isArray(a) ? [a[0], a[1]] : [a.lon, a.lat] }
      const r = recOps()
      PJ.path({ type: 'LineString', coordinates: co }, r)
      if (r.isBad()) return null            // 录不下来（理论上 LineString 不会）：整份作废，回退现算
      if (!r.ops.length) continue
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < r.ops.length; i += 3) { if (r.ops[i] === 2) continue; const x = r.ops[i + 1]; if (x < lo) lo = x; if (x > hi) hi = x }
      out.push({ lo, hi, ops: Float64Array.from(r.ops) })
    }
    return out
  }
  function bakeAdm() {
    admPaths = { prov: prov ? bakeAdmOne(prov.borders) : [], city: city ? bakeAdmOne(city.borders) : [] }
    return admPaths
  }
  // 回放一层。返回 false ＝ 这一层烘不出来，调用方按老路现画。
  function drawAdmBaked(which, color, width) {
    const list = (admPaths || bakeAdm())[which]
    if (!list) { admPaths = null; return false }
    if (!list.length) return true
    const kk = k()
    // 视口裁剪（老路没有，纯是省掉画不到的那些）：留出线宽一圈余量，边上那条不会被切掉
    const m = (width + 2) / kk
    const wl = -tx / kk - m, wr = (cw - tx) / kk + m
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    for (const sh of list) {
      if (sh.hi < wl || sh.lo > wr) continue
      const o = sh.ops
      ctx.beginPath()
      for (let i = 0; i < o.length; i += 3) {
        const c = o[i]
        if (c === 0) ctx.moveTo(o[i + 1] * kk + tx, o[i + 2] * kk + ty)
        else if (c === 1) ctx.lineTo(o[i + 1] * kk + tx, o[i + 2] * kk + ty)
        else ctx.closePath()
      }
      ctx.stroke()
    }
    return true
  }
  // ★ 原先这里有一个「南极极冠」：把 −82° 以南整条横带无条件涂成陆地色，用来补老底图（world-atlas）
  //   在极点处留下的圆形空洞。换成主权解算层之后，南极大陆的环三档都自己走到了 −90°（10m 有 724 个
  //   lat=−90 的点），空洞早就没有了 —— 那条横带只剩下副作用：把深入到 −85° 的罗斯海、威德尔海
  //   整片糊成陆地，海陆边界被切成一条横贯全图的直线，冰架前缘的海岸线孤零零浮在陆地色上。
  //   3D 球体那边早已改用 antarcticaFillRings 收口（见 globe3d/scene.js），这里是漏网的另一半，删掉即可。
  //   北极岛屿由 buildBaseGeo 按「多边形整块」染冰白（与 3D 同口径），不需要极冠。
  //   2026-09-05 补：「三档都自己走到 −90°」只对 10m / 50m 成立，110m 的主环止于 −84.71° ——
  //   故 buildBaseGeo 已改成三档一律走 antarcticaFillRings，与 3D 同源。
  // 卫星图标（矢量复刻聚焦卫星 SVG：双侧 3×2 太阳能板 + 中央星体）。按 color 填充、size 缩放。
  // 仰角线卫星与聚焦卫星共用此函数 —— 平面图上卫星统一为同一枚图标，颜色随各自设置。
  const SAT_BLOCKS = [[8, 41], [21, 41], [34, 41], [8, 63], [21, 63], [34, 63], [76, 41], [89, 41], [102, 41], [76, 63], [89, 63], [102, 63]]
  function drawSatIcon(lon, lat, size, color) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
    const x = PX(lon, lat), y = PY(lat, lon), s = size || sizes.satIcon || 30
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
  // 经纬网。等距圆柱下经线纬线都是直线，直接在屏幕坐标画两族直线（最省）；
  // 投影档下它们是曲线，改用 d3 的 geoGraticule 烘一条平面 Path2D，缓存在 gridPath 里
  // （只随投影 / 切口 / 步长变，不随 pan/zoom 变），画时走与边界线同一套 setTransform + 线宽除 kk。
  let gridPath = null, gridKey = ''
  function drawGrid() {
    if (borderStyle.gridOn === false) return
    const kk = k(), x0 = tx, x1 = tx + PJ.W * kk
    const step = borderStyle.gridStep > 0 ? borderStyle.gridStep : 15
    ctx.save()
    ctx.strokeStyle = borderStyle.gridColor; ctx.globalAlpha = borderStyle.gridOpacity
    const px = DASH_PX[borderStyle.gridDash || 'solid']
    if (!PJ.identity) {
      const key = planeKey() + '/' + step
      if (!gridPath || gridKey !== key) { gridPath = PJ.path(PJ.graticule(step)(), new Path2D()); gridKey = key }
      ctx.lineWidth = borderStyle.gridWidth / kk
      ctx.setLineDash(px ? px.map((v) => v / kk) : [])
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
      if (compat) { /* 矢量导出：svgcanvas 的 stroke() 不认 Path2D 入参，改逐点回放 */
        ctx.beginPath()
        PJ.path(PJ.graticule(step)(), ctx)
        ctx.stroke()
      } else ctx.stroke(gridPath)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.restore()
      return
    }
    ctx.lineWidth = borderStyle.gridWidth
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
  // ★ 跨接缝的那一段在缝上插值断开，不是整段丢掉。旧写法一到 |Δwx| > 180 就 stroke + beginPath，
  //   两端都不画到边，留一个与那一段等宽的缺口 —— 聚焦星覆盖圈 72 点、 5° 一段就缺 5°，
  //   航迹稀疏航点能缺几十度，改了画面中心后跨缝的省界/岛链/等仰角线同理。
  //   算式在 geo/lineGeom.js 的 seamCrossing（纯函数、不分配：静态层每次重建要走 CHN adm2 的 4.5 万段）。
  //   3D 没有接缝，不受影响。
  function drawPolyline(p, color, width, closed, dash) {
    const kk = k()
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    if (dash) ctx.setLineDash(dash)
    if (!PJ.identity) { drawPolylineProj(p); if (dash) ctx.setLineDash([]); return }
    ctx.beginPath(); let started = false, pwx = 0, pwy = 0
    for (let i = 0; i < p.length; i++) {
      const a = p[i], lon = Array.isArray(a) ? a[0] : a.lon, lat = Array.isArray(a) ? a[1] : a.lat
      const wx = WXN(lon), wy = 90 - lat, x = wx * kk + tx, y = wy * kk + ty
      if (started && Math.abs(wx - pwx) > 180) {
        const c = seamCrossing(pwx, pwy, wx, wy)
        ctx.lineTo(c.xOut * kk + tx, c.y * kk + ty)
        ctx.stroke(); ctx.beginPath()
        ctx.moveTo(c.xIn * kk + tx, c.y * kk + ty)
        ctx.lineTo(x, y)
      } else started ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
      started = true; pwx = wx; pwy = wy
    }
    ctx.stroke()
    if (dash) ctx.setLineDash([])
  }
  // 投影档的折线：交给 d3 —— 它按投影曲率自适应加密（省界那种沿纬线的长段在
  // Robinson / Equal Earth 下是曲线，直连会切角），并在日界线上把折线切成两段。
  // ★ 走的是【屏幕坐标】：d3 出的是平面坐标，这里套一层适配把它折到屏幕，
  //   与等距圆柱那条一样，线宽/虚线周期就都还是屏幕像素、不用除 kk。
  const _plAdapt = {
    moveTo(x, y) { ctx.moveTo(x * _plK + _plTx, y * _plK + _plTy) },
    lineTo(x, y) { ctx.lineTo(x * _plK + _plTx, y * _plK + _plTy) },
    closePath() { ctx.closePath() },
    arc() {}
  }
  let _plK = 1, _plTx = 0, _plTy = 0
  function drawPolylineProj(p) {
    const co = new Array(p.length)
    for (let i = 0; i < p.length; i++) { const a = p[i]; co[i] = Array.isArray(a) ? [a[0], a[1]] : [a.lon, a.lat] }
    _plK = k(); _plTx = tx; _plTy = ty
    ctx.beginPath()
    PJ.path({ type: 'LineString', coordinates: co }, _plAdapt)
    ctx.stroke()
  }
  // 投影档的环填充（卫星层足迹 / 聚焦星足迹）。绕极的环由 d3 自己补极点 ——
  // 等距圆柱那条要手工判「解缠后首尾差满一圈」再补两枚极点顶点，投影档不需要。
  function fillRingProj(ring, fill, alpha) {
    if (!ring || ring.length < 3) return
    const co = new Array(ring.length + 1)
    for (let i = 0; i < ring.length; i++) { const a = ring[i]; co[i] = Array.isArray(a) ? [a[0], a[1]] : [a.lon, a.lat] }
    co[ring.length] = co[0]
    _plK = k(); _plTx = tx; _plTy = ty
    ctx.fillStyle = fill; ctx.globalAlpha = alpha
    ctx.beginPath()
    PJ.path(asPoly([co]), _plAdapt)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  function drawText(text, lon, lat, px, color, opt) {
    const o = opt || {}
    // o.sx / o.sy：直接给屏幕坐标当锚点（城市标签贴框边那种，锚点不是某个经纬度而是框的屏幕包围盒）
    const x = (o.sx != null ? o.sx : PX(lon, lat)) + (o.dx || 0), y = (o.sy != null ? o.sy : PY(lat, lon)) + (o.dy || 0)
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
      // 屏幕偏移（单位 em，见 admPacks.mergePacks）：落点与碰撞盒一起平移；随字号走、不随缩放走
      const ox = (l.dx || 0) * fs, oy = (l.dy || 0) * fs
      const x = PX(l.lon, l.lat) + ox, y = PY(l.lat, l.lon) + oy
      if (x < -160 || x > cw + 160 || y < -40 || y > ch + 40) continue
      const name = nameOf(l)
      if (!name) continue
      arr.push({ l, name, fs, x, y, ox, oy, hw: (textW(name, fs) / 2) * LB_OVX + LB_PADX, hh: fs * LB_HK * LB_OVY + LB_PADY })
    }
    // 排队：先看 rk（NE 的 labelrank，越小越该先标；构建期写进包里），再看 pri（到最近邻的距离）
    arr.sort((a, b) => ((b.l.keep ? 1 : 0) - (a.l.keep ? 1 : 0)) ||
      ((a.l.rk || 12) - (b.l.rk || 12)) || ((b.l.pri || 0) - (a.l.pri || 0)))
    for (const e of arr) {
      // 常显（KEEP_ISO 的国家）：不判碰撞，挤到也画；但照常登记占位，免得别人再压上来
      if (!e.l.keep && !slotFits(slots, e.x - e.hw, e.y - e.hh, e.x + e.hw, e.y + e.hh)) continue
      slotAdd(slots, e.x - e.hw, e.y - e.hh, e.x + e.hw, e.y + e.hh)
      drawText(e.name, e.l.lon, e.l.lat, e.fs, color, (e.ox || e.oy) ? { ...opt, dx: ((opt && opt.dx) || 0) + e.ox, dy: ((opt && opt.dy) || 0) + e.oy } : opt)
    }
  }
  function dot(lon, lat, r, fill, ring) {
    const x = PX(lon, lat), y = PY(lat, lon)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill()
    if (ring) { ctx.lineWidth = Math.max(1, r * 0.35); ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.stroke() }
  }
  // 峰值点标记：细十字（对齐 SATSOFT §11.1 Contour Dialog 的 Beam Peak Label「+」；3D 侧 makeCovCross 同款）。
  // 叉心＝那个点，两条细臂不遮挡下面的等值线/填充。span = 十字全长(px)。
  // ★ 线宽【恒定屏幕像素】，不随 span 走：按比例给线宽的话，放大几档笔画就跟着变粗，十字成了一个又粗又笨
  //   的实心加号（SATSOFT 的十字自始至终是一根细线）。与等值线同档线宽，故也不需要深色套边——等值线自己也没有。
  const CROSS_W = 1.3            // 十字线宽（屏幕 px），与 3D 侧 scene.js 的 CROSS_W 同值
  function cross(lon, lat, span, color) {
    const x = PX(lon, lat), y = PY(lat, lon), a = span * 0.5
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.lineWidth = CROSS_W; ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x - a, y); ctx.lineTo(x + a, y); ctx.moveTo(x, y - a); ctx.lineTo(x, y + a)
    ctx.stroke()
    ctx.restore()
  }

  // 星下点标记 —— 照 SATSOFT：一个圆，一条十字穿过圆心并从两侧探出去一小截，此外什么都没有。
  // ★ 不印名字：SATSOFT 那个准星就是光秃秃一个记号（谁的星下点由面板上写着）。图上多一行字，
  //   缩放到密集处就成了糊在一起的一片。
  // ★ 十字要【穿过】圆心：断开的那两版（⊕ 断臂、CSGO 的中心间隙）中心是空的，读不出确切位置；
  //   穿过去之后交点自己就是那个点。
  // ★ 尺寸走屏幕像素恒定 —— 它是个记号不是地物，跟着缩放放大只会挡图。
  // 诚实边界：SATSOFT 的图是浅底（浅蓝海），它那枚准星是【深色】的；本平台的 2D 可暗（影像）
  //   可亮（矢量底图），故这里画白线 + 一道半透明黑描边，两种底图上都看得见。形状与比例照抄。
  let subPt = null            // { lon, lat, name }（name 只留在数据里，不画）
  const XH_R = 6.5            // 圆半径（屏幕 px）
  const XH_ARM = 11           // 十字半臂：比半径长出来的那截就是探出圆外的部分
  function drawSubPoint() {
    if (!subPt || !Number.isFinite(subPt.lon) || !Number.isFinite(subPt.lat)) return
    const x0 = PX(subPt.lon, subPt.lat), y0 = PY(subPt.lat, subPt.lon)
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return        // 投影档下越出图幅的点没有平面坐标
    // 钉到半像素栅格：1 px 的线压在整数坐标上会被抗锯齿摊成两行灰的，糊掉一半
    const x = Math.round(x0) + 0.5, y = Math.round(y0) + 0.5
    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineCap = 'butt'
    const paint = () => {
      ctx.beginPath()
      ctx.arc(x, y, XH_R, 0, Math.PI * 2)
      ctx.moveTo(x - XH_ARM, y); ctx.lineTo(x + XH_ARM, y)
      ctx.moveTo(x, y - XH_ARM); ctx.lineTo(x, y + XH_ARM)
      ctx.stroke()
    }
    ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; paint()
    ctx.lineWidth = 1; ctx.strokeStyle = '#ffffff'; paint()
    ctx.restore()
  }

  // GRD 分带填充：与 3D 同源——由 bandGeometry 逐三角形切出的各档环带多边形（lon/lat）。每档把全部多边形
  // 烘成一个「世界度坐标」Path2D（x=lon-LON0, y=90-lat，仅在 setField 时一次），同档多边形并入一条 path
  // 一次 fill → 相邻三角形无 AA 缝隙。draw() 随 pan/zoom 只用 setTransform 平移缩放矢量填充（清晰、分辨率无关），
  // 并在 -360/0/+360 三档经度环绕各填一份 → 跨东经180° 无缝。地平/接缝裁剪已在 bandGeometry 内完成。
  // 一层覆盖在「世界 X」(=lon-LON0) 上的经度跨度，供 drawField 的 ±360 环绕做视口裁剪（只填可见副本）。
  function layerBounds(L) {
    let lo = Infinity, hi = -Infinity
    // GPU 路：经度跨度在建索引时顺手量的（只算真被引用到的顶点），O(1) 直接换算成世界 X。
    // 投影档没有横向周期（wraps() 只有 0 一档），用不上这个裁剪 → 返回 null（恒画）。
    if (L.fieldMesh) {
      if (!PJ.identity) return null
      const x = L._glExt
      return (x && Number.isFinite(x.lonLo)) ? { lo: x.lonLo - LON0, hi: x.lonHi - LON0 } : null
    }
    // 投影档下平面 x 不再是 lon−LON0（非圆柱投影里 x 还随纬度变），故按真投影量；
    // 等距圆柱仍走原式子（同一个结果，但省掉一次函数调用 × 几十万点）。
    const upd = PJ.identity
      ? (lon) => { const x = lon - LON0; if (x < lo) lo = x; if (x > hi) hi = x }
      : (lon, lat) => { const x = PJ.fwd(lon, lat, _pw)[0]; if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x } }
    if (L.fillBands) for (const fb of L.fillBands) { const v = fb.verts; for (let i = 0; i < v.length; i += 2) upd(v[i], v[i + 1]) }
    if (L.segGroups) for (const grp of L.segGroups) for (const sg of (grp.segs || [])) { upd(sg[0][0], sg[0][1]); upd(sg[1][0], sg[1][1]) }
    if (lo > hi) return null
    return { lo, hi }
  }
  // 一层进来时的加工：CPU 路烘 Path2D，GPU 路上传网格缓冲（两者互斥，由几何层按 fieldBackend() 二选一送）。
  // ★ 上传只在这里发生 —— 平移/缩放/改 LON0/改透明度一律不碰缓冲（见 drawFieldGL 只改 uniform）。
  // 投影档的顶点位置：CPU 用 PJ.fwd 把网格【真正用到的那些格点】预投成世界平面坐标。
  // ★ 只投三角化引用到的行列（meshLattice）：stride=2/4 时点数直接降到 1/4 / 1/16，
  //   其余槽位留着不填 —— 索引根本不会引用到它们。
  // ★ 等距圆柱不走这里：那一档平面坐标是经纬的仿射，在着色器里现算，LON0 才能留在 uniform 里
  //   （「拖着转」每帧改一个数就行，不必重传缓冲）。
  function projectMeshPlane(m) {
    const { rows, cols, rA, rB } = meshLattice(m)
    if (!rows.length || !cols.length) return null
    const NX = m.NX, len = (rB - rA + 1) * NX
    const xy = new Float32Array(len * 2)
    xy.fill(NaN)
    const lat = m.lat, lon = m.lonU
    for (const r of rows) {
      const rb = r * NX, ob = (r - rA) * NX
      for (const c of cols) {
        const q = rb + c, o = (ob + c) * 2
        const p = PJ.fwd(lon[q], lat[q], _pw)
        xy[o] = p[0]; xy[o + 1] = p[1]
      }
    }
    return { xy, W: PJ.W, H: PJ.H, key: planeKey() }
  }
  function makeFieldEntry(L, i) {
    const entry = {
      ...L,
      fillPaths: L.fillBands ? buildFillPaths(L.fillBands) : null,
      // 等值线的 Path2D 改成【按需】烘（segPathsOf）：屏上走 GPU 路时根本用不到它，
      // 55 档 11 万段烘一遍是几十毫秒；只有 GPU 不可用那一帧才补烘一次
      segPaths: null,
      bounds: null,
      _glKey: null, _glExt: null, _glPlaneKey: null,
      _lnKey: null, _lnMeta: null, _lnPlaneKey: null
    }
    if (L.fieldMesh) {
      const g = glField()
      const key = L.id != null ? L.id : '#' + i
      const plane = PJ.identity ? null : projectMeshPlane(L.fieldMesh)
      const ext = (g && (PJ.identity || plane)) ? g.upload(key, L.fieldMesh, plane) : null
      // ★ 等距圆柱记 null 而不是 planeKey()：那一档的位置在着色器里现算，换切口 / 拖着转
      //   只该改一个 uniform —— 记了键就会在每次 rebuildPlane 上白重传一轮缓冲。
      if (ext) { entry._glKey = key; entry._glExt = ext; entry._glPlaneKey = plane ? planeKey() : null }
    }
    uploadFieldLines(entry, i)
    entry.bounds = layerBounds(entry)
    return entry
  }
  const segPathsOf = (L) => (L.segPaths || (L.segPaths = L.segGroups ? buildSegPaths(L.segGroups) : null))
  // ---- 等值线的 GPU 线集合 ----
  // 一层的各档等值线打成一份实例缓冲（每档一种样式：色 / 宽 / 线型；透明度来自颜色的 alpha）。
  // 等距圆柱喂 (lon, lat)（位置在着色器里现算，换切口不重传）；投影档经 d3 投成平面折线后再打包（换平面重传）。
  function packFieldLines(L) {
    const pk = createLinePacker({ period: PJ.identity ? 360 : 0 })
    for (const grp of (L.segGroups || [])) {
      if (!grp.segs || !grp.segs.length) continue
      const w = grp.width || 1.2, c = parseColor(grp.color || 'rgba(255,255,255,0.9)')
      // 线型花样与 dashOf 同一口径：DASH_PX 按线宽等比放大（屏幕 px）
      pk.style({ rgb: c, alpha: c[3], width: w, dash: DASH_PX[grp.dash] || null, dashScale: Math.max(0.6, w) / 1.2 })
      if (PJ.identity) for (const ch of chainsOf(grp)) pk.polyline(ch, false)
      else packGeoInto(pk, chainsToGeo(grp))
    }
    return pk.finish()
  }
  function uploadFieldLines(L, i) {
    L._lnKey = null; L._lnMeta = null; L._lnPlaneKey = null
    if (!L.segGroups || !L.segGroups.length || !lnOk()) return
    const g = glLines()
    const key = 'f:' + (L.id != null ? L.id : '#' + i)
    const meta = g ? g.upload(key, packFieldLines(L)) : null
    if (meta) { L._lnKey = key; L._lnMeta = meta; L._lnPlaneKey = PJ.identity ? null : planeKey() }
  }
  // 各层的线集合与当前状态对齐：换平面（投影档重投）/ 上下文恢复（重传）/ 样式热路径（重打包）。
  // 等距圆柱下换切口什么都不做 —— LON0 在 uniform 里。
  function syncFieldLines(force) {
    for (let i = 0; i < fieldLayers.length; i++) {
      const L = fieldLayers[i]
      if (!L.segGroups || !L.segGroups.length) continue
      if (!lnOk()) { L._lnKey = null; L._lnMeta = null; continue }
      const want = PJ.identity ? null : planeKey()
      if (!force && L._lnKey != null && L._lnPlaneKey === want) continue
      uploadFieldLines(L, i)
    }
  }
  // 投影档：把 GeoJSON（LineString / MultiLineString）经 d3 投成平面折线（含自适应加密与日界线切分）后打进打包器。
  // 与 drawPolylineProj / buildSegPaths 的投影档分支走的是同一个 PJ.path，出来的折线逐点相同。
  let _capPk = null
  const _capAdapt = {
    moveTo(x, y) { _capPk.moveTo(x, y) },
    lineTo(x, y) { _capPk.lineTo(x, y) },
    closePath() { _capPk.closePath() },
    arc() {}
  }
  function packGeoInto(pk, geo) { _capPk = pk; PJ.path(geo, _capAdapt); pk.end(); _capPk = null }
  // 数据线集合：波束线（geom.lines）→ 仰角线（satLayer 非 under 的线）→ 逐颗聚焦星的覆盖圈 / 轨迹（轨迹面时描扫过区域的轮廓），
  // 与 drawDataLines 的 Canvas2D 路同序同样式；实例按透明度分桶（见 glLines.js 文件头）。
  function packDataLines() {
    const pk = createLinePacker({ period: PJ.identity ? 360 : 0 })
    const put = (pts, closed) => { if (PJ.identity) pk.polyline(pts, closed); else packGeoInto(pk, { type: 'LineString', coordinates: pts.map((a) => (Array.isArray(a) ? [a[0], a[1]] : [a.lon, a.lat])) }) }
    if (geom) for (const ln of (geom.lines || [])) if (ln.p && ln.p.length > 1) { const c = parseColor(hex(ln.color)); pk.style({ rgb: c, alpha: c[3], width: Math.max(0.1, ln.width || 1.6), dash: null }); put(ln.p, false) }
    if (satLayer) for (const ln of (satLayer.lines || [])) if (!ln.under && ln.p && ln.p.length > 1) { const c = parseColor(hex(ln.color != null ? ln.color : 0x66ddff)); pk.style({ rgb: c, alpha: c[3], width: Math.max(0.1, ln.width || 1.4), dash: null }); put(ln.p, false) }
    const fpC = parseColor(focusCfg.fpColor), trC = parseColor(focusCfg.trkColor)
    const fpSt = { rgb: fpC, alpha: fpC[3] * Math.max(0, Math.min(1, focusCfg.fpOpacity)), width: Math.max(0.1, focusCfg.fpWidth), dash: DASH_2D[focusCfg.fpDash] || null }
    const trSt = { rgb: trC, alpha: trC[3] * Math.max(0, Math.min(1, focusCfg.trkOpacity)), width: Math.max(0.1, focusCfg.trkWidth), dash: DASH_2D[focusCfg.trkDash] || null }
    for (const g of selGeomList) {
      if (focusCfg.fpOn && g.footprint && g.footprint.length > 1) { pk.style(fpSt); put(g.footprint, false) }
      if (focusCfg.trkOn && g.track && g.track.length > 1) {
        pk.style(trSt)
        if (focusCfg.trkMode === 'swath' && g.swath) {
          if (g.swLines) for (const pl of g.swLines) if (pl && pl.length > 1) put(pl, false)
        } else put(g.track, false)
      }
    }
    return pk.finish()
  }
  // 画若干线集合：跨集合按趟透明度归并 —— 同透明度的所有实例画进同一张 GL 画布、按该透明度贴回一次
  // （每像素只混合一次，与 Canvas2D 一条 Path2D 一次 stroke 同口径）。items=[{ id, meta }]；alphaMul=层级透明度。
  // 等距圆柱按集合的经度跨度裁掉整份不可见的环绕副本。返回 false = GL 当场不可用（调用方退回 Canvas2D）。
  function drawGlLineSets(items, alphaMul) {
    const g = glLines()
    if (!g || !glf) return false
    const kk = k(), wl = -tx / kk, wr = (cw - tx) / kk
    const byA = new Map()
    for (const it of items) for (const p of (it.meta.passes || [])) { let arr = byA.get(p.alpha); if (!arr) byA.set(p.alpha, arr = []); arr.push({ id: it.id, pass: p, meta: it.meta }) }
    if (!byA.size) return true
    // 贴回的范围：世界矩形 ∩ 画布（设备 px）—— 线可能铺满整个地图，不逐集合算包围盒
    const _wr = worldRect()
    const sx = Math.max(0, Math.floor(_wr.x * dpr) - 1), sy = Math.max(0, Math.floor(_wr.y * dpr) - 1)
    const ex = Math.min(canvas.width, Math.ceil((_wr.x + _wr.w) * dpr) + 1), ey = Math.min(canvas.height, Math.ceil((_wr.y + _wr.h) * dpr) + 1)
    if (ex <= sx || ey <= sy) return true
    const u = { w: canvas.width, h: canvas.height, dpr, k: kk, tx, ty, lon0: LON0, proj: !PJ.identity }
    const sa = ctx.globalAlpha
    const _t0 = performance.now()
    let nInst = 0
    for (const it of items) nInst += it.meta.n || 0
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0)
    let ok = true
    for (const [alpha, list] of byA) {
      glf.clear()
      if (!g.begin(u)) { ok = false; break }
      let any = false
      for (const it of list) {
        // 等距圆柱：经度跨度窄（< 180°）的集合按「取模后的世界 X 区间」裁掉整份不在视口里的（三个可能落点都不沾视口）；
        // 跨度宽的集合直接画 —— 副本由着色器按实例决定（见 glLines.js VERT_SRC）
        if (PJ.identity && Number.isFinite(it.meta.xMin) && it.meta.xMax - it.meta.xMin < 180) {
          let a = it.meta.xMin - LON0; a -= 360 * Math.floor(a / 360)
          const b = a + (it.meta.xMax - it.meta.xMin)
          if ((b < wl || a > wr) && (b - 360 < wl || a - 360 > wr) && (b + 360 < wl || a + 360 > wr)) continue
        }
        if (g.draw(it.id, it.pass)) any = true
      }
      g.end()
      if (any) { ctx.globalAlpha = sa * alphaMul * alpha; ctx.drawImage(glf.canvas(), sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy) }
    }
    glf.clear()   // 填充路（drawFieldGL）不自己清画布：留一张干净的给它
    ctx.restore()
    // 开发期计数器（手测时在控制台读）：最近一次线合成的毫秒数 / 趟数 / 实例数。与 __fillStat 同款。
    globalThis.__lineStat = { ms: +(performance.now() - _t0).toFixed(2), passes: byA.size, sets: items.length, instances: nInst }
    return ok
  }
  // 换平面（换投影档 / 换切口 / 改中心纬度或标准纬线）后重投影各 GPU 层。
  // 等距圆柱只需重算 bounds —— 位置在着色器里按新的 LON0 现算。
  function reprojectGlLayers() {
    if (!glf) return
    for (const L of fieldLayers) {
      if (!L.fieldMesh || L._glKey == null) continue
      if (PJ.identity) { if (L._glPlaneKey !== null) { const e = glf.upload(L._glKey, L.fieldMesh, null); if (e) L._glExt = e } L._glPlaneKey = null; continue }
      if (L._glPlaneKey === planeKey()) continue
      const plane = projectMeshPlane(L.fieldMesh)
      const e = plane ? glf.upload(L._glKey, L.fieldMesh, plane) : null
      if (e) { L._glExt = e; L._glPlaneKey = planeKey() } else { L._glKey = null; L._glExt = null }
    }
  }
  // 扁平缓冲(verts/counts) → GeoJSON MultiPolygon（投影档把分带填充交给 d3 切割）
  function bandsToGeo(fb) {
    const verts = fb.verts, counts = fb.counts, polys = []
    let vi = 0
    for (let j = 0; j < counts.length; j++) {
      const plen = counts[j], ring = new Array(plen + 1)
      for (let q = 0; q < plen; q++) ring[q] = [verts[(vi + q) * 2], verts[(vi + q) * 2 + 1]]
      ring[plen] = ring[0]                     // GeoJSON 的环必须闭合，否则 d3 的多边形裁剪判不出内外
      polys.push(orientRings([ring]))
      vi += plen
    }
    return { type: 'MultiPolygon', coordinates: polys }
  }
  // 一档的线段 → 连通链（stitchLoops，端点量化匹配），缓存在组对象上：烘 Path2D / 导出回放 / 投影档切割三处共用一份。
  // ★ 每链一个子路径，不再每段一个：55 档的单波束有 11 万条线段，每段一个两点子路径 × 两个圆帽是慢路描边的大头
  //   （设备线宽 ≥ 1 px 时 Skia 走完整描边器，实测 130～170 ms/帧；拼成几百条折线后 54～82 ms）。
  //   圆角接头与逐段圆帽的并集是同一个形状，画面不变；线宽 < 1 设备 px 的 hairline 快路两种烘法都是 10 ms 上下。
  const chainsOf = (grp) => { if (!grp._chains) grp._chains = stitchLoops(grp.segs || []); return grp._chains }
  const chainsToGeo = (grp) => asLines(chainsOf(grp).map((ch) => ch.map((p) => [p[0], p[1]])))
  // 每档线型（SATSOFT Line Style）：花样复用边界线那张表（DASH_PX，屏上 px），按线宽等比放大，
  // 再除以 kk 折回世界坐标 —— 与线宽同款，缩放时屏上疏密不变。
  const dashOf = (style, w, kk) => { const p = DASH_PX[style]; return p ? p.map((x) => x * Math.max(0.6, w) / 1.2 / kk) : null }
  function buildFillPaths(fillBands) {
    if (!PJ.identity) return fillBands.map((fb) => ({
      color: 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')', alpha: (fb.alpha == null ? null : +fb.alpha),
      path: PJ.path(bandsToGeo(fb), new Path2D())
    }))
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
      return { color: 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')', alpha: (fb.alpha == null ? null : +fb.alpha), path }
    })
  }
  // 等值线：与填充同策略——每档一条「世界坐标」Path2D（x=lon-LON0, y=90-lat），仅在 setField/patchField 时烘一次。
  // draw() 随 pan/zoom 只用 setTransform 平移缩放矢量描边（每帧零路径构建），±360 环绕在 drawField 内按视口裁剪。
  // 链上逐点就近解缠（跨 ±180° 不被直线横扫全图）。线宽在描边时 /kk 保持恒定屏幕 px。
  function buildSegPaths(segGroups) {
    if (!PJ.identity) return segGroups.map((grp) => ({
      color: grp.color || 'rgba(255,255,255,0.9)', width: grp.width || 1.2, dash: grp.dash || null,
      path: PJ.path(chainsToGeo(grp), new Path2D())
    }))
    return segGroups.map((grp) => {
      const path = new Path2D()
      for (const ch of chainsOf(grp)) {
        let prev = ch[0][0]
        path.moveTo(prev - LON0, 90 - ch[0][1])
        for (let i = 1; i < ch.length; i++) {
          let lo = ch[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360
          path.lineTo(lo - LON0, 90 - ch[i][1]); prev = lo
        }
      }
      return { color: grp.color || 'rgba(255,255,255,0.9)', width: grp.width || 1.2, dash: grp.dash || null, path }
    })
  }

  // 导出回放：把一档填充环带 / 一组等值线段描进当前路径（与 buildFillPaths/buildSegPaths 同款就近解缠）。
  function traceFillBand(fb) {
    if (!PJ.identity) { ctx.beginPath(); PJ.path(bandsToGeo(fb), ctx); return }
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
    if (!PJ.identity) { PJ.path(chainsToGeo(grp), ctx); return }
    for (const ch of chainsOf(grp)) {
      let prev = ch[0][0]
      ctx.moveTo(prev - LON0, 90 - ch[0][1])
      for (let i = 1; i < ch.length; i++) { let lo = ch[i][0]; while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360; ctx.lineTo(lo - LON0, 90 - ch[i][1]); prev = lo }
    }
  }

  // 晨昏线（分界线 + 自带的夜区阴影）。世界坐标 x=lon−LON0、y=90−lat，与覆盖层同一套 setTransform + ±360 环绕。
  // 采样起点已在 terminatorFlat 里对齐到 LON0（地图接缝）→ 世界 X 单调 0→360，多边形不会被接缝撕开。
  // 画在 drawEnvRaster 之前（即所有数据层之下、底图之上）：它与晨昏效果一样是「打光」不是「数据」；
  // 国界地名在 aboveCanvas，天然压在其上。
  // 夜区阴影（shadeOpacity > 0 才画）：硬边夜区多边形 —— v1.4.13「夜区遮罩」原样，矢量填充、放多大都是一条利边。
  // 晨昏效果（drawNightShade 的柔和栅格）勾着时页面给 shadeOpacity 0，夜区由它接管，不叠两层。
  function drawTerminator() {
    // 换平面（切口 / 投影）会作废点列（见 rebuildPlane 的 term）：时钟停着没有下一拍来补，这里按存着的时刻就地重算
    if (!termData && termDate) termData = terminatorFlat(termDate, { steps: (termOpts.steps || 1440), lon0: LON0 })
    if (!termData) return
    const kk = k(), wl = -tx / kk, wr = (cw - tx) / kk
    const o = termOpts
    const sh = Number(o.shadeOpacity) > 0 ? Math.min(1, Number(o.shadeOpacity)) : 0
    const lineOn = !(o.lineOpacity <= 0)
    ctx.save()
    for (const off of wraps()) {
      if (off + 360 < wl || off > wr) continue          // 该副本整幅落在视口外
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
      if (sh > 0) {
        ctx.globalAlpha = sh
        ctx.fillStyle = o.shadeColor || '#0a1120'
        ctx.beginPath()
        // 投影档交给 d3 的球面多边形裁剪 —— 它自己判绕不绕极、该不该补极点，
        // 故【不用】平面那套「沿暗极那条边封口」的收口点（那两点的经度超出 ±180，d3 认不得）。
        // 定向靠反日下点：它恒是夜区正中（太阳高度 −90°），据此判要不要把环翻过来（面积判据在这里正好是半球、靠不住）。
        // ★ 不能拿暗极附近的 (0°, ±89°) 当内点（v1.4.13 的写法）：春秋分前后赤纬不到 1°，极夜只剩极点一小圈，
        //   (0°, 89°) 常常落在昼侧 —— 整片阴影就填到白天那半边去了（2026-09-24 秋分后一天实测 Robinson / 方位等距全反）。
        if (!PJ.identity) {
          const ring = termData.line.map((q) => [((q[0] + 180) % 360 + 360) % 360 - 180, q[1]])
          const s = termData.sub
          PJ.path(asPoly([ring.concat([ring[0]])], [((s.lon % 360) + 360) % 360 - 180, -s.lat]), ctx)
        } else {
          const ng = termData.night
          ctx.moveTo(ng[0][0] - LON0, 90 - ng[0][1])
          for (let i = 1; i < ng.length; i++) ctx.lineTo(ng[i][0] - LON0, 90 - ng[i][1])
        }
        ctx.closePath(); ctx.fill()
      }
      if (!lineOn) continue
      ctx.globalAlpha = o.lineOpacity != null ? o.lineOpacity : 0.75
      ctx.strokeStyle = o.lineColor || '#ffd27a'
      ctx.lineWidth = (o.lineWidth || 1.2) / kk       // 除以缩放 → 恒定屏幕像素宽
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      ctx.beginPath()
      const ln = termData.line
      if (!PJ.identity) PJ.path({ type: 'LineString', coordinates: ln.map((q) => [((q[0] + 180) % 360 + 360) % 360 - 180, q[1]]) }, ctx)
      else {
        ctx.moveTo(ln[0][0] - LON0, 90 - ln[0][1])
        for (let i = 1; i < ln.length; i++) ctx.lineTo(ln[i][0] - LON0, 90 - ln[i][1])
      }
      ctx.stroke()
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
  }

  // ---- 晨昏效果：夜区柔和压暗（地图设置 · 宇宙空间）----
  // 与 3D 同一条曲线：按太阳高度角 h 从 0° 到 −18° smoothstep 压暗（terminator.nightRamp），不是硬边多边形。
  // 连续渐变在 Canvas2D 里只能靠栅格：算一张小位图（每像素一次点积）再 drawImage 放大，双线性插值天然平滑 ——
  // 过渡带宽 18°（约 2000 km），0.5°～1° 一格的栅格放大多少倍都看不出格子。逐帧只是一到三次 drawImage。
  //   · 等距圆柱：经纬栅格 720×360（0.5°/格），可分离（行项 sinφ·sinφs、cosφ·cosφs × 列项 cos(λ−λs)），重算约 2 ms；
  //     按 x = lon − LON0 与整幅影像同一套 ±360 副本贴，副本边界 round 到整设备像素 —— 半透明层两副本在小数边上
  //     各盖一半，source-over 叠出来比单层淡，接缝经线上会出一条亮线。
  //   · 投影档：平面栅格（≤ 9 万格）逐格逆算一次、存成【投影旋转系】下的单位矢量 —— 平面 ↔ 旋转系只由投影形状
  //    （档 + 标准纬线）定，与切口 / 中心纬度无关：换切口（跟随星下点）/ 拖中心只把太阳转进旋转系、重填一遍 alpha，
  //     不重做逆投影。画时裁到图廓（Sphere）里，栅格边上那一格的外推值漏不到图廓外。
  // 栅格只在「日下点 / 颜色 / 强度」变了才重填（键比较），时间轴不动时每帧零计算。
  const NIGHT_EQ_W = 720, NIGHT_EQ_H = 360, NIGHT_PJ_BUDGET = 90000
  const _R = Math.PI / 180
  function nightKey(sub) { return sub.lat.toFixed(4) + '/' + sub.lon.toFixed(4) + '/' + nightOpts.color + '/' + nightOpts.opacity }
  function nightCanvas(w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h
    const g = cv.getContext('2d')
    return { cv, g, img: g.createImageData(w, h), key: '' }
  }
  function nightEqRaster() {
    if (!nightEq) {
      nightEq = nightCanvas(NIGHT_EQ_W, NIGHT_EQ_H)
      nightEq.cosLon = new Float64Array(NIGHT_EQ_W)
    }
    const s = nightSub, key = nightKey(s)
    if (nightEq.key === key) return nightEq.cv
    const [cr, cg, cb] = parseColor(nightOpts.color)
    const A = 255 * Math.max(0, Math.min(1, nightOpts.opacity))
    const sps = Math.sin(s.lat * _R), cps = Math.cos(s.lat * _R)
    const cl = nightEq.cosLon, d = nightEq.img.data
    for (let i = 0; i < NIGHT_EQ_W; i++) cl[i] = Math.cos((-180 + (i + 0.5) * 360 / NIGHT_EQ_W - s.lon) * _R)
    let p = 0
    for (let j = 0; j < NIGHT_EQ_H; j++) {
      const lat = (90 - (j + 0.5) * 180 / NIGHT_EQ_H) * _R
      const a = Math.sin(lat) * sps, b = Math.cos(lat) * cps
      for (let i = 0; i < NIGHT_EQ_W; i++, p += 4) {
        d[p] = cr; d[p + 1] = cg; d[p + 2] = cb
        d[p + 3] = Math.round(A * nightRamp(a + b * cl[i]))
      }
    }
    nightEq.g.putImageData(nightEq.img, 0, 0)
    nightEq.key = key
    return nightEq.cv
  }
  function nightPjRaster() {
    const shape = PJ.kind + '/' + (PJ.par ? PJ.par.join(',') : '') + '/' + PJ.W + 'x' + PJ.H.toFixed(6)
    if (!nightPj || nightPj.shape !== shape) {
      const aspect = PJ.H / PJ.W
      const RW = Math.max(64, Math.round(Math.sqrt(NIGHT_PJ_BUDGET / aspect))), RH = Math.max(32, Math.round(RW * aspect))
      const rot = geoRotation(PJ.d3.rotate())
      const dirs = new Float32Array(RW * RH * 3), ok = new Uint8Array(RW * RH)
      const _t0 = performance.now()
      for (let j = 0, k0 = 0; j < RH; j++) {
        const y = (j + 0.5) / RH * PJ.H
        for (let i = 0; i < RW; i++, k0++) {
          const b = PJ.invRaw((i + 0.5) / RW * PJ.W, y)
          if (!b) continue
          const r = rot(b)
          if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue
          const la = r[1] * _R, lo = r[0] * _R, c = Math.cos(la)
          dirs[k0 * 3] = c * Math.cos(lo); dirs[k0 * 3 + 1] = c * Math.sin(lo); dirs[k0 * 3 + 2] = Math.sin(la)
          ok[k0] = 1
        }
      }
      nightPj = { shape, RW, RH, dirs, ok, ...nightCanvas(RW, RH), buildMs: +(performance.now() - _t0).toFixed(1) }
    }
    const P = nightPj
    // 太阳转进投影旋转系（与逐格方向同一个系）：两边一起转，点积不变
    const rs = geoRotation(PJ.d3.rotate())([nightSub.lon, nightSub.lat])
    const key = nightKey({ lat: rs[1], lon: rs[0] })
    if (P.key === key) return P.cv
    const la = rs[1] * _R, lo = rs[0] * _R, c = Math.cos(la)
    const sx = c * Math.cos(lo), sy = c * Math.sin(lo), sz = Math.sin(la)
    const [cr, cg, cb] = parseColor(nightOpts.color)
    const A = 255 * Math.max(0, Math.min(1, nightOpts.opacity))
    const D = P.dirs, d = P.img.data, n = P.RW * P.RH
    for (let q = 0, p = 0; q < n; q++, p += 4) {
      d[p] = cr; d[p + 1] = cg; d[p + 2] = cb
      d[p + 3] = P.ok[q] ? Math.round(A * nightRamp(D[q * 3] * sx + D[q * 3 + 1] * sy + D[q * 3 + 2] * sz)) : 0
    }
    P.g.putImageData(P.img, 0, 0)
    P.key = key
    return P.cv
  }
  function drawNightShade() {
    if (!nightSub || !(nightOpts.opacity > 0)) return
    const kk = k()
    if (!(kk > 0)) return
    ctx.save()
    ctx.imageSmoothingEnabled = true
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    if (PJ.identity) {
      const cv = nightEqRaster()
      const shift = (((-180 - LON0) % 360) + 360) % 360
      const wl = -tx / kk, wr = (cw - tx) / kk
      let n0 = Math.floor((wl - shift) / 360), n1 = Math.floor((wr - shift) / 360)
      if (Number.isFinite(n0) && Number.isFinite(n1)) {
        if (n1 - n0 > 8) n1 = n0 + 8
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        const y0 = Math.round(dpr * ty), y1 = Math.round(dpr * (ty + 180 * kk))
        for (let n = n0; n <= n1; n++) {
          const x0 = Math.round(dpr * (tx + (shift + n * 360) * kk)), x1 = Math.round(dpr * (tx + (shift + (n + 1) * 360) * kk))
          if (x1 > x0 && y1 > y0) ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0)
        }
      }
    } else {
      const cv = nightPjRaster()
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
      traceSphere(ctx); ctx.clip()
      ctx.drawImage(cv, 0, 0, PJ.W, PJ.H)
    }
    ctx.restore()
  }

  // GPU 路的一层：三份环绕副本各画一次 → 按【该层屏上包围盒】合成一次 → 清空 GL 画布给下一层。
  // ★ 必须逐层合成：层与层之间是 fieldAlpha 半透明叠加，一张 GL 画布上把多层画在一起再合成一次，
  //   重叠处的颜色就变了。
  // ★ 只合成包围盒不合成整幅：2× 渲染倍率下整幅是 8 MPix/层，四层就是 33 MPix 的白搬。
  function drawFieldGL(L, kk, wl, wr) {
    const m = L.fieldMesh, key = L._glKey, ex0 = L._glExt
    const proj = !PJ.identity
    if (!m || key == null || !ex0 || (proj && !Number.isFinite(ex0.pxLo)) || !glf.begin(m, proj)) return false
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    let any = false
    for (const off of wraps()) {
      if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
      if (!glf.draw(key, { lon0: LON0, off, k: kk, tx, ty, dpr })) continue
      any = true
      // 包围盒：等距圆柱按经纬折算世界坐标；投影档直接用预投出来的平面跨度
      const wx0 = proj ? ex0.pxLo : (ex0.lonLo - LON0 + off), wx1 = proj ? ex0.pxHi : (ex0.lonHi - LON0 + off)
      const wy0 = proj ? ex0.pyLo : (90 - ex0.latHi), wy1 = proj ? ex0.pyHi : (90 - ex0.latLo)
      const x0 = wx0 * kk + tx, x1 = wx1 * kk + tx
      const y0 = wy0 * kk + ty, y1 = wy1 * kk + ty
      if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1
      if (y0 < by0) by0 = y0; if (y1 > by1) by1 = y1
    }
    if (!any) return false
    const cwPx = canvas.width, chPx = canvas.height
    const sx = Math.max(0, Math.floor(bx0 * dpr) - 1), sy = Math.max(0, Math.floor(by0 * dpr) - 1)
    const ex = Math.min(cwPx, Math.ceil(bx1 * dpr) + 1), ey = Math.min(chPx, Math.ceil(by1 * dpr) + 1)
    if (ex > sx && ey > sy) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(glf.canvas(), sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy)
    }
    glf.clear()
    return true
  }

  function drawField() {
    if (rotLive) return          // 转动进行中：填充与等值线还烘在上一张平面上，画出来就是错位的
    const kk = k()
    // 填充：把 pan/zoom 烘进变换矩阵，直接填充缓存的世界坐标 Path2D（每帧零顶点遍历），-360/0/+360 三档环绕。
    // 环绕副本按视口裁剪：放大到某区域时三份里通常只有一份可见 → 大足迹填充成本直降到 1/3（拖拽开填充提速核心）。
    const wl = -tx / kk, wr = (cw - tx) / kk
    // GPU 路（等距圆柱 + 屏上）：每帧只改 uniform，不碰任何几何。见 drawFieldGL / glField.js。
    // ★ 先看有没有网格层再问 glField()：后者会【懒创建】WebGL2 上下文，没网格时白建一个
    const glOn = !compat && !exporting && fieldLayers.some((L) => L.fieldMesh) && !!glField()
    const _t0 = performance.now()
    let nGl = 0
    ctx.save(); ctx.globalAlpha = fieldAlpha
    for (const L of fieldLayers) {
      if (glOn && L.fieldMesh) { if (drawFieldGL(L, kk, wl, wr)) nGl++; continue }
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of wraps()) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const fb of (L.fillBands || [])) { ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.fillStyle = fb.color; ctx.fill(fb.path) }
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1; ctx.restore()
    // 开发期计数器（手测时在控制台读）：最近一帧的填充合成毫秒数 + 后端名。与 __bakeStat 同款。
    if (fieldLayers.length) globalThis.__fillStat = { backend: glOn ? 'gl' : (compat ? 'paths(compat)' : 'paths'), ms: +(performance.now() - _t0).toFixed(2), layers: fieldLayers.length, glLayers: nGl }
    // 逐档等值线（多层，每层每档一色）：复用缓存的世界坐标 Path2D，setTransform 平移缩放矢量描边（每帧零构建），
    // ±360 环绕按视口裁剪只描可见副本（与填充同策略）。线宽 /kk 保持恒定屏幕 px。
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.save(); ctx.globalAlpha = fieldLineAlpha
    // GPU 路：上过线集合的层一次合成（每帧只改 uniform，不碰几何）；其余层（GPU 不可用 / 导出）描 Path2D
    const glItems = [], cpuLayers = []
    const useGl = lnOk()
    for (const L of fieldLayers) {
      if (!L.segGroups || !L.segGroups.length) continue
      if (useGl && L._lnKey != null && L._lnMeta) glItems.push({ id: L._lnKey, meta: L._lnMeta, L }); else cpuLayers.push(L)
    }
    if (glItems.length && !drawGlLineSets(glItems, fieldLineAlpha)) for (const it of glItems) cpuLayers.push(it.L)
    for (const L of cpuLayers) {
      const paths = compat ? null : segPathsOf(L)
      if (!compat && (!paths || !paths.length)) continue
      for (const off of wraps()) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        if (compat) for (const grp of (L.segGroups || [])) { if (!grp.segs || !grp.segs.length) continue; ctx.strokeStyle = grp.color || 'rgba(255,255,255,0.9)'; ctx.lineWidth = (grp.width || 1.2) / kk; const d = dashOf(grp.dash, grp.width || 1.2, kk); ctx.setLineDash(d || []); traceSegGroup(grp); ctx.stroke() }
        else for (const sp of paths) { ctx.strokeStyle = sp.color; ctx.lineWidth = sp.width / kk; const d = dashOf(sp.dash, sp.width, kk); ctx.setLineDash(d || []); ctx.stroke(sp.path) }
        ctx.setLineDash([])
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
    if (!PJ.identity) {
      const img = envImageForDraw()
      blitReprojected(reprojectRaster(img, envBBox, envSmooth), img === envImg ? envAlpha : 1, 1, envSmooth)
      return
    }
    const kk = k(), bb = envBBox
    const x0 = WXN(bb.lonMin), w = (bb.lonMax - bb.lonMin) * kk
    const y = PY(bb.latMax), h = (bb.latMax - bb.latMin) * kk
    const img = envImageForDraw()
    ctx.save(); ctx.globalAlpha = img === envImg ? envAlpha : 1
    // 分级填色要看得见硬边界（那条边界就是等值线），故插值开关跟着显示模式走
    const sm = ctx.imageSmoothingEnabled
    ctx.imageSmoothingEnabled = envSmooth
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high'
    for (const off of wraps()) {
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
      for (const an of (g.labels || [])) drawText(g.text, an.lon, an.lat, Math.max(7, 11 * (k() / 13.1)), g.labelColor || '#ffffff', { rot: an.a, strokeScale: CASE_K * 1.15, bold: !!g.bold })
    }
  }
  function drawCovGrid() {
    if (!covGridLayers.length) return
    const kk = k()
    const wl = -tx / kk, wr = (cw - tx) / kk
    ctx.save(); ctx.globalAlpha = covGridAlpha
    for (const L of covGridLayers) {
      if (!L.fillPaths || !L.fillPaths.length) continue
      for (const off of wraps()) {
        if (L.bounds && (L.bounds.hi + off < wl || L.bounds.lo + off > wr)) continue
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * (tx + off * kk), dpr * ty)
        // 逐档填充透明度（缺省 null = 跟整层 fieldAlpha）：SATSOFT 把透明度也放在 Contour Levels 每一档里
        if (compat) for (const fb of (L.fillBands || [])) { ctx.globalAlpha = fieldAlpha * (fb.alpha == null ? 1 : fb.alpha); ctx.fillStyle = 'rgb(' + fb.color[0] + ',' + fb.color[1] + ',' + fb.color[2] + ')'; traceFillBand(fb); ctx.fill() }
        else for (const fb of L.fillPaths) { ctx.globalAlpha = fieldAlpha * (fb.alpha == null ? 1 : fb.alpha); ctx.fillStyle = fb.color; ctx.fill(fb.path) }
        ctx.globalAlpha = fieldAlpha
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
      const bold = !!o.fontBold   // 三类标签共用的字重（SATSOFT Font Weight）
      if (o.showVal) for (const grp of (L.segGroups || [])) { if (grp.txt == null) continue; for (const an of (grp.labels || [])) drawText(String(grp.txt), an[0], an[1], covFont(o.valSize || 12), o.valColor || '#ffffff', { bold }) }
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
      if (peakOn) drawText(b.peak.toFixed(2), b.lon, b.lat, pf, o.peakColor || '#cfd6df', { dy: -(lift + pf * 0.5), bold })
      if (named) drawText(L.name, b.lon, b.lat, nf, o.nameColor || '#ffffff', { dy: -(lift + (peakOn ? pf * 1.15 : 0) + nf * 0.5), bold })
    }
  }

  // field 之下的底图（海陆/冰盖/网格）。渲到主画布后由 renderStaticLayers 拷到 belowCanvas。
  function drawBelowContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // ★ 实时影像（瓦片档、屏上）：影像不进快照，每帧画在快照【之下】（见 draw 的 drawImageryLive）。
    //   快照里世界（图廓内）留成透明让它透上来；图廓之外仍是底色。缩放 / 拖动期间影像于是永远是
    //   当前视角的真投影、当前级的瓦片，不再跟着位图一起糊、一起缩成一小块。
    if (imgLiveNow()) {
      if (PJ.identity) ctx.clearRect(rx, ry, rw, rh)
      else {
        const kk = k(); ctx.save()
        ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
        traceSphere(ctx); ctx.clip()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(rx, ry, rw, rh)
        ctx.restore()
      }
      ctx.restore()
      return
    }
    // 影像模式：整幅影像顶替海色 + 陆地填充。
    // 导出时两条路都画：PNG（raster:true，真 canvas）逐片画；矢量 PDF 画 bakeImagery 预合成的那一张
    // （vecImg）—— 逐片塞进 SVG 才是不可用的那种，整层一张不是。
    // drawImagery 返回 false ＝ 这一帧一片都没取到（瓦片档但离线包缺失/还没到货）→ 回退矢量底图。
    // 判据放在「画完之后」而不是「画之前探测」：探测要么多一次异步往返、要么要维护一个可用性状态机，
    // 而这里天然自愈 —— 包补上了下一帧就自己切回影像。
    // ★ 反向网格那一档（方位等距）先垫一层海色再铺影像：它的圆周与极点各留了不到一格的缺口
    //   （见 reprojectRaster 里那两处防呆），垫过之后缺口露出来的是海，不是窗口背景那块深色。
    if (imgOn && PJ.invGrid && (imgSet || imgEl) && (!compat || rasterOut || vecImg)) {
      const kk = k(); ctx.save()
      ctx.fillStyle = oceanColor
      ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
      traceSphere(ctx); ctx.fill()
      ctx.restore()
    }
    if (imgOn && (imgSet || imgEl) && (!compat || rasterOut || vecImg) && drawImagery()) {
      /* 影像已铺满，海色与陆地填充这两层被顶替 */
    } else {
      // ★ 等距圆柱下世界就是那一整块矩形，铺满即可；换了投影地球只占平面里的一块
      //   （Equal Earth / Robinson 是个椭圆样的形，Albers 是把扇面），铺满矩形就等于
      //   把「地图之外」也涂成海色，图廓当场没了。故投影档按 d3 的 Sphere 轮廓填。
      ctx.fillStyle = oceanColor
      if (PJ.identity) ctx.fillRect(rx, ry, rw, rh)
      else {
        const kk = k(); ctx.save(); ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
        traceSphere(ctx); ctx.fill()
        ctx.restore()
      }
      drawLand()
    }
    ctx.restore()
  }
  // 图廓（地球在这张平面上的外轮廓）。等距圆柱下就是世界矩形的边，由经纬网的 ±180 那两条兼着；
  // 投影档下是一条曲线，得单画一条，否则椭圆边缘只有海色与背景色的交界、没有线。
  // 图廓描边用的 Path2D（老样子）；另有一份【录下来的 moveTo/lineTo 序列】给两处海色填充用。
  // ★ 四处一律走 PJ.spherePath（细精度那份投影实例），不再拿地物那份 PJ.path 画 Sphere：
  //   d3 出厂精度下等积地球的图廓只有 33 段折线、弦高 0.41 平面单位，放大到 6 px/° 整圈是多边形
  //   （2026-09-10 用户截图）。精度的两档与代价见 projection.js 的 PATH_PRECISION / OUTLINE_PRECISION。
  // ★ 为什么填充不能改用 Path2D：Path2D 是用户空间坐标、由 CTM 整体变换后再光栅化，
  //   而 `beginPath + 逐点 lineTo` 是记录时就折进设备坐标 —— 两条路的抗锯齿覆盖不逐位相同。
  //   实测在罗宾逊全图上沿图廓差出 2.8 万个像素（最大 17/255）。故填充这一侧只把
  //   d3 的那一趟（日界线裁剪 + 自适应加密）缓存下来，画的时候仍是同一串 ctx 调用 → 逐像素相同。
  let sphPath = null, sphKey = ''
  let sphOps = null, sphOpsKey = ''
  function sphereOps() {
    const key = planeKey()
    if (sphOps !== null && sphOpsKey === key) return sphOps
    const ops = []
    let bad = false
    PJ.spherePath({
      moveTo(x, y) { ops.push(0, x, y) },
      lineTo(x, y) { ops.push(1, x, y) },
      closePath() { ops.push(2, 0, 0) },
      arc() { bad = true }          // Sphere 不会走到这里；真走到就整份作废、回退现算
    })
    sphOps = bad ? null : ops
    sphOpsKey = key
    return sphOps
  }
  // 海色填充：把录下来的那串调用原样回放（compat 与录不下来时回退现算）
  function traceSphere(g) {
    const ops = compat ? null : sphereOps()
    g.beginPath()
    if (!ops) { PJ.spherePath(g); return }
    for (let i = 0; i < ops.length; i += 3) {
      const op = ops[i]
      if (op === 0) g.moveTo(ops[i + 1], ops[i + 2])
      else if (op === 1) g.lineTo(ops[i + 1], ops[i + 2])
      else g.closePath()
    }
  }
  function drawSphereOutline() {
    if (PJ.identity || borderStyle.gridOn === false) return
    const kk = k()
    const key = planeKey()
    if (!sphPath || sphKey !== key) { sphPath = PJ.spherePath(new Path2D()); sphKey = key }
    ctx.save()
    ctx.strokeStyle = borderStyle.gridColor
    ctx.globalAlpha = Math.min(1, (borderStyle.gridOpacity || 0.5) * 1.6)   // 图廓比网格线实一档
    ctx.lineWidth = (borderStyle.gridWidth || 1) / kk
    ctx.setLineDash([])
    ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty)
    if (compat) { ctx.beginPath(); PJ.spherePath(ctx); ctx.stroke() } else ctx.stroke(sphPath)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.restore()
  }
  // field 之上的标注（省界/标记/国家名/卫星层点标注等）。透明背景，叠在覆盖填充之上。
  // 各类数据线（GXT 波束线/仰角线/聚焦卫星线）不在此层——见 drawDataLines（压在国界省界之下）。
  // 航迹是例外：整层（线+圆点+图标）在此层的【地名之后】画，见 drawTrajLayer。
  // 2026-09-07 拆成两半：drawLinesContent（经纬网 / 行政区界 / 五类线 / 岛链，烘进 aboveCanvas，可增量条带重建）
  // 与 drawTextContent（标记 / 地名 / 航迹 / 卫星层，烘进 textCanvas，随时间走的东西只重画它）。
  // drawAboveContent 仍是两半连着画（导出用）。
  function drawAboveContent(rx, ry, rw, rh) { drawLinesContent(rx, ry, rw, rh); drawTextContent(rx, ry, rw, rh) }
  function drawLinesContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 经纬网 + 行政区界 + 五类边界线画在覆盖填充之上：地理骨架贯穿覆盖区内外，覆盖与底图融为一体（平级），
    // 不再像贴纸浮在上面。次序从下往上：经纬网 → 二级行政区 → 一级行政区 → 海岸 → 主张 → 停火 → 未定 → 国界。
    drawGrid()
    drawSphereOutline()
    // 缩放分级：全球视角下二级行政区完全淡出、一级降到 0.3（政治五类不参与——国界在任何尺度都在）
    const admF = admFade(borderStyle.fade ? fadeFactor(1 / k()) : 1)
    // 二级行政区界（画在一级之下，一级更醒目）
    if (cityVisible && city && admF.adm2 > 0.01) {
      ctx.globalAlpha = borderStyle.cityOpacity * admF.adm2
      if (PJ.identity || compat || !drawAdmBaked('city', borderStyle.cityColor, borderStyle.cityWidth)) for (const ring of city.borders) drawPolyline(ring, borderStyle.cityColor, borderStyle.cityWidth)
      ctx.globalAlpha = 1
    }
    // 一级行政区界
    if (provVisible && prov) {
      ctx.globalAlpha = borderStyle.provOpacity * admF.adm1
      if (PJ.identity || compat || !drawAdmBaked('prov', borderStyle.provColor, borderStyle.provWidth)) for (const ring of prov.borders) drawPolyline(ring, borderStyle.provColor, borderStyle.provWidth)
      ctx.globalAlpha = 1
    }
    drawBorders()   // 海岸 → 主张 → 停火 → 未定 → 国界（国界压在最上面）
    drawChains()    // 岛链参考线：叠在全部底图线之上（它是注记，不该被国界盖住）
    ctx.restore()
  }
  function drawTextContent(rx, ry, rw, rh) {
    ctx.save()
    ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    // 随缩放联动系数：mz=scale（与国家名同率，用于数值/覆盖/卫星层等注记）；scale=1 即当前大小。
    // iz=√scale 是「克制版」联动：点标记/地球站/航迹这类实心图标若按 mz 满速放大，2D 缩放幅度大(可达60×)会膨成大色块，
    // 故按 √scale 缓增——仍随缩放变化、scale=1 时不变，但放大时增长更温和、不至于过大。
    const mz = scale, iz = izNow()
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
    // 挂了模型的点 / 站：画模型俯视图（出好了才画，否则照画符号）；画了的记下来，下面标注按模型图的外廓让位
    const sprOn = sprLive()
    if (sprOn) entSpr.beginPass()
    const ptSp = sprOn ? new Map() : null, stSp = sprOn ? new Map() : null
    for (const p of mk.points) {
      const x = PX(p.lon, p.lat), y = PY(p.lat, p.lon)
      const sp = ptSp && p.m2d && sprVisible(x, y, p, iz) ? sprAt('point', 'pt:' + p.id, p, northRot(p.lat, p.lon, x, y), iz) : null
      if (sp) {
        ptSp.set(p, sp)
        const sa = ctx.globalAlpha
        if (markCfg.ptOpacity < 1) ctx.globalAlpha = sa * Math.max(0, markCfg.ptOpacity)
        drawSpr(sp, x, y)
        ctx.globalAlpha = sa
      } else if (p.idx) paintNumBadge(ctx, x, y, idxD, p.idx, idxFont, ptBadgeOf(p))
      else paintMarkSymbol(ctx, x, y, ptD, ptSymOf(p))
    }
    // 纵向锚点走 STATION_ANCHOR_Y（符号里那颗白色址点），不再是方框底边 —— 3D 侧的
    // sprite.center 用 1−STATION_ANCHOR_Y 对齐同一处，两视图的站址才落在同一个像素上。
    {
      const sa = ctx.globalAlpha
      if (markCfg.stOpacity < 1) ctx.globalAlpha = sa * Math.max(0, markCfg.stOpacity)
      for (const s of mk.stations) {
        const x = PX(s.lon, s.lat), y = PY(s.lat, s.lon)
        const sp = stSp && s.m2d && sprVisible(x, y, s, iz) ? sprAt('station', 'st:' + s.id, s, northRot(s.lat, s.lon, x, y), iz) : null
        if (sp) { stSp.set(s, sp); drawSpr(sp, x, y) }
        else if (stationReady) ctx.drawImage(stationImg, x - si * STATION_ANCHOR_X, y - si * STATION_ANCHOR_Y, si, si)
      }
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
      drawLabelLayer(chainLbl, slots, (l) => (chainCfg.name === 'en' ? l.en : l.zh), chainCfg.nameSize || 1, zf, chainCfg.color, { ...water, opacity: chainCfg.opacity, bold: !!chainCfg.nameBold })
    }
    if (oceanMode !== 'off') {
      drawLabelLayer(oceanLbl, slots, (l) => (oceanMode === 'en' ? l.en : l.zh), sizes.oceanScale || 1, zf, labelStyle.oceanColor, { ...water, opacity: labelStyle.oceanOpacity, bold: !!labelStyle.oceanBold })
    }
    if (nameMode !== 'off') {
      drawLabelLayer(clabels, slots, (l) => (nameMode === 'en' ? l.en : l.zh), ns, zf, labelStyle.countryColor, { opacity: labelStyle.countryOpacity, bold: !!labelStyle.countryBold })
    }
    if (seaMode !== 'off') {
      drawLabelLayer(seaLbl, slots, (l) => (seaMode === 'en' ? l.en : l.zh), sizes.seaScale || 1, zf, labelStyle.seaColor, { ...water, opacity: labelStyle.seaOpacity, bold: !!labelStyle.seaBold })
    }
    if (provVisible && prov) {
      drawLabelLayer(prov.labels, slots, (l) => l.name, sizes.provScale || 1, zf, labelStyle.provColor, { strokeScale: CASE_K_P, strokeMin: CASE_MIN_P, opacity: labelStyle.provOpacity, bold: !!labelStyle.provBold })
    }
    if (cityVisible && city) {   // 二级最后摆：一级不在场的地方它才有位子
      drawLabelLayer(city.labels, slots, (l) => l.name, sizes.cityScale || 1, zf, labelStyle.cityColor, { strokeScale: CASE_K_C, strokeMin: CASE_MIN_C, opacity: labelStyle.cityOpacity, bold: !!labelStyle.cityBold })
    }
    // ★ 航迹层压在【地名之上】：制图分工是「面在文字下、线/点在文字上」——
    //   填充面盖住文字是整片消失，细线穿过文字只吃掉几个像素、字还认得出；反过来一个带套边的地名
    //   压在航迹上一次吃掉几十像素的线，而线的连续性本身就是信息（有没有拐、是一条还是两条、
    //   末点是不是真到那儿）。载具图标＝当前位置，等同「本船符号」，更不能被底图地名盖住。
    //   线/圆点/图标必须同层：只提点不提线会把航迹切断、圆点却浮在字上，比整层压下去更怪。
    drawTrajLayer(iz, ST_ICON_K)
    drawCityBoxes(iz)
    if (geom) {   // GXT 覆盖图标签（波束名/数值）：克制版联动 iz
      for (const l of (geom.labels || [])) drawText(l.text, l.lon, l.lat, Math.round((l.hpx || 0.03) * 533 * iz), l.color || '#fff', { bold: !!l.bold })
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
      // 带序号徽标时字心要让开圈（外沿比例 BADGE_R，与 3D 同一支）；没有徽标按该形状自己的外沿；画的是模型图就按模型图的外廓
      const sp = ptSp && ptSp.get(p)
      const eUp = sp ? sp.u : (p.idx ? idxD * BADGE_R : symbolUp(sh) * ptD), eDn = sp ? sp.d : (p.idx ? idxD * BADGE_R : symbolDown(sh) * ptD)
      const ext = sp ? sprExt(sp) : { up: eUp, down: eDn, half: (p.idx ? idxD : ptD) * 0.5 }
      const dU = Math.max(pf * MK_UP, eUp + pf * 0.7), dD = Math.max(pf * 0.9 * MK_UP, eDn + pf * 0.63)
      if (p.label) {
        const a = labelAt(ptPos, ext, pf, ptPos === 'down' ? dD : dU, pf * 1.2, 0)
        drawText(p.label, p.lon, p.lat, pf, markCfg.ptLabelColor, { dx: a.dx, dy: a.dy, align: a.align, opacity: markCfg.ptLabelOpacity, bold: !!markCfg.ptBold })
      }
      if (p.el) {   // 聚焦卫星仰角：亮白，标记下方（坐标也在下方时让到第二行）
        const a = labelAt('down', ext, pf * 0.9, dD, pf * 1.2, (ptPos === 'down' && p.label) ? 1 : 0)
        drawText(p.el, p.lon, p.lat, pf * 0.9, '#ffffff', { dx: a.dx, dy: a.dy, bold: !!markCfg.ptBold })
      }
    }
    for (const s of mk.stations) {
      const sf = markCfg.stFont * iz * MK_FONT_K   // 地球站文字：×MK_FONT_K 与 3D 字高对齐（与图标同用克制版 iz）
      // 锚点在址点上，符号还有一截落在锚点下方（址点那颗圆的下半 / 几何符号的下半），
      // 字要整体让开这一截，否则与址点叠在一起；画的是模型俯视图就按它的外廓让（锚点大致在图形中部）
      const sp = stSp && stSp.get(s)
      const ext = sp ? sprExt(sp) : stExtent(si)
      const gapD = ext.down + sf * 0.5 + 0.5 * iz, gapU = ext.up + sf * 0.5 + 0.5 * iz, step = sf + 3 * iz
      if (s.name) {
        const a = labelAt(stPos, ext, sf, stPos === 'up' ? gapU : gapD, step, 0)
        drawText(s.name, s.lon, s.lat, sf, markCfg.stLabelColor, { dx: a.dx, dy: a.dy, align: a.align, opacity: markCfg.stLabelOpacity, bold: !!markCfg.stBold })
      }
      if (s.el) {   // 聚焦卫星仰角：亮白，恒在名称之下
        const a = labelAt('down', ext, sf * 0.9, gapD, step, (stPos === 'down' && s.name) ? 1 : 0)
        drawText(s.el, s.lon, s.lat, sf * 0.9, '#ffffff', { dx: a.dx, dy: a.dy, bold: !!markCfg.stBold })
      }
    }
    // 卫星 / 仰角线独立图层：等仰角线 + 卫星图标 + 名称（在覆盖/标记之上、聚焦图标之下）
    if (satLayer) {
      // 卫星层所有线（Polygon 边线随 drawSatPolyLines、仰角线等随 drawDataLines）均画在 below/above 之间
      // → 压在国界/省界/地名之下，与之共存；这里只画点/标签/卫星图标
      // d.px：屏幕恒定像素半径（Polygon 顶点手柄，不随缩放变大）；否则沿用世界联动尺寸
      for (const d of (satLayer.dots || [])) {
        const dx = PX(d.lon, d.lat), dy2 = PY(d.lat, d.lon)   // 视口外剔除：波束合成大群（数百点）放大后大多在屏外，逐点画纯浪费
        if (dx < -24 || dx > cw + 24 || dy2 < -24 || dy2 > ch + 24) continue
        dot(d.lon, d.lat, d.px != null ? Math.max(1, d.px) : Math.max(2, d.r != null ? d.r : 4) * mz, hex(d.color != null ? d.color : 0xffd27a), true)
      }
      for (const l of (satLayer.labels || [])) {   // 世界尺寸字号：与 3D makeCovLabel 同源（套用地名标定 hpx0.02↔px15，zf=k()/13.1），2D/3D 一致
        const px = Math.round((l.hpx || 0.026) * 750 * zf)
        if (l.cullPx && px < l.cullPx) continue    // 自适应编号：小于可读下限的糊点直接不画（缩小看大群时天量文字全免）
        const lx2 = PX(l.lon, l.lat), ly2 = PY(l.lat, l.lon)
        const mw = px * (String(l.text == null ? '' : l.text).length * 0.4 + 1)
        if (lx2 < -mw || lx2 > cw + mw || ly2 < -px || ly2 > ch + px) continue   // 视口外剔除（含文字宽裕量）
        drawText(l.text, l.lon, l.lat, px, l.color || '#fff', { bold: !!l.bold })
      }
      for (const s of (satLayer.sats || [])) { if (s.lon == null || s.lat == null || s.iconShow === false) continue; drawSatIcon(s.lon, s.lat, (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K, hex(s.color != null ? s.color : 0xffd27a)) }   // 颜色/大小随各星设置；图标按 mz 联动，与卫星名标签同率缩放；iconShow 单独控制显隐
      for (const s of (satLayer.sats || [])) {
        if (!s.name || s.lon == null || s.lat == null || s.labelShow === false) continue
        const ls = (s.labelSize || 9) * mz
        // 名称紧贴图标：间隙=0，只留图标半高的偏移（无图标时名称直接锚在星位置）
        drawText(s.name, s.lon, s.lat, ls, hex(s.color != null ? s.color : 0xffd27a), { dy: -(s.iconShow !== false ? (s.iconSize || sizes.satIcon || 30) * mz * SAT_ICON_K * 0.5 : 0), bold: !!s.labelBold })
      }
    }
    ctx.restore()
  }
  // 这一次快照该带多少余量（设备像素，恒为整数）。
  // ★ 只在世界矩形真的伸出视口时才留：全图视角（信箱留白）四周是空的，留了也是白占内存与工时；
  //   而那一档本来就不需要余量 —— 世界整个在快照里，平移多远都盖得住（见 snapPlace）。
  // ★ 必须是【设备像素的整数】：① 瓦片影像的片边按 round(css×dpr) 取整，余量在 CSS 上不是整像素
  //   就会把取整相位挪掉、缝的位置全变；② 合成时的位移才落得到整设备像素上，不触发位图重采样。
  function snapMargins() {
    const kk = k()
    const ohX = Math.max(Math.max(0, -tx), Math.max(0, tx + PJ.W * kk - cw))
    const ohY = Math.max(Math.max(0, -ty), Math.max(0, ty + PJ.H * kk - ch))
    const qz = (oh, cap) => Math.min(Math.round(cap * OVER * dpr), Math.ceil(oh * dpr / OVER_Q) * OVER_Q)
    return { mx: qz(ohX, cw), my: qz(ohY, ch) }
  }
  // 重建两张静态快照。below 不透明含底色；above 透明叠加。
  // 余量为 0 时【原样走老路】：渲到主画布再拷到离屏缓冲 —— 全图视角（本次改造的主战场）
  // 于是与改造前逐字节同一条指令流，逐像素相同由构造保证。
  // 余量不为 0（放大到世界伸出视口）时快照比主画布大，主画布当不了草稿，改为直接渲到离屏缓冲。
  // 旧快照挪进 fallbacks，当前这一对换成另一对画布（双缓冲）—— 别再往同一张上画。
  function keepFallback() {
    const rec = curRec()
    const c = coverOf(rec, dpr)
    // 文字那一张合进 above：回退快照只留两张（below / above），当回退垫底时文字也在
    if (textCanvas && textCanvas.width === aboveCanvas.width && textCanvas.height === aboveCanvas.height) {
      aboveCtx.save(); aboveCtx.setTransform(1, 0, 0, 1, 0, 0); aboveCtx.drawImage(textCanvas, 0, 0); aboveCtx.restore()
    }
    fallbacks.unshift({ ...rec, below: belowCanvas, above: aboveCanvas, cw: belowCanvas.width, ch: belowCanvas.height, area: Math.abs((c.x1 - c.x0) * (c.y1 - c.y0)) })
    fallbacks.sort((a, b) => b.area - a.area)
    while (fallbacks.length > FALLBACK_MAX) sparePairs.push(fallbacks.pop())
    if (sparePairs.length > 1) sparePairs.length = 1
    const sp = sparePairs.pop()
    belowCanvas = sp ? sp.below : document.createElement('canvas')
    aboveCanvas = sp ? sp.above : document.createElement('canvas')
    belowCtx = belowCanvas.getContext('2d'); aboveCtx = aboveCanvas.getContext('2d')
  }
  function renderStaticLayers() {
    const _t0 = performance.now()
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0 }
    // §4.2：静止重建时把平移量落到整设备像素上 —— 不然缩放停下后 snapTx 是分数，
    // 第一次拖动的残差又是 0.5 px，于是拖动全程每次停顿都补一次建。挪 ≤ 0.5 设备像素肉眼不可见。
    // 手势【进行中】不动它：缩放锚点的精度只在缩放进行中有意义（onWheel / setZoomT 的锚点数学要精确的 tx）。
    if (!gestureHot()) { tx = quantPan(tx, dpr); ty = quantPan(ty, dpr) }
    const { mx: mxDev, my: myDev } = snapMargins()
    const bw = canvas.width + 2 * mxDev, bh = canvas.height + 2 * myDev
    // 旧快照留不留：内容代相同、且新的那张【盖不住】它（典型：从全图放大进来，旧的是全图）就留着当回退。
    // ★ 判据是 snapGen === staticGen 而不是 staticValid —— 静止补建（rebuildAtRest）正是
    //   「内容没变、只是视图动了」那一条，它把 staticValid 置假，按 staticValid 判就一张也留不下。
    // ★ 只在【缩放变了】时留：同 k 的平移留一张价值很小（盖的是挪开的那一块），代价却是每次
    //   平移后的补建都换一对新画布 —— 新建的画布头一次光栅走的是另一档（软件光栅未提升到 GPU），
    //   与「一直用同一对」比逐像素差 0.1% 的点、最大 6/255。静止画面的逐像素闸卡的正是这个。
    if (snapGen === staticGen && belowCanvas.width > 1 && k() !== snapK) {
      const oc = coverOf(curRec(), dpr), nc = coverOf({ k: k(), tx, ty, mx: mxDev, my: myDev, w: bw, h: bh }, dpr)
      if (!coversSubset(nc, oc)) keepFallback()
    }
    // ★ 增量条带（2026-09-07）：同 k 的平移补建不整份重来 —— 旧位图搬位，只重画露出来的那一圈。
    //   实测 10m @1920×1080：整份光栅 115～135 ms，18% 条带 19～21 ms（线的光栅代价随面积走，
    //   逐要素 Path2D 被 Skia 按 clip 剔）。判据见 stripPlan；必须在 snapTx 被改写之前算。
    const sp = stripPlan(bw, bh, mxDev, myDev)
    lastStrip = !!sp
    if (belowCanvas.width !== bw || belowCanvas.height !== bh) {
      belowCanvas.width = bw; belowCanvas.height = bh
      aboveCanvas.width = bw; aboveCanvas.height = bh
    }
    if (textCanvas.width !== bw || textCanvas.height !== bh) { textCanvas.width = bw; textCanvas.height = bh }
    const SV = { ctx, cw, ch, tx, ty }
    snapK = k(); snapTx = tx; snapTy = ty; snapMxDev = mxDev; snapMyDev = myDev; snapGen = staticGen
    if (mxDev || myDev) realView = { cw, ch, tx, ty }
    try {
      if (mxDev || myDev) { cw = bw / dpr; ch = bh / dpr; tx = SV.tx + mxDev / dpr; ty = SV.ty + myDev / dpr }
      const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
      if (sp) {
        shiftCanvas(belowCanvas, belowCtx, sp.sx, sp.sy)
        shiftCanvas(aboveCanvas, aboveCtx, sp.sx, sp.sy)
        // below：只在露出来的那一圈铺底色 + 画海陆
        ctx = belowCtx
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.save(); clipRectsDev(sp.rects)
        ctx.fillStyle = BG; for (const r of sp.rects) ctx.fillRect(r[0], r[1], r[2], r[3])
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawBelowContent(rx, ry, rw, rh)
        ctx.restore()
        // 线：同一圈
        ctx = aboveCtx
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.save(); clipRectsDev(sp.rects)
        for (const r of sp.rects) ctx.clearRect(r[0], r[1], r[2], r[3])
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        drawLinesContent(rx, ry, rw, rh)
        ctx.restore()
        // 文字：整张重画（地名避让按整幅算，条带里画不了半个字；本来就便宜）
        ctx = textCtx
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
        drawTextContent(rx, ry, rw, rh)
      } else if (mxDev || myDev) {
        // below：海陆/冰盖/网格（含背景底色）
        ctx = belowCtx
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
        drawBelowContent(rx, ry, rw, rh)
        // above：经纬网/行政区界/五类边界线（透明）
        ctx = aboveCtx
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
        drawLinesContent(rx, ry, rw, rh)
        // text：标记/国家名/卫星层（透明）
        ctx = textCtx
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
        drawTextContent(rx, ry, rw, rh)
      } else {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
        drawBelowContent(rx, ry, rw, rh)
        belowCtx.setTransform(1, 0, 0, 1, 0, 0); belowCtx.clearRect(0, 0, bw, bh); belowCtx.drawImage(canvas, 0, 0)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
        drawLinesContent(rx, ry, rw, rh)
        aboveCtx.setTransform(1, 0, 0, 1, 0, 0); aboveCtx.clearRect(0, 0, bw, bh); aboveCtx.drawImage(canvas, 0, 0)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
        drawTextContent(rx, ry, rw, rh)
        textCtx.setTransform(1, 0, 0, 1, 0, 0); textCtx.clearRect(0, 0, bw, bh); textCtx.drawImage(canvas, 0, 0)
      }
    } finally {
      ctx = SV.ctx; cw = SV.cw; ch = SV.ch; tx = SV.tx; ty = SV.ty; realView = null
    }
    textValid = true
    tilesDirty = false          // 这一趟本来就把瓦片重画了
    lastRebuildMs = +(performance.now() - _t0).toFixed(2)
  }
  // 这一次补建能不能走增量条带：内容代没变、同 k、同尺寸同余量、位移落在整设备像素上、
  // 露出的面积不超过 STRIP_MAX（超过就整份重来更划算）、手势中到货的瓦片没有欠账（非实时影像路
  // 那些片落在留下来的那一块里，条带补不到它们）。返回 { sx, sy, rects } 或 null。
  const STRIP_MAX = 0.75
  let lastStrip = false
  function stripPlan(bw, bh, mxDev, myDev) {
    if (snapGen !== staticGen || tilesDirty || !belowCanvas || belowCanvas.width !== bw || belowCanvas.height !== bh) return null
    if (k() !== snapK || snapMxDev !== mxDev || snapMyDev !== myDev) return null
    const ex = (tx - snapTx) * dpr, ey = (ty - snapTy) * dpr
    const sx = Math.round(ex), sy = Math.round(ey)
    if (Math.abs(ex - sx) > 1e-6 || Math.abs(ey - sy) > 1e-6) return null
    if (!sx && !sy) return null
    const rects = stripRects(sx, sy, bw, bh)
    let area = 0
    for (const r of rects) area += r[2] * r[3]
    if (area > STRIP_MAX * bw * bh) return null
    return { sx, sy, rects }
  }
  function stripAble() {
    const { mx, my } = snapMargins()
    return !!stripPlan(canvas.width + 2 * mx, canvas.height + 2 * my, mx, my)
  }
  // 设备坐标下把几块矩形并成一个 clip（调用方已置单位变换、已 save）
  function clipRectsDev(rects) {
    ctx.beginPath()
    for (const r of rects) ctx.rect(r[0], r[1], r[2], r[3])
    ctx.clip()
  }
  // 旧位图搬位：经一张常驻的中转画布（画布自画自己在规范里允许，但实现各异，不赌）。
  // 'copy' 合成让没被源盖住的那一圈直接成透明，省一次 clearRect。
  let shiftTmp = null
  function shiftCanvas(cv, c, sx, sy) {
    if (!shiftTmp) shiftTmp = document.createElement('canvas')
    if (shiftTmp.width !== cv.width || shiftTmp.height !== cv.height) { shiftTmp.width = cv.width; shiftTmp.height = cv.height }
    const t = shiftTmp.getContext('2d')
    t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'copy'; t.drawImage(cv, 0, 0); t.globalCompositeOperation = 'source-over'
    c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'copy'; c.drawImage(shiftTmp, sx, sy); c.globalCompositeOperation = 'source-over'
  }
  // 只重画文字 / 标记 / 卫星层那一张（invalidateText 之后）。★ 按【快照的视图】画，不按当前视图 ——
  // 手势中两者可以不同，而这张必须与 below / above 逐像素对齐。
  function renderTextLayer() {
    if (!belowCanvas || belowCanvas.width < 2 || !textCanvas) return
    const bw = belowCanvas.width, bh = belowCanvas.height
    if (textCanvas.width !== bw || textCanvas.height !== bh) { textCanvas.width = bw; textCanvas.height = bh }
    const SV = { ctx, cw, ch, tx, ty, scale }
    try {
      scale = snapK / base
      cw = bw / dpr; ch = bh / dpr; tx = snapTx + snapMxDev / dpr; ty = snapTy + snapMyDev / dpr
      const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h
      ctx = textCtx
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
      drawTextContent(rx, ry, rw, rh)
    } finally {
      ctx = SV.ctx; cw = SV.cw; ch = SV.ch; tx = SV.tx; ty = SV.ty; scale = SV.scale
    }
    textValid = true
  }
  // ── 全图背板（《2D 手势期重建治理》§11.3 的根治）──────────────────────────
  // 110m 骨架烘一张【全图】（下：海陆，开实时影像时图廓内透明；上：只有线，不带文字 —— 缩放去用时
  // 文字会跟着位图放大成大字）。谁都盖不住时垫它：拖动 / 缩小期间画面永远有海陆线，再也不同步整份重建。
  // 按需烘、按键复用：内容代 / 画布尺寸 / 平面 / 影像模式任一变了才重烘，一次 ≈ 5 ms。
  let bpBelow = null, bpAbove = null, bpKey = '', bpRec = null
  const backplateKey = () => planeKey() + '/' + canvas.width + 'x' + canvas.height + '/' + staticGen + '/' + (imgLiveNow() ? 'L' : 'V') + '/' + mapDetail0
  function ensureBackplate() {
    if (!hasDetail('110m')) { ensureDetail('110m').catch(() => {}); return null }
    if (rotLive || liteBake) return null
    const key = backplateKey()
    if (!(bpBelow && bpKey === key)) {
      if (!bpBelow) { bpBelow = document.createElement('canvas'); bpAbove = document.createElement('canvas') }
      const bw = canvas.width, bh = canvas.height
      if (bpBelow.width !== bw || bpBelow.height !== bh) { bpBelow.width = bw; bpBelow.height = bh; bpAbove.width = bw; bpAbove.height = bh }
      const SV = { ctx, tx, ty, scale }
      const tx0 = (cw - PJ.W * base) / 2, ty0 = (ch - PJ.H * base) / 2
      try {
        withLiteGeo(() => {
          scale = 1; tx = tx0; ty = ty0
          const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h
          ctx = bpBelow.getContext('2d')
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch); ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch)
          drawBelowContent(rx, ry, rw, rh)
          ctx = bpAbove.getContext('2d')
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch)
          drawLinesContent(rx, ry, rw, rh)
        })
      } catch (e) {
        bpKey = ''; console.warn('全图背板烘制失败', e); return null
      } finally {
        ctx = SV.ctx; tx = SV.tx; ty = SV.ty; scale = SV.scale
      }
      bpRec = { k: base, tx: tx0, ty: ty0, mx: 0, my: 0, w: bw, h: bh, cw: bw, ch: bh }
      bpKey = key
    }
    return { f: { ...bpRec, below: bpBelow, above: bpAbove }, pl: placeOf(bpRec) }
  }
  // 快照怎么摆到当前视图上。返回 null ＝ 盖不住 / 该重建。
  // ★ 判据是「盖住【世界矩形 ∩ 视口】」而不是「盖住整个视口」：世界之外快照上本就是背景（below）
  //   与透明（above），与现画一遍逐字相同 —— 故全图视角（世界整个在快照里）平移多远都命中。
  // ★ 返回值恒非 null：covers=false 只说明「盖不住」，几何照给 —— 盖不住时也要把它缩着贴上去
  //   （下面垫一张回退快照或海色），而不是整块空着。
  const viewNow = () => ({ k: k(), tx, ty, dpr, cwDev: canvas.width, chDev: canvas.height, W: PJ.W, H: PJ.H })
  const placeOf = (rec) => placeSnapshot(rec, viewNow())
  const curRec = () => ({ k: snapK, tx: snapTx, ty: snapTy, mx: snapMxDev, my: snapMyDev, w: belowCanvas.width, h: belowCanvas.height })
  function snapPlace() { return placeOf(curRec()) }
  // 回退快照里挑一张盖得住当前「世界矩形 ∩ 视口」的（同一套判据，缩放比最接近的优先）；
  // 一张都没有就垫全图背板（110m 骨架，按需烘）。
  function pickFallback() {
    const i = pickFallbackIdx(fallbacks, viewNow())
    if (i >= 0) return { f: fallbacks[i], pl: placeOf(fallbacks[i]) }
    return ensureBackplate()
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
      if (!PJ.identity) { fillRingProj(f.p, hex(f.color), f.opacity != null ? f.opacity : 0.18); continue }
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
      for (const s of wraps()) {
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
  function drawTrajLayer(iz, stIconK) {
    // 线：颜色由页面逐条给（整层按航行/飞行两档，某条航迹可自带覆盖色），线粗/透明度/线型是整层设置
    const sa0 = ctx.globalAlpha
    ctx.globalAlpha = sa0 * Math.max(0, Math.min(1, markCfg.tjOpacity != null ? markCfg.tjOpacity : 0.95))
    const tjDash = DASH_2D[markCfg.tjDash] || null
    // 运动档（t.line：0.5° 大圆加密，与载具运动同一条大圆）画加密线；drawPolyline 按 |Δx| > 180 在接缝切段、投影档交给 d3
    for (const t of mk.trajectories) if (t.pts && t.pts.length > 1) drawPolyline(Array.isArray(t.line) && t.line.length > 1 ? t.line : t.pts, hex(t.color != null ? t.color : 0xff5a5a), Math.max(0.1, markCfg.tjWidth != null ? markCfg.tjWidth : 2.2), false, tjDash)
    ctx.globalAlpha = sa0
    // 圆点大小可调 markCfg.tjDot（0＝不画），按克制版 iz 联动。
    // ★ tjDot 与 tjIconPx 同一把尺（都是【屏幕 px @100% 缩放】、同一档位区间），
    //   但圆点按【该数的一半】作直径 —— 同一个数下实心圆比图标那种镂空剪影重得多，等大时圆点抢戏。
    //   点标记的 ptDot 仍是老的半径口径（滑块上的数不等于屏幕尺寸），两者不要互相抄。
    const trajD = (markCfg.tjDot != null ? markCfg.tjDot : 4) * iz / 2
    if (trajD > 0) {
      for (const t of mk.trajectories) {
        const c = hex(t.dotColor != null ? t.dotColor : (t.color != null ? t.color : 0xff9a5a))
        for (const p of (t.pts || [])) paintMarkSymbol(ctx, PX(p.lon, p.lat), PY(p.lat, p.lon), trajD, { shape: 'circle', fill: c, opacity: markCfg.tjOpacity, edge: 0.18, edgeColor: 'rgba(255,255,255,0.92)' })
      }
    }
    // 航迹头（末航点）上的载具图标：航行＝船、飞行＝飞机，形状与 3D 同一份（viz/vehicleSymbol.js）。
    // 朝向取末段在【图上】的走向 —— 2D 的航迹是按经纬度直连画的，图标得贴着那条线（口径见 flatHeading）。
    // 载具挂了模型（载荷带 m2d）：画这件模型的俯视图、机头 / 船艏顺着同一个朝向（出图器没出好时照画剪影）
    const trSp = sprLive() ? new Map() : null
    if (markCfg.tjIconOn !== false && (markCfg.tjIconPx == null || markCfg.tjIconPx > 0)) {
      const vi = (markCfg.tjIconPx != null ? markCfg.tjIconPx : 26) * iz * stIconK   // 与地球站图标同一条尺寸律
      const sa = ctx.globalAlpha
      ctx.globalAlpha = sa * Math.max(0, Math.min(1, markCfg.tjOpacity != null ? markCfg.tjOpacity : 0.95))
      for (const t of mk.trajectories) {
        const tp = t.pts || []; if (!tp.length) continue
        // 运动档：画在此刻的状态位置，朝向取【屏幕】走向（沿大圆前进一小步投到图上）—— 任何投影档都贴着大圆线
        const vs = vehStates.size && t.id != null ? vehStates.get(t.id) : null
        let x, y, rot
        if (vs) { x = PX(vs.lon, vs.lat); y = PY(vs.lat, vs.lon); rot = vehScreenRot(vs, x, y) }
        else { const hd = tp[tp.length - 1]; x = PX(hd.lon, hd.lat); y = PY(hd.lat, hd.lon); rot = flatHeading(tp[tp.length - 2], hd) }
        const sp = trSp && t.m2d && sprVisible(x, y, t, iz) ? sprAt(vehKind(t), 'tr:' + t.id, t, rot, iz) : null
        if (sp) { trSp.set(t, sp); drawSpr(sp, x, y); continue }
        drawVehicle(ctx, t.kind, x, y, vi, rot, hex(t.iconColor != null ? t.iconColor : (t.color != null ? t.color : 0xff5a5a)))
      }
      ctx.globalAlpha = sa
    }
    // 航迹名（默认不画）：锚在航迹头上（运动档跟着载具走），让开载具图标那一截（画的是模型图就让开它朝上的外廓）
    if (markCfg.tjNameOn && markCfg.tjNameFont > 0) {
      const nf = markCfg.tjNameFont * iz * MK_FONT_K
      const vi = (markCfg.tjIconOn !== false ? (markCfg.tjIconPx != null ? markCfg.tjIconPx : 26) : 0) * iz * stIconK
      for (const t of mk.trajectories) {
        const tp = t.pts || []; if (!tp.length || !t.name) continue
        const vs = vehStates.size && t.id != null ? vehStates.get(t.id) : null
        const hd = vs || tp[tp.length - 1]
        const sp = trSp && trSp.get(t)
        drawText(t.name, hd.lon, hd.lat, nf, markCfg.tjNameColor, { dy: -((sp ? sp.u : vi * 0.5) + nf * 0.7), bold: !!markCfg.tjNameBold })
      }
    }
  }
  // 航迹载具的模型类别（= entityRuntime.trajEntityKind：飞行 → 飞机、其余 → 船）：锚点口径与吃水线裁剪按它
  function vehKind(t) { return t && t.kind === 'flight' ? 'aircraft' : 'ship' }
  // 运动档载具在图上的朝向（弧度，屏幕正上起顺时针）：沿大圆前进 0.05° 投到图上取走向；那一步跨了世界接缝就改取后退一步反向
  const _aq = { lat: 0, lon: 0 }
  function vehScreenRot(vs, x, y) {
    aheadPoint(vs.lat, vs.lon, vs.headingDeg, 0.05, _aq)
    let dx = PX(_aq.lon, _aq.lat) - x, dy = PY(_aq.lat, _aq.lon) - y
    if (Math.abs(dx) > PJ.W * k() * 0.5) {
      aheadPoint(vs.lat, vs.lon, vs.headingDeg + 180, 0.05, _aq)
      dx = x - PX(_aq.lon, _aq.lat); dy = y - PY(_aq.lat, _aq.lon)
    }
    if (dx * dx + dy * dy < 1e-12) return 0
    return Math.atan2(dx, -dy)
  }
  // 载具此刻在图上的位置（运动档 = 状态；静止档 = 末航点）
  function vehLL(t) {
    const vs = vehStates.size && t.id != null ? vehStates.get(t.id) : null
    if (vs) return vs
    const tp = t.pts || []
    return tp.length ? tp[tp.length - 1] : null
  }
  // ---- 拖放命中（不受「调整位置」门控）：地球站 → 点标记 → 载具（图上压盖次序反过来）。2D 没有卫星拾取 ----
  // 几何与 markerAt 同一套（stBox / stExtent / ptDiam / idxDiam，立在锚点上的符号抓形体中心），外加载具（半径 max(HIT_MIN, vi·0.5 + 4)）。
  // 返回 { kind, id, x, y, px }（x / y = 画布 CSS 像素的形体中心，px = 视觉直径）或 null。
  const ENT_ORDER = ['station', 'point', 'vehicle']
  function entityAtScreen(clientX, clientY, kinds) {
    const r = canvas.getBoundingClientRect()
    const mx = clientX - r.left, my = clientY - r.top
    let best = null, bd = Infinity
    const test = (x, y, d, kind, id) => {
      const hit = Math.max(HIT_MIN, d * 0.5 + 4)
      const dd = Math.hypot(x - mx, y - my)
      if (dd <= hit && dd < bd) { bd = dd; best = { kind, id, x, y, px: d } }
    }
    for (const kind of ENT_ORDER) {
      if (Array.isArray(kinds) && kinds.indexOf(kind) < 0) continue
      entityGeom(kind, test, null)
      if (best) return best
    }
    return null
  }
  // 一类实体的屏幕几何（命中与高亮环共用）：逐个回调 fn(x, y, 直径, kind, id)；only = {kind, id} 时只回调那一个
  function entityGeom(kind, fn, only) {
    const iz = izNow()
    const pick = (id) => !only || only.id === id
    // 画的是模型俯视图的：按那张图的外廓（peek：只看已出的图，与画面同一张）；否则按符号
    if (kind === 'station') {
      const si = stBox(iz), ext = stExtent(si), d = Math.max(ext.up + ext.down, ext.half * 2)
      for (const s of mk.stations) if (s.id != null && pick(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        const x = PX(s.lon, s.lat), y = PY(s.lat, s.lon)
        const sp = s.m2d ? sprAt('station', 'st:' + s.id, s, northRot(s.lat, s.lon, x, y), iz, 'peek') : null
        if (sp) { const h = sprHit(sp); fn(x + h.cx, y + h.cy, h.d, 'station', s.id) }
        else fn(x, y - (ext.up - ext.down) * 0.5, d, 'station', s.id)
      }
    } else if (kind === 'point') {
      const ptD = ptDiam(iz), idxD = idxDiam(iz), sh = markCfg.ptShape
      for (const p of mk.points) if (p.id != null && pick(p.id) && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        const x = PX(p.lon, p.lat), y = PY(p.lat, p.lon)
        const sp = p.m2d ? sprAt('point', 'pt:' + p.id, p, northRot(p.lat, p.lon, x, y), iz, 'peek') : null
        if (sp) { const h = sprHit(sp); fn(x + h.cx, y + h.cy, h.d, 'point', p.id); continue }
        const d = p.idx ? idxD : ptD
        const up = p.idx ? d * BADGE_R : symbolUp(sh) * d, dn = p.idx ? d * BADGE_R : symbolDown(sh) * d
        fn(x, y - (up - dn) * 0.5, Math.max(up + dn, d), 'point', p.id)
      }
    } else if (kind === 'vehicle') {
      const vi = (markCfg.tjIconOn !== false ? (markCfg.tjIconPx != null ? markCfg.tjIconPx : 26) : 0) * iz * ST_ICON_K
      for (const t of mk.trajectories) {
        if (t.id == null || !pick(t.id)) continue
        const ll = vehLL(t)
        if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue
        const x = PX(ll.lon, ll.lat), y = PY(ll.lat, ll.lon)
        if (t.m2d && markCfg.tjIconOn !== false) {
          const vs = vehStates.size ? vehStates.get(t.id) : null, tp = t.pts || []
          const rot = vs ? vehScreenRot(vs, x, y) : flatHeading(tp[tp.length - 2], ll)
          const sp = sprAt(vehKind(t), 'tr:' + t.id, t, rot, iz, 'peek')
          if (sp) { const h = sprHit(sp); fn(x + h.cx, y + h.cy, h.d, 'vehicle', t.id); continue }
        }
        fn(x, y, vi, 'vehicle', t.id)
      }
    }
  }
  // 落点高亮环：实时层（所有快照之后），按目标实体【当前】屏幕位置；直径 max(px, 24) + 12、线宽 2，外垫一道深色描边（浅底也认得出）
  function drawDropRing() {
    if (!dropHl) return
    let at = null
    entityGeom(dropHl.kind, (x, y, d) => { if (!at) at = { x, y, d } }, dropHl)
    if (!at) return
    const R = (Math.max(at.d, 24) + 12) / 2
    ctx.save()
    ctx.beginPath(); ctx.arc(at.x, at.y, R, 0, Math.PI * 2)
    ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(6,11,18,0.55)'; ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = dropHl.color || '#4da3ff'; ctx.stroke()
    ctx.restore()
  }
  // 性能指标表的城市层：指向误差框 + 城市标签。椭圆（it.ring，卫星视角下的 Az/El 误差投到地面的闭合环）走 drawPolyline；
  // ★ 矩形（it.rect = 半宽 / 半高，度）＝屏幕矩形：以城市的屏幕位置为中心、半宽半高 = 度 × k()。全部投影档的平面都归一到
  //   W=360（geo/projection.js），k() 恒为像素/度 —— Mercator / Robinson / 方位档下与等距圆柱同一尺寸、同一形状，四边水平竖直。
  // 与航迹同层（地名之上）：框是用户特意摆上去的注记，不该被底图地名吃掉。字号按 pt 给（SATSOFT 口径），
  // 与地球站名同一条尺寸律（× iz × MK_FONT_K，两视图同大）；标签摆位 right / left / above（SATSOFT Alignment）。
  // ★ 标签贴着框的【屏幕包围盒】边缘、留 CB_GAP 像素（不随缩放）：框随缩放线性变大，
  //   标签若锚在城市点上按字号偏移，放大后陷进框里、缩小后又飘远。没有框（标记关 / 误差全 0）就贴城市点。
  const CB_GAP = 3
  function drawCityBoxes(iz) {
    if (!cityBoxes.length) return
    for (const L of cityBoxes) {
      const items = L.items || []
      if (!items.length) continue
      const color = L.color || '#ff2a2a', width = Math.max(0.1, Number(L.width) || 1.2), markOn = L.markOn !== false
      const kk = k()
      if (markOn) {
        for (const it of items) {
          if (it.rect) {
            const cx = PX(it.lon, it.lat), cy = PY(it.lat, it.lon)
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
            const hw = it.rect.w * kk, hh = it.rect.h * kk
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'miter'
            ctx.strokeRect(cx - hw, cy - hh, 2 * hw, 2 * hh)
          } else if (it.ring && it.ring.length > 1) drawPolyline(it.ring, color, width, true)
        }
      }
      if (L.labelOn !== false && L.labelPt > 0) {
        const pf = L.labelPt * 4 / 3 * iz * MK_FONT_K, al = L.labelAlign || 'right', bold = !!L.labelBold
        const lim = 90 * kk                      // 跨接缝被甩到另一头的顶点不进包围盒（一座城市的框跨不过 90°）
        for (const it of items) {
          if (!it.text) continue
          const cx = PX(it.lon, it.lat), cy = PY(it.lat, it.lon)
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
          let x0 = cx, x1 = cx, y0 = cy, y1 = cy
          if (markOn && it.rect) { const hw = it.rect.w * kk, hh = it.rect.h * kk; x0 = cx - hw; x1 = cx + hw; y0 = cy - hh; y1 = cy + hh }
          else if (markOn && it.ring && it.ring.length > 1) {
            for (const p of it.ring) {
              const x = PX(p[0], p[1]), y = PY(p[1], p[0])
              if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x - cx) > lim) continue
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
            }
          }
          // 左右：贴边、竖直对齐框心；上下：贴边、水平对齐框心（textBaseline 是 middle，再让开半个字高）
          if (al === 'left') drawText(it.text, it.lon, it.lat, pf, color, { sx: x0 - CB_GAP, sy: cy, align: 'right', bold })
          else if (al === 'above') drawText(it.text, it.lon, it.lat, pf, color, { sx: cx, sy: y0 - CB_GAP - pf * 0.5, bold })
          else if (al === 'below') drawText(it.text, it.lon, it.lat, pf, color, { sx: cx, sy: y1 + CB_GAP + pf * 0.5, bold })
          else drawText(it.text, it.lon, it.lat, pf, color, { sx: x1 + CB_GAP, sy: cy, align: 'left', bold })
        }
      }
    }
  }
  // 数据线统一层（GXT 波束线 / 仰角线等卫星层线 / 聚焦卫星足迹与轨迹）：与 GRD 等值线、
  // Polygon 边线同一画法同一层——画在覆盖之上、above 快照（国界/省界/市界/地名）之下 → 与国界省界共存，
  // 边界压在线上仍清晰可见。各线的圆点/标签仍留在 above 层或顶层（属标注，不遮边界线）。
  // ★航迹不在此层（已提到地名之上，见 drawTrajLayer）。
  function drawDataLines() {
    // GPU 路：内容变了（setGeom / setSatLayer / setSelGeom / 改样式 / 换平面）才重打包上传，平移缩放与时间轴每拍只改 uniform。
    // 投影档「拖着转」期间（rotLive）平面逐帧在变，预投的折线对不上 → 那几帧走 Canvas2D 现投；等距圆柱不受影响（LON0 在 uniform 里）。
    if (lnOk() && (PJ.identity || !rotLive)) {
      if (dlDirty) { const g = glLines(); dlMeta = g ? g.upload(DL_KEY, packDataLines()) : null; dlDirty = !dlMeta }
      if (dlMeta && (!dlMeta.n || drawGlLineSets([{ id: DL_KEY, meta: dlMeta }], 1))) return
    }
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
        const w = Math.max(0.1, focusCfg.trkWidth), dash = DASH_2D[focusCfg.trkDash] || null
        // 轨迹面：描的是扫过区域的轮廓（两缘 + 首尾端帽弧，被别处覆盖压住的段已裁掉，见 focusSwath.swathOutline），不再描中线；
        // 当前时刻那段端帽弧与覆盖圈重合，覆盖圈层开着时由它自己描
        if (focusCfg.trkMode === 'swath' && g.swath) {
          if (g.swLines) for (const pl of g.swLines) if (pl && pl.length > 1) drawPolyline(pl, focusCfg.trkColor, w, false, dash)
        } else drawPolyline(g.track, focusCfg.trkColor, w, false, dash)
      }
    }
    ctx.globalAlpha = sa
  }
  // 轨迹面填充（与覆盖圈填充同一层）。相邻两条横断面围成一个「切片」多边形（前断面左→右、后断面右→左），
  // 同一颗星的全部切片进同一条路径、一次 fill（nonzero）：切片共边不留缝、跨圈自交处也不叠加变深。
  // ★ 为此每个切片按有向面积统一绕向 —— 绕极切片补极点边之后绕向可能反转，反转的与相邻切片重叠处 winding 归零就成了洞。
  //   绕极判据与 drawFocusFills 同：解缠后首尾经度差满一圈，补两点收到极点边上。
  // 横向断面只取到 8 段（步幅抽稀）：断面点在纬线图上只为极区拓扑与曲率服务，GEO 那几十段照搬是白画；
  // 屏幕外的切片（含 ±360 副本）整片跳过。
  // ★ 打转步（sw.skip[i]，见 focusSwath.swathLayout）不围切片，该段由圆盘环（g.swRings）补上，进同一条路径一次 fill；
  //   首尾端帽（当前时刻与轨迹末端的覆盖圈）也在 g.swRings 里。
  // ★ 覆盖圈填充开着时带面不叠到覆盖圈上（覆盖圈为准，与 3D 端模板缓冲同口径）：先按每个覆盖圈 evenodd 裁掉再填。
  //   svgcanvas 不认 evenodd 入参（见文件头），矢量导出不裁；裁剪成本按圈走，聚焦全部时圈数超 64 不裁。
  function drawFocusSwaths() {
    if (!focusCfg.trkOn || focusCfg.trkMode !== 'swath' || !(focusCfg.trkFillOpacity > 0)) return
    const kk = k()
    ctx.save()
    if (focusCfg.fpOn && focusCfg.fpFillOpacity > 0 && (!compat || rasterOut) && selGeomList.length <= 64) {
      for (const g of selGeomList) {
        const ring = g.footprint
        if (!ring || ring.length < 3) continue
        ctx.beginPath(); ctx.rect(-1, -1, cw + 2, ch + 2)
        if (PJ.identity) { const r = fpWorldRing(ring, g.sub && Number.isFinite(g.sub.lat) ? g.sub.lat >= 0 : null); traceWorldRing(r.W, r.lo, r.hi, kk, false) }
        else { _plK = kk; _plTx = tx; _plTy = ty; PJ.path(asPoly([ringCoords(ring)]), _plAdapt) }
        ctx.clip('evenodd')
      }
    }
    ctx.fillStyle = focusCfg.trkFillColor; ctx.globalAlpha = Math.max(0, Math.min(1, focusCfg.trkFillOpacity))
    for (const g of selGeomList) {
      const sw = g.swath
      if (!sw || !(sw.K >= 1) || !sw.ll) continue
      const m = sw.K + 1, n = Math.floor(sw.ll.length / (m * 2))
      const rings = g.swRings || []
      if (n < 2 && !rings.length) continue
      const step = Math.max(1, Math.ceil(sw.K / 8)), idx = [], mid = sw.K >> 1
      for (let j = 0; j < sw.K; j += step) { if (j > mid && idx[idx.length - 1] < mid) idx.push(mid); idx.push(j) }
      if (idx[idx.length - 1] < mid) idx.push(mid)   // 断面在星下点处折一下（两臂各自沿大圆，偏心轨道时两臂倾斜），抽稀时这一点不能跳过
      idx.push(sw.K)
      if (!PJ.identity) { fillSwathProj(sw.ll, m, n, idx, sw.skip, rings); continue }
      ctx.beginPath()
      let any = false
      const P = []
      for (let i = 0; i + 1 < n; i++) {
        if (sw.skip && sw.skip[i]) continue
        const A = i * m * 2, B = (i + 1) * m * 2
        P.length = 0
        // 切片环（世界度坐标：x＝相对 LON0 归一后解缠的经度，y＝90−纬度）：前断面左→右，后断面右→左
        let prev = 0, lo = 0, hi = 0, ymin = 0, ymax = 0, bad = false, cnt = 0
        const put = (o) => {
          const la = sw.ll[o], ln = sw.ll[o + 1]
          if (!Number.isFinite(la) || !Number.isFinite(ln)) { bad = true; return }
          let wx = WXN(ln)
          const y = 90 - la
          if (cnt) { while (wx - prev > 180) wx -= 360; while (wx - prev < -180) wx += 360; if (wx < lo) lo = wx; if (wx > hi) hi = wx; if (y < ymin) ymin = y; if (y > ymax) ymax = y }
          else { lo = hi = wx; ymin = ymax = y }
          P.push(wx, y); prev = wx; cnt++
        }
        for (let q = 0; q < idx.length && !bad; q++) put(A + idx[q] * 2)
        for (let q = idx.length - 1; q >= 0 && !bad; q--) put(B + idx[q] * 2)
        if (bad || cnt < 3) continue
        // 绕极：解缠后首尾经度差满一圈 → 补两点收到极点边上（南北按前断面中点＝星下点附近的纬度定）
        if (Math.abs(P[P.length - 2] - P[0]) > 300) {
          const py = sw.ll[A + (sw.K >> 1) * 2] >= 0 ? 0 : 180
          P.push(P[P.length - 2], py, P[0], py)
          if (py < ymin) ymin = py; if (py > ymax) ymax = py
        }
        let area = 0
        for (let q = 0, L = P.length; q < L; q += 2) { const r2 = (q + 2) % L; area += P[q] * P[r2 + 1] - P[r2] * P[q + 1] }
        const rev = area < 0
        for (const s of wraps()) {
          if (hi + s < 0 || lo + s > 360) continue                                            // 该副本完全在地图外
          if ((hi + s) * kk + tx < 0 || (lo + s) * kk + tx > cw || ymax * kk + ty < 0 || ymin * kk + ty > ch) continue   // 屏幕外
          if (rev) { ctx.moveTo((P[P.length - 2] + s) * kk + tx, P[P.length - 1] * kk + ty); for (let q = P.length - 4; q >= 0; q -= 2) ctx.lineTo((P[q] + s) * kk + tx, P[q + 1] * kk + ty) }
          else { ctx.moveTo((P[0] + s) * kk + tx, P[1] * kk + ty); for (let q = 2; q < P.length; q += 2) ctx.lineTo((P[q] + s) * kk + tx, P[q + 1] * kk + ty) }
          ctx.closePath(); any = true
        }
      }
      // 打转段的覆盖圆盘：与切片同一条路径、同一绕向（有向面积为正），并集一次 fill 不叠色
      for (const ring of rings) {
        if (!ring || ring.length < 3) continue
        const r = fpWorldRing(ring, null), Wp = r.W
        let area = 0
        for (let q = 0, L = Wp.length; q < L; q++) { const b = Wp[(q + 1) % L]; area += Wp[q][0] * b[1] - b[0] * Wp[q][1] }
        traceWorldRing(Wp, r.lo, r.hi, kk, area < 0); any = true
      }
      if (any) ctx.fill()
    }
    ctx.restore()
  }
  // 投影档：切片作 MultiPolygon 交给 d3（日界线切分与极点收口它自己做），每环按 orientRings 定向后一次 fill；
  // 打转步（skip[i]）不围切片，圆盘环（rings）一并进 MultiPolygon
  function fillSwathProj(ll, m, n, idx, skip, rings) {
    const polys = []
    for (const ring of (rings || [])) if (ring && ring.length >= 3) polys.push(orientRings([ringCoords(ring)]))
    for (let i = 0; i + 1 < n; i++) {
      if (skip && skip[i]) continue
      const A = i * m * 2, B = (i + 1) * m * 2, ring = []
      let bad = false
      for (let q = 0; q < idx.length && !bad; q++) { const o = A + idx[q] * 2; if (!Number.isFinite(ll[o]) || !Number.isFinite(ll[o + 1])) bad = true; else ring.push([ll[o + 1], ll[o]]) }
      for (let q = idx.length - 1; q >= 0 && !bad; q--) { const o = B + idx[q] * 2; if (!Number.isFinite(ll[o]) || !Number.isFinite(ll[o + 1])) bad = true; else ring.push([ll[o + 1], ll[o]]) }
      if (bad || ring.length < 3) continue
      ring.push(ring[0])
      polys.push(orientRings([ring]))
    }
    if (!polys.length) return
    _plK = k(); _plTx = tx; _plTy = ty
    ctx.beginPath()
    PJ.path({ type: 'MultiPolygon', coordinates: polys }, _plAdapt)
    ctx.fill()
  }
  // 覆盖圈填充（与 Polygon 区域填充同一层band：画在 GRD 覆盖场之前）。世界度坐标 + ±360 环绕副本，
  // 与 drawSatFills 同策略；★足迹可以套住极点（极轨星过极区就是），此时解缠后经度跨满 360° 且首尾不闭合
  //   —— 必须补两点收到极点边上，否则 canvas 自动收口成一条横穿地图的直边、填出一块假区域。
  // 覆盖圈（{lat,lon} 环）→ 世界度多边形 W=[[wx, y]...]（wx＝相对 LON0 解缠的经度、y＝90−纬度）与经度范围 lo/hi。
  // 绕极判据：解缠后首尾经度差满一圈（足迹环按方位等分生成，绕极时必然单调走满 360°）→ 补两点收到极点边上，
  // 南北按 north（星下点在北半球）定，没给就按环的纬度均值。
  function fpWorldRing(ring, north) {
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
    if (Math.abs(W[W.length - 1][0] - W[0][0]) > 300) {
      const py = (north != null ? north : latSum >= 0) ? 0 : 180   // y = 90 - lat
      W.push([W[W.length - 1][0], py], [W[0][0], py])
    }
    return { W, lo, hi }
  }
  // 把世界度多边形的各 ±360 副本追加进【当前路径】（不 beginPath / 不 fill，调用方决定是填还是裁）；rev＝反向绕
  function traceWorldRing(W, lo, hi, kk, rev) {
    for (const s of wraps()) {
      if (hi + s < 0 || lo + s > 360) continue   // 该副本完全在地图外 → 跳过
      if (rev) { ctx.moveTo((W[W.length - 1][0] + s) * kk + tx, W[W.length - 1][1] * kk + ty); for (let i = W.length - 2; i >= 0; i--) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty) }
      else { ctx.moveTo((W[0][0] + s) * kk + tx, W[0][1] * kk + ty); for (let i = 1; i < W.length; i++) ctx.lineTo((W[i][0] + s) * kk + tx, W[i][1] * kk + ty) }
      ctx.closePath()
    }
  }
  // {lat,lon} 环 → 闭合的 GeoJSON 坐标环 [[lon, lat]...]
  function ringCoords(ring) {
    const co = new Array(ring.length + 1)
    for (let i = 0; i < ring.length; i++) co[i] = [ring[i].lon, ring[i].lat]
    co[ring.length] = co[0]
    return co
  }
  function drawFocusFills() {
    if (!focusCfg.fpOn || !(focusCfg.fpFillOpacity > 0)) return
    const kk = k()
    ctx.save()
    ctx.fillStyle = focusCfg.fpFillColor; ctx.globalAlpha = Math.max(0, Math.min(1, focusCfg.fpFillOpacity))
    for (const g of selGeomList) {
      const ring = g.footprint
      if (!ring || ring.length < 3) continue
      if (!PJ.identity) { fillRingProj(ring, focusCfg.fpFillColor, Math.max(0, Math.min(1, focusCfg.fpFillOpacity))); continue }
      const r = fpWorldRing(ring, g.sub && Number.isFinite(g.sub.lat) ? g.sub.lat >= 0 : null)
      ctx.beginPath(); traceWorldRing(r.W, r.lo, r.hi, kk, false); ctx.fill()
    }
    ctx.restore()
  }
  // 聚焦卫星星下点图标（最上层）：按 iz=√scale 克制联动（与 2D 导出/地球站/航迹一致，防止高倍放大时
  // 膨大、更贴 3D）；多选=每颗各一个。大小/颜色取聚焦设置，单点可用 px/colorHex 覆盖（对星分析用）。
  // 对星指向（Sat-track）目标星高亮环：空心圆套在目标星星下点上，大小按 iz 联动（同卫星图标）
  function drawBoreRings() {
    if (!boreRings.length) return
    const iz = Math.sqrt(scale) * SAT_ICON_K
    ctx.save()
    for (const p of boreRings) {
      const x = PX(p.lon, p.lat), y = PY(p.lat, p.lon)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const r = Math.max(6, (Number(p.px) > 0 ? Number(p.px) : 26) * iz * 0.5)
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.lineWidth = Math.max(2.4, r * 0.2); ctx.strokeStyle = 'rgba(8,12,18,0.75)'; ctx.stroke()
      ctx.lineWidth = Math.max(1.4, r * 0.12); ctx.strokeStyle = p.color || '#ffd27a'; ctx.stroke()
    }
    ctx.restore()
  }
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
        ctx.beginPath(); ctx.arc(PX(p.lon, p.lat), PY(p.lat, p.lon), r, 0, Math.PI * 2)
        ctx.fillStyle = color; ctx.fill()
        ctx.lineWidth = Math.max(0.6, r * 0.5); ctx.strokeStyle = 'rgba(8,12,18,0.92)'; ctx.stroke()
      } else drawSatIcon(p.lon, p.lat, px * iz, color)
    }
  }

  // 把一张快照按 snapPlace 的结果贴上（调用方已置好单位变换）。
  // ★ 1:1 那条【只搬落进画布的那一块】：带余量的快照能有 2612×1468，整张搬两遍就是 7.7 MPix
  //   的白拷贝（实测把平移一帧从 1.1 ms 拖到 6.5 ms 的长尾就是它）。源与目标同尺寸、坐标又都是
  //   整数，九参与三参是同一条 1:1 快路，不引入重采样。
  //   位移正好为零（刚重建完 / 全图视角没动过）时仍走三参 —— 与改造前逐字节同一条调用。
  // 一张快照都盖不住时的垫底（§4.4）：把【世界范围】填一遍海色 —— 露出来的那一圈是海而不是
  // 深色背景（观感上的「空环」）。等距圆柱是世界矩形，投影档是图廓路径。静止后 ≤ 350 ms 归位。
  function paintOceanBase() {
    const kk = k()
    ctx.save()
    ctx.fillStyle = oceanColor
    if (PJ.identity) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); const r = worldRect(); ctx.fillRect(r.x, r.y, r.w, r.h) }
    else { ctx.setTransform(dpr * kk, 0, 0, dpr * kk, dpr * tx, dpr * ty); traceSphere(ctx); ctx.fill() }
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  // 缩位图的采样档（验证台可用 globalThis.__blitQ 覆写做对照）
  const SCALE_Q = () => globalThis.__blitQ || 'low'
  function blitSnap(cv, pl) {
    if (!pl) return
    if (pl.scaled) {
      const q = ctx.imageSmoothingQuality
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = SCALE_Q()
      ctx.drawImage(cv, pl.dx, pl.dy, pl.w, pl.h)
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = q
      return
    }
    if (!pl.dx && !pl.dy) { ctx.drawImage(cv, 0, 0); return }
    const sx = Math.max(0, -pl.dx), sy = Math.max(0, -pl.dy)
    const dx = Math.max(0, pl.dx), dy = Math.max(0, pl.dy)
    const w = Math.min(cv.width - sx, canvas.width - dx), h = Math.min(cv.height - sy, canvas.height - dy)
    if (w > 0 && h > 0) ctx.drawImage(cv, sx, sy, w, h, dx, dy, w, h)
  }
  function draw() {
    if (cw < 2 || ch < 2 || !belowCanvas) return
    const _tIn = performance.now()
    if (probeLeft > 0) probeTick(_tIn)
    // 快照怎么用（§4.1 的判定表）：
    //   内容变了            → 无条件重建
    //   平移且盖得住        → 搬位图
    //   缩放且盖得住        → 【实测便宜】的放大才同步重建（清晰优先）；其余一律缩位图 + 静止补建
    //   盖不住              → 有回退快照就垫一张；没有且便宜才同步重建；没有且贵就海色垫底（§4.4）
    // ★ 缩小一律不同步重建：缩小是降采样，缩位图不糊；放大才有清晰度收益。
    // ★ 判据是 costEst 不是 lastRebuildMs —— 后者只是「记录绘制指令」的时间，所有档都读到 1.5～6 ms。
    const cls = viewCls(), kk = k()
    let pl = staticValid ? snapPlace() : null
    let mode = 'blit', reason = '', fb = null
    const doRebuild = (why) => {
      reason = why
      renderStaticLayers(); staticValid = true
      pl = snapPlace(); fb = null
      mode = 'rebuild'
      // 增量条带那一次不进代价表：它只画一圈，按它记会把贵的类误判成便宜（放大时就会同步整份重建）
      if (!lastStrip) {
        probeLeft = PROBE_FRAMES; probeAcc = 0; probeSync = lastRebuildMs; probeCls = cls; probeT = _tIn; probeChase = 0
        armProbe()
      }
    }
    if (!pl) doRebuild('invalid')
    else if (pl.covers) {
      if (!pl.scaled) mode = 'blit'
      else if (clsCheap(cls) && kk > snapK) doRebuild('fast')
      else mode = 'scaled'
    } else {
      fb = pickFallback()
      const u = uncoveredMode(pl, !!fb, clsCheap(cls))     // 三选一的判据见 rebuildPolicy（§11.3）
      if (u === 'rebuild') doRebuild('uncovered')                // doRebuild 自己把 fb 清掉
      else { mode = pl.scaled ? 'scaled' : 'blit'; reason = u }   // 'fallback' 垫回退 / 'ocean' 垫海色
    }
    // 缩位图 / 盖不住 / 位移落不到整设备像素 / 位图搬过位置：手势停下来之后补一次精确重建。
    // ★ 「搬过位置也补」有两个理由：① 快照的余量被这趟平移吃掉了一部分，静止下来重烘一次
    //   才把四周的余量续满，下一次手势才不会当场撞上「盖不住」；② 静止画面的口径 ——
    //   搬过位置的位图上，地名避让与世界矩形裁剪是按【旧位置的视口】算的，现画一遍才是这个
    //   视图应有的那张图。补建落在【手势之外】：拖动期间 gestureHot() 恒真，idleFire 到期只会再等一拍（§4.3）。
    // ★ 判据是 pl.moved 不是 pl.dx/dy：dx 是贴图坐标（dx = rx − mx），快照带余量时一动没动也 ≠ 0
    //   → 静止时每帧 blit 都排补建、补建又催出探针帧，以 idleMs 为周期无限循环整份重建（§11.1）。
    // ★ 只在没挂着定时器时才挂（2026-09-07）：scheduleRebuild 是「清掉再计时」，每帧都调就等于每帧重新计时 ——
    //   时间轴播放（聚焦星每拍 setFocusSat → requestDraw）或任何持续重绘期间，静止补建永远轮不到，
    //   缩放后的快照就一直停在缩位图那张（影像实时画是清晰的，线却糊着）。手势的「热」由 gestureHot 判，
    //   定时器到期时自己再等一拍，不需要靠重新计时来延后。
    if (mode !== 'rebuild' && !idleTimer && needsRestRebuild(pl, tilesDirty)) scheduleRebuild()
    // 只有文字 / 标记 / 卫星层变了（invalidateText）：重画那一张就够，面与线不动
    if (mode !== 'rebuild' && !textValid) renderTextLayer()
    drawSeq++; if (mode === 'rebuild') rebuildSeq++
    const live = imgLiveNow()
    globalThis.__staticStat = { mode, reason, drawSeq, rebuildSeq, rebuildMs: lastRebuildMs, strip: lastStrip, live, rasterGapMs, costEst, nominal: +rasterNominal.toFixed(2), cls, cheap: clsCheap(cls), cost: clsCost(cls), unknown: UNKNOWN_COST, fallbacks: fallbacks.length, backplate: !!(fb && fb.f.below === bpBelow), gen: staticGen, detail: curDetail(), mx: snapMxDev, my: snapMyDev, w: belowCanvas.width, h: belowCanvas.height }
    const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
    // 复合：blit below（不透明）→ Polygon 填充 + 覆盖填充/线（夹在中间）→ blit above（透明）→ 覆盖标注 → 聚焦星
    // ★ 先铺背景色再贴：位移之后快照盖不满整块画布，露出来的那一条本就该是背景
    //   （世界矩形之外 below 上就是这个色）。余量为 0 且没位移时与老写法逐像素相同。
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = BG; ctx.fillRect(0, 0, canvas.width, canvas.height)
    // ★ 实时影像：海色 + 影像每帧画在所有快照之下（快照里世界是透明的）；缩放 / 拖动期间它永远是
    //   当前视角的真投影，不跟位图一起缩、一起糊
    if (live) {
      const _ta = performance.now(); paintOceanBase(); const _tb = performance.now(); drawImageryLive()
      globalThis.__staticStat.oceanMs = +(_tb - _ta).toFixed(1); globalThis.__staticStat.imgMs = +(performance.now() - _tb).toFixed(1)
    }
    else if (reason === 'ocean') paintOceanBase()   // 一张都盖不住：露出来的那一圈填海色而不是深色背景
    if (fb) blitSnap(fb.f.below, fb.pl)        // 回退快照垫底（below 不裁：当前快照盖在它上面）
    blitSnap(belowCanvas, pl)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawNightShade()     // 晨昏效果 + 晨昏线（最底：是「打光」不是数据，只压暗底图、不蒙灰数据层）
    drawTerminator()
    drawEnvRaster()      // ITU 环境场栅格（气象/地形是背景量，谁都压得住它）
    drawEnvContours()    // 环境场等值线 + 数值标注（紧跟其场，不与覆盖层混层）
    drawSatFills()       // Polygon 区域填充（覆盖场之下：叠加区只显示覆盖图颜色）
    drawFocusFills()     // 聚焦卫星覆盖圈填充（同上一层band，紧跟 Polygon 填充）
    drawFocusSwaths()    // 聚焦卫星轨迹面填充（与覆盖圈填充同层）
    drawCovGrid()        // STK Coverage FOM 热力图（Polygon 填充之上、GRD 覆盖场之下）
    drawField()          // GRD 覆盖填充面 + 等值线（在底图/Polygon 填充之上、标注之下）
    drawSatPolyLines()   // Polygon 边线（覆盖之上、国界/地名之下：叠加区仍见边线）
    drawDataLines()      // 波束线/仰角线/聚焦卫星线（同上：覆盖之上、国界省界之下，与边界共存；航迹另见 drawTrajLayer）
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // ★ 回退快照的 above 层必须 evenodd 裁到当前快照【之外】那一圈：不裁的话地名 / 边界线
    //   会在重叠区叠成两层、还略有错位。below 层不裁也行（当前快照直接盖住）。
    if (fb) {
      ctx.save()
      ctx.beginPath(); for (const r of clipRects(pl, canvas.width, canvas.height)) ctx.rect(r[0], r[1], r[2], r[3])
      ctx.clip('evenodd')
      blitSnap(fb.f.above, fb.pl)
      ctx.restore()
    }
    blitSnap(aboveCanvas, pl)
    blitSnap(textCanvas, pl)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
    drawFieldOverlays()   // GRD 波束名/峰值点/数值标签（覆盖层之上）
    drawSubPoint()        // 星下点标记：压在最上面，任何图层都不许盖住它
    drawFocusIcons()      // 聚焦卫星星下点图标（最上层）
    drawBoreRings()       // 对星指向目标星高亮环
    ctx.restore()
    if (dropHl) drawDropRing()   // 拖放落点高亮（实时层：按目标此刻的屏幕位置，不进快照、不进导出）
    if (globalThis.__staticStat) globalThis.__staticStat.drawMs = +(performance.now() - _tIn).toFixed(1)
  }

  // ---- 缩放进度（底部状态栏进度条）：scale[0.9,60] 对数映射到 t∈[0,1]，t=0 缩小到底、t=1 放大到底。
  // 对数映射 → 进度条每格的缩放倍率恒定，放大时绝对步进更细，支持精细化缩放。
  const SMIN = 0.9, SMAX = 60, _lnS0 = Math.log(SMIN), _lnS1 = Math.log(SMAX)
  // ★ 进度条满格是 1.2（读数 120%）：0–100% 那一段的映射一格不改（scale=60 仍是 100%），
  //   100–120% 是顺着同一条对数轴再往里延的放大余量 → 上限 60 → exp(lnSMIN + 1.2·(lnSMAX−lnSMIN)) ≈ 139×。
  const TMAX = 1.2
  const SCAP = Math.exp(_lnS0 + TMAX * (_lnS1 - _lnS0))
  const scaleToT = () => (Math.log(scale) - _lnS0) / (_lnS1 - _lnS0)
  const tToScale = (t) => clamp(Math.exp(_lnS0 + Math.max(0, Math.min(TMAX, t)) * (_lnS1 - _lnS0)), SMIN, SCAP)
  let onZoom = null
  // 一格滚轮走几个百分点（＝底部状态栏那条缩放读数的百分点数，与 ± 按钮的 0.01 同刻度、与 3D 同一口径）
  let wheelPct = 3
  // ---- 交互 ----
  function onWheel(e) {
    e.preventDefault()
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = tToScale(stepZoomT(scaleToT(), wheelNotches(e), wheelPct, TMAX))
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; noteZoom(); requestDraw()   // ★ 不作废快照：缩放期缩位图，静止后由 scheduleRebuild 补一次
    if (onZoom) onZoom(scaleToT())
  }
  // 进度条设缩放：绕画布中心缩放（锚定中心世界点），t∈[0,1]
  function setZoomT(t) {
    const mx = cw / 2, my = ch / 2, kk = k(), wx = (mx - tx) / kk, wy = (my - ty) / kk
    scale = tToScale(t)
    const k2 = k(); tx = mx - wx * k2; ty = my - wy * k2; noteZoom(); requestDraw()
  }
  // 空闲态光标：普通箭头。地图能拖，但常态给「小手」等于把「可拖」当成这张图的主要用途 ——
  // 图上还有点选 / 框选 / 放点 / 拖顶点一堆模态，各自的光标才是提示。按下之后仍给 grabbing（那是动作反馈）。
  const CUR_IDLE = 'default'
  let dragging = false, lx = 0, ly = 0
  let beamDragMode = false, onBeamDrag = null, beamDragging = false   // 拖拽波束（不平移地图）
  // 「拖着转」：左键拖动改的是【投影中心】而不是画面平移 —— 横向改中央经线（各档都有），
  // 纵向改中心纬度（只有方位等距认，见 PROJ_PARAMS）。必须是一个显式模式，否则和平移抢同一个手势。
  // 换算按【平面单位就是度】来：拖 1 像素 = 1/k() 度，于是圆心附近完全跟手（一阶精确）。
  let rotMode = false, onRotate = null, rotDragging = false
  let rotSX = 0, rotSY = 0, rotBase = null, rotPend = null, rotRaf = 0
  function rotStep() {
    rotRaf = 0
    if (!rotDragging || !rotPend || !rotBase) return
    const kk = k()
    // 往右拖 = 图跟着往右走 = 视野西移 = 中央经线减小；往下拖 = 视野北移 = 中心纬度增大。
    const dLon = (rotPend.x - rotSX) / kk
    const dLat = (rotPend.y - rotSY) / kk
    LON0 = ((rotBase.lon0 - dLon + 180) % 360 + 360) % 360 - 180
    const lat0 = Math.max(-90, Math.min(90, rotBase.lat0 + dLat))
    rebuildPlane(PJ.kind, { ...PJOPT, lat0 }, { refit: false, fast: true })
    if (onRotate) onRotate({ lon0: LON0, lat0, live: true })
  }
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
      const d = Math.hypot(PX(p[0], p[1]) - mx, PY(p[1], p[0]) - my)
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
      const dd = Math.hypot(PX(lon, lat) - mx, PY(lat, lon) - my)
      if (dd <= hit && dd < bd) { bd = dd; best = target }
    }
    // 次序＝图上的压盖次序反过来：地球站画在最上，先抓它；航点在最下，最后
    const si = stBox(iz), ptD = ptDiam(iz), idxD = idxDiam(iz)
    // 画的是模型俯视图的：抓那张图的形体中心、按它的外廓定半径（与 entityGeom 同一支；屏幕偏移折回经纬差）
    const sprTest = (kind, ent, e, target) => {
      const x = PX(e.lon, e.lat), y = PY(e.lat, e.lon)
      const sp = sprAt(kind, ent, e, northRot(e.lat, e.lon, x, y), iz, 'peek')
      if (!sp) return false
      const h = sprHit(sp), kk = Math.max(1e-6, k())
      test(e.lon + h.cx / kk, e.lat - h.cy / kk, h.d, target)
      return true
    }
    if (dragOk('station')) for (const s of mk.stations) if (s.id) {
      if (s.m2d && sprTest('station', 'st:' + s.id, s, { kind: 'station', id: s.id })) continue
      const ext = stExtent(si)
      // 天线/图钉这类「立在锚点上」的符号：抓取点按其形体中心（针尖上方半个身位），不然只有针尖那一点能抓
      test(s.lon, s.lat + (ext.up - ext.down) * 0.5 / Math.max(1e-6, k()), Math.max(ext.up + ext.down, ext.half * 2), { kind: 'station', id: s.id })
    }
    if (dragOk('point')) for (const p of mk.points) if (p.id) {
      if (p.m2d && sprTest('point', 'pt:' + p.id, p, { kind: 'point', id: p.id })) continue
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
      const xi = PX(pts[i][0], pts[i][1]), yi = PY(pts[i][1], pts[i][0]), xj = PX(pts[j][0], pts[j][1]), yj = PY(pts[j][1], pts[j][0])
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
    if (rotMode && e.button === 0) {   // 转动态：左键拖动改投影中心（不平移）
      rotDragging = true; canvas.setPointerCapture(e.pointerId)
      rotSX = e.clientX; rotSY = e.clientY
      rotBase = { lon0: LON0, lat0: optNum(PJOPT.lat0) || 0 }   // 基准钉在按下那一刻：逐帧从它算绝对量，不累加增量（累加会漂）
      canvas.style.cursor = 'grabbing'
      return
    }
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
    dragging = true; lx = e.clientX; ly = e.clientY; panQ.reset(); canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'
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
    // 转动：一帧最多重烘一次（pointermove 在高刷屏上一帧能来五六个，逐个重烘就是白算五遍同一帧）
    else if (rotDragging) { rotPend = { x: e.clientX, y: e.clientY }; if (!rotRaf) rotRaf = requestAnimationFrame(rotStep) }
    // ★ 不作废快照：平移只搬位图。tx/ty 落到整设备像素上（§4.2）—— DPR 1.25/1.5 下不取整，
    //   snapPlace 的 exact 恒为假，于是拖动中每停一下就补一次建，再拖的第一帧要等它的光栅。
    //   每次按【当前绝对值】就近取整，误差不累积。
    else if (dragging) { const q = panQ.step(tx, ty, e.clientX - lx, e.clientY - ly, dpr); tx = q[0]; ty = q[1]; lx = e.clientX; ly = e.clientY; requestDraw() }
    else if (editVerts) {   // 悬停提示：可拖顶点 / 可拖多边形内部（cursor 可覆盖命中态提示，如删除模式用 'pointer' 而非 'move'）
      canvas.style.cursor = (editVerts.move ? pointInEditPoly(e.clientX, e.clientY) : vertexAt(e.clientX, e.clientY) >= 0) ? (editVerts.cursor || 'move') : CUR_IDLE
    }
    // 悬停到可拖的标记上变手型（各模态自己的光标优先，不抢）
    else if (!beamDragMode && !labelDragMode && !boxMode && !rotMode) {
      const on = markerDragAny() && !!markerAt(e.clientX, e.clientY)
      canvas.style.cursor = on ? 'move' : (polyDrawMode || placeMode ? 'crosshair' : CUR_IDLE)
    }
    if (onHover) onHover(screenToLonLat(e.clientX, e.clientY))   // 实时经纬度（拖拽时也更新）
  }
  function onUp(e) {
    if (boxDragging) {
      boxDragging = false
      if (e && onBoxSelect) {
        const moved = Math.abs(e.clientX - boxSX) + Math.abs(e.clientY - boxSY) > 6
        const add = !!(e.ctrlKey || e.metaKey)   // Ctrl/⌘ = 累加（框选并入 / 点击增减）
        const sub = !!e.altKey                   // Alt = 减选（框住的从选区里去掉 / 点中的取消选中）
        onBoxSelect('end', moved ? { a: screenToLonLatClamp(boxSX, boxSY), b: screenToLonLatClamp(e.clientX, e.clientY), add, sub } : { add, sub, at: screenToLonLatClamp(boxSX, boxSY) })   // 原地点击带落点：命中站点=单选
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
    if (rotDragging) {   // 松手：底图回到设置的那一档，覆盖场重烘、影像重投影一并补回来
      rotDragging = false; rotPend = null
      if (rotRaf) { cancelAnimationFrame(rotRaf); rotRaf = 0 }
      rebuildPlane(PJ.kind, PJOPT, { refit: false, fast: false, term: PJ.identity })
      if (onRotate) onRotate({ lon0: LON0, lat0: optNum(PJOPT.lat0) || 0, live: false })
    }
    const wasDragging = dragging
    dragging = false; beamDragging = false; labelDragging = false; vertDragging = -1; moveDragging = false; moveLast = null; polyDrawing = false
    if (wasDragging) scheduleRebuild()   // §4.3：按着指针时不补建，松手之后按 idle 补一次
    canvas.style.cursor = (polyDrawMode || placeMode) ? 'crosshair' : (rotMode ? 'grab' : ((beamDragMode || labelDragMode) ? 'move' : CUR_IDLE))
    // 显式释放指针捕获（不只依赖 pointerup 的隐式释放）：pointercancel / 抬起点在画布外等边角情形下隐式释放可能不发生，
    // 残留捕获会把之后所有点击截给 canvas，导致输入框点不进。有 e.pointerId 就按其释放，无（onLeave 调用）则整体兜底。
    try {
      if (e && e.pointerId != null) { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId) }
    } catch { /* ignore */ }
  }
  function onLeave() { placeArmed = false; onUp(); if (onHover) onHover(null) }       // 移出地图：清空读数（放置武装作废，避免离屏误落点）
  function onDbl() { fit(); invalidateStatic(); requestDraw(); if (onZoom) onZoom(scaleToT()) }
  // 屏幕坐标 -> 经纬度（夹到地图边缘，框选角点用：框拖出地图外也取有效角）
  // 夹紧版：拖出地图边界也要给一个值（拖标记/拖顶点时手滑出去不能当场断掉）。
  // 非等距圆柱下平面不是矩形，没法按轴夹；改成【沿屏幕向图心二分】找回最近的地图内点。
  function screenToLonLatClamp(clientX, clientY) {
    const hit = screenToLonLat(clientX, clientY)
    if (hit) return hit
    const r = canvas.getBoundingClientRect(), kk = k()
    const sx = clientX - r.left, sy = clientY - r.top
    const cx = tx + PJ.W * kk / 2, cy = ty + PJ.H * kk / 2
    let a = 0, b = 1, best = null
    for (let i = 0; i < 24; i++) {
      const t = (a + b) / 2
      const q = PJ.inv((cx + (sx - cx) * t - tx) / kk, (cy + (sy - cy) * t - ty) / kk)
      if (q) { best = q; a = t } else b = t
    }
    return best ? { lon: best[0], lat: best[1] } : { lon: PJ.lon0 + 180, lat: 0 }
  }
  // 屏幕坐标 -> 经纬度（投影逆运算）；超出地图范围返回 null
  function screenToLonLat(clientX, clientY) {
    const r = canvas.getBoundingClientRect(), kk = k()
    const wx = (clientX - r.left - tx) / kk, wy = (clientY - r.top - ty) / kk
    const q = PJ.inv(wx, wy)                                    // 平面之外（信箱留白 / 圆锥扇外）返回 null
    return q ? { lon: q[0], lat: q[1] } : null
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
  canvas.style.cursor = CUR_IDLE

  // 画布位图尺寸 = CSS 尺寸 × effDpr()。窗口尺寸变化与 DPR 变化都从这里进。
  function resizeNow() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0, h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0
    if (!w || !h) return
    const firstFit = cw < 2 || ch < 2; cw = w; ch = h; dpr = effDpr()
    const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr)   // 仅在尺寸真正变化时重设位图，避免无谓清空
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh }
    // 离屏静态快照缓冲随主画布尺寸（设备像素）创建/重建
    if (!belowCanvas) { belowCanvas = document.createElement('canvas'); belowCtx = belowCanvas.getContext('2d'); aboveCanvas = document.createElement('canvas'); aboveCtx = aboveCanvas.getContext('2d') }
    if (!textCanvas) { textCanvas = document.createElement('canvas'); textCtx = textCanvas.getContext('2d') }
    // 快照尺寸由 renderStaticLayers 按余量定（可比主画布大），这里不再同步
    if (glf) glf.resize(canvas.width, canvas.height)   // GPU 填充画布与主画布同为设备像素尺寸
    invalidateStatic()
    if (firstFit) fit()
    draw()   // 同步立即重绘：canvas.width 重设会清空画布，若只 requestDraw 会隔一帧露出深色底 → 黑一下
  }
  // DPR 监听：窗口拖到另一块缩放不同的显示器、或系统改了显示缩放时，devicePixelRatio 变而 CSS 尺寸不变
  // —— ResizeObserver 那条路一声不响，位图密度就永远停在旧 DPR 上。而吸附式 effDpr 全靠 DPR 取值，
  //   停在旧值等于比例又变回非整数，正是这次要治的那件事。
  // ★ matchMedia 的 resolution 查询是唯一听得见这件事的接口；一个查询只盯一个具体的 dppx 值，
  //   故每次触发后必须照新 DPR 重新挂一次。
  const onWinFocus = () => measureNominal()
  window.addEventListener('focus', onWinFocus)
  let offDpr = null
  function watchDpr() {
    if (offDpr) { offDpr(); offDpr = null }
    let mq
    try { mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)') } catch { return }
    const on = () => { watchDpr(); resizeNow(); measureNominal() }
    mq.addEventListener('change', on)
    offDpr = () => mq.removeEventListener('change', on)
  }
  watchDpr()

  // 一级行政区数据（与 3D setProvinces 同款格式）。★ 可反复调用：多选国家时上层并成一份重新喂进来。
  function setProvinces(data) {
    prov = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 15, pri: l.pri, rk: l.rk, keep: l.keep, dx: l.dx, dy: l.dy })) } : null
    admPaths = null
    invalidateStatic(); requestDraw()
  }

  // 二级行政区数据（同上）。地名密集 → 基准 px 偏小（小空间）
  function setCities(data) {
    city = data ? { borders: data.borders || [], labels: (data.labels || []).map((l) => ({ name: l.name, lon: l.lon, lat: l.lat, px: l.px2d != null ? l.px2d : 11, pri: l.pri, rk: l.rk, keep: l.keep, dx: l.dx, dy: l.dy })) } : null
    admPaths = null
    invalidateStatic(); requestDraw()
  }

  return {
    setGeom(g) { geom = g; dlDirty = true; invalidateStatic(); requestDraw() },
    // GRD 覆盖多层：layers=[{fillBands:[{color:[r,g,b], verts:Float64Array[x,y,...], counts:Int32Array}]|null, segGroups:[...]}]；
    // opts={alpha}。setField 时把每层 fillBands 烘成各档世界坐标 Path2D 缓存（fillPaths），draw 只设变换矢量填充。整体替换。
    setField(layers, opts) {
      const src = layers || []
      fieldLayers = src.map((L, i) => makeFieldEntry(L, i))
      // 消失的层收回显存（GPU 路），并记下「几何层是不是自己拒绝了 GL」
      if (glf) glf.keepOnly(fieldLayers.filter((L) => L.fieldMesh).map((L) => L._glKey))
      { const g = glf ? glf.lines() : null; if (g) g.keepOnly([DL_KEY, ...fieldLayers.map((L) => L._lnKey).filter((x) => x != null)]) }
      glDenied = !!(src.length && fieldBackend() === 'gl' && !src.some((L) => L.fieldMesh))
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; if (opts.lineAlpha != null) fieldLineAlpha = opts.lineAlpha; fieldOpts = { ...fieldOpts, ...opts } }
      requestDraw()
    },
    // 拖拽热路径：只替换给定层（聚焦天线各波束，按 id 匹配），其余层缓存的 fillPaths / GPU 缓冲原样保留 → 不再每帧全量重建。
    patchField(layers, opts) {
      if (opts) { if (opts.alpha != null) fieldAlpha = opts.alpha; if (opts.lineAlpha != null) fieldLineAlpha = opts.lineAlpha; fieldOpts = { ...fieldOpts, ...opts } }
      for (const L of (layers || [])) {
        const i = L.id != null ? fieldLayers.findIndex((x) => x.id === L.id) : -1
        const old = i >= 0 ? fieldLayers[i] : null
        const entry = makeFieldEntry(L, i >= 0 ? i : fieldLayers.length)
        // 这一层从 GPU 路换回了 CPU 路（后端变了）：旧缓冲当场收回，别等下一次整体 setField
        if (glf && old && old._glKey != null && entry._glKey == null) glf.remove(old._glKey)
        if (glf && old && old._lnKey != null && entry._lnKey == null) { const g = glf.lines(); if (g) g.remove(old._lnKey) }
        if (i >= 0) fieldLayers[i] = entry; else fieldLayers.push(entry)
      }
      requestDraw()
    },
    setFieldAlpha(a) { fieldAlpha = a; requestDraw() },   // 仅覆盖层透明度，静态快照不变
    setFieldLineAlpha(a) { fieldLineAlpha = a; requestDraw() },   // 等值线透明度（同上：不动静态快照，也不重烘 Path2D）
    // 线宽 / 线型（样式热路径，几何层 restyleActive 调）：只改缓存的 segGroups / segPaths 的 width 与 dash，
    // Path2D 是纯几何不重烘。ids=要改的层 id 列表；byIdx=档下标 → { width, dash }（档下标在 segGroup.idx 上，没带的组不动）。
    restyleFieldLines(ids, byIdx) {
      const want = ids ? new Set(ids) : null
      for (const L of fieldLayers) {
        if (want && !want.has(L.id)) continue
        const groups = L.segGroups || [], paths = L.segPaths || []
        for (let i = 0; i < groups.length; i++) {
          const st = groups[i].idx != null ? byIdx[groups[i].idx] : null; if (!st) continue
          groups[i].width = st.width; groups[i].dash = st.dash
          if (paths[i]) { paths[i].width = st.width || 1.2; paths[i].dash = st.dash || null }
        }
        // GPU 线集合：线宽 / 线型是逐实例属性，重打包一次（几毫秒，只在拖滑杆时发生）
        if (L._lnKey != null) uploadFieldLines(L, fieldLayers.indexOf(L))
      }
      requestDraw()
    },
    // 开发 / 验证台：关掉线的 GPU 路（整条 Canvas2D 老路），用来 A/B 对拍与计时。运行时不用。
    setGlLines(v) { glLinesOn = v !== false; dlDirty = true; syncFieldLines(); requestDraw() },
    glLinesActive: () => lnOk(),
    // ---- 分带填充的后端（见文件头 glField 那段）----
    // 几何层每次组装图层前问一次：'gl' → 只出等值线 + fieldMesh；'paths' → 出老的 fillBands。不缓存。
    // nLevels 是本次的档数（超过 GL_MAX_LEVELS 退回 CPU 路）。
    fieldBackend,
    // 导出流程显式置位：exportRender 里才置的 compat 来不及给几何层看（recompute 在它之前）。
    // 置位期间 fieldBackend() 恒为 'paths' → 导出照旧走 fillBands 回放，PNG/PDF 逐字节不变。
    setExporting(v) { const nv = !!v; if (nv === exporting) return; exporting = nv; notifyBackend() },
    // 后端变了（换投影 / 导出前后 / WebGL 上下文丢失恢复）→ 宿主重算一轮几何
    setOnBackendChange(fn) { onBackendChange = typeof fn === 'function' ? fn : null },
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
    // ---- 晨昏线（分界线 + 自带的夜区阴影）----
    // date = UTC 时刻（跟随时间轴，非系统时钟）；传 null 清层。opts 同 3D：{ lineColor, lineWidth, lineOpacity, shadeColor, shadeOpacity, steps }
    //（shadeOpacity > 0 才画硬边夜区；line:false 同 null —— 老调用口径；晨昏效果的柔和夜区归 setNightShade）。
    // 采样起点钉在 LON0（地图接缝）。steps 默认 1440（0.25°/段）：平面图能放大到 60×，360 段（1°/段）在高倍下会看出折线棱角。
    // 逐帧只是 1440 次 lineTo，与覆盖分带填充比可忽略，故直接给足而不做自适应。
    setTerminator(date, opts) {
      if (opts) termOpts = { ...termOpts, ...opts }
      termDate = date && termOpts.line !== false ? date : null
      termData = termDate ? terminatorFlat(termDate, { steps: (termOpts.steps || 1440), lon0: LON0 }) : null
      requestDraw()
    },
    clearTerminator() { termData = null; termDate = null; requestDraw() },
    // ---- 晨昏效果（夜区柔和压暗）----
    // date = UTC 时刻（或直接给日下点 {lat, lon}）；传 null 清层。opts：{ color: CSS 色, opacity: 夜区最深处的不透明度 }
    setNightShade(date, opts) {
      if (opts) nightOpts = { ...nightOpts, ...opts }
      nightSub = !date ? null : (Number.isFinite(date.lat) && Number.isFinite(date.lon) ? { lat: date.lat, lon: date.lon } : solarGeometry(date instanceof Date ? date : new Date(date)).sub)
      requestDraw()
    },
    // 验证台读数：栅格规格与最近一次逆投影耗时（投影档）
    nightShadeStats: () => ({ on: !!nightSub, eq: nightEq ? { w: NIGHT_EQ_W, h: NIGHT_EQ_H } : null, pj: nightPj ? { w: nightPj.RW, h: nightPj.RH, buildMs: nightPj.buildMs, shape: nightPj.shape } : null }),
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
    // 岛链：{ on, off, color, width, opacity, dash, name, nameSize, nameBold } 一次给，只改给到的那几项
    setChains(o) {
      if (!o) return
      if (o.off) { chainOff = { ...o.off }; chains = chainList(chainOff); chainLbl = chainLbls() }
      for (const k of ['on', 'color', 'width', 'opacity', 'dash', 'name', 'nameSize', 'nameBold']) if (o[k] != null) chainCfg[k] = o[k]
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
      const prevSet = imgSet
      if (o.set !== undefined) imgSet = o.set || null
      if (o.img !== undefined) imgEl = o.img || null
      if (o.on != null) imgOn = !!o.on
      if (o.maxZ != null && Number.isFinite(o.maxZ)) imgMaxZ = Math.max(0, Math.min(11, o.maxZ | 0))   // 上限 11：GIBS 的 31.25m 矩阵集到 L11（30.6 m/px），是其真彩天花板
      if (o.bright != null) imgBright = Math.max(0.05, Math.min(2, Number(o.bright) || 1))
      if (imgSet !== prevSet) {
        // 换集 / 进出瓦片档：投影档的分桶网格与 CPU 烘图都按集缓存，片纹理 LRU 一并清
        rmKeyT = ''; rmBoxT = null; rmBinsT = null; rpKey = ''; rpBox = null
        meshBlockCache.clear(); imgLiveOff = false; lastPlanZ = -1
        if (glr) glr.clearTiles()
        // 进瓦片路先把 L2 那 15 片拉进来（与 3D 底层同口径）：首帧有粗档兜底，不是矢量底图闪一下
        if (imgSet) warmTiles(imgSet, 2, onTileReady)
      }
      invalidateStatic(); requestDraw()
    },
    // 大地颜色（基调方案 + 逐国覆盖，与 3D 同步）：写入公共色板状态后重建陆地 Path2D 并重绘静态层
    setLandColors(s) { setLandPalette(s); geoCache.clear(); buildBaseGeo(resolvedFeatures(curDetail()), curThin()); invalidateStatic(); requestDraw() },
    setOnRightClick(fn) { onRightClick = fn },
    setOnHover(fn) { onHover = fn },
    // 缩放进度条接口：getZoom 读当前进度、setZoom 设到进度 t、setOnZoom 注册滚轮缩放回填回调
    getZoom: () => scaleToT(),
    setZoom: (t) => setZoomT(t),
    setWheelStep(p) { if (Number.isFinite(p)) wheelPct = Math.max(1, Math.min(20, Math.round(p))) },
    setOnZoom(fn) { onZoom = fn },
    // 覆盖填充用：屏上尺度（1° 纬度占多少【设备像素】），供 useGrdCoverage.autoStride 按屏定三角化步长。
    // ★ 必须是 O(1) 且不碰 DOM：拖拽时每帧都要问一次。早先写成「屏幕探针逐点反算」——26 个采样点
    //   各自 getBoundingClientRect + 逆投影，每帧几十次强制重排，2D 拖拽当场卡死。
    //   k() 是每个投影单位多少 CSS 像素；PJ.H 个单位铺满 180° 纬度（等距圆柱恰为 1 单位 = 1°，
    //   其余投影是量级近似——定步长只需要量级，不需要精确。
    viewMetrics() {
      const kk = k()
      return kk > 0 ? { pxPerDeg: kk * (PJ.H / 180) * dpr } : null
    },
    // 完整视图记忆：缩放 scale + 画面中心的「世界坐标」(cx=lon-LON0, cy=90-lat)。
    // 用世界中心点而非 tx/ty → 窗口尺寸变化后仍能复原到同一地理中心。setView 需在 resize 后调用（base 已就绪）。
    getView() { const kk = k(); return { scale, cx: (cw / 2 - tx) / kk, cy: (ch / 2 - ty) / kk } },
    // 键盘方向键：把视窗中心按屏幕像素平移（dxPx 右为正 → 中心东移，dyPx 下为正 → 中心南移）。
    // tx/ty 为 CSS 像素平移量（与鼠标拖拽同一坐标系），故与缩放无关：每次移动固定屏幕距离。
    panByPixels(dxPx, dyPx) {
      const dx = Number.isFinite(dxPx) ? dxPx : 0, dy = Number.isFinite(dyPx) ? dyPx : 0
      if (!dx && !dy) return
      const q = panQ.step(tx, ty, -dx, -dy, dpr); tx = q[0]; ty = q[1]   // §4.2：整设备像素
      requestDraw()
    },
    setView(v) {
      if (!v || !Number.isFinite(v.scale)) return
      scale = clamp(v.scale, SMIN, SCAP)
      const kk = k()
      if (Number.isFinite(v.cx)) tx = cw / 2 - v.cx * kk
      if (Number.isFinite(v.cy)) ty = ch / 2 - v.cy * kk
      requestDraw()
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
      borderPaths = null; geoCache.clear()
      buildBaseGeo(resolvedFeatures(detail), t)
      invalidateStatic(); requestDraw()
    },
    // 切口经度（左边缘经度，−180..180）。★ 面板上填的是【画面中心】，切口 = 中心 − 180（见 stores/mapCrs）。
    // 世界度坐标 x = lon − LON0 是烘在 Path2D 里的，
    // 故改切口要把陆地/边界线/覆盖场/等值线全部重烘，再 fit 一次把新接缝放到边上。
    // keepView=true：只换平面，【不动视图】——缩放与平移原样留着。
    // ★ 跟随星下点非用它不可：默认那条会 fit() 一次，于是时间轴每跳一下缩放就被打回全图，
    //   用户放大看的那一块当场没了。
    // opts（可选）：连投影参数一起换（跟随星下点 = 切口 + 中心纬度一起动），只重建一次；不给就沿用当前参数
    setLon0(v, keepView, opts) {
      const nv = Number(v)
      if (!Number.isFinite(nv)) return
      const w = ((nv + 180) % 360 + 360) % 360 - 180
      const op = opts || PJOPT
      if (Math.abs(w - LON0) < 1e-9) {
        if (opts && !samePlaneOpts(op)) rebuildPlane(PJ.kind, op, { refit: false })
        return
      }
      LON0 = w
      // 切口即中央经线，投影跟着重造。夜区采样起点钉在 LON0，作废后下一拍 setTerminator 按新切口重算
      rebuildPlane(PJ.kind, op, { term: true, refit: !keepView })
    },
    getLon0: () => LON0,
    // 2D 投影档。与 setLon0 同一条通路：世界平面变了 → 陆地 / 五类边界线 / 覆盖场 / 等值线
    // 全部重烘，经纬网缓存作废，再 fit 一次把新平面摆进画布。
    // ★ 出厂 'equirect' 走的是换投影前那条一行没改的老路（PJ.identity），逐位相同。
    setProjection(kind, opts) {
      const kd = isProjection(kind) ? kind : DEFAULT_PROJECTION
      const op = opts || PJOPT
      if (kd === PJ.kind && samePlaneOpts(op)) return
      rebuildPlane(kd, op, { refit: kd !== PJ.kind })
    },
    getProjection: () => PJ.kind,
    // 只换参数不换档（中心纬度 / 标准纬线）。fast=true 走「拖着转」的轻量档：
    // 底图降到 110m、覆盖场不重烘，松手时再补一次全量（见 setRotateMode）。
    setProjParams(opts, fast) {
      if (!opts || samePlaneOpts(opts)) return
      rebuildPlane(PJ.kind, opts, { refit: false, fast: !!fast })
    },
    getProjParams: () => ({ ...PJOPT }),
    // 星下点标记。{lon, lat, name} 或 null；只画一个记号，不进任何几何计算。
    setSubPoint(v) {
      const nv = (v && Number.isFinite(v.lon) && Number.isFinite(v.lat)) ? { lon: v.lon, lat: v.lat, name: v.name || '' } : null
      const same = (!nv && !subPt) || (nv && subPt && nv.lon === subPt.lon && nv.lat === subPt.lat && nv.name === subPt.name)
      if (same) return
      subPt = nv
      requestDraw()      // ★ 只是最上层的一个记号，不必 invalidateStatic（静态层没它的份）
    },
    // 「拖着转」模式。开启后左键拖动改投影中心（不平移地图），回调 onRotate({lon0, lat0, live})：
    // live=true 是拖动过程中的每一帧（外面据此更新读数，别落库），live=false 是松手那一次（该落库了）。
    setRotateMode(v) {
      rotMode = !!v
      // ★ 先把 110m 那份取回来：没加载过时 resolvedFeatures('110m') 会回落到 10m（B() 的兜底），
      //   于是「降档提速」反倒变成拿最重的一档逐帧重烘。开模式时预热，拖起来才是 5.6 ms 那一档。
      if (rotMode) ensureDetail('110m').catch(() => {})
      if (!rotMode && rotDragging) onUp()
      canvas.style.cursor = polyDrawMode ? 'crosshair' : (rotMode ? 'grab' : ((beamDragMode || labelDragMode) ? 'move' : CUR_IDLE))
    },
    setOnRotate(fn) { onRotate = fn },
    setBeamDragMode(v) { beamDragMode = !!v; beamDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || labelDragMode) ? 'move' : CUR_IDLE) },
    setOnBeamDrag(fn) { onBeamDrag = fn },
    setLabelDragMode(v) { labelDragMode = !!v; labelDragging = false; canvas.style.cursor = polyDrawMode ? 'crosshair' : ((v || beamDragMode) ? 'move' : CUR_IDLE) },
    setOnLabelDrag(fn) { onLabelDrag = fn },
    // 协调区多边形 hold-to-draw 模式：开启后左键按住沿路径连续加点
    setPolyDrawMode(v) { polyDrawMode = !!v; polyDrawing = false; canvas.style.cursor = v ? 'crosshair' : (beamDragMode ? 'move' : CUR_IDLE) },
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
      if (!editVerts) canvas.style.cursor = placeMode ? 'crosshair' : (beamDragMode ? 'move' : CUR_IDLE)
    },
    setOnVertexDrag(fn) { onVertexDrag = fn },
    // 放置模式（波束合成）：左键点击落点；拖动仍平移
    setPlaceMode(v) { placeMode = !!v; placeArmed = false; canvas.style.cursor = placeMode ? 'crosshair' : (polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : CUR_IDLE)) },
    setOnPlace(fn) { onPlace = fn },
    // 框选模式（站点栅编辑）：左键拖矩形选站；开启期间不平移
    setBoxSelectMode(v) { boxMode = !!v; boxDragging = false; canvas.style.cursor = boxMode ? 'crosshair' : (placeMode || polyDrawMode ? 'crosshair' : ((beamDragMode || labelDragMode) ? 'move' : CUR_IDLE)) },
    setOnBoxSelect(fn) { onBoxSelect = fn },
    setOnPolyMove(fn) { onPolyMove = fn },
    // ★ 标记 / 标记样式 / 卫星层只住在文字那一张快照里：只重画它（几毫秒），面与线、回退快照都不动 ——
    //   这三样随时间轴每拍都会被页面重推一次（标记仰角、卫星图标），按内容作废就是每拍一次 100 ms 的整份重建。
    setMarkers(points, stations, trajectories) { mk = { points: points || [], stations: stations || [], trajectories: trajectories || [] }; invalidateText(); requestDraw() },
    // 标记实体（P4）：运动档载具状态 —— list = [{ id, lat, lon, headingDeg }]（只含运动档）或 null；条目复用。
    // 没变就不作废文字快照（页面每拍都调，静止档航迹时它是空表 → 一次重画都不多）
    setVehicleStates(list) {
      const g = ++vehGen
      let changed = false
      if (Array.isArray(list)) for (const it of list) {
        if (!it || it.id == null) continue
        const lat = +it.lat, lon = +it.lon, hd = Number.isFinite(it.headingDeg) ? +it.headingDeg : 0
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
        let e = vehStates.get(it.id)
        if (!e) { e = { lat, lon, headingDeg: hd, gen: g }; vehStates.set(it.id, e); changed = true; continue }
        if (e.lat !== lat || e.lon !== lon || e.headingDeg !== hd) { e.lat = lat; e.lon = lon; e.headingDeg = hd; changed = true }
        e.gen = g
      }
      for (const [id, e] of vehStates) if (e.gen !== g) { vehStates.delete(id); changed = true }
      if (changed) { invalidateText(); requestDraw() }
    },
    // 标记实体的模型俯视图出图器（viz/flatmap/entitySprites.js 的实例；null = 摘掉，一律画通用符号）。它出好一批图就回调 → 只重画文字层
    setEntitySprites(p) {
      if (entSpr === (p || null)) return
      if (entSpr && entSpr.setOnChange) entSpr.setOnChange(null)
      entSpr = p || null
      if (entSpr && entSpr.setOnChange) entSpr.setOnChange(() => { if (!dead) { invalidateText(); requestDraw() } })
      invalidateText(); requestDraw()
    },
    // 挂了模型的站此刻对星的画面口径方位 / 仰角（度）：list = [{ id, az, el, park }]（页面每拍推，只含挂了模型的站；条目复用）。
    // 模型俯视图里碟面按它摆（出图器按 2° 分档出图）；变化不到 0.2° 不作废文字快照 —— 盯 GEO 的站每拍都是同一组角
    setStationAims(list) {
      const g = ++aimGen
      let changed = false
      const near = (a, b) => (a !== a && b !== b) || Math.abs(a - b) <= 0.2
      if (Array.isArray(list)) for (const it of list) {
        if (!it || it.id == null) continue
        const az = Number.isFinite(it.az) ? +it.az : NaN, el = Number.isFinite(it.el) ? +it.el : NaN, pk = !!it.park
        let e = stAims.get(it.id)
        if (!e) { e = { az, el, park: pk, gen: g }; stAims.set(it.id, e); changed = true; continue }
        if (!near(e.az, az) || !near(e.el, el) || e.park !== pk) { e.az = az; e.el = el; e.park = pk; changed = true }
        e.gen = g
      }
      for (const [id, e] of stAims) if (e.gen !== g) { stAims.delete(id); changed = true }
      if (changed && entSpr) { invalidateText(); requestDraw() }
    },
    // 拖放命中（不受「调整位置」门控）：{ kind: 'station'|'point'|'vehicle', id, x, y, px } | null；kinds 里的 'sat' 忽略（2D 没有卫星拾取）
    entityAtScreen,
    // 拖放落点高亮：hit = entityAtScreen 的结果或 null；o.color 缺省 #4da3ff（页面传 accent）
    setDropHighlight(hit, o) {
      const next = hit && hit.kind && hit.id != null ? { kind: hit.kind, id: hit.id, px: Number(hit.px) > 0 ? Number(hit.px) : 24, color: (o && o.color) || '#4da3ff' } : null
      if (!next && !dropHl) return
      dropHl = next
      requestDraw()
    },
    // 性能指标表的城市层（指向误差框 + 城市标签），与标记同住文字快照
    setCityBoxes(list) { cityBoxes = Array.isArray(list) ? list : []; invalidateText(); requestDraw() },
    // 标记层样式（与 3D 同一份设置，见 markCfg）
    setMarkStyle(cfg) { Object.assign(markCfg, cfg || {}); invalidateText(); requestDraw() },
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
    setBoreRings(p) { boreRings = (Array.isArray(p) ? p : []).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon)); requestDraw() },
    setFocusSat(p) { focusSats = (Array.isArray(p) ? p : (p ? [p] : [])).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon)); requestDraw() },
    // g：单个 {footprint,track} 或数组（多选=每颗都画），随时间实时，不入快照
    setSelGeom(g) { selGeomList = Array.isArray(g) ? g.filter(Boolean) : (g ? [g] : []); dlDirty = true; requestDraw() },
    // 聚焦卫星显示样式（轨道线只在 3D 有，这里收轨迹/覆盖圈/星下点图标三项）
    setFocusStyle(s) { Object.assign(focusCfg, s || {}); dlDirty = true; requestDraw() },
    setSatLayer(spec) { satLayer = spec; dlDirty = true; invalidateText(); requestDraw() },
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
      let plan = null, zT = -1, tilesT = null
      try {
        if (PJ.identity) plan = imageryPlan()
        else {
          // 投影档：按【导出视图】算分桶，把片等到位 —— 屏上缓存里的片比导出要的粗好几级
          const kk = k(), F = kk > 0 ? rasterFrame(kk) : null
          if (F) { zT = tileZ(kk); tilesT = planTileBins(F, bakeRes(F, kk), zT).tiles }
        }
      } finally {
        dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty
      }
      if (plan && plan.items.length) await loadTiles(imgSet, plan.z, plan.items)
      if (tilesT && tilesT.length) await loadTiles(imgSet, zT, tilesT)
    },
    // 矢量导出（PDF）的影像底图：把这次出图要用的瓦片【预合成成一张位图】，再由 exportRender 当作
    // 单张 <image> 垫在最底下。返回 Image（已 decode）或 null（没开影像 / 一片都没取到）。
    // ★ 不逐片贴：几十上百片各自一个 base64 <image>，SVG 体积炸掉，且片边被 svg2pdf 取整后海面上
    //   会留一格一格的白缝。整层一张只有一个 <image>，位置与页面 1:1。
    // ★ 用 JPEG 不是图省事：同一张 7680×3840 的真彩影像，PNG base64 约 60 MB（SVG 直接不可用），
    //   JPEG q0.86 约 4 MB。影像本就是有损来源，再压一道肉眼分不出。
    // px = 合成位图的目标宽（默认 7680，与「8K PNG」同一档）：这一个数决定 PDF 放大到多少倍
    // 影像层还不糊 —— 页宽 1200pt 时即 6.4×，超过它才开始软。矢量层不受此限，照旧无限清晰。
    async bakeImagery(opts) {
      if (!imgOn || !(imgSet || imgEl)) return null
      const o = opts || {}
      const W = Math.max(1, Math.round(o.width || cw)), H = Math.max(1, Math.round(o.height || ch))
      // 画布面积封顶同 renderFlatPNG：撞上 Chromium 的 268 MPix，toDataURL 直接返回空图
      let ps = Math.max(1, (o.px > 0 ? o.px : 7680) / W)
      ps = Math.min(ps, Math.sqrt(268435456 / (W * H)))
      await this.ensureImagery({ width: W, height: H, pixelScale: ps, view: o.view })
      // ★ 恒走 CPU 路：这张图是矢量 PDF 的影像底图，PNG/PDF 逐字节一致是硬约束。
      //   宿主（ConstellationMap3D）在导出前本来就置了 exporting，这里再钉一次 —— 别的调用方
      //   （验证台直接调 renderFlatPDF）没置位时也不会悄悄换成 GPU 出的那一张。
      const SV = { ctx, dpr, cw, ch, base, scale, tx, ty, exporting }
      exporting = true
      const cvI = document.createElement('canvas')
      cvI.width = Math.round(W * ps); cvI.height = Math.round(H * ps)
      let painted = false
      try {
        ctx = cvI.getContext('2d'); dpr = ps
        if (o.view !== true) { cw = W; ch = H; fit() }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.fillStyle = oceanColor; ctx.fillRect(0, 0, cw, ch)   // JPEG 没有 alpha：缺片处露海色，不是一块黑
        painted = drawImagery()
      } finally {
        ctx = SV.ctx; dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty; exporting = SV.exporting
      }
      if (!painted) return null
      const img = new Image()
      img.src = cvI.toDataURL('image/jpeg', 0.86)
      await img.decode()
      img.bakedPx = cvI.width      // 调用方据此如实报出「影像层实际多少像素宽」
      return img
    },
    // 当前底图精细化档（导出前临时换成最细、用完复位，见 exportFlat 的 withFinestBasemap）
    getMapDetail: () => ({ detail: mapDetail0, thin: mapThin }),
    exportRender(targetCtx, opts) {
      const o = opts || {}
      // view=true：所见即所得，保留当前 base/scale/tx/ty 与屏幕 cw/ch，仅按 pixelScale 放大输出；
      // 否则：整幅世界图，重置 cw/ch=W/H 后 fit() 一次。
      const viewMode = o.view === true
      const W = o.width || 1600, H = o.height || (W / 2), ps = o.pixelScale || 1
      const SV = { ctx, dpr, cw, ch, base, scale, tx, ty, font: textFont, fontLatin: textFontLatin }
      ctx = targetCtx; dpr = ps; compat = true; rasterOut = o.raster === true
      vecImg = (!rasterOut && o.imagery) ? o.imagery : null   // 矢量导出的影像底图（见 bakeImagery）
      if (o.fontFamily) textFont = o.fontFamily
      if (o.fontFamilyLatin) textFontLatin = o.fontFamilyLatin
      if (viewMode) { /* 保留当前屏幕视图（cw/ch/base/scale/tx/ty 不变） */ }
      else { cw = W; ch = H; fit() }
      const _wr = worldRect(), rx = _wr.x, ry = _wr.y, rw = _wr.w, rh = _wr.h   // 裁到世界矩形：整幅图只此一张
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (o.background !== false) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch) }
      drawBelowContent(rx, ry, rw, rh)
      // 层序必须与 draw() 逐字一致（所见即所得）：晨昏线夜区打头，与屏幕上同为最底层
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip(); drawNightShade(); drawTerminator(); drawEnvRaster(); drawEnvContours(); drawSatFills(); drawFocusFills(); drawFocusSwaths(); drawCovGrid(); drawField(); drawSatPolyLines(); drawDataLines(); ctx.restore()
      drawAboveContent(rx, ry, rw, rh)
      ctx.save(); ctx.beginPath(); ctx.rect(rx, ry, rw, rh); ctx.clip()
      drawFieldOverlays()
      drawSubPoint()
      drawFocusIcons()
      drawBoreRings()
      ctx.restore()
      ctx = SV.ctx; dpr = SV.dpr; cw = SV.cw; ch = SV.ch; base = SV.base; scale = SV.scale; tx = SV.tx; ty = SV.ty; textFont = SV.font; textFontLatin = SV.fontLatin; compat = false; rasterOut = false; vecImg = null
      staticValid = false; requestDraw()
    },
    // 销毁：退订主权解算层的广播（不退的话卸载后的画布仍会被换视角触发重建）与 DPR 监听，再摘画布事件。
    // ★ 这里原本有【两个 destroy 键落在同一个对象字面量里】，后一个把前一个整个盖掉 —— offPov()
    //   从来没被调用过，卸载后的实例仍挂在主权解算层的广播上。已并成这一个。
    destroy() {
      dead = true
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = 0 }
      if (tileTimer) { clearTimeout(tileTimer); tileTimer = 0 }        // 瓦片到货去抖：到期会 rebuildAtRest + 重绘
      if (imgLiveOffTimer) { clearTimeout(imgLiveOffTimer); imgLiveOffTimer = 0 }
      if (diskIdleT) { clearTimeout(diskIdleT); diskIdleT = 0 }
      if (rotRaf) { cancelAnimationFrame(rotRaf); rotRaf = 0 }
      if (glf) { glf.dispose(); glf = null }
      if (glr) { glr.dispose(); glr = null }
      offPov()
      if (offDpr) { offDpr(); offDpr = null }
      window.removeEventListener('focus', onWinFocus)
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onCtx)
    }
  }
}
