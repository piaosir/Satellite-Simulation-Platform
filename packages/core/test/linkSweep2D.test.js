// 二维参数扫描（设计空间图的算力层）测试。运行：npm test
//
// 关键不变式：
//   ① 二维网格的第 j 行，必须与「把 y 固定在 ys[j] 后跑一维扫描」逐点相等——
//      两条路都得经过同一个引擎、同一套轴写入语义，差一点就说明轴写歪了；
//   ② 可行裕度与链路表「合格」判定同口径（设置余量方式看 100−占用，其余看余量）；
//   ③ 算不出的格留 NaN（不是 0）——0 会被等值线当成真值，画出一条不存在的边界；
//   ④ 站址平面上，卫星覆盖不到的格必须留白（地平线以下 / 方向图波束外），
//      且接了方向图时卫星 EIRP·G/T 要逐格重采——否则等于把一个点的增益铺满全图。
const { sweepLink, sweepLink2D, MAX_CELLS } = require('../utils/linkSweep.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''));
  cond ? pass++ : fail++;
}

console.log('=== 链路预算二维参数扫描测试 ===\n');

const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO' };
const LINK = {};
const AX_D = { key: 'antennaDiameter', target: 'link', min: 1.2, max: 9.2 };      // 发信站口径 m
const AX_RD = { key: 'rxAntennaDiameter', target: 'link', min: 1.2, max: 9.2 };   // 收信站口径 m

// ① 网格形状与轴取值
{
  const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'balance' }, x: { ...AX_D, steps: 7 }, y: { ...AX_RD, steps: 5 } });
  ok('二维扫描出网格', r.nx === 7 && r.ny === 5, `nx=${r.nx} ny=${r.ny}`);
  ok('轴端点精确落在区间两端', r.xs[0] === 1.2 && r.xs[6] === 9.2 && r.ys[0] === 1.2 && r.ys[4] === 9.2);
  ok('全部 35 格算通', r.ok === 35 && r.fail === 0, `ok=${r.ok} fail=${r.fail}`);
  const m = r.series.linkmargin;
  ok('余量场按行主序铺满', m instanceof Float64Array && m.length === 35);
  ok('场值有限', Number.isFinite(m[0]) && Number.isFinite(m[34]));
  // 物理单调：两端口径都变大 → 余量必然变大（同一颗星、同一条载波）
  ok('两站口径同增 → 余量增', m[34] > m[0], `${m[0].toFixed(2)} → ${m[34].toFixed(2)} dB`);
  // 沿单轴单调。工作点恒定钉在基准链路解出的那台功放上（见 _pinnedOpt），于是这两条的归属
  // 正好与逐格重解口径下对调：功放成了不动的常数，口径的好处全部落到上行 C/N 上。（逐格重解
  // 口径下反过来——上行 C/N 被转发器工作点 SFD−BOi 钉死，口径大只是省功放。）
  const pa = r.series.paRecommendation;
  ok('功放钉在当前链路 → 不随口径变', Math.abs(pa[6] - pa[0]) < 1e-9, `${pa[0].toFixed(3)} → ${pa[6].toFixed(3)} W`);
  // 口径 1.2 → 9.2 m 即天线增益 +20·log₁₀(9.2/1.2) ≈ 17.7 dB；功放不动，这一整份增益就
  // 原样落到到达卫星的载波功率上。含干扰合成后略打折扣，故判据取「显著抬升」而非精确值
  const up = r.series.uplinkCN;
  ok('功放钉住 → 发信站口径增 → 上行 C/N 增', up[6] - up[0] > 15,
    `${up[0].toFixed(2)} → ${up[6].toFixed(2)} dB，增益差 ${(20 * Math.log10(9.2 / 1.2)).toFixed(2)} dB`);
}

