// 链路预算 · 默认站址的降雨率 / 海拔（src/shared/lbDefaultSite.js + core.defaultSiteGeo）自测。运行：npm test
//
// 关键不变式：
//   ① 同源：引擎经纬度留空时的取值点 = core.DEFAULT_SITE = 三窗字段缺省经纬度；defaultSiteGeo 按这同一组数查 ITU；
//   ② 只动「站址经纬度两格都留空 + R0.01% / 海拔格留空」的那一侧：其余行 withDefaultSite 原样返回同一个对象，
//      组参与引擎结果逐位不变（含手填 0、站址填了而降雨率留空的行）；
//   ③ 补上的值 = 灰字占位的值（defaultSiteValue 一处出）；发 / 收两侧互不牵连；
//   ④ 出厂行（站址写着默认站址）按同一组取值写 R0.01% / 海拔，isDefaultSiteSeed 认得它；别处的站址不写；
//   ⑤ 取不到（未激活 { locked:true } / 老 preload / 抛错）一律 null，一切照旧。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TX_SITE, RX_SITE, siteDefaulted, defaultSiteValue, withDefaultSite, seedDefaultSite, isDefaultSiteSeed, loadDefaultSiteGeo
} from '../../../src/shared/lbDefaultSite.js'
import * as GEO from '../../../src/linkbudget/params.js'
import * as NGSO from '../../../src/ngso/ngsoParams.js'
import * as REGEN from '../../../src/regen/regenParams.js'

const require = createRequire(import.meta.url)
const core = require('../index.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const defOf = (fields, key) => (fields.find((f) => f.key === key) || {}).def

// 全精度 ITU 数据照主进程启动时那样注入（降雨率 P.837 / 海拔 P.1511）；缺文件就用内嵌回退（海拔为 null）
try {
  const rd = (f) => readFileSync(join(ROOT, 'resources/itu', f))
  core.loadFullPrecisionData({ rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'), vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin') })
} catch (e) { /* 内嵌回退 */ }

// ---------- ① 同源 ----------
const DS = core.DEFAULT_SITE
ok('DEFAULT_SITE 有值', DS && Number.isFinite(DS.lat) && Number.isFinite(DS.lon), DS && `${DS.lat},${DS.lon}`)
for (const [name, P] of [['GSO', GEO], ['NGSO', NGSO], ['再生式', REGEN]]) {
  ok(`${name} 发信站经纬度缺省 = DEFAULT_SITE`, Number(defOf(P.TX_FIELDS, 'longitude')) === DS.lon && Number(defOf(P.TX_FIELDS, 'latitude')) === DS.lat)
  ok(`${name} 收信站经纬度缺省 = DEFAULT_SITE`, Number(defOf(P.RX_FIELDS, 'rxLongitude')) === DS.lon && Number(defOf(P.RX_FIELDS, 'rxLatitude')) === DS.lat)
}
// 引擎留空经纬度 ≡ 显式给 DEFAULT_SITE（GEO / NGSO 两引擎）
const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO' }
const explicit = { longitude: String(DS.lon), latitude: String(DS.lat), rxLongitude: String(DS.lon), rxLatitude: String(DS.lat) }
const gBlank = core.calculateLinkBudget(SAT, {}).data, gExp = core.calculateLinkBudget(SAT, explicit).data
ok('GEO 引擎：经纬度留空 ≡ 显式 DEFAULT_SITE（全部出参逐位相同）', JSON.stringify(gBlank) === JSON.stringify(gExp))
const NG = { distanceMode: 'slantRange', slantRange: '2000', minElevation: '30', rxDistanceMode: 'slantRange', rxSlantRange: '2000', rxMinElevation: '30', orbitAltitude: '1200', rxOrbitAltitude: '1200' }
const nBlank = core.calculateLinkBudgetNGSO(SAT, { ...NG }), nExp = core.calculateLinkBudgetNGSO(SAT, { ...NG, ...explicit })
ok('NGSO 引擎：经纬度留空 ≡ 显式 DEFAULT_SITE', nBlank && nBlank.success && JSON.stringify(nBlank.data) === JSON.stringify(nExp.data))
// defaultSiteGeo 就是 geoAutoFill(DEFAULT_SITE)
const geo = core.defaultSiteGeo()
const gf = core.geoAutoFill(DS.lat, DS.lon)
ok('defaultSiteGeo 的查询点 = DEFAULT_SITE', geo.lat === DS.lat && geo.lon === DS.lon)
ok('defaultSiteGeo 的取值 = geoAutoFill(DEFAULT_SITE)', geo.rainRate === gf.rainRate && geo.altitude === gf.altitude, `R=${geo.rainRate} h=${geo.altitude}`)
ok('默认站址降雨率 > 0（P.837 有值）', Number(geo.rainRate) > 0)

