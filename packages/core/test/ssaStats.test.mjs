// 空间态势（SSA）统计引擎与报告模型自测。运行：npm test
// 被测的两份都是渲染端 ESM（src/shared/ssaStats.js / ssaReport.js，零 DOM），故本测试也是 .mjs。
//
// ★ 这套测试盯的是三样东西，每样都是「错了不会报错、只会悄悄给出一份错的交付文档」的那种：
//   ① 口径的【不重不漏】—— 在轨 / 已陨落 / 深空着陆三类必须互斥且铺满整张表，类型合计对得上；
//      「逐月在轨累计」的末值必须恰好等于在轨对象数（发射 +1 / 陨落 −1 的前缀和一旦漏一条就对不上）；
//   ② 模型的【纯数据】—— NaN / undefined / 函数进了模型，过 IPC 会被结构化克隆悄悄吃掉或直接抛，
//      Word 那头拿到的就是空格。这里显式扫一遍，再做一次 JSON 往返比对；
//   ③ 报告的【可复现】—— 同一份数据 + 同一个 asOf，两次 build 必须逐字相同。引擎里任何一处
//      Date.now() / Math.random() / Map 迭代序依赖都会在这条上露馅。
// 夹具（fixtures/satcat.sample.csv、fixtures/ssaGp.sample.csv）是手造的，覆盖四种类型 / 八种状态 /
// 在轨与陨落与停靠与深空与着陆 / 名称带引号逗号 / 根数为空 / 9 位 NORAD / 五种区制 / 近 30 天进出。

import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
// SSA_SOFT=1：失败只记下不中断（补丁前逐条确认新断言是红的用；平时照常第一条失败即停）
const SOFT = !!process.env.SSA_SOFT
let fail = 0
const soft = (f, m) => { try { f(); pass++ } catch (e) { if (!SOFT) throw e; fail++; console.log('✗ ' + m) } }
const ok = (c, m) => soft(() => assert.ok(c, m), m)
const eq = (a, b, m) => soft(() => assert.deepEqual(a, b, m), m)
const part = (name, f) => { try { f() } catch (e) { if (!SOFT) throw e; fail++; console.log('✗ [' + name + '] 抛错：' + e.message) } }

const S = await import('../../../src/shared/ssaStats.js')
const RP = await import('../../../src/shared/ssaReport.js')
const { parseOMMCsv } = await import('../../../src/viz/constellation/tle.js')

const read = (f) => fs.readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8')
const rows = S.parseSatcatCsv(read('satcat.sample.csv'))
const gp = parseOMMCsv(read('ssaGp.sample.csv'))
const asOf = '2026-09-16T00:00:00Z'
const idx = S.buildIndex(rows)
const gpIdx = new Map(gp.map((g) => [g.noradId, g]))

// ===================================================================================
// 1. 解析
// ===================================================================================
eq(rows.length, 57, 'satcat 夹具 57 行')
eq(gp.length, 18, 'gp 夹具 18 条')

const quoted = idx.get('70050')
eq(quoted.name, 'COSMOS 2251, DEB TEST', '名称里的引号逗号：引号剥掉、逗号保留，不当分隔符')
eq(quoted.type, 'DEB', '带引号的行后面各列不错位')

const wide = idx.get('123456789')
ok(wide && wide.norad === '123456789', '9 位 NORAD 原样保留（norad 是字符串，不走 Number）')

const noEl = idx.get('70043')
eq([noEl.periodMin, noEl.inclDeg, noEl.apogeeKm, noEl.perigeeKm], [null, null, null, null], '空数值列 → null')
eq(noEl.dataStatus, 'NEA', '空串列 → 原串')
eq(S.regimeOf(noEl), '—', '根数为空 → 区制 —')

eq(S.parseSatcatCsv('').length, 0, '空文本 → 空表')
eq(S.parseSatcatCsv('A,B,C\n1,2,3').length, 0, '缺 NORAD_CAT_ID 列 → 空表')

// 八种状态码在夹具里都出现过（+ − P B S X D 空）
const statusSet = new Set(rows.map((r) => r.status))
for (const c of ['+', '-', 'P', 'B', 'S', 'X', 'D', '']) ok(statusSet.has(c), '夹具覆盖状态码 ' + JSON.stringify(c))

// ===================================================================================
// 2. 谓词：三类不重不漏
// ===================================================================================
let io = 0, de = 0, ds = 0, none = 0, dup = 0
for (const r of rows) {
  const a = S.isInOrbit(r), b = S.isDecayed(r), c = S.isDeepSpace(r)
  const n = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0)
  if (n === 0) none++
  if (n > 1) dup++
  if (a) io++; if (b) de++; if (c) ds++
}
eq([none, dup], [0, 0], '在轨 / 已陨落 / 深空着陆：互斥且铺满全表')
eq([io, de, ds], [45, 9, 3], '三类计数')
eq(io + de + ds, rows.length, '三类之和 = 总行数')

eq(S.isInOrbit(idx.get('70060')), true, 'ORBIT_CENTER 为数字（停靠母体）也算在轨')
eq(S.isDeepSpace(idx.get('70070')), true, 'ORBIT_CENTER = MO → 深空')
eq(S.isDeepSpace(idx.get('70071')), true, 'ORBIT_TYPE = LAN → 着陆')
eq(S.isDeepSpace(idx.get('70072')), true, 'ORBIT_TYPE = R/T 优先于 DECAY_DATE → 归深空着陆，不计已陨落')
eq(S.isActive(idx.get('70070')), true, 'isActive 只看类型 + 状态（深空探测器也算活跃载荷）')
eq(S.isActiveInOrbit(idx.get('70070')), false, '★ 报告口径的活跃载荷再叠一道在轨，深空的不算')

eq(S.regimeOf(idx.get('70001')), 'LEO', '区制 LEO')
eq(S.regimeOf(idx.get('70040')), 'MEO', '区制 MEO')
eq(S.regimeOf(idx.get('70020')), 'GEO', '区制 GEO')
eq(S.regimeOf(idx.get('70041')), 'IGSO', '区制 IGSO（同步周期但倾角 55°）')
eq(S.regimeOf(idx.get('70042')), 'HEO', '区制 HEO（e ≈ 0.74）')

// ===================================================================================
// 3. 编目总览 / 区制 / 所有者
// ===================================================================================
const ov = S.catalogOverview(rows)
eq([ov.total, ov.inOrbit, ov.decayed, ov.deepSpace], [57, 45, 9, 3], '总览四数')
eq(ov.active, 26, '活跃载荷（在轨口径）')
eq([ov.docked, ov.landed, ov.impacted], [1, 1, 9], '停靠 / 着陆 / 再入计数')
eq(ov.byType.map((t) => t.code), ['PAY', 'R/B', 'DEB', 'UNK'], '类型行序固定')
for (const t of ov.byType) eq(t.inOrbit + t.decayed + t.deepSpace, t.total, '类型 ' + t.code + ' 合计 = 在轨 + 已陨落 + 深空着陆')
eq(ov.byType.reduce((s, t) => s + t.total, 0), rows.length, '各类型合计之和 = 总行数，无遗漏')
eq(ov.byType.map((t) => [t.code, t.inOrbit, t.decayed, t.deepSpace, t.total]),
  [['PAY', 29, 2, 3, 34], ['R/B', 6, 2, 0, 8], ['DEB', 8, 5, 0, 13], ['UNK', 2, 0, 0, 2]], '类型 × 状态逐格')

const rt = S.regimeTable(rows)
eq(rt.rows.map((r) => r.regime), ['LEO', 'MEO', 'GEO', 'IGSO', 'HEO', '—'], '区制行序固定')
eq(rt.rows.map((r) => r.total), [37, 2, 3, 1, 1, 1], '区制 × 在轨合计逐行')
eq(rt.rows.reduce((s, r) => s + r.total, 0), ov.inOrbit, '区制表合计 = 在轨对象数')
eq(rt.rows.reduce((s, r) => s + r.active, 0), ov.active, '区制表活跃载荷合计 = 总览活跃载荷')
eq(rt.rows[0].byType, { PAY: 21, 'R/B': 6, DEB: 8, UNK: 2 }, 'LEO 行逐类型')

const ot = S.ownerTable(rows, { topN: 5 })
eq(ot.ownerCount, 7, '所有者数（深空着陆的行不进本表）')
eq(ot.rows.map((r) => r.owner), ['PRC', 'US', 'CIS', 'JPN', 'ROC'], '按在轨载荷降序、并列按代码升序')
// 累计·发射只计载荷 + 火箭体（#10，2026-10-16：原先 22 = 连碎片 4 条一起计）
eq(ot.rows[0], { owner: 'PRC', active: 16, payloads: 16, rockets: 2, debris: 3, inOrbit: 21, launched: 18, decayed: 1 }, 'PRC 行逐格')
eq(ot.total.launched, rows.filter((r) => !S.isDeepSpace(r) && (r.type === 'PAY' || r.type === 'R/B')).length, '所有者表合计·累计发射 = 非深空载荷 + 火箭体条数')
// ★ 行数恒 = topN（2026-09-17 删掉「钉住某一家」那档之后）：题注写「前 N 位」，表里就得是 N 行
eq(S.ownerTable(rows, { topN: 2 }).rows.map((r) => r.owner), ['PRC', 'US'], '只取前 topN 行，不再往表尾追加任何一行')

// ===================================================================================
// 4. 发射与陨落
// ===================================================================================
const ls = S.launchSeries(rows, { asOf })
eq([ls.years[0], ls.years[ls.years.length - 1], ls.years.length], [1957, 2026, 70], '逐年序列 1957–asOf 年')
// 发射只数载荷与火箭体（碎片的发射日是母体的，2026-10-15 起不计入发射）
eq(ls.payRb.reduce((a, b) => a + b, 0), rows.filter((r) => r.type === 'PAY' || r.type === 'R/B').length, '逐年发射（载荷与火箭体）合计 = 载荷与火箭体总数（每行都有发射日期）')
eq(ls.payload.reduce((a, b) => a + b, 0), 34, '逐年发射（载荷）合计 = 载荷总数')

const dsy = S.decaySeries(rows, { asOf })
eq(dsy.all.reduce((a, b) => a + b, 0), ov.decayed, '逐年陨落合计 = 已陨落数（R/T 的返回日期不计）')

const ms = S.monthlySeries(rows, { asOf, months: 24 })
eq([ms.months.length, ms.months[0], ms.months[23]], [24, '2024-10', '2026-09'], '近 24 月窗口，末月 = asOf 所在月')
eq(ms.launchPayRb.slice(-3), [0, 2, 5].map((_, i) => rows.filter((r) => (r.type === 'PAY' || r.type === 'R/B') && String(r.launchDate).slice(0, 7) === ms.months[21 + i]).length), '近三个月发射（载荷与火箭体）')
eq(ms.decayAll.slice(-3), [0, 1, 2], '近三个月陨落（全部）')

const cum = S.inOrbitCumulative(rows, { asOf })
eq([cum.months[0], cum.months[cum.months.length - 1]], ['1957-10', '2026-09'], '在轨累计序列起止月')
eq(cum.counts.length, cum.months.length, '在轨累计：月与值等长')
eq(cum.counts[cum.counts.length - 1], ov.inOrbit, '★ 在轨累计末值 = 在轨对象数')
ok(cum.counts.every((n) => n >= 0), '在轨累计恒非负')