// ② 与一维扫描交叉验证：二维第 j 行 ≡ 把 y 固定在 ys[j] 的一维扫描。
//    一维二维都恒定钉住工作点，但两边的「基准链路」并不是同一条——一维把 rxAntennaDiameter
//    挪到了 ys[j]，二维的基准仍是原值——各自解出的功放于是不同，逐格自然对不上。故显式把
//    一维钉在二维那台功放上（'power' 方式走 _pinnedOpt 的短路分支，原样沿用）：这样比的才是
//    「同一工作点下两条代码路径算不算得一样」，顺带验证回传的 pin 能原样喂回去。
{
  const g = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'balance' }, x: { ...AX_D, steps: 9 }, y: { ...AX_RD, steps: 4 } });
  const j = 2;
  const oned = sweepLink({
    engine: 'geo', satParams: SAT,
    linkParams: { ...LINK, rxAntennaDiameter: String(g.ys[j]) },
    opt: { mode: 'power', powerW: g.pin.powerW }, x: { ...AX_D, steps: 9 }
  });
  let worst = 0;
  for (let i = 0; i < g.nx; i++) {
    const a = g.series.linkmargin[j * g.nx + i], b = oned.series.linkmargin[i];
    worst = Math.max(worst, Math.abs(a - b));
  }
  ok('二维第 j 行 ≡ 一维同参扫描', worst < 1e-9, `最大偏差 ${worst.toExponential(1)} dB`);
  ok('一维扫描同样恒定钉住工作点', !!oned.pin && oned.pin.powerW === g.pin.powerW,
    `一维 ${oned.pin && oned.pin.powerW} W / 二维 ${g.pin.powerW} W`);
}

// ③ 可行裕度口径。工作点恒定钉住 → 计算方式一律换成「设置功放功率」，余量成了逐格解出来的
//    量，可行裕度直接取它——「设置余量」方式在这里也不例外（钉住的是那 3 dB 解出的功放，
//    不是那 3 dB 本身）。
{
  const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'margin' }, x: { ...AX_D, steps: 5 }, y: { ...AX_RD, steps: 5 } });
  ok('设置余量方式 + 钉住工作点：裕度即链路余量', r.feasMeta.unit === 'dB', r.feasMeta.label);
  let worst = 0;
  for (let t = 0; t < r.nx * r.ny; t++) worst = Math.max(worst, Math.abs(r.feas[t] - r.series.linkmargin[t]));
  ok('裕度 ≡ 链路余量（钉住口径）', worst < 1e-9, `最大偏差 ${worst.toExponential(1)}`);
}
// 「100 − 占用」那一档只剩不钉的轴还会走到：「目标余量」轴上余量本身就是自变量，
// 拿它当可行裕度成了同义反复，故退回资源占用口径
{
  const r = sweepLink2D({
    engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'margin' },
    x: { key: '_margin', min: 0, max: 6, steps: 5 }, y: { ...AX_RD, steps: 5 }
  });
  ok('目标余量轴：裕度单位为百分点', r.feasMeta.unit === '百分点', r.feasMeta.label);
  let worst = 0;
  for (let t = 0; t < r.nx * r.ny; t++) {
    const want = Math.min(100 - r.series.powerUsageRatio[t], 100 - r.series.bandwidthUsageRatio[t]);
    worst = Math.max(worst, Math.abs(r.feas[t] - want));
  }
  ok('裕度 = min(100−功率占用, 100−带宽占用)', worst < 1e-9, `最大偏差 ${worst.toExponential(1)}`);
}
// 计算方式换成求解式，钉住之后归到同一口径
{
  const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'balance' }, x: { ...AX_D, steps: 4 }, y: { ...AX_RD, steps: 4 } });
  ok('求解方式：裕度单位为 dB', r.feasMeta.unit === 'dB');
  let same = true;
  for (let t = 0; t < r.nx * r.ny; t++) if (Math.abs(r.feas[t] - r.series.linkmargin[t]) > 1e-12) same = false;
  ok('裕度 ≡ 链路余量', same);
}

// ④ 合成轴（一次写多个引擎键）在二维里同样成立
{
  // 用「设置功放瓦数」方式：余量是解出来的，才能看出可用度对它的压制。
  // 降雨率须显式给（空入参默认无雨 → 雨衰恒 0 → 可用度轴对任何输出量都不起作用）。
  const r = sweepLink2D({
    engine: 'geo', satParams: SAT,
    linkParams: { ...LINK, rainRate: '42', rxRainRate: '42' },
    opt: { mode: 'power', powerW: 200 },
    x: { key: '_availability', min: 99, max: 99.9, steps: 5 },
    y: { ...AX_D, steps: 5 }
  });
  ok('合成轴（可用度）可作二维轴', r.ok === 25 && r.axisX.unit === '%', r.axisX.label);
  const m = r.series.linkmargin;
  // 可用度要求越高 → 雨衰取值越大 → 余量越低（同一行内比较）
  ok('可用度↑ → 余量↓', m[0] > m[4], `${m[0].toFixed(2)} → ${m[4].toFixed(2)} dB`);
}

