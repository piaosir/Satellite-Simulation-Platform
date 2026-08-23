// 卫星组按真实星历核对成员（useSatGroups.reconcile）：自动移除已离轨的星。
//
// ★ 这套测试盯的是「什么时候【不】该删」——误删是不可逆的（组只存 NORAD，删掉就要用户自己找回来），
//   所以每条守卫都单独立一个用例：首次缺席只记账、同一份目录重复跑不推进、星回来了要撤销观察、
//   合成星永不参与、单组掉太多整组不动。真删得掉只需要一条用例，防止误删需要六条。
import assert from 'node:assert/strict'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

// composable 只用到 localStorage
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}

const { useSatGroups } = await import('../../../src/viz/constellation/useSatGroups.js')

const T1 = '2026-08-01T00:00:00.000Z'
const T2 = '2026-08-02T00:00:00.000Z'
const T3 = '2026-08-03T00:00:00.000Z'

// probe 工厂：inPool 里的返 true，exempt 里的返 null（不参与），其余 false（缺席）
const mkProbe = (inPool, exempt = []) => (id) => {
  if (exempt.includes(String(id))) return null
  return inPool.includes(String(id))
}
const satOf = (g, id) => g.sats.find((s) => s.id === String(id)) || null
const ids = (g) => g.sats.map((s) => s.id)

// —— 1. 首次缺席：只记账，一颗都不删 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  const rep = G.reconcile(mkProbe(['111']), T1)
  eq(ids(G.find(g.id)), ['111', '222'], '首次缺席不删任何成员')
  eq(rep, [], '首次缺席不产生移除报告')
  eq(satOf(G.find(g.id), 222).missAt, T1, '缺席星记下 missAt')
  ok(!satOf(G.find(g.id), 111).missAt, '在池的星不带 missAt')
}

// —— 2. 同一份目录重复跑：epoch 没变新 → 判决不推进 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  G.reconcile(mkProbe(['111']), T1)
  const rep = G.reconcile(mkProbe(['111']), T1)   // 同一份目录再跑一遍
  eq(ids(G.find(g.id)), ['111', '222'], '同一份目录重复跑不移除')
  eq(rep, [], '同一份目录重复跑不报移除')
  // 更旧的一份目录同样不能推进（离线回落到旧缓存时会这样）
  G.reconcile(mkProbe(['111']), '2026-07-01T00:00:00.000Z')
  eq(ids(G.find(g.id)), ['111', '222'], '比 missAt 更旧的目录不移除')
}

// —— 3. 隔一份更新的完整目录仍缺席 → 移除 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  G.reconcile(mkProbe(['111']), T1)
  const rep = G.reconcile(mkProbe(['111']), T2)
  eq(ids(G.find(g.id)), ['111'], '第二份更新的目录仍缺席 → 移除')
  eq(rep.length, 1, '产生一条移除报告')
  eq(rep[0].removed, [{ id: '222', name: 'B' }], '报告点名移除了谁')
  eq(rep[0].remain, 1, '报告带剩余颗数')
  eq(rep[0].total, 2, '报告带原总数')
  // 持久化跟着走，不是只改了内存
  const blob = JSON.parse(localStorage.getItem('constellation3d/satGroups'))
  eq(blob.items[0].sats.map((s) => s.id), ['111'], '移除已落盘')
}

// —— 4. 星回到目录里 → 撤销观察，重新计两轮 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  G.reconcile(mkProbe(['111']), T1)                 // B 缺席，记账
  G.reconcile(mkProbe(['111', '222']), T2)          // B 回来了
  ok(!satOf(G.find(g.id), 222).missAt, '星回到目录里 → missAt 被撤销')
  G.reconcile(mkProbe(['111']), T3)                 // 又缺席：这是新的第一次
  eq(ids(G.find(g.id)), ['111', '222'], '撤销后重新缺席要再走两轮，不能一次就删')
  eq(satOf(G.find(g.id), 222).missAt, T3, '重新记账用的是新 epoch')
}

// —— 5. 合成星（自定义星座）永不参与核对 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 900001, name: '自建星' }], '组一')
  G.reconcile(mkProbe(['111'], ['900001']), T1)
  G.reconcile(mkProbe(['111'], ['900001']), T2)
  G.reconcile(mkProbe(['111'], ['900001']), T3)
  eq(ids(G.find(g.id)), ['111', '900001'], '合成星连跑三轮也不掉')
  ok(!satOf(G.find(g.id), 900001).missAt, '合成星连 missAt 都不记')
}

