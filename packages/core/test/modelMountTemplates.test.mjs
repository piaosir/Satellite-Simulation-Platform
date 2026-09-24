// 挂点模板（packages/core/models/mountTemplates.mjs）：字段合 schema.normalizeMount（零错误、幂等）、参数化模型挂点名与位姿对得上、
// 套用时模型为准 / 悬空引用清掉 / id 去重；D1 上向；万向节几何（TDRS SA 的 a1 管南北、a2 管东西；默认卫星点波束 ±9° 覆盖可见地球盘）；
// 旧 id dfh4 静默别名到 default-sat（不进目录）；目录与模板文字不出现中国平台字样。
// 每条挂点的方向图量都够算星侧太阳侵入 ΔT（不会因「没有方向图」静默记 0）。

import assert from 'node:assert/strict'
import { MOUNT_TEMPLATES, listMountTemplates, mountTemplate, applyMountTemplate } from '../models/mountTemplates.mjs'
import { TEMPLATE_IDS } from '../models/paramTemplates.mjs'
import { normalizeMount, validateBindings } from '../models/schema.mjs'
import { defaultUpBody } from '../models/bodyFrame.mjs'
import { buildTemplateModel } from '../models/paramBus.mjs'
import { attitudeBasisEcef, mountFrame, mountBasisEcef, dirBodyToMount, losToBody } from '../models/attitude.mjs'
import { solveXY, normalizeGimbal, pickSolution } from '../models/gimbal.mjs'
import { createRequire } from 'node:module'
const so = createRequire(import.meta.url)('../utils/sunOutageCalculator.js')

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const D2R = Math.PI / 180
const R_GEO = 42164.17

t('六份模板：TDRS（两副单址 + 多址阵 + SGL）/ GOES / SSL-1300 / 默认卫星 / Landsat 8 / 3U 立方星；全部 illustrative', () => {
  assert.deepEqual(MOUNT_TEMPLATES.map((x) => x.id), ['tdrs', 'goes', 'ssl1300', 'default-sat', 'landsat8', 'cubesat3u'])
  for (const x of MOUNT_TEMPLATES) {
    assert.equal(x.fidelity, 'illustrative', x.id)
    assert.ok(x.mounts.length >= 2, x.id)
    assert.ok(Object.isFrozen(x) && Object.isFrozen(x.mounts[0]), '只读')
    assert.ok(x.source && x.source.note && x.source.refs.length, `${x.id} 出处`)
  }
  const tdrs = mountTemplate('tdrs')
  assert.deepEqual(tdrs.mounts.map((m) => m.id), ['sa_e', 'sa_w', 'ma', 'sgl'])
  assert.equal(tdrs.mounts.filter((m) => m.gimbal.type !== 'none').length, 3, 'SA ×2 + SGL 带万向节')
  const L = listMountTemplates()
  assert.equal(L.length, 6); assert.equal(L[0].count, 4)
  assert.equal(mountTemplate('nope'), null)
  const c = mountTemplate('default-sat'); c.mounts[0].name = 'x'
  assert.notEqual(mountTemplate('default-sat').mounts[0].name, 'x', '副本可改、不回写')
})

t('默认卫星：旧 id dfh4 静默别名（mountTemplate / applyMountTemplate 认、目录不列）；modelIds 只指向现行参数化模板；全部模板文字无中国平台字样', () => {
  assert.deepEqual(mountTemplate('dfh4'), mountTemplate('default-sat'), '旧 id → 默认卫星')
  assert.deepEqual(applyMountTemplate('dfh4'), applyMountTemplate('default-sat'), '套用结果相同')
  assert.ok(!listMountTemplates().some((x) => /dfh/i.test(x.id)), '目录不列旧 id')
  const d = mountTemplate('default-sat')
  assert.equal(d.titleZh, '默认卫星'); assert.equal(d.title, 'Default satellite')
  assert.deepEqual(d.modelIds, ['param:default-sat'])
  for (const x of MOUNT_TEMPLATES) {
    for (const id of x.modelIds) if (id.startsWith('param:')) assert.ok(TEMPLATE_IDS.includes(id.slice(6)), `${x.id} 引用的参数化模板 ${id} 在目录里`)
    const text = JSON.stringify(x)
    assert.ok(!/dfh|东方红|东四|中国|china|空间技术研究院/i.test(text) && !/CAST|CGWIC/.test(text), `${x.id} 含中国平台字样`)
  }
})

