// 端到端链路（多跳 / 混合转发）引擎自测。
// 运行：node packages/core/test/linkChain.test.js
//
// 分两部分：
//   ① 级联代数钉死——倒数和、分段切割（含地面转接站）、最弱段、可用度乘积（星间段不参与）、时延求和；
//   ② 回归锚点（最重要）——新引擎不是另起炉灶，它借的是现有三引擎的物理量，凡是老引擎能算的
//      拓扑，两边必须给出同一个数：
//        a. 站→透明星→站  ⇔ computeLinkModeNGSO 的 carrierTotalCN（弯管全链）
//        b. 站→再生星     ⇔ computeRegenUplinkMode（上行段）
//        c. 站→再生星→站  ⇔ computeRegenUplinkMode + computeRegenDownlinkMode（两段各自）
//        d. 等参数双透明星 ISL 链 ⇔ 现有 islHops=1 —— 存在已知口径差异，见该节注释（不许静默）

const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const { computeLinkChain } = require(path.join(ROOT, 'packages/core/utils/linkChain.js'));
const { computeLinkModeNGSO } = require(path.join(ROOT, 'packages/core/utils/modeSolver.js'));
const { computeRegenUplinkMode, computeRegenDownlinkMode, computeRegenIslMode, computeRegenLaserIslMode } = require(path.join(ROOT, 'packages/core/utils/linkCalculatorRegen.js'));
const { calculateLinkBudget: calcNGSO } = require(path.join(ROOT, 'packages/core/utils/linkCalculatorNGSO.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}
const near = (a, b, tol) => (a !== null && b !== null && isFinite(a) && isFinite(b) && Math.abs(a - b) <= (tol === undefined ? 0.01 : tol));
const N = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// ============ 公共参数（一处改，两边同步）============
const CARRIER = {
  infoRate: '2048', modulation: 'QPSK', fec: '3/4', ebno: '5.50', ber: '7',
  m: '1.00', bandwidthFactor: '1.20', rsCode: '188/204', noiseRatioMode: 'ebno'
};
const INTF = {
  aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24',
  aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21'
};
const XPDR = { sfdRef: '-84', sfdGtRef: '0', transponderBandwidth: '36', BOi: '6', BOo: '3' };

const TX_ES = {
  kind: 'es', name: '北京关口站',
  longitude: '116.4074', latitude: '39.9042', altitude: '50', rainRate: '0', availability: '99.90',
  antennaDiameter: '9.0', antennaEfficiency: '65', feederLoss: '3.5', paBackoff: '0',
  uplinkPowerControl: '否', upcValue: '0', powerW: '120',
  rxAntennaEfficiency: '65', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35',
  rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2'
};
const RX_ES = {
  kind: 'es', name: '三亚站',
  longitude: '109.5', latitude: '18.25', altitude: '10', rainRate: '0', availability: '99.90',
  antennaDiameter: '4.5', antennaEfficiency: '65', feederLoss: '3.0', paBackoff: '0',
  uplinkPowerControl: '否', upcValue: '0', powerW: '20',
  rxAntennaEfficiency: '68', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35',
  rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2'
};
const TXP_SAT = Object.assign({ kind: 'txp', name: '透明星-1', gt: '2', eirpSat: '46' }, XPDR, INTF);
const UP_HOP = { frequency: '14.25', polarization: 'V', slantRange: '39500', elevation: '25', miscLoss: '0.3' };
const DN_HOP = { frequency: '12.50', polarization: 'H', slantRange: '38800', elevation: '32', miscLoss: '0.3' };

// 与链完全同参的 NGSO 弯管入参（回归锚点 a 用）
function ngsoParamsFor(txEs, rxEs, sat, upHop, dnHop) {
  const satParams = Object.assign({}, XPDR, INTF, { satelliteName: sat.name, frequencyBand: 'Ku' });
  const linkParams = Object.assign({}, CARRIER, {
    margin: '3',
    centerFrequency: upHop.frequency, uplinkPolarization: upHop.polarization,
    rxCenterFrequency: dnHop.frequency, downlinkPolarization: dnHop.polarization,
    distanceMode: 'slantRange', slantRange: upHop.slantRange, minElevation: upHop.elevation,
    rxDistanceMode: 'slantRange', rxSlantRange: dnHop.slantRange, rxMinElevation: dnHop.elevation,
    earthStationLocation: txEs.name, longitude: txEs.longitude, latitude: txEs.latitude,
    altitude: txEs.altitude, rainRate: txEs.rainRate, uplinkAvailability: txEs.availability,
    antennaDiameter: txEs.antennaDiameter, antennaEfficiency: txEs.antennaEfficiency,
    feederLoss: txEs.feederLoss, paBackoff: txEs.paBackoff,
    uplinkPowerControl: txEs.uplinkPowerControl, upcValue: txEs.upcValue,
    uplinkOtherLoss: upHop.miscLoss,
    G_Ts: sat.gt, rxEIRP: sat.eirpSat,
    rxEarthStationLocation: rxEs.name, rxLongitude: rxEs.longitude, rxLatitude: rxEs.latitude,
    rxAltitude: rxEs.altitude, rxRainRate: rxEs.rainRate, rxDownlinkAvailability: rxEs.availability,
    rxAntennaDiameter: rxEs.antennaDiameter, rxAntennaEfficiency: rxEs.rxAntennaEfficiency,
    rxAntennaNoiseTempMode: rxEs.rxAntennaNoiseTempMode, rxAntennaNoiseTemp: rxEs.rxAntennaNoiseTemp,
    rxReceiverNoiseTemp: rxEs.rxReceiverNoiseTemp, rxFeederLoss: rxEs.rxFeederLoss,
    downlinkOtherLoss: dnHop.miscLoss
  });
  return { satParams, linkParams };
}

// ============================================================
console.log('=== ① 结构与级联代数 ===\n');

{
  // 2 节点本身是合法的（星→站 / 站→星，见第 4 节）；被拒的是「地球站直连地球站」这种非卫星链路
  const bad = computeLinkChain({ nodes: [TX_ES, RX_ES], hops: [UP_HOP], carrier: CARRIER });
  ok('地球站直连地球站被拒（非卫星链路）', bad.success === false, bad.message);
  const one = computeLinkChain({ nodes: [TX_ES], hops: [], carrier: CARRIER });
  ok('单节点被拒（链最少 2 个节点）', one.success === false, one.message);
}
{
  const bad = computeLinkChain({
    nodes: [TX_ES, TXP_SAT, RX_ES],
    hops: [Object.assign({}, UP_HOP, { slantRange: '' }), DN_HOP], carrier: CARRIER
  });
  ok('★ 斜距为空 → 报错，不按轨道高度兜底换算', bad.success === false && /斜距/.test(bad.message || ''), bad.message);
}
{
  const bad = computeLinkChain({
    nodes: [TX_ES, { kind: 'regen', name: 'R', gt: '10', eirp: '25' }, RX_ES],
    hops: [UP_HOP, Object.assign({}, DN_HOP, { slantRange: '0' })], carrier: CARRIER
  });
  ok('斜距为 0 同样报错', bad.success === false, bad.message);
}

// 分段切割：站 → 再生星 → 透明星 → 地面转接站 → 再生星 → 站（4 段）
{
  const chain = {
    nodes: [
      TX_ES,
      { kind: 'regen', name: '再生星A', gt: '10', eirp: '28', procDelayMs: '1.5', aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24', aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21' },
      Object.assign({}, TXP_SAT, { name: '透明星B' }),
      Object.assign({}, RX_ES, { name: '转接站C', powerW: '60' }),
      { kind: 'regen', name: '再生星D', gt: '10', eirp: '28', procDelayMs: '2.5', aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24', aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21' },
      Object.assign({}, RX_ES, { name: '末端站E' })
    ],
    hops: [
      UP_HOP,                                                             // 站 → 再生星A（上行）
      { link: 'rf', frequency: '23', rangeKm: '3000', islEirp: '45', islGT: '12', miscLoss: '1' },   // 再生星A → 透明星B（星间）
      DN_HOP,                                                             // 透明星B → 转接站C（下行）
      Object.assign({}, UP_HOP, { slantRange: '38000', elevation: '30' }), // 转接站C → 再生星D（上行）
      Object.assign({}, DN_HOP, { slantRange: '39000', elevation: '28' })  // 再生星D → 末端站E（下行）
    ],
    carrier: CARRIER
  };
  const r = computeLinkChain(chain);
  ok('六节点混合链算得出', r.success === true, r.message);
  const d = r.data || {};
  ok('分段切割：再生星 / 地面转接站各切一刀 → 4 段', d.segmentCount === 4, `segs=${d.segmentCount}`);
  const segs = d.segments || [];
  ok('段 1 = 站→再生星A（单 hop 上行）', segs[0] && segs[0].hopIndexes.length === 1 && segs[0].bentPipe === false);
  ok('段 2 = 再生星A→(星间)→透明星B→转接站C（2 hop，含透明星 ⇒ 弯管口径）',
    segs[1] && segs[1].hopIndexes.length === 2 && segs[1].bentPipe === true);
  ok('段 3 = 转接站C→再生星D（单 hop 上行）', segs[2] && segs[2].hopIndexes.length === 1 && segs[2].bentPipe === false);
  ok('段 4 = 再生星D→末端站E（单 hop 下行）', segs[3] && segs[3].hopIndexes.length === 1 && segs[3].bentPipe === false);

  // 倒数和：段 2 的热噪 C/N = 其两跳 C/N 的倒数和
  const hops = d.hops || [];
  const lin = (v) => Math.pow(10, -N(v) / 10);
  const seg2Cascade = -10 * Math.log10(lin(hops[1].cnResult) + lin(hops[2].cnResult));
  ok('★ 段内倒数和级联（段 2 = hop2 ⊕ hop3）', near(N(segs[1].cnResult), seg2Cascade, 0.011),
    `${segs[1].cnResult} vs ${seg2Cascade.toFixed(2)}`);

  // 最弱段 = 端到端余量
  let mn = Infinity, mi = -1;
  segs.forEach((s, i) => { const m = N(s.marginResult); if (m !== null && m < mn) { mn = m; mi = i; } });
  ok('★ 端到端余量 = 最弱段余量', near(N(d.e2eMarginResult), mn), `${d.e2eMarginResult} vs ${mn.toFixed(2)}`);
  ok('最弱段标记正确', String(d.weakestSegment) === String(mi + 1) && segs[mi].weakest === true,
    `weakest=${d.weakestSegment}`);

  // 可用度乘积（星间段不参与）：四个星地 hop 的站址可用度连乘
  const gs = hops.filter((h) => h.type === 'up' || h.type === 'down');
  ok('星地 hop 计 4 个、星间 hop 计 1 个', gs.length === 4 && hops.filter((h) => h.type === 'isl').length === 1);
  let av = null;
  for (const h of gs) { const a = N(h.availabilityResult); av = (av === null) ? a : av * a / 100; }
  ok('★ 系统可用度 = 各星地 hop 可用度之积', near(N(d.systemAvailabilityResult), av, 1e-4),
    `${d.systemAvailabilityResult} vs ${av.toFixed(5)}`);
  ok('★ 星间 hop 不报可用度（手动距离下无互视统计，不许漏出占位入参的雨衰可用度）',
    hops[1].availabilityResult === '', JSON.stringify(hops[1].availabilityResult));

  // 时延求和
  let dly = 0;
  for (const h of hops) dly += N(h.delayResult);
  const proc = 1.5 + 2.5;   // 两颗再生星的处理时延（地面转接站未设，按 0）
  ok('★ 端到端时延 = Σ hop 传播时延 + Σ 再生节点处理时延',
    near(N(d.e2eDelayResult), dly + proc, 0.01), `${d.e2eDelayResult} vs ${(dly + proc).toFixed(3)}`);
  ok('传播/处理时延分列自洽', near(N(d.propDelayResult) + N(d.procDelayResult), N(d.e2eDelayResult), 0.001));
  ok('处理时延只算再生类节点', near(N(d.procDelayResult), proc, 0.001), d.procDelayResult);
}

// 单段链（全透明）：站→透明星A→(星间)→透明星B→站 只有一段
{
  const chain = {
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A' }), Object.assign({}, TXP_SAT, { name: 'B' }), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '2500', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  };
  const r = computeLinkChain(chain);
  ok('单段链（全透明，3 跳）算得出且只有 1 段', r.success === true && r.data.segmentCount === 1,
    r.message || `segs=${r.data && r.data.segmentCount}`);
  ok('端到端余量 = 该唯一段的余量',
    r.success && r.data.e2eMarginResult === r.data.segments[0].marginResult);
}

// 每跳都是再生（每段单 hop）
{
  const rg = (n) => ({ kind: 'regen', name: n, gt: '10', eirp: '28', procDelayMs: '1', aciUplinkFactor: '30', adjUplinkFactor: '25', xpolUplinkFactor: '26', hpaIntermodFactor: '24', aciDownlinkFactor: '30', adjDownlinkFactor: '25', xpolDownlinkFactor: '26', xpdrIntermodFactor: '21' });
  const chain = {
    nodes: [TX_ES, rg('R1'), rg('R2'), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '2500', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  };
  const r = computeLinkChain(chain);
  ok('每跳都是再生 → 3 段、每段单 hop', r.success === true && r.data.segmentCount === 3 &&
    r.data.segments.every((s) => s.hopIndexes.length === 1), r.message);
  ok('每段各自与门限比较（段余量 = 段 C/(N+I) − 门限）', r.success &&
    r.data.segments.every((s) => near(N(s.marginResult), N(s.cnResult) - N(s.thresholdCN), 0.011)));
}

// ============================================================
console.log('\n=== ② 回归锚点 a：站→透明星→站 ⇔ computeLinkModeNGSO ===\n');

function anchorA(label, txEs, rxEs, tol) {
  const { satParams, linkParams } = ngsoParamsFor(txEs, rxEs, TXP_SAT, UP_HOP, DN_HOP);
  const ref = computeLinkModeNGSO(satParams, linkParams, { mode: 'power', powerW: parseFloat(txEs.powerW) });
  const chain = computeLinkChain({
    nodes: [txEs, TXP_SAT, rxEs], hops: [UP_HOP, DN_HOP], carrier: CARRIER
  });
  ok(`${label}：两边都算得出`, ref && ref.success && chain.success, (chain && chain.message) || (ref && ref.message));
  if (!(ref && ref.success && chain.success)) return;
  const d = chain.data, rd = ref.data;
  ok(`${label}：地球站 EIRP 一致`, near(N(d.hops[0].thermalCNResult) !== null, true) &&
    near(N(rd.uplinkThermalCN), N(d.hops[0].thermalCNResult), 0.011),
  `上行热噪 ${d.hops[0].thermalCNResult} vs ${rd.uplinkThermalCN}`);
  ok(`${label}：上行 C/(N+I) 一致`, near(N(rd.uplinkCN), N(d.hops[0].cnResult), 0.011),
    `${d.hops[0].cnResult} vs ${rd.uplinkCN}`);
  ok(`${label}：下行 C/(N+I) 一致`, near(N(rd.downlinkCN), N(d.hops[1].cnResult), 0.011),
    `${d.hops[1].cnResult} vs ${rd.downlinkCN}`);
  ok(`${label}：★ 端到端 C/(N+I) ⇔ carrierTotalCN`, near(N(d.segments[0].cnResult), N(rd.carrierTotalCN), tol || 0.01),
    `${d.segments[0].cnResult} vs ${rd.carrierTotalCN}`);
  ok(`${label}：★ 端到端余量 ⇔ 引擎链路余量`, near(N(d.e2eMarginResult), N(rd.linkmargin), tol || 0.01),
    `${d.e2eMarginResult} vs ${rd.linkmargin}`);
  ok(`${label}：系统可用度 ⇔ 引擎 systemAvailability`,
    near(N(d.systemAvailabilityResult), N(rd.systemAvailabilityResult), 1e-4),
    `${d.systemAvailabilityResult} vs ${rd.systemAvailabilityResult}`);
  ok(`${label}：端到端时延 ⇔ 引擎单程时延`, near(N(d.propDelayResult), N(rd.linkDelayResult), 0.11),
    `${d.propDelayResult} vs ${rd.linkDelayResult}`);
}

// a-1 无雨：只跑几何 + 大气 + 云 + 转发器 + 四路干扰（两边必须逐位重合）
anchorA('a-1 晴空', TX_ES, RX_ES);
// a-2 下行有雨（上行无雨 ⇒ 弯管引擎走「下行降雨主导」分支，雨衰与 G/T 劣化照计）
anchorA('a-2 下行雨', TX_ES, Object.assign({}, RX_ES, { rainRate: '60' }));
// a-3 上行有雨 + UPC 全补偿
anchorA('a-3 上行雨·UPC', Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '是' }), RX_ES);
// a-4 上行有雨 + UPC 关闭：弯管的「上行残余雨衰转嫁下行账」只改它自己的转发器输出电平记账，
//     不改按功放定死的合计——两边仍必须一致
anchorA('a-4 上行雨·无 UPC', Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '否' }), RX_ES);
// a-6 两端都有雨、且弯管走「下行降雨主导」分支（UPC 开着即走这一支）：两边仍必须一致
anchorA('a-6 两端雨·下行主导', Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '是' }),
  Object.assign({}, RX_ES, { rainRate: '60' }));

