// 交互底座四件的自测（2026-10-14 交互方式调研 P0/P1 修复）：运行 npm test
//   stores/sceneUndo   —— 场景级撤销 / 重做栈：压栈清 redo、上限 50、undo/redo 互推、条目抛错不卡栈；
//                         快照条目的 stale 核对（接不上不回放、该域整条作废，2026-10-16 体检 #5）与域快照撤销 createDomainUndo
//                         （单步 / 嵌套 / 一段编辑 / 打断续记 / 连发合并 / 拖动 / 显隐不算改动 / 漏网改动不被抹掉）
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

// ---- sceneUndo：快照条目的 stale 核对（体检 #5：撤一步把之后没进栈的改动一起抹掉）----
{
  U.clearSceneUndo()
  let ran = 0, staleNow = false
  U.pushSceneUndo({ label: 'other', dom: 'b', undo: () => { ran++ }, redo: () => {}, stale: () => false })
  U.pushSceneUndo({ label: 'm1', dom: 'a', undo: () => { ran++ }, redo: () => {}, stale: () => staleNow })
  U.pushSceneUndo({ label: 'm2', dom: 'a', undo: () => { ran++ }, redo: () => {}, stale: () => staleNow })
  staleNow = true
  const r = U.sceneUndo()
  ok('接不上：不回放、返回 stale', r && r.stale === true && r.dom === 'a' && ran === 0)
  ok('该域条目整条作废，别的域留着', U.sceneUndoState.canUndo && U.sceneUndoState.undoLabel === 'other' && !U.sceneUndoState.canRedo)
  const r2 = U.sceneUndo()
  ok('别的域照常撤', r2 && !r2.stale && r2.label === 'other' && ran === 1)
  // 重做方向：撤完之后又有漏网改动 → 重做也不回放
  U.clearSceneUndo()
  let redone = 0, st2 = false
  U.pushSceneUndo({ label: 'x', dom: 'a', undo: () => {}, redo: () => { redone++ }, stale: (dir) => dir === 'redo' && st2 })
  U.sceneUndo()
  st2 = true
  const r3 = U.sceneRedo()
  ok('重做接不上：不回放、redo 栈清掉', r3 && r3.stale && redone === 0 && !U.sceneUndoState.canRedo && !U.sceneUndoState.canUndo)
  // 核对抛错按接不上处理（宁可不撤）
  U.clearSceneUndo()
  let ran3 = 0
  U.pushSceneUndo({ label: 'y', dom: 'a', undo: () => { ran3++ }, redo: () => {}, stale: () => { throw new Error('boom') } })
  const origErr = console.error; console.error = () => {}
  const r4 = U.sceneUndo()
  console.error = origErr
  ok('核对抛错 = 接不上', r4 && r4.stale && ran3 === 0)
  // 没带 dom 的老式条目不核对（照旧回放）
  U.clearSceneUndo()
  let ran4 = 0
  U.pushSceneUndo({ label: 'z', undo: () => { ran4++ }, redo: () => {}, stale: () => true })
  ok('无 dom 不核对', U.sceneUndo() && ran4 === 1)
  U.clearSceneUndo()
}

