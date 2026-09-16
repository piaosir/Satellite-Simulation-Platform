// SATCAT（CelesTrak 全量卫星编目 CSV）的有效性判据 —— 纯逻辑、无依赖、只读入参。
//
// 为什么单列一份：星历那条链路的判据是 `/MEAN_MOTION/i`，而 SATCAT 是编目不是星历，整份文件里
// 根本没有 MEAN_MOTION 列。直接复用会把每一次下载都判成「内容非有效 OMM」，于是四级链路每一级
// 都判失败：直连白丢、云镜像白丢、快照脚本走「下载失败，保留旧快照」——表现为 SATCAT 永远取不到。
//
// 一份实现三处共用（别再抄第二份）：
//   · electron/services/omm.js（CJS）            —— `require('../../packages/core/utils/satcatValid.js')`
//   · scripts/fetch-omm-snapshot.mjs（ESM）      —— `createRequire(import.meta.url)` 反向桥接
//   · packages/core/test/ommCacheFirst.test.mjs  —— 同上
// 故本文件必须是 CJS（`packages/core` 下无 package.json、根 package.json 无 "type"，`.js` 一律 CJS）。
//
// 判据三条（2026-09-16 实测：6,737,839 B / 70,667 数据行 / 17 列 / 无带引号的行）：
//   ① 首个非空行是表头且含五个必需列名 —— 拦「拿到的是别的 CSV / 是 HTML 错误页 / 是 GP 星历」；
//   ② 数据行 ≥ minRows（出厂 50000，实测约 7 万）—— 拦「只有表头 / 空表」；
//   ③ 最后一条非空行拆出恰好 SATCAT_COLS 列 —— 拦【截断】：半途断连拿到的前半份文件，①②都过得去
//      （表头在、行数也够），只有末行会缺列甚至只剩前几个字段，这是唯一能查出来的痕迹。
//
// ★ 判据③的代价：CelesTrak 哪天给 satcat.csv 加第 18 列，本判据会把新数据全判无效、静默退回旧快照。
//   宁可这样也不放宽 —— 截断的编目会让报告里的「在轨 / 已陨落」凭空少掉几万条，而且不报错。
//   真加列时改这里的 SATCAT_COLS 一处即可（三处调用方都从本文件取）。

// 表头必需列（大小写不敏感比对）：不是全部 17 列，只取「换了数据源就一定缺」的五个骨架列
const SATCAT_HEAD_COLS = ['NORAD_CAT_ID', 'OBJECT_TYPE', 'OPS_STATUS_CODE', 'LAUNCH_DATE', 'DECAY_DATE']
const SATCAT_COLS = 17        // 表头与每条数据行的列数（附录 A 的 17 列）
const SATCAT_MIN_ROWS = 50000 // 数据行下限：2026-09 实测 70667，留足余量只为拦空表/半截表

// CSV 单行拆列（RFC 4180：引号包裹的字段里允许逗号，`""` 是一个字面引号）。
// 当前 satcat.csv 没有任何带引号的行，但用户导入的文件（Excel 另存）一定会有 —— 解析器不许裸 split(',')。
// 注意：字段内含换行的情形本函数管不了（调用方是按行切好再进来的）；SATCAT 不会出现这种字段。
function splitCsvLine(line) {
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c !== '"') { cur += c; continue }
      if (line[i + 1] === '"') { cur += '"'; i++; continue }   // "" → 一个字面引号
      quoted = false
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      out.push(cur); cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

/**
 * 是不是一份可用的 SATCAT 编目 CSV。
 * @param {string} text 原文
 * @param {{minRows?: number}} [opts] minRows 只为测试夹具能把行数门槛降下来；生产一律用出厂值
 * @returns {boolean}
 */
function validSatcat(text, opts = {}) {
  if (!text || typeof text !== 'string') return false
  const minRows = Number.isFinite(opts.minRows) ? opts.minRows : SATCAT_MIN_ROWS
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length)
  if (lines.length < 2) return false
  // ① 表头：去 BOM（用户从 Excel 另存的文件常带）后按大写比对列名
  const head = lines[0].replace(/^﻿/, '').toUpperCase()
  const cols = splitCsvLine(head).map((s) => s.trim())
  for (const need of SATCAT_HEAD_COLS) if (!cols.includes(need)) return false
  // ② 数据行数（首行是表头）
  if (lines.length - 1 < minRows) return false
  // ③ 末行列数：截断的唯一痕迹
  return splitCsvLine(lines[lines.length - 1]).length === SATCAT_COLS
}

module.exports = { validSatcat, splitCsvLine, SATCAT_COLS, SATCAT_HEAD_COLS, SATCAT_MIN_ROWS }