const rl = S.recentLaunches(rows, { asOf, days: 30 })
eq(rl.from, '2026-08-17', '近 30 天窗口起点（UTC 日历日）')
eq(rl.payloads.map((r) => r.norad), ['70090', '70114', '70060'], '近 30 天新发射载荷，按日期降序')
eq(rl.rockets.map((r) => r.norad), ['123456789', '70091'], '近 30 天新发射火箭体')
eq([rl.debris, rl.other, rl.total], [1, 1, 7], '碎片与未知只计数')
eq(rl.payloads[0].regime, 'LEO', '明细带区制列')

const rd = S.recentDecays(rows, { asOf, days: 30 })
eq([rd.payloads.map((r) => r.norad), rd.rockets.map((r) => r.norad), rd.debris], [['70094'], ['70095'], 1], '近 30 天陨落明细')

// ===================================================================================
// 5. 星座部署 / 星历时效
// ===================================================================================
const cd = S.constellationDeploy(rows, gp, { asOf })
eq(cd.rows.map((r) => r.key), ['beidou', 'gps', 'starlink'], '只列命中名称模式的星座，按在轨降序、并列按 key 升序')
const sl = cd.rows.find((r) => r.key === 'starlink')
eq([sl.launched, sl.inOrbit, sl.active, sl.recent30, sl.recent365, sl.decayed, sl.gpCount], [1, 1, 1, 1, 1, 0, 0], 'starlink 行逐格')
const bd = cd.rows.find((r) => r.key === 'beidou')
eq(bd.shells, [{ altKm: 35775, incDeg: 55, n: 1 }], '主壳层（高度 25 km × 倾角 1° 的桶下边界）')

const ea = S.epochAgeStats(gp, asOf)
eq([ea.overall.n, ea.overall.median, ea.overall.p90, ea.overall.max, ea.overall.stale], [18, 1, 2, 10, 1],
  '历元龄：颗数 / 中位数 / P90（最近秩，sorted[ceil(0.9n)−1]）/ 最大 / > 7 天颗数')
eq(ea.byConst.map((c) => c.key), ['beidou', 'gps'], '按大型星座分组各一行')

// ===================================================================================
// 6. GEO 轨道弧
// ===================================================================================
const go = S.geoOccupancy(gp, idx, { arc: [60, 150], topN: 5 })
eq(go.total, 3, '定点解算成功的 GEO 卫星（非 GEO 的星历不参与）')
eq(go.sats.map((s) => [s.norad, s.lon]), [['70115', 20], ['70020', 110], ['70021', 110.1]], '逐星定点经度，按经度升序')
eq(go.sats[1].slot, '110.0°E', '定点格式化 °E/°W')
eq(go.bins.length, 360, '1° 桶覆盖 −180…179 全程')
eq(go.top.map((b) => [b.lon, b.n]), [[110, 2], [20, 1]], '最拥挤桶排序')
eq(go.clusters.length, 1, '★ 共位簇 1 个')
eq([go.clusters[0].n, go.clusters[0].sats.map((s) => s.norad)], [2, ['70020', '70021']], '★ 该簇 2 颗（相邻 0.1° ≤ 0.2°）')
eq(go.arc.n, 2, '重点弧段 60°E–150°E 内 2 颗')
eq(go.sats[1].owner, 'PRC', '所有者由编目索引回填')

const nb = S.geoNeighbors({ norad: '70020', lon: 110 }, gp, { tol: 1.0, index: idx })
eq(nb.map((x) => [x.norad, x.dLon]), [['70021', 0.1]], '±1° 邻星（不含自己）')
eq(S.geoNeighbors({ norad: '70115', lon: 20 }, gp, { tol: 1.0, index: idx }).length, 0, '孤立定点无邻星')

// ===================================================================================
// 7. 卫星组
// ===================================================================================
// 88888 = 编目里查无此号（真实号段）；900001 = 自建星座合成号段（NORAD ≥ 900000），两者都归「查无此号」，
// 但后者要单独计一笔 customCount —— 它不是「目录漏了」，是本来就不该在真实编目里。
const g1 = {
  id: 'sg1', name: 'TESTSAT 组', color: '#4dabf7',
  sats: [...Array(12)].map((_, i) => ({ id: String(70001 + i), name: 'TESTSAT-' + String(i + 1).padStart(2, '0') })).concat([
    { id: '70044', name: 'SPARE SAT T', missAt: '2026-09-10T00:00:00Z' },
    { id: '70090', name: 'NEWSAT A' },
    { id: '70113', name: 'SAT TEST CIS1' },
    { id: '70083', name: 'OLDSAT T' },
    { id: '88888', name: 'GHOST' },
    { id: '900001', name: 'SIM-1' }
  ])
}
const g2 = { id: 'sg2', name: 'GEO 组', color: '#ff6b6b', sats: [{ id: '70020', name: 'GEOSAT-A' }, { id: '70021', name: 'GEOSAT-B' }, { id: '70115', name: 'GEOSAT-C' }] }

const res = S.groupResolve(g1, gpIdx, idx)
eq(res.total, 18, '组成员总数')
eq(res.inGp.length, 12, '四类之一：在最新星历中')
eq(res.absent.map((e) => e.id), ['70044', '70090', '70113'], '四类之二：不在星历但编目未陨落')
eq(res.absent[0].missAt, '2026-09-10T00:00:00Z', '缺席观察时刻原样带出')
eq(res.decayed.map((e) => e.id), ['70083'], '四类之三：编目已陨落')
eq(res.unknown.map((e) => e.id), ['88888', '900001'], '四类之四：编目查无此号')
eq(res.customCount, 1, '其中自定义号段 1 颗')
eq(res.inGp.length + res.absent.length + res.decayed.length + res.unknown.length, res.total, '四类之和 = 成员数')
eq(S.groupResolve(null, gpIdx, idx).total, 0, '空组不抛错')

const mem = S.groupMembers(g1, gpIdx, idx, { asOf })
eq(mem.length, 18, '成员表行数 = 成员数')
eq(mem.map((m) => m.id)[0], '70001', '成员表按 NORAD 升序')
const m1 = mem.find((m) => m.id === '70001')
eq(m1.source, 'GP', '有星历的成员：轨道量取 GP')
eq([m1.perigeeKm, m1.apogeeKm, m1.periodMin, m1.raanDeg], [540.4, 545.4, 95.5, 0], 'GP 换算的近 / 远地点与周期 / RAAN')
eq([m1.epochAgeDays, m1.ageDays], [1, 929], '历元龄与在轨天数都由 asOf 算')
const m44 = mem.find((m) => m.id === '70044')
eq([m44.source, m44.perigeeKm, m44.apogeeKm, m44.raanDeg], ['SATCAT', 690, 700, null], '无星历的成员退回 SATCAT，且没有 RAAN')
const mGhost = mem.find((m) => m.id === '88888')
eq([mGhost.source, mGhost.regime, mGhost.owner], ['—', '—', ''], '编目查无此号：两边都没有，来源列记 —')

const pc = S.planeClusters(mem, {})
eq(pc.shells.length, 1, '一个倾角壳（53°）')
eq(pc.shells[0].planeCount, 3, '★ 面数 3')
eq([pc.shells[0].perPlaneMin, pc.shells[0].perPlaneMax], [4, 4], '★ 每面 4 颗')
eq(pc.shells[0].planes.map((p) => p.raanDeg), [0, 120, 240], '三个面的 RAAN 锚点')
eq([pc.shells[0].spacingDeg, pc.shells[0].spacingMinDeg, pc.shells[0].spacingMaxDeg], [120, 120, 120], '面间间隔')
eq(S.planeClusters([], {}).shells.length, 0, '空成员表不抛错')

const vs = S.groupVsCatalog(mem, rows)
eq(vs.byRegime.map((r) => [r.regime, r.groupPayloads, r.catalogPayloads]), [['LEO', 15, 21]], '本组在轨载荷占同区制比例的分子分母')
eq(vs.owners.map((o) => o.owner), ['PRC', 'CIS', 'US'], '所有者构成按颗数降序、并列按代码升序')

const mem2 = S.groupMembers(g2, gpIdx, idx, { asOf })
eq(mem2.map((m) => m.geoSlot), ['110.0°E', '110.1°E', '20.0°E'], 'GEO 成员带定点标注')

// ===================================================================================
// 8. 报告模型
// ===================================================================================
const doc = { title: '', docNo: 'SSA-2026-001', classification: '内部', org: '中国卫通', date: '2026-09-16', logo: null, fonts: null, appVersion: '1.4.10', generatedAt: '2026-09-16T08:00:00Z' }
const dataMeta = { satcatAt: '2026-09-16 01:37', satcatSource: 'cloud', satcatRows: rows.length, gpAt: '2026-09-16 02:10', gpSource: 'network', gpRows: gp.length, gpGroups: 17, asOf }
const build = (over) => RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: {}, lang: 'zh', doc, dataMeta, ...over })

const mAll = build()
eq(mAll.kind, 'ssa', '模型 kind')
// 2026-10-15 二期重排：关键指标在前、数据与方法第二、编目与区制合章、新增碎片章、星历时效并入数据与方法
const APX = ['appendix', 'appendix-b', 'appendix-c']
eq(mAll.sections.map((s) => s.key), ['summary', 'meta', 'catalog', 'owner', 'launch', 'debris', 'constellation', 'geo', ...APX], '全量章节 key 与顺序（附录拆 A / B / C 三篇）')
eq(mAll.sections.map((s) => s.no), ['', '1', '2', '3', '4', '5', '6', '7', 'A', 'B', 'C'], '关键指标页不编号（前置部分），正文章号连续，附录按字母编')
eq(mAll.opts, { recentDays: 30, topN: 15, geoArc: [60, 150], months: 24, rowCap: 500, constellations: [], owners: [], regimes: [], types: [] }, '缺省参数（四道筛选默认全空 = 不筛）')
eq(mAll.scope, { mode: 'all', groups: [], filters: { constellations: [], owners: [], regimes: [], types: [] }, filtered: false, rows: rows.length, rowsTotal: rows.length }, '不筛时 scope 如实报「没筛」')
eq(mAll.data.asOf, asOf, '基准时刻原样进模型')
eq(mAll.doc.title, '空间态势报告', '缺省报告名（全量）')

const blocksOf = (m) => m.sections.flatMap((s) => s.blocks)
const tablesOf = (m) => blocksOf(m).filter((b) => b.type === 'table')
const figsOf = (m) => blocksOf(m).filter((b) => b.type === 'figure')

