// 频率计划 → Excel 的自测：模型（src/shared/fpXlsxModel.js）与刷格（electron/services/freqPlanXlsx.js）
// 各测一遍，且【真的落一次盘再读回来】—— 这条管线过 IPC，模型建得对而工作簿写不出来（合并区打架、
// 表名越界、numFmt 非法）在界面上只表现为「导出失败」四个字，光测模型看不见。
//
// 关键不变式：
//   ① 模型必须是【纯数据】—— 过一趟 structuredClone 不抛（Vue 的 Proxy / 函数 / 循环引用都会在这里现形，
//      见 ipc-no-reactive-proxy：invoke 当场抛且没人 catch，症状是全静默）；
//   ② 总表的色块【互不重叠且按频率升序】：色块宽度就是带宽，重叠即比例尺算错；
//   ③ 分配表的段序列【铺满视域、首尾对齐频带】：载波之间的空当必须成段，藏起来等于把没卖出去的
//      频谱说成卖了；
//   ④ 频率与带宽落进 Excel 是【数值】不是字符串（纯数据表的全部意义在于还能求和排序）；
//   ⑤ 越界的载波仍出现在段序列里（画到条外面去等于把问题藏起来），并在冲突明细里有条目。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { newPlan, newChannel, newLo, newBeam, normalizePlan } from '../../../src/shared/freqPlanModel.js'
import { newCarrier } from '../../../src/shared/freqPlanCapacity.js'
import { buildStyledXlsx, buildDataXlsx, buildFreqPlanXlsx, argbOf } from '../../../src/shared/fpXlsxModel.js'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { buildFreqPlanWorkbook } = require('../../../electron/services/freqPlanXlsx.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; return }
  fail++
  console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
}
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol

// ---- 样例：一份 C 段计划，两个波束、三条转发器、一根信标，转发器上摆了几条载波 ----
function samplePlan() {
  const lo = newLo({ name: 'LO-C', valueMHz: 2225 })
  const bA = newBeam({ name: '中国波束', color: '#E03C31', bwMHz: 36 })
  const bB = newBeam({ name: '亚洲波束', color: '#4472C4', bwMHz: 36 })
  const ch = (no, fc, pol, beams) => newChannel({
    no, loId: lo.id, beamUpIds: beams, up: { fcMHz: fc, bwMHz: 36, pol }, dn: { pol: pol === 'H' ? 'V' : 'H' }
  })
  const beacon = newChannel({ no: 'BCN', kind: 'beacon', up: { fcMHz: 4199.5, pol: 'H' } })
  return normalizePlan(newPlan({
    name: '中星测试星 C 频段频率计划', satName: '中星测试星', band: 'C',
    los: [lo], beams: [bA, bB],
    channels: [
      ch('C1', 5945, 'H', [bA.id]),
      ch('C2', 5985, 'H', [bA.id, bB.id]),
      ch('C3', 6025, 'V', [bB.id]),
      beacon
    ]
  }))
}

function sampleCarriers(plan) {
  const id = (no) => plan.channels.find((c) => c.no === no).id
  // 载波存的恒是【上行】中心频率；下行 = 上行 − LO(2225)
  return [
    // C1（上行 5927~5963）：两条 12 MHz 载波，中间留 4 MHz 空当
    newCarrier({ name: 'CCTV-1', channelId: id('C1'), fcMHz: 5933, occBwMHz: 12, pwrBwMHz: 12, modcod: '8PSK 3/4', infoRateKbps: 24000, pol: 'H' }),
    newCarrier({ name: 'CCTV-2', channelId: id('C1'), fcMHz: 5953, occBwMHz: 12, pwrBwMHz: 10, modcod: 'QPSK 2/3', infoRateKbps: 12000 }),
    // C2：一条满宽
    newCarrier({ name: 'VSAT 主站', channelId: id('C2'), fcMHz: 5985, occBwMHz: 36, pwrBwMHz: 30, infoRateKbps: 60000 }),
    // C3：一条越出频带（上边沿 6025+18=6043，载波到 6046）—— 越界必须看得见
    newCarrier({ name: '越界载波', channelId: id('C3'), fcMHz: 6041, occBwMHz: 10, pwrBwMHz: 8 }),
    // 未归属转发器
    newCarrier({ name: '待分配', fcMHz: null, occBwMHz: 5 })
  ]
}

