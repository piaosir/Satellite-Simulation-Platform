// 设计页快速设置的纯逻辑（src/model/quickLogic.js）+ 组件主要参数表（src/model/asmLogic.js KEY_PARAMS）单测。
// ① 太阳翼构型切换保留参数、转角按整星 SADA 角（两翼同向对日：−Y 翼取反）；读数「两翼不同」；翼长 / 基板面积。
// ② 反射面增删：占第一个空闲位置、口径取细节档示意口径、位置下拉只列空位；生成器实际焦距（留空按焦径比）。
// ③ 偏置抛物面几何读数对审查算例：D 2.5 m、f 2.0 m、d_c 1.55 m → 净空 0.30 m、θ0 39.3°、θ* 30.7°。
// ④ 出处：模板原值 → 示意值 / 出处；改过 → 用户值；列表条目按槽位 / 安装面对回模板。热控多层两键联动。
// ⑤ 主要参数：全部登记组件都有主要参数且键都存在；paramRows 带 main 标记。
// 不联网。

import assert from 'node:assert/strict'
import * as Q from '../../../src/model/quickLogic.js'
import { KEY_PARAMS, keyParamsOf, paramRows } from '../../../src/model/asmLogic.js'
import { listComponents, getComponent } from '../models/components/index.mjs'
import { newDrivenDoc } from '../models/drive.mjs'
import { validateSpec } from '../models/paramBus.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const specOf = (id = 'default-sat') => newDrivenDoc({ templateId: id }).drive.spec

t('太阳翼构型：双翼 → 单翼 → 无 → 双翼，参数保留、转角按 SADA 角（−Y 翼取反）', () => {
  let s = specOf()
  assert.equal(Q.wingConfig(s), 'both')
  s = Q.setWingValue(s, 'tiltDeg', 20)
  assert.equal(s.wings.find((w) => w.side === '+Y').tiltDeg, 20)
  assert.equal(s.wings.find((w) => w.side === '-Y').tiltDeg, -20)
  assert.equal(Q.wingValue(s, 'tiltDeg').value, 20); assert.equal(Q.wingValue(s, 'tiltDeg').mixed, false)
  s = Q.setWingConfig(s, '+Y')
  assert.equal(Q.wingConfig(s), '+Y'); assert.equal(s.wings.length, 1)
  s = Q.setWingConfig(s, 'both')
  assert.equal(Q.wingConfig(s), 'both')
  const wm = s.wings.find((w) => w.side === '-Y')
  assert.equal(wm.panels, 4); assert.equal(wm.tiltDeg, -20, '新补的 −Y 翼照抄 +Y 翼参数、转角按 SADA 角')
  assert.ok(validateSpec(s).ok)
  s = Q.setWingConfig(s, 'none')
  assert.equal(Q.wingConfig(s), 'none'); assert.ok(validateSpec(s).ok)
  const s2 = Q.setWingConfig(s, 'both', { panels: 3, panelHM: 2, panelWM: 1.5, sidePanels: 0, yokeLenM: 1, gapM: 0.05, tiltDeg: 0, axis: 'y' })
  assert.equal(s2.wings.length, 2); assert.equal(s2.wings[0].panels, 3)
})

t('太阳翼读数：两翼不同 → mixed；翼长 = 连接架 + 基板串 + 板缝；基板面积含侧板', () => {
  let s = specOf()
  s.wings[1].panels = 5
  const r = Q.wingValue(s, 'panels')
  assert.equal(r.mixed, true); assert.deepEqual(r.values.slice().sort(), [4, 5])
  near(Q.wingLengthM({ yokeLenM: 2.5, panels: 4, panelHM: 3.3, gapM: 0.05 }), 2.5 + 13.2 + 0.15, 1e-12, '翼长')
  s = specOf()
  near(Q.arrayAreaM2(s), 2 * 4 * 3.3 * 2.36, 1e-9, '基板面积')
  s.wings[0].sidePanels = 2
  near(Q.arrayAreaM2(s), (4 + 4 + 2) * 3.3 * 2.36, 1e-9, '侧板计入')
})

t('反射面增删：第一个空闲位置、示意口径、位置下拉只列空位', () => {
  let s = specOf()
  assert.deepEqual(Q.slotChoices(s).map((x) => x.key), ['+X2', '-X2'])
  assert.deepEqual(Q.slotChoices(s, 0).map((x) => x.key), ['+X', '+X2', '-X2'], '本行自己占的位置照列')
  const a = Q.addReflector(s)
  assert.ok(a); s = a.spec
  const r = s.reflectors.at(-1)
  assert.equal(r.slot, '+X2'); assert.equal(r.diameterM, 2.5, 'GEO 侧壁示意口径')
  assert.equal(a.path, 'reflectors[4].diameterM')
  s = Q.addReflector(s).spec
  assert.equal(Q.addReflector(s), null, '六个位置占满')
  s = Q.removeReflector(s, 0)
  assert.equal(s.reflectors.length, 5)
  assert.ok(Q.slotChoices(s).some((x) => x.key === '+X'))
  assert.ok(validateSpec(s).ok)
  s = Q.setReflValue(s, 0, 'diameterM', 3.3)
  assert.equal(s.reflectors[0].diameterM, 3.3)
})