// 渲染端拿到的形状（loadDefaultSiteGeo 归一后）
const G = await loadDefaultSiteGeo({ linkBudget: { defaultSiteGeo: async () => geo } })
ok('loadDefaultSiteGeo：正常取值', G && G.lat === DS.lat && G.rainRate === Number(geo.rainRate))
ok('loadDefaultSiteGeo：未激活 → null', (await loadDefaultSiteGeo({ linkBudget: { defaultSiteGeo: async () => ({ locked: true }) } })) === null)
ok('loadDefaultSiteGeo：老 preload 无入口 → null', (await loadDefaultSiteGeo({ linkBudget: {} })) === null)
ok('loadDefaultSiteGeo：抛错 → null', (await loadDefaultSiteGeo({ linkBudget: { defaultSiteGeo: async () => { throw new Error('x') } } })) === null)
ok('loadDefaultSiteGeo：无 api → null', (await loadDefaultSiteGeo(null)) === null)

// ---------- ② 不涉及的行原样 ----------
const blankRow = () => { const r = {}; for (const f of [...GEO.TX_FIELDS, ...GEO.RX_FIELDS]) r[f.key] = ''; return r }
const factory = () => ({ ...GEO.defaultsFor(GEO.TX_FIELDS), ...GEO.defaultsFor(GEO.RX_FIELDS) })
const filledSite = { ...blankRow(), earthStationLocation: '上海', longitude: '121.47', latitude: '31.23', rxLongitude: '113.26', rxLatitude: '23.13' }
const handZero = { ...blankRow(), rainRate: '0', altitude: '0', rxRainRate: '0', rxAltitude: '0' }
for (const [name, row] of [['站址填了、降雨率留空', filledSite], ['站址留空、手填 0', handZero], ['出厂默认值行', factory()]]) {
  ok(`${name} → withDefaultSite 原样返回同一对象`, withDefaultSite(row, G) === row)
}
const R0 = blankRow()
ok('geo 取不到 → 同一对象（身份）', withDefaultSite(R0, null) === R0)
// 不涉及的行：组参与引擎结果逐位不变（与不经 withDefaultSite 直接组参比）
const ES_TX = { ...GEO.defaultsFor(GEO.ES_COMMON_FIELDS), ...GEO.defaultsFor(GEO.ES_TX_FIELDS) }
const ES_RX = { ...GEO.defaultsFor(GEO.ES_COMMON_FIELDS), ...GEO.defaultsFor(GEO.ES_RX_FIELDS) }
const SATF = GEO.defaultsFor(GEO.SAT_FIELDS), BB = GEO.defaultsFor(GEO.CARRIER_FIELDS)
const run = (row) => {
  const p = GEO.buildParams(SATF, BB, row, row, ES_TX, ES_RX)
  return { p, r: core.calculateLinkBudget(p.satParams, p.linkParams) }
}
for (const [name, row0] of [['站址填了、降雨率留空', filledSite], ['站址留空、手填 0', handZero], ['出厂默认值行', factory()]]) {
  const row = { ...row0, uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9' }
  const a = run(row), b = run(withDefaultSite(row, G))
  ok(`${name}：组参与引擎结果逐位不变`, JSON.stringify(a.p) === JSON.stringify(b.p) && JSON.stringify(a.r) === JSON.stringify(b.r))
}

// ---------- ③ 站址留空的那一侧补默认站址 ----------
const B = { ...blankRow(), uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9' }
ok('siteDefaulted：两格都空才算', siteDefaulted(B, TX_SITE) && !siteDefaulted({ ...B, latitude: '30' }, TX_SITE))
const eff = withDefaultSite(B, G)
ok('站址留空：补上 R0.01%（发 / 收）', eff !== B && eff.rainRate === String(G.rainRate) && eff.rxRainRate === String(G.rainRate))
ok('站址留空：原行不被改写（留空就是留空）', B.rainRate === '' && B.altitude === '')
if (G.altitude != null) ok('站址留空：补上海拔（发 / 收）', eff.altitude === String(G.altitude) && eff.rxAltitude === String(G.altitude))
ok('补上的值 = 灰字占位的值', defaultSiteValue(B, 'rainRate', G) === eff.rainRate && defaultSiteValue(B, 'rxRainRate', G) === eff.rxRainRate)
ok('非站址列不出灰字覆盖', defaultSiteValue(B, 'G_Ts', G) === null && defaultSiteValue(B, 'longitude', G) === null)
ok('格子填了 → 不出覆盖（用户值优先）', defaultSiteValue({ ...B, rainRate: '80' }, 'rainRate', G) === null)
const half = withDefaultSite({ ...B, rxLongitude: '113.26', rxLatitude: '23.13' }, G)
ok('发 / 收两侧互不牵连：只补站址留空的发侧', half.rainRate === String(G.rainRate) && half.rxRainRate === '')
const handRain = withDefaultSite({ ...B, rainRate: '20' }, G)
ok('手填降雨率保留、海拔照补', handRain.rainRate === '20' && (G.altitude == null || handRain.altitude === String(G.altitude)))
const onlyLon = withDefaultSite({ ...B, longitude: '120' }, G)
ok('只填了经度（纬度留空）→ 该侧不算默认站址、不补', onlyLon.rainRate === '' && onlyLon.rxRainRate === String(G.rainRate))
// 引擎侧：补上之后可用度 < 100 才有雨衰；补之前雨衰为 0（问题本身）
const before = run(B).r.data, after = run(eff).r.data
ok('修复前：站址留空、可用度 99.9 → 上行雨衰 0', Number(before.uplinkRainAttenuation) === 0, before.uplinkRainAttenuation)
ok('修复后：站址留空、可用度 99.9 → 上行雨衰 > 0', Number(after.uplinkRainAttenuation) > 0, after.uplinkRainAttenuation)
ok('修复后与显式填北京 ITU 值逐位一致', JSON.stringify(after) === JSON.stringify(run({ ...B, rainRate: String(G.rainRate), rxRainRate: String(G.rainRate), altitude: eff.altitude, rxAltitude: eff.rxAltitude }).r.data))
// 再生式：按表传侧（发信站表只有发侧键，不该冒出收侧键）
const tx = {}; for (const f of REGEN.TX_FIELDS) tx[f.key] = ''
const txEff = withDefaultSite(tx, G, [TX_SITE])
ok('再生式发信站表：只补发侧、不冒出收侧键', txEff.rainRate === String(G.rainRate) && !('rxRainRate' in txEff))
const rx = {}; for (const f of REGEN.RX_FIELDS) rx[f.key] = ''
ok('再生式收信站表：只补收侧', withDefaultSite(rx, G, [RX_SITE]).rxRainRate === String(G.rainRate))

// ---------- ④ 出厂行 ----------
const F = seedDefaultSite(factory(), G)
ok('出厂行：R0.01% 按默认站址写入（发 / 收）', F.rainRate === String(G.rainRate) && F.rxRainRate === String(G.rainRate))
if (G.altitude != null) ok('出厂行：海拔按默认站址写入', F.altitude === String(G.altitude) && F.rxAltitude === String(G.altitude))
ok('出厂行：isDefaultSiteSeed 认得写入值', isDefaultSiteSeed('rainRate', F.rainRate, G) && isDefaultSiteSeed('rxAltitude', F.rxAltitude, G) === (G.altitude != null))
ok('isDefaultSiteSeed：别的值 / 别的列不认', !isDefaultSiteSeed('rainRate', '0', G) && !isDefaultSiteSeed('G_Ts', String(G.rainRate), G))
const other = seedDefaultSite({ ...factory(), longitude: '121.47', latitude: '31.23' }, G)
ok('站址不是默认站址的一侧不写', other.rainRate === '0' && other.rxRainRate === String(G.rainRate))
ok('geo 取不到：出厂行照旧（0）', seedDefaultSite(factory(), null).rainRate === '0')
const isl = seedDefaultSite(REGEN.defaultsFor(REGEN.ISL_FIELDS), G, [])
ok('星间表无站址：不写任何键', !('rainRate' in isl) && !('rxRainRate' in isl))
// 出厂行用户之后清空降雨率：站址是显式默认站址（非留空）→ 按原口径 0，不补（只认留空站址）
ok('出厂行清空 R0.01%（站址显式）→ 不补', withDefaultSite({ ...F, rainRate: '' }, G).rainRate === '')
// （引擎 accuracy 基线 12.80 / 13.04 由 accuracy.test.js 守：那边不注入全精度数据，本文件注入了，数值不可比）

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
