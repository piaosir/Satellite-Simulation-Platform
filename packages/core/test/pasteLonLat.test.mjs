// 定位块粘贴「末两列 = 经纬度」兜底（src/shared/pasteLonLat.js）+ 三处接线（标记批量表格 / 对地性能表城市 / 气象表）。
// 运行：node packages/core/test/pasteLonLat.test.mjs
//   ① v1.4.13 列序的窄块从文本列粘：末两格落经纬度，其余从起始列依次落（地球站 / 点标记 / 城市 / 气象）
//   ② 照旧按位置：从数字列起粘、块够宽（新列序整行）、末两格不是合法经纬度、有一行不合格、起点在经纬度上
//   ③ 行尾空格不算宽度；整行空不落
//   ④ 真表：useMarkerTable 的 pasteBlock 用老列序粘进地球站 / 点标记，经纬度落对、口径不被写
//   ⑤ 源码钉：usePerfTable / MetTableWin 的 pasteBlock 都走 lonLatPasteKeys
import { readFileSync } from 'node:fs'
import { lonLatPasteKeys } from '../../../src/shared/pasteLonLat.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const src = (p) => readFileSync(new URL('../../../' + p, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const keysFor = (cols, start, grid, textKeys) => { const f = lonLatPasteKeys(cols, start, grid, { textKeys }); return f ? grid.map((r) => f(r)) : null }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const ST = ['name', 'diaM', 'radome', 'pwrW', 'lon', 'lat']
const PT = ['name', 'lon', 'lat']
const CITY = ['country', 'city', 'desig', 'tMs', 'altM', 'lon', 'lat']
const MET = ['name', 'tMs', 'lon', 'lat']

// ① 老列序窄块
ok(eq(keysFor(ST, 'name', [['北京站', '116.4', '39.9'], ['上海站', '121.47', '31.23']], ['name']),
  [['name', 'lon', 'lat'], ['name', 'lon', 'lat']]), '地球站：「名称 / 经度 / 纬度」→ 名称、经度、纬度（不进口径）')
ok(eq(keysFor(PT, 'name', [['116.4', '39.9']], ['name']), [['lon', 'lat']]), '点标记：「经度 / 纬度」从名称列粘 → 经度、纬度（名称不动）')
ok(eq(keysFor(CITY, 'country', [['中国', '上海', 'SH', '121.47', '31.23']], ['country', 'city', 'desig']),
  [['country', 'city', 'desig', 'lon', 'lat']]), '城市：「国家 / 城市 / 代号 / 经度 / 纬度」→ 不进时间 / 高度')
ok(eq(keysFor(CITY, 'city', [['上海', '121.47', '31.23']], ['country', 'city', 'desig']),
  [['city', 'lon', 'lat']]), '城市：从城市列粘「城市 / 经度 / 纬度」')
ok(eq(keysFor(MET, 'name', [['上海', '121.47', '31.23']], ['name']), [['name', 'lon', 'lat']]), '气象：「站名 / 经度 / 纬度」→ 不进时间')
ok(eq(keysFor(ST, 'name', [['西经站', '－75.5', '−33.2']], ['name']), [['name', 'lon', 'lat']]), '全角 / 数学减号的负经纬度照认')
ok(eq(keysFor(ST, 'name', [['东经站', '200', '10']], ['name']), [['name', 'lon', 'lat']]), '经度 0–360 写法照认')

// ② 照旧按位置
ok(keysFor(ST, 'diaM', [['4.5', '1']], ['name']) === null, '从口径列起粘（数字列）：按位置——不把口径 / 天线罩当经纬度')
ok(keysFor(CITY, 'tMs', [['2026-10-07 12:00', '1000']], ['country', 'city', 'desig']) === null, '从时间列起粘：按位置')
ok(keysFor(ST, 'name', [['北京站', '4.5', '', '100', '116.4', '39.9']], ['name']) === null, '新列序整行（够宽）：按位置')
ok(keysFor(ST, 'name', [['北京站', '天线罩']], ['name']) === null, '末两格不是数字：按位置')
ok(keysFor(ST, 'name', [['北京站', '116.4', '139.9']], ['name']) === null, '纬度越界（139.9）：按位置')
ok(keysFor(ST, 'name', [['北京站', '116.4', '39.9'], ['坏行', 'x', 'y']], ['name']) === null, '块里有一行不合格：整块按位置（不混用两种落位）')
ok(keysFor(ST, 'lon', [['116.4', '39.9']], ['name']) === null, '起点就在经度列：按位置（本来就对）')
ok(keysFor(ST, 'name', [['116.4']], ['name']) === null, '单格：按位置')

