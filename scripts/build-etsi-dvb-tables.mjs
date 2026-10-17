// 从 ETSI 原文 PDF 抽 DVB-S2 / S2X 的误码性能表，生成 packages/core/data/etsiDvbS2.json。
//
//   node scripts/build-etsi-dvb-tables.mjs <EN302307-1 V1.4.1 PDF> <EN302307-2 V1.4.1 PDF>
//
// 原文（ETSI 官方交付目录，免费下载；直连时 curl 要带浏览器 User-Agent）：
//   EN 302 307-1 V1.4.1 (2014-11)  https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf
//     499 949 B  SHA-256 19077f80420eb17519fcf6f83e2847d7a877940b134c5306814b8c6f60d8475d
//   EN 302 307-2 V1.4.1 (2024-08)  https://www.etsi.org/deliver/etsi_en/302300_302399/30230702/01.04.01_60/en_30230702v010401p.pdf
//     1 786 312 B  SHA-256 72b013ca8ca957c26a8e5fc70d491fc5c49065d25ff56ab8ae86087f35664fdd
//
// 抽表工具：xpdf / poppler 的 pdftotext（Git for Windows 自带 /mingw64/bin/pdftotext），用 -table 模式——
// 这几张表的各列在 PDF 里是分别定位的文本块，-layout 模式会把数值列整体错开一行（表 20a 的 Es/N0 列
// 会从第二行起往上漂），-table 按版面行对齐才是逐行对得上的。抽完逐行自检：
//   ① 行数与原表一致（13：28 行；20a：39 行；20b：3 行；20c：22 行）；
//   ② 频谱效率 ≈ 调制阶数 × 码率 × 帧效率（0.95–0.995），对不上即说明列错位；
//   ③ 同一调制族内码率升序时 Es/N0 单调不减（-L 星座与同码率常规星座不互比）。
// 任何一条不过就不写文件。表 13 / 20a–20c 的版面在页 36（-1）与页 53–54（-2）。
//
// 输出的每行都带 mod / fec / L（-L 后缀）/ spread（BPSK-S 的扩频因子 2），消费方不必再解析名字。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'packages/core/data/etsiDvbS2.json')

const SRC = {
  'EN302307-1': {
    doc: 'ETSI EN 302 307-1 V1.4.1 (2014-11)',
    url: 'https://www.etsi.org/deliver/etsi_en/302300_302399/30230701/01.04.01_60/en_30230701v010401p.pdf',
    bytes: 499949,
    sha256: '19077f80420eb17519fcf6f83e2847d7a877940b134c5306814b8c6f60d8475d'
  },
  'EN302307-2': {
    doc: 'ETSI EN 302 307-2 V1.4.1 (2024-08)',
    url: 'https://www.etsi.org/deliver/etsi_en/302300_302399/30230702/01.04.01_60/en_30230702v010401p.pdf',
    bytes: 1786312,
    sha256: '72b013ca8ca957c26a8e5fc70d491fc5c49065d25ff56ab8ae86087f35664fdd'
  }
}

const [pdf1, pdf2] = process.argv.slice(2)
if (!pdf1 || !pdf2) { console.error('用法：node scripts/build-etsi-dvb-tables.mjs <EN302307-1.pdf> <EN302307-2.pdf>'); process.exit(2) }
for (const [k, f] of [['EN302307-1', pdf1], ['EN302307-2', pdf2]]) {
  const buf = fs.readFileSync(f)
  const h = createHash('sha256').update(buf).digest('hex')
  if (h !== SRC[k].sha256 || buf.length !== SRC[k].bytes) { console.error(`${f}：SHA-256 / 大小与 ${SRC[k].doc} 不符（${h}）`); process.exit(1) }
}

