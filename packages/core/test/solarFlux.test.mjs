// 太阳射电流量 F10.7 取数自测：四个 NOAA SWPC 产品的解析、合并（部分刷新）、按日期取值五级
// 优先，以及主进程服务 electron/services/solarFlux.js 的「不联网也有数据」这条底线。运行：npm test
//
// 为什么要这一条：日凌的太阳亮温现在整个挂在 F10.7 上，而 F10.7 的取值规则（窗口、优先级、
// 月中点插值、末值外推）全是"对着日期挑数"的分支 —— 屏上只看得到一个数，错了没人发现。
// 规则全在 packages/core/utils/solarFluxPick.js 的纯函数里，这里逐条钉死。
//
// 夹具 fixtures/swpc/ 是 2026-09-21 从 SWPC 抓的真样本（观测月均截到 2020-01 起，省体积）。
// ★ 夹具里的合并快照 solar-flux.json 只放【月均 + 预测】两条长期产品：逐日那两条是滚动窗口，
//   放进夹具会让"某日该取哪一档"随抓取日漂，断言就钉不住了。逐日两档单独用原始产品文件验。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pick = require('../utils/solarFluxPick.js')
const { validSolarFlux } = require('../utils/solarFluxValid.js')

const FIX = path.join(HERE, 'fixtures/swpc')
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8')
const RAW = {
  daily30: read('10cm-flux-30-day.json'),
  forecast45: read('45-day-forecast.txt'),
  monthly: read('observed-solar-cycle-indices.json'),
  predicted: read('predicted-solar-cycle.json')
}
const AT = '2026-09-21T00:00:00.000Z'

let pass = 0, fail = 0
const ok = (n, c, x) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (x ? `  (${x})` : '')); c ? pass++ : fail++ }
const keys = (o) => Object.keys(o).sort()

/* ── ① 四个解析器：条数与首末值 ────────────────────────────────────────── */
{
  const d = pick.parseDaily30(RAW.daily30), kd = keys(d)
  ok('① 30 天观测日值 30 条、首末值对', kd.length === 30 && kd[0] === '2026-08-22' && d['2026-08-22'] === 124 && kd[29] === '2026-09-20' && d['2026-09-20'] === 101,
    `${kd.length} 条 ${kd[0]}=${d[kd[0]]} … ${kd[29]}=${d[kd[29]]}`)

  const f = pick.parseForecast45(RAW.forecast45), kf = keys(f)
  ok('① 45 天预报 45 条、首末值对（每行 5 对 DDMonYY value）', kf.length === 45 && kf[0] === '2026-09-21' && f['2026-09-21'] === 105 && kf[44] === '2026-11-04' && f['2026-11-04'] === 110,
    `${kf.length} 条 ${kf[0]}=${f[kf[0]]} … ${kf[44]}=${f[kf[44]]}`)
  // ★ 同一份文本里 45-DAY AP FORECAST 块的格式一模一样，串块就会多出 45 个错值
  ok('① 45 天预报不串到 AP 块（AP 值 005 不该出现在 F10.7 序列里）', Object.values(f).every((v) => v > 50), JSON.stringify(Object.values(f).filter((v) => v <= 50)))

  const m = pick.parseMonthly(RAW.monthly), km = keys(m)
  ok('① 观测月均 80 条（夹具自 2020-01）、首末值对', km.length === 80 && km[0] === '2020-01' && m['2020-01'] === 72.32 && km[79] === '2026-08' && m['2026-08'] === 116.22,
    `${km.length} 条 ${km[0]}=${m[km[0]]} … ${km[79]}=${m[km[79]]}`)
  ok('① 观测月均剔掉 -1（缺测）', Object.values(m).every((v) => v > 0))

  const p = pick.parsePredicted(RAW.predicted), kp = keys(p)
  ok('① 太阳周预测 58 条、带 low / high、首末值对',
    kp.length === 58 && kp[0] === '2026-03' && p['2026-03'].f === 137.4 && kp[57] === '2030-12' && p['2030-12'].f === 70.3 && p['2030-12'].lo === 67.8 && p['2030-12'].hi === 72.8,
    `${kp.length} 条 ${kp[0]}=${p[kp[0]].f} … ${kp[57]}=${p[kp[57]].f}`)
  ok('① 2026-09 预测 = 129.6 / 120.4 / 137（任务书 §5.1 的实测样例）',
    p['2026-09'].f === 129.6 && p['2026-09'].lo === 120.4 && p['2026-09'].hi === 137, JSON.stringify(p['2026-09']))

  // 垃圾输入不许抛，一律回空表
  for (const [nm, fn] of [['daily30', pick.parseDaily30], ['forecast45', pick.parseForecast45], ['monthly', pick.parseMonthly], ['predicted', pick.parsePredicted]]) {
    let threw = ''
    try { fn('<html>404</html>'); fn(''); fn(null); fn('{]') } catch (e) { threw = e.message }
    ok('① ' + nm + ' 解析垃圾输入不抛、回空表', !threw && Object.keys(fn('<html>404</html>')).length === 0, threw)
  }
}

