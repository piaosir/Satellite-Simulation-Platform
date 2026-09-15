// 性能指标表窗口 ⇄ 主窗口的双向镜像（src/perf/bridge.js useMirror）自测。运行：npm test
//
// 钉死的口径：只记一个 hostSig（据我们所知主窗口此刻持有的那份）。
//   ① 主窗口那份没到之前本地不许发；到了就应用，且应用引起的本地变化不发回；
//   ② 本地改了就发；★ 改回最初收到的那份也必须发（矩形→椭圆→矩形曾被吞掉，主窗口停在椭圆上）；
//   ③ 自己发出去的回声不再应用；④ 主窗口推来另一份要应用、且不弹回去；
//   ⑤ 主窗口把我们发的那份改了一点再推回（补 id 之类）要应用、且不弹回去。
import { reactive, ref, nextTick } from 'vue'
import { useMirror } from '../../../src/perf/bridge.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const flush = async () => { await nextTick(); await nextTick() }

const st = reactive({})                  // 主窗口推来的状态（桥上的 st）
const local = ref({ type: 'rect', n: 0 })  // 弹窗本地可编辑模型
const sent = []                          // 发给主窗口的载荷
useMirror(st, 'opts', {
  sigOf: (o) => JSON.stringify({ type: o.type, n: o.n }),
  apply: (v) => { local.value = { type: v.type, n: v.n } },
  local: () => local.value,
  send: (v) => sent.push(JSON.stringify({ type: v.type, n: v.n }))
})

// ==================== ① 没到之前不发；到了应用且不弹回 ====================
{
  local.value.n = 1                      // 主窗口那份还没到，本地已经动了
  await flush()
  ok('① 主窗口那份没到之前不发', sent.length === 0)
  st.opts = { type: 'rect', n: 0 }       // 主窗口推来存盘的那份
  await flush()
  ok('① 到了就应用（本地被存盘的那份覆盖）', local.value.type === 'rect' && local.value.n === 0)
  ok('① 应用引起的本地变化不发回', sent.length === 0, String(sent.length))
}

// ==================== ② 本地改了就发；改回最初收到的那份也要发 ====================
{
  local.value.type = 'ellipse'
  await flush()
  ok('② 矩形→椭圆：发', sent.length === 1 && sent[0].includes('ellipse'))
  local.value.type = 'rect'
  await flush()
  ok('② ★ 椭圆→矩形（等于最初收到的那份）：也要发', sent.length === 2 && sent[1].includes('rect'), JSON.stringify(sent))
  local.value.type = 'ellipse'
  await flush()
  ok('② 再改回椭圆：还发', sent.length === 3 && sent[2].includes('ellipse'))
}

// ==================== ③ 自己发出去的回声不应用 ====================
{
  let applied = 0
  const st2 = reactive({}), loc2 = ref({ type: 'rect', n: 0 }), out2 = []
  useMirror(st2, 'opts', {
    sigOf: (o) => JSON.stringify({ type: o.type, n: o.n }),
    apply: (v) => { applied++; loc2.value = { type: v.type, n: v.n } },
    local: () => loc2.value,
    send: (v) => out2.push(JSON.stringify({ type: v.type, n: v.n }))
  })
  st2.opts = { type: 'rect', n: 0 }; await flush()
  loc2.value.n = 5; await flush()
  ok('③ 本地改了：发', out2.length === 1 && applied === 1)
  st2.opts = { type: 'rect', n: 5 }; await flush()   // 主窗口把同一份推回来
  ok('③ 回声不再应用、也不再发', applied === 1 && out2.length === 1)
  // ④ 主窗口推来另一份（比如树上的眼睛改了）：应用，且不弹回去
  st2.opts = { type: 'ellipse', n: 5 }; await flush()
  ok('④ 主窗口推来另一份：应用', applied === 2 && loc2.value.type === 'ellipse')
  ok('④ 应用引起的本地变化不弹回', out2.length === 1)
  loc2.value.n = 6; await flush()
  ok('④ 之后本地再改仍正常发', out2.length === 2 && out2[1].includes('"n":6'))
  // ⑤ 主窗口把我们发的那份改了一点再推回（补默认值 / 补 id）：应用，不弹回
  st2.opts = { type: 'ellipse', n: 7 }; await flush()
  ok('⑤ 主窗口修过再推回：应用且不弹回', loc2.value.n === 7 && out2.length === 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
