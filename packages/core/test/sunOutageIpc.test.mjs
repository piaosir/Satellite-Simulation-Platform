// 日凌主进程接线自测（electron/ipc/register.js 的 sunoutage:* / suntool:*）。运行：npm test
//
// 为什么要这一条：验证台（.sunharness）桩掉的恰恰是这一层，单测又只测到引擎与版式，
// 中间「handler 有没有注册 / seasons 传没传对 / 轨迹缓存跨 IPC 有没有复用 / 关窗守卫接没接上」
// 从来没人看着。这里用一个假 electron 把 register.js 原样装起来，直接调它的 handler。
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
const require = createRequire(import.meta.url)
const Module = require('module')

// 单测不许摸网络，也不许往仓库里造数据目录：SWPC 服务一律离线 + 临时数据目录。
// 两段断言各自切 SATSIM_SWPC_BUNDLE_DIR（没有内置快照 → 缺省 120；指向夹具 → 按分点日取预测值）。
process.env.SATSIM_SWPC_OFFLINE = '1'
process.env.SATSIM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sunipc-'))
delete process.env.SATSIM_SWPC_BUNDLE_DIR

const handlers = new Map()
let closedCalled = 0
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  app: { getPath: () => '.', isPackaged: false },
  shell: { openExternal: async () => {}, openPath: async () => {}, showItemInFolder: () => {} },
  nativeTheme: { on: () => {} }
}
const orig = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, ...rest)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..').split(path.sep).join('/')
const core = require(ROOT + '/packages/core/index.js')
const report = require(ROOT + '/electron/services/report.js')
const { register } = require(ROOT + '/electron/ipc/register.js')

register({
  core: () => core, storage: {}, report,
  coverage: {}, coverageGrd: {}, coverageGxt: {}, share: {}, grd: {},
  openSunOutage: () => {}, confirmCloseSunOutage: () => { closedCalled++ },
  activation: { current: () => ({ active: true }), start: () => {} },
  perfWin: {}, freqPlan: {}, weather: {}, gfs: {}, updater: {}
})

let pass = 0, fail = 0
const ok = (n, c, x) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? `  (${x})` : '')); c ? pass++ : fail++ }
const call = (ch, ...a) => handlers.get(ch)({ sender: {} }, ...a)

ok('注册了 sunoutage:compute', handlers.has('sunoutage:compute'))
ok('注册了 sunoutage:computeBatch', handlers.has('sunoutage:computeBatch'))
ok('注册了 sunoutage:exportExcel', handlers.has('sunoutage:exportExcel'))
ok('注册了 sunoutage:exportWord', handlers.has('sunoutage:exportWord'))
ok('注册了 sunoutage:exportIcs', handlers.has('sunoutage:exportIcs'))
ok('注册了 suntool:confirmClose', handlers.has('suntool:confirmClose'))
ok('注册了 sunoutage:solarFlux', handlers.has('sunoutage:solarFlux'))
ok('注册了 sunoutage:solarFluxRefresh', handlers.has('sunoutage:solarFluxRefresh'))

const BASE = { lat: 39.9042, lon: 116.4074, satLon: 130.5, diameter: 2.4, band: 'Ku', customFreq: 12.5, sysTemp: 150, year: 2026, degThreshold: 1 }

// ① seasons 选择
{
  const out = await call('sunoutage:computeBatch', [{ ...BASE, seasons: ['vernal'] }])
  ok('① seasons:[vernal] 只回春分', out[0].vernal && out[0].vernal.error === false && out[0].autumnal === null)
  const both = await call('sunoutage:computeBatch', [{ ...BASE }])
  ok('① 不传 seasons 回两季（SLA 那条链路行为不变）', !!both[0].vernal && !!both[0].autumnal)
  ok('① 两季 seasonName 对', both[0].vernal.seasonName === '春分' && both[0].autumnal.seasonName === '秋分')
}