t('生成器实际焦距：给了用给的；留空按焦径比（东西侧挂实面 1.6、对地板实面 0.8、网状 0.5；口径超过网状门限一律网状）', () => {
  const s = specOf()
  assert.equal(Q.effFocalM(s, { diameterM: 2, focalM: 1.7 }), 1.7)
  near(Q.effFocalM(s, { diameterM: 2, focalM: null }), 3.2, 1e-12, '侧挂实面（没给槽位 = 侧挂）')
  near(Q.effFocalM(s, { diameterM: 2, focalM: null, slot: '-X2' }), 3.2, 1e-12, '侧挂实面')
  near(Q.effFocalM(s, { diameterM: 2, focalM: null, slot: 'deck+Y' }), 1.6, 1e-12, '对地板实面')
  near(Q.effFocalM(s, { diameterM: 2, focalM: null, mount: 'deck' }), 1.6, 1e-12, '对地板实面（只给挂法）')
  near(Q.effFocalM(s, { diameterM: 2, focalM: null, mesh: true }), 1.0, 1e-12, '网状')
  near(Q.effFocalM(s, { diameterM: 6, focalM: null }), 3.0, 1e-12, '超过门限 → 网状')
})

t('偏置抛物面读数：审查算例 D 2.5 / f 2.0 / d_c 1.55 → 净空 0.30 m、θ0 39.3°、θ* 30.7°', () => {
  const g = Q.reflGeom(2.5, 2.0, 1.55)
  near(g.fD, 0.8, 1e-12, 'F/D')
  near(g.clearanceM, 0.30, 1e-12, '净空')
  near(g.theta0Deg, 39.28, 0.01, 'θ0')
  near(g.thetaStarDeg, 30.70, 0.01, 'θ*')
  const g0 = Q.reflGeom(2, 1, 0)
  near(g0.theta0Deg, 0, 1e-12, '正馈 θ0 = 0')
  assert.equal(Q.reflGeom(0, 1, 1), null)
})

t('出处：模板原值 → 示意 / 出处；改过 → 用户值；反射面按槽位对回模板', () => {
  let s = specOf('ssl1300')
  const p0 = Q.provOf('ssl1300', s, 'bus.xM')
  assert.ok(p0.kind === 'source' || p0.kind === 'derived', p0.kind)
  assert.ok(p0.title.length > 0)
  s.bus.xM = 3.3
  assert.equal(Q.provOf('ssl1300', s, 'bus.xM').kind, 'user')
  let d = specOf()
  assert.equal(Q.provOf('default-sat', d, 'reflectors[2].diameterM').kind, 'illustrative')
  d = Q.removeReflector(d, 0)   // 下标前移：第 2 条的槽位仍是 deck+Y
  assert.equal(d.reflectors[1].slot, 'deck+Y')
  assert.equal(Q.provOf('default-sat', d, 'reflectors[1].diameterM').kind, 'illustrative', '按槽位对回模板')
  assert.equal(Q.provOf('', d, 'bus.xM').kind, 'user')
})

t('热控多层：选「无」只关 detail.mli、材质留着；选材质同时打开', () => {
  let s = specOf()
  assert.equal(Q.mliOf(s), 'mli_gold')
  s = Q.setMli(s, 'none')
  assert.equal(Q.mliOf(s), 'none'); assert.equal(s.bus.mli, 'mli_gold')
  s = Q.setMli(s, 'mli_black')
  assert.equal(Q.mliOf(s), 'mli_black'); assert.equal(s.detail.mli, true)
  assert.ok(validateSpec(s).ok)
})

t('可选覆盖键：天线塔高 / 密度留空 = 删键回生成器缺省', () => {
  let s = specOf()
  s = Q.setSpecValue(s, 'tower.hM', 2.2)
  assert.equal(s.tower.hM, 2.2)
  s = Q.setSpecValue(s, 'tower.hM', null)
  assert.ok(!s.tower)
  s = Q.setSpecValue(s, 'density.panelAreal', 2)
  assert.equal(s.density.panelAreal, 2)
  s = Q.setSpecValue(s, 'density.panelAreal', null)
  assert.ok(!s.density)
})

t('主要参数：全部登记组件都有主要参数，键都存在；paramRows 带 main 标记', () => {
  for (const def of listComponents()) {
    const k = keyParamsOf(def)
    assert.ok(k.length > 0, def.type)
    if (KEY_PARAMS[def.type]) for (const key of KEY_PARAMS[def.type]) assert.ok(def.keys.includes(key), `${def.type}.${key}`)
  }
  const rows = paramRows(getComponent('sat.reflector'), {})
  assert.deepEqual(rows.filter((r) => r.main).map((r) => r.key), ['diameterM', 'focalM', 'offsetHM', 'surface', 'front', 'support', 'feed'])
  assert.ok(rows.some((r) => !r.main && r.key === 'shellM'))
})

console.log(`modelQuick: ${n} 项通过`)
