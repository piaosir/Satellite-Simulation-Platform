// 波束合成「高斯组」（mode 'stk'，STK Gaussian 解析天线）组合层自测。运行：node packages/core/test/synthStk.test.mjs
//
// 盯的口径（useBeamSynth.js 高斯组那一半）：
//   ① addGroup('stk') 出厂 = STK Gaussian 默认模型（gaussStk.freshModel 经 syncModel 三驱动拉齐），宽度 = 模型 θ3（不取整）、
//      Auto 间距 = θ3（4 位小数）；导航器兜底不落在独立仰角线（kind 'elevline'）上。
//   ② 切驱动（口径 → 波束宽 → 峰值增益）数值不跳；改模型 → 该设置与属于它的波束宽度同步、别的设置不动；手动间距不被覆盖；
//      反射面那套（refl / syncReflBack / syncWidths / Auto 间距 watcher / thetaAuto）一概不碰高斯组设置。
//   ③ 生成 → createAnalyticAntenna 恰一次；记录里每个波束的 (az,el) 经天底基底 + 射线求交回到放置的地面点（< 1e-6°），
//      GEO 与 LEO 各一遍；波束名 = 整星连续编号；owner = { kind:'beamsynth', groupId }。再生成 → updateAnalyticAntenna。
//   ④ 自动同步：改动 150 ms 合帧后静默 update（期间不动、连改只一发、不弹窗不写状态行）；拖拽中不发、松手补一次；
//      改模型参数 / 改组名（→ renameAntenna 就地改名）也同步；天线被删 → 不再同步；关联星无星历 → 状态行一句、不建。
//   ⑤ 落盘 → 重新装载：'stk' 不被当成 'gauss'，模型键 / 间距 / _genName / _genSig 全在；撤销快照与复制组保住模型键。
//   ⑥ 多馈源组不受影响：设置仍只带反射面 RP_KEYS（落盘键集逐项相同）、syncWidths 照旧把波束宽拉到反射面 θ3。
//   ⑨ 布阵工具按真实离轴角（LEO 550 km、偏轴 az≈40°，旧 az/el 平面在这里 el 向短 23%）：蜂窝布满最近邻真实夹角 = 间距、
//      相切吸附中心真实夹角 = r1+r2（1 / 2 个邻居），均 < 1e-3°；频率配色同色最小真实间距 ≥ 复用门限；多馈源照旧平面口径（逐位）。
//   ⑩ 关联星无星历：蜂窝布满 / 频率配色报「关联卫星当前无星历」而不是「请先选择卫星」。
//   ⑪ 自动同步遇关联星无星历：本轮跳过、激活组状态行报一句，星历回来自己补同步（不靠别的改动碰巧触发）；
//      状态行只刷新本组还挂着的读数（别的回执不冲掉）；没有波束等静默失败也报到激活组状态行。
//   ⑫ 覆盖树里给生成的天线改名 → 组名 / _genName 跟着改，链接不断（自动同步照旧、再生成不出第二副）；
//      组名不许撞同星的非合成天线（否则同步永远静默失败）。
//   ⑬ 全球 / 宽波束（θ3/2 锥包住整个可见地球盘）：草图画临边圈，不丢。
//   ⑭ 宿主卸载（effectScope 停掉）：退避重试定时器随之清掉，死实例星位回来也不再同步 / 落盘（不覆盖新实例的组表）；
//      重挂 / 重启：上回没同步上的改动自己补上 —— 树已装好、树后装入（往已有星节点 push 天线）、星历还在载入三种情形。
//   ⑮ 树上把天线改成同星另一组的组名：撤回改名 + 一句告警，两组各守各的天线；同星别组攥着的过期 _genName 被清掉。
import { ref, nextTick, effectScope } from 'vue'

let store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] }
}
const { useBeamSynth } = await import('../../../src/viz/grd/useBeamSynth.js')
const { antennaBasis, gridDir, invGridDir, dirToAzEl, azElGround } = await import('../../../src/viz/grd/coverage.js')
const { rayEllipsoid, ecefToGeodetic, geodeticToEcef } = await import('../../../src/viz/wgs84.js')
const { hexFillCenters, snapTangentAzEl, snapTangentTrue, aeqFrame, trueAngleDeg } = await import('../../../src/viz/grd/synth.js')
const { solveStk, syncModel, freshModel, STK_MODEL_DEFAULT } = await import('../../../src/viz/grd/gaussStk.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = async (ms = 0) => { await nextTick(); await nextTick(); if (ms) await sleep(ms); await nextTick() }
const clone = (o) => JSON.parse(JSON.stringify(o))
const GEO = { lon: 110, lat: 0, altKm: 35786 }
const LEO = { lon: 30, lat: 40, altKm: 550 }

// —— 替身：卫星树（先放一条独立仰角线，验证兜底跳过它）+ 解析天线四个入口的记账 ——
// ants / recs0：sat1 下预先挂着的天线与解析记录（模拟重挂 / 重启时覆盖树已装好）
function makeEnv({ keepStore = false, polys = [], ants = [], recs0 = null } = {}) {
  if (!keepStore) store = {}
  const calls = { create: [], update: [], remove: [], rename: [] }
  const alerts = []
  const recs = new Map(recs0 || [])
  const keySubs = []                                                 // grd.onTreeKeys 订阅者（同 useGrdCoverage：改名广播 {type:'rename',from,to}）
  const sats = ref([
    { folder: 'el1', satName: '仰角线', kind: 'elevline', antennas: [] },
    { folder: 'sat1', satName: 'TESTSAT', kind: 'preset', lon: 110, lat: 0, altKm: 35786, antennas: ants.map((a) => ({ ...a })) }
  ])
  const selected = ref([]), active = ref('')
  const satOf = (f) => sats.value.find((x) => x.folder === f)
  const grd = {
    sats, selected, active,
    keyOf: (f, n) => `${f}|${n}`,
    isSelected: (f, n) => selected.value.includes(`${f}|${n}`),
    loadIndex: async () => {},
    // 同 useGrdCoverage.importSynthGrd：同名先删再建（多馈源组生成 = 同名替换）
    importSynthGrd: async (folder, name) => {
      const sat = satOf(folder)
      if (sat.antennas.some((a) => a.name === name)) grd.removeAntenna(folder, name)
      sat.antennas.push({ name, imported: true, synth: true })
      sats.value = [...sats.value]
      calls.synth = (calls.synth || 0) + 1
      return `${folder}|${name}`
    },
    ensureAntLoaded: async (k) => recs.has(k),
    analyticRecordOf: (k) => (recs.has(k) ? clone(recs.get(k)) : null),
    createAnalyticAntenna: async (folder, { name, record, settings, select = true, activate = true } = {}) => {
      if (env.noEph) throw new Error('关联卫星当前无星历')
      const sat = satOf(folder)
      let nm = name, i = 1
      while (sat.antennas.some((a) => a.name === nm)) nm = `${name}·${++i}`
      const key = `${folder}|${nm}`
      calls.create.push({ folder, name: nm, record: clone(record), settings: clone(settings), select, activate })
      sat.antennas.push({ name: nm, imported: true, analytic: true, synth: !!record.owner })
      recs.set(key, clone(record))
      if (select) selected.value = [...selected.value, key]
      if (activate) active.value = key
      sats.value = [...sats.value]
      return key
    },
    updateAnalyticAntenna: (key, record) => {
      calls.update.push({ key, record: clone(record) })
      if (!recs.has(key)) return false
      recs.set(key, clone(record))
      return true
    },
    removeAntenna: (f, n) => {
      calls.remove.push({ f, n })
      const sat = satOf(f); if (!sat) return
      sat.antennas = sat.antennas.filter((a) => a.name !== n)
      recs.delete(`${f}|${n}`)
      selected.value = selected.value.filter((k) => k !== `${f}|${n}`)
      sats.value = [...sats.value]
    },
    renameAntenna: (f, o, n) => {
      calls.rename.push({ f, o, n })
      const sat = satOf(f); if (!sat || sat.antennas.some((a) => a.name === n)) return false
      const a = sat.antennas.find((x) => x.name === o); if (!a) return false
      a.name = n
      const ok = `${f}|${o}`, nk = `${f}|${n}`
      if (recs.has(ok)) { recs.set(nk, recs.get(ok)); recs.delete(ok) }
      selected.value = selected.value.map((k) => (k === ok ? nk : k))
      if (active.value === ok) active.value = nk
      sats.value = [...sats.value]
      for (const f of keySubs) f({ type: 'rename', from: ok, to: nk })
      return true
    },
    onTreeKeys: (fn) => { keySubs.push(fn) }
  }
  const env = { calls, alerts, recs, grd, pos: GEO, noEph: false, polys }
  env.bs = useBeamSynth({
    grd,
    getPolys: () => env.polys,
    livePos: (node) => (node.kind === 'elevline' || env.noEph ? null : env.pos),
    appAlert: (m) => alerts.push(m),
    refresh: () => {}
  })
  return env
}
// 记录波束 (az,el) → 天底基底 igrid-6 方向 → 与 WGS-84 求交 → 地面经纬（与 dirToAzEl / 应用出图同一套基底）
function groundOf(pos, az, el) {
  const nb = antennaBasis(pos.lon, pos.lon, pos.lat || 0, 0, pos.lat || 0, pos.altKm)
  const d = gridDir(6, az, el)
  const w = [0, 1, 2].map((i) => nb.x[i] * d[0] + nb.y[i] * d[1] + nb.z[i] * d[2])
  const P = rayEllipsoid(nb.S, w)
  if (!P) return null
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat }
}
const dLon = (a, b) => Math.abs((((a - b) + 540) % 360) - 180)
function maxGroundErr(pos, rec, pts) {
  let worst = 0
  rec.beams.forEach((b, i) => {
    const g = groundOf(pos, b.az, b.el)
    const e = g ? Math.max(dLon(g.lon, pts[i][0]), Math.abs(g.lat - pts[i][1])) : Infinity
    if (e > worst) worst = e
  })
  return worst
}

