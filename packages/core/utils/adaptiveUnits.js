// utils/adaptiveUnits.js
// 结果显示单位自适应：W/Hz/bps 这类线性可缩放单位按数值大小挑最易读档位
// （0.5 W → 500 mW、2457.6 kHz → 2.4576 MHz），纯功率 dBW 在整组值 <0 dBW（<1 W，
// 小站接收/发射电平场景）时改记 dBm。只改「显示」层（瀑布行 / 结果列 / 报告汇总），
// 引擎结果字段与入参口径一律不动。
//
// 渲染端镜像：src/shared/adaptUnits.js（Vite ESM 无法直接吃本 CJS 文件；两边档位表与
// 规则须保持一致，改这里记得同步那边）。

// ============ 线性单位族（同族内 值×f 归一到基准单位） ============
const FAMILIES = {
  Hz: [['Hz', 1], ['kHz', 1e3], ['MHz', 1e6], ['GHz', 1e9]],
  bps: [['bps', 1], ['kbps', 1e3], ['Mbps', 1e6], ['Gbps', 1e9]],
  sps: [['sps', 1], ['ksps', 1e3], ['Msps', 1e6], ['Gsps', 1e9]],
  cps: [['cps', 1], ['kcps', 1e3], ['Mcps', 1e6], ['Gcps', 1e9]],
  W: [['µW', 1e-6], ['mW', 1e-3], ['W', 1], ['kW', 1e3], ['MW', 1e6]]
};
const UNIT_INDEX = {};
for (const fam of Object.keys(FAMILIES)) {
  for (const pair of FAMILIES[fam]) UNIT_INDEX[pair[0]] = { fam, f: pair[1] };
}

// 按最大绝对值挑档位（尾数落在 [1, 1000)；低于最小档用最小档、高于最大档用最大档）。
// 返回 { unit, factor }（新值 = 旧值 × factor）；单位不认识 / 无须换档返回 null。
function pickUnit(maxAbs, unit) {
  const info = UNIT_INDEX[unit];
  if (!info || !isFinite(maxAbs) || maxAbs <= 0) return null;
  const base = maxAbs * info.f;
  const steps = FAMILIES[info.fam];
  let chosen = steps[0];
  for (const s of steps) { if (base / s[1] >= 1) chosen = s; }
  if (chosen[0] === unit) return null;
  return { unit: chosen[0], factor: info.f / chosen[1] };
}

// 换档后的数值格式：最多 4 位小数并去尾零（2.4576 MHz 不丢精度、36.0000 → 36）
function fmtScaled(n) {
  return isFinite(n) ? String(parseFloat(n.toFixed(4))) : String(n);
}

// 一组同量纲数值（结果列 / 汇总行）共选一个显示单位：线性族按最大|值|挑档；
// dBW 仅当全组 < 0 dBW（< 1 W）才整组转 dBm。返回 { unit, conv } 或 null（不换）。
function pickColumn(vals, unit) {
  const nums = (vals || []).filter((n) => isFinite(n));
  if (!nums.length) return null;
  if (unit === 'dBW') {
    if (Math.max.apply(null, nums) < 0) return { unit: 'dBm', conv: (v) => v + 30 };
    return null;
  }
  const p = pickUnit(Math.max.apply(null, nums.map(Math.abs)), unit);
  return p ? { unit: p.unit, conv: (v) => v * p.factor } : null;
}

// ============ 瀑布 segments 后处理（buildWaterfallSegments 出口统一调用） ============
// 多列行（上/下行/合计共用一个单位格）按各列最大|值|共选档位，保证同行可横向比较。
// dBW→dBm 只动独立参考/指标行（ref/kpi）：级联算式行（base/gain/loss/sub/chk/margin）
// 是「逐行可手算」的 dB 功率链，检查点换 dBm 会让上下行加减对不上，一律不动。
const CHAIN_KINDS = { base: 1, gain: 1, loss: 1, sub: 1, chk: 1, margin: 1 };
const COLS_OF = { 1: ['up'], 2: ['up', 'down'], 3: ['up', 'down', 'total'] };
// 显示列 → 同行的机读数值字段（waterfallBuilder 挂的 num/numDown/numTotal）。
// 换档改的是显示串，机读值必须跟着改：不然 -18.393 dBm 的格子背后还挂着 -48.393（dBW 原值），
// 屏幕与 Excel 就是两套数。一律按换档后的显示串回解，保证两者永远同一个数。
const NUM_OF = { up: 'num', down: 'numDown', total: 'numTotal' };
function syncNum(row, c) {
  const f = NUM_OF[c];
  if (!f || !Object.prototype.hasOwnProperty.call(row, f)) return;   // 旧记录没有这些字段，不凭空添
  const n = parseFloat(row[c]);
  row[f] = isFinite(n) ? n : null;
}

function adaptSegments(segments) {
  if (!Array.isArray(segments)) return segments;
  for (const seg of segments) {
    if (!seg || !Array.isArray(seg.rows)) continue;
    const cols = COLS_OF[seg.cols] || ['up'];
    for (const row of seg.rows) {
      if (!row || !row.unit) continue;
      const nums = [];
      for (const c of cols) { const n = parseFloat(row[c]); if (isFinite(n)) nums.push(n); }
      if (!nums.length) continue;
      if (UNIT_INDEX[row.unit]) {
        const p = pickUnit(Math.max.apply(null, nums.map(Math.abs)), row.unit);
        if (!p) continue;
        for (const c of cols) { const n = parseFloat(row[c]); if (isFinite(n)) { row[c] = fmtScaled(n * p.factor); syncNum(row, c); } }
        // 标签里写死的单位后缀跟着换：'功放建议值(W)' / 'Recommended PA Value (W)' → (mW)
        if (typeof row.label === 'string' && row.label.indexOf('(' + row.unit + ')') >= 0) {
          row.label = row.label.replace('(' + row.unit + ')', '(' + p.unit + ')');
        }
        row.unit = p.unit;
        if (row.unitKey) row.unitKey = p.unit;   // 单位原文跟着指向换档后的单位，与 unit 始终同一个
      } else if (row.unit === 'dBW' && !CHAIN_KINDS[row.kind] && Math.max.apply(null, nums) < 0) {
        for (const c of cols) { const n = parseFloat(row[c]); if (isFinite(n)) { row[c] = fmtScaled(n + 30); syncNum(row, c); } }
        row.unit = 'dBm';
        if (row.unitKey) row.unitKey = 'dBm';
      }
    }
  }
  return segments;
}

module.exports = { FAMILIES, pickUnit, fmtScaled, pickColumn, adaptSegments };
