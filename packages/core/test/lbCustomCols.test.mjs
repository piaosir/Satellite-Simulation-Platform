// 链路表「自定义列」表达式引擎自测（src/shared/lbCustomCols.js，渲染端 ESM）。运行：npm test
//
// 关键不变式：
//   ① 求值器无注入面（纯递归下降，不走 eval/Function），语法错/未知函数/参数个数错在编译期报中文错；
//   ② 空值传播：任一引用缺失、非数值、或运算结果非有限（除零、log 负数）→ 整格 '—'，绝不冒出 NaN/Infinity；
//   ③ dB 域三件套 db/lin/par 与引擎口径一致：par 就是链路预算的噪声并联 −10lg Σ10^(−x/10)；
//   ④ 标签引用：裸标签唯一才认，同名标签配多单位（功放建议功率 W/dBW）必须写 [标签(单位)]，杜绝静默取错列；
//   ⑤ localStorage 定义净化：坏形状条目丢弃，缺省字段补齐，round-trip 不变。
import {
  compileExpr, buildPool, makeResolver, validateExpr, evalRows, customFieldDefs, inferUnit, unitOf, schemaInputPool, deriveColumn, parseUnit
} from '../../../src/shared/lbCustomCols.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
function approx(name, got, want, tol = 1e-9) { ok(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `got=${got} want≈${want}`) }

const GET0 = () => null

// —— ① 语法与求值 ——
const run = (src, get) => { const c = compileExpr(src); return c.ok ? c.fn(get || GET0) : undefined }
approx('四则与优先级 2+3*4', run('2+3*4'), 14)
approx('括号 (2+3)*4', run('(2+3)*4'), 20)
approx('一元负号 -2^2（^ 先于一元负）', run('-2^2'), -4)
approx('^ 右结合 2^3^2', run('2^3^2'), 512)
approx('科学计数 1.5e2/3', run('1.5e2/3'), 50)
approx('常量 pi', run('2*pi'), 2 * Math.PI)
approx('函数 log10(100)', run('log10(100)'), 2)
approx('pow(2,10)', run('pow(2,10)'), 1024)
approx('min/max 可变参', run('max(1,5,3)-min(2,0)'), 5)
approx('db(100)=20', run('db(100)'), 20)
approx('lin(30)=1000', run('lin(30)'), 1000)
// par：两支等强噪声并联恰差 3.0103 dB —— 与链路预算引擎的合成口径逐位同式
approx('par(10,10)=10-3.0103', run('par(10,10)'), 10 - 10 * Math.log10(2), 1e-9)
approx('par 单参恒等', run('par(7.5)'), 7.5)
approx('round/floor/ceil', run('round(2.5)+floor(2.9)+ceil(2.1)'), 3 + 2 + 3)
approx('clamp 夹取', run('clamp(15, 0, 10) + clamp(0-3, 0, 10)'), 10)
// 三角一律度制（与全软件仰角/方位角口径一致）
approx('sin/cos 度制', run('sin(30) + cos(60)'), 1, 1e-12)
approx('tan(45)=1', run('tan(45)'), 1, 1e-12)
approx('asin(0.5)=30°', run('asin(0.5)'), 30, 1e-12)
approx('atan2(1,1)=45°', run('atan2(1, 1)'), 45, 1e-12)
approx('acos(0)=90°', run('acos(0)'), 90, 1e-12)

// 编译期报错（中文、可读）
const bad = (src) => { const c = compileExpr(src); return c.ok ? '' : c.error }
ok('空表达式报错', /为空/.test(bad('  ')))
ok('未闭合括号报错', bad('(1+2') !== '')
ok('未知函数报错', /未知函数/.test(bad('foo(1)')))
ok('pow 参数个数报错', /参数/.test(bad('pow(2)')))
ok('clamp 参数个数报错', /参数/.test(bad('clamp(1,2)')))
ok('多余 token 报错', bad('1 2') !== '')
ok('缺配对 ] 报错', /\]/.test(bad('[上行C/N')))
ok('非法字符报错', /无法识别/.test(bad('1 @ 2')))

// —— ② 空值传播 ——
const g1 = (n) => (n === 'a' ? 6 : null)
ok('缺失引用 → null', run('a + b', g1) === null)
ok('除零 → null', run('1/0') === null)
ok('log 负数 → null', run('log10(0-5)') === null)
ok('函数吃 null → null', run('db(b)', g1) === null)

