// 「检查更新」状态快照的自测（electron/services/updaterState.js）。运行：npm test
//
// 为什么测：快照只在打包后的机器上由真实网络事件驱动，开发模式一条事件都不会来。这里钉死：
// ① 事件 → phase 的每一条边；② 两条防抖（下载中 / 已下载时再检查不打回 checking 与 0%，同版本
// 再次 available 原样保持）；③ 已下载后的错误不降级；④ 错误文字归类；⑤ 无关事件返回同一个对象
// （主进程按引用判断「有没有变化」再广播）。
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const S = require('../../../electron/services/updaterState.js')

let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }

const NOW = 1_700_000_000_000
const r = (s, ev) => S.reduce(s, ev, NOW)

// ① 初始与基本路径
const s0 = S.initial('1.4.8')
eq(s0, { phase: 'idle', current: '1.4.8', latest: '', percent: 0, transferred: 0, total: 0, error: '', checkedAt: 0 }, '初始快照')
eq(S.initial(undefined).current, '', '无版本号不抛')

const chk = r(s0, { type: 'checking' })
eq(chk.phase, 'checking', 'idle → checking')
const lat = r(chk, { type: 'not-available', version: '1.4.8' })
eq([lat.phase, lat.latest, lat.checkedAt], ['latest', '1.4.8', NOW], 'not-available → latest，记检查时刻')
eq(r(chk, { type: 'not-available' }).latest, '1.4.8', 'not-available 缺版本号时最新 = 当前')

const avail = r(chk, { type: 'available', version: '1.4.9' })
eq([avail.phase, avail.latest, avail.percent], ['downloading', '1.4.9', 0], 'available → downloading 0%')
const p1 = r(avail, { type: 'progress', percent: 37.6, transferred: 3_000_000, total: 8_000_000 })
eq([p1.phase, p1.percent, p1.transferred, p1.total], ['downloading', 37.6, 3_000_000, 8_000_000], '进度')
eq(r(avail, { type: 'progress', percent: 140 }).percent, 100, '进度封顶 100')
eq(r(avail, { type: 'progress', percent: 'x', transferred: -1 }).percent, 0, '进度非数视为 0')
const dl = r(p1, { type: 'downloaded', version: '1.4.9' })
eq([dl.phase, dl.percent, dl.latest], ['downloaded', 100, '1.4.9'], 'downloaded → 100%')
eq(r(s0, { type: 'disabled' }).phase, 'disabled', '开发模式 disabled')

// ② 防抖：下载中 / 已下载时再检查
ok(r(p1, { type: 'checking' }) === p1, '下载中再检查：同一个对象，不打回 checking')
eq(r(p1, { type: 'available', version: '1.4.9' }).percent, 37.6, '下载中同版本再次 available：进度保持')
eq(r(p1, { type: 'available', version: '1.4.10' }).percent, 0, '下载中出现更新的版本：重新从 0% 下')
ok(r(dl, { type: 'checking' }) === dl, '已下载再检查：同一个对象')
const dl2 = r(dl, { type: 'available', version: '1.4.9' })
eq([dl2.phase, dl2.percent], ['downloaded', 100], '已下载同版本再次 available：仍是 downloaded 100%')
eq(r(dl, { type: 'available', version: '1.4.10' }).phase, 'downloading', '已下载但源上又出了更新的版本：重新下载')
ok(r(dl, { type: 'progress', percent: 50 }) === dl, '已下载后的迟到进度事件忽略')
eq(r(dl, { type: 'not-available', version: '1.4.8' }).phase, 'latest', '源回滚到当前版本：latest（已下载的包作废）')

// ③ 错误：已下载不降级；其余进 error
const e1 = r(chk, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
eq([e1.phase, e1.error], ['error', '无法连接更新服务器'], '检查出错 → error + 归类文字')
const e2 = r(dl, { type: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
eq([e2.phase, e2.error], ['downloaded', '无法连接更新服务器'], '已下载后出错：仍是 downloaded，错误只记字段')
eq(r(e2, { type: 'checking' }).error, '', '再检查清掉错误字段（仍是 downloaded 对象的拷贝）')
eq(r(e1, { type: 'checking' }).phase, 'checking', 'error 后再检查 → checking')
eq(r(p1, { type: 'error', message: 'ECONNRESET' }).phase, 'error', '下载中断 → error')

// ④ 错误文字归类
eq(S.friendlyError('Error: getaddrinfo ENOTFOUND update-1385987144.cos.ap-beijing.myqcloud.com'), '无法连接更新服务器', 'DNS 失败')
eq(S.friendlyError(new Error('net::ERR_CONNECTION_TIMED_OUT')), '无法连接更新服务器', 'Error 对象也认')
eq(S.friendlyError('sha512 checksum mismatch, expected abc, got def'), '安装包校验失败', '校验失败')
eq(S.friendlyError('HttpError: 404 Not Found\nmethod: GET url: https://x/latest.yml'), '更新源上没有版本描述文件', '404')
eq(S.friendlyError('This file could not be downloaded ERR_UPDATER_INVALID_VERSION'), '更新源的版本号无效', '版本号无效')
eq(S.friendlyError('cancelled'), '下载已取消', '取消')
eq(S.friendlyError('Something odd\nsecond line'), 'Something odd', '未归类：取首行')
eq(S.friendlyError(''), '未知错误', '空 → 未知错误')
eq(S.friendlyError(null), '未知错误', 'null → 未知错误')
eq(S.friendlyError('x'.repeat(200)).length, 160, '超长截断')

// ⑤ 无关事件：同一个对象（主进程按引用判变化）
ok(r(s0, { type: 'nope' }) === s0, '未知事件返回原对象')
ok(r(s0, null) === s0, '空事件返回原对象')

console.log(`updaterState: ${pass} 项通过`)
