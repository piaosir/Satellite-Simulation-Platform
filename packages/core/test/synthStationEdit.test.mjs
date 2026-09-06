// 站点栅「框选 / 类型 / 撤销」交互自测（useBeamSynth 的编辑态那一半）。运行：node packages/core/test/synthStationEdit.test.mjs
//
// 盯的是 2026-09-06 那轮改动定下的四条口径：
//   ① 模式与选区分家 —— 退出框选【保留】选中的站（否则一退出就丢选区，连地图都平移不了）；
//      整体退出（离开视图 / 切组 / 切模式）走 exitStEdit，close() 必须捎上它 —— 「切到别的页面框选还留在地图上」就是这儿漏的。
//   ② 框选 Ctrl=并入 / Alt=减选（SATSOFT §9.2 Select Stations 本就是 select or de-select）；全选 / 反选＝§9.4 / §9.3。
//   ③ Contour / 抑制 / 排除＝SATSOFT §9.12 的站点类型，落到 p.stOv 的 t 上（引擎按它分 KIND，见 synth.js）；
//      stSelType 给这三个钮点亮当前态：选中的站类型全同 → 那一档，不一致 → 'mix'。
//   ④ 类型改写 / 目标偏置 / 重置 / 加站全部先 pushUndo —— 「重置」此前是不可逆的一下。
import { ref } from 'vue'

