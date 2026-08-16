// 配置库按工作台命名空间分家（configs.<ns>.json）+ 旧 configs.json 一次性迁移。
// 动的是用户存量数据，故这套断言盯死三件事：① 迁移前后各窗看到的列表逐条不变；
// ② 旧文件只读不改（回滚兜底）；③ 一个窗口的写入不碰另一个窗口的库。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
let pass = 0
const ok = (cond, msg) => { assert.ok(cond, msg); pass++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); pass++ }

// 每个用例一份干净数据目录：storage 的 baseDir 只解析一次，故 storage 也要跟着重新 require
function freshStore(legacy) {
  const dir = mkdtempSync(join(tmpdir(), 'satsim-cfg-'))
  process.env.SATSIM_DATA_DIR = dir
  if (legacy) writeFileSync(join(dir, 'configs.json'), JSON.stringify(legacy, null, 2))
  delete require.cache[require.resolve('../../../electron/services/storage.js')]
  return { dir, storage: require('../../../electron/services/storage.js') }
}
const readNs = (dir, ns) => JSON.parse(readFileSync(join(dir, `configs.${ns}.json`), 'utf8'))

// 五体制混装的旧库，含各窗口迁移前 loadConfigs 会认领的每一种形态
const LEGACY = [
  { id: 'g-folder', type: 'folder', name: 'GEO 分组', orbitType: 'GEO' },
  { id: 'g1', name: 'GEO 显式', parentId: 'g-folder', state: { orbitType: 'GEO', rows: [1] } },
  { id: 'g2', name: 'GEO 遗留无 orbitType', state: { rows: [2] } },           // 老配置：无 orbitType ⇒ GEO
  { id: 'g3', name: '早期空壳', params: {} },                                  // 无 state ⇒ 也落 GEO（照抄现状）
  { id: 'n-folder', type: 'folder', name: 'NGSO 分组', orbitType: 'NGSO' },
  { id: 'n1', name: 'NGSO 配置', parentId: 'n-folder', state: { orbitType: 'NGSO' } },
  { id: 'r1', name: '再生式配置', state: { orbitType: 'REGEN' } },
  { id: 'e-folder', type: 'folder', name: '端到端分组', orbitType: 'E2E' },
  { id: 'e1', name: '端到端配置', parentId: 'e-folder', state: { orbitType: 'E2E' } },
  { id: 'x1', name: '跨库孤儿', parentId: 'n-folder', state: { orbitType: 'E2E' } },   // 父级在别的库里
  { id: 'w1', name: '雨衰配置', state: { orbitType: 'RAIN' } }
]

// —— ① 迁移：逐条归位，与各窗口原过滤规则一致 ——
{
  const { dir, storage } = freshStore(LEGACY)
  eq(storage.listConfigs('geo').map((c) => c.id), ['g-folder', 'g1', 'g2', 'g3'], 'GEO 白名单：显式 + 无 orbitType + 无 state 三种都收')
  eq(storage.listConfigs('ngso').map((c) => c.id), ['n-folder', 'n1'], 'NGSO 只收自己那批')
  eq(storage.listConfigs('regen').map((c) => c.id), ['r1'], '再生式只收自己那批')
  eq(storage.listConfigs('e2e').map((c) => c.id), ['e-folder', 'e1', 'x1'], '端到端只收自己那批')
  eq(storage.listConfigs('rain').map((c) => c.id), ['w1'], '雨衰只收自己那批')

  // 归属之和 = 旧库全量：一条都不许在拆分中蒸发
  const total = ['geo', 'ngso', 'regen', 'e2e', 'rain'].reduce((n, ns) => n + storage.listConfigs(ns).length, 0)
  eq(total, LEGACY.length, '拆分无损：五库条目数之和等于旧库')

  // 跨库的 parentId 必须清空，否则在新文件里是悬空引用
  eq(storage.listConfigs('e2e').find((c) => c.id === 'x1').parentId, null, '跨库 parentId 清成 null')
  eq(storage.listConfigs('e2e').find((c) => c.id === 'e1').parentId, 'e-folder', '同库 parentId 原样保留')

  // 旧文件只读不动
  eq(JSON.parse(readFileSync(join(dir, 'configs.json'), 'utf8')), LEGACY, '旧 configs.json 未被改写（回滚兜底）')
  rmSync(dir, { recursive: true, force: true })
}

