// 打包前自检：安装包里必须真的带上影像瓦片离线包。运行：node scripts/check-imagery.mjs
//
// 为什么需要这个脚本 —— 它拦的是与「分享凭证漏带」同一类的事故：
//   resources/imagery 是百 MB 级的生成物（出厂 L0–L6 = 4273 片 / 100 MB），.gitignore 排除、asar 里
//   也显式排除，靠 build.extraResources
//   原样拷进 resources/imagery。而 2026-09 起【出厂默认底图】就是这个瓦片档（viz/imagery.js 的
//   DEFAULT_IMAGERY = 'bmTiles'）。渲染端缺片时会自愈式回退到矢量底图 —— 好事，但也正因为如此，
//   漏带这个包【不会报错、不会黑屏】：所有用户的「高精」档静默变成矢量底图，谁也不会来报。
//   而开发机上目录一直在，永远复现不出来。
//
// 判据取「逐级片数与网格数学一致」，不是「目录存在」：半截的包（切到一半中断、拷贝漏文件）比没有更坏 ——
// 那会让某些区域有图、某些区域空着，看起来像渲染 BUG。
//
// 网格与 src/viz/imageryTiles.js 逐字一致（EPSG:4326 / GIBS，512² 瓦片）：
//   res(z) = 0.5625/2^z 度/像素 · span(z) = 512·res(z) · cols = ⌈360/span⌉ · rows = ⌈180/span⌉
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(root, 'resources', 'imagery')
const SET = 'bmng'   // 出厂离线包（imagery.js 的 IMAGERY_SOURCES 里 tiles:'bmng' 那一档）

const span = (z) => 512 * 0.5625 / 2 ** z
const cols = (z) => Math.ceil(360 / span(z))
const rows = (z) => Math.ceil(180 / span(z))

const die = (lines) => {
  console.error('\n✗ 打包中断：影像瓦片离线包不完整\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  重新生成：npm run imagery:tiles（源图放 .imagery-src，默认切到 L7，出厂档位在 --max 里调）')
  console.error('  确实要打一个不含影像的包：设 SATSIM_SKIP_IMAGERY=1 —— 但请同时把 viz/imagery.js 的')
  console.error('  DEFAULT_IMAGERY 改回 \'bm16k\'，否则出厂默认底图会静默回退成矢量底图。\n')
  process.exit(1)
}

if (process.env.SATSIM_SKIP_IMAGERY === '1') {
  console.log('⚠ 已设 SATSIM_SKIP_IMAGERY=1，跳过影像瓦片自检。')
  console.log('⚠ 若 viz/imagery.js 的 DEFAULT_IMAGERY 仍是瓦片档，用户侧的「高精」会静默回退成矢量底图。')
  process.exit(0)
}

const setDir = join(DIR, SET)
const metaPath = join(setDir, 'meta.json')
if (!existsSync(metaPath)) die([`找不到 ${SET} 的 meta.json（期望 resources/imagery/${SET}/meta.json）。`])

let meta
try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) } catch (e) { die([`meta.json 解析失败：${e.message}`]) }

const maxZ = Number(meta.maxZoom)
if (!Number.isInteger(maxZ) || maxZ < 0 || maxZ > 11) die([`meta.json 的 maxZoom 不合法：${meta.maxZoom}`])

// 逐级点数：只数目录项，不打开文件（4273 片，毫秒级）
const bad = []
let total = 0
for (let z = 0; z <= maxZ; z++) {
  const want = rows(z) * cols(z)
  let got = 0
  const zDir = join(setDir, String(z))
  if (existsSync(zDir)) {
    for (const r of readdirSync(zDir)) {
      try { got += readdirSync(join(zDir, r)).filter((f) => f.toLowerCase().endsWith('.jpg')).length } catch { /* 非目录：跳过 */ }
    }
  }
  total += got
  if (got !== want) bad.push(`L${z}: ${got} / ${want} 片`)
}

if (bad.length) {
  die([`${SET} 逐级片数与网格数学对不上（缺片会让那一片区域空着，比整个没有更难查）：`, ...bad.map((s) => '  ' + s)])
}
// meta 自报的总数也要对上：对不上说明 meta 与目录不是同一次生成的
if (Number.isFinite(Number(meta.tiles)) && Number(meta.tiles) !== total) {
  die([`meta.json 自报 ${meta.tiles} 片，实际数到 ${total} 片 —— meta 与瓦片目录不是同一次生成的。`])
}

const mPerPx = Math.round(0.5625 / 2 ** maxZ * 111320)   // 度/像素 × 赤道 111320 m/度
console.log(`✓ 影像瓦片就绪：${SET} · L0–L${maxZ} · ${total} 片 · 最深级 ≈ ${mPerPx} m/px`)
console.log(`  随包路径：build.extraResources → resources/imagery（不进 app.asar，见 package.json）`)
