// 太阳射电流量 F10.7 —— 四个 NOAA SWPC 产品的解析、合并与「按日期取值」的纯函数层。
// 主进程 electron/services/solarFlux.js 只负责 I/O（联网 / 落盘 / 云镜像 / 内置快照），
// 规则全在这里，于是测试钉得住（packages/core/test/solarFlux.test.mjs）。
//
// 合并数据形状（也是落盘与内置快照的形状，见 resources/space-weather/solar-flux.json）：
//   { fetchedAt, products: {
//       daily30:    { at, data: { 'YYYY-MM-DD': sfu } },          // 30 天观测日值（20 UT 那次）
//       forecast45: { at, data: { 'YYYY-MM-DD': sfu } },          // 45 天预报
//       monthly:    { at, data: { 'YYYY-MM': sfu } },             // 观测月均（1947 起）
//       predicted:  { at, data: { 'YYYY-MM': { f, lo, hi } } }    // 太阳周预测月均
//   } }
// 四个产品各自带 at（各自成功抓取的时刻）：某一个抓失败只保留旧的那一份，其余照更新（部分刷新）。
//
// 取值口径（f107For，见任务书 §5.3）：目标日 = 该季分点日，窗口 ±20 天（日凌事件就落在分点前后
// 两三周），逐日 → 观测月均 → 预测月均 → 预测末值 → 缺省 120，五级各自标明 source。

var F107_DEFAULT = 120;         // 与引擎 sunOutageCalculator.js 的 F107_DEFAULT 同值
var MONTHLY_FROM = 1947;        // SWPC 观测月均里 F10.7 自 1947 才有（更早的行是 -1）
var TAIL_YEARS = 5;             // 预测末值外推的上限：最后一个预测月之后 5 年内才敢给数

/* ============================ 四个产品的解析 ============================ */

function asJson(text) {
  if (text == null) return null;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch (e) { return null; }
}
var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
var numOr = function (v, d) { var x = Number(v); return Number.isFinite(x) ? x : d; };

/** 30 天观测日值：[{ time_tag:'2026-08-22T20:00:00', flux:124 }] → { 'YYYY-MM-DD': sfu } */
function parseDaily30(text) {
  var arr = asJson(text), out = {};
  if (!Array.isArray(arr)) return out;
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i] || {};
    var d = String(r.time_tag || r.time || '').slice(0, 10);
    var v = numOr(r.flux, NaN);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v > 0) out[d] = v;
  }
  return out;
}

var MON3 = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * 45 天预报（纯文本）：`45-DAY F10.7 CM FLUX FORECAST` 块下每行 5 对 `21Sep26 105`，
 * 到 `FORECASTER:` 行为止。两位年按 2000+ 解（这份产品只发未来 45 天）。
 */
function parseForecast45(text) {
  var out = {};
  if (typeof text !== 'string' || !text) return out;
  var lines = text.split(/\r?\n/);
  var on = false;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/45-DAY\s+F10\.7\s*CM\s+FLUX\s+FORECAST/i.test(ln)) { on = true; continue; }
    if (!on) continue;
    if (/^\s*(FORECASTER|:|#|99999)/i.test(ln)) { if (/FORECASTER|99999/i.test(ln)) break; continue; }
    if (/45-DAY\s+AP\s+FORECAST/i.test(ln)) break;          // 顺序颠倒时也不会串块
    var re = /(\d{1,2})([A-Za-z]{3})(\d{2})\s+(\d+)/g, m;
    while ((m = re.exec(ln))) {
      var mon = MON3[m[2].toUpperCase()];
      var v = Number(m[4]);
      if (!mon || !(v > 0)) continue;
      out[(2000 + Number(m[3])) + '-' + pad2(mon) + '-' + pad2(Number(m[1]))] = v;
    }
  }
  return out;
}

