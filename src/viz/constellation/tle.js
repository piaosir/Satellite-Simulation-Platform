// 桌面端 TLE 数据层：CSV 由主进程直连 CelesTrak 取回（无 CORS），此处仅解析。
// parseOMMCsv / splitCsvLine 与小程序 tleStore 逐字一致，保证解析结果完全相同。

function splitCsvLine(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false } else cur += c
    } else if (c === '"') { inQ = true }
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

export function parseOMMCsv(text) {
  const lines = text.split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].trim()) h++
  if (h >= lines.length) return []
  const header = splitCsvLine(lines[h]).map((s) => s.trim().toUpperCase())
  const col = {}
  for (let i = 0; i < header.length; i++) col[header[i]] = i
  const ix = (n) => (n in col ? col[n] : -1)
  const iName = ix('OBJECT_NAME'), iObj = ix('OBJECT_ID'), iEpoch = ix('EPOCH'),
    iMM = ix('MEAN_MOTION'), iEcc = ix('ECCENTRICITY'), iInc = ix('INCLINATION'),
    iRaan = ix('RA_OF_ASC_NODE'), iArgp = ix('ARG_OF_PERICENTER'), iMa = ix('MEAN_ANOMALY'),
    iId = ix('NORAD_CAT_ID'), iB = ix('BSTAR'), iMdot = ix('MEAN_MOTION_DOT'), iMddot = ix('MEAN_MOTION_DDOT')
  if (iEpoch < 0 || iMM < 0 || iId < 0) return []
  const g = (f, i) => (i >= 0 && i < f.length ? f[i].trim() : '')
  const sats = []
  for (let r = h + 1; r < lines.length; r++) {
    if (!lines[r].trim()) continue
    const f = splitCsvLine(lines[r])
    const noradId = g(f, iId)
    if (!noradId) continue
    sats.push({
      name: g(f, iName) || ('NORAD ' + noradId), noradId, objectId: g(f, iObj), epoch: g(f, iEpoch),
      meanMotion: g(f, iMM), ecc: g(f, iEcc), incl: g(f, iInc), raan: g(f, iRaan),
      argp: g(f, iArgp), ma: g(f, iMa), bstar: g(f, iB) || '0', mdot: g(f, iMdot) || '0', mddot: g(f, iMddot) || '0'
    })
  }
  return sats
}

// 与小程序同名接口：取某组并解析为 payload。CSV 由主进程取回。
// fetchedAt 取主进程回传的“实际下载落盘时间”（缓存 mtime），而非解析此刻——复用缓存时显示真实下载时间。
export async function fetchGroupLiveOrSup(key) {
  if (!(typeof window !== 'undefined' && window.api && window.api.omm)) throw new Error('需在 Electron 中运行')
  const res = await window.api.omm.csv(key)
  // 兼容旧返回（纯字符串）与新返回（{ text, fetchedAt }）
  const text = typeof res === 'string' ? res : (res && res.text) || ''
  const fetchedAt = (res && res.fetchedAt) || new Date().toISOString()
  const sats = parseOMMCsv(text)
  if (!sats.length) throw new Error('empty')
  return { group: key, fetchedAt, count: sats.length, csv: text, sats }
}

// 桌面端无云端回传，保留同名空实现以兼容调用点。
export function uploadGroupPayload() { return Promise.resolve(false) }
