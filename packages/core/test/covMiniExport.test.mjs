// 覆盖快照 → 小程序「卫星覆盖」的目标卫星 / 名称 / 幂等键自测（src/shared/covMiniExport.js）。
//
// 守的不变式：
//   ① 目标星候选两段：内置那 24 颗逐项照抄镜像（顺序也不动），自定义段 = 画面里的非内置星 + 记住的星
//      +「手动指定…」，按名称归一去重，内置星不会在自定义段里再出现一次；
//   ② 每项带 vals（名称 / 轨位原文），切到手动指定时两格里是刚才那颗星；
//   ③ 默认选中：画面里的内置星优先，其次画面里的非内置星，都没有才取第一项；
//   ④ 手动指定：名称去首尾空白、轨位归一到 [-180, 180)（250 → -110，即 110°W）；
//   ⑤ 幂等键：没改过名的仍是老格式 'gxt:<星名>'（此前发过的那一份照旧被覆盖）；改了名则带上名称，
//      同一颗星下两份不同名的覆盖互不覆盖；名称同时写进快照本身（密钥导入那条路取 snap.name）；
//   ⑥ 不改入参快照（弹窗每敲一个字都会重攒一次，改了原件第二次就叠在第一次上）；
//   ⑦ 记住的自定义星：最近的在前、按名称归一去重、封顶，内置星与没有轨位的不记；坏数据逐条丢弃。
import { MINI_COVERAGE_SATS } from '../../../src/shared/miniSatList.js'
import { MANUAL, CUSTOM_MAX, normLon, targetOptions, defaultTarget, resolveTarget, covUnit, parseCustoms, rememberTarget } from '../../../src/shared/covMiniExport.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}
const J = (x) => JSON.stringify(x)

console.log('覆盖快照 → 小程序：目标卫星 / 名称 / 幂等键')

const G = { builtin: '内置', custom: '自定义' }
const beams = [
  { satName: 'MY SAT-1', lon: 120.5 },          // 画面里的非内置星
  { satName: 'my sat 1', lon: 120.5 },          // 同一颗（归一后同名）：不该出现两次
  { satName: 'CHINASAT 6D', lon: 125 },         // 画面里的内置星：只在内置段出现
  { satName: '', lon: 88 },                     // 无名：跳过
  { satName: 'NOLON', lon: null }               // 无轨位：照列，但不带轨位
]
const customs = [{ name: 'OLD-1', lon: -30 }, { name: 'MY-SAT 1', lon: 99 }, { name: 'apstar 6d', lon: 134 }]
const opts = targetOptions({ beams, customs, groups: G, manualLabel: '手动指定…' })

// ① 两段
const inb = opts.filter((o) => o.group === '内置')
ok('内置段逐项照抄镜像（含顺序）', J(inb.map((o) => o.value)) === J(MINI_COVERAGE_SATS.map((s) => s.name)))
ok('内置段排在前面', opts.slice(0, inb.length).every((o) => o.group === '内置'))
const cus = opts.filter((o) => o.group === '自定义')
ok('自定义段 = 画面非内置星 + 记住的星 + 手动指定', J(cus.map((o) => o.value)) === J(['MY SAT-1', 'NOLON', 'OLD-1', MANUAL]), J(cus.map((o) => o.value)))
ok('手动指定在最后', opts[opts.length - 1].value === MANUAL && opts[opts.length - 1].label === '手动指定…')
ok('轨位按 °E/°W 标注', cus[0].label === 'MY SAT-1（120.5°E）' && cus[2].label === 'OLD-1（30.0°W）', cus[0].label + ' / ' + cus[2].label)
ok('无轨位的不带括号', cus[1].label === 'NOLON' && cus[1].lon === null)
ok('选项取值互不重复', new Set(opts.map((o) => o.value)).size === opts.length)

// ② vals
ok('vals 带名称与轨位原文', J(cus[0].vals) === J({ satName: 'MY SAT-1', satLon: '120.5' }))
ok('无轨位的 vals 轨位为空串', cus[1].vals.satLon === '')
ok('手动指定那项不带 vals（两格保持刚才那颗）', !opts[opts.length - 1].vals)

// ③ 默认选中
ok('画面里有内置星 → 选内置那项', defaultTarget(beams, opts) === 'CHINASAT 6D')
ok('只有非内置星 → 选它', defaultTarget([{ satName: ' MY SAT-1 ', lon: 1 }], opts) === 'MY SAT-1')
ok('画面里没有星名 → 第一项', defaultTarget([], opts) === MINI_COVERAGE_SATS[0].name)
ok('内置星按归一名称匹配', defaultTarget([{ satName: 'chinasat-6d' }], opts) === 'CHINASAT 6D')