// —— ③/④ 字段池、解析器与歧义 ——
const pool = buildPool(
  [{ key: 'linkmargin', label: '链路余量', unit: 'dB' }, { key: 'uplinkCN', label: '上行C/N', unit: 'dB' }],
  [
    { key: 'paRecommendation', label: '功放建议功率', unit: 'W' },
    { key: 'paRecommendationdBResult', label: '功放建议功率', unit: 'dBW' },
    { key: 'linkmargin', label: '链路余量（重复键应去重）', unit: 'dB' }
  ]
)
ok('池按 key 去重（先到先得）', pool.filter((p) => p.key === 'linkmargin').length === 1 && pool.find((p) => p.key === 'linkmargin').label === '链路余量')
const resolve = makeResolver(pool)
ok('键名直引', resolve('uplinkCN') === 'uplinkCN')
ok('唯一标签直引', resolve('上行C/N') === 'uplinkCN')
ok('歧义裸标签拒认', resolve('功放建议功率') === null)
ok('标签(单位) 消歧', resolve('功放建议功率(dBW)') === 'paRecommendationdBResult' && resolve('功放建议功率(W)') === 'paRecommendation')
ok('未知名 → null', resolve('不存在的列') === null)
ok('validateExpr 通过', validateExpr('[上行C/N] - linkmargin', resolve) === null)
ok('validateExpr 未知字段报错', /未知字段/.test(validateExpr('[上行C/N] + [不存在]', resolve) || ''))
ok('validateExpr 语法错误透传', validateExpr('1+', resolve) !== null)
// 同标签同单位跨键：连 label(unit) 都判歧义拒认（不许后写者静默胜出），键名仍可直引
const ambPool = buildPool([{ key: 'amb1', label: '同名量', unit: 'dB' }, { key: 'amb2', label: '同名量', unit: 'dB' }])
const ambR = makeResolver(ambPool)
ok('同标签同单位 → label(unit) 判歧义', ambR('同名量(dB)') === null && ambR('同名量') === null && ambR('amb1') === 'amb1')

// —— 输入参数池策展（schemaInputPool）——
const SPECS = [
  { fields: [{ key: 'rainRate', label: '降雨率', unit: 'mm/h', type: 'num' }, { key: 'earthStationLocation', label: '站名', type: 'text' }], group: '输入 · 发信站', side: 'tx' },
  { fields: [{ key: 'rxRainRate', label: '降雨率', unit: 'mm/h', type: 'num' }], group: '输入 · 收信站', side: 'rx' },
  { fields: [{ key: 'antennaDiameter', rxKey: 'rxAntennaDiameter', label: '天线口径', unit: 'm', type: 'num' }], group: '输入 · 发信站', side: 'tx' },
  { fields: [{ key: 'antennaDiameter', rxKey: 'rxAntennaDiameter', label: '天线口径', unit: 'm', type: 'num' }], group: '输入 · 收信站', side: 'rx', useRxKey: true },
  { fields: [{ key: 'bandwidthFactor', label: '带宽系数', unit: '', type: 'num' }, { key: 'notInSample', label: '样本没有', unit: '', type: 'num' }], group: '输入 · 载波' }
]
const sample = { rainRate: '46.167', rxRainRate: 60, antennaDiameter: 6.2, rxAntennaDiameter: 3.7, earthStationLocation: '北京', bandwidthFactor: 1.2, junkNotDeclared: 99 }
const ip = schemaInputPool(SPECS, sample)
ok('输入池：schema∩样本、text 与未声明键不收', ip.length === 5 && !ip.some((x) => x.key === 'earthStationLocation' || x.key === 'junkNotDeclared' || x.key === 'notInSample'))
ok('输入池：跨侧同名标（发）/（收）', ip.find((x) => x.key === 'rainRate').label === '降雨率（发）' && ip.find((x) => x.key === 'rxRainRate').label === '降雨率（收）')
ok('输入池：ES 共用字段拆两侧', ip.find((x) => x.key === 'antennaDiameter').label === '天线口径（发）' && ip.find((x) => x.key === 'rxAntennaDiameter').label === '天线口径（收）')
ok('输入池：唯一标签不加后缀', ip.find((x) => x.key === 'bandwidthFactor').label === '带宽系数')
ok('输入池：无样本给空', schemaInputPool(SPECS, null).length === 0)
ok('输入池：消歧后引用可解析', makeResolver(buildPool(ip))('降雨率（发）') === 'rainRate' && makeResolver(buildPool(ip))('降雨率') === null)

