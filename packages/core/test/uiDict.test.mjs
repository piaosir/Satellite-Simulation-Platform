// UI 词典自检 —— 守住三条：译文里不留中文、槽位守恒、模式不会「匹配一切又原样返回」。
// 第三条是踩过的坑：只靠标点锚定的模式（`${x}-${y}`、`点${i+1}`）会命中一大片却把输入原样
// 吐回来，而运行时命中即 break，后面真正对得上的条目再也轮不到——表现为整句译文里冒出中文岛。
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..')
const HAN = /[一-鿿]/
const SLOT_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}/g
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lits = (s) => s.split(SLOT_RE)
const hanCount = (s) => (s.match(/[一-鿿]/g) || []).length

// 策展的组合模式：只靠标点锚定，但配运行时的捕获组递归是有意为之（拆「标签：说明（单位）」）
const COMPOSE = new Set(['${a}。${b}', '${a}；${b}', '（${a}）', '${a}：${b}', '${a}: ${b}',
  '${a}——${b}', '${a}（${b}）', '${a} / ${b}', '${a} · ${b}', '${a} → ${b}'])

const src = fs.readFileSync(path.join(ROOT, 'src/shared/i18n/uiDict.data.js'), 'utf8').replace(/\bexport const /g, 'const ')
const { EXACT, PAT } = new Function(src + '\nreturn { EXACT, PAT }')()

let fails = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`PASS  ${msg}${extra ? '  (' + extra + ')' : ''}`)
  else { console.log(`FAIL  ${msg}${extra ? '  (' + extra + ')' : ''}`); fails++ }
}

// —— EXACT ——
let emptyVal = 0, hanVal = 0
for (const [k, v] of Object.entries(EXACT)) {
  if (typeof v !== 'string' || !v.trim()) { emptyVal++; if (emptyVal < 4) console.log('   空译文:', k) }
  else if (HAN.test(v)) { hanVal++; if (hanVal < 4) console.log('   残留中文:', k, '=>', v) }
}
ok(emptyVal === 0, 'EXACT：无空译文', `${Object.keys(EXACT).length} 条`)
ok(hanVal === 0, 'EXACT：译文无残留中文')

// —— PAT ——
let slotBad = 0, hanLit = 0, weak = 0, notSelf = 0
for (const [zh, en] of PAT) {
  const lz = lits(zh), le = lits(en)
  if (lz.length !== le.length) { slotBad++; if (slotBad < 4) console.log('   槽位数不等:', zh); continue }
  if (le.some((l) => HAN.test(l))) { hanLit++; if (hanLit < 4) console.log('   字面量残留中文:', zh, '=>', en); continue }

  // 锚定强度：非策展模式不许只靠标点站住
  if (!COMPOSE.has(zh)) {
    const openHead = lz[0] === '', openTail = lz[lz.length - 1] === ''
    const bad = lz.join('').trim().length < 1
      || hanCount(lz.join('')) < 1
      || (openHead && openTail && hanCount(lz.slice(1, -1).join('')) < 2)
      || (openTail && !openHead && hanCount(lz[0]) < 2)
    if (bad) { weak++; if (weak < 6) console.log('   锚定过弱:', zh); continue }
  }

  // 自洽：拿哨兵值把模板实例化，正则应命中且译文把每个槽位值原样搬过去。
  // 正则的拼法必须与 runtime.js 的 compilePat 一致——含「收尾槽位不跨组合分隔符」那条。
  const vals = []
  const inst = lz.reduce((acc, lit, i) => (i === 0 ? lit : (vals.push(`V${i}#`), acc + `V${i}#` + lit)))
  const openTail = lz[lz.length - 1] === '' && lz.some((l) => HAN.test(l))
  const TAIL = '((?:(?!' + [' · ', ' / ', ' → ', '——', '；', '。', '：'].map(esc).join('|') + ')[\\s\\S])*?)'
  const body = lz.map(esc).reduce((acc, lit, i) => (i === 0 ? lit
    : acc + ((i === lz.length - 1 && openTail) ? TAIL : '([\\s\\S]*?)') + lit), '')
  const m = new RegExp('^' + body + '$').exec(inst)
  if (!m) { notSelf++; if (notSelf < 4) console.log('   模式不自洽:', zh); continue }
  let out = le[0]
  for (let i = 1; i < le.length; i++) out += m[i] + le[i]
  if (!vals.every((v) => out.includes(v))) { notSelf++; if (notSelf < 4) console.log('   译文丢槽位值:', zh) }
}
ok(slotBad === 0, 'PAT：槽位数守恒', `${PAT.length} 条`)
ok(hanLit === 0, 'PAT：槽位外无残留中文')
ok(weak === 0, 'PAT：无「只靠标点锚定」的模式')
ok(notSelf === 0, 'PAT：模式自洽且槽位值原样透传')

// —— 组合模式的先后：谁先命中就在谁那儿切开，切错一层里面整条就查不到表了 ——
const idx = (k) => PAT.findIndex((p) => p[0] === k)
const iWrap = idx('（${a}）'), iColon = idx('${a}：${b}'), iParen = idx('${a}（${b}）')
const iSemi = idx('${a}；${b}'), iStop = idx('${a}。${b}')
ok(iWrap === -1 || iParen === -1 || iWrap < iParen, '组合模式：整串解包排在括号切分之前')
ok(iColon === -1 || iParen === -1 || iColon < iParen, '组合模式：冒号切分排在括号切分之前',
  `冒号 #${iColon} < 括号 #${iParen}`)
// 句号/分号最后：整句常常本来就在 EXACT 里，先按句切反而把它拆散（踩过——「名称随所选卫星
// 自动生成；…（清空名称可恢复自动）」被分号先切走，两半都查不到表）
ok(iSemi === -1 || iSemi > iParen, '组合模式：分号切分排在括号切分之后', `分号 #${iSemi}`)
ok(iStop === -1 || iStop > iSemi, '组合模式：句号切分排在最末', `句号 #${iStop}`)

console.log(`\n${fails ? '✗ ' + fails + ' 项未通过' : '全部通过'}`)
process.exit(fails ? 1 : 0)