// ④ 解析目标
ok('内置项取自带轨位', J(resolveTarget({ sat: 'APSTAR 6D' }, opts)) === J({ satName: 'APSTAR 6D', satLon: 134 }))
ok('自定义项取自带轨位', J(resolveTarget({ sat: 'OLD-1' }, opts)) === J({ satName: 'OLD-1', satLon: -30 }))
ok('手动指定：名称去空白', resolveTarget({ sat: MANUAL, satName: '  NEWSAT  ', satLon: '100' }, opts).satName === 'NEWSAT')
ok('手动指定：250 → -110（110°W）', resolveTarget({ sat: MANUAL, satName: 'X', satLon: '250' }, opts).satLon === -110)
ok('手动指定：-30 原样', resolveTarget({ sat: MANUAL, satName: 'X', satLon: ' -30 ' }, opts).satLon === -30)
ok('手动指定：轨位空 → null', resolveTarget({ sat: MANUAL, satName: 'X', satLon: '' }, opts).satLon === null)
ok('手动指定：轨位非数 → null', resolveTarget({ sat: MANUAL, satName: 'X', satLon: '1e' }, opts).satLon === null)
ok('归一：180 → -180、-180 → -180、359.5 → -0.5', normLon(180) === -180 && normLon(-180) === -180 && Math.abs(normLon(359.5) + 0.5) < 1e-12)

// ⑤ ⑥ 投递单元
const base = { app: 'satsim', kind: 'gxt-snapshot', v: 1, name: '平台叫法', createdAt: 1, coverage: { beams: [{ satName: '平台叫法', lon: 125 }] }, polygons: [] }
const baseJ = J(base)
const u1 = covUnit(base, { satName: 'CHINASAT 6D', satLon: 125 }, '')
ok('没改名：自动名「<星名> 覆盖」', u1.name === 'CHINASAT 6D 覆盖', u1.name)
ok('没改名：老格式幂等键 gxt:<星名>', u1.sync === 'gxt:CHINASAT 6D', u1.sync)
ok('类型名', u1.label === '覆盖图')
ok('快照带目标星', J(u1.raw.target) === J({ satName: 'CHINASAT 6D', satLon: 125 }))
ok('名称写进快照本身（密钥导入取 snap.name）', u1.raw.name === 'CHINASAT 6D 覆盖')
ok('不改入参快照', J(base) === baseJ)
ok('快照其余字段原样带过去', u1.raw.kind === 'gxt-snapshot' && u1.raw.coverage === base.coverage && u1.raw.polygons === base.polygons)

const u2 = covUnit(base, { satName: 'CHINASAT 6D', satLon: 125 }, '  Ku 点波束 2  ')
ok('改名：名称去空白', u2.name === 'Ku 点波束 2' && u2.raw.name === 'Ku 点波束 2')
ok('改名：幂等键带名称', u2.sync === 'gxt:CHINASAT 6D|Ku 点波束 2', u2.sync)
ok('同星不同名 → 不同的件', u1.sync !== u2.sync)
ok('名称恰好等于自动名 → 仍是老格式', covUnit(base, { satName: 'CHINASAT 6D', satLon: 125 }, 'CHINASAT 6D 覆盖').sync === 'gxt:CHINASAT 6D')
ok('换一颗星 → 不同的件', covUnit(base, { satName: 'APSTAR 6D', satLon: 134 }, '').sync === 'gxt:APSTAR 6D')
const u3 = covUnit(base, { satName: 'NEWSAT', satLon: null }, '')
ok('无轨位的目标：satLon 为 null（小程序照名称匹配）', u3.raw.target.satLon === null)
const u4 = covUnit(base, { satName: '', satLon: null }, '')
ok('没有目标星：不带 target、名称退回快照名', !('target' in u4.raw) && u4.name === '平台叫法' && u4.sync === 'gxt:平台叫法')
ok('出去的是纯数据', J(structuredClone(u2.raw)) === J(u2.raw))

// ⑦ 记忆
ok('内置星不记', rememberTarget([], { satName: 'chinasat 6d', satLon: 125 }) === null)
ok('没有轨位的不记', rememberTarget([], { satName: 'NEWSAT', satLon: null }) === null)
ok('空名不记', rememberTarget([], { satName: '  ', satLon: 1 }) === null)
const r1 = rememberTarget([{ name: 'A', lon: 1 }, { name: 'new-sat', lon: 2 }, { name: 'B', lon: 3 }], { satName: 'NEW SAT', satLon: -110 })
ok('放到最前、按归一名称去重', J(r1) === J([{ name: 'NEW SAT', lon: -110 }, { name: 'A', lon: 1 }, { name: 'B', lon: 3 }]), J(r1))
const many = Array.from({ length: CUSTOM_MAX + 5 }, (_, i) => ({ name: 'S' + i, lon: i }))
const r2 = rememberTarget(many, { satName: 'TOP', satLon: 5 })
ok('封顶 ' + CUSTOM_MAX, r2.length === CUSTOM_MAX && r2[0].name === 'TOP' && r2[CUSTOM_MAX - 1].name === 'S' + (CUSTOM_MAX - 2))
ok('解析：坏数据逐条丢弃', J(parseCustoms('[{"name":"A","lon":1},{"name":"","lon":2},{"name":"B"},null,{"name":"C","lon":"x"},{"name":" D ","lon":"-5"}]')) === J([{ name: 'A', lon: 1 }, { name: 'D', lon: -5 }]))
ok('解析：非 JSON / 非数组 → 空表', J(parseCustoms('{oops')) === '[]' && J(parseCustoms('{"a":1}')) === '[]' && J(parseCustoms(null)) === '[]')

console.log(`  ${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
if (fail) process.exit(1)