const pageText = (f, a, b) => execFileSync('pdftotext', ['-table', '-f', String(a), '-l', String(b), f, '-'], { encoding: 'utf8' })
const numOf = (s) => Number(String(s).replace(',', '.'))
// 名字 → 调制方式 / 码率 / -L / 扩频（BPSK-S = π/2-BPSK 扩频因子 2，见 EN 302 307-2 §5.4.0a）
const NAME_RE = /^(BPSK-S|BPSK|QPSK|8PSK|8APSK|16APSK|32APSK|64APSK|128APSK|256APSK) (\d+\/\d+)(-L)?$/
function parts(name) {
  const m = NAME_RE.exec(name)
  if (!m) throw new Error('认不出的 MODCOD 名：' + name)
  return { mod: m[1] === 'BPSK-S' ? 'BPSK' : m[1], fec: m[2], L: !!m[3], spread: m[1] === 'BPSK-S' ? 2 : 1 }
}
const BITS = { BPSK: 1, QPSK: 2, '8PSK': 3, '8APSK': 3, '16APSK': 4, '32APSK': 5, '64APSK': 6, '128APSK': 7, '256APSK': 8 }
const rate = (fec) => { const [a, b] = fec.split('/').map(Number); return a / b }
const NAME = '((?:BPSK-S|BPSK|QPSK|8PSK|8APSK|16APSK|32APSK|64APSK|128APSK|256APSK) \\d+/\\d+(?:-L)?)'
const NUM = '(-?\\d+,\\d+|-?\\d+)'

// —— 表 13（EN 302 307-1 第 36 页）：名字 / 频谱效率 / Es/N0 ——
function table13(txt) {
  const rows = []
  const re = new RegExp('^\\s*' + NAME + '\\s+' + NUM + '\\s+' + NUM + '\\s*$')
  for (const line of txt.split(/\r?\n/)) {
    const m = re.exec(line)
    if (m) rows.push({ name: m[1], ...parts(m[1]), se: numOf(m[2]), esno: numOf(m[3]) })
  }
  return rows
}
// —— 表 20a（EN 302 307-2 第 53–54 页）：名字 / 频谱效率 / Es/N0 [(note 3)] / Csat/(N0Rs) ——
function table20a(txt) {
  const rows = []
  const re = new RegExp('^\\s*' + NAME + '\\s+' + NUM + '\\s+' + NUM + '(\\s+\\(note\\s+3\\))?\\s+' + NUM + '\\s*$')
  for (const line of txt.split(/\r?\n/)) {
    const m = re.exec(line.replace(/\(note\s+3\)/, '(note 3)'))
    if (m) {
      const r = { name: m[1], ...parts(m[1]), se: numOf(m[2]), esno: numOf(m[3]), hl: numOf(m[5]) }
      if (m[4]) r.frame = 61560   // 表 20a 注 3：QPSK 2/9（VL-SNR）的 FECFRAME 长 61 560
      rows.push(r)
    }
  }
  return rows
}
// —— 表 20b / 20c（第 54 页）：名字 / Es/N0 [(note n)] ——
function tableEsno(txt, head, tail, notes) {
  const a = txt.indexOf(head), b = tail ? txt.indexOf(tail, a + 1) : -1
  const seg = txt.slice(a, b > a ? b : undefined)
  const rows = []
  const re = new RegExp('^\\s*' + NAME + '\\s+' + NUM + '(?:\\s+\\(note\\s+(\\d)\\))?\\s*$')
  for (const line of seg.split(/\r?\n/)) {
    const m = re.exec(line)
    if (!m) continue
    const r = { name: m[1], ...parts(m[1]), esno: numOf(m[2]) }
    if (m[3]) r.frame = notes[m[3]]
    rows.push(r)
  }
  return rows
}

const t13 = table13(pageText(pdf1, 36, 36))
const p2 = pageText(pdf2, 53, 54)
const t20a = table20a(p2)
// 20c 的注 1 / 注 2：BPSK-S 两档 FECFRAME 15 390、π/2-BPSK 1/5 与 4/15 两档 14 976（版面在表下方）
const t20b = tableEsno(p2, 'Table 20b', 'Table 20c', {})
const t20c = tableEsno(p2, 'Table 20c', 'NOTE 2:  The FECFRAME length is 14 976', { 1: 15390, 2: 14976 })

