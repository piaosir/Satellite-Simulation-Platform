// 端到端链路：链描述子组装（src/e2e/e2eParams.js）自测。
// 运行：node packages/core/test/e2eChainParams.test.mjs
//
// 盯住「体制下放到节点」之后的三条口径：
//   · 载波体制不再是库条目，它落在【段起点节点】上（链首那份还定义这条业务的信息速率）；
//   · 下游段没自己那份就整套照抄链首（＝和第一跳一致）；
//   · ★ 信息速率全程守恒：各段一律取链首那份，段与段之间只换 MODCOD / 滚降 / 帧效率。
// 引擎侧（门限/带宽/BER 怎么跟着变）在 linkChain.test.js 里钉。

import {
  buildChain, chainInfoRate, defaultCarrier, newEsNode, newSatNode, newHop, intfKeysFor,
  thresholdCNOf, thresholdEffLive,
  gsoLookAngles, suggestIslRangeKm, orbitAltKmOf, serializeChainsState
} from '../../../src/e2e/e2eParams.js'
// 门限那一节要与引擎对表：渲染端算的门限 C/N 必须与 computeLinkChain 出的同一个数
import { createRequire } from 'node:module'
import path from 'node:path'
import url from 'node:url'
const _require = createRequire(import.meta.url)
const { computeLinkChain } = _require(path.join(
  path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..'), 'packages/core/utils/linkChain.js'))

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// —— 两库解析桩（体制已无库）——
const ES = { id: 'es1', name: '站', form: { antennaDiameter: '9', antennaEfficiency: '65', opPowerW: '120', feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', rxAntennaEfficiency: '65', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2' } }
const SAT = { id: 'sat1', name: '星', form: { satelliteName: '星', frequencyBand: 'Ku', gt: '2', eirpSat: '46', eirp: '28', sfdRef: '-84', sfdGtRef: '0', BOi: '6', BOo: '3', transponderBandwidth: '36' } }
const RESOLVE = { es: () => ES, sat: () => SAT }

// 站 → 再生星 → 站（两段）；体制落在链首与再生星上
function mkRow() {
  const a = newEsNode('发'), r = newSatNode('regen', '再生星'), b = newEsNode('收')
  const h1 = newHop('rf'), h2 = newHop('rf')
  h1.slantRange = '39500'; h1.elevation = '25'
  h2.slantRange = '38800'; h2.elevation = '32'
  a.carrier = { ...defaultCarrier(), infoRate: '2048', modulation: 'QPSK', fec: '3/4' }
  return { _id: 'c1', name: '', nameAuto: true, nodes: [a, r, b], hops: [h1, h2] }
}

// ① 下游段没自己那份 ⇒ 整套照抄链首
{
  const row = mkRow()
  const chain = buildChain(row, RESOLVE)
  ok('两段都算得出体制', chain.carriers.length === 2)
  ok('★ 下游段默认和第一跳一致', chain.carriers[1].modulation === 'QPSK' && chain.carriers[1].fec === '3/4' &&
    chain.carriers[1].infoRate === '2048', JSON.stringify(chain.carriers[1].modulation))
  ok('链级体制回显＝链首那份（老字段 carrier 仍在，引擎缺省回落用）', chain.carrier.modulation === 'QPSK')
}

// ② 下游段自己换 MODCOD：只换调制/码率，速率不跟着走
{
  const row = mkRow()
  row.nodes[1].carrier = { ...defaultCarrier(), infoRate: '9999', modulation: '8PSK', fec: '2/3' }
  const chain = buildChain(row, RESOLVE)
  ok('段 1 仍是链首那份', chain.carriers[0].modulation === 'QPSK' && chain.carriers[0].fec === '3/4')
  ok('★ 段 2 换成 8PSK 2/3', chain.carriers[1].modulation === '8PSK' && chain.carriers[1].fec === '2/3')
  ok('★ 信息速率全程守恒：节点上写的 9999 不算数，一律取链首那份',
    chain.carriers[0].infoRate === '2048' && chain.carriers[1].infoRate === '2048',
    chain.carriers.map((c) => c.infoRate).join('/'))
}

// ③ 链首那份缺项回落出厂默认（不让某一格为空把引擎带偏）
{
  const row = mkRow()
  row.nodes[0].carrier = { infoRate: '4096' }
  const chain = buildChain(row, RESOLVE)
  ok('缺项回落默认', chain.carriers[0].modulation === defaultCarrier().modulation && chain.carriers[0].fec === defaultCarrier().fec)
  ok('给了的那项照用', chain.carriers[0].infoRate === '4096')
  ok('chainInfoRate 读的就是链首那份', chainInfoRate(row) === 4096, String(chainInfoRate(row)))
}

// ④ 链首完全没有 carrier（新建/迁移途中）：整条链走出厂默认，不报错
{
  const row = mkRow()
  delete row.nodes[0].carrier
  const chain = buildChain(row, RESOLVE)
  ok('链首无体制 ⇒ 整链回落默认，仍算得出', chain.carriers.length === 2 && chain.carriers[0].infoRate === defaultCarrier().infoRate)
  ok('chainInfoRate 此时返回 null（读数区报「—」）', chainInfoRate(row) === null)
}

// ⑤ 解调实现损失随节点进链描述子（引擎按段末节点取）
{
  const row = mkRow()
  row.nodes[1].demodLossDb = '0.8'; row.nodes[2].demodLossDb = '1.2'
  const chain = buildChain(row, RESOLVE)
  ok('解调实现损失落到各自节点上', chain.nodes[1].demodLossDb === '0.8' && chain.nodes[2].demodLossDb === '1.2',
    chain.nodes.map((n) => n.demodLossDb).join('/'))
}

// ⑥ 全角数字归一（从别处粘来的串）
{
  const row = mkRow()
  row.nodes[0].carrier.infoRate = '４０９６'
  ok('全角速率归一到半角', buildChain(row, RESOLVE).carriers[0].infoRate === '4096', buildChain(row, RESOLVE).carriers[0].infoRate)
}

// ⑦ 功放功率的节点级覆盖：空＝跟随库，填了＝节点优先（发信站快调段起点电平）
{
  const row = mkRow()
  ok('未覆盖 ⇒ 跟随库条目', buildChain(row, RESOLVE).nodes[0].powerW === '120')
  row.nodes[0].opPowerW = '60'
  ok('★ 节点覆盖优先', buildChain(row, RESOLVE).nodes[0].powerW === '60')
  row.nodes[0].opPowerW = ''
  ok('清空回落库条目', buildChain(row, RESOLVE).nodes[0].powerW === '120')
}

// ⑧ GSO 真实指向几何（站址 + 定点经度 ⇒ 仰角与斜距都定了）
{
  // 北京（116.4074°E, 39.9042°N）看 110.5°E：工程常识区间——仰角 40°±3、斜距 37500±500 km
  const g = gsoLookAngles(116.4074, 39.9042, 0, 110.5)
  ok('北京→110.5°E 可见且量级正确', !!g && g.elevDeg > 36 && g.elevDeg < 44 && g.slantKm > 37000 && g.slantKm < 38200,
    g && `${g.slantKm.toFixed(1)} km / ${g.elevDeg.toFixed(2)}°`)
  // 星下点正对（0°N, 110.5°E 看 110.5°E）：仰角 90°、斜距＝轨道高度
  const sub = gsoLookAngles(110.5, 0, 0, 110.5)
  ok('星下点仰角 90°、斜距≈35786 km', !!sub && Math.abs(sub.elevDeg - 90) < 0.2 && Math.abs(sub.slantKm - 35786) < 30,
    sub && `${sub.slantKm.toFixed(1)} km / ${sub.elevDeg.toFixed(2)}°`)
  ok('高纬（82°N）不可见 ⇒ null（不编数）', gsoLookAngles(110.5, 82, 0, 110.5) === null)
  ok('经度差过大（对面 290.5→110.5 差 180°）⇒ null', gsoLookAngles(-69.5, 0, 0, 110.5) === null)
}

// ⑨ 星间距离建议值
{
  const gso = (lon) => ({ type: 'snapshot', lonDeg: lon, latDeg: 0, altKm: 35786 })
  // 双 GSO：Δlon 弦长 d = 2r·sin(Δ/2)，r = 42164.137
  const d10 = suggestIslRangeKm(gso(110.5), gso(120.5))
  const exp10 = 2 * 42164.137 * Math.sin(5 * Math.PI / 180)
  ok('★ 双 GSO＝定点经度弦长', d10 !== null && Math.abs(d10 - exp10) < 1, `${d10 && d10.toFixed(1)} vs ${exp10.toFixed(1)}`)
  ok('同一定点 ⇒ null（共位没有诚实的建议值）', suggestIslRangeKm(gso(110.5), gso(110.5)) === null)
  // NGSO：擦临边最大互视距离 √((R+h)²−R²) 两端相加
  const leo = { type: 'circular', altKm: 1200, inclDeg: 53 }
  const dLeo = suggestIslRangeKm(leo, leo)
  const expLeo = 2 * Math.sqrt(Math.pow(6378.137 + 1200, 2) - 6378.137 * 6378.137)
  ok('★ NGSO＝擦临边最大互视距离', dLeo !== null && Math.abs(dLeo - expLeo) < 1, `${dLeo && dLeo.toFixed(1)} vs ${expLeo.toFixed(1)}`)
  // GSO + NGSO 混合：同式（LEO 擦临边看 GEO 的最大斜距）
  const dMix = suggestIslRangeKm(gso(110.5), leo)
  ok('GSO+NGSO 混合可给建议值', dMix > 40000 && dMix < 50000, dMix && dMix.toFixed(0))
  ok('缺轨道 ⇒ null', suggestIslRangeKm(null, leo) === null)
  // orbitAltKmOf：omm 由平均运动反推（GEO ≈ 1.0027 圈/天 → ~35786 km）
  const altOmm = orbitAltKmOf({ type: 'omm', meanMotion: 1.0027 })
  ok('omm 平均运动反推高度', altOmm > 35000 && altOmm < 36500, altOmm && altOmm.toFixed(0))
}

// ⑩ 场景序列化必须是【纯数据】——它要过 IPC 的结构化克隆
// 修的账：serializeState 早先只剥一层 _id 的浅拷，而本窗口的节点上挂着两个嵌套对象
// （链首/段起点的 carrier、卫星节点的 ov）。浅拷把嵌套那层原样带出去，在 Vue 里那层是响应式
// Proxy —— ipcRenderer.invoke 当场抛 DataCloneError，两个调用点都没 catch，于是
//   · 点「保存」没反应（既没落盘也没提示）；
//   · 关窗时在「是否保存」里点保存，guardedLeave 整条 reject，confirmClose 永远轮不到 ⇒ 窗口不关。
// 故这里拿【真的 reactive】喂进去，钉死出参能过 structuredClone。
{
  const { reactive } = await import('vue')
  const row = mkRow()
  row.nodes[1].ov = { gt: '3.5' }                   // 卫星节点的行内覆盖（嵌套对象之二）
  const chains = reactive([row])                     // ★ 与窗口里 chains = reactive([...]) 同构
  const st = serializeChainsState(chains, 'manual')

  ok('序列化出参结构完整（链/节点/跳都在）',
    Array.isArray(st.chains) && st.chains.length === 1 &&
    st.chains[0].nodes.length === 3 && st.chains[0].hops.length === 2,
    JSON.stringify([st.chains.length, st.chains[0].nodes.length, st.chains[0].hops.length]))
  ok('嵌套的 carrier / ov 原样带出（不是被丢掉换来的"纯"）',
    st.chains[0].nodes[0].carrier.modulation === 'QPSK' && st.chains[0].nodes[1].ov.gt === '3.5',
    JSON.stringify([st.chains[0].nodes[0].carrier.modulation, st.chains[0].nodes[1].ov.gt]))
  ok('_id 一律剥掉（行内 id 不入场景）',
    st.chains[0].nodes.every((n) => n._id === undefined) && st.chains[0].hops.every((h) => h._id === undefined))
  // 这一条就是「保存按钮没反应」的直接判据：过不了克隆 = 存不进去
  let cloneErr = null
  try { structuredClone(st) } catch (e) { cloneErr = e }
  ok('★ 出参能过结构化克隆（＝能过 IPC；响应式 Proxy 一个都没漏出去）', cloneErr === null,
    cloneErr ? (cloneErr.name + ': ' + cloneErr.message) : 'clone OK')
  // 反证：同样的链做浅拷（老写法）必然带出 Proxy、必然克隆失败——不然这条测试是空转的
  const shallow = {
    chains: chains.map((c) => ({
      nodes: c.nodes.map((o) => { const r = {}; for (const k of Object.keys(o)) if (k !== '_id') r[k] = o[k]; return r })
    }))
  }
  let shallowErr = null
  try { structuredClone(shallow) } catch (e) { shallowErr = e }
  ok('★ 反证：浅拷（老写法）确实克隆失败 —— 这条测试不是空转', shallowErr !== null,
    shallowErr ? (shallowErr.name + ': ' + shallowErr.message) : '（居然过了，说明本测试失去意义）')
  // 非响应式输入（新建空白配置那条路）照样正常
  ok('非响应式输入同样出纯数据', (() => {
    const s2 = serializeChainsState([mkRow()], 'auto')
    try { structuredClone(s2) } catch (e) { return false }
    return s2.geoMode === 'auto' && s2.orbitType === 'E2E' && s2.v === 1
  })())
}

// ============================================================
// 干扰项按位置取舍（检查器只显示【这颗星在这个位置上真正入账】的那几项）。
// 判据必须与引擎逐条对齐（utils/linkChain.js §干扰口径）——多显示一项，用户就会去调一个
// 不进任何算式的数；少显示一项，真正在算的那一路就没有入口。
{
  const es = () => newEsNode('站')
  const sat = (kind) => newSatNode(kind, kind === 'regen' ? '再生星' : '透明星')
  const rf = () => newHop('rf')
  const laser = () => newHop('laser')
  const UP = ['aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor']
  const DN = ['aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor', 'xpdrIntermodFactor']
  const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i])
  const at = (nodes, hops, i) => intfKeysFor(nodes, hops, i)

  // 站 → 透明星 → 站：经典单星弯管，八项全生效
  {
    const nodes = [es(), sat('txp'), es()], hops = [rf(), rf()]
    ok('★ 站→透明星→站：上行四项 + 下行四项全生效', same(at(nodes, hops, 1), [...UP, ...DN]),
      at(nodes, hops, 1).join(','))
    ok('地球站节点不出干扰项（干扰归卫星）', at(nodes, hops, 0).length === 0 && at(nodes, hops, 2).length === 0)
  }
  // 站 → 透明星A →(星间)→ 透明星B → 站
  {
    const nodes = [es(), sat('txp'), sat('txp'), es()], hops = [rf(), rf(), rf()]
    ok('★ 出星间跳的透明星：上行四项 + 只补下行 C/IM（另三项不逐星重复）',
      same(at(nodes, hops, 1), [...UP, 'xpdrIntermodFactor']), at(nodes, hops, 1).join(','))
    ok('★ 出段那颗透明星：只有下行四项（它接的是星间跳，没有星地上行）',
      same(at(nodes, hops, 2), DN), at(nodes, hops, 2).join(','))
  }
  // 站 → 再生星A →(星间)→ 再生星B → 站：中间两颗各只有一侧
  {
    const nodes = [es(), sat('regen'), sat('regen'), es()], hops = [rf(), rf(), rf()]
    ok('再生星A（接上行、出星间）：只有上行四项', same(at(nodes, hops, 1), UP), at(nodes, hops, 1).join(','))
    ok('再生星B（接星间、出下行）：只有下行四项', same(at(nodes, hops, 2), DN), at(nodes, hops, 2).join(','))
  }
  // 只中转星间跳的那颗中间星：一项都不生效 ⇒ 整组不出
  {
    const nodes = [es(), sat('regen'), sat('regen'), sat('regen'), es()], hops = [rf(), rf(), rf(), rf()]
    ok('★ 只中转星间跳的中间星：一项都不生效（星间那一路的干扰填在跳上）',
      at(nodes, hops, 2).length === 0, JSON.stringify(at(nodes, hops, 2)))
  }
  // 三颗透明星串星间：中间那颗按自己的工作点补一份互调（引擎 txpIslImCI，见 linkChain.test.js 第 9 节）
  {
    const nodes = [es(), sat('txp'), sat('txp'), sat('txp'), es()], hops = [rf(), rf(), rf(), rf()]
    ok('★ 中间那颗透明星：只补自己的下行 C/IM', same(at(nodes, hops, 2), ['xpdrIntermodFactor']),
      at(nodes, hops, 2).join(','))
  }
  // 链端点卫星按载荷直发 / 解调结算归一：链首出星间跳不做转发器变换 ⇒ 没有互调账
  {
    const nodes = [sat('txp'), sat('txp'), es()], hops = [rf(), rf()]
    ok('★ 链首透明星出星间跳：不出 C/IM（端点按载荷直发归一，不做转发器变换）',
      at(nodes, hops, 0).length === 0, JSON.stringify(at(nodes, hops, 0)))
    const dn = [sat('txp'), es()]
    ok('链首卫星直发下行：下行四项照常生效', same(at(dn, [rf()], 0), DN), at(dn, [rf()], 0).join(','))
  }
  // 激光跳两端一律没有干扰项（背景光/串扰已含在接收灵敏度 P_req 的定义里）
  {
    const nodes = [sat('regen'), sat('regen')], hops = [laser()]
    ok('★ 激光跳两端都不出干扰项', at(nodes, hops, 0).length === 0 && at(nodes, hops, 1).length === 0)
  }
}

