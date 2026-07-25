// 链路预算地理图底图（src/shared/lbBasemap.js）的几何自测。运行：npm test
// 被测文件是渲染端 ESM，故本测试自身也是 .mjs。
//
// 这一层不出数，出的是「读者据以判断落址的那张参照图」，错了不会报错、只会悄悄误导。
// 关键不变式：
//   ① 经度解缠：横贯 ±180 的国家（俄罗斯、斐济）不得被画成一条横贯全图的假色带；
//   ② ±360 整周补份：视图跨过 ±180 时对岸的陆地不能缺一块；
//   ③ 视图外的要素整条剔掉（缩放到一国时不该还在遍历南极）；
//   ④ 抽稀只并掉屏幕上分不出的点，且末点必须留住（闭合环靠它接回起点）；
//   ⑤ 小要素剔除只在它确实小于一两个像素时发生——放大之后必须原样回来；
//   ⑥ 岸线（陆地面的环）与国界（国与国共享的弧）是两份，国界里不含海岸段。
//
// ⑥ 与 50m 数据本身走真实数据验（不 mock：这一层的价值全在那份数据长什么样）。
// Node 的 ESM 不认无属性的 JSON import，故此处用 fs + topojson 复现 loadBasemap 里的两句，
// 再喂给被测的 preparePaths / basemapPaths。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as tj from 'topojson-client'
import { preparePaths, basemapPaths } from '../../../src/shared/lbBasemap.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const WORLD = { lon0: -180, lon1: 180, lat0: -90, lat1: 90 }
const nPts = (paths) => paths.reduce((s, p) => s + (p.length >> 1), 0)

console.log('=== 地理图底图：解缠 / 投影 / 抽稀 / 分层测试 ===\n')

// ① 经度解缠：一条跨 ±180 的线，解缠后经度必须连续（不得在 buf 里出现 ±360 的跳变）
{
  const p = preparePaths({
    type: 'LineString',
    coordinates: [[170, 60], [175, 61], [-179, 62], [-174, 63]]
  })
  ok('单条线出单条路径', p.length === 1, `${p.length} 条`)
  const b = p[0].buf
  let jump = 0
  for (let i = 1; i < b.length / 2; i++) jump = Math.max(jump, Math.abs(b[i * 2] - b[(i - 1) * 2]))
  ok('解缠后相邻经度无 ±360 跳变', jump < 180, `最大跳 ${jump.toFixed(1)}°`)
  ok('解缠把 −179 记成 181', Math.abs(b[4] - 181) < 1e-9, `${b[4]}`)
  ok('包围盒跟着解缠后的坐标走', p[0].lo === 170 && Math.abs(p[0].hi - 186) < 1e-9, `[${p[0].lo}, ${p[0].hi}]`)
}

// ② ±360 整周补份：视图落在日界线以东时，解缠到 180+ 的那一段要跟着搬回来
{
  const p = preparePaths({ type: 'LineString', coordinates: [[170, 0], [-170, 0]] })   // 解缠后 170→190
  const east = basemapPaths(p, { lon0: 150, lon1: 200, lat0: -10, lat1: 10 }, { w: 500, h: 100 })
  ok('视图在东侧：原位那份画出来', east.length === 1, `${east.length} 条`)
  // 同一条线在 −190…−170 那个周期上也应出现（视图挪到日界线以西时）
  const west = basemapPaths(p, { lon0: -200, lon1: -150, lat0: -10, lat1: 10 }, { w: 500, h: 100 })
  ok('视图在西侧：−360 那份补上（对岸不缺块）', west.length === 1, `${west.length} 条`)
  ok('补份后落点正确', Math.abs(west[0][0] - (170 - 360 + 200) * 10) < 1e-6, `x0=${west[0][0]}`)
}

