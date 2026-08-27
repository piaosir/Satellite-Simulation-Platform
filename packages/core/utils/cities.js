// cities.js
// 城市数据 - 国内（中国所有地级市 + 港澳台 + 卫通信关站/航天城市）+ 国际知名城市 / 航天与地面站所在地
// 每条都带 en（英文名）：英文界面下的城市列表 / 站名回填一律取它（见 shared/cityName.js），检索也多一路。
//   国内条目的 en 取自民政部两级行政区表（resources/adm/CHN-adm1|adm2.json 的 name_en），
//   两级表里没有的县级市 / 口岸 / 航天场站 / 极点按通用罗马化补（Golmud、Korla、Erenhot…）；
//   两级表里本就撞名的五组（Suzhou/Taizhou/Fuzhou/Yichun/Yulin，地图上靠位置区分）另加省份括注——
//   英文名要写进站名、又要被站名反查坐标，撞名会静默写错一组经纬度。
// 国际条目另带 country / countryEn，检索走中文名、英文名、国家名三路。

// 国内城市总数（＝ CITIES_DATA 前 364 条；国际条目一律追加在其后，勿往中间插）
const CHINA_CITIES_COUNT = 364;

// 城市显示优先级顺序（打开下拉时默认排序）
const PRIORITY_ORDER = [
  // 第1层：直辖市 + 港澳台
  '北京', '上海', '天津', '重庆', '香港', '澳门', '台北',
  // 第2层：一线城市 + 各省省会
  '深圳',
  '石家庄', '太原', '呼和浩特',
  '沈阳', '长春', '哈尔滨',
  '济南', '南京', '杭州', '合肥', '福州', '南昌',
  '郑州', '武汉', '长沙',
  '广州', '南宁', '海口',
  '成都', '贵阳', '昆明', '拉萨',
  '西安', '兰州', '西宁',
  '银川',      // 宁夏省会 / 中星27信关站
  '乌鲁木齐',  // 新疆省会 / 中星26关口站
  // 第3层：卫通信关站 / 航天重要城市
  '怀来',    // 中星16 Ka信关站
  '喀什',    // 中星26关口站
  '大理',    // 中星26关口站
  '格尔木',  // 中星27信关站
  '西昌',    // 卫星发射中心
  '文昌',    // 卫星发射中心
  '敦煌'     // 深空测控站
];

