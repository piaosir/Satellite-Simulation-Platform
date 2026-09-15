// 对地性能指标表的【站点库逐表独立】自测（src/viz/grd/usePerfTable.js）。运行：npm test
//
// 站点库曾是全表共享的一份：在一根天线的表里改城市，别的天线的表跟着变。改成一根天线一份之后，
// 逐条钉死四件会静默出错的事：
//   ① 表要先 setActiveKey 绑到一根天线才收得下城市 —— 没绑就往里加，返回值不许说加成功了；
//   ② 两张表互不污染：A 表加/删/清空都不许动到 B 表，切回来还得原样在；
//   ③ 撤销栈不跨表 —— 栈里存的是整份城市列表，切表不丢的话在新表按一次 Ctrl+Z 就把上一张表的城市贴过来了；
//   ④ 老快照（全表共享一份）迁移：原样复制给每一根【开过表的】天线，此后各改各的；
//   ⑤ 「城市组」仍是全表共享的预设库 —— 那正是分家之后跨表复用的手段。
import { usePerfTable, fillOpts } from '../../../src/viz/grd/usePerfTable.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const cities = (p) => p.stations.value.map((s) => s.city).join(',')
// 加一座城（与 UI 上「增加一行 + 逐格键入」同一条路径）
function addCity(p, city, lon, lat) {
  const s = p.addEmptyStation()
  if (s) p.updateStation(s.id, { city, lon, lat })
  return s
}

// ==================== ① 没开表：加不进，也不许说加进去了 ====================
{
  const p = usePerfTable()
  ok('① 没开表城市列表为空', p.stations.value.length === 0)
  ok('① 没开表加不进城市', p.addEmptyStation() === null && p.stations.value.length === 0)
  ok('① 没开表粘贴返回 0', p.addStationsBulk('北京\t116.4\t39.9') === 0)
  ok('① 没开表从标记导入返回 0', p.importFromMarkers([{ lon: 1, lat: 2 }], []) === 0)
}

// ==================== ② 两张表互不污染 ====================
{
  const A = 'satX|ant1', B = 'satX|ant2'
  const p = usePerfTable()
  p.setActiveKey(A)
  addCity(p, '北京', 116.4, 39.9)
  addCity(p, '上海', 121.5, 31.2)
  ok('② A 表两座城', cities(p) === '北京,上海', cities(p))

  p.setActiveKey(B)
  ok('② 新表从空白起', p.stations.value.length === 0, cities(p))
  addCity(p, '广州', 113.3, 23.1)
  ok('② B 表加的城不进 A 表', cities(p) === '广州')

  p.setActiveKey(A)
  ok('② 切回 A 表原样还在', cities(p) === '北京,上海', cities(p))
  // A 表里改一座城的名字 → B 表不受影响（曾是同一批对象，改一处两边都变）
  p.updateStation(p.stations.value[0].id, { city: '北京-改' })
  p.setActiveKey(B)
  ok('② 改 A 表的城不牵动 B 表', cities(p) === '广州')
  p.setActiveKey(A)
  ok('② A 表的改动落在 A 表', cities(p) === '北京-改,上海', cities(p))

  p.clearStations()
  p.setActiveKey(B)
  ok('② 清空 A 表不动 B 表', cities(p) === '广州')
}

// ==================== ③ 撤销栈不跨表 ====================
{
  const A = 'satX|ant1', B = 'satX|ant2'
  const p = usePerfTable()
  p.setActiveKey(A)
  p.pushUndo(); addCity(p, '北京', 116.4, 39.9)
  ok('③ A 表可撤销', p.canUndo.value === true)
  p.setActiveKey(B)
  ok('③ 切表后撤销栈已清', p.canUndo.value === false && p.canRedo.value === false)
  ok('③ 切表后按撤销什么也没有', p.undo() === false && p.stations.value.length === 0)
  p.setActiveKey(A)
  ok('③ A 表的城市没被撤销掉', cities(p) === '北京')
}

// ==================== ④ 老快照迁移：共享的那一份复制给每根开过表的天线 ====================
{
  const A = 'A|a1', B = 'B|b1'
  const legacy = {
    optsByAnt: { [A]: { cols: {} }, [B]: { cols: {} } },     // 键＝开过表的天线，迁移必须排在它之后
    stations: [{ country: '中国', city: '北京', desig: 'BJ', lon: 116.4, lat: 39.9 }]
  }
  const p = usePerfTable()
  p.restoreState(legacy)
  p.setActiveKey(A)
  ok('④ 老快照迁移：A 表拿到那份城市', cities(p) === '北京')
  addCity(p, '只在A', 1, 1)
  p.setActiveKey(B)
  ok('④ 老快照迁移：B 表拿到的是自己那份副本', cities(p) === '北京', cities(p))
  p.setActiveKey(A)
  ok('④ 老快照迁移后两表已分家', cities(p) === '北京,只在A', cities(p))

  // 新格式存档：两张表各存各的，恢复后仍各是各的
  const st = JSON.parse(JSON.stringify(p.getState()))
  ok('④ 新存档逐天线存', Object.keys(st.stationsByAnt).sort().join(',') === [A, B].sort().join(','), Object.keys(st.stationsByAnt).join(','))
  const p2 = usePerfTable()
  p2.restoreState(st)
  p2.setActiveKey(B)
  ok('④ 恢复后 B 表还是一座城', cities(p2) === '北京')
  p2.setActiveKey(A)
  ok('④ 恢复后 A 表还是两座城', cities(p2) === '北京,只在A', cities(p2))
}