// —— 自检 ——
const fails = []
const expectLen = (nm, rows, n) => { if (rows.length !== n) fails.push(`${nm} 行数 ${rows.length} ≠ ${n}`) }
expectLen('表 13', t13, 28); expectLen('表 20a', t20a, 39); expectLen('表 20b', t20b, 3); expectLen('表 20c', t20c, 22)
for (const [nm, rows] of [['表 13', t13], ['表 20a', t20a]]) {
  for (const r of rows) {
    const eff = r.se / (BITS[r.mod] * rate(r.fec))
    if (!(eff > 0.95 && eff < 0.995)) fails.push(`${nm} ${r.name}：频谱效率 ${r.se} 与 ${BITS[r.mod]}×${r.fec} 对不上（${eff.toFixed(4)}）`)
  }
}
for (const [nm, rows] of [['表 13', t13], ['表 20a', t20a], ['表 20b', t20b], ['表 20c', t20c]]) {
  const fam = {}
  for (const r of rows) (fam[r.mod + (r.L ? '-L' : '') + (r.spread > 1 ? '-S' : '') + (r.frame || '')] ||= []).push(r)
  for (const [k, list] of Object.entries(fam)) {
    const s = list.slice().sort((x, y) => rate(x.fec) - rate(y.fec))
    for (let i = 1; i < s.length; i++) if (s[i].esno < s[i - 1].esno) fails.push(`${nm} ${k}：${s[i].name} ${s[i].esno} < ${s[i - 1].name} ${s[i - 1].esno}`)
  }
}
if (fails.length) { console.error('自检不过，未写文件：\n  ' + fails.join('\n  ')); process.exit(1) }

const out = {
  about: 'ETSI DVB-S2 / S2X 误码性能原表的逐值转录（AWGN 线性信道 Es/N0 门限 + 表 20a 的硬限幅信道 Csat/(N0·Rs)）。由 scripts/build-etsi-dvb-tables.mjs 从 ETSI 原文 PDF 抽取并自检，勿手改；packages/core/utils/constants.js 据此生成内置 MODCOD 表，packages/core/test/etsiTables.test.mjs 逐值钉住。',
  sources: SRC,
  // 内置 MODCOD 标准（constants.js 的 dvbStandard 键）→ 依据的原表，按序查（DVB-S2X 正常帧先查表 20a，S2 遗留档落到表 13）
  standards: {
    'DVB-S2': ['S2-13'],
    'DVB-S2X': ['S2X-20a', 'S2-13'],
    'DVB-S2X Short': ['S2X-20c'],
    'DVB-S2X VL-SNR Medium': ['S2X-20b']
  },
  tables: {
    'S2-13': {
      source: 'EN302307-1', table: '13', clause: '6', page: 36,
      title: 'Es/No performance at Quasi Error Free PER = 10-7 (AWGN channel)',
      channel: 'AWGN', frame: 64800, iterations: 50,
      qef: { kind: 'PER', exp: 7, def: 'Transport Stream Packet Error Ratio (188-byte packets) after FEC, §4.1 / clause 6' },
      rows: t13
    },
    'S2X-20a': {
      source: 'EN302307-2', table: '20a', clause: '6', page: 53,
      title: 'Performance at Quasi Error Free FER=10-5, Normal FECFRAMES, 50 iterations',
      channel: 'AWGN', frame: 64800, iterations: 50,
      qef: { kind: 'FER', exp: 5, def: 'Frame Error Ratio of useful FECFRAMEs after FEC, clause 6' },
      hl: 'Ideal Csat/(N0Rs) on the non-linear hard-limiter channel (informative, note 2): optimised IBO, roll-off 10 %, Csat = hard-limiter saturated single-carrier power, N0Rs = noise power in the symbol-rate bandwidth',
      rows: t20a
    },
    'S2X-20b': {
      source: 'EN302307-2', table: '20b', clause: '6', page: 54,
      title: 'Es/N0 Performance at Quasi Error Free FER=10-5 (AWGN Channel), medium XFECFRAMEs, 75 iterations',
      channel: 'AWGN', frame: 30780, iterations: 75,
      qef: { kind: 'FER', exp: 5, def: 'Frame Error Ratio of useful FECFRAMEs after FEC, clause 6' },
      rows: t20b
    },
    'S2X-20c': {
      source: 'EN302307-2', table: '20c', clause: '6', page: 54,
      title: 'Es/N0 Performance at Quasi Error Free FER=10-5 (AWGN Channel), Short XFECFRAMEs, 75 iterations pi/2 BPSK modes, 50 iterations other modes',
      channel: 'AWGN', frame: 16200, iterations: '75 (π/2-BPSK) / 50',
      qef: { kind: 'FER', exp: 5, def: 'Frame Error Ratio of useful FECFRAMEs after FEC, clause 6' },
      rows: t20c
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`已写 ${path.relative(ROOT, OUT)}：表 13 ${t13.length} 行、表 20a ${t20a.length} 行、表 20b ${t20b.length} 行、表 20c ${t20c.length} 行`)