/** 观测月均：[{ 'time-tag':'2026-08', 'f10.7':116.22 }] → { 'YYYY-MM': sfu }（-1 = 缺，1947 前不留） */
function parseMonthly(text) {
  var arr = asJson(text), out = {};
  if (!Array.isArray(arr)) return out;
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i] || {};
    var ym = String(r['time-tag'] || r.time_tag || '').slice(0, 7);
    var v = numOr(r['f10.7'], NaN);
    if (!/^\d{4}-\d{2}$/.test(ym) || !(v > 0)) continue;
    if (Number(ym.slice(0, 4)) < MONTHLY_FROM) continue;
    out[ym] = v;
  }
  return out;
}

/** 太阳周预测月均：[{ 'time-tag':'2026-09', predicted_f10.7, low_f10.7, high_f10.7 }] → { 'YYYY-MM': {f,lo,hi} } */
function parsePredicted(text) {
  var arr = asJson(text), out = {};
  if (!Array.isArray(arr)) return out;
  for (var i = 0; i < arr.length; i++) {
    var r = arr[i] || {};
    var ym = String(r['time-tag'] || r.time_tag || '').slice(0, 7);
    var f = numOr(r['predicted_f10.7'], NaN);
    if (!/^\d{4}-\d{2}$/.test(ym) || !(f > 0)) continue;
    out[ym] = {
      f: f,
      lo: numOr(r['low_f10.7'], null),
      hi: numOr(r['high_f10.7'], null)
    };
  }
  return out;
}

var PRODUCTS = ['daily30', 'forecast45', 'monthly', 'predicted'];
var PARSER = {
  daily30: parseDaily30, forecast45: parseForecast45, monthly: parseMonthly, predicted: parsePredicted
};

/* ============================ 合并（部分刷新）============================ */

/**
 * 旧快照 + 本轮抓到的若干产品 → 新快照。
 * fresh：{ daily30: text|null, … }，某个产品缺席 / 解不出条目 → 保留旧的那一份（部分刷新）。
 * at：本轮的抓取时刻，只写给真正更新了的产品。
 */
function mergeProducts(prev, fresh, at) {
  var p0 = (prev && prev.products) || {};
  var stamp = at || new Date().toISOString();
  var products = {};
  var any = false;
  for (var i = 0; i < PRODUCTS.length; i++) {
    var k = PRODUCTS[i];
    var got = fresh && fresh[k] != null ? PARSER[k](fresh[k]) : null;
    if (got && Object.keys(got).length) { products[k] = { at: stamp, data: got }; any = true; }
    else if (p0[k] && p0[k].data) products[k] = { at: p0[k].at || null, data: p0[k].data };
  }
  return {
    fetchedAt: any ? stamp : ((prev && prev.fetchedAt) || null),
    products: products
  };
}

/* ============================ 按日期取值 ============================ */

var dayMs = function (iso) { var t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(t) ? t : NaN; };
var isoOf = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
var daysInMonth = function (y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
var monthStartMs = function (ym) { return Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1); };
var monthEndMs = function (ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return Date.UTC(y, m - 1, daysInMonth(y, m)) + 86400e3 - 1;
};
// 月中点：按该月实际天数取一半 —— 预测月均代表的是整月，插值锚在月中最合理
var monthMidMs = function (ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return Date.UTC(y, m - 1, 1) + daysInMonth(y, m) * 86400e3 / 2;
};
var lerp = function (a, b, t) { return (a == null || b == null) ? null : a + (b - a) * t; };

/**
 * 目标日期 → F10.7 取值。
 * @param data  合并数据（solarFlux.snapshot() 的返回，或内置快照解出来的对象）
 * @param dateIso 目标日 'YYYY-MM-DD'（日凌用的是该季分点日，由 core.equinoxDateOf 给）
 * @param opts  { windowDays:20 } 逐日均值的半窗
 * @returns { f107, source, at, fetchedAt, low, high }
 *   source：daily 观测 / forecast45 含预报 / monthly 观测月均 / predicted 预测 / predicted-tail 预测末值 / default 缺省
 */
