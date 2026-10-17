'use strict'
const path = require('path')
const core = require(path.join(process.argv[2], 'packages/core/index.js'))
const q = (fn) => { const o = console.log; console.log = () => {}; try { return fn() } finally { console.log = o } }
const sat = { frequencyBand: 'Ku', satelliteName: 'BENCH', orbitPosition: '110.5' }
const link = { longitude: '116.4', latitude: '39.9', rxLongitude: '121.5', rxLatitude: '31.2', uplinkAvailability: '99.9', rxDownlinkAvailability: '99.9', rainRate: '40', rxRainRate: '50' }
const r = q(() => core.computeLinkMode(sat, link, { mode: 'margin' }))
const d = r.data || {}
console.log(Object.keys(d).filter((k) => /rain|Rain|atten|Atten|avail/i.test(k)).map((k) => k + '=' + d[k]).join('\n'))