// ================= ① 出厂 =================
{
  const env = makeEnv()
  const { bs } = env
  bs.addGroup('stk')
  const s = bs.curSetting.value
  const th0 = solveStk(syncModel(freshModel())).th3Deg
  ok('新建高斯组：mode = stk', bs.mode.value === 'stk' && bs.curGroup.value.mode === 'stk')
  ok('兜底卫星跳过独立仰角线', bs.satFolder.value === 'sat1', bs.satFolder.value)
  ok('一个出厂设置 = STK Gaussian 默认模型', bs.settings.value.length === 1 && s.fGHz === STK_MODEL_DEFAULT.fGHz && s.drv === 'D' && s.D === 1 && s.eff === 55 && s.back === -30 && s.k === 'stk')
  ok('三驱动已拉齐（bw3 / G 为算出值，不是出厂常量的取整值）', Math.abs(s.bw3 - th0) < 1e-12 && Math.abs(s.G - solveStk(s).g0Dbi) < 1e-12)
  ok('宽度 = 模型 θ3（不取整）', s.thX === th0 && s.thY === th0 && s.rot === 0, th0.toFixed(9) + '°')
  ok('Auto 间距 = θ3（4 位）', s.autoSpacing === true && s.spacing === +th0.toFixed(4), String(s.spacing))
  ok('没混进反射面键（antD / apDriver / feedModel）', !('antD' in s) && !('apDriver' in s) && !('feedModel' in s))
  ok('反射面解对高斯组不生效（refl.ok=false、thetaAuto=NaN）', bs.refl.value.ok === false && Number.isNaN(bs.thetaAuto.value))
  ok('组名 = 高斯波束', bs.curName.value === '高斯波束', bs.curName.value)
}

// ================= ② 驱动切换 / 宽度同步 =================
{
  const env = makeEnv()
  const { bs } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  const s = bs.curSetting.value
  const th0 = s.thX, D0 = s.D, G0 = s.G
  bs.setStkModel({ ...syncModel(s), drv: 'bw' })                   // GaussModelFields.setDrv 的发法
  ok('切到「波束宽」驱动：θ3 / 口径 / 峰值增益不跳', s.drv === 'bw' && Math.abs(s.thX - th0) < 1e-12 && Math.abs(solveStk(s).Dm - D0) < 1e-9 && Math.abs(solveStk(s).g0Dbi - G0) < 1e-9)
  bs.setStkModel({ ...syncModel(s), drv: 'G' })
  ok('再切到「峰值增益」驱动：仍不跳', s.drv === 'G' && Math.abs(s.thX - th0) < 1e-9 && Math.abs(solveStk(s).Dm - D0) < 1e-9)
  bs.setStkModel({ ...syncModel(s), drv: 'D' })
  bs.placeAt({ lon: 105, lat: 20 }); bs.placeAt({ lon: 112, lat: 18 })
  ok('放置的波束宽度 = θ3', bs.beams.value.every((b) => b.thX === th0 && b.thY === th0 && b.rot === 0))
  bs.setStkModel(syncModel({ ...s, D: 2 }))                         // 口径翻倍 → θ3 减半
  const th2 = solveStk(s).th3Deg
  ok('改口径 → 设置 θ3 跟着变（θ3 ∝ 1/D）', s.thX === th2 && Math.abs(th2 - th0 / 2) < 1e-12, th2.toFixed(6))
  ok('… 属于它的波束同步', bs.beams.value.every((b) => b.thX === th2 && b.thY === th2))
  ok('… Auto 间距 = 新 θ3', s.spacing === +th2.toFixed(4))
  // 宿主若整份回写（带旧宽度）→ 被拉回 θ3
  Object.assign(s, { thX: 9, thY: 9, rot: 5 })
  ok('整份回写旧宽度 → 被拉回 θ3', s.thX === th2 && s.thY === th2 && s.rot === 0)
  // 第二个设置：复制当前模型，改它不动第一个
  const sid1 = s.id
  bs.addSetting()
  const s2 = bs.curSetting.value
  ok('新设置 = 当前模型的副本', s2.id !== sid1 && s2.D === 2 && s2.thX === th2)
  bs.placeAt({ lon: 120, lat: 10 })
  bs.setStkModel(syncModel({ ...s2, drv: 'bw', bw3: 3 }))
  ok('改第二个设置 → 只有它的波束变宽', bs.beams.value[2].thX === 3 && bs.beams.value[0].thX === th2 && bs.beams.value[1].thX === th2)
  s2.autoSpacing = false; s2.spacing = 5
  bs.setStkModel(syncModel({ ...s2, bw3: 2.5 }))
  ok('手动间距不被模型改动覆盖', s2.spacing === 5 && s2.thX === 2.5)
  s2.autoSpacing = true
  ok('重开 Auto → 间距回到 θ3', s2.spacing === 2.5)
  // 删设置：它的波束改挂激活设置，宽度随之
  bs.selectSetting(sid1)
  bs.removeSetting(s2.id)
  ok('删设置 → 其波束改挂激活设置并换宽度', bs.beams.value[2].settingId === sid1 && bs.beams.value[2].thX === th2)
  bs.undo()
  ok('删设置可撤销（设置与波束归属都回来）', bs.settings.value.length === 2 && bs.beams.value[2].settingId === s2.id && bs.beams.value[2].thX === 2.5)
  ok('撤销快照保住模型键', bs.settings.value.every((x) => x.drv && x.D > 0 && Number.isFinite(x.G) && x.k))
  // 批量表格：高斯组只收经纬度
  const b0 = bs.beams.value[0]
  bs.tblUpdate(b0.id, { thX: 7, rot: 30, lon: 101 })
  ok('批量表格：宽度 / 旋转写不进去，经纬度照写', b0.thX === th2 && (b0.rot || 0) === 0 && b0.lon === 101)
  const n0 = bs.beams.value.length
  bs.tblPasteAppend('100 5 9 9 45\n101 6')
  const added = bs.beams.value.slice(n0)
  ok('粘贴追加：宽度 / 旋转列忽略，宽度 = 激活设置 θ3', added.length === 2 && added.every((b) => b.thX === bs.curSetting.value.thX && (b.rot || 0) === 0))
}

