// 影像瓦片离线包：把 NASA BMNG 500m 原生 8 分幅切成 resources/imagery/bmng 下的 EPSG:4326 金字塔。
//
// 用法（需在装了 electron 的仓库里跑，走的是 Electron 的 nativeImage —— 本机没有 sharp/ImageMagick/PIL，
// 也刻意不为此引入构建期依赖）：
//     npm run imagery:tiles              # 缺源图时自动下载（400 MB）再切
//     npm run imagery:tiles -- --max 6   # 只切到 L6（88 MB，海岸线已可辨，装机包小得多）
//
// 数据源：world.topo.bathy.200407.3x21600x21600.{A1..D2}.jpg（NASA Visible Earth，公有领域）
//   8 张各 21600×21600，拼起来 86400×43200 = 500 m/px 全球。7 月版是最经典那张
//   （12 月版北半球雪线偏南，不适合做通用底图）。署名：NASA Earth Observatory。
//
// 分幅布局：列 A=−180 B=−90 C=0 D=90，行 1=北半球 2=南半球，每张 90°×90°，240 px/度。
// ★ L5/L6/L7 的片跨度（9/4.5/2.25 度）都整除 90 → 没有一片跨分幅边界，可逐分幅独立切；
//   L0–L4 的跨度不整除（L3 是 36°），故先把 8 张缩合成一张 L4 世界图（10240×5120）再从它切。
//
// ★ gutter：每片多采一圈 1 px（成品 514×514，渲染时只用中间 512）。没有它，相邻片各自
//   独立采样，边界上双线性退化成硬边 —— 片内相邻纹素之间是平滑过渡，缝上却是瞬变，
//   3D 高倍放大时就是一条发丝线，加了 mipmap 还会更明显。分幅边界（3 条经线 + 赤道）
//   上取不到邻片像素，退化为边缘复制 —— 那 4 条线上的效果等同于「没有 gutter」，不会更差。
import { app, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRCDIR = path.join(ROOT, '.imagery-src')          // 中间产物：切完可删，已进 .gitignore
const OUT = path.join(ROOT, 'resources', 'imagery', 'bmng')
const BASE_URL = 'https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73751/world.topo.bathy.200407.3x21600x21600.'
const QUADS = [['A1', -180, 90], ['A2', -180, 0], ['B1', -90, 90], ['B2', -90, 0],
               ['C1', 0, 90], ['C2', 0, 0], ['D1', 90, 90], ['D2', 90, 0]]

const TS = 512, G = 1, IMG = TS + 2 * G       // 512 内容 + 两边各 1 px gutter
const res = (z) => 0.5625 / 2 ** z
const span = (z) => TS * res(z)
const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d }
const MAXZ = Math.max(0, Math.min(7, argOf('max', 7)))
const Q = Math.max(40, Math.min(100, argOf('q', 85)))

