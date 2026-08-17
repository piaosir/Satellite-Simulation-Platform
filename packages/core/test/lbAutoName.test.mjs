// 资源库条目「自动命名」自测。运行：npm test
// 被测文件是渲染端 ESM（src/shared/lbAutoName.js），故本测试也是 .mjs。
//
// 关键不变式：
//   ① 没被用户改过名字的条目（nameAuto=true），名字随关键参数走：地球站=口径 / 载波=速率·调制 FEC / 卫星=星名；
//   ② 用户改过一次（nameAuto=false），此后参数怎么变都不动它的名字；
//   ③ 幂等：同一份库反复 sync 结果不变（深监听里会反复跑，后缀不能越加越长）；
//   ④ 重名自动加序号，且自定义名先占位（自动名让着它）；
//   ⑤ 算不出名字（还没取星的卫星）时留着现名不动，只有新建的空名条目才落到兜底名；
//   ⑥ 旧库没存 nameAuto → 按历史默认名（「站型2」「默认」…）或「名字恰好等于自动名」推定。

const { esAutoName, carrierAutoName, satAutoName, autoNameOf, legacyAutoFlag, adoptAutoFlag, withAutoFlag, syncAutoNames } =
  await import('../../../src/shared/lbAutoName.js')
const { anchoredRate } = await import('../../../src/shared/carrierRate.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 资源库条目自动命名 ===\n')

// —— ① 三库各自的自动名 ——
ok('地球站 = 口径（功放不进名字）', esAutoName({ antennaDiameter: '6.2', paPowerW: '40' }) === '6.2 m', esAutoName({ antennaDiameter: '6.2', paPowerW: '40' }))
ok('地球站 功放多大都不进名字（再生式 opPowerW 同理）',
  esAutoName({ antennaDiameter: '2.4', opPowerW: '0.2' }) === '2.4 m' && esAutoName({ antennaDiameter: '13', paPowerW: '3000' }) === '13 m')
ok('地球站 无功放只报口径', esAutoName({ antennaDiameter: '0.35' }) === '0.35 m')
ok('地球站 无口径 → 算不出名字', esAutoName({ paPowerW: '40' }) === '')
// 载波：速率报「用户按的那一档」（锚点）+ 按数值换档到 Mbps/MHz 这一级（与结果列同一套档位表）
const CAR = { infoRate: '2048', modulation: 'QPSK', fec: '3/4', rsCode: '188/204', m: '1', bandwidthFactor: '1.20' }
ok('载波 = 速率 · 调制 FEC（2048 kbps → 2.048 Mbps）', carrierAutoName(CAR) === '2.048 Mbps · QPSK 3/4', carrierAutoName(CAR))
ok('载波 小速率不换档', carrierAutoName({ ...CAR, infoRate: '64' }) === '64 kbps · QPSK 3/4', carrierAutoName({ ...CAR, infoRate: '64' }))
ok('载波 锚点=符号率 → 报 Msps', carrierAutoName({ ...CAR, rateAnchor: 'symbol' }) === '1.4815 Msps · QPSK 3/4', carrierAutoName({ ...CAR, rateAnchor: 'symbol' }))
ok('载波 锚点=载波带宽 → 报 MHz', carrierAutoName({ ...CAR, rateAnchor: 'bw', rateAnchorValue: 36000 }) === '36 MHz · QPSK 3/4', carrierAutoName({ ...CAR, rateAnchor: 'bw', rateAnchorValue: 36000 }))
ok('载波 锚点=码片速率 → 报 Mcps', carrierAutoName({ ...CAR, rateAnchor: 'chip' }) === '2.9631 Mcps · QPSK 3/4', carrierAutoName({ ...CAR, rateAnchor: 'chip' }))
ok('载波 锚点缺失/非法 → 退回信息速率', carrierAutoName({ ...CAR, rateAnchor: '乱写' }) === '2.048 Mbps · QPSK 3/4')
// 锚点用用户填的原值：infoRate 只存 3 位小数，沿链反推回去会掉精度（填 5000 kcps 反推成 4999.999）
ok('载波 锚点照用户原值', anchoredRate({ ...CAR, infoRate: '3455.882', rateAnchor: 'chip', rateAnchorValue: 5000 }).value === 5000)
ok('载波 原值缺失 → 退回按链反推', Math.abs(anchoredRate({ ...CAR, infoRate: '3455.882', rateAnchor: 'chip', rateAnchorValue: null }).value - 5000) > 1e-6)
// 卫星：GSO = 星名 · 频段 · 轨位（°E/°W 折算，2026-08-17 起）；NGSO/再生式（有 ngsoSat）= 只报星名
ok('卫星 GSO = 星名 · 频段 · 轨位', satAutoName({ form: { satelliteName: 'APSTAR-6D', frequencyBand: 'Ku', orbitPosition: '134' } }) === 'APSTAR-6D · Ku · 134.0°E',
  satAutoName({ form: { satelliteName: 'APSTAR-6D', frequencyBand: 'Ku', orbitPosition: '134' } }))