const CITIES_DATA = [
  // ========== 中国地级市 (337个) ==========
  
  // 直辖市 (4个)
  { name: "北京", en: "Beijing", py: "bj", lat: 39.904, lon: 116.407, alt: 43.5 },
  { name: "上海", en: "Shanghai", py: "sh", lat: 31.230, lon: 121.473, alt: 4.0 },
  { name: "天津", en: "Tianjin", py: "tj", lat: 39.084, lon: 117.201, alt: 5.0 },
  { name: "重庆", en: "Chongqing", py: "cq", lat: 29.563, lon: 106.551, alt: 237.0 },
  
  // 特别行政区 (2个)
  { name: "香港", en: "Hong Kong", py: "xg", lat: 22.319, lon: 114.169, alt: 32.0 },
  { name: "澳门", en: "Macao", py: "am", lat: 22.199, lon: 113.544, alt: 22.0 },
  
  // 台湾省 (1个)
  { name: "台北", en: "Taipei", py: "tb", lat: 25.033, lon: 121.565, alt: 10.0 },
  
  // 黑龙江省 (13个)
  { name: "哈尔滨", en: "Harbin", py: "heb", lat: 45.803, lon: 126.535, alt: 150.0 },
  { name: "齐齐哈尔", en: "Qiqihar", py: "qqhe", lat: 47.354, lon: 123.918, alt: 147.0 },
  { name: "牡丹江", en: "Mudanjiang", py: "mdj", lat: 44.551, lon: 129.633, alt: 230.0 },
  { name: "佳木斯", en: "Jiamusi", py: "jms", lat: 46.800, lon: 130.318, alt: 83.0 },
  { name: "大庆", en: "Daqing", py: "dq", lat: 46.590, lon: 125.104, alt: 146.0 },
  { name: "鸡西", en: "Jixi", py: "jx", lat: 45.300, lon: 130.969, alt: 239.0 },
  { name: "双鸭山", en: "Shuangyashan", py: "sys", lat: 46.646, lon: 131.159, alt: 81.0 },
  { name: "伊春", en: "Yichun (Heilongjiang)", py: "yc", lat: 47.727, lon: 128.899, alt: 241.0 },
  { name: "七台河", en: "Qitaihe", py: "qth", lat: 45.771, lon: 131.003, alt: 215.0 },
  { name: "鹤岗", en: "Hegang", py: "hg", lat: 47.350, lon: 130.298, alt: 100.0 },
  { name: "黑河", en: "Heihe", py: "hh", lat: 50.245, lon: 127.528, alt: 166.0 },
  { name: "绥化", en: "Suihua", py: "shh", lat: 46.637, lon: 126.969, alt: 180.0 },
  { name: "大兴安岭", en: "Da Hinggan Ling", py: "dxal", lat: 51.991, lon: 124.711, alt: 496.0 },
  
  // 吉林省 (9个)
  { name: "长春", en: "Changchun", py: "cc", lat: 43.817, lon: 125.324, alt: 215.0 },
  { name: "吉林", en: "Jilin", py: "jl", lat: 43.838, lon: 126.550, alt: 189.0 },
  { name: "四平", en: "Siping", py: "sp", lat: 43.166, lon: 124.350, alt: 165.0 },
  { name: "辽源", en: "Liaoyuan", py: "ly", lat: 42.888, lon: 125.145, alt: 260.0 },
  { name: "通化", en: "Tonghua", py: "thh", lat: 41.728, lon: 125.940, alt: 380.0 },
  { name: "白山", en: "Baishan", py: "bs", lat: 41.943, lon: 126.428, alt: 696.0 },
  { name: "松原", en: "Songyuan", py: "soy", lat: 45.142, lon: 124.825, alt: 140.0 },
  { name: "白城", en: "Baicheng", py: "bc", lat: 45.619, lon: 122.839, alt: 155.0 },
  { name: "延边", en: "Yanbian", py: "yb", lat: 42.891, lon: 129.509, alt: 176.0 },
  
  // 辽宁省 (14个)
  { name: "沈阳", en: "Shenyang", py: "sya", lat: 41.805, lon: 123.431, alt: 55.0 },
  { name: "大连", en: "Dalian", py: "dl", lat: 38.914, lon: 121.615, alt: 93.0 },
  { name: "鞍山", en: "Anshan", py: "as", lat: 41.108, lon: 122.994, alt: 40.0 },
  { name: "抚顺", en: "Fushun", py: "fs", lat: 41.881, lon: 123.957, alt: 117.0 },
  { name: "本溪", en: "Benxi", py: "bx", lat: 41.294, lon: 123.766, alt: 185.0 },
  { name: "丹东", en: "Dandong", py: "dd", lat: 40.000, lon: 124.357, alt: 14.0 },
  { name: "锦州", en: "Jinzhou", py: "jz", lat: 41.095, lon: 121.127, alt: 28.0 },
  { name: "营口", en: "Yingkou", py: "yk", lat: 40.666, lon: 122.235, alt: 4.0 },
  { name: "阜新", en: "Fuxin", py: "fx", lat: 42.021, lon: 121.670, alt: 180.0 },
  { name: "辽阳", en: "Liaoyang", py: "liy", lat: 41.268, lon: 123.173, alt: 30.0 },
  { name: "盘锦", en: "Panjin", py: "pj", lat: 41.120, lon: 122.070, alt: 6.0 },
  { name: "铁岭", en: "Tieling", py: "tl", lat: 42.286, lon: 123.726, alt: 73.0 },
  { name: "朝阳", en: "Chaoyang", py: "chy", lat: 41.576, lon: 120.451, alt: 169.0 },
  { name: "葫芦岛", en: "Huludao", py: "hld", lat: 40.711, lon: 120.836, alt: 10.0 },
  
  // 内蒙古自治区 (12个)
  { name: "呼和浩特", en: "Hohhot", py: "hhht", lat: 40.842, lon: 111.749, alt: 1065.0 },
  { name: "包头", en: "Baotou", py: "bt", lat: 40.657, lon: 109.840, alt: 1067.0 },
  { name: "乌海", en: "Wuhai", py: "wh", lat: 39.655, lon: 106.794, alt: 1150.0 },
  { name: "赤峰", en: "Chifeng", py: "cf", lat: 42.258, lon: 118.887, alt: 568.0 },
  { name: "通辽", en: "Tongliao", py: "tol", lat: 43.653, lon: 122.244, alt: 179.0 },
  { name: "鄂尔多斯", en: "Ordos", py: "eeds", lat: 39.608, lon: 109.781, alt: 1380.0 },
  { name: "呼伦贝尔", en: "Hulunbuir", py: "hlbe", lat: 49.212, lon: 119.766, alt: 650.0 },
  { name: "巴彦淖尔", en: "Bayannur", py: "byne", lat: 40.743, lon: 107.387, alt: 1039.0 },
  { name: "乌兰察布", en: "Ulanqab", py: "wlcb", lat: 41.000, lon: 113.133, alt: 1417.0 },
  { name: "兴安盟", en: "Hinggan", py: "xam", lat: 46.076, lon: 122.037, alt: 284.0 },
  { name: "锡林郭勒盟", en: "Xilingol", py: "xlglm", lat: 43.933, lon: 116.048, alt: 989.0 },
  { name: "阿拉善盟", en: "Alxa", py: "alsm", lat: 38.851, lon: 105.729, alt: 1342.0 },
  
  // 河北省 (11个)
  { name: "石家庄", en: "Shijiazhuang", py: "sjz", lat: 38.042, lon: 114.514, alt: 83.0 },
  { name: "唐山", en: "Tangshan", py: "ts", lat: 39.631, lon: 118.180, alt: 29.0 },
  { name: "秦皇岛", en: "Qinhuangdao", py: "qhd", lat: 39.936, lon: 119.600, alt: 5.0 },
  { name: "邯郸", en: "Handan", py: "hd", lat: 36.609, lon: 114.490, alt: 60.0 },
  { name: "邢台", en: "Xingtai", py: "xt", lat: 37.070, lon: 114.504, alt: 77.0 },
  { name: "保定", en: "Baoding", py: "bd", lat: 38.874, lon: 115.465, alt: 19.0 },
  { name: "张家口", en: "Zhangjiakou", py: "zjk", lat: 40.824, lon: 114.886, alt: 726.0 },
  { name: "承德", en: "Chengde", py: "chd", lat: 40.951, lon: 117.963, alt: 386.0 },
  { name: "沧州", en: "Cangzhou", py: "caz", lat: 38.304, lon: 116.839, alt: 10.0 },
  { name: "廊坊", en: "Langfang", py: "lf", lat: 39.538, lon: 116.683, alt: 27.0 },
  { name: "衡水", en: "Hengshui", py: "hs", lat: 37.739, lon: 115.670, alt: 20.0 },
  
  // 山西省 (11个)
  { name: "太原", en: "Taiyuan", py: "ty", lat: 37.870, lon: 112.549, alt: 800.0 },
  { name: "大同", en: "Datong", py: "dt", lat: 40.076, lon: 113.300, alt: 1040.0 },
  { name: "阳泉", en: "Yangquan", py: "yq", lat: 37.857, lon: 113.569, alt: 700.0 },
  { name: "长治", en: "Changzhi", py: "cz", lat: 36.195, lon: 113.116, alt: 929.0 },
  { name: "晋城", en: "Jincheng", py: "jch", lat: 35.490, lon: 112.851, alt: 700.0 },
  { name: "朔州", en: "Shuozhou", py: "sz", lat: 39.331, lon: 112.432, alt: 1100.0 },
  { name: "晋中", en: "Jinzhong", py: "jzh", lat: 37.687, lon: 112.752, alt: 744.0 },
  { name: "运城", en: "Yuncheng", py: "yuch", lat: 35.026, lon: 111.007, alt: 370.0 },
  { name: "忻州", en: "Xinzhou", py: "xz", lat: 38.416, lon: 112.734, alt: 792.0 },
  { name: "临汾", en: "Linfen", py: "lif", lat: 36.088, lon: 111.518, alt: 449.0 },
  { name: "吕梁", en: "Lüliang", py: "ll", lat: 37.518, lon: 111.143, alt: 951.0 },
  
  // 山东省 (16个)
  { name: "济南", en: "Jinan", py: "jn", lat: 36.651, lon: 117.120, alt: 58.0 },
  { name: "青岛", en: "Qingdao", py: "qd", lat: 36.067, lon: 120.383, alt: 76.0 },
  { name: "淄博", en: "Zibo", py: "zb", lat: 36.813, lon: 118.055, alt: 57.0 },
  { name: "枣庄", en: "Zaozhuang", py: "zaz", lat: 34.811, lon: 117.324, alt: 63.0 },
  { name: "东营", en: "Dongying", py: "dy", lat: 37.434, lon: 118.675, alt: 8.0 },
  { name: "烟台", en: "Yantai", py: "yat", lat: 37.463, lon: 121.448, alt: 47.0 },
  { name: "潍坊", en: "Weifang", py: "wf", lat: 36.707, lon: 119.162, alt: 27.0 },
  { name: "济宁", en: "Jining", py: "jin", lat: 35.415, lon: 116.587, alt: 41.0 },
  { name: "泰安", en: "Tai'an", py: "ta", lat: 36.200, lon: 117.089, alt: 128.0 },
  { name: "威海", en: "Weihai", py: "weih", lat: 37.510, lon: 122.120, alt: 7.0 },
  { name: "日照", en: "Rizhao", py: "rz", lat: 35.416, lon: 119.527, alt: 16.0 },
  { name: "临沂", en: "Linyi", py: "liy", lat: 35.104, lon: 118.356, alt: 72.0 },
  { name: "德州", en: "Dezhou", py: "dez", lat: 37.436, lon: 116.359, alt: 21.0 },
  { name: "聊城", en: "Liaocheng", py: "lic", lat: 36.457, lon: 115.985, alt: 29.0 },
  { name: "滨州", en: "Binzhou", py: "bz", lat: 37.382, lon: 117.970, alt: 12.0 },
  { name: "菏泽", en: "Heze", py: "hz", lat: 35.234, lon: 115.480, alt: 50.0 },
  
  // 河南省 (17个)
  { name: "郑州", en: "Zhengzhou", py: "zz", lat: 34.746, lon: 113.625, alt: 110.0 },
  { name: "开封", en: "Kaifeng", py: "kf", lat: 34.797, lon: 114.348, alt: 73.0 },
  { name: "洛阳", en: "Luoyang", py: "luy", lat: 34.620, lon: 112.454, alt: 144.0 },
  { name: "平顶山", en: "Pingdingshan", py: "pds", lat: 33.766, lon: 113.193, alt: 136.0 },
  { name: "安阳", en: "Anyang", py: "ay", lat: 36.097, lon: 114.393, alt: 61.0 },
  { name: "鹤壁", en: "Hebi", py: "heb", lat: 35.748, lon: 114.297, alt: 65.0 },
  { name: "新乡", en: "Xinxiang", py: "xx", lat: 35.303, lon: 113.927, alt: 73.0 },
  { name: "焦作", en: "Jiaozuo", py: "jz", lat: 35.216, lon: 113.242, alt: 95.0 },
  { name: "濮阳", en: "Puyang", py: "puy", lat: 35.762, lon: 115.029, alt: 50.0 },
  { name: "许昌", en: "Xuchang", py: "xuc", lat: 34.035, lon: 113.852, alt: 67.0 },
  { name: "漯河", en: "Luohe", py: "lh", lat: 33.582, lon: 114.017, alt: 60.0 },
  { name: "三门峡", en: "Sanmenxia", py: "smx", lat: 34.773, lon: 111.200, alt: 374.0 },
  { name: "南阳", en: "Nanyang", py: "ny", lat: 33.004, lon: 112.528, alt: 130.0 },
  { name: "商丘", en: "Shangqiu", py: "shq", lat: 34.414, lon: 115.656, alt: 50.0 },
  { name: "信阳", en: "Xinyang", py: "xiy", lat: 32.147, lon: 114.075, alt: 114.0 },
  { name: "周口", en: "Zhoukou", py: "zk", lat: 33.625, lon: 114.696, alt: 48.0 },
  { name: "驻马店", en: "Zhumadian", py: "zmd", lat: 33.011, lon: 114.022, alt: 82.0 },
  
  // 江苏省 (13个)
  { name: "南京", en: "Nanjing", py: "nj", lat: 32.060, lon: 118.797, alt: 20.0 },
  { name: "无锡", en: "Wuxi", py: "wx", lat: 31.491, lon: 120.312, alt: 8.0 },
  { name: "徐州", en: "Xuzhou", py: "xuz", lat: 34.205, lon: 117.284, alt: 41.0 },
  { name: "常州", en: "Changzhou", py: "chz", lat: 31.811, lon: 119.974, alt: 7.0 },
  { name: "苏州", en: "Suzhou (Jiangsu)", py: "suz", lat: 31.299, lon: 120.585, alt: 6.0 },
  { name: "南通", en: "Nantong", py: "nt", lat: 31.980, lon: 120.894, alt: 6.0 },
  { name: "连云港", en: "Lianyungang", py: "lyg", lat: 34.596, lon: 119.222, alt: 5.0 },
  { name: "淮安", en: "Huaian", py: "ha", lat: 33.610, lon: 119.015, alt: 10.0 },
  { name: "盐城", en: "Yancheng", py: "yc", lat: 33.347, lon: 120.163, alt: 4.0 },
  { name: "扬州", en: "Yangzhou", py: "yz", lat: 32.394, lon: 119.413, alt: 8.0 },
  { name: "镇江", en: "Zhenjiang", py: "zj", lat: 32.188, lon: 119.425, alt: 22.0 },
  { name: "泰州", en: "Taizhou (Jiangsu)", py: "taz", lat: 32.455, lon: 119.923, alt: 6.0 },
  { name: "宿迁", en: "Suqian", py: "sq", lat: 33.963, lon: 118.275, alt: 25.0 },
  
  // 浙江省 (11个)
  { name: "杭州", en: "Hangzhou", py: "haz", lat: 30.274, lon: 120.155, alt: 19.0 },
  { name: "宁波", en: "Ningbo", py: "nb", lat: 29.868, lon: 121.544, alt: 4.0 },
  { name: "温州", en: "Wenzhou", py: "wz", lat: 27.994, lon: 120.699, alt: 22.0 },
  { name: "嘉兴", en: "Jiaxing", py: "jx", lat: 30.746, lon: 120.755, alt: 5.0 },
  { name: "湖州", en: "Huzhou", py: "huz", lat: 30.893, lon: 120.088, alt: 14.0 },
  { name: "绍兴", en: "Shaoxing", py: "sx", lat: 30.030, lon: 120.580, alt: 13.0 },
  { name: "金华", en: "Jinhua", py: "jh", lat: 29.079, lon: 119.647, alt: 63.0 },
  { name: "衢州", en: "Quzhou", py: "qz", lat: 28.970, lon: 118.873, alt: 66.0 },
  { name: "舟山", en: "Zhoushan", py: "zs", lat: 29.985, lon: 122.207, alt: 3.0 },
  { name: "台州", en: "Taizhou (Zhejiang)", py: "taz", lat: 28.656, lon: 121.421, alt: 5.0 },
  { name: "丽水", en: "Lishui", py: "lis", lat: 28.468, lon: 119.923, alt: 60.0 },
  
  // 安徽省 (16个)
  { name: "合肥", en: "Hefei", py: "hf", lat: 31.821, lon: 117.227, alt: 37.0 },
  { name: "芜湖", en: "Wuhu", py: "wuh", lat: 31.353, lon: 118.433, alt: 15.0 },
  { name: "蚌埠", en: "Bengbu", py: "bb", lat: 32.916, lon: 117.389, alt: 21.0 },
  { name: "淮南", en: "Huainan", py: "hn", lat: 32.625, lon: 117.018, alt: 20.0 },
  { name: "马鞍山", en: "Maanshan", py: "mas", lat: 31.670, lon: 118.507, alt: 28.0 },
  { name: "淮北", en: "Huaibei", py: "hub", lat: 33.974, lon: 116.791, alt: 31.0 },
  { name: "铜陵", en: "Tongling", py: "tol", lat: 30.945, lon: 117.812, alt: 33.0 },
  { name: "安庆", en: "Anqing", py: "aq", lat: 30.543, lon: 117.063, alt: 20.0 },
  { name: "黄山", en: "Huangshan", py: "hus", lat: 29.715, lon: 118.338, alt: 136.0 },
  { name: "滁州", en: "Chuzhou", py: "chuz", lat: 32.302, lon: 118.317, alt: 27.0 },
  { name: "阜阳", en: "Fuyang", py: "fy", lat: 32.890, lon: 115.815, alt: 30.0 },
  { name: "宿州", en: "Suzhou (Anhui)", py: "suz", lat: 33.646, lon: 116.964, alt: 27.0 },
  { name: "六安", en: "Lu'an", py: "la", lat: 31.735, lon: 116.521, alt: 60.0 },
  { name: "亳州", en: "Bozhou", py: "boz", lat: 33.845, lon: 115.779, alt: 37.0 },
  { name: "池州", en: "Chizhou", py: "ciz", lat: 30.665, lon: 117.491, alt: 23.0 },
  { name: "宣城", en: "Xuancheng", py: "xc", lat: 30.945, lon: 118.758, alt: 29.0 },
  
  // 福建省 (9个)
  { name: "福州", en: "Fuzhou (Fujian)", py: "fz", lat: 26.075, lon: 119.296, alt: 10.0 },
  { name: "厦门", en: "Xiamen", py: "xm", lat: 24.480, lon: 118.089, alt: 63.0 },
  { name: "莆田", en: "Putian", py: "pt", lat: 25.454, lon: 119.007, alt: 14.0 },
  { name: "三明", en: "Sanming", py: "sm", lat: 26.263, lon: 117.639, alt: 215.0 },
  { name: "泉州", en: "Quanzhou", py: "quz", lat: 24.874, lon: 118.676, alt: 30.0 },
  { name: "漳州", en: "Zhangzhou", py: "zhz", lat: 24.513, lon: 117.647, alt: 19.0 },
  { name: "南平", en: "Nanping", py: "np", lat: 26.641, lon: 118.178, alt: 155.0 },
  { name: "龙岩", en: "Longyan", py: "loy", lat: 25.075, lon: 117.017, alt: 290.0 },
  { name: "宁德", en: "Ningde", py: "nd", lat: 26.666, lon: 119.548, alt: 14.0 },
  
  // 江西省 (11个)
  { name: "南昌", en: "Nanchang", py: "nc", lat: 28.683, lon: 115.858, alt: 50.0 },
  { name: "景德镇", en: "Jingdezhen", py: "jdz", lat: 29.269, lon: 117.178, alt: 61.0 },
  { name: "萍乡", en: "Pingxiang", py: "px", lat: 27.623, lon: 113.854, alt: 120.0 },
  { name: "九江", en: "Jiujiang", py: "jj", lat: 29.705, lon: 116.001, alt: 35.0 },
  { name: "新余", en: "Xinyu", py: "xyu", lat: 27.818, lon: 114.917, alt: 131.0 },
  { name: "鹰潭", en: "Yingtan", py: "yit", lat: 28.260, lon: 117.069, alt: 49.0 },
  { name: "赣州", en: "Ganzhou", py: "gaz", lat: 25.831, lon: 114.935, alt: 124.0 },
  { name: "吉安", en: "Ji'an", py: "ja", lat: 27.111, lon: 114.993, alt: 71.0 },
  { name: "宜春", en: "Yichun (Jiangxi)", py: "yic", lat: 27.815, lon: 114.416, alt: 130.0 },
  { name: "抚州", en: "Fuzhou (Jiangxi)", py: "fuz", lat: 27.949, lon: 116.358, alt: 27.0 },
  { name: "上饶", en: "Shangrao", py: "sr", lat: 28.455, lon: 117.943, alt: 79.0 },
  
  // 湖北省 (17个)
  { name: "武汉", en: "Wuhan", py: "wh", lat: 30.593, lon: 114.305, alt: 37.0 },
  { name: "黄石", en: "Huangshi", py: "hus", lat: 30.199, lon: 115.039, alt: 25.0 },
  { name: "十堰", en: "Shiyan", py: "syy", lat: 32.629, lon: 110.798, alt: 260.0 },
  { name: "宜昌", en: "Yichang", py: "yich", lat: 30.692, lon: 111.286, alt: 76.0 },
  { name: "襄阳", en: "Xiangyang", py: "xy", lat: 32.009, lon: 112.122, alt: 69.0 },
  { name: "鄂州", en: "Ezhou", py: "ez", lat: 30.391, lon: 114.895, alt: 22.0 },
  { name: "荆门", en: "Jingmen", py: "jm", lat: 31.035, lon: 112.199, alt: 54.0 },
  { name: "孝感", en: "Xiaogan", py: "xg", lat: 30.924, lon: 113.926, alt: 36.0 },
  { name: "荆州", en: "Jingzhou", py: "jiz", lat: 30.335, lon: 112.239, alt: 32.0 },
  { name: "黄冈", en: "Huanggang", py: "hug", lat: 30.453, lon: 114.872, alt: 36.0 },
  { name: "咸宁", en: "Xianning", py: "xn", lat: 29.841, lon: 114.322, alt: 38.0 },
  { name: "随州", en: "Suizhou", py: "suiz", lat: 31.690, lon: 113.382, alt: 84.0 },
  { name: "恩施", en: "Enshi", py: "es", lat: 30.272, lon: 109.488, alt: 460.0 },
  { name: "仙桃", en: "Xiantao", py: "xit", lat: 30.362, lon: 113.454, alt: 27.0 },
  { name: "潜江", en: "Qianjiang", py: "qj", lat: 30.402, lon: 112.899, alt: 31.0 },
  { name: "天门", en: "Tianmen", py: "tm", lat: 30.663, lon: 113.166, alt: 34.0 },
  { name: "神农架", en: "Shennongjia", py: "snj", lat: 31.745, lon: 110.676, alt: 1200.0 },
  
  // 湖南省 (14个)
  { name: "长沙", en: "Changsha", py: "cs", lat: 28.228, lon: 112.939, alt: 66.0 },
  { name: "株洲", en: "Zhuzhou", py: "zuz", lat: 27.827, lon: 113.134, alt: 61.0 },
  { name: "湘潭", en: "Xiangtan", py: "xta", lat: 27.829, lon: 112.944, alt: 40.0 },
  { name: "衡阳", en: "Hengyang", py: "hey", lat: 26.893, lon: 112.572, alt: 79.0 },
  { name: "邵阳", en: "Shaoyang", py: "shay", lat: 27.239, lon: 111.468, alt: 248.0 },
  { name: "岳阳", en: "Yueyang", py: "yy", lat: 29.357, lon: 113.129, alt: 54.0 },
  { name: "常德", en: "Changde", py: "chd", lat: 29.032, lon: 111.699, alt: 35.0 },
  { name: "张家界", en: "Zhangjiajie", py: "zjj", lat: 29.117, lon: 110.479, alt: 183.0 },
  { name: "益阳", en: "Yiyang", py: "yiy", lat: 28.554, lon: 112.355, alt: 35.0 },
  { name: "郴州", en: "Chenzhou", py: "cez", lat: 25.770, lon: 113.015, alt: 189.0 },
  { name: "永州", en: "Yongzhou", py: "yoz", lat: 26.420, lon: 111.613, alt: 172.0 },
  { name: "怀化", en: "Huaihua", py: "huh", lat: 27.550, lon: 109.998, alt: 272.0 },
  { name: "娄底", en: "Loudi", py: "ld", lat: 27.700, lon: 111.994, alt: 170.0 },
  { name: "湘西", en: "Xiangxi", py: "xix", lat: 28.311, lon: 109.739, alt: 237.0 },
  
  // 广东省 (21个)
  { name: "广州", en: "Guangzhou", py: "gz", lat: 23.129, lon: 113.264, alt: 21.0 },
  { name: "韶关", en: "Shaoguan", py: "sg", lat: 24.810, lon: 113.597, alt: 69.0 },
  { name: "深圳", en: "Shenzhen", py: "szh", lat: 22.543, lon: 114.058, alt: 17.0 },
  { name: "珠海", en: "Zhuhai", py: "zhh", lat: 22.271, lon: 113.576, alt: 36.0 },
  { name: "汕头", en: "Shantou", py: "st", lat: 23.354, lon: 116.682, alt: 51.0 },
  { name: "佛山", en: "Foshan", py: "fos", lat: 23.022, lon: 113.122, alt: 8.0 },
  { name: "江门", en: "Jiangmen", py: "jme", lat: 22.579, lon: 113.081, alt: 18.0 },
  { name: "湛江", en: "Zhanjiang", py: "zhj", lat: 21.271, lon: 110.359, alt: 26.0 },
  { name: "茂名", en: "Maoming", py: "mm", lat: 21.663, lon: 110.925, alt: 28.0 },
  { name: "肇庆", en: "Zhaoqing", py: "zq", lat: 23.047, lon: 112.465, alt: 18.0 },
  { name: "惠州", en: "Huizhou", py: "huiz", lat: 23.112, lon: 114.416, alt: 19.0 },
  { name: "梅州", en: "Meizhou", py: "mz", lat: 24.289, lon: 116.117, alt: 88.0 },
  { name: "汕尾", en: "Shanwei", py: "sw", lat: 22.786, lon: 115.375, alt: 9.0 },
  { name: "河源", en: "Heyuan", py: "hy", lat: 23.746, lon: 114.700, alt: 35.0 },
  { name: "阳江", en: "Yangjiang", py: "yj", lat: 21.857, lon: 111.983, alt: 23.0 },
  { name: "清远", en: "Qingyuan", py: "qy", lat: 23.682, lon: 113.056, alt: 16.0 },
  { name: "东莞", en: "Dongguan", py: "dg", lat: 23.020, lon: 113.751, alt: 6.0 },
  { name: "中山", en: "Zhongshan", py: "zhs", lat: 22.517, lon: 113.393, alt: 6.0 },
  { name: "潮州", en: "Chaozhou", py: "chaz", lat: 23.657, lon: 116.622, alt: 8.0 },
  { name: "揭阳", en: "Jieyang", py: "jiy", lat: 23.550, lon: 116.373, alt: 20.0 },
  { name: "云浮", en: "Yunfu", py: "yf", lat: 22.915, lon: 112.044, alt: 54.0 },
  
  // 广西壮族自治区 (14个)
  { name: "南宁", en: "Nanning", py: "nn", lat: 22.817, lon: 108.366, alt: 72.0 },
  { name: "柳州", en: "Liuzhou", py: "liuz", lat: 24.326, lon: 109.412, alt: 97.0 },
  { name: "桂林", en: "Guilin", py: "gl", lat: 25.234, lon: 110.180, alt: 153.0 },
  { name: "梧州", en: "Wuzhou", py: "wuz", lat: 23.477, lon: 111.279, alt: 15.0 },
  { name: "北海", en: "Beihai", py: "bh", lat: 21.481, lon: 109.120, alt: 14.0 },
  { name: "防城港", en: "Fangchenggang", py: "fcg", lat: 21.687, lon: 108.354, alt: 5.0 },
  { name: "钦州", en: "Qinzhou", py: "qiz", lat: 21.979, lon: 108.654, alt: 10.0 },
  { name: "贵港", en: "Guigang", py: "gg", lat: 23.111, lon: 109.599, alt: 42.0 },
  { name: "玉林", en: "Yulin (Guangxi)", py: "yl", lat: 22.654, lon: 110.181, alt: 82.0 },
  { name: "百色", en: "Baise", py: "bse", lat: 23.902, lon: 106.618, alt: 173.0 },
  { name: "贺州", en: "Hezhou", py: "hez", lat: 24.403, lon: 111.567, alt: 108.0 },
  { name: "河池", en: "Hechi", py: "hec", lat: 24.692, lon: 108.085, alt: 221.0 },
  { name: "来宾", en: "Laibin", py: "lb", lat: 23.750, lon: 109.221, alt: 89.0 },
  { name: "崇左", en: "Chongzuo", py: "chz", lat: 22.377, lon: 107.365, alt: 128.0 },
  
  // 海南省 (4个)
  { name: "海口", en: "Haikou", py: "hk", lat: 20.020, lon: 110.320, alt: 14.0 },
  { name: "三亚", en: "Sanya", py: "say", lat: 18.253, lon: 109.504, alt: 7.0 },
  { name: "三沙", en: "Sansha", py: "sas", lat: 16.833, lon: 112.333, alt: 4.0 },
  { name: "儋州", en: "Danzhou", py: "daz", lat: 19.521, lon: 109.580, alt: 23.0 },
  
  // 四川省 (21个)
  { name: "成都", en: "Chengdu", py: "chd", lat: 30.572, lon: 104.066, alt: 500.0 },
  { name: "自贡", en: "Zigong", py: "zg", lat: 29.339, lon: 104.778, alt: 305.0 },
  { name: "攀枝花", en: "Panzhihua", py: "pzh", lat: 26.582, lon: 101.718, alt: 1108.0 },
  { name: "泸州", en: "Luzhou", py: "luz", lat: 28.871, lon: 105.442, alt: 306.0 },
  { name: "德阳", en: "Deyang", py: "dey", lat: 31.127, lon: 104.398, alt: 465.0 },
  { name: "绵阳", en: "Mianyang", py: "my", lat: 31.468, lon: 104.679, alt: 470.0 },
  { name: "广元", en: "Guangyuan", py: "gy", lat: 32.435, lon: 105.843, alt: 489.0 },
  { name: "遂宁", en: "Suining", py: "sn", lat: 30.513, lon: 105.593, alt: 300.0 },
  { name: "内江", en: "Neijiang", py: "nj", lat: 29.580, lon: 105.058, alt: 350.0 },
  { name: "乐山", en: "Leshan", py: "ls", lat: 29.552, lon: 103.765, alt: 424.0 },
  { name: "南充", en: "Nanchong", py: "nch", lat: 30.837, lon: 106.110, alt: 298.0 },
  { name: "眉山", en: "Meishan", py: "ms", lat: 30.075, lon: 103.848, alt: 420.0 },
  { name: "宜宾", en: "Yibin", py: "yib", lat: 28.752, lon: 104.643, alt: 292.0 },
  { name: "广安", en: "Guang'an", py: "ga", lat: 30.456, lon: 106.633, alt: 400.0 },
  { name: "达州", en: "Dazhou", py: "daz", lat: 31.209, lon: 107.468, alt: 310.0 },
  { name: "雅安", en: "Yaan", py: "yaa", lat: 30.014, lon: 103.042, alt: 627.0 },
  { name: "巴中", en: "Bazhong", py: "bzh", lat: 31.867, lon: 106.747, alt: 418.0 },
  { name: "资阳", en: "Ziyang", py: "ziy", lat: 30.128, lon: 104.627, alt: 391.0 },
  { name: "阿坝", en: "Aba", py: "ab", lat: 31.899, lon: 102.224, alt: 2664.0 },
  { name: "甘孜", en: "Garzê", py: "gaz", lat: 30.050, lon: 101.963, alt: 3394.0 },
  { name: "凉山", en: "Liangshan", py: "lis", lat: 27.881, lon: 102.267, alt: 1580.0 },
  
  // 贵州省 (9个)
  { name: "贵阳", en: "Guiyang", py: "guy", lat: 26.647, lon: 106.630, alt: 1070.0 },
  { name: "六盘水", en: "Liupanshui", py: "lps", lat: 26.592, lon: 104.830, alt: 1797.0 },
  { name: "遵义", en: "Zunyi", py: "zy", lat: 27.725, lon: 106.927, alt: 844.0 },
  { name: "安顺", en: "Anshun", py: "as", lat: 26.253, lon: 105.947, alt: 1392.0 },
  { name: "毕节", en: "Bijie", py: "bij", lat: 27.284, lon: 105.292, alt: 1511.0 },
  { name: "铜仁", en: "Tongren", py: "tr", lat: 27.718, lon: 109.189, alt: 414.0 },
  { name: "黔西南", en: "Qianxinan", py: "qxn", lat: 25.088, lon: 104.906, alt: 1274.0 },
  { name: "黔东南", en: "Qiandongnan", py: "qdn", lat: 26.584, lon: 107.982, alt: 676.0 },
  { name: "黔南", en: "Qiannan", py: "qn", lat: 26.254, lon: 107.522, alt: 997.0 },
  
  // 云南省 (16个)
  { name: "昆明", en: "Kunming", py: "km", lat: 25.043, lon: 102.832, alt: 1892.0 },
  { name: "曲靖", en: "Qujing", py: "quj", lat: 25.490, lon: 103.796, alt: 1881.0 },
  { name: "玉溪", en: "Yuxi", py: "yux", lat: 24.352, lon: 102.543, alt: 1636.0 },
  { name: "保山", en: "Baoshan", py: "bos", lat: 25.112, lon: 99.161, alt: 1653.0 },
  { name: "昭通", en: "Zhaotong", py: "zt", lat: 27.338, lon: 103.717, alt: 1949.0 },
  { name: "丽江", en: "Lijiang", py: "lj", lat: 26.855, lon: 100.228, alt: 2400.0 },
  { name: "普洱", en: "Pu'er", py: "pe", lat: 22.825, lon: 100.966, alt: 1302.0 },
  { name: "临沧", en: "Lincang", py: "lic", lat: 23.877, lon: 100.092, alt: 1502.0 },
  { name: "楚雄", en: "Chuxiong", py: "chx", lat: 25.033, lon: 101.546, alt: 1773.0 },
  { name: "红河", en: "Honghe", py: "hoh", lat: 23.364, lon: 103.374, alt: 1302.0 },
  { name: "文山", en: "Wenshan", py: "wes", lat: 23.369, lon: 104.216, alt: 1260.0 },
  { name: "西双版纳", en: "Xishuangbanna", py: "xsbn", lat: 22.008, lon: 100.797, alt: 552.0 },
  { name: "大理", en: "Dali", py: "dal", lat: 25.606, lon: 100.268, alt: 1976.0 },
  { name: "德宏", en: "Dehong", py: "deh", lat: 24.434, lon: 98.585, alt: 905.0 },
  { name: "怒江", en: "Nujiang", py: "nuj", lat: 25.850, lon: 98.856, alt: 1400.0 },
  { name: "迪庆", en: "Dêqên", py: "diq", lat: 27.819, lon: 99.702, alt: 3280.0 },
  
  // 西藏自治区 (7个)
  { name: "拉萨", en: "Lhasa", py: "las", lat: 29.645, lon: 91.117, alt: 3650.0 },
  { name: "日喀则", en: "Xigaze", py: "rkz", lat: 29.267, lon: 88.881, alt: 3836.0 },
  { name: "昌都", en: "Chamdo", py: "chd", lat: 31.141, lon: 97.172, alt: 3240.0 },
  { name: "林芝", en: "Nyingchi", py: "lz", lat: 29.654, lon: 94.361, alt: 3000.0 },
  { name: "山南", en: "Shannan", py: "shn", lat: 29.237, lon: 91.773, alt: 3700.0 },
  { name: "那曲", en: "Nagchu", py: "nq", lat: 31.476, lon: 92.071, alt: 4507.0 },
  { name: "阿里", en: "Ngari", py: "al", lat: 32.501, lon: 80.106, alt: 4278.0 },
  
  // 陕西省 (10个)
  { name: "西安", en: "Xi'an", py: "xa", lat: 34.342, lon: 108.940, alt: 400.0 },
  { name: "铜川", en: "Tongchuan", py: "tc", lat: 34.896, lon: 108.945, alt: 978.0 },
  { name: "宝鸡", en: "Baoji", py: "bj", lat: 34.362, lon: 107.238, alt: 574.0 },
  { name: "咸阳", en: "Xianyang", py: "xiy", lat: 34.329, lon: 108.709, alt: 479.0 },
  { name: "渭南", en: "Weinan", py: "wn", lat: 34.499, lon: 109.510, alt: 351.0 },
  { name: "延安", en: "Yan'an", py: "ya", lat: 36.585, lon: 109.489, alt: 959.0 },
  { name: "汉中", en: "Hanzhong", py: "haz", lat: 33.068, lon: 107.023, alt: 509.0 },
  { name: "榆林", en: "Yulin (Shaanxi)", py: "yul", lat: 38.285, lon: 109.734, alt: 1057.0 },
  { name: "安康", en: "Ankang", py: "ak", lat: 32.680, lon: 109.029, alt: 290.0 },
  { name: "商洛", en: "Shangluo", py: "shl", lat: 33.870, lon: 109.940, alt: 742.0 },
  
  // 甘肃省 (14个)
  { name: "兰州", en: "Lanzhou", py: "laz", lat: 36.061, lon: 103.834, alt: 1520.0 },
  { name: "嘉峪关", en: "Jiayuguan", py: "jyg", lat: 39.773, lon: 98.290, alt: 1700.0 },
  { name: "金昌", en: "Jinchang", py: "jc", lat: 38.520, lon: 102.188, alt: 1540.0 },
  { name: "白银", en: "Baiyin", py: "by", lat: 36.544, lon: 104.139, alt: 1641.0 },
  { name: "天水", en: "Tianshui", py: "tis", lat: 34.581, lon: 105.725, alt: 1141.0 },
  { name: "武威", en: "Wuwei", py: "ww", lat: 37.928, lon: 102.638, alt: 1531.0 },
  { name: "张掖", en: "Zhangye", py: "zhy", lat: 38.925, lon: 100.449, alt: 1483.0 },
  { name: "平凉", en: "Pingliang", py: "pl", lat: 35.543, lon: 106.665, alt: 1346.0 },
  { name: "酒泉", en: "Jiuquan", py: "jq", lat: 39.734, lon: 98.500, alt: 1477.0 },
  { name: "庆阳", en: "Qingyang", py: "qiy", lat: 35.709, lon: 107.643, alt: 1265.0 },
  { name: "定西", en: "Dingxi", py: "dx", lat: 35.580, lon: 104.626, alt: 1898.0 },
  { name: "陇南", en: "Longnan", py: "lon", lat: 33.401, lon: 104.921, alt: 1010.0 },
  { name: "临夏", en: "Linxia", py: "lix", lat: 35.601, lon: 103.210, alt: 1917.0 },
  { name: "甘南", en: "Gannan", py: "gan", lat: 34.983, lon: 102.911, alt: 2910.0 },
  
  // 青海省 (9个)
  { name: "西宁", en: "Xining", py: "xn", lat: 36.623, lon: 101.779, alt: 2275.0 },
  { name: "海东", en: "Haidong", py: "had", lat: 36.502, lon: 102.103, alt: 1978.0 },
  { name: "海北", en: "Haibei", py: "hab", lat: 36.954, lon: 100.901, alt: 2868.0 },
  { name: "黄南", en: "Huangnan", py: "hun", lat: 35.519, lon: 102.015, alt: 2491.0 },
  { name: "海南州", en: "Hainan Prefecture", py: "hnz", lat: 36.286, lon: 100.620, alt: 2261.0 },
  { name: "果洛", en: "Golog", py: "gl", lat: 34.471, lon: 100.244, alt: 3719.0 },
  { name: "玉树", en: "Yushu", py: "ysh", lat: 33.004, lon: 97.007, alt: 3681.0 },
  { name: "海西", en: "Haixi", py: "hax", lat: 37.377, lon: 97.371, alt: 2817.0 },
  { name: "格尔木", en: "Golmud", py: "gem", lat: 36.420, lon: 94.900, alt: 2808.0 },
  
  // 宁夏回族自治区 (5个)
  { name: "银川", en: "Yinchuan", py: "yc", lat: 38.487, lon: 106.232, alt: 1112.0 },
  { name: "石嘴山", en: "Shizuishan", py: "szs", lat: 39.233, lon: 106.376, alt: 1090.0 },
  { name: "吴忠", en: "Wuzhong", py: "wz", lat: 37.997, lon: 106.199, alt: 1126.0 },
  { name: "固原", en: "Guyuan", py: "guy", lat: 36.016, lon: 106.242, alt: 1753.0 },
  { name: "中卫", en: "Zhongwei", py: "zw", lat: 37.500, lon: 105.190, alt: 1225.0 },
  
  // 新疆维吾尔自治区 (14个)
  { name: "乌鲁木齐", en: "Ürümqi", py: "wlmq", lat: 43.825, lon: 87.617, alt: 800.0 },
  { name: "克拉玛依", en: "Karamay", py: "klmy", lat: 45.579, lon: 84.889, alt: 283.0 },
  { name: "吐鲁番", en: "Turpan", py: "tlf", lat: 42.951, lon: 89.189, alt: -95.0 },
  { name: "哈密", en: "Hami", py: "hm", lat: 42.819, lon: 93.515, alt: 739.0 },
  { name: "昌吉", en: "Changji", py: "chj", lat: 44.011, lon: 87.308, alt: 700.0 },
  { name: "博尔塔拉", en: "Bortala", py: "betl", lat: 44.906, lon: 82.066, alt: 533.0 },
  { name: "巴音郭楞", en: "Bayingolin", py: "bygl", lat: 41.764, lon: 86.145, alt: 932.0 },
  { name: "阿克苏", en: "Aksu", py: "aks", lat: 41.168, lon: 80.263, alt: 1104.0 },
  { name: "克孜勒苏", en: "Kizilsu", py: "kzls", lat: 39.714, lon: 76.168, alt: 1433.0 },
  { name: "喀什", en: "Kashgar", py: "ks", lat: 39.468, lon: 75.994, alt: 1289.0 },
  { name: "和田", en: "Hotan", py: "ht", lat: 37.110, lon: 79.922, alt: 1375.0 },
  { name: "伊犁", en: "Ili", py: "yl", lat: 43.916, lon: 81.324, alt: 639.0 },
  { name: "塔城", en: "Tacheng", py: "tac", lat: 46.746, lon: 82.980, alt: 534.0 },
  { name: "阿勒泰", en: "Altay", py: "alt", lat: 47.848, lon: 88.141, alt: 735.0 },
  
  // 卫通信关站 / 航天重要城市
  { name: "怀来", en: "Huailai", py: "hl", lat: 40.415, lon: 115.517, alt: 535.0 },   // 中星16 Ka信关站
  { name: "西昌", en: "Xichang", py: "xc", lat: 27.892, lon: 102.265, alt: 1590.0 },  // 卫星发射中心
  { name: "文昌", en: "Wenchang", py: "wc", lat: 19.613, lon: 110.750, alt: 34.0 },    // 卫星发射中心
  { name: "敦煌", en: "Dunhuang", py: "dh", lat: 40.142, lon: 94.662, alt: 1140.0 },   // 深空测控站

  // ========== 地理极点 / 边境关键点 (4个) ==========
  { name: "漠河", en: "Mohe", py: "mh", lat: 52.972, lon: 122.530, alt: 296.0 },     // 中国最北
  { name: "抚远", en: "Fuyuan", py: "fy", lat: 48.367, lon: 134.296, alt: 40.0 },      // 中国最东
  { name: "乌恰", en: "Wuqia", py: "wq", lat: 39.719, lon: 75.260, alt: 2180.0 },     // 中国最西县城
  { name: "曾母暗沙", en: "Zengmu Ansha", py: "zmas", lat: 3.858, lon: 112.283, alt: 0.0 },   // 中国最南

  // ========== 航天发射 / 测控 / 信关站所在地 (3个) ==========
  { name: "东风", en: "Dongfeng", py: "df", lat: 40.961, lon: 100.298, alt: 1000.0 },    // 酒泉卫星发射中心(额济纳)
  { name: "密云", en: "Miyun", py: "my", lat: 40.377, lon: 116.843, alt: 72.0 },      // 北京密云测控站
  { name: "佘山", en: "Sheshan", py: "ss", lat: 31.096, lon: 121.187, alt: 96.0 },      // 上海佘山 VLBI 站

  // ========== 重点县级市 / 口岸 (8个) ==========
  { name: "义乌", en: "Yiwu", py: "yw", lat: 29.307, lon: 120.075, alt: 65.0 },
  { name: "昆山", en: "Kunshan", py: "ks", lat: 31.388, lon: 120.981, alt: 5.0 },
  { name: "库尔勒", en: "Korla", py: "kel", lat: 41.726, lon: 86.174, alt: 933.0 },
  { name: "满洲里", en: "Manzhouli", py: "mzl", lat: 49.597, lon: 117.379, alt: 662.0 },  // 中俄口岸
  { name: "二连浩特", en: "Erenhot", py: "elht", lat: 43.653, lon: 111.979, alt: 966.0 }, // 中蒙口岸
  { name: "瑞丽", en: "Ruili", py: "rl", lat: 24.013, lon: 97.851, alt: 776.0 },      // 中缅口岸
  { name: "绥芬河", en: "Suifenhe", py: "sfh", lat: 44.412, lon: 131.157, alt: 480.0 },  // 中俄口岸
  { name: "东兴", en: "Dongxing", py: "dx", lat: 21.547, lon: 107.972, alt: 10.0 },      // 中越口岸

  // ========== 国际知名城市 / 航天与地面站所在地 (170个) ==========
  // ★ 必须整块追加在国内城市之后：PROVINCE_MAPPING 按【下标区间】切省，CHINA_CITIES_COUNT
  //   也是按下标切中外，往中间插一条会把两处一起错位。
  // 多一个 en / country / countryEn：检索走中文名、英文名、国家名三路（见 searchCities）。
  // 西经记负值（lon 恒为 °E 轴），引擎按此直接算，勿改成 0–360。

  // —— 东亚 ——
  { name: "东京", en: "Tokyo", country: "日本", countryEn: "Japan", py: "tokyo", lat: 35.690, lon: 139.692, alt: 40.0 },
  { name: "大阪", en: "Osaka", country: "日本", countryEn: "Japan", py: "osaka", lat: 34.694, lon: 135.502, alt: 12.0 },
  { name: "名古屋", en: "Nagoya", country: "日本", countryEn: "Japan", py: "nagoya", lat: 35.181, lon: 136.906, alt: 13.0 },
  { name: "福冈", en: "Fukuoka", country: "日本", countryEn: "Japan", py: "fukuoka", lat: 33.590, lon: 130.402, alt: 8.0 },
  { name: "札幌", en: "Sapporo", country: "日本", countryEn: "Japan", py: "sapporo", lat: 43.062, lon: 141.354, alt: 26.0 },
  { name: "种子岛", en: "Tanegashima", country: "日本", countryEn: "Japan", py: "tanegashima", lat: 30.400, lon: 130.968, alt: 30.0 },  // 航天发射场
  { name: "首尔", en: "Seoul", country: "韩国", countryEn: "South Korea", py: "seoul", lat: 37.567, lon: 126.978, alt: 38.0 },
  { name: "釜山", en: "Busan", country: "韩国", countryEn: "South Korea", py: "busan", lat: 35.180, lon: 129.075, alt: 10.0 },
  { name: "平壤", en: "Pyongyang", country: "朝鲜", countryEn: "North Korea", py: "pyongyang", lat: 39.019, lon: 125.738, alt: 27.0 },
  { name: "乌兰巴托", en: "Ulaanbaatar", country: "蒙古", countryEn: "Mongolia", py: "ulaanbaatar", lat: 47.886, lon: 106.906, alt: 1350.0 },

  // —— 东南亚 ——
  { name: "新加坡", en: "Singapore", country: "新加坡", countryEn: "Singapore", py: "singapore", lat: 1.352, lon: 103.820, alt: 15.0 },
  { name: "曼谷", en: "Bangkok", country: "泰国", countryEn: "Thailand", py: "bangkok", lat: 13.756, lon: 100.502, alt: 2.0 },
  { name: "吉隆坡", en: "Kuala Lumpur", country: "马来西亚", countryEn: "Malaysia", py: "kualalumpur", lat: 3.139, lon: 101.687, alt: 56.0 },
  { name: "雅加达", en: "Jakarta", country: "印度尼西亚", countryEn: "Indonesia", py: "jakarta", lat: -6.208, lon: 106.846, alt: 8.0 },
  { name: "泗水", en: "Surabaya", country: "印度尼西亚", countryEn: "Indonesia", py: "surabaya", lat: -7.258, lon: 112.752, alt: 5.0 },
  { name: "马尼拉", en: "Manila", country: "菲律宾", countryEn: "Philippines", py: "manila", lat: 14.599, lon: 120.984, alt: 16.0 },
  { name: "河内", en: "Hanoi", country: "越南", countryEn: "Vietnam", py: "hanoi", lat: 21.028, lon: 105.854, alt: 16.0 },
  { name: "胡志明市", en: "Ho Chi Minh City", country: "越南", countryEn: "Vietnam", py: "hochiminh", lat: 10.823, lon: 106.630, alt: 19.0 },
  { name: "金边", en: "Phnom Penh", country: "柬埔寨", countryEn: "Cambodia", py: "phnompenh", lat: 11.556, lon: 104.928, alt: 12.0 },
  { name: "万象", en: "Vientiane", country: "老挝", countryEn: "Laos", py: "vientiane", lat: 17.975, lon: 102.633, alt: 174.0 },
  { name: "仰光", en: "Yangon", country: "缅甸", countryEn: "Myanmar", py: "yangon", lat: 16.866, lon: 96.195, alt: 15.0 },
  { name: "斯里巴加湾市", en: "Bandar Seri Begawan", country: "文莱", countryEn: "Brunei", py: "bandarseribegawan", lat: 4.903, lon: 114.939, alt: 2.0 },
  { name: "帝力", en: "Dili", country: "东帝汶", countryEn: "Timor-Leste", py: "dili", lat: -8.557, lon: 125.578, alt: 5.0 },

  // —— 南亚 ——
  { name: "新德里", en: "New Delhi", country: "印度", countryEn: "India", py: "newdelhi", lat: 28.614, lon: 77.209, alt: 216.0 },
  { name: "孟买", en: "Mumbai", country: "印度", countryEn: "India", py: "mumbai", lat: 19.076, lon: 72.878, alt: 14.0 },
  { name: "班加罗尔", en: "Bangalore", country: "印度", countryEn: "India", py: "bangalore", lat: 12.972, lon: 77.594, alt: 920.0 },
  { name: "加尔各答", en: "Kolkata", country: "印度", countryEn: "India", py: "kolkata", lat: 22.573, lon: 88.364, alt: 9.0 },
  { name: "钦奈", en: "Chennai", country: "印度", countryEn: "India", py: "chennai", lat: 13.083, lon: 80.270, alt: 6.0 },
  { name: "斯里赫里戈达", en: "Sriharikota", country: "印度", countryEn: "India", py: "sriharikota", lat: 13.720, lon: 80.230, alt: 10.0 },  // 航天发射场
  { name: "达卡", en: "Dhaka", country: "孟加拉国", countryEn: "Bangladesh", py: "dhaka", lat: 23.811, lon: 90.413, alt: 8.0 },
  { name: "卡拉奇", en: "Karachi", country: "巴基斯坦", countryEn: "Pakistan", py: "karachi", lat: 24.861, lon: 67.010, alt: 8.0 },
  { name: "伊斯兰堡", en: "Islamabad", country: "巴基斯坦", countryEn: "Pakistan", py: "islamabad", lat: 33.684, lon: 73.048, alt: 540.0 },
  { name: "科伦坡", en: "Colombo", country: "斯里兰卡", countryEn: "Sri Lanka", py: "colombo", lat: 6.927, lon: 79.861, alt: 5.0 },
  { name: "加德满都", en: "Kathmandu", country: "尼泊尔", countryEn: "Nepal", py: "kathmandu", lat: 27.717, lon: 85.324, alt: 1400.0 },
  { name: "马累", en: "Male", country: "马尔代夫", countryEn: "Maldives", py: "male", lat: 4.175, lon: 73.509, alt: 2.0 },

  // —— 中亚 ——
  { name: "阿拉木图", en: "Almaty", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "almaty", lat: 43.238, lon: 76.889, alt: 780.0 },
  { name: "阿斯塔纳", en: "Astana", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "astana", lat: 51.169, lon: 71.449, alt: 347.0 },
  { name: "拜科努尔", en: "Baikonur", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "baikonur", lat: 45.965, lon: 63.305, alt: 90.0 },  // 航天发射场
  { name: "塔什干", en: "Tashkent", country: "乌兹别克斯坦", countryEn: "Uzbekistan", py: "tashkent", lat: 41.299, lon: 69.240, alt: 455.0 },
  { name: "比什凯克", en: "Bishkek", country: "吉尔吉斯斯坦", countryEn: "Kyrgyzstan", py: "bishkek", lat: 42.874, lon: 74.570, alt: 800.0 },
  { name: "杜尚别", en: "Dushanbe", country: "塔吉克斯坦", countryEn: "Tajikistan", py: "dushanbe", lat: 38.560, lon: 68.787, alt: 800.0 },
  { name: "阿什哈巴德", en: "Ashgabat", country: "土库曼斯坦", countryEn: "Turkmenistan", py: "ashgabat", lat: 37.960, lon: 58.326, alt: 219.0 },

  // —— 西亚 / 中东 ——
  { name: "迪拜", en: "Dubai", country: "阿联酋", countryEn: "United Arab Emirates", py: "dubai", lat: 25.205, lon: 55.271, alt: 5.0 },
  { name: "阿布扎比", en: "Abu Dhabi", country: "阿联酋", countryEn: "United Arab Emirates", py: "abudhabi", lat: 24.453, lon: 54.377, alt: 5.0 },
  { name: "多哈", en: "Doha", country: "卡塔尔", countryEn: "Qatar", py: "doha", lat: 25.286, lon: 51.535, alt: 10.0 },
  { name: "利雅得", en: "Riyadh", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "riyadh", lat: 24.713, lon: 46.675, alt: 612.0 },
  { name: "吉达", en: "Jeddah", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "jeddah", lat: 21.486, lon: 39.192, alt: 12.0 },
  { name: "科威特城", en: "Kuwait City", country: "科威特", countryEn: "Kuwait", py: "kuwaitcity", lat: 29.376, lon: 47.978, alt: 5.0 },
  { name: "马斯喀特", en: "Muscat", country: "阿曼", countryEn: "Oman", py: "muscat", lat: 23.588, lon: 58.408, alt: 10.0 },
  { name: "麦纳麦", en: "Manama", country: "巴林", countryEn: "Bahrain", py: "manama", lat: 26.229, lon: 50.586, alt: 5.0 },
  { name: "德黑兰", en: "Tehran", country: "伊朗", countryEn: "Iran", py: "tehran", lat: 35.689, lon: 51.389, alt: 1189.0 },
  { name: "巴格达", en: "Baghdad", country: "伊拉克", countryEn: "Iraq", py: "baghdad", lat: 33.315, lon: 44.366, alt: 34.0 },
  { name: "安曼", en: "Amman", country: "约旦", countryEn: "Jordan", py: "amman", lat: 31.956, lon: 35.945, alt: 780.0 },
  { name: "贝鲁特", en: "Beirut", country: "黎巴嫩", countryEn: "Lebanon", py: "beirut", lat: 33.889, lon: 35.494, alt: 30.0 },
  { name: "大马士革", en: "Damascus", country: "叙利亚", countryEn: "Syria", py: "damascus", lat: 33.513, lon: 36.292, alt: 690.0 },
  { name: "特拉维夫", en: "Tel Aviv", country: "以色列", countryEn: "Israel", py: "telaviv", lat: 32.086, lon: 34.781, alt: 15.0 },
  { name: "伊斯坦布尔", en: "Istanbul", country: "土耳其", countryEn: "Turkey", py: "istanbul", lat: 41.008, lon: 28.978, alt: 39.0 },
  { name: "安卡拉", en: "Ankara", country: "土耳其", countryEn: "Turkey", py: "ankara", lat: 39.933, lon: 32.859, alt: 938.0 },
  { name: "巴库", en: "Baku", country: "阿塞拜疆", countryEn: "Azerbaijan", py: "baku", lat: 40.409, lon: 49.867, alt: -20.0 },
  { name: "第比利斯", en: "Tbilisi", country: "格鲁吉亚", countryEn: "Georgia", py: "tbilisi", lat: 41.716, lon: 44.783, alt: 450.0 },
  { name: "埃里温", en: "Yerevan", country: "亚美尼亚", countryEn: "Armenia", py: "yerevan", lat: 40.183, lon: 44.513, alt: 990.0 },

  // —— 俄罗斯 / 东欧 ——
  { name: "莫斯科", en: "Moscow", country: "俄罗斯", countryEn: "Russia", py: "moscow", lat: 55.756, lon: 37.617, alt: 156.0 },
  { name: "圣彼得堡", en: "Saint Petersburg", country: "俄罗斯", countryEn: "Russia", py: "saintpetersburg", lat: 59.939, lon: 30.315, alt: 3.0 },
  { name: "新西伯利亚", en: "Novosibirsk", country: "俄罗斯", countryEn: "Russia", py: "novosibirsk", lat: 55.030, lon: 82.921, alt: 150.0 },
  { name: "叶卡捷琳堡", en: "Yekaterinburg", country: "俄罗斯", countryEn: "Russia", py: "yekaterinburg", lat: 56.839, lon: 60.605, alt: 255.0 },
  { name: "符拉迪沃斯托克", en: "Vladivostok", country: "俄罗斯", countryEn: "Russia", py: "vladivostok", lat: 43.116, lon: 131.882, alt: 30.0 },
  { name: "基辅", en: "Kyiv", country: "乌克兰", countryEn: "Ukraine", py: "kyiv", lat: 50.450, lon: 30.523, alt: 179.0 },
  { name: "明斯克", en: "Minsk", country: "白俄罗斯", countryEn: "Belarus", py: "minsk", lat: 53.902, lon: 27.562, alt: 220.0 },

  // —— 欧洲 ——
  { name: "伦敦", en: "London", country: "英国", countryEn: "United Kingdom", py: "london", lat: 51.507, lon: -0.128, alt: 11.0 },
  { name: "曼彻斯特", en: "Manchester", country: "英国", countryEn: "United Kingdom", py: "manchester", lat: 53.480, lon: -2.243, alt: 38.0 },
  { name: "古恩希利", en: "Goonhilly", country: "英国", countryEn: "United Kingdom", py: "goonhilly", lat: 50.048, lon: -5.182, alt: 100.0 },  // 卫星地面站
  { name: "巴黎", en: "Paris", country: "法国", countryEn: "France", py: "paris", lat: 48.857, lon: 2.352, alt: 35.0 },
  { name: "图卢兹", en: "Toulouse", country: "法国", countryEn: "France", py: "toulouse", lat: 43.605, lon: 1.444, alt: 146.0 },  // CNES / 航天工业
  { name: "柏林", en: "Berlin", country: "德国", countryEn: "Germany", py: "berlin", lat: 52.520, lon: 13.405, alt: 34.0 },
  { name: "法兰克福", en: "Frankfurt", country: "德国", countryEn: "Germany", py: "frankfurt", lat: 50.110, lon: 8.682, alt: 112.0 },
  { name: "慕尼黑", en: "Munich", country: "德国", countryEn: "Germany", py: "munich", lat: 48.135, lon: 11.582, alt: 519.0 },
  { name: "达姆施塔特", en: "Darmstadt", country: "德国", countryEn: "Germany", py: "darmstadt", lat: 49.872, lon: 8.651, alt: 144.0 },  // ESOC 测控中心
  { name: "罗马", en: "Rome", country: "意大利", countryEn: "Italy", py: "rome", lat: 41.903, lon: 12.496, alt: 21.0 },
  { name: "米兰", en: "Milan", country: "意大利", countryEn: "Italy", py: "milan", lat: 45.464, lon: 9.190, alt: 120.0 },
  { name: "富奇诺", en: "Fucino", country: "意大利", countryEn: "Italy", py: "fucino", lat: 42.000, lon: 13.600, alt: 680.0 },  // 卫星地面站
  { name: "马德里", en: "Madrid", country: "西班牙", countryEn: "Spain", py: "madrid", lat: 40.417, lon: -3.704, alt: 667.0 },
  { name: "巴塞罗那", en: "Barcelona", country: "西班牙", countryEn: "Spain", py: "barcelona", lat: 41.385, lon: 2.173, alt: 12.0 },
  { name: "里斯本", en: "Lisbon", country: "葡萄牙", countryEn: "Portugal", py: "lisbon", lat: 38.722, lon: -9.139, alt: 100.0 },
  { name: "阿姆斯特丹", en: "Amsterdam", country: "荷兰", countryEn: "Netherlands", py: "amsterdam", lat: 52.370, lon: 4.895, alt: 2.0 },
  { name: "布鲁塞尔", en: "Brussels", country: "比利时", countryEn: "Belgium", py: "brussels", lat: 50.851, lon: 4.352, alt: 56.0 },
  { name: "卢森堡", en: "Luxembourg", country: "卢森堡", countryEn: "Luxembourg", py: "luxembourg", lat: 49.611, lon: 6.130, alt: 305.0 },
  { name: "苏黎世", en: "Zurich", country: "瑞士", countryEn: "Switzerland", py: "zurich", lat: 47.377, lon: 8.542, alt: 408.0 },
  { name: "日内瓦", en: "Geneva", country: "瑞士", countryEn: "Switzerland", py: "geneva", lat: 46.204, lon: 6.143, alt: 375.0 },  // ITU 所在地
  { name: "维也纳", en: "Vienna", country: "奥地利", countryEn: "Austria", py: "vienna", lat: 48.209, lon: 16.373, alt: 170.0 },
  { name: "布拉格", en: "Prague", country: "捷克", countryEn: "Czechia", py: "prague", lat: 50.076, lon: 14.438, alt: 200.0 },
  { name: "华沙", en: "Warsaw", country: "波兰", countryEn: "Poland", py: "warsaw", lat: 52.230, lon: 21.012, alt: 100.0 },
  { name: "布达佩斯", en: "Budapest", country: "匈牙利", countryEn: "Hungary", py: "budapest", lat: 47.498, lon: 19.040, alt: 102.0 },
  { name: "布加勒斯特", en: "Bucharest", country: "罗马尼亚", countryEn: "Romania", py: "bucharest", lat: 44.427, lon: 26.103, alt: 70.0 },
  { name: "索菲亚", en: "Sofia", country: "保加利亚", countryEn: "Bulgaria", py: "sofia", lat: 42.698, lon: 23.322, alt: 550.0 },
  { name: "贝尔格莱德", en: "Belgrade", country: "塞尔维亚", countryEn: "Serbia", py: "belgrade", lat: 44.787, lon: 20.449, alt: 117.0 },
  { name: "雅典", en: "Athens", country: "希腊", countryEn: "Greece", py: "athens", lat: 37.984, lon: 23.728, alt: 70.0 },
  { name: "斯德哥尔摩", en: "Stockholm", country: "瑞典", countryEn: "Sweden", py: "stockholm", lat: 59.329, lon: 18.069, alt: 28.0 },
  { name: "奥斯陆", en: "Oslo", country: "挪威", countryEn: "Norway", py: "oslo", lat: 59.914, lon: 10.752, alt: 23.0 },
  { name: "朗伊尔城", en: "Longyearbyen", country: "挪威", countryEn: "Norway", py: "longyearbyen", lat: 78.223, lon: 15.648, alt: 30.0 },  // 斯瓦尔巴极地地面站
  { name: "哥本哈根", en: "Copenhagen", country: "丹麦", countryEn: "Denmark", py: "copenhagen", lat: 55.676, lon: 12.568, alt: 14.0 },
  { name: "赫尔辛基", en: "Helsinki", country: "芬兰", countryEn: "Finland", py: "helsinki", lat: 60.170, lon: 24.938, alt: 26.0 },
  { name: "都柏林", en: "Dublin", country: "爱尔兰", countryEn: "Ireland", py: "dublin", lat: 53.350, lon: -6.260, alt: 20.0 },
  { name: "雷克雅未克", en: "Reykjavik", country: "冰岛", countryEn: "Iceland", py: "reykjavik", lat: 64.147, lon: -21.940, alt: 61.0 },

  // —— 非洲 ——
  { name: "开罗", en: "Cairo", country: "埃及", countryEn: "Egypt", py: "cairo", lat: 30.044, lon: 31.236, alt: 23.0 },
  { name: "亚历山大", en: "Alexandria", country: "埃及", countryEn: "Egypt", py: "alexandria", lat: 31.200, lon: 29.918, alt: 12.0 },
  { name: "拉各斯", en: "Lagos", country: "尼日利亚", countryEn: "Nigeria", py: "lagos", lat: 6.524, lon: 3.379, alt: 41.0 },
  { name: "阿布贾", en: "Abuja", country: "尼日利亚", countryEn: "Nigeria", py: "abuja", lat: 9.058, lon: 7.495, alt: 476.0 },
  { name: "内罗毕", en: "Nairobi", country: "肯尼亚", countryEn: "Kenya", py: "nairobi", lat: -1.286, lon: 36.817, alt: 1795.0 },
  { name: "亚的斯亚贝巴", en: "Addis Ababa", country: "埃塞俄比亚", countryEn: "Ethiopia", py: "addisababa", lat: 9.005, lon: 38.763, alt: 2355.0 },
  { name: "约翰内斯堡", en: "Johannesburg", country: "南非", countryEn: "South Africa", py: "johannesburg", lat: -26.204, lon: 28.047, alt: 1753.0 },
  { name: "开普敦", en: "Cape Town", country: "南非", countryEn: "South Africa", py: "capetown", lat: -33.925, lon: 18.424, alt: 25.0 },
  { name: "比勒陀利亚", en: "Pretoria", country: "南非", countryEn: "South Africa", py: "pretoria", lat: -25.746, lon: 28.188, alt: 1339.0 },
  { name: "卡萨布兰卡", en: "Casablanca", country: "摩洛哥", countryEn: "Morocco", py: "casablanca", lat: 33.573, lon: -7.590, alt: 50.0 },
  { name: "拉巴特", en: "Rabat", country: "摩洛哥", countryEn: "Morocco", py: "rabat", lat: 34.021, lon: -6.842, alt: 75.0 },
  { name: "阿尔及尔", en: "Algiers", country: "阿尔及利亚", countryEn: "Algeria", py: "algiers", lat: 36.754, lon: 3.060, alt: 25.0 },
  { name: "突尼斯", en: "Tunis", country: "突尼斯", countryEn: "Tunisia", py: "tunis", lat: 36.807, lon: 10.181, alt: 25.0 },
  { name: "达喀尔", en: "Dakar", country: "塞内加尔", countryEn: "Senegal", py: "dakar", lat: 14.717, lon: -17.467, alt: 22.0 },
  { name: "阿克拉", en: "Accra", country: "加纳", countryEn: "Ghana", py: "accra", lat: 5.604, lon: -0.187, alt: 61.0 },
  { name: "阿比让", en: "Abidjan", country: "科特迪瓦", countryEn: "Cote d'Ivoire", py: "abidjan", lat: 5.360, lon: -4.008, alt: 18.0 },
  { name: "金沙萨", en: "Kinshasa", country: "刚果（金）", countryEn: "DR Congo", py: "kinshasa", lat: -4.322, lon: 15.307, alt: 240.0 },
  { name: "罗安达", en: "Luanda", country: "安哥拉", countryEn: "Angola", py: "luanda", lat: -8.839, lon: 13.234, alt: 6.0 },
  { name: "达累斯萨拉姆", en: "Dar es Salaam", country: "坦桑尼亚", countryEn: "Tanzania", py: "daressalaam", lat: -6.792, lon: 39.208, alt: 24.0 },
  { name: "哈拉雷", en: "Harare", country: "津巴布韦", countryEn: "Zimbabwe", py: "harare", lat: -17.825, lon: 31.033, alt: 1490.0 },
  { name: "卢萨卡", en: "Lusaka", country: "赞比亚", countryEn: "Zambia", py: "lusaka", lat: -15.387, lon: 28.323, alt: 1279.0 },
  { name: "喀土穆", en: "Khartoum", country: "苏丹", countryEn: "Sudan", py: "khartoum", lat: 15.501, lon: 32.559, alt: 385.0 },
  { name: "马普托", en: "Maputo", country: "莫桑比克", countryEn: "Mozambique", py: "maputo", lat: -25.966, lon: 32.581, alt: 47.0 },
  { name: "安塔那那利佛", en: "Antananarivo", country: "马达加斯加", countryEn: "Madagascar", py: "antananarivo", lat: -18.879, lon: 47.508, alt: 1276.0 },

  // —— 北美 ——
  { name: "纽约", en: "New York", country: "美国", countryEn: "United States", py: "newyork", lat: 40.713, lon: -74.006, alt: 10.0 },
  { name: "华盛顿", en: "Washington", country: "美国", countryEn: "United States", py: "washington", lat: 38.907, lon: -77.037, alt: 15.0 },
  { name: "洛杉矶", en: "Los Angeles", country: "美国", countryEn: "United States", py: "losangeles", lat: 34.052, lon: -118.244, alt: 87.0 },
  { name: "旧金山", en: "San Francisco", country: "美国", countryEn: "United States", py: "sanfrancisco", lat: 37.775, lon: -122.419, alt: 16.0 },
  { name: "芝加哥", en: "Chicago", country: "美国", countryEn: "United States", py: "chicago", lat: 41.878, lon: -87.630, alt: 182.0 },
  { name: "休斯敦", en: "Houston", country: "美国", countryEn: "United States", py: "houston", lat: 29.760, lon: -95.370, alt: 13.0 },
  { name: "西雅图", en: "Seattle", country: "美国", countryEn: "United States", py: "seattle", lat: 47.606, lon: -122.332, alt: 53.0 },
  { name: "波士顿", en: "Boston", country: "美国", countryEn: "United States", py: "boston", lat: 42.360, lon: -71.058, alt: 43.0 },
  { name: "亚特兰大", en: "Atlanta", country: "美国", countryEn: "United States", py: "atlanta", lat: 33.749, lon: -84.388, alt: 320.0 },
  { name: "迈阿密", en: "Miami", country: "美国", countryEn: "United States", py: "miami", lat: 25.762, lon: -80.192, alt: 2.0 },
  { name: "丹佛", en: "Denver", country: "美国", countryEn: "United States", py: "denver", lat: 39.739, lon: -104.990, alt: 1609.0 },
  { name: "达拉斯", en: "Dallas", country: "美国", countryEn: "United States", py: "dallas", lat: 32.777, lon: -96.797, alt: 131.0 },
  { name: "拉斯维加斯", en: "Las Vegas", country: "美国", countryEn: "United States", py: "lasvegas", lat: 36.170, lon: -115.139, alt: 610.0 },
  { name: "卡纳维拉尔角", en: "Cape Canaveral", country: "美国", countryEn: "United States", py: "capecanaveral", lat: 28.392, lon: -80.605, alt: 3.0 },  // 航天发射场
  { name: "范登堡", en: "Vandenberg", country: "美国", countryEn: "United States", py: "vandenberg", lat: 34.742, lon: -120.573, alt: 112.0 },  // 航天发射场
  { name: "檀香山", en: "Honolulu", country: "美国", countryEn: "United States", py: "honolulu", lat: 21.307, lon: -157.858, alt: 6.0 },
  { name: "安克雷奇", en: "Anchorage", country: "美国", countryEn: "United States", py: "anchorage", lat: 61.218, lon: -149.900, alt: 31.0 },
  { name: "关岛", en: "Guam", country: "美国", countryEn: "United States", py: "guam", lat: 13.475, lon: 144.751, alt: 75.0 },
  { name: "多伦多", en: "Toronto", country: "加拿大", countryEn: "Canada", py: "toronto", lat: 43.653, lon: -79.383, alt: 76.0 },
  { name: "温哥华", en: "Vancouver", country: "加拿大", countryEn: "Canada", py: "vancouver", lat: 49.283, lon: -123.121, alt: 70.0 },
  { name: "蒙特利尔", en: "Montreal", country: "加拿大", countryEn: "Canada", py: "montreal", lat: 45.502, lon: -73.567, alt: 36.0 },
  { name: "渥太华", en: "Ottawa", country: "加拿大", countryEn: "Canada", py: "ottawa", lat: 45.421, lon: -75.697, alt: 70.0 },
  { name: "卡尔加里", en: "Calgary", country: "加拿大", countryEn: "Canada", py: "calgary", lat: 51.045, lon: -114.057, alt: 1045.0 },
  { name: "伊努维克", en: "Inuvik", country: "加拿大", countryEn: "Canada", py: "inuvik", lat: 68.361, lon: -133.730, alt: 15.0 },  // 极地地面站
  { name: "墨西哥城", en: "Mexico City", country: "墨西哥", countryEn: "Mexico", py: "mexicocity", lat: 19.433, lon: -99.133, alt: 2240.0 },
  { name: "哈瓦那", en: "Havana", country: "古巴", countryEn: "Cuba", py: "havana", lat: 23.113, lon: -82.366, alt: 59.0 },
  { name: "巴拿马城", en: "Panama City", country: "巴拿马", countryEn: "Panama", py: "panamacity", lat: 8.983, lon: -79.517, alt: 2.0 },

  // —— 南美 ——
  { name: "圣保罗", en: "Sao Paulo", country: "巴西", countryEn: "Brazil", py: "saopaulo", lat: -23.551, lon: -46.633, alt: 760.0 },
  { name: "里约热内卢", en: "Rio de Janeiro", country: "巴西", countryEn: "Brazil", py: "riodejaneiro", lat: -22.907, lon: -43.173, alt: 11.0 },
  { name: "巴西利亚", en: "Brasilia", country: "巴西", countryEn: "Brazil", py: "brasilia", lat: -15.794, lon: -47.883, alt: 1172.0 },
  { name: "库鲁", en: "Kourou", country: "法属圭亚那", countryEn: "French Guiana", py: "kourou", lat: 5.159, lon: -52.650, alt: 10.0 },  // 圭亚那航天中心
  { name: "布宜诺斯艾利斯", en: "Buenos Aires", country: "阿根廷", countryEn: "Argentina", py: "buenosaires", lat: -34.604, lon: -58.382, alt: 25.0 },
  { name: "圣地亚哥", en: "Santiago", country: "智利", countryEn: "Chile", py: "santiago", lat: -33.449, lon: -70.669, alt: 570.0 },
  { name: "利马", en: "Lima", country: "秘鲁", countryEn: "Peru", py: "lima", lat: -12.046, lon: -77.043, alt: 154.0 },
  { name: "波哥大", en: "Bogota", country: "哥伦比亚", countryEn: "Colombia", py: "bogota", lat: 4.711, lon: -74.072, alt: 2640.0 },
  { name: "加拉加斯", en: "Caracas", country: "委内瑞拉", countryEn: "Venezuela", py: "caracas", lat: 10.481, lon: -66.904, alt: 900.0 },
  { name: "基多", en: "Quito", country: "厄瓜多尔", countryEn: "Ecuador", py: "quito", lat: -0.180, lon: -78.468, alt: 2850.0 },
  { name: "蒙得维的亚", en: "Montevideo", country: "乌拉圭", countryEn: "Uruguay", py: "montevideo", lat: -34.901, lon: -56.164, alt: 43.0 },
  { name: "拉巴斯", en: "La Paz", country: "玻利维亚", countryEn: "Bolivia", py: "lapaz", lat: -16.500, lon: -68.150, alt: 3640.0 },

  // —— 大洋洲 ——
  { name: "悉尼", en: "Sydney", country: "澳大利亚", countryEn: "Australia", py: "sydney", lat: -33.869, lon: 151.209, alt: 58.0 },
  { name: "墨尔本", en: "Melbourne", country: "澳大利亚", countryEn: "Australia", py: "melbourne", lat: -37.814, lon: 144.963, alt: 31.0 },
  { name: "堪培拉", en: "Canberra", country: "澳大利亚", countryEn: "Australia", py: "canberra", lat: -35.281, lon: 149.129, alt: 578.0 },
  { name: "布里斯班", en: "Brisbane", country: "澳大利亚", countryEn: "Australia", py: "brisbane", lat: -27.469, lon: 153.026, alt: 27.0 },
  { name: "珀斯", en: "Perth", country: "澳大利亚", countryEn: "Australia", py: "perth", lat: -31.953, lon: 115.857, alt: 15.0 },
  { name: "阿德莱德", en: "Adelaide", country: "澳大利亚", countryEn: "Australia", py: "adelaide", lat: -34.929, lon: 138.601, alt: 50.0 },
  { name: "达尔文", en: "Darwin", country: "澳大利亚", countryEn: "Australia", py: "darwin", lat: -12.463, lon: 130.846, alt: 30.0 },
  { name: "奥克兰", en: "Auckland", country: "新西兰", countryEn: "New Zealand", py: "auckland", lat: -36.848, lon: 174.763, alt: 26.0 },
  { name: "惠灵顿", en: "Wellington", country: "新西兰", countryEn: "New Zealand", py: "wellington", lat: -41.286, lon: 174.776, alt: 31.0 },
  { name: "苏瓦", en: "Suva", country: "斐济", countryEn: "Fiji", py: "suva", lat: -18.141, lon: 178.442, alt: 15.0 },
  { name: "莫尔兹比港", en: "Port Moresby", country: "巴布亚新几内亚", countryEn: "Papua New Guinea", py: "portmoresby", lat: -9.478, lon: 147.150, alt: 40.0 },
  { name: "帕皮提", en: "Papeete", country: "法属波利尼西亚", countryEn: "French Polynesia", py: "papeete", lat: -17.535, lon: -149.570, alt: 10.0 },

  // —— 极地（高纬 / 极轨过顶站）——
  { name: "麦克默多站", en: "McMurdo Station", country: "南极洲", countryEn: "Antarctica", py: "mcmurdo", lat: -77.846, lon: 166.669, alt: 10.0 },
  { name: "中山站", en: "Zhongshan Station", country: "南极洲", countryEn: "Antarctica", py: "zhongshan", lat: -69.373, lon: 76.377, alt: 15.0 },
  { name: "长城站", en: "Great Wall Station", country: "南极洲", countryEn: "Antarctica", py: "greatwall", lat: -62.216, lon: -58.961, alt: 10.0 },
  { name: "昆仑站", en: "Kunlun Station", country: "南极洲", countryEn: "Antarctica", py: "kunlun", lat: -80.417, lon: 77.117, alt: 4087.0 }
  ];

