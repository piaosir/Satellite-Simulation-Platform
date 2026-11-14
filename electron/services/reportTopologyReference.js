const fs = require('fs')
const { join } = require('path')
// Original reference illustrations. End-to-end reports use only their actual
// cascade diagrams; their topology is never represented by a generic picture.
const SOURCE = 'https://www.mathworks.com/help/satcom/gs/satellite-link-budget.html'
const IMAGE_SOURCE = 'https://www.mathworks.com/help/satcom/gs/intro_slb.png'
const REGEN_SOURCE = 'https://www.haystack.mit.edu/wp-content/uploads/2021/10/2021_Briggs_Presentation.pdf'
function topologyReference(model) {
  const orbitType = model.scheme?.orbitType || 'GEO', en = model.lang === 'en'
  if (orbitType === 'REGEN') {
    // Embedded JPEG extracted directly from page 9, without redrawing or
    // re-encoding: one ground dish, one satellite, and digital onboard processing.
    const data = fs.readFileSync(join(__dirname, '../assets/report-topology-regen-mit.jpg'))
    return { data, type: 'jpg', mimeType: 'image/jpeg', w: 1319, h: 525,
      source: REGEN_SOURCE, sourcePage: 9, imageSource: REGEN_SOURCE + '#page=9',
      title: en ? 'Digital Earth-space communication and onboard processing' : '星地数字通信与星上处理示意',
      caption: en ? 'Digital Earth-space communication and onboard processing. Source: MIT Haystack Observatory, 2021 Briggs Presentation, p. 9.'
        : '星地数字通信与星上处理示意。来源：MIT Haystack Observatory，2021 Briggs Presentation，第9页。' }
  }
  if (!['GEO', 'NGSO'].includes(orbitType)) return null
  const data = fs.readFileSync(join(__dirname, '../assets/report-topology-mathworks.png'))
  return { data, type: 'png', mimeType: 'image/png', w: 943, h: 398, source: SOURCE, imageSource: IMAGE_SOURCE,
    title: en ? 'Typical transparent satellite link' : '典型透明转发链路结构',
    caption: en ? 'Typical transparent satellite link. Source: MathWorks, Satellite Link Budget.'
      : '典型透明转发链路：发信站、功放与馈线、卫星、低噪放及收信站。来源：MathWorks Satellite Link Budget。' }
}
module.exports = { topologyReference, SOURCE, IMAGE_SOURCE, REGEN_SOURCE }
