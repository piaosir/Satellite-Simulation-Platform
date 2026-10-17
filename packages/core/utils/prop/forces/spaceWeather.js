// 空间天气（F10.7、Ap）：CelesTrak SW-All.csv 解析 + NRLMSISE-00 输入取值（纯 CommonJS）。
//
// 【格式】CelesTrak「Space Weather Data」CSV（https://celestrak.org/SpaceData/SW-All.csv，说明见
//   https://celestrak.org/SpaceData/SpaceWx-format.php），首行表头，每日一行：
//   DATE,BSRN,ND,KP1…KP8,KP_SUM,AP1…AP8,AP_AVG,CP,C9,ISN,F10.7_OBS,F10.7_ADJ,F10.7_DATA_TYPE,
//   F10.7_OBS_CENTER81,F10.7_OBS_LAST81,F10.7_ADJ_CENTER81,F10.7_ADJ_LAST81
//   KP 为 10 倍整数（43 = 4.3），AP 为 3 小时 ap（UT 0–3 h … 21–24 h），AP_AVG 为日 Ap。
//   F10.7_DATA_TYPE：OBS 观测；INT 插补；PRD 45 天逐日预报；PRM 逐月预报（每月 1 日一行，无 Kp / Ap 的 3 小时值）。
//   列按表头名取，不按位置取（CelesTrak 加列时不至于错位）。
//
// 【NRLMSISE-00 取值口径】按 NRLMSISE-00 头注的定义（与 Orekit CssiSpaceWeatherData 一致，测试对拍）：
//   f107  = 前一日的 F10.7_OBS（观测通量 —— 头注要求「实际日地距离处的通量」，不用 1 AU 归算的 ADJ）
//   f107A = 当日的 F10.7_OBS_CENTER81（以当日为中心的 81 日平均）
//   ap    = 当日 AP_AVG（日 Ap）
//   ap_a  = [日 Ap, 当前 3 h ap, −3 h, −6 h, −9 h, −12…−33 h 八个 3 h ap 的均值, −36…−57 h 的均值]
//   最后一个 OBS 日之后的 3 小时 ap 改用日 Ap（预报的 3 小时值不可信）；越过逐日数据后（PRM 段）按月线性插值。
//   PRM 行在 CSV 里没有 Ap（只有 F10.7），这一段的 Ap 沿用最后一个逐日行的日 Ap。日界一律 UTC。
// 【已知数据差异】八个 3 小时 ap 的均值恰为 x.5 的日子，CelesTrak 的 CSV（AP_AVG）与同源 TXT
//   （SpaceWeather-All-v1.2.txt，Orekit 缺省读这份）取整不同：CSV 向偶数取整（8.5 → 8），TXT 四舍五入（→ 9）。
//   约 1/8 的日子如此，平静期密度差 ~0.5%，扰动期可到 3%。本模块按 CSV 原值取用；与 Orekit 对拍时由
//   scripts/orekit-prop-refs.py 把同一份 CSV 转成 TXT 喂给 Orekit，两边输入逐位一致。
//
// 接口：
//   parseSwCsv(text) → { records:[{ ms, f107Obs, f107Adj, f107ObsCtr81, f107ObsLast81, f107AdjCtr81, f107AdjLast81,
//                         apAvg, ap:[8], kp:[8], type }], lastObservedMs, lastDailyMs, firstMs }
//   createSpaceWeather(parsedOrText) → { msisInputs(tMs) → { f107, f107A, ap, ap_a }, minMs, maxMs }
//   constantSpaceWeather({ f107, f107A, ap }) → 同形（ap_a 全取 ap）

'use strict'

const DAY_MS = 86400000

function num(s) {
  const t = String(s == null ? '' : s).trim()
  if (t === '') return NaN
  return Number(t)
}

function parseSwCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/)
  let head = null
  const records = []
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln) continue
    const cols = ln.split(',')
    if (!head) {
      if (!/^DATE$/i.test(cols[0].trim())) throw new Error('SW-All.csv：首行应为表头（DATE,…）')
      head = {}
      cols.forEach((c, i) => { head[c.trim().toUpperCase()] = i })
      for (const k of ['DATE', 'AP_AVG', 'F10.7_OBS', 'F10.7_OBS_CENTER81', 'F10.7_DATA_TYPE']) {
        if (!(k in head)) throw new Error('SW-All.csv：缺列 ' + k)
      }
      continue
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cols[head.DATE].trim())
    if (!m) throw new Error('SW-All.csv：日期看不懂：' + cols[head.DATE])
    const g = (k) => (k in head ? num(cols[head[k]]) : NaN)
    const ap = [], kp = []
    for (let i = 1; i <= 8; i++) { ap.push(g('AP' + i)); kp.push(g('KP' + i) / 10) }
    records.push({
      ms: Date.UTC(+m[1], +m[2] - 1, +m[3]),
      type: String(cols[head['F10.7_DATA_TYPE']] || '').trim().toUpperCase(),
      f107Obs: g('F10.7_OBS'), f107Adj: g('F10.7_ADJ'),
      f107ObsCtr81: g('F10.7_OBS_CENTER81'), f107ObsLast81: g('F10.7_OBS_LAST81'),
      f107AdjCtr81: g('F10.7_ADJ_CENTER81'), f107AdjLast81: g('F10.7_ADJ_LAST81'),
      apAvg: g('AP_AVG'), ap, kp
    })
  }
  if (!records.length) throw new Error('SW-All.csv：没有数据行')
  records.sort((a, b) => a.ms - b.ms)
  let lastObservedMs = NaN, lastDailyMs = NaN
  for (const r of records) {
    if (r.type === 'OBS' || r.type === 'INT') lastObservedMs = r.ms
    if (r.type !== 'PRM') lastDailyMs = r.ms
  }
  return { records, lastObservedMs, lastDailyMs, firstMs: records[0].ms }
}

