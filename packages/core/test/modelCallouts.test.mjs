// 报告三视图的挂点名排位（src/viz/models/thumbs.js 的 placeCallouts / wrapLabel，纯函数）与模板缩略图版本号导出。
// 裸 node 跑：thumbs.js 顶层只 import three 与本目录的 studio / view / materials / gpuRelease（不碰 DOM），modelRenderStack 同样这么引。
// 口径（W16 报告 ④-1「贴格边的挂点名被裁掉」）：名字矩形整块落在格内（内缩 pad）、不压占位 / 别的名字 / 锚点、引线不穿别的名字；
// 放不下时宁叠不丢（ok = false），但仍在格内。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TH = await import(pathToFileURL(path.join(HERE, '../../../src/viz/models/thumbs.js')).href)
const { placeCallouts, wrapLabel, TPL_THUMB_VER } = TH

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error('✗ ' + name); throw e } }
const inside = (r, box, pad) => r[0] >= box[0] + pad - 1e-9 && r[1] >= box[1] + pad - 1e-9 && r[2] <= box[2] - pad + 1e-9 && r[3] <= box[3] - pad + 1e-9
const ov = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
const onBorder = (r, x, y) => {
  const inX = x >= r[0] - 1e-9 && x <= r[2] + 1e-9, inY = y >= r[1] - 1e-9 && y <= r[3] + 1e-9
  return inX && inY && (Math.abs(x - r[0]) < 1e-9 || Math.abs(x - r[2]) < 1e-9 || Math.abs(y - r[1]) < 1e-9 || Math.abs(y - r[3]) < 1e-9)
}
const CELL = 640, FS = 16
const BOX = [0, 0, CELL, CELL], PAD = FS * 0.4
const TITLE = [0, 0, CELL * 0.47, FS * 2.5]
const TRIAD = [FS * 0.2, CELL - FS * 8.8, FS * 8.8, CELL]
const SCALE = [CELL - 200, CELL - FS * 3.7, CELL, CELL]
const OBST = [TITLE, TRIAD, SCALE]
const base = { box: BOX, pad: PAD, obstacles: OBST, lead: CELL * 0.12, gap: FS * 0.25, dot: FS * 0.45 }

t('导出：TPL_THUMB_VER = v4（工作台与 3D 页侧栏共用）', () => {
  assert.equal(TPL_THUMB_VER, 'v4')
})

t('贴右沿的长名字：整块落在格内（向内排），引线终点在名字矩形边上', () => {
  const items = [{ x: CELL - 20, y: CELL / 2, w: 260, h: FS * 1.3 }]
  const [q] = placeCallouts(items, base)
  assert.ok(q && q.ok, JSON.stringify(q))
  assert.ok(inside(q.rect, BOX, PAD), JSON.stringify(q.rect))
  assert.ok(q.rect[2] <= CELL - PAD + 1e-9)
  assert.ok(onBorder(q.rect, q.lx, q.ly), JSON.stringify(q))
  assert.equal(ov(q.rect, [items[0].x - FS * 0.45, items[0].y - FS * 0.45, items[0].x + FS * 0.45, items[0].y + FS * 0.45]), 0, '名字不压自己的锚点')
})

t('四角 + 四边贴边的锚点：全部落在格内、互不重叠、不压占位', () => {
  const pts = [[8, 8], [CELL - 8, 8], [8, CELL - 8], [CELL - 8, CELL - 8], [CELL / 2, 6], [CELL / 2, CELL - 6], [6, CELL / 2], [CELL - 6, CELL / 2]]
  const items = pts.map(([x, y], i) => ({ x, y, w: 120 + i * 13, h: FS * 1.3 }))
  const res = placeCallouts(items, base)
  res.forEach((q, i) => {
    assert.ok(q, 'item ' + i)
    assert.ok(inside(q.rect, BOX, PAD), 'item ' + i + ' ' + JSON.stringify(q.rect))
    if (q.ok) for (const o of OBST) assert.equal(ov(q.rect, o), 0, 'item ' + i + ' 压占位')
  })
  for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) if (res[i].ok && res[j].ok) assert.equal(ov(res[i].rect, res[j].rect), 0, i + '×' + j)
  assert.ok(res.filter((q) => q.ok).length >= 7, '8 个里至少 7 个完全满足硬约束：' + res.map((q) => q.ok).join(','))
})

t('一簇挂在星体中部的锚点：名字互不重叠、不压任何锚点、引线不穿别的名字', () => {
  const items = []
  for (let k = 0; k < 10; k++) items.push({ x: CELL / 2 + (k % 5) * 18 - 36, y: CELL / 2 + Math.floor(k / 5) * 22 - 11, w: 90 + (k % 3) * 25, h: FS * 1.3 })
  const res = placeCallouts(items, base)
  const dots = items.map((it) => [it.x - FS * 0.45, it.y - FS * 0.45, it.x + FS * 0.45, it.y + FS * 0.45])
  res.forEach((q, i) => {
    assert.ok(q.ok, 'item ' + i + ' 未满足硬约束')
    assert.ok(inside(q.rect, BOX, PAD))
    for (const d of dots) assert.equal(ov(q.rect, d), 0, 'item ' + i + ' 压锚点')
  })
  for (let i = 0; i < res.length; i++) for (let j = i + 1; j < res.length; j++) assert.equal(ov(res[i].rect, res[j].rect), 0, i + '×' + j)
})

