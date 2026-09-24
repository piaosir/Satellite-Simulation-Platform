// 自动匹配（packages/core/models/autoMatch.mjs）的回归网。
//
//   ① 规则表 ≥ 60 条；每条引用的 NASA id 都真在 scripts/nasa3d/include-list.json 的七组里且有 glb
//      （多文件条目按契约 §3.5：nasa:<slug>~<n> 的 n 不超过该条目的文件数）。只读仓库里的清单，不联网、不读语料。
//   ② 真实卫星名（CelesTrak / SATCAT 写法）≥ 30 个逐个对答案。
//   ③ available 里没有的 NASA id 跳到下一个候选 / 下一条规则；prefs.geoDefault 生效且不可用时退回默认卫星 param:default-sat。
//   ④ 2026-09-24：GEO 缺省与一切未命中规则的星都给默认卫星；prefs.geoDefault 写旧模板 id（param:dfh4 等）按别名换成现行 id；
//      任何输入都不会匹配出旧模板 id。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { match, RULES, ruleNasaIds, normalizeName, CONSTELLATION_RULES, DEFAULT_MODEL_ID } from '../models/autoMatch.mjs'
import { isValidModelId } from '../models/schema.mjs'
import { TEMPLATE_IDS } from '../models/paramTemplates.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }

const includeList = JSON.parse(readFileSync(fileURLToPath(new URL('../../../scripts/nasa3d/include-list.json', import.meta.url)), 'utf8'))
const GROUPS = new Set(['spacecraft', 'deepspace', 'station', 'component', 'ground', 'crewed', 'launcher'])
const VALID = new Set()
for (const e of includeList.entries) {
  if (!GROUPS.has(e.group) || !Array.isArray(e.glbs) || !e.glbs.length) continue
  VALID.add(`nasa:${e.slug}`)
  for (let k = 2; k <= e.glbs.length; k++) VALID.add(`nasa:${e.slug}~${k}`)
}
const N = (slug) => `nasa:${slug}`
const DEF = 'param:default-sat'

t('规则表 ≥ 60 条、key 唯一；每个 NASA id 都在 include-list 七组内且有 glb', () => {
  assert.ok(RULES.length >= 60, `只有 ${RULES.length} 条`)
  assert.equal(new Set(RULES.map((r) => r.key)).size, RULES.length, 'key 重复')
  const ids = ruleNasaIds()
  for (const id of ids) {
    assert.ok(isValidModelId(id), `id 格式 ${id}`)
    assert.ok(VALID.has(id), `${id} 不在 include-list 七组 / 无 glb`)
  }
  console.log(`  规则 ${RULES.length} 条（另有星座 ${CONSTELLATION_RULES.length} 条），引用 NASA 模型 ${ids.length} 个，全部在清单内`)
})

t('参数化兜底 id 都是真实模板；默认卫星 = param:default-sat', () => {
  assert.equal(DEFAULT_MODEL_ID, DEF)
  for (const id of ['flat-leo', 'default-sat', 'cubesat-1u', 'cubesat-1.5u', 'cubesat-3u', 'cubesat-6u', 'cubesat-12u']) assert.ok(TEMPLATE_IDS.includes(id), id)
})