// ② 星历档 + 跨 IPC 轨迹 LRU
{
  const { gunzipSync } = require('node:zlib')
  const { readFileSync } = require('node:fs')
  const txt = gunzipSync(readFileSync(ROOT + '/resources/omm/csv_geo.csv.gz')).toString('utf8')
  const head = txt.split(/\r?\n/)[0].split(',')
  const row = txt.split(/\r?\n/).find((l) => l.startsWith('ZHONGXING-6C,')).split(',')
  const o = {}; head.forEach((k, i) => (o[k] = row[i]))
  const orbit = {
    type: 'omm', noradId: o.NORAD_CAT_ID, epoch: o.EPOCH, meanMotion: +o.MEAN_MOTION,
    ecc: +o.ECCENTRICITY, incl: +o.INCLINATION, raan: +o.RA_OF_ASC_NODE,
    argp: +o.ARG_OF_PERICENTER, ma: +o.MEAN_ANOMALY, bstar: +o.BSTAR, mdot: +o.MEAN_MOTION_DOT, mddot: +o.MEAN_MOTION_DDOT
  }
  const p = { ...BASE, satLon: undefined, orbit, seasons: ['autumnal'] }
  const t0 = Date.now(); const a = await call('sunoutage:computeBatch', [p]); const ms1 = Date.now() - t0
  const t1 = Date.now(); const b = await call('sunoutage:computeBatch', [{ ...p, lat: 43.8256, lon: 87.6168 }]); const ms2 = Date.now() - t1
  ok('② 星历档算得出', a[0].autumnal.error === false && a[0].autumnal.satSource === 'ephemeris', a[0].autumnal.totalDays + ' 天')
  ok('② 第二次 IPC 复用轨迹（LRU 生效）', ms2 < Math.max(30, ms1 * 0.5), `${ms1} ms → ${ms2} ms`)
  ok('② 第二站也算得出', b[0].autumnal.error === false)
  // 非同步：拒算
  const bad = await call('sunoutage:computeBatch', [{ ...p, orbit: { ...orbit, meanMotion: 2 } }])
  ok('② 非同步轨道拒算', bad[0].autumnal.error === true && /GSO/.test(bad[0].autumnal.message))
  // 引用形状：本期报「星历不在库中」
  const ref = await call('sunoutage:computeBatch', [{ ...p, orbit: { type: 'ephem', ref: { groupId: 'g', satId: 's' } } }])
  ok('② 带 ref 的星历报「不在库中」', ref[0].autumnal.error === true && /不在库中/.test(ref[0].autumnal.message), ref[0].autumnal.message)
}

// ③ 纯几何档过 IPC
{
  const out = await call('sunoutage:computeBatch', [{ ...BASE, criterion: 'geometric', seasons: ['autumnal'] }])
  const r = out[0].autumnal
  ok('③ 纯几何档过 IPC', r.error === false && r.thresholdAngle === r.beamWidth && r.model.thresholdAngleSource === 'beamwidth')
}

// ④ 结果过结构化克隆（IPC 的硬约束）
{
  const out = await call('sunoutage:computeBatch', [{ ...BASE }])
  let cloneOk = true
  try { structuredClone(out) } catch { cloneOk = false }
  ok('④ 批量结果过 structuredClone', cloneOk)
}

