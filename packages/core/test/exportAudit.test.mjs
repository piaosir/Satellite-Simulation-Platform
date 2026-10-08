// 导出（PNG / PDF）2026-10-07 审查修掉的八处，源码级不变量。运行：npm test
//
// 每一条都是「出图看着正常、其实少了 / 糊了 / 字体不对 / 静默失败」那一类，屏上看不出来，只有对着导出件才发现：
//   ① 矢量 PDF + 影像底图 + 投影档（罗宾逊 / 方位等距…）：预合成的影像 JPEG 是整块矩形，不按图廓裁剪 → 图廓外四角全是海色
//   ② 全球图画幅按投影平面的实际宽高比取（方位等距是圆盘，写死 2:1 时两侧各空四分之一）
//   ③ 平面渲染器是懒创建的：之前算出的覆盖分析热力图 / 图上链路，feedFlat 要补推，否则全球图导出缺层
//   ④ 3D 截图降档：下一档直接取浏览器给的上限（fit），不再与 s × 0.8 取小
//   ⑤ 3D 截图：影像瓦片按出图分辨率重新选级并等片到位（同 2D 的 ensureImagery）
//   ⑥ 保存框预填文件名：/ \ 在 Windows 上被当路径分隔（「合计 C/N.png」只剩「N.png」）→ 主进程统一清洗
//   ⑦ file:save 写失败不抛、只回 {ok:false,error}：出图的调用方必须看返回值
//   ⑧ C/I 出图：不逐节点内联 font-family，否则根节点的报告字体被屏上无衬线盖掉
// 逐像素的复验在会话验证台里做过（等距圆柱差异不变；方位等距 10.6% → 0.3%、罗宾逊 12.3% → 0.26%）；
// 这里只卡「写法」，代价是零，回退其中任何一处这里当场红。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const src = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const FLAT = src('src', 'viz', 'flatmap', 'flatCoverage.js')
const SCENE = src('src', 'viz', 'globe3d', 'scene.js')
const PAGE = src('src', 'pages', 'ConstellationMap3D.vue')
const IPC = src('electron', 'ipc', 'register.js')
const CI = src('src', 'ci', 'ciFigureExport.js')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}
// 取某个函数体（从 `function name(` 到下一个同缩进的 `function `）
function body(text, head) {
  const i = text.indexOf(head)
  if (i < 0) return ''
  const rest = text.slice(i + head.length)
  const indent = (text.slice(text.lastIndexOf('\n', i) + 1, i).match(/^\s*/) || [''])[0]
  const j = rest.search(new RegExp('\\n' + indent + '(async\\s+)?function\\s'))
  return j < 0 ? rest : rest.slice(0, j)
}