for (const b of blocksOf(mAll)) ok(['kv', 'table', 'figure', 'kpi', 'refs'].indexOf(b.type) >= 0, '块型只有五种：' + b.type)
const tids = tablesOf(mAll).map((t) => t.tableId)
eq(tids.length, new Set(tids).size, 'tableId 全篇唯一')
const fids = figsOf(mAll).map((f) => f.figId)
eq(fids.length, new Set(fids).size, 'figId 全篇唯一')
for (const f of figsOf(mAll)) {
  ok(mAll.figures[f.figId], '每个 figure 块在 figures 里有 spec：' + f.figId)
  eq(mAll.figures[f.figId].png, null, 'png 出厂为 null（由渲染端导出前填）')
}
for (const t of tablesOf(mAll)) {
  // 附录的判据表不给 source（它逐行第四列自带来源），其余表只有三种
  ok(!t.source || ['SATCAT', 'GP', 'SATCAT+GP'].indexOf(t.source) >= 0, '表的 source 只有三种：' + t.tableId + ' ' + t.source)
  for (const r of t.rows) eq(r.length, t.head.length, '表 ' + t.tableId + ' 行列数一致')
}
const tCat = tids.indexOf('t.catalog.type')
eq(tablesOf(mAll)[tCat].rows.length, 5, '编目总览表 4 类型 + 合计行')
eq(tablesOf(mAll)[tCat].head.length, 5, '编目总览表 5 列')
const tOwner = tablesOf(mAll).find((t) => t.tableId === 't.owner.top')
eq(tOwner.emphasisRows, undefined, '所有者表不再有强调行（「重点所有者」2026-09-17 删）')
const tEpoch = tablesOf(mAll).find((t) => t.tableId === 't.epoch.age')
eq(tEpoch.warnCells, [[0, 4]], '历元龄 > 7 天的格进 warnCells')
const critBlk = blocksOf(mAll).find((b) => b.tableId === 't.appendix.criteria')
ok(critBlk && critBlk.type === 'table' && critBlk.rows.length >= 9, '口径与判据一节（正式三线表，不再是 note 块）')
ok(!blocksOf(mAll).some((b) => b.type === 'note'), 'note 块型已删，全篇一个都没有')

// 章节开关
const mFew = build({ opts: { sections: { owner: false, geo: false, debris: false } } })
eq(mFew.sections.map((s) => s.key), ['summary', 'meta', 'catalog', 'launch', 'constellation', ...APX], '关掉的整章跳过')
eq(mFew.sections.map((s) => s.no), ['', '1', '2', '3', '4', 'A', 'B', 'C'], '关章后章号仍连续')
ok(build({ opts: { sections: { meta: false } } }).sections.some((s) => s.key === 'meta'), 'meta 章不可关')

// 卫星组范围
const mGrp = build({ groups: [g1, g2], scope: 'groups' })
eq(mGrp.sections.map((s) => s.key), ['meta', 'g:sg1', 'g:sg2', ...APX], '卫星组范围的章节 key')
// ★ 附录不是组章，不从主计数器再拿一个号 —— 那样它会拿到「2」而排在 G2 之后（1 / G1 / G2 / 2）
eq(mGrp.sections.map((s) => s.no), ['1', 'G1', 'G2', 'A', 'B', 'C'], '组章章号 G1 / G2，附录按字母编（不拿数字号）')
eq(mGrp.sections[1].title, 'TESTSAT 组', '组章标题＝组名（自命名不翻）')
eq(mGrp.scope.groups, [{ id: 'sg1', name: 'TESTSAT 组', count: 18 }, { id: 'sg2', name: 'GEO 组', count: 3 }], 'scope 带每组成员数')
eq(mGrp.scope.mode, 'groups', 'scope.mode')
eq(mGrp.doc.title, 'TESTSAT 组、GEO 组 空间态势报告', '缺省报告名（卫星组）')
const g1Caps = mGrp.sections[1].blocks.map((b) => b.caption)
// #7（2026-10-16）：题注不再自带「G1.n」前缀 —— 表号 / 图号由两端按章编号，原先印成「表 G1-2　G1.3 …」
eq(g1Caps[0], '概况', '组章块题注不带小节号前缀')
ok(mGrp.sections.every((s) => s.blocks.every((b) => !/^G\d+\.\d/.test(b.caption || ''))), '任何组章块题注都不以 Gn.m 开头')
ok(g1Caps.some((c) => c.startsWith('GEO 成员定点')) === false, '本组没有 GEO 成员就不出 G1.5')
ok(mGrp.sections[2].blocks.some((b) => (b.caption || '').startsWith('GEO 成员定点')), 'GEO 组出 G2.5')
const g1Tables = mGrp.sections[1].blocks.filter((b) => b.type === 'table').map((b) => b.tableId)
eq(g1Tables, ['t.g1.members', 't.g1.planes', 't.g1.recent', 't.g1.lost', 't.g1.inactive'], 'G1 的五张表')
const gMem = mGrp.sections[1].blocks.find((b) => b.tableId === 't.g1.members')
eq([gMem.head.length, gMem.rows.length], [19, 18], '成员表 19 列 × 18 行')
ok(!('capped' in gMem), '未截断时不落 capped 键')

// 超长成员表截断
const big = { id: 'sgBig', name: '大组', sats: [...Array(600)].map((_, i) => ({ id: String(800001 + i), name: 'X' + i })) }
const mBig = build({ groups: [big], scope: 'groups' })
const bigMem = mBig.sections[1].blocks.find((b) => b.tableId === 't.g1.members')
eq(bigMem.rows.length, 500, '屏上成员表封顶 500 行')
eq(bigMem.capped, { shown: 500, total: 600 }, '截断时给读数')

// 纯数据
const walk = (v, path, bad) => {
  if (v === undefined) { bad.push(path + ' = undefined'); return }
  if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(path + ' = ' + String(v)); return }
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') { bad.push(path + ' : ' + typeof v); return }
  if (v === null || typeof v !== 'object') return
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']', bad); return }
  for (const k of Object.keys(v)) walk(v[k], path + '.' + k, bad)
}
for (const [name, m] of [['全量', mAll], ['卫星组', mGrp]]) {
  const bad = []
  walk(m, name, bad)
  eq(bad, [], name + '模型里无 undefined / NaN / Infinity / 函数')
  eq(JSON.parse(JSON.stringify(m)), m, name + '模型 JSON 往返后深相等')
}

// 确定性：同一份数据 + 同一个 asOf，两次 build 逐字相同
eq(JSON.stringify(build()), JSON.stringify(mAll), '★ asOf 相同 → 两次 build 的模型逐字相同')
eq(JSON.stringify(build({ groups: [g1, g2], scope: 'groups' })), JSON.stringify(mGrp), '★ 卫星组范围同样确定性')

// 英文版
const HAN = /[一-鿿]/
const mEn = build({ lang: 'en' })
const leaks = []
for (const s of mEn.sections) {
  if (HAN.test(s.title)) leaks.push('title: ' + s.title)
  for (const b of s.blocks) {
    if (b.caption && HAN.test(b.caption)) leaks.push('caption: ' + b.caption)
    for (const h of (b.head || [])) if (HAN.test(h)) leaks.push('head: ' + h)
  }
}
eq(leaks, [], '★ 英文版所有 title / caption / head 不含汉字')
eq(mEn.doc.title, 'Space Situational Awareness Report', '英文缺省报告名')
eq(RP.ssaReportFileName('all', [], asOf, 'zh'), '空间态势报告_20260916', '缺省文件名（全量）')
eq(RP.ssaReportFileName('groups', [{ name: 'A/B:C' }], asOf, 'zh'), '空间态势报告_A_B_C_20260916', '文件名里的非法字符换成下划线')
eq(RP.ssaReportTitle('groups', [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }], 'zh'), 'A等 4 组 空间态势报告', '> 3 组的报告名')

// 只列真用到的参数：卫星组报告里没有所有者榜 / 重点弧段，第 1 章就不列这三行
const metaOf = (m) => m.sections.find((s) => s.key === 'meta')
const metaKeysAll = metaOf(mAll).blocks[1].rows.map((r) => r[0])
const metaKeysGrp = metaOf(mGrp).blocks[1].rows.map((r) => r[0])
ok(metaKeysAll.indexOf('GEO 重点弧段') >= 0, '全量报告列出 GEO 重点弧段')
eq(metaKeysGrp.filter((k) => ['逐月统计（月）', '排名条数', 'GEO 重点弧段'].indexOf(k) >= 0), [], '卫星组报告不列全量专用参数')
// 成员表行数只管卫星组报告的成员表：全量报告不列它，组报告列
ok(metaKeysAll.indexOf('成员表行数上限') < 0 && metaKeysGrp.indexOf('成员表行数上限') >= 0, '成员表行数只在卫星组报告里列')
ok(metaKeysAll.indexOf('逐月统计（月）') >= 0, '全量报告列出逐月统计月数')

// 经度区间右端点：fmtGeoSlot 把 180 折成 180.0°W，右端点要单独印成 180.0°E
const mArc = build({ opts: { geoArc: [150, 180] } })
const arcCap = mArc.sections.find((s) => s.key === 'geo').blocks.find((b) => b.tableId === 't.geo.arc')
ok(!arcCap || arcCap.caption.indexOf('180.0°E') > 0, '重点弧段题注的右端点印 180.0°E')
ok(mArc.sections.find((s) => s.key === 'geo').blocks[0].rows.some((r) => r[1].indexOf('180.0°E') > 0), '读数行里的弧段同样')

// 空输入
const mEmpty = RP.buildSsaModel({ satcat: [], gp: [], groups: [], scope: 'all', opts: {}, lang: 'zh', doc: {}, dataMeta: { asOf } })
eq(mEmpty.sections.map((s) => s.key), ['summary', 'meta', 'catalog', 'owner', 'launch', 'geo', 'appendix', 'appendix-c'], '空数据：无物可报的章（碎片 / 星座）、无代码表时整章不出，其余照出')
const badEmpty = []
walk(mEmpty, '空', badEmpty)
eq(badEmpty, [], '空数据的模型同样纯数据')
eq(RP.buildSsaModel({}).kind, 'ssa', '完全空的入参不抛错')