// —— 单位＝量纲演算（用户不再手填；引用带着自己的单位进公式，跨标度自动归一）——
const upool = buildPool([
  { key: 'uplinkCN', label: '上行C/N', unit: 'dB', group: '结果列' },
  { key: 'downlinkCN', label: '下行C/N', unit: 'dB' },
  { key: 'systemNoiseTempKResult', label: '系统噪温', unit: 'K' },
  { key: 'paRecommendation', label: '功放', unit: 'W' },
  { key: 'paDbm', label: '功放电平', unit: 'dBm' },
  { key: 'stationEIRPResult', label: '站 EIRP', unit: 'dBW' },
  { key: 'slantRangeResult', label: '斜距', unit: 'km' },
  { key: 'linkDelayResult', label: '时延', unit: 'ms' },
  { key: 'interruptionMinutes', label: '年中断时长', unit: 'min' },
  { key: 'allocBandwidthResult', label: '载波带宽', unit: 'kHz' },
  { key: 'infoRateResult', label: '信息速率', unit: 'kbps' },
  { key: 'elevationResult', label: '仰角', unit: '°' }
])
ok('池保留分组', upool[0].group === '结果列')
const iu = (s) => inferUnit(s, upool)
const R = (rows) => (expr) => { const v = evalRows([{ id: 'q', expr, dp: 4 }], [{ id: 'r', data: rows }], makeResolver(upool), upool); return v.r._cq }

// 单位推导
ok('同单位加减 → 沿用', iu('[上行C/N] - downlinkCN + 3') === 'dB')
ok('除以纯数 → 保留原单位（本轮要点）', iu('slantRangeResult / 12') === 'km')
ok('乘以纯数 → 保留原单位', iu('allocBandwidthResult * 2') === 'kHz')
ok('同量纲跨标度相除 → 无量纲', iu('interruptionMinutes / linkDelayResult') === '')
ok('不同量纲相除 → 合成单位', iu('slantRangeResult / linkDelayResult') === 'm/s')
ok('速率×时间 → bit', iu('infoRateResult * linkDelayResult') === 'bit')
ok('dBW − dBW → dB', iu('stationEIRPResult - stationEIRPResult') === 'dB')
ok('dBW + dB → dBW', iu('stationEIRPResult + uplinkCN') === 'dBW')
ok('db(W 量) → dBW', iu('db(paRecommendation)') === 'dBW')
ok('lin(dBW) → W', iu('lin(stationEIRPResult)') === 'W')
ok('lin(dB) → 无量纲', iu('lin(uplinkCN)') === '')
ok('par 同 dB → dB', iu('par(uplinkCN, downlinkCN)') === 'dB')
ok('min/abs 保单位', iu('abs(min(uplinkCN, downlinkCN))') === 'dB')
ok('三角出无量纲', iu('sin(elevationResult)') === '')
ok('反三角出度', iu('asin(0.5)') === '°')
ok('sqrt(m²)→m', iu('sqrt(slantRangeResult * slantRangeResult)') === 'km')
ok('unitOf 走推导', unitOf({ expr: 'slantRangeResult / 12' }, upool) === 'km')

// 量纲冲突：报错且值判 —
const err = (s) => (deriveColumn(s, upool).err || '')
ok('min + dB 报量纲不一致', /量纲不一致/.test(err('interruptionMinutes + uplinkCN')))
ok('K + W 报量纲不一致', /量纲不一致/.test(err('systemNoiseTempKResult + paRecommendation')))
ok('两个 dBW 相加无定义', /并联|无定义/.test(err('stationEIRPResult + stationEIRPResult')))
ok('sin(米数) 报错', /三角/.test(err('sin(slantRangeResult)')))
ok('ln(带量纲) 报错', /无量纲/.test(err('ln(paRecommendation)')))
ok('validateExpr 拦量纲冲突', /量纲/.test(validateExpr('interruptionMinutes + uplinkCN', makeResolver(upool), upool) || ''))