// ================= ③ 生成（GEO / LEO）+ 再生成 =================
async function genCase(pos, pts, label) {
  const env = makeEnv()
  const { bs, calls } = env
  env.pos = pos
  bs.addGroup('stk')
  bs.p.snapTangent = false
  for (const [lon, lat] of pts) bs.placeAt({ lon, lat })
  const k = await bs.generate()
  const c = calls.create
  ok(`${label}：生成 → createAnalyticAntenna 恰一次`, !!k && c.length === 1 && calls.update.length === 0)
  const rec = c[0].record
  ok(`${label}：记录波束数 / 名 = 整星编号`, rec.beams.length === pts.length && rec.beams.every((b, i) => b.name === String(i + 1)))
  const err = maxGroundErr(pos, rec, pts)
  ok(`${label}：记录 (az,el) 回投到放置点 < 1e-6°`, err < 1e-6, err.toExponential(2) + '°')
  const r = solveStk(bs.curSetting.value)
  ok(`${label}：逐波束 θ3 / g0 = 模型解`, rec.beams.every((b) => Math.abs(b.th3 - r.th3Deg) < 1e-12 && Math.abs(b.g0 - r.g0Dbi) < 1e-12 && b.k === 'stk' && b.back === -30))
  ok(`${label}：owner / sat / 电平口径`, rec.owner && rec.owner.kind === 'beamsynth' && rec.owner.groupId === bs.activeGroupId.value && rec.sat.name === 'TESTSAT' && rec.sat.lon === pos.lon && rec.sat.altKm === pos.altKm && c[0].settings.ctype === 'rel' && c[0].settings.levels[0] === -3)
  ok(`${label}：首次生成勾选 + 聚焦`, c[0].select === true && c[0].activate === true)
  ok(`${label}：状态行`, /^已生成天线「高斯波束」：\d+ 个波束 · 波束宽 [\d.]+° · 峰值 [\d.]+ dBi$/.test(bs.status.value), bs.status.value)
  ok(`${label}：_genName / 按钮字样`, bs.curGroup.value._genName === '高斯波束' && bs.genAntExists.value === true)
  return env
}
{
  const env = await genCase(GEO, [[105, 20], [110, 25], [115, 15], [100, 0], [118, -12]], 'GEO')
  const { bs, calls } = env
  const k2 = await bs.generate()
  ok('再生成 → updateAnalyticAntenna（不再新建）', !!k2 && calls.create.length === 1 && calls.update.length === 1)
  ok('再生成状态行 = 已更新天线', /^已更新天线「高斯波束」/.test(bs.status.value), bs.status.value)
  await settle(260)
  ok('手动生成后无多余自动同步', calls.update.length === 1)
}
await genCase(LEO, [[30, 40], [33, 42], [27, 38.5], [31.5, 36]], 'LEO 550 km')

// ================= ④ 自动同步 =================
{
  const env = makeEnv()
  const { bs, calls, alerts } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  // 没生成过 → 改动不触发任何天线操作
  bs.placeAt({ lon: 105, lat: 20 })
  await settle(220)
  ok('未生成过：改动不同步', calls.create.length === 0 && calls.update.length === 0)
  bs.placeAt({ lon: 110, lat: 22 })
  await bs.generate()
  const st0 = bs.status.value, nA = alerts.length
  const b0 = bs.beams.value[0]
  bs.tblUpdate(b0.id, { lon: 106 })
  await settle(60)
  ok('改动后 60 ms：还没发（合帧）', calls.update.length === 0)
  bs.tblUpdate(b0.id, { lat: 21 })
  await settle(60)
  bs.tblUpdate(b0.id, { lon: 106.5 })
  await settle(260)
  ok('连改三下 → 只同步一次', calls.update.length === 1, String(calls.update.length))
  const rec = calls.update[0].record
  ok('同步的记录 = 最新几何', maxGroundErr(GEO, rec, [[106.5, 21], [110, 22]]) < 1e-6)
  // 状态行挂着本组的生成读数 → 静默同步把它刷新成「已更新」（天线已换，旧读数不能留着）；不弹窗
  ok('静默：不弹窗；状态行上本组的读数刷新为「已更新」', alerts.length === nA && /^已生成天线「高斯波束」：2 个波束/.test(st0) && /^已更新天线「高斯波束」：2 个波束 · 波束宽 [\d.]+° · 峰值 [\d.]+ dBi$/.test(bs.status.value), bs.status.value)
  // 拖拽：拖动中不发，松手补一次
  bs.dragBeam(1, { lon: 111, lat: 22 }, 'move')
  await settle(80)
  bs.dragBeam(1, { lon: 112, lat: 22.5 }, 'move')
  await settle(260)
  ok('拖拽中不同步', calls.update.length === 1)
  bs.dragBeam(1, null, 'end')
  await settle(40)
  ok('松手补一次', calls.update.length === 2 && maxGroundErr(GEO, calls.update[1].record, [[106.5, 21], [112, 22.5]]) < 1e-6)
  // 改模型参数 → 同步（记录里 θ3 变）
  const s = bs.curSetting.value
  bs.setStkModel(syncModel({ ...s, D: 1.6 }))
  await settle(220)
  ok('改方向图模型 → 同步，记录 θ3 = 新模型', calls.update.length === 3 && Math.abs(calls.update[2].record.beams[0].th3 - solveStk(s).th3Deg) < 1e-12)
  // 纯显示改动（轮廓色）→ 签名不变，不同步
  bs.p.skColor = '#ff0000'
  await settle(220)
  ok('纯显示改动不同步', calls.update.length === 3)
  // 改组名 → 就地改名 + 更新
  bs.renameGroup(bs.activeGroupId.value, '点波束A')
  await settle(220)
  ok('改组名 → renameAntenna 就地改名并更新', calls.rename.length === 1 && calls.rename[0].n === '点波束A' && calls.update.length === 4 && calls.update[3].key === 'sat1|点波束A' && bs.curGroup.value._genName === '点波束A')
  ok('改名不新建天线', calls.create.length === 1 && env.grd.sats.value[1].antennas.length === 1)
  // 天线被删 → 不再同步；按钮回到「生成天线」
  env.grd.removeAntenna('sat1', '点波束A')
  ok('天线删了 → genAntExists = false', bs.genAntExists.value === false)
  bs.tblUpdate(b0.id, { lon: 107 })
  await settle(220)
  ok('天线删了 → 改动不再同步', calls.update.length === 4 && calls.create.length === 1)
  // 关联星无星历 → 状态行、不建
  env.noEph = true
  const kNo = await bs.generate()
  ok('无星历 → 不生成，状态行 = 关联卫星当前无星历', kNo === null && bs.status.value === '关联卫星当前无星历' && calls.create.length === 1)
  env.noEph = false
  const kRe = await bs.generate()
  ok('星历回来 → 重新生成（新建）', !!kRe && calls.create.length === 2)
}

