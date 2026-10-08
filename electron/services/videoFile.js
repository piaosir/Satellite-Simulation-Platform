// 视频导出的落盘（主进程侧）：MP4 按绝对位置流式写（渲染端的封装器预留 moov、末尾回填），图片序列逐帧一个文件。
//
// 为什么不走通用 file:save：那条是「整份数据一次给」，视频动辄几百 MB～几 GB，渲染端攒不下也不该攒；
// 这里开一个会话（token），渲染端边编码边按位置写，结束时关文件 —— 内存只占一个 4 MB 的批次。
//
// 通道（全部在授权锁内，由 register 传入的 ipcMain 包装默认拦截）：
//   video:begin  { kind: 'mp4'|'png'|'jpg', defaultName, frames } → 保存框 → { ok, token, path, exists } | { canceled } | { ok:false, error }
//                exists > 0：图片序列所选位置已有同名同位数的旧帧（<名>_0001…），会话挂起（不收帧），等渲染端在应用内确认框里问过：
//   video:begin  { confirm: token }                               → 「替换」：清掉那些旧帧、会话转正（不再弹保存框）；「取消」走 video:end(token, false)
//   video:write  (token, position, bytes)                         → MP4 按位置写
//   video:frame  (token, index, bytes)                            → 图片序列第 index 帧（1 起）：<名>_000001.png；
//                                                                   单帧（frames = 1）就是保存框选的那个文件本身，不带帧号
//   video:end    (token, keep)                                    → 关文件；keep=false 时 MP4 删掉（取消 / 出错），图片序列保留已写的帧
//   video:reveal (path) / video:openPath (path)                  → 只认本进程导出过的路径（不让渲染端借它打开任意文件）
//
// 覆盖确认只管图片序列：MP4 与单帧落盘就是保存框选的那个文件，保存框自己会问覆盖；序列写的是 <名>_0001… 这一串，
// 保存框问不到 —— 重导同一时段帧数变少时，旧尾帧留在文件夹里，剪辑软件按序列导入会接在新帧后面。
const fs = require('fs')
const path = require('path')

// 写盘失败的文案（视频自己的一份）：目标被其他程序占着（播放器 / 看图软件开着）→ EBUSY / EPERM / EACCES。
// 不用 register 的通用 writeErrText：那份举的例子是 PDF 查看器，对视频与帧图片不对
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
function ioErr(err, kind) {
  if (err && BUSY_CODES.has(err.code)) return kind === 'mp4' ? '文件可能正被其他程序打开（如播放器）' : '文件可能正被其他程序打开（如图片查看器）'
  return (err && err.message) || String(err)
}

// 同名同位数的旧帧：<stem>_<digits 位数字>.<ext>（只认文件）。位数不同的是另一串序列，剪辑软件也不会把它接上，不动。
// Windows / macOS 文件名不分大小写：Seq_0001.PNG 与 seq_0001.png 是同一个位置，按不分大小写比
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'
async function oldFrames(dir, stem, ext, digits) {
  let ents
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const fold = (s) => (FOLD_CASE ? s.toLowerCase() : s)
  const pre = fold(stem + '_'), suf = fold('.' + ext)
  const out = []
  for (const d of ents) {
    if (!d.isFile()) continue
    const f = fold(d.name)
    if (f.length === pre.length + digits + suf.length && f.startsWith(pre) && f.endsWith(suf) && /^\d+$/.test(f.slice(pre.length, pre.length + digits))) out.push(d.name)
  }
  return out
}