const plan = samplePlan()
const carriers = sampleCarriers(plan)

// 每条转发器只挂一个波束的计划（结合总表据此把「载波波束」那一列省掉）
const noDnBeamPlan = (() => {
  const b = newBeam({ name: '单波束', color: '#2E9E5B', bwMHz: 36 })
  return normalizePlan(newPlan({
    name: '单波束计划', beams: [b],
    channels: [newChannel({ no: 'S1', beamUpIds: [b.id], up: { fcMHz: 6000, bwMHz: 36, pol: 'H' }, dn: { fcMHz: 3775, pol: 'V' } })]
  }))
})()
const oneBeamCarriers = [newCarrier({
  name: 'S1-1', channelId: noDnBeamPlan.channels[0].id, fcMHz: 6000, occBwMHz: 10, pwrBwMHz: 10
})]

console.log('频率计划 · Excel 导出')

// ── ① 纯数据：过得了结构化克隆 ─────────────────────────────────────────────
const styled = buildStyledXlsx(plan, carriers, { unit: 'MHz' })
const data = buildDataXlsx(plan, carriers, { unit: 'MHz' })
for (const [name, m] of [['样式版', styled], ['纯数据版', data]]) {
  let cloned = true
  try { structuredClone(m) } catch (e) { cloned = false; console.error('    ' + e.message) }
  ok(`${name}模型可过结构化克隆（IPC 前提）`, cloned)
}
ok('两种版式 kind 正确', styled.kind === 'styled' && data.kind === 'data')
ok('入口按 kind 分派', buildFreqPlanXlsx('data', plan, carriers).kind === 'data'
  && buildFreqPlanXlsx('styled', plan, carriers).kind === 'styled')

// ── ② 总表：色块互不重叠、按频率升序、宽度正比于带宽 ───────────────────────
const up = styled.overview.bands.find((b) => b.side === 'up')
const dn = styled.overview.bands.find((b) => b.side === 'dn')
ok('上下行两带都在', !!up && !!dn)
ok('上行按极化分两行（H / V）', up.rows.length === 2 && up.rows[0].pol === 'H' && up.rows[1].pol === 'V')
ok('下行极化与上行正交（H 行里是 C3）', dn.rows[0].pol === 'H' && dn.rows[0].blocks[0].label === 'C3')
for (const band of styled.overview.bands) {
  for (const row of band.rows) {
    let okRow = true
    for (let i = 1; i < row.blocks.length; i++) {
      if (row.blocks[i].c0 <= row.blocks[i - 1].c1) okRow = false
      if (row.blocks[i].f1 < row.blocks[i - 1].f1) okRow = false
    }
    ok(`${band.side} / ${row.pol} 行色块互不重叠且升序`, okRow)
  }
}
const b1 = up.rows[0].blocks[0], b2 = up.rows[0].blocks[1]
// 两端都要吸到整数列上，故等带宽的两条最多差一格（相位不同 —— 这是格点化的固有抖动，
// 不是比例尺算错）。列数按「最窄的转发器 ≥ 24 格」定，就是为了把这一格压到 4% 以内
ok('等带宽的转发器占同样多的列（±1 格）', Math.abs((b1.c1 - b1.c0) - (b2.c1 - b2.c0)) <= 1,
  `${b1.c1 - b1.c0} vs ${b2.c1 - b2.c0}`)