// [名称, NORAD, 轨道类别, 组, 期望 id, 期望 rule]
const CASES = [
  ['TDRS 13', 42915, 'GEO', 'geo', N('tracking-and-data-relay-satellites-tdrs-d'), 'tdrs-gen2-3'],
  ['TDRS 3', 19548, 'GEO', 'geo', N('tracking-and-data-relay-satellites-tdrs-a'), 'tdrs-gen1'],
  ['GOES 18', 51850, 'GEO', 'geo', N('geostationary-operational-environmental-satellites'), 'goes'],
  ['LANDSAT 9', 49260, 'LEO', 'other', N('landsat-8'), 'landsat-8-9'],
  ['LANDSAT 7', 25682, 'LEO', 'other', N('landsat-7'), 'landsat-7'],
  ['ISS (ZARYA)', 25544, 'LEO', 'stations', N('international-space-station-iss-d-igoal'), 'iss'],
  ['ISS (NAUKA)', 49044, 'LEO', 'stations', N('international-space-station-iss-d-igoal'), 'iss'],
  ['HST', 20580, 'LEO', 'other', N('hubble-space-telescope-a'), 'hst'],
  ['AQUA', 27424, 'LEO', 'other', N('aqua-c'), 'aqua'],
  ['TERRA', 25994, 'LEO', 'other', N('terra'), 'terra'],
  ['AURA', 28376, 'LEO', 'other', N('aura-c'), 'aura'],
  ['JASON-3', 41240, 'LEO', 'other', N('ocean-surface-topography-mission-ostm-jason-2'), 'jason-3'],
  ['SENTINEL-6A', 46984, 'LEO', 'other', N('jason-continuity-of-service-sentinel-6'), 'sentinel-6'],
  ['SENTINEL-6 (MICHAEL FREILICH)', 46984, 'LEO', 'other', N('jason-continuity-of-service-sentinel-6'), 'sentinel-6'],
  ['SUOMI NPP', 37849, 'LEO', 'other', N('suomi-national-polar-orbiting-partnership-suomi-npp'), 'suomi-npp'],
  ['NOAA 20', 43013, 'LEO', 'other', N('suomi-national-polar-orbiting-partnership-suomi-npp'), 'noaa-20'],
  ['NOAA 19', 33591, 'LEO', 'other', N('polar-operational-environmental-satellite-poes'), 'noaa-poes'],
  ['GPM-CORE', 39574, 'LEO', 'other', N('global-precipitation-measurement'), 'gpm'],
  ['OCO 2', 40059, 'LEO', 'other', N('orbiting-carbon-observatory-oco-2'), 'oco-2'],
  ['ICESAT-2', 43613, 'LEO', 'other', N('ice-clouds-and-land-elevation-satellite-2-icesat-2-c'), 'icesat-2'],
  ['CLOUDSAT', 29107, 'LEO', 'other', N('cloudsat-c'), 'cloudsat'],
  ['CALIPSO', 29108, 'LEO', 'other', N('cloud-aerosol-lidar-and-infrared-pathfinder-satellite-calipso'), 'calipso'],
  ['SWIFT', 28485, 'LEO', 'other', N('swift'), 'swift'],
  ['FERMI', 33053, 'LEO', 'other', N('fermi-gamma-ray-large-area-space-telescope'), 'fermi'],
  ['TESS', 43435, 'HEO', 'other', N('transiting-exoplanet-survey-satellite-tess-b'), 'tess'],
  ['GRACE-FO 1', 43476, 'LEO', 'other', N('gravity-recovery-and-climate-experiment-grace-a'), 'grace-fo'],
  ['CYGFM05', 41884, 'LEO', 'other', N('cyclone-global-navigation-satellite-system-cygnss'), 'cygnss'],
  ['CXO', 25867, 'HEO', 'other', N('chandra-x-ray-observatory'), 'chandra'],
  ['MMS 1', 40482, 'HEO', 'other', N('magnetospheric-multiscale-mms-a'), 'mms'],
  ['DSCOVR', 40390, 'HEO', 'other', N('deep-space-climate-observatory-dscovr-triana'), 'dscovr'],
  ['SAC-D', 37673, 'LEO', 'other', 'nasa:aquarius-b~2', 'aquarius'],
  ['STARLINK-1007', 44713, 'LEO', 'starlink', 'param:flat-leo', 'constellation:starlink'],
  ['ONEWEB-0012', 44057, 'LEO', 'oneweb', 'param:flat-leo', 'constellation:oneweb'],
  ['KUIPER-00008', 60000, 'LEO', 'kuiper', 'param:flat-leo', 'constellation:kuiper'],
  ['QIANFAN-1', 60379, 'LEO', 'qianfan', 'param:flat-leo', 'constellation:qianfan'],
  ['HULIANWANG DIGUI-01', 62000, 'LEO', 'guowang', 'param:flat-leo', 'constellation:guowang'],
  ['某星 A', 99999, 'LEO', 'guowang', 'param:flat-leo', 'constellation:guowang'],
  ['ZHONGXING-9A', 42763, 'GEO', 'geo', DEF, 'geo-default'],
  ['CHINASAT 26', 57860, 'GEO', 'geo', DEF, 'geo-default'],
  ['APSTAR 6D', 45863, 'GEO', 'geo', DEF, 'geo-default'],
  ['INTELSAT 39', 44476, 'GEO', 'geo', DEF, 'geo-default'],
  ['BEIDOU-3 M1', 43001, 'MEO', 'beidou', DEF, 'fallback'],
  ['GSAT0101 (GALILEO 5)', 37846, 'MEO', 'galileo', DEF, 'fallback'],
  ['TIANHE', 48274, 'LEO', 'stations', DEF, 'fallback'],
  ['OBSCURESAT-7', 88888, 'LEO', 'other', DEF, 'fallback'],
  ['MOLNIYA 1-93', 28163, 'HEO', 'other', DEF, 'fallback'],
  ['FLOCK 4P-1', 51000, 'LEO', 'planet', 'param:cubesat-3u', 'cubesat:3u-series'],
  ['LEMUR-2-JOEL', 42000, 'LEO', 'spire', 'param:cubesat-3u', 'cubesat:3u-series'],
  ['CUBESAT XI-IV', 27848, 'LEO', 'other', 'param:cubesat-3u', 'cubesat:default-3u'],
  ['MYSAT 1U', 70001, 'LEO', 'other', 'param:cubesat-1u', 'cubesat:1u'],
  ['TESTSAT 1.5U', 70002, 'LEO', 'other', 'param:cubesat-1.5u', 'cubesat:1.5u'],
  ['XYZ-12U', 70003, 'LEO', 'other', 'param:cubesat-12u', 'cubesat:12u'],
  ['ICECUBE', 42705, 'LEO', 'other', N('cubesat-icecube'), 'icecube'],
  ['ISS DEB', 99001, 'LEO', 'other', null, 'debris'],
  ['CZ-3B R/B', 99002, 'GEO', 'other', null, 'debris']
]