// ===================================================================================
// 时刻一律过显示时区档：ISO 原串（…T01:37:09Z）不许上纸，且必须带时区角标
// ===================================================================================
{
  const ts = { satcatAt: '2026-09-16T01:37:09Z', gpAt: '2026-09-16T01:37:09Z', asOf: '2026-09-16T12:00:00Z' }
  const tsOf = (m) => m.sections.find((s) => s.key === 'meta').blocks[0].rows[0][1]
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 'utc', doc: {}, dataMeta: ts })),
    '2026-09-16 01:37 UTC', '时刻按 UTC 档格式化，带角标')
  // ★ 固定档位的单位是【分钟】不是小时（tz.js 的 normTzMode / tzOffMin）：480 才是 UTC+8
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 480, doc: {}, dataMeta: ts })),
    '2026-09-16 09:37 UTC+8', '固定时区档 UTC+8')
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: -300, doc: {}, dataMeta: ts })),
    '2026-09-15 20:37 UTC−5', '西五区跨了一天')
  const m0 = RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf: '' } })
  eq(tsOf(m0), '—', '缺时刻印破折号，不印 Invalid Date')
  // 成员表的「历元」列：GP CSV 里是 `2026-09-15T00:00:00.000000`（无时区后缀、六位小数），
  // 直接上纸就是一列读不动的机器串；且不带 Z 时 Date.parse 按本机时区解，会整体偏一个时差
  const mg = RP.buildSsaModel({ satcat: rows, gp, groups: [{ id: 'g1', name: 'G', sats: [{ id: '70001' }] }], scope: 'groups', opts: {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const mem = mg.sections.flatMap((s) => s.blocks).find((b) => b.type === 'table' && /成员表/.test(b.caption || ''))
  eq(mem.head[14], '历元', '成员表第 15 列是历元')
  eq(mem.rows[0][14], '2026-09-15 00:00 UTC', '历元过显示时区档（无后缀的 EPOCH 按 UTC 解，不按本机）')

  // 通篇不许有没格式化过的 ISO 串漏出去（两种范围各扫一遍 —— 历元列只在卫星组报告里）
  const isoLeak = []
  const scanIso = (m) => JSON.stringify(m, (k, v) => {
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) && !['asOf', 'satcatAt', 'gpAt', 'generatedAt', 'missAt'].includes(k)) isoLeak.push(k + '=' + v)
    return v
  })
  scanIso(RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: {}, lang: 'zh', tz: 'utc', doc: { generatedAt: ts.asOf }, dataMeta: ts }))
  scanIso(mg)
  // 缺席观察时刻（3D 页存进卫星组的 ISO 串）同样得格式化
  const mMiss = RP.buildSsaModel({ satcat: rows, gp, groups: [{ id: 'g1', name: 'G', sats: [{ id: '70043', missAt: '2026-09-02T00:00:00Z' }] }], scope: 'groups', opts: {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const lost = mMiss.sections.flatMap((s) => s.blocks).find((b) => b.type === 'table' && /缺席成员/.test(b.caption || ''))
  eq(lost.rows[0][4], '2026-09-02 00:00 UTC', '缺席观察时刻也过显示时区档')
  scanIso(mMiss)
  eq(isoLeak, [], '除 data/doc 里留的原值外，章节内容里没有裸 ISO 串')
}

// ===================================================================================
// 四道筛选：典型星座 / 所有者 / 轨道区制 / 对象类型，可叠加（交集）
// ===================================================================================
{
  const nf = S.normFilters
  eq(nf({}), { constellations: [], owners: [], regimes: [], types: [] }, '空入参 → 四维全空')
  eq(nf({ owners: ['US', 'PRC', 'US', '  ', null] }).owners, ['PRC', 'US'], '去空 / 去重 / 排序（同一组条件必须建出逐字相同的报告）')
  eq(S.hasFilters(nf({})), false, '全空 = 不筛')
  eq(S.hasFilters(nf({ types: ['PAY'] })), true, '给了一维就是在筛')
  ok(S.filterRows(rows, nf({})) === rows, '不筛时原样返回同一个数组，不白拷 7 万行')

  const cnt = (f) => S.filterRows(rows, nf(f)).length
  const byOwner = rows.filter((r) => r.owner === 'PRC').length
  eq(cnt({ owners: ['PRC'] }), byOwner, '所有者筛')
  eq(cnt({ types: ['PAY'] }), rows.filter((r) => r.type === 'PAY').length, '类型筛')
  eq(cnt({ regimes: ['LEO'] }), rows.filter((r) => S.regimeOf(r) === 'LEO').length, '区制筛')
  // ★ 叠加是交集，不是并集
  eq(cnt({ owners: ['PRC'], types: ['PAY'] }), rows.filter((r) => r.owner === 'PRC' && r.type === 'PAY').length, '两维叠加 = 交集')
  ok(cnt({ owners: ['PRC'], types: ['PAY'] }) <= Math.min(cnt({ owners: ['PRC'] }), cnt({ types: ['PAY'] })), '交集不大于任一维单筛')
  eq(cnt({ owners: ['PRC', 'US'] }), rows.filter((r) => r.owner === 'PRC' || r.owner === 'US').length, '同一维多值 = 并集')
  eq(cnt({ owners: ['ZZZZ'] }), 0, '筛不出东西就是 0 行，不回落成全量')
  // ★ 无根数的行在区制筛生效时一律落选（判不出来，不是「不属于」）
  const noEl2 = rows.filter((r) => S.regimeOf(r) === '—')
  ok(noEl2.length > 0, '夹具里有判不出区制的行')
  for (const rg of ['LEO', 'MEO', 'GEO', 'IGSO', 'HEO']) {
    ok(S.filterRows(rows, nf({ regimes: [rg] })).every((r) => S.regimeOf(r) !== '—'), `区制筛 ${rg} 不带出「—」的行`)
  }
  eq(cnt({ regimes: ['—'] }), noEl2.length, '想单看判不出区制的，显式选「—」')

  // GP 只按星座名前缀筛（星历里没有所有者与类型两列）
  ok(S.filterGp(gp, nf({ owners: ['PRC'] })) === gp, 'GP 不受所有者筛影响')
  eq(S.filterGp(gp, nf({ constellations: ['starlink'] })).length, gp.filter((g) => S.constKeyOf(g.name) === 'starlink').length, 'GP 按星座名筛')

  // 所有者下拉的排序：按在轨载荷降序
  const oo = S.ownerOptions(rows)
  ok(oo.length > 0 && oo.every((e, i) => i === 0 || oo[i - 1].payloads >= e.payloads), 'ownerOptions 按在轨载荷降序')

  // —— 模型层 ——
  const mk = (f) => RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: f, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf, satcatRows: rows.length } })
  const mf = mk({ owners: ['PRC'], types: ['PAY'] })
  eq(mf.scope.filtered, true, '模型如实报「筛过」')
  eq(mf.scope.filters, { constellations: [], owners: ['PRC'], regimes: [], types: ['PAY'] }, '模型带回生效的筛选')
  eq([mf.scope.rows, mf.scope.rowsTotal], [cnt({ owners: ['PRC'], types: ['PAY'] }), rows.length], '筛前 / 筛后条数都进模型')
  // 第 1 章要把筛选逐维列出来 + 给出筛前筛后条数
  const metaKv = mf.sections.find((s) => s.key === 'meta').blocks.filter((b) => b.type === 'kv')
  const flat = metaKv.flatMap((b) => b.rows)
  ok(flat.some((r) => r[0] === '所有者' && r[1].indexOf('PRC') === 0), '第 1 章列出「所有者 = PRC 中国」')
  ok(flat.some((r) => r[0] === '对象类型' && /PAY/.test(r[1])), '第 1 章列出「对象类型 = PAY 载荷」')
  ok(flat.some((r) => r[0] === '本报告统计条数' && r[1].indexOf('/') > 0), '第 1 章给出「本报告统计条数 = 筛后 / 总数」')
  ok(mf.sections.find((s) => s.key === 'meta').blocks.some((b) => b.caption === '筛选条件'), '筛了就多出「筛选条件」这一块')
  // 不筛时这两样都不出现（没用上的口径不该给读者一行）
  const flat0 = metaOf(mAll).blocks.filter((b) => b.type === 'kv').flatMap((b) => b.rows)
  ok(!flat0.some((r) => r[0] === '本报告统计条数'), '不筛时不出「本报告统计条数」这一行')
  ok(!metaOf(mAll).blocks.some((b) => b.caption === '筛选条件'), '不筛时不出「筛选条件」这一块')

  // 各表都吃同一份筛过的子集：第 2 章合计 = scope.rows
  const ovRow = mf.sections.find((x) => x.key === 'catalog').blocks.find((b) => b.type === 'table').rows.slice(-1)[0]
  eq(Number(ovRow[4]), mf.scope.rows, '★ 筛过之后，编目总览的「合计」= 本报告统计条数（各章吃同一份子集）')

  // 报告名与文件名带上筛选摘要
  eq(mf.doc.title, '中国 载荷 空间态势报告', '报告名带筛选摘要')
  eq(RP.ssaReportFileName('all', [], asOf, 'zh', '中国 载荷'), '空间态势报告_中国_载荷_20260916', '文件名带筛选摘要（空白折成下划线）')
  const mfEn = RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { owners: ['PRC'] }, lang: 'en', tz: 'utc', doc: {}, dataMeta: { asOf } })
  eq(mfEn.doc.title, "People's Republic of China Space Situational Awareness Report", '英文报告名')

  // 同样的筛选条件，两次 build 逐字相同（normFilters 排过序，入参顺序不影响结果）
  const a1 = JSON.stringify(mk({ owners: ['US', 'PRC'] }))
  const a2 = JSON.stringify(mk({ owners: ['PRC', 'US'] }))
  eq(a1 === a2, true, '入参顺序不同、结果逐字相同（可复现）')
}

// ===================================================================================
// 口径与判据：四列（类别 | 项 | 判据 | 数据来源），且随范围与筛选增删
// ===================================================================================
{
  const noteOf = (m) => m.sections.flatMap((x) => x.blocks).filter((b) => b.tableId === 't.appendix.criteria')
  const nAll = noteOf(mAll)
  eq(nAll.length, 1, '判据表全篇恰一张（在附录）')
  ok(!nAll[0].source, '判据表不挂全局数据来源标（逐行第四列已经标了）')
  eq(nAll[0].head, ['类别', '项', '判据', '数据来源'], '四列表头')
  ok(nAll[0].rows.every((r) => r.length === 4), '每行四格')
  const cats = [...new Set(nAll[0].rows.map((r) => r[0]).filter(Boolean))]
  eq(cats, ['对象状态', '对象属性', '轨道', '时间', '归类方法'], '类别按「状态 → 属性 → 轨道 → 时间 → 归类」排，不混着来')
  const srcs = [...new Set(nAll[0].rows.map((r) => r[3]))]
  ok(srcs.every((x) => x), '每条都标了数据来源')
  ok(srcs.indexOf('名称近似') > -1, '按名称猜的那条明说是近似')
  // 「近 N 天」要写真实的 N，不能字面留个 N
  const recent = nAll[0].rows.find((r) => /^近 \d+ 天$/.test(r[1]))
  ok(recent && recent[1] === '近 30 天', `项名写真实天数：${recent && recent[1]}`)
  ok(!nAll[0].rows.some((r) => /%n/.test(r[2])), '判据里的槽位都替换掉了')
  const m7 = RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { recentDays: 7 }, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  ok(noteOf(m7)[0].rows.some((r) => r[1] === '近 7 天'), '改了近期窗口，判据表跟着改')
  // 卫星组报告换掉两条（共位 / 星座名称模式 → 轨道面估计 / 成员四类）
  const nGrp = noteOf(mGrp)[0]
  ok(nGrp.rows.some((r) => r[1] === '轨道面估计') && !nGrp.rows.some((r) => r[1] === '共位'), '组报告出轨道面估计、不出共位')
  ok(nGrp.rows.some((r) => r[1] === '成员四类'), '组报告出成员四类')
  // 筛选生效时多出「筛选条件」一类
  const nF = noteOf(RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { regimes: ['GEO'], constellations: ['starlink'] }, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } }))[0]
  // 类别只在组首行出现（blankCols），按组向下补齐再比
  let curCat = ''
  const nFfill = nF.rows.map((r) => { if (r[0]) curCat = r[0]; return [curCat].concat(r.slice(1)) })
  ok(nFfill.some((r) => r[0] === '筛选条件' && r[1] === '轨道区制'), '筛了区制就在判据表里写明')
  ok(nF.rows.some((r) => r[1] === '区制筛选的边界'), '并交代「判不出区制的一律落选」这条边界')
  ok(nF.rows.some((r) => r[1] === '星座筛选的边界'), '星座筛的近似性也交代')
  ok(!nAll[0].rows.some((r) => r[0] === '筛选条件'), '没筛就不出这一类')
  // 英文版四列表头
  const nEn = noteOf(RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: {}, lang: 'en', tz: 'utc', doc: {}, dataMeta: { asOf } }))[0]
  eq(nEn.head, ['Category', 'Item', 'Definition', 'Source'], '英文四列表头')
  ok(!/[\u4e00-\u9fa5]/.test(JSON.stringify(nEn)), '英文判据表无汉字')
}

