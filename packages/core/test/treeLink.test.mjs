// 卫星 / 天线树 ↔ 星座 联动的纯逻辑（src/viz/grd/treeLink.js）。运行：node packages/core/test/treeLink.test.mjs
//
//   ① createNoradResolver：解析顺序（在场 → 全量池 → 自定义星座）、同号取第一份、String 比对（数字 / 字符串混存）、
//      命中缓存（同一来源不重复扫 / 不重复问自定义星座）、四项来源任一换了整表作废（含缓存下来的 null）、不按名字配。
//   ② foldersForNorads：NORAD → folder 一对多、多对多、混合类型、仰角线与无号节点不参与。
//   ③ linkMissing：池没就绪不下判断；就绪后按解析器判；非关联 / 仰角线恒 false。
//   ④ followFolder：波束合成跟随主选 —— 当前星已关联同号不动；切到树序第一个关联 folder；无关联 null。
//   ⑤ recordWithModel：换模型后逐波束已解析量按新模型重算、视轴 / 身份 / 星位 / 窗口原样保留；非法参数抛错。
import { createNoradResolver, foldersForNorads, linkedNodesOf, linkMissing, followFolder, recordWithModel } from '../../../src/viz/grd/treeLink.js'
import { buildRecord, freshModel, solveStk } from '../../../src/viz/grd/gaussStk.js'
//   ⑥ 解析器的点序列一路（eph）：隐藏图层的点序列星照样解析得到；顺序 在场 → 全量池 → eph → 自定义星座；eph 换新整表作废。
//   ⑦ ephGroupsToLoad：只挑被树关联着、还没载表的点序列组；gp 组 / 已载 / 仰角线 / 无号不参与。
//   ⑧ grdLivePayload + 链路预算 grdParam：关联星此刻解不出 → 进 noEph（不写 pos）；链路预算读回仍是实时星（回填指纹不翻）、
//      不按存盘旧星位取值（采样全 null、地理图规格 null）→ 手改值不被冲掉。
import { ephGroupsToLoad, grdLivePayload } from '../../../src/viz/grd/treeLink.js'
//   ⑨ createFollowGate：波束合成跟随只认用户换 / 点名主选（程序性刷新不放行、主选没变不放行）。
//   ⑩ synthGroupDrives / synthOwned：波束合成产物只在组在世且正驱动它时只读；死 owner 的多设置天线逐模型就地改、owner 抹掉。
import { createFollowGate, synthGroupDrives, synthOwned } from '../../../src/viz/grd/treeLink.js'
//   ⑪ createLiveThrottle：grdLive 写入节流；星历源换了（due）那一拍不受节流 —— 暂停档启动时池到齐前写下的 noEph 不许被 3 s 节流留住
//      （复现脚本 review2/throttle_sim.mjs：T0 写 noEph、池两段都在 3 s 内到齐被吞 → 链路预算一直读到无星历）。页面接线按源码钉。
//   ⑫ focusStale：树聚焦的过期判据（createGaussFor 等星历源 / 建天线那几秒里用户另选了星 → 不再拽回）；页面接线按源码钉。
import { createLiveThrottle, focusStale } from '../../../src/viz/grd/treeLink.js'
//   ⑬ treeNavState：两棵树卫星行「聚焦 / 跟随」两钮的点亮 / 置灰 / 悬停说明（关联 / 非关联 / 缺失 / 平面图 / 正跟随）；
//      说明文字都在 UI 词典里；两棵树与页面接线（Ctrl 点加减、非关联星与正跟随的星显式聚焦先退出跟随）按源码钉。
import { treeNavState, nodeLinkId } from '../../../src/viz/grd/treeLink.js'
import { EXACT as UI_EXACT, PAT as UI_PAT } from '../../../src/shared/i18n/uiDict.data.js'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }

// ---------- ① 解析器 ----------
{
  const eA = { noradId: '25544', name: 'ISS (ZARYA)', tag: 'entries' }
  const eB = { noradId: 43013, name: 'NOAA 20', tag: 'entries' }         // 数字号
  const eB2 = { noradId: '43013', name: 'NOAA 20', tag: 'entries-dup' }  // 同号第二份：不该被取到
  const pA = { noradId: '25544', name: 'ISS', tag: 'pool' }
  const pC = { noradId: 20580, name: 'HST', tag: 'pool' }
  const pSame = { noradId: '99999', name: 'ISS (ZARYA)', tag: 'pool-same-name' }   // 同名不同号：绝不能按名字命中
  const cc = { noradId: '900003', name: 'CC-P01-S04', tag: 'cc' }
  let ccCalls = 0
  const src = { entries: [eA, eB, eB2], pool: [pA, pC, pSame], ccList: [{ id: 'c1' }], ccEpoch: 'E1', ccFind: (id) => { ccCalls++; return id === '900003' ? cc : null } }
  const r = createNoradResolver(() => src)
  ok(r('25544') === eA, '在场优先于全量池（同号取 entries 那份）')
  ok(r(25544) === eA, '数字号与字符串号同一身份')
  ok(r('43013') === eB, '数字存的号按字符串命中')
  ok(r('43013') !== eB2, '同号多份取第一份（与 Array.find 同口径）')
  ok(r('20580') === pC, '在场没有 → 全量池')
  ok(r('900003') === cc, '都没有 → 自定义星座')
  ok(r('') === null && r(null) === null && r(undefined) === null, '空号 → null')
  ok(r('ISS (ZARYA)') === null, '不按名字配（名字当号问 → null）')
  ok(r('11111') === null, '查无此星 → null')
  const c0 = ccCalls
  r('11111'); r('11111'); r('900003')
  ok(ccCalls === c0, '命中缓存（含 null）：同一来源不再问自定义星座', `calls ${ccCalls - c0}`)
  // 来源换了 → 整表作废
  const eD = { noradId: '11111', name: 'NEW', tag: 'entries' }
  src.entries = [eA, eB, eD]
  ok(r('11111') === eD, 'entries 换新数组 → 缓存的 null 作废，新星解析得到')
  src.pool = [{ noradId: '25544', tag: 'pool2' }, { noradId: '20580', tag: 'pool2' }]
  ok(r('20580').tag === 'pool2', 'searchPool 换新 → 池索引重建')
  ok(r('900003') === cc, '池换新后自定义星座照常解析（记进新表）')
  let cc2 = { noradId: '900003', name: 'CC-P01-S04', tag: 'cc-rebuilt' }
  src.ccFind = (id) => (id === '900003' ? cc2 : null)
  ok(r('900003') === cc, 'ccFind 换了但 list/历元未变 → 仍命中旧缓存（自定义星座只认 list 引用与历元）')
  src.ccEpoch = 'E2'
  ok(r('900003') === cc2, '场景历元变了 → 合成星重新解析')
  cc2 = { noradId: '900003', tag: 'cc-v3' }
  src.ccFind = (id) => (id === '900003' ? cc2 : null)
  src.ccList = [{ id: 'c1' }]                      // list 整份换新（增删改星座）
  ok(r('900003').tag === 'cc-v3', '自定义星座 list 换新 → 重新解析')
  // 删除后：同号在任何来源都没了 → null（不留旧对象）
  src.entries = [eA]; src.pool = []; src.ccList = []; src.ccFind = () => null
  ok(r('900003') === null && r('43013') === null, '来源里删掉 → 解析为 null，不残留缓存对象')
  r.reset(); ok(r('25544') === eA, 'reset 后照常解析')
}

