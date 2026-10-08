// 天线树轨道根数星的历元口径（src/shared/treeOrbitEpoch.js）+ 场景时刻跨窗口镜像（src/shared/sceneClock.js）。
// 运行：node packages/core/test/treeOrbitEpoch.test.mjs
//   ① normEpoch：带 Z / 不带时区（按 UTC）/ ±hh:mm 偏移 / 毫秒数 → 规范 ISO；空 / 非法 → null
//   ② treeOrbitEpoch：节点自己的历元优先；没有 / 解不出 → 固定常量（不取「此刻」：取此刻就成了每个窗口各一个）
//   ③ withTreeEpoch / needsTreeEpoch：规范的原样返回同一个对象（缓存签名不翻），旧数据补常量
//   ④ 同一份根数 + 同一个历元：渲染端 elementsOmm→omm2satrec 与主进程 buildSatrec(treeElementsSpec) 建出的 satrec 逐位一致；
//      同一绝对时刻两边位置逐位一致（全软件一条时间线）
//   ⑤ orbitSpecWithEpoch：库条目旧 spec（epoch:null）补历元；有历元 / 非 elements 原样
//   ⑥ sceneClock：记录 → 场景时刻（实时＝系统钟、播放按 wallMs 外推、暂停钉住、坏记录 null）
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import sat from '../../../src/viz/constellation/satellite.js'
import { normEpoch, treeOrbitEpoch, withTreeEpoch, needsTreeEpoch, elementsOmm, treeElementsSpec, orbitSpecWithEpoch, TREE_ORBIT_LEGACY_EPOCH } from '../../../src/shared/treeOrbitEpoch.js'
import { sceneClockRecord, sceneNowFrom } from '../../../src/shared/sceneClock.js'

const require = createRequire(import.meta.url)
const { buildSatrec } = require('../utils/ngsoGeometry.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }

// ① normEpoch
ok(normEpoch('2026-10-06T02:30:00Z') === '2026-10-06T02:30:00.000Z', 'normEpoch：带 Z')
ok(normEpoch('2026-10-06T02:30:00') === '2026-10-06T02:30:00.000Z', 'normEpoch：不带时区按 UTC（同 omm2satrec）')
ok(normEpoch('2026-10-06T10:30:00+08:00') === '2026-10-06T02:30:00.000Z', 'normEpoch：±hh:mm 偏移换算到 UTC')
ok(normEpoch(Date.UTC(2026, 9, 6, 2, 30)) === '2026-10-06T02:30:00.000Z', 'normEpoch：毫秒数')
ok(normEpoch('') === null && normEpoch(null) === null && normEpoch('abc') === null && normEpoch(undefined) === null, 'normEpoch：空 / 非法 → null')

// ② treeOrbitEpoch
const el = { altKm: 550, ecc: 0.001, incl: 53, raan: 120, argp: 30, ma: 45 }
ok(treeOrbitEpoch({ ...el, epoch: '2026-10-06T02:30:00' }) === '2026-10-06T02:30:00.000Z', 'treeOrbitEpoch：节点自己的历元（规范化）')
ok(treeOrbitEpoch(el) === TREE_ORBIT_LEGACY_EPOCH && treeOrbitEpoch({ ...el, epoch: 'x' }) === TREE_ORBIT_LEGACY_EPOCH && treeOrbitEpoch(null) === TREE_ORBIT_LEGACY_EPOCH, 'treeOrbitEpoch：没有 / 解不出 → 固定常量')
ok(normEpoch(TREE_ORBIT_LEGACY_EPOCH) === TREE_ORBIT_LEGACY_EPOCH, '旧数据常量本身是规范串')

// ③ withTreeEpoch / needsTreeEpoch
const good = { ...el, epoch: '2026-10-06T02:30:00.000Z' }
ok(withTreeEpoch(good) === good && !needsTreeEpoch(good), '已规范：原样返回同一个对象、不需迁移')
const legacy = { ...el }
const mig = withTreeEpoch(legacy)
ok(mig !== legacy && mig.epoch === TREE_ORBIT_LEGACY_EPOCH && legacy.epoch === undefined && needsTreeEpoch(legacy), '旧数据：返回新对象补常量，不改入参')
const loose = { ...el, epoch: '2026-10-06T02:30:00' }
ok(withTreeEpoch(loose).epoch === '2026-10-06T02:30:00.000Z' && needsTreeEpoch(loose), '不规范的串：规范化（算迁移）')
ok(withTreeEpoch(null) === null && !needsTreeEpoch(null), 'null 原样')

// ④ 渲染端与主进程逐位一致
const cases = [
  { ...el, epoch: '2026-10-06T02:30:00.000Z' },
  { altKm: 20200, ecc: 0.01, incl: 55, raan: 10, argp: 0, ma: 200, epoch: '2026-03-01T00:00:00.000Z' },   // MEO（深空 SDP4）
  { altKm: 35786, ecc: 0, incl: 0.05, raan: 0, argp: 0, ma: 100 }                                           // 无历元：两边都按常量
]
for (const c of cases) {
  const rR = sat.omm2satrec(elementsOmm(c, 'SIM'))
  const rC = buildSatrec(treeElementsSpec(c, 'SIM'))
  const same = ['jdsatepoch', 'jdsatepochF', 'no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo'].every((k) => rR[k] === rC[k])
  ok(!rR.error && !rC.error && same, `satrec 逐位一致：渲染端 elementsOmm ＝ 主进程 buildSatrec（altKm ${c.altKm}）`)
  const t = new Date('2026-10-06T08:00:00Z')
  const a = sat.propagate(rR, t).position, b = sat.propagate(rC, t).position
  ok(a.x === b.x && a.y === b.y && a.z === b.z, `同一绝对时刻位置逐位一致（altKm ${c.altKm}）`)
}
const e1 = sat.omm2satrec(elementsOmm({ ...el, epoch: '2026-10-06T00:00:00Z' }))
const e2 = sat.omm2satrec(elementsOmm({ ...el, epoch: '2026-10-06T01:00:00Z' }))
const t1 = new Date('2026-10-06T02:00:00Z')
const pa = sat.propagate(e1, t1).position, pb = sat.propagate(e2, t1).position
ok(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) > 100, '历元不同（各星可以不一致）：同一时刻位置确实不同')
ok(elementsOmm(el).noradId === 'SIM' && elementsOmm(el, 12).noradId === '12', 'elementsOmm：noradId 缺省 SIM、只影响编号')
const sp = treeElementsSpec({ ...el, epoch: '2026-10-06T02:30:00' }, null)
ok(sp.type === 'elements' && sp.epoch === '2026-10-06T02:30:00.000Z' && sp.altKm === 550 && sp.noradId === null, 'treeElementsSpec：带规范历元')