t('每条 mount 过 schema.normalizeMount 零错误、归一幂等（已知键逐字段相同）；antennaRef = param 且带频率', () => {
  let cnt = 0
  for (const x of MOUNT_TEMPLATES) {
    for (const m of x.mounts) {
      const r = normalizeMount(JSON.parse(JSON.stringify(m)))
      assert.deepEqual(r.errors, [], `${x.id}/${m.id}`)
      for (const k of ['id', 'name', 'attachPoint', 'posBody', 'boresightBody', 'upBody', 'sysTempK', 'gimbal', 'antennaRef', 'excludeNodes']) assert.deepEqual(r.mount[k], JSON.parse(JSON.stringify(m[k])), `${x.id}/${m.id}.${k}`)
      if (m.fovDeg !== undefined) assert.equal(r.mount.fovDeg, m.fovDeg)
      assert.equal(m.antennaRef.kind, 'param')
      assert.ok(m.antennaRef.spec.freqGHz > 0, `${x.id}/${m.id} 频率`)
      assert.ok(m.sysTempK > 0)
      cnt++
    }
    // 整张绑定表也过得去（id 在星内唯一）
    const vb = validateBindings({ schema: 1, bindings: { 'norad:1': { model: { id: 'auto' }, mounts: x.mounts, attitude: x.attitude } } })
    assert.equal(vb.ok, true); assert.deepEqual(vb.errors, [], x.id)
  }
  console.log(`  ${MOUNT_TEMPLATES.length} 份模板、${cnt} 条挂点全部零错误`)
})

t('D1：上向 = defaultUpBody(视轴)（对地 [0,−1,0]），up ⟂ 视轴', () => {
  for (const x of MOUNT_TEMPLATES) for (const m of x.mounts) {
    const d = m.upBody[0] * m.boresightBody[0] + m.upBody[1] * m.boresightBody[1] + m.upBody[2] * m.boresightBody[2]
    near(d, 0, 1e-15, `${x.id}/${m.id} ⟂`)
    if (m.boresightBody[2] === 1 || m.boresightBody[2] === -1) assert.deepEqual(m.upBody, defaultUpBody(m.boresightBody), `${x.id}/${m.id}`)
  }
})

t('参数化模型：默认卫星 / SSL-1300 / 3U 的挂点名在 paramBus 生成结果里都有，模板位姿与之相同（1 mm / 1e-12）', () => {
  for (const [tid, pid] of [['default-sat', 'default-sat'], ['ssl1300', 'ssl1300'], ['cubesat3u', 'cubesat-3u']]) {
    const aps = buildTemplateModel(pid).attachPoints
    for (const m of mountTemplate(tid).mounts) {
      if (!m.attachPoint) continue
      const ap = aps.find((a) => a.name === m.attachPoint)
      assert.ok(ap, `${tid}/${m.id}：paramBus 没有挂点 ${m.attachPoint}`)
      for (let k = 0; k < 3; k++) {
        near(m.posBody[k], ap.posBody[k], 1e-3, `${tid}/${m.id} pos`)
        near(m.boresightBody[k], ap.dirBody[k], 1e-12, `${tid}/${m.id} 视轴`)
        near(m.upBody[k], ap.upBody[k], 1e-12, `${tid}/${m.id} up`)
      }
    }
  }
  assert.equal(mountTemplate('default-sat').mounts.filter((m) => /^reflector_[1-4]_focus$/.test(m.attachPoint)).length, 4, '默认卫星四个反射面挂点')
})

t('applyMountTemplate：有同名挂点 → 位姿取模型；没有 → attachPoint 置 null、用模板位姿；id 与已有撞了加后缀', () => {
  const r = buildTemplateModel('default-sat')
  const moved = r.attachPoints.map((a) => (a.name === 'reflector_1_focus' ? { ...a, posBody: [1.2, 0.1, 1.7] } : a))
  const a = applyMountTemplate('default-sat', { attachPoints: moved, existingIds: ['spot_1'] })
  assert.deepEqual(a.errors, [])
  assert.deepEqual(a.matched, ['reflector_1_focus', 'reflector_2_focus', 'reflector_3_focus', 'reflector_4_focus'])
  assert.deepEqual(a.unmatched, [])
  assert.deepEqual(a.mounts[0].posBody, [1.2, 0.1, 1.7], '模型为准')
  assert.deepEqual(a.mounts.map((m) => m.id), ['refl_c_e', 'refl_ku_w', 'spot_1_2', 'spot_2'])
  assert.equal(a.attitude.law, 'nadir')
  const b = applyMountTemplate('tdrs', {})
  assert.deepEqual(b.unmatched, ['SA_E_Attachpoint', 'SA_W_Attachpoint', 'MA_Attachpoint', 'SGL_Attachpoint'])
  assert.ok(b.mounts.every((m) => m.attachPoint === null), '不留悬空引用')
  assert.deepEqual(b.mounts[0].posBody, [4, 0, 2])
  assert.equal(applyMountTemplate('nope'), null)
})