// ================= ⑤ 落盘往返 / 复制 =================
{
  const env = makeEnv()
  const { bs } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  const s = bs.curSetting.value
  bs.setStkModel(syncModel({ ...s, drv: 'bw', bw3: 1.2, eff: 60, back: -25, k: '4ln2' }))
  s.autoSpacing = false; s.spacing = 1.5
  bs.placeAt({ lon: 105, lat: 20 })
  await bs.generate()
  await settle(20)
  const gid = bs.activeGroupId.value, sig = bs.curGroup.value._genSig
  const raw = JSON.parse(store['globe3d/beamSynth'])
  const sg = raw.groups.find((g) => g.id === gid)
  ok('落盘：mode = stk、模型键在', sg.mode === 'stk' && sg.settings[0].drv === 'bw' && sg.settings[0].bw3 === 1.2 && sg.settings[0].eff === 60 && sg.settings[0].back === -25 && sg.settings[0].k === '4ln2')
  ok('落盘：间距 / _genName / _genSig', sg.settings[0].autoSpacing === false && sg.settings[0].spacing === 1.5 && sg._genName === '高斯波束' && !!sg._genSig)
  ok('落盘：高斯组设置不带反射面键', !('antD' in sg.settings[0]) && !('feedModel' in sg.settings[0]))
  const env2 = makeEnv({ keepStore: true })
  const bs2 = env2.bs
  const g2 = bs2.groups.value.find((g) => g.id === gid)
  ok('重新装载：不被当成多馈源', g2 && g2.mode === 'stk' && bs2.mode.value === 'stk')
  const s2 = bs2.curSetting.value
  ok('重新装载：模型 / 宽度 / 间距', s2.drv === 'bw' && s2.bw3 === 1.2 && s2.k === '4ln2' && s2.thX === 1.2 && s2.autoSpacing === false && s2.spacing === 1.5 && bs2.beams.value[0].thX === 1.2)
  ok('重新装载：_genName / _genSig 保住', g2._genName === '高斯波束' && g2._genSig === sig)
  // 复制组：模型键跟着走，_genName 不跟（副本是新天线）
  bs2.duplicateGroup(gid)
  const cs = bs2.curSetting.value
  ok('复制组：模型键保住、不继承生成记号', bs2.mode.value === 'stk' && cs.drv === 'bw' && cs.bw3 === 1.2 && cs.k === '4ln2' && !bs2.curGroup.value._genName)
}

// ================= ⑥ 多馈源组不受影响 =================
{
  const env = makeEnv()
  const { bs } = env
  bs.addGroup('gauss')
  bs.p.snapTangent = false
  const s = bs.curSetting.value
  ok('多馈源：设置带反射面键、不带模型键', 'antD' in s && 'apDriver' in s && !('drv' in s) && !('back' in s))
  bs.placeAt({ lon: 105, lat: 20 })
  const t0 = bs.thetaAuto.value
  ok('多馈源：thetaAuto = 反射面 θ3、波束宽 = 其 4 位取整', t0 > 0 && bs.beams.value[0].thX === +t0.toFixed(4))
  s.antD = 3.6
  const t1 = bs.thetaAuto.value
  ok('多馈源：改口径 → syncWidths 把设置与波束拉到新 θ3', Math.abs(t1 - t0) > 1e-3 && s.thX === +t1.toFixed(4) && bs.beams.value[0].thX === +t1.toFixed(4))
  ok('多馈源：Auto 间距 watcher 照旧（间距 = thX）', s.spacing === s.thX)
  await settle(20)
  const raw = JSON.parse(store['globe3d/beamSynth'])
  const keys = Object.keys(raw.groups[0].settings[0])
  const want = ['id', 'name', 'thX', 'thY', 'rot', 'color', 'fGHz', 'antD', 'eff', 'apDriver', 'bw3', 'fdDriver', 'feedSpacingWl', 'feedModel', 'feedDiaAuto', 'feedDiaWl', 'foc', 'offsetClr', 'pol', 'simSame', 'fSim', 'autoSpacing', 'spacing']
  ok('多馈源：落盘键集与旧版逐项相同', JSON.stringify(keys) === JSON.stringify(want), keys.join(','))
  bs.addSetting()
  bs.undo()
  ok('多馈源：撤销快照仍是反射面键', bs.settings.value.length === 1 && 'antD' in bs.settings.value[0] && !('drv' in bs.settings.value[0]))
}

// ================= ⑦ 整星编号：不跟显示态走，跟组的增删走 =================
{
  const env = makeEnv()
  const { bs, calls } = env
  const gA = bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.placeAt({ lon: 100, lat: 10 }); bs.placeAt({ lon: 104, lat: 10 })
  await bs.generate()
  bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.placeAt({ lon: 110, lat: 20 }); bs.placeAt({ lon: 114, lat: 20 }); bs.placeAt({ lon: 118, lat: 20 })
  await bs.generate()
  const recB = calls.create[1].record
  ok('第二组的波束名接着第一组往下数', calls.create[1].name === '高斯波束 2' && recB.beams.map((b) => b.name).join(',') === '3,4,5', recB.beams.map((b) => b.name).join(','))
  await settle(220)
  const nU = calls.update.length
  bs.toggleGroupVisible(gA)
  bs.selectGroup(gA)
  await settle(220)
  ok('常显 / 切组不改编号、不触发同步', calls.update.length === nU)
  bs.removeGroup(gA)
  await settle(220)
  const last = calls.update[calls.update.length - 1]
  ok('删掉前面的组 → 后面组的天线波束名重排（自动同步）', calls.update.length === nU + 1 && last.key === 'sat1|高斯波束 2' && last.record.beams.map((b) => b.name).join(',') === '1,2,3')
  ok('删组不删它已生成的天线', env.grd.sats.value[1].antennas.some((a) => a.name === '高斯波束'))
}

// ================= ⑧ 草图轮廓 = θ3/2 锥 ∩ WGS-84（精确） =================
{
  const env = makeEnv()
  const { bs } = env
  env.pos = LEO
  bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.setStkModel(syncModel({ ...bs.curSetting.value, drv: 'bw', bw3: 4 }))
  bs.placeAt({ lon: 33, lat: 43 })
  bs.openFor('sat1')
  const spec = bs.sketchSpec()
  const { geodeticToEcef } = await import('../../../src/viz/wgs84.js')
  const S = geodeticToEcef(LEO.lon, LEO.lat, LEO.altKm), T = geodeticToEcef(33, 43, 0)
  const ax = [T[0] - S[0], T[1] - S[1], T[2] - S[2]], al = Math.hypot(...ax)
  let worst = 0, n = 0
  for (const q of spec.lines[0].p) {
    const P = geodeticToEcef(q[0], q[1], 0), v = [P[0] - S[0], P[1] - S[1], P[2] - S[2]]
    const c = (v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2]) / (Math.hypot(...v) * al)
    const cr = Math.hypot(v[1] * ax[2] - v[2] * ax[1], v[2] * ax[0] - v[0] * ax[2], v[0] * ax[1] - v[1] * ax[0]) / (Math.hypot(...v) * al)
    const e = Math.abs(Math.atan2(cr, c) * 180 / Math.PI - 2)
    if (e > worst) worst = e
    n++
  }
  ok('LEO 草图轮廓每点离轴角 = θ3/2（锥足迹，非 az/el 椭圆）', n >= 96 && worst < 1e-7, `${n} 点，最大偏差 ${worst.toExponential(2)}°`)
  const b = bs.beams.value[0]
  const ring0 = b._ring
  bs.sketchSpec()
  ok('同一星位二次取草图命中缓存', b._ring === ring0)
}

