// GXT 序列化器 —— 把等值线数据写回 SATSOFT/GRASP 的 GXT 文本（与 parse.js 互逆）。
// 入参 data: { lon, satName, bore:[[lon,lat]...]|[{lon,lat,gain}], contours:[{ g, p:[[lon,lat]...] }],
//              beamId, emiRcp }。用于：① 导出用户库里的 GXT；② 把当前画面绘制的覆盖导出为 GXT。
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : '0.000')
const pt = (p) => `${f3(p[0])};${f3(p[1])}`

export function serializeGxt(data = {}) {
  const lon = Number.isFinite(data.lon) ? data.lon : 0
  const satName = (data.satName || 'Satellite Name').toString()
  const bore = (data.bore || []).map((b) => Array.isArray(b) ? { lon: b[0], lat: b[1], gain: NaN } : { lon: b.lon, lat: b.lat, gain: b.gain })
  const contours = (data.contours || []).filter((c) => c && c.p && c.p.length >= 2)

  const out = []
  out.push('[FormatInfo]')
  out.push('format_ver=1')
  out.push('')
  out.push('[GeoMain]')
  out.push('adm=G  ')
  out.push(`sat_name=${satName}`)
  out.push(`long_nom=${lon.toFixed(3)}`)
  out.push('n_diag=1')
  out.push('')
  out.push('[COHeader]')
  out.push(`beam_id=${data.beamId != null ? data.beamId : 1}`)
  out.push(`emi_rcp=${data.emiRcp || 'E'}`)
  out.push('polar_disc=X')
  out.push('reason=C')
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