ok('卫星 GSO 西经轨位报 °W（不再是负°E）', satAutoName({ form: { satelliteName: 'AMAZONAS-3', frequencyBand: 'Ku', orbitPosition: '-61' } }) === 'AMAZONAS-3 · Ku · 61.0°W',
  satAutoName({ form: { satelliteName: 'AMAZONAS-3', frequencyBand: 'Ku', orbitPosition: '-61' } }))
const NGSO_SAT = { form: { satelliteName: 'X', frequencyBand: 'Ka', orbitAltitude: '1000', orbitInclination: '89' }, ngsoSat: { mode: 'manual', orbit: null } }
ok('卫星 NGSO/再生式 只报星名（频段与轨道不进名字）', satAutoName(NGSO_SAT) === 'X', satAutoName(NGSO_SAT))
ok('卫星 NGSO 选星后也只报星名',
  satAutoName({ form: { satelliteName: '旧星', frequencyBand: 'Ka', orbitAltitude: '550' }, ngsoSat: { mode: 'search', orbit: {}, name: 'STARLINK-31234' } }) === 'STARLINK-31234')
ok('卫星 取星后以所选星为准', satAutoName({ form: { satelliteName: '旧星' }, ngsoSat: { mode: 'search', orbit: {}, name: 'QIANFAN-1' } }) === 'QIANFAN-1')
ok('卫星 手动轨道取表单星名', satAutoName({ form: { satelliteName: 'CS10R' }, ngsoSat: { mode: 'manual', orbit: null, name: '' } }) === 'CS10R')
ok('卫星 出厂占位名 Satellite 不算星名（整条不成立）', satAutoName({ form: { satelliteName: 'Satellite', frequencyBand: 'Ku', orbitPosition: '110.5' } }) === '')

// —— ①④ 全库刷名 + 重名加序号 ——
const es = [
  withAutoFlag({ name: '', form: { antennaDiameter: '6.2', paPowerW: '40' } }, 'es'),
  withAutoFlag({ name: '', form: { antennaDiameter: '6.2', paPowerW: '400' } }, 'es'),  // 同口径（功放不进名字）→ 加序号
  withAutoFlag({ name: '关口站 6.2m', form: { antennaDiameter: '6.2', paPowerW: '400' } }, 'es')  // 起过名 → 不动
]
syncAutoNames(es, 'es')
ok('新建条目按参数得名', es[0].name === '6.2 m', es[0].name)
ok('同名自动加序号', es[1].name === '6.2 m 2', es[1].name)
ok('内置的自定义名不被冲掉', es[2].name === '关口站 6.2m' && es[2].nameAuto === false)

// ③ 幂等：再跑两遍，名字一字不变
const before = es.map((c) => c.name).join('|')
syncAutoNames(es, 'es'); syncAutoNames(es, 'es')
ok('反复 sync 幂等', es.map((c) => c.name).join('|') === before, es.map((c) => c.name).join('|'))