// ================= ⑨ 布阵工具按真实离轴角（LEO 550 km、偏轴 az≈40°） =================
// 这里 igrid-6 的 el 向真实夹角 ≈ cos(40°)·Δel —— 旧的 az/el 平面算法把蜂窝 / 吸附排密 17%–23%。
const LEO30 = { lon: 30, lat: 30, altKm: 550 }
const dirOfLL = (pos, lon, lat) => { const ae = dirToAzEl(pos.lon, pos.lat || 0, pos.altKm, lon, lat); return gridDir(6, ae.az, ae.el) }
const llOfAzEl = (pos, az, el) => azElGround(pos.lon, pos.lat || 0, pos.altKm, az, el)
const angLL = (pos, a, b) => trueAngleDeg(dirOfLL(pos, a.lon, a.lat), dirOfLL(pos, b.lon, b.lat))
// 地面 Polygon：以 igrid-6 (az0,el0) 为切点、真实角半径 rad° 的圆（n 顶点）
function polyAround(pos, az0, el0, rad, n = 12) {
  const F = aeqFrame(az0, el0), pts = []
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / n, w = F.fromXY(rad * Math.cos(t), rad * Math.sin(t))
    const ae = invGridDir(6, w[0], w[1], w[2]), g = llOfAzEl(pos, ae[0], ae[1])
    pts.push([g.lon, g.lat])
  }
  return pts
}
const nnTrue = (dirs) => dirs.map((u, i) => Math.min(...dirs.map((v, j) => (j === i ? Infinity : trueAngleDeg(u, v)))))
const fmtSpan = (a) => `${Math.min(...a).toFixed(5)}…${Math.max(...a).toFixed(5)}°`
{
  // 9a 引擎层：格心精确方向（未取整）
  const P3 = polyAround(LEO30, 40, 3, 3), P10 = polyAround(LEO30, 40, 3, 10)
  const arg = (pts, metric) => ({ satLon: LEO30.lon, satLat: LEO30.lat, altKm: LEO30.altKm, polyPts: pts, spacing: 2, ...(metric ? { metric } : {}) })
  const old = hexFillCenters(arg(P3))
  const oldNN = nnTrue(old.map((c) => dirOfLL(LEO30, c.lon, c.lat)))
  ok('旧 az/el 平面蜂窝在此处最近邻真实夹角明显短于间距（复现缺陷）', Math.min(...oldNN) < 1.7, fmtSpan(oldNN))
  const t3 = hexFillCenters(arg(P3, 'true'))
  const nn3 = nnTrue(t3.map((c) => gridDir(6, c.az, c.el)))
  ok('真实角度蜂窝：最近邻真实夹角 = 间距（< 1e-3°）', t3.length >= 6 && nn3.every((d) => Math.abs(d - 2) < 1e-3), `${t3.length} 个，${fmtSpan(nn3)}`)
  const t10 = hexFillCenters(arg(P10, 'true'))
  const nn10 = nnTrue(t10.map((c) => gridDir(6, c.az, c.el)))
  const rho = 10 * Math.PI / 180, bound = 2 * rho * rho / 6
  ok('大区（半径 10°）：最近邻只会略短，不超出 AEQ 失真界 s·ρ²/6', t10.length > 50 && nn10.every((d) => d <= 2 + 1e-9 && d >= 2 - bound), `${t10.length} 个，${fmtSpan(nn10)}，界 ${bound.toFixed(5)}°`)
  ok('格心经纬度 = 精确方向回投后取 4 位', t3.every((c) => { const g = llOfAzEl(LEO30, c.az, c.el); return dLon(g.lon, c.lon) <= 5.1e-5 && Math.abs(g.lat - c.lat) <= 5.1e-5 }))
  ok('缺省口径仍是 az/el 平面（多馈源 / 相控阵用）', JSON.stringify(old) === JSON.stringify(hexFillCenters(arg(P3, 'azel'))))
  // 相切吸附（引擎层，精确）
  const A = { az: 40, el: 3, r: 2 }
  const s1 = snapTangentTrue([40, 7.4], [A], 2)
  const u1 = gridDir(6, s1.az, s1.el), uA = gridDir(6, 40, 3)
  ok('snapTangentTrue 1 个邻居：真实夹角 = r+rNew（1e-9°）', s1.snapped === 1 && Math.abs(trueAngleDeg(u1, uA) - 4) < 1e-9, trueAngleDeg(u1, uA).toFixed(12))
  const s2 = snapTangentTrue([44.3, 5], [A, { az: s1.az, el: s1.el, r: 2 }], 2)
  const u2 = gridDir(6, s2.az, s2.el)
  ok('snapTangentTrue 2 个邻居：与两者真实夹角都 = r+rNew（1e-9°）', s2.snapped === 2 && Math.abs(trueAngleDeg(u2, uA) - 4) < 1e-9 && Math.abs(trueAngleDeg(u2, u1) - 4) < 1e-9)
  const o1 = snapTangentAzEl([40, 7.4], [A], 2)
  ok('平面版（多馈源口径）不变：az/el 平面间距 = r+rNew，真实夹角只有 ≈ 4·cos40°', Math.abs(Math.hypot(o1.az - 40, o1.el - 3) - 4) < 1e-12 && trueAngleDeg(gridDir(6, o1.az, o1.el), uA) < 3.2)
}
{
  // 9b 组合层：高斯组「蜂窝布满」→ 落盘经纬度（4 位）上量真实夹角；频率配色按真实复用距离
  const env = makeEnv({ polys: [{ id: 'P3', pts: polyAround(LEO30, 40, 3, 3) }, { id: 'P6', pts: polyAround(LEO30, 40, 3, 6) }] })
  env.pos = LEO30
  const { bs } = env
  bs.addGroup('stk')
  bs.setStkModel(syncModel({ ...bs.curSetting.value, drv: 'bw', bw3: 2 }))
  const sp = bs.curSetting.value.spacing
  bs.p.polyId = 'P3'
  bs.hexFill()
  const nn = nnTrue(bs.beams.value.map((b) => dirOfLL(LEO30, b.lon, b.lat)))
  ok('高斯组蜂窝布满：落盘波束最近邻真实夹角 = Auto 间距 θ3（< 1e-3°，含经纬度取整）', sp === 2 && bs.beams.value.length >= 6 && nn.every((d) => Math.abs(d - sp) < 1e-3), `${bs.beams.value.length} 个，${fmtSpan(nn)}`)
  bs.clearBeams()
  bs.p.polyId = 'P6'
  bs.hexFill()
  bs.p.fcN = 4
  bs.assignFreqPlan()
  const bl = bs.beams.value, dirs = bl.map((b) => dirOfLL(LEO30, b.lon, b.lat))
  let minSame = Infinity
  for (let i = 0; i < bl.length; i++) for (let j = i + 1; j < bl.length; j++) if (bl[i].fc === bl[j].fc) minSame = Math.min(minSame, trueAngleDeg(dirs[i], dirs[j]))
  ok('高斯组频率配色（4 色）：无冲突，同色最小真实间距 ≥ 0.95·√4·θ3', /^频率配色完成/.test(bs.status.value) && bl.length > 20 && bl.every((b) => b.fc >= 0 && b.fc < 4) && minSame >= 0.95 * 2 * sp, `${bl.length} 个，同色最小 ${minSame.toFixed(4)}°`)
  // 多馈源组：同一 Polygon、同一间距 → 与平面算法逐点相同
  const env2 = makeEnv({ polys: env.polys })
  env2.pos = LEO30
  const bs2 = env2.bs
  bs2.addGroup('gauss')
  const s2 = bs2.curSetting.value
  s2.autoSpacing = false; s2.spacing = 2
  bs2.p.polyId = 'P3'
  bs2.hexFill()
  const want = hexFillCenters({ satLon: LEO30.lon, satLat: LEO30.lat, altKm: LEO30.altKm, polyPts: env.polys[0].pts, spacing: 2 })
  ok('多馈源蜂窝布满仍走 az/el 平面（逐点相同）', want.length > 0 && JSON.stringify(bs2.beams.value.map((b) => [b.lon, b.lat])) === JSON.stringify(want.map((c) => [c.lon, c.lat])))
}
{
  // 9c 组合层：高斯组相切吸附（θ3 = 4°：r1 + r2 = 4°）
  const env = makeEnv()
  env.pos = LEO30
  const { bs } = env
  bs.addGroup('stk')
  bs.setStkModel(syncModel({ ...bs.curSetting.value, drv: 'bw', bw3: 4 }))
  bs.p.snapTangent = true
  const A = llOfAzEl(LEO30, 40, 3)
  bs.placeAt({ lon: A.lon, lat: A.lat })
  const c1 = llOfAzEl(LEO30, 40, 7.4)                              // 沿 el 一个 θ3 多：真实夹角只有 ≈ 3.4°（深交叠）→ 吸附推开
  bs.placeAt({ lon: c1.lon, lat: c1.lat })
  const [a, b] = bs.beams.value
  const dAB = angLL(LEO30, a, b)
  const aeA = dirToAzEl(LEO30.lon, LEO30.lat, LEO30.altKm, a.lon, a.lat), aeB = dirToAzEl(LEO30.lon, LEO30.lat, LEO30.altKm, b.lon, b.lat)
  ok('高斯组相切吸附（1 个邻居，沿 el）：两中心真实夹角 = r1+r2（< 1e-3°）', Math.abs(dAB - 4) < 1e-3, dAB.toFixed(6) + '°')
  ok('… az/el 平面间距 ≈ θ3/cos(az)，不再停在平面相切的 4.000', Math.hypot(aeB.az - aeA.az, aeB.el - aeA.el) > 4.8)
  const c2 = llOfAzEl(LEO30, 44.3, 5)
  bs.placeAt({ lon: c2.lon, lat: c2.lat })
  const c = bs.beams.value[2]
  const dCA = angLL(LEO30, c, a), dCB = angLL(LEO30, c, b)
  ok('高斯组相切吸附（2 个邻居）：与两邻居真实夹角都 = r1+r2（< 1e-3°）', Math.abs(dCA - 4) < 1e-3 && Math.abs(dCB - 4) < 1e-3, `${dCA.toFixed(6)}° / ${dCB.toFixed(6)}°`)
  // 多馈源组：放置 = 平面相切（逐位同 snapTangentAzEl → azElGround → 4 位）
  const env2 = makeEnv()
  env2.pos = LEO30
  const bs2 = env2.bs
  bs2.addGroup('gauss')
  bs2.p.snapTangent = true
  Object.assign(bs2.curSetting.value, { apDriver: 'beamwidth', bw3: 4 })   // 反射面按波束宽驱动 → θ3 ≈ 4°，同一个捕获圈
  bs2.placeAt({ lon: A.lon, lat: A.lat })
  bs2.placeAt({ lon: c1.lon, lat: c1.lat })
  const [ga, gb] = bs2.beams.value
  const ae0 = dirToAzEl(LEO30.lon, LEO30.lat, LEO30.altKm, ga.lon, ga.lat), aeC = dirToAzEl(LEO30.lon, LEO30.lat, LEO30.altKm, +c1.lon.toFixed(4), +c1.lat.toFixed(4))
  const r = (ga.thX + ga.thY) / 4
  const sw = snapTangentAzEl([aeC.az, aeC.el], [{ az: ae0.az, el: ae0.el, r }], r, 1.6, null)
  const gw = llOfAzEl(LEO30, sw.az, sw.el)
  ok('多馈源相切吸附仍是 az/el 平面（逐位相同）', r > 1.9 && sw.snapped === 1 && gb.lon === +gw.lon.toFixed(4) && gb.lat === +gw.lat.toFixed(4), `r=${r}`)
}