function registerVideoIpc(ipcMain, { dialog, BrowserWindow, shell, safeSaveName }) {
  const sessions = new Map()      // token → { kind, sender, fd?, path, dir?, stem?, ext?, digits?, pending?, count, bytes }
  const exported = new Set()      // 导出成功过的文件 / 首帧路径（reveal / openPath 的白名单）
  let seq = 0

  function closeSession(token, keep) {
    const s = sessions.get(token)
    if (!s) return null
    sessions.delete(token)
    if (s.fd != null) { try { fs.closeSync(s.fd) } catch { /* 已关 */ } }
    if (!keep && s.kind === 'mp4') { try { fs.unlinkSync(s.path) } catch { /* 没建成 / 已删 */ } }
    return s
  }

  // 覆盖确认的第二步（渲染端确认框点了「替换」）：按此刻的文件夹重列一遍旧帧删掉（问的那会儿到现在可能又变了），会话转正。
  // 删到一半失败（某帧正被看图软件开着）就整单放弃、不导出：硬写下去，删不掉的那帧照样是拖在新序列后面的旧尾帧
  async function confirmReplace(e, token) {
    const s = sessions.get(token)
    if (!s || !s.pending || s.sender !== e.sender.id) return { ok: false, error: '导出会话已结束' }
    try {
      const old = await oldFrames(s.dir, s.stem, s.ext, s.digits)
      const rm = (n) => fs.promises.unlink(path.join(s.dir, n)).catch((err) => { if (err.code !== 'ENOENT') throw err })
      for (let i = 0; i < old.length; i += 32) await Promise.all(old.slice(i, i + 32).map(rm))   // 分批异步删：几千帧也不卡住主进程
    } catch (err) {
      closeSession(token, false)
      return { ok: false, error: ioErr(err, s.kind) }
    }
    s.pending = false
    return { ok: true, token, path: s.path }
  }

  ipcMain.handle('video:begin', async (e, o) => {
    const opt = o || {}
    if (opt.confirm != null) return confirmReplace(e, String(opt.confirm))
    const kind = opt.kind === 'png' || opt.kind === 'jpg' ? opt.kind : 'mp4'
    const single = kind !== 'mp4' && opt.frames === 1
    const win = BrowserWindow.fromWebContents(e.sender)
    const pic = kind === 'png' ? 'PNG' : 'JPEG'
    // 系统保存框画在主进程、呈现层翻译够不着：按发起窗口的界面语言（opt.lang）现出字
    const en = opt.lang === 'en'
    const filters = kind === 'mp4'
      ? [{ name: en ? 'MP4 video (H.264)' : 'MP4 视频（H.264）', extensions: ['mp4'] }]
      : [{ name: pic + (en ? (single ? ' image' : ' image sequence') : (single ? ' 图片' : ' 图片序列')), extensions: [kind] }]
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: kind === 'mp4' ? (en ? 'Export Video' : '导出视频') : single ? (en ? 'Export Image' : '导出图片') : (en ? 'Export Image Sequence' : '导出图片序列'),
      defaultPath: safeSaveName(opt.defaultName, en ? 'video' : '视频') + '.' + kind,
      filters
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    const token = 'v' + (++seq) + '_' + Date.now().toString(36)
    let exists = 0
    try {
      if (kind === 'mp4') {
        const fd = fs.openSync(filePath, 'w')
        sessions.set(token, { kind, sender: e.sender.id, fd, path: filePath, count: 0, bytes: 0 })
      } else {
        const dir = path.dirname(filePath)
        const ext0 = path.extname(filePath)
        const stem = path.basename(filePath, ext0) || 'frame'
        fs.mkdirSync(dir, { recursive: true })
        if (single) {
          // 扩展名对得上就原样用（保存框的覆盖确认问的就是这个路径），否则按格式补
          const e0 = ext0.toLowerCase()
          const file = e0 === '.' + kind || (kind === 'jpg' && e0 === '.jpeg') ? filePath : path.join(dir, stem + '.' + kind)
          sessions.set(token, { kind, sender: e.sender.id, single: true, dir, path: file, count: 0, bytes: 0 })
        } else {
          const digits = Math.max(4, String(Math.max(1, opt.frames | 0)).length)
          exists = (await oldFrames(dir, stem, kind, digits)).length   // 有旧帧：会话先挂起，确认「替换」后才收帧
          sessions.set(token, { kind, sender: e.sender.id, dir, stem, ext: kind, digits, pending: exists > 0, path: path.join(dir, stem + '_' + '1'.padStart(digits, '0') + '.' + kind), count: 0, bytes: 0 })
        }
      }
      // 窗口被关 / 重载：没收尾的会话一律按放弃处理（MP4 半成品删掉），不留句柄
      if (!e.sender.__videoHooked) {
        e.sender.__videoHooked = true
        const id = e.sender.id
        e.sender.once('destroyed', () => { for (const [t, s] of [...sessions]) if (s.sender === id) closeSession(t, false) })
      }
      return { ok: true, token, path: sessions.get(token).path, exists }
    } catch (err) {
      return { ok: false, error: ioErr(err, kind) }
    }
  })

  ipcMain.handle('video:write', (e, token, position, bytes) => {
    const s = sessions.get(token)
    if (!s || s.fd == null || s.sender !== e.sender.id) return { ok: false, error: '导出会话已结束' }
    if (!Number.isSafeInteger(position) || position < 0) return { ok: false, error: '写入位置无效' }
    try {
      const b = Buffer.from(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength != null ? bytes.byteLength : bytes.length)
      for (let off = 0; off < b.length;) off += fs.writeSync(s.fd, b, off, b.length - off, position + off)
      s.count++; s.bytes = Math.max(s.bytes, position + b.length)
      return { ok: true }
    } catch (err) { return { ok: false, error: ioErr(err, s.kind) } }
  })

  ipcMain.handle('video:frame', (e, token, index, bytes) => {
    const s = sessions.get(token)
    if (!s || s.kind === 'mp4' || s.sender !== e.sender.id) return { ok: false, error: '导出会话已结束' }
    if (s.pending) return { ok: false, error: '导出会话未就绪' }   // 覆盖还没确认：一帧都不能落，否则旧帧被逐个盖掉却没问过
    // 帧号只收正整数：它直接拼进文件名，收字符串就能拼出「../」写到所选目录之外
    if (!Number.isSafeInteger(index) || index < 1 || (s.single && index !== 1)) return { ok: false, error: '帧号无效' }
    try {
      const file = s.single ? s.path : path.join(s.dir, s.stem + '_' + String(index).padStart(s.digits, '0') + '.' + s.ext)
      if (path.dirname(file) !== s.dir) return { ok: false, error: '帧号无效' }
      const b = Buffer.from(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength != null ? bytes.byteLength : bytes.length)
      fs.writeFileSync(file, b)
      s.count++; s.bytes += b.length
      return { ok: true }
    } catch (err) { return { ok: false, error: ioErr(err, s.kind) } }
  })

  ipcMain.handle('video:end', (_e, token, keep) => {
    const s = closeSession(token, !!keep)
    if (!s) return { ok: false, error: '导出会话已结束' }
    let bytes = s.bytes
    if (s.kind === 'mp4' && keep) { try { bytes = fs.statSync(s.path).size } catch { /* 读不到大小不碍事 */ } }
    if (keep && !s.pending) exported.add(path.normalize(s.path))   // 挂起中收掉的会话（确认框点了取消）一帧没写，不进白名单
    return { ok: true, path: s.path, bytes, frames: s.kind === 'mp4' ? undefined : s.count }
  })

  ipcMain.handle('video:reveal', (_e, p) => {
    const q = path.normalize(String(p || ''))
    if (!exported.has(q)) return { ok: false }
    shell.showItemInFolder(q)
    return { ok: true }
  })
  ipcMain.handle('video:openPath', async (_e, p) => {
    const q = path.normalize(String(p || ''))
    if (!exported.has(q)) return { ok: false }
    const err = await shell.openPath(q)
    return err ? { ok: false, error: err } : { ok: true }
  })
}

module.exports = { registerVideoIpc }
