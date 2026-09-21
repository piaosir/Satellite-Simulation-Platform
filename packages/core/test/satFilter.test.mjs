// 卫星搜索筛选器的回归网（src/shared/satFilter.js）。
//
// 【最要紧的一条】没有卫星编目（SATCAT）时，编目那四项（所有者 / 类型 / 状态 / 发射年）
// 一律【视为不限】而不是「全都筛掉」—— 把没编目的星全滤没了，用户只会以为搜索坏了。

import SF from '../../../src/shared/satFilter.js'
import SM from '../../../src/shared/satrecMetrics.js'
import { tableFrom } from '../../../src/viz/constellation/ephemTable.js'
import sat from '../../../src/viz/constellation/satellite.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)

// 池记录（形状同 satSearchPool 的产物）
const mk = (noradId, name, incl, mm, ecc, apo, per) => ({ noradId: String(noradId), name, incl, meanMotion: mm, ecc, apogeeKm: apo, perigeeKm: per })
const POOL = [
  mk(25544, 'ISS', 51.64, 15.5, 0.0007, 420, 410),          // LEO · 载荷 · 美国 · 1998
  mk(41838, 'CS-6D', 0.03, 1.0027, 0.0002, 35790, 35780),    // GEO · 载荷 · 中国 · 2016
  mk(37846, 'GPS BIIF-2', 55.0, 2.0056, 0.006, 20200, 20150),// MEO · 载荷 · 美国 · 2011
  mk(19822, 'MOLNIYA 1-80', 63.4, 2.006, 0.72, 39800, 600),  // HEO · 载荷 · 苏联 · 1989
  mk(40000, 'DEB-X', 98.0, 14.5, 0.001, 800, 780),           // LEO · 碎片 · 中国 · 2014
  mk(50000, 'RB-Y', 28.5, 1.0, 0.72, 35800, 200),            // HEO · 火箭体 · 未知 · 2021
  mk(60000, 'DECAYED-Z', 51.6, 16.0, 0.001, 300, 280),       // 已陨落
  mk(70000, 'NOCAT', 45.0, 14.0, 0.001, 600, 590)            // 编目里没有这一颗
]
const ROWS = {
  25544: { norad: '25544', owner: 'US', type: 'PAY', status: '+', launchDate: '1998-11-20', decayDate: '' },
  41838: { norad: '41838', owner: 'PRC', type: 'PAY', status: '+', launchDate: '2016-12-10', decayDate: '' },
  37846: { norad: '37846', owner: 'US', type: 'PAY', status: '+', launchDate: '2011-07-16', decayDate: '' },
  19822: { norad: '19822', owner: 'CIS', type: 'PAY', status: 'D', launchDate: '1989-02-15', decayDate: '' },
  40000: { norad: '40000', owner: 'PRC', type: 'DEB', status: '', launchDate: '2014-08-09', decayDate: '' },
  50000: { norad: '50000', owner: 'TBD', type: 'R/B', status: '?', launchDate: '2021-03-01', decayDate: '' },
  60000: { norad: '60000', owner: 'US', type: 'PAY', status: '+', launchDate: '2019-05-01', decayDate: '2023-04-02' }
}
const IDX = new Map(Object.entries(ROWS).map(([k, v]) => [k, v]))
const run = (f, index) => {
  const p = SF.makePredicate(f, index === undefined ? IDX : index)
  return p ? POOL.filter(p).map((r) => r.name) : POOL.map((r) => r.name)
}
const F = (o) => Object.assign(SF.emptyFilters(), o)

/* ===== ① 空筛选 ===== */
section('空筛选')
ok(SF.isEmpty(SF.emptyFilters()), '出厂筛选是空的')
ok(SF.makePredicate(SF.emptyFilters(), IDX) === null, '★ 空筛选返回 null（调用方走原来的路，零开销）')
ok(SF.makePredicate(null, IDX) === null, 'null 也返回 null')
ok(!SF.isEmpty(F({ owner: 'PRC' })), '填了任何一项就不是空的')
ok(!SF.isEmpty(F({ inclFrom: 0 })), '数值 0 也算填了')
ok(SF.isEmpty(F({ inclFrom: null })), 'null 不算填了')