// ---- createDomainUndo：域快照撤销 ----
{
  // 一个最小的「域」：一组对象 + 视图态 show；签名剔掉 show、套回时保留此刻的显隐（同主窗 UNDO_DOM）
  const jc = (x) => JSON.parse(JSON.stringify(x))
  const sig = (s) => JSON.stringify(s, (k, v) => (k === 'show' ? undefined : v))
  const st = { list: [] }
  const dom = {
    snap: () => jc(st.list),
    sig,
    apply: (s) => {
      const next = jc(s), cur = new Map(st.list.map((o) => [o.id, o]))
      for (const o of next) { const c = cur.get(o.id); if (c) { if ('show' in c) o.show = c.show; else delete o.show } }
      st.list = next
    }
  }
  const D = U.createDomainUndo({ m: dom })
  const ids = () => st.list.map((o) => o.id).join(',')
  U.clearSceneUndo()

  // 单步：有变化才压；嵌套只压一步
  D.run('m', 'add A', () => { st.list.push({ id: 'A', v: 1 }) })
  D.run('m', 'noop', () => {})
  ok('run：有变化压一步、没变化不压', U.sceneUndoState.undoLabel === 'add A')
  const lb = D.run('m', () => 'add B（' + st.list.length + '）', () => { D.run('m', 'inner', () => { st.list.push({ id: 'B', v: 1 }) }) })
  ok('run：嵌套只压外层一步，label 可传函数（改完才取）', lb.pushed && lb.label === 'add B（2）' && U.sceneUndoState.undoLabel === 'add B（2）')

  // 显隐不算改动：之后点一下眼睛，撤销照样接得上，且保留此刻的显隐
  st.list[0].show = false
  const e1 = U.sceneUndo()
  ok('显隐变化不让撤销失效', e1 && !e1.stale && ids() === 'A')
  ok('套回时保留此刻的显隐', st.list[0].show === false)
  U.sceneRedo()
  ok('重做回来', ids() === 'A,B')

  // 漏网改动（没进栈的写入口）：撤销不回放，数据不丢
  st.list.push({ id: 'C', v: 1 })
  const e2 = U.sceneUndo()
  ok('漏网改动之后撤销：不回放、C 还在', e2 && e2.stale && ids() === 'A,B,C')
  ok('该域记录作废', !U.sceneUndoState.canUndo)

  // 一段编辑：begin → 多次改 → end = 一步；撤销整段
  U.clearSceneUndo()
  st.list = []
  let drawing = true
  D.begin('m', '画 P', 'draw:P', () => drawing)
  st.list.push({ id: 'P', pts: [] })
  st.list[0].pts.push(1); st.list[0].pts.push(2); st.list[0].pts.push(3)
  drawing = false
  D.end('draw:P')
  ok('一段编辑收成一步', U.sceneUndoState.undoLabel === '画 P')
  U.sceneUndo()
  ok('撤销整段（新建的整个拿掉）', ids() === '')
  U.sceneRedo()

  // 打断续记：描绘中同域别的单步修改 → 先把描绘落栈、单步一步、描绘从此刻接着记；三步首尾相接
  U.clearSceneUndo()
  st.list = [{ id: 'K', v: 1 }]
  drawing = true
  D.begin('m', '画 Q', 'draw:Q', () => drawing)
  st.list.push({ id: 'Q', pts: [1] })
  D.run('m', '删 K', () => { st.list = st.list.filter((o) => o.id !== 'K') })
  ok('打断：描绘先落栈、续记中', D.pending().join() === 'draw:Q')
  st.list[0].pts.push(2)
  drawing = false
  D.end('draw:Q')
  const a = U.sceneUndo(), b = U.sceneUndo(), c = U.sceneUndo()
  ok('三步依次撤销都接得上', a && b && c && !a.stale && !b.stale && !c.stale && ids() === 'K')

  // 表格写入（不进场景栈）夹在描绘中间：宿主先 flushAll(域) 落栈、写完 resume 接着记 —— 表格的改动落在两段之间的缺口里，
  // 撤销后一段照常、跨过缺口那一步接不上 → 不回放，表格的改动保住（不被夹进描绘的前后快照里一并抹掉）
  U.clearSceneUndo()
  st.list = [{ id: 'T', v: 1 }]
  drawing = true
  D.begin('m', '画 S', 'draw:S', () => drawing)
  st.list.push({ id: 'S', pts: [1] })
  const held2 = D.flushAll('m')
  st.list[0].v = 2
  D.resume(held2)
  st.list[1].pts.push(2)
  drawing = false
  D.end('draw:S')
  const u1 = U.sceneUndo()
  ok('缺口之后那段照常撤', u1 && !u1.stale && st.list[1].pts.length === 1 && st.list[0].v === 2)
  const u2 = U.sceneUndo()
  ok('跨过表格改动的那一步不回放：表格的改动保住', u2 && u2.stale && st.list[0].v === 2 && ids() === 'T,S')
  ok('flushAll(域) 只收那一个域', (() => { D.begin('m', 'x', 'k1'); const h = D.flushAll('other'); const left = D.pending().join(); D.flushAll(); return !h.length && left === 'k1' })())

  // 描绘中顺手改的样式（begin 不带 alive）并进那次描绘
  U.clearSceneUndo()
  st.list = []
  drawing = true
  D.begin('m', '画 R', 'draw:R', () => drawing)
  st.list.push({ id: 'R', color: 'red' })
  D.begin('m', '改色', 'edit:R')
  st.list[0].color = 'blue'
  D.end('edit:R')
  ok('描绘中的样式修改不另起一段', D.pending().join() === 'draw:R')
  drawing = false
  D.end('draw:R')
  U.sceneUndo()
  ok('撤销描绘连同样式一起回去', ids() === '' && !U.sceneUndoState.canUndo)

  // 撤 / 重做前先收掉进行中的段（宿主 doSceneUndo 的口径）
  U.clearSceneUndo()
  st.list = []
  D.begin('m', '改名', 'edit:N')
  st.list.push({ id: 'N' })
  const held = D.flushAll()
  ok('flushAll：进行中的段落栈', U.sceneUndoState.undoLabel === '改名' && held.length === 1 && !D.pending().length)
  D.resume(held)
  ok('resume：不带 alive 的段不续记', !D.pending().length)

  // 连发合并（取色框拖动）：同 key 的多次 live 一步
  U.clearSceneUndo()
  st.list = [{ id: 'L', color: '#000000' }]
  for (const c2 of ['#111111', '#222222', '#333333']) D.live('m', '改色', 'col:L', () => { st.list[0].color = c2 }, 5)
  D.flushAll()
  U.sceneUndo()
  ok('live：连发合成一步，撤回最初的颜色', st.list[0].color === '#000000' && !U.sceneUndoState.canUndo)

  // 拖动：按下拍、松手比对
  U.clearSceneUndo()
  st.list = [{ id: 'G', x: 0 }]
  D.dragBegin('m', '拖 G')
  for (let i = 1; i <= 5; i++) st.list[0].x = i
  D.dragCommit()
  U.sceneUndo()
  ok('拖动一步、撤回按下时', st.list[0].x === 0)

  // cur(ref)：「此刻」按条目记的键取（天线指向：聚焦换了根天线也对得上）
  const ants = { a1: { az: 0 }, a2: { az: 5 } }
  let active = 'a1'
  const bore = {
    snap: () => ({ key: active, v: jc(ants[active]) }),
    cur: (ref) => (ants[ref.key] ? { key: ref.key, v: jc(ants[ref.key]) } : null),
    apply: (s) => { active = s.key; ants[s.key] = jc(s.v) }
  }
  const B = U.createDomainUndo({ bore })
  U.clearSceneUndo()
  B.dragBegin('bore', '拖 a1'); ants.a1.az = 30; B.dragCommit()
  active = 'a2'
  const e3 = U.sceneUndo()
  ok('cur：聚焦换到别的天线，撤销照样接得上并切回去', e3 && !e3.stale && active === 'a1' && ants.a1.az === 0)
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
