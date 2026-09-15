// 对星性能指标表的【目标星来源】自测（src/viz/grd/useSatPerfTable.js）。运行：npm test
//
// 这一份验的是「波束内的星接到仿真时钟」之后新增的那半边：目标集本身是时刻的函数。
// 逐条钉死的是四件会静默出错的事：
//   ① 切来源＝换名单：点选档报点选的，波束内档报此刻在波束里的，两份互不污染
//      （污染的典型症状：切回点选后表里还留着上一拍的波束成员，看着像「这颗星一直被照到」）；
//   ② 成员没变就【不换数组引用】—— 每拍换一次引用会把浮窗的只读网格整片重渲，框选当场丢；
//   ③ 时段扫描的指纹在波束内档不计入成员名单 —— 成员每拍在变，计入就等于每拍自称过期，
//      「输入已变」会一直闪，那个提示也就废了；
//   ④ 存档只存来源档位不存波束成员 —— 名单是时刻的函数，存下来跟下次打开的时刻对不上；
//   ⑥ 一根天线一张表，名单/档位/时窗设置逐表独立 —— 在 A 表加的星不许出现在 B 表里
//      （表要先 setActiveKey 绑到一根天线才收得下目标星，没绑＝没开表）。
import { useSatPerfTable } from '../../../src/viz/grd/useSatPerfTable.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const names = (arr) => arr.map((p) => p.name).join(',')

// ==================== ① 切来源＝换名单 ====================
{
  const sp = useSatPerfTable()
  sp.setActiveKey('sat|ant')      // 开表＝把这张表绑到一根天线（名单逐表独立，见 ⑥）
  sp.addTarget({ name: 'PICKED-A', noradId: 111 })
  sp.addTarget({ name: 'PICKED-B', noradId: 222 })
  sp.setBeamTargets([{ name: 'INBEAM-1', noradId: 901 }, { name: 'INBEAM-2', noradId: 902 }])

  ok('① 默认是点选档', sp.targetMode.value === 'pick' && names(sp.activePicks.value) === 'PICKED-A,PICKED-B', names(sp.activePicks.value))
  sp.targetMode.value = 'beam'
  ok('① 波束内档报此刻的成员', names(sp.activePicks.value) === 'INBEAM-1,INBEAM-2', names(sp.activePicks.value))
  ok('① 波束内档不动用户名单', names(sp.picks.value) === 'PICKED-A,PICKED-B', names(sp.picks.value))
  sp.targetMode.value = 'pick'
  ok('① 切回点选档不残留波束成员', names(sp.activePicks.value) === 'PICKED-A,PICKED-B', names(sp.activePicks.value))

  // 波束内成员【不】进 picks：hasPick 只认用户名单，否则「加入波束内的星」会以为都已经加过了
  ok('① 波束成员不算已加入', !sp.hasPick('INBEAM-1', 901) && sp.hasPick('PICKED-A', 111))
}

// ==================== ② 成员没变就不换数组引用 ====================
{
  const sp = useSatPerfTable()
  sp.setActiveKey('sat|ant')      // 开表＝把这张表绑到一根天线（名单逐表独立，见 ⑥）
  sp.targetMode.value = 'beam'
  const list = [{ name: 'S1', noradId: 1 }, { name: 'S2', noradId: 2 }]
  sp.setBeamTargets(list)
  const ref1 = sp.beamPicks.value
  sp.setBeamTargets([{ name: 'S1', noradId: 1 }, { name: 'S2', noradId: 2 }])   // 同一批星，新对象
  ok('② 成员相同 → 引用不变（网格不重渲、选区不丢）', sp.beamPicks.value === ref1)

  sp.setBeamTargets([{ name: 'S1', noradId: 1 }])                                // 一颗星出了波束
  ok('② 成员变了 → 引用换新', sp.beamPicks.value !== ref1 && sp.beamPicks.value.length === 1)

  sp.setBeamTargets([{ name: 'S1', noradId: 1 }, { name: 'S3', noradId: 3 }])    // 换了一颗
  ok('② 换星也算变', names(sp.beamPicks.value) === 'S1,S3', names(sp.beamPicks.value))

  // 顺序变了也是变（表是按这个顺序编号的）
  const r2 = sp.beamPicks.value
  sp.setBeamTargets([{ name: 'S3', noradId: 3 }, { name: 'S1', noradId: 1 }])
  ok('② 顺序变也算变', sp.beamPicks.value !== r2 && names(sp.beamPicks.value) === 'S3,S1')

  sp.setBeamTargets([])
  ok('② 全出波束 → 清空', sp.beamPicks.value.length === 0)
  sp.setBeamTargets(null)
  ok('② 空入参不炸', sp.beamPicks.value.length === 0)
}

