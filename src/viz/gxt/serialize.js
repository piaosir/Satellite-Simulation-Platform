// GXT 序列化器 —— 把等值线数据写回 SATSOFT/GRASP 的 GXT 文本（与 parse.js 互逆）。
// 入参 data: { lon, satName, bore:[[lon,lat]...]|[{lon,lat,gain}], contours:[{ g, p:[[lon,lat]...] }],
//              beamId, emiRcp }。用于：① 导出用户库里的 GXT；② 把当前画面绘制的覆盖导出为 GXT。
// 可选头字段（缺省即历来的写法，菜单导出逐字节不变；可编程波束地图的 gxt() 透传）：
//   adm        主管部门代码，定宽 3 字符（缺省 'G'）     polarDisc  极化鉴别（缺省 'X'）
//   reason     原因码（缺省 'C'）                       digits     坐标小数位（缺省 3）
const fx = (n, d) => (Number.isFinite(n) ? n.toFixed(d) : (0).toFixed(d))

export function serializeGxt(data = {}) {
  const lon = Number.isFinite(data.lon) ? data.lon : 0
  const satName = (data.satName || 'Satellite Name').toString()
  // 波束中心：[lon, lat] 或带电平的 [lon, lat, gain]（parse.js 读出的口径），或 { lon, lat, gain }
  const bore = (data.bore || []).map((b) => Array.isArray(b) ? { lon: b[0], lat: b[1], gain: Number.isFinite(b[2]) ? b[2] : NaN } : { lon: b.lon, lat: b.lat, gain: b.gain })
  const contours = (data.contours || []).filter((c) => c && c.p && c.p.length >= 2)
  const dg = Number.isInteger(data.digits) && data.digits >= 0 && data.digits <= 10 ? data.digits : 3
  const pt = (p) => `${fx(p[0], dg)};${fx(p[1], dg)}`
  const adm = data.adm != null && String(data.adm) !== '' ? String(data.adm).padEnd(3).slice(0, 3) : 'G  '

  const out = []
  out.push('[FormatInfo]')
  out.push('format_ver=1')
  out.push('')
  out.push('[GeoMain]')
  out.push(`adm=${adm}`)
  out.push(`sat_name=${satName}`)
  out.push(`long_nom=${lon.toFixed(3)}`)
  out.push('n_diag=1')
  out.push('')
  out.push('[COHeader]')
  out.push(`beam_id=${data.beamId != null ? data.beamId : 1}`)
  out.push(`emi_rcp=${data.emiRcp || 'E'}`)
  out.push(`polar_disc=${data.polarDisc || 'X'}`)
  out.push(`reason=${data.reason || 'C'}`)
  out.push(`n_bore=${bore.length}`)
  out.push(`n_cont=${contours.length}`)
  out.push('')

  bore.forEach((b, i) => {
    out.push(`[B${i + 1}]`)
    if (Number.isFinite(b.gain)) out.push(`gain=${b.gain.toFixed(2)}`)
    out.push(`p1=${pt([b.lon, b.lat])}`)
  })
  if (bore.length) out.push('')

  contours.forEach((c, i) => {
    out.push(`[C${i + 1}]`)
    out.push(`gain=${Number(c.g)}`)
    out.push(`n_point=${c.p.length}`)
    c.p.forEach((p, j) => out.push(`p${j + 1}=${pt(p)}`))
    out.push('')
  })

  return out.join('\r\n')
}