// a-5 两端都有雨、且弯管走「上行降雨主导」分支 —— 唯一的口径差异，如实钉住（不许静默）：
//   弯管引擎是【单端降雨情景】模型：uplinkRainDominant 为真时，它认为「雨下在发信站那一端」，
//   于是下行按晴空算（downlinkRainEff = 0、G/T 劣化 = 0，见 linkCalculatorNGSO 的
//   uplinkRainDominant 分支）。依据是两端同时下雨的联合概率 p_up·p_dn 远小于单端 p。
//   本引擎按任务书 §2.3 做纯正向电平递推：每一跳扣自己的雨，两端的雨同时计入（联合最差工况），
//   因此在这一支下必然更保守。差值 ≈ 下行雨衰 + G/T 劣化经级联后的代价。
//   多跳链上「主导端」本就无从定义（可能有三四个星地跳），故不移植该分支——这是设计选择，
//   不是缺陷；工程上要对齐弯管口径时，把非主导端的站址雨量置 0 即可复现。
{
  const tx = Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '否' });
  const rx = Object.assign({}, RX_ES, { rainRate: '60' });
  const { satParams, linkParams } = ngsoParamsFor(tx, rx, TXP_SAT, UP_HOP, DN_HOP);
  const ref = computeLinkModeNGSO(satParams, linkParams, { mode: 'power', powerW: parseFloat(tx.powerW) });
  const chain = computeLinkChain({ nodes: [tx, TXP_SAT, rx], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  const dChain = N(chain.data.segments[0].cnResult), dRef = N(ref.data.carrierTotalCN);
  const dnRain = N(ref.data.downlinkRainAttenuationResult), gtDeg = N(ref.data.gOverTdegradationResult);
  ok('a-5：弯管确实走了「上行降雨主导」分支（下行按晴空）', ref.data.uplinkRainDominant === true);
  ok('a-5：上行侧两边仍一致（雨在上行那一跳扣，无争议）',
    near(N(ref.data.uplinkCN), N(chain.data.hops[0].cnResult), 0.011),
    `${chain.data.hops[0].cnResult} vs ${ref.data.uplinkCN}`);
  ok(`a-5：★ 已知口径差——弯管按单端降雨情景丢掉了下行雨衰 ${dnRain} dB 与 G/T 劣化 ${gtDeg} dB，本引擎联合计入故更保守`,
    dChain < dRef && (dRef - dChain) <= (Math.abs(dnRain) + Math.abs(gtDeg) + 0.5),
    `chain ${dChain.toFixed(2)} vs ngso ${dRef.toFixed(2)}`);
  // 把下行站雨量置 0（即回到弯管的单端降雨情景）后，两边必须重新对上——证明差异只来自这一条
  const chain0 = computeLinkChain({ nodes: [tx, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  const ref0 = computeLinkModeNGSO(...(() => { const p = ngsoParamsFor(tx, RX_ES, TXP_SAT, UP_HOP, DN_HOP); return [p.satParams, p.linkParams, { mode: 'power', powerW: parseFloat(tx.powerW) }]; })());
  ok('a-5：把非主导端雨量置 0 → 两边重新逐位对上（差异的唯一来源就是这一条）',
    near(N(chain0.data.segments[0].cnResult), N(ref0.data.carrierTotalCN), 0.011),
    `${chain0.data.segments[0].cnResult} vs ${ref0.data.carrierTotalCN}`);
}

// ============================================================
console.log('\n=== ② 回归锚点 b/c：再生星链 ⇔ computeRegenUplink/DownlinkMode ===\n');

{
  const REGEN_SAT = Object.assign({ kind: 'regen', name: '再生星', gt: '10', eirp: '25', procDelayMs: '0' }, INTF);
  // 与链完全同参的再生式上行入参
  const upSat = Object.assign({}, XPDR, INTF, { satelliteName: REGEN_SAT.name, frequencyBand: 'Ku' });
  const upLink = Object.assign({}, CARRIER, {
    margin: '3',
    centerFrequency: UP_HOP.frequency, uplinkPolarization: UP_HOP.polarization,
    rxCenterFrequency: '12.5', downlinkPolarization: 'H',
    distanceMode: 'slantRange', slantRange: UP_HOP.slantRange, minElevation: UP_HOP.elevation,
    rxDistanceMode: 'slantRange', rxSlantRange: UP_HOP.slantRange, rxMinElevation: UP_HOP.elevation,
    earthStationLocation: TX_ES.name, longitude: TX_ES.longitude, latitude: TX_ES.latitude,
    altitude: TX_ES.altitude, rainRate: TX_ES.rainRate, uplinkAvailability: TX_ES.availability,
    antennaDiameter: TX_ES.antennaDiameter, antennaEfficiency: TX_ES.antennaEfficiency,
    feederLoss: TX_ES.feederLoss, paBackoff: TX_ES.paBackoff,
    uplinkPowerControl: TX_ES.uplinkPowerControl, upcValue: TX_ES.upcValue,
    uplinkOtherLoss: UP_HOP.miscLoss, G_Ts: REGEN_SAT.gt,
    rxEarthStationLocation: TX_ES.name, rxLongitude: TX_ES.longitude, rxLatitude: TX_ES.latitude,
    rxAltitude: TX_ES.altitude, rxRainRate: TX_ES.rainRate, rxDownlinkAvailability: '99.90',
    rxAntennaDiameter: '3.7', rxAntennaEfficiency: '65', rxEIRP: '46',
    rxAntennaNoiseTemp: '35', rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2', downlinkOtherLoss: '0.3'
  });
  const refUp = computeRegenUplinkMode(upSat, upLink, { mode: 'power', powerW: parseFloat(TX_ES.powerW) });

  // 与链完全同参的再生式下行入参
  const dnSat = Object.assign({}, XPDR, INTF, { satelliteName: REGEN_SAT.name, frequencyBand: 'Ku' });
  const dnLink = Object.assign({}, CARRIER, {
    margin: '3',
    centerFrequency: '14.25', uplinkPolarization: 'V',
    rxCenterFrequency: DN_HOP.frequency, downlinkPolarization: DN_HOP.polarization,
    distanceMode: 'slantRange', slantRange: DN_HOP.slantRange, minElevation: DN_HOP.elevation,
    rxDistanceMode: 'slantRange', rxSlantRange: DN_HOP.slantRange, rxMinElevation: DN_HOP.elevation,
    earthStationLocation: RX_ES.name, longitude: RX_ES.longitude, latitude: RX_ES.latitude,
    altitude: RX_ES.altitude, rainRate: RX_ES.rainRate, uplinkAvailability: '99.90',
    antennaDiameter: '6.2', antennaEfficiency: '65', G_Ts: '2',
    feederLoss: '3.5', paBackoff: '0', uplinkPowerControl: '否', upcValue: '0', uplinkOtherLoss: '0.3',
    rxEarthStationLocation: RX_ES.name, rxLongitude: RX_ES.longitude, rxLatitude: RX_ES.latitude,
    rxAltitude: RX_ES.altitude, rxRainRate: RX_ES.rainRate, rxDownlinkAvailability: RX_ES.availability,
    rxAntennaDiameter: RX_ES.antennaDiameter, rxAntennaEfficiency: RX_ES.rxAntennaEfficiency,
    rxAntennaNoiseTempMode: RX_ES.rxAntennaNoiseTempMode, rxAntennaNoiseTemp: RX_ES.rxAntennaNoiseTemp,
    rxReceiverNoiseTemp: RX_ES.rxReceiverNoiseTemp, rxFeederLoss: RX_ES.rxFeederLoss,
    downlinkOtherLoss: DN_HOP.miscLoss, rxEIRP: REGEN_SAT.eirp
  });
  const refDn = computeRegenDownlinkMode(dnSat, dnLink, { mode: 'power' });

  const chain = computeLinkChain({ nodes: [TX_ES, REGEN_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  ok('c：站→再生星→站 算得出，切成 2 段', chain.success === true && chain.data.segmentCount === 2, chain.message);
  const d = chain.data;
  ok('b：★ 上行段 C/(N+I) ⇔ computeRegenUplinkMode',
    near(N(d.segments[0].cnResult), N(refUp.data.carrierTotalCN), 0.011),
    `${d.segments[0].cnResult} vs ${refUp.data.carrierTotalCN}`);
  ok('b：上行段余量 ⇔ 再生式上行余量',
    near(N(d.segments[0].marginResult), N(refUp.data.linkmargin), 0.011),
    `${d.segments[0].marginResult} vs ${refUp.data.linkmargin}`);
  ok('c：★ 下行段 C/(N+I) ⇔ computeRegenDownlinkMode',
    near(N(d.segments[1].cnResult), N(refDn.data.carrierTotalCN), 0.011),
    `${d.segments[1].cnResult} vs ${refDn.data.carrierTotalCN}`);
  ok('c：下行段余量 ⇔ 再生式下行余量',
    near(N(d.segments[1].marginResult), N(refDn.data.linkmargin), 0.011),
    `${d.segments[1].marginResult} vs ${refDn.data.linkmargin}`);
  ok('c：端到端余量 = 两段较弱者',
    near(N(d.e2eMarginResult), Math.min(N(refUp.data.linkmargin), N(refDn.data.linkmargin)), 0.011),
    `${d.e2eMarginResult}`);
  ok('c：★ 系统可用度 = 上行 × 下行（各段雨区独立）',
    near(N(d.systemAvailabilityResult), N(refUp.data.uplinkAvailabilityResult) * N(refDn.data.downlinkAvailabilityResult) / 100, 1e-4),
    d.systemAvailabilityResult);
}

// ============================================================
console.log('\n=== ② 回归锚点 d：等参数双透明星 ISL 链 ⇔ 现有 islHops=1 ===\n');
//
// 现有 NGSO 引擎的多跳 ISL 是「等参数跳 × 跳数」的近似，并且把 ISL 噪声并进【整转发器饱和
// 参考】的总 C/T（invTotalCT 里那一项 islHops·10^(−cIsl_CT/10)），再随整份总 C/T 一起折算到
// 载波工作点。而 cIsl_CT 本身是【该载波】的星间 C/T（islEirp 就是这条载波的星间 EIRP）——
// 一个已经在载波参考系里的量被塞进了饱和参考系的和里，于是它对合计的代价被整整少算了
// 「载波占转发器回退 capacity」那么多 dB（引擎注释里说的「取 ISL 在饱和总 C/T 中的噪声份额」
// 正是这一步）。
//
// 本引擎是逐跳正向：星间那一跳的 C/N 就是 islPerHopCN 本身（载波参考），直接进段内倒数和，
// 不做任何份额折算。故两边必然差一个 capacity 量级的数，方向是【本引擎更保守（合计更低）】。
// 下面把这条关系钉死：差异 ≈ ISL 噪声份额被少算 capacity dB 所致，且方向恒定。
{
  const A = Object.assign({}, TXP_SAT, { name: '透明星A' });
  const B = Object.assign({}, TXP_SAT, { name: '透明星B' });
  const ISL = { link: 'rf', frequency: '23', rangeKm: '2000', islEirp: '45', islGT: '12', miscLoss: '1' };
  const chain = computeLinkChain({ nodes: [TX_ES, A, B, RX_ES], hops: [UP_HOP, ISL, DN_HOP], carrier: CARRIER });
  ok('d：双透明星 + 星间 链算得出（单段 3 跳）', chain.success === true && chain.data.segmentCount === 1, chain.message);

  // 现有引擎：同一条上/下行 + islHops=1、同一套星间参数
  const { satParams, linkParams } = ngsoParamsFor(TX_ES, RX_ES, TXP_SAT, UP_HOP, DN_HOP);
  const sp = Object.assign({}, satParams, {
    islMode: 'rf', islHops: 1, islEirp: ISL.islEirp, islGT: ISL.islGT,
    islFreq: ISL.frequency, islMiscLoss: ISL.miscLoss, islHopDistance: ISL.rangeKm
  });
  // islHops>0 时 modeSolver 会强制置 0，故直接调 NGSO 引擎，并按 power 模式等效的余量喂入
  const base = computeLinkModeNGSO(satParams, linkParams, { mode: 'power', powerW: parseFloat(TX_ES.powerW) });
  const ref = calcNGSO(sp, Object.assign({}, linkParams, { margin: String(base.resolvedMargin) }));
  ok('d：现有引擎 islHops=1 算得出', ref && ref.success === true, ref && ref.message);

  const d = chain.data;
  const chainTotal = N(d.segments[0].cnResult);
  const refTotal = N(ref.data.carrierTotalCN);
  // 星间跳的【热噪】C/N 两边同源；cnResult 则额外并入了发射星（透明）的转发器互调——
  // 那是本引擎的逐星干扰账（见第 9 节），现有引擎的 islHops 口径里没有这一项。
  const islCN = N(d.hops[1].thermalCNResult);
  const refIslPerHop = N(ref.data.islPerHopCNResult);
  ok('d：星间单跳热噪 C/N 两边同源（都走 islPerHopCN 口径）', near(islCN, refIslPerHop, 0.011),
    `${islCN} vs ${refIslPerHop}`);
  ok('d：星间跳 C/(N+I) ≤ 热噪 C/N（发射星互调已入账）', N(d.hops[1].cnResult) <= islCN + 1e-9,
    `${d.hops[1].cnResult} vs ${islCN}`);
  const cap = N(d.hops[0].capacityResult);
  // 引擎折算后的 ISL 等效 C/N（islCascadeCNResult）= 载波参考的 ISL C/N + 大约 capacity
  const refIslCascade = N(ref.data.islCascadeCNResult);
  ok(`d：★ 引擎把 ISL 折算到饱和参考份额，等效 C/N 比载波参考高约 capacity=${cap && cap.toFixed(2)} dB（口径差异，非本引擎的错）`,
    refIslCascade !== null && islCN !== null && refIslCascade > islCN,
    `折算后 ${refIslCascade} vs 载波参考 ${islCN}`);
  ok('d：★ 因此本引擎合计更保守（更低），差值不超过该折算量',
    chainTotal <= refTotal + 0.011 && (refTotal - chainTotal) <= Math.abs(refIslCascade - islCN) + 0.5,
    `chain ${chainTotal} vs ngso(islHops=1) ${refTotal}`);
  // 逐跳异参数才是本引擎存在的理由：把星间距离改成 2×，合计必须变差
  // （比热噪那份：C/(N+I) 里发射星互调的 C/I 不随星间距离变，降幅会小于 6.02）
  const chain2 = computeLinkChain({
    nodes: [TX_ES, A, B, RX_ES],
    hops: [UP_HOP, Object.assign({}, ISL, { rangeKm: '4000' }), DN_HOP], carrier: CARRIER
  });
  ok('d：逐跳异参数生效（星间距离 ×2 → 该跳热噪 C/N 降 6 dB）',
    near(N(chain2.data.hops[1].thermalCNResult), islCN - 6.02, 0.05),
    `${chain2.data.hops[1].thermalCNResult} vs ${(islCN - 6.02).toFixed(2)}`);
}

// ============================================================
console.log('\n=== ③ 星间段可用度：手动距离下端到端可用度不含任何占位入参成分 ===\n');
{
  const rg = (n) => Object.assign({ kind: 'regen', name: n, gt: '10', eirp: '28', procDelayMs: '0' }, INTF);
  // 只有一个星地上行 + 一个星间 + 一个星地下行：可用度必须 = 上行 × 下行，星间不掺和
  const chain = computeLinkChain({
    nodes: [TX_ES, rg('R1'), rg('R2'), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '2500', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  });
  const d = chain.data;
  const expect = parseFloat(TX_ES.availability) * parseFloat(RX_ES.availability) / 100;
  ok('★ 系统可用度 = 上行站 × 下行站（星间段不贡献可用度损失）',
    near(N(d.systemAvailabilityResult), expect, 1e-4), `${d.systemAvailabilityResult} vs ${expect}`);
  ok('星间段的段级结果里没有可用度字段被写坏', d.hops[1].availabilityResult === '');
}


// ============================================================
console.log('\n=== 4 链端点为卫星（星上发起 / 星上结算）===\n');
{
  const RG = Object.assign({ kind: 'regen', name: '再生星', gt: '10', eirp: '28', procDelayMs: '0' }, INTF);
  const three = computeLinkChain({ nodes: [TX_ES, RG, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  // 卫星 → 站（2 节点单跳下行）：与三节点链的第二段必须逐位相同——同一段、同样的物理量
  const dn2 = computeLinkChain({ nodes: [RG, RX_ES], hops: [DN_HOP], carrier: CARRIER });
  ok('卫星→站（2 节点）算得出', dn2.success === true, dn2.message);
  ok('★ 其结果 = 三节点链的下行段（端点卫星按载荷直发口径，与再生转接同源）',
    dn2.success && dn2.data.segments[0].cnResult === three.data.segments[1].cnResult &&
    dn2.data.e2eMarginResult === three.data.segments[1].marginResult,
    `${dn2.success && dn2.data.e2eMarginResult} vs ${three.data.segments[1].marginResult}`);
  // 站 → 卫星（2 节点单跳上行）：与三节点链的第一段逐位相同
  const up2 = computeLinkChain({ nodes: [TX_ES, RG], hops: [UP_HOP], carrier: CARRIER });
  ok('站→卫星（2 节点）算得出', up2.success === true, up2.message);
  ok('★ 其结果 = 三节点链的上行段', up2.success && up2.data.segments[0].cnResult === three.data.segments[0].cnResult,
    `${up2.success && up2.data.segments[0].cnResult} vs ${three.data.segments[0].cnResult}`);
  // 卫星 → 卫星（星间单跳）：可用度空（星间段不贡献）
  const ISL1 = { link: 'rf', frequency: '23', rangeKm: '2500', islEirp: '45', islGT: '12', miscLoss: '1' };
  const isl2 = computeLinkChain({ nodes: [RG, Object.assign({}, RG, { name: 'B' })], hops: [ISL1], carrier: CARRIER });
  ok('卫星→卫星（星间单跳）算得出', isl2.success === true, isl2.message);
  ok('星间单跳链不报系统可用度（星间段不贡献）', isl2.success && isl2.data.systemAvailabilityResult === '');
  // 端点透明星按再生（载荷直发 / 解调结算）归一：不做转发器变换，也就没有转发器占用
  const headTxp = computeLinkChain({ nodes: [Object.assign({}, TXP_SAT, { eirp: '28' }), RX_ES], hops: [DN_HOP], carrier: CARRIER });
  ok('★ 端点透明星按再生归一（无来波可转发 ⇒ 不做转发器变换）',
    headTxp.success && headTxp.data.transponders.length === 0 && headTxp.data.e2eMarginResult === dn2.data.e2eMarginResult,
    `${headTxp.success && headTxp.data.e2eMarginResult} vs ${dn2.data.e2eMarginResult}`);
  // 起点卫星没填 EIRP：报因，不兜底
  const noEirp = computeLinkChain({ nodes: [TXP_SAT, RX_ES], hops: [DN_HOP], carrier: CARRIER });
  ok('起点卫星缺下行 EIRP → 报因', noEirp.success === false && /EIRP/.test(noEirp.message), noEirp.message);
  // 站→站 仍拒绝
  const esEs = computeLinkChain({ nodes: [TX_ES, RX_ES], hops: [UP_HOP], carrier: CARRIER });
  ok('地球站直连地球站仍被拒绝', esEs.success === false, esEs.message);
}

// ============================================================
console.log('\n=== 5 透明转发器占用（带宽 / 功率）===\n');
{
  const r = computeLinkChain({ nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  const d = r.data, t = (d.transponders || [])[0];
  ok('逐颗透明星各一条占用记录', (d.transponders || []).length === 1 && t.nodeIndex === 1, JSON.stringify(d.transponders));
  const cap = N(d.hops[0].capacityResult);
  ok('★ 功率占比 = 10^(−载波占转发器回退/10)（回退 0 dB 即吃满转发器功率）',
    near(N(t.powerRatioResult), Math.pow(10, -cap / 10) * 100, 0.6),
    `${t.powerRatioResult} vs ${(Math.pow(10, -cap / 10) * 100).toFixed(2)}`);
  const bwExp = N(d.allocBandwidthResult) / (parseFloat(TXP_SAT.transponderBandwidth) * 1000) * 100;
  ok('★ 带宽占比 = 载波带宽 / 转发器带宽', near(N(t.bandwidthRatioResult), bwExp, 0.011), `${t.bandwidthRatioResult} vs ${bwExp.toFixed(2)}`);
  // 与弯管引擎的同名量对表（口径一致；capacity 两条求法差 <0.01 dB，功率占比按比例给容差）
  const P = ngsoParamsFor(TX_ES, RX_ES, TXP_SAT, UP_HOP, DN_HOP);
  const ref = computeLinkModeNGSO(P.satParams, P.linkParams, { mode: 'power', powerW: 120 });
  ok('★ 带宽占比 ⇔ 弯管引擎 bandwidthUsageRatio', near(N(t.bandwidthRatioResult), N(ref.data.bandwidthUsageRatio), 0.011),
    `${t.bandwidthRatioResult} vs ${ref.data.bandwidthUsageRatio}`);
  ok('★ 功率占比 ⇔ 弯管引擎 powerUsageRatio（同口径）',
    near(N(t.powerRatioResult), N(ref.data.powerUsageRatio), Math.max(1, N(ref.data.powerUsageRatio) * 0.005)),
    `${t.powerRatioResult} vs ${ref.data.powerUsageRatio}`);
  ok('每载波输出 EIRP = 饱和 EIRP − OBO − 回退',
    near(N(t.eirpPerCarrierResult), parseFloat(TXP_SAT.eirpSat) - parseFloat(TXP_SAT.BOo) - cap, 0.011), t.eirpPerCarrierResult);
  // 再生链上没有透明星 ⇒ 没有占用记录，也不报链级占比
  const rg = computeLinkChain({ nodes: [TX_ES, Object.assign({ kind: 'regen', name: 'R', gt: '10', eirp: '28' }, INTF), RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  ok('再生链无转发器占用记录', (rg.data.transponders || []).length === 0);
  // 占比是某一颗透明星的资源账，不是端到端的量：链级不出这两个键（免得被当成"链的占比"用）
  ok('★ 不出链级占比（占比属于转发器，不属于这条链）',
    d.powerUsageRatio === undefined && d.bandwidthUsageRatio === undefined);
  // —— 回退的来处摆在台账上：来波（C + 单位面积增益）→ 工作点（SFD − IBO）→ 两者作差，逐行可手算 ——
  // 表上就这几行，读者拿它们相加减必须还原出回退量（此前只有「到达通量密度 / 回退」两行并排，
  // 中间那两条通量密度账整条缺失，谁也看不出回退是怎么来的）。
  // 「到达通量密度」在透明转发块里出现两次：① 的结果（sub）与 ③ 的减数（loss），故按 kind 取。
  const led = d.ledger.filter((x) => x.seg === 0);
  const rowOf = (label, kind) => led.find((x) => x.label === label && (!kind || x.kind === kind)) || null;
  const pick = (label, kind) => { const it = rowOf(label, kind); return it ? it.value : null; };
  const kindOf = (label) => { const it = rowOf(label); return it ? it.kind : null; };
  const sfdExp = parseFloat(TXP_SAT.sfdRef) - parseFloat(TXP_SAT.gt);       // 参考 G/T = 0 ⇒ 归一量即卫星 G/T
  // ① 来波：到达载波电平 C（各向同性口径）+ 10·lg(4π/λ²) = 到达通量密度
  const lam = 0.299792458 / parseFloat(UP_HOP.frequency);
  const uagExp = 10 * Math.log10(4 * Math.PI / (lam * lam));
  ok('★ 到达载波电平 C + 卫星天线单位面积增益 = 到达通量密度',
    near(pick('到达载波电平 C', 'base') + pick('卫星天线单位面积增益'), pick('到达通量密度', 'sub'), 1e-9),
    `${pick('到达载波电平 C', 'base')} + ${pick('卫星天线单位面积增益')} = ${pick('到达通量密度', 'sub')}`);
  ok('★ 单位面积增益 = 10·lg(4π/λ²)（按本跳上行频率）', near(pick('卫星天线单位面积增益'), uagExp, 1e-9),
    `${pick('卫星天线单位面积增益')} vs ${uagExp.toFixed(3)}`);
  ok('★ 摊开用的 C 就是上一跳末尾那一个（不另算一份）',
    near(pick('到达载波电平 C', 'chk'), pick('到达载波电平 C', 'base'), 1e-9),
    `${pick('到达载波电平 C', 'chk')} vs ${pick('到达载波电平 C', 'base')}`);
  // 传播项折叠后级联列只剩「雨衰 P.618 / 其他传播衰减」两行，后者 = 大气 + 云 + 附加（分项在
  // 右侧「逐跳几何与时延」段逐条出，见第 11 节）
  ok('★ 等价于 EIRP − 10·lg(4πd²)（球面摊开；差的是大气/雨/云/附加损耗）',
    near(pick('到达通量密度', 'sub'),
      pick('发信站 EIRP') - 10 * Math.log10(4 * Math.PI * Math.pow(parseFloat(UP_HOP.slantRange) * 1000, 2))
      - pick('雨衰 P.618') - pick('其他传播衰减'), 0.011),
    `${pick('到达通量密度', 'sub')}`);
  ok('★ 标称 SFD − G/T 差 = 饱和通量密度',
    near(pick('卫星 SFD（标称）') - pick('G/T 差（卫星 − 参考）'), pick('饱和通量密度 SFD'), 1e-9)
    && near(pick('饱和通量密度 SFD'), sfdExp, 1e-9), `${pick('饱和通量密度 SFD')} vs ${sfdExp}`);
  ok('★ 饱和通量密度 − IBO = 转发器工作点通量密度',
    near(pick('饱和通量密度 SFD') - pick('输入回退 IBO'), pick('转发器工作点通量密度'), 1e-9),
    `${pick('转发器工作点通量密度')}`);
  ok('★ 工作点通量密度 − 到达通量密度 = 载波占转发器回退（表上摆得出这一减）',
    near(pick('转发器工作点通量密度') - pick('到达通量密度', 'loss'), pick('载波占转发器回退'), 1e-9)
    && near(pick('载波占转发器回退'), cap, 0.011),        // 台账是全精度、hops 那份已 toFixed(2)
    `${pick('载波占转发器回退')} vs ${cap}`);
  ok('★ 这几行是算式行（base/gain/loss/sub），不是并排摆着的参考行',
    kindOf('卫星天线单位面积增益') === 'gain' && kindOf('饱和通量密度 SFD') === 'sub'
    && kindOf('输入回退 IBO') === 'loss' && kindOf('载波占转发器回退') === 'sub'
    && !!rowOf('到达通量密度', 'sub') && !!rowOf('到达通量密度', 'loss'));
  ok('参考段同口径带出 SFD / 工作点 / 到达通量密度',
    near(N(t.sfdsResult), sfdExp, 0.011) && near(N(t.opPFDResult), sfdExp - parseFloat(TXP_SAT.BOi), 0.011)
    && near(N(t.arrivalPFDResult) + N(t.capacityResult), N(t.opPFDResult), 0.011),
    `${t.sfdsResult} / ${t.opPFDResult} / ${t.arrivalPFDResult}`);
  // 参考 G/T 与本星 G/T 相等 ⇒ 归一量为 0：不摆那一行空账，标称即饱和值，单行 base 起头
  const same = computeLinkChain({
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { sfdGtRef: TXP_SAT.gt }), RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER
  });
  const ledS = same.data.ledger;
  ok('★ 归一量为 0 ⇒ 不摆 G/T 差那一行，饱和通量密度直接起头',
    !ledS.some((x) => x.label === 'G/T 差（卫星 − 参考）')
    && ledS.find((x) => x.label === '饱和通量密度 SFD').kind === 'base'
    && near(ledS.find((x) => x.label === '饱和通量密度 SFD').value, parseFloat(TXP_SAT.sfdRef), 1e-9));
}

// ============================================================
console.log('\n=== 6 地球站 EIRP / G·T：算式行留级联、设备参数移入收发链参数段 ===\n');
// 方案二：级联列只留进算式的行。发信站的口径 / 效率 / 功放瓦数 / UPC 与收信站 G/T 的十项分解
// 一律移出台账，改由 hops[] 的纯回显字段承接（右侧「收发链参数」段消费）——行数降下来、数一个不丢。
{
  const r = computeLinkChain({ nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  const led = r.data.ledger;
  const pick = (label) => { const it = led.find((x) => x.label === label); return it ? it.value : null; };
  const up = r.data.hops[0], dn = r.data.hops[1];
  // —— 算式行照旧必须绿 ——
  const eirp = pick('发信站 EIRP');
  const sum = pick('功放输出功率') - pick('功放回退') - pick('馈线损耗') + pick('发射天线增益');
  ok('★ 功放输出 − 回退 − 馈线 + 天线增益 = 发信站 EIRP', near(sum, eirp, 0.011), `${sum.toFixed(3)} vs ${eirp}`);
  ok('★ 收信站段只剩两行算式：G/T 与它的降雨劣化（级联列逐行可手算）',
    (led.find((x) => x.label === '接收站 G/T') || {}).kind === 'gain' &&
    (led.find((x) => x.label === 'G/T 劣化（降雨）') || {}).kind === 'loss');
  // —— 方案二：参考行移入右侧收发链参数段 ——
  const gone = ['天线口径', '天线效率', '功放输出功率(W)', 'UPC 补偿', '接收天线增益', '接收馈线损耗',
    '天线噪声温度', '接收机噪声温度', '雨噪声温度', '云噪声温度', '系统噪声温度', '系统噪声温度(dB)'];
  ok('★ 不进算式的设备参数已从级联列删净', gone.every((k) => pick(k) === null),
    gone.filter((k) => pick(k) !== null).join(' / '));
  ok('★ 发信站四项在上行跳的回显字段里（方案二：参考行移入右侧收发链参数段）',
    near(N(up.txDiameterResult), parseFloat(TX_ES.antennaDiameter), 1e-9) &&
    near(N(up.txEffResult), parseFloat(TX_ES.antennaEfficiency), 1e-9) &&
    N(up.paWResult) > 0 && up.upcMarginResult !== '',
    `${up.txDiameterResult} / ${up.txEffResult} / ${up.paWResult} / ${up.upcMarginResult}`);
  const gt = N(dn.rxAntennaGainResult) - N(dn.rxFeederLossResult) - N(dn.sysNoiseTempDbResult);
  ok('★ 接收天线增益 − 接收馈线损耗 − 系统噪声温度(dB) = 接收站 G/T（方案二：参考行移入右侧收发链参数段）',
    near(gt, pick('接收站 G/T'), 0.011), `${gt.toFixed(2)} vs ${pick('接收站 G/T')}`);
  ok('噪温分项齐全（天线 / 接收机 / 雨 / 云 / 系统 K）（方案二：参考行移入右侧收发链参数段）',
    ['antennaNoiseTempResult', 'receiverNoiseTempResult', 'rainNoiseTempResult', 'cloudNoiseTempResult',
      'sysNoiseTempKResult'].every((k) => dn[k] !== '' && N(dn[k]) !== null),
    JSON.stringify([dn.antennaNoiseTempResult, dn.receiverNoiseTempResult, dn.rainNoiseTempResult, dn.cloudNoiseTempResult, dn.sysNoiseTempKResult]));
  ok('★ 口径 / 效率随收发侧各归各位（上行跳不出接收链字段，下行跳不出发射链字段）',
    up.rxDiameterResult === '' && up.sysNoiseTempDbResult === '' &&
    dn.txDiameterResult === '' && dn.paWResult === '');
  // 星间跳没有地面收发链：这些字段一律留空，绝不拿占位入参那套地球站参数冒充
  const isl = computeLinkChain({
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }), Object.assign({}, TXP_SAT, { name: 'B星' }), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '40000', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  });
  ok('★ 星间跳不出地面收发链字段（占位入参的地球站参数不许漏出来）',
    ['txDiameterResult', 'txEffResult', 'paWResult', 'upcMarginResult', 'rxDiameterResult',
      'rxAntennaGainResult', 'sysNoiseTempKResult'].every((k) => isl.data.hops[1][k] === ''));
}

// ============================================================
console.log('\n=== 7 逐段载波体制（再生后可换调制）===\n');
{
  const RG = Object.assign({ kind: 'regen', name: '再生星', gt: '10', eirp: '28', procDelayMs: '0' }, INTF);
  const C8 = Object.assign({}, CARRIER, { modulation: '8PSK' });
  const nodes = [TX_ES, RG, RX_ES], hops = [UP_HOP, DN_HOP];
  const one = computeLinkChain({ nodes, hops, carrier: CARRIER });
  const two = computeLinkChain({ nodes, hops, carrier: CARRIER, carriers: [CARRIER, C8] });
  ok('逐段体制链算得出', two.success === true, two.message);
  ok('★ 段 1 门限不变（仍是链级那份 QPSK）', two.data.segments[0].thresholdCN === one.data.segments[0].thresholdCN,
    `${two.data.segments[0].thresholdCN} vs ${one.data.segments[0].thresholdCN}`);
  ok('★ 段 2 换成 8PSK 后门限升高（同 Eb/N₀ 下 Es/N₀ 更高）',
    N(two.data.segments[1].thresholdCN) > N(one.data.segments[1].thresholdCN) + 1,
    `${two.data.segments[1].thresholdCN} vs ${one.data.segments[1].thresholdCN}`);
  ok('★ 段 2 噪声带宽随之变窄（8PSK 符号率低）',
    N(two.data.carriers[1].RXnoiseBW) < N(two.data.carriers[0].RXnoiseBW),
    `${two.data.carriers[1].RXnoiseBW} vs ${two.data.carriers[0].RXnoiseBW}`);
  ok('段 1 的 C/N 不受段 2 体制影响（段与段解耦）', two.data.segments[0].cnResult === one.data.segments[0].cnResult);
  ok('逐段体制回显齐全（每段一份）', (two.data.carriers || []).length === 2 &&
    two.data.carriers[0].modulationResult === 'QPSK' && two.data.carriers[1].modulationResult === '8PSK',
    JSON.stringify((two.data.carriers || []).map((c) => c.modulationResult)));
  const wi = parseInt(two.data.weakestSegment, 10) - 1;
  ok('★ 链级门限 = 最弱段门限（余量 = C/N − 门限 自洽）',
    two.data.thresholdCN === two.data.segments[wi].thresholdCN &&
    near(N(two.data.e2eMarginResult), N(two.data.carrierTotalCN) - N(two.data.thresholdCN), 0.011),
    `${two.data.thresholdCN} / 段${wi + 1}`);
  const fallback = computeLinkChain({ nodes, hops, carrier: CARRIER, carriers: [] });
  ok('carriers 为空 ⇒ 回落链级体制（老场景逐位不变）', fallback.data.e2eMarginResult === one.data.e2eMarginResult);
}



// ============================================================
console.log('\n=== 8 解调侧：实现损失 / 端到端 BER 累加 / 段速率驱动带宽 ===\n');
{
  const RG = (extra) => Object.assign({ kind: 'regen', name: '再生星', gt: '10', eirp: '28', procDelayMs: '0' }, INTF, extra || {});
  const nodes0 = [TX_ES, RG(), RX_ES], hops2 = [UP_HOP, DN_HOP];
  const base = computeLinkChain({ nodes: nodes0, hops: hops2, carrier: CARRIER });

  // —— 解调实现损失：挂在【段末节点】的解调器上，只抬该段门限，不动 C/N ——
  const withLoss = computeLinkChain({
    nodes: [TX_ES, RG({ demodLossDb: '0.8' }), Object.assign({}, RX_ES, { demodLossDb: '1.2' })],
    hops: hops2, carrier: CARRIER
  });
  ok('实现损失不改 C/N（它是解调器的事，不是链路的事）',
    withLoss.data.segments[0].cnResult === base.data.segments[0].cnResult &&
    withLoss.data.segments[1].cnResult === base.data.segments[1].cnResult);
  ok('★ 实际解调门限 = 体制理论门限 + 本段收端实现损失',
    near(N(withLoss.data.segments[0].thresholdEffResult), N(withLoss.data.segments[0].thresholdCN) + 0.8, 0.011) &&
    near(N(withLoss.data.segments[1].thresholdEffResult), N(withLoss.data.segments[1].thresholdCN) + 1.2, 0.011),
    `${withLoss.data.segments[0].thresholdEffResult} / ${withLoss.data.segments[1].thresholdEffResult}`);
  ok('★ 段余量按实际门限扣（段1 −0.8、段2 −1.2）',
    near(N(withLoss.data.segments[0].marginResult), N(base.data.segments[0].marginResult) - 0.8, 0.011) &&
    near(N(withLoss.data.segments[1].marginResult), N(base.data.segments[1].marginResult) - 1.2, 0.011),
    `${withLoss.data.segments[0].marginResult} / ${withLoss.data.segments[1].marginResult}`);
  ok('链首那颗节点的实现损失不参与（链首不解调）',
    computeLinkChain({ nodes: [Object.assign({}, TX_ES, { demodLossDb: '9' }), RG(), RX_ES], hops: hops2, carrier: CARRIER })
      .data.segments[0].marginResult === base.data.segments[0].marginResult);
  ok('缺省实现损失 = 0（不替用户假定，老场景逐位不变）',
    base.data.segments[0].demodLossResult === '0.00' && base.data.e2eMarginResult === computeLinkChain({ nodes: nodes0, hops: hops2, carrier: CARRIER }).data.e2eMarginResult);

  // —— 端到端 BER：各段设计值之和（比特透传，误码不可恢复）——
  ok('★ 两段同为 1e-7 ⇒ 端到端 2×10⁻⁷', base.data.e2eBerResult === '2×10⁻⁷', base.data.e2eBerResult);
  ok('逐段设计 BER 逐段报', base.data.segments.every((sg) => sg.berResult === '1×10⁻⁷'));
  const C6 = Object.assign({}, CARRIER, { ber: '6' });
  const mixed = computeLinkChain({ nodes: nodes0, hops: hops2, carrier: CARRIER, carriers: [CARRIER, C6] });
  ok('★ 段间设计 BER 不同 ⇒ 按和累加（1e-7 + 1e-6 = 1.1e-6）', mixed.data.e2eBerResult === '1.1×10⁻⁶', mixed.data.e2eBerResult);
  const single = computeLinkChain({ nodes: [TX_ES, TXP_SAT, RX_ES], hops: hops2, carrier: CARRIER });
  ok('单段链（全透明）端到端 BER = 该段设计值', single.data.e2eBerResult === '1×10⁻⁷', single.data.e2eBerResult);

  // —— 段速率驱动带宽：同 MODCOD 下速率翻倍 ⇒ 噪声带宽 +3.01 dB、门限不变、段 C/N −3.01 ——
  const C2x = Object.assign({}, CARRIER, { infoRate: '4096' });
  const dbl = computeLinkChain({ nodes: nodes0, hops: hops2, carrier: CARRIER, carriers: [CARRIER, C2x] });
  ok('★ 段速率翻倍 ⇒ 该段噪声带宽 +3.01 dB',
    near(N(dbl.data.carriers[1].RXnoiseBW), N(base.data.carriers[1].RXnoiseBW) + 3.01, 0.02),
    `${dbl.data.carriers[1].RXnoiseBW} vs ${base.data.carriers[1].RXnoiseBW}`);
  ok('★ 门限 C/N 不随速率变（只随 MODCOD）', dbl.data.segments[1].thresholdCN === base.data.segments[1].thresholdCN,
    `${dbl.data.segments[1].thresholdCN} vs ${base.data.segments[1].thresholdCN}`);
  ok('★ 段热噪 C/N 随之降 3.01 dB（同样的载波功率摊到两倍带宽）',
    near(N(dbl.data.segments[1].thermalCNResult), N(base.data.segments[1].thermalCNResult) - 3.01, 0.02),
    `${dbl.data.segments[1].thermalCNResult} vs ${base.data.segments[1].thermalCNResult}`);
  // 合计 C/(N+I) 降得比 3.01 少：干扰是 dB 比值、不随噪声带宽变，带宽一放大热噪占比上升、干扰占比下降
  const dropTot = N(base.data.segments[1].cnResult) - N(dbl.data.segments[1].cnResult);
  ok('★ 合计 C/(N+I) 降幅 < 3.01 dB（干扰底不随带宽变，这一段的干扰是直接合并口径）',
    dropTot > 0 && dropTot < 3.01, `降了 ${dropTot.toFixed(2)} dB`);
  ok('前一段不受影响（速率适配发生在再生节点之后）', dbl.data.segments[0].cnResult === base.data.segments[0].cnResult);
}

// ============================================================
console.log('\n=== 9 一段多颗透明星：逐星干扰入账（转发器互调随信号走）===\n');
// 修的账：此前一段的干扰只有「进段星的上行四项 + 出段星的下行四项」——发射端出星间跳的透明星
// 下行四项从不入账（互调整个丢掉），三星以上中间星更是一项都没有。现在每颗透明星的转发器互调
// 按【它自己的】capacity 折算入账（txpIslImCI）；ACI/ASI/XPI 仍只在边界入账（同一批相邻载波
// 随信号走到底，逐星重复即双计；星间路径口径无干扰项）。
{
  const ISL = { link: 'rf', frequency: '23', rangeKm: '40000', islEirp: '45', islGT: '12', miscLoss: '1' };
  const mk = (ovA, ovB) => computeLinkChain({
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }, ovA || {}), Object.assign({}, TXP_SAT, { name: 'B星' }, ovB || {}), RX_ES],
    hops: [UP_HOP, ISL, DN_HOP], carrier: CARRIER
  });
  const base = mk();
  ok('双透明星 ISL 链算得出', base.success === true, base.message);
  // ① 发射星（A）的互调拉差 ⇒ 该星间跳的 C/(N+I) 按并联式精确变差（此前纹丝不动——本节要钉死的漏账）
  const badImA = mk({ xpdrIntermodFactor: '5' });
  {
    const thermal = N(badImA.data.hops[1].thermalCNResult);
    const ci = N(badImA.data.hops[1].interferenceCNResult);
    const expMerged = -10 * Math.log10(Math.pow(10, -thermal / 10) + Math.pow(10, -ci / 10));
    ok('★ A星（星间跳发射端）互调入账：跳 C/(N+I) = 热噪 ∥ 互调（此前整个不入账）',
      near(N(badImA.data.hops[1].cnResult), expMerged, 0.02) &&
      N(badImA.data.segments[0].cnResult) <= N(base.data.segments[0].cnResult) - 0.011,
      `${badImA.data.hops[1].cnResult} vs ${expMerged.toFixed(2)}；段 ${badImA.data.segments[0].cnResult} vs 基线 ${base.data.segments[0].cnResult}`);
  }
  // ② 折算公式手工核对：C/IM(载波参考) = C/IM(标称) − cap_A + 10lg(B_xpdr/B_noise)
  const capA = N(base.data.hops[0].capacityResult);
  const bNoise = N(base.data.RXnoiseBW);
  const expCI = 21 - capA + (10 * Math.log10(36e6) - bNoise);
  ok('★ 星间跳 interferenceCN = IM标称 − cap_A + 10lg(B_xpdr/B_noise)',
    near(N(base.data.hops[1].interferenceCNResult), expCI, 0.02),
    `${base.data.hops[1].interferenceCNResult} vs ${expCI.toFixed(2)}`);
  // ③ A星的下行 ACI/ASI/XPI 仍不入账（边界星才有路径干扰；重复计即双计同一批相邻载波）
  const badPathA = mk({ aciDownlinkFactor: '5', adjDownlinkFactor: '5', xpolDownlinkFactor: '5' });
  ok('A星下行 ACI/ASI/XPI 不逐星重复（只在出段星入账）',
    badPathA.data.segments[0].cnResult === base.data.segments[0].cnResult,
    `${badPathA.data.segments[0].cnResult}`);
  // ④ B星（出段星）下行四项照旧入账（回归：原有口径不动）
  const badB = mk(null, { xpdrIntermodFactor: '5' });
  ok('B星（出段星）互调照旧入账', N(badB.data.segments[0].cnResult) < N(base.data.segments[0].cnResult) - 0.5,
    `${badB.data.segments[0].cnResult}`);
  // ⑤ 三透明星：中间星互调拉差 ⇒ 合计变差（此前中间星一项都不入账）
  const mk3 = (ovM) => computeLinkChain({
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }), Object.assign({}, TXP_SAT, { name: '中间星' }, ovM || {}), Object.assign({}, TXP_SAT, { name: 'B星' }), RX_ES],
    hops: [UP_HOP, ISL, Object.assign({}, ISL), DN_HOP], carrier: CARRIER
  });
  const base3 = mk3();
  const badM = mk3({ xpdrIntermodFactor: '5' });
  ok('★ 三透明星：中间星互调拉差 ⇒ 合计变差（此前中间星整个不入账）',
    base3.success && badM.success && N(badM.data.segments[0].cnResult) < N(base3.data.segments[0].cnResult) - 0.5,
    `${badM.data.segments[0].cnResult} vs 基线 ${base3.data.segments[0].cnResult}`);
  // ⑥ 单星弯管不受影响（发射端是地球站，无星间跳 ⇒ 新账一项不加，回归锚点 a 的逐位一致仍成立）
  const single = computeLinkChain({ nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  const singleIm = computeLinkChain({ nodes: [TX_ES, Object.assign({}, TXP_SAT, { xpdrIntermodFactor: '21' }), RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  ok('单星弯管逐位不变（新账只在星间跳发射端加）', single.data.segments[0].cnResult === singleIm.data.segments[0].cnResult);
  // ⑦ 端点卫星（源）出星间跳：源星是再生类，不做转发器变换也不加互调账
  const RG = Object.assign({ kind: 'regen', name: '源星', gt: '10', eirp: '28' }, INTF);
  const headSat = computeLinkChain({ nodes: [RG, Object.assign({}, TXP_SAT), RX_ES], hops: [ISL, DN_HOP], carrier: CARRIER });
  ok('源卫星（再生类）出星间跳不加互调账（互调是透明转发的事）',
    headSat.success && headSat.data.hops[0].interferenceCNResult === '',
    headSat.message || headSat.data.hops[0].interferenceCNResult);
}

// ============================================================
console.log('\n=== 10 激光段口径：两端必为再生类 + 纯激光段以 P_rx / P_req 结算 ===\n');
// 三条一起钉（审查修复批次 A1–A3）：
//   A1 激光跳两端都必须是再生类——透明转发器只能变频放大射频，射频变光须经星上再生；此前
//      「透明星发激光」能静默算出结果，而它的互调从不入账、转发器输出电平与手填的激光发射功率
//      完全脱钩。校验上提到结构阶段 ⇒ 激光跳必然独占一段。
//   A2 纯激光段不再借射频门限造「等效 C/N」，直接以接收光功率对所需接收功率结算：门限在余量里
//      本就严格抵消（(thr+LM) − (thr+demod) ≡ LM − demod），是个多余的中间量，却让全激光链被
//      「取不到门限」整条挡掉。故本节既钉「全激光链算得出」，也钉「混合链的激光段余量逐位不变」。
//   A3 透明星缺参就地报因，不再让下一跳的「段起点电平缺失」把锅甩给发信站功放。
{
  // —— 站参数（功放 120 W / 口径 9 m / 效率 65·68 / 馈线 3.5·0.2 / 噪温 35·75 / 雨率 54 / 可用度 99.90）——
  const LAS_TX = {
    kind: 'es', name: '北京关口站',
    longitude: '116.4074', latitude: '39.9042', altitude: '50', rainRate: '54', availability: '99.90',
    antennaDiameter: '9.0', antennaEfficiency: '65', feederLoss: '3.5', paBackoff: '0',
    uplinkPowerControl: '否', upcValue: '0', powerW: '120',
    rxAntennaEfficiency: '68', rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: '35',
    rxReceiverNoiseTemp: '75', rxFeederLoss: '0.2'
  };
  const LAS_RX = Object.assign({}, LAS_TX, { name: '三亚站', longitude: '109.5', latitude: '18.25', altitude: '10' });
  // 再生星：G/T 2、EIRP 28
  const RG = (n, extra) => Object.assign({ kind: 'regen', name: n, gt: '2', eirp: '28', procDelayMs: '0' }, INTF, extra || {});
  // 激光跳：4600 km / P_tx 30 dBm / λ1550 nm / 口径 80·80 mm / 效率 0.8·0.8 / 指向误差 1·1 µrad / P_req −35.5 dBm
  const LASER = {
    link: 'laser', rangeKm: '4600',
    laser: {
      txPowerDbm: '30', wavelengthNm: '1550', txApertureMm: '80', rxApertureMm: '80',
      txOpticsEff: '0.8', rxOpticsEff: '0.8', txPointingErrUrad: '1', rxPointingErrUrad: '1',
      rxSensitivityDbm: '-35.5', otherLossDb: '0'
    }
  };
  // 期望值的权威来源：同参数直接调再生式光学引擎（链引擎借的就是它）
  const refLas = computeRegenLaserIslMode(
    Object.assign({}, LASER.laser, { islHopDistance: 4600 }), { visibilityPct: null, rangeRateKmS: null });
  ok('光学引擎参照算得出', refLas && refLas.success === true, refLas && refLas.message);
  const LM = refLas.resolvedMargin;                  // 全精度光链余量 P_rx − P_req

  // ① 透明星发激光 → 拒（A1 发端校验）
  const badTx = computeLinkChain({
    nodes: [LAS_TX, TXP_SAT, RG('再生星B'), LAS_RX],
    hops: [UP_HOP, LASER, DN_HOP], carrier: CARRIER
  });
  ok('★ ① 透明星发激光被拒（射频变光须经星上再生，此前静默算出非物理结果）',
    badTx.success === false && /发射端须为再生类/.test(badTx.message || ''), badTx.message);
  // ①′ 激光跳收端为透明星 → 拒（A1 收端校验，原在递推里、现前置到结构阶段）
  const badRx = computeLinkChain({
    nodes: [RG('源星'), Object.assign({}, TXP_SAT), LAS_RX],
    hops: [LASER, DN_HOP], carrier: CARRIER
  });
  ok('①′ 激光跳收端为透明星被拒（激光段无射频电平可递推）',
    badRx.success === false && /接收端须为再生类/.test(badRx.message || ''), badRx.message);

  // ② 全激光链（再生星 →(激光)→ 再生星）：合法拓扑，直接以 P_rx 对 P_req 结算
  const only = computeLinkChain({ nodes: [RG('源星'), RG('宿星')], hops: [LASER], carrier: CARRIER });
  ok('★ ② 全激光链算得出（此前被「链上没有可用的射频 hop」整条挡掉）', only.success === true, only.message);
  const sg0 = (only.data || {}).segments ? only.data.segments[0] : {};
  ok('★ ② 段余量 = 光链余量（⇔ computeRegenLaserIslMode 的 resolvedMargin）',
    Math.abs(N(sg0.marginResult) - parseFloat(LM.toFixed(2))) <= 1e-9, `${sg0.marginResult} vs ${LM.toFixed(2)}`);
  ok('② 段打激光标记，P_rx / P_req 逐项出参（A2 口径：纯激光段以 P_rx/P_req 结算）',
    sg0.laser === true && sg0.prxResult === N(refLas.data.laserPrxResult).toFixed(2) &&
    sg0.preqResult === N(refLas.data.laserPreqResult).toFixed(2),
    `${sg0.prxResult} / ${sg0.preqResult}`);
  ok('★ ② 段 C/(N+I) / 门限 / 实际门限一律留空（光链没有 C/N，不硬造数）',
    sg0.cnResult === '' && sg0.thresholdCN === '' && sg0.thresholdEffResult === '',
    JSON.stringify([sg0.cnResult, sg0.thresholdCN, sg0.thresholdEffResult]));
  ok('★ ② 链级 thresholdCN / carrierTotalCN 为空串（最弱段是激光段，不为它编数）',
    only.data.thresholdCN === '' && only.data.carrierTotalCN === '',
    JSON.stringify([only.data.thresholdCN, only.data.carrierTotalCN]));
  ok('★ ② 端到端余量 = 该段余量', only.data.e2eMarginResult === sg0.marginResult, only.data.e2eMarginResult);
  ok('② 激光跳出参：cnResult 留空，改出 P_rx / P_req / 光链余量',
    only.data.hops[0].cnResult === '' && only.data.hops[0].laserMarginResult === LM.toFixed(2) &&
    only.data.hops[0].prxResult === sg0.prxResult,
    JSON.stringify([only.data.hops[0].cnResult, only.data.hops[0].laserMarginResult]));

  // ③ ②的变体：段末节点带 1.2 dB 解调实现损失 ⇒ 段余量逐位减 1.2
  const withDem = computeLinkChain({
    nodes: [RG('源星'), RG('宿星', { demodLossDb: '1.2' })], hops: [LASER], carrier: CARRIER
  });
  ok('★ ③ 解调实现损失照扣（段余量 = 光链余量 − 实现损失，逐位）',
    withDem.data.segments[0].marginResult === (LM - 1.2).toFixed(2),
    `${withDem.data.segments[0].marginResult} vs ${(LM - 1.2).toFixed(2)}`);
  ok('③ 实际所需接收功率 = P_req + 实现损失',
    withDem.data.segments[0].preqEffResult === (N(refLas.data.laserPreqResult) + 1.2).toFixed(2),
    withDem.data.segments[0].preqEffResult);

  // ④ 混合链 站→再生星→(激光)→再生星→站：上行段 + 激光段 + 下行段
  const mix = computeLinkChain({
    nodes: [LAS_TX, RG('再生星A'), RG('再生星B'), LAS_RX],
    hops: [UP_HOP, LASER, DN_HOP], carrier: CARRIER
  });
  ok('④ 混合链切成三段（上行 / 激光 / 下行）', mix.success === true && mix.data.segmentCount === 3, mix.message);
  ok('★ ④ 混合链里激光段的段余量与全激光链逐位相同（借门限机制删除后的不变性——门限本就严格抵消）',
    mix.data.segments[1].marginResult === sg0.marginResult,
    `${mix.data.segments[1].marginResult} vs ${sg0.marginResult}`);
  ok('④ 射频两段照旧有 C/N 与门限（激光段的空值不外溢）',
    mix.data.segments[0].cnResult !== '' && mix.data.segments[0].thresholdCN !== '' &&
    mix.data.segments[2].cnResult !== '' && mix.data.segments[2].thresholdCN !== '');
  ok('④ 端到端 BER 照旧按各段设计值累加（激光段取该段体制的 ber）',
    mix.data.e2eBerResult === '3×10⁻⁷', mix.data.e2eBerResult);

  // ⑤ 透明星缺参就地报因（A3）：缺饱和 EIRP / 缺 SFD 或 G/T 各报各的，都不再点名功放
  const noEirp = computeLinkChain({
    nodes: [LAS_TX, Object.assign({}, TXP_SAT, { eirpSat: '' }), LAS_RX], hops: [UP_HOP, DN_HOP], carrier: CARRIER
  });
  ok('★ ⑤ 透明星缺饱和 EIRP：就地报这颗星，不再张冠李戴到发信站功放',
    noEirp.success === false && /缺饱和 EIRP/.test(noEirp.message || '') &&
    (noEirp.message || '').includes(TXP_SAT.name) && !/功放/.test(noEirp.message || ''), noEirp.message);
  const noGt = computeLinkChain({
    nodes: [LAS_TX, Object.assign({}, TXP_SAT, { gt: '' }), LAS_RX], hops: [UP_HOP, DN_HOP], carrier: CARRIER
  });
  ok('⑤′ 透明星缺 G/T（工作点定不下来）报另一因',
    noGt.success === false && /缺 SFD 或 G\/T/.test(noGt.message || '') && !/功放/.test(noGt.message || ''), noGt.message);
  ok('⑤″ 发信站功放确实无效时仍照旧报功放（原兜底文案不动）',
    (() => {
      const r = computeLinkChain({ nodes: [Object.assign({}, LAS_TX, { powerW: '' }), TXP_SAT, LAS_RX], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
      return r.success === false && /功放/.test(r.message || '');
    })());

  // ⑥ 回归锚点照旧逐位：站→透明星→站 ⇔ 弯管引擎（A1–A3 一律不碰这条路径）
  {
    const P = ngsoParamsFor(TX_ES, RX_ES, TXP_SAT, UP_HOP, DN_HOP);
    const ref = computeLinkModeNGSO(P.satParams, P.linkParams, { mode: 'power', powerW: parseFloat(TX_ES.powerW) });
    const ch = computeLinkChain({ nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
    ok('★ ⑥ 回归锚点仍逐位：段 C/(N+I) ⇔ carrierTotalCN、端到端余量 ⇔ 引擎链路余量',
      near(N(ch.data.segments[0].cnResult), N(ref.data.carrierTotalCN), 0.011) &&
      near(N(ch.data.e2eMarginResult), N(ref.data.linkmargin), 0.011),
      `${ch.data.segments[0].cnResult} vs ${ref.data.carrierTotalCN}`);
  }
}

// ============================================================
console.log('\n=== 11 星间C/I：星间域自己的那一项聚合干扰（手填，留空＝不计入）===\n');
//
// 星间微波跳此前除「透明发射星的转发器互调」外干扰恒为零，工程师没有任何输入口。星间域有自己的
// 干扰（星座内邻 ISL 同频、邻道、极化泄漏），与星地那四项不是同一个物理域——真空段无雨致去极化、
// 无地面 ASI 路径——且随这条链路的几何与频率复用而变，故聚合成一项挂在【跳】上（与 islEirp/islGT
// 同构），不挂卫星。并联做在引擎单咽喉 computeRegenIslMode 里：本窗口与再生式窗口同源。
// 本节钉四件事：
//   ① 留空 / 无效值 ⇒ 逐位不计入（最重要的一条：老场景一个数都不许动）；
//   ② C/(N+I) = −10lg(10^(−热噪/10) + 10^(−C/I/10)) 手算钉死，段余量随动；
//   ③ 与透明发射星的转发器互调同时有效 ⇒ 三项线性并联，出参「本跳干扰」是两者的合计；
//   ④ 引擎单咽喉三个出参自洽，且【NGSO 引擎自己的 islPerHopCN 一个字不动】（弯管多跳共用出口）。
{
  const RG = (n) => Object.assign({ kind: 'regen', name: n, gt: '10', eirp: '28', procDelayMs: '0' }, INTF);
  const ISL = (extra) => Object.assign(
    { link: 'rf', frequency: '23', rangeKm: '3000', islEirp: '45', islGT: '12', miscLoss: '1' }, extra || {});
  const chainOf = (islHop) => computeLinkChain({
    nodes: [TX_ES, RG('R1'), RG('R2'), RX_ES], hops: [UP_HOP, islHop, DN_HOP], carrier: CARRIER
  });
  const ledLabels = (d) => d.ledger.map((it) => it.label || ('#' + it.tag));

  // —— ① 留空 / 无效值一律不计入：整份出参与「根本没有这个字段」逐位相同 ——
  const base = chainOf(ISL());
  ok('① 含星间跳的链算得出（基线：没有 islCI 这个字段）', base.success === true, base.message);
  for (const bad of ['', '0', '-3', 'abc', '   ']) {
    const r = chainOf(ISL({ islCI: bad }));
    ok(`★ ① islCI=${JSON.stringify(bad)} ⇒ 整份出参与基线逐位相同（向后兼容：只认 isFinite 且 >0）`,
      JSON.stringify(r.data) === JSON.stringify(base.data));
  }
  ok('① 不计入时星间跳的热噪 = 本跳 C/N（同一个数），干扰列留空',
    base.data.hops[1].thermalCNResult === base.data.hops[1].cnResult &&
    base.data.hops[1].interferenceCNResult === '',
    `${base.data.hops[1].thermalCNResult} / ${base.data.hops[1].cnResult}`);
  ok('① 不计入时台账里没有星间干扰那两行', !ledLabels(base.data).includes('干扰损失 星间C/I'));

  // —— ② 并联式手算钉死（regen → isl(islCI=20) → regen）——
  const CI = 20;
  const ci20 = chainOf(ISL({ islCI: String(CI) }));
  ok('② islCI=20 的链算得出', ci20.success === true, ci20.message);
  const thermal = N(ci20.data.hops[1].thermalCNResult);
  const expCN = -10 * Math.log10(Math.pow(10, -thermal / 10) + Math.pow(10, -CI / 10));
  ok('★ ② 热噪档不受影响（= 基线的本跳 C/N）', ci20.data.hops[1].thermalCNResult === base.data.hops[1].cnResult,
    `${ci20.data.hops[1].thermalCNResult} vs ${base.data.hops[1].cnResult}`);
  ok('★ ② 本跳 C/(N+I) = −10lg(10^(−热噪/10) + 10^(−C/I/10))（手算钉死）',
    near(N(ci20.data.hops[1].cnResult), parseFloat(expCN.toFixed(2)), 1e-9),
    `${ci20.data.hops[1].cnResult} vs ${expCN.toFixed(2)}`);
  ok('② 出参「本跳干扰」回显该 C/I（星间段没有别的干扰源）', ci20.data.hops[1].interferenceCNResult === '20.00',
    ci20.data.hops[1].interferenceCNResult);
  // 段余量随动：星间跳独占第 2 段（两端都是再生星）⇒ 段 C/N 就是这一跳的 C/(N+I)
  const drop = thermal - N(ci20.data.hops[1].cnResult);
  ok('★ ② 段余量随动（正好差这一笔干扰损失）',
    near(N(ci20.data.segments[1].marginResult), N(base.data.segments[1].marginResult) - drop, 0.011) &&
    near(N(ci20.data.segments[1].cnResult), N(ci20.data.hops[1].cnResult), 0.011),
    `${ci20.data.segments[1].marginResult} vs ${base.data.segments[1].marginResult} − ${drop.toFixed(2)}`);
  ok('② 星地两跳一个数都不动（干扰只落在这一跳）',
    JSON.stringify(ci20.data.hops[0]) === JSON.stringify(base.data.hops[0]) &&
    JSON.stringify(ci20.data.hops[2]) === JSON.stringify(base.data.hops[2]));
  // 台账：热噪 → 干扰损失 → C/(N+I) 三行齐全且逐行可手算（级联列的硬要求）
  {
    const led = ci20.data.ledger;
    const at = led.findIndex((it) => it.label === '干扰损失 星间C/I');
    ok('★ ② 台账摊成「本跳 C/N（热噪）− 干扰损失 星间C/I = 本跳 C/(N+I)」，逐行可手算',
      at > 0 && led[at - 1].label === '本跳 C/N' && led[at + 1].label === '本跳 C/(N+I)' &&
      Math.abs(led[at - 1].value - led[at].value - led[at + 1].value) < 1e-9,
      at > 0 ? `${led[at - 1].value} − ${led[at].value} = ${led[at + 1].value}` : '未找到干扰行');
  }
  // 激光跳不受这一项管：背景光/串扰已含在接收灵敏度 P_req 的定义里，再并一项即双计
  {
    const LAS = {
      link: 'laser', rangeKm: '4600', islCI: '20',
      laser: {
        txPowerDbm: '30', wavelengthNm: '1550', txApertureMm: '80', rxApertureMm: '80',
        txOpticsEff: '0.8', rxOpticsEff: '0.8', txPointingErrUrad: '1', rxPointingErrUrad: '1',
        rxSensitivityDbm: '-35.5', otherLossDb: '0'
      }
    };
    const withCI = computeLinkChain({ nodes: [RG('源星'), RG('宿星')], hops: [LAS], carrier: CARRIER });
    const noCI = computeLinkChain({
      nodes: [RG('源星'), RG('宿星')], hops: [Object.assign({}, LAS, { islCI: '' })], carrier: CARRIER
    });
    ok('★ ② 激光跳一概不受 islCI 影响（背景光/串扰已含在 P_req 的定义里，再并一项即双计）',
      withCI.success && JSON.stringify(withCI.data) === JSON.stringify(noCI.data), withCI.message);
  }

  // —— ③ 透明发射星：星间 C/I 与该星的转发器互调三项线性并联 ——
  {
    const A = Object.assign({}, TXP_SAT, { name: 'A星' });
    const B = Object.assign({}, TXP_SAT, { name: 'B星' });
    const mk = (extra) => computeLinkChain({
      nodes: [TX_ES, A, B, RX_ES], hops: [UP_HOP, ISL(extra), DN_HOP], carrier: CARRIER
    });
    const t0 = mk(), t20 = mk({ islCI: String(CI) });
    ok('③ 透明星链两版都算得出', t0.success === true && t20.success === true, t0.message || t20.message);
    const th = N(t20.data.hops[1].thermalCNResult);
    const imCI = N(t0.data.hops[1].interferenceCNResult);      // 基线那一版只有转发器互调
    ok('③ 基线的「本跳干扰」就是该星的转发器互调（口径不变）', imCI !== null && th !== null,
      `${t0.data.hops[1].interferenceCNResult}`);
    const lin = (v) => Math.pow(10, -v / 10);
    const expTot = -10 * Math.log10(lin(th) + lin(CI) + lin(imCI));
    const expInt = -10 * Math.log10(lin(CI) + lin(imCI));
    ok('★ ③ 本跳 C/(N+I) = 热噪 ⊕ 星间C/I ⊕ 转发器IM（三项线性并联）',
      near(N(t20.data.hops[1].cnResult), expTot, 0.02), `${t20.data.hops[1].cnResult} vs ${expTot.toFixed(2)}`);
    ok('★ ③ 出参「本跳干扰」= 星间C/I ⊕ 转发器IM 的合计（两者都有时给线性和）',
      near(N(t20.data.hops[1].interferenceCNResult), expInt, 0.02),
      `${t20.data.hops[1].interferenceCNResult} vs ${expInt.toFixed(2)}`);
    // 台账顺序：先并星间 C/I，再并这颗星的互调（rec.cn 先含 islCI 再并 IM）
    const lb = ledLabels(t20.data);
    ok('③ 台账顺序：干扰损失 星间C/I 在 干扰损失 转发器IM 之前',
      lb.indexOf('干扰损失 星间C/I') > 0 && lb.indexOf('干扰损失 星间C/I') < lb.indexOf('干扰损失 转发器IM'),
      JSON.stringify(lb.filter((s) => /干扰损失/.test(s))));
    ok('③ 合计比只有互调那一版更差（多一路干扰）',
      N(t20.data.segments[0].cnResult) < N(t0.data.segments[0].cnResult) - 0.011,
      `${t20.data.segments[0].cnResult} vs ${t0.data.segments[0].cnResult}`);
  }

  // —— ④ 引擎单咽喉 computeRegenIslMode（再生式窗口走的就是它）——
  {
    const P = ngsoParamsFor(TX_ES, RX_ES, TXP_SAT, UP_HOP, DN_HOP);
    const spOf = (ci) => Object.assign({}, P.satParams, {
      islMode: 'rf', islHops: 1, islEirp: '45', islGT: '12', islFreq: '23', islMiscLoss: '1', islHopDistance: 3000
    }, ci === undefined ? null : { islCI: ci });
    const run = (ci) => computeRegenIslMode(spOf(ci), P.linkParams, { visibilityPct: null });
    const r0 = run(), rB = run(''), r20 = run(String(CI));
    ok('④ 引擎三版都算得出', r0.success && rB.success && r20.success, (r0.message || rB.message || r20.message));
    ok('④ 留空：热噪档 = 单跳 C/N（语义不变），C/I 回显为空',
      r0.data.islPerHopThermalCNResult === r0.data.islPerHopCNResult && r0.data.islCIResult === '',
      `${r0.data.islPerHopThermalCNResult} / ${r0.data.islPerHopCNResult}`);
    ok('④ 留空与「没有这个字段」逐位相同', JSON.stringify(rB.data) === JSON.stringify(r0.data));
    const th4 = N(r20.data.islPerHopThermalCNResult);
    const exp4 = -10 * Math.log10(Math.pow(10, -th4 / 10) + Math.pow(10, -CI / 10));
    ok('★ ④ 三个出参自洽：热噪 ⊕ 回显C/I = 单跳 C/N',
      r20.data.islPerHopThermalCNResult === r0.data.islPerHopCNResult &&
      r20.data.islCIResult === '20.00' &&
      near(N(r20.data.islPerHopCNResult), parseFloat(exp4.toFixed(2)), 1e-9),
      `${r20.data.islPerHopThermalCNResult} ⊕ ${r20.data.islCIResult} → ${r20.data.islPerHopCNResult}`);
    ok('★ ④ 合计 C/N 与余量随动（carrierTotalCN = 单跳 C/(N+I)，余量 = 它 − 门限）',
      r20.data.carrierTotalCN === r20.data.islPerHopCNResult &&
      near(N(r20.data.linkmargin), N(r20.data.islPerHopCNResult) - N(r20.data.thresholdCN), 0.011),
      `${r20.data.carrierTotalCN} / ${r20.data.linkmargin}`);
    // ★ 不许动 NGSO 引擎：弯管等参数多跳共用 islPerHopCN 这个出口，改写只落在 computeRegenIslMode 上
    const rawNGSO = calcNGSO(spOf(String(CI)), Object.assign({}, P.linkParams, { margin: '3' }));
    ok('★ ④ NGSO 引擎自己的 islPerHopCN 一个字不动（仍是热噪；弯管多跳共用这个出口）',
      rawNGSO.success && rawNGSO.data.islPerHopCNResult === r0.data.islPerHopCNResult &&
      rawNGSO.data.islCIResult === undefined,
      `${rawNGSO.success && rawNGSO.data.islPerHopCNResult} vs 热噪 ${r0.data.islPerHopCNResult}`);
  }
}

// ============================================================
console.log('\n=== 12 方案二：级联精简（传播项折叠 / 手算链完整性 / 出参逐位不变）===\n');
// 级联列此前一屏摆不下：不进算式的设备参考行 13 行 + 传播五项 + k 与噪声带宽各一行。
// 方案二只动展示层的行组织——参考行移入右侧参考段（第 6 节钉死），传播项与常量项折叠（本节钉死），
// 计算一步不动（③ 的出参指纹）。
{
  const CH = { nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER };
  const r = computeLinkChain(CH);
  const led = r.data.ledger;
  const up = r.data.hops[0], dn = r.data.hops[1];
  const rows = (label, kind) => led.filter((x) => x.label === label && (!kind || x.kind === kind));

  // —— ① 折叠值逐位 ——
  // 其他传播衰减 = 大气 P.676 + 云 P.840 + 附加损耗（hops[] 那份已 toFixed(2)，故按 0.011 比）
  const others = rows('其他传播衰减', 'loss');
  ok('★ 星地跳传播项折成三行（FSL / 雨衰 / 其他传播衰减），大气·云·附加不再各占一行',
    others.length === 2 && rows('大气衰减 P.676').length === 0 &&
    rows('云衰 P.840').length === 0 && rows('附加损耗').length === 0 &&
    rows('自由空间损耗', 'loss').length === 2 && rows('雨衰 P.618', 'loss').length === 2,
    `其他传播衰减 ${others.length} 行`);
  ok('★ 上行「其他传播衰减」= 大气 + 云 + 附加（逐位）',
    near(others[0].value, N(up.atmResult) + N(up.cloudResult) + N(up.miscResult), 0.011),
    `${others[0].value} vs ${N(up.atmResult)} + ${N(up.cloudResult)} + ${N(up.miscResult)}`);
  ok('★ 下行「其他传播衰减」= 大气 + 云 + 附加（逐位）',
    near(others[1].value, N(dn.atmResult) + N(dn.cloudResult) + N(dn.miscResult), 0.011),
    `${others[1].value} vs ${N(dn.atmResult)} + ${N(dn.cloudResult)} + ${N(dn.miscResult)}`);
  const kbw = rows('−k − 10·lgB', 'gain');
  ok('★ −k 与 10·lgB 并成一行（原「−玻尔兹曼常数 k」「载波噪声带宽 10·lgB」两行不再单列）',
    kbw.length === 2 && rows('−玻尔兹曼常数 k').length === 0 && rows('载波噪声带宽 10·lgB').length === 0);
  ok('★「−k − 10·lgB」= 228.6 − 载波噪声带宽（逐位）',
    kbw.every((x) => near(x.value, 228.6 - N(r.data.RXnoiseBW), 0.011)),
    `${kbw.map((x) => x.value).join(' / ')} vs ${(228.6 - N(r.data.RXnoiseBW)).toFixed(2)}`);
  // 星间微波跳同样合并（激光跳无此结构，不动）
  const islChain = computeLinkChain({
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }), Object.assign({}, TXP_SAT, { name: 'B星' }), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '40000', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  });
  ok('★ 星间微波跳的同两行同样合并（附加损耗照旧单列——星间没有大气/雨/云可并）',
    islChain.data.ledger.filter((x) => x.label === '−k − 10·lgB').length === 3 &&
    islChain.data.ledger.filter((x) => x.label === '−玻尔兹曼常数 k').length === 0 &&
    islChain.data.ledger.filter((x) => x.label === '附加损耗').length === 1);
  ok('★ 到达电平 = 上级电平 − FSL − 雨衰 − 其他传播衰减（三行手算得出）',
    near(rows('发信站 EIRP', 'sub')[0].value - rows('自由空间损耗', 'loss')[0].value
      - rows('雨衰 P.618', 'loss')[0].value - others[0].value,
      rows('到达载波电平 C', 'chk')[0].value, 1e-9));
  ok('★ 本跳 C/N = 到达电平 + G/T + (−k − 10·lgB)（两行手算得出）',
    near(rows('到达载波电平 C', 'chk')[0].value + rows('卫星 G/T', 'gain')[0].value + kbw[0].value,
      rows('本跳 C/N（热噪声）', 'chk')[0].value, 1e-9));
}

// —— ② 级联列手算链完整性：每个 chk/sub 检查点的累计值 = 它自己的值 ——
// _cascadeSingleSeg 的 running 规则在此原样复刻（base 重置 / gain 加 / loss 减 / sub·chk 权威回填）：
// 少一行、并错一行、把参考行当算式行摆进去，这一验就会在那个检查点上炸。
{
  const walk = (name, chain) => {
    const r = computeLinkChain(chain);
    if (!r.success) { ok(`级联手算链：${name}`, false, r.message); return; }
    let running = null, bad = [], pts = 0;
    const F = (n) => Math.round(n * 100) / 100;          // 与 waterfallBuilder._fmt 同口径（2 位）
    for (const it of r.data.ledger) {
      const k = it.kind;
      const n = (it.value === null || it.value === undefined || !isFinite(it.value)) ? null : it.value;
      if (k === 'base') running = n;
      else if (k === 'gain') { if (running !== null && n !== null) running += n; }
      else if (k === 'loss') { if (running !== null && n !== null) running -= n; }
      else if (k === 'sub' || k === 'chk') {
        pts++;
        if (n !== null && running !== null && Math.abs(F(running) - F(n)) > 0.001) {
          bad.push(`${it.label}：累计 ${F(running)} ≠ 自身 ${F(n)}`);
        }
        if (n !== null) running = n;                      // 引擎权威检查点
      }
    }
    ok(`★ 级联列逐行可手算：${name}（${pts} 个检查点，${r.data.ledger.length} 行）`,
      bad.length === 0, bad.join('；'));
  };
  walk('站→透明星→站', { nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER });
  walk('站→透明星A→(星间)→透明星B→站', {
    nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }), Object.assign({}, TXP_SAT, { name: 'B星' }), RX_ES],
    hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '40000', islEirp: '45', islGT: '12', miscLoss: '1' }, DN_HOP],
    carrier: CARRIER
  });
  // 雨天 + UPC：雨衰与 G/T 劣化都非零，折叠行不许把它们吃掉
  walk('雨天弯管（UPC 开）', {
    nodes: [Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '是', upcValue: '4' }),
      TXP_SAT, Object.assign({}, RX_ES, { rainRate: '42' })],
    hops: [UP_HOP, DN_HOP], carrier: CARRIER
  });
}

// —— ③ 全部数值出参与改动前逐位一致 ——
// 基准取自方案二动手【之前】的引擎：把 data（除 ledger 与本次新增的纯回显字段外）规范化成一个
// 串再取 SHA-1 前 16 位。展示层怎么改都不该动这一串——它一变就是计算被碰了。
{
  const crypto = require('crypto');
  // 方案二新增的纯回显字段（右侧参考段消费）：基线里没有，排除在指纹之外
  const ECHO_NEW = new Set(['txDiameterResult', 'txEffResult', 'paWResult', 'upcMarginResult',
    'rxDiameterResult', 'rxEffResult', 'rxAntennaGainResult', 'rxFeederLossResult', 'antennaNoiseTempResult',
    'receiverNoiseTempResult', 'rainNoiseTempResult', 'cloudNoiseTempResult', 'sysNoiseTempKResult',
    'sysNoiseTempDbResult']);
  const canon = (v) => {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => k !== 'ledger' && !ECHO_NEW.has(k))
        .map((k) => k + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  };
  const digest = (d) => crypto.createHash('sha1').update(canon(d)).digest('hex').slice(0, 16);
  const RGx = (n, extra) => Object.assign({ kind: 'regen', name: n, gt: '10', eirp: '28', procDelayMs: '0' }, INTF, extra || {});
  const ISLx = { link: 'rf', frequency: '23', rangeKm: '40000', islEirp: '45', islGT: '12', miscLoss: '1' };
  const LASERx = {
    link: 'laser', rangeKm: '4600',
    laser: {
      txPowerDbm: '30', wavelengthNm: '1550', txApertureMm: '80', rxApertureMm: '80',
      txOpticsEff: '0.8', rxOpticsEff: '0.8', txPointingErrUrad: '1', rxPointingErrUrad: '1',
      rxSensitivityDbm: '-35.5', otherLossDb: '0'
    }
  };
  // 基线指纹（2026-08-16，方案二动手前跑出）：改到这一行说明有出参变了，先查是不是碰了计算
  const BASELINE = {
    '弯管 站→透明星→站': ['956b60cd1e7ac15b', { nodes: [TX_ES, TXP_SAT, RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER }],
    '弯管·两端有雨·UPC': ['92ce6a7161365c5e', {
      nodes: [Object.assign({}, TX_ES, { rainRate: '60', uplinkPowerControl: '是', upcValue: '4' }),
        TXP_SAT, Object.assign({}, RX_ES, { rainRate: '42' })],
      hops: [UP_HOP, DN_HOP], carrier: CARRIER
    }],
    '再生 站→再生星→站': ['0d8f3031e3cbbf23', { nodes: [TX_ES, RGx('再生星'), RX_ES], hops: [UP_HOP, DN_HOP], carrier: CARRIER }],
    '再生·带解调实现损失': ['92db2b5579390862', {
      nodes: [TX_ES, RGx('再生星', { demodLossDb: '0.8' }), Object.assign({}, RX_ES, { demodLossDb: '1.2' })],
      hops: [UP_HOP, DN_HOP], carrier: CARRIER
    }],
    '双透明星 ISL 链': ['f6412e6530823d41', {
      nodes: [TX_ES, Object.assign({}, TXP_SAT, { name: 'A星' }), Object.assign({}, TXP_SAT, { name: 'B星' }), RX_ES],
      hops: [UP_HOP, ISLx, DN_HOP], carrier: CARRIER
    }],
    '六节点混合链（4 段）': ['580f80c568b72e26', {
      nodes: [TX_ES, RGx('再生星A', { procDelayMs: '1.5' }), Object.assign({}, TXP_SAT, { name: '透明星B' }),
        Object.assign({}, RX_ES, { name: '转接站C', powerW: '60' }), RGx('再生星D', { procDelayMs: '2.5' }),
        Object.assign({}, RX_ES, { name: '末端站E' })],
      hops: [UP_HOP, { link: 'rf', frequency: '23', rangeKm: '3000', islEirp: '45', islGT: '12', miscLoss: '1' },
        DN_HOP, Object.assign({}, UP_HOP, { slantRange: '38000', elevation: '30' }),
        Object.assign({}, DN_HOP, { slantRange: '39000', elevation: '28' })],
      carrier: CARRIER
    }],
    '全激光链': ['e19a791924f43a0e', { nodes: [RGx('源星'), RGx('宿星')], hops: [LASERx], carrier: CARRIER }],
    '激光混合链（3 段）': ['fcd86683588826c0', {
      nodes: [TX_ES, RGx('再生星A'), RGx('再生星B'), RX_ES], hops: [UP_HOP, LASERx, DN_HOP], carrier: CARRIER
    }],
    '逐段体制（QPSK → 8PSK）': ['e9f9b1047e74e672', {
      nodes: [TX_ES, RGx('再生星'), RX_ES], hops: [UP_HOP, DN_HOP],
      carrier: CARRIER, carriers: [CARRIER, Object.assign({}, CARRIER, { modulation: '8PSK' })]
    }]
  };
  let same = 0, drift = [];
  for (const [name, [want, chain]] of Object.entries(BASELINE)) {
    const rr = computeLinkChain(chain);
    const got = rr.success ? digest(rr.data) : 'ERR';
    if (got === want) same++; else drift.push(`${name}: ${got} ≠ ${want}`);
  }
  ok(`★ 全部数值出参与方案二动手前逐位一致（${same}/${Object.keys(BASELINE).length} 条链指纹不变）`,
    drift.length === 0, drift.join('；'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