ok('网格分辨率足够（最窄的转发器 ≥ 24 格）', (b1.c1 - b1.c0 + 1) >= 24, String(b1.c1 - b1.c0 + 1))
ok('色块带上了频率读数', near(b1.f1, 5927) && near(b1.f2, 5963) && near(b1.fc, 5945))
// 编号格：整条只归一个色的照着刷（= 软件那张图上的样子）；挂着两个波束的 C2 留白，
// 色落在波束行上（刷第一个波束的色正是从前那个「其余几个看不见」的毛病）
ok('单色转发器的编号格刷波束原色', b1.fill === argbOf('#E03C31'), String(b1.fill))
ok('多波束转发器的编号格不着色', b2.fill === undefined && b2.beam === '中国波束 + 亚洲波束')

// ★ 波束行：色 = 波束【原色】（与屏上 FpAlloc 的 colorOf、出图的 stripes 同一个色，不再兑白），
//   同频叠放的各占一层（C2 上两个 36 MHz 的波束都占满 36 MHz 的频带 → 两层）
const lanes = up.rows[0].lanes
ok('波束行按占段出格', lanes.length === 2, `lanes=${lanes.length}`)
ok('波束色是原色', lanes[0][0].fill === argbOf('#E03C31') && lanes[0][0].name === '中国波束',
  `${lanes[0][0].fill} vs ${argbOf('#E03C31')}`)
ok('同频叠放的第二个波束落在第二层', lanes[1].length === 1 && lanes[1][0].name === '亚洲波束'
  && lanes[1][0].fill === argbOf('#4472C4'))
// 叠着的两片都是满宽（各占整条频带），故列区间与色块同宽
const c2b = up.rows[0].blocks[1]
ok('叠放的两片各占满整条频带', lanes[1][0].c0 === c2b.c0 && lanes[1][0].c1 === c2b.c1)
ok('单波束的转发器只出一格', lanes[0].filter((c) => c.c0 === b1.c0).length === 1)
// ★ 合并区一旦相交，exceljs 当场抛（界面上只剩「导出失败」四个字）—— 层内必须严格不相交且升序
const laneClean = (rows) => rows.every((lane) => lane.every((c, i) =>
  c.c1 >= c.c0 && (i === 0 || c.c0 > lane[i - 1].c1)))
ok('每一层内的波束格互不相交且升序',
  styled.overview.bands.every((band) => band.rows.every((row) => laneClean(row.lanes))))
// 信标是一根箭头，不是色块（只有频率与极化，见模型 CHANNEL_KINDS）；
// 且它是星上发的 → 只在【下行】那一侧（markSide('beacon') = 'dn'，foldMark 会把它折过去）
ok('信标不进色块行', styled.overview.bands.every((b) => b.rows.every((r) => r.blocks.every((x) => x.label !== 'BCN'))))
ok('信标只在下行侧、画成箭头', up.marks.length === 0
  && dn.marks.length === 1 && dn.marks[0].tag === 'BEACON' && dn.marks[0].arrow === '↓' && dn.marks[0].pol === 'H')
ok('图例给出两个波束', styled.overview.legend.length === 2 && styled.overview.legend[0].color === argbOf('#E03C31'))
ok('图例带上本振', styled.overview.los.length === 1 && near(styled.overview.los[0].value, 2225))

// ── ③ 分配表：段序列铺满、空当成段、越界看得见 ─────────────────────────────
const blocks = styled.sheets.flatMap((s) => s.blocks)
ok('分配表只排转发器（信标没有频带）', blocks.length === 3 && blocks.every((b) => b.no !== 'BCN'))
ok('每 3 条一张（同示例体例）', styled.sheets.length === 1 && styled.sheets[0].blocks.length === 3)
ok('表名由转发器编号拼出', styled.sheets[0].name === 'C1、C2、C3')

const c1 = blocks.find((b) => b.no === 'C1')
// C1 下行频带 3702~3738（上行 5927~5963 − LO 2225）。两条载波：
//   CCTV-1 上行 5933±6 → 下行 3702~3714（正贴下边沿，故前面没有空当）
//   CCTV-2 上行 5953±6 → 下行 3722~3734，两者之间空 8 MHz，末尾再空 4 MHz
ok('C1 段序列 = 载波 · 空 · 载波 · 空', c1.segs.map((s) => (s.gap ? 'gap' : s.name)).join(',') === 'CCTV-1,gap,CCTV-2,gap',
  c1.segs.map((s) => (s.gap ? 'gap' : s.name)).join(','))