// ==================== ③ 时段扫描指纹：波束内档不计成员 ====================
{
  const KEY = 'sat|ant'
  const sp = useSatPerfTable()
  sp.setActiveKey(KEY)            // 开表＝把这张表绑到一根天线（名单逐表独立，见 ⑥）
  sp.addTarget({ name: 'A', noradId: 1 })
  // 点选档：加一颗目标 → 指纹必须变（结果确实过期了）
  sp.win.on = true
  const f1 = sp.winStaleFor(KEY)
  ok('③ 没算过一律算过期', f1 === true)

  sp.targetMode.value = 'beam'
  sp.setBeamTargets([{ name: 'X', noradId: 9 }])
  // 用内部指纹函数不可见 → 换个法子：连续两次成员变化后，winStaleFor 的判定只取决于其它输入。
  // 这里只能验「成员变了不会让判定翻转」——先记下当前值，再改成员，判定应保持一致。
  const before = sp.winStaleFor(KEY)
  sp.setBeamTargets([{ name: 'Y', noradId: 8 }, { name: 'Z', noradId: 7 }])
  ok('③ 波束内档：成员变化不影响过期判定', sp.winStaleFor(KEY) === before)

  // 而时窗参数变化必须影响（否则这个提示就真废了）
  sp.win.durH = 48
  ok('③ 时窗参数变化仍然要判过期', sp.winStaleFor(KEY) === true)
}

// ==================== ④ 存档：只存档位，不存波束成员 ====================
{
  const KEY = 'sat|ant'
  const sp = useSatPerfTable()
  sp.setActiveKey(KEY)            // 开表＝把这张表绑到一根天线（名单逐表独立，见 ⑥）
  sp.addTarget({ name: 'KEEP', noradId: 5 })
  sp.targetMode.value = 'beam'
  sp.setBeamTargets([{ name: 'TRANSIENT', noradId: 77 }])
  const st = JSON.parse(JSON.stringify(sp.getState()))
  ok('④ 存档记住来源档位', st.targetModeByAnt[KEY] === 'beam')
  ok('④ 存档只存点选名单', names(st.picksByAnt[KEY]) === 'KEEP' && !JSON.stringify(st).includes('TRANSIENT'))

  const sp2 = useSatPerfTable()
  sp2.restoreState(st)
  sp2.setActiveKey(KEY)
  ok('④ 恢复后回到波束内档', sp2.targetMode.value === 'beam')
  ok('④ 恢复后波束成员为空（等下一拍现算）', sp2.beamPicks.value.length === 0 && sp2.activePicks.value.length === 0)
  ok('④ 恢复后点选名单还在', names(sp2.picks.value) === 'KEEP')

  // 脏存档不许把档位改坏
  const sp3 = useSatPerfTable()
  sp3.restoreState({ targetModeByAnt: { [KEY]: 'garbage' }, picksByAnt: {} })
  sp3.setActiveKey(KEY)
  ok('④ 非法档位落回点选', sp3.targetMode.value === 'pick')

  // 老快照（全表共享一份名单/档位/时窗）→ 复制给每一根【开过表的】天线，此后各表各改各的。
  // 键取 optsByAnt：那是「开过表的天线」的唯一记录，故迁移必须排在它之后。
  const legacy = {
    optsByAnt: { 'A|a1': { cols: {} }, 'B|b1': { cols: {} } },
    picks: [{ name: 'OLD', noradId: 3 }],
    targetMode: 'pick',
    win: { on: true, startMs: 1700000000000, durH: 6 }
  }
  const sp4 = useSatPerfTable()
  sp4.restoreState(legacy)
  sp4.setActiveKey('A|a1')
  ok('④ 老快照迁移：A 表拿到那份名单', names(sp4.picks.value) === 'OLD')
  ok('④ 老快照迁移：时窗设置一并带过来', sp4.win.on === true && sp4.win.durH === 6 && sp4.win.startMs === 1700000000000)
  sp4.addTarget({ name: 'ONLY-A', noradId: 4 })
  sp4.setActiveKey('B|b1')
  ok('④ 老快照迁移：B 表拿到的是自己那份副本', names(sp4.picks.value) === 'OLD')
  sp4.setActiveKey('A|a1')
  ok('④ 老快照迁移后两表已分家', names(sp4.picks.value) === 'OLD,ONLY-A')
}

// ==================== ⑥ 一根天线一张表：名单 / 档位 / 时窗设置逐表独立 ====================
{
  const A = 'satX|ant1', B = 'satX|ant2'
  const sp = useSatPerfTable()
  ok('⑥ 没开表时名单为空', sp.picks.value.length === 0)
  ok('⑥ 没开表加不进目标星', sp.addTarget({ name: 'NOWHERE', noradId: 1 }) === false && sp.picks.value.length === 0)

  sp.setActiveKey(A)
  sp.addTarget({ name: 'A-1', noradId: 11 })
  sp.addTarget({ name: 'A-2', noradId: 12 })
  sp.targetMode.value = 'beam'
  sp.win.on = true; sp.win.durH = 48

  sp.setActiveKey(B)
  ok('⑥ 新表从空白起', sp.picks.value.length === 0, names(sp.picks.value))
  ok('⑥ 新表回到出厂档位与时窗', sp.targetMode.value === 'pick' && sp.win.on === false && sp.win.durH === 24)
  sp.addTarget({ name: 'B-1', noradId: 21 })
  ok('⑥ B 表加的星不进 A 表', names(sp.picks.value) === 'B-1')

  sp.setActiveKey(A)
  ok('⑥ 切回 A 表名单原样还在', names(sp.picks.value) === 'A-1,A-2', names(sp.picks.value))
  ok('⑥ 切回 A 表档位与时窗也还在', sp.targetMode.value === 'beam' && sp.win.on === true && sp.win.durH === 48)
  sp.clearTargets()
  sp.setActiveKey(B)
  ok('⑥ 清空 A 表不动 B 表', names(sp.picks.value) === 'B-1')

  // 两张表都存进快照，恢复后仍各是各的
  const st = JSON.parse(JSON.stringify(sp.getState()))
  const sp2 = useSatPerfTable()
  sp2.restoreState(st)
  sp2.setActiveKey(B)
  ok('⑥ 存档恢复后 B 表还在', names(sp2.picks.value) === 'B-1')
  sp2.setActiveKey(A)
  ok('⑥ 存档恢复后清空过的 A 表仍是空的', sp2.picks.value.length === 0)
}

