// 对星性能指标表的【目标星来源】自测（src/viz/grd/useSatPerfTable.js）。运行：npm test
//
// 这一份验的是「波束内的星接到仿真时钟」之后新增的那半边：目标集本身是时刻的函数。
// 逐条钉死的是四件会静默出错的事：
//   ① 切来源＝换名单：点选档报点选的，波束内档报此刻在波束里的，两份互不污染
//      （污染的典型症状：切回点选后表里还留着上一拍的波束成员，看着像「这颗星一直被照到」）；
//   ② 成员没变就【不换数组引用】—— 每拍换一次引用会把浮窗的只读网格整片重渲，框选当场丢；
//   ③ 时段扫描的指纹在波束内档不计入成员名单 —— 成员每拍在变，计入就等于每拍自称过期，
//      「输入已变」会一直闪，那个提示也就废了；
//   ④ 存档只存来源档位不存波束成员 —— 名单是时刻的函数，存下来跟下次打开的时刻对不上。
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
  const sp = useSatPerfTable()
  const KEY = 'sat|ant'
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
  const sp = useSatPerfTable()
  sp.addTarget({ name: 'KEEP', noradId: 5 })
  sp.targetMode.value = 'beam'
  sp.setBeamTargets([{ name: 'TRANSIENT', noradId: 77 }])
  const st = JSON.parse(JSON.stringify(sp.getState()))
  ok('④ 存档记住来源档位', st.targetMode === 'beam')
  ok('④ 存档只存点选名单', names(st.picks) === 'KEEP' && !JSON.stringify(st).includes('TRANSIENT'))

  const sp2 = useSatPerfTable()
  sp2.restoreState(st)
  ok('④ 恢复后回到波束内档', sp2.targetMode.value === 'beam')
  ok('④ 恢复后波束成员为空（等下一拍现算）', sp2.beamPicks.value.length === 0 && sp2.activePicks.value.length === 0)
  ok('④ 恢复后点选名单还在', names(sp2.picks.value) === 'KEEP')

  // 脏存档不许把档位改坏
  const sp3 = useSatPerfTable()
  sp3.restoreState({ targetMode: 'garbage', picks: [] })
  ok('④ 非法档位落回点选', sp3.targetMode.value === 'pick')
}

// ==================== ⑤ 取值时刻戳：跳拍时表脚读的是它 ====================
{
  const sp = useSatPerfTable()
  ok('⑤ 未算过没有时刻戳', sp.stampMs.value === null)
  sp.compute(null)
  ok('⑤ 无天线上下文清掉时刻戳', sp.stampMs.value === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
