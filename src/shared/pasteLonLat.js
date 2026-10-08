// 定位块粘贴的「末两列 = 经纬度」兜底（标记批量表格 / 对地性能表城市列表 / 气象表共用）。
//
// 这几张表在经纬度前面插过新列（地球站：口径 / 天线罩 / 功放；点标记：名称；城市：时间 / 高度；气象：时间），
// 而定位块粘贴（选中格后 Ctrl+V）按位置对列 —— v1.4.13 列序的块（如「名称 / 经度 / 纬度」）从首列粘进来，
// 经度就落进了新插的那几列（地球站口径变 116.4 m、城市纬度进了高度、气象表纬度写进经度……）。
// 整块追加（不选格粘贴）本来就按「末两列 = 经纬度」认坐标，这里让定位粘贴在同样的块上与它一致。
//
// 判据（全部满足才改落位，否则返回 null = 照旧按位置）：
//   · 起始列是文本列（textKeys：名称 / 国家 / 城市 / 代号…）—— 从数字列起粘的块（如只粘口径、功放、高度）一律按位置；
//   · 块宽 ≥ 2，且小于「起始列到纬度列」的列数（够宽的块按位置本来就对得上）；
//   · 每个非空行的末两格都是合法经纬度数（经度 −180…360、纬度 −90…90）。
// 落位：末两格 → 经度 / 纬度，其余格从起始列起依次落（同整块追加）。行尾空格不算宽度。
import { num } from './num.js'

const isBlank = (v) => v == null || String(v).trim() === ''
// 去掉行尾空格后的有效宽度
function effLen(cells) {
  let n = cells.length
  while (n > 0 && isBlank(cells[n - 1])) n--
  return n
}

/**
 * @param {string[]} cols      网格列 key 顺序（经度、纬度两列相邻，纬度在后）
 * @param {string} startKey    块左上角所在列
 * @param {string[][]} grid    已切好的块（行 × 格）
 * @param {{ textKeys?: string[], lonKey?: string, latKey?: string }} [opt]
 * @returns {null | ((cells: string[]) => (string|null)[])}  每格落到哪一列（null = 不落）
 */
export function lonLatPasteKeys(cols, startKey, grid, opt = {}) {
  const { textKeys = [], lonKey = 'lon', latKey = 'lat' } = opt
  const c0 = cols.indexOf(startKey), iLon = cols.indexOf(lonKey), iLat = cols.indexOf(latKey)
  if (c0 < 0 || iLon < 0 || iLat !== iLon + 1 || c0 >= iLon || !textKeys.includes(startKey)) return null
  const span = iLat - c0 + 1
  const rows = (grid || []).filter((r) => Array.isArray(r) && effLen(r) > 0)
  if (!rows.length) return null
  for (const r of rows) {
    const n = effLen(r)
    if (n < 2 || n >= span) return null
    const lon = num(r[n - 2]), lat = num(r[n - 1])
    if (lon == null || lat == null || lon < -180 || lon > 360 || lat < -90 || lat > 90) return null
  }
  return (cells) => {
    const n = effLen(cells)
    return cells.map((_, ci) => (ci >= n ? null : ci === n - 2 ? lonKey : ci === n - 1 ? latKey : (c0 + ci < iLon ? cols[c0 + ci] : null)))
  }
}