/**
 * 获取所有城市列表
 */
function getAllCities() {
  return CITIES_DATA;
}

/**
 * 获取中国城市列表（前337个）
 */
function getChinaCities() {
  return CITIES_DATA.slice(0, CHINA_CITIES_COUNT);
}

/**
 * 获取国际城市列表
 */
function getInternationalCities() {
  return CITIES_DATA.slice(CHINA_CITIES_COUNT);
}

/**
 * 根据城市名称查找城市信息
 */
function getCityByName(name) {
  return CITIES_DATA.find(city => city.name === name);
}

// 缓存排序后的显示顺序城市列表
let _displayOrderCache = null;

/**
 * 获取按优先级排序的城市列表（用于下拉默认显示）
 */
function getDisplayOrderCities() {
  if (_displayOrderCache) return _displayOrderCache;
  const priorityMap = new Map();
  PRIORITY_ORDER.forEach((name, i) => priorityMap.set(name, i));
  const defaultPriority = PRIORITY_ORDER.length;
  _displayOrderCache = [...CITIES_DATA].sort((a, b) => {
    const pa = priorityMap.has(a.name) ? priorityMap.get(a.name) : defaultPriority;
    const pb = priorityMap.has(b.name) ? priorityMap.get(b.name) : defaultPriority;
    if (pa !== pb) return pa - pb;
    return 0;
  });
  return _displayOrderCache;
}