// ⑤ F10.7 按分点日自动填（渲染端不传，界面上也没有这个输入）
{
  const solarFlux = require(ROOT + '/electron/services/solarFlux.js')
  // 本机什么都没有：引擎走缺省 120，来源如实写 default —— 取不到数也必须算得出来
  solarFlux._reset()
  const bare = (await call('sunoutage:computeBatch', [{ ...BASE, seasons: ['autumnal'] }]))[0].autumnal
  ok('⑤ 无任何 F10.7 数据 → f107 是数、来源 default', typeof bare.model.f107 === 'number' && bare.model.f107 === 120 && bare.model.f107Source === 'default', `${bare.model.f107} / ${bare.model.f107Source}`)
  ok('⑤ 缺省档是 norp', bare.model.solarModel === 'norp')

  // 指向夹具（只有观测月均 + 太阳周预测）：2026 秋分落在预测覆盖里 → predicted ≈ 129.6
  process.env.SATSIM_SWPC_BUNDLE_DIR = ROOT + '/packages/core/test/fixtures/swpc'
  solarFlux._reset()
  const out = await call('sunoutage:computeBatch', [{ ...BASE }])
  const au = out[0].autumnal, ve = out[0].vernal
  ok('⑤ 有数据 → 秋分按分点日取到预测值', au.model.f107Source === 'predicted' && Math.abs(au.model.f107 - 129.6) < 0.5, `${au.model.f107Source} ${au.model.f107}`)
  ok('⑤ f107Meta 原样回显到 model', au.model.f107At === '2026-09 ~ 2026-10' && au.model.f107FetchedAt === '2026-09-21T00:00:00.000Z' && au.model.f107Low > 0 && au.model.f107High > au.model.f107Low,
    `${au.model.f107At} · ${au.model.f107FetchedAt} · ${au.model.f107Low}~${au.model.f107High}`)
  // ★ 两季各取各的：春分与秋分相隔半年，一份入参填不了两季
  ok('⑤ 春分取的是另一个日子的 F10.7（不是秋分那份照抄）', ve.model.f107 !== au.model.f107 && ve.model.f107At !== au.model.f107At,
    `春 ${ve.model.f107.toFixed(1)} @${ve.model.f107At} · 秋 ${au.model.f107.toFixed(1)} @${au.model.f107At}`)
  ok('⑤ F10.7 真进了算式（太阳亮温随之变）', au.model.solarTemp !== bare.model.solarTemp, `${bare.model.solarTemp} → ${au.model.solarTemp}`)
  // 显式传 f107 / solarTemp 的调用方不被覆盖
  const fixed = (await call('sunoutage:computeBatch', [{ ...BASE, f107: 200, seasons: ['autumnal'] }]))[0].autumnal
  ok('⑤ 调用方显式传 f107 → 不被自动填覆盖', fixed.model.f107 === 200 && fixed.model.f107Source === 'default')
  const man = (await call('sunoutage:computeBatch', [{ ...BASE, solarTemp: 9000, seasons: ['autumnal'] }]))[0].autumnal
  ok('⑤ 显式传 solarTemp → 仍是 manual、f107 为 null', man.model.solarTempSource === 'manual' && man.model.f107 === null && man.model.solarTemp === 9000)

  // 读数那两条
  const st = await call('sunoutage:solarFlux')
  ok('⑤ sunoutage:solarFlux 回数据时间与来源', st.source === 'bundled' && st.fetchedAt === '2026-09-21T00:00:00.000Z' && st.products.predicted, JSON.stringify(st))
  const st2 = await call('sunoutage:solarFluxRefresh')
  ok('⑤ sunoutage:solarFluxRefresh 离线也回 status、不抛', !!st2 && st2.source === 'bundled')
  ok('⑤ 两条读数通道过 structuredClone', (() => { try { structuredClone(st); structuredClone(st2); return true } catch { return false } })())
}

// ⑥ 关窗守卫
{
  await call('suntool:confirmClose')
  ok('⑥ suntool:confirmClose 打到 confirmCloseSunOutage', closedCalled === 1)
}

// ⑦ 三个导出：取消保存框也不该抛
for (const ch of ['sunoutage:exportExcel', 'sunoutage:exportWord', 'sunoutage:exportIcs']) {
  let r = null, threw = ''
  try { r = await call(ch, { sat: { name: 'X', slotText: '130.5°E' }, year: 2026, seasons: ['vernal'], stations: [] }) }
  catch (e) { threw = e.message }
  ok('⑦ ' + ch + ' 不抛', !threw, threw || JSON.stringify(r))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