// ================= ⑩ 关联星无星历：提示说真话 =================
{
  const env = makeEnv({ polys: [{ id: 'P3', pts: polyAround(LEO30, 40, 3, 3) }] })
  env.pos = LEO30
  const { bs, alerts } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.placeAt({ lon: 30, lat: 30 }); bs.placeAt({ lon: 32, lat: 31 })
  bs.p.polyId = 'P3'
  env.noEph = true
  const n0 = alerts.length
  bs.hexFill(); bs.assignFreqPlan()
  ok('关联星无星历：蜂窝布满 / 频率配色报「关联卫星当前无星历」', alerts.slice(n0).join('|') === '关联卫星当前无星历|关联卫星当前无星历', alerts.slice(n0).join('|'))
  ok('… 什么都不动', bs.beams.value.length === 2 && bs.beams.value.every((b) => b.fc == null))
  env.noEph = false
  bs.setSat('')
  const n1 = alerts.length
  bs.hexFill(); bs.assignFreqPlan()
  ok('真没选卫星：仍是「请先选择卫星」', alerts.slice(n1).join('|') === '请先选择卫星|请先选择卫星', alerts.slice(n1).join('|'))
}

// ================= ⑪ 自动同步：无星历重试 / 状态行 =================
{
  const env = makeEnv()
  const { bs, calls, alerts } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.placeAt({ lon: 105, lat: 20 }); bs.placeAt({ lon: 110, lat: 22 })
  await bs.generate()
  await settle(20)
  const s = bs.curSetting.value, nA = alerts.length
  // 别的动作刚写下的回执：静默同步不冲掉
  bs.status.value = '已清除频率配色'
  bs.setStkModel(syncModel({ ...s, D: 1.2 }))
  await settle(220)
  ok('静默同步：状态行上别的回执不被冲掉', calls.update.length === 1 && bs.status.value === '已清除频率配色', bs.status.value)
  // 关联星无星历：跳过、报一句；星历回来自己补
  env.noEph = true
  bs.setStkModel(syncModel({ ...s, D: 1.5 }))
  await settle(300)
  ok('关联星无星历：不同步，激活组状态行 = 关联卫星当前无星历，不弹窗', calls.update.length === 1 && bs.status.value === '关联卫星当前无星历' && alerts.length === nA, bs.status.value)
  env.noEph = false
  await settle(1300)
  const th = solveStk(s).th3Deg
  ok('星历回来 → 自己补同步（不靠别的改动），记录 θ3 = 新模型', calls.update.length === 2 && Math.abs(calls.update[1].record.beams[0].th3 - th) < 1e-12, String(calls.update.length))
  ok('… 状态行由失败换成本组读数', bs.status.value === `已更新天线「高斯波束」：2 个波束 · 波束宽 ${+th.toFixed(3)}° · 峰值 ${+solveStk(s).g0Dbi.toFixed(2)} dBi`, bs.status.value)
  // 静默失败（没有波束）：报到状态行，天线不动；撤销回到已同步状态 → 失败那句撤掉
  bs.clearBeams()
  await settle(220)
  ok('静默失败（没有波束）：激活组状态行一句、不弹窗、天线不动', /^组「高斯波束」还没有波束/.test(bs.status.value) && calls.update.length === 2 && alerts.length === nA, bs.status.value)
  bs.undo()
  await settle(220)
  ok('撤销 → 与天线重新一致：不重写，失败那句撤掉', calls.update.length === 2 && bs.status.value === '', JSON.stringify(bs.status.value))
  // 非激活组的失败不抢状态行；切回它时再报
  const gA = bs.activeGroupId.value
  bs.addGroup('stk')
  bs.status.value = '已清除频率配色'
  const gObj = bs.groups.value.find((g) => g.id === gA)
  gObj.beams.splice(0, gObj.beams.length)                           // gA（非激活）没了波束
  bs.placeAt({ lon: 120, lat: 10 })                                 // 激活组的改动触发一轮同步（gA 签名已变 → 静默失败）
  await settle(220)
  ok('非激活组的静默失败不抢状态行', bs.status.value === '已清除频率配色' && calls.update.length === 2, bs.status.value)
  bs.selectGroup(gA)
  await settle(220)
  ok('… 切回该组 → 失败报在状态行', /^组「高斯波束」还没有波束/.test(bs.status.value) && calls.update.length === 2 && alerts.length === nA, bs.status.value)
}

