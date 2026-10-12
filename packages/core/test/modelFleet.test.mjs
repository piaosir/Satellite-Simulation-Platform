// 星座精模（packages/core/models/fleet）的回归网。
//
//   ① 注册表：FLEET_IDS 与 match.mjs 的 FLEET_MATCH_IDS 同集；id 都过 schema 的 param: 规则；目录条目与注册表一一对应
//   ② 每型都能生成：IR 合法、几何全有限、整星质量 = 型号定义的出处质量、挂点名唯一、太阳翼关节的电池片节点都在太阳翼组里、
//      三角形 ≤ 60k / 节点 ≤ 70（3D 页一次画 32 颗图标）、两次生成几何签名逐位相同（缩略图缓存靠它）
//   ③ 有出处的外形尺寸对得上（翼展 / 本体）：GPS IIR 11.42 m、IIF 17.5 m、III 15 m、伽利略 FOC 14.67 m、IOV 14.5 m、铱星 9.4 m、
//      O3b 7.72 m、格洛纳斯-K1 9.205 m、星链 v1.x 翼长 8.1 m、V2 Mini 翼展落在 FCC 下限 28.3 m 与图像估计 ≈33 m 之间
//   ④ 导航星按官方质心偏置落位的型号（北斗 / 伽利略 / 格洛纳斯）整星质心在原点
//   ⑤ 随包星历快照里各星座组的每一颗星都匹配到精模（不落到默认卫星 / 平板 LEO），分型与研究结论逐颗一致
//      （研究结论按每颗星的永久身份写、期望集合从快照现取，不写死颗数——快照每次 omm:snapshot 都在变）
//   ⑥ GEO 快照里国内具体星（中星 / 亚太 / 天链 / 天通 / 风云……）一颗都不配精模（北斗星座除外）——用户口径：GEO 精模不涉及国内

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
    if (FLEET[id].bodyCells) {
      // 自旋稳定圆柱星：体装电池、无太阳翼关节（3D 页对日跳过它）
      assert.ok(wings.length === 0 && r.solarPanelGroups.some((g) => g.nodes.length > 0), `${id} 体装电池型应有电池组、无太阳翼关节`)
    } else {
      assert.ok(wings.length >= 1, `${id} 没有太阳翼关节`)
      for (const a of wings) assert.ok(a.nodes.some((nd) => cells.has(nd)), `${id} ${a.name} 关节里没有电池片节点（3D 页不会自动对日）`)
    }
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

