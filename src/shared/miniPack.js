// 「发送到小程序」的信封（渲染端 ESM；链路预算三窗与文件区共用）。
//
// 一个密钥 = 一个包，包里可以装多件（与 LbShareDialog 的「勾选 N 个配置 + M 条库条目」同构）。
// 通道复用 2026-07 落地的 GXT 覆盖快照那条路，一个字节都没改：
//   渲染端 → IPC share:gxtSnapshot → electron/services/share.js putSnapshot()
//   → PUT updates/gxt/<8位密钥>.json（匿名公读、不可列举，密钥即凭证）
//   → 小程序云函数 importGxtSnapshot 按密钥直链拉取
// 云函数原先硬校验 kind === 'gxt-snapshot'，本模块的包用 kind = 'satsim-pack'，
// 故【云函数的 kind 白名单是唯一要改的地方】；老版本平台发出的覆盖快照照收不误。
//
// ★ 单向。小程序侧的配置是扁平的（无三库结构），回传无法还原引用闭包，故不做回流。
//
// ★★ 大小是唯一的硬约束：微信云函数返回值上限 1 MB，而现在的实现把包内联在 data 里返回。
//    链路配置一份 ≈ 20 KB 不成问题；频率计划的绘制指令在 94 波束的 HTS 上会到几百 KB。
//    故发送前必须估一次字节数（estimateBytes），触顶就明确拒绝并提示拆分——
//    与其让用户拿到一个「导入失败」的密钥，不如在这一侧就说清楚。

export const PACK_KIND = 'satsim-pack'
export const PACK_V = 1

// 对象在 COS 上没有 TTL 会一直堆积。桶上加 lifecycle 规则要动控制台，故改由信封自带过期时间、
// 云函数据此判「已失效」——不依赖任何控制台操作，也让用户知道密钥不是永久的。
export const TTL_DAYS = 90

// 字节门限。SIZE_MAX 留出的余量给云函数的 JSON 外壳（{success, data, fileID, meta} 那一层）
// 与 UTF-8 转义膨胀；SIZE_WARN 之上仍然发得出去，只是提示一句。
export const SIZE_WARN = 640 * 1024
export const SIZE_MAX = 900 * 1024

const asArr = (x) => (Array.isArray(x) ? x : [])

/** 包内一件的一句话名字（清单与提示语共用） */
export const ITEM_LABEL = { 'lb-config': '链路配置', 'freq-plan': '频率计划', 'sat-set': '卫星集' }

/**
 * 造一个信封。items 由各调用方按类型自备（见 lbMiniExport / fpMiniExport）。
 * @param {object} o { name, from, items, ttlDays }
 */
export function makePack({ name, from, items, ttlDays } = {}) {
  const ts = Date.now()
  const days = Number.isFinite(Number(ttlDays)) ? Number(ttlDays) : TTL_DAYS
  return {
    kind: PACK_KIND,
    v: PACK_V,
    from: String(from || ''),                       // 平台版本 / 机器ID —— 小程序据此标注「平台计算值」
    ts,
    expiresAt: ts + days * 86400000,
    name: String(name || '仿真平台数据'),
    items: asArr(items).filter(Boolean)
  }
}

/** 序列化后的字节数（UTF-8）。中文在 JSON 里是 \uXXXX 还是原字符取决于 JSON.stringify —— 原字符，故按 UTF-8 数 */
export function estimateBytes(pack) {
  const s = JSON.stringify(pack)
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length
  // Node 下跑自测时的兜底
  return globalThis.Buffer ? globalThis.Buffer.byteLength(s, 'utf8') : s.length * 3
}

export const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(0) + ' KB')

/** 一句话清单：「2 个链路配置 · 1 份频率计划 · 312 KB」 */
export function describePack(pack) {
  const items = asArr(pack && pack.items)
  const byType = new Map()
  for (const it of items) byType.set(it.type, (byType.get(it.type) || 0) + 1)
  const bytes = estimateBytes(pack)
  const parts = [...byType.entries()].map(([t, n]) => `${n} 件${ITEM_LABEL[t] || t}`)
  parts.push(fmtBytes(bytes))
  return { n: items.length, bytes, text: parts.join(' · ') }
}