/* ── ② f107For 五级优先各命中一次 ─────────────────────────────────────── */
const ALL = pick.mergeProducts(null, RAW, AT)         // 四条全有：逐日两档才验得到
const LONG = JSON.parse(read('solar-flux.json'))      // 只有月均 + 预测：内置快照的形状
{
  // 逐日·全观测：目标 2026-08-31 → 窗口 08-11~09-20，观测覆盖 30 天、预报一天都没进窗口
  const a = pick.f107For(ALL, '2026-08-31')
  ok('② 逐日（全观测）→ source=daily、at 写窗口起止', a.source === 'daily' && a.at === '2026-08-11 ~ 2026-09-20' && Math.abs(a.f107 - 111.4) < 0.01, JSON.stringify(a))

  // 逐日·含预报：目标 2026-10-21 → 窗口全落在 45 天预报里
  const b = pick.f107For(ALL, '2026-10-21')
  ok('② 逐日（含预报）→ source=forecast45', b.source === 'forecast45' && Math.abs(b.f107 - 106.8) < 0.01, JSON.stringify(b))

  // 观测月均：2020-06 在月表里
  const c = pick.f107For(LONG, '2020-06-15')
  ok('② 观测月均 → source=monthly、at=YYYY-MM', c.source === 'monthly' && c.at === '2020-06' && c.f107 === 69.7, JSON.stringify(c))

  // 预测插值：2028-03-10 落在 2028-02 与 2028-03 两个月中点之间
  const d = pick.f107For(LONG, '2028-03-10')
  ok('② 预测 → source=predicted、相邻月中点线性插值、带 low/high',
    d.source === 'predicted' && d.at === '2028-02 ~ 2028-03' && d.f107 > 94 && d.f107 < 97 && d.low > 0 && d.high > d.low, JSON.stringify(d))
  const p = pick.parsePredicted(RAW.predicted)
  ok('② 插值真落在两端之间', d.f107 > Math.min(p['2028-02'].f, p['2028-03'].f) && d.f107 < Math.max(p['2028-02'].f, p['2028-03'].f),
    `${Math.min(p['2028-02'].f, p['2028-03'].f)} < ${d.f107.toFixed(2)} < ${Math.max(p['2028-02'].f, p['2028-03'].f)}`)

  // 预测末值外推：2033-01 在最后一个预测月（2030-12）之后 5 年内
  const e = pick.f107For(LONG, '2033-01-15')
  ok('② 预测末值 → source=predicted-tail、取末月值', e.source === 'predicted-tail' && e.at === '2030-12' && e.f107 === 70.3, JSON.stringify(e))
  ok('② 末值外推超过 5 年 → 回缺省', pick.f107For(LONG, '2040-01-15').source === 'default')

  // 缺省：1900-01 早于任何产品
  const g = pick.f107For(LONG, '1900-01-15')
  ok('② 早于全部产品 → source=default、120', g.source === 'default' && g.f107 === 120 && g.at === null, JSON.stringify(g))
  ok('② 没有任何数据 → source=default、120', pick.f107For(null, '2026-09-23').source === 'default' && pick.f107For({}, '2026-09-23').f107 === 120)
  ok('② 日期非法 → 不抛、回缺省', pick.f107For(ALL, 'not-a-date').source === 'default')

  // 2026 秋分：这是日凌那条链路真会问的那一天
  const eq = pick.f107For(LONG, '2026-09-23')
  ok('② 2026 秋分（只有月均 + 预测时）→ predicted ≈ 129.6', eq.source === 'predicted' && Math.abs(eq.f107 - 129.6) < 0.5, JSON.stringify(eq))

  // 窗口内不足 10 天 → 不用逐日，往下走
  const thin = pick.mergeProducts(null, { daily30: JSON.stringify([{ time_tag: '2026-09-20T20:00:00', flux: 101 }]), monthly: RAW.monthly, predicted: RAW.predicted }, AT)
  ok('② 逐日窗口内不足 10 天 → 不取逐日均值，落到下一级', pick.f107For(thin, '2026-09-23').source === 'predicted')
  ok('② fetchedAt 原样带出', pick.f107For(LONG, '2020-06-15').fetchedAt === AT)
}