ok('C1 空当写成「空」并给出宽度', c1.segs[1].gap && c1.segs[1].name === '空' && near(c1.segs[1].bw, 8))
let contiguous = true
for (let i = 1; i < c1.segs.length; i++) if (!near(c1.segs[i].f1, c1.segs[i - 1].f2, 1e-3)) contiguous = false
ok('C1 段首尾相接（铺满视域，不漏频谱）', contiguous)
ok('C1 段起止对齐频带两端', near(c1.segs[0].f1, c1.f1, 1e-3) && near(c1.segs[c1.segs.length - 1].f2, c1.f2, 1e-3))
ok('C1 列区间不重叠', c1.segs.every((s, i) => i === 0 || s.c0 > c1.segs[i - 1].c1))
// 只挂一个波束的转发器不在每条载波下面重复波束名（上面那条波束带写过一遍）
ok('载波带上调制与速率', c1.segs[0].sub === '8PSK 3/4 · 24000 kbps', c1.segs[0].sub)
ok('C1 小结前六项只出数值', c1.summary.slice(0, 6).length === 6 && c1.summary[0][1] === 36 && c1.summary[1][1] === 24)
ok('C1 小结带上波束占段', c1.summary[6][0] === '波束数' && c1.summary[6][1] === 1
  && c1.summary[7][0] === '波束 · 中国波束 (MHz)' && c1.summary[7][1] === 36)
// 载波色 = 它所属波束的原色（同屏上）
ok('载波块用波束原色', c1.segs[0].fill === argbOf('#E03C31'), c1.segs[0].fill)
ok('C1 波束带一层一个波束', c1.beamLanes.length === 1 && c1.beamLanes[0].length === 1
  && c1.beamLanes[0][0].name === '中国波束')

const c2 = blocks.find((b) => b.no === 'C2')
ok('C2 满宽载波占满整条（无空当段）', c2.segs.length === 1 && !c2.segs[0].gap && near(c2.segs[0].bw, 36))
// 两个波束同频叠在一条转发器上 → 波束带两层；载波下面这时才写波束名（有得分辨了）
ok('C2 波束带两层', c2.beamLanes.length === 2 && c2.beamLanes[0][0].name === '中国波束'
  && c2.beamLanes[1][0].name === '亚洲波束')
ok('多波束的转发器：载波副行写出波束', /^中国波束 · /.test(c2.segs[0].sub), c2.segs[0].sub)
// 分配表是【下行域】，故极化写的是下行那一个（C2 上行 H → 下行 V），上行频带补在后面
ok('标题右端写极化与上行频带', c2.tail === 'V（垂直） · 上行 5967~6003 MHz', c2.tail)

const c3 = blocks.find((b) => b.no === 'C3')
const outSeg = c3.segs.find((s) => !s.gap)
ok('越界载波仍在段序列里', !!outSeg && outSeg.name === '越界载波')
ok('越界载波带上越界标记', outSeg.out === true)
ok('越界载波在冲突明细里有条目', c3.issues.some((i) => /越出/.test(i.msg)))
ok('视域含越界那一截（不裁到频带边沿）', c3.d1 > c3.f2 - 1e-9)
ok('未归属载波单列一张', styled.orphan.length === 1 && styled.orphan[0].name === '待分配')

// ── ③′ 波束表：图例写不下的那一半（一个波束落在哪几条转发器上、各占多少）─────────────
const bmA = styled.beams.find((b) => b.name === '中国波束')
const bmB = styled.beams.find((b) => b.name === '亚洲波束')
ok('波束表两条、带原色与色值', styled.beams.length === 2 && bmA.color === argbOf('#E03C31') && bmA.hex === '#E03C31')
// 下行域：C1(H→V) 与 C2 挂中国波束、C2 与 C3 挂亚洲波束
ok('波束表数出挂载的转发器', bmA.tpCount === 2 && bmA.tps === 'C1、C2' && bmB.tpCount === 2 && bmB.tps === 'C2、C3',
  `${bmA.tps} / ${bmB.tps}`)