// 数值：跨标度归一（本轮的判据例）
const r1 = R({ interruptionMinutes: 1, linkDelayResult: 10000, slantRangeResult: 36000, allocBandwidthResult: 2400, infoRateResult: 2048, stationEIRPResult: 50, paRecommendation: 100, uplinkCN: 12, downlinkCN: 12 })
ok('1min / 10s = 6', r1('interruptionMinutes / linkDelayResult') === '6.0000', r1('interruptionMinutes / linkDelayResult'))
ok('36000km / 12 = 3000 km', r1('slantRangeResult / 12') === '3000.0000', r1('slantRangeResult / 12'))
ok('db(100W) = 20 dBW', r1('db(paRecommendation)') === '20.0000', r1('db(paRecommendation)'))
ok('lin(50dBW) = 100000 W', r1('lin(stationEIRPResult)') === '100000.0000', r1('lin(stationEIRPResult)'))
ok('par(12,12) = 8.9897 dB', r1('par(uplinkCN, downlinkCN)') === '8.9897', r1('par(uplinkCN, downlinkCN)'))
ok('kbps × ms = bit（2048 kbps × 10 s = 2.048e7 bit）', r1('infoRateResult * linkDelayResult') === '20480000.0000', r1('infoRateResult * linkDelayResult'))
ok('量纲冲突行值判 —', r1('interruptionMinutes + uplinkCN') === '—')
// dBm ↔ dBW 跨参考标度：30dBm − 0dBW = 0 dB
const r2 = R({ paDbm: 30, stationEIRPResult: 0 })
ok('30dBm − 0dBW = 0 dB', r2('paDbm - stationEIRPResult') === '0.0000', r2('paDbm - stationEIRPResult'))

// —— 逐行求值（引擎出参是字符串；行可无 data）——
const defs = [
  { id: 'k1', label: '上下行差', expr: '[上行C/N] - downlinkCN', unit: 'dB', dp: 2, on: true },
  { id: 'k2', label: '并联复算', expr: 'par(uplinkCN, downlinkCN)', unit: 'dB', dp: 3, on: true },
  { id: 'k3', label: '关掉的列', expr: 'uplinkCN', unit: 'dB', dp: 2, on: false },
  { id: 'k4', label: '空dp', expr: 'uplinkCN', unit: 'dB', dp: '', on: true }
]
const pool2 = buildPool(pool, [{ key: 'downlinkCN', label: '下行C/N', unit: 'dB' }])
const resolve2 = makeResolver(pool2)
const rows = [
  { id: 'r1', data: { uplinkCN: '12.99', downlinkCN: '12.84' } },
  { id: 'r2', data: null },
  { id: 'r3', data: { uplinkCN: '10.00', downlinkCN: '—' } }
]
const vals = evalRows(defs.filter((d) => d.on !== false), rows, resolve2)
ok('正常行 差值', vals.r1._ck1 === '0.15', vals.r1._ck1)
approx('正常行 par 复算（对齐引擎合成口径）', parseFloat(vals.r1._ck2),
  -10 * Math.log10(Math.pow(10, -1.299) + Math.pow(10, -1.284)), 5e-4)
ok('小数位按定义（dp=3）', /^\d+\.\d{3}$/.test(vals.r1._ck2), vals.r1._ck2)
ok('无结果行 → —', vals.r2._ck1 === '—' && vals.r2._ck2 === '—')
ok('非数值出参 → —', vals.r3._ck1 === '—')
ok('关掉的列不求值', vals.r1._ck3 === undefined)
ok('dp 清空按缺省 2 位（与落库口径一致）', vals.r1._ck4 === '12.99', vals.r1._ck4)
// 小数位上限 10＝引擎自身最大精度（toFixed(2+FX)，FX 钳 0~8）；越界夹取不报错
{
  const p1 = buildPool([{ key: 'uplinkCN', label: '上行C/N', unit: 'dB' }])
  const one = (dp) => evalRows([{ id: 'q', expr: 'uplinkCN / 3', dp }], [{ id: 'r', data: { uplinkCN: '12.99' } }], makeResolver(p1), p1).r._cq
  ok('dp=10 全位输出', one(10) === (12.99 / 3).toFixed(10), one(10))
  ok('dp 超上限夹到 10', one(99) === (12.99 / 3).toFixed(10))
  ok('dp 负数夹到 0', one(-3) === (12.99 / 3).toFixed(0))
}