/* ===== ② 编目四项，各一例 ===== */
section('编目四项')
ok(run(F({ owner: 'PRC' })).join('|') === 'CS-6D|DEB-X', '所有者 PRC', run(F({ owner: 'PRC' })).join('|'))
ok(run(F({ owner: 'US' })).join('|') === 'ISS|GPS BIIF-2|DECAYED-Z', '所有者 US', run(F({ owner: 'US' })).join('|'))
ok(run(F({ type: 'PAY' })).join('|') === 'ISS|CS-6D|GPS BIIF-2|MOLNIYA 1-80|DECAYED-Z', '对象类型 PAY', run(F({ type: 'PAY' })).join('|'))
ok(run(F({ type: 'DEB' })).join('|') === 'DEB-X', '对象类型 DEB')
ok(run(F({ type: 'R/B' })).join('|') === 'RB-Y', '对象类型 R/B')
ok(run(F({ status: 'active' })).join('|') === 'ISS|CS-6D|GPS BIIF-2', '状态 运行（ACTIVE_STATUS 集合）', run(F({ status: 'active' })).join('|'))
ok(run(F({ status: 'inactive' })).join('|') === 'MOLNIYA 1-80', '状态 停运')
// ★ 编目里查不到的那颗（NOCAT）也算「未知」：它的状态确实无从得知。
// 与「所有者 PRC」那一条不同 —— 那是「查不到就不能确认是 PRC」，这是「查不到本身就是未知」。
ok(run(F({ status: 'unknown' })).join('|') === 'DEB-X|RB-Y|NOCAT', '状态 未知（空串 / ? / 编目里根本没有）', run(F({ status: 'unknown' })).join('|'))
ok(run(F({ status: 'decayed' })).join('|') === 'DECAYED-Z', '状态 已陨落（有 DECAY_DATE 的优先算陨落）')
ok(run(F({ launchFrom: 2010, launchTo: 2016 })).join('|') === 'CS-6D|GPS BIIF-2|DEB-X', '发射年 2010–2016', run(F({ launchFrom: 2010, launchTo: 2016 })).join('|'))
ok(run(F({ launchFrom: 2020 })).join('|') === 'RB-Y', '发射年 ≥2020（只给下界）')
ok(run(F({ launchTo: 1999 })).join('|') === 'ISS|MOLNIYA 1-80', '发射年 ≤1999（只给上界）')
ok(SF.statusKind(null) === 'unknown', '没有编目行 -> 未知')
ok(SF.launchYearOf({ launchDate: '2016-12-10' }) === 2016, '发射年取前四位')
ok(SF.launchYearOf({ launchDate: '' }) === null, '没有发射日期 -> null')

/* ===== ③ 几何五项，各一例 ===== */
section('几何五项')
ok(run(F({ orbit: 'GEO' })).join('|') === 'CS-6D', '轨道区制 GEO', run(F({ orbit: 'GEO' })).join('|'))
ok(run(F({ orbit: 'MEO' })).join('|') === 'GPS BIIF-2', '轨道区制 MEO', run(F({ orbit: 'MEO' })).join('|'))
ok(run(F({ orbit: 'HEO' })).join('|') === 'MOLNIYA 1-80|RB-Y', '轨道区制 HEO', run(F({ orbit: 'HEO' })).join('|'))
ok(run(F({ orbit: 'LEO' })).join('|') === 'ISS|DEB-X|DECAYED-Z|NOCAT', '轨道区制 LEO', run(F({ orbit: 'LEO' })).join('|'))
ok(run(F({ perigeeFrom: 20000 })).join('|') === 'CS-6D|GPS BIIF-2', '近地点 ≥20000 km', run(F({ perigeeFrom: 20000 })).join('|'))
ok(run(F({ apogeeFrom: 35000, apogeeTo: 36000 })).join('|') === 'CS-6D|RB-Y', '远地点 35000–36000 km', run(F({ apogeeFrom: 35000, apogeeTo: 36000 })).join('|'))
ok(run(F({ inclFrom: 50, inclTo: 60 })).join('|') === 'ISS|GPS BIIF-2|DECAYED-Z', '倾角 50–60°', run(F({ inclFrom: 50, inclTo: 60 })).join('|'))
ok(run(F({ inclFrom: 0, inclTo: 1 })).join('|') === 'CS-6D', '倾角 0–1°（赤道）')
ok(run(F({ periodFrom: 1400, periodTo: 1500 })).join('|') === 'CS-6D|RB-Y', '周期 1400–1500 min', run(F({ periodFrom: 1400, periodTo: 1500 })).join('|'))
// NOCAT 的平均运动 14.0 rev/d -> 周期 102.9 min，正好落在 100 min 之外
ok(run(F({ periodTo: 100 })).join('|') === 'ISS|DEB-X|DECAYED-Z', '周期 ≤100 min', run(F({ periodTo: 100 })).join('|'))
ok(run(F({ periodTo: 105 })).join('|') === 'ISS|DEB-X|DECAYED-Z|NOCAT', '周期 ≤105 min 才带上 NOCAT（102.9 min）')

