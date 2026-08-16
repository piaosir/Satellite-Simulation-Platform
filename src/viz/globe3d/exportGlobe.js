// 3D 球体视图截图导出：高清 PNG / PDF。与 2D 平面图那条（viz/flatmap/exportFlat.js）分工——
// 那边有完整几何可重放，出的是矢量；这边 WebGL 帧缓冲里只剩像素，出图就是把渲染分辨率抬上去
// 再取一帧（见 globe3d/scene.js 的 snapshot），PDF 也只能是「一页一张位图」。
//
// jspdf 是重包，故本模块由调用方按需 import()，不进首屏。
import { jsPDF } from 'jspdf'

// 高清 PNG：factor=像素倍率（4/6…）。返回 { bytes, w, h, factor }，factor 为**实际**倍率
// （显存不够时 snapshot 会自行降档，见其注释），调用方按它命名文件。
export async function renderGlobePNG(scene, { factor = 4 } = {}) {
  return scene.snapshot(factor)
}

// 位图 PDF：页面逻辑尺寸取球面画布的 CSS 尺寸（pt 数只是名义大小，与位图分辨率无关，同 2D 截图 PDF），
// 图铺满整页。倍率固定 4×（全平台出图基准，约合按整幅宽放置 288 dpi）。
//
// compression='FAST'：jsPDF 走 PNG 预测器 + flate 重新打包。别用默认档——它把解码后的原始像素
// 交给整文档压缩，实测 5600×3600 一张要 2.6s / 15MB，FAST 只要 1.1s / 2.6MB。
export async function renderGlobePDF(scene, { factor = 4 } = {}) {
  const shot = await scene.snapshot(factor)
  const W = Math.max(1, Math.round(shot.w / shot.factor))
  const H = Math.max(1, Math.round(shot.h / shot.factor))
  const doc = new jsPDF({ orientation: W >= H ? 'landscape' : 'portrait', unit: 'pt', format: [W, H], compress: true })
  doc.addImage(shot.bytes, 'PNG', 0, 0, W, H, undefined, 'FAST')
  return { bytes: new Uint8Array(doc.output('arraybuffer')), w: shot.w, h: shot.h, factor: shot.factor }
}