/* ── ③ 合并与部分刷新 ──────────────────────────────────────────────────── */
{
  const first = pick.mergeProducts(null, RAW, '2026-09-01T00:00:00.000Z')
  ok('③ 首次合并：四个产品齐全、fetchedAt 为本轮时刻',
    pick.PRODUCTS.every((k) => first.products[k] && Object.keys(first.products[k].data).length) && first.fetchedAt === '2026-09-01T00:00:00.000Z')

  // 第二轮只有 daily30 抓成了：其余三条保留旧份（连各自的 at 一起保留）
  const d2 = JSON.stringify([{ time_tag: '2026-09-21T20:00:00', flux: 99 }, { time_tag: '2026-09-22T20:00:00', flux: 98 }])
  const second = pick.mergeProducts(first, { daily30: d2, forecast45: null, monthly: null, predicted: null }, AT)
  ok('③ 部分刷新：抓成的那条换新、at 更新', second.products.daily30.at === AT && second.products.daily30.data['2026-09-21'] === 99 && Object.keys(second.products.daily30.data).length === 2)
  ok('③ 部分刷新：抓失败的三条保留旧数据与旧 at',
    pick.PRODUCTS.slice(1).every((k) => second.products[k].at === '2026-09-01T00:00:00.000Z'
      && JSON.stringify(second.products[k].data) === JSON.stringify(first.products[k].data)))
  ok('③ 部分刷新：整体 fetchedAt 跟着本轮走', second.fetchedAt === AT)

  // 抓回来的是垃圾（解不出条目）：视同抓失败，绝不用空数据盖掉旧的
  const third = pick.mergeProducts(second, { daily30: '<html>503</html>' }, '2026-09-22T00:00:00.000Z')
  ok('③ 抓回垃圾不盖旧数据', JSON.stringify(third.products.daily30.data) === JSON.stringify(second.products.daily30.data) && third.products.daily30.at === AT)
  ok('③ 一条都没抓成 → fetchedAt 不动', third.fetchedAt === second.fetchedAt)
  ok('③ 合并结果过 structuredClone（要落盘也要上云）', (() => { try { structuredClone(third); return true } catch { return false } })())
}

/* ── ④ validSolarFlux ──────────────────────────────────────────────────── */
{
  ok('④ 认合法快照', validSolarFlux(read('solar-flux.json')) && validSolarFlux(JSON.parse(read('solar-flux.json'))))
  ok('④ 拒 GP CSV', !validSolarFlux('OBJECT_NAME,OBJECT_ID,EPOCH,MEAN_MOTION\nISS,1998-067A,2026-09-01,15.5'))
  ok('④ 拒空对象 / 空串 / null / 缺 products', !validSolarFlux('{}') && !validSolarFlux('') && !validSolarFlux(null) && !validSolarFlux('{"fetchedAt":"x"}'))
  ok('④ 拒月序列不足 12 条的半份', !validSolarFlux(JSON.stringify({ fetchedAt: AT, products: { monthly: { data: { '2026-01': 100 } }, predicted: { data: {} } } })))
  ok('④ 逐日两条全缺也认（月序列够就能算）', validSolarFlux(read('solar-flux.json')))
}