// —— 字段定义生成 ——
const fds = customFieldDefs(defs)
ok('字段只出勾选列', fds.length === 3 && fds[0].key === '_ck1' && fds[1].key === '_ck2' && fds[2].key === '_ck4')
ok('字段为只读结果组、tip=公式', fds[0].ro === true && fds[0].group === 'res' && fds[0].tip === defs[0].expr)

// —— ⑤ 定义净化（loadDefs 走 localStorage，这里直接测 sanitize 行为：坏形状进、好形状出）——
// loadDefs 依赖 localStorage（渲染端），node 下用一个临时垫片验证净化逻辑
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] === undefined ? null : this._s[k] },
  setItem(k, v) { this._s[k] = String(v) }
}
const { loadDefs, saveDefs } = await import('../../../src/shared/lbCustomCols.js')
saveDefs('t/cc', [
  { id: 'a1', label: 'x', expr: '1+1', unit: '', dp: 2, on: true },
  { bad: true },                                    // 缺 id/expr → 丢弃
  { id: 'a2', expr: 'uplinkCN', dp: 'x' }           // 缺省补齐：label=自定义 dp=2 on=true
])
const back = loadDefs('t/cc')
ok('round-trip 保留合法条目', back.length === 2 && back[0].id === 'a1' && back[0].expr === '1+1')
ok('坏形状丢弃、缺省补齐', back[1].label === '自定义' && back[1].dp === 2 && back[1].on === true)
ok('无存档 → 空数组', loadDefs('t/none').length === 0)

// —— 百分数字面量与常量（用户点名：[年中断时长]*20% 要能算；pi / e 进常量）——
approx('20% ≡ 0.2', run('20%'), 0.2)
approx('百分数参与运算 100*20%', run('100*20%'), 20)
approx('常量 e', run('e'), Math.E, 1e-12)
approx('ln(e)=1', run('ln(e)'), 1, 1e-12)
{
  const p = buildPool([{ key: 'interruptionMinutes', label: '年中断时长', unit: 'min' }, { key: 'powerUsageRatio', label: '功率占用', unit: '%' }])
  const r = (expr, data, dp) => evalRows([{ id: 'q', expr, dp: dp === undefined ? 4 : dp }], [{ id: 'r', data }], makeResolver(p), p).r._cq
  ok('[年中断时长]*20% 保持 min', inferUnit('interruptionMinutes * 20%', p) === 'min')
  ok('[年中断时长]*20% 数值', r('interruptionMinutes * 20%', { interruptionMinutes: 50 }) === '10.0000', r('interruptionMinutes * 20%', { interruptionMinutes: 50 }))
  ok('% 列保持 %（不折成 0.39）', inferUnit('powerUsageRatio', p) === '%' && r('powerUsageRatio', { powerUsageRatio: 38.98 }) === '38.9800')
  // 字段在前 → 结果沿用 %（10% 折进 % 标度）；裸数 100 是纯数不是 100%，100 − 38.98% = 99.6102（量演算的严格口径）
  ok('% 字段 − 百分数 仍是 %', inferUnit('powerUsageRatio - 10%', p) === '%' && r('powerUsageRatio - 10%', { powerUsageRatio: 38.98 }) === '28.9800', r('powerUsageRatio - 10%', { powerUsageRatio: 38.98 }))
  ok('裸数与 % 混算按纯数口径', r('100 - powerUsageRatio', { powerUsageRatio: 38.98 }) === '99.6102')
}