// 省份映射表（城市索引范围）
const PROVINCE_MAPPING = {
  '北京': { start: 0, count: 1, aliases: ['北京市'] },
  '上海': { start: 1, count: 1, aliases: ['上海市'] },
  '天津': { start: 2, count: 1, aliases: ['天津市'] },
  '重庆': { start: 3, count: 1, aliases: ['重庆市'] },
  '香港': { start: 4, count: 1, aliases: ['香港特别行政区'] },
  '澳门': { start: 5, count: 1, aliases: ['澳门特别行政区'] },
  '台湾': { start: 6, count: 1, aliases: ['台湾省'] },
  '黑龙江': { start: 7, count: 13, aliases: ['黑龙江省'] },
  '吉林': { start: 20, count: 9, aliases: ['吉林省'] },
  '辽宁': { start: 29, count: 14, aliases: ['辽宁省'] },
  '内蒙古': { start: 43, count: 12, aliases: ['内蒙古自治区'] },
  '河北': { start: 55, count: 11, aliases: ['河北省'] },
  '山西': { start: 66, count: 11, aliases: ['山西省'] },
  '山东': { start: 77, count: 16, aliases: ['山东省'] },
  '河南': { start: 93, count: 17, aliases: ['河南省'] },
  '江苏': { start: 110, count: 13, aliases: ['江苏省'] },
  '浙江': { start: 123, count: 11, aliases: ['浙江省'] },
  '安徽': { start: 134, count: 16, aliases: ['安徽省'] },
  '福建': { start: 150, count: 9, aliases: ['福建省'] },
  '江西': { start: 159, count: 11, aliases: ['江西省'] },
  '湖北': { start: 170, count: 17, aliases: ['湖北省'] },
  '湖南': { start: 187, count: 14, aliases: ['湖南省'] },
  '广东': { start: 201, count: 21, aliases: ['广东省'] },
  '广西': { start: 222, count: 14, aliases: ['广西壮族自治区', '广西自治区'] },
  '海南': { start: 236, count: 4, aliases: ['海南省'] },
  '四川': { start: 240, count: 21, aliases: ['四川省'] },
  '贵州': { start: 261, count: 9, aliases: ['贵州省'] },
  '云南': { start: 270, count: 16, aliases: ['云南省'] },
  '西藏': { start: 286, count: 7, aliases: ['西藏自治区'] },
  '陕西': { start: 293, count: 10, aliases: ['陕西省'] },
  '甘肃': { start: 303, count: 14, aliases: ['甘肃省'] },
  '青海': { start: 317, count: 9, aliases: ['青海省'] },
  '宁夏': { start: 326, count: 5, aliases: ['宁夏回族自治区', '宁夏自治区'] },
  '新疆': { start: 331, count: 14, aliases: ['新疆维吾尔自治区', '新疆自治区'] }
};