// ================= ⑫ 覆盖树改天线名：组跟着改，链接不断；组名不撞非合成天线 =================
{
  const env = makeEnv()
  const { bs, calls, grd } = env
  const gid = bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.placeAt({ lon: 105, lat: 20 }); bs.placeAt({ lon: 110, lat: 22 })
  await bs.generate()
  await settle(20)
  const nU = calls.update.length
  grd.renameAntenna('sat1', '高斯波束', 'Ku点波束')
  await settle(220)
  const g = bs.curGroup.value
  ok('树上改天线名 → 组名 / _genName 跟着改，按钮仍是「更新」', g.name === 'Ku点波束' && g._genName === 'Ku点波束' && bs.curName.value === 'Ku点波束' && bs.genAntExists.value === true, g.name)
  ok('… 已同步的组只换基线：不重写天线、不改回旧名', calls.update.length === nU && calls.rename.length === 1)
  bs.tblUpdate(bs.beams.value[0].id, { lon: 106 })
  await settle(220)
  ok('… 之后的改动照常同步到改过名的那副', calls.update.length === nU + 1 && calls.update[nU].key === 'sat1|Ku点波束' && calls.create.length === 1)
  await bs.generate()
  ok('… 再点生成 = 更新它，不造第二副', calls.create.length === 1 && grd.sats.value[1].antennas.map((a) => a.name).join(',') === 'Ku点波束')
  bs.tblUpdate(bs.beams.value[0].id, { lon: 107 })
  grd.renameAntenna('sat1', 'Ku点波束', 'Ka点波束')                 // 改动还没同步就改名
  await settle(220)
  const last = calls.update[calls.update.length - 1]
  ok('未同步改动 + 改名：改动同步到新名那副、天线不被改回去', last.key === 'sat1|Ka点波束' && maxGroundErr(GEO, last.record, [[107, 20], [110, 22]]) < 1e-6 && calls.rename.length === 2 && bs.curGroup.value.name === 'Ka点波束')
  await settle(20)
  const sg = JSON.parse(store['globe3d/beamSynth']).groups.find((x) => x.id === gid)
  ok('… 落盘：组名 / _genName 是新名', sg.name === 'Ka点波束' && sg._genName === 'Ka点波束')
  // 组名不许撞同星的非合成天线
  grd.sats.value[1].antennas.push({ name: 'Ku', imported: true, synth: false })
  bs.renameGroup(gid, 'Ku')
  ok('组名撞同星的非合成天线 → 自动加序号', bs.curGroup.value.name === 'Ku 2' && bs.curName.value === 'Ku 2', bs.curName.value)
  await settle(220)
  ok('… 于是同步照常：天线跟着改名为「Ku 2」', grd.sats.value[1].antennas.some((a) => a.name === 'Ku 2' && a.analytic) && bs.curGroup.value._genName === 'Ku 2' && grd.sats.value[1].antennas.some((a) => a.name === 'Ku' && !a.synth))
  grd.sats.value[1].antennas.push({ name: '高斯波束', imported: true, synth: false })
  bs.addGroup('stk')
  ok('新建组的默认名也避开非合成天线', bs.curName.value === '高斯波束 2', bs.curName.value)
}

