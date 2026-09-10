// 自动更新「启动时补装」的决策逻辑自测（electron/services/updaterPending.js）。运行：npm test
//
// 为什么测：这套逻辑只在打包后的机器上跑、又全程静默，出了错没有任何界面反馈。这里钉死：
// ① 版本比较不按字符串（1.4.10 > 1.4.8）；② 决策矩阵的每一格（安装器重开 / 安装进行中 /
// 版本已到 / 包不在 / 次数用尽 / 该装）；③ 同一个包重复触发 update-downloaded 时 attempts 不复位，
// 否则「尝试两次就放弃」的闸每个会话都会被复位；④ 标记读写与 sha512 口径（base64）。
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const P = require('../../../electron/services/updaterPending.js')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }

// ① 版本比较
eq(P.cmpVersion('1.4.10', '1.4.8'), 1, '1.4.10 > 1.4.8（不按字符串）')
eq(P.cmpVersion('1.4.8', '1.4.8'), 0, '相等')
eq(P.cmpVersion('1.4.7', '1.4.8'), -1, '小于')
eq(P.cmpVersion('1.5', '1.4.9'), 1, '段数不同按缺省 0 补')
eq(P.cmpVersion('1.4.8-beta', '1.4.8'), 0, '预发布后缀忽略')
eq(P.cmpVersion(undefined, '1.4.8'), -1, '空版本视为 0')

// ② 决策矩阵
const NOW = 1_700_000_000_000
const base = { version: '1.4.8', file: 'C:/pending/x-1.4.8-Setup.exe', sha512: 'abc', attempts: 0, installing: false }
const run = (marker, extra = {}) => P.decide({
  marker, currentVersion: '1.4.7', argv: [], now: NOW,
  pidAlive: () => false, fileExists: () => true, ...extra
}).action

eq(run(null), 'none', '无标记 → none')
eq(run(base), 'install', '新版本 + 包在 + 没试过 → install')
eq(run(base, { argv: ['app.exe', '--updated'] }), 'clear', '安装器重开（--updated）→ clear')
eq(run({ ...base, version: '1.4.7' }), 'clear', '版本已到 → clear')
eq(run({ ...base, version: '1.4.6' }), 'clear', '标记版本比当前还旧 → clear')
eq(run(base, { fileExists: () => false }), 'clear', '包不在了 → clear')
eq(run({ ...base, attempts: P.MAX_ATTEMPTS }), 'skip', '尝试次数用尽 → skip（标记留着交给退出时安装）')
eq(run({ ...base, attempts: P.MAX_ATTEMPTS - 1 }), 'install', '还差一次 → install')
eq(run({ version: '1.4.8' }), 'clear', '标记残缺 → clear')
eq(run({ ...base, sha512: 123 }), 'clear', 'sha512 不是字符串 → clear')

const inflight = { ...base, installing: true, installStartedAt: NOW - 60_000, installerPid: 4242 }
eq(run(inflight, { pidAlive: (pid) => pid === 4242 }), 'exit', '安装进行中且 pid 活着 → exit')
eq(run(inflight, { pidAlive: () => false }), 'install', '安装进行中但安装器已死 → 重试 install')
eq(run({ ...inflight, installStartedAt: NOW - P.INSTALL_GRACE_MS - 1 }, { pidAlive: () => true }), 'install', '超出判定窗口 → 不信 pid，重试 install')
eq(run(inflight, { pidAlive: () => true, argv: ['--updated'] }), 'clear', '安装器重开优先于「安装进行中」，否则新版会被自己挡在门外')
eq(run({ ...inflight, version: '1.4.7' }, { pidAlive: () => true }), 'exit', '安装进行中的判定先于版本判定：老版本残余实例也得退')

// ③ update-downloaded 载荷 → 标记；同包保留 attempts
const payload = { version: '1.4.8', files: [{ url: 'x-1.4.8-Setup.exe', sha512: 'S1', size: 1 }], path: 'x-1.4.8-Setup.exe', sha512: 'S1', releaseDate: '2026-09-10', downloadedFile: 'C:/pending/x-1.4.8-Setup.exe' }
const m1 = P.markerFromDownloaded(payload, null, NOW)
eq({ version: m1.version, file: m1.file, sha512: m1.sha512, attempts: m1.attempts, installing: m1.installing, admin: m1.isAdminRightsRequired },
  { version: '1.4.8', file: 'C:/pending/x-1.4.8-Setup.exe', sha512: 'S1', attempts: 0, installing: false, admin: false }, '载荷映射')
eq(P.markerFromDownloaded(payload, { ...m1, attempts: 2, installing: true }, NOW).attempts, 2, '同一个包重复触发保留 attempts')
eq(P.markerFromDownloaded(payload, { ...m1, attempts: 2, installing: true }, NOW).installing, false, '重复触发时 installing 复位（程序在跑就不可能有安装在进行）')
eq(P.markerFromDownloaded({ ...payload, sha512: 'S2', files: [{ url: 'y', sha512: 'S2' }] }, { ...m1, attempts: 2 }, NOW).attempts, 0, '换了包 attempts 归零')
eq(P.markerFromDownloaded({ ...payload, sha512: undefined }, null, NOW).sha512, 'S1', '顶层没 sha512 时取 files[0]')
eq(P.markerFromDownloaded({ ...payload, files: [{ url: 'x', sha512: 'S1', isAdminRightsRequired: true }] }, null, NOW).isAdminRightsRequired, true, 'files[0].isAdminRightsRequired 也认')
eq(P.markerFromDownloaded({ ...payload, downloadedFile: undefined }, null, NOW), null, '缺路径 → null（不落标记）')
eq(P.markerFromDownloaded({ ...payload, sha512: undefined, files: [] }, null, NOW), null, '缺 sha512 → null')

// ④ 标记读写 + sha512 口径
const dir = mkdtempSync(join(tmpdir(), 'satsim-upd-'))
try {
  const mf = P.markerPath(dir)
  eq(P.readMarker(mf), null, '没有文件 → null')
  P.writeMarker(mf, m1)
  eq(P.readMarker(mf), m1, '写后读回一致')
  ok(!existsSync(mf + '.tmp'), '临时文件已改名，不残留')
  writeFileSync(mf, '{ broken')
  eq(P.readMarker(mf), null, '坏 JSON → null')
  writeFileSync(mf, '[1,2]')
  eq(P.readMarker(mf), null, '不是对象 → null')
  P.removeMarker(mf)
  ok(!existsSync(mf), '删除')
  P.removeMarker(mf)
  pass++ // 重复删除不抛

  const pkg = join(dir, 'fake-Setup.exe')
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a)
  writeFileSync(pkg, bytes)
  const want = createHash('sha512').update(bytes).digest('base64')
  eq(await P.hashFileSha512(pkg), want, 'sha512 走 base64，与 latest.yml 同口径')
  await assert.rejects(P.hashFileSha512(join(dir, 'nope.exe')), '文件不存在 → reject')
  pass++
} finally {
  rmSync(dir, { recursive: true, force: true })
}

eq(P.INSTALLER_ARGS, ['--updated', '/S', '--force-run'], '安装器参数与 electron-updater quitAndInstall(true, true) 一致')

console.log(`updaterPending: ${pass} 项通过`)
