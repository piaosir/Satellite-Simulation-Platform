// 微信小程序 API 兼容垫片：让小程序页面代码近乎原样运行在桌面渲染进程。
// 仅实现星座/星间页面用到的接口。canvas 由宿主提供，并已打上 requestAnimationFrame。

export function makeWx({ canvasEl, getRoot }) {
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('wx:' + k)) } catch { return '' } },
    set(k, v) { try { localStorage.setItem('wx:' + k, JSON.stringify(v)) } catch {} },
    del(k) { try { localStorage.removeItem('wx:' + k) } catch {} }
  }

  function createSelectorQuery() {
    let sel = null, brCb = null
    const q = {
      in() { return q },
      select(s) { sel = s; return q },
      fields() { return q },
      boundingClientRect(cb) { brCb = cb; return q },
      exec(cb) {
        const isCanvas = sel === '#globeCanvas' || sel === '.globe-canvas' || sel === '#islCanvas'
        if (isCanvas) {
          const r = canvasEl.getBoundingClientRect()
          const res = [{ node: canvasEl, width: canvasEl.clientWidth || r.width, height: canvasEl.clientHeight || r.height }]
          if (cb) cb(res)
          return res
        }
        const root = (getRoot && getRoot()) || document
        const el = root.querySelector(sel)
        const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
        if (brCb) brCb(r)
        if (cb) cb([r])
        return [r]
      }
    }
    return q
  }

  function createOffscreenCanvas({ width, height } = {}) {
    try { return new OffscreenCanvas(width || 300, height || 150) }
    catch {
      const c = document.createElement('canvas')
      c.width = width || 300; c.height = height || 150
      return c
    }
  }

  const noopFS = {
    readFileSync() { throw new Error('no fs') },
    writeFileSync() {},
    readFile(o) { o && o.fail && o.fail(new Error('no fs')) },
    writeFile(o) { o && o.success && o.success() }
  }

  return {
    createSelectorQuery,
    createOffscreenCanvas,
    getWindowInfo: () => ({ pixelRatio: window.devicePixelRatio || 2 }),
    getSystemInfoSync: () => ({ pixelRatio: window.devicePixelRatio || 2 }),
    getStorageSync: store.get,
    setStorageSync: store.set,
    removeStorageSync: store.del,
    vibrateShort() {},
    showToast() {},
    showModal() {},
    env: { USER_DATA_PATH: '' },
    getFileSystemManager: () => noopFS,
    cloud: {
      downloadFile: (o) => o && o.fail && o.fail(new Error('no cloud')),
      uploadFile: (o) => o && o.fail && o.fail(new Error('no cloud'))
    }
  }
}

// 把小程序 Page({...}) 定义跑成一个实例：data 用响应式对象，setData 合并即触发更新。
export function runPage(def, reactiveData) {
  const inst = Object.assign({}, def)
  inst.data = reactiveData
  inst.setData = (patch) => { if (patch) for (const k in patch) reactiveData[k] = patch[k] }
  return inst
}