// ⑤ orbitSpecWithEpoch
const oldSpec = { type: 'elements', ...el, epoch: null }
const fixed = orbitSpecWithEpoch(oldSpec)
ok(fixed !== oldSpec && fixed.epoch === TREE_ORBIT_LEGACY_EPOCH && oldSpec.epoch === null, '旧库条目：补常量，不改入参')
ok(orbitSpecWithEpoch(oldSpec, '2026-10-06T02:30:00Z').epoch === '2026-10-06T02:30:00.000Z', '给了 fallback（树节点自己的历元）：用它')
const newSpec = { type: 'elements', ...el, epoch: '2026-10-06T02:30:00.000Z' }
ok(orbitSpecWithEpoch(newSpec) === newSpec, '已有规范历元：原样')
const omm = { type: 'omm', meanMotion: 15, epoch: null }
ok(orbitSpecWithEpoch(omm) === omm && orbitSpecWithEpoch(null) === null, '非 elements：原样')

// ⑥ sceneClock
const T = Date.UTC(2026, 0, 1, 0, 0), W = 1_000_000
ok(sceneNowFrom(sceneClockRecord({ tMs: T, mode: 'pause' }, W), W + 5000) === T, '暂停：钉在 tMs')
ok(sceneNowFrom(sceneClockRecord({ tMs: T, mode: 'play', rate: 600 }, W), W + 2000) === T + 1_200_000, '播放：按 wallMs 外推（600 倍速 2 s → 20 min）')
ok(sceneNowFrom(sceneClockRecord({ tMs: T, mode: 'play', rate: -60 }, W), W + 1000) === T - 60_000, '倒放：外推方向随 rate 符号')
ok(sceneNowFrom(sceneClockRecord({ tMs: T, mode: 'live' }, W), W + 7) === W + 7, '实时：系统钟')
ok(sceneClockRecord({ tMs: T, mode: 'weird' }, W).mode === 'pause' && sceneClockRecord({ tMs: T, mode: 'pause', rate: 5 }, W).rate === 0, '记录：非法模式按暂停、暂停的 rate 恒 0')
ok(sceneNowFrom(null, W) === null && sceneNowFrom({ v: 2, tMs: T }, W) === null && sceneNowFrom({ v: 1, tMs: NaN }, W) === null, '坏记录 → null（调用方退系统钟）')

// 源码钉：主窗口时钟写镜像；只有主窗口 import 时钟单例
const clk = readFileSync(new URL('../../../src/stores/simClock.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// import 行只钉「从 sceneClock 取了 writeSceneClock」：同一行后来又多取了 readSceneClock（bootSceneMs 开机回到镜像时刻）
ok(/import \{[^}]*\bwriteSceneClock\b[^}]*\} from '\.\.\/shared\/sceneClock\.js'/.test(clk) && /function publish\(force\)/.test(clk) && (clk.match(/publish\(true\)/g) || []).length >= 10, '时钟：控制动作立即写镜像（≥ 10 处）+ 走表节流写')
ok(/export function releaseClock\(\) \{[^}]*held = true; publish\(true\)/.test(clk), '时钟：宿主页卸载停表 → 镜像按暂停写（读的一侧不再外推）')
ok(/function publish\(force\) \{\n  if \(!mirror\) return/.test(clk) && clk.includes('export function initClockMirror() { mirror = true; publish(true) }') && !/^publish\(true\)$/m.test(clk), '时钟：只有显式开镜像才写（性能表弹窗顺 import 链带进本模块也不写），模块载入不写')
const app = readFileSync(new URL('../../../src/App.vue', import.meta.url), 'utf8')
ok(app.includes('initClockMirror()') && app.includes('initClockMirror } from \'./stores/simClock\''), '主窗口根组件开镜像')
const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8')
const cc = readFileSync(new URL('../../../src/viz/constellation/useCustomConstellations.js', import.meta.url), 'utf8')
ok(cc.includes('function refreshDayEpoch()') && page.includes('function checkDayEpoch() { if (customConst.refreshDayEpoch()) rebindSelection(\'\') }') && page.includes('dayEpochBeat = setInterval(checkDayEpoch, 60000)'), '3D 页跨零点重解场景历元（与别的窗口每次现解一致）')

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