t('applyMountTemplate：up 取模板（投到模型视轴法平面），不取挂点节点的上向——STK tdrs 式镜像挂点（SA_E 上向 −X、SA_W 上向 +X）两副都保持北向；模板 up 与视轴平行时退到挂点 up、再退 D1', () => {
  // 形状照本机 STK tdrs.glb 按出厂映射读出的挂点位姿（只抄方向的形状，不抄模型数据）
  const aps = [
    { name: 'SA_E_Attachpoint', posBody: [5.18, 0, 2.49], dirBody: [0, 0, 1], upBody: [-1, 0, 0] },
    { name: 'SA_W_Attachpoint', posBody: [-3.28, 0, 2.49], dirBody: [0, 0, 1], upBody: [1, 0, 0] },
    { name: 'MA_Attachpoint', posBody: [0, 0, 1.86], dirBody: [0, 0, 1], upBody: [-1, 0, 0] },
    { name: 'SGL_Attachpoint', posBody: [0, -3.015, 1.58], dirBody: [0, 0.6, 0.8], upBody: [-1, 0, 0] }
  ]
  const r = applyMountTemplate('tdrs', { attachPoints: aps })
  assert.deepEqual(r.errors, []); assert.deepEqual(r.unmatched, [])
  assert.deepEqual(r.mounts[0].upBody, [0, -1, 0], 'SA_E 北向'); assert.deepEqual(r.mounts[1].upBody, [0, -1, 0], 'SA_W 北向')
  assert.deepEqual(r.mounts[0].posBody, [5.18, 0, 2.49], '位置取模型')
  const sgl = r.mounts[3]
  near(sgl.upBody[0] * sgl.boresightBody[0] + sgl.upBody[1] * sgl.boresightBody[1] + sgl.upBody[2] * sgl.boresightBody[2], 0, 1e-15, 'SGL up ⟂ 新视轴')
  assert.ok(sgl.upBody[1] < -0.7, 'SGL up 仍偏北')
  // 模板 up [0,−1,0] 与模型视轴 −Y 平行 → 退到挂点 up
  const par = applyMountTemplate('tdrs', { attachPoints: [{ name: 'MA_Attachpoint', posBody: [0, 0, 1.86], dirBody: [0, -1, 0], upBody: [0, 0, 1] }] })
  assert.deepEqual(par.errors, []); assert.deepEqual(par.mounts[2].upBody, [0, 0, 1], '退到挂点 up')
  const par2 = applyMountTemplate('tdrs', { attachPoints: [{ name: 'MA_Attachpoint', posBody: [0, 0, 1.86], dirBody: [0, -1, 0] }] })
  assert.deepEqual(par2.errors, []); assert.deepEqual(par2.mounts[2].upBody, defaultUpBody([0, -1, 0]), '再退 D1')
})

t('TDRS SA（X-Y 座、±31° / ±22.5°）：赤道 GEO 天底姿态下 a1 管南北（北为正）、a2 管东西（西为正）', () => {
  const lon = -41 * D2R, rE = [R_GEO * Math.cos(lon), R_GEO * Math.sin(lon), 0]
  const body = attitudeBasisEcef('nadir', null, { rEcef: rE })
  const sa = mountTemplate('tdrs').mounts[0]
  const f = mountFrame(sa)
  const nadir = rE.map((x) => -x / R_GEO), north = [0, 0, 1], east = [-Math.sin(lon), Math.cos(lon), 0]
  const tilt = (axis, deg) => nadir.map((x, k) => Math.cos(deg * D2R) * x + Math.sin(deg * D2R) * axis[k])
  const sN = solveXY(dirBodyToMount(losToBody(tilt(north, 10), body), f))
  near(sN.a1, 10, 1e-9, '北偏 10° → a1 = +10'); near(sN.a2, 0, 1e-9, 'a2 = 0')
  const sE = solveXY(dirBodyToMount(losToBody(tilt(east, 10), body), f))
  near(sE.a2, -10, 1e-9, '东偏 10° → a2 = −10'); near(sE.a1, 0, 1e-9, 'a1 = 0')
  // 与挂点系 ECEF 基底一致：mountBasisEcef 的 y = 北、x = 西
  const mb = mountBasisEcef(body, f)
  for (let k = 0; k < 3; k++) { near(mb.y[k], north[k], 1e-12, 'y = 北'); near(mb.x[k], -east[k], 1e-12, 'x = 西') }
})