// ⑤ 出错分支：两轴同参 / 区间无效 / 未指定轴
{
  const same = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, x: { ...AX_D, steps: 5 }, y: { ...AX_D, steps: 5 } });
  ok('两轴同参 → 明确报错', same.nx === 0 && /同一个参数/.test(same.message), same.message);
  const badRange = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, x: { ...AX_D, min: 5, max: 5, steps: 5 }, y: { ...AX_RD, steps: 5 } });
  ok('区间无效 → 明确报错', badRange.nx === 0 && /横轴区间无效/.test(badRange.message), badRange.message);
  const noAxis = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, x: { ...AX_D, steps: 5 } });
  ok('缺一根轴 → 明确报错', noAxis.nx === 0 && /两根自变量轴/.test(noAxis.message));
  const laser = sweepLink2D({ engine: 'regen-laser', satParams: SAT, linkParams: LINK, x: { ...AX_D, steps: 3 }, y: { ...AX_RD, steps: 3 } });
  ok('激光星间 → 说明不支持而非静默算错', laser.nx === 0 && /激光星间/.test(laser.message));
}

// ⑥ 总格数封顶：等比压到上限内，且保持两边疏密比例
{
  const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'balance' }, x: { ...AX_D, steps: 81 }, y: { ...AX_RD, steps: 81 } });
  ok('超上限自动压到 MAX_CELLS 内', r.nx * r.ny <= MAX_CELLS && r.nx >= 2 && r.ny >= 2, `${r.nx}×${r.ny}=${r.nx * r.ny} ≤ ${MAX_CELLS}`);
  ok('压缩后仍保持正方比例', r.nx === r.ny, `${r.nx}×${r.ny}`);
}

// ⑦ 算不出的格留 NaN（不是 0）：把口径扫到负数区间，引擎必然失败
{
  const r = sweepLink2D({
    engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'balance' },
    x: { key: 'latitude', target: 'link', min: 60, max: 89.9, steps: 6 },   // 高纬 → 看不见 GEO 星
    y: { ...AX_D, steps: 4 }
  });
  const arr = r.series.linkmargin;
  let zeros = 0, nans = 0;
  for (let t = 0; t < arr.length; t++) { if (arr[t] === 0) zeros++; if (arr[t] !== arr[t]) nans++; }
  ok('高纬不可见区不产生假 0', zeros === 0, `NaN 格 ${nans} / ${arr.length}`);
}

// ⑧ 覆盖门（几何）：站址平面上，卫星在地平线以下的格必须留白，不能算出一个穿地球的 C/N
{
  const GEO_SAT = { lon: 110.5, lat: 0, alt: 35786 };   // 与引擎缺省轨位同值
  const PLANE = {
    engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'margin' },
    x: { key: 'longitude', target: 'link', min: -180, max: 180, steps: 25 },
    y: { key: 'latitude', target: 'link', min: -80, max: 80, steps: 17 }
  };
  const off = sweepLink2D(PLANE);                                        // 不给覆盖门
  const on = sweepLink2D({ ...PLANE, geo: { sat: GEO_SAT, minElev: {} } });  // 给覆盖门
  const n = 25 * 17;
  ok('覆盖门：整幅世界铺开必有大片留白', on.masked > n * 0.3, `masked=${on.masked} / ${n}`);
  ok('覆盖门：三类格数加起来正好铺满网格', on.ok + on.fail + on.masked === n, `${on.ok}+${on.fail}+${on.masked}`);
  // 引擎自报的负仰角这一重兜底门，不给 spec.geo 时也该拦下（GEO 引擎按轨位算得出仰角）
  ok('无覆盖门时也不画穿地球的格（引擎负仰角兜底）', off.masked > 0, `masked=${off.masked}`);
  // 两条门口径应当一致：同一颗星、同一个地平线，格数差不出几个（边界格的浮点差）
  ok('几何门与引擎自报口径一致', Math.abs(on.masked - off.masked) <= 2, `${on.masked} vs ${off.masked}`);
  // 卫星对面（轨位 +180°）必然看不见；星下点必然看得见
  const m = on.series.linkmargin;
  const at = (lon, lat) => {
    let bi = 0, bj = 0;
    for (let i = 1; i < on.nx; i++) if (Math.abs(on.xs[i] - lon) < Math.abs(on.xs[bi] - lon)) bi = i;
    for (let j = 1; j < on.ny; j++) if (Math.abs(on.ys[j] - lat) < Math.abs(on.ys[bj] - lat)) bj = j;
    return m[bj * on.nx + bi];
  };
  ok('对跖点留白', at(-69.5, 0) !== at(-69.5, 0), `z=${at(-69.5, 0)}`);
  ok('星下点有值', Number.isFinite(at(110.5, 0)), `z=${at(110.5, 0)}`);
  // 最低工作仰角抬高 → 覆盖圈收紧 → 留白更多（覆盖圈边界确实按门限走）
  const hi = sweepLink2D({ ...PLANE, geo: { sat: GEO_SAT, minElev: { tx: 30 } } });
  ok('仰角门限抬高 → 覆盖圈收紧', hi.masked > on.masked, `10°→0°: ${on.masked}, 30°: ${hi.masked}`);
}

