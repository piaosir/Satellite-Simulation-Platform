// 雨衰计算纯核 精度/回归测试（无框架，纯断言）。运行： node packages/core/test/rainAttenuation.test.js
//
// 锚点 = 商业软件 SatMaster「Atmospheric Attenuation」算例（用户截图）：
//   站址 11°N / 111°E、GEO 轨位 125°E、14.5 GHz、圆极化、口径 13 m、效率 60%、
//   年可用度 99%、晴空系统噪温 121 K。
// 该软件用较旧 ITU 版本（云衰 P.840-8 等）；本平台用最新版（P.840-9 云衰更低，已验证正确，
// 见记忆 cloud-p840-9-validated）。故几何 / 降雨率 / 雨衰 / 停时应逐项吻合，而气体 / 云 /
// 闪烁 / XPD 因模型版本不同允许偏差——只校验其为有限且落在合理区间。
const fs = require('fs');
const path = require('path');
const core = require('../index.js');

// 注入全精度 ITU 数据（与 electron/main.js 一致），否则降雨率/云/气体走内嵌回退，与真机不符。
const ituDir = path.join(__dirname, '..', '..', '..', 'resources', 'itu');
const rd = (f) => { try { return fs.readFileSync(path.join(ituDir, f)); } catch (e) { return null; } };
const rep = core.loadFullPrecisionData({
  rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'),
  vapor: rd('p836_rho_v1.bin'), cloud: rd('p840_logn_v1.bin')
});