// ③ 视图外整条剔掉
{
  const p = preparePaths({ type: 'MultiLineString', coordinates: [[[0, 80], [10, 82]], [[0, -80], [10, -82]]] })
  const v = basemapPaths(p, { lon0: -20, lon1: 20, lat0: 70, lat1: 89 }, { w: 400, h: 200 })
  ok('纬度上在视图外的整条剔掉', v.length === 1, `${v.length} 条（应只剩北边那条）`)
  const h = basemapPaths(p, { lon0: 100, lon1: 140, lat0: -89, lat1: 89 }, { w: 400, h: 400 })
  ok('经度上在视图外的整条剔掉', h.length === 0, `${h.length} 条`)
}

// ④ 抽稀：并掉屏幕上分不出的点，末点必须留住
{
  // 0…1° 上密布 101 个点；投到 100 px 宽 ⇒ 点距 1 px
  const dense = { type: 'LineString', coordinates: Array.from({ length: 101 }, (_, k) => [k / 100, 0]) }
  const p = preparePaths(dense)
  const view = { lon0: 0, lon1: 1, lat0: -0.5, lat1: 0.5 }, size = { w: 100, h: 100 }
  const raw = basemapPaths(p, view, size)
  ok('不抽稀时点数原样', (raw[0].length >> 1) === 101, `${raw[0].length >> 1} 点`)
  const thin = basemapPaths(p, view, size, { minPx: 3 })
  ok('按 3 px 抽稀后点数明显减少', (thin[0].length >> 1) <= 36, `${thin[0].length >> 1} 点（原 101）`)
  const last = thin[0]
  ok('末点必须留住（闭合环靠它接回起点）', Math.abs(last[last.length - 2] - 100) < 1e-9, `x=${last[last.length - 2]}`)
  // 抽稀阈值超过整条线长时也不能塌成一个点：至少首末两点
  const flat = basemapPaths(p, view, size, { minPx: 1e4 })
  ok('阈值过大时仍保留首末两点', (flat[0].length >> 1) === 2, `${flat[0].length >> 1} 点`)
}

// ⑤ 小要素剔除：缩到整幅时不足一个像素的礁与小岛丢掉，放大后原样回来
{
  const islet = preparePaths({ type: 'Polygon', coordinates: [[[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2], [0, 0]]] })
  const world = basemapPaths(islet, WORLD, { w: 720, h: 360 }, { minSize: 1.5 })
  ok('整幅世界图上：0.2° 的小岛剔掉', world.length === 0, `${world.length} 条`)
  const zoom = basemapPaths(islet, { lon0: -1, lon1: 1, lat0: -1, lat1: 1 }, { w: 720, h: 720 }, { minSize: 1.5 })
  ok('放大之后：同一个小岛原样回来', zoom.length === 1, `${zoom.length} 条`)
  // 细长要素（一维够大）不算小要素——海岸线上的长条沙洲不该被整条丢掉
  const spit = preparePaths({ type: 'LineString', coordinates: [[0, 0], [40, 0.01]] })
  ok('细长要素不被当成小要素剔掉', basemapPaths(spit, WORLD, { w: 720, h: 360 }, { minSize: 1.5 }).length === 1)
}

