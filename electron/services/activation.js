// 激活与设备管理（主进程）：终端设备心跳上报 + 激活书拉取验签。
// 对端是独立的「卫星仿真平台管理」软件（manager/），两边经同一 COS 桶 share/mgr/ 前缀交互
// （CAM 子账号已有 share/* 的 PutObject/GetObject，零控制台配置）：
//   share/mgr/registry.json    设备名册（多写者：首见登记 + 每跳自检自愈，只存 id 列表——
//                              lastSeen 等易变量不入册，否则每跳都读改写名册必然竞态）
//   share/mgr/dev/<ID>.json    设备心跳（单写者 = 该设备；主机名/用户/版本/MAC/机器码/最后在线）
//   share/mgr/lic/<ID>.json    激活书（【应当】只有管理端写；实际人人可写，见下）
//
// 激活书防伪：随包分发的 COS 子账号密钥人人可 PUT share/*（本模块的心跳自己就在用它写
// share/mgr/dev/*，所以这不是假设而是既成事实），故对象本身不可信 —— 信的是签名。
// 验签公钥内置于此；私钥只在管理软件内且被登录口令加密，拆平台包拿不到签发能力。
// 本地缓存（settings.activationLic）存最近一次【可信】的激活书，每次读取都重新验签，改文件即失效。
// 无网 / 未配置凭证时静默降级：维持本地缓存状态，绝不因云端不可达把已激活设备锁死。
//
// ★ 2026-08-10 审计加固的三条（原先都被真实复现过，见 .mgrharness/smoke.mjs「P0 防线」段）：
//   ① 冒名：设备ID 不再无条件采信 settings.deviceId —— 采纳过的 ID 盖 safeStorage 机器封印，
//      拷别人的 settings.json 过来会被识破（判定分支见 deviceId()，验证台 .mgrharness/seal.mjs）
//   ② 重放：issuedAt 单调下限，比「见过的最大 issuedAt」旧的一律不认 —— 撤销后把旧激活书
//      写回桶里不再复活（撤销书本身把下限抬过去，其之前的激活书永久作废）
//   ③ 覆写停用：验不过的对象一律【忽略并维持本地授权】，不再落进缓存把人打回未激活。
//      只有确凿 404（管理端真删）才清缓存 —— 否则任何人一次 PUT 就能远程停用任意设备。
const { createPublicKey, verify, createHash } = require('crypto')

// 验签公钥表：按序试，任一通过即算数。留成数组是为了【密钥轮换】有过渡路径——
// 换签名钥时把新公钥加在前面、旧的留一版，等存量设备都升上来再删旧的；
// 否则换钥当天所有已签发的激活书同时失效（规范化串是冻结的，不能靠加 kid 字段解决）。
const LIC_PUBKEYS = [
  'MCowBQYDK2VwAyEAeRBwxQsJYZmJTZZUcURVvmLBJ++8+iHOyTAzNqxPviI='
]

