// SP3-c / SP3-d 精密星历解析（IGS 及各分析中心的产品体例；纯 CommonJS）。
// 参考：Hilla, "The Extended Standard Product 3 Orbit Format (SP3-c)"，及 SP3-d 的不定行卫星表扩展。
//
// 【定长栏位不是可选项】SP3 的数值列常常挨在一起（-14027.052340-12041.234560 中间一个空格都没有），
//   按空白切必然切错，故一律按标准的定长列切；只有切不出数时才退回空白切（第三方非标件的兜底）。
//
// 【缺样本】位置三列全是 0.000000 是 SP3 规定的「该历元无数据」哨兵，整点剔除并计数；
//   钟差 999999.999999 同样是无数据 —— 本平台不用钟差，只计数不影响轨道。
//
// 【坐标系】头里写的是 IGS14 / IGb14 / IGS20 / ITRF20xx 一类，全部是地固系，一律按 FIXED 收；
//   换到 TEME 是 ephemInterp.buildTable 的事。
//
// 【时间系统】%c 行第 10–12 列：GPS / UTC / TAI / GLO / GAL / QZS / BDT / IRN。
//   GLO 在 SP3 里已折算到 UTC；GAL / QZS / IRN 与 GPS 同原点（偏 0）；BDT = GPS − 14 s。
//
// 【插值】SP3 是 15 min 量级的粗采样，用 Lagrange min(10, n)：附录 C 里 MEO 上是 cm 级；
//   LEO 用这个步长本就不该（buildTable 会给「过粗」告警）。

'use strict'

const T = require('./timeSystems.js')

// 卫星系统前缀 -> 中文名
const SP3_SYS = { G: 'GPS', R: 'GLONASS', E: 'Galileo', C: '北斗', J: 'QZSS', I: 'NavIC', S: 'SBAS' }
// %c 的时间系统 -> timeSystems 的时标 id
const SP3_TIME = { GPS: 'GPS', UTC: 'UTC', TAI: 'TAI', GLO: 'UTC', GAL: 'GPS', QZS: 'GPS', BDT: 'BDT', IRN: 'GPS' }
const SP3_BAD_CLOCK = 999999.999999

function prnName(id) {
  const sys = SP3_SYS[id[0]]
  if (!sys) return id
  return (id[0] === 'G' ? 'GPS PRN ' : sys + ' ') + id.slice(1)
}
function colNum(line, a, b) {
  const s = line.slice(a, b).trim()
  if (!s) return NaN
  const v = Number(s)
  return Number.isFinite(v) ? v : NaN
}