// ---------- ② NORAD → folder ----------
{
  const nodes = [
    { folder: 'A', noradId: '25544', kind: 'linked' },
    { folder: 'A·2', noradId: 25544, kind: 'linked' },        // 同号第二个 folder，数字存储
    { folder: 'B', noradId: '43013', kind: 'preset' },         // 预置星关联后 kind 仍是 preset
    { folder: 'C', noradId: null, kind: 'custom' },
    { folder: 'O', noradId: null, elements: { altKm: 500 }, kind: 'orbit' },
    { folder: 'EL', noradId: '25544', kind: 'elevline' },      // 仰角线：不参与（防御：即便带了号）
    { folder: 'Z', noradId: '', kind: 'linked' }
  ]
  const s1 = foldersForNorads(nodes, ['25544'])
  ok(s1.size === 2 && s1.has('A') && s1.has('A·2'), '一号多 folder（字符串 / 数字混存）', [...s1].join(','))
  ok(!s1.has('EL'), '仰角线不参与')
  const s2 = foldersForNorads(nodes, [25544, '43013', 20580])
  ok(s2.size === 3 && s2.has('B'), '多号 → 多 folder；没有关联的号不产出', [...s2].join(','))
  ok(foldersForNorads(nodes, []).size === 0 && foldersForNorads(nodes, ['']).size === 0 && foldersForNorads(nodes, [null]).size === 0, '空选中集 / 空号 → 空集')
  ok(foldersForNorads([], ['25544']).size === 0 && foldersForNorads(null, ['1']).size === 0, '空树 → 空集')
  ok(linkedNodesOf(nodes, 25544).map((n) => n.folder).join(',') === 'A,A·2', 'linkedNodesOf 按树序')
  ok(linkedNodesOf(nodes, '').length === 0, 'linkedNodesOf 空号 → []')
}

// ---------- ③ 关联缺失 ----------
{
  const have = new Set(['25544'])
  const resolve = (id) => (have.has(String(id)) ? { noradId: id } : null)
  const nOk = { folder: 'A', noradId: '25544', kind: 'linked' }
  const nGone = { folder: 'G', noradId: 99999, kind: 'linked' }
  ok(linkMissing(nGone, false, resolve) === false, '池没就绪：找不到不算缺失')
  ok(linkMissing(nGone, true, resolve) === true, '池就绪且解析不到 → 缺失')
  ok(linkMissing(nOk, true, resolve) === false, '解析得到 → 不缺失')
  ok(linkMissing({ folder: 'C', noradId: null, kind: 'custom' }, true, resolve) === false, '非关联星恒 false')
  ok(linkMissing({ folder: 'E', noradId: '1', kind: 'elevline' }, true, resolve) === false, '仰角线恒 false')
  ok(linkMissing(null, true, resolve) === false, '空节点 false')
}

// ---------- ④ 波束合成跟随 ----------
{
  const nodes = [
    { folder: 'X', noradId: null, kind: 'custom' },
    { folder: 'A', noradId: '25544', kind: 'linked' },
    { folder: 'A·2', noradId: 25544, kind: 'linked' },
    { folder: 'B', noradId: '43013', kind: 'linked' }
  ]
  ok(followFolder(nodes, '25544', 'X') === 'A', '当前星不是主选 → 切到树序第一个关联 folder')
  ok(followFolder(nodes, 25544, 'A·2') === null, '当前星已关联同号（用户挑的第二个）→ 不动')
  ok(followFolder(nodes, '25544', 'A') === null, '已在该 folder → 不动')
  ok(followFolder(nodes, '43013', 'A') === 'B', '换主选 → 切过去')
  ok(followFolder(nodes, '11111', 'A') === null, '主选没有关联 folder → 不动')
  ok(followFolder(nodes, '', 'A') === null, '无主选 → 不动')
  ok(followFolder(nodes, '43013', '') === 'B', '导航器还没选星 → 切过去')
  ok(followFolder(nodes, '43013', 'gone') === 'B', '当前 folder 已被删 → 切过去')
}

