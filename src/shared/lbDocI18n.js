// 「详细预算」区的界面语汇中英对照 —— 功能区的「语言」是报表语言，切到 English 时
// 这一区（级联主表 + 参考段 + 图表区）连同导出内容一起变英文，而不是只有导出的文件。
//
// 同一区里的文字有三处出处，各管一段，都以中文原文为键、未命中原样返回：
//   段标题 / 行标签 / 特殊单位   core/utils/waterfallBuilder.js 的 WF_DICT
//                               （取瀑布数据时就按 lang 翻好，与 Excel 导出同一份译法）
//   场变量名                     core/utils/lbOutputDefs.js 的 labelEn
//                               （随可绘输出量清单过 IPC 带过来，与临界值声明同源）
//   本文件                       剩下的界面语汇：三线表列头、图名、轴名、控制条、状态提示
//
// 译法与 electron/services/report.js 的英文列头对齐（上行 = Uplink、下行 = Downlink、
// 合计 = Total）：一份链路预算里表、图、导出三处不能各说一套。
// 带插值的句子（「××在本区间内恒定（…）」一类）不进字典，在用处按 lang 分支拼，
// 免得字典里塞满占位符反而看不出译文长什么样。

export const LB_DOC_EN = {
  // —— 三线表列头 ——
  '上行': 'Uplink',
  '下行': 'Downlink',
  '合计': 'Total',

  // —— 图名与题注 ——
  '地理': 'Geography',
  '链路': 'Link',
  '站址经纬度 · 换个地方还成不成立': 'Site coordinates · does the link still close elsewhere',
  '站星几何 · 这条链路在天上长什么样': 'Station–satellite geometry · what this link looks like in space',
  '地理场图': 'Geographic Field',
  '链路视图': 'Link View',

  // —— 轴名（地理图四个组合名）——
  '发信站经度': 'Tx Station Longitude',
  '发信站纬度': 'Tx Station Latitude',
  '收信站经度': 'Rx Station Longitude',
  '收信站纬度': 'Rx Station Latitude',

  // —— 控制条 ——
  '站': 'Site',
  '发信站': 'Tx station',
  '收信站': 'Rx station',
  '经度': 'Longitude',
  '纬度': 'Latitude',
  '场': 'Field',
  '网格': 'Grid',
  '粗 21×21': 'Coarse 21×21',
  '中 31×31': 'Medium 31×31',
  '细 41×41': 'Fine 41×41',
  '数据': 'Data',
  '出图': 'Figure',
  '复位': 'Reset',
  ' · 恒定': ' · constant',

  // —— 悬停说明与导出对话框的文件类型名 ——
  '扫哪一端的站址：另一端固定在当前取值': 'Which end of the link to sweep; the other end stays at its current value',
  '平面上画哪个量的等值线': 'Which quantity to contour on the plane',
  '网格越密曲线越细腻，代价是逐格重跑一次引擎': 'A denser grid draws finer contours, at the cost of one full engine run per cell',
  '回到默认区间': 'Back to the default range',
  '导出本图背后的网格数据为 CSV（一行一格）': 'Export the grid behind this figure as CSV (one row per cell)',
  '导出本图为 PNG 图片（4 倍分辨率，可直接放进报告）': 'Export this figure as a PNG image (4× resolution, ready for a report)',
  'PNG 图片': 'PNG Image',
  'CSV 表格': 'CSV Table',

  // —— 链路视图（上行/下行沿用上面三线表列头那两条）——
  '自转': 'Spin',
  '星间': 'ISL',
  '仰角': 'Elevation',
  '方位': 'Azimuth',
  '斜距': 'Slant range',
  '星间距离': 'Inter-satellite range',
  '让地球缓慢自转（不影响任何数值）': 'Slowly spin the globe (affects no numbers)',
  '回到自动取景的视角': 'Back to the auto-framed viewpoint',
  '本图几何所在时刻（与详细预算同一瞬间）': 'The instant this geometry belongs to (same instant as the detailed budget)',
  '先计算链路，再在此看几何': 'Compute a link first; its geometry appears here',
  '拖拽旋转 · 滚轮缩放 · 尺度按真实比例': 'Drag to rotate · scroll to zoom · true scale',
  '3D 视图初始化失败': '3-D view failed to initialise',
  // 算得出预算却画不出几何时，说清缺的是哪一项（引擎对空值有默认值兜底，图没有）
  '这条链路画不出几何': 'No geometry can be drawn for this link',
  '取不到发信站经纬度': 'transmit-station longitude/latitude unavailable',
  '取不到收信站经纬度': 'receive-station longitude/latitude unavailable',
  '取不到卫星定点轨道经度': 'satellite orbital longitude unavailable',
  '取不到卫星星下点': 'satellite sub-point unavailable',
  '取不到轨道高度': 'orbit altitude unavailable',
  '取不到轨道高度或最差仰角': 'orbit altitude or worst-case elevation unavailable',
  '取不到两星的星下点': 'sub-points of the two satellites unavailable',
  '星间几何不可解（两星互不可见或缺相位）': 'ISL geometry unsolvable (satellites not mutually visible, or phase missing)',

  // —— 状态与提示（引擎抛回来的消息不在字典里，原样透出）——
  '先计算链路，再在此出图': 'Compute a link first; the figure appears here',
  '暂无扫描结果': 'No sweep result yet',
  '区间无效（上限须大于下限）': 'Invalid range (upper bound must exceed lower bound)',
  '扫描失败': 'Sweep failed',
  '扫描中…': 'Sweeping…',
  '格': 'cells',
  '本区间全部不在卫星覆盖内': 'The whole range lies outside satellite coverage',
  '多因当前计算方式把它钉死了 · 换一个随两轴变化的量或换轴': 'Usually pinned by the current calculation mode · pick a quantity that varies with the axes, or change the axes'
};

// lang → 翻译函数（中文原文 ⇒ 该语言下的文字）。中文或未命中一律原样返回。
export function lbDocT(lang) {
  if (lang !== 'en') return (s) => s;
  return (s) => ((s && LB_DOC_EN[s] !== undefined) ? LB_DOC_EN[s] : s);
}

// 场变量名：清单自带 labelEn（core/utils/lbOutputDefs.js），缺则退回中文标签
export function lbZName(def, lang) {
  if (!def) return '';
  return (lang === 'en' && def.labelEn) ? def.labelEn : (def.label || '');
}