// —— ② 迁移只做一次：新库里删掉的条目不会被下次访问从旧库补回来 ——
{
  const { dir, storage } = freshStore(LEGACY)
  storage.deleteConfig('geo', 'g2')
  eq(storage.listConfigs('geo').map((c) => c.id), ['g-folder', 'g1', 'g3'], '删除生效')
  delete require.cache[require.resolve('../../../electron/services/storage.js')]
  const again = require('../../../electron/services/storage.js')
  eq(again.listConfigs('geo').map((c) => c.id), ['g-folder', 'g1', 'g3'], '重启后不重迁：已删的不复活')
  rmSync(dir, { recursive: true, force: true })
}

// —— ③ 主文件不在但 .bak 在：不许重迁盖掉可恢复的那份 ——
{
  const { dir, storage } = freshStore(LEGACY)
  storage.saveConfig('geo', { name: '新配置' })                    // 触发一次写，产出 .bak
  const f = join(dir, 'configs.geo.json')
  const kept = JSON.parse(readFileSync(f, 'utf8'))
  writeFileSync(f + '.bak', JSON.stringify(kept))
  rmSync(f)
  delete require.cache[require.resolve('../../../electron/services/storage.js')]
  const again = require('../../../electron/services/storage.js')
  eq(again.listConfigs('geo').map((c) => c.id), kept.map((c) => c.id), '主文件缺失时走 .bak 恢复，而非重迁旧库')
  rmSync(dir, { recursive: true, force: true })
}

// —— ④ 库间隔离：一个工作台的增删移不碰另一个 ——
{
  const { dir, storage } = freshStore(LEGACY)
  const before = storage.listConfigs('ngso')
  storage.saveConfig('geo', { name: 'GEO 新增' })
  storage.moveItem('geo', 'g1', null, null, 'inside')
  storage.deleteFolder('geo', 'g-folder')
  eq(storage.listConfigs('ngso'), before, 'GEO 的增/移/级联删除后 NGSO 库逐条不变')

  // 级联删除只清本库子树
  ok(!storage.listConfigs('geo').some((c) => c.id === 'g-folder'), '文件夹已删')
  ok(storage.listConfigs('ngso').some((c) => c.id === 'n-folder'), '同名概念的 NGSO 文件夹不受牵连')
  rmSync(dir, { recursive: true, force: true })
}

// —— ⑤ 未知命名空间抛错，绝不静默落到某一份库 ——
{
  const { dir, storage } = freshStore(LEGACY)
  assert.throws(() => storage.listConfigs('geo2'), /未知的配置命名空间/, '未知 ns 抛错'); pass++
  assert.throws(() => storage.saveConfig(undefined, { name: 'x' }), /未知的配置命名空间/, 'ns 缺省也抛错'); pass++
  rmSync(dir, { recursive: true, force: true })
}

// —— ⑥ 全新安装（无旧库）：各库为空且不产生垃圾文件 ——
{
  const { dir, storage } = freshStore(null)
  eq(storage.listConfigs('e2e'), [], '无旧库时为空列表')
  ok(!existsSync(join(dir, 'configs.e2e.json')), '只读不写：未落盘空文件')
  storage.saveConfig('e2e', { name: '第一份' })
  eq(storage.listConfigs('e2e').length, 1, '首次写入时自然创建')
  rmSync(dir, { recursive: true, force: true })
}

// —— ⑦ 跨库总览（主窗口配置管理页）——
{
  const { dir, storage } = freshStore(LEGACY)
  const all = storage.listAllConfigs()
  eq(all.map((g) => g.ns), ['geo', 'ngso', 'regen', 'e2e', 'rain'], '总览按固定顺序给出五个命名空间')
  eq(all.reduce((n, g) => n + g.items.length, 0), LEGACY.length, '总览覆盖全部条目')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`configStore: ${pass} 项断言全部通过`)