// ==================== ⑤ 城市组＝全表共享的预设库（分家之后跨表复用就靠它）====================
{
  const A = 'satX|ant1', B = 'satX|ant2'
  const p = usePerfTable()
  p.setActiveKey(A)
  addCity(p, '北京', 116.4, 39.9)
  addCity(p, '上海', 121.5, 31.2)
  const gid = p.addCityGroup('华东两城')
  ok('⑤ 存组成功', !!gid && p.cityGroups.value.length === 1)

  p.setActiveKey(B)
  ok('⑤ 在 B 表里也看得见这个组', p.cityGroups.value.length === 1)
  ok('⑤ 载入组＝把那批城市搬进 B 表', p.loadCityGroup(gid) === 2 && cities(p) === '北京,上海', cities(p))
  addCity(p, '广州', 113.3, 23.1)
  p.setActiveKey(A)
  ok('⑤ 载入组之后两表仍各是各的', cities(p) === '北京,上海', cities(p))

  // 组随快照存盘，且不跟着某一张表走
  const st = JSON.parse(JSON.stringify(p.getState()))
  const p2 = usePerfTable()
  p2.restoreState(st)
  ok('⑤ 组随快照回来', p2.cityGroups.value.length === 1 && p2.cityGroups.value[0].cities.length === 2)
}

// ==================== ⑥ 城市层总开关（树里「性能指标表」行的眼睛）====================
{
  const A = 'satY|ant1', B = 'satY|ant2'
  const p = usePerfTable()
  ok('⑥ 没建过桶也读得出：出厂关，且读不建桶', p.cityShowOf(A) === false && !p.hasOpts(A))
  p.setCityShow(A, true)
  ok('⑥ 打开后读回 true，只动这一根', p.cityShowOf(A) === true && p.getOpts(A).cityShow === true && p.cityShowOf(B) === false)
  p.rememberOpts(A)
  ok('⑥ 眼睛不进「记住上次选择」模板：新天线的表从关起', p.getOpts(B).cityShow === false)
  const st = JSON.parse(JSON.stringify(p.getState()))
  const p2 = usePerfTable(); p2.restoreState(st)
  ok('⑥ 随快照存盘', st.cityDefault === 'off' && p2.cityShowOf(A) === true && p2.cityShowOf(B) === false)
  ok('⑥ 老快照缺键 → 关', fillOpts({}).cityShow === false && fillOpts({ cityShow: true }).cityShow === true)
  const p3 = usePerfTable()
  p3.restoreState({ optsByAnt: { [A]: { cityShow: true } }, optsTemplate: { cityShow: true }, stationsByAnt: {} })   // 没有 cityDefault 标记：中间版本落下的 true 归零
  ok('⑥ 没有标记的快照里的 cityShow:true 一次性归零', p3.cityShowOf(A) === false && p3.getOpts(B).cityShow === false)
}

// ==================== ⑦ 「仅覆盖波束」默认关 + 老快照一次性归零 ====================
{
  ok('⑦ 出厂默认关', usePerfTable().getOpts('s|a').filterOn === false)
  const p = usePerfTable()
  p.restoreState({ optsByAnt: { 's|a': { filterOn: true, minDir: 60 } }, optsTemplate: { filterOn: true, minDir: 60 }, stationsByAnt: {} })   // 老快照：没有 filterDefault 标记
  ok('⑦ 老快照里的 filterOn:true 归零、阈值保留', p.getOpts('s|a').filterOn === false && p.getOpts('s|a').minDir === 60)
  ok('⑦ 老快照的模板也归零：新天线不再继承旧出厂默认', p.getOpts('s|b').filterOn === false && p.getOpts('s|b').minDir === 60)
  p.getOpts('s|a').filterOn = true
  const st = JSON.parse(JSON.stringify(p.getState()))
  const p2 = usePerfTable(); p2.restoreState(st)
  ok('⑦ 新快照带标记：用户勾上的原样回来', st.filterDefault === 'off' && p2.getOpts('s|a').filterOn === true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