function parseSp3(text) {
  const errors = [], warnings = []
  const src = String(text == null ? '' : text).replace(/^﻿/, '')
  const lines = src.split(/\r?\n/)
  if (!/^#[cd]/.test(lines[0] || '')) {
    errors.push('不是 SP3-c / SP3-d（首行应以 #c 或 #d 开头）')
    return { sats: [], errors, warnings }
  }
  const version = lines[0][1]
  const hasVelFlag = /^#[cd]V/.test(lines[0])
  const declaredEpochs = colNum(lines[0], 32, 39)
  const coordSys = (lines[0].slice(46, 51) || '').trim()

  let timeSys = 'GPS', timeSysSeen = false
  const ids = []
  const rows = new Map()          // 卫星 id -> [{ ms, x, y, z, vx, vy, vz, hasV }]
  let epochMs = NaN, dropped = 0, badClock = 0

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]
    if (!line) continue
    if (/^EOF/.test(line)) break
    const h2 = line.slice(0, 2)

    if (h2 === '##') continue                       // GPS 周 / 周内秒 / 间隔 / MJD：时刻以 * 行为准
    if (h2 === '++') continue                       // 精度指数
    if (line[0] === '+') {                          // 卫星表（c 固定 5 行、d 不定行）
      const m = line.slice(9).match(/[A-Z]\d{2}/g) || []
      for (const id of m) if (ids.indexOf(id) < 0) ids.push(id)
      continue
    }
    if (h2 === '%c') {
      const tok = (line.slice(9, 12) || '').trim().toUpperCase()
      if (tok && !timeSysSeen) {
        timeSysSeen = true
        if (SP3_TIME[tok]) timeSys = SP3_TIME[tok]
        else warnings.push('未知时间系统 ' + tok + '，按 GPS 处理')
      }
      continue
    }
    if (h2 === '%f' || h2 === '%i') continue
    if (h2 === '/*') continue                       // 注释
    if (h2 === 'EP' || h2 === 'EV') continue        // 标准差 / 相关性记录

    if (line[0] === '*') {                          // 历元：*  yyyy mm dd hh mm ss.ssssssss
      const f = line.slice(1).trim().split(/\s+/).map(Number)
      if (f.length < 6 || f.slice(0, 6).some((x) => !Number.isFinite(x))) {
        warnings.push('第 ' + (li + 1) + ' 行历元无法解析，其后的记录一并跳过')
        epochMs = NaN
        continue
      }
      const read = Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], 0) + f[5] * 1000
      epochMs = T.utcMsFrom({ system: timeSys, ms: read })
      continue
    }

    if (line[0] === 'P' || line[0] === 'V') {
      if (!Number.isFinite(epochMs)) continue
      const id = line.slice(1, 4).trim()
      if (!id) continue
      let x = colNum(line, 4, 18), y = colNum(line, 18, 32), z = colNum(line, 32, 46)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        const tok = line.slice(4).trim().split(/\s+/).map(Number)     // 非定长件的兜底
        x = tok[0]; y = tok[1]; z = tok[2]
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { dropped++; continue }
      if (!rows.has(id)) rows.set(id, [])
      const arr = rows.get(id)
      if (line[0] === 'P') {
        // 位置三列全 0 = 该历元无数据（SP3 规定的哨兵），整点剔除
        if (x === 0 && y === 0 && z === 0) { dropped++; continue }
        const clk = colNum(line, 46, 60)
        if (Number.isFinite(clk) && Math.abs(clk - SP3_BAD_CLOCK) < 1e-6) badClock++
        arr.push({ ms: epochMs, x, y, z, vx: 0, vy: 0, vz: 0, hasV: false })
      } else {
        // V 行是 dm/s（÷1e4 → km/s），总跟在同一颗星的 P 行之后
        const last = arr[arr.length - 1]
        if (last && last.ms === epochMs) { last.vx = x / 1e4; last.vy = y / 1e4; last.vz = z / 1e4; last.hasV = true }
      }
    }
  }

  if (!rows.size) { errors.push('SP3 里没有可用的位置记录'); return { sats: [], errors, warnings } }
  if (dropped) warnings.push('剔除 ' + dropped + ' 个缺样本（位置哨兵 0.000000 或数值无效）')
  if (badClock) warnings.push(badClock + ' 个历元的钟差是 999999.999999（无数据）；本平台不用钟差，不影响轨道')
  if (Number.isFinite(declaredEpochs) && declaredEpochs > 0) {
    let maxN = 0
    for (const a of rows.values()) if (a.length > maxN) maxN = a.length
    if (maxN > declaredEpochs) warnings.push('头里声明 ' + declaredEpochs + ' 个历元，实得 ' + maxN)
  }

  // 输出顺序按卫星表；表里没有的（非标件）追加在后
  const listed = ids.filter((x) => rows.has(x))
  const extra = Array.from(rows.keys()).filter((x) => ids.indexOf(x) < 0)
  const order = listed.concat(extra)
  const sats = []
  for (const id of order) {
    const arr = rows.get(id)
    if (!arr || arr.length < 2) { if (arr) warnings.push(id + '：只有 ' + arr.length + ' 个有效历元，已丢弃'); continue }
    const n = arr.length
    const t = new Float64Array(n), p = new Float64Array(3 * n)
    const withV = hasVelFlag && arr.every((r) => r.hasV)
    const v = withV ? new Float64Array(3 * n) : null
    for (let i = 0; i < n; i++) {
      t[i] = arr[i].ms
      p[3 * i] = arr[i].x; p[3 * i + 1] = arr[i].y; p[3 * i + 2] = arr[i].z
      if (v) { v[3 * i] = arr[i].vx; v[3 * i + 1] = arr[i].vy; v[3 * i + 2] = arr[i].vz }
    }
    sats.push({
      name: prnName(id), objectId: id, frame: 'FIXED', timeSystem: timeSys,
      interp: { method: 'lagrange', samples: Math.min(10, n) },
      t, p, v, spans: null,
      meta: { sp3Version: version, coordSys, prn: id, system: SP3_SYS[id[0]] || '' }
    })
  }
  if (!sats.length) errors.push('SP3 里每颗星的有效历元都不足 2 个')
  return { sats, errors, warnings }
}

module.exports = { parseSp3, prnName, SP3_SYS, SP3_TIME, SP3_BAD_CLOCK }