/* ===== ④ 组合 ===== */
section('组合')
ok(run(F({ owner: 'PRC', type: 'PAY', orbit: 'GEO' })).join('|') === 'CS-6D', '★ 所有者 PRC · 载荷 · GEO（§12 验收清单第 ⑤ 条）')
ok(run(F({ owner: 'US', orbit: 'LEO' })).join('|') === 'ISS|DECAYED-Z', '所有者 US + LEO')
ok(run(F({ type: 'PAY', inclFrom: 60 })).join('|') === 'MOLNIYA 1-80', '载荷 + 倾角 ≥60°')
ok(run(F({ owner: 'PRC', orbit: 'MEO' })).length === 0, '筛空了就是空的（不兜底）')
ok(run(F({ owner: 'US', type: 'PAY', status: 'active', launchFrom: 2000, orbit: 'MEO', inclFrom: 50, periodFrom: 700 })).join('|') === 'GPS BIIF-2',
  '七项一起筛', run(F({ owner: 'US', type: 'PAY', status: 'active', launchFrom: 2000, orbit: 'MEO', inclFrom: 50, periodFrom: 700 })).join('|'))

/* ===== ⑤ ★ 没有编目时：前四项一律不限 ===== */
section('没有卫星编目')
for (const idx of [null, undefined === undefined ? new Map() : null]) {
  const got = run(F({ owner: 'PRC' }), idx)
  ok(got.length === POOL.length, '没有编目时「所有者」不筛任何星（' + got.length + '/' + POOL.length + '）')
}
ok(run(F({ type: 'DEB' }), null).length === POOL.length, '没有编目时「对象类型」不筛')
ok(run(F({ status: 'active' }), null).length === POOL.length, '没有编目时「状态」不筛')
ok(run(F({ launchFrom: 2010 }), null).length === POOL.length, '没有编目时「发射年」不筛')
// 但几何五项照筛
ok(run(F({ orbit: 'GEO' }), null).join('|') === 'CS-6D', '★ 没有编目时几何五项照常筛（它们与编目无关）')
ok(run(F({ inclFrom: 50, inclTo: 60 }), null).join('|') === 'ISS|GPS BIIF-2|DECAYED-Z', '没有编目时倾角照筛')
// 有编目但这颗星不在编目里
ok(run(F({ owner: 'PRC' })).indexOf('NOCAT') < 0, '有编目但查不到这颗 -> 按不匹配处理（筛所有者时它不出现）')
ok(run(F({ orbit: 'LEO' })).indexOf('NOCAT') >= 0, '同一颗星在几何筛选里照常出现')

