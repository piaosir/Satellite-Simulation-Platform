// 视频导出落盘（electron/services/videoFile.js）：图片序列逐帧带帧号；单帧（frames = 1）就是保存框选的那个文件本身；
// 图片序列重导的覆盖确认（同名同位数旧帧：挂起 → 确认清旧帧 / 取消不动）；写盘失败用视频自己的文案。
// 假 ipcMain / dialog 直接调各通道的处理函数，文件写进系统临时目录、跑完删掉。
// 运行：npm test -- videoFile
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { registerVideoIpc } = require('../../../electron/services/videoFile.js')

let pass = 0, fail = 0
const ok = (name, cond, note) => {
  if (cond) { pass++; console.log('PASS  ' + name + (note ? '  (' + note + ')' : '')) }
  else { fail++; console.log('FAIL  ' + name + (note ? '  — ' + note : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llvideo-'))
let pick = ''
const handlers = new Map()
registerVideoIpc({ handle: (ch, fn) => handlers.set(ch, fn) }, {
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: pick }) },
  BrowserWindow: { fromWebContents: () => null },
  shell: { showItemInFolder: () => {}, openPath: async () => '' },
  safeSaveName: (s, d) => String(s || d),
  writeErrText: () => '文件可能正被其他程序打开（如 PDF 查看器）'   // register 照旧传通用那份进来：视频不该用它（见 ⑥）
})
const ev = { sender: { id: 7, once: () => {} } }
const call = (ch, ...a) => handlers.get(ch)(ev, ...a)
const bytes = new Uint8Array([137, 80, 78, 71])
const files = () => fs.readdirSync(dir).sort()

try {
  // ① 单帧 PNG：写到选的文件本身，不带帧号；只收第 1 帧
  pick = path.join(dir, 'still.png')
  let b = await call('video:begin', { kind: 'png', defaultName: 'x', frames: 1 })
  ok('① 单帧：会话路径 = 保存框选的文件', b.ok && b.path === pick, b.path)
  const r2 = await call('video:frame', b.token, 2, bytes)
  const r1 = await call('video:frame', b.token, 1, bytes)
  let end = await call('video:end', b.token, true)
  ok('① 单帧只收第 1 帧', !r2.ok && r1.ok)
  ok('① 落盘就是 still.png，没有 still_0001.png', files().join() === 'still.png' && end.path === pick && end.frames === 1 && end.bytes === 4, files().join())
  ok('① 导出过的单帧可「打开」（白名单）', (await call('video:openPath', pick)).ok === true)

  // ② 扩展名：.jpeg 认作 JPEG 原样用（保存框的覆盖确认问的就是它）；对不上的按格式补
  pick = path.join(dir, 'a.JPEG')
  b = await call('video:begin', { kind: 'jpg', frames: 1 })
  ok('② JPEG 单帧选了 .JPEG → 原样', b.ok && b.path === pick, b.path)
  await call('video:end', b.token, false)
  pick = path.join(dir, 'b.txt')
  b = await call('video:begin', { kind: 'png', frames: 1 })
  ok('② 扩展名对不上 → 按格式补成 b.png', b.ok && b.path === path.join(dir, 'b.png'), b.path)
  await call('video:end', b.token, false)

  // ③ 图片序列照旧：<名>_0001… 逐帧带号，首帧路径给「在文件夹中显示」
  pick = path.join(dir, 'seq.png')
  b = await call('video:begin', { kind: 'png', frames: 3 })
  for (let k = 1; k <= 3; k++) await call('video:frame', b.token, k, bytes)
  end = await call('video:end', b.token, true)
  ok('③ 序列：seq_0001～0003.png、无 seq.png', ['seq_0001.png', 'seq_0002.png', 'seq_0003.png'].every((f) => files().includes(f)) && !files().includes('seq.png') && end.frames === 3, files().join())
  ok('③ 序列会话路径 = 首帧', end.path === path.join(dir, 'seq_0001.png'))

  // ④ MP4 不受 frames 影响（单帧 MP4 由渲染端拦下，主进程照常按位置写）
  pick = path.join(dir, 'v.mp4')
  b = await call('video:begin', { kind: 'mp4', frames: 1 })
  ok('④ MP4 路径 = 所选文件', b.ok && b.path === pick)
  ok('④ MP4 会话不收逐帧图片', !(await call('video:frame', b.token, 1, bytes)).ok)
  await call('video:end', b.token, false)
  ok('④ 放弃的 MP4 删掉', !fs.existsSync(pick))

  // ⑤ 图片序列重导：所选位置已有同名同位数的旧帧 → begin 回 exists、会话挂起不收帧；
  //    确认（begin { confirm }）= 清掉旧帧再写，帧数变少时旧尾帧不留；取消（end）= 一个不动。位数 / 格式 / 名字不同的不算
  const busyErr = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  const foldCase = process.platform === 'win32' || process.platform === 'darwin'
  const seqOf = (re) => files().filter((f) => re.test(f) && fs.statSync(path.join(dir, f)).isFile())   // 只数文件（rq_0009.png 是个文件夹）
  const rqSeq = foldCase ? /^rq_\d{4}\.png$/i : /^rq_\d{4}\.png$/   // 4 位帧序列（大小写口径同平台）
  pick = path.join(dir, 'rq.png')
  b = await call('video:begin', { kind: 'png', frames: 5 })
  ok('⑤ 首次导出：没有旧帧 → exists = 0、直接收帧', b.ok && b.exists === 0 && (await call('video:frame', b.token, 1, bytes)).ok)
  for (let k = 2; k <= 5; k++) await call('video:frame', b.token, k, bytes)
  await call('video:end', b.token, true)
  const decoys = ['rq_01.png', 'rq_00001.png', 'rq_0001.jpg', 'rq_000x.png', 'rqx_0001.png', 'rq.png']
  for (const f of decoys) fs.writeFileSync(path.join(dir, f), bytes)
  fs.mkdirSync(path.join(dir, 'rq_0009.png'))                         // 同名的文件夹：不是帧
  fs.writeFileSync(path.join(dir, 'RQ_0007.PNG'), bytes)              // Windows / macOS 上就是 rq_0007.png 那个位置
  const nOld = 5 + (foldCase ? 1 : 0)
  b = await call('video:begin', { kind: 'png', frames: 3 })
  ok('⑤ 重导（帧数变少）：exists = 旧帧数、路径 = 首帧', b.ok && b.exists === nOld && b.path === path.join(dir, 'rq_0001.png'), String(b.exists))
  ok('⑤ 确认前一帧都不收，旧帧原样', !(await call('video:frame', b.token, 1, bytes)).ok && seqOf(rqSeq).length === nOld)
  const bc = await call('video:begin', { confirm: b.token })
  ok('⑤ 确认替换：会话转正、token / 路径不变', bc.ok && bc.token === b.token && bc.path === b.path)
  for (let k = 1; k <= 3; k++) await call('video:frame', b.token, k, bytes)
  end = await call('video:end', b.token, true)
  ok('⑤ 替换后只剩新的 3 帧（旧尾帧 0004 / 0005 / 0007 清掉）', seqOf(rqSeq).join() === 'rq_0001.png,rq_0002.png,rq_0003.png' && end.frames === 3, seqOf(/^rq_/i).join())
  ok('⑤ 位数不同 / 别的格式 / 别的名字 / 文件夹一个不动', decoys.every((f) => fs.existsSync(path.join(dir, f))) && fs.statSync(path.join(dir, 'rq_0009.png')).isDirectory())

  b = await call('video:begin', { kind: 'png', frames: 3 })
  ok('⑤ 再导：exists = 3', b.ok && b.exists === 3)
  ok('⑤ 别的窗口替它确认无效', !(await handlers.get('video:begin')({ sender: { id: 8, once: () => {} } }, { confirm: b.token })).ok)
  await call('video:end', b.token, false)
  ok('⑤ 取消（end）：旧帧原样、再确认无效', seqOf(rqSeq).length === 3 && !(await call('video:begin', { confirm: b.token })).ok)

  b = await call('video:begin', { kind: 'png', frames: 12000 })
  ok('⑤ 12000 帧（5 位）只认 5 位的旧帧', b.ok && b.exists === 1, String(b.exists))
  await call('video:end', b.token, false)

  b = await call('video:begin', { kind: 'png', frames: 3 })
  const unlink0 = fs.promises.unlink
  fs.promises.unlink = async () => { throw busyErr() }                 // 某帧正被看图软件开着
  let rr
  try { rr = await call('video:begin', { confirm: b.token }) } finally { fs.promises.unlink = unlink0 }
  ok('⑤ 清旧帧失败：报占用、整单放弃（会话关掉）', !rr.ok && rr.error === '文件可能正被其他程序打开（如图片查看器）' && !(await call('video:frame', b.token, 1, bytes)).ok, rr.error)

  b = await call('video:begin', { kind: 'png', frames: 1 })
  ok('⑤ 单帧不走这套（保存框自己问覆盖）', b.ok && !b.exists && b.path === pick)
  await call('video:end', b.token, false)

  // ⑥ 写盘失败（目标被别的程序占着）：视频自己的文案，不举「PDF 查看器」
  pick = path.join(dir, 'busy.png')
  b = await call('video:begin', { kind: 'png', frames: 2 })
  const wfs = fs.writeFileSync
  fs.writeFileSync = () => { throw busyErr() }
  let rb
  try { rb = await call('video:frame', b.token, 1, bytes) } finally { fs.writeFileSync = wfs }
  ok('⑥ 帧图片写不进 → 图片查看器', !rb.ok && rb.error === '文件可能正被其他程序打开（如图片查看器）', rb.error)
  await call('video:end', b.token, false)
  pick = path.join(dir, 'busy.mp4')
  b = await call('video:begin', { kind: 'mp4', frames: 2 })
  const ws = fs.writeSync
  fs.writeSync = () => { throw busyErr() }
  try { rb = await call('video:write', b.token, 0, bytes) } finally { fs.writeSync = ws }
  ok('⑥ MP4 写不进 → 播放器', !rb.ok && rb.error === '文件可能正被其他程序打开（如播放器）', rb.error)
  await call('video:end', b.token, false)
  const other = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  b = await call('video:begin', { kind: 'png', frames: 2 })
  fs.writeFileSync = () => { throw other }
  try { rb = await call('video:frame', b.token, 1, bytes) } finally { fs.writeFileSync = wfs }
  ok('⑥ 其他错误照原文', !rb.ok && rb.error === other.message)
  await call('video:end', b.token, false)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail ? 'FAIL' : 'OK'} ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