ok('波束表占用带宽只按下行合计（两侧相加会记两遍）', near(bmA.occ, 72) && near(bmA.bw, 36))

// ── ④ 纯数据表：概览 + 结合总表两张 · 频率是数值 ────────────────────────────
const names = data.sheets.map((s) => s.name)
ok('两张表：概览 + 转发器·载波', names.join(',') === '计划概览,转发器 · 载波', names.join(','))
const shOf = (n) => data.sheets.find((s) => s.name === n)
const all = shOf('转发器 · 载波')
const col = (name) => all.columns.findIndex((c) => c.header.startsWith(name))
const cell = (row, name) => row[col(name)]
// 一行一条载波；没有载波的转发器仍占一行（藏起来 = 那条转发器像是没录）；信标各一行；
// 未归属的载波跟在末尾。C1×2 + C2×1 + C3×1 + 信标 + 未归属 = 6
ok('结合表按载波摊平（空转发器与信标各留一行）', all.rows.length === 6,
  all.rows.map((r) => `${cell(r, '转发器')}/${cell(r, '载波')}`).join(' '))
const rowC1 = all.rows.find((r) => cell(r, '载波') === 'CCTV-1')
ok('结合表：转发器的字段跟着载波重复一遍',
  cell(rowC1, '转发器') === 'C1' && near(cell(rowC1, '上行起始'), 5927) && near(cell(rowC1, '上行终止'), 5963))
ok('结合表：载波只写中心与两条带宽（起止 = 中心 ∓ 占用/2，不再各占一列）',
  near(cell(rowC1, '载波下行中心'), 3708) && near(cell(rowC1, '载波上行中心'), 5933)
  && near(cell(rowC1, '占用带宽'), 12) && col('载波下行起始') === -1)
ok('结合表：下行由本振推算得出', near(cell(rowC1, '下行起始'), 3702) && cell(rowC1, '本振') === 'LO-C')
// 两侧挂的是同一组波束（下行没单独指定就随上行）→ 并成一列「波束」
ok('波束两列同值时并成一列', cell(rowC1, '波束') === '中国波束'
  && col('上行波束') === -1 && col('下行波束') === -1,
  all.columns.map((c) => c.header).join(','))
// 载波那一列只在【分辨得出】时才留：C2 挂着两个波束，它的载波归谁不是自明的
ok('多波束的计划留着载波波束列', col('载波波束') > 0 && cell(rowC1, '载波波束') === '中国波束')
const oneBeam = buildDataXlsx(noDnBeamPlan, oneBeamCarriers).sheets.find((s) => s.name === '转发器 · 载波')
ok('每条转发器只挂一个波束时，载波波束列不出',
  oneBeam.columns.every((c) => c.header !== '载波波束'), oneBeam.columns.map((c) => c.header).join(','))
const rowBcn = all.rows.find((r) => cell(r, '转发器') === 'BCN')
ok('信标行没有带宽（模型不给它带宽，报了就是噪声）', cell(rowBcn, '上行带宽') == null)
// 信标是一个频点，不是一段零宽的频带 —— 起止留空、只写中心。下行域里它就是那个中心
ok('信标行起止留空', cell(rowBcn, '下行起始') == null && cell(rowBcn, '下行终止') == null)
ok('结合表含未归属那一条', all.rows.some((r) => cell(r, '转发器') === '（未归属）' && cell(r, '载波') === '待分配'))
// ★ 空列不出：这份样例没录 SFD / G/T / IBO / OBO / C/IM，那五列一并不出现
//   （Number(null) 是 0 —— 从前留着列就得挡空，现在整列都不该在）
ok('整列没值的不出列', col('SFD') === -1 && col('C/IM') === -1 && col('备注') === -1,
  all.columns.map((c) => c.header).join(','))