// —— 出参词表：三体制 100% 收录（漏一个键界面上就会冒出裸键名）——
{
  const core = await import('../index.js')
  const { RESULT_LABELS, labeledResultPool } = await import('../../../src/shared/lbResultLabels.js')
  const numKeys = (d) => Object.keys(d).filter((k) => typeof d[k] !== 'object' && Number.isFinite(parseFloat(d[k])) && k !== 'berResult')
  const engines = [
    ['GEO', core.default.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' }, {})],
    ['NGSO', core.default.calculateLinkBudgetNGSO({ frequencyBand: 'Ku', satelliteName: 'D' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })],
    ['再生·上行', core.default.computeRegenUplinkMode({ frequencyBand: 'Ku' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })],
    ['再生·下行', core.default.computeRegenDownlinkMode({ frequencyBand: 'Ku' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })],
    ['再生·星间', core.default.computeRegenIslMode({ frequencyBand: 'Ku' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })]
  ]
  for (const [name, res] of engines) {
    const d = res && res.data
    if (!d) { ok(name + ' 引擎可用', false); continue }
    const miss = numKeys(d).filter((k) => !RESULT_LABELS[k])
    ok(name + ' 出参 100% 有中文名与单位', miss.length === 0, miss.slice(0, 8).join(' '))
  }
  // 词表条目必须真的是引擎出参（防拼错键名：写了却永远匹配不上）
  const known = new Set(engines.flatMap(([, r]) => (r && r.data ? Object.keys(r.data) : [])))
  const ghost = Object.keys(RESULT_LABELS).filter((k) => !known.has(k))
  ok('词表无幽灵键（每条都真出现在引擎结果里）', ghost.length === 0, ghost.join(' '))
  // 词表单位必须可被量纲解析（不能出现解析成原子量纲的写法）
  const badUnit = Object.values(RESULT_LABELS).filter((it) => it.unit && Object.keys(parseUnit(it.unit).d).some((x) => x.startsWith('a:')))
  ok('词表单位全部可解析', badUnit.length === 0, badUnit.map((x) => x.key + ':' + x.unit).join(' '))
  // 池只出该体制真有的键
  const geoKeys = new Set(numKeys(engines[0][1].data))
  const pool = labeledResultPool(geoKeys)
  ok('labeledResultPool 只出该结果里有的键', pool.length > 100 && pool.every((it) => geoKeys.has(it.key)))
  ok('labeledResultPool 条目带分组与单位', pool.every((it) => !!it.group) && pool.some((it) => it.unit === 'dB'))
}

// —— 字段名唯一性与歧义提示 ——
// 用户实测踩坑：字段列表里明明写着「功放实际输出 (W)」，公式里写 [功放实际输出] 却报「未知字段」——
// 因为同名的还有一条 dBW 的，解析器判歧义后报成了「未知」。三条守卫：词表标签全局唯一、
// 三体制池内标签唯一（含结果列组沿用词表名）、以及歧义与查无此名的报错必须分开说。
{
  const { RESULT_LABEL_LIST, RESULT_LABELS, labeledResultPool } = await import('../../../src/shared/lbResultLabels.js')
  const core = await import('../index.js')
  const dupOf = (list) => {
    const m = {}
    for (const it of list) (m[it.label] = m[it.label] || new Set()).add(it.key)
    return Object.entries(m).filter(([, v]) => v.size > 1).map(([k, v]) => k + '→' + [...v].join('/'))
  }
  ok('词表标签全局唯一', dupOf(RESULT_LABEL_LIST).length === 0, dupOf(RESULT_LABEL_LIST).join(' '))
  // 镜像三窗的池构造：结果列组沿用词表名（同一个量不许两个名字）
  const RD = [{ key: 'paRecommendation', label: '功放建议', unit: 'W' }, { key: 'selectedPowerWResult', label: '功放实际输出', unit: 'W' }]
  const engines = [
    ['GEO', core.default.calculateLinkBudget({ frequencyBand: 'Ku', satelliteName: 'D' }, {})],
    ['NGSO', core.default.calculateLinkBudgetNGSO({ frequencyBand: 'Ku', satelliteName: 'D' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })],
    ['再生·星间', core.default.computeRegenIslMode({ frequencyBand: 'Ku' }, { orbitAltitude: 1145, rxOrbitAltitude: 1145 })]
  ]
  for (const [name, res] of engines) {
    const d = res.data
    const keys = new Set(Object.keys(d).filter((k) => k !== 'berResult' && typeof d[k] !== 'object' && Number.isFinite(parseFloat(d[k]))))
    const pool = buildPool(
      RD.filter((x) => keys.has(x.key)).map((x) => { const t = RESULT_LABELS[x.key]; return { key: x.key, label: t ? t.label : x.label, unit: t ? t.unit : x.unit, group: '结果列' } }),
      labeledResultPool(keys),
      [...keys].sort().map((k) => ({ key: k, label: k, unit: '', group: '未命名出参' }))
    )
    ok(name + ' 池内标签唯一（裸标签都能直引）', dupOf(pool).length === 0, dupOf(pool).join(' '))
    const rs = makeResolver(pool)
    if (name === 'GEO') {
      ok('GEO [功放实际输出] 可直引（用户实测那条）', rs('功放实际输出') === 'selectedPowerWResult')
      ok('GEO [功放实际输出电平] 指 dBW 那条', rs('功放实际输出电平') === 'selectedPowerResult')
      ok('GEO [功放实际输出]*50% 算得出且保 W',
        evalRows([{ id: 'q', expr: '[功放实际输出]*50%', dp: 4 }], [{ id: 'r', data: d }], rs, pool).r._cq === (parseFloat(d.selectedPowerWResult) * 0.5).toFixed(4)
        && inferUnit('[功放实际输出]*50%', pool) === 'W')
    }
  }
  // 歧义与未知必须分开报（歧义要给出可照抄的写法）
  const amb = makeResolver([{ key: 'a1', label: '同名量', unit: 'W' }, { key: 'a2', label: '同名量', unit: 'dBW' }])
  ok('歧义报「有歧义」并给出带单位写法', /歧义/.test(amb.explain('同名量')) && /\[同名量\(W\)\]/.test(amb.explain('同名量')), amb.explain('同名量'))
  ok('查无此名仍报「未知字段」', /未知字段/.test(amb.explain('没有的名字')))
  ok('validateExpr 走 explain 口径', /歧义/.test(validateExpr('[同名量] + 1', amb) || ''))
}


// —— 频率族标签回写（用户实测：功放输出×带宽 显示成 W/s，射频语境读作「每秒瓦」）——
// Hz 量纲上就是 s⁻¹（所以带宽×时延＝时带积能相消、载波带宽/符号速率能约掉秒），但显示要写回 Hz：
// 判据是「这个 s⁻¹ 是不是来自频率单位」（f 标记），来自除时间的照旧记秒（斜距/时延仍是 m/s）。
{
  const fp = buildPool([
    { key: 'pw', label: '功放实际输出', unit: 'W' },
    { key: 'bw', label: '功率带宽', unit: 'kHz' },
    { key: 'ab', label: '载波带宽', unit: 'kHz' },
    { key: 'sr', label: '符号速率', unit: 'ksps' },
    { key: 'ir', label: '信息速率', unit: 'kbps' },
    { key: 'rng', label: '斜距', unit: 'km' },
    { key: 'dly', label: '时延', unit: 'ms' },
    { key: 'psd', label: '发信站功率谱密度', unit: 'dBW/Hz' },
    { key: 'cn0', label: '合计 C/N₀', unit: 'dBHz' }
  ])
  const fu = (e) => inferUnit(e, fp)
  ok('功率×带宽 → W·Hz（不是 W/s）', fu('[功放实际输出]*[功率带宽]') === 'W·Hz', fu('[功放实际输出]*[功率带宽]'))
  ok('功率÷带宽 → W/Hz（功率谱密度，不是 W·s）', fu('[功放实际输出]/[功率带宽]') === 'W/Hz', fu('[功放实际输出]/[功率带宽]'))
  ok('距离÷时间仍是 m/s（除时间的秒不写成 Hz）', fu('[斜距]/[时延]') === 'm/s', fu('[斜距]/[时延]'))
  ok('功率×时间 → W·s（能量，不许认成 W/Hz）', fu('[功放实际输出]*[时延]') === 'W·s', fu('[功放实际输出]*[时延]'))
  ok('带宽×时延 → 无量纲（时带积，Hz≡s⁻¹ 的正确后果）', fu('[载波带宽]*[时延]') === '')
  ok('速率×时延 → bit（这里的秒来自速率不是频率）', fu('[信息速率]*[时延]') === 'bit', fu('[信息速率]*[时延]'))
  ok('带宽÷符号速率 → 1/sym', fu('[载波带宽]/[符号速率]') === '1/sym', fu('[载波带宽]/[符号速率]'))
  ok('db(功率÷带宽) 认出池里的 dBW/Hz 写法', fu('db([功放实际输出]/[功率带宽])') === 'dBW/Hz', fu('db([功放实际输出]/[功率带宽])'))
  ok('lin(dBW/Hz) → W/Hz', fu('lin([发信站功率谱密度])') === 'W/Hz', fu('lin([发信站功率谱密度])'))
  ok('lin(dBHz) → Hz', fu('lin([合计 C/N₀])') === 'Hz', fu('lin([合计 C/N₀])'))
}

console.log(`
=== ${pass} passed, ${fail} failed ===`)
if (fail) process.exit(1)