/* ===== ⑥ 归一化与持久化往返 ===== */
section('归一化')
const n1 = SF.normalize({ owner: 'PRC', inclFrom: '30', inclTo: '', junk: 1 })
ok(n1.owner === 'PRC' && n1.inclFrom === 30 && n1.inclTo === null, '字符串数值归一成 number|null', JSON.stringify(n1.inclFrom) + '/' + JSON.stringify(n1.inclTo))
ok(!('junk' in n1), '认不得的键丢掉（localStorage 里的旧结构不带进来）')
ok(JSON.stringify(SF.normalize(JSON.parse(JSON.stringify(n1)))) === JSON.stringify(n1), 'JSON 往返幂等')
ok(SF.normalize(null).owner === '' && SF.isEmpty(SF.normalize(null)), 'null 归一成空筛选')

/* ===== ⑦ 派生量 ===== */
section('派生量')
const m = SF.metricsOf(POOL[1], ROWS[41838])
ok(Math.abs(m.periodMin - 1436) < 2, 'GEO 周期由平均运动算出 ≈1436 min', String(m.periodMin))
ok(m.orbit === 'GEO', 'GEO 区制')
const m2 = SF.metricsOf({ noradId: '1' }, { inclDeg: 98, periodMin: 100, apogeeKm: 800, perigeeKm: 780 })
ok(m2.incl === 98 && m2.periodMin === 100, '池记录缺项时回退到编目行', m2.incl + '/' + m2.periodMin)
const m3 = SF.metricsOf({ noradId: '2' }, null)
ok(m3.incl === null && m3.orbit === null, '两边都没有 -> 全 null（不编数）')
ok(SF.ownersIn(POOL, IDX).join(',') === 'CIS,PRC,TBD,US', '所有者下拉只列池里真有的那些（已排序）', SF.ownersIn(POOL, IDX).join(','))
ok(SF.ownersIn(POOL, null).length === 0, '没有编目时所有者下拉为空')

/* ===== ⑧ 清单常量 ===== */
section('清单')
ok(SF.OBJECT_TYPES.join('|') === 'PAY|R/B|DEB|UNK', '对象类型四档')
ok(SF.ORBIT_CLASSES.join('|') === 'GEO|IGSO|MEO|LEO|HEO', '轨道区制五档')
ok(SF.STATUS_KINDS.length === 4 && SF.STATUS_KINDS.every((s) => s.key && s.zh && s.en), '状态四档各有中英名')