// —— 6. 安全阀：单组一次掉过半 → 整组原地不动，只报告 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([1, 2, 3, 4, 5, 6].map((n) => ({ noradId: n, name: 'S' + n })), '大组')
  G.reconcile(mkProbe(['1', '2', '3', '4', '5', '6']), T1)   // 全在池：无 missAt
  G.reconcile(mkProbe(['1', '2']), T2)                        // 4 颗缺席：记账
  const rep = G.reconcile(mkProbe(['1', '2']), T3)            // 仍缺席 → 4/6 > 0.5，撞阀
  eq(ids(G.find(g.id)).length, 6, '撞安全阀时整组一颗不删')
  eq(rep.length, 1, '撞阀也要报告')
  eq(rep[0].skipped, 4, '报告写明本可掉几颗')
  eq(rep[0].removed, [], '撞阀报告里没有 removed')
  // 阀值以下就照常删：目录恢复到只缺 1 颗
  const rep2 = G.reconcile(mkProbe(['1', '2', '3', '4', '5']), '2026-08-04T00:00:00.000Z')
  eq(ids(G.find(g.id)), ['1', '2', '3', '4', '5'], '回到阀值以下后照常移除')
  eq(rep2[0].removed.length, 1, '只掉该掉的那一颗')
}

// —— 7. 小组不设阀（三颗掉两颗完全可能是真的，按比例卡会把小组永远锁死）——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 1, name: 'A' }, { noradId: 2, name: 'B' }, { noradId: 3, name: 'C' }], '小组')
  G.reconcile(mkProbe(['1']), T1)
  G.reconcile(mkProbe(['1']), T2)
  eq(ids(G.find(g.id)), ['1'], 'minGroupSize 以下的组不受比例阀限制')
}

// —— 8. 非法 epoch / 非法 probe：整个空转，绝不动数据 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  eq(G.reconcile(mkProbe(['111']), ''), [], '空 epoch 直接空转')
  eq(G.reconcile(mkProbe(['111']), 'not-a-date'), [], '坏 epoch 直接空转')
  eq(G.reconcile(null, T1), [], '没有 probe 直接空转')
  eq(ids(G.find(g.id)), ['111', '222'], '空转不留痕')
  ok(!satOf(G.find(g.id), 222).missAt, '空转连 missAt 都不记')
}

// —— 9. 配色与观察标记互不吞并 ——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  G.colorSats(g.id, ['222'], '#ff0000')
  G.reconcile(mkProbe(['111']), T1)
  eq(satOf(G.find(g.id), 222).color, '#ff0000', '记 missAt 不吞掉逐颗色')
  eq(satOf(G.find(g.id), 222).missAt, T1, '有色的成员照样记 missAt')
  G.colorSats(g.id, ['222'], '')          // 清色
  eq(satOf(G.find(g.id), 222).missAt, T1, '清色不吞掉 missAt')
  ok(!satOf(G.find(g.id), 222).color, '色确实清掉了')
  // 复制一组要把观察标记一并带走，否则副本的判决要从头再走两轮
  const c = G.duplicate(g.id)
  eq(satOf(c, 222).missAt, T1, '复制组带走 missAt')
}

// —— 10. 重新 load 后 missAt 能从存储里回来（跨会话累积判决）——
{
  store.clear()
  const G = useSatGroups()
  const g = G.add([{ noradId: 111, name: 'A' }, { noradId: 222, name: 'B' }], '组一')
  G.reconcile(mkProbe(['111']), T1)
  const G2 = useSatGroups()               // 模拟下次启动
  G2.load()
  eq(satOf(G2.find(g.id), 222).missAt, T1, 'missAt 跨会话保留')
  const rep = G2.reconcile(mkProbe(['111']), T2)
  eq(ids(G2.find(g.id)), ['111'], '新会话拿到更新的目录即完成判决')
  eq(rep[0].removed.length, 1, '跨会话也报告移除')
}

console.log(`satGroupReconcile: ${pass} 项断言全部通过`)
