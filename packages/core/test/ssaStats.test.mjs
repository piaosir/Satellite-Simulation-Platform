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
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

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
eq(ot.rows[0], { owner: 'PRC', active: 16, payloads: 16, rockets: 2, debris: 3, inOrbit: 21, launched: 22, decayed: 1 }, 'PRC 行逐格')
// ★ 行数恒 = topN（2026-09-17 删掉「钉住某一家」那档之后）：题注写「前 N 位」，表里就得是 N 行
eq(S.ownerTable(rows, { topN: 2 }).rows.map((r) => r.owner), ['PRC', 'US'], '只取前 topN 行，不再往表尾追加任何一行')

// ===================================================================================
// 4. 发射与陨落
// ===================================================================================
const ls = S.launchSeries(rows, { asOf })
eq([ls.years[0], ls.years[ls.years.length - 1], ls.years.length], [1957, 2026, 70], '逐年序列 1957–asOf 年')
eq(ls.all.reduce((a, b) => a + b, 0), rows.length, '逐年发射合计 = 总行数（每行都有发射日期）')
eq(ls.payload.reduce((a, b) => a + b, 0), 34, '逐年发射（载荷）合计 = 载荷总数')

const dsy = S.decaySeries(rows, { asOf })
eq(dsy.all.reduce((a, b) => a + b, 0), ov.decayed, '逐年陨落合计 = 已陨落数（R/T 的返回日期不计）')

const ms = S.monthlySeries(rows, { asOf, months: 24 })
eq([ms.months.length, ms.months[0], ms.months[23]], [24, '2024-10', '2026-09'], '近 24 月窗口，末月 = asOf 所在月')
eq(ms.launchAll.slice(-3), [0, 2, 5], '近三个月发射（全部）')
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
eq(mAll.sections.map((s) => s.key), ['meta', 'catalog', 'regime', 'owner', 'launch', 'constellation', 'geo', 'epoch', 'appendix'], '全量章节 key 与顺序（契约 §3）')
eq(mAll.sections.map((s) => s.no), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], '章号连续')
eq(mAll.opts, { recentDays: 30, topN: 15, geoArc: [60, 150], months: 24, rowCap: 500, constellations: [], owners: [], regimes: [], types: [] }, '缺省参数（四道筛选默认全空 = 不筛）')
eq(mAll.scope, { mode: 'all', groups: [], filters: { constellations: [], owners: [], regimes: [], types: [] }, filtered: false, rows: rows.length, rowsTotal: rows.length }, '不筛时 scope 如实报「没筛」')
eq(mAll.data.asOf, asOf, '基准时刻原样进模型')
eq(mAll.doc.title, '空间态势报告', '缺省报告名（全量）')

const blocksOf = (m) => m.sections.flatMap((s) => s.blocks)
const tablesOf = (m) => blocksOf(m).filter((b) => b.type === 'table')
const figsOf = (m) => blocksOf(m).filter((b) => b.type === 'figure')

for (const b of blocksOf(mAll)) ok(['kv', 'table', 'figure'].indexOf(b.type) >= 0, '块型只有三种：' + b.type)
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
const mFew = build({ opts: { sections: { regime: false, geo: false, epoch: false } } })
eq(mFew.sections.map((s) => s.key), ['meta', 'catalog', 'owner', 'launch', 'constellation', 'appendix'], '关掉的整章跳过')
eq(mFew.sections.map((s) => s.no), ['1', '2', '3', '4', '5', '6'], '关章后章号仍连续')
eq(build({ opts: { sections: { meta: false } } }).sections[0].key, 'meta', 'meta 章不可关')

// 卫星组范围
const mGrp = build({ groups: [g1, g2], scope: 'groups' })
eq(mGrp.sections.map((s) => s.key), ['meta', 'g:sg1', 'g:sg2', 'appendix'], '卫星组范围的章节 key')
// ★ 附录不是组章，不从主计数器再拿一个号 —— 那样它会拿到「2」而排在 G2 之后（1 / G1 / G2 / 2）
eq(mGrp.sections.map((s) => s.no), ['1', 'G1', 'G2', ''], '组章章号 G1 / G2，附录不编号')
eq(mGrp.sections[1].title, 'TESTSAT 组', '组章标题＝组名（自命名不翻）')
eq(mGrp.scope.groups, [{ id: 'sg1', name: 'TESTSAT 组', count: 18 }, { id: 'sg2', name: 'GEO 组', count: 3 }], 'scope 带每组成员数')
eq(mGrp.scope.mode, 'groups', 'scope.mode')
eq(mGrp.doc.title, 'TESTSAT 组、GEO 组 空间态势报告', '缺省报告名（卫星组）')
const g1Caps = mGrp.sections[1].blocks.map((b) => b.caption)
ok(g1Caps[0].startsWith('G1.1 '), '组章块的题注自带小节号前缀')
ok(g1Caps.some((c) => c.startsWith('G1.5 ')) === false, '本组没有 GEO 成员就不出 G1.5')
ok(mGrp.sections[2].blocks.some((b) => b.caption.startsWith('G2.5 ')), 'GEO 组出 G2.5')
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
const metaKeysAll = mAll.sections[0].blocks[1].rows.map((r) => r[0])
const metaKeysGrp = mGrp.sections[0].blocks[1].rows.map((r) => r[0])
ok(metaKeysAll.indexOf('GEO 重点弧段') >= 0, '全量报告列出 GEO 重点弧段')
eq(metaKeysGrp.filter((k) => ['所有者榜条目数', 'GEO 重点弧段'].indexOf(k) >= 0), [], '卫星组报告不列全量专用参数')

