import assert from 'node:assert/strict'
import { createHoverLabel, normalizeHoverLabelPrefs } from '../../../src/shared/hoverLabel.js'

assert.deepEqual(normalizeHoverLabelPrefs(null), { mode: 'always', seconds: 3 })
for (const seconds of [null, '', '5', 0, -1, NaN, Infinity, 0.01]) assert.equal(normalizeHoverLabelPrefs({ mode: 'timed', seconds }).seconds, 3)
assert.equal(normalizeHoverLabelPrefs({ mode: 'timed', seconds: 0.25 }).seconds, 0.25)
assert.equal(normalizeHoverLabelPrefs({ mode: 'unknown', seconds: 8 }).mode, 'always')

let time = 0, next = 0, value, prefs = { mode: 'always', seconds: 3 }
const timers = new Map()
const advance = (ms) => {
  const end = time + ms
  while (true) {
    const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    const [id, event] = due; timers.delete(id); time = event.at; event.fn()
  }
  time = end
}
const label = createHoverLabel({ getPrefs: () => prefs, show: (v) => { value = v }, now: () => time,
  schedule: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id }, cancel: (id) => timers.delete(id) })
const p = { x: 1, y: 2, text: '同名对象' }
label.update('point:1', p); advance(100000)
assert.equal(value, p, '默认停留多久都显示')
assert.equal(timers.size, 0, '常显不创建定时器')
prefs.mode = 'timed'; label.refresh(); advance(2000)
label.update('point:1', { ...p, x: 3 }); advance(999)
assert.equal(value.x, 3, '同一对象内移动更新位置')
advance(1); assert.equal(value, null, '鼠标停住也按时消失，不因移动续期')
label.update('point:1', p); advance(10000); assert.equal(value, null, '到期后同对象移动不闪现')
label.update('point:2', p); advance(1000); assert.equal(value, p, '同名但不同身份的新对象重新显示')
label.reset(); assert.equal(value, null); assert.equal(timers.size, 0)
label.update('point:2', p); advance(2999); assert.equal(value, p, '移开再进入重新计时')
advance(1); assert.equal(value, null)
prefs.mode = 'always'; label.refresh(); assert.equal(value, p, '改为常显立即恢复当前对象')
prefs.mode = 'off'; label.refresh(); assert.equal(value, null)
label.update('point:2', { ...p, x: 4 }); assert.equal(value, null, '关闭标签后移动不显示')
prefs.mode = 'timed'; prefs.seconds = 0.25; label.refresh(); advance(250); assert.equal(value, null, '支持小数秒')
label.reset(); label.update('point:3', p); prefs.seconds = 5; label.refresh(); advance(1000)
label.dispose(); advance(10000); assert.equal(value, null); assert.equal(timers.size, 0, '卸载无残留定时器')

// 设置的校验与持久化不依赖地图页面，关闭设置窗 / 切页面后仍保留。
const storage = new Map(), events = {}
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
globalThis.window = { addEventListener: (name, fn) => { events[name] = fn } }
const S = await import('../../../src/stores/hoverLabelPrefs.js')
assert.equal(S.hoverLabelPrefs.mode, 'always')
S.setHoverLabelMode('timed'); assert(S.setHoverLabelSeconds('1.25'))
for (const input of ['', 'bad', '0', '-2', 'Infinity']) assert.equal(S.setHoverLabelSeconds(input), false)
assert.equal(S.hoverLabelPrefs.seconds, 1.25)
assert.deepEqual(JSON.parse(storage.get('map-object-hover-label-v1')), { mode: 'timed', seconds: 1.25 })
events.storage({ key: 'map-object-hover-label-v1', newValue: JSON.stringify({ mode: 'off', seconds: 4 }) })
assert.equal(S.hoverLabelPrefs.mode, 'off')
S.resetHoverLabelPrefs(); assert.deepEqual({ ...S.hoverLabelPrefs }, { mode: 'always', seconds: 3 })

const V = await import('../../../src/stores/mapSatVisibility.js')
V.setMapSatelliteHidden('n:1', true); V.setMapSatelliteHidden('n:1', true)
assert.deepEqual(V.hiddenMapSatellites.value, ['n:1'], '同星多来源只隐藏一次')
assert(V.mapSatelliteHidden('n:1'))
V.setMapSatelliteHidden('n:1', false); assert(!V.mapSatelliteHidden('n:1'))
V.setMapSatelliteHidden('n:2', true); V.showHiddenMapSatellites()
assert.deepEqual(JSON.parse(storage.get('map-hidden-satellites-v1')), [])
console.log('hoverLabel: defaults, exact timing, identity, changes, cleanup, preferences and visibility persistence passed')