ok('有值的可选列照出（这份样例录了调制与速率）', col('调制') > 0 && col('信息速率') > 0)
ok('该出的列都在', col('转发器') === 1 && col('载波') > 0 && col('本振') > 0 && col('下行极化') > 0)
const ov = shOf('计划概览')
ok('概览是键值表', ov.kv === true && ov.rows.length > 20)
// 波束 / 本振 / 校验三张原本各占一表的小表并进概览（各自只有几行）
const ovKeys = ov.rows.map((r) => String(r[0]))
ok('概览并进了波束与本振', ovKeys.includes('—— 波束 / 带宽组') && ovKeys.includes('中国波束')
  && ovKeys.includes('—— 本振') && ovKeys.includes('LO-C'))
ok('概览逐条列出校验（只报条数等于把问题藏起来）', ov.rows.some((r) => /越出/.test(String(r[1]))),
  ovKeys.join(','))

// ── ⑤ 真落一次盘再读回来 ────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpxlsx-'))
async function roundTrip(model, file) {
  const buf = await buildFreqPlanWorkbook(model)
  const fp = path.join(tmp, file)
  fs.writeFileSync(fp, Buffer.from(buf))
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(fp)
  return wb
}

const wbS = await roundTrip(styled, 'styled.xlsx')
ok('样式版：总表 + 波束 + 分配表 + 未归属，共 4 张', wbS.worksheets.length === 4, wbS.worksheets.map((w) => w.name).join(','))
ok('样式版表名正确', wbS.worksheets.map((w) => w.name).join(',') === '总表,波束,C1、C2、C3,未归属载波')
const wsO = wbS.getWorksheet('总表')
const flat = []
wsO.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => flat.push(String(c.value ?? ''))))
ok('总表写出了标题与转发器编号', flat.some((v) => v.includes('中星测试星')) && flat.includes('C1') && flat.includes('C3'))
ok('总表画出了色块底色', (() => {
  let n = 0
  wsO.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => {
    if (c.fill && c.fill.type === 'pattern' && c.fill.fgColor && c.fill.fgColor.argb) n++
  }))
  return n > 3
})())
const wsA = wbS.getWorksheet('C1、C2、C3')
const aFlat = []
wsA.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => aFlat.push(c.value)))
ok('分配表写出了转发器标题（起 · 中 · 止）', aFlat.some((v) => typeof v === 'string' && v.startsWith('C1（3702 · 3720 · 3738')),
  String(aFlat.find((v) => typeof v === 'string' && v.startsWith('C1')) || ''))
ok('分配表写出了载波名', aFlat.includes('CCTV-1') && aFlat.includes('VSAT 主站'))
ok('分配表的频率是数值不是字符串', aFlat.some((v) => typeof v === 'number' && near(v, 3738)))
ok('分配表有冲突明细表头', aFlat.includes('冲突与越界明细'))
ok('分配表画出了波束带', aFlat.filter((v) => v === '中国波束').length >= 2)
// 落盘再读回来，底色仍是波束原色（兑白那一版这里是 #F09E98）
const fills = []
wsA.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => {
  if (c.fill && c.fill.fgColor && c.fill.fgColor.argb) fills.push(c.fill.fgColor.argb)
}))
ok('工作簿里的底色是波束原色', fills.includes(argbOf('#E03C31')), [...new Set(fills)].join(','))
const wsB = wbS.getWorksheet('波束')
ok('波束表落盘可读', wsB.getRow(5).getCell(3).value === '中国波束' && wsB.getRow(5).getCell(6).value === 2)

const wbD = await roundTrip(data, 'data.xlsx')
ok('纯数据版两张表', wbD.worksheets.length === 2, wbD.worksheets.map((w) => w.name).join(','))
const wsC = wbD.getWorksheet('转发器 · 载波')
ok('纯数据版表头在第 4 行', wsC.getRow(4).getCell(2).value === '转发器')
const cDn = all.columns.findIndex((c) => c.header.startsWith('载波下行中心')) + 1
ok('纯数据版频率落成数值', typeof wsC.getRow(5).getCell(cDn).value === 'number')
ok('纯数据版带 numFmt', String(wsC.getRow(5).getCell(cDn).numFmt || '') === '0.00')
ok('纯数据版有自动筛选', !!wsC.autoFilter)
ok('纯数据版列宽已定', Number(wsC.getColumn(2).width) > 0)
fs.rmSync(tmp, { recursive: true, force: true })

