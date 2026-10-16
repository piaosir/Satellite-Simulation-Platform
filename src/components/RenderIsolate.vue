<script>
// 渲染隔离：把页面模板里的一段放进它自己的渲染作用域。
// 页面根组件每拍整页重渲时，这一段不跟着重建 vnode（编译出的默认插槽是 STABLE、本组件又没有 props，父级更新判定直接跳过它）；
// 只有这一段自己读到的响应式数据变了，它才单独重渲。插槽在父组件作用域里编译：scoped 样式、事件、模板 ref 一律照旧，
// 也不多出任何 DOM（单根时原样返回那一个节点）。
// ★ 只用来包「读的全是 ref / computed / reactive」的那种段落：段里若读了普通变量（setup 里的 let），原来它是搭着别处的
//   重渲顺带刷新的，包进来就不刷了。另外别放进 v-for 里引用循环变量（那样插槽成了动态插槽，隔离失效但不会出错）。
export default {
  name: 'RenderIsolate',
  setup(_, { slots }) {
    return () => {
      const v = slots.default ? slots.default() : null
      return Array.isArray(v) && v.length === 1 ? v[0] : v
    }
  }
}
</script>