// ============================================================================
// 绑定投递（免密钥）——「发给谁」的另一半
// ============================================================================
// 小程序端生成一个 12 位认证码当收件地址，人肉带到平台（长按复制 → 文件传输助手 → 粘贴）。
// 一个认证码可被多个平台绑定，一个平台可绑多个认证码。通道与落盘布局见 electron/services/share.js
// 的「绑定投递」段；本模块只管渲染端这一侧：认证码校验/显示、幂等键、拆包。

export const CH_LEN = 12
const CH_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'   // 与密钥同源（去 I L O 0 1）

/** 归一：去分隔符、大写、截断。返回可能不足 12 位——由 isCh 判合法 */
export const normalizeCh = (raw) =>
  String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CH_LEN)

export const isCh = (s) => {
  const v = normalizeCh(s)
  return v.length === CH_LEN && [...v].every((c) => CH_ALPHABET.includes(c))
}

/** 显示成 ABCD-EFGH-JKMN（4 位一组，人肉抄写/核对友好） */
export const fmtCh = (s) => (normalizeCh(s).match(/.{1,4}/g) || []).join('-')

/**
 * 一件内容的幂等键。自动同步靠它做到「平台改哪一份 → 手机上覆盖哪一份」，
 * 而不是每发一次就在手机上多堆一份。
 * ★ 拿不到稳定 id 时返回空串 —— 主进程会退化为内容哈希（内容不变即同一件，改了就是新的一件）。
 *   这是【诚实的降级】：宁可多出一份，也不要用「名字」当 id 去覆盖掉一份其实不同的东西。
 */
export function syncOf(item) {
  if (!item) return ''
  if (item.type === 'lb-config') return item.srcId ? `cfg:${item.srcId}` : ''
  if (item.type === 'freq-plan') return item.meta && item.meta.id ? `fp:${item.meta.id}` : ''
  if (item.type === 'sat-set') return item.setId ? `ss:${item.setId}` : ''
  return ''
}

/** 把一件拆成自己的信封 —— 小程序侧的 importConfigs / importPlans 收的仍是标准包，零改动 */
const packOne = (pack, item) => ({
  kind: pack.kind, v: pack.v, from: pack.from, ts: pack.ts, expiresAt: pack.expiresAt,
  name: item.name || pack.name, items: [item]
})

// ---------------------------------------------------------------------------
// 投递单元：{ sync 幂等键, name, label 类型名, payload 信封 }
// ---------------------------------------------------------------------------
// 发送弹窗只认这个形状，于是同一套 UI 能同时伺候两种载荷：
//   · 标准包（链路配置 / 频率计划）→ 逐件拆成 N 个单元
//   · 整块快照（覆盖等值线 + 协调区多边形，没有 items[]）→ 就是 1 个单元
// 拆件的意义不只是省流量：一件一条消息，幂等键才挂得到内容上，自动同步才能做到
// 「平台改了哪一份，手机上更新哪一份」。

/**
 * 标准包 → 逐件拆开。
 * label 优先取件自带的（卫星集那类一个 type 下有「卫星组 / 自定义卫星 / 自定义星座」三种来源，
 * 清单上只写「卫星集」的话，三行长得一模一样，勾选时分不出哪行是哪个）。
 */
export const unitsOfPack = (pack) => asArr(pack && pack.items).map((it) => ({
  sync: syncOf(it),
  name: it.name || '',
  label: it.label || ITEM_LABEL[it.type] || it.type,
  payload: packOne(pack, it)
}))

/** 整块载荷 → 一个单元。sync 由调用方给（如 'gxt:中星6D'），保证重发覆盖同一份 */
export const unitOfRaw = (payload, o = {}) => [{
  sync: String(o.sync || ''),
  name: String(o.name || (payload && payload.name) || ''),
  label: String(o.label || '快照'),
  payload
}]

/**
 * 投递到已绑定的认证码（可多个）。
 * @param {object} api      window.api（需要 api.share.boxSend）
 * @param {string[]} chs    认证码数组
 * @param {Array} units     投递单元（unitsOfPack / unitOfRaw 造）
 * @param {object} meta     { pid 本机ID, label 本机备注名, app 版本 }
 * @returns {Promise<{ok:boolean, done:string[], fails:Array<{ch:string,error:string}>, bytes:number}>}
 */