function f107For(data, dateIso, opts) {
  var o = opts || {};
  var win = Number.isFinite(Number(o.windowDays)) ? Number(o.windowDays) : 20;
  var minDays = Number.isFinite(Number(o.minDays)) ? Number(o.minDays) : 10;
  var fetchedAt = (data && data.fetchedAt) || null;
  var miss = { f107: F107_DEFAULT, source: 'default', at: null, fetchedAt: fetchedAt, low: null, high: null };
  var t0 = dayMs(dateIso);
  if (!Number.isFinite(t0)) return miss;
  var P = (data && data.products) || {};

  // ① 逐日：30 天观测 + 45 天预报合成一条日序列（同一天两者都有取观测），窗口内 ≥ minDays 天取均值
  var obs = (P.daily30 && P.daily30.data) || {};
  var fc = (P.forecast45 && P.forecast45.data) || {};
  if (Object.keys(obs).length || Object.keys(fc).length) {
    var sum = 0, n = 0, anyFc = false;
    for (var d = -win; d <= win; d++) {
      var key = isoOf(t0 + d * 86400e3);
      var v = obs[key];
      if (!(v > 0)) { v = fc[key]; if (v > 0) anyFc = true; }
      if (v > 0) { sum += v; n++; }
    }
    if (n >= minDays) {
      return {
        f107: sum / n,
        source: anyFc ? 'forecast45' : 'daily',
        at: isoOf(t0 - win * 86400e3) + ' ~ ' + isoOf(t0 + win * 86400e3),
        fetchedAt: fetchedAt, low: null, high: null
      };
    }
  }

  var ym = String(dateIso).slice(0, 7);

  // ② 观测月均
  var mon = (P.monthly && P.monthly.data) || {};
  if (mon[ym] > 0) return { f107: mon[ym], source: 'monthly', at: ym, fetchedAt: fetchedAt, low: null, high: null };

  // ③ / ④ 太阳周预测月均：覆盖范围内按相邻月中点线性插值；覆盖之后 5 年内取末值
  var pre = (P.predicted && P.predicted.data) || {};
  var keys = Object.keys(pre).filter(function (k) { return /^\d{4}-\d{2}$/.test(k) && pre[k] && pre[k].f > 0; }).sort();
  if (keys.length) {
    var first = keys[0], last = keys[keys.length - 1];
    if (t0 >= monthStartMs(first) && t0 <= monthEndMs(last)) {
      // 落在首月中点之前 / 末月中点之后：钳到端点（仍是"预测"，不外推）
      if (t0 <= monthMidMs(first)) return predOut(pre[first], first, fetchedAt, 'predicted');
      if (t0 >= monthMidMs(last)) return predOut(pre[last], last, fetchedAt, 'predicted');
      for (var i = 1; i < keys.length; i++) {
        var m1 = monthMidMs(keys[i - 1]), m2 = monthMidMs(keys[i]);
        if (t0 >= m1 && t0 <= m2) {
          var t = m2 > m1 ? (t0 - m1) / (m2 - m1) : 0;
          var a = pre[keys[i - 1]], b = pre[keys[i]];
          return {
            f107: lerp(a.f, b.f, t),
            source: 'predicted',
            at: keys[i - 1] + ' ~ ' + keys[i],
            fetchedAt: fetchedAt,
            low: lerp(a.lo, b.lo, t), high: lerp(a.hi, b.hi, t)
          };
        }
      }
    }
    if (t0 > monthEndMs(last) && t0 <= monthEndMs(last) + TAIL_YEARS * 365.25 * 86400e3) {
      return predOut(pre[last], last, fetchedAt, 'predicted-tail');
    }
  }
  return miss;
}

function predOut(rec, ym, fetchedAt, source) {
  return {
    f107: rec.f, source: source, at: ym, fetchedAt: fetchedAt,
    low: rec.lo == null ? null : rec.lo, high: rec.hi == null ? null : rec.hi
  };
}

module.exports = {
  parseDaily30: parseDaily30,
  parseForecast45: parseForecast45,
  parseMonthly: parseMonthly,
  parsePredicted: parsePredicted,
  mergeProducts: mergeProducts,
  f107For: f107For,
  PRODUCTS: PRODUCTS,
  F107_DEFAULT: F107_DEFAULT
};