// 获取所有省份列表
const PROVINCES = Object.keys(PROVINCE_MAPPING);

/**
 * 根据关键词匹配省份
 * @param {string} keyword - 搜索关键词
 * @returns {string|null} - 匹配到的省份名称或null
 */
function matchProvince(keyword) {
  if (!keyword) return null;
  const trimmed = keyword.trim();
  
  // 精确匹配省份名
  if (PROVINCE_MAPPING[trimmed]) {
    return trimmed;
  }
  
  // 匹配别名
  for (const [province, info] of Object.entries(PROVINCE_MAPPING)) {
    if (info.aliases && info.aliases.includes(trimmed)) {
      return province;
    }
  }
  
  // 模糊匹配（省份名包含关键词或关键词包含省份名）
  for (const province of PROVINCES) {
    if (province.includes(trimmed) || trimmed.includes(province)) {
      return province;
    }
  }
  
  return null;
}

/**
 * 检测字符串是否为纯拼音/英文字母
 * @param {string} str - 要检测的字符串
 * @returns {boolean}
 */
function isPinyin(str) {
  return /^[a-zA-Z]+$/.test(str);
}

/**
 * 城市与关键词是否相符：中文名 / 英文名 / 国家名（中英）四路任一命中
 * @param {Object} city - 城市条目
 * @param {string} lower - 已 trim + toLowerCase 的关键词
 */
