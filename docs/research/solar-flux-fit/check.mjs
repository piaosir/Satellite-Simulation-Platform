// RSTN（SWPC solar_radio_flux.txt，7 天多频正午流量）交叉验证：用 NoRP 拟合系数 + log-log 插值预测
// 4995 / 8800 / 15400 MHz 的流量，与 San Vito / Learmonth / Palehua 实测比。F10.7 取同日 DRAO 20 UT 观测值。
import { readFileSync } from 'node:fs'
import path from 'node:path'
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const coef = JSON.parse(readFileSync(path.join(HERE, 'coef.json'), 'utf8')).fitted
// 锚点：2.8 GHz 恒等（a=0,b=1），其余取拟合
const ANCH = [
  { f: 1, a: coef['1000'].a, b: coef['1000'].b },
  { f: 2, a: coef['2000'].a, b: coef['2000'].b },
  { f: 2.8, a: 0, b: 1 },
  { f: 3.75, a: coef['3750'].a, b: coef['3750'].b },
  { f: 9.4, a: coef['9400'].a, b: coef['9400'].b },
  { f: 17, a: coef['17000'].a, b: coef['17000'].b }
].sort((x, y) => x.f - y.f)
function fluxAt(fGHz, F) {
  const S = (p) => p.a + p.b * F
  if (fGHz <= ANCH[0].f) return S(ANCH[0])
  for (let i = 1; i < ANCH.length; i++) {
    if (fGHz <= ANCH[i].f) {
      const p = ANCH[i - 1], q = ANCH[i]
      const t = Math.log(fGHz / p.f) / Math.log(q.f / p.f)
      return Math.exp(Math.log(S(p)) + t * (Math.log(S(q)) - Math.log(S(p))))
    }
  }
  return S(ANCH[ANCH.length - 1])
}
// DRAO 日值（20 UT 观测）
const f107 = new Map()
for (const ln of readFileSync(path.join(HERE, 'pent', 'fluxtable.txt'), 'utf8').split(/\r?\n/)) {
  const m = /^(\d{8})\s+200000\s+\S+\s+\S+\s+([\d.]+)/.exec(ln)
  if (m) f107.set(m[1], parseFloat(m[2]))
}
// RSTN 报表
const txt = readFileSync(path.join(HERE, 'rstn.txt'), 'utf8').split(/\r?\n/)
let day = null
const rows = []
for (const ln of txt) {
  const d = /^(\d{4}) (\w{3}) (\d{2})\s*$/.exec(ln)
  if (d) { const mo = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(d[2]) / 3 + 1; day = `${d[1]}${String(mo).padStart(2, '0')}${d[3]}`; continue }
  const m = /^\s*(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(ln)
  if (m && day) rows.push({ day, f: +m[1], learmonth: +m[2], sanvito: +m[3], saghill: +m[4], pent17: +m[5], pent20: +m[6], palehua: +m[7], pent23: +m[8] })
}
const errs = {}
for (const r of rows) {
  if (![4995, 8800, 15400, 2695, 1415].includes(r.f)) continue
  const F = f107.get(r.day) || r.pent20 || r.pent17
  if (!(F > 0)) continue
  const pred = fluxAt(r.f / 1000, F)
  const obs = [r.sanvito, r.learmonth, r.palehua].filter((v) => v > 0)
  if (!obs.length) continue
  const mean = obs.reduce((a, b) => a + b, 0) / obs.length
  const e = (pred / mean - 1) * 100
  ;(errs[r.f] = errs[r.f] || []).push(e)
  console.log(`${r.day} ${String(r.f).padStart(5)} MHz F10.7=${F}  预测 ${pred.toFixed(0)}  实测 ${obs.join('/')} (均 ${mean.toFixed(0)})  偏差 ${e.toFixed(1)}%`)
}
for (const [f, a] of Object.entries(errs)) console.log(`${f} MHz: 平均偏差 ${(a.reduce((p, q) => p + q, 0) / a.length).toFixed(1)}%  |偏差| 最大 ${Math.max(...a.map(Math.abs)).toFixed(1)}%  n=${a.length}`)