t(`真实卫星名 ${CASES.length} 个逐个对答案`, () => {
  assert.ok(CASES.length >= 30)
  for (const [name, noradId, orbitKind, group, id, rule] of CASES) {
    const r = match({ name, noradId, orbitKind, group })
    assert.deepStrictEqual(r, { id, rule }, `${name}：得到 ${JSON.stringify(r)}`)
  }
})

t('NORAD 号兜底：名字不规范时仍能认出 ISS / HST / AQUA / TERRA', () => {
  assert.equal(match({ name: '国际空间站', noradId: 25544, orbitKind: 'LEO' }).rule, 'iss')
  assert.equal(match({ name: 'hubble', noradId: '20580' }).rule, 'hst')
  assert.equal(match({ name: '', noradId: 27424 }).id, N('aqua-c'))
  assert.equal(match({ name: 'EOS AM-1', noradId: 0 }).id, N('terra'))
})

t('名称归一：全角 / 小写 / 多空格', () => {
  assert.equal(normalizeName('  ｔｅｒｒａ  '), 'TERRA')
  assert.equal(match({ name: 'ｔｅｒｒａ' }).id, N('terra'))
  assert.equal(match({ name: 'tdrs   13' }).rule, 'tdrs-gen2-3')
  assert.equal(match({ name: 'goes-16' }).rule, 'goes')
})

t('available 缺候选：先换同规则的下一个候选，再落到下一条规则', () => {
  const all = new Set(ruleNasaIds())
  const without = (...drop) => new Set([...all].filter((x) => !drop.includes(x)))
  // TDRS 13：tdrs-d 不可用 → 同规则下一个 trds-e
  assert.deepStrictEqual(match({ name: 'TDRS 13', orbitKind: 'GEO' }, { available: without(N('tracking-and-data-relay-satellites-tdrs-d')) }),
    { id: N('tracking-and-data-relay-satellites-trds-e'), rule: 'tdrs-gen2-3' })
  // 三个 TDRS 候选全缺 → 下一条「tdrs」规则的 tdrs-a？也缺 → GEO 缺省
  const noTdrs = without(N('tracking-and-data-relay-satellites-tdrs-d'), N('tracking-and-data-relay-satellites-trds-e'), N('tracking-and-data-relay-satellites-tdrs-a'))
  assert.deepStrictEqual(match({ name: 'TDRS 13', orbitKind: 'GEO' }, { available: noTdrs }), { id: DEF, rule: 'geo-default' })
  // ISS 候选全缺 → 兜底默认卫星
  assert.deepStrictEqual(match({ name: 'ISS (ZARYA)', orbitKind: 'LEO', group: 'stations' }, { available: new Set() }), { id: DEF, rule: 'fallback' })
  // param: 模型恒可用（运行时生成，不进 manifest 也行）
  assert.deepStrictEqual(match({ name: 'STARLINK-30000' }, { available: new Set() }), { id: 'param:flat-leo', rule: 'constellation:starlink' })
  // 数组形式的 available 也认
  assert.equal(match({ name: 'HST' }, { available: [N('hubble-space-telescope-b')] }).id, N('hubble-space-telescope-b'))
})

