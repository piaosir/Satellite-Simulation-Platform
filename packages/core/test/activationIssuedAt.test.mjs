// 激活书「远期 issuedAt」拒收 + activation.log 分类节流（2026-10-16 通信审查修复轮）。
//
// 审查离线复现过的病灶：一份签名合法、issuedAt 在远期的激活书一旦被采纳，重放下限与时钟锚都被抬到未来——
// 离线开机即 'clock' 锁；之后管理端正常签发的撤销书全被当成重放件拒收。
//
// 签名：本单测不持有管理端私钥。activation.js 在 require 时解构了 crypto.verify，故在 require 之前把 verify
// 换成「认得本测试的签名就放行、其余照走真验签」的包装 —— 这里验的是 issuedAt / 重放下限 / 时钟锚这几条判据；
// 真签名链路由 .mgrharness/smoke.mjs 用管理端真私钥覆盖。share / storage 都是内存桩，不碰网络不碰盘。
import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.error('  ✗ ' + msg + (extra ? '  ← ' + extra : '')) } }

const TEST_SIG = Buffer.from('satsim-unit-test-signature').toString('base64')
const realVerify = crypto.verify
crypto.verify = function (alg, data, key, sig, ...rest) {
  if (Buffer.isBuffer(sig) && sig.toString('base64') === TEST_SIG) return true
  return realVerify.call(this, alg, data, key, sig, ...rest)
}
const createActivation = require(path.join(ROOT, 'electron/services/activation.js'))

const DAY = 86400e3
const ID = 'UTDEV00001'
const LIC = `share/mgr/lic/${ID}.json`
const lic = (o) => ({ v: 1, id: ID, status: 'active', plan: 'perm', activatedAt: 1, expiresAt: 0, issuedBy: 'master1', issuedAt: Date.now(), sig: TEST_SIG, ...o })

// share 内存桩：serverNow 可控（0 = 本进程还没拿到过 COS 的 Date 头）；failNext 让下一次读抛指定错误
function mkEnv(settings) {
  const S = { deviceId: ID, ...(settings || {}) }
  const mem = new Map()
  const env = {
    S, mem, SN: 0, failNext: null, failPut: null, lines: [],
    storage: { getSettings: () => S, setSettings: (p) => Object.assign(S, p) }
  }
  env.share = {
    configured: () => true,
    prefixOf: () => 'share',
    serverNow: () => env.SN,
    serverDate: () => env.SN,
    getJsonStrict: async (k) => {
      if (env.failNext) { const e = env.failNext; env.failNext = null; throw e }
      return mem.has(k) ? JSON.parse(JSON.stringify(mem.get(k))) : null
    },
    getJson: async (k, f) => (mem.has(k) ? mem.get(k) : f),
    putJson: async (k, o) => { if (env.failPut) throw env.failPut; mem.set(k, o); return true }
  }
  env.log = { info: (s) => env.lines.push('I ' + s), warn: (s) => env.lines.push('W ' + s), error: (s) => env.lines.push('E ' + s), debug() {} }
  env.act = createActivation(env.share, env.storage, { log: env.log })
  return env
}

// ===================== ① 在线：远期件拒收，下限 / 锚 / 缓存都不动 =====================
console.log('在线：远期 issuedAt')
{
  const E = mkEnv()
  E.SN = Date.now()
  const t0 = Date.now() - 60e3
  E.mem.set(LIC, lic({ issuedAt: t0 }))
  let st = await E.act.refresh()
  ok(st.active === true && st.plan === 'perm', '前置：正常激活书采纳')
  ok(E.act._licFloor() === t0, '前置：重放下限 = 该件 issuedAt')

  E.mem.set(LIC, lic({ issuedAt: E.SN + 2 * DAY, plan: 'y5' }))
  st = await E.act.refresh()
  ok(st.active === true && st.state === 'active' && st.plan === 'perm', '★ 远期件（服务器时间 + 2 天）不采纳，维持原授权（没被锁成 clock）', JSON.stringify(st))
  ok(E.act._licFloor() === t0, '★ 重放下限没被抬到未来')
  ok(E.S.activationLic.plan === 'perm', '★ 本地缓存没被远期件覆盖')
  ok(E.lines.some((l) => /远期拒收/.test(l)), 'activation.log 记「远期拒收」')

  // 之后管理端正常签发的撤销书：issuedAt = 现在 —— 必须生效，不能被当重放件
  E.mem.set(LIC, lic({ status: 'inactive', plan: '', issuedAt: Date.now() }))
  st = await E.act.refresh()
  ok(st.active === false && st.state === 'revoked', '★ 远期件之后的正常撤销书照常生效（不被当成重放件）', JSON.stringify(st))

  // 管理端时钟偏快几小时：在一天容差之内，照常采纳
  E.mem.set(LIC, lic({ issuedAt: E.SN + 2 * 3600e3 }))
  st = await E.act.refresh()
  ok(st.active === true && st.state === 'active', '管理端时钟快 2 h（一天容差内）→ 照常采纳，且不锁 clock', JSON.stringify(st))
}

