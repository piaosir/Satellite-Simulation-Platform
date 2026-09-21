import { reactive, computed } from 'vue'
import { diagMsg } from './log.js'

// 命令注册表 —— 顶部搜索框（仿 Office 标题栏「搜索」/ 旧版「告诉我你想要做什么」）的数据源。
//
// 谁登记：App.vue 登记菜单 / 工具栏 / 活动栏视图 / 侧栏分区 / 设置项 / 文件管理页签；
//         星座地图页在挂载时登记只有它自己才够得着的动作（绘制多边形、投影档、图层开关…），卸载时注销。
// 登记的是 getter 而不是数组：命令的可用性（disabled）与勾选态（check）随程序状态走，每次取用时现算。
//
// 命令形状：
//   { id, label, icon?, group?, keywords?: string[], hint?, lock?, disabled?, check?, run?, children?: Command[] }
//   - id      稳定标识（最近使用记忆按它存，改名不丢历史）
//   - group   所在位置（菜单名 / 视图名），结果行里作次级文字，也参与匹配
//   - path    所在分区（参数行用：显示成「分区 › 行」），也参与匹配
//   - keywords 同义词 / 英文名 / 缩写，只参与匹配不显示
//   - lock    受激活锁约束（与菜单项同义）
//   - children 有子项的命令是「带 ▸ 的行」：点开飞出子菜单，本身不执行（Office 的「方向 ▸ 纵向 / 横向」）
const providers = reactive(new Map())

export function registerCommands(key, getter) {
  warned.delete(key)
  providers.set(key, getter)
  return () => { if (providers.get(key) === getter) providers.delete(key) }
}

// 全部命令（扁平；子项不展开，匹配时另行下钻）
// ★ 登记方抛错不连累其余，但【不能静默】：某个 getter 一旦抛错（如 3D 页卸载 / 重挂载期间回调为 null），
//   该来源的命令整批消失 —— 搜什么都「没有匹配的操作」，界面上一点痕迹都没有。同一个 key 只报一次
//   （computed 每次取用都会跑，出错的 getter 会一直错，不设闸会把控制台刷爆）。
const warned = new Set()
export const commands = computed(() => {
  const out = []
  for (const [key, g] of providers) {
    if (!g) continue
    try {
      const list = typeof g === 'function' ? g() : g
      if (Array.isArray(list)) out.push(...list)
    } catch (e) {
      if (!warned.has(key)) { warned.add(key); console.warn('[commands] 登记方「' + key + '」取命令时抛错，该来源本次整批缺席：', e) }
      diagMsg('命令登记方「' + key + '」抛错：' + ((e && e.message) || e))
    }
  }
  return out
})
// 登记方重新挂上时清掉它的「已报过」标记：下一轮再抛错要能再报一次
export function clearCommandWarn(key) { warned.delete(key) }

// ---- 最近使用的操作（本地记忆，跨会话）----
const RECENT_KEY = 'cmd-search-recent-v1'
const RECENT_CAP = 10
function loadRecent() {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_CAP) : [] } catch { return [] }
}
export const recent = reactive({ ids: loadRecent() })
export function noteUsed(id) {
  if (!id) return
  const ids = [id, ...recent.ids.filter((x) => x !== id)].slice(0, RECENT_CAP)
  recent.ids = ids
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

// ---- 匹配 ----
// 规整：小写、去空白与标点，让「链路 预算」「链路预算」「link-budget」「linkbudget」同一口径。
const STRIP = /[\s·•・,，。、;；:：()（）[\]【】「」『』“”"'‘’…\-—–_/／\|‖>›»?？!！]+/g
export const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(STRIP, '')

// 单个词元对一条命令的得分：标题前缀 > 标题包含 > 关键词前缀 > 关键词包含 > 位置包含 > 说明包含；0 = 不命中
function tokenScore(tok, f) {
  if (!tok) return 0
  if (f.label === tok) return 200
  if (f.label.startsWith(tok)) return 100
  if (f.label.includes(tok)) return 60
  for (const k of f.keys) { if (k === tok) return 55; if (k.startsWith(tok)) return 50 }
  for (const k of f.keys) if (k.includes(tok)) return 35
  if (f.group && f.group.includes(tok)) return 20
  if (f.hint && f.hint.includes(tok)) return 10
  return 0
}
function fields(cmd, parent) {
  return {
    label: norm(cmd.label),
    keys: (cmd.keywords || []).map(norm).filter(Boolean),
    // 子项的「位置」取父项所在位置，不取父项标题：否则输「投影」会把六个投影档全列出来（父项本身已带 ▸）
    // path = 行所在分区（「边界线 › 线粗」的前半），与所在视图一起算「位置」
    group: norm(parent ? parent.group : (cmd.path ? cmd.path + ' ' : '') + (cmd.group || '')),
    hint: norm(cmd.hint)
  }
}
export function tokenize(q) {
  return String(q || '').trim().toLowerCase().split(/\s+/).map(norm).filter(Boolean)
}
// 命令必须被【每个】词元命中（多词 = 交集）；总分为各词元之和。子项单独成一条结果（带 parent）。
export function searchCommands(q, list, limit = 8) {
  const toks = tokenize(q)
  if (!toks.length) return []
  const hits = []
  let order = 0
  const consider = (cmd, parent) => {
    const f = fields(cmd, parent)
    let total = 0
    for (const t of toks) {
      const s = tokenScore(t, f)
      if (!s) { total = 0; break }
      total += s
    }
    if (total > 0) hits.push({ cmd, parent, score: total - (parent ? 5 : 0), len: f.label.length, order: order++ })
  }
  for (const cmd of list) {
    consider(cmd, null)
    if (Array.isArray(cmd.children)) for (const c of cmd.children) consider(c, cmd)
  }
  hits.sort((a, b) => b.score - a.score || a.len - b.len || a.order - b.order)
  return hits.slice(0, limit)
}