function cityMatches(city, lower) {
  if (String(city.name || '').toLowerCase().includes(lower)) return true;
  if (String(city.en || '').toLowerCase().includes(lower)) return true;
  if (String(city.country || '').toLowerCase().includes(lower)) return true;
  if (String(city.countryEn || '').toLowerCase().includes(lower)) return true;
  return false;
}

/**
 * 搜索城市（支持城市名、省份名和拼音首字母搜索；国际条目另支持英文名与国家名）
 * @param {string} keyword - 搜索关键词（城市名、省份名、拼音首字母、英文名或国家名）
 * @param {Object} options - 搜索选项
 * @param {boolean} options.includeProvince - 是否支持按省份搜索，默认true
 * @param {boolean} options.includePinyin - 是否支持拼音搜索，默认true
 * @param {boolean} options.fuzzy - 是否模糊匹配，默认true
 */
function searchCities(keyword, options = {}) {
  const { includeProvince = true, includePinyin = true, fuzzy = true } = options;
  
  if (!keyword || keyword.trim() === '') {
    return getDisplayOrderCities();
  }
  
  const trimmedKeyword = keyword.trim();
  const lowerKeyword = trimmedKeyword.toLowerCase();
  
  // 检测是否为拼音输入
  const isPinyinInput = isPinyin(trimmedKeyword);
  
  // 如果是拼音输入，优先按拼音搜索
  if (isPinyinInput && includePinyin) {
    const pyHit = (city) => {
      if (!city.py) return false;
      // 模糊匹配：拼音以关键词开头或包含关键词；精确匹配：全等
      return fuzzy ? (city.py.startsWith(lowerKeyword) || city.py.includes(lowerKeyword)) : city.py === lowerKeyword;
    };
    // 一串拉丁字母既可能是拼音首字母（bj）也可能是英文名 / 国家名（tokyo、japan）：两路都收
    const pinyinResults = CITIES_DATA.filter(city => pyHit(city) || (fuzzy && cityMatches(city, lowerKeyword)));

    if (pinyinResults.length > 0) {
      // 排序：拼音全等 → 拼音前缀 → 拼音包含 → 英文名/国家名命中（同档保持原序，sort 稳定）
      const rank = (c) => (c.py === lowerKeyword ? 0 : (c.py && c.py.startsWith(lowerKeyword)) ? 1 : pyHit(c) ? 2 : 3);
      return pinyinResults.sort((a, b) => rank(a) - rank(b));
    }
  }
  
  // 尝试按省份搜索（非拼音输入时）
  if (includeProvince && !isPinyinInput) {
    const matchedProvince = matchProvince(trimmedKeyword);
    if (matchedProvince) {
      return getCitiesByProvince(matchedProvince);
    }
  }
  
  // 按城市名搜索（国际条目连英文名与国家名一并比，「日本」/「Japan」即出该国全部城市）
  if (fuzzy) {
    // 模糊匹配
    return CITIES_DATA.filter(city => cityMatches(city, lowerKeyword));
  } else {
    // 精确匹配
    return CITIES_DATA.filter(city =>
      city.name.toLowerCase() === lowerKeyword || String(city.en || '').toLowerCase() === lowerKeyword
    );
  }
}

