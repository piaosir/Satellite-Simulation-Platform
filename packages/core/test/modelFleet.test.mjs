// 星座精模（packages/core/models/fleet）的回归网。
//
//   ① 注册表：FLEET_IDS 与 match.mjs 的 FLEET_MATCH_IDS 同集；id 都过 schema 的 param: 规则；目录条目与注册表一一对应
//   ② 每型都能生成：IR 合法、几何全有限、整星质量 = 型号定义的出处质量、挂点名唯一、太阳翼关节的电池片节点都在太阳翼组里、
//      三角形 ≤ 60k / 节点 ≤ 70（3D 页一次画 32 颗图标）、两次生成几何签名逐位相同（缩略图缓存靠它）
//   ③ 有出处的外形尺寸对得上（翼展 / 本体）：GPS IIR 11.42 m、IIF 17.5 m、III 15 m、伽利略 FOC 14.67 m、IOV 14.5 m、铱星 9.4 m、
//      O3b 7.72 m、格洛纳斯-K1 9.205 m、星链 v1.x 翼长 8.1 m、V2 Mini 翼展落在 FCC 下限 28.3 m 与图像估计 ≈33 m 之间
//   ④ 导航星按官方质心偏置落位的型号（北斗 / 伽利略 / 格洛纳斯）整星质心在原点
//   ⑤ 随包星历快照里各星座组的每一颗星都匹配到精模（不落到默认卫星 / 平板 LEO），分型颗数与研究结论一致

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { FLEET, FLEET_IDS, buildFleetModel, fleetCatalog, fleetSig, isFleetId } from '../models/fleet/index.mjs'
import { FLEET_MATCH_IDS } from '../models/fleet/match.mjs'
import { match } from '../models/autoMatch.mjs'
import { validateIR } from '../models/ir.mjs'
import { isValidModelId } from '../models/schema.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a.toFixed(3)} ≠ ${b}（±${tol}）`)

t('① 注册表 / 匹配表 / 目录一致，id 合法', () => {
  assert.deepStrictEqual([...FLEET_IDS].sort(), [...FLEET_MATCH_IDS].sort())
  const cat = fleetCatalog()
  assert.deepStrictEqual(cat.map((c) => c.id), FLEET_IDS.map((id) => `param:${id}`))
  for (const c of cat) {
    assert.ok(isValidModelId(c.id), `id 格式 ${c.id}`)
    assert.ok(isFleetId(c.id) && isFleetId(c.templateId))
    assert.equal(c.source.kind, 'param')
    assert.ok(c.source.url.startsWith('http'), `${c.id} 缺出处`)
  }
  assert.ok(!isFleetId('param:default-sat') && !isFleetId('nasa:tdrs') && !isFleetId(null))
})

const built = new Map()
t('② 每型都能生成、几何合法、质量对账、挂点唯一、太阳翼组完整、规模受控、确定性', () => {
  for (const id of FLEET_IDS) {
    const r = buildFleetModel(id)
    built.set(id, r)
    const v = validateIR(r.ir)
    assert.ok(v.ok, `${id} IR：${v.errors && v.errors.slice(0, 3).join('；')}`)
    const target = FLEET[id].massKg.value
    near(r.massProps.massKg, target, 1e-6, `${id} 整星质量`)
    const aps = r.attachPoints.map((a) => a.name)
    assert.equal(new Set(aps).size, aps.length, `${id} 挂点重名`)
    const cells = new Set(r.solarPanelGroups.flatMap((g) => g.nodes))
    const wings = r.articulations.filter((a) => /wing/.test(a.name))
    assert.ok(wings.length >= 1, `${id} 没有太阳翼关节`)
    for (const a of wings) assert.ok(a.nodes.some((nd) => cells.has(nd)), `${id} ${a.name} 关节里没有电池片节点（3D 页不会自动对日）`)
    const tris = r.ir.meshes.reduce((s, m) => s + m.index.length / 3, 0)
    assert.ok(tris <= 60000, `${id} 三角形 ${tris}`)
    assert.ok(r.ir.nodes.length <= 70, `${id} 节点 ${r.ir.nodes.length}`)
    assert.equal(fleetSig(buildFleetModel(id)), fleetSig(r), `${id} 两次生成签名不同`)
    assert.equal(r.spec.kind, 'fleet')
  }
})

