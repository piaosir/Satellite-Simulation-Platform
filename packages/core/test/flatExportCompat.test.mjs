// 2D 平面图矢量导出（PDF）的「回放兼容」不变量。运行：npm test
//
// 为什么要有这一份：矢量 PDF 走 svgcanvas 录制，而 svgcanvas 的 fill()/stroke()/clip()【忽略
// Path2D 入参】—— 递给它一个 Path2D 不会报错，它转而把「上一个元素」的路径重描一遍。于是那一层
// 在 PDF 里整个消失，PNG 却好好的（真 canvas 认这个入参）。2026-09 就是这么丢掉了五类边界线：
// 导出的地图上一条海岸线、一条国界都没有，只剩几块色斑，而且没有任何报错。
//
// 判据是源码级的：flatCoverage.js 里凡是给 fill/stroke/clip 递了参数的那一行，都必须落在
// `if (compat)` 的【else】分支里（即只在非导出路径上走 Path2D）。这条比逐像素比图便宜得多，
// 也正好卡在会犯错的那一步上：新写一层时顺手 `ctx.fill(path)`，这里当场红。
//
// 另外两条同源的不变量：
//   · bakeBorders 必须同时存下点列（pts）—— compat 分支要按点回放，只有 Path2D 是放不出来的
//   · 出图必须恒用最细底图（exportFlat 的 withFinestBasemap）—— 屏上那档是给帧率的，
//     50m 的海岸线一放大就是折线（「一放大细节就差了」）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { groupLandForExport } from '../../../src/viz/flatmap/landGroups.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const FLAT = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'flatCoverage.js'), 'utf8')
const EXPORT = readFileSync(join(ROOT, 'src', 'viz', 'flatmap', 'exportFlat.js'), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

// ---------- ① 带入参的 fill/stroke/clip 一律要有 compat 分支 ----------
// 判据：从该行往上找到本函数开头之前，必须出现过 `if (compat)`。抓的是「新写一层时顺手
// ctx.fill(path)、压根没写回放分支」这一种 —— 那正是丢掉五类边界线的写法。
const lines = FLAT.split(/\r?\n/)
const PATH_ARG = /\bctx\.(fill|stroke|clip)\(\s*[A-Za-z_$]/          // ctx.fill(sh.path) / ctx.stroke(p) …
const FN_HEAD = /^\s{0,2}function\s+\w+\s*\(/    // 顶层（缩进 ≤2）的具名函数才算函数头，回调箭头不算
const hits = [], offenders = []
lines.forEach((ln, i) => {
  if (!PATH_ARG.test(ln)) return
  hits.push(i + 1)
  for (let j = i; j >= 0; j--) {
    if (/if \(compat\)/.test(lines[j])) return                       // 本函数里有回放分支
    if (j < i && FN_HEAD.test(lines[j])) break                       // 退到函数头还没见到 → 没有
  }
  offenders.push((i + 1) + ': ' + ln.trim().slice(0, 110))
})
ok('① 递 Path2D 的 fill/stroke/clip 都落在 compat 的非导出分支里',
  offenders.length === 0,
  offenders.length ? '\n      ' + offenders.join('\n      ') : '共 ' + hits.length + ' 处，所在函数都有 if (compat) 回放分支')

// ---------- ② 五类边界线的点列存下来了 ----------
// bakeBorders 只存 Path2D 的话，compat 分支无从回放 —— 这一条钉的是「pts 不许被当成冗余删掉」。
const bake = /function bakeBorders\s*\(\)\s*\{[\s\S]*?\n  \}/.exec(FLAT)
ok('② bakeBorders 存下回放用的点列', !!bake && /\bpts\b/.test(bake[0]) && /Float64Array/.test(bake[0]),
  bake ? '' : '没找到 bakeBorders')
const draw = /function drawBorders\s*\(\)\s*\{[\s\S]*?\n  \}/.exec(FLAT)
ok('③ drawBorders 有 compat 回放分支', !!draw && /if \(compat\)/.test(draw[0]) && /sh\.pts/.test(draw[0]),
  draw ? '' : '没找到 drawBorders')

// ---------- ③ 影像底图在矢量导出里不掉层 ----------
ok('④ 矢量导出有预合成的影像底图（bakeImagery + vecImg）',
  /bakeImagery\s*\(/.test(FLAT) && /\bvecImg\b/.test(FLAT) && /imagery/.test(EXPORT),
  '整层合成一张 JPEG 垫底，不是逐片塞进 SVG')
ok('⑤ drawBelowContent 的影像判据认 vecImg', /rasterOut \|\| vecImg/.test(FLAT))

// ---------- ④ 出图恒用最细底图 ----------
ok('⑥ exportFlat 有 withFinestBasemap 并强制 10m', /withFinestBasemap/.test(EXPORT) && /setMapDetail\('10m', 0\)/.test(EXPORT))
const wrapped = (EXPORT.match(/return withFinestBasemap\(flat/g) || []).length
ok('⑦ PNG 与 PDF 两条路都套上了它（否则两份出图一细一粗）', wrapped === 2, '套了 ' + wrapped + ' 处')
ok('⑧ 用完复位屏上精度', /finally \{ if \(need\) await flat\.setMapDetail\(cur\.detail, cur\.thin\) \}/.test(EXPORT))

// ---------- ⑤ 争议叠加面不并入同色 path ----------
// 导出把同色陆地面合并成一条 evenodd path（省 svg2pdf 的节点数），前提是同一条 path 里的面互不重叠。
// 争议叠加面（resolvedFeatures 的 over:true，如藏南 / 典角）整块落在宿主面（印度）之内 —— 统一底色下两者
// 同色，并进同一条 path 后重叠处被算成偶数次 → 抠成洞，导出的 PNG/PDF 上是一块海色补丁，屏上却没有
// （屏上逐面 fill(Path2D)）。2026-09 用户截图里藏南 / 典角一带的蓝斑就是它。分组口径见 landGroups.js。
{
  const C = '#e4eccf'
  const host = { lo: 60, hi: 100, rings: [[[60, 0], [100, 0], [100, 40], [60, 40]]] }        // 宿主（印度）
  const over = { lo: 90, hi: 96, rings: [[[90, 10], [96, 10], [96, 16], [90, 16]]] }         // 叠加（藏南），与宿主同色
  const other = { lo: 200, hi: 220, rings: [[[200, 0], [220, 0], [220, 20], [200, 20]]] }    // 别国，另一色
  const far = { lo: 400, hi: 420, rings: [[[400, 0], [420, 0], [420, 20], [400, 20]]] }      // 视口之外
  const land = [
    { shapes: [host, far], fill: C, over: false },
    { shapes: [other], fill: '#b0a98f', over: false },
    { shapes: [over], fill: C, over: true }
  ]
  const r = groupLandForExport(land, 0, 0, 360)
  ok('⑨ 叠加面不进同色 path：同色组只含宿主，叠加面单列',
    r.groups.length === 2 && r.groups[0].fill === C && r.groups[0].shapes.length === 1 && r.groups[0].shapes[0] === host &&
    r.overs.length === 1 && r.overs[0].shape === over && r.overs[0].fill === C)
  ok('⑩ 视口裁剪与实时路径同判据（视口外的面不进任何组）', !r.groups.some((g) => g.shapes.includes(far)) && !r.overs.some((o) => o.shape === far))
  ok('⑪ 经度环绕偏移参与裁剪（off=360 时同一批面整体移出视口）', groupLandForExport(land, 360, 0, 360).groups.length === 0)
  // 源码级：over 标记要从 resolvedFeatures 一路带到 land，drawLand 的 compat 分支要分两步画（基础组 → 叠加面）
  const bbg = /function buildBaseGeo\s*\([\s\S]*?\n  \}/.exec(FLAT)
  ok('⑫ buildBaseGeo 把 over 标记带进 land 的每一条', !!bbg && (bbg[0].match(/land\.push\(\{[^}]*\bover\b/g) || []).length === 3,
    bbg ? '' : '没找到 buildBaseGeo')
  const dl = /function drawLand\s*\(\)\s*\{[\s\S]*?\n  \}/.exec(FLAT)
  ok('⑬ drawLand 的 compat 分支走 groupLandForExport，叠加面逐面单独 fill', !!dl && /groupLandForExport\(land/.test(dl[0]) && /for \(const o of overs\)/.test(dl[0]),
    dl ? '' : '没找到 drawLand')
}

console.log('\n' + (fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
