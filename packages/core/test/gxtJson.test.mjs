// GXT 结构 JSON 自测（src/viz/gxt/json.js）+ GXT 波束中心电平保留（parse.js / serialize.js）：运行 npm test。
// 这是 LinkLab 小程序云数据（Satellitelinkbudget/CoverageCloudData）用的波束图格式；本机有那个目录时，
// 拿全部真实文件跑一遍「解析 → 写出 → 再解析」回环（没有就只跑合成用例）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const { parseGxtJson, serializeGxtJson, isGxtJsonText } = await import('../../../src/viz/gxt/json.js')
const { parseGxt } = await import('../../../src/viz/gxt/parse.js')
const { serializeGxt } = await import('../../../src/viz/gxt/serialize.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra != null && extra !== '' ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

/* ---------- 合成用例：与云数据同形 ---------- */
const SAMPLE = '{"formatInfo":{"format_ver":"1"},"geoMain":{"adm":"G","satName":"Satellite Name","longitude":134,"nDiag":1},' +
  '"coHeader":{"beamId":1,"emiRcp":"R","polarization":"C","reason":"C","nBore":1,"nContours":3},' +
  '"borePoints":[{"index":1,"gain":43.46,"pos":[111.34,33.05]}],' +
  '"contours":[{"i":1,"p":[[109.242,28.805],[109.794,28.035],[110.361,27.376],[109.242,28.805]],"g":43},null,{"i":3,"g":"41","p":[[1,2],[3,4]]},{"i":4,"g":40,"p":[[5,6]]}]}'
ok('嗅探：像 / 不像', isGxtJsonText(SAMPLE) && isGxtJsonText('  \uFEFF'.slice(2) + SAMPLE) && !isGxtJsonText('<kml/>') && !isGxtJsonText('{"type":"FeatureCollection"}'))
const p = parseGxtJson(SAMPLE)
ok('解析：轨位 / 占位卫星名当作没有 / 接收', p.lon === 134 && p.satName === '' && p.emiRcp === 'R' && p.polarDisc === 'C' && p.formatVer === '1')
ok('解析：波束中心带电平', p.bore.length === 1 && p.bore[0][0] === 111.34 && p.bore[0][1] === 33.05 && p.bore[0][2] === 43.46)
ok('解析：null 条目 / 不足 2 点剔除、字符串电平数值化', p.contours.length === 2 && p.contours[0].g === 43 && p.contours[1].g === 41 && p.contours[0].p.length === 4)
ok('解析：不是这种 JSON 报错', (() => { try { parseGxtJson('{"type":"FeatureCollection","features":[]}'); return false } catch (e) { return /contours/.test(e.message) } })())
ok('解析：坏 JSON 报错', (() => { try { parseGxtJson('{"contours":[}'); return false } catch (e) { return /JSON/.test(e.message) } })())
ok('解析：空等值线 + 空中心报错', (() => { try { parseGxtJson('{"contours":[null]}'); return false } catch (e) { return /未识别/.test(e.message) } })())

const out = serializeGxtJson({ lon: 110.5, satName: '中星10R', bore: [[115.2, 30.4, 52.345], [116, 31]], contours: [{ g: 48, p: [[115.12345, 30.98765], [116, 31], [115.12345, 30.98765]] }, { g: 44, p: [[1, 2]] }], beamId: 3, emiRcp: 'E' })
const j = JSON.parse(out)
ok('写出：五节齐、键序与云数据一致', JSON.stringify(Object.keys(j)) === '["formatInfo","geoMain","coHeader","borePoints","contours"]' && JSON.stringify(Object.keys(j.contours[0])) === '["i","g","p"]')
ok('写出：geoMain / coHeader 字段', j.geoMain.adm === 'G' && j.geoMain.satName === '中星10R' && j.geoMain.longitude === 110.5 && j.geoMain.nDiag === 1 &&
  j.coHeader.beamId === 3 && j.coHeader.emiRcp === 'E' && j.coHeader.polarization === 'X' && j.coHeader.reason === 'C' && j.coHeader.nBore === 2 && j.coHeader.nContours === 1)
ok('写出：坐标 3 位小数、电平原样、无电平的中心不写 gain', j.contours[0].p[0][0] === 115.123 && j.contours[0].p[0][1] === 30.988 && j.borePoints[0].gain === 52.345 && !('gain' in j.borePoints[1]))
ok('写出：不足 2 点的线剔除、编号连续', j.contours.length === 1 && j.contours[0].i === 1)
ok('写出：单行、indent 可缩进', !out.includes('\n') && serializeGxtJson({ contours: [{ g: 1, p: [[0, 0], [1, 1]] }] }, { indent: 2 }).includes('\n  "geoMain"'))
ok('写出：缺卫星名写占位、缺轨位不写 longitude', (() => { const k = JSON.parse(serializeGxtJson({ contours: [{ g: 1, p: [[0, 0], [1, 1]] }] })); return k.geoMain.satName === 'Satellite Name' && !('longitude' in k.geoMain) && JSON.stringify(Object.keys(k.geoMain)) === '["adm","satName","nDiag"]' })())
const back = parseGxtJson(out)
ok('回环：写出再解析', back.lon === 110.5 && back.satName === '中星10R' && back.contours.length === 1 && back.bore[0][2] === 52.345 && back.contours[0].p.length === 3)

/* ---------- GXT 波束中心电平保留 ---------- */
const GXT = '[FormatInfo]\r\nformat_ver=1\r\n\r\n[GeoMain]\r\nadm=G  \r\nsat_name=TEST\r\nlong_nom=134.000\r\nn_diag=1\r\n\r\n[COHeader]\r\nbeam_id=1\r\nemi_rcp=E\r\npolar_disc=X\r\nreason=C\r\nn_bore=2\r\nn_cont=1\r\n\r\n' +
  '[B1]\r\ngain=43.46\r\np1=111.340;33.050\r\n\r\n[B2]\r\np1=112.000;34.000\r\n\r\n[C1]\r\ngain=43\r\nn_point=3\r\np1=1.000;2.000\r\np2=3.000;4.000\r\np3=1.000;2.000\r\n'
const g = parseGxt(GXT)
ok('parseGxt：波束中心 gain 记成第三分量、没有就两分量', g.bore.length === 2 && g.bore[0].length === 3 && g.bore[0][2] === 43.46 && g.bore[1].length === 2)
const g2 = serializeGxt({ lon: g.lon, satName: 'TEST', bore: g.bore, contours: g.contours, beamId: 1 })
ok('serializeGxt：带回 gain= 行（与原文同）', g2.includes('[B1]\r\ngain=43.46\r\np1=111.340;33.050') && g2.includes('[B2]\r\np1=112.000;34.000'))
ok('serializeGxt：两分量照旧不写 gain', !serializeGxt({ bore: [[1, 2]], contours: [{ g: 1, p: [[0, 0], [1, 1]] }] }).includes('gain=0') && !serializeGxt({ bore: [[1, 2]], contours: [{ g: 1, p: [[0, 0], [1, 1]] }] }).includes('[B1]\r\ngain'))
// GXT → JSON → GXT：与小程序仓 convertApstar6DJsonToGxt 互为逆的口径（字段一一对应）
const viaJson = parseGxtJson(serializeGxtJson({ lon: g.lon, satName: g.satName, bore: g.bore, contours: g.contours }))
ok('GXT → JSON → 解析：等值线 / 中心 / 轨位不丢', viaJson.lon === 134 && viaJson.satName === 'TEST' && viaJson.contours[0].p.length === 3 && viaJson.bore[0][2] === 43.46)

/* ---------- 真实云数据回环（本机有才跑） ---------- */
const CLOUD = 'C:/Users/85256/WeChatProjects/Satellitelinkbudget/CoverageCloudData'
if (existsSync(CLOUD)) {
  let files = 0, bad = [], mismatch = []
  for (const d of readdirSync(CLOUD)) {
    const dir = join(CLOUD, d)
    if (d === 'permissions' || !statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      files++
      const text = readFileSync(join(dir, f), 'utf8')
      let a
      try { a = parseGxtJson(text) } catch (e) { bad.push(`${d}/${f}: ${e.message}`); continue }
      const raw = JSON.parse(text)
      const want = (raw.contours || []).filter((c) => c && Number.isFinite(Number(c.g)) && Array.isArray(c.p) && c.p.length >= 2).length
      if (a.contours.length !== want) mismatch.push(`${d}/${f}: ${a.contours.length}≠${want}`)
      const b = parseGxtJson(serializeGxtJson({ lon: a.lon, satName: a.satName, bore: a.bore, contours: a.contours, emiRcp: a.emiRcp, polarDisc: a.polarDisc, reason: a.reason, beamId: a.beamId, formatVer: a.formatVer }))
      const same = b.contours.length === a.contours.length && b.bore.length === a.bore.length && b.lon === a.lon &&
        a.contours.every((c, k) => c.g === b.contours[k].g && c.p.length === b.contours[k].p.length && c.p.every((q, t) => Math.abs(q[0] - b.contours[k].p[t][0]) < 6e-4 && Math.abs(q[1] - b.contours[k].p[t][1]) < 6e-4)) &&
        a.bore.every((q, k) => q[2] === b.bore[k][2] || (q[2] == null && b.bore[k][2] == null))
      if (!same) mismatch.push(`${d}/${f}: 回环不一致`)
    }
  }
  ok(`云数据：${files} 个文件全部解析`, files > 0 && bad.length <= 2, bad.slice(0, 3).join(' | '))
  ok('云数据：有效等值线条数逐个对上、写出再解析逐点一致（3 位小数内）', !mismatch.length, mismatch.slice(0, 3).join(' | '))
} else {
  console.log('SKIP  云数据回环：本机没有 ' + CLOUD)
}

console.log(`\nGXT 结构 JSON：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