// ---------- ⑤ 换模型重建记录 ----------
{
  const m1 = { id: 'm1', name: '', ...freshModel() }
  const rec = buildRecord({ sat: { name: 'SAT', lon: 110.5, lat: 0, altKm: 35786 }, models: [m1], beams: [{ name: 'b1', az: 1.5, el: -2, model: 'm1' }, { name: '', az: 0, el: 0, model: 'm1' }] })
  const next = { ...m1, drv: 'bw', bw3: 3, fGHz: 20, eff: 60, back: -25, k: '4ln2', id: 'hacked', name: 'hacked' }
  const rec2 = recordWithModel(rec, 0, next)
  const sol = solveStk({ ...next })
  ok(rec2.models[0].id === 'm1' && rec2.models[0].name === '', '模型身份（id / 名）不被界面值改掉')
  ok(rec2.beams.length === 2 && rec2.beams[0].az === 1.5 && rec2.beams[0].el === -2 && rec2.beams[0].name === 'b1' && rec2.beams[0].model === 'm1', '波束视轴 / 名 / 模型引用原样')
  ok(Math.abs(rec2.beams[0].th3 - 3) < 1e-12 && Math.abs(rec2.beams[1].g0 - sol.g0Dbi) < 1e-12, '逐波束 θ3 / g0 按新模型重算', `th3 ${rec2.beams[0].th3} g0 ${rec2.beams[1].g0.toFixed(4)}`)
  ok(rec2.beams.every((b) => b.k === '4ln2' && b.back === -25), '滚降系数 / 背瓣随模型')
  ok(rec2.sat.lon === 110.5 && rec2.sat.altKm === 35786 && rec2.win === rec.win && rec2.owner === null, '星位 / 窗口 / 归属原样')
  ok(rec.beams[0].th3 !== rec2.beams[0].th3 && rec.models[0].drv === 'D', '入参记录不被改动')
  let threw = false
  try { recordWithModel(rec, 0, { ...m1, eff: 0 }) } catch { threw = true }
  ok(threw, '非法参数（效率 0）抛错，不产出半截记录')
}

// ---------- ⑥ 解析器：点序列一路（隐藏图层也解析） ----------
{
  const eVis = { noradId: '80001', tag: 'entries' }                  // 可见点序列组的星（在场）
  const xHid = { noradId: '80101', tag: 'eph' }                      // 隐藏点序列组的星（只在 eph）
  const xDup = { noradId: '80001', tag: 'eph-dup' }                  // 可见组的同一颗也在 eph 里：在场那份优先
  const pA = { noradId: '25544', tag: 'pool' }
  const xPoolDup = { noradId: '25544', tag: 'eph-pool-dup' }         // 防御：同号也在 eph → 全量池优先
  let ccCalls = 0
  const src = { entries: [eVis], pool: [pA], eph: [xDup, xHid, xPoolDup], ccList: [], ccEpoch: 'E', ccFind: (id) => { ccCalls++; return id === '90001' ? { noradId: '90001', tag: 'cc' } : null } }
  const r = createNoradResolver(() => src)
  ok(r('80101') === xHid, '隐藏图层的点序列星从 eph 解析得到')
  ok(r(80101) === xHid, 'eph 一路同样 String 比（数字号）')
  ok(r('80001') === eVis, '在场优先于 eph')
  ok(r('25544') === pA, '全量池优先于 eph')
  ok(r('90001').tag === 'cc', 'eph 没有 → 自定义星座')
  const c0 = ccCalls; r('80101'); r('80101')
  ok(ccCalls === c0, 'eph 命中也进缓存')
  // 图层关了：entries 里没了那颗 → 仍从 eph 解析（身份不随地图显隐变）
  src.entries = []
  ok(r('80001') === xDup, '可见组关掉后（出了 entries）同一颗改从 eph 解析')
  // eph 换新：删掉那组 → 缓存作废 → null
  src.eph = [xPoolDup]
  ok(r('80101') === null, 'eph 整份换新（组删了 / 作废）→ 缓存作废，解析为 null')
  const nHid = { noradId: '80222', tag: 'eph-new' }
  src.eph = [nHid]
  ok(r('80222') === nHid, 'eph 换新后新载入的组即可解析（缓存的 null 作废）')
  // 没有 eph 字段（老调用方）照旧工作
  const r2 = createNoradResolver(() => ({ entries: [eVis], pool: [pA] }))
  ok(r2('80001') === eVis && r2('80101') === null, '不给 eph 的调用方行为不变')
}

// ---------- ⑦ 该补载哪些点序列组 ----------
{
  const groups = [
    { id: 'gp1', kind: 'gp', sats: [{ noradId: '25544' }] },                          // gp 组：走全量池，不在此列
    { id: 'e1', kind: 'ephem', sats: [{ noradId: 80001 }, { noradId: '80002' }] },    // 被关联（数字存储）
    { id: 'e2', kind: 'ephem', sats: [{ noradId: '80101' }] },                        // 没人关联
    { id: 'e3', kind: 'ephem', sats: [{ noradId: '80201' }] },                        // 被关联但已载入
    { id: 'e4', kind: 'ephem', sats: [{ noradId: '80301' }] },                        // 只被仰角线「带着号」：不算
    { id: 'e5', kind: 'ephem' }                                                       // 没有 sats 字段：防御
  ]
  const nodes = [
    { folder: 'A', noradId: '80001', kind: 'linked' },
    { folder: 'B', noradId: 80201, kind: 'linked' },
    { folder: 'EL', noradId: '80301', kind: 'elevline' },
    { folder: 'C', noradId: '', kind: 'custom' },
    { folder: 'G', noradId: '25544', kind: 'linked' }
  ]
  const loaded = new Set(['e3'])
  const ids = ephGroupsToLoad(groups, nodes, (id) => loaded.has(id))
  ok(ids.join(',') === 'e1', '只挑被关联着且未载表的点序列组（号 String 比；gp / 已载 / 仰角线 / 无号不参与）', ids.join(','))
  ok(ephGroupsToLoad(groups, [], () => false).length === 0 && ephGroupsToLoad(null, nodes, null).length === 0, '空树 / 空清单 → []')
  ok(ephGroupsToLoad(groups, nodes).join(',') === 'e1,e3', '不给 loaded → 全部被关联的点序列组')
}