// ⑨ 方向图联动 + 波束外留白：注入一支「假天线」，只在星下点附近有增益
{
  const GEO_SAT = { lon: 110.5, lat: 0, alt: 35786 };
  const PLANE = {
    engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'margin' },
    x: { key: 'longitude', target: 'link', min: 80, max: 140, steps: 13 },
    y: { key: 'latitude', target: 'link', min: 10, max: 60, steps: 11 },
    geo: { sat: GEO_SAT, minElev: {}, pattern: { tx: { key: 'G_Ts', file: 'fake.grd', sat: GEO_SAT, cfg: {} } } }
  };
  // 离星下点 >20° 视作波束外（返回 null）；圈内给一个随距离衰减的 G/T
  const calls = [];
  const hooks = {
    samplePattern: (pat, pts) => {
      calls.push({ file: pat.file, n: pts.length });
      return pts.map((p) => {
        const d = Math.hypot(p.lon - 110.5, p.lat - 0);
        return d > 20 ? null : 2 - 0.3 * d;
      });
    }
  };
  const r = sweepLink2D(PLANE, hooks);
  ok('方向图只采一次，整张网格一批过去', calls.length === 1 && calls[0].n === 13 * 11, JSON.stringify(calls));
  ok('波束外的格留白', r.maskBeam > 0 && r.masked > 0, `maskBeam=${r.maskBeam} masked=${r.masked}`);
  ok('波束内的格照常算出', r.ok > 0, `ok=${r.ok}`);
  // 联动真的落到了卫星 G/T 上：拿一支「全场恒定 5 dB/K」的假天线跑，结果必须与
  // 「不接方向图、入参直接写 G_Ts=5」逐格相同——差一点就说明值写到了别的键上。
  // 判据取上行 C/N：工作点恒定钉住之后功放才是那个不动的常数（旧判据取的正是它，已不再响应），
  // 而功放钉死时到达卫星的载波功率随之钉死，卫星 G/T 抬多少上行 C/N 就抬多少，干净且单调。
  // 两次扫描显式钉在同一台功放上（'power' 走 _pinnedOpt 的短路分支）：否则两边各自解基准
  // 链路——一边 G_Ts 走方向图、一边写死 5——解出的功放不同，逐格就无从比起。
  const PIN = { mode: 'power', powerW: 20 };
  const flat = (v) => ({ samplePattern: (pat, pts) => pts.map(() => v) });
  const cn5 = sweepLink2D({ ...PLANE, opt: PIN }, flat(5)).series.uplinkCN;
  const cnRaw = sweepLink2D({ ...PLANE, opt: PIN, linkParams: { ...LINK, G_Ts: '5' }, geo: { sat: GEO_SAT, minElev: {} } }).series.uplinkCN;
  let cmp = 0, diff = 0;
  for (let t = 0; t < cn5.length; t++) {
    if (cn5[t] !== cn5[t] || cnRaw[t] !== cnRaw[t]) continue;
    cmp++; if (Math.abs(cn5[t] - cnRaw[t]) > 1e-9) diff++;
  }
  ok('方向图取值确实写进卫星 G/T', cmp > 0 && diff === 0, `逐格核对 ${cmp} 格，不符 ${diff}`);
  // 再抬 3 dB：上行 C/N 应当整整高 3 dB，证明写进去的是 dB 量而不是被当成别的标度
  const cn8 = sweepLink2D({ ...PLANE, opt: PIN }, flat(8)).series.uplinkCN;
  let bad = 0, cmp8 = 0;
  for (let t = 0; t < cn5.length; t++) {
    if (cn5[t] !== cn5[t] || cn8[t] !== cn8[t]) continue;
    cmp8++; if (Math.abs(cn8[t] - cn5[t] - 3) > 0.01) bad++;
  }
  ok('卫星 G/T +3 dB → 上行 C/N 高 3 dB', cmp8 > 0 && bad === 0, `核对 ${cmp8} 格，不符 ${bad}`);
  // 波束内的场确实随离轴角变（不是把一个点的增益铺满）：离星下点越远增益越低、上行 C/N 越低。
  // 取同一行（10°N）上离星下点 10° 与 13.8° 的两格，都还在假天线的 20° 圈内
  const cn = r.series.uplinkCN;
  const cnAt = (i, j) => cn[j * r.nx + i];
  ok('波束内上行 C/N 随离轴角单调降', cnAt(6, 0) > cnAt(8, 0), `近 ${cnAt(6, 0).toFixed(2)} → 远 ${cnAt(8, 0).toFixed(2)} dB`);
  // 不给回调（如核心层单测直接调用）→ 只剩几何门，绝不静默把 pattern 当成有值
  const noHook = sweepLink2D(PLANE);
  ok('无采样回调时退回纯几何门', noHook.maskBeam === 0 && noHook.ok > r.ok, `ok ${noHook.ok} > ${r.ok}`);
}

