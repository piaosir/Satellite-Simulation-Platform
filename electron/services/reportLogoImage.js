// Shared logo image decoding for all three report formats. Logo dimensions come
// from the uploaded PNG itself so every exporter uses the same aspect ratio.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function logoImage(logo) {
  const src = logo && logo.dataUrl
  if (typeof src !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(src)) return null
  try {
    const data = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
    if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR') return null
    const w = data.readUInt32BE(16), h = data.readUInt32BE(20)
    if (!w || !h) return null
    return { data, dataUrl: 'data:image/png;base64,' + data.toString('base64'), w, h }
  } catch (_) { return null }
}
function fitLogo(logo, maxW, maxH) {
  const image = logoImage(logo)
  if (!image) return null
  const k = Math.min(maxW / image.w, maxH / image.h)
  return { ...image, width: Math.max(1, Math.round(image.w * k)), height: Math.max(1, Math.round(image.h * k)) }
}
module.exports = { logoImage, fitLogo }