// ① 参数改了，名字跟着改
es[0].form.antennaDiameter = '9.0'
syncAutoNames(es, 'es')
ok('改口径 → 名字跟随', es[0].name === '9.0 m', es[0].name)
ok('跟随后同口径那条让出后缀', es[1].name === '6.2 m', es[1].name)
// 功放只是预设值（实时功率在链路表里算），改它不动名字
es[1].form.paPowerW = '125'
syncAutoNames(es, 'es')
ok('改功放 → 名字不动', es[1].name === '6.2 m', es[1].name)

// —— ② 用户改过名 → 此后再不自动 ——
es[0].name = '我的关口站'; es[0].nameAuto = false
es[0].form.antennaDiameter = '13.0'
syncAutoNames(es, 'es')
ok('自定义名此后不随参数变', es[0].name === '我的关口站')

// ④ 自动名撞上别人的自定义名 → 自动的那条让位
const es2 = [
  { name: '3.7 m', nameAuto: false, form: { antennaDiameter: '9', paPowerW: '5' } },
  { name: '', nameAuto: true, form: { antennaDiameter: '3.7', paPowerW: '40' } }
]
syncAutoNames(es2, 'es')
ok('自动名让着自定义名', es2[1].name === '3.7 m 2', es2[1].name)

// —— ⑤ 算不出名字的卫星 ——
const sats = [
  { name: '默认卫星', nameAuto: true, form: { satelliteName: 'Satellite' } },   // 还没取星（出厂占位名）→ 留着现名
  withAutoFlag({ name: '', form: { satelliteName: '' } }, 'sat')                 // 新建空名 → 兜底名
]
syncAutoNames(sats, 'sat')
ok('未取星的旧条目留名不动', sats[0].name === '默认卫星')
ok('新建空名条目落到兜底名', sats[1].name === '卫星', sats[1].name)
sats[0].form.satelliteName = 'CHINASAT 6D'
syncAutoNames(sats, 'sat')
ok('取星后名字跟到星名', sats[0].name === 'CHINASAT 6D')

// —— ⑥ 旧库推定 ——
ok('历史默认名判为自动（站型2）', legacyAutoFlag('es', { name: '站型2', form: {} }) === true)
ok('历史默认名判为自动（默认）', legacyAutoFlag('carrier', { name: '默认', form: {} }) === true)
ok('历史默认名判为自动（默认卫星）', legacyAutoFlag('sat', { name: '默认卫星', form: {} }) === true)
ok('带重名后缀的默认名也算（卫星2 3）', legacyAutoFlag('sat', { name: '卫星2 3', form: {} }) === true)
ok('名字恰好等于自动名 → 自动', legacyAutoFlag('es', { name: '6.2 m', form: { antennaDiameter: '6.2', paPowerW: '40' } }) === true)
// 改规则（2026-07-29 功放退出名字）前的库：名字还是旧形状「口径 · 功放」的同样算自动，别一次性钉成自定义名
ok('旧版自动名「口径 · 功放」也算自动', legacyAutoFlag('es', { name: '6.2 m · 40 W', form: { antennaDiameter: '6.2', paPowerW: '40' } }) === true)
ok('旧版自动名 再生式 opPowerW 换档形状', legacyAutoFlag('es', { name: '2.4 m · 200 mW', form: { antennaDiameter: '2.4', opPowerW: '0.2' } }) === true)
// 改规则（2026-08-15 NGSO/再生式的卫星只报星名）前的库：名字还是「星名 · 频段 · h/i」的同样算自动
ok('旧版自动名 NGSO「星名 · 频段 · 高度倾角」也算自动',
  legacyAutoFlag('sat', { name: 'X · Ka · h=1000 km i=89°', form: { satelliteName: 'X', frequencyBand: 'Ka', orbitAltitude: '1000', orbitInclination: '89' }, ngsoSat: { mode: 'manual', orbit: null } }) === true)
// 改规则（2026-08-17 GSO 轨位 °E/°W 折算）前的库：名字还是「原样数字+°E」旧形状的同样算自动
ok('旧版自动名 GSO「原样数字+°E」也算自动',
  legacyAutoFlag('sat', { name: 'APSTAR-6D · Ku · 134°E', form: { satelliteName: 'APSTAR-6D', frequencyBand: 'Ku', orbitPosition: '134' } }) === true)