t('标题带（左上 0.47 格宽 × 2.5 字高）里不落名字：锚点在标题正下方也让开', () => {
  const items = [{ x: 60, y: FS * 3, w: 150, h: FS * 1.3 }]
  const [q] = placeCallouts(items, base)
  assert.ok(q.ok)
  assert.equal(ov(q.rect, TITLE), 0)
})

t('cover：朝外一侧整片是模型时名字挪到空白处', () => {
  // 锚点在格心右侧，朝外是 +x；右半格整片「模型」（占比 1），左半格空白
  const cover = (r) => { const a = Math.max(0, r[2] - Math.max(r[0], CELL / 2 + 40)); return a / Math.max(1e-9, r[2] - r[0]) }
  const items = [{ x: CELL / 2 + 60, y: CELL / 2, w: 100, h: FS * 1.3 }]
  const [q0] = placeCallouts(items, base)
  const [q1] = placeCallouts(items, { ...base, cover })
  assert.ok(q0.rect[0] > items[0].x, '无 cover：朝外（右侧）')
  assert.ok(cover(q1.rect) < cover(q0.rect), '有 cover：压模型的比例变小 ' + cover(q0.rect) + ' → ' + cover(q1.rect))
})

t('无名字（w = 0）的项返回 null，只当障碍', () => {
  const items = [{ x: 300, y: 300, w: 0, h: 0 }, { x: 320, y: 300, w: 80, h: FS * 1.3 }]
  const res = placeCallouts(items, base)
  assert.equal(res[0], null)
  assert.ok(res[1] && res[1].ok)
  assert.equal(ov(res[1].rect, [300 - FS * 0.45, 300 - FS * 0.45, 300 + FS * 0.45, 300 + FS * 0.45]), 0)
})

t('挤不下（40 个锚点挤在一个小格里）：宁叠不丢，但全部仍在格内', () => {
  const box = [0, 0, 200, 200]
  const items = []
  for (let k = 0; k < 40; k++) items.push({ x: 20 + (k % 8) * 20, y: 20 + Math.floor(k / 8) * 30, w: 70, h: 20 })
  const res = placeCallouts(items, { box, pad: 4, lead: 24, gap: 4, dot: 7 })
  assert.equal(res.length, 40)
  res.forEach((q, i) => { assert.ok(q, 'item ' + i); assert.ok(inside(q.rect, box, 4), 'item ' + i + ' ' + JSON.stringify(q.rect)) })
  assert.ok(res.some((q) => !q.ok), '确实有放不下的（ok = false）')
})

t('名字比格还宽：矩形宽度夹到格内可用宽', () => {
  const items = [{ x: 100, y: 300, w: 5000, h: FS * 1.3 }]
  const [q] = placeCallouts(items, base)
  assert.ok(inside(q.rect, BOX, PAD))
})

t('确定性：同一输入两次结果逐位相同；输出与 items 同序', () => {
  const items = [{ x: 500, y: 100, w: 120, h: 20 }, { x: 100, y: 500, w: 90, h: 20 }, { x: 330, y: 330, w: 150, h: 20 }]
  const a = placeCallouts(items, base), b = placeCallouts(items, base)
  assert.deepEqual(a, b)
  // 各自贴近自己的锚点（引线终点离锚点 < 格宽一半）
  a.forEach((q, i) => assert.ok(Math.hypot(q.lx - items[i].x, q.ly - items[i].y) < CELL / 2))
})

t('坏输入不抛：空 items / 缺 box', () => {
  assert.deepEqual(placeCallouts([], base), [])
  const r = placeCallouts([{ x: 5, y: 5, w: 10, h: 10 }])
  assert.equal(r.length, 1)
})

t('wrapLabel：逐字折行（中文），有空格优先在空格处断，每行不超宽', () => {
  const m = (s) => Array.from(s).length * 10
  const zh = wrapLabel('Ku频段多波束接收天线东半球覆盖', 60, m)
  assert.ok(zh.length >= 3)
  for (const l of zh) assert.ok(m(l) <= 60, l)
  assert.equal(zh.join(''), 'Ku频段多波束接收天线东半球覆盖')
  const en = wrapLabel('Single Access Antenna West', 120, m)
  assert.deepEqual(en, ['Single', 'Access', 'Antenna West'])
  assert.deepEqual(wrapLabel('一', 5, m), ['一'], '一个字都放不下也放一个字')
  assert.deepEqual(wrapLabel('', 50, m), [''])
})

console.log(`modelCallouts: ${n} 项通过`)
