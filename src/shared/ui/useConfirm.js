// Promise 式确认框（全平台一份；原四个链路预算窗、雨衰、空间态势、日凌、模型工作台、文件管理各抄一份，共 9 份）。
//
//   import { askConfirm } from '../shared/ui/useConfirm.js'
//   if (!(await askConfirm('删除配置「x」？'))) return
//   askConfirm(msg, { title, okText, cancelText, danger })
//
// 窗口根组件里挂一次 <ConfirmDialog />（components/ConfirmDialog.vue）。
// 每个窗口是独立的渲染进程，模块级单例即「本窗一份」；主窗里 App.vue 挂一次，3D 页与各子组件共用。
// 外壳是 AppDialog：Esc / 关闭钮 = 取消，点遮罩不取消；打开时焦点落在「确定」上（回车即确定）。
// 文案走 DOM 词典翻译（不挂 data-i18n-skip）：动态拼的句子由 uiDict 的 PAT 条目接住。
import { reactive } from 'vue'

export const confirmState = reactive({ open: false, msg: '', title: '', okText: '', cancelText: '', danger: false })
let resolver = null

export function askConfirm(msg, opts = {}) {
  // 上一个还没答就又来一个：前一个按「取消」了结，免得它的 await 永远挂着
  if (resolver) { const r = resolver; resolver = null; r(false) }
  Object.assign(confirmState, {
    open: true,
    msg: String(msg ?? ''),
    title: opts.title || '确认',
    okText: opts.okText || '确定',
    cancelText: opts.cancelText || '取消',
    danger: !!opts.danger,
  })
  return new Promise((res) => { resolver = res })
}

export function answerConfirm(ok) {
  confirmState.open = false
  const r = resolver; resolver = null
  if (r) r(!!ok)
}

export function useConfirm() { return askConfirm }