// ---------- ⑧ grdLive 的 noEph 一段 + 链路预算读回（grdParam） ----------
{
  const sats = [
    { folder: 'U1', noradId: '41838', kind: 'linked', lon: 115.4, lat: 0, altKm: 35786 },   // 关联星：此刻解得出
    { folder: 'U2', noradId: '99999', kind: 'linked', lon: 110.5, lat: 0, altKm: 35786 },   // 关联星：此刻解不出
    { folder: 'O1', noradId: null, elements: { altKm: 500 }, kind: 'orbit', lon: 1, lat: 2, altKm: 500 },
    { folder: 'F1', noradId: null, kind: 'custom', lon: 87.5, lat: 0, altKm: 35786 }         // 固定星：不写
  ]
  const livePos = (s) => (s.folder === 'U1' ? { lon: 115.523456, lat: 0.012345, altKm: 35785.97 } : s.folder === 'U2' ? null : s.folder === 'O1' ? { lon: 10, lat: 20, altKm: 500.04 } : { lon: s.lon, lat: s.lat, altKm: s.altKm })
  const pl = grdLivePayload(sats, livePos)
  ok(pl.pos.U1 && pl.pos.U1.lon === 115.5235 && pl.pos.U1.lat === 0.0123 && pl.pos.U1.altKm === 35786, '解得出的关联星写 pos（4 / 4 / 1 位小数）', JSON.stringify(pl.pos.U1))
  ok(!('U2' in pl.pos) && pl.noEph.length === 1 && pl.noEph[0] === 'U2', '解不出的关联星不写 pos、记进 noEph')
  ok(pl.pos.O1 && !('F1' in pl.pos) && !pl.noEph.includes('F1') && !pl.noEph.includes('O1'), '轨道根数星写 pos；固定星两段都不进')

  // 链路预算窗口读回：localStorage / window.api 桩必须先于模块求值装好
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)) }, removeItem: (k) => { mem.delete(k) } }
  let ipcCalls = 0
  globalThis.window = { api: { linkBudget: { grdSample: async ({ points }) => { ipcCalls++; return points.map(() => 51) } } } }
  const gp = await import('../../../src/linkbudget/grdParam.js')
  const ant = { name: 'A', imported: true, file: 'u.grd', beams: 1, satLon: 115.4, satLat: 0, satAlt: 35786 }
  mem.set('globe3d/settings', JSON.stringify({ grd: { sats: sats.slice(0, 2).map((s) => ({ ...s, satName: s.folder, antennas: [{ ...ant }] })), cfgs: {} } }))
  // 第一拍：两颗都解得出
  mem.set('globe3d/grdLive', JSON.stringify({ t: 1, pos: { U1: { lon: 115.52, lat: 0, altKm: 35786 }, U2: { lon: 110.52, lat: 0, altKm: 35786 } } }))
  const t1 = gp.loadSatTree()
  const u2a = t1.sats.find((s) => s.folder === 'U2')
  const fpLive = gp.grdFillBase(u2a, u2a.antennas[0], {})
  ok(u2a.live === true && !u2a.noEph && JSON.parse(fpLive).sat === 'live', '解得出：实时星、指纹记 live')
  // 第二拍：U2 解不出（3D 页写进 noEph）
  mem.set('globe3d/grdLive', JSON.stringify({ t: 2, pos: { U1: { lon: 115.52, lat: 0, altKm: 35786 } }, noEph: ['U2'] }))
  const t2 = gp.loadSatTree()
  const u2b = t2.sats.find((s) => s.folder === 'U2'), u1b = t2.sats.find((s) => s.folder === 'U1')
  const fpGone = gp.grdFillBase(u2b, u2b.antennas[0], {})
  ok(u2b.live === true && u2b.noEph === true, '解不出：仍是实时星（live）+ noEph')
  ok(fpGone === fpLive, '回填指纹不翻（与解得出时逐字相同）', fpGone)
  ok(u1b.live === true && !u1b.noEph, '别的星不受影响')
  ok(u2b.lon === 110.5 && u2b.antennas[0].satLon === 115.4, '显示回退到存储值（只作显示）')
  const c0 = ipcCalls
  const vals = await gp.sampleAntennaParams(u2b, u2b.antennas[0], {}, [{ lon: 110, lat: 30 }, { lon: 120, lat: 35 }])
  ok(vals.length === 2 && vals.every((v) => v === null) && ipcCalls === c0, '无星历：采样全 null、不发 IPC（不按存盘旧星位取值）')
  ok(gp.antennaSampleSpec(u2b, u2b.antennas[0], {}) === null && gp.antennaSampleSpec(u1b, u1b.antennas[0], {}) !== null, '无星历：地理图取值规格为 null；有星历的照常')
  const v1 = await gp.sampleAntennaParams(u1b, u1b.antennas[0], {}, [{ lon: 110, lat: 30 }])
  ok(v1[0] === 51 && ipcCalls === c0 + 1, '有星历的照常采样')
  // 手改值：指纹没变 → 不改写；刷新（force）也只动本会话自动写过的
  ok(gp.grdFillNeeded(fpLive, fpGone, '52.3', '46', false, '51.0') === false, '手改值（52.3）在星历丢失后不被判为要改写')
  ok(gp.grdFillNeeded(fpLive, fpGone, '52.3', '46', true, '51.0') === false, '刷新也不碰手改值')
  // 老格式（没有 noEph 段）：不在 pos 的星照旧当非实时（与改前一致）
  mem.set('globe3d/grdLive', JSON.stringify({ t: 3, pos: {} }))
  const t3 = gp.loadSatTree()
  const u2c = t3.sats.find((s) => s.folder === 'U2')
  ok(u2c.live === false && u2c.noEph === false, '没有 noEph 段的老缓存：行为不变')
  mem.set('globe3d/grdLive', '{坏 JSON')
  ok(gp.loadSatTree().sats.every((s) => s.live === false && s.noEph === false), '坏缓存不抛、当作都没有实时位置')

  // 旧 grdLive 条目只认【此刻仍是】关联 / 轨道根数星的节点（复现脚本 review2/staleNoEph.mjs）：
  // 唯一一颗关联星 F 解不出 → 3D 页写下 noEph:[F]；用户「取消关联」改成固定星 → 树里再没有实时星，persistGrdLive 早退、grdLive 不再重写。
  const plF = grdLivePayload([{ folder: 'F', noradId: '99999', satName: 'F', lon: 100.5, lat: 0, altKm: 35786 }], () => null)
  ok(plF.noEph.join() === 'F' && !Object.keys(plF.pos).length, '前提：解不出的唯一关联星写进 noEph')
  mem.set('globe3d/grdLive', JSON.stringify({ t: 4, ...plF }))
  const fixedF = { folder: 'F', kind: 'custom', noradId: null, elements: null, satName: 'F', lon: 100.5, lat: 0, altKm: 35786, antennas: [{ ...ant, satLon: 100.5 }] }
  mem.set('globe3d/settings', JSON.stringify({ grd: { sats: [fixedF], cfgs: {} } }))
  const nF = gp.loadSatTree().sats.find((s) => s.folder === 'F')
  ok(nF && nF.live === false && nF.noEph === false, '取消关联后的固定星：旧 noEph 不再把它判成「实时星此刻无星历」', nF && JSON.stringify({ live: nF.live, noEph: nF.noEph }))
  const cF = ipcCalls
  const vF = await gp.sampleAntennaParams(nF, nF.antennas[0], {}, [{ lon: 116, lat: 40 }])
  ok(vF[0] === 51 && ipcCalls === cF + 1 && gp.antennaSampleSpec(nF, nF.antennas[0], {}) !== null, '固定星照常采样（发 IPC、地理图规格非空）', `vals ${JSON.stringify(vF)}`)
  ok(JSON.parse(gp.grdFillBase(nF, nF.antennas[0], {})).sat.lon === 100.5, '指纹按固定星位（不是 live）')
  // 同一份旧 grdLive 里还有 pos：同名 folder 的固定星不被旧星位顶掉（HEAD 就有的老问题）
  mem.set('globe3d/grdLive', JSON.stringify({ t: 5, pos: { F: { lon: 120.25, lat: 1.5, altKm: 35786 } } }))
  const nF2 = gp.loadSatTree().sats.find((s) => s.folder === 'F')
  ok(nF2.live === false && nF2.lon === 100.5 && nF2.antennas[0].satLon === 100.5, '固定星：旧 pos 不覆盖存储星位', `lon ${nF2.lon}`)
  // 仍是关联星的照旧：noEph 生效（改动不碰原意）
  mem.set('globe3d/grdLive', JSON.stringify({ t: 6, ...plF }))
  mem.set('globe3d/settings', JSON.stringify({ grd: { sats: [{ ...fixedF, kind: 'linked', noradId: '99999' }], cfgs: {} } }))
  const nL = gp.loadSatTree().sats.find((s) => s.folder === 'F')
  ok(nL.live === true && nL.noEph === true, '仍关联着的星：noEph 照旧生效')
  // 轨道根数星：pos 照旧覆盖；noEph 只认关联星（轨道根数星不会进 noEph，进了也不认）
  const orbF = { ...fixedF, kind: 'orbit', elements: { altKm: 500, ecc: 0, incl: 53 } }
  mem.set('globe3d/settings', JSON.stringify({ grd: { sats: [orbF], cfgs: {} } }))
  mem.set('globe3d/grdLive', JSON.stringify({ t: 7, pos: { F: { lon: 10, lat: 20, altKm: 500 } } }))
  const nO = gp.loadSatTree().sats.find((s) => s.folder === 'F')
  ok(nO.live === true && nO.lon === 10 && nO.antennas[0].satLon === 10 && nO.noEph === false, '轨道根数星：实时 pos 照旧覆盖')
  mem.set('globe3d/grdLive', JSON.stringify({ t: 8, pos: {}, noEph: ['F'] }))
  const nO2 = gp.loadSatTree().sats.find((s) => s.folder === 'F')
  ok(nO2.noEph === false && nO2.live === false, '轨道根数星：不认 noEph')
}

