// ExcelGrid 的「勾选列」：ExcelGrid 的格子只出文本，没有复选框；这里在表外包一层捕获阶段的监听，
// 把「点勾选列的格」翻成勾 / 不勾，「点该列表头」翻成全选 / 全不选，「空格」翻选区里的行。
// 格子的外观由调用方的 cellClass（'md-chk' / 'md-chk on'）+ md-chk 的样式给出（见 styles 里 :deep(td.md-chk)）。
// 为什么不给 ExcelGrid 加一种列类型：那是全平台四张表共用的组件，不在本窗口的文件范围里；包一层就够用。

/**
 * @param {object} grid useGridSelect 的返回
 * @param {{key?:string, cols:()=>object[], isOn:(row)=>boolean, set:(row, on:boolean)=>void, setAll:(on:boolean)=>void, rows:()=>object[]}} o
 */
export function useCheckCol(grid, o) {
  const key = o.key || 'chk'
  function colIndex() { return (grid.visCols ? grid.visCols.value : o.cols()).findIndex((c) => c.key === key) }
  function onClickCapture(ev) {
    const t = ev.target
    if (!t || !t.closest) return
    const th = t.closest('th.eg-h')
    if (th && th.getAttribute('data-k') === key) {
      ev.stopPropagation(); ev.preventDefault()
      const rows = o.rows()
      const allOn = rows.length > 0 && rows.every(o.isOn)
      o.setAll(!allOn)
      return
    }
    const td = t.closest('td.eg-c')
    if (!td) return
    const tr = td.parentElement
    const tds = Array.from(tr.querySelectorAll(':scope > td.eg-c'))
    if (tds.indexOf(td) !== colIndex()) return
    const trs = Array.from(tr.parentElement.querySelectorAll(':scope > tr')).filter((x) => !x.classList.contains('eg-addrow') && !x.querySelector('.eg-empty'))
    const ri = trs.indexOf(tr)
    const row = grid.rows.value[ri]
    if (row) o.set(row, !o.isOn(row))
  }
  function onKeyCapture(ev) {
    if (ev.key !== ' ' || ev.ctrlKey || ev.altKey || ev.metaKey) return
    const r = grid.rect.value
    if (r.r0 < 0) return
    const rows = grid.rows.value.slice(r.r0, r.r1 + 1)
    if (!rows.length) return
    ev.preventDefault(); ev.stopPropagation()
    const allOn = rows.every(o.isOn)
    for (const row of rows) o.set(row, !allOn)
  }
  return { onClickCapture, onKeyCapture }
}