export async function sendUnitsToBoxes(api, chs, units, meta = {}) {
  const list = asArr(units).filter((u) => u && u.payload)
  const bytes = list.reduce((s, u) => s + estimateBytes(u.payload), 0)
  if (!list.length) return { ok: false, done: [], fails: [], bytes, error: '没有可发送的内容' }
  const send = api && api.share && api.share.boxSend
  if (!send) return { ok: false, done: [], fails: [], bytes, error: '发送到小程序需在桌面客户端中运行' }

  // ★ 出 IPC 前深拷成纯数据：载荷里的 plan / state / pts 多半来自 Vue 的 reactive，
  //   响应式 Proxy 过不了结构化克隆，会当场抛「An object could not be cloned」（没 catch 时全静默）。
  const msgs = list.map((u) => ({ sync: u.sync || '', name: u.name || '', payload: JSON.parse(JSON.stringify(u.payload)) }))

  // 大小门限在【单件】上判，不在整批上判：绑定模式下一件就是一个对象、小程序按件拉，
  // 云函数 1 MB 的返回上限约束的是单件。一次发多少件都无所谓 —— 这是拆件相对密钥模式的直接好处。
  const over = msgs.filter((m) => estimateBytes(m.payload) > SIZE_MAX)
  if (over.length) {
    return {
      ok: false, done: [], fails: [], bytes,
      error: `有 ${over.length} 件单件超过 ${fmtBytes(SIZE_MAX)}（微信云函数返回上限）：${over.map((m) => m.name || '未命名').join('、')}`
    }
  }

  const o = { pid: String(meta.pid || ''), label: String(meta.label || ''), app: String(meta.app || ''), msgs }

  const done = []
  const fails = []
  for (const raw of asArr(chs)) {
    const ch = normalizeCh(raw)
    if (!isCh(ch)) { fails.push({ ch: raw, error: '认证码格式不正确' }); continue }
    try {
      const r = await send(ch, o)
      if (r && r.ok) done.push(ch)
      else fails.push({ ch, error: (r && r.error) || '投递失败' })
    } catch (e) {
      fails.push({ ch, error: String((e && e.message) || e) })
    }
  }
  return { ok: done.length > 0, done, fails, bytes }
}

/** 标准包的便捷入口（等价于 sendUnitsToBoxes(api, chs, unitsOfPack(pack), meta)） */
export const sendToBoxes = (api, chs, pack, meta) => sendUnitsToBoxes(api, chs, unitsOfPack(pack), meta)

/**
 * 发送：估大小 → PUT → 回密钥。
 * @param {object} api window.api（需要 api.share.putPack 或老名 api.share.gxtSnapshot）
 * @returns {Promise<{ok:boolean, key?:string, bytes:number, error?:string, warn?:string}>}
 */
export async function sendPack(api, pack) {
  const bytes = estimateBytes(pack)
  if (!asArr(pack && pack.items).length) return { ok: false, bytes, error: '包里没有内容' }
  if (bytes > SIZE_MAX) {
    return {
      ok: false,
      bytes,
      error: `内容 ${fmtBytes(bytes)}，超过微信云函数 1 MB 的返回上限（本平台留出余量后为 ${fmtBytes(SIZE_MAX)}）。请分几次发送。`
    }
  }
  const put = api && api.share && (api.share.putPack || api.share.gxtSnapshot)
  if (!put) return { ok: false, bytes, error: '发送到小程序需在桌面客户端中运行' }
  try {
    // ★ 出 IPC 前一律深拷成纯数据：包里的 plan / state 多半来自 Vue 的 reactive，
    //   响应式 Proxy 过不了结构化克隆，会当场抛 “An object could not be cloned”（没 catch 时全静默）。
    const r = await put(JSON.parse(JSON.stringify(pack)))
    if (r && r.ok && r.key) {
      return { ok: true, key: r.key, bytes, warn: bytes > SIZE_WARN ? `内容 ${fmtBytes(bytes)}，接近云函数返回上限` : '' }
    }
    return { ok: false, bytes, error: (r && r.error) || '上传失败' }
  } catch (e) {
    return { ok: false, bytes, error: String((e && e.message) || e) }
  }
}