ok('旧版自动名 GSO 负值西经「-61°E」也算自动',
  legacyAutoFlag('sat', { name: 'AMAZONAS-3 · Ku · -61°E', form: { satelliteName: 'AMAZONAS-3', frequencyBand: 'Ku', orbitPosition: '-61' } }) === true)
ok('NGSO 用户起的名字仍判为自定义',
  legacyAutoFlag('sat', { name: 'X 备份星', form: { satelliteName: 'X', frequencyBand: 'Ka', orbitAltitude: '1000' }, ngsoSat: { mode: 'manual', orbit: null } }) === false)
ok('用户起的名字判为自定义', legacyAutoFlag('es', { name: '关口站 6.2m', form: { antennaDiameter: '6.2', paPowerW: '40' } }) === false)
ok('存过的标志位优先于推定', adoptAutoFlag('es', { name: '站型2', nameAuto: false, form: {} }) === false)
ok('没存过才推定', adoptAutoFlag('es', { name: '站型2', form: {} }) === true)

// —— 兜底：脏输入不炸 ——
ok('未知库类型不改动', (() => { const a = [{ name: 'X', nameAuto: true, form: {} }]; syncAutoNames(a, '不存在'); return a[0].name === 'X' })())
ok('非数组不炸', (() => { syncAutoNames(null, 'es'); return true })())
ok('缺 form 不炸', autoNameOf('es', { name: 'x' }) === '' || autoNameOf('es', { name: 'x' }) === undefined)

// —— ⑦ 平台语言：自动名是【数据】（存进 library.json、显示在 <input> 里），DOM 呈现层翻不到，
//        故生成时就得按语言出字；换语言时兜底名要跟着搬过去，带参数的名字与自定义名一律不动 ——
const { newCfgName, newFolderName, copyNameOf } = await import('../../../src/shared/lbAutoName.js')
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }
const setLang = (v) => store.set('ui-lang', v)

setLang('en')
ok('英文：配置树默认名', newCfgName() === 'New Configuration' && newFolderName() === 'New Folder' && copyNameOf('A') === 'A Copy')
ok('英文：e2e 自带中文默认名也走英文', newCfgName('新建配置') === 'New Configuration')
const enLib = [withAutoFlag({ name: '', form: {} }, 'sat'), withAutoFlag({ name: '', form: {} }, 'es')]
syncAutoNames(enLib, 'sat')
ok('英文：新建卫星落到英文兜底名', enLib[0].name === 'Satellite', enLib[0].name)
const enEs = [withAutoFlag({ name: '', form: {} }, 'es')]
syncAutoNames(enEs, 'es')
ok('英文：新建地球站落到英文兜底名', enEs[0].name === 'Earth Station', enEs[0].name)
// 有参数的自动名不受语言影响（口径/速率/星名本就没有中文）
const enD = [{ name: '', nameAuto: true, form: { antennaDiameter: '6.2' } }]
syncAutoNames(enD, 'es')
ok('英文：有参数的自动名照旧', enD[0].name === '6.2 m', enD[0].name)

setLang('zh')
syncAutoNames(enEs, 'es'); syncAutoNames(enLib, 'sat')
ok('换回中文：兜底名跟着搬', enEs[0].name === '地球站' && enLib[0].name === '卫星', enEs[0].name + ' / ' + enLib[0].name)
ok('中文：配置树默认名回中文', newCfgName() === '新配置' && newFolderName() === '新建文件夹' && copyNameOf('A') === 'A 副本')
const keep = [{ name: '关口站 6.2m', nameAuto: false, form: {} }, { name: '默认卫星', nameAuto: true, form: { satelliteName: 'Satellite' } }]
setLang('en'); syncAutoNames(keep, 'sat'); setLang('zh')
ok('换语言不碰自定义名 / 不碰算不出名字的条目', keep[0].name === '关口站 6.2m' && keep[1].name === '默认卫星')

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