t('默认卫星可动点波束（X-Y ±9°）：105.5°E 看得见的地面点全部在限位内（地球张角 8.7°）', () => {
  const lon0 = 105.5 * D2R, rE = [R_GEO * Math.cos(lon0), R_GEO * Math.sin(lon0), 0]
  const body = attitudeBasisEcef('nadir', null, { rEcef: rE })
  const spot = mountTemplate('default-sat').mounts.find((m) => m.id === 'spot_1')
  const f = mountFrame(spot), lim = normalizeGimbal(spot.gimbal), o = {}
  let worst = 0, cnt = 0
  for (let lat = -80; lat <= 80; lat += 2) for (let lon = 25; lon <= 185; lon += 2) {
    const la = lat * D2R, lo = lon * D2R, P = [6378.137 * Math.cos(la) * Math.cos(lo), 6378.137 * Math.cos(la) * Math.sin(lo), 6356.752 * Math.sin(la)]
    const d = P.map((x, k) => x - rE[k]), l = Math.hypot(...d), u = d.map((x) => x / l)
    const up = P.map((x) => x / Math.hypot(...P))
    if (u[0] * up[0] + u[1] * up[1] + u[2] * up[2] > -0.01) continue      // 仰角低于约 0.6° 的不算
    const s = solveXY(dirBodyToMount(losToBody(u, body), f))
    assert.ok(pickSolution(s.a1, s.a2, lim, 0, 0, o), `(${lat},${lon}) 超限：${s.a1}/${s.a2}`)
    worst = Math.max(worst, Math.abs(s.a1), Math.abs(s.a2)); cnt++
  }
  assert.ok(worst < 9 && cnt > 500)
  console.log(`  默认卫星点波束：${cnt} 个可见地面点，最大万向节角 ${worst.toFixed(2)}°（限位 ±9°）`)
})

t('每条挂点都能算星侧太阳侵入 ΔT：spec 带口径 / 波束宽 / 增益之一，sunNoiseTemp 视轴对日非空且 > 0；全向 0 dBi、TDRS MA 取阵元 26°、Landsat 8 X 频段是固定对地 ECA', () => {
  const rows = []
  for (const x of MOUNT_TEMPLATES) for (const m of x.mounts) {
    const sp = m.antennaRef.spec
    assert.ok(sp.diameterM > 0 || sp.hpbwDeg > 0 || Number.isFinite(sp.gainDbi), `${x.id}/${m.id}：没有能定方向图的量`)
    const r = so.sunNoiseTemp({ freqGHz: sp.freqGHz, offAxisDeg: 0, diameterM: sp.diameterM, thetaB3dBDeg: sp.hpbwDeg, gainDbi: sp.gainDbi, sysTempK: m.sysTempK, utcMs: Date.UTC(2026, 2, 20) })
    assert.ok(r && r.dT > 0 && Number.isFinite(r.gtLossDb), `${x.id}/${m.id}：ΔT 算不出`)
    if (['ma', 'eca', 's_nadir', 's_zenith', 'uhf'].includes(m.id)) rows.push(`${x.id}/${m.id} ${r.mode} ΔT ${r.dT.toFixed(2)} K`)
  }
  const byId = (tid, mid) => mountTemplate(tid).mounts.find((m) => m.id === mid)
  assert.equal(byId('tdrs', 'ma').antennaRef.spec.hpbwDeg, 26)
  for (const [tid, mid] of [['landsat8', 's_nadir'], ['landsat8', 's_zenith'], ['cubesat3u', 'uhf']]) assert.equal(byId(tid, mid).antennaRef.spec.gainDbi, 0, `${tid}/${mid} 0 dBi`)
  const eca = byId('landsat8', 'eca')
  assert.equal(eca.gimbal.type, 'none'); assert.equal(eca.antennaRef.spec.hpbwDeg, 120)
  assert.equal(byId('landsat8', 'gxa'), undefined, 'Landsat 8 没有 GXA（那是 Landsat 7）')
  console.log('  补上方向图的五条（春分、视轴对日）：' + rows.join('；'))
})

console.log(`modelMountTemplates: ${n} 项通过`)