// ============================================================
// 「实际门限 C/N」就地派生（检查器里没点过计算也有数，改体制 / 填实现损失当场跟上）。
// 它只由体制与实现损失定，与几何/功率/干扰无关 ⇒ 渲染端能算。本节的要害是【与引擎同一个数】：
// 逐个体制拿 computeLinkChain 的 thresholdCN / thresholdEffResult 对表，一位不许差。
{
  const CARR = (o) => ({ ...defaultCarrier(), ...o })
  // 与引擎对表：一条最简单的 站→再生星→站 链，逐个体制比 thresholdCN
  const chainThreshold = (carrier, lossDb) => {
    const a = newEsNode('发'), r = newSatNode('regen', 'R'), b = newEsNode('收')
    const h1 = newHop('rf'), h2 = newHop('rf')
    h1.slantRange = '39500'; h1.elevation = '25'; h2.slantRange = '38800'; h2.elevation = '32'
    a.carrier = carrier
    if (lossDb !== undefined) r.demodLossDb = lossDb
    const out = computeLinkChain(buildChain({ nodes: [a, r, b], hops: [h1, h2] }, RESOLVE))
    return out.success ? out.data.segments[0] : null
  }
  const CASES = [
    ['QPSK 3/4 出厂默认', CARR({})],
    ['8PSK 5/6', CARR({ modulation: '8PSK', fec: '5/6' })],
    ['BPSK 1/2', CARR({ modulation: 'BPSK', fec: '1/2', ebno: '4.20' })],
    ['16APSK 3/4 · 帧效率 1', CARR({ modulation: '16APSK', rsCode: '1' })],
    ['32APSK 9/10 · 扩频 4', CARR({ modulation: '32APSK', fec: '9/10', m: '4' })],
    ['门限模式 = Es/N₀（填的就是 Es/N₀）', CARR({ noiseRatioMode: 'esno', ebno: '9.35' })]
  ]
  for (const [name, c] of CASES) {
    const sg = chainThreshold(c)
    const mine = thresholdCNOf(c)
    ok(`★ 门限 C/N 与引擎同一个数：${name}`,
      sg !== null && mine !== null && mine.toFixed(2) === sg.thresholdCN,
      `${mine === null ? 'null' : mine.toFixed(2)} vs 引擎 ${sg && sg.thresholdCN}`)
  }
  // ★ 门限 C/N ≡ 门限 Es/N₀（噪声带宽取符号率）——界面上写「实际门限 C/N」的依据
  {
    const c = CARR({ modulation: '8PSK', fec: '2/3' })
    const sg = chainThreshold(c)
    const full = computeLinkChain(buildChain({
      nodes: [Object.assign(newEsNode('发'), { carrier: c }), newSatNode('regen', 'R'), newEsNode('收')],
      hops: [Object.assign(newHop('rf'), { slantRange: '39500', elevation: '25' }),
        Object.assign(newHop('rf'), { slantRange: '38800', elevation: '32' })]
    }, RESOLVE))
    ok('★ 门限 C/N 与门限 Es/N₀ 同值（引擎噪声带宽取符号率 ⇒ 两者恒等）',
      full.success && full.data.carriers[0].esnoResult === sg.thresholdCN,
      `Es/N₀ ${full.success && full.data.carriers[0].esnoResult} vs C/N ${sg.thresholdCN}`)
  }
  // 实际门限 = 门限 C/N + 实现损失：与引擎 thresholdEffResult 逐位对表
  for (const loss of ['0', '', '0.5', '1', '1.25', '2.7']) {
    const c = CARR({})
    const sg = chainThreshold(c, loss)
    ok(`★ 实际门限 C/N ⇔ 引擎 thresholdEffResult（实现损失 ${JSON.stringify(loss)}）`,
      thresholdEffLive(c, loss) === sg.thresholdEffResult,
      `${thresholdEffLive(c, loss)} vs ${sg.thresholdEffResult}`)
  }
  // 界面上的即时性：这两项都不经引擎，改一个数当场就是新值
  const base = CARR({})
  ok('★ 填 1 dB ⇒ 门限当场抬 1 dB（不必先点计算）',
    thresholdEffLive(base, '1') === (parseFloat(thresholdEffLive(base, '0')) + 1).toFixed(2),
    `${thresholdEffLive(base, '0')} → ${thresholdEffLive(base, '1')}`)
  ok('留空当 0 算（口径同引擎 numOr(demodLossDb, 0)）',
    thresholdEffLive(base, '') === thresholdEffLive(base, '0') &&
    thresholdEffLive(base, undefined) === thresholdEffLive(base, '0'))
  ok('全角数字归一（中文输入法下敲的 １．５ 也认）',
    thresholdEffLive(base, '１.５') === thresholdEffLive(base, '1.5'), thresholdEffLive(base, '１.５'))
  ok('换体制当场跟上（8PSK 门限比 QPSK 高）',
    parseFloat(thresholdEffLive(CARR({ modulation: '8PSK' }), '0')) > parseFloat(thresholdEffLive(base, '0')) + 1,
    `${thresholdEffLive(CARR({ modulation: '8PSK' }), '0')} vs ${thresholdEffLive(base, '0')}`)
  ok('体制不全（门限没填）返回 null', thresholdCNOf({}) === null && thresholdEffLive({ ebno: '' }, '1') === null &&
    thresholdEffLive(null, '1') === null)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
