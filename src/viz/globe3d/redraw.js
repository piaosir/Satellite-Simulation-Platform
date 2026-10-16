// 3D 按需出帧的「重画请求」总线。
// 地球场景（scene.js）空闲时不逐帧重画，只在画面可能变了时出帧。场景自己的对外接口一调用就置脏；
// 这里收的是【场景看不见的】那些变化 —— 叠加层 / 宇宙空间里异步到货的东西（模型图标模板就绪、抽稀档回包、
// 星表与贴图解码完成、页面直接调模型层 / 实体层的接口），它们改完调一次 requestRedraw()，场景下一帧补画。
// 订阅方只有场景（同一时刻至多一个地球场景；多订一个也只是多出一帧）。
const subs = new Set()

export function requestRedraw() { for (const f of subs) f() }

export function onRedraw(fn) {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

// 把一个对外接口对象的函数成员都套一层：调用即请求重画（页面直接调叠加层接口时，场景收不到置脏）。
// skip：只读 / 不改画面的成员名（高频调用的读数接口不该每次都逼出一帧）。
export function redrawOnCall(api, skip) {
  for (const k of Object.keys(api)) {
    const f = api[k]
    if (typeof f !== 'function' || (skip && skip.has(k))) continue
    api[k] = function (...args) { const r = f.apply(this, args); requestRedraw(); return r }
  }
  return api
}
