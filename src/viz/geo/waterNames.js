// 水域注记（大洋 + 海域）的单一来源 —— 3D 球体（globe3d/scene.js）与 2D 平面图（flatmap/flatCoverage.js）
// 共用这一份。原先两处各存一份逐字符相同的 OCEANS 副本，改一处漏一处就是「球上有、平面图没有」。
//
// 分两档，各自独立的显隐 / 字号 / 颜色 / 透明度（见地图设置「地名」一节）：
//   ocean 大洋 —— 五大洋，太平洋 / 大西洋面积大，分东西两处各标一次（同一 id，勾选清单里只出现一条）
//   sea   海域 —— 边缘海 / 海湾 / 海峡 / 内海
//
// px = 该注记在「每度 13.1 像素」这一基准视图下的字号（2D 直接用，3D 按 hpx = 0.034 × px/15 折算成世界高）。
// 它就是这一层的制图层级：大洋 15 > 大海 11 > 海湾 9 > 海峡 / 小海 7.5 —— 小的那几档在世界视角下
// 会被「低于 2.5 px 不画」的门槛自然滤掉，拉近才逐档冒出来，不需要另写一套缩放规则。
// pri = 同层内的摆位先后（避让时大的先占位），故直接取 px。
//
// 位置一律取该水域的一处开阔水面，不取几何质心 —— 质心可能落在陆地上（如渤海、加利福尼亚湾）。
const O = 15, SEA = 11, BAY = 9, STR = 7.5

