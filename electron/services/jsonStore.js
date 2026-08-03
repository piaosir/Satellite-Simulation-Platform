// JSON 库文件的原子写 + 损坏回退（storage / customSats / coverageGxt 共用一份实现）。
// 单抽一处是因为这两件事必须成对：哪个库漏了原子写，它的下一次读就会把半截文件当成
// 「空库」，紧接着的写再拿空库整份覆盖 —— 旧数据就永久没了（盘上的 .gxt 还在，索引没了）。
const fs = require('fs')

// 先写满 .tmp，保留上一份 .bak，再 rename 覆盖（Windows MoveFileEx 覆盖）。
// 崩溃/断电至多丢「本次未落盘的改动」，不会留下被截断的主文件。
function writeJsonAtomic(f, val, space) {
  const tmp = f + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(val, null, space))
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak') } catch { /* 备份尽力而为 */ }
  fs.renameSync(tmp, f)
}

// 读 JSON：主文件读不出就退到 .bak。返回 { value, corrupt }——
// corrupt=true 专指「文件在、两份都解析不出」，与「本来就没有这个文件」是两回事：
// 前者绝不能当空库用，调用方据此拒写，别让下一次写把坏文件整份覆盖掉。
function readJsonSafe(f, def) {
  let corrupt = false
  try { return { value: JSON.parse(fs.readFileSync(f, 'utf8')), corrupt: false } }
  catch (e) { corrupt = !(e && e.code === 'ENOENT') }
  try { return { value: JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), corrupt: false } }
  catch { return { value: def, corrupt } }
}

module.exports = { writeJsonAtomic, readJsonSafe }
