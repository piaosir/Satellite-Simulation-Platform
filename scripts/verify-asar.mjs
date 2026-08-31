// 打包后自检：app.asar 的目录表必须与包体真实字节对得上。运行：node scripts/verify-asar.mjs
//
// 为什么需要这个脚本 —— 它拦的是 v1.4.0 那次发版事故：
//   asar 的结构是「一张目录表（每个文件记 offset/size/sha256）+ 一整块首尾相连的内容区」。
//   electron-builder 建表与写内容是分两步走的，中间若有人动了源文件，表和内容就此对不上。
//   那次 resources/omm/manifest.json 正好在这两步之间被 OMM 快照刷新改写：表里记 2531 字节，
//   实际写进去 2439 字节 —— 少的 92 字节没人补，于是它【之后的一万多个文件】在包里的真实位置
//   全部比表里声明的早 92 字节。
//
//   后果不是「某个数据文件坏了」，而是主进程入口 out/main/main.js 被从第 92 字节读起、
//   开头整整齐齐削掉一截，Electron 一启动就 SyntaxError: Invalid or unexpected token，
//   整个应用打不开。而这在开发机上永远复现不出来 —— dev 跑的是源文件，不经过 asar。
//
// 两道检查，前者一眼见死，后者定位到具体文件：
//   ① 目录表声明的内容总长 == 包体实际内容长度（那次差 92 字节，这一条就足以拦下）
//   ② 逐文件比对 sha256（表里自带 integrity.hash），并把主进程入口真正 parse 一遍
//
// 挂在 dist 里 electron-builder 之后、publish-cos 之前（见 package.json）：坏包绝不许上传。
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const die = (lines) => {
  console.error('\n✗ 打包中断：app.asar 自检未通过（这样的包装上去会直接打不开，绝不能上传）\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  几乎总是同一个原因：electron-builder 打包期间有别的进程改了 resources/ 下的源文件。')
  console.error('  先把 omm:snapshot 这类会改文件的任务跑完、彻底结束，再 npm run dist，然后重打一次。\n')
  process.exit(1)
}

// ---- 找出本次产出的 app.asar（release/<平台目录>/resources/app.asar）----
const releaseDir = join(root, 'release')
if (!existsSync(releaseDir)) die(['没有 release/ 目录 —— 先运行 electron-builder。'])
const archives = readdirSync(releaseDir)
  .map((d) => join(releaseDir, d, 'resources', 'app.asar'))
  .filter((p) => existsSync(p))
if (!archives.length) die(['release/ 下没找到任何 */resources/app.asar。'])

for (const A of archives) {
  const rel = A.slice(root.length + 1)
  const size = statSync(A).size
  const fd = openSync(A, 'r')
  const readAt = (off, len) => { const b = Buffer.alloc(len); readSync(fd, b, 0, len, off); return b }

  // asar 头：8 字节 size pickle，其后 header pickle（payload 长度 + 字符串长度 + JSON）
  const pickleSize = readAt(0, 8).readUInt32LE(4)
  const hb = readAt(8, pickleSize)
  const dataStart = 8 + pickleSize
  let header
  try { header = JSON.parse(hb.slice(8, 8 + hb.readUInt32LE(4)).toString('utf8')) }
  catch (e) { closeSync(fd); die([`${rel}：目录表 JSON 解析失败 —— ${e.message}`]) }

  const files = []
  ;(function walk(node, prefix) {
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = prefix + '/' + name
      if (v.files) walk(v, p)
      else if (!v.unpacked) files.push({ p, off: Number(v.offset), size: Number(v.size), hash: v.integrity?.hash })
    }
  })(header, '')

  // ① 表声明的内容总长 vs 包体实际内容长度
  const declared = files.reduce((m, f) => Math.max(m, f.off + f.size), 0)
  const actual = size - dataStart
  if (declared !== actual) {
    const off = files.slice().sort((a, b) => a.off - b.off).find((f) => {
      // 越界的文件连完整长度都读不出来 —— 它要么就是错位的起点，要么在起点之后
      if (f.off + f.size > actual) return true
      if (!f.hash) return false
      return createHash('sha256').update(readAt(dataStart + f.off, f.size)).digest('hex') !== f.hash
    })
    closeSync(fd)
    die([
      `${rel}：目录表声明 ${declared} 字节内容，包体实际 ${actual} 字节（差 ${declared - actual}）。`,
      off ? `错位从这个文件开始：${off.p}（表里记 ${off.size} 字节）—— 打包途中它被改写过。` : '',
      '其后所有文件在包里的真实位置都与表不符，主进程入口多半已经读不出来了。'
    ].filter(Boolean))
  }

  // ② 逐文件 sha256
  const bad = []
  let checked = 0
  for (const f of files) {
    if (!f.hash) continue
    if (createHash('sha256').update(readAt(dataStart + f.off, f.size)).digest('hex') !== f.hash) bad.push(f.p)
    checked++
  }
  if (bad.length) {
    closeSync(fd)
    die([`${rel}：${bad.length}/${checked} 个文件与目录表记录的 sha256 不符，头几个：`, ...bad.slice(0, 8).map((p) => '  ' + p)])
  }

  // ③ 主进程入口必须真的能解析（②过了这条几乎不会挂，但它是整个包能否启动的直接判据）
  const entry = JSON.parse(readAt(dataStart + files.find((f) => f.p === '/package.json').off,
    files.find((f) => f.p === '/package.json').size).toString('utf8')).main
  for (const p of ['/' + entry, '/out/preload/preload.js']) {
    const f = files.find((x) => x.p === p)
    if (!f) { closeSync(fd); die([`${rel}：包里没有 ${p}`]) }
    try { new Script(readAt(dataStart + f.off, f.size).toString('utf8'), { filename: p }) }
    catch (e) { closeSync(fd); die([`${rel}：${p} 语法错误 —— ${e.message}`, '包体内容与目录表错位时就是这个症状。']) }
  }

  closeSync(fd)
  console.log(`✓ ${rel}：${files.length} 个文件全部与目录表一致（${checked} 个比对了 sha256），入口 ${entry} 可解析。`)
}