async function fetchSources() {
  fs.mkdirSync(SRCDIR, { recursive: true })
  for (const [t] of QUADS) {
    const f = path.join(SRCDIR, t + '.jpg')
    // 完整性判据用 JPEG 结束标记 FFD9，不用文件大小 —— 半截文件也有大小，但解出来是残图。
    if (fs.existsSync(f) && fs.readFileSync(f).subarray(-2).toString('hex') === 'ffd9') { console.log(`  ${t} 已有`); continue }
    process.stdout.write(`  ${t} 下载… `)
    const r = await fetch(BASE_URL + t + '.jpg')
    if (!r.ok) throw new Error(`${t} HTTP ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.subarray(-2).toString('hex') !== 'ffd9') throw new Error(`${t} 下载不完整（尾部不是 FFD9）`)
    fs.writeFileSync(f, buf)
    console.log((buf.length / 1048576).toFixed(1) + ' MB')
  }
}

const stat = {}
const note = (z) => (stat[z] ??= { n: 0, bytes: 0 })
function put(z, row, col, buf) {
  const d = path.join(OUT, String(z), String(row))
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, col + '.jpg'), buf)
  const s = note(z); s.n++; s.bytes += buf.length
}

// 从「一条已缩放到目标级的横带」里裁出带 gutter 的一片。
// 横带覆盖本分幅的整幅宽度（nt·512 px）与 [y0,y1) 行；越出横带的那一圈按边缘复制补。
function cutTile(strip, stripW, stripH, offsetY, col) {
  const sx = col * TS - G, sy = -offsetY - G   // 目标片左上角在横带里的位置（可为负）
  if (sx >= 0 && sy >= 0 && sx + IMG <= stripW && sy + IMG <= stripH) {
    return strip.crop({ x: sx, y: sy, width: IMG, height: IMG })   // 常规路径：直接裁，最快
  }
  // 边缘片：逐行按夹取索引拷进 514×514（BGRA）
  const src = strip.toBitmap()
  const dst = Buffer.alloc(IMG * IMG * 4)
  for (let y = 0; y < IMG; y++) {
    const yy = Math.max(0, Math.min(stripH - 1, sy + y))
    for (let x = 0; x < IMG; x++) {
      const xx = Math.max(0, Math.min(stripW - 1, sx + x))
      src.copy(dst, (y * IMG + x) * 4, (yy * stripW + xx) * 4, (yy * stripW + xx) * 4 + 4)
    }
  }
  return nativeImage.createFromBitmap(dst, { width: IMG, height: IMG })
}

app.whenReady().then(async () => {
  try {
    console.log('影像瓦片离线包')
    console.log(`  目标 ${OUT}`)
    console.log(`  级别 L0–L${MAXZ}   质量 q${Q}   瓦片 ${IMG}×${IMG}（${TS} + gutter ${G}）\n`)
    await fetchSources()
    const t0 = Date.now()
    fs.rmSync(OUT, { recursive: true, force: true })

    // 世界图缓冲：顺手在遍历分幅时攒出来，省一轮解码。L4 世界尺寸 10240×5120。
    const WW = Math.round(360 / res(4)), WH = Math.round(180 / res(4))
    const world = Buffer.alloc(WW * WH * 4)

    console.log('\n逐分幅切 L5–L7（片跨度整除 90°，不跨分幅）：')
    for (const [name, lon0, lat1] of QUADS) {
      const img = nativeImage.createFromPath(path.join(SRCDIR, name + '.jpg'))
      const { width: sw, height: sh } = img.getSize()
      if (!sw) throw new Error(`${name} 解码失败`)
      process.stdout.write(`  ${name} ${sw}×${sh}`)
      for (let z = 5; z <= MAXZ; z++) {
        const s = span(z), nt = Math.round(90 / s)
        const c0 = Math.round((lon0 + 180) / s), r0 = Math.round((90 - lat1) / s)
        const stripW = nt * TS
        for (let rr = 0; rr < nt; rr++) {
          // 横带含上下各 1 px gutter，越出分幅时收窄（cutTile 会把缺的那一圈按边缘复制补上）
          const y0 = Math.max(0, rr * TS - G), y1 = Math.min(nt * TS, (rr + 1) * TS + G)
          const strip = img.crop({ x: 0, y: Math.round(y0 * sh / stripW), width: sw, height: Math.max(1, Math.round(y1 * sh / stripW) - Math.round(y0 * sh / stripW)) })
                           .resize({ width: stripW, height: y1 - y0, quality: 'best' })
          for (let cc = 0; cc < nt; cc++) put(z, r0 + rr, c0 + cc, cutTile(strip, stripW, y1 - y0, y0 - rr * TS, cc).toJPEG(Q))
        }
        process.stdout.write(`  L${z}✓`)
      }
      // 攒 L4 世界图：本分幅缩到 (WW/4)×(WH/2) 贴进去
      const qw = WW / 4, qh = WH / 2
      const small = img.resize({ width: qw, height: qh, quality: 'best' }).toBitmap()
      const ox = Math.round((lon0 + 180) / 360 * WW), oy = Math.round((90 - lat1) / 180 * WH)
      for (let y = 0; y < qh; y++) small.copy(world, ((oy + y) * WW + ox) * 4, y * qw * 4, (y + 1) * qw * 4)
      console.log(`   ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }

    console.log('\n从世界图切 L0–L4（这几级的片跨度不整除 90°，会跨分幅）：')
    const wimg = nativeImage.createFromBitmap(world, { width: WW, height: WH })
    for (let z = 0; z <= Math.min(4, MAXZ); z++) {
      const lw = Math.round(360 / res(z)), lh = Math.round(180 / res(z))
      const lv = wimg.resize({ width: lw, height: lh, quality: 'best' })
      const nc = Math.ceil(lw / TS), nr = Math.ceil(lh / TS)
      for (let r = 0; r < nr; r++) {
        const y0 = Math.max(0, r * TS - G), y1 = Math.min(lh, (r + 1) * TS + G)
        const strip = lv.crop({ x: 0, y: y0, width: lw, height: y1 - y0 })
        for (let c = 0; c < nc; c++) put(z, r, c, cutTile(strip, lw, y1 - y0, y0 - r * TS, c).toJPEG(Q))
      }
      console.log(`  L${z}  ${nc}×${nr}  ${note(z).n} 片`)
    }

    let cum = 0, cn = 0
    console.log('\n级  片数     本级 MB   累计 MB   最细 m/px')
    for (let z = 0; z <= MAXZ; z++) {
      cum += stat[z].bytes; cn += stat[z].n
      console.log(`L${z} ${String(stat[z].n).padStart(6)} ${(stat[z].bytes / 1048576).toFixed(2).padStart(10)} ${(cum / 1048576).toFixed(1).padStart(9)}  ${(res(z) * 111320).toFixed(0).padStart(8)}`)
    }
    console.log(`\n合计 ${cn} 片  ${(cum / 1048576).toFixed(1)} MB  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
      set: 'bmng', maxZoom: MAXZ, tile: TS, gutter: G, quality: Q,
      credit: 'NASA Earth Observatory · Blue Marble Next Generation (topo+bathy, 2004-07)',
      source: 'world.topo.bathy.200407.3x21600x21600', grid: 'EPSG:4326 / GIBS', tiles: cn
    }, null, 2))
    console.log(`\n源图留在 ${SRCDIR}（切完可删，已进 .gitignore）`)
  } catch (e) {
    console.error('\n失败：', e.message)
    process.exitCode = 1
  }
  app.quit()
})