// ===================================================================================
// 属性查询 vs 统计口径：筛选只决定「哪些星进统计」，不该让「查得到的星」变成查不到
// ===================================================================================
{
  const g = { id: 'sg1', name: 'TESTSAT 组', sats: [{ id: '70001' }, { id: '70002' }, { id: '70040' }] }
  const mk = (opts) => RP.buildSsaModel({ satcat: rows, gp, groups: [g], scope: 'groups', opts, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const secOf = (m) => m.sections.find((s) => s.key.indexOf('g:') === 0)
  const kvOf = (m) => { const rs = secOf(m).blocks[0].rows; return (k) => (rs.find((r) => r[0].indexOf(k) === 0) || [])[1] }
  const ownersOf = (m) => secOf(m).blocks.find((b) => b.type === 'table' && /成员表/.test(b.caption || '')).rows.map((r) => r[3])
  const base = mk({})
  // ★ 成员是用户点名的那几颗，属性一律查【全量】索引 —— 编目侧 idxAll、星历侧 gpIdxAll。
  //   拿筛后的查，被筛掉的成员会被误报成「编目查无此号」/「不在星历」，所有者 / 状态 / 类型
  //   几列一并变空（模块说明 §1 写死了这条口径）。
  //   ★ 星历侧那两条是 2026-09-17 补的回归闸：在此之前 gpIdx 由【筛后】的星历建，
  //     「典型星座＝GPS」再看一个非 GPS 的组，三个成员里两个被判成「不在星历」（1 / 2，
  //     补丁后 3 / 0），G.2 成员表的根数列一并变空。
  for (const f of [{ constellations: ['gps'] }, { owners: ['US'] }, { types: ['PAY'] }, { regimes: ['GEO'] }]) {
    const m = mk(f)
    eq(kvOf(m)('编目查无此号'), kvOf(base)('编目查无此号'), '★ 筛 ' + JSON.stringify(f) + ' 不会把成员误报成「编目查无此号」')
    eq(kvOf(m)('在最新星历中'), kvOf(base)('在最新星历中'), '★ 筛 ' + JSON.stringify(f) + ' 不会把成员误报成「不在星历」')
    eq(kvOf(m)('不在星历'), kvOf(base)('不在星历'), '★ 筛 ' + JSON.stringify(f) + ' 不改「不在星历」计数')
    eq(kvOf(m)('活跃状态'), kvOf(base)('活跃状态'), '★ 筛 ' + JSON.stringify(f) + ' 不改成员的活跃状态计数')
    eq(ownersOf(m), ownersOf(base), '★ 筛 ' + JSON.stringify(f) + ' 不把成员表的所有者列抹空')
  }
  // 第 7 / 8 章要同时钉住两件相反的事，2026-09-17 一并补：
  //   · 【统计口径】跟着筛选走 —— 星历侧原先只筛得动星座名前缀，所有者 / 区制 / 类型三维对它
  //     是 no-op，于是「所有者＝中国」的报告里 GEO 轨道弧与星历时效印的还是全世界的数
  //     （真编目实测 483 颗定点 / 16561 条星历一个没少，而第 1 章明写着筛选条件）；
  //   · 【回填属性】不跟筛选走 —— 表里的代码 / 所有者 / 状态三列走全量 idxAll，不许因筛选变空。
  // 夹具三颗 GEO：US 一颗、PRC 两颗（两颗共位，且都落在 60–150°E 的重点弧段里）。
  const mAll_ = (opts) => RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const geoOf = (opts) => {
    const sec = mAll_(opts).sections.find((s) => s.key === 'geo')
    const kvr = sec.blocks[0].rows
    return {
      slots: Number((kvr.find((r) => r[0].indexOf('定点解算成功') === 0) || [])[1]),
      arc: sec.blocks.find((b) => b.tableId === 't.geo.arc')
    }
  }
  const epochN = (opts) => mAll_(opts).sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age').rows[0][1]
  eq(geoOf({}).slots, 3, 'GEO 章不筛时数满三颗')
  eq(geoOf({ owners: ['US'] }).slots, 1, '★ 筛 US：GEO 章只数 US 那一颗（补丁前是全量 3）')
  eq(geoOf({ owners: ['PRC'] }).slots, 2, '★ 筛 PRC：GEO 章只数 PRC 那两颗（补丁前是全量 3）')
  // 筛 LEO：GEO 章整章不出（2026-10-15 筛选感知；之前是出一章、定点数为 0）
  ok(!mAll_({ regimes: ['LEO'] }).sections.some((x) => x.key === 'geo'), '★ 筛 LEO：GEO 章整章不出')
  eq(geoOf({ types: ['DEB'] }).slots, 0, '★ 筛碎片：夹具里没有 GEO 碎片，定点数为 0')
  const arcCn = geoOf({ owners: ['PRC'] }).arc
  eq(arcCn ? arcCn.rows.length : -1, 2, '筛 PRC 时重点弧段表里正是本国那两颗')
  eq(arcCn.rows.filter((r) => !r[3] || !r[4]).length, 0, '★ 筛选生效时重点弧段表的所有者 / 状态列不留空')
  eq(epochN({}), 18, '星历时效章不筛时是星历并集全量')
  eq(epochN({ owners: ['PRC'] }), 15, '★ 星历时效章也跟着筛选缩（补丁前恒等于全量 18）')
  eq(epochN({ types: ['DEB'] }), 0, '★ 筛碎片：夹具星历里没有碎片，本章为空')

  // 第 6 章：一行里左半边（编目）与右半边（星历）必须同口径
  const mcF = RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { owners: ['PRC'] }, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const cdF = mcF.sections.find((s) => s.key === 'constellation').blocks[0]
  eq(cdF.rows.filter((r) => Number(r[1]) === 0 && Number(r[7]) > 0).map((r) => r[0]), [],
    '★ 非星座维筛选生效时星历侧跟着编目侧筛，不出「累计发射 0 / 星历颗数 N」这种行')
  ok(cdF.rows.some((r) => r[0] === '北斗' && Number(r[7]) > 0), '同一维度里筛得中的星座，星历列照常有数')
}

// ===================================================================================
// 分箱：图题写明量程时，越界值不许并进末桶
// ===================================================================================
{
  eq(S.histBins([1, 5, 9, 12], 0, 10, 5).bins.map((b) => b.n), [1, 3], '缺省：越界值并入末桶（倾角这类满量程的图要的就是这个）')
  eq(S.histBins([1, 5, 9, 12], 0, 10, 5, { dropOver: true }).bins.map((b) => b.n), [1, 2], '★ dropOver：越界值不入桶')
  eq(S.histBins([1, 5, 9, 12], 0, 10, 5, { dropOver: true }).over, 1, 'over 仍如实计数')
  eq(S.histBins([1, 5, 10], 0, 10, 5, { dropOver: true }).bins.map((b) => b.n), [1, 2], '恰好等于上界的仍落末桶（只丢 v > hi）')
  // 密度格同理：高度越界的不压进顶行
  const hRow = (alt) => ({ inclDeg: 50, perigeeKm: alt, apogeeKm: alt })
  const hg = S.heatGrid([hRow(39500), hRow(45000), hRow(60000)], { incStep: 5, altMax: 40000, altStep: 500 })
  eq(hg.cells[hg.cells.length - 1].reduce((a, x) => a + x, 0), 1, '★ 密度格顶行只算落在量程内的')
  eq(hg.over, 2, '越界的另计 over')
}

// ===================================================================================
// 星历时效（2026-10-15 并入「数据与方法」、直方图删）：表照常随数据走，颗数不丢负历元龄
// ===================================================================================
{
  const ep = (m) => m.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age')
  ok(ep(mAll) && mAll.sections.find((s) => s.key === 'meta').blocks.indexOf(ep(mAll)) > -1, '星历表在「数据与方法」一章')
  ok(!Object.keys(mAll.figures).some((k) => /epoch/.test(k)), '历元龄直方图已删')
  const mOld = build({ dataMeta: { ...dataMeta, asOf: '2027-03-16T00:00:00Z' } })
  ok(ep(mOld).rows[0][4] > 30, '半年后的快照：最大历元龄照实给')
}

// ===================================================================================
// 所有者表：表 = 前 topN 行 + 其余 + 合计行
// ===================================================================================
{
  // 夹具只有 7 个所有者，撑不到图的 20 条切口，构一份 30 个所有者的合成编目
  const synth = []
  let k = 0
  for (let o = 0; o < 30; o++) {
    const code = 'O' + String(o).padStart(2, '0')
    for (let j = 0; j <= 30 - o; j++) {
      synth.push({ norad: String(500000 + (k++)), name: 'SYN-' + k, objectId: '', owner: code, launchDate: '2020-01-01', decayDate: '',
        status: '+', type: 'PAY', orbitType: 'ORB', orbitCenter: 'EA', periodMin: 95, inclDeg: 53, apogeeKm: 550, perigeeKm: 540, rcsM2: null, launchSite: '', dataStatus: '' })
    }
  }
  const mk = (opts) => RP.buildSsaModel({ satcat: synth, gp: [], groups: [], scope: 'all', opts, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const m25 = mk({ topN: 25 })
  const tb25 = m25.sections.find((s) => s.key === 'owner').blocks[0]
  eq(tb25.rows.length, 27, '★ 表 = 前 25 行 + 「其余 5 家」+ 合计行（不再往表尾追加钉住行）')
  eq(tb25.rows[25][0], '其余 5 家', '榜外 5 家并成一行')
  eq(tb25.emphasisRows, undefined, '表里没有强调行')
  ok(!m25.figures['f.owner.rank'], '所有者排名图已删（2026-10-15：被前两家压扁，数全在表里）')
}

// ===================================================================================
// 比例：只在格式化那一步四舍五入一次
// ===================================================================================
{
  const mR = build({ groups: [{ id: 'r1', name: '单星组', sats: [{ id: '70001' }] }], scope: 'groups' })
  const row = mR.sections[1].blocks[0].rows.find((r) => r[0].indexOf('占同区制') === 0)
  // 本组 1 颗 LEO 在轨载荷 / 全目录 21 颗 → 4.7619%；stats 层先量化到 0.001 会印成 4.80%
  eq(row[1], 'LEO 4.76%', '★ 比例不在 stats 层四舍五入（先 r3 再印两位小数，后两位全是量化噪声）')
  const vs1 = S.groupVsCatalog([{ id: '1', cls: 'inGp', type: 'PAY', regime: 'LEO', owner: 'US' }],
    [...Array(800)].map((_, i) => ({ norad: 'c' + i, name: 'C', owner: 'US', type: 'PAY', orbitType: 'ORB', orbitCenter: 'EA', decayDate: '', periodMin: 95, inclDeg: 53, apogeeKm: 550, perigeeKm: 540 })))
  eq(vs1.byRegime[0].ratio, 1 / 800, '★ ratio 出参是原始比值')
}

// ===================================================================================
// 2026-10-15 真编目审查的一期修复（docs/空间态势报告优化方案_2026-10-15.md §2）。
// 夹具撑不出这些病（57 行里没有印度 GSAT、铱星碎片、GLONASS 星历名），一律就地合成最小行，
// 每条断言写的是不变式而不是真编目上的颗数。
// ===================================================================================
{
  const R = (o) => ({ name: '', objectId: '', norad: '', type: 'PAY', status: '+', owner: 'US', launchDate: '2020-01-01', launchSite: '',
    decayDate: '', periodMin: 95, inclDeg: 53, apogeeKm: 550, perigeeKm: 540, rcsM2: null, dataStatus: '', orbitCenter: 'EA', orbitType: 'ORB', ...o })
  const G = (o) => ({ name: '', noradId: '', epoch: '2026-09-15T00:00:00', meanMotion: 15.1, ecc: 0.0001, incl: 53, raan: 0, argp: 0, meanAnomaly: 0, ...o })
  const mk = (satcat, gpRecs, opts, more) => RP.buildSsaModel({ satcat, gp: gpRecs, groups: [], scope: 'all', opts: opts || {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf }, ...(more || {}) })
  const sec = (m, k) => m.sections.find((s) => s.key === k)
  const tbl = (m, id) => m.sections.flatMap((s) => s.blocks).find((b) => b.tableId === id)

  part('#1', () => {
    // #1 Galileo 的名称模式不许吞掉印度 GSAT（GSAT-7 / GSAT-30 …）；#4 中国星网补 GUOWANG 前缀
    eq(S.constKeyOf('GSAT0101 (GALILEO-PFM)'), 'galileo', 'Galileo 星名 GSAT0nnn 归 galileo')
    eq(S.constKeyOf('GSAT-7'), '', '★ 印度 GSAT-7 不归 Galileo')
    eq(S.constKeyOf('GSAT-30'), '', '★ 印度 GSAT-30 不归 Galileo')
    eq(S.constKeyOf('GUOWANG 27 OBJECT A'), 'guowang', '★ GUOWANG 前缀归中国星网')
  
  })
  part('#2', () => {
    // #2 星座只数载荷：Iridium 33 的碎片不是铱星星座的成员
    const iri = [R({ norad: '1', name: 'IRIDIUM 106' }), R({ norad: '2', name: 'IRIDIUM 107' }),
      R({ norad: '3', name: 'IRIDIUM 33 DEB', type: 'DEB' }), R({ norad: '4', name: 'IRIDIUM 33 DEB', type: 'DEB' })]
    const cdI = S.constellationDeploy(iri, [], { asOf }).rows.find((r) => r.key === 'iridium')
    eq([cdI.launched, cdI.inOrbit], [2, 2], '★ 星座各列只数 PAY（碎片 2 条不进铱星）')
    eq(S.filterRows(iri, S.normFilters({ constellations: ['iridium'] })).length, 2, '★ 星座筛选与第 6 章同口径：只留载荷')
  
  })
  part('#3', () => {
    // #3 GP 侧按编目名归类：GLONASS 的星历名是「COSMOS 2433 (720)」，编目名才带 GLONASS
    const gloCat = [R({ norad: '32276', name: 'COSMOS 2433 [GLONASS-M]', periodMin: 675, inclDeg: 65, apogeeKm: 19140, perigeeKm: 19100 })]
    const gloGp = [G({ noradId: '32276', name: 'COSMOS 2433 (720)', meanMotion: 2.13, incl: 65 })]
    const gIdx = S.buildIndex(gloCat)
    eq(S.constellationDeploy(gloCat, gloGp, { asOf, index: gIdx }).rows.find((r) => r.key === 'glonass').gpCount, 1, '★ GLONASS 星历按编目名归类，星历颗数不再是 0')
    eq(S.epochAgeStats(gloGp, asOf, gIdx).byConst.map((c) => c.key), ['glonass'], '★ 星历时效按编目名归类')
    eq(S.filterGp(gloGp, S.normFilters({ constellations: ['glonass'] }), gIdx).length, 1, '★ 星历的星座筛选按编目名归类')
    const mGlo = mk(gloCat, gloGp)
    eq(Number(tbl(mGlo, 't.const.deploy').rows[0][7]), 1, '★ 第 6 章 GLONASS 行的星历颗数 = 1')
  
  })
  part('#5', () => {
    // #5 星座表「近 N 天」与第 5 章同一个窗口：按 UTC 日历日、随「近期明细」参数
    const asOfPm = '2026-09-16T15:00:00Z'
    const win = [R({ norad: '10', name: 'QIANFAN-1', launchDate: '2026-08-17' })]
    const rlW = S.recentLaunches(win, { asOf: asOfPm, days: 30 })
    const cdW = S.constellationDeploy(win, [], { asOf: asOfPm, days: 30 }).rows[0]
    eq([rlW.payloads.length, cdW.recent30], [1, 1], '★ 下午生成：窗口起点那天发射的星，第 5 / 6 章都算（不再一边 1 一边 0）')
    const cd7 = S.constellationDeploy([R({ norad: '11', name: 'QIANFAN-2', launchDate: '2026-09-01' })], [], { asOf, days: 7 }).rows[0]
    eq(cd7.recent30, 0, '★ 窗口随「近期明细」参数：7 天窗口不含 15 天前的发射')
    ok(tbl(mk(win, [], { recentDays: 7 }), 't.const.deploy').head.indexOf('近 7 天') > -1, '★ 星座表列头写真实天数')
  
  })
  part('#6', () => {
    // #6 第 8 章首行是「星历并集」，不是「全部在轨」；另给在轨覆盖率
    const ep = tbl(mAll, 't.epoch.age')
    eq(ep.rows[0][0], '星历并集', '★ 首行行名 = 星历并集')
    ok(ep.head.indexOf('在轨覆盖率') > -1, '★ 星历时效表有「在轨覆盖率」列')
    const cov = ep.rows[0][ep.head.indexOf('在轨覆盖率')]
    ok(/^\d+(\.\d+)?%$/.test(cov), '覆盖率印成百分数：' + cov)
  
  })
  part('#7', () => {
    // #7 第 7 章 GEO 读数能与第 3 章对账：编目在轨 GEO / 其中有星历 / 定点解算成功
    const geoKv = sec(mAll, 'geo').blocks[0].rows.map((r) => r[0])
    ok(geoKv.indexOf('编目在轨 GEO 对象') > -1 && geoKv.indexOf('其中有星历') > -1, '★ GEO 读数补编目侧两行')
    const geoReg = tbl(mAll, 't.regime.type').rows.find((r) => r[0] === 'GEO')
    eq(sec(mAll, 'geo').blocks[0].rows.find((r) => r[0] === '编目在轨 GEO 对象')[1], String(geoReg[geoReg.length - 2]), '★ 与第 3 章 GEO 在轨合计同数')
  
  })
  part('#8', () => {
    // #8 卫星组：已陨落成员的在轨天数止于陨落日；它的编目根数不进轨道分布
    const decCat = [R({ norad: '46000', name: 'STARLINK-31', launchDate: '2019-05-24', decayDate: '2020-10-01', type: 'PAY', status: 'D', perigeeKm: 142, apogeeKm: 150, inclDeg: 53 }),
      R({ norad: '46001', name: 'STARLINK-32', launchDate: '2019-05-24', inclDeg: 53 })]
    const decGp = [G({ noradId: '46001', name: 'STARLINK-32', incl: 53 })]
    const dg = { id: 'd1', name: 'D', sats: [{ id: '46000' }, { id: '46001' }] }
    const dMem = S.groupMembers(dg, new Map(decGp.map((g) => [g.noradId, g])), S.buildIndex(decCat), { asOf })
    eq(dMem.find((m) => m.id === '46000').ageDays, Math.round((Date.UTC(2020, 9, 1) - Date.UTC(2019, 4, 24)) / 86400000), '★ 已陨落成员：在轨天数 = 陨落日 − 发射日')
    const mDec = mk(decCat, decGp, {}, { groups: [dg], scope: 'groups' })
    const inclSpec = Object.entries(mDec.figures).find(([k]) => /\.incl$/.test(k))[1].spec
    eq(inclSpec.bins.reduce((a, b) => a + b.n, 0), 1, '★ 组倾角分布只数在星历 / 缺席两类（已陨落那颗不进）')
  
  })
  part('#9', () => {
    // #9 轨道面：不足 3 颗的壳不列，GEO 成员不分壳，单面壳的面间间隔记空
    const pm = (id, inc, raan, regime) => ({ id, inclDeg: inc, raanDeg: raan, regime: regime || 'LEO', perigeeKm: 540, apogeeKm: 550 })
    const pcs = S.planeClusters([pm('1', 53, 0), pm('2', 53, 1), pm('3', 53, 2), pm('4', 97, 10), pm('5', 0.1, 70, 'GEO'), pm('6', 0.2, 80, 'GEO'), pm('7', 0.1, 90, 'GEO')], {})
    eq(pcs.shells.map((s) => s.inclDeg), [53], '★ 只剩 53° 壳（97° 壳只有 1 颗不列；GEO 成员不参与分壳）')
    eq([pcs.shells[0].planeCount, pcs.shells[0].spacingDeg, pcs.shells[0].spacingMinDeg, pcs.shells[0].spacingMaxDeg], [1, null, null, null], '★ 单面壳：面间间隔三列为空，不印 360')
  
  })
  part('#10', () => {
    // #10 组高度分布按区制拆图：LEO 与 GEO 不同轴
    const mixCat = [R({ norad: '50001', name: 'L1' }), R({ norad: '50002', name: 'L2' }),
      R({ norad: '50003', name: 'G1', periodMin: 1436, inclDeg: 0.05, apogeeKm: 35800, perigeeKm: 35770 })]
    const mixGp = [G({ noradId: '50001', name: 'L1' }), G({ noradId: '50002', name: 'L2', raan: 1 }), G({ noradId: '50003', name: 'G1', meanMotion: 1.0027, incl: 0.05, ecc: 0.0002 })]
    const mMix = mk(mixCat, mixGp, {}, { groups: [{ id: 'x', name: 'X', sats: [{ id: '50001' }, { id: '50002' }, { id: '50003' }] }], scope: 'groups' })
    const altIds = Object.keys(mMix.figures).filter((k) => /\.alt/.test(k)).sort()
    eq(altIds, ['f.g1.alt.GEO', 'f.g1.alt.LEO'], '★ 高度分布按区制各一张')
    ok(mMix.figures['f.g1.alt.LEO'].spec.bins.every((b) => b.x1 < 2000), '★ LEO 那张的量程不被 GEO 拉到 35800 km')
  
  })
  part('#11', () => {
    // #11 逐年 / 逐月发射不把碎片按母体发射年计：FY-1C 2007 年解体的碎片不该算成 1999 年的发射
    const fy = [R({ norad: '25730', name: 'FENGYUN 1C', launchDate: '1999-05-10' }), R({ norad: '25731', name: 'CZ-4 R/B', type: 'R/B', launchDate: '1999-05-10' }),
      ...[...Array(5)].map((_, i) => R({ norad: String(29700 + i), name: 'FENGYUN 1C DEB', type: 'DEB', launchDate: '1999-05-10' }))]
    const lsF = S.launchSeries(fy, { asOf })
    eq(lsF.payRb[lsF.years.indexOf(1999)], 2, '★ 1999 年发射（载荷与火箭体）= 2，5 条碎片不计')
    const msF = S.monthlySeries([R({ norad: '1', launchDate: '2026-09-01' }), R({ norad: '2', type: 'DEB', launchDate: '2026-09-01' })], { asOf, months: 3 })
    eq(msF.launchPayRb[2], 1, '★ 逐月发射同口径（碎片不计）')
  
  })
  part('#12', () => {
    // #12 1° 桶前 N：并列的同进同出，不在并列处任意截断
    eq(S.geoOccupancy([], new Map(), { topN: 2 }).top.length, 0, '空输入不出前 N')
    const fakeTop = S.topWithTies([{ lon: 1, n: 4 }, { lon: 2, n: 4 }, { lon: 3, n: 4 }, { lon: 4, n: 2 }], 2, (b) => b.n)
    eq(fakeTop.map((b) => b.lon), [1, 2, 3], '★ 第 2 位与第 3 位并列 → 一起进表')
  
  })
  part('#13', () => {
    // #13 历元晚于基准时刻（预报历元）的星不许从直方图里漏掉
    const futGp = [G({ noradId: '25867', name: 'CXO', epoch: '2026-09-17T00:00:00' }), G({ noradId: '1', name: 'A', epoch: '2026-09-10T00:00:00' })]
    const mFut = mk([], futGp)
    const ehT = mFut.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age')
    eq(ehT.rows[0][1], 2, '★ 星历表颗数含历元晚于基准时刻的那颗（直方图 2026-10-15 已删，负龄不再有地方被丢）')
  
  })
  part('#14', () => {
    // #14 判据补齐
    const crit = tbl(mAll, 't.appendix.criteria').rows.map((r) => r[1])
    for (const k of ['主壳层', '星历并集', '历元龄超限', '在轨覆盖率', '逐年与逐月发射']) ok(crit.indexOf(k) > -1, '★ 判据表有「' + k + '」')
  
  })
  part('暂缓项 2', () => {
    // 暂缓项 2：「再入 / 撞击」只数地球轨道上的（月面撞击体不算），恒 ≤ 已陨落
    const imp = [R({ norad: '1', orbitType: 'IMP', decayDate: '2020-01-01' }), R({ norad: '2', orbitType: 'IMP', orbitCenter: 'MO' })]
    const ovI = S.catalogOverview(imp)
    eq([ovI.decayed, ovI.impacted], [1, 1], '★ 深空撞击体不计入再入 / 撞击')
    ok(S.catalogOverview(rows).impacted <= S.catalogOverview(rows).decayed, '再入 / 撞击 ≤ 已陨落')
  
  })
  part('暂缓项 3', () => {
    // 暂缓项 3：逐年曲线的末年是不完整年 —— 图上标出来、题注写截至日期
    const yl = mAll.figures['f.launch.year'].spec
    eq(yl.partialLast, true, '★ 逐年发射图标注末年不完整')
    const ylCap = sec(mAll, 'launch').blocks.find((b) => b.figId === 'f.launch.year').caption
    ok(/2026 年截至 09-16/.test(ylCap), '★ 题注写截至日期：' + ylCap)
  
  })
  part('暂缓项 4', () => {
    // 暂缓项 4：所有者表 = 前 N 位 + 其余 + 合计，合计等于上面各行之和
    const ot2 = tbl(build({ opts: { topN: 2 } }), 't.owner.top')
    const body2 = ot2.rows.slice(0, -1)
    const tot2 = ot2.rows[ot2.rows.length - 1]
    ok(/^其余 \d+ 家$/.test(body2[body2.length - 1][0]), '★ 前 N 位之后有「其余 N 家」一行')
    for (let c = 2; c < ot2.head.length; c++) eq(body2.reduce((a, r) => a + Number(r[c]), 0), Number(tot2[c]), '★ 合计 = 表内各行之和（列 ' + ot2.head[c] + '）')
  })
}

// ===================================================================================
// 2026-10-15 二期：关键指标 / 发射按次 / 碎片母体 / 空间密度 / GEO 经度段 / 筛选感知
// ===================================================================================
{
  const R = (o) => ({ name: '', objectId: '', norad: '', type: 'PAY', status: '+', owner: 'US', launchDate: '2020-01-01', launchSite: 'AFETR',
    decayDate: '', periodMin: 95, inclDeg: 53, apogeeKm: 550, perigeeKm: 540, rcsM2: null, dataStatus: '', orbitCenter: 'EA', orbitType: 'ORB', ...o })

  // 发射按次：同一国际编号的载荷 / 火箭体算一次；只有碎片的编号不算
  const L = [R({ norad: '1', objectId: '2026-001A', launchDate: '2026-01-05' }), R({ norad: '2', objectId: '2026-001B', launchDate: '2026-01-05' }),
    R({ norad: '3', objectId: '2026-001C', type: 'R/B', name: 'CZ-2D R/B', launchDate: '2026-01-05' }),
    R({ norad: '4', objectId: '2025-010A', launchDate: '2025-01-03' }), R({ norad: '5', objectId: '2025-200A', launchDate: '2025-12-30' }),
    R({ norad: '6', objectId: '1999-025ABC', type: 'DEB', name: 'FENGYUN 1C DEB', launchDate: '1999-05-10' })]
  const ev = S.launchEvents(L)
  eq(ev.map((e) => e.key), ['2026-001', '2025-200', '2025-010'], '发射事件按日期降序，碎片单独撑不起一次发射')
  eq([ev[0].payloads, ev[0].rocketBodies, ev[0].vehicle], [2, 1, 'CZ-2D'], '一次发射的载荷数 / 火箭体数 / 运载火箭名（火箭体名去「R/B」）')
  const lc = S.launchCountSeries(L, { asOf })
  eq([lc.counts[lc.years.indexOf(2025)], lc.counts[lc.years.indexOf(2026)], lc.counts[lc.years.indexOf(1999)]], [2, 1, 0], '逐年发射次数')
  const ytd = S.yearToDate(L, { asOf: '2026-01-04T00:00:00Z' })
  eq([ytd.cur.launches, ytd.prev.launches], [0, 1], '本年至今与去年同期按同月同日截（2025-01-03 落在同期内、2025-12-30 不在）')

  // 碎片母体 / 近期新编目碎片（NORAD 近似编目时间）
  const Db = [R({ norad: '100', objectId: '2026-050A', launchDate: '2026-09-01' }),
    ...[...Array(4)].map((_, i) => R({ norad: String(90 + i), objectId: '1999-025' + 'ABCD'[i], type: 'DEB', name: 'FENGYUN 1C DEB', owner: 'PRC', launchDate: '1999-05-10' })),
    R({ norad: '101', objectId: '1999-025Z', type: 'DEB', name: 'FENGYUN 1C DEB', owner: 'PRC', launchDate: '1999-05-10' }),
    R({ norad: '102', objectId: '2026-051B', type: 'DEB', name: 'YAOGAN-50 02 DEB', owner: 'PRC', launchDate: '2026-02-01', decayDate: '2026-09-10' })]
  const dbp = S.debrisByParent(Db)
  eq([dbp.rows[0].key, dbp.rows[0].parent, dbp.rows[0].inOrbit], ['1999-025', 'FENGYUN 1C', 5], '碎片按发射编号归并、母体名去「DEB」')
  eq([dbp.debrisInOrbit, dbp.debrisTotal], [5, 6], '在轨碎片 / 累计编目碎片')
  const rdb = S.recentDebris(Db, { asOf, days: 30 })
  eq([rdb.fromNorad, rdb.total], [100, 2], '★ 窗口内首个新发射对象的编号（100）以上的碎片才算近期编目（编号 90–93 的老碎片不算）')

  // 空间密度：一颗 540–550 km 的近圆轨道整颗落进一层；Σ 密度 × 体积 = 颗数（时间比例守恒）
  const sd = S.spatialDensity([R({ norad: '1' }), R({ norad: '2', perigeeKm: 400, apogeeKm: 1200, type: 'DEB' })], { lo: 200, hi: 2000, step: 20 })
  const Re = 6378.137
  const vol = (b) => 4 / 3 * Math.PI * (Math.pow(Re + b.h1, 3) - Math.pow(Re + b.h0, 3))
  const mass = (ty) => sd.bins.reduce((a, b, i) => a + sd.density[ty][i] * vol(b), 0)
  ok(Math.abs(mass('PAY') - 1) < 1e-9 && Math.abs(mass('DEB') - 1) < 1e-9, '★ 每颗对象的时间比例在各层之和 = 1（近圆一层、椭圆摊开）')
  eq(sd.density.PAY.filter((v) => v > 0).length, 1, '近圆轨道只落一层')
  ok(sd.density.DEB.filter((v) => v > 0).length > 30, '椭圆轨道摊到近地点—远地点之间的各层')

  // 关键指标页
  const kpi = mAll.sections[0].blocks[0]
  eq([mAll.sections[0].key, kpi.type], ['summary', 'kpi'], '第 1 章是关键指标，块型 kpi')
  eq(kpi.groups.length, 3, '关键指标三组：存量 / 本年至今 / 近 N 天')
  ok(kpi.groups.every((g) => g.title && g.refLabel && g.items.length), '每组有标题、对照期名、条目')
  ok(kpi.groups.flatMap((g) => g.items).every((it) => ('ref' in it && 'delta' in it) || 'note' in it), '★ 每格都有对照行：对照期值 + 差值，或一个相关读数')
  ok(kpi.groups.flatMap((g) => g.items).every((it) => !/,/.test(it.value + (it.ref || '') + (it.delta || ''))), '★ 读数分组用细空，不用逗号')
  eq(RP.buildSsaModel({ satcat: [], gp: [], groups: [], scope: 'all', opts: {}, lang: 'zh', doc: {}, dataMeta: { asOf } }).sections.filter((x) => x.appendix).map((x) => x.no), ['A', 'B'], '没有代码表时参考文献顺成附录 B（字母不留空洞）')
  ok(kpi.groups.flatMap((g) => g.items).every((it) => typeof it.value === 'string'), 'kpi 的值是已格式化的读数串（渲染端不再格式化）')
  const kEn = build({ lang: 'en' }).sections[0].blocks[0]
  ok(!HAN.test(JSON.stringify(kEn)), '★ 英文版关键指标无汉字')

  // GEO 经度段：36 段，合计 = 定点解算数
  const seg = mAll.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.geo.seg')
  eq(seg.rows.length, 36, '10° 经度段 36 行')
  eq(seg.rows.reduce((a, r) => a + r[1], 0), 3, '各段合计 = 定点解算的 GEO 卫星数')

  // 筛选感知
  const keysOf = (opts) => RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } }).sections.map((s) => s.key)
  ok(keysOf({ owners: ['PRC'] }).indexOf('owner') < 0, '★ 只筛一家所有者：所有者章不出')
  ok(keysOf({ owners: ['PRC', 'US'] }).indexOf('owner') > -1, '筛两家：所有者章照出')
  ok(keysOf({ types: ['PAY'] }).indexOf('debris') < 0, '★ 类型筛里没有碎片：碎片章不出')
  ok(keysOf({ types: ['DEB'] }).indexOf('constellation') < 0, '★ 类型筛里没有载荷：星座章不出')
  const regGeo = RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { regimes: ['GEO'] }, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const rtG = regGeo.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.regime.type')
  eq(rtG.rows.map((r) => r[0]), ['GEO', '合计'], '★ 区制筛 GEO：区制表只剩 GEO 与合计（不出五行全零）')
  const regPay = RP.buildSsaModel({ satcat: rows, gp, groups: [], scope: 'all', opts: { types: ['PAY'] }, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  eq(regPay.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.regime.type').head.slice(1, -2), ['载荷'], '★ 类型筛 PAY：区制表只剩载荷一列')

  // 基准时刻回溯（2026-10-16）：之后发射的不计、之后陨落的按在轨计；为「现在」时原样返回同一数组
  const bd = [R({ norad: '1', launchDate: '2026-01-01' }), R({ norad: '2', launchDate: '2026-10-01' }),
    R({ norad: '3', launchDate: '2020-01-01', decayDate: '2026-09-20', status: 'D', orbitType: 'IMP' })]
  const t930 = Date.UTC(2026, 8, 30)
  const bdr = S.backdateRows(bd, t930)
  eq(bdr.map((r) => r.norad), ['1', '3'], '★ 回溯到 9-30：10-01 才发射的那颗不计')
  ok(S.isDecayed(bdr[1]), '9-20 陨落、早于基准 9-30：仍记已陨落')
  const t915 = Date.UTC(2026, 8, 15)
  const bd915 = S.backdateRows(bd, t915)
  const r3 = bd915.find((r) => r.norad === '3')
  ok(S.isInOrbit(r3) && r3.status === '?', '★ 回溯到 9-15：9-20 才陨落的那颗按在轨计，运行状态记 ?')
  ok(S.backdateRows(bd, Date.UTC(2026, 9, 16)) === bd, '基准时刻为「现在」：原样返回同一个数组（缓存照常命中）')
  const mBd = RP.buildSsaModel({ satcat: bd, gp: [], groups: [], scope: 'all', opts: {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf: '2026-09-15T00:00:00Z' } })
  ok(mBd.sections.find((x) => x.key === 'appendix').blocks[0].rows.some((r) => r[1] === '基准时刻回溯'), '回溯生效时判据表写明星历侧不回溯')
  ok(!mAll.sections.find((x) => x.key === 'appendix').blocks[0].rows.some((r) => r[1] === '基准时刻回溯'), '不回溯时不出这一条')
  // 回溯时历元龄按星历数据时间计：星历历元 10-15、基准 9-15、星历数据时间 10-16 → 中位数 1 天，不是 −30 天
  const gpBd = [{ name: 'SAT-1', noradId: '1', epoch: '2026-10-15T00:00:00', meanMotion: 15.1, ecc: 0.0001, incl: 53, raan: 0, argp: 0, meanAnomaly: 0 }]
  const mBdE = RP.buildSsaModel({ satcat: bd, gp: gpBd, groups: [], scope: 'all', opts: {}, lang: 'zh', tz: 'utc', doc: {},
    dataMeta: { asOf: '2026-09-15T00:00:00Z', gpAt: '2026-10-16T00:00:00Z' } })
  const epBd = mBdE.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age')
  ok(epBd && Number(String(epBd.rows[0][2]).replace(/[^\d.\-−]/g, '').replace('−', '-')) === 1, '★ 回溯时历元龄按星历数据时间计（中位数 1 天，不出负龄）')

  // —— 相对 v1.5.2 审查 #1–#4 / #11–#13（2026-10-16）——
  // 基准 08-31：窗口内发射 100（US）；基准之后发射 200（截断号）；201 / 202 是母体 2 月发射、9 月解体才编目的碎片
  const bc = [R({ norad: '50', objectId: '2020-001A', owner: 'PRC', launchDate: '2020-01-01' }),
    R({ norad: '90', objectId: '1999-025A', type: 'DEB', name: 'FENGYUN 1C DEB', owner: 'PRC', launchDate: '1999-05-10' }),
    R({ norad: '100', objectId: '2026-090A', launchDate: '2026-08-20' }),
    R({ norad: '101', objectId: '1999-025B', type: 'DEB', name: 'FENGYUN 1C DEB', owner: 'PRC', launchDate: '1999-05-10' }),
    R({ norad: '200', objectId: '2026-099A', launchDate: '2026-09-05' }),
    R({ norad: '201', objectId: '2026-051B', type: 'DEB', name: 'YAOGAN-50 02 DEB', owner: 'PRC', launchDate: '2026-02-01' }),
    R({ norad: '202', objectId: '2026-051C', type: 'DEB', name: 'YAOGAN-50 02 DEB', owner: 'PRC', launchDate: '2026-02-01' })]
  const asBc = '2026-08-31T16:00:00Z', tBc = S.asOfMs(asBc)
  const gpOf = (id) => ({ name: 'SAT-' + id, noradId: id, epoch: '2026-10-15T00:00:00', meanMotion: 15.1, ecc: 0.0001, incl: 53, raan: 0, argp: 0, meanAnomaly: 0 })
  const gpBc = ['50', '100', '200'].map(gpOf)
  const metaBc = { asOf: asBc, gpAt: '2026-10-16T00:00:00Z', satcatRows: bc.length }
  const mk = (over) => RP.buildSsaModel({ satcat: bc, gp: gpBc, groups: [], scope: 'all', opts: {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: metaBc, ...over })
  const kvOf = (m, cap) => m.sections.flatMap((s) => s.blocks).find((b) => b.type === 'kv' && b.caption === cap)
  const kvVal = (m, cap, label) => { const r = kvOf(m, cap).rows.find((x) => x[0].indexOf(label) === 0); return r && r[1] }
  const kpiNew = (m) => m.sections[0].blocks[0].groups[2].items.find((x) => x.label === '新编目碎片')
  // #1
  eq(S.catalogCutNorad(bc, tBc), 200, '截断号 = 基准之后首个发射对象的 NORAD')
  eq(S.backdateRows(bc, tBc).map((r) => r.norad), ['50', '90', '100', '101'], '★ #1 回溯删掉编号 ≥ 截断号的碎片（母体发射日早于基准也删）')
  eq(S.recentDebris(bc, { asOf: asBc, days: 30 }).total, 1, '★ #1 recentDebris 有上界：基准之后才编目的碎片不计')
  eq(S.debrisCataloguedBetween(S.backdateRows(bc, tBc), S.windowStartMs(tBc, 30), tBc, { hiNorad: 200 }), 1, '#1 debrisCataloguedBetween 吃外加上界')
  const mBc = mk()
  eq(kvVal(mBc, '碎片读数', '近 30 天新编目碎片'), '1', '★ #1 回溯报告第 6 章新编目碎片 = 1（不含 9 月才编目的 2 条）')
  eq(kpiNew(mBc).value, '1', '★ #1 回溯报告关键指标新编目碎片 = 1')
  // #2
  const epBc = mBc.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age')
  eq(epBc.rows[0][1], 2, '★ #2 回溯时星历只留回溯后编目里有的号（200 号不计）')
  ok(mk({ dataMeta: { ...metaBc, asOf: '2026-10-16T00:00:00Z' } }).sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.epoch.age').rows[0][1] === 3, '#2 不回溯时星历原样（3 条）')
  // #3
  const mG = mk({ scope: 'groups', groups: [{ id: 'q', name: 'Q', sats: [{ id: '100', name: 'A' }, { id: '200', name: 'B' }] }] })
  const gMemBc = mG.sections.flatMap((s) => s.blocks).find((b) => b.tableId === 't.g1.members')
  eq(gMemBc.rows.map((r) => r[1]), ['100'], '★ #3 回溯时基准之后发射的成员剔除')
  eq(kvVal(mG, '概况', '基准时刻之后发射'), '1', '#3 剔除数单列一行')
  ok(gMemBc.rows.every((r) => r[15] == null || r[15] >= 0), '★ #3 回溯时组成员历元龄按星历数据时间计，不为负')
  // #4
  eq(kpiNew(mk({ dataMeta: { ...metaBc, asOf: '2026-09-01T00:00:00Z' }, satcat: S.backdateRows(bc, tBc), opts: { types: ['DEB'] } })).value, '1', '★ #4 类型筛碎片：新编目碎片按全量定界')
  eq(kvVal(mk({ opts: { owners: ['PRC'] } }), '碎片读数', '近 30 天新编目碎片'), '1', '★ #4 按所有者筛：下界不随该所有者首发漂移')
  // #11
  const kT = mBc.sections[0].blocks[0].groups.map((g) => g.title)
  ok(kT.every((x) => / UTC）$/.test(x)), '★ #11 关键指标三组标题标 UTC：' + kT.join(' / '))
  ok(/2025-08-\d\d—2026-08-31 UTC/.test(mk({ opts: { recentDays: 365 } }).sections[0].blocks[0].groups[2].title), '★ #11 跨年窗口印完整日期')
  // #12
  eq(kvVal(mBc, '报告基准', '本报告统计条数'), '4 / 7', '★ #12 回溯时给统计条数（倒推后 / 原始）')
  // #13
  const big = [...Array(1234)].map((_, i) => R({ norad: String(5000 + i), objectId: '1999-025' + i, type: 'DEB', name: 'X DEB', launchDate: '1999-05-10' }))
  const mBig = RP.buildSsaModel({ satcat: big, gp: [], groups: [], scope: 'all', opts: {}, lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf } })
  const kDeb = mBig.sections[0].blocks[0].groups[0].items.find((x) => x.label === '在轨碎片').value
  eq([kDeb, kvVal(mBig, '碎片读数', '在轨碎片')], ['1 234', '1 234'], '★ #13 关键指标与 kv 同一分组规则')
  ok(kvOf(mBig, '碎片读数').rows.some((r) => r[0] === '累计编目碎片（不含深空 / 着陆）'), '#13 累计编目碎片标明不含深空')
  ok(/≥ 3 颗/.test(JSON.stringify(mAll.sections.find((x) => x.key === 'appendix'))) && !/≥ 2 颗/.test(JSON.stringify(mAll.sections.find((x) => x.key === 'appendix'))), '#13 附录共位判据 ≥ 3 颗，与正文一致')

  // 对数高度分层
  const hgL = S.heatGrid([{ inclDeg: 53, perigeeKm: 540, apogeeKm: 550 }, { inclDeg: 0, perigeeKm: 35780, apogeeKm: 35790 }], { incStep: 2, altMin: 150, altMax: 50000, logAlt: true, altBins: 36 })
  eq(hgL.yBins.length, 36, '对数分 36 层')
  ok(hgL.yBins[0].y0 === 150 && hgL.yBins[35].y1 === 50000, '首层下界 150 km、末层上界 50000 km')
  eq(hgL.cells.flat().reduce((a, b) => a + b, 0), 2, 'LEO 与 GEO 都落在格里')
}

if (fail) { console.log('FAIL  ' + fail + ' 项'); process.exit(1) }
console.log('PASS  ssaStats/ssaReport：' + pass + ' 项')