// ---------- ⑪ grdLive 写入节流（createLiveThrottle）----------
{
  const g = createLiveThrottle(3000)
  ok(g.pass(1000) === true, '第一次恒放行')
  ok(g.pass(2500) === false && g.pass(3999) === false, '3 s 内不放行')
  ok(g.pass(4000) === true, '满 3 s 放行')
  g.due()
  ok(g.pending() === true && g.pass(4100) === true && g.pending() === false, 'due 之后下一次无条件放行、放行即消费')
  ok(g.pass(4200) === false, '消费后回到节流（从放行那一刻重新计）')
  ok(g.pass(7100) === true, '从 due 放行那一刻起满 3 s 放行')

  // 复现 review2/throttle_sim.mjs：暂停档启动；关联 GEO 星不在可见集；池两段（本机缓存 / 当日缓存）都在首写后 3 s 内到齐
  const sats = [{ folder: 'ZX6E', noradId: '41194', lon: 115.5, lat: 0, altKm: 35786 }]
  let poolReady = false, store = null
  const livePos = () => (poolReady ? { lon: 115.49, lat: 0.02, altKm: 35786 } : null)   // 池前 liveEntryOf → null
  const gate = createLiveThrottle(3000)
  const persist = (now) => { if (!gate.pass(now)) return false; store = { t: now, ...grdLivePayload(sats, livePos) }; return true }   // 页面 persistGrdLive 同口径
  const relink = (now) => { gate.due(); const w = persist(now); if (gate.pending()) persist(now); return w }                       // 页面 relinkTick 同口径
  const T = 1_000_000
  ok(persist(T) === true && store.noEph.join() === 'ZX6E', 'T0 首个可见集载入：池前解不出 → noEph')
  poolReady = true
  ok(persist(T + 400) === false, '对照：普通一拍仍被节流（改前 relinkTick 就是这样被吞的）')
  ok(relink(T + 400) === true && store.pos.ZX6E && !store.noEph.length, '池第一段 relinkTick：不受节流，写 pos、清 noEph', JSON.stringify(store))
  ok(relink(T + 900) === true && store.t === T + 900, '池第二段 relinkTick：同样落盘')
  // 渲染集为空（refreshPositions 早退、不经写入点）：relinkTick 靠 pending 补写
  const gate2 = createLiveThrottle(3000)
  let wrote = 0
  gate2.pass(T); gate2.due()
  if (gate2.pending() && gate2.pass(T + 300)) wrote++
  ok(wrote === 1 && gate2.pending() === false, '早退分支：pending 补写一次')

  // 链路预算窗口读回：不再是「无星历」，照常取值
  const gp = await import('../../../src/linkbudget/grdParam.js')
  globalThis.localStorage.setItem('globe3d/settings', JSON.stringify({ grd: { sats: [{ ...sats[0], kind: 'linked', satName: 'ZX6E', antennas: [{ name: 'A', imported: true, file: 'z.grd', beams: 1, satLon: 115.5, satLat: 0, satAlt: 35786 }] }], cfgs: {} } }))
  globalThis.localStorage.setItem('globe3d/grdLive', JSON.stringify(store))
  const n = gp.loadSatTree().sats.find((s) => s.folder === 'ZX6E')
  const v = await gp.sampleAntennaParams(n, n.antennas[0], {}, [{ lon: 116, lat: 40 }])
  ok(n.live === true && n.noEph === false && n.lon === 115.49 && v[0] === 51, '链路预算：实时星位、照常采样', JSON.stringify({ noEph: n.noEph, lon: n.lon, v }))

  // 页面接线（Node 里挂不起 .vue → 按源码钉）：relinkTick 先 due 再 refreshPositions、再按 pending 补写；persistGrdLive 走这道闸
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (sig) => { const i = page.indexOf(sig), j = page.indexOf('\n}\n', i); return i >= 0 && j > i ? page.slice(i, j) : '' }
  const rt = body('function relinkTick() {')
  const iDue = rt.indexOf('_grdLiveGate.due()'), iRef = rt.indexOf('refreshPositions()'), iPend = rt.indexOf('if (_grdLiveGate.pending()) persistGrdLive()')
  ok(iDue > 0 && iRef > iDue && iPend > iRef, 'relinkTick：due → refreshPositions → pending 补写')
  const pg = body('function persistGrdLive() {')
  ok(pg.includes('_grdLiveGate.pass(') && !/_grdLiveT\b/.test(pg), 'persistGrdLive：节流走 _grdLiveGate（不再自己比 3 s）')
}