// ================= ⑬ 全球 / 宽波束：草图画临边圈 =================
{
  const env = makeEnv()
  const { bs } = env
  bs.addGroup('stk')
  bs.p.snapTangent = false
  bs.setStkModel(syncModel({ ...bs.curSetting.value, drv: 'bw', bw3: 20 }))
  bs.placeAt({ lon: 110, lat: 0 })
  bs.beams.value[0].fc = 0
  bs.openFor('sat1')
  const spec = bs.sketchSpec()
  ok('GEO θ3 = 20°（锥包住整个地球盘）：草图照画一圈并填充', !!spec && spec.lines.length === 1 && spec.fills.length === 1)
  const S = geodeticToEcef(GEO.lon, GEO.lat, GEO.altKm), Aa = 6378.137, Bb = 6356.752314245
  const grazeDeg = (q) => {                                         // 星 → 该点视线与该点椭球法向的夹角偏离 90° 的量
    const P = geodeticToEcef(q[0], q[1], 0), v = [P[0] - S[0], P[1] - S[1], P[2] - S[2]], n = [P[0] / (Aa * Aa), P[1] / (Aa * Aa), P[2] / (Bb * Bb)]
    return Math.abs(Math.asin((v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / (Math.hypot(...v) * Math.hypot(...n)))) * 180 / Math.PI
  }
  const worst = spec ? Math.max(...spec.lines[0].p.map(grazeDeg)) : Infinity
  ok('… 那一圈就是临边（视线切于椭球）', worst < 1e-6, worst.toExponential(2) + '°')
  bs.setStkModel(syncModel({ ...bs.curSetting.value, bw3: 17 }))
  const spec2 = bs.sketchSpec()
  ok('θ3 = 17°：锥与地球相交，照旧画交线（不是临边）', !!spec2 && spec2.lines.length === 1 && Math.max(...spec2.lines[0].p.map(grazeDeg)) > 1)
}

// ================= ⑭ 宿主卸载 / 重挂：死实例不再同步落盘；重挂后补同步 =================
{
  const ANT = { name: '高斯波束', imported: true, analytic: true, synth: true }
  const recTh3 = (env) => env.recs.get('sat1|高斯波束').beams[0].th3
  const modelTh3 = (env) => solveStk(env.bs.groups.value.find((g) => g.mode === 'stk').settings[0]).th3Deg
  // 实例 1（页面卸载前）：生成后关联星无星历时改了口径 → 签名留旧、退避重试已排上
  const scope1 = effectScope()
  const env1 = scope1.run(() => makeEnv())
  const b1 = env1.bs
  b1.addGroup('stk'); b1.p.snapTangent = false
  b1.placeAt({ lon: 105, lat: 20 }); b1.placeAt({ lon: 110, lat: 22 })
  await b1.generate(); await settle(20)
  env1.noEph = true
  b1.setStkModel(syncModel({ ...b1.curSetting.value, D: 1.5 }))
  await settle(300)
  ok('前提：无星历 → 未同步、状态行报一句', env1.calls.update.length === 0 && b1.status.value === '关联卫星当前无星历', b1.status.value)
  const saved = JSON.stringify(store), savedRecs = [...env1.recs]
  const staleTh3 = recTh3(env1)
  scope1.stop()                                                     // 页面按 key 重挂（切 MSAA）：旧实例的作用域停掉
  // 实例 2（重挂后的新页面，覆盖树已装好、星历就绪）：上回的改动自己补上
  const env2 = makeEnv({ keepStore: true, ants: [ANT], recs0: savedRecs })
  await settle(260)
  ok('重挂（树已装好）→ 自己补同步一次，记录 θ3 = 当前模型', env2.calls.update.length === 1 && Math.abs(recTh3(env2) - modelTh3(env2)) < 1e-12 && Math.abs(staleTh3 - modelTh3(env2)) > 0.1,
    `updates ${env2.calls.update.length} · 记录 ${recTh3(env2).toFixed(4)}° · 模型 ${modelTh3(env2).toFixed(4)}°`)
  env2.bs.addGroup('gauss')
  env2.bs.renameGroup(env2.bs.activeGroupId.value, 'NEW-WORK')      // 新实例里的新工作
  await settle(50)
  env1.noEph = false                                                // 死实例那头星位回来了
  await settle(1400)
  const names = JSON.parse(store['globe3d/beamSynth']).groups.map((g) => g.name)
  ok('卸载后死实例不再同步（退避定时器已清）', env1.calls.update.length === 0 && env1.calls.create.length === 1 && env1.calls.rename.length === 0, `updates ${env1.calls.update.length} · creates ${env1.calls.create.length}`)
  ok('… 也不拿旧组表覆盖落盘：新实例的组还在', names.includes('NEW-WORK') && names.length === 2, names.join(','))
  // 实例 3（重启，覆盖树后装入：restoreState 往已有星节点 push 天线，不换 sats 数组）
  store = JSON.parse(saved)
  const env3 = makeEnv({ keepStore: true, recs0: savedRecs })
  await settle(260)
  ok('重启、树还没装入：不动', env3.calls.update.length === 0 && env3.calls.create.length === 0)
  env3.grd.sats.value[1].antennas.push({ ...ANT })
  await settle(260)
  ok('树后装入（push 进已有节点）→ 补同步一次', env3.calls.update.length === 1 && Math.abs(recTh3(env3) - modelTh3(env3)) < 1e-12, `updates ${env3.calls.update.length}`)
  // 实例 4（重启，树已装好、星池还在载入）：退避重试等到星历回来
  store = JSON.parse(saved)
  const env4 = makeEnv({ keepStore: true, ants: [ANT], recs0: savedRecs })
  env4.noEph = true
  await settle(400)
  ok('重启、星历还在载入：不同步', env4.calls.update.length === 0)
  env4.noEph = false
  await settle(1300)
  ok('… 星历回来 → 退避重试补上', env4.calls.update.length === 1 && Math.abs(recTh3(env4) - modelTh3(env4)) < 1e-12, `updates ${env4.calls.update.length}`)
  // 签名一致的组：重挂不重写
  const env5 = makeEnv({ keepStore: true, ants: [ANT], recs0: [...env4.recs] })
  await settle(260)
  ok('签名一致：重挂不重写天线', env5.calls.update.length === 0 && env5.calls.create.length === 0)
}

// ================= ⑮ 树上改天线名撞同星另一组的组名：撤回 + 告警；清同星别组的过期 _genName =================
{
  const names = (env) => env.grd.sats.value[1].antennas.map((a) => a.name).join(',')
  const cases = [['stk', 'stk'], ['gauss', 'gauss'], ['gauss', 'stk'], ['stk', 'gauss']]
  for (const [ma, mb] of cases) {
    const env = makeEnv()
    const { bs, grd, calls, alerts } = env
    const gA = bs.addGroup(ma); bs.p.snapTangent = false
    bs.placeAt({ lon: 105, lat: 20 })
    await bs.generate(); await settle(20)
    const A = () => bs.groups.value.find((g) => g.id === gA)
    const n0 = A()._genName
    const gB = bs.addGroup(mb); bs.p.snapTangent = false
    bs.renameGroup(gB, 'Ku')                                        // B 还没生成：树上没有叫 Ku 的天线
    bs.placeAt({ lon: 115, lat: 25 }); bs.placeAt({ lon: 118, lat: 25 })
    const B = () => bs.groups.value.find((g) => g.id === gB)
    bs.selectGroup(gA); await settle(20)
    const nA = alerts.length
    const accepted = grd.renameAntenna('sat1', n0, 'Ku')            // 树的校验只看天线 → 放行
    await settle(300)
    ok(`[${ma}/${mb}] 改成另一组的组名 → 撤回、告警一句`, accepted && names(env) === n0 && alerts.slice(nA).join('|') === '「Ku」与同星另一波束组重名', `${names(env)} · ${alerts.slice(nA).join('|')}`)
    ok(`[${ma}/${mb}] … 两组名字 / _genName 都没动`, A().name === n0 && A()._genName === n0 && B().name === 'Ku' && !B()._genName && bs.curName.value === n0, `A ${A().name}/${A()._genName} · B ${B().name}`)
    ok(`[${ma}/${mb}] … 不被再改成「Ku 2」`, !calls.rename.some((r) => r.n === 'Ku 2') && calls.create.length === (ma === 'stk' ? 1 : 0))
    bs.selectGroup(gB); await settle(10)
    await bs.generate(); await settle(220)
    bs.selectGroup(gA); await settle(10)
    await bs.generate(); await settle(220)
    const alive = (g) => grd.sats.value[1].antennas.some((a) => a.name === g._genName)
    ok(`[${ma}/${mb}] … 之后两组各自生成：各守各的天线，谁也不删谁`, A()._genName === n0 && B()._genName === 'Ku' && alive(A()) && alive(B()) && grd.sats.value[1].antennas.length === 2, names(env))
  }
  // 同星别组攥着的过期 _genName（它那副已被删）：别组的天线改成这个名后被清掉，不再被当成自己的孤儿删掉
  const env = makeEnv()
  const { bs, grd } = env
  const g1 = bs.addGroup('gauss'); bs.p.snapTangent = false
  bs.placeAt({ lon: 105, lat: 20 })
  await bs.generate(); await settle(20)
  const G1 = () => bs.groups.value.find((g) => g.id === g1)
  const n1 = G1()._genName
  bs.renameGroup(g1, 'W')                                           // 多馈源组改名不自动同步：_genName 还指着旧名
  grd.removeAntenna('sat1', n1)                                     // 旧名那副在树上删了
  const s1 = bs.addGroup('stk'); bs.p.snapTangent = false
  bs.placeAt({ lon: 110, lat: 22 })
  await bs.generate(); await settle(220)
  const S1 = () => bs.groups.value.find((g) => g.id === s1)
  grd.renameAntenna('sat1', S1()._genName, n1)                     // 高斯组的天线改成那个旧名
  await settle(300)
  ok('过期 _genName：高斯组改名照常，别组的过期指针被清掉', S1().name === n1 && S1()._genName === n1 && !G1()._genName, `S1 ${S1().name} · G1 ${G1()._genName}`)
  bs.selectGroup(g1); await settle(10)
  await bs.generate(); await settle(220)
  ok('… 多馈源组再生成不把高斯组的天线当孤儿删掉', grd.sats.value[1].antennas.some((a) => a.name === n1 && a.analytic) && grd.sats.value[1].antennas.some((a) => a.name === 'W'), names(env))
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