// ===================== ② 服务器时间优先：把本机钟拨快也收不进远期件 =====================
console.log('服务器时间优先于本机钟')
{
  const E = mkEnv()
  E.SN = Date.now() - 3 * DAY          // 本机钟比服务器快 3 天
  E.mem.set(LIC, lic({ issuedAt: Date.now() }))    // 对本机钟是「现在」，对服务器是 3 天后
  const st = await E.act.refresh()
  ok(st.active === false && st.state === 'none', '★ issuedAt 超出服务器时间 3 天 → 拒收（本机钟拨快不顶用）', JSON.stringify(st))
  ok(E.act._licFloor() === 0 && !E.S.activationLic, '下限与缓存都没动')
}

// ===================== ③ 离线开机：缓存里躺着远期件（修复前已被采纳的设备）=====================
console.log('离线开机')
{
  const E = mkEnv({ activationLic: lic({ issuedAt: Date.now() + 10 * DAY }) })
  E.SN = 0                                                  // 本进程从未联网成功
  const st = E.act.current()
  ok(st.state !== 'clock', `★ 离线开机不再被远期 issuedAt 锁成 clock（实得 ${st.state}）`)
  ok(st.active === false, '远期件本身也不被当成有效授权（否则它就是一张永远压过下限的重放票）')
  E.failNext = Object.assign(new Error('COS 连接失败（ERR_INTERNET_DISCONNECTED）'), { kind: 'net', code: 'ERR_INTERNET_DISCONNECTED' })
  const st2 = await E.act.refresh()
  ok(st2.state !== 'clock', '断网刷新一次后仍不是 clock')

  // 对照：缓存里是正常的已激活件，离线开机照常激活
  const E2 = mkEnv({ activationLic: lic({ issuedAt: Date.now() - DAY }) })
  ok(E2.act.current().active === true, '对照：正常件离线开机照常激活')
}

// ===================== ④ activation.log：分类与节流 =====================
console.log('activation.log')
{
  const E = mkEnv()
  E.SN = Date.now() - 3600e3           // 本机钟快 1 h：每行都带上，签名 403 / 时钟锁的头号嫌疑
  E.mem.set(LIC, lic({ issuedAt: Date.now() - 2 * 3600e3 }))
  await E.act.refresh()
  const n1 = E.lines.length
  for (let i = 0; i < 5; i++) await E.act.refresh()
  ok(n1 === 1 && /激活书 200 采纳/.test(E.lines[0]), '200 采纳记一行', E.lines.join(' | '))
  ok(E.lines.length === n1, '★ 同类结果节流：连拉 5 次不再刷行')
  ok(/本机钟 \+3600 s/.test(E.lines[0]), '每行带本机钟与服务器的差', E.lines[0])

  E.mem.delete(LIC)
  await E.act.refresh()
  ok(/激活书 404/.test(E.lines[1]) && /上条之后同类 ×5/.test(E.lines[1]), '类别一变立刻记，并附上条之后的同类次数', E.lines[1])

  E.failNext = Object.assign(new Error('COS 403: <Error><Code>AccessDenied</Code></Error>'), { kind: 'http', status: 403, cosCode: 'AccessDenied', fromCos: true })
  await E.act.refresh()
  ok(/HTTP 403 AccessDenied/.test(E.lines[2]), '403 + COS Code', E.lines[2])

  E.failNext = Object.assign(new Error('COS 连接失败（ERR_PROXY_CONNECTION_FAILED）'), { kind: 'net', code: 'ERR_PROXY_CONNECTION_FAILED' })
  await E.act.refresh()
  ok(/网络错/.test(E.lines[3]) && /ERR_PROXY_CONNECTION_FAILED/.test(E.lines[3]), '网络错带底层错误码（代理连不上一眼可见）', E.lines[3])

  E.failNext = new SyntaxError('Unexpected token \'<\'')
  await E.act.refresh()
  ok(/不是 JSON/.test(E.lines[4]), '门户劫持（200 + 网页）记成「返回内容不是 JSON」', E.lines[4])

  E.mem.set(LIC, { v: 1, id: ID, sig: 'AAAA' })
  await E.act.refresh()
  ok(/验签失败/.test(E.lines[5]), '验签失败', E.lines[5])

  E.mem.set(LIC, lic({ issuedAt: 1000 }))
  await E.act.refresh()
  ok(/重放拒收/.test(E.lines[6]), '重放拒收（早于下限）', E.lines[6])

  await E.act.heartbeat()
  ok(E.lines.some((l) => /心跳 200/.test(l)), '心跳 200')
  E.failPut = Object.assign(new Error('COS 403: x'), { kind: 'http', status: 403, cosCode: 'RequestTimeTooSkewed', fromCos: true })
  let threw = false
  try { await E.act.heartbeat() } catch { threw = true }
  ok(threw && E.lines.some((l) => /心跳 HTTP 403 RequestTimeTooSkewed/.test(l)), '心跳失败按类别记（403 + Code）')
}

crypto.verify = realVerify
console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`)
process.exit(fail ? 1 : 0)