// ---------- ⑫ 树聚焦的过期判据（focusStale）----------
{
  ok(focusStale(null, 5, 7) === false && focusStale(undefined, 5, 7) === false && focusStale({}, 5, 7) === false && focusStale({ tick: null, fseq: null }, 5, 7) === false, '没给 guard / 缺项 → 不判（即时聚焦恒放行）')
  ok(focusStale({ tick: 5, fseq: 7 }, 5, 7) === false, '期间没人动 → 放行')
  ok(focusStale({ tick: 5, fseq: 7 }, 6, 7) === true, '期间用户另选了星（_userSelTick 变了）→ 作废')
  ok(focusStale({ tick: 5, fseq: 7 }, 5, 8) === true, '期间树上又点了别的（_focusSeq 变了）→ 作废')
  ok(focusStale({ tick: 0, fseq: 0 }, 0, 0) === false && focusStale({ tick: 0 }, 1, 0) === true, '0 是合法值（不当缺项）')

  // 页面接线（按源码钉）：focusTreeSat 进门判 guard（在 ++_focusSeq 之前）；createGaussFor 进门捕获 / 收尾带 guard 聚焦；
  // ctxNewGauss / antAddPick 在 ensureLinkedFolder 之前捕获并传入；expFocus / startFollow 换主选算用户改选
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (sig) => { const i = page.indexOf(sig), j = page.indexOf('\n}\n', i); return i >= 0 && j > i ? page.slice(i, j) : '' }
  const ft = body('async function focusTreeSat(node, {')
  ok(/tick = null, fseq = null/.test(ft) && ft.indexOf('focusStale({ tick, fseq }, _userSelTick, _focusSeq)') > 0 && ft.indexOf('focusStale({ tick, fseq }') < ft.indexOf('++_focusSeq'), 'focusTreeSat：guard 在自增聚焦序号之前判')
  const cg = body('async function createGaussFor(node, guard) {')
  const iCap = cg.indexOf('const g = guard || { tick: _userSelTick, fseq: _focusSeq }'), iWait = cg.indexOf('await awaitLinkEph()')
  ok(iCap > 0 && iWait > iCap && cg.includes('focusTreeSat(node, { tick: g.tick, fseq: g.fseq })'), 'createGaussFor：等星历源之前捕获、收尾带 guard 聚焦')
  for (const [sig, call] of [['async function ctxNewGauss() {', 'createGaussFor(r.node, g)'], ['async function antAddPick(kind) {', 'createGaussFor(node, g)']]) {
    const b = body(sig)
    const iG = b.indexOf('const g = { tick: _userSelTick, fseq: _focusSeq }'), iE = b.indexOf('await ensureLinkedFolder(')
    ok(iG > 0 && iE > iG && b.includes(call), `${/function (\w+)/.exec(sig)[1]}：ensureLinkedFolder 之前捕获并传给 createGaussFor`)
  }
  const ef = body('async function expFocus(sats, label, tagOverride) {')
  ok(ef.indexOf('_userSelTick++') > ef.indexOf('await expResolve(') && ef.indexOf('_userSelTick++') < ef.indexOf('selEntries = hit'), 'expFocus：解析完、落选中之前 _userSelTick++')
  const sf = body('function startFollow(e) {')
  ok(/if \(selEntries\.includes\(e\)\) \{ _userSelTick\+\+; selEntry = e;/.test(sf), 'startFollow：已在选中集里换主选也算用户改选')
}

// ---------- ⑨ 波束合成跟随的放行闸（createFollowGate）----------
//   只认用户换 / 点名主选：启动恢复选中、星座重绑、向导预览（system）不放行；主选没变的刷新不放行；点名同一颗放行。
{
  const g = createFollowGate()
  ok(g('41838', { system: true }) === false, '启动恢复选中（程序性、主选从无到 41838）→ 不放行，openFor 恢复的组不被冲掉')
  ok(g('41838') === false, 'Ctrl 移出一颗非主选 / 历元重绑（主选没变）→ 不放行')
  ok(g(41838) === false, '数字号与字符串号同一身份：主选没变')
  ok(g('41838', { picked: true }) === true, '用户再点一次同一颗主选（导航器被手动挪走过）→ 放行')
  ok(g('25544') === true, '用户换了主选 → 放行')
  ok(g('43013', { system: true }) === false && g('43013') === false, '程序性刷新换了主选 → 不放行，且之后同主选的刷新也不算「换了」')
  ok(g('43013', { system: true, picked: true }) === false, '程序在用户点名之后又刷了一版（向导种子星走 selectSat）→ 以 system 为准')
  ok(g('') === true && followFolder([{ folder: 'A', noradId: '43013' }], '', 'A') === null, '主选清空算换了，但无主选 followFolder 不给目标')
  const g2 = createFollowGate()
  ok(g2('41838') === true, '各闸独立（新闸第一次见到主选 → 放行）')
}

// ---------- ⑩ 波束合成产物的归属是否在世（synthGroupDrives / synthOwned）----------
//   组删了 / 天线从别的工作区带来 → 死 owner，当作无主（覆盖分析侧可改）；组在世但已不驱动这根（产物名对不上）→ 同样可改。
{
  const keyOf = (f, n) => f + '|' + n
  const groups = [{ id: 'g1', satFolder: 'SAT', _genName: '高斯波束' }, { id: 'g2', satFolder: 'SAT' }, { id: 'g3', satFolder: 'SAT·2', _genName: '高斯波束' }]
  ok(synthGroupDrives(groups, 'g1', 'SAT|高斯波束', keyOf) === true, '组在世、产物名就是这根 → 驱动着')
  ok(synthGroupDrives(groups, 'g1', 'SAT|Ku点波束', keyOf) === false, '组在世但产物名对不上（天线被改名 / 组已产出别的）→ 不驱动')
  ok(synthGroupDrives(groups, 'g3', 'SAT|高斯波束', keyOf) === false, '同名天线在别的卫星下 → 不驱动（按 folder|名 比）')
  ok(synthGroupDrives(groups, 'g2', 'SAT|任意', keyOf) === true, '老组没记产物名 → 只看组在不在')
  ok(synthGroupDrives(groups, 'gone', 'SAT|高斯波束', keyOf) === false && synthGroupDrives(groups, '', 'SAT|高斯波束', keyOf) === false, '组不存在 / 无组号 → 不驱动')
  ok(synthGroupDrives(null, 'g1', 'SAT|高斯波束', keyOf) === false, '组表缺失 → 不驱动')
  const alive = (id, key) => synthGroupDrives(groups, id, key, keyOf)
  const owned = { owner: { kind: 'beamsynth', groupId: 'g1' } }
  ok(synthOwned(owned, 'SAT|高斯波束', alive) === true, '在世组的产物 → 只读')
  ok(synthOwned({ owner: null }, 'SAT|高斯波束', alive) === false && synthOwned(null, 'k', alive) === false && synthOwned({ owner: { kind: 'other', groupId: 'g1' } }, 'SAT|高斯波束', alive) === false, '无 owner / 空记录 / 别的 owner 种类 → 不只读')
  ok(synthOwned(owned, 'SAT|高斯波束') === true, '宿主没给判据 → 保守按在世（只读）')
  let seen = null
  synthOwned(owned, 'SAT|高斯波束', (id, key) => { seen = [id, key]; return true })
  ok(seen && seen[0] === 'g1' && seen[1] === 'SAT|高斯波束', '判据收到 (groupId, key)')
  groups.splice(0, 1)                                                         // 删组（removeGroup 不动已生成的天线）
  ok(synthOwned(owned, 'SAT|高斯波束', alive) === false, '删了组 → 死 owner，可改')

  // 死 owner 的多设置天线就地改：逐模型 recordWithModel、owner 抹成 null；波束视轴 / 身份原样，逐波束量按各自新模型重算
  const mA = { id: 'mA', name: 'A', ...freshModel() }, mB = { id: 'mB', name: 'B', ...freshModel({ drv: 'bw', bw3: 3 }) }
  const rec = buildRecord({ sat: { name: 'SAT', lon: 0, lat: 0, altKm: 35786 }, models: [mA, mB], beams: [{ name: '1', az: 0.5, el: 0, model: 'mA' }, { name: '2', az: -0.5, el: 0.2, model: 'mB' }], owner: { kind: 'beamsynth', groupId: 'gone' } })
  let rec2 = { ...rec, owner: null }
  const drafts = [{ ...mA, drv: 'G', G: 45 }, { ...mB, bw3: 2 }]
  drafts.forEach((d, i) => { rec2 = recordWithModel(rec2, i, d) })
  ok(rec2.owner === null && rec.owner.groupId === 'gone', '改动落盘时死 owner 抹掉（入参记录不动）')
  ok(Math.abs(rec2.beams[0].g0 - 45) < 1e-12 && Math.abs(rec2.beams[1].th3 - 2) < 1e-12, '两个模型各自生效（波束 1 → 45 dBi，波束 2 → 2°）', `g0 ${rec2.beams[0].g0} th3 ${rec2.beams[1].th3}`)
  ok(rec2.beams[0].az === 0.5 && rec2.beams[1].el === 0.2 && rec2.models.map((m) => m.id).join() === 'mA,mB', '视轴 / 模型身份原样')
}

// ---------- ⑬ 树卫星行「聚焦 / 跟随」两钮（treeNavState）----------
{
  const L = { folder: 'ZX6E', noradId: 41194 }                       // 关联星（号存成数字）
  const F = { folder: 'MY-GEO', lon: 125, lat: 0, altKm: 35786 }     // 固定星
  const O = { folder: 'SIM', elements: { a: 7000 } }                 // 轨道根数模拟星
  const E = { folder: 'EL', kind: 'elevline', noradId: '41194' }     // 仰角线：号也不认

  let s = treeNavState(L, { cur: true })
  ok(s.focusOn && !s.focusDis && s.focusTip === '聚焦卫星（Ctrl 点＝加入 / 移出聚焦集）', '关联星在聚焦集里：聚焦钮亮、可点')
  ok(!s.followOn && !s.followDis && s.followTip === '跟随卫星', '关联星、3D、没在跟随：跟随钮可点')
  s = treeNavState(L, { cur: false })
  ok(!s.focusOn && !s.focusDis, '关联星不在聚焦集：聚焦钮不亮、可点')
  s = treeNavState(L, { followId: '41194' })
  ok(s.followOn && !s.followDis && s.followTip === '退出跟随（Esc）', '正跟随它（号字符串 / 数字混存同一身份）：跟随钮亮，点＝退出')
  ok(!treeNavState(L, { followId: '25544' }).followOn, '跟随的是别的星：不亮')
  s = treeNavState(L, { flat: true })
  ok(s.followDis && s.followTip === '跟随卫星（仅 3D 球体）' && !s.focusDis, '平面图：跟随置灰（聚焦照常）')
  ok(!treeNavState(L, { flat: true, followId: '41194' }).followDis, '正跟随着的不灰（留退出的口）')
  s = treeNavState(L, { miss: true, cur: false })
  ok(s.focusDis && s.followDis && s.focusTip === '关联卫星 NORAD 41194 不在当前星历中' && s.followTip === s.focusTip, '关联星不在当前星历：两钮置灰，说明同告警')
  for (const [n, what] of [[F, '固定星'], [O, '轨道根数星']]) {
    const t = treeNavState(n, { cur: true, miss: true })
    ok(!t.focusOn && !t.focusDis && t.focusTip === '转到该卫星（该星不在星座中）', `${what}：聚焦＝只转过去，恒不亮、不因 miss 置灰`)
    ok(!t.followOn && t.followDis && t.followTip === '跟随卫星（该星不在星座中）', `${what}：跟随置灰`)
  }
  ok(!treeNavState(E, { cur: true, followId: '41194' }).focusOn && !treeNavState(E, { followId: '41194' }).followOn, '仰角线节点：不认号，不亮')
  ok(treeNavState({ folder: 'X', noradId: '' }).followDis && !treeNavState(null).followOn, '空号 / 空节点：按非关联处理、不抛')

  // 天线树定点同步星：节点没有号，星座条目用合成号（geoIds：folder → 号串）—— 与关联星同样可聚焦 / 跟随
  const G = { folder: 'MY-GEO', kind: 'custom', lon: 125, lat: 0, altKm: 35786, noradId: null }
  const geoIds = new Map([['MY-GEO', '1712966']])
  ok(nodeLinkId(G, geoIds) === '1712966' && nodeLinkId(G) === '' && nodeLinkId(L, geoIds) === '41194' && nodeLinkId(E, new Map([['EL', '1']])) === '', 'nodeLinkId：关联星给号、定点同步星给合成号、没映射 / 仰角线给空')
  s = treeNavState(G, { cur: true, linkId: nodeLinkId(G, geoIds) })
  ok(s.focusOn && !s.focusDis && s.focusTip === '聚焦卫星（Ctrl 点＝加入 / 移出聚焦集）' && !s.followDis && s.followTip === '跟随卫星', '定点同步星（给了 linkId）：聚焦亮、跟随可点')
  ok(treeNavState(G, { followId: '1712966', linkId: '1712966' }).followOn, '正跟随它（按合成号）→ 亮')
  ok(treeNavState(G, { linkId: '' }).followDis, 'linkId 显式给空（非同步定点星）→ 跟随置灰')
  const tree = [L, G, { folder: 'LEO-FIX', kind: 'custom', altKm: 550, noradId: null }]
  ok([...foldersForNorads(tree, ['1712966', '41194'], geoIds)].sort().join() === 'MY-GEO,ZX6E' && foldersForNorads(tree, ['1712966']).size === 0, 'foldersForNorads：带映射认合成号（不带映射照旧只认真号）')
  ok(linkedNodesOf(tree, 1712966, geoIds).map((n) => n.folder).join() === 'MY-GEO' && linkedNodesOf(tree, '1712966').length === 0, 'linkedNodesOf：合成号 → 它自己那一个节点')
  ok(followFolder(tree, '1712966', 'ZX6E', geoIds) === 'MY-GEO' && followFolder(tree, '1712966', 'MY-GEO', geoIds) === null, 'followFolder：主选是定点同步星 → 波束合成切到它的 folder；已在就不动')

  // 说明文字都进了 UI 词典（英文界面不漏翻）：EXACT 整串 / PAT 槽位模板
  const patHit = (str) => UI_PAT.some(([zh]) => new RegExp('^' + zh.split(/\$\{[^}]*\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*?') + '$').test(str))
  const tips = new Set()
  for (const n of [L, F]) for (const ctx of [{}, { cur: true }, { followId: '41194' }, { flat: true }, { miss: true }]) { const t = treeNavState(n, ctx); tips.add(t.focusTip); tips.add(t.followTip) }
  const lost = [...tips].filter((t) => !UI_EXACT[t] && !patHit(t))
  ok(tips.size === 7 && !lost.length, '七条说明全在 UI 词典里', lost.join(' | '))

  // 页面接线（按源码钉）
  const page = readFileSync(new URL('../../../src/pages/ConstellationMap3D.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const panel = readFileSync(new URL('../../../src/components/SatCovPanel.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = (src, sig) => { const i = src.indexOf(sig), j = src.indexOf('\n}\n', i); return i >= 0 && j > i ? src.slice(i, j) : '' }
  const ft = body(page, 'async function focusTreeSat(node, {')
  const iAdd = ft.indexOf('if (additive) { selectSat(had || e, !had, true)'), iHad = ft.indexOf('if (had) {')
  ok(/additive = false/.test(ft) && iAdd > 0 && iHad > iAdd, 'focusTreeSat：Ctrl 点按号认已选那份，先于「已选中＝设主选」分支')
  ok((ft.match(/if \(force\) stopFollow\(\)/g) || []).length === 2, 'focusTreeSat：显式聚焦（已选中的那颗 / 非关联星）先退出跟随')
  const fl = body(page, 'async function followTreeSat(node) {')
  ok(fl.includes('if (followLinkId.value === id) { stopFollow(); return }') && fl.includes('startFollow(e)') && fl.indexOf('selEntries.find(') > 0, 'followTreeSat：正跟随它＝退出；否则按号认已选那份再 startFollow（追加式）')
  ok(page.includes('@click.stop="onTreeFocusBtn(sat, $event)"') && page.includes('@click.stop="onTreeFollowBtn(sat)"'), '对地树卫星行：两钮接上')
  ok(page.includes(':follow-id="followLinkId" :flat="flatView"') && page.includes('@focus-sat="(n, f, add) => focusTreeSat(n, { force: f, additive: !!add })" @follow-sat="followTreeSat"'), '对星树：宿主传跟随状态与平面图、接两路事件')
  ok(panel.includes('@click.stop="onFocusBtn(sat, $event)"') && panel.includes('@click.stop="onFollowBtn(sat)"') && panel.includes("'follow-sat'"), '对星树卫星行：两钮接上')
}

console.log(`\n${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
