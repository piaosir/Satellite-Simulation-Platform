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

console.log('\n' + (fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