function createSpaceWeather(src) {
  const sw = typeof src === 'string' ? parseSwCsv(src) : src
  const recs = sw.records
  const byDay = new Map()
  for (const r of recs) if (r.type !== 'PRM') byDay.set(r.ms, r)
  let lastAp = NaN
  for (const r of recs) if (r.type !== 'PRM' && Number.isFinite(r.apAvg)) lastAp = r.apAvg
  // PRM 行缺 Ap 的沿用最后一个逐日日 Ap（拷贝，不改调用方传入的解析结果）
  const monthly = recs.filter((r) => r.type === 'PRM').map((r) => (Number.isFinite(r.apAvg) ? r : Object.assign({}, r, { apAvg: lastAp })))
  const lastDaily = sw.lastDailyMs
  const lastObs = sw.lastObservedMs
  const maxMs = recs[recs.length - 1].ms + (monthly.length ? 0 : DAY_MS)

  // 逐月段：在相邻两条记录（取逐日段最后一行与各 PRM 行）之间线性插值
  const interpPts = (byDay.has(lastDaily) ? [byDay.get(lastDaily)] : []).concat(monthly)
  function interp(tMs, key) {
    let i = 0
    while (i < interpPts.length - 2 && interpPts[i + 1].ms <= tMs) i++
    const a = interpPts[i], b = interpPts[i + 1] || a
    if (b === a || b.ms === a.ms) return a[key]
    const w = (tMs - a.ms) / (b.ms - a.ms)
    return a[key] + (b[key] - a[key]) * w
  }
  function dayRec(tMs) {
    const d = Math.floor(tMs / DAY_MS) * DAY_MS
    const r = byDay.get(d)
    if (!r) throw new Error('空间天气数据无此日：' + new Date(d).toISOString().slice(0, 10))
    return r
  }
  const daily = (tMs, key) => (tMs < lastDaily + DAY_MS ? dayRec(tMs)[key] : interp(tMs, key))
  const dailyAp = (tMs) => daily(tMs, 'apAvg')
  function threeHourAp(tMs) {
    if (tMs < lastObs + DAY_MS) {
      const r = dayRec(tMs)
      let i = Math.floor((tMs - r.ms) / 10800000)
      if (i > 7) i = 7
      return r.ap[i]
    }
    return dailyAp(tMs)
  }
  function avg8(tMs) {
    if (!(tMs < lastDaily + DAY_MS)) return dailyAp(tMs)
    let s = 0
    for (let i = 0; i < 8; i++) s += threeHourAp(tMs - i * 10800000)
    return s / 8
  }
  return {
    minMs: sw.firstMs + 3 * DAY_MS,
    maxMs,
    lastObservedMs: lastObs,
    msisInputs(tMs) {
      const ap0 = dailyAp(tMs)
      return {
        f107: daily(tMs - DAY_MS, 'f107Obs'),
        f107A: daily(tMs, 'f107ObsCtr81'),
        ap: ap0,
        ap_a: [ap0, threeHourAp(tMs), threeHourAp(tMs - 10800000), threeHourAp(tMs - 21600000), threeHourAp(tMs - 32400000),
          avg8(tMs - 43200000), avg8(tMs - 129600000)]
      }
    }
  }
}

function constantSpaceWeather(v) {
  const o = v || {}
  const f107 = o.f107 == null ? 150 : Number(o.f107)
  const f107A = o.f107A == null ? f107 : Number(o.f107A)
  const ap = o.ap == null ? 4 : Number(o.ap)
  const res = { f107, f107A, ap, ap_a: [ap, ap, ap, ap, ap, ap, ap] }
  return { constant: true, minMs: -Infinity, maxMs: Infinity, msisInputs: () => res }
}

module.exports = { parseSwCsv, createSpaceWeather, constantSpaceWeather }