// ⑩ 非站址平面（如「发信站纬度 × 天线口径」）不套覆盖门：那不是一张地图，
//    但引擎自报的负仰角仍要拦下——两条路各管各的，别互相顶掉
{
  const r = sweepLink2D({
    engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode: 'margin' },
    x: { key: 'latitude', target: 'link', min: 60, max: 89.9, steps: 6 },
    y: { ...AX_D, steps: 4 },
    geo: { sat: { lon: 110.5, lat: 0, alt: 35786 }, minElev: {} }
  });
  ok('非站址平面：高纬不可见仍被拦下', r.masked === 8, `masked=${r.masked} / 24`);
}

// ⑪ 场变量的「按端归属」（lbOutputDefs.js 的 geoSide）必须与引擎实际行为一致。
//    地理场图据此决定扫某一端时列出哪些量：声明成 'tx' 的，收信站挪到哪儿它都不该动；
//    'rx' 反之；不声明 geoSide 的则两端都影响不了它。声明歪了，下拉里就会多出一堆逐格
//    同值的死选项，或反过来把真会变的量整组藏起来——「链路余量怎么没了」正是这么来的。
{
  const { OUTPUT_GROUPS } = require('../utils/lbOutputDefs.js');
  // 两端同址、同有雨：收发两侧的量在同一起点上，谁随谁变才看得干净
  const SITE_LINK = {
    ...LINK,
    longitude: '116.4', latitude: '39.9', altitude: '0', rainRate: '42', uplinkAvailability: '99.9',
    rxLongitude: '116.4', rxLatitude: '39.9', rxAltitude: '0', rxRainRate: '42', rxDownlinkAvailability: '99.9'
  };
  const sweepSite = (side, mode) => sweepLink2D({
    engine: 'geo', satParams: SAT, linkParams: SITE_LINK, opt: { mode, powerW: 200 },
    x: { key: side === 'rx' ? 'rxLongitude' : 'longitude', target: 'link', min: 75, max: 140, steps: 9 },
    y: { key: side === 'rx' ? 'rxLatitude' : 'latitude', target: 'link', min: 22, max: 50, steps: 9 },
    autoGeo: true, geo: { sat: { lon: 110.5, lat: 0, alt: 35786 }, minElev: {} }
  });
  const runs = { tx: {}, rx: {} };
  for (const m of ['margin', 'power']) { runs.tx[m] = sweepSite('tx', m); runs.rx[m] = sweepSite('rx', m); }
  // 该量在「挪这一端」的扫描里动没动过（两种计算方式任一动了就算动——求解方式不同，
  // 耦合路径也不同：设置余量下挪收信站会经求解器改功放，从而带动上行侧的量）
  const moves = (side, key) => ['margin', 'power'].some((m) => {
    const arr = runs[side][m].series[key];
    if (!arr) return false;
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < arr.length; t++) { const v = arr[t]; if (v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) return false;
    return (hi - lo) > 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi));
  });
  const wrong = [];
  for (const g of OUTPUT_GROUPS) {
    for (const it of g.items) {
      const s = it.geoSide;
      if (s === 'tx' && moves('rx', it.key)) wrong.push(`${it.key} 标 tx 却随收信站变`);
      if (s === 'rx' && moves('tx', it.key)) wrong.push(`${it.key} 标 rx 却随发信站变`);
      if (!s && (moves('tx', it.key) || moves('rx', it.key))) wrong.push(`${it.key} 未标 geoSide 却随站址变`);
    }
  }
  ok('geoSide 按端归属与引擎实测相符', wrong.length === 0, wrong.join('；') || '全部相符');
  // 列进地理场图下拉的量（geoField），GEO 引擎必须真的算得出——否则下拉里是个点了没反应的死项
  const missing = [];
  for (const g of OUTPUT_GROUPS) {
    for (const it of g.items) {
      if (!it.geoField) continue;
      if (!it.geoSide) { missing.push(`${it.key}(无 geoSide)`); continue; }
      const side = it.geoSide === 'rx' ? 'rx' : 'tx';
      if (!runs[side].margin.series[it.key]) missing.push(it.key);
    }
  }
  ok('geoField 标注的量 GEO 引擎都给得出', missing.length === 0, missing.join(', ') || '全部有值');
}

