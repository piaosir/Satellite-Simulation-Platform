import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const geo = require('../utils/linkCalculator.js').calculateLinkBudget
const ngso = require('../utils/linkCalculatorNGSO.js').calculateLinkBudget
const { computeLinkMode, computeLinkModeNGSO } = require('../utils/modeSolver.js')
const { computeRegenUplinkMode, computeRegenDownlinkMode, computeRegenIslMode, computeRegenLaserIslMode } = require('../utils/linkCalculatorRegen.js')
const geometry = { orbitAltitude: 1200, rxOrbitAltitude: 1200 }
const freeze = (x) => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(freeze) } return x }

function captured(run, sat, link, options = {}) {
  freeze(sat); freeze(link)
  const original = JSON.stringify({ sat, link })
  const plain = run(sat, link, options)
  const result = run(sat, link, { ...options, captureInputs: true })
  assert.equal(result.success, true, result.message)
  assert.equal(plain.success, true, plain.message)
  assert.deepEqual(result.data, plain.data, 'Capturing report inputs must not change any calculation result')
  assert.ok(!Object.hasOwn(plain, 'effectiveInputs'), 'Parameter scans do not allocate report snapshots')
  assert.ok(result.effectiveInputs && !Object.hasOwn(result.data, 'effectiveInputs'), 'The snapshot belongs to the response envelope')
  assert.equal(JSON.stringify({ sat, link }), original, 'Caller inputs stay unchanged')
  return result
}

for (const [run, link] of [[geo, {}], [ngso, geometry]]) {
  const r = captured(run, { frequencyBand: 'Ku' }, { ...link, infoRate: '', antennaDiameter: null, rxAntennaDiameter: '' })
  const p = r.effectiveInputs.linkParams
  assert.equal(p.infoRate, 2048)
  assert.equal(p.antennaDiameter, 6.2)
  assert.equal(p.rxAntennaDiameter, 3.7, 'The receive-side fallback differs from the shared form field default')
  assert.equal(p.margin, 3)
  assert.equal(p.noiseRatioMode, 'ebno')
  assert.equal(p.fec, 0.75)
  assert.equal(p.rsCode, 188 / 204)
  assert.equal(p.rxAntennaNoiseTempMode, '自定义', 'An empty mode uses the actual engine mode')
  assert.equal(p.rxAntennaNoiseTemp, 35)
  assert.equal(p.rxReceiverNoiseTemp, 75)
  assert.equal(r.effectiveInputs.satParams.sfdRef, -84)
  assert.equal(r.effectiveInputs.satParams.transponderBandwidth, 36)

  const c = captured(run, { frequencyBand: 'C' }, { ...link, uplinkPolarization: 'H', downlinkPolarization: '' })
  assert.equal(c.effectiveInputs.linkParams.rxAntennaNoiseTemp, 30)
  assert.equal(c.effectiveInputs.linkParams.rxReceiverNoiseTemp, 40)
  assert.equal(c.effectiveInputs.linkParams.downlinkPolarization, 'V')
  const l = captured(run, { frequencyBand: 'Ku' }, { ...link, uplinkPolarization: 'L' })
  assert.equal(l.effectiveInputs.linkParams.downlinkPolarization, 'L')

  const zeros = captured(run, { frequencyBand: 'Ku', BOi: 0, BOo: 0, sfdRef: 0 }, {
    ...link, margin: 0, feederLoss: 0, rxFeederLoss: 0,
    rxAntennaNoiseTemp: 0, rxReceiverNoiseTemp: 0, uplinkOtherLoss: 0, downlinkOtherLoss: 0
  })
  for (const k of ['margin', 'feederLoss', 'rxFeederLoss', 'rxAntennaNoiseTemp', 'rxReceiverNoiseTemp', 'uplinkOtherLoss', 'downlinkOtherLoss']) {
    assert.equal(zeros.effectiveInputs.linkParams[k], 0, k)
  }
  assert.equal(zeros.effectiveInputs.satParams.sfdRef, 0)
  assert.equal(zeros.effectiveInputs.satParams.BOi, 0)

  const automatic = captured(run, { frequencyBand: 'Ku' }, { ...link, rxAntennaNoiseTempMode: '自动', rxAntennaNoiseTemp: 999 })
  assert.equal(automatic.effectiveInputs.linkParams.rxAntennaNoiseTempMode, '自动')
  assert.notEqual(automatic.effectiveInputs.linkParams.rxAntennaNoiseTemp, 999)
  assert.ok(Math.abs(automatic.effectiveInputs.linkParams.rxAntennaNoiseTemp - automatic.data.antennaNoiseTempResult) < 0.0051)
  const strict = captured(run, {}, { ...link, centerFrequency: '36 GHz', feederLoss: '３．５', uplinkPowerControl: '自定义', upcValue: -3 })
  assert.equal(strict.effectiveInputs.linkParams.centerFrequency, 14.25)
  assert.equal(strict.effectiveInputs.linkParams.feederLoss, 3.5)
  assert.equal(strict.effectiveInputs.linkParams.upcValue, 0, 'A negative custom UPC is clamped before use')
  const decimal = captured(run, {}, { ...link, antennaEfficiency: 58.12, rxAntennaEfficiency: 58.12 })
  assert.equal(decimal.effectiveInputs.linkParams.antennaEfficiency, 58.12, 'Report values retain the original units without conversion round-trip tails')
  assert.equal(decimal.effectiveInputs.linkParams.rxAntennaEfficiency, 58.12)
  assert.ok(!Object.hasOwn(run({}, link, { captureInputs: 'true' }), 'effectiveInputs'), 'Capture requires explicit boolean opt-in')
}

