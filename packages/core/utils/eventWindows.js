// eventWindows.js — 通用事件窗口求解器（平台化基石件）
//
// 把「窗口类」分析统一成一个抽象：给定标量函数 f(t)，约定 f(t) > 0 表示"在窗口内"，
// 返回 [t0, t1] 区间内全部窗口 [{ start, end, peak }]。
//   - 日凌窗口：  f(t) = θ_th − 太阳夹角(t)          （恶化超门限）
//   - 可见窗口：  f(t) = 仰角(t) − 最低仰角           （Access，P2）
//   - ISL 通视：  f(t) = 视线离地高度(t) − 掠射门限    （P2）
// f(t) 返回 NaN / null / undefined 视为「窗口外」（如太阳在地平线下、卫星无星历段）。
//
// 算法：粗扫步长 coarseStep 找符号翻转 → 边界二分精炼到 tol → 窗口内细扫+二分找极值。
// 前提：f 在窗口边界附近连续单调（物理量普遍满足）；窗口宽度 < coarseStep 时可能漏检，
// 调用方应按事件的最短时标选粗扫步长（日凌分钟级 → 15s 足够）。

'use strict';

/**
 * @param {(t:number)=>number} f     标量函数，>0 在窗口内；NaN/null 视为窗口外
 * @param {number} t0                扫描起点（时间单位由调用方定义，秒/分皆可）
 * @param {number} t1                扫描终点
 * @param {object} [opts]
 * @param {number} [opts.coarseStep=15]  粗扫步长
 * @param {number} [opts.tol=1]          边界精度（二分终止条件）
 * @param {boolean} [opts.findPeak=true] 是否求窗口内 f 的最大值点
 * @returns {Array<{start:number, end:number, peak:{t:number, value:number}|null}>}
 */
function findWindows(f, t0, t1, opts) {
  opts = opts || {};
  var step = opts.coarseStep > 0 ? opts.coarseStep : 15;
  var tol = opts.tol > 0 ? opts.tol : 1;
  var findPeak = opts.findPeak !== false;

  var inside = function (v) { return typeof v === 'number' && isFinite(v) && v > 0; };

  var windows = [];
  var prevT = t0;
  var prevIn = inside(f(t0));
  var openT = prevIn ? t0 : null;   // 窗口在扫描起点已开启 → start 记为 t0（不外推）

  for (var t = t0 + step; ; t += step) {
    if (t > t1) t = t1;
    var curIn = inside(f(t));
    if (curIn && !prevIn) {
      openT = bisectBoundary(f, prevT, t, tol, inside);      // 外→内：精炼开始边界
    } else if (!curIn && prevIn) {
      var endT = bisectBoundary(f, t, prevT, tol, inside);   // 内→外：精炼结束边界
      if (openT != null && endT > openT) {
        windows.push(makeWindow(f, openT, endT, tol, findPeak));
      }
      openT = null;
    }
    prevT = t; prevIn = curIn;
    if (t >= t1) break;
  }
  // 扫描终点仍在窗口内 → end 记为 t1（截断，不外推）
  if (openT != null && prevIn && t1 > openT) {
    windows.push(makeWindow(f, openT, t1, tol, findPeak));
  }
  return windows;
}

// 二分精炼边界：outT 在窗口外、inT 在窗口内，收敛到 |区间| <= tol 后返回窗口内侧端点。
function bisectBoundary(f, outT, inT, tol, inside) {
  var lo = outT, hi = inT;
  while (Math.abs(hi - lo) > tol) {
    var mid = (lo + hi) / 2;
    if (inside(f(mid))) hi = mid; else lo = mid;
  }
  return hi;
}

// 窗口内求 f 最大值点：先按 ~64 份细扫锁定粗峰，再三分法收敛到 tol。
function makeWindow(f, start, end, tol, findPeak) {
  var w = { start: start, end: end, peak: null };
  if (!findPeak) return w;

  var n = 64;
  var fine = Math.max((end - start) / n, tol);
  var bestT = start, bestV = -Infinity;
  for (var t = start; t <= end; t += fine) {
    var v = f(t);
    if (typeof v === 'number' && isFinite(v) && v > bestV) { bestV = v; bestT = t; }
  }
  // 三分法在 [bestT-fine, bestT+fine] 内收敛（f 在峰附近单峰）
  var lo = Math.max(start, bestT - fine), hi = Math.min(end, bestT + fine);
  while (hi - lo > tol) {
    var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    var v1 = f(m1), v2 = f(m2);
    if (!(typeof v1 === 'number' && isFinite(v1))) { lo = m1; continue; }
    if (!(typeof v2 === 'number' && isFinite(v2))) { hi = m2; continue; }
    if (v1 < v2) lo = m1; else hi = m2;
  }
  var pt = (lo + hi) / 2;
  var pv = f(pt);
  if (!(typeof pv === 'number' && isFinite(pv)) || pv < bestV) { pt = bestT; pv = bestV; }
  w.peak = { t: pt, value: pv };
  return w;
}

module.exports = { findWindows: findWindows };