const RAW = [
  // 大洋
  ['ocean', 'pacific', '太平洋', 'Pacific Ocean', -155, 25, O],
  ['ocean', 'pacific', '太平洋', 'Pacific Ocean', -130, -22, O],
  ['ocean', 'atlantic', '大西洋', 'Atlantic Ocean', -35, 28, O],
  ['ocean', 'atlantic', '大西洋', 'Atlantic Ocean', -18, -25, O],
  ['ocean', 'indian', '印度洋', 'Indian Ocean', 78, -28, O],
  ['ocean', 'arctic', '北冰洋', 'Arctic Ocean', 0, 85, O],
  ['ocean', 'southern', '南大洋', 'Southern Ocean', 40, -62, O],

  // 西太平洋 / 东亚
  ['sea', 'south-china-sea', '南海', 'South China Sea', 114.5, 13.5, SEA],
  ['sea', 'east-china-sea', '东海', 'East China Sea', 125.5, 29.0, SEA],
  ['sea', 'yellow-sea', '黄海', 'Yellow Sea', 123.5, 35.5, BAY],
  ['sea', 'bohai-sea', '渤海', 'Bohai Sea', 119.6, 38.6, STR],
  ['sea', 'taiwan-strait', '台湾海峡', 'Taiwan Strait', 119.3, 24.3, STR],
  ['sea', 'gulf-of-tonkin', '北部湾', 'Gulf of Tonkin', 108.0, 19.5, BAY],
  ['sea', 'sea-of-japan', '日本海', 'Sea of Japan', 135.0, 40.0, SEA],
  ['sea', 'sea-of-okhotsk', '鄂霍次克海', 'Sea of Okhotsk', 148.0, 53.5, SEA],
  ['sea', 'bering-sea', '白令海', 'Bering Sea', -177.0, 57.5, SEA],
  ['sea', 'bering-strait', '白令海峡', 'Bering Strait', -169.0, 65.8, STR],
  ['sea', 'philippine-sea', '菲律宾海', 'Philippine Sea', 131.0, 17.0, SEA],
  ['sea', 'sulu-sea', '苏禄海', 'Sulu Sea', 120.0, 8.5, STR],
  ['sea', 'celebes-sea', '苏拉威西海', 'Celebes Sea', 123.0, 3.5, STR],
  ['sea', 'java-sea', '爪哇海', 'Java Sea', 112.0, -5.2, BAY],
  ['sea', 'banda-sea', '班达海', 'Banda Sea', 127.5, -5.5, STR],
  ['sea', 'arafura-sea', '阿拉弗拉海', 'Arafura Sea', 136.0, -9.5, BAY],
  ['sea', 'timor-sea', '帝汶海', 'Timor Sea', 127.5, -11.5, BAY],
  ['sea', 'coral-sea', '珊瑚海', 'Coral Sea', 154.0, -18.0, SEA],
  ['sea', 'tasman-sea', '塔斯曼海', 'Tasman Sea', 162.0, -38.0, SEA],
  ['sea', 'gulf-of-carpentaria', '卡奔塔利亚湾', 'Gulf of Carpentaria', 139.5, -14.0, STR],
  ['sea', 'great-australian-bight', '大澳大利亚湾', 'Great Australian Bight', 132.0, -35.5, BAY],

  // 印度洋周边 / 中东
  ['sea', 'gulf-of-thailand', '泰国湾', 'Gulf of Thailand', 101.5, 9.5, BAY],
  ['sea', 'strait-of-malacca', '马六甲海峡', 'Strait of Malacca', 99.0, 4.5, STR],
  ['sea', 'andaman-sea', '安达曼海', 'Andaman Sea', 95.5, 11.0, BAY],
  ['sea', 'bay-of-bengal', '孟加拉湾', 'Bay of Bengal', 88.0, 15.0, SEA],
  ['sea', 'arabian-sea', '阿拉伯海', 'Arabian Sea', 63.0, 15.0, SEA],
  ['sea', 'gulf-of-oman', '阿曼湾', 'Gulf of Oman', 58.5, 24.5, STR],
  ['sea', 'strait-of-hormuz', '霍尔木兹海峡', 'Strait of Hormuz', 56.5, 26.6, STR],
  ['sea', 'persian-gulf', '波斯湾', 'Persian Gulf', 51.5, 27.2, BAY],
  ['sea', 'red-sea', '红海', 'Red Sea', 38.3, 20.5, BAY],
  ['sea', 'bab-el-mandeb', '曼德海峡', 'Bab-el-Mandeb', 43.4, 12.6, STR],
  ['sea', 'gulf-of-aden', '亚丁湾', 'Gulf of Aden', 47.5, 12.5, BAY],
  ['sea', 'mozambique-channel', '莫桑比克海峡', 'Mozambique Channel', 41.5, -19.0, STR],

  // 地中海 / 黑海 / 里海
  ['sea', 'mediterranean-sea', '地中海', 'Mediterranean Sea', 17.5, 34.8, SEA],
  ['sea', 'strait-of-gibraltar', '直布罗陀海峡', 'Strait of Gibraltar', -5.5, 35.95, STR],
  ['sea', 'tyrrhenian-sea', '第勒尼安海', 'Tyrrhenian Sea', 12.2, 39.8, STR],
  ['sea', 'adriatic-sea', '亚得里亚海', 'Adriatic Sea', 16.8, 42.5, STR],
  ['sea', 'ionian-sea', '伊奥尼亚海', 'Ionian Sea', 18.5, 37.3, STR],
  ['sea', 'aegean-sea', '爱琴海', 'Aegean Sea', 25.2, 37.8, STR],
  ['sea', 'black-sea', '黑海', 'Black Sea', 34.0, 43.2, BAY],
  ['sea', 'sea-of-azov', '亚速海', 'Sea of Azov', 36.5, 46.2, STR],
  ['sea', 'caspian-sea', '里海', 'Caspian Sea', 50.5, 41.5, BAY],

  // 欧洲 / 北大西洋
  ['sea', 'bay-of-biscay', '比斯开湾', 'Bay of Biscay', -4.5, 45.5, BAY],
  ['sea', 'english-channel', '英吉利海峡', 'English Channel', -1.5, 50.0, STR],
  ['sea', 'north-sea', '北海', 'North Sea', 3.5, 56.0, BAY],
  ['sea', 'baltic-sea', '波罗的海', 'Baltic Sea', 19.5, 57.0, BAY],
  ['sea', 'norwegian-sea', '挪威海', 'Norwegian Sea', 2.0, 68.5, SEA],
  ['sea', 'greenland-sea', '格陵兰海', 'Greenland Sea', -4.0, 76.0, BAY],
  ['sea', 'white-sea', '白海', 'White Sea', 37.0, 65.5, STR],

  // 北冰洋边缘海
  ['sea', 'barents-sea', '巴伦支海', 'Barents Sea', 42.0, 74.0, SEA],
  ['sea', 'kara-sea', '喀拉海', 'Kara Sea', 75.0, 74.5, BAY],
  ['sea', 'laptev-sea', '拉普捷夫海', 'Laptev Sea', 128.0, 76.0, BAY],
  ['sea', 'east-siberian-sea', '东西伯利亚海', 'East Siberian Sea', 160.0, 73.5, BAY],
  ['sea', 'chukchi-sea', '楚科奇海', 'Chukchi Sea', -170.0, 70.0, BAY],
  ['sea', 'beaufort-sea', '波弗特海', 'Beaufort Sea', -140.0, 72.0, BAY],

  // 美洲
  ['sea', 'baffin-bay', '巴芬湾', 'Baffin Bay', -65.0, 73.0, BAY],
  ['sea', 'hudson-bay', '哈得孙湾', 'Hudson Bay', -85.0, 59.0, BAY],
  ['sea', 'labrador-sea', '拉布拉多海', 'Labrador Sea', -55.0, 58.0, BAY],
  ['sea', 'gulf-of-st-lawrence', '圣劳伦斯湾', 'Gulf of St. Lawrence', -61.5, 48.0, STR],
  ['sea', 'gulf-of-mexico', '墨西哥湾', 'Gulf of Mexico', -90.0, 25.0, SEA],
  ['sea', 'caribbean-sea', '加勒比海', 'Caribbean Sea', -75.0, 14.5, SEA],
  ['sea', 'gulf-of-california', '加利福尼亚湾', 'Gulf of California', -111.0, 26.5, STR],
  ['sea', 'gulf-of-alaska', '阿拉斯加湾', 'Gulf of Alaska', -145.0, 56.0, BAY],
  ['sea', 'scotia-sea', '斯科舍海', 'Scotia Sea', -45.0, -57.0, BAY],
  ['sea', 'drake-passage', '德雷克海峡', 'Drake Passage', -63.0, -58.5, STR],

  // 非洲
  ['sea', 'gulf-of-guinea', '几内亚湾', 'Gulf of Guinea', 2.0, 2.0, BAY],

  // 南大洋边缘海
  ['sea', 'weddell-sea', '威德尔海', 'Weddell Sea', -45.0, -72.0, BAY],
  ['sea', 'ross-sea', '罗斯海', 'Ross Sea', 175.0, -75.0, BAY],
  ['sea', 'amundsen-sea', '阿蒙森海', 'Amundsen Sea', -110.0, -71.5, BAY],
  ['sea', 'bellingshausen-sea', '别林斯高晋海', 'Bellingshausen Sea', -85.0, -70.0, BAY]
]

// 渲染用的注记形状：{ tier, id, zh, en, lon, lat, px, pri }。pri = px（同层内大的先占位，见避让）。
export const WATERS = RAW.map(([tier, id, zh, en, lon, lat, px]) => ({ tier, id, zh, en, lon, lat, px, pri: px }))

// 逐档的注记（含同名多处）。off = { id: true } 即这一条被用户关掉
export function waterLabels(tier, off) {
  const o = off || {}
  return WATERS.filter((w) => w.tier === tier && !o[w.id])
}

// 逐档的勾选清单：按 id 去重（太平洋/大西洋各标两处，清单里只出现一条），顺序即上表的编排顺序
export function waterList(tier) {
  const seen = new Set(), out = []
  for (const w of WATERS) { if (w.tier !== tier || seen.has(w.id)) continue; seen.add(w.id); out.push(w) }
  return out
}