/* ===== ⑨ ★ 真实池形记录：根数在 rec（satrec）里，不是扁平字段 ===== */
// 搜索池（ConstellationMap3D 的 setSearchPool / buildEntries / 自建星座 build）产出的记录形如
// { rec: satrec, name, noradId, group }，根数在 satrec 的 inclo / no / ecco / alta / altp 上。
// metricsOf 原来只认扁平字段，四种池记录形状一个都不命中 —— 于是「没下载编目时按倾角筛 → 0 颗」。
// NORAD 一律取 8000x（故意【不在】上面的 ROWS / IDX 里），一并钉死「有编目但这颗查不到时几何五项照样筛」。
section('池形记录（rec 是 satrec）')
const REC = (id, name, incl, mm, ecc) => ({
  rec: sat.omm2satrec({ noradId: String(id), epoch: '2026-09-20T00:00:00.000000', meanMotion: mm, ecc, incl, raan: 0, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 }),
  name, noradId: String(id), group: 'other'
})
const SPOOL = [
  REC(80001, 'ISS/池', 51.64, 15.5, 0.0007),       // LEO
  REC(80002, 'CS-6D/池', 0.03, 1.0027, 0.0002),    // GEO
  REC(80003, 'GPS/池', 55.0, 2.0056, 0.006),       // MEO
  REC(80004, 'MOLNIYA/池', 63.4, 2.006, 0.72)      // HEO
]
const mPool = SF.metricsOf(SPOOL[0], null)
ok(mPool.incl != null && Math.abs(mPool.incl - 51.64) < 0.01, '★ 倾角从 satrec 的 inclo 取到', String(mPool.incl))
ok(mPool.periodMin != null && Math.abs(mPool.periodMin - 92.9136) < 0.01, '★ 周期从 satrec 的 no 取到', String(mPool.periodMin))
ok(mPool.apogeeKm != null && Math.abs(mPool.apogeeKm - 422) < 5, '★ 远地点高度从 alta×RE 取到', String(mPool.apogeeKm))
ok(mPool.perigeeKm != null && Math.abs(mPool.perigeeKm - 412) < 5, '★ 近地点高度从 altp×RE 取到', String(mPool.perigeeKm))
ok(mPool.orbit === 'LEO', '★ 区制判得出来', String(mPool.orbit))
const byIncl = (lo, hi, index) => SPOOL.filter(SF.makePredicate({ ...SF.emptyFilters(), inclFrom: lo, inclTo: hi }, index)).map((r) => r.name)
ok(byIncl(50, 60, null).join(',') === 'ISS/池,GPS/池', '★ 无编目时按倾角筛命中（原来是 0 颗）', byIncl(50, 60, null).join(','))
ok(byIncl(50, 60, IDX).join(',') === 'ISS/池,GPS/池', '★ 有编目但这几颗不在编目里，仍照样命中', byIncl(50, 60, IDX).join(','))
const byOrbit = (o) => SPOOL.filter(SF.makePredicate({ ...SF.emptyFilters(), orbit: o }, null)).map((r) => r.name)
ok(byOrbit('GEO').join(',') === 'CS-6D/池', '★ 按区制筛 GEO', byOrbit('GEO').join(','))
ok(byOrbit('MEO').join(',') === 'GPS/池', '★ 按区制筛 MEO', byOrbit('MEO').join(','))
ok(byOrbit('HEO').join(',') === 'MOLNIYA/池', '★ 按区制筛 HEO', byOrbit('HEO').join(','))
// GPS（2.0056 圈/日）与 Molniya（2.006）周期都是 718 min，靠周期分不开它们；
// 取 1400–1500 只圈住同步周期那一颗，判据才唯一
const byPeriod = (lo, hi) => SPOOL.filter(SF.makePredicate({ ...SF.emptyFilters(), periodFrom: lo, periodTo: hi }, null)).map((r) => r.name)
ok(byPeriod(1400, 1500).join(',') === 'CS-6D/池', '★ 按周期筛（1436 min 的 GEO）', byPeriod(1400, 1500).join(','))
ok(byPeriod(700, 800).join(',') === 'GPS/池,MOLNIYA/池', '★ 12 h 那两颗一起命中（718 / 718 min）', byPeriod(700, 800).join(','))
const byPer = (lo, hi) => SPOOL.filter(SF.makePredicate({ ...SF.emptyFilters(), perigeeFrom: lo, perigeeTo: hi }, null)).map((r) => r.name)
ok(byPer(0, 500).join(',') === 'ISS/池', '★ 按近地点高度筛（ISS 412 km）', byPer(0, 500).join(','))
ok(byPer(900, 1200).join(',') === 'MOLNIYA/池', '★ 大偏心那颗按近地点筛（1058 km，不是半长轴）', byPer(900, 1200).join(','))
// helper 直测：单位换算不许漂
const gm = SM.metricsFromSatrec(SPOOL[1].rec)
ok(Math.abs(gm.periodMin - 1436.176) < 0.05, 'metricsFromSatrec：GEO 周期 ≈ 1436.18 min', String(gm.periodMin))
ok(Math.abs(gm.meanMotion - 1.0027) < 1e-3, 'metricsFromSatrec：平均运动回读', String(gm.meanMotion))
ok(Math.abs(gm.apogeeKm - 35796) < 20 && Math.abs(gm.perigeeKm - 35780) < 20, 'metricsFromSatrec：近远地点是【高度】不是地心距',
  gm.perigeeKm.toFixed(0) + ' / ' + gm.apogeeKm.toFixed(0))
ok(SM.metricsFromSatrec(null) === null && SM.metricsFromSatrec({}) === null, 'metricsFromSatrec 认不出返回 null')
ok(SM.metricsFromEntry(SPOOL[0]) !== null && SM.metricsFromEntry({ name: 'x' }) === null, 'metricsFromEntry 判形')

