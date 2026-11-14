export const HOVER_LABEL_DEFAULTS = Object.freeze({ mode: 'always', seconds: 3 })
export const HOVER_LABEL_MODES = ['always', 'off', 'timed']

export function normalizeHoverLabelPrefs(value) {
  const seconds = value && value.seconds
  return {
    mode: HOVER_LABEL_MODES.includes(value && value.mode) ? value.mode : HOVER_LABEL_DEFAULTS.mode,
    seconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0.1 && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds : HOVER_LABEL_DEFAULTS.seconds
  }
}

// 以对象身份计时。停在同一对象上移动不续期；移开再进入或换对象才重新计时。
export function createHoverLabel({ getPrefs, show, now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout }) {
  let key = '', payload = null, timer = null, deadline = 0, expired = false
  const stopTimer = () => { if (timer != null) cancel(timer); timer = null }
  function expire() {
    timer = null
    const remaining = deadline - now()
    if (remaining > 0) { timer = schedule(expire, Math.min(remaining, 2147483647)); return }
    expired = true; show(null)
  }
  function refresh() {
    stopTimer(); expired = false
    const prefs = normalizeHoverLabelPrefs(getPrefs())
    if (!key || prefs.mode === 'off') { show(null); return }
    show(payload)
    if (prefs.mode === 'timed') { deadline = now() + prefs.seconds * 1000; timer = schedule(expire, Math.min(prefs.seconds * 1000, 2147483647)) }
  }
  function reset() { stopTimer(); key = ''; payload = null; expired = false; show(null) }
  return {
    update(nextKey, nextPayload) {
      if (!nextKey || !nextPayload) { reset(); return }
      payload = nextPayload
      if (nextKey !== key) { key = nextKey; refresh(); return }
      if (!expired && getPrefs().mode !== 'off') show(payload)
    },
    refresh, reset, dispose: reset
  }
}