const span = (id, k = 1) => { const b = built.get(id).bboxBody; return b.max[k] - b.min[k] }
t('③ 有出处的外形尺寸', () => {
  near(span('gps-iir'), 11.42, 0.03, 'GPS IIR 翼展（Adhya 2005 图 5.3）')
  near(span('gps-iif'), 17.5, 0.1, 'GPS IIF 翼展（DLR 2020 表 1）')
  near(span('gps-iii'), 15.0, 0.1, 'GPS III 翼展（DLR 2020 表 1）')
  near(span('galileo-foc'), 14.67, 0.1, '伽利略 FOC 翼展（ESA）')
  near(span('galileo-iov'), 14.5, 0.1, '伽利略 IOV 翼展（ESA）')
  near(span('iridium-next'), 9.4, 0.1, '铱星二代翼展（铱星官方）')
  near(span('o3b-gen1'), 7.72, 0.05, 'O3b 第一代（Arianespace VS22）')
  near(span('glonass-k1'), 9.205, 0.05, '格洛纳斯-K1（Reshetnev 图 4）')
  const v2 = span('starlink-v2mini')
  assert.ok(v2 >= 28.3 && v2 <= 34, `星链 V2 Mini 翼展 ${v2.toFixed(2)}`)
  assert.ok(span('starlink-v1', 2) > 8.1, '星链 v1.0 鲨鱼鳍翼长 8.1 m（竖向包围盒应超过它）')
  near(span('starlink-v2mini', 0), 4.1 + 0.2, 0.25, '星链 V2 Mini 本体长 4.1 m（含两端推力器 / 天线）')
})

t('④ 按官方质心偏置落位的导航星：整星质心在原点', () => {
  for (const id of FLEET_IDS) {
    if (!Array.isArray(FLEET[id].comTarget)) continue
    const c = built.get(id).massProps.comBody
    assert.ok(Math.hypot(...c) < 1e-6, `${id} 质心 ${c.map((x) => x.toFixed(4)).join(',')}`)
  }
})

t('⑤ 随包星历快照：各星座组每颗星都配到精模，分型颗数对得上', () => {
  const dir = fileURLToPath(new URL('../../../resources/omm/', import.meta.url))
  const tally = {}
  for (const grp of ['starlink', 'oneweb', 'kuiper', 'gps', 'beidou', 'galileo', 'glonass', 'iridium', 'globalstar', 'o3b']) {
    let rows
    try { rows = gunzipSync(readFileSync(dir + `csv_${grp}.csv.gz`)).toString('utf8').split(/\r?\n/).slice(1).filter(Boolean) } catch { console.log(`  （无快照 csv_${grp}，跳过）`); continue }
    for (const line of rows) {
      const c = line.split(',')
      const r = match({ name: c[0], noradId: Number(c[11]), orbitKind: '', group: grp })
      assert.ok(r.id && isFleetId(r.id), `${grp} ${c[0]} → ${r.id}（${r.rule}）`)
      tally[r.id] = (tally[r.id] || 0) + 1
    }
  }
  // 研究结论：v1.0 无遮阳板批次（NORAD < 45720）128 颗；北斗三号五院 MEO 带搜救载荷 4 颗、微小卫星院 B 型 4 颗；格洛纳斯-K2 2 颗
  if (tally['param:starlink-v1']) assert.equal(tally['param:starlink-v1'], 128)
  if (tally['param:beidou3-meo-cast-sar']) assert.equal(tally['param:beidou3-meo-cast-sar'], 4)
  if (tally['param:beidou3-meo-secm-b']) assert.equal(tally['param:beidou3-meo-secm-b'], 4)
  if (tally['param:glonass-k2']) assert.equal(tally['param:glonass-k2'], 2)
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k.slice(6)}×${v}`).join('  '))
})

console.log(`modelFleet: ${n} 项通过`)
