// 模型工作台设计页文档标签条（2026-10-06，任务书 §3.1）的纯逻辑单测（src/model/wbLogic.js）：
//   签键 / 签对应的库条目、草稿分槽淘汰（打开着的签不参与）、换下签的撤销栈截断、Ctrl+Tab 循环、关签后激活哪个、
//   库页「装配」分段排序（用户件在实体模板之前、按修改时间倒序）；副本名（§3.2：byLang 后缀、重名递增、已带后缀接着编号）。
// 裸 node 跑：wbLogic.js 只 import packages/core（相对路径），不碰 three / vue / DOM。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = await import(pathToFileURL(path.join(HERE, '../../../src/model/wbLogic.js')).href)

let n = 0
const ok = (name, fn) => { fn(); n++ }

ok('签键：模型签 (库 id, model)；模板签 = 模板条目 id + |tpl；其余装配文档 (id, asm)', () => {
  assert.equal(W.docKeyOf({ kind: 'model', id: 'm|nasa:tdrs-a', libId: 'nasa:tdrs-a' }), 'nasa:tdrs-a|model')
  assert.equal(W.docKeyOf({ kind: 'asm', id: 'asm:0123456789ab', templateKey: 'param:ssl-1300|tpl' }), 'param:ssl-1300|tpl')
  assert.equal(W.docKeyOf({ kind: 'asm', id: 'asm:0123456789ab', templateKey: '' }), 'asm:0123456789ab|asm')
  // 同一库条目的模型签与装配签是两个签（「查看模型属性」与「打开」可同时开着）
  assert.notEqual(W.docKeyOf({ kind: 'model', libId: 'asm:0123456789ab' }), W.docKeyOf({ kind: 'asm', id: 'asm:0123456789ab' }))
  assert.equal(W.docKeyOf(null), '')
})
ok('签对应的库条目：模型签 → 那一件；模板签 → 模板条目；已入库装配件 → 自己；未入库 → 空', () => {
  assert.equal(W.libIdOfDoc({ kind: 'model', libId: 'nasa:tdrs-a' }), 'nasa:tdrs-a')
  assert.equal(W.libIdOfDoc({ kind: 'asm', id: 'asm:0123456789ab', templateKey: 'ent:a320neo|tpl', inLib: false }), 'ent:a320neo')
  assert.equal(W.libIdOfDoc({ kind: 'asm', id: 'asm:0123456789ab', templateKey: '', inLib: true }), 'asm:0123456789ab')
  assert.equal(W.libIdOfDoc({ kind: 'asm', id: 'asm:0123456789ab', templateKey: '', inLib: false }), '')
  assert.equal(W.libIdOfDoc(null), '')
})
ok('草稿淘汰：超过上限按时间从旧到新淘汰，打开着的签不淘汰；坏条目丢弃', () => {
  const l = Array.from({ length: 14 }, (_, i) => ({ id: 'asm:' + String(i).padStart(12, '0'), at: 1000 + i }))
  const open = ['asm:000000000000', 'asm:000000000001']
  const r = W.evictDrafts([...l].reverse(), open, 12)
  assert.equal(r.keep.length, 12)
  assert.deepEqual(r.drop, ['asm:000000000002', 'asm:000000000003'])
  assert.ok(r.keep.some((x) => x.id === 'asm:000000000000') && r.keep.some((x) => x.id === 'asm:000000000001'))
  assert.deepEqual(r.keep.map((x) => x.at), [...r.keep.map((x) => x.at)].sort((a, b) => a - b))
  // 全是打开着的签：一份也不淘汰（宁可超上限）
  const all = W.evictDrafts(l, new Set(l.map((x) => x.id)), 12)
  assert.equal(all.keep.length, 14)
  assert.deepEqual(all.drop, [])
  assert.deepEqual(W.evictDrafts([{ id: 'x' }, null, { id: 'y', at: 1 }], [], 12).keep, [{ id: 'y', at: 1 }])
})
ok('换下签的撤销栈：截到最近 max 步，先丢最旧的撤销步、再丢最远的重做步；不改入参', () => {
  const mk = (k) => Array.from({ length: k }, (_, i) => ({ label: 'c' + i, before: 'b' + i, after: 'a' + i }))
  const s = { hist: mk(50), hptr: 50, sel: ['x'], view: null }
  const t = W.trimHistory(s, 30)
  assert.equal(t.hist.length, 30)
  assert.equal(t.hptr, 30)
  assert.equal(t.hist[0].label, 'c20')
  assert.deepEqual(t.sel, ['x'])
  assert.equal(s.hist.length, 50)
  // 指针在中间（有重做步）：撤销步全丢光之前不动重做步
  const u = W.trimHistory({ hist: mk(50), hptr: 10 }, 30)
  assert.equal(u.hist.length, 30)
  assert.equal(u.hptr, 0)
  assert.equal(u.hist[0].label, 'c10')
  const v = W.trimHistory({ hist: mk(50), hptr: 35 }, 30)
  assert.equal(v.hptr, 15)
  assert.equal(v.hist[v.hptr - 1].label, 'c34')
  // 没超：原样返回
  const w = { hist: mk(5), hptr: 3 }
  assert.equal(W.trimHistory(w, 30), w)
  assert.equal(W.trimHistory(null, 30), null)
})
ok('Ctrl+Tab 循环与关签后的激活签', () => {
  assert.equal(W.cycleIndex(3, 0, 1), 1)
  assert.equal(W.cycleIndex(3, 2, 1), 0)
  assert.equal(W.cycleIndex(3, 0, -1), 2)
  assert.equal(W.cycleIndex(3, -1, 1), 0)
  assert.equal(W.cycleIndex(0, -1, 1), -1)
  assert.equal(W.cycleIndex(1, 0, -1), 0)
  // 关之前 n 个、关下标 i → 关完之后数组里的下标（右邻，没有取左邻）
  assert.equal(W.neighborAfterClose(3, 0), 0)
  assert.equal(W.neighborAfterClose(3, 1), 1)
  assert.equal(W.neighborAfterClose(3, 2), 1)
  assert.equal(W.neighborAfterClose(1, 0), -1)
})
ok('库页「装配」分段：用户装配件在实体模板之前、按修改时间倒序；没有时间的排在有的之后；实体模板按目录序', () => {
  const list = [
    { id: 'ent:b', origin: 'entTemplate', tplOrder: 101, titleZh: '乙模板', local: {} },
    { id: 'ent:a', origin: 'entTemplate', tplOrder: 100, titleZh: '甲模板', local: {} },
    { id: 'asm:000000000001', titleZh: '旧件', updatedAt: '2026-10-01T00:00:00.000Z', spec: { kind: 'assembly' } },
    { id: 'asm:000000000002', titleZh: '新件', updatedAt: '2026-10-05T00:00:00.000Z', spec: { kind: 'assembly' } },
    { id: 'asm:000000000003', titleZh: '无时间', spec: { kind: 'assembly' } },
    { id: 'nasa:x', origin: 'remote', titleZh: '不在装配段', source: { kind: 'nasa' }, local: {} }
  ]
  assert.deepEqual(W.filterEntries(list, { seg: 'asm', lang: 'zh' }).map((e) => e.id),
    ['asm:000000000002', 'asm:000000000001', 'asm:000000000003', 'ent:a', 'ent:b'])
  // 别的分段排序口径不变：有 tplOrder 的在前
  assert.equal(W.filterEntries(list, { seg: 'all', lang: 'zh' })[0].id, 'ent:a')
})
ok('副本名（§3.2）：中文「名 副本」/ 英文「name Copy」；重名递增；已带副本后缀的接着编号；全角收尾标点后不加空格', () => {
  assert.equal(W.copyNameOf('默认卫星', [], 'zh'), '默认卫星 副本')
  assert.equal(W.copyNameOf('Default Satellite', [], 'en'), 'Default Satellite Copy')
  assert.equal(W.copyNameOf('SSL-1300（Maxar 1300）', [], 'zh'), 'SSL-1300（Maxar 1300）副本')
  assert.equal(W.copyNameOf('SSL-1300 (Maxar 1300)', [], 'en'), 'SSL-1300 (Maxar 1300) Copy')
  // 与库内 / 已打开签重名：递增
  assert.equal(W.copyNameOf('默认卫星', new Set(['默认卫星 副本']), 'zh'), '默认卫星 副本 2')
  assert.equal(W.copyNameOf('默认卫星', ['默认卫星 副本', '默认卫星 副本 2', ' 默认卫星 副本 3 '], 'zh'), '默认卫星 副本 4')
  assert.equal(W.copyNameOf('Bus', ['bus copy'], 'en'), 'Bus Copy 2')
  // 原名已是副本：去后缀接着编号（不叠成「副本 副本」）
  assert.equal(W.copyNameOf('默认卫星 副本', ['默认卫星 副本'], 'zh'), '默认卫星 副本 2')
  assert.equal(W.copyNameOf('默认卫星 副本 2', ['默认卫星 副本', '默认卫星 副本 2'], 'zh'), '默认卫星 副本 3')
  assert.equal(W.copyNameOf('SSL-1300（Maxar 1300）副本', ['SSL-1300（Maxar 1300）副本'], 'zh'), 'SSL-1300（Maxar 1300）副本 2')
  assert.equal(W.copyNameOf('Bus Copy 2', ['Bus Copy', 'Bus Copy 2'], 'en'), 'Bus Copy 3')
  // 空名：给个占位名再接后缀；坏条目不挡
  assert.equal(W.copyNameOf('', [null, 3, ''], 'zh'), '未命名 副本')
  assert.equal(W.copyNameOf(null, undefined, 'en'), 'Untitled Copy')
})

console.log(`modelWbDocs: ${n} 项通过`)