// ⑥ 真实 50m 数据：岸线与国界确实分成两份，且国界里不含海岸段
{
  const topo = JSON.parse(readFileSync(join(ROOT, 'src/viz/globe3d/data/countries-50m.json'), 'utf8'))
  const land = preparePaths(tj.feature(topo, topo.objects.land))
  const borders = preparePaths(tj.mesh(topo, topo.objects.countries, (a, b) => a !== b))
  ok('50m 陆地面环数在量级上对', land.length > 1000, `${land.length} 环`)
  ok('国界只取共享弧（远少于逐国整圈轮廓）', borders.length < land.length / 5, `${borders.length} 条国界 / ${land.length} 环岸线`)
  // 国界总点数必须远小于岸线：若误取了每个国家的整圈轮廓，海岸会被再描一遍、两者同量级
  const lp = land.reduce((s, x) => s + (x.buf.length >> 1), 0)
  const bp = borders.reduce((s, x) => s + (x.buf.length >> 1), 0)
  ok('国界不含海岸段（点数远少于岸线）', bp < lp / 2, `国界 ${bp} 点 / 岸线 ${lp} 点`)

  // 解缠必须清干净：任一路径内部不得留下 ±360 的跳变（留下就是横贯全图的假色带）
  let worst = 0, who = ''
  for (const it of land.concat(borders)) {
    const b = it.buf
    for (let i = 1; i < b.length / 2; i++) {
      const d = Math.abs(b[i * 2] - b[(i - 1) * 2])
      if (d > worst) { worst = d; who = `${b[(i - 1) * 2].toFixed(1)}→${b[i * 2].toFixed(1)}` }
    }
  }
  ok('全量数据解缠后无 ±360 跳变', worst < 180, `最大跳 ${worst.toFixed(1)}° (${who})`)

  // 抽稀的实效：整幅世界图（最坏情形，一点都剔不掉）上的绝对点数必须落在
  // 「canvas 逐帧描得动」的量级里——拖拽时这两层每帧都要按新视图重投一遍。
  // 与旧的 110m 比不是 1:1：那份数据本就没有岸线细节、也没有独立的国界层，
  // 3 倍是换来这两样东西的价钱，不是抽稀没做够。
  const size = { w: 760 * 2, h: 380 * 2 }        // 典型图框 × dpr=2
  const dec = { minPx: 1.0 * 2, minSize: 2.0 * 2 }
  const wLand = basemapPaths(land, WORLD, size, dec)
  const wBord = basemapPaths(borders, WORLD, size, dec)
  const drawn = nPts(wLand) + nPts(wBord)
  const src = lp + bp
  ok('整幅世界图：抽稀掉七成以上的点', drawn < src * 0.32, `${src} → ${drawn} 点（${(100 * drawn / src).toFixed(0)}%）`)
  ok('整幅世界图的绝对点数在 2.5 万以内', drawn < 25000, `${drawn} 点`)
  ok('整幅世界图的子路径数在 500 条以内', wLand.length + wBord.length < 500, `${wLand.length + wBord.length} 条`)

  // 放大到一国：细节必须真的回来（否则换 50m 白换），且总量因视图剔除反而更小
  const cn = { lon0: 73, lon1: 135, lat0: 18, lat1: 54 }
  const zLand = basemapPaths(land, cn, size, dec)
  let inWorld = 0
  for (const p of wLand) for (let i = 0; i < p.length; i += 2) {
    // 整幅图上落在中国那一块的点数（视图 → 像素的线性换算）
    const lon = p[i] / size.w * 360 - 180, lat = 90 - p[i + 1] / size.h * 180
    if (lon >= 73 && lon <= 135 && lat >= 18 && lat <= 54) inWorld++
  }
  ok('放大到一国时细节真的回来了', nPts(zLand) > inWorld * 3, `同一区域 ${inWorld} → ${nPts(zLand)} 点`)
  ok('放大后总点数仍受控（视图外已剔除）', nPts(zLand) < drawn, `${nPts(zLand)} < ${drawn}`)
}

// 边界情形：空输入、退化视图不得抛异常
{
  ok('空清单返回空', basemapPaths([], WORLD, { w: 10, h: 10 }).length === 0)
  ok('null 清单返回空', basemapPaths(null, WORLD, { w: 10, h: 10 }).length === 0)
  const p = preparePaths({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })
  ok('零宽视图返回空（不除零）', basemapPaths(p, { lon0: 5, lon1: 5, lat0: 0, lat1: 1 }, { w: 10, h: 10 }).length === 0)
  ok('零尺寸画布返回空', basemapPaths(p, WORLD, { w: 0, h: 0 }).length === 0)
  ok('单点路径丢弃', preparePaths({ type: 'LineString', coordinates: [[0, 0]] }).length === 0)
  ok('未知几何类型不抛异常', preparePaths({ type: 'Point', coordinates: [0, 0] }).length === 0)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
