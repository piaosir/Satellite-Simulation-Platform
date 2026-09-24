// 解析高斯天线（STK Gaussian）—— 主进程 CommonJS 镜像。
// 渲染端原件：src/viz/grd/gaussStk.js（Vite 不转本地 CJS，故两份；求值 / 铺网格改动须两处对照，
// packages/core/test/gaussStk.test.mjs 逐位对拍）。这里只留主进程要的：认记录、求值、铺网格（给 .grdbin）。
'use strict';

const AN_FORMAT = 'satsim-analytic-antenna';
const AN_WIN = 2.0;
const K_STK = 2.76, K_4LN2 = 4 * Math.LN2;
const D2R = Math.PI / 180;
const kDbOf = (kind) => 10 * Math.LOG10E * (kind === '4ln2' ? K_4LN2 : K_STK);

function isAnalyticText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trimStart();
  return t.charAt(0) === '{' && t.indexOf(AN_FORMAT) >= 0;
}
function parseRecord(text) {
  const r = JSON.parse(text);
  if (!r || r.format !== AN_FORMAT || !Array.isArray(r.beams) || !r.beams.length) throw new Error('不是解析天线记录');
  for (const b of r.beams) {
    if (![b.az, b.el, b.th3, b.g0, b.back].every((v) => Number.isFinite(+v)) || !(+b.th3 > 0)) throw new Error('解析天线记录损坏');
  }
  return r;
}
function anBeamOf(b, win) {
  const az = +b.az * D2R, el = +b.el * D2R, ca = Math.cos(az), th = +b.th3 * D2R;
  return { igrid: 6, az: +b.az, el: +b.el, th3: +b.th3, g0: +b.g0, back: +b.back, k: b.k === '4ln2' ? '4ln2' : 'stk',
    bx: -Math.sin(az), by: ca * Math.sin(el), bz: ca * Math.cos(el), inv: 1 / (th * th), kdb: kDbOf(b.k), win: +win > 0 ? +win : AN_WIN };
}
function anGainDbi(an, ux, uy, uz) {
  const c = ux * an.bx + uy * an.by + uz * an.bz;
  const cx = uy * an.bz - uz * an.by, cy = uz * an.bx - ux * an.bz, cz = ux * an.by - uy * an.bx;
  const th = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), c);
  if (th > Math.PI / 2) return an.back;
  return an.g0 - an.kdb * th * th * an.inv;
}
const resFor = (n) => (n <= 4 ? 101 : n <= 16 ? 81 : n <= 48 ? 61 : n <= 120 ? 49 : n <= 400 ? 37 : n <= 1200 ? 29 : 23);
function anWindow(an) {
  const R = an.win * an.th3;
  const XS = Math.max(-89.9, an.az - R), XE = Math.min(89.9, an.az + R);
  const xm = Math.min(89.9, Math.abs(an.az) + R);
  const hy = R / Math.cos(xm * D2R);
  const YS = Math.max(-179.9, an.el - hy), YE = Math.min(179.9, an.el + hy);
  return { XS, YS, XE, YE };
}
// 单波束 → { XS,YS,XE,YE,NX,NY, c1re,c1im,c2re,c2im, an }（与 grdSampler.parseGrd 的 set 同形）
function materializeBeam(an, res) {
  const { XS, YS, XE, YE } = anWindow(an);
  const NX = res, NY = res, N = NX * NY;
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1);
  const c1re = new Float32Array(N), z = new Float32Array(N);
  for (let row = 0; row < NY; row++) {
    const el = (YS + dy * row) * D2R, se = Math.sin(el), ce = Math.cos(el);
    for (let col = 0; col < NX; col++) {
      const az = (XS + dx * col) * D2R, ca = Math.cos(az);
      c1re[row * NX + col] = Math.sqrt(Math.pow(10, anGainDbi(an, -Math.sin(az), ca * se, ca * ce) / 10));
    }
  }
  return { XS, YS, XE, YE, NX, NY, c1re, c1im: z, c2re: z, c2im: z, an };
}
// 记录文本 → grdSampler.parseGrd 同形对象（每个 set 多带一个 an 描述子）
function materializeText(text) {
  const rec = parseRecord(text);
  const ans = rec.beams.map((b) => anBeamOf(b, rec.win));
  const res = resFor(ans.length);
  return { ktype: 1, nset: ans.length, icomp: 3, ncomp: 2, igrid: 6, sets: ans.map((an) => materializeBeam(an, res)), rec };
}

module.exports = { AN_FORMAT, AN_WIN, kDbOf, isAnalyticText, parseRecord, anBeamOf, anGainDbi, resFor, anWindow, materializeBeam, materializeText };