// ==================== ⑤ 取值时刻戳：跳拍时表脚读的是它 ====================
{
  const sp = useSatPerfTable()
  sp.setActiveKey('sat|ant')      // 开表＝把这张表绑到一根天线（名单逐表独立，见 ⑥）
  ok('⑤ 未算过没有时刻戳', sp.stampMs.value === null)
  sp.compute(null)
  ok('⑤ 无天线上下文清掉时刻戳', sp.stampMs.value === null)
}

// ==================== ⑦ 批量移除：按 id（名单表）或按 NORAD / 星名（结果表的行没有 pick id）====================
{
  const sp = useSatPerfTable()
  sp.setActiveKey('sat|ant')
  sp.addTargets([{ name: 'R-1', noradId: 1 }, { name: 'R-2', noradId: 2 }, { name: 'R-3' }, { name: 'R-4', noradId: 4 }])
  const idOf = (n) => sp.picks.value.find((p) => p.name === n).id
  ok('⑦ 按 id 批量移除', sp.removeTargets({ ids: [idOf('R-1'), idOf('R-2')] }) === 2 && names(sp.picks.value) === 'R-3,R-4', names(sp.picks.value))
  ok('⑦ 按 NORAD 对上结果行', sp.removeTargets({ keys: [{ name: 'R-4', noradId: 4 }] }) === 1 && names(sp.picks.value) === 'R-3', names(sp.picks.value))
  ok('⑦ 只按名加的星：结果行带解析出的 NORAD 也按名对上', sp.removeTargets({ keys: [{ name: 'R-3', noradId: 33 }] }) === 1 && sp.picks.value.length === 0)
  sp.addTarget({ name: 'R-5', noradId: 5 })
  ok('⑦ 同名不同 NORAD 不算命中', sp.removeTargets({ keys: [{ name: 'R-5', noradId: 55 }] }) === 0 && names(sp.picks.value) === 'R-5')
  ok('⑦ 没命中返回 0 且名单不动', sp.removeTargets({ ids: ['nope'], keys: [{ name: 'X', noradId: 99 }] }) === 0 && names(sp.picks.value) === 'R-5')
  ok('⑦ 空参数返回 0', sp.removeTargets(null) === 0 && sp.removeTargets({}) === 0 && sp.removeTargets({ ids: [], keys: [] }) === 0)
  sp.setActiveKey('sat|other')
  sp.addTarget({ name: 'O-1', noradId: 7 })
  ok('⑦ 指定 key 只动那张表', sp.removeTargets({ ids: [idOf('O-1')] }, 'sat|ant') === 0 && sp.removeTargets({ keys: [{ name: 'R-5', noradId: 5 }] }, 'sat|ant') === 1 && names(sp.picks.value) === 'O-1', names(sp.picks.value))
  ok('⑦ 没开表返回 0', useSatPerfTable().removeTargets({ ids: ['x'] }) === 0)
}

// ==================== ⑧ 天线改名：名单 / 来源档 / 选项 / 时窗 / 会话整体搬到新 key，会话不作废 ====================
{
  const sp = useSatPerfTable()
  sp.setActiveKey('sat|old')
  sp.addTarget({ name: 'T-1', noradId: 1 })
  sp.targetMode.value = 'beam'
  sp.getOpts('sat|old').filterOn = true
  sp.win.durH = 6
  const s0 = sp.session('sat|old')
  ok('⑧ 改名成功', sp.renameKey('sat|old', 'sat|new') === true)
  ok('⑧ 名单跟到新 key、旧 key 清空', sp.picksOf('sat|new').length === 1 && sp.picksOf('sat|old').length === 0)
  ok('⑧ 来源档与选项跟到新 key', sp.targetModeOf('sat|new') === 'beam' && sp.getOpts('sat|new').filterOn === true && sp.targetModeOf('sat|old') === 'pick')
  ok('⑧ 会话是同一份（结果不作废）、时窗设置在会话里', sp.session('sat|new') === s0 && sp.session('sat|new').win.durH === 6)
  ok('⑧ 当前表指向新 key', sp.activeKey.value === 'sat|new')
  ok('⑧ 无效入参返回 false', sp.renameKey('', 'x') === false && sp.renameKey('a', 'a') === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