// 经度区间右端点：fmtGeoSlot 把 180 折成 180.0°W，右端点要单独印成 180.0°E
const mArc = build({ opts: { geoArc: [150, 180] } })
const arcCap = mArc.sections.find((s) => s.key === 'geo').blocks.find((b) => b.tableId === 't.geo.arc')
ok(!arcCap || arcCap.caption.indexOf('180.0°E') > 0, '重点弧段题注的右端点印 180.0°E')
ok(mArc.sections.find((s) => s.key === 'geo').blocks[0].rows.some((r) => r[1].indexOf('180.0°E') > 0), '读数行里的弧段同样')

// 空输入
const mEmpty = RP.buildSsaModel({ satcat: [], gp: [], groups: [], scope: 'all', opts: {}, lang: 'zh', doc: {}, dataMeta: { asOf } })
eq(mEmpty.sections.length, 9, '空数据也出全套章节')
const badEmpty = []
walk(mEmpty, '空', badEmpty)
eq(badEmpty, [], '空数据的模型同样纯数据')
eq(RP.buildSsaModel({}).kind, 'ssa', '完全空的入参不抛错')

// ===================================================================================
// 时刻一律过显示时区档：ISO 原串（…T01:37:09Z）不许上纸，且必须带时区角标
// ===================================================================================
{
  const ts = { satcatAt: '2026-09-16T01:37:09Z', gpAt: '2026-09-16T01:37:09Z', asOf: '2026-09-16T12:00:00Z' }
  const tsOf = (m) => m.sections[0].blocks[0].rows[0][1]
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 'utc', doc: {}, dataMeta: ts })),
    '2026-09-16 01:37 UTC', '时刻按 UTC 档格式化，带角标')
  // ★ 固定档位的单位是【分钟】不是小时（tz.js 的 normTzMode / tzOffMin）：480 才是 UTC+8
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 480, doc: {}, dataMeta: ts })),
    '2026-09-16 09:37 UTC+8', '固定时区档 UTC+8')
  eq(tsOf(RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: -300, doc: {}, dataMeta: ts })),
    '2026-09-15 20:37 UTC−5', '西五区跨了一天')
  const m0 = RP.buildSsaModel({ scope: 'all', lang: 'zh', tz: 'utc', doc: {}, dataMeta: { asOf: '' } })
  eq(m0.sections[0].blocks[0].rows[0][1], '—', '缺时刻印破折号，不印 Invalid Date')
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
  const metaKv = mf.sections[0].blocks.filter((b) => b.type === 'kv')
  const flat = metaKv.flatMap((b) => b.rows)
  ok(flat.some((r) => r[0] === '所有者' && r[1].indexOf('PRC') === 0), '第 1 章列出「所有者 = PRC 中国」')
  ok(flat.some((r) => r[0] === '对象类型' && /PAY/.test(r[1])), '第 1 章列出「对象类型 = PAY 载荷」')
  ok(flat.some((r) => r[0] === '本报告统计条数' && r[1].indexOf('/') > 0), '第 1 章给出「本报告统计条数 = 筛后 / 总数」')
  ok(mf.sections[0].blocks.some((b) => b.caption === '筛选条件'), '筛了就多出「筛选条件」这一块')
  // 不筛时这两样都不出现（没用上的口径不该给读者一行）
  const flat0 = mAll.sections[0].blocks.filter((b) => b.type === 'kv').flatMap((b) => b.rows)
  ok(!flat0.some((r) => r[0] === '本报告统计条数'), '不筛时不出「本报告统计条数」这一行')
  ok(!mAll.sections[0].blocks.some((b) => b.caption === '筛选条件'), '不筛时不出「筛选条件」这一块')

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
  const cats = [...new Set(nAll[0].rows.map((r) => r[0]))]
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
  ok(nF.rows.some((r) => r[0] === '筛选条件' && r[1] === '轨道区制'), '筛了区制就在判据表里写明')
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
  const epochN = (opts) => mAll_(opts).sections.find((s) => s.key === 'epoch').blocks[0].rows[0][1]
  eq(geoOf({}).slots, 3, 'GEO 章不筛时数满三颗')
  eq(geoOf({ owners: ['US'] }).slots, 1, '★ 筛 US：GEO 章只数 US 那一颗（补丁前是全量 3）')
  eq(geoOf({ owners: ['PRC'] }).slots, 2, '★ 筛 PRC：GEO 章只数 PRC 那两颗（补丁前是全量 3）')
  eq(geoOf({ regimes: ['LEO'] }).slots, 0, '★ 筛 LEO：GEO 章一颗都不该有')
  eq(geoOf({ types: ['DEB'] }).slots, 0, '★ 筛碎片：夹具里没有 GEO 碎片，定点数为 0')
  const arcCn = geoOf({ owners: ['PRC'] }).arc
  eq(arcCn ? arcCn.rows.length : -1, 2, '筛 PRC 时重点弧段表里正是本国那两颗')
  eq(arcCn.rows.filter((r) => !r[3] || !r[4] || !r[5]).length, 0, '★ 筛选生效时重点弧段表的代码 / 所有者 / 状态列不留空')
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
  // 近地点图：图题写着 0–2000 km，末桶就必须只有 1950–2000 km 那一档
  const orb2000 = rows.filter((r) => S.isInOrbit(r) && Number.isFinite(r.perigeeKm) && r.perigeeKm >= 2000).length
  ok(orb2000 > 0, '夹具里有 2000 km 以上的在轨对象（否则下一条空转）')
  const periBins = mAll.figures['f.regime.perigee'].spec.bins
  eq(periBins[periBins.length - 1].n, rows.filter((r) => S.isInOrbit(r) && Number.isFinite(r.perigeeKm) && r.perigeeKm >= 1950 && r.perigeeKm < 2000).length,
    '★ 近地点图末桶 = 1950–2000 km 的真值（2000 km 以上的 ' + orb2000 + ' 个不并进来）')
  // 密度格同理：高度越界的不压进顶行
  const hRow = (alt) => ({ inclDeg: 50, perigeeKm: alt, apogeeKm: alt })
  const hg = S.heatGrid([hRow(39500), hRow(45000), hRow(60000)], { incStep: 5, altMax: 40000, altStep: 500 })
  eq(hg.cells[hg.cells.length - 1].reduce((a, x) => a + x, 0), 1, '★ 密度格顶行只算落在量程内的')
  eq(hg.over, 2, '越界的另计 over')
}