let pass = 0, fail = 0;
function approx(name, got, want, tol) {
  const g = parseFloat(got);
  const okk = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((okk ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${g}, want≈${want} ±${tol})`);
  okk ? pass++ : fail++;
}
function ok(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  cond ? pass++ : fail++;
}
function inRange(name, got, lo, hi) {
  const g = parseFloat(got);
  const okk = Number.isFinite(g) && g >= lo && g <= hi;
  console.log((okk ? 'PASS' : 'FAIL') + '  ' + name + `  (got=${g}, want∈[${lo},${hi}])`);
  okk ? pass++ : fail++;
}

console.log('=== rainAttenuation 精度/回归测试 ===\n');
ok('ITU 全精度数据注入', rep && rep.rain === true && rep.cloud === true);

// —— SatMaster GEO 锚点（用 satLon 便捷路径反算仰角；rainRate=0 → 自动 P.837）——
// feederLoss:0 → 不做馈线折算，与 SatMaster「System noise (clear)」口径可比
const ANCHOR = {
  lat: 11, lon: 111, satLon: 125, freq: 14.5, pol: 'C', diameter: 13, efficiency: 60,
  availability: 99, rainRate: 0, systemNoiseTemp: 121, direction: 'down', altitude: 0, feederLoss: 0
};
const r = core.calculateRainAttenuation(ANCHOR);
ok('锚点计算无错误', !r.error);

// 逐项吻合（几何 / 降雨率 / 雨衰 / 停时）
approx('仰角 ≈ 69.19°', r.elevation, 69.19, 0.2);
approx('方位角 ≈ 127.43°', r.azimuth, 127.43, 0.2);
approx('斜距 ≈ 36141.86 km', r.slantRange, 36141.86, 5);
approx('R0.01 自动 ≈ 106.65 mm/h', r.rainRate, 106.65, 0.5);
ok('R0.01 标记为自动', r.rainRateAuto === true);
approx('雨衰 ≈ 2.05 dB', r.rainAtten, 2.05, 0.15);
approx('年不可用时长 ≈ 87.66 h', r.downtimeYear, 87.66, 0.1);
approx('最坏月可用度 ≈ 97.15 %', r.worstMonthAvail, 97.15, 0.15);
approx('最坏月停时 ≈ 20.82 h', r.downtimeWorstMonth, 20.82, 0.1);

// 模型版本相关量：只校验有限 + 合理区间（不对 SatMaster 精确值）
inRange('气体吸收 合理', r.gasAtten, 0.05, 0.5);
inRange('云衰 合理(P.840-9)', r.cloudAtten, 0, 1.5);
inRange('对流层闪烁 合理', r.scintillation, 0, 0.5);
inRange('雨致 XPD 合理', r.rainXPD, 25, 50);
approx('合计=气体+云+雨', r.totalAtten, r.gasAtten + r.cloudAtten + r.rainAtten, 1e-6);

// 下行专属量存在
ok('下行 G/T 衰减 有值', Number.isFinite(r.gtDegradation) && r.gtDegradation > 0);
ok('下行 DND 有值', Number.isFinite(r.dnd) && r.dnd > 0);

// —— 统一噪声口径（雨+云 · T_mr=275K · 经馈线折算）——
approx('precipAtten = 雨衰 + 云衰', r.precipAtten, r.rainAtten + r.cloudAtten, 1e-9);
approx('DND = (雨衰+云衰) + 降雨噪声G/T衰减', r.dnd, r.precipAtten + r.gtDegradation, 1e-9);
ok('噪声增量与G/T衰减已统一为同一量', Math.abs(r.noiseIncrease - r.gtDegradation) < 1e-12);
ok('气体吸收不计入 DND', Math.abs(r.dnd - (r.totalAtten + r.gtDegradation)) > 1e-6 || r.gasAtten === 0);
// 馈线折算：馈线损耗越大 → 天空噪声折算到参考点后越小 → G/T 衰减越小
const rFeed0 = core.calculateRainAttenuation({ ...ANCHOR, feederLoss: 0 });
const rFeed1 = core.calculateRainAttenuation({ ...ANCHOR, feederLoss: 1.0 });
ok('馈线损耗↑ → G/T衰减↓（经馈线折算）', rFeed1.gtDegradation < rFeed0.gtDegradation);
ok('馈线=0 即退化为不折算口径', Math.abs(rFeed0.gtDegradation - r.gtDegradation) < 1e-12);

// —— 仰角越界防呆 ——
ok('仰角 >90° 报错', core.calculateRainAttenuation({ ...ANCHOR, satLon: undefined, elevation: 120 }).error === true);
ok('仰角 ≤0° 报错', core.calculateRainAttenuation({ ...ANCHOR, satLon: undefined, elevation: -5 }).error === true);

// —— 通用性：纯仰角（无 satLon，非 GEO 也能算）——
const rg = core.calculateRainAttenuation({
  lat: 11, lon: 111, elevation: 30, freq: 14.5, pol: 'V', diameter: 2.4, efficiency: 60,
  availability: 99.5, rainRate: 60, systemNoiseTemp: 150, direction: 'down'
});
ok('纯仰角算例无错误', !rg.error);
approx('纯仰角=30° 原样采用', rg.elevation, 30, 1e-6);
ok('无 satLon → 方位角为空', rg.azimuth === null);
ok('无 satLon → 斜距为空', rg.slantRange === null);
ok('纯仰角 雨衰为正', rg.rainAtten > 0);
// 低仰角(30°)斜路径更长，同降雨率下雨衰应大于高仰角(69°)同 100mm/h 量级——此处只验证物理有值
ok('纯仰角 下行 G/T 衰减有值', Number.isFinite(rg.gtDegradation));

// —— 上行方向 → 无 G/T 衰减 ——
const ru = core.calculateRainAttenuation({
  lat: 11, lon: 111, elevation: 45, freq: 14.5, pol: 'V', diameter: 3, efficiency: 60,
  availability: 99.9, rainRate: 80, systemNoiseTemp: 121, direction: 'up'
});
ok('上行方向 G/T 衰减为空', ru.gtDegradation === null && ru.dnd === null);
ok('上行方向 雨衰仍计算', ru.rainAtten > 0);

// —— 曲线扫描：单调性 ——
const swR = core.sweepRainAttenuation(
  { lat: 11, lon: 111, elevation: 45, freq: 14.5, pol: 'C', availability: 99 },
  'rainRate', { min: 0, max: 120, steps: 25 }
);
ok('降雨率扫描点数正确', swR.points.length === 25);
ok('降雨率=0 → 雨衰≈0', Math.abs(swR.points[0].y) < 1e-6);
ok('雨衰随降雨率单调不减', swR.points.every((p, i) => i === 0 || p.y >= swR.points[i - 1].y - 1e-9));
const swF = core.sweepRainAttenuation(
  { lat: 11, lon: 111, elevation: 45, pol: 'C', availability: 99, rainRate: 60 },
  'frequency', { min: 4, max: 30, steps: 20 }
);
ok('频率扫描点数正确', swF.points.length === 20);
ok('雨衰随频率总体上升', swF.points[swF.points.length - 1].y > swF.points[0].y);

// ---------------------------------------------------------------------------
// 4~6 GHz 雨致 XPD：递归进 6 GHz 公式时必须换成 **6 GHz 上的** 雨衰
//
// §4.1 的下界是 6 GHz，C 频段要先算「6 GHz 的 XPD」再按 §4.3 式(79) 标度下来。
// Step 2 的 CA = V(f)·lg(Ap) 里 V(6)=21.6 配套的就是 6 GHz 的 CPA 统计；曾沿用本频率
// 那个小得多的雨衰（C 段 γ(6)/γ(4)≈6），CA 少算十几 dB、XPD 高报 16~17 dB。
// ---------------------------------------------------------------------------
{
  const site = { lat: 23.13, lon: 113.26, elevation: 50.38, pol: 'C', availability: 99.9, rainRate: 80, diameter: 7.3, efficiency: 65, direction: 'down' };
  const p = 100 - site.availability, tau = 45;             // 圆极化：τ=45°，与几何无关
  const at = (f) => core.calculateRainAttenuation({ ...site, freq: f }).rainXPD;

  // 测试侧独立走一遍严格路径：A001@6GHz → Ap(p)@6GHz → XPD(6) → −20lg(f/6)
  const strict = (f) => {
    const { A001 } = core.geo.calculateSinglePathRainAttenuation(site.rainRate, 6, site.pol, site.lat, site.lon, null, 0, site.elevation);
    const ap6 = core.geo.scaleRainAttenP618_14(A001, p, site.lat, site.elevation);
    return core.geo.calculateRainXPD_P618_14(ap6, 6, tau, site.elevation, p) - 20 * Math.log10(f / 6);
  };
  // 旧口径（本频率的雨衰直接喂进 6 GHz 公式）——用来证明两者真的差着双位数
  const legacy = (f) => {
    const { A001 } = core.geo.calculateSinglePathRainAttenuation(site.rainRate, f, site.pol, site.lat, site.lon, null, 0, site.elevation);
    const apf = core.geo.scaleRainAttenP618_14(A001, p, site.lat, site.elevation);
    return core.geo.calculateRainXPD_P618_14(apf, 6, tau, site.elevation, p) - 20 * Math.log10(f / 6);
  };

  const a6 = core.geo.scaleRainAttenP618_14(
    core.geo.calculateSinglePathRainAttenuation(site.rainRate, 6, site.pol, site.lat, site.lon, null, 0, site.elevation).A001,
    p, site.lat, site.elevation);
  const a4 = core.geo.scaleRainAttenP618_14(
    core.geo.calculateSinglePathRainAttenuation(site.rainRate, 4, site.pol, site.lat, site.lon, null, 0, site.elevation).A001,
    p, site.lat, site.elevation);
  ok('前提：C 段雨衰随频率极陡（Ap@6GHz 是 Ap@4GHz 的数倍）', a6 / a4 > 4, `${a4.toFixed(4)} → ${a6.toFixed(4)} dB（×${(a6 / a4).toFixed(2)}）`);

  approx('4.0 GHz XPD = 由 6 GHz 雨衰算出再标度', at(4.0), strict(4.0), 1e-9);
  approx('4.2 GHz XPD = 由 6 GHz 雨衰算出再标度', at(4.2), strict(4.2), 1e-9);
  approx('5.925 GHz XPD = 由 6 GHz 雨衰算出再标度', at(5.925), strict(5.925), 1e-9);
  ok('与旧口径确实差着双位数 dB（4.0 GHz）', legacy(4.0) - at(4.0) > 10,
    `旧 ${legacy(4.0).toFixed(2)} vs 现 ${at(4.0).toFixed(2)}，差 ${(legacy(4.0) - at(4.0)).toFixed(2)} dB`);
  ok('越靠近 6 GHz 两口径越收敛（5.925 处差 < 1 dB）', legacy(5.925) - at(5.925) < 1);

  // 6 GHz 接缝：标度支与主支必须接得上
  ok('6 GHz 接缝连续（5.999 vs 6.001 差 < 0.01 dB）', Math.abs(at(5.999) - at(6.001)) < 0.01,
    `${at(5.999).toFixed(4)} vs ${at(6.001).toFixed(4)}`);
  // f≥6 主路径不受影响
  approx('6.5 GHz 走主路径（不经标度）', at(6.5),
    core.geo.calculateRainXPD_P618_14(
      core.geo.scaleRainAttenP618_14(core.geo.calculateSinglePathRainAttenuation(site.rainRate, 6.5, site.pol, site.lat, site.lon, null, 0, site.elevation).A001, p, site.lat, site.elevation),
      6.5, tau, site.elevation, p), 1e-9);
  ok('f<4 GHz 不计雨致去极化（超出 §4.3 标度下界）', core.calculateRainAttenuation({ ...site, freq: 3.8 }).rainXPD === null);

  // 健壮性：重算路径要按 6 GHz 再查一次 P.837/P.838，极干旱站也得算得出来（不抛错）
  const dry = core.calculateRainAttenuation({ ...site, lat: 23.4, lon: 12.0, rainRate: 5, freq: 4.0 });   // 撒哈拉腹地、小雨
  ok('极干旱站 C 频段 XPD 仍算得出（雨衰趋 0 → XPD 很高）', Number.isFinite(dry.rainXPD) && dry.rainXPD > 50,
    `R001=${dry.rainRate} mm/h，雨衰 ${dry.rainAtten.toFixed(5)} dB，XPD ${dry.rainXPD.toFixed(2)} dB`);
  ok('雨越小 XPD 越高（去极化单调性，C 频段标度支）',
    core.calculateRainAttenuation({ ...site, lat: 23.4, lon: 12.0, rainRate: 2, freq: 4.0 }).rainXPD > dry.rainXPD);
  // 缺上下文必须显式报错，不许退回「拿本频率雨衰硬算」那种静默高报 16~17 dB 的老路
  let threw = false;
  try { core.geo.calculateRainXPD_P618_14(0.074, 4.0, tau, site.elevation, p); } catch (e) { threw = /重算雨衰|rainCtx/.test(e.message); }
  ok('4~6 GHz 缺 rainCtx → 显式抛错（不静默沿用本频率雨衰）', threw);
  ok('f≥6 GHz 不需要 rainCtx（Ku/Ka 调用方零改动）',
    Number.isFinite(core.geo.calculateRainXPD_P618_14(3.5, 12.5, tau, site.elevation, p)));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