t('⑤ 随包星历快照：各星座组每颗星都配到精模，分型与研究结论逐颗对得上', () => {
  const dir = fileURLToPath(new URL('../../../resources/omm/', import.meta.url))
  const tally = {}
  const sats = []
  for (const grp of ['starlink', 'oneweb', 'kuiper', 'gps', 'beidou', 'galileo', 'glonass', 'iridium', 'globalstar', 'o3b']) {
    let rows
    try { rows = gunzipSync(readFileSync(dir + `csv_${grp}.csv.gz`)).toString('utf8').split(/\r?\n/).filter(Boolean) } catch { console.log(`  （无快照 csv_${grp}，跳过）`); continue }
    const col = Object.fromEntries((rows.shift() || '').split(',').map((h, i) => [h, i]))
    assert.ok(['OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID'].every((h) => h in col), `csv_${grp} 表头缺列`)
    for (const line of rows) {
      const c = line.split(',')
      const s = { grp, name: c[col.OBJECT_NAME], cospar: c[col.OBJECT_ID], norad: Number(c[col.NORAD_CAT_ID]) }
      const r = match({ name: s.name, noradId: s.norad, orbitKind: '', group: grp })
      assert.ok(r.id && isFleetId(r.id), `${grp} ${s.name} → ${r.id}（${r.rule}）`)
      tally[r.id] = (tally[r.id] || 0) + 1
      sats.push({ ...s, id: r.id })
    }
  }
  // 研究结论（星座精模调研稿 2026-09，出处见 match.mjs）按每颗星【永久不变的身份】写，期望集合从本版快照现取、与匹配结果逐颗比对。
  // ★ 不写死颗数：在轨颗数随离轨 / 退役 / 新发射逐版在变（星链 v1.0 无遮阳板 09-10 版 131 → 09-22 版 128 → 10-08 版 120），
  //   写死就是拟合某一版快照。身份尽量取与匹配规则不同的字段，逐颗比对才是交叉核验：
  //   星链 v1.0 无遮阳板 = OBJECT_ID 发射号 2019-074 … 2020-035（VisorSat 自 2020-038 即 v1.0 L8 起；匹配规则拿 NORAD < 45720 作代理）；
  //     该段里的 VisorSat 原型 STARLINK-1436 已于 2024-06 再入，不会再出现
  //   北斗三号 MEO 五院带搜救载荷 = M13 / M14 / M23 / M24、微小卫星院 B 型 = M21 / M22 / M25 / M27（按名称里的 M 序号；匹配规则 NORAD 表优先）
  //   格洛纳斯-K2 = 703K / 704K（IAC 2026-09-24 星座表）
  const launch = (s) => (s.cospar || '').slice(0, 8)   // '2019-074B' → '2019-074'
  const bdM = (s) => Number((/^BEIDOU-3 M(\d+)\b/.exec(s.name) || [])[1])
  const RESEARCH = {
    'starlink-v1': (s) => s.grp === 'starlink' && /^\d{4}-\d{3}$/.test(launch(s)) && launch(s) >= '2019-074' && launch(s) <= '2020-035',
    'beidou3-meo-cast-sar': (s) => s.grp === 'beidou' && [13, 14, 23, 24].includes(bdM(s)),
    'beidou3-meo-secm-b': (s) => s.grp === 'beidou' && [21, 22, 25, 27].includes(bdM(s)),
    'glonass-k2': (s) => s.grp === 'glonass' && /\((703|704)K\)$/.test(s.name)
  }
  const key = (s) => `${s.name}（${s.norad}）`
  for (const [model, isIt] of Object.entries(RESEARCH)) {
    const want = new Set(sats.filter(isIt).map(key))
    const got = new Set(sats.filter((s) => s.id === `param:${model}`).map(key))
    const miss = [...want].filter((k) => !got.has(k)), extra = [...got].filter((k) => !want.has(k))
    assert.ok(!miss.length && !extra.length,
      `${model}：研究结论 ${want.size} 颗、匹配 ${got.size} 颗；漏配 ${miss.length}【${miss.slice(0, 6).join('、')}】、多配 ${extra.length}【${extra.slice(0, 6).join('、')}】`)
  }
  console.log('  ' + Object.entries(tally).map(([k, v]) => `${k.slice(6)}×${v}`).join('  '))
})

t('⑥ GEO 快照：国内具体星不配精模（北斗星座除外；2026-10-07 用户「不要涉及国内」）', () => {
  const dir = fileURLToPath(new URL('../../../resources/omm/', import.meta.url))
  let rows
  try { rows = gunzipSync(readFileSync(dir + 'csv_geo.csv.gz')).toString('utf8').split(/\r?\n/).slice(1).filter(Boolean) } catch { console.log('  （无快照 csv_geo，跳过）'); return }
  const CN = /^(ZHONGXING|CHINASAT|APSTAR|TIANLIAN|TIANTONG|FENGYUN|GAOFEN|SHIJIAN|SHIYAN|TJS|HULIANWAN|YAOGAN|LUDI TANCE)\b/
  let cn = 0
  for (const line of rows) {
    const c = line.split(',')
    if (!CN.test(c[0])) continue
    cn++
    const r = match({ name: c[0], noradId: Number(c[11]), orbitKind: 'GEO', group: 'geo' })
    assert.ok(!isFleetId(r.id), `${c[0]} 不该配到精模（→ ${r.id}，${r.rule}）`)
  }
  assert.ok(cn > 50, `快照里的国内 GEO 星只认出 ${cn} 颗（名称规律变了？）`)
})

console.log(`modelFleet: ${n} 项通过`)
