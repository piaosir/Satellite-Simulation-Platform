// 交互底座四件的自测（2026-10-14 交互方式调研 P0/P1 修复）：运行 npm test
//   stores/sceneUndo   —— 场景级撤销 / 重做栈：压栈清 redo、上限 50、undo/redo 互推、条目抛错不卡栈
//   stores/tlMarks     —— 时间轴事件层：整类替换、单条覆盖、相邻标记查找、非法值丢弃、上限
//   stores/statusMsg   —— 状态栏状态句：多操作链接、按序号执行后清掉、过程态只按原文清
//   shared/errText     —— IPC 错误前缀剥离
// 只测纯逻辑，不碰渲染。
let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

const U = await import('../../../src/stores/sceneUndo.js')
const T = await import('../../../src/stores/tlMarks.js')
const S = await import('../../../src/stores/statusMsg.js')
const { errText } = await import('../../../src/shared/errText.js')

// ---- sceneUndo ----
{
  let v = 0
  const set = (x) => () => { v = x }
  U.clearSceneUndo()
  ok('空栈 canUndo=false', !U.sceneUndoState.canUndo && !U.sceneUndoState.canRedo)
  v = 1; U.pushSceneUndo({ label: 'a', undo: set(0), redo: set(1) })
  v = 2; U.pushSceneUndo({ label: 'b', undo: set(1), redo: set(2) })
  ok('压两条后 canUndo', U.sceneUndoState.canUndo && U.sceneUndoState.undoLabel === 'b')
  const e = U.sceneUndo()
  ok('撤销最近一条', e && e.label === 'b' && v === 1)
  ok('撤销后 canRedo', U.sceneUndoState.canRedo && U.sceneUndoState.redoLabel === 'b')
  U.sceneRedo()
  ok('重做回到 2', v === 2 && !U.sceneUndoState.canRedo)
  U.sceneUndo(); U.sceneUndo()
  ok('连撤两步到 0', v === 0 && !U.sceneUndoState.canUndo)
  U.pushSceneUndo({ label: 'c', undo: set(9), redo: set(3) })
  ok('新压栈清空 redo', !U.sceneUndoState.canRedo)
  U.clearSceneUndo()
  for (let i = 0; i < 60; i++) U.pushSceneUndo({ label: 'n' + i, undo: () => {}, redo: () => {} })
  let n = 0; while (U.sceneUndo()) n++
  ok('上限 50 步', n === 50, String(n))
  U.clearSceneUndo()
  U.pushSceneUndo({ label: 'boom', undo: () => { throw new Error('x') }, redo: () => {} })
  const origErr = console.error; console.error = () => {}
  const r = U.sceneUndo()
  console.error = origErr
  ok('条目抛错不卡栈（照常进 redo）', r && r.label === 'boom' && U.sceneUndoState.canRedo && !U.sceneUndoState.canUndo)
  U.pushSceneUndo({ label: 'bad' })
  ok('缺 undo/redo 的条目不收', !U.sceneUndoState.canUndo)
  U.clearSceneUndo()
}

// ---- tlMarks ----
{
  T.clearMarks()
  T.setMarks('vis', [{ label: 'p1', t0: 1000, t1: 2000 }, { label: 'p2', t0: 5000, t1: 6000 }, { label: 'bad', t0: NaN }])
  ok('整类替换：丢非法值', T.tlMarks.list.length === 2)
  T.setMarks('vis', [{ label: 'p3', t0: 3000, t1: 2500 }])
  ok('再替换同类：只剩新的；t1<t0 当时刻点', T.tlMarks.list.length === 1 && T.tlMarks.list[0].t1 === null)
  T.upsertMark('ngso', 't*', 10000)
  T.upsertMark('ngso', 't*', 12000)
  ok('同 src+label 覆盖', T.tlMarks.list.filter((m) => m.src === 'ngso').length === 1 && T.tlMarks.list.find((m) => m.src === 'ngso').t0 === 12000)
  T.upsertMark('suntool', '日凌 北京', 20000, 21000)
  ok('相邻：往后', T.adjacentMarkMs(3000, 1) === 12000)
  ok('相邻：往前', T.adjacentMarkMs(20000, -1) === 12000)
  ok('相邻：±500 ms 内算同一处', T.adjacentMarkMs(12200, -1) === 3000)
  ok('相邻：没有返回 null', T.adjacentMarkMs(30000, 1) === null)
  T.clearMarks('ngso')
  ok('按类清除', !T.tlMarks.list.some((m) => m.src === 'ngso') && T.tlMarks.list.length === 2)
  T.setMarks('big', Array.from({ length: 700 }, (_, i) => ({ label: 'x' + i, t0: i })))
  ok('总数封顶 500', T.tlMarks.list.length === 500)
  T.clearMarks()
  ok('全清', T.tlMarks.list.length === 0)
}

// ---- statusMsg ----
{
  const ran = []
  S.showStatus('已删除 A', { actions: [{ label: '撤销', run: () => ran.push('u') }, { label: '定位', run: () => ran.push('l') }], ms: 0 })
  ok('两个操作链接', S.statusMsg.actions.length === 2 && S.statusMsg.text === '已删除 A')
  S.runStatusAction(1)
  ok('按序号执行并清掉这条', ran.join() === 'l' && S.statusMsg.text === '' && S.statusMsg.actions.length === 0)
  S.showStatus('x', { action: { label: '撤销', run: () => ran.push('a') }, ms: 0 })
  ok('单个 action 也收', S.statusMsg.actions.length === 1)
  S.showStatus('正在导出…', { ms: 0 })
  S.showExported('C:\\out\\图.png')
  S.clearStatusIf('正在导出…')
  ok('过程态已被回执覆盖时 clearStatusIf 不误清', S.statusMsg.text === '已导出：图.png' && S.statusMsg.file === 'C:\\out\\图.png')
  S.showStatus('正在导出…', { ms: 0 })
  S.clearStatusIf('正在导出…')
  ok('过程态还在时清掉', S.statusMsg.text === '')
  S.showStatus('失败', { level: 'error', ms: 0 })
  ok('error 级保留', S.statusMsg.level === 'error')
  S.clearStatus()
}

// ---- errText ----
{
  ok('剥 IPC 前缀', errText(new Error("Error invoking remote method 'file:save': Error: 磁盘已满")) === '磁盘已满')
  ok('剥类名前缀', errText(new TypeError('x 不是函数')) === 'x 不是函数')
  ok('字符串原样', errText('写入失败') === '写入失败')
  ok('空值', errText(null) === '')
  ok('String(Error) 形态', errText(String(new Error('坏了'))) === '坏了')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