// ===================================================================================
// 历元龄图：x 上界跟着数据走，不封顶 30 天（离线用内置快照时全体历元龄都在 30 天以外）
// ===================================================================================
{
  const figOf = (m) => m.figures['f.epoch.hist'].spec
  const capOf = (m) => m.sections.find((s) => s.key === 'epoch').blocks.find((b) => b.type === 'figure').caption
  const rowOf = (m) => m.sections.find((s) => s.key === 'epoch').blocks[0].rows[0]
  // 日常（当天更新）那档不变：1 天分箱
  eq(figOf(mAll).bins[0].x1 - figOf(mAll).bins[0].x0, 1, '历元龄 ≤ 30 天时仍是 1 天分箱')
  eq(capOf(mAll), '历元龄分布（1 天分箱）', '图题写实际桶宽')
  const mOld = build({ dataMeta: { ...dataMeta, asOf: '2027-03-16T00:00:00Z' } })
  const bOld = figOf(mOld).bins
  const maxDays = rowOf(mOld)[4]
  ok(maxDays > 30, '半年后的快照：表里的最大历元龄 = ' + maxDays + ' 天')
  ok(bOld[bOld.length - 1].x1 >= maxDays, '★ 图的 x 上界（' + bOld[bOld.length - 1].x1 + '）不低于表里的最大历元龄，不封 30 天')
  eq(bOld.reduce((a, b) => a + b.n, 0), rowOf(mOld)[1], '★ 图里的点数 = 表里的颗数（没有被压进末桶）')
  ok(bOld[bOld.length - 1].n < rowOf(mOld)[1], '★ 末桶不再是「全体都在这一条」')
  eq(capOf(mOld), '历元龄分布（' + (bOld[0].x1 - bOld[0].x0) + ' 天分箱）', '桶宽放大后图题跟着改')
}

// ===================================================================================
// 所有者表与排名图：表 = 前 topN 行 + 合计行，图 = 前 20 条封顶
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
  eq(tb25.rows.length, 26, '★ 表 = 前 25 行 + 合计行，一行不多（不再往表尾追加钉住行）')
  eq(tb25.emphasisRows, undefined, '表里没有强调行')
  const it25 = m25.figures['f.owner.rank'].spec.items
  eq(it25.length, 20, '★ 图封顶 20 条（表可以到 topN = 50，图画不下）')
  ok(it25.every((i) => i.emphasis === undefined), '图里没有强调条')
  const it15 = mk({ topN: 15 }).figures['f.owner.rank'].spec.items
  eq(it15.length, 15, 'topN 不足 20 时图条数 = 表行数（不含合计行）')
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

console.log('PASS  ssaStats/ssaReport：' + pass + ' 项')
