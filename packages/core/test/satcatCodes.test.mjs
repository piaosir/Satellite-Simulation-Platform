// SATCAT 代码表（src/shared/satcatCodes.js，由 scripts/build-satcat-codes.mjs 生成）。
//
// 这份测试防两件事：
//   ① 生成脚本的 HTML 解析被上游改版悄悄打穿 —— 表还在、但只剩几条，或某条只有英文没中文；
//   ② 表漏收 —— 真实编目里出现了表里没有的代码，报告上就会冒出一列裸代码。
//      ②只在内置快照存在时才跑（首次装仓库、或 resources/omm 被清空时自动跳过），
//      判据是【未命中 0 个】：2026-09-16 实测上游 sources.php 少收 4 个所有者（JOR/KWT/SVK/UGA），
//      已在生成脚本的 MANUAL_OWNER 里补上 —— 再多出来的就是真漏了，得回去重跑生成脚本。
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++ }

const C = await import('../../../src/shared/satcatCodes.js')

// ① 七张表的形状
const TABLES = [
  ['OWNER', C.OWNER, 100],
  ['LAUNCH_SITE', C.LAUNCH_SITE, 30],
  ['OPS_STATUS', C.OPS_STATUS, 8],
  ['OBJECT_TYPE', C.OBJECT_TYPE, 4],
  ['ORBIT_TYPE', C.ORBIT_TYPE, 5],
  ['DATA_STATUS', C.DATA_STATUS, 3],
  ['ORBIT_CENTER', C.ORBIT_CENTER, 10]
]
for (const [name, table, min] of TABLES) {
  ok(Object.keys(table).length >= min, `① ${name} 至少 ${min} 条（实有 ${Object.keys(table).length}）`)
  const bad = Object.entries(table).filter(([, v]) => !v || !v.en || !v.zh)
  eq(bad.map(([k]) => k), [], `① ${name} 每条都有 en 与 zh`)
}

// ② 类型 / 状态 / 轨道类型的取值与 CelesTrak 定义一致（判据的基石，错了整份报告都错）
eq(Object.keys(C.OBJECT_TYPE).sort(), ['DEB', 'PAY', 'R/B', 'UNK'], '② OBJECT_TYPE 四项')
eq(Object.keys(C.ORBIT_TYPE).sort(), ['DOC', 'IMP', 'LAN', 'ORB', 'R/T'], '② ORBIT_TYPE 五项')
eq(Object.keys(C.OPS_STATUS).sort(), ['+', '-', '?', 'B', 'D', 'P', 'S', 'X'], '② OPS_STATUS 八项')
eq(C.ACTIVE_STATUS.slice().sort(), ['+', 'B', 'P', 'S', 'X'], '② 活跃载荷状态码 + P B S X')
ok(!C.ACTIVE_STATUS.includes('D') && !C.ACTIVE_STATUS.includes('-'), '② 已陨落 / 停运不算活跃')

// ③ 主权口径（与 frozen.js 的台港澳红线一致）
eq(C.ownerName('ROC'), '中国台湾', '③ ROC 中文「中国台湾」')
eq(C.ownerName('ROC', 'en'), 'Taiwan, China', '③ ROC 英文 Taiwan, China')
eq(C.ownerName('STCT'), '新加坡/中国台湾', '③ STCT 中文')
eq(C.ownerName('STCT', 'en'), 'Singapore/Taiwan, China', '③ STCT 英文')
const zhAll = Object.values(C.OWNER).map((v) => v.zh).join('|')
const enAll = Object.values(C.OWNER).map((v) => v.en).join('|')
ok(!zhAll.includes('中华民国'), '③ 中文名里没有「中华民国」')
ok(!/Republic of China\b/.test(enAll.replace(/People's Republic of China/g, '')), '③ 英文名里没有落单的 Republic of China')
eq(C.ownerName('PRC'), '中国', '③ PRC 中文「中国」')

// ④ 查不到的代码原样回退（报告里不留空）
eq(C.ownerName('ZZZZ'), 'ZZZZ', '④ 未知所有者回退代码本身')
eq(C.launchSiteName('ZZZZZ', 'en'), 'ZZZZZ', '④ 未知发射场同理')
eq(C.orbitCenterName('25544'), '25544', '④ ORBIT_CENTER 的数字（停靠母体 NORAD）原样回退')
eq(C.ownerName(''), '', '④ 空值回空串')
eq(C.ownerName(null), '', '④ null 回空串')
eq(C.opsStatusName(' + '), '运行', '④ 取值先去空白')

// ⑤ 真实编目扫一遍：未命中必须为 0（无内置快照则跳过）
const gz = join(ROOT, 'resources', 'omm', 'csv_satcat.csv.gz')
if (existsSync(gz)) {
  const text = gunzipSync(readFileSync(gz)).toString('utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const head = lines[0].split(',').map((s) => s.trim().toUpperCase())
  const ix = (n) => head.indexOf(n)
  const cols = {
    OWNER: ix('OWNER'), LAUNCH_SITE: ix('LAUNCH_SITE'), OPS_STATUS_CODE: ix('OPS_STATUS_CODE'),
    OBJECT_TYPE: ix('OBJECT_TYPE'), ORBIT_TYPE: ix('ORBIT_TYPE'), DATA_STATUS_CODE: ix('DATA_STATUS_CODE')
  }
  const seen = {}
  for (const k of Object.keys(cols)) seen[k] = new Set()
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',')
    for (const [k, c] of Object.entries(cols)) {
      const v = (f[c] || '').trim()
      if (v) seen[k].add(v)
    }
  }
  const miss = (set, table) => [...set].filter((v) => !table[v]).sort()
  eq(miss(seen.OWNER, C.OWNER), [], `⑤ 编目里的所有者代码全部有名字（${seen.OWNER.size} 个代码）`)
  eq(miss(seen.LAUNCH_SITE, C.LAUNCH_SITE), [], `⑤ 发射场代码全部有名字（${seen.LAUNCH_SITE.size} 个代码）`)
  eq(miss(seen.OPS_STATUS_CODE, C.OPS_STATUS), [], '⑤ 运行状态码全部有名字')
  eq(miss(seen.OBJECT_TYPE, C.OBJECT_TYPE), [], '⑤ 对象类型全部有名字')
  eq(miss(seen.ORBIT_TYPE, C.ORBIT_TYPE), [], '⑤ 轨道类型全部有名字')
  eq(miss(seen.DATA_STATUS_CODE, C.DATA_STATUS), [], '⑤ 数据状态码全部有名字')
} else {
  console.log('  （无 resources/omm/csv_satcat.csv.gz，跳过真实编目扫描）')
}

console.log(`satcatCodes: ${pass} 项断言全部通过`)