// ── ⑥ 边界：空计划 / 没有载波 / 换刻度 ────────────────────────────────────
const bare = normalizePlan(newPlan({ name: '空计划' }))
const bs = buildStyledXlsx(bare, [])
const bd = buildDataXlsx(bare, [])
ok('空计划：总表无频带、分配表无分页', bs.overview.bands.length === 0 && bs.sheets.length === 0)
const wbBare = await buildFreqPlanWorkbook(bs).then(() => true).catch((e) => e.message)
ok('空计划的样式版仍写得出工作簿', wbBare === true, String(wbBare))
const wbBareD = await buildFreqPlanWorkbook(bd).then(() => true).catch((e) => e.message)
ok('空计划的纯数据版仍写得出工作簿', wbBareD === true, String(wbBareD))

const kHz = buildDataXlsx(plan, carriers, { unit: 'kHz' })
const kSh = kHz.sheets.find((s) => s.name === '转发器 · 载波')
const kCol = (n) => kSh.columns.findIndex((c) => c.header.startsWith(n))
const kRow = kSh.rows.find((r) => r[1] === 'C1')
ok('换刻度：kHz 下 5927 MHz 写成 5927000', near(kRow[kCol('上行起始')], 5927000))
ok('换刻度：列头跟着写 kHz', kSh.columns[kCol('上行起始')].header === '上行起始 (kHz)')
ok('换刻度：kHz 取整（小数位随刻度走）', kHz.unit.numFmt === '0')

const noCarr = buildStyledXlsx(plan, [])
const nc1 = noCarr.sheets[0].blocks[0]
// 空转发器整条写一个「空」（同示例的 C-3A：B23:F23 合并写「空」），不是留一条白条
ok('没有载波的转发器：整条一个「空」段', nc1.segs.length === 1 && nc1.segs[0].gap && nc1.segs[0].name === '空'
  && near(nc1.segs[0].bw, 36))
ok('空转发器小结仍在且占用为 0', nc1.summary[0][1] === 36 && nc1.summary[1][1] === 0)
const wbNC = await buildFreqPlanWorkbook(noCarr).then(() => true).catch((e) => e.message)
ok('没有载波也写得出工作簿', wbNC === true, String(wbNC))

// 一侧【只有】信标 / 遥控 / 遥测：它们不归极化行（没有带宽画不成色块），故那一带一行极化行都没有。
// 取 rows[0] 画刻度会当场 TypeError，界面上只表现为「导出失败」四个字。
const markOnly = normalizePlan(newPlan({
  name: '只有信标',
  channels: [
    newChannel({ no: 'BCN', kind: 'beacon', up: { fcMHz: 4199.5, pol: 'H' } }),
    newChannel({ no: 'TC', kind: 'tc', up: { fcMHz: 6425, pol: 'V' } })
  ]
}))
const mo = buildStyledXlsx(markOnly, [])
ok('只有标记类载波：两带都无极化行、marks 各归各侧',
  mo.overview.bands.every((b) => b.rows.length === 0)
  && mo.overview.bands.find((b) => b.side === 'up')?.marks.length === 1
  && mo.overview.bands.find((b) => b.side === 'dn')?.marks.length === 1)
const wbMO = await buildFreqPlanWorkbook(mo).then(() => true).catch((e) => e.message)
ok('只有标记类载波也写得出工作簿', wbMO === true, String(wbMO))

// 未挂 LO 又没显式给下行 → 这一条排不出条（分配表没有下行域）
const noDn = normalizePlan(newPlan({
  name: '缺下行', channels: [newChannel({ no: 'X1', up: { fcMHz: 6000, bwMHz: 36, pol: 'H' } })]
}))
const nd = buildStyledXlsx(noDn, [])
ok('缺下行频带的转发器：标题写明、段表为空', nd.sheets[0].blocks[0].title.includes('无下行频带')
  && nd.sheets[0].blocks[0].segs.length === 0)