/* ── ⑤ 主进程服务：不联网也有数据 ─────────────────────────────────────── */
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'swpc-'))
  process.env.SATSIM_SWPC_BUNDLE_DIR = FIX
  process.env.SATSIM_SWPC_OFFLINE = '1'        // 单测不许摸网络
  process.env.SATSIM_DATA_DIR = TMP
  const svc = require(path.join(HERE, '../../../electron/services/solarFlux.js'))
  svc._reset()

  const snap = svc.snapshot()
  ok('⑤ SATSIM_SWPC_BUNDLE_DIR 指向夹具 → snapshot() 不联网就有数据', !!snap && snap.source === 'bundled' && !!snap.data, snap && snap.source)
  const eq = svc.f107For('2026-09-23')
  ok('⑤ f107For 走同一套规则', eq.source === 'predicted' && Math.abs(eq.f107 - 129.6) < 0.5 && eq.dataSource === 'bundled', JSON.stringify(eq))
  const st = svc.status()
  ok('⑤ status() 报来源与四个产品各自的时刻', st.source === 'bundled' && st.fetchedAt === AT && st.products.monthly === AT && st.products.daily30 === null, JSON.stringify(st))
  const r = await svc.refresh()
  ok('⑤ 离线开关下 refresh() 立刻返回、不发请求', r && r.source === 'offline' && r.ok === false, JSON.stringify(r))
  ok('⑤ 读路径不在数据目录里造文件', fs.readdirSync(TMP).length === 0, fs.readdirSync(TMP).join())

  // ★ 并发去重不能把 force 吞掉：普通刷新飞行中时，refresh({force:true}) 必须另起一次
  //   （原来直接 return 那个飞行中的 promise —— 那一次可能被当日闸 / 会话闸挡掉，force 就白给了）。
  //   离线开关下每一次 doRefresh 都立刻回 offline，故这里只钉「排了几次」与「先后顺序」。
  {
    const order = []
    const pn = svc.refresh()                        // 普通刷新，飞行中
    const pf = svc.refresh({ force: true })         // 强制：不能复用飞行中那一次普通刷新
    const pn2 = svc.refresh()                       // 普通的复用飞行中那一次强制刷新
    const pf2 = svc.refresh({ force: true })        // 强制的复用飞行中那一次强制刷新
    ok('⑤ force 遇到飞行中的普通刷新 → 另起一次，不复用', pf !== pn)
    ok('⑤ 普通刷新复用飞行中的强制刷新', pn2 === pf)
    ok('⑤ 强制刷新之间仍并发去重', pf2 === pf)
    pn.then(() => order.push('normal'))
    pf.then(() => order.push('force'))
    const [, rf] = await Promise.all([pn, pf, pn2, pf2])
    await Promise.resolve(); await Promise.resolve()
    ok('⑤ 强制那次排在普通那次之后跑（不并发）', order.join(',') === 'normal,force', order.join(','))
    ok('⑤ 强制那次也走离线短路', rf && rf.source === 'offline', JSON.stringify(rf))
    ok('⑤ 跑完后飞行标志清干净', svc.status().refreshing === false, String(svc.status().refreshing))
  }

  // 用户缓存更新时压过内置快照（择新，同 omm.js offlineBest）
  fs.mkdirSync(path.join(TMP, 'space-weather'), { recursive: true })
  const newer = pick.mergeProducts(JSON.parse(read('solar-flux.json')), {}, null)
  newer.fetchedAt = '2026-09-30T00:00:00.000Z'
  fs.writeFileSync(path.join(TMP, 'space-weather', 'solar-flux.json'), JSON.stringify(newer))
  svc._reset()
  ok('⑤ 用户缓存更新 → 压过内置快照', svc.snapshot().source === 'cache', svc.snapshot().source)
  // 内置快照更新 → 反过来
  fs.writeFileSync(path.join(TMP, 'space-weather', 'solar-flux.json'), JSON.stringify(Object.assign({}, newer, { fetchedAt: '2020-01-01T00:00:00.000Z' })))
  svc._reset()
  ok('⑤ 用户缓存更旧 → 回内置快照', svc.snapshot().source === 'bundled', svc.snapshot().source)

  delete process.env.SATSIM_SWPC_BUNDLE_DIR
  svc._reset()
  ok('⑤ 无内置快照目录、无缓存 → snapshot() 为 null，取值回缺省 120',
    (() => { process.env.SATSIM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swpc2-')); svc._reset(); return svc.snapshot() === null && svc.f107For('2026-09-23').f107 === 120 })())
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