/* ===== ⑩ ★ 星历点序列星：{ eph: 采样表 } ===== */
// 池里第四种形状（ephemEntriesOf 造的 entry）压根没有 rec。周期只能由表内相邻两次升交点估，
// 近远地点只能由整表地心距极值减 RE，估不出的一律 null —— 不拿不足一圈的端点冒充。
section('星历点序列星（eph 是采样表）')
{
  const RE0 = 6378.137, R = RE0 + 500, nn = Math.sqrt(398600.4418 / (R * R * R))
  const inc = 51.6 * Math.PI / 180, ci = Math.cos(inc), si = Math.sin(inc)
  const mkTab = (minutes, step) => {
    const cnt = Math.round(minutes * 60 / step) + 1
    const t = new Float64Array(cnt), p = new Float64Array(3 * cnt), v = new Float64Array(3 * cnt)
    for (let i = 0; i < cnt; i++) {
      const s = i * step, u = nn * s
      t[i] = Date.UTC(2026, 8, 21) + s * 1000
      p[3 * i] = R * Math.cos(u); p[3 * i + 1] = R * Math.sin(u) * ci; p[3 * i + 2] = R * Math.sin(u) * si
      v[3 * i] = -R * nn * Math.sin(u); v[3 * i + 1] = R * nn * Math.cos(u) * ci; v[3 * i + 2] = R * nn * Math.cos(u) * si
    }
    return tableFrom({ t, p, v, method: 'lagrange', samples: 6 })
  }
  const longTab = mkTab(200, 60)      // 200 min > 2 圈（真周期 94.6 min）
  const shortTab = mkTab(29, 60)      // 不足一圈
  const eLong = { eph: longTab, name: '星历/长', noradId: '800000', group: 'ci:g1' }
  const eShort = { eph: shortTab, name: '星历/短', noradId: '800001', group: 'ci:g1' }
  const mL = SF.metricsOf(eLong, null)
  ok(mL.incl != null && Math.abs(mL.incl - 51.6) < 0.05, '★ 倾角由轨道面法向算出', String(mL.incl))
  ok(mL.periodMin != null && Math.abs(mL.periodMin - 94.62) < 0.05, '★ 周期由表内两次升交点估出', String(mL.periodMin))
  ok(mL.apogeeKm != null && Math.abs(mL.apogeeKm - 500) < 1 && Math.abs(mL.perigeeKm - 500) < 1,
    '★ 近远地点由地心距极值减 RE（圆轨道两者相等）', mL.perigeeKm + ' / ' + mL.apogeeKm)
  ok(mL.orbit === 'LEO', '★ 星历星也判得出区制', String(mL.orbit))
  const hitEph = [eLong, eShort].filter(SF.makePredicate({ ...SF.emptyFilters(), inclFrom: 50, inclTo: 55 }, null)).map((r) => r.name)
  ok(hitEph.join(',') === '星历/长,星历/短', '★ 按倾角筛，两种表都命中（倾角不靠周期）', hitEph.join(','))
  const mS = SF.metricsOf(eShort, null)
  ok(mS.incl != null, '短表仍算得出倾角', String(mS.incl))
  ok(mS.periodMin === null && mS.apogeeKm === null && mS.perigeeKm === null,
    '★ 不足一圈的表：周期 / 近远地点一律 null，不编数', [mS.periodMin, mS.apogeeKm, mS.perigeeKm].join(','))
  const hitPeriod = [eLong, eShort].filter(SF.makePredicate({ ...SF.emptyFilters(), periodFrom: 90, periodTo: 100 }, null)).map((r) => r.name)
  ok(hitPeriod.join(',') === '星历/长', '要筛周期时，估不出周期的那颗不命中（inRange 对 null 返 false）', hitPeriod.join(','))
  ok(!!longTab._metrics, '结果缓存在表上，逐拍筛选不重复扫全表')
  ok(SM.periodMinFromNo(0) === null && Math.abs(SM.periodMinFromNo(2 * Math.PI / 100) - 100) < 1e-9, 'periodMinFromNo 单位对')
}

console.log('\nsatFilter: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