for (const [run, link] of [[computeLinkMode, {}], [computeLinkModeNGSO, geometry]]) {
  for (const options of [{ mode: 'margin' }, { mode: 'power', powerW: 40 }, { mode: 'balance' }, { mode: 'overbalance', overDb: 0 }]) {
    const r = captured(run, { frequencyBand: 'Ku' }, { ...link, margin: '' }, options)
    assert.ok(Math.abs(r.effectiveInputs.linkParams.margin - r.resolvedMargin) < 1e-9)
  }
  const overdrive = captured(run, { frequencyBand: 'Ku' }, link, { mode: 'overbalance', overDb: '' })
  assert.equal(overdrive.effectiveInputs.overDb, 0, 'An empty overdrive setting records the zero actually used by the solver')
}

for (const run of [computeRegenUplinkMode, computeRegenDownlinkMode]) {
  for (const mode of ['power', 'margin']) {
    const r = captured(run, { frequencyBand: 'Ku' }, { ...geometry, margin: '' }, { mode, powerW: 40 })
    assert.equal(r.effectiveInputs.linkParams.infoRate, 2048)
    assert.equal(r.effectiveInputs.satParams.aciUplinkFactor, undefined, 'Blank regenerative direct interference stays excluded')
    assert.equal(r.effectiveInputs.satParams.aciDownlinkFactor, undefined)
    assert.equal(r.effectiveInputs.satParams.xpolUplinkFactor, 26, 'Equipment XPI still uses the basic engine fallback')
    if (mode === 'margin') assert.equal(r.effectiveInputs.targetMargin, 3, 'A regenerative target is separate from the internal NGSO margin')
  }
}
const isl = captured(computeRegenIslMode, { frequencyBand: 'Ku', islHopDistance: 2000 }, geometry)
assert.equal(isl.effectiveInputs.satParams.islHopDistance, 2000)
assert.equal(isl.effectiveInputs.satParams.islHops, 1)
assert.equal(isl.effectiveInputs.satParams.islFreq, 23)
assert.equal(isl.effectiveInputs.satParams.islEirp, 45)

const laserParams = freeze({ islHopDistance: 2000, txPowerDbm: '', txPointingErrUrad: 0.233333, rxPointingErrUrad: 0 })
const plainLaser = computeRegenLaserIslMode(laserParams, {})
const laser = computeRegenLaserIslMode(laserParams, { captureInputs: true })
assert.deepEqual(laser.data, plainLaser.data)
assert.ok(!Object.hasOwn(plainLaser, 'effectiveInputs'))
assert.equal(laser.effectiveInputs.linkParams.txPowerDbm, 30)
assert.equal(laser.effectiveInputs.linkParams.wavelengthNm, 1550)
assert.equal(laser.effectiveInputs.linkParams.rxPointingErrUrad, 0)
assert.equal(laser.effectiveInputs.linkParams.txPointingErrUrad, 0.233333)
assert.equal(laser.effectiveInputs.linkParams.rxSensitivityDbm, -35.5)
assert.equal(laser.effectiveInputs.linkParams.txOpticsEff, 0.8)
console.log('PASS effective calculation input snapshots: defaults, zero, conditional modes, solver final points, regenerative scope, and unchanged result data')