// ---- 心跳隐私字段加密（治「每个客户都能拉走全体客户的机器指纹」）----
// 随包密钥人人可 GET share/*，而心跳里带主机名 / Windows 用户名 / 全部物理网卡 MAC。
// 这里用管理端的 X25519 公钥把这几项封成密文再上报，桶里不再有明文个人信息；
// 私钥只在管理软件内、且被登录口令加密，拆平台包拿不到任何解密能力。
// ★ 本段是管理端 devcrypto.js sealTo 的镜像实现：KDF 的 info 串、salt 取法（= 临时公钥 DER）、
//   字段名任何一处改动都必须两端同步 —— 与 canonical 是同一个约定。
const DEV_PUBKEY = 'MCowBQYDK2VuAyEAptmNagQd6uL5L5tDxbjRULOa6b+6ju60uV9RnbbV/lk='
const DEV_INFO = 'satsim-dev-v1'
function sealDev(obj) {
  const { generateKeyPairSync, diffieHellman, createPublicKey, hkdfSync, randomBytes, createCipheriv } = require('crypto')
  const eph = generateKeyPairSync('x25519')
  const epkDer = eph.publicKey.export({ type: 'spki', format: 'der' })
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey({ key: Buffer.from(DEV_PUBKEY, 'base64'), format: 'der', type: 'spki' })
  })
  const key = Buffer.from(hkdfSync('sha256', shared, epkDer, DEV_INFO, 32))
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()])
  return {
    v: 1,
    epk: epkDer.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ct: ct.toString('base64')
  }
}
const HEARTBEAT_MS = 5 * 60 * 1000   // 设备心跳（PUT dev + 名册自愈）；管理端按「< 2 周期 + 余量」判在线
// 激活书单独轮询，比心跳密：拉取模型没有推送，这个周期就是管理端「激活/撤销」的生效时延上界。
// 只 GET 一个小对象，流量可忽略；设备信息上报仍走 5 分钟心跳，不加写放大。
const LIC_POLL_MS = 60 * 1000
// 首跳尽快：本地缓存只决定「启动瞬间显示什么」，权威状态以首跳拉到的激活书为准——
// 治「上一轮试验留下的旧激活书缓存，把管理端的撤销拖到下一轮心跳才生效」。
const FIRST_BEAT_DELAY_MS = 1500
// 时钟防篡改：系统时钟落后「已确证时间」超过此幅度 → state 'clock' 锁定（回拨续命防线；
// NTP 正常校正是秒级、时区/夏令时不动 epoch，正常用户永远碰不到 24h 这条线）
const CLOCK_BACK_LIMIT_MS = 24 * 3600e3

// 管理员身份硬编码（不开放修改，避免他人冒充）：派生ID → 固定标识。
// 加新管理机：在那台机器上跑一次、看「关于」对话框显示的设备ID，填进此表再发版即可。
const ADMIN_IDS = {
  '2E314A3754': 'master1',     // 开发者笔记本（MAC 84:9e:56:77:52:9d）
  '731D97DD7B': 'master2'      // 开发者台式机（MAC 50:eb:f6:eb:83:02）
  // '<机器3派生ID>': 'master3'
}

// 激活书规范化串：字段序固定，签名与验签两端必须一字不差（manager/auth.js 是唯一另一处）
const canonical = (l) => `satsim-lic|${l.v}|${l.id}|${l.status}|${l.plan}|${l.activatedAt}|${l.expiresAt}|${l.issuedBy}|${l.issuedAt}`

function verifyLic(lic, expectId) {
  if (!lic || typeof lic !== 'object' || lic.v !== 1 || !lic.sig) return false
  if (String(lic.id) !== String(expectId)) return false
  const msg = Buffer.from(canonical(lic), 'utf8')
  const sig = Buffer.from(String(lic.sig), 'base64')
  for (const k of LIC_PUBKEYS) {
    try {
      const pub = createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' })
      if (verify(null, msg, pub, sig)) return true
    } catch { /* 该公钥不可用，试下一把 */ }
  }
  return false
}

