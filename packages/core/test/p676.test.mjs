// ITU-R P.676-13 附件 1 逐线法比衰减测试（无框架，纯断言）。
//   运行： node packages/core/test/p676.test.mjs
//
// 期望值来源：ITU-R 第 3 研究组地空传播验证例集 CG-3M3J-13-ValEx-Rev8.3.0.xlsx 的「P.676-13 SpAtt」页
// （p = 1013.25 hPa、T = 288.15 K、ρ = 7.5 g/m³；1–350 GHz 逐 1 GHz 扫描 + 12/20/60/90/130 GHz 单点），
// 夹具 fixtures/itu_p676_13_spatt.json 记录来源 URL、xlsx 的 SHA-256 与单元格范围。
// 这份 γo、γw 也是 P.452-18 式 (9) 的气体吸收口径（p452.test.mjs 的 Lbfsg / Lbs / Lba 对拍间接覆盖 0.1–50 GHz）。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const G = require('../utils/terrestrial/p676.js');
const fx = require('./fixtures/itu_p676_13_spatt.json');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
};
const approx = (name, got, want, tol) => {
  const g = Number(got);
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol;
  console.log((c ? 'PASS' : 'FAIL') + `  ${name}  (got=${Number.isFinite(g) ? g.toPrecision(10) : g}, want≈${want} ±${tol})`);
  c ? pass++ : fail++;
};

const { pHPa, tempK, rho } = fx.conditions;

console.log('=== 单点（12/20/60/90/130 GHz）===');
for (const [f, go, gw] of fx.points) {
  const r = G.specificAttenuation(f, pHPa, rho, tempK);
  approx(`${f} GHz γo`, r.gammaO, go, Math.max(1e-12, go * 1e-10));
  approx(`${f} GHz γw`, r.gammaW, gw, Math.max(1e-12, gw * 1e-10));
}

console.log('\n=== 1–350 GHz 扫描 ===');
{
  let mo = 0, mw = 0, wo = 0, ww = 0;
  for (const [f, go, gw] of fx.sweep) {
    const r = G.specificAttenuation(f, pHPa, rho, tempK);
    const ro = Math.abs(r.gammaO - go) / go, rw = Math.abs(r.gammaW - gw) / gw;
    if (ro > mo) { mo = ro; wo = f; }
    if (rw > mw) { mw = rw; ww = f; }
  }
  ok(`扫描点数 = 350`, fx.sweep.length === 350, String(fx.sweep.length));
  ok('γo 最大相对偏差 ≤ 1e−10', mo <= 1e-10, `${mo.toExponential(2)} @ ${wo} GHz`);
  ok('γw 最大相对偏差 ≤ 1e−10', mw <= 1e-10, `${mw.toExponential(2)} @ ${ww} GHz`);
}

console.log('\n=== 物理自洽 ===');
{
  const dry = G.specificAttenuation(22.235, 1013.25, 0, 288.15);
  ok('ρ = 0 时 γw = 0', dry.gammaW === 0);
  const a = G.specificAttenuation(22.235, 1013.25, 7.5, 288.15).gammaW, b = G.specificAttenuation(22.235, 1013.25, 15, 288.15).gammaW;
  // 线强 Si ∝ e ∝ ρ；线宽 Δf 随 e 增大（式 (6a) 自展宽项 b5·e），线中心峰值 ∝ Si/Δf → 略低于 2 倍
  ok('22.235 GHz 线中心：ρ 加倍 γw 略低于 2 倍（自展宽）', b > 1.9 * a && b < 2 * a, `${(b / a).toFixed(4)}`);
  const o60 = G.specificAttenuation(60, 1013.25, 7.5, 288.15).gammaO, o50 = G.specificAttenuation(50, 1013.25, 7.5, 288.15).gammaO;
  ok('60 GHz 氧吸收带远强于 50 GHz', o60 > 10 * o50, `${o60.toFixed(3)} / ${o50.toFixed(3)} dB/km`);
  ok('表 1 氧 44 线、表 2 水汽 35 线', G.OXYGEN.length === 44 && G.WATER.length === 35);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