// ⑫ 钉住工作点：地理场图的**唯一**口径（无开关，调用方不传任何东西也照钉），按体制/上下行
//    分别钉。三条不变式——
//    ① 站址本格必须与「不扫描、直接算一次」逐字相同（钉的就是这条链路自己的工作点）；
//    ② 钉住之后两端同义：扫发信站与扫收信站的链路余量都得是随站址变的场。
//       此前默认逐格重解，发信站那一端的余量被求解器每格补回目标 → 图上恒定、收信站却有起伏，
//       同一个「链路余量」两端不同义（用户报的就是这个）。
//    ③ 「设置功放功率」方式走短路分支，原样沿用用户填的瓦数，不去解基准链路换成别的功放。
{
  const { computeLinkMode, computeLinkModeNGSO } = require('../utils/modeSolver.js');
  const regen = require('../utils/linkCalculatorRegen.js');
  const LON = 116.4074, LAT = 39.9042, N = 11, HALF = 20;
  const SITE = {
    ...LINK,
    longitude: String(LON), latitude: String(LAT), altitude: '0', rainRate: '38', uplinkAvailability: '99.9',
    rxLongitude: String(LON), rxLatitude: String(LAT), rxAltitude: '0', rxRainRate: '38', rxDownlinkAvailability: '99.9',
    // NGSO / 再生式的站星几何由前端解算后注入，本模块不重解
    elevation: '35', slantRange: '1500', rxElevation: '35', rxSlantRange: '1500'
  };
  // 刻意不传任何「钉不钉」的字段：钉住是算力层的恒定口径，调用方无从关掉
  const sweep = (engine, side, opt) => sweepLink2D({
    engine, satParams: SAT, linkParams: SITE, opt,
    x: { key: side === 'rx' ? 'rxLongitude' : 'longitude', target: 'link', min: LON - HALF, max: LON + HALF, steps: N },
    y: { key: side === 'rx' ? 'rxLatitude' : 'latitude', target: 'link', min: LAT - HALF, max: LAT + HALF, steps: N },
    autoGeo: true, geo: { sat: { lon: 110.5, lat: 0, alt: 35786 }, minElev: {} }
  });
  const solverOf = {
    geo: computeLinkMode, ngso: computeLinkModeNGSO,
    'regen-up': regen.computeRegenUplinkMode, 'regen-down': regen.computeRegenDownlinkMode
  };
  const CASES = [
    ['geo', ['margin', 'balance', 'power'], ['tx', 'rx']],
    ['ngso', ['margin', 'power'], ['tx', 'rx']],
    ['regen-up', ['margin', 'power'], ['tx']],
    ['regen-down', ['margin', 'power'], ['rx']]
  ];
  const C = ((N - 1) / 2) * N + (N - 1) / 2;   // 中心格 = 站址本格
  const offs = [], flats = [];
  for (const [engine, modes, sides] of CASES) {
    for (const mode of modes) {
      const opt = { mode, powerW: 40, overDb: 1 };
      let base = null;
      try { base = solverOf[engine](SAT, SITE, opt); } catch (e) { base = null; }
      const dm = (base && base.success) ? parseFloat(base.data.linkmargin) : NaN;
      for (const side of sides) {
        const r = sweep(engine, side, opt);
        const arr = r.series.linkmargin;
        if (!arr) { offs.push(`${engine}/${mode}/${side} 没有余量场`); continue; }
        // ① 本格 ≡ 直接算（0.01 dB 内：直接算那次没开出参小数位增量，只到 2 位）
        if (!(Math.abs(arr[C] - dm) <= 0.01)) offs.push(`${engine}/${mode}/${side} 本格 ${arr[C].toFixed(3)} ≠ 直接算 ${dm.toFixed(3)}`);
        // ② 钉住之后必须是场，不能是常数
        let lo = Infinity, hi = -Infinity;
        for (let t = 0; t < arr.length; t++) { const v = arr[t]; if (v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!(hi - lo > 0.01)) flats.push(`${engine}/${mode}/${side} 跨度仅 ${(hi - lo).toFixed(4)} dB`);
      }
    }
  }
  ok('钉住工作点：站址本格 ≡ 直接算一次', offs.length === 0, offs.join('；') || '四体制全部相符');
  ok('钉住工作点：两端的余量都成了随站址变的场', flats.length === 0, flats.join('；') || '无一恒定');
  // ③ 「设置功放功率」方式本就钉着工作点 → _pinnedOpt 走短路分支原样返回，不再解一次基准
  //    链路去取别的功放（那会把用户填的瓦数悄悄换成求解器自己算的那台）
  {
    const r = sweep('geo', 'tx', { mode: 'power', powerW: 40 });
    const p = r.pin;
    ok('设置功放功率方式：工作点原样沿用入参瓦数',
      !!p && p.kind === 'pa' && p.powerW === 40,
      p ? `${p.kind} / ${p.powerW} W` : '未回传工作点');
  }
  // 唯一不钉的轴：合成轴「目标余量」强制 mode='margin'，那根轴本身就在扫工作点。
  // 若这里也钉住，mode 会被换成 'power'，写进 margin 入参的轴值随即失效 —— 整根轴变成死值。
  {
    const r = sweepLink2D({
      engine: 'geo', satParams: SAT, linkParams: SITE, opt: { mode: 'margin' },
      x: { key: '_margin', min: 0, max: 6, steps: N },
      y: { key: 'latitude', target: 'link', min: LAT - HALF, max: LAT + HALF, steps: N },
      autoGeo: true
    });
    const arr = r.series.linkmargin;
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < arr.length; t++) { const v = arr[t]; if (v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
    ok('目标余量轴不钉工作点（钉了这根轴就失效）',
      r.pin === null && hi - lo > 5, `pin=${JSON.stringify(r.pin)} · 余量跨度 ${(hi - lo).toFixed(2)} dB`);
  }
}

// ⑬ 耗时实测（不作断言，供分辨率档位定档参考）
{
  for (const [mode, steps] of [['margin', 21], ['margin', 31], ['margin', 41], ['balance', 21], ['balance', 31], ['balance', 41]]) {
    const t0 = Date.now();
    const r = sweepLink2D({ engine: 'geo', satParams: SAT, linkParams: LINK, opt: { mode }, x: { ...AX_D, steps }, y: { ...AX_RD, steps } });
    const dt = Date.now() - t0;
    console.log(`      计时  mode=${mode.padEnd(7)} ${steps}×${steps}=${String(steps * steps).padStart(4)} 格  ${String(dt).padStart(5)} ms  (${(dt / (steps * steps)).toFixed(3)} ms/格, ok=${r.ok})`);
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