const wbND = await buildFreqPlanWorkbook(nd).then(() => true).catch((e) => e.message)
ok('缺下行频带也写得出工作簿', wbND === true, String(wbND))

// HTS：一条转发器上挂几十个波束、频分排布。三条不变式（三条各踩过一次）：
//   ① 分层照【频率】判重叠 —— 照列判的话，四舍五入撞在同一格的那些段会被当成「同频」，
//      9 列上排 40 个波束能错出 13 层，那不叫表叫栅栏；
//   ② 层内互不相交 —— 合并区一相交 exceljs 当场抛，界面上只剩「导出失败」四个字；
//   ③ 排不下的并进邻格并【写出 +n】—— 悄悄少画等于把那几个波束藏了。
const HTS_N = 40
const htsBeams = Array.from({ length: HTS_N }, (_, i) => newBeam({ name: `B${i + 1}`, bwMHz: 0.5 }))
const htsPlan = normalizePlan(newPlan({
  name: 'HTS', band: 'Ka',
  beams: htsBeams,
  channels: [
    // 这一条只有 20 MHz 却挂着 40 个波束，而整幅要铺到 800 MHz 外那一条 —— 一个波束分不到一列
    newChannel({
      no: 'K1', beamUpIds: htsBeams.map((b) => b.id), beamLayout: 'tile',
      up: { fcMHz: 29010, bwMHz: 20, pol: 'H' }
    }),
    newChannel({ no: 'K2', up: { fcMHz: 29800, bwMHz: 36, pol: 'H' } })
  ]
}))
const hts = buildStyledXlsx(htsPlan, [])
const htsRow = hts.overview.bands.find((b) => b.side === 'up').rows[0]
const htsCells = htsRow.lanes.flat()
// 频分排布的一律留在同一层：另起一层就是把「各占一段」画成「挤在同一段」
ok('HTS：频分排布只出一层', htsRow.lanes.length === 1, `层数 ${htsRow.lanes.length}`)
ok('HTS：层内互不相交且升序', htsRow.lanes.every((lane) => lane.every((c, i) =>
  c.c1 >= c.c0 && (i === 0 || c.c0 > lane[i - 1].c1))))
// 画出来的 + 并进去的 = 全部（K2 没有波束，占一格灰的「—」，故加 1）
const htsShown = htsCells.reduce((n, c) => n + 1 + (c.more || 0), 0)
ok('HTS：一个波束都没丢（并进邻格的也算数）', htsShown === HTS_N + 1, `${htsShown} vs ${HTS_N + 1}`)
ok('HTS：并进去的在格上写出 +n', htsCells.some((c) => c.more > 0 && /\+\d+$/.test(c.label)),
  htsCells.map((c) => c.label).join(','))
const wbHts = await buildFreqPlanWorkbook(hts).then(() => true).catch((e) => e.message)
ok('HTS 也写得出工作簿（合并区不打架）', wbHts === true, String(wbHts))

// 表名越界与非法字符（Excel: ≤31 字符、不含 : \ / ? * [ ]）
const longNo = normalizePlan(newPlan({
  name: '长编号',
  channels: [1, 2, 3].map((i) => newChannel({ no: `转发器编号非常长的一条[${i}]/测试`, up: { fcMHz: 5900 + i * 40, bwMHz: 36, pol: 'H' } }))
}))
const wbLong = await buildFreqPlanWorkbook(buildStyledXlsx(longNo, []))
const lw = new ExcelJS.Workbook()
await lw.xlsx.load(wbLong)
ok('超长/非法表名已收编', lw.worksheets.every((w) => w.name.length <= 31 && !/[:\\/?*[\]]/.test(w.name)),
  lw.worksheets.map((w) => w.name).join(','))

console.log(`  ${pass} 通过${fail ? ` · ${fail} 失败` : ''}`)
if (fail) process.exit(1)