let store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
  removeItem: (k) => { delete store[k] }
}
const { useBeamSynth } = await import('../../../src/viz/grd/useBeamSynth.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// —— 最小替身：一颗 GEO 星 + 一块方形覆盖区（110°E 上空，赤道对称，站点栅必落在方框内）——
const POLY = { id: 'pg1', name: '测试区', pts: [[100, 10], [120, 10], [120, 30], [100, 30]] }
function makeBs() {
  store = {}
  const grd = {
    sats: ref([{ folder: 'sat1', name: 'TESTSAT', antennas: [] }]),
    active: ref(''),
    loadIndex: async () => {},
    importSynthGrd: async () => 'sat1|ant',
    removeAntenna: () => {}
  }
  return useBeamSynth({
    grd,
    getPolys: () => [POLY],
    livePos: () => ({ lon: 110, lat: 0, altKm: 35786 }),
    appAlert: () => {},
    refresh: () => {}
  })
}
// 覆盖区经纬 → 框选用的角点（整块框住 = 全选，半块 = 一半）
const BOX_ALL = [{ lon: 99, lat: 9 }, { lon: 121, lat: 31 }]
const BOX_LEFT = [{ lon: 99, lat: 9 }, { lon: 110, lat: 31 }]

const bs = makeBs()
bs.addGroup('shaped')
bs.togglePoly('pg1')
bs.p.stDens = 1.5                                  // 站少一点，跑得快；密度不影响本文件验的口径

const sq = () => (bs.stInfo.value ? bs.stInfo.value.squares : [])
ok('站点栅出得来（赋形组 + 一块覆盖区）', sq().length > 8, sq().length + ' 站')

// ① 框选：默认=新选择，Ctrl=并入，Alt=减选
bs.stBoxSelect(BOX_LEFT[0], BOX_LEFT[1], false, false)
const nLeft = bs.stSel.value.size
ok('框左半 → 选中一部分', nLeft > 0 && nLeft < sq().length, nLeft + '/' + sq().length)
bs.stBoxSelect(BOX_ALL[0], BOX_ALL[1], true, false)
ok('Ctrl+框全区 → 并入到全部', bs.stSel.value.size === sq().length, bs.stSel.value.size + '/' + sq().length)
bs.stBoxSelect(BOX_LEFT[0], BOX_LEFT[1], false, true)
ok('Alt+框左半 → 从选区里减掉左半', bs.stSel.value.size === sq().length - nLeft, bs.stSel.value.size + '')
bs.stBoxSelect(BOX_LEFT[0], BOX_LEFT[1], false, false)
ok('无修饰键框选 → 重新开始（不累加）', bs.stSel.value.size === nLeft)

// ② 全选 / 反选（SATSOFT §9.4 / §9.3）
bs.invertStSel()
ok('反选 → 取补集', bs.stSel.value.size === sq().length - nLeft)
bs.selectAllSt()
ok('全选 → 全部在场的站', bs.stSel.value.size === sq().length)
bs.clearStSel()
ok('清选 → 空', bs.stSel.value.size === 0)

// ③ 类型：Contour / 抑制 / 排除 落到 p.stOv，stSelType 反映当前态
bs.stBoxSelect(BOX_LEFT[0], BOX_LEFT[1], false, false)
ok('类型缺省＝Contour（生成栅时全部站点都是这一类）', bs.stSelType.value === 'cov', String(bs.stSelType.value))
bs.applyStType('sup')
ok('转抑制 → 落到 p.stOv 的 t', (bs.p.stOv || []).filter((o) => o.t === 'sup').length === nLeft, (bs.p.stOv || []).length + ' 条修正')
ok('转抑制 → 类型钮点亮「抑制」', bs.stSelType.value === 'sup', String(bs.stSelType.value))
const supIds = [...bs.stSel.value]
bs.stSel.value = new Set(supIds.slice(0, 1))
bs.applyStType('cov')
bs.stSel.value = new Set(supIds)
ok('一半改回 Contour → 类型钮谁也不亮（mix）', bs.stSelType.value === 'mix', String(bs.stSelType.value))
bs.applyStType('ex')
ok('转排除 → 全体 ex', bs.stSelType.value === 'ex', String(bs.stSelType.value))
bs.applyStType('cov')
ok('还原 Contour → 修正条目自行清空（无偏置时不留垃圾）', (bs.p.stOv || []).length === 0, (bs.p.stOv || []).length + ' 条')

// 目标偏置：正=抬高、0=清除
bs.applyStGoal(2.5)
ok('目标偏置 +2.5 dB → 落到 stOv.g', (bs.p.stOv || []).filter((o) => o.g === 2.5).length === nLeft)
bs.applyStGoal(0)
ok('目标偏置 0 → 清除（条目一并回收）', (bs.p.stOv || []).length === 0)

// ④ 撤销：类型改写与「重置」都进撤销栈
bs.applyStType('sup')
const nSup = (bs.p.stOv || []).length
ok('撤销可用（类型改写压了快照）', bs.canUndo.value === true)
bs.undo()
ok('撤销 → 站点修正回滚', (bs.p.stOv || []).length === 0, nSup + ' → ' + (bs.p.stOv || []).length)
bs.redo()
ok('重做 → 修正回来', (bs.p.stOv || []).length === nSup)
bs.resetStations()
ok('重置 → 清空全部修正', (bs.p.stOv || []).length === 0 && (bs.p.stAdd || []).length === 0)
bs.undo()
ok('重置可撤销（此前这一下不可逆）', (bs.p.stOv || []).length === nSup, (bs.p.stOv || []).length + ' 条')

// ⑤ 模式与选区分家：退出框选保留选区；离开视图（close）整体退出
bs.toggleStEdit()
ok('框选态开', bs.stEditOn.value === true)
bs.stBoxSelect(BOX_LEFT[0], BOX_LEFT[1], false, false)
bs.toggleStEdit()
ok('退出框选 → 模式关', bs.stEditOn.value === false)
ok('退出框选 → 选中的站保留（可挪地图再进来接着选）', bs.stSel.value.size === nLeft, bs.stSel.value.size + '')
bs.toggleStEdit()
bs.toggleStPick()
ok('加站态与框选态互斥', bs.stPick.value === true && bs.stEditOn.value === false)
bs.close()
ok('收面板（收起侧栏）→ 选区与加站态原样保留（收起侧栏≠离开视图）',
  bs.stPick.value === true && bs.stSel.value.size === nLeft)
bs.exitStEdit()
ok('离开波束合成视图（页面按 sideCtx 调 exitStEdit）→ 框选/加站/选区全退',
  bs.stEditOn.value === false && bs.stPick.value === false && bs.stSel.value.size === 0)

// 手工加站也进撤销栈
bs.openFor('sat1')
const addBefore = (bs.p.stAdd || []).length
bs.toggleStPick()
bs.placeAt({ lon: 108, lat: 18 })
ok('加站 → stAdd 多一条', (bs.p.stAdd || []).length === addBefore + 1)
bs.undo()
ok('加站可撤销', (bs.p.stAdd || []).length === addBefore)

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