module.exports = (share, storage) => {
  const K = {
    registry: () => `${share.prefixOf()}/mgr/registry.json`,
    dev: (id) => `${share.prefixOf()}/mgr/dev/${id}.json`,
    lic: (id) => `${share.prefixOf()}/mgr/lic/${id}.json`
  }

  // ---- 设备 ID：按本机 MAC 派生的稳定短码（沿用「我的ID」同一份，见 register.js app:deviceId）----
  // seed 口径一个字符不能动：已被无数存量设备的 ID 钉死（physicalMacs 那边的去重排序是另一回事）。
  function deriveBase() {
    const os = require('os')
    const ifaces = os.networkInterfaces(); const macs = []
    for (const name of Object.keys(ifaces)) for (const i of (ifaces[name] || [])) {
      if (i.mac && i.mac !== '00:00:00:00:00:00' && !i.internal) macs.push(i.mac.toLowerCase())
    }
    macs.sort()
    const seed = macs.join(',') || os.hostname() || String(Date.now())
    return createHash('sha256').update(seed).digest('hex').slice(0, 10).toUpperCase()
  }

  // ---- 设备 ID 机器绑定（治「拷 settings.json 两个字段即激活」）----
  // 原实现：settings.deviceId 一存在就无条件采信。而那是用户可改的明文 JSON —— 把别人已激活
  // 机器的 settings.json 拷过来（或照抄两行），本机就变成对方，直接继承对方的授权。
  //
  // 现在给采纳过的 ID 盖一枚【机器封印】：safeStorage（Windows 上即 DPAPI）加密，换台机器/换个
  // Windows 账户就解不开。封印随 settings.json 一起被拷走也没用 —— 在对方机器上解不开。
  //
  // 判定顺序刻意保守，宁可放过不可误伤（误伤 = 老客户凭空掉激活，比漏网严重得多）：
  //   1. stored === 本机实时派生   → 采信（最常见；也覆盖 DPAPI 因重装/改名失效的情形）
  //   2. 封印能解开且等于 stored   → 采信（覆盖装了 VPN/WSL/Docker 虚拟网卡后实时派生值变了）
  //   3. 压根没有封印             → 采信并补盖（老版本升上来的存量设备，一次性认领）
  //   4. 有封印但解不开/对不上，且 stored ≠ 实时派生 → 判为「从别的机器拷来的」，改用本机派生值
  // 只有第 4 条会否定 stored，而它同时要求「封印不属于本机」+「MAC 也不是本机的」，
  // 正是拷贝攻击的特征；正常用户凑不齐这两条。
  // 残留缺口：攻击者若知道要连封印字段一起删掉，就会落进第 3 条被认领。彻底堵死要靠激活书
  // 里签上机器指纹（须升 v2 规范化串，届时存量设备得先全部升级），见 README 的迁移说明。
  const SEAL_KEY = 'mgrIdSeal'
  function safeStore() {
    try {
      const { safeStorage } = require('electron')
      return safeStorage && safeStorage.isEncryptionAvailable() ? safeStorage : null
    } catch { return null }   // 非 Electron 环境（验证台/脚本）：无封印能力，退回原行为
  }
  function seal(base) {
    const ss = safeStore()
    if (!ss) return null
    try { return ss.encryptString(String(base)).toString('base64') } catch { return null }
  }
  function unseal(blob) {
    const ss = safeStore()
    if (!ss || !blob) return null
    try { return ss.decryptString(Buffer.from(String(blob), 'base64')) } catch { return null }
  }

  let _idMemo = null            // DPAPI 调用不便宜，而 current()/gate() 每次都要 ID —— 进程内定一次
  function deviceId() {
    if (_idMemo) return ADMIN_IDS[_idMemo] || _idMemo
    const s = storage.getSettings() || {}
    const stored = s.deviceId
    if (!stored) {                                   // 首次运行：派生 + 落盘 + 盖封印
      const base = deriveBase()
      storage.setSettings({ deviceId: base, [SEAL_KEY]: seal(base) })
      _idMemo = base
      return ADMIN_IDS[base] || base
    }
    const live = deriveBase()
    let base = stored
    if (stored !== live) {                           // 只有对不上时才需要查封印（省一次 DPAPI）
      const blob = s[SEAL_KEY]
      if (!blob) {
        storage.setSettings({ [SEAL_KEY]: seal(stored) })      // 存量设备一次性认领
      } else if (unseal(blob) !== stored) {
        base = live                                            // 封印不属于本机 → 这份 settings 是拷来的
        storage.setSettings({ deviceId: base, [SEAL_KEY]: seal(base) })
        console.warn('[activation] 设备ID 封印与本机不符，已改用本机派生ID（settings.json 疑似自他机拷入）')
      }
    } else if (!s[SEAL_KEY]) {
      storage.setSettings({ [SEAL_KEY]: seal(stored) })        // 补盖，供将来换网卡后仍认得
    }
    _idMemo = base
    return ADMIN_IDS[base] || base
  }

  // ---- 物理网卡 MAC（仅心跳上报用）。deviceId 的 seed 口径独立在上面，一个字符不能动——
  //      这里去重排序是为了上报好看，seed 那边的重复项已被无数设备的 ID 钉死 ----
  function physicalMacs() {
    const os = require('os')
    const out = []
    const ifaces = os.networkInterfaces()
    for (const name of Object.keys(ifaces)) for (const i of (ifaces[name] || [])) {
      const m = i.mac && i.mac.toLowerCase()
      if (m && m !== '00:00:00:00:00:00' && !i.internal && !out.includes(m)) out.push(m)
    }
    return out.sort()
  }

  // ---- 时钟防篡改（断网时效走本地时钟 → 必须让「回拨续命」无效）----
  // 「已确证时间」单调锚 = max(盘上高水位, 激活书 issuedAt, 服务器 Date 头) + 进程单调推进：
  //   · 盘上高水位带 HMAC 校验位防手改（改了校验不过 → 忽略，回落到其余锚源，不误锁）
  //   · issuedAt 在激活书里被 Ed25519 签名钉死 —— 重装清盘也抹不掉这个下限
  //   · COS 响应 Date 头（TLS 保真）是权威源：联网成功即无条件重置锚（升降皆从，
  //     可自愈「时钟曾被拨到未来把高水位污染」的误锁）
  // 进程内推进用 hrtime 单调钟，系统时钟怎么拨都不影响；有效时间 = max(系统钟, 锚)。
  // 纯离线 + 每次开机小幅回拨(<24h) 理论上仍可拖延，但无可信时间源的离线环境防不到底，
  // 此为 license 系统的标准取舍；任何一次联网/新激活书都会把锚拉回真实。
  const monoMs = () => Number(process.hrtime.bigint() / 1000000n)
  const anchorMac = (t, id) => createHash('sha256').update(`satsim-anchor-v1|${t}|${id}`).digest('hex').slice(0, 16)
  let _aBase = 0        // 锚基准（epoch ms）
  let _aMono = 0        // 基准对应的单调钟读数
  let _aSavedT = 0      // 上次落盘的锚值（节流用）
  const anchorNow = () => _aBase + (monoMs() - _aMono)
  function setAnchor(t) { _aBase = Number(t); _aMono = monoMs() }
  function bumpAnchor(t) { if (Number(t) > anchorNow()) setAnchor(t) }                 // 本地源：只升不降
  function setAnchorAuthoritative(t) { if (Number(t) > 0) { setAnchor(t); persistAnchor(true) } }  // 服务器时间：升降皆从
  function persistAnchor(force) {
    const t = Math.round(anchorNow())
    if (!force && t - _aSavedT < 60_000) return          // 节流：跨重启粒度 1 分钟足够
    _aSavedT = t
    storage.setSettings({ mgrClockAnchor: { t, mac: anchorMac(t, deviceId()) } })
  }
  {
    const s = storage.getSettings() || {}
    const id0 = deviceId()
    const a = s.mgrClockAnchor
    const disk = a && typeof a.t === 'number' && a.mac === anchorMac(a.t, id0) ? a.t : 0
    const iss = (s.activationLic && Number(s.activationLic.issuedAt)) || 0
    setAnchor(Math.max(disk, iss, Date.now()))
  }

  // ---- 激活书重放防线：issuedAt 单调下限（治「撤销后把旧激活书写回桶里就复活」）----
  // 随包分发的子账号密钥对 share/* 有 PutObject —— 平台自己的心跳就在用它写 share/mgr/dev/*，
  // 所以任何持有安装包的人都能往【自己的】share/mgr/lic/<ID>.json 写东西。他伪造不了签名，
  // 但可以把撤销前存下的那份【合法旧激活书】原样 PUT 回去，撤销就此失效。
  // 修法：记住「本机见过的最大 issuedAt」，比它旧的一律不认。撤销书本身会把下限抬上去，
  // 于是它之前的所有激活书永久作废。校验位同时钟锚一路（手改即失效，不误锁）。
  const floorMac = (t, id) => createHash('sha256').update(`satsim-licfloor-v1|${t}|${id}`).digest('hex').slice(0, 16)
  let _floor = 0
  {
    const s = storage.getSettings() || {}
    const f = s.mgrLicFloor
    _floor = f && typeof f.t === 'number' && f.mac === floorMac(f.t, deviceId()) ? f.t : 0
  }
  function bumpFloor(t) {
    const v = Number(t) || 0
    if (v <= _floor) return
    _floor = v
    storage.setSettings({ mgrLicFloor: { t: v, mac: floorMac(v, deviceId()) } })
  }
  // 通过验签、且不是被重放的旧件，才算可信
  const licTrusted = (lic, id) => verifyLic(lic, id) && (Number(lic.issuedAt) || 0) >= _floor

  // ---- 当前激活状态（纯本地：缓存的激活书重新验签后判读，不碰网络）----
  // state: none 无激活书 / active 激活中 / expired 已到期 / revoked 已被管理端撤销
  //        / clock 时钟异常（系统钟落后已确证时间超限，修回时钟或联网自愈）
  function current() {
    const id = deviceId()
    const lic = (storage.getSettings() || {}).activationLic || null
    // licTrusted 而非 verifyLic：缓存也在用户可改的 settings.json 里，手工塞一份撤销前的
    // 旧激活书进去同样要被下限挡住（否则 refresh 的重放防线可以绕开本地这一路）。
    if (!licTrusted(lic, id)) return { active: false, state: 'none', plan: '', activatedAt: 0, expiresAt: 0, deviceId: id }
    const base = { plan: String(lic.plan || ''), activatedAt: Number(lic.activatedAt) || 0, expiresAt: Number(lic.expiresAt) || 0, deviceId: id }
    if (lic.status !== 'active') return { active: false, state: 'revoked', ...base }
    const sys = Date.now()
    const aNow = anchorNow()
    if (sys + CLOCK_BACK_LIMIT_MS < aNow) return { active: false, state: 'clock', ...base }
    if (base.expiresAt && Math.max(sys, aNow) >= base.expiresAt) return { active: false, state: 'expired', ...base }
    return { active: true, state: 'active', ...base }
  }

  // ---- 拉激活书：只信两种确凿结果 —— 拿到对象（更新缓存）或确凿 404（管理端未签发/已删除，
  //      清缓存 → 未激活）；其余一切失败（断网、超时、门户网络劫持成 HTML、5xx）都维持本地缓存。
  //      断网口径：已激活的保持已激活（到期判定在 current() 里实时走本地时钟，断网照样生效）、
  //      未激活的保持未激活 —— 必须用 getJsonStrict，宽松版会把门户页误判成「对象损坏」清掉缓存。
  async function refresh() {
    if (share.configured()) {
      try {
        const id = deviceId()
        const lic = await share.getJsonStrict(K.lic(id))
        // 落缓存的口径（治「任何持包用户把别人的 lic 覆写成 {} 就能远程停用对方」）：
        //   · 确凿 404（getJsonStrict 返回 null）→ 管理端确实没签发/已删除 → 清缓存
        //   · 验签通过且非重放                  → 采纳
        //   · 其余（空对象 / 篡改 / 他机的 / 重放的旧件）→ 【不动缓存】
        // 关键在第三条：桶里那个对象人人可写，它不可信就该被忽略，而不是拿来覆盖本机既有授权。
        // 合法管理端从不写出验不过签的激活书，所以「验不过」只可能是别人写的垃圾。
        // 注意这不会放松防篡改：验不过的东西一律不采纳，用户改桶里的对象一样占不到便宜。
        if (lic === null) {
          storage.setSettings({ activationLic: null })
        } else if (licTrusted(lic, id)) {
          storage.setSettings({ activationLic: lic })
          bumpFloor(Number(lic.issuedAt))
        } else {
          console.warn('[activation] 云端激活书不可信（验签失败或为重放旧件），已忽略并维持本地授权')
        }
        // 时钟锚注入。顺序有讲究：issuedAt（管理端时钟，可能偏快）只升不降先进，
        // 服务器 Date 头（权威）最后进且升降皆从 —— 管理端时钟偏快留下的高锚被服务器时间纠回。
        // 只吃【可信】激活书的 issuedAt：否则别人往你的 lic 里塞个远期 issuedAt 就能把锚拉到未来，
        // 等于隔空把你的时钟判成异常。
        if (lic && licTrusted(lic, id) && Number(lic.issuedAt)) bumpAnchor(Number(lic.issuedAt))
        const sd = share.serverDate && share.serverDate()
        if (sd) setAnchorAuthoritative(sd)
      } catch (e) { console.warn('[activation] 拉取激活书失败（维持本地状态）：', e.message) }
    }
    return current()
  }

  // ---- 心跳：上报设备信息 + 顺带拉激活书（管理端的激活/撤销最迟一跳自动生效）----
  async function heartbeat() {
    if (!share.configured()) return current()
    const id = deviceId()
    const os = require('os')
    const s = storage.getSettings()
    const firstSeen = Number(s.mgrFirstSeen) || Date.now()
    if (!s.mgrFirstSeen) storage.setSettings({ mgrFirstSeen: firstSeen })
    const st = await refresh()
    let user = ''
    try { user = os.userInfo().username || '' } catch { /* 域账号偶发拿不到 */ }
    let app = ''
    try { app = require('electron').app.getVersion() } catch { /* 测试脚本环境 */ }
    // 明文只留「不是个人信息、且管理端排序/统计要用」的：版本 / 系统 / 在线时间 / 自认状态。
    // 主机名 / 用户名 / MAC / 机器码封进 sec，只有管理端登录后解得开（见 sealDev）。
    await share.putJson(K.dev(id), {
      kind: 'satsim-mgr-dev', v: 1, id,
      app,
      os: `${os.platform()} ${os.release()}`, arch: os.arch(),
      firstSeen, lastSeen: Date.now(),
      state: st.state,             // 设备自认状态，供管理端对账（权威仍是 lic + 签名）
      sec: sealDev({
        host: os.hostname(), user,
        mac: physicalMacs(),
        mid: String(s.deviceId || '')   // 原始机器码：管理员机 id 被映射成 master*，这里补回派生短码
      })
    })
    // 名册自愈：不在册才写（写的是 id 列表，不含易变量 → 仅两台新设备同时首跳才可能互踩，
    // 踩了下一跳自愈）。
    const reg = await share.getJson(K.registry(), null) || { kind: 'satsim-mgr-registry', v: 1, ids: [] }
    if (!Array.isArray(reg.ids)) reg.ids = []
    if (!reg.ids.includes(id)) {
      reg.ids.push(id)
      reg.updatedAt = Date.now()
      await share.putJson(K.registry(), reg)
    }
    return st
  }

  // ---- 定时心跳 / 激活书轮询 + 状态变化通知（渲染端各窗口广播）----
  let _notify = null
  let _timer = null
  let _licTimer = null
  // 包一层变化检测：干活前后各取一次本地状态，变了才广播。
  // 顺带维护时钟锚高水位：系统时钟吸入（只升）+ 节流落盘 —— 断网时这里也照跑，
  // 「跨越到期时刻」「回拨触发 clock」的状态翻转都由这层前后对比广播出去。
  async function withNotify(work, tag) {
    bumpAnchor(Date.now())
    const before = JSON.stringify(current())
    try { await work() } catch (e) { console.warn(`[activation] ${tag}失败：`, e.message) }
    persistAnchor()
    const st = current()
    if (_notify && JSON.stringify(st) !== before) _notify(st)
    return st
  }
  const tick = () => withNotify(heartbeat, '心跳')
  const tickLic = () => withNotify(refresh, '激活书轮询')
  function start(notify) {
    _notify = notify || null
    if (_timer) return
    setTimeout(() => { tick() }, FIRST_BEAT_DELAY_MS)
    _timer = setInterval(() => { tick() }, HEARTBEAT_MS)
    _licTimer = setInterval(() => { tickLic() }, LIC_POLL_MS)
  }

  // 用户「刷新激活状态」特定动作入口：立即完整心跳（顺带把最后在线也刷了），状态变化同样广播
  async function refreshNow() { return tick() }

  return {
    deviceId, current, refresh, refreshNow, heartbeat, start, verifyLic, canonical,
    // 时钟锚测试钩子（.mgrharness 用；_setAnchorAuthoritative 也是 refresh 的服务器时间注入口）
    _bumpAnchor: bumpAnchor, _setAnchorAuthoritative: setAnchorAuthoritative,
    _licFloor: () => _floor
  }
}