// ③ 行尾空格 / 空行
ok(eq(keysFor(ST, 'name', [['北京站', '116.4', '39.9', '', '']], ['name']), [['name', 'lon', 'lat', null, null]]), '行尾空格不算宽度、不落')
ok(eq(keysFor(ST, 'name', [['北京站', '116.4', '39.9'], ['', '', '']], ['name']), [['name', 'lon', 'lat'], [null, null, null]]), '整行空：不落（不清掉该行已有的值）')

// ④ 真表：useMarkerTable（vue 的 ref 在 node 里可直接用）
{
  const { useMarkerTable } = await import('../../../src/viz/markers/useMarkerTable.js').catch(() => ({}))
  if (typeof useMarkerTable === 'function') {
    const { ref } = await import('vue')
    const points = ref([]), stations = ref([{ id: 's1', name: '旧站', lon: 100, lat: 20, diaM: 7.3 }]), trajectories = ref([])
    let seq = 0
    const t = useMarkerTable({ points, stations, trajectories, newId: () => 'n' + (++seq), sync: () => {}, parseTime: () => null })
    t.stLayer.pasteBlock('s1', 'name', '北京站\t116.4\t39.9\n上海站\t121.47\t31.23')
    const s = stations.value
    ok(s.length === 2 && s[0].name === '北京站' && s[0].lon === 116.4 && s[0].lat === 39.9 && s[0].diaM === 7.3 && s[1].lon === 121.47 && s[1].lat === 31.23 && s[1].diaM == null,
      '地球站表：老列序覆盖已有行 → 坐标换成新的、口径不被经度写坏', JSON.stringify(s.map((x) => [x.name, x.diaM, x.lon, x.lat])))
    t.ptLayer.pasteBlock(null, 'name', '116.4\t39.9')
    ok(points.value.length === 1 && points.value[0].lon === 116.4 && points.value[0].lat === 39.9 && !points.value[0].name, '点标记表：「经度 / 纬度」从名称列粘 → 坐标落对、名称留空')
    t.stLayer.pasteBlock('s1', 'name', '北京站\t4.5\t有\t200\t116.4\t39.9')
    ok(s[0].diaM === 4.5 && s[0].radome === true && s[0].pwrW === 200 && s[0].lon === 116.4, '地球站表：新列序整行照旧按位置')
  } else ok(true, '（useMarkerTable 未能在 node 下载入，跳过真表段）')
}

// ⑤ 源码钉
const perf = src('src/viz/grd/usePerfTable.js'), met = src('src/perf/MetTableWin.vue'), mk = src('src/viz/markers/useMarkerTable.js')
ok(/function pasteBlock\(startId, startKey, text\) \{[\s\S]*?lonLatPasteKeys\(EDIT_COLS, EDIT_COLS\[c0\], grid, \{ textKeys: \['country', 'city', 'desig'\] \}\)/.test(perf), '对地性能表城市列表 pasteBlock 走 lonLatPasteKeys（文本列 = 国家 / 城市 / 代号）')
ok(/function pasteBlock\(anchorId, startKey, text\) \{[\s\S]*?lonLatPasteKeys\(keys0, startKey, grid, \{ textKeys: \['name'\] \}\)/.test(met), '气象表 pasteBlock 走 lonLatPasteKeys（文本列 = 站名）')
ok(/function pasteBlock\(anchorId, startKey, text\) \{[\s\S]*?lonLatPasteKeys\(cols, cols\[c0\], grid, \{ textKeys \}\)/.test(mk), '标记批量表格 pasteBlock 走 lonLatPasteKeys')

console.log(`\npasteLonLat: ${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`)
if (fail) process.exit(1)