/**
 * 按拼音首字母搜索城市
 * @param {string} pinyin - 拼音首字母
 * @param {boolean} exact - 是否精确匹配，默认false
 */
function searchByPinyin(pinyin, exact = false) {
  if (!pinyin || pinyin.trim() === '') {
    return [];
  }
  
  const lowerPinyin = pinyin.trim().toLowerCase();
  
  return CITIES_DATA.filter(city => {
    if (!city.py) return false;
    if (exact) {
      return city.py === lowerPinyin;
    }
    return city.py.startsWith(lowerPinyin) || city.py.includes(lowerPinyin);
  });
}

/**
 * 按省份获取城市（返回某省所有地级市）
 * @param {string} province - 省份名称
 */
function getCitiesByProvince(province) {
  // 先尝试匹配省份
  const matchedProvince = matchProvince(province);
  const info = PROVINCE_MAPPING[matchedProvince || province];
  
  if (info) {
    return CITIES_DATA.slice(info.start, info.start + info.count);
  }
  return [];
}

/**
 * 获取所有省份列表
 */
function getAllProvinces() {
  return PROVINCES.slice();
}

/**
 * 获取城市统计信息
 */
function getCitiesStats() {
  return {
    total: CITIES_DATA.length,
    china: CHINA_CITIES_COUNT,
    international: CITIES_DATA.length - CHINA_CITIES_COUNT
  };
}

module.exports = {
  CITIES_DATA,
  CHINA_CITIES_COUNT,
  PRIORITY_ORDER,
  PROVINCE_MAPPING,
  PROVINCES,
  getAllCities,
  getDisplayOrderCities,
  getChinaCities,
  getInternationalCities,
  getCityByName,
  searchCities,
  searchByPinyin,
  isPinyin,
  getCitiesByProvince,
  getAllProvinces,
  matchProvince,
  getCitiesStats
};