t('prefs.geoDefault：生效；是 NASA id 但不可用时退回默认卫星；旧模板 id 按别名换成 param:default-sat；只管 GEO', () => {
  const ssl = N('space-systems-loral-ssl-1300')
  assert.deepStrictEqual(match({ name: 'APSTAR 6D', orbitKind: 'GEO' }, { prefs: { geoDefault: ssl } }), { id: ssl, rule: 'geo-default' })
  assert.deepStrictEqual(match({ name: 'APSTAR 6D', orbitKind: 'GEO' }, { prefs: { geoDefault: ssl }, available: new Set([N('terra')]) }), { id: DEF, rule: 'geo-default' })
  assert.deepStrictEqual(match({ name: 'APSTAR 6D', orbitKind: 'geo' }, { prefs: { geoDefault: 'param:ssl1300' } }), { id: 'param:ssl1300', rule: 'geo-default' })
  // 旧模板 id（老存档的 prefs）：静默别名到现行 id
  for (const old of ['param:dfh4', 'param:dfh4e', 'param:dfh5']) {
    assert.deepStrictEqual(match({ name: 'INTELSAT 39', orbitKind: 'GEO' }, { prefs: { geoDefault: old } }), { id: DEF, rule: 'geo-default' }, old)
    assert.deepStrictEqual(match({ name: 'ZHONGXING-26' }, { prefs: { geoDefault: old }, available: new Set() }), { id: DEF, rule: 'geo-name-hint' }, old)
  }
  assert.deepStrictEqual(match({ name: 'APSTAR 6D', orbitKind: 'GEO' }, { prefs: { geoDefault: '' } }), { id: DEF, rule: 'geo-default' }, '空串按缺省')
  // GEO 偏好不外溢到非 GEO 的兜底
  assert.deepStrictEqual(match({ name: 'BEIDOU-3 M1', orbitKind: 'MEO' }, { prefs: { geoDefault: 'param:ssl1300' } }), { id: DEF, rule: 'fallback' })
})

t('orbitKind 缺失时 GEO 运营商名兜底；给了非 GEO 类别就不兜底', () => {
  assert.deepStrictEqual(match({ name: 'ZHONGXING-26' }), { id: DEF, rule: 'geo-name-hint' })
  assert.deepStrictEqual(match({ name: 'INTELSAT 901' }), { id: DEF, rule: 'geo-name-hint' })
  assert.deepStrictEqual(match({ name: 'ZHONGXING-26', orbitKind: 'IGSO' }), { id: DEF, rule: 'fallback' })
  assert.deepStrictEqual(match({ name: 'GSAT0203 (GALILEO 8)' }), { id: DEF, rule: 'fallback' }, '伽利略的 GSAT 不能当 GEO 通信星')
  // 两条路给的模型同是默认卫星，区别在 GEO 偏好只作用于 GEO 那条
  assert.deepStrictEqual(match({ name: 'GSAT0203 (GALILEO 8)' }, { prefs: { geoDefault: 'param:ssl1300' } }), { id: DEF, rule: 'fallback' })
  assert.deepStrictEqual(match({ name: 'INTELSAT 901' }, { prefs: { geoDefault: 'param:ssl1300' } }), { id: 'param:ssl1300', rule: 'geo-name-hint' })
})

t('入参容错：空对象 / null', () => {
  assert.deepStrictEqual(match({}), { id: DEF, rule: 'fallback' })
  assert.deepStrictEqual(match(null), { id: DEF, rule: 'fallback' })
})

t('任何输入都匹配不出旧模板 id（param:dfh*）；碎片 / 火箭体仍不配模型', () => {
  const names = [...CASES.map((c) => c[0]), 'DFH-4', 'DONGFANGHONG 5', 'SHIJIAN-20', 'ZHONGXING-26', '']
  for (const nm of names) for (const kind of ['GEO', 'MEO', 'LEO', 'IGSO', 'HEO', '']) {
    const r = match({ name: nm, orbitKind: kind })
    assert.ok(r.id === null || !/dfh/i.test(r.id), `${nm}/${kind}：${r.id}`)
  }
  assert.equal(match({ name: 'CZ-3B R/B', orbitKind: 'GEO' }).id, null)
  assert.equal(match({ name: 'FENGYUN 1C DEB', orbitKind: 'LEO' }).id, null)
})

console.log(`modelAutoMatch: ${n} 项通过`)
