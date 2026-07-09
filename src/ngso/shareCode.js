// 链路预算配置「分享码」编解码（线下分享：复制文本 / 文件互导）。
// 格式：前缀 LBCFG1. + URL-safe base64(JSON{app,kind,v,name,state})。base64 走 TextEncoder 字节，
// 中文等多字节安全。文件导入也兼容直接传纯 JSON 文本。
const PREFIX = 'LBCFG1.'

function bytesToB64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64ToStr(b64) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

// 规整为配置数组 [{name,state}]（支持单条对象或数组）
function normItems(items) {
  return (Array.isArray(items) ? items : [items]).filter((it) => it && it.state).map((it) => ({ name: it.name || '配置', state: it.state }))
}
// 配置数组 → 分享码字符串（v2 多配置 bundle）
export function encodeShare(items) {
  return PREFIX + bytesToB64(JSON.stringify({ app: 'satlink', kind: 'lbcfg', v: 2, items: normItems(items) }))
}
// 文件导出用的可读 JSON 文本（与分享码同 payload）
export function configFileText(items) {
  return JSON.stringify({ app: 'satlink', kind: 'lbcfg', v: 2, items: normItems(items) }, null, 2)
}
// 分享码 / 纯 JSON 文本 → 配置数组 [{name,state}]；兼容 v1 单条。非法抛错。
export function decodeShare(input) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) throw new Error('内容为空')
  let o
  if (raw[0] === '{') {
    o = JSON.parse(raw)
  } else {
    let body = raw
    const at = body.indexOf(PREFIX)
    if (at >= 0) body = body.slice(at + PREFIX.length)
    o = JSON.parse(b64ToStr(body.replace(/\s+/g, '')))
  }
  if (o && Array.isArray(o.items)) {
    const list = normItems(o.items)
    if (list.length) return list
  }
  if (o && o.state) return [{ name: o.name || '导入配置', state: o.state }]   // v1 单条兼容
  throw new Error('无效的分享内容')
}