// ① vecImg 在投影档下按图廓裁
{
  const b = body(FLAT, 'function drawImagery()')
  const vi = b.indexOf('if (vecImg)')
  const seg = vi >= 0 ? b.slice(vi, vi + 700) : ''
  ok('① 矢量导出的影像底图：投影档先按图廓 clip 再贴', /PJ\.identity/.test(seg) && /traceSphere\(ctx\);\s*ctx\.clip\(\)/.test(seg) && /drawImage\(vecImg/.test(seg))
}
// ② 全球图画幅取投影平面宽高比
{
  const m = FLAT.match(/fittedWorldSize\(\)\s*\{[^\n]*/)
  ok('② fittedWorldSize 按 PJ.W × PJ.H 取，不写死 360 × 180', !!m && /PJ\.W/.test(m[0]) && /PJ\.H/.test(m[0]) && !/\/ 180\b/.test(m[0]))
}
// ③ feedFlat 补推热力图与图上链路
{
  const b = body(PAGE, 'function feedFlat()')
  ok('③a feedFlat 补推覆盖分析热力图', /covGridLast/.test(b) && /setCovGrid\(covGridLast\.layer/.test(b))
  ok('③b feedFlat 补推图上链路', /\bpushLinks\(\)/.test(b))
  ok('③c drawCov 记下最近一份、清除时置空', /covGridLast = \{ layer, opts \}/.test(PAGE) && /covGridLast = null; if \(scene\) scene\.clearCovGrid\(\)/.test(PAGE))
}
// ④⑤ 3D 截图
{
  const b = body(SCENE, 'async function snapshot(')
  ok('④ 降档不再与 s × 0.8 取小', b.length > 0 && !/s \* 0\.8/.test(b) && /s = \(i >= 4 \|\| !\(fit > 1\)\) \? 1 : fit/.test(b))
  const u = b.indexOf('updateImageryTiles()'), r = b.indexOf('renderFrame()')
  ok('⑤ 出图前按出图分辨率重选影像级并等 pendingTiles 落地', u > 0 && r > u && /pendingTiles/.test(b.slice(u, r)) && /await new Promise/.test(b.slice(u, r)))
}
// ⑥ 保存框文件名清洗：渲染端给名字的 defaultPath 一律过 safeSaveName
{
  const raw = IPC.split(/\r?\n/).filter((ln) => /defaultPath:/.test(ln) && /defaultName/.test(ln))
  const bare = raw.filter((ln) => !/safeSaveName\(/.test(ln))
  ok('⑥ defaultPath 里带 defaultName 的都走 safeSaveName', raw.length >= 2 && bare.length === 0, bare.length ? bare.map((s) => s.trim()).join(' | ') : raw.length + ' 处')
  const m = IPC.match(/const safeSaveName = [^\n]*/)
  let fn = null
  try { fn = m ? new Function('return ' + m[0].replace(/^const safeSaveName = /, ''))() : null } catch { fn = null }
  ok('⑥ safeSaveName：/ \\ : * ? " < > | 换成 -，空名回落', !!fn && fn('合计 C/N.png', 'x') === '合计 C-N.png' && fn('a\\b:c*d?e"f<g>h|i', 'x') === 'a-b-c-d-e-f-g-h-i' && fn('  ', 'dflt') === 'dflt')
}
// ⑦ 出图调用方看 file:save 的返回值
{
  const files = [
    ['src/components/LbSpacePane.vue', 2], ['src/components/LbLinkPane.vue', 1], ['src/rain/RainPlot.vue', 1]
  ]
  for (const [f, n] of files) {
    const t = src(...f.split('/'))
    const k = (t.match(/if \(r && !r\.ok && !r\.canceled\)/g) || []).length
    ok('⑦ ' + f + ' 写失败出错误', k >= n && /expErr/.test(t), k + ' 处')
  }
  ok('⑦ exportSvgPng 回传 file:save 的结果', /return await exportFile\(/.test(CI) && !/return true\s*\r?\n\s*\} catch/.test(CI))
  for (const f of ['CiCdfPlot', 'CiSeriesPlot']) ok('⑦ ' + f + ' 看返回值', /const r = await exportSvgPng\(/.test(src('src', 'ci', f + '.vue')))
  const ana = src('src', 'model', 'anaContext.js')
  ok('⑦ anaContext.exportState 存在且导出', /function exportState\(x\)/.test(ana) && /exportBlob, exportState,/.test(ana))
  for (const f of ['AnaSun', 'AnaPower', 'AnaMask', 'AnaGimbal']) {
    const t = src('src', 'model', 'ana', f + '.vue')
    ok('⑦ ' + f + ' 的 PNG 导出走 exportState', /ana\.exportState\(/.test(t) && !/expMsg\.value = (x|r) && (x|r)\.ok \? '已导出。' : ''/.test(t))
  }
}
// ⑧ C/I 出图不内联 font-family
{
  const m = CI.match(/const INK = \[[\s\S]*?\]/)
  ok('⑧ INK 不含 font-family（各节点从根上继承报告字体）', !!m && !/'font-family'/.test(m[0]))
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
