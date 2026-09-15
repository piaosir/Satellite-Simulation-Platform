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

  // ========== 国际知名城市 / 航天与地面站所在地 (582个) ==========
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
  { name: "横滨", en: "Yokohama", country: "日本", countryEn: "Japan", py: "yokohama", lat: 35.444, lon: 139.638, alt: 40.0 },
  { name: "仙台", en: "Sendai", country: "日本", countryEn: "Japan", py: "sendai", lat: 38.268, lon: 140.872, alt: 45.0 },
  { name: "广岛", en: "Hiroshima", country: "日本", countryEn: "Japan", py: "hiroshima", lat: 34.385, lon: 132.455, alt: 5.0 },
  { name: "新潟", en: "Niigata", country: "日本", countryEn: "Japan", py: "niigata", lat: 37.916, lon: 139.036, alt: 5.0 },
  { name: "鹿儿岛", en: "Kagoshima", country: "日本", countryEn: "Japan", py: "kagoshima", lat: 31.597, lon: 130.557, alt: 5.0 },
  { name: "那霸", en: "Naha", country: "日本", countryEn: "Japan", py: "naha", lat: 26.212, lon: 127.679, alt: 10.0 },
  { name: "筑波", en: "Tsukuba", country: "日本", countryEn: "Japan", py: "tsukuba", lat: 36.083, lon: 140.112, alt: 25.0 },  // JAXA 筑波宇宙中心
  { name: "内之浦", en: "Uchinoura", country: "日本", countryEn: "Japan", py: "uchinoura", lat: 31.251, lon: 131.079, alt: 220.0 },  // 航天发射场
  { name: "首尔", en: "Seoul", country: "韩国", countryEn: "South Korea", py: "seoul", lat: 37.567, lon: 126.978, alt: 38.0 },
  { name: "釜山", en: "Busan", country: "韩国", countryEn: "South Korea", py: "busan", lat: 35.180, lon: 129.075, alt: 10.0 },
  { name: "仁川", en: "Incheon", country: "韩国", countryEn: "South Korea", py: "incheon", lat: 37.456, lon: 126.705, alt: 20.0 },
  { name: "大田", en: "Daejeon", country: "韩国", countryEn: "South Korea", py: "daejeon", lat: 36.351, lon: 127.385, alt: 60.0 },  // KARI
  { name: "济州", en: "Jeju", country: "韩国", countryEn: "South Korea", py: "jeju", lat: 33.500, lon: 126.531, alt: 30.0 },
  { name: "高兴", en: "Goheung", country: "韩国", countryEn: "South Korea", py: "goheung", lat: 34.432, lon: 127.535, alt: 20.0 },  // 罗老宇航中心
  { name: "平壤", en: "Pyongyang", country: "朝鲜", countryEn: "North Korea", py: "pyongyang", lat: 39.019, lon: 125.738, alt: 27.0 },
  { name: "乌兰巴托", en: "Ulaanbaatar", country: "蒙古", countryEn: "Mongolia", py: "ulaanbaatar", lat: 47.886, lon: 106.906, alt: 1350.0 },

  // —— 东南亚 ——
  { name: "新加坡", en: "Singapore", country: "新加坡", countryEn: "Singapore", py: "singapore", lat: 1.352, lon: 103.820, alt: 15.0 },
  { name: "曼谷", en: "Bangkok", country: "泰国", countryEn: "Thailand", py: "bangkok", lat: 13.756, lon: 100.502, alt: 2.0 },
  { name: "清迈", en: "Chiang Mai", country: "泰国", countryEn: "Thailand", py: "chiangmai", lat: 18.788, lon: 98.985, alt: 310.0 },
  { name: "普吉", en: "Phuket", country: "泰国", countryEn: "Thailand", py: "phuket", lat: 7.881, lon: 98.392, alt: 10.0 },
  { name: "吉隆坡", en: "Kuala Lumpur", country: "马来西亚", countryEn: "Malaysia", py: "kualalumpur", lat: 3.139, lon: 101.687, alt: 56.0 },
  { name: "槟城", en: "Penang", country: "马来西亚", countryEn: "Malaysia", py: "penang", lat: 5.414, lon: 100.329, alt: 5.0 },
  { name: "新山", en: "Johor Bahru", country: "马来西亚", countryEn: "Malaysia", py: "johorbahru", lat: 1.464, lon: 103.762, alt: 30.0 },
  { name: "古晋", en: "Kuching", country: "马来西亚", countryEn: "Malaysia", py: "kuching", lat: 1.553, lon: 110.359, alt: 27.0 },
  { name: "亚庇", en: "Kota Kinabalu", country: "马来西亚", countryEn: "Malaysia", py: "kotakinabalu", lat: 5.980, lon: 116.073, alt: 10.0 },
  { name: "雅加达", en: "Jakarta", country: "印度尼西亚", countryEn: "Indonesia", py: "jakarta", lat: -6.208, lon: 106.846, alt: 8.0 },
  { name: "泗水", en: "Surabaya", country: "印度尼西亚", countryEn: "Indonesia", py: "surabaya", lat: -7.258, lon: 112.752, alt: 5.0 },
  { name: "棉兰", en: "Medan", country: "印度尼西亚", countryEn: "Indonesia", py: "medan", lat: 3.595, lon: 98.672, alt: 25.0 },
  { name: "万隆", en: "Bandung", country: "印度尼西亚", countryEn: "Indonesia", py: "bandung", lat: -6.917, lon: 107.619, alt: 768.0 },
  { name: "三宝垄", en: "Semarang", country: "印度尼西亚", countryEn: "Indonesia", py: "semarang", lat: -6.966, lon: 110.417, alt: 5.0 },
  { name: "巨港", en: "Palembang", country: "印度尼西亚", countryEn: "Indonesia", py: "palembang", lat: -2.976, lon: 104.775, alt: 8.0 },
  { name: "望加锡", en: "Makassar", country: "印度尼西亚", countryEn: "Indonesia", py: "makassar", lat: -5.147, lon: 119.432, alt: 5.0 },
  { name: "登巴萨", en: "Denpasar", country: "印度尼西亚", countryEn: "Indonesia", py: "denpasar", lat: -8.670, lon: 115.212, alt: 10.0 },
  { name: "巴厘巴板", en: "Balikpapan", country: "印度尼西亚", countryEn: "Indonesia", py: "balikpapan", lat: -1.265, lon: 116.831, alt: 10.0 },
  { name: "查亚普拉", en: "Jayapura", country: "印度尼西亚", countryEn: "Indonesia", py: "jayapura", lat: -2.533, lon: 140.717, alt: 10.0 },
  { name: "比亚克", en: "Biak", country: "印度尼西亚", countryEn: "Indonesia", py: "biak", lat: -1.190, lon: 136.108, alt: 15.0 },  // 地面站
  { name: "马尼拉", en: "Manila", country: "菲律宾", countryEn: "Philippines", py: "manila", lat: 14.599, lon: 120.984, alt: 16.0 },
  { name: "宿务", en: "Cebu", country: "菲律宾", countryEn: "Philippines", py: "cebu", lat: 10.316, lon: 123.891, alt: 10.0 },
  { name: "达沃", en: "Davao", country: "菲律宾", countryEn: "Philippines", py: "davao", lat: 7.191, lon: 125.455, alt: 20.0 },
  { name: "河内", en: "Hanoi", country: "越南", countryEn: "Vietnam", py: "hanoi", lat: 21.028, lon: 105.854, alt: 16.0 },
  { name: "胡志明市", en: "Ho Chi Minh City", country: "越南", countryEn: "Vietnam", py: "hochiminh", lat: 10.823, lon: 106.630, alt: 19.0 },
  { name: "岘港", en: "Da Nang", country: "越南", countryEn: "Vietnam", py: "danang", lat: 16.054, lon: 108.202, alt: 5.0 },
  { name: "海防", en: "Hai Phong", country: "越南", countryEn: "Vietnam", py: "haiphong", lat: 20.865, lon: 106.683, alt: 5.0 },
  { name: "芹苴", en: "Can Tho", country: "越南", countryEn: "Vietnam", py: "cantho", lat: 10.045, lon: 105.746, alt: 3.0 },
  { name: "金边", en: "Phnom Penh", country: "柬埔寨", countryEn: "Cambodia", py: "phnompenh", lat: 11.556, lon: 104.928, alt: 12.0 },
  { name: "西哈努克", en: "Sihanoukville", country: "柬埔寨", countryEn: "Cambodia", py: "sihanoukville", lat: 10.627, lon: 103.523, alt: 10.0 },
  { name: "万象", en: "Vientiane", country: "老挝", countryEn: "Laos", py: "vientiane", lat: 17.975, lon: 102.633, alt: 174.0 },
  { name: "琅勃拉邦", en: "Luang Prabang", country: "老挝", countryEn: "Laos", py: "luangprabang", lat: 19.885, lon: 102.135, alt: 300.0 },
  { name: "仰光", en: "Yangon", country: "缅甸", countryEn: "Myanmar", py: "yangon", lat: 16.866, lon: 96.195, alt: 15.0 },
  { name: "内比都", en: "Naypyidaw", country: "缅甸", countryEn: "Myanmar", py: "naypyidaw", lat: 19.745, lon: 96.129, alt: 115.0 },
  { name: "曼德勒", en: "Mandalay", country: "缅甸", countryEn: "Myanmar", py: "mandalay", lat: 21.975, lon: 96.083, alt: 76.0 },
  { name: "斯里巴加湾市", en: "Bandar Seri Begawan", country: "文莱", countryEn: "Brunei", py: "bandarseribegawan", lat: 4.903, lon: 114.939, alt: 2.0 },
  { name: "帝力", en: "Dili", country: "东帝汶", countryEn: "Timor-Leste", py: "dili", lat: -8.557, lon: 125.578, alt: 5.0 },

  // —— 南亚 ——
  { name: "新德里", en: "New Delhi", country: "印度", countryEn: "India", py: "newdelhi", lat: 28.614, lon: 77.209, alt: 216.0 },
  { name: "孟买", en: "Mumbai", country: "印度", countryEn: "India", py: "mumbai", lat: 19.076, lon: 72.878, alt: 14.0 },
  { name: "班加罗尔", en: "Bangalore", country: "印度", countryEn: "India", py: "bangalore", lat: 12.972, lon: 77.594, alt: 920.0 },
  { name: "加尔各答", en: "Kolkata", country: "印度", countryEn: "India", py: "kolkata", lat: 22.573, lon: 88.364, alt: 9.0 },
  { name: "钦奈", en: "Chennai", country: "印度", countryEn: "India", py: "chennai", lat: 13.083, lon: 80.270, alt: 6.0 },
  { name: "斯里赫里戈达", en: "Sriharikota", country: "印度", countryEn: "India", py: "sriharikota", lat: 13.720, lon: 80.230, alt: 10.0 },  // 航天发射场
  { name: "海得拉巴", en: "Hyderabad", country: "印度", countryEn: "India", py: "hyderabad", lat: 17.385, lon: 78.487, alt: 542.0 },
  { name: "艾哈迈达巴德", en: "Ahmedabad", country: "印度", countryEn: "India", py: "ahmedabad", lat: 23.023, lon: 72.571, alt: 53.0 },
  { name: "浦那", en: "Pune", country: "印度", countryEn: "India", py: "pune", lat: 18.520, lon: 73.856, alt: 560.0 },
  { name: "斋浦尔", en: "Jaipur", country: "印度", countryEn: "India", py: "jaipur", lat: 26.912, lon: 75.787, alt: 431.0 },
  { name: "勒克瑙", en: "Lucknow", country: "印度", countryEn: "India", py: "lucknow", lat: 26.847, lon: 80.947, alt: 123.0 },
  { name: "科钦", en: "Kochi", country: "印度", countryEn: "India", py: "kochi", lat: 9.931, lon: 76.267, alt: 5.0 },
  { name: "维沙卡帕特南", en: "Visakhapatnam", country: "印度", countryEn: "India", py: "visakhapatnam", lat: 17.687, lon: 83.219, alt: 10.0 },
  { name: "古瓦哈提", en: "Guwahati", country: "印度", countryEn: "India", py: "guwahati", lat: 26.144, lon: 91.736, alt: 55.0 },
  { name: "特里凡得琅", en: "Thiruvananthapuram", country: "印度", countryEn: "India", py: "thiruvananthapuram", lat: 8.524, lon: 76.937, alt: 10.0 },  // VSSC
  { name: "布莱尔港", en: "Port Blair", country: "印度", countryEn: "India", py: "portblair", lat: 11.667, lon: 92.736, alt: 10.0 },
  { name: "达卡", en: "Dhaka", country: "孟加拉国", countryEn: "Bangladesh", py: "dhaka", lat: 23.811, lon: 90.413, alt: 8.0 },
  { name: "吉大港", en: "Chittagong", country: "孟加拉国", countryEn: "Bangladesh", py: "chittagong", lat: 22.357, lon: 91.783, alt: 10.0 },
  { name: "卡拉奇", en: "Karachi", country: "巴基斯坦", countryEn: "Pakistan", py: "karachi", lat: 24.861, lon: 67.010, alt: 8.0 },
  { name: "伊斯兰堡", en: "Islamabad", country: "巴基斯坦", countryEn: "Pakistan", py: "islamabad", lat: 33.684, lon: 73.048, alt: 540.0 },
  { name: "拉合尔", en: "Lahore", country: "巴基斯坦", countryEn: "Pakistan", py: "lahore", lat: 31.550, lon: 74.344, alt: 217.0 },
  { name: "白沙瓦", en: "Peshawar", country: "巴基斯坦", countryEn: "Pakistan", py: "peshawar", lat: 34.015, lon: 71.525, alt: 359.0 },
  { name: "奎达", en: "Quetta", country: "巴基斯坦", countryEn: "Pakistan", py: "quetta", lat: 30.184, lon: 67.001, alt: 1680.0 },
  { name: "瓜达尔", en: "Gwadar", country: "巴基斯坦", countryEn: "Pakistan", py: "gwadar", lat: 25.126, lon: 62.323, alt: 10.0 },
  { name: "科伦坡", en: "Colombo", country: "斯里兰卡", countryEn: "Sri Lanka", py: "colombo", lat: 6.927, lon: 79.861, alt: 5.0 },
  { name: "汉班托塔", en: "Hambantota", country: "斯里兰卡", countryEn: "Sri Lanka", py: "hambantota", lat: 6.124, lon: 81.119, alt: 10.0 },
  { name: "加德满都", en: "Kathmandu", country: "尼泊尔", countryEn: "Nepal", py: "kathmandu", lat: 27.717, lon: 85.324, alt: 1400.0 },
  { name: "马累", en: "Male", country: "马尔代夫", countryEn: "Maldives", py: "male", lat: 4.175, lon: 73.509, alt: 2.0 },
  { name: "喀布尔", en: "Kabul", country: "阿富汗", countryEn: "Afghanistan", py: "kabul", lat: 34.526, lon: 69.178, alt: 1790.0 },
  { name: "廷布", en: "Thimphu", country: "不丹", countryEn: "Bhutan", py: "thimphu", lat: 27.472, lon: 89.639, alt: 2320.0 },

  // —— 中亚 ——
  { name: "阿拉木图", en: "Almaty", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "almaty", lat: 43.238, lon: 76.889, alt: 780.0 },
  { name: "阿斯塔纳", en: "Astana", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "astana", lat: 51.169, lon: 71.449, alt: 347.0 },
  { name: "拜科努尔", en: "Baikonur", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "baikonur", lat: 45.965, lon: 63.305, alt: 90.0 },  // 航天发射场
  { name: "卡拉干达", en: "Karaganda", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "karaganda", lat: 49.806, lon: 73.085, alt: 553.0 },
  { name: "希姆肯特", en: "Shymkent", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "shymkent", lat: 42.318, lon: 69.596, alt: 506.0 },
  { name: "阿克套", en: "Aktau", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "aktau", lat: 43.651, lon: 51.160, alt: -20.0 },
  { name: "阿特劳", en: "Atyrau", country: "哈萨克斯坦", countryEn: "Kazakhstan", py: "atyrau", lat: 47.107, lon: 51.918, alt: -20.0 },
  { name: "塔什干", en: "Tashkent", country: "乌兹别克斯坦", countryEn: "Uzbekistan", py: "tashkent", lat: 41.299, lon: 69.240, alt: 455.0 },
  { name: "撒马尔罕", en: "Samarkand", country: "乌兹别克斯坦", countryEn: "Uzbekistan", py: "samarkand", lat: 39.655, lon: 66.976, alt: 705.0 },
  { name: "比什凯克", en: "Bishkek", country: "吉尔吉斯斯坦", countryEn: "Kyrgyzstan", py: "bishkek", lat: 42.874, lon: 74.570, alt: 800.0 },
  { name: "杜尚别", en: "Dushanbe", country: "塔吉克斯坦", countryEn: "Tajikistan", py: "dushanbe", lat: 38.560, lon: 68.787, alt: 800.0 },
  { name: "阿什哈巴德", en: "Ashgabat", country: "土库曼斯坦", countryEn: "Turkmenistan", py: "ashgabat", lat: 37.960, lon: 58.326, alt: 219.0 },

  // —— 西亚 / 中东 ——
  { name: "迪拜", en: "Dubai", country: "阿联酋", countryEn: "United Arab Emirates", py: "dubai", lat: 25.205, lon: 55.271, alt: 5.0 },
  { name: "阿布扎比", en: "Abu Dhabi", country: "阿联酋", countryEn: "United Arab Emirates", py: "abudhabi", lat: 24.453, lon: 54.377, alt: 5.0 },
  { name: "多哈", en: "Doha", country: "卡塔尔", countryEn: "Qatar", py: "doha", lat: 25.286, lon: 51.535, alt: 10.0 },
  { name: "利雅得", en: "Riyadh", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "riyadh", lat: 24.713, lon: 46.675, alt: 612.0 },
  { name: "吉达", en: "Jeddah", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "jeddah", lat: 21.486, lon: 39.192, alt: 12.0 },
  { name: "达曼", en: "Dammam", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "dammam", lat: 26.434, lon: 50.103, alt: 10.0 },
  { name: "麦加", en: "Mecca", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "mecca", lat: 21.389, lon: 39.858, alt: 277.0 },
  { name: "麦地那", en: "Medina", country: "沙特阿拉伯", countryEn: "Saudi Arabia", py: "medina", lat: 24.470, lon: 39.612, alt: 620.0 },
  { name: "科威特城", en: "Kuwait City", country: "科威特", countryEn: "Kuwait", py: "kuwaitcity", lat: 29.376, lon: 47.978, alt: 5.0 },
  { name: "马斯喀特", en: "Muscat", country: "阿曼", countryEn: "Oman", py: "muscat", lat: 23.588, lon: 58.408, alt: 10.0 },
  { name: "塞拉莱", en: "Salalah", country: "阿曼", countryEn: "Oman", py: "salalah", lat: 17.015, lon: 54.092, alt: 20.0 },
  { name: "麦纳麦", en: "Manama", country: "巴林", countryEn: "Bahrain", py: "manama", lat: 26.229, lon: 50.586, alt: 5.0 },
  { name: "德黑兰", en: "Tehran", country: "伊朗", countryEn: "Iran", py: "tehran", lat: 35.689, lon: 51.389, alt: 1189.0 },
  { name: "马什哈德", en: "Mashhad", country: "伊朗", countryEn: "Iran", py: "mashhad", lat: 36.297, lon: 59.606, alt: 995.0 },
  { name: "伊斯法罕", en: "Isfahan", country: "伊朗", countryEn: "Iran", py: "isfahan", lat: 32.655, lon: 51.668, alt: 1575.0 },
  { name: "设拉子", en: "Shiraz", country: "伊朗", countryEn: "Iran", py: "shiraz", lat: 29.592, lon: 52.584, alt: 1500.0 },
  { name: "大不里士", en: "Tabriz", country: "伊朗", countryEn: "Iran", py: "tabriz", lat: 38.080, lon: 46.292, alt: 1350.0 },
  { name: "阿巴斯港", en: "Bandar Abbas", country: "伊朗", countryEn: "Iran", py: "bandarabbas", lat: 27.183, lon: 56.267, alt: 10.0 },
  { name: "巴格达", en: "Baghdad", country: "伊拉克", countryEn: "Iraq", py: "baghdad", lat: 33.315, lon: 44.366, alt: 34.0 },
  { name: "巴士拉", en: "Basra", country: "伊拉克", countryEn: "Iraq", py: "basra", lat: 30.508, lon: 47.783, alt: 5.0 },
  { name: "埃尔比勒", en: "Erbil", country: "伊拉克", countryEn: "Iraq", py: "erbil", lat: 36.191, lon: 44.009, alt: 420.0 },
  { name: "安曼", en: "Amman", country: "约旦", countryEn: "Jordan", py: "amman", lat: 31.956, lon: 35.945, alt: 780.0 },
  { name: "亚喀巴", en: "Aqaba", country: "约旦", countryEn: "Jordan", py: "aqaba", lat: 29.532, lon: 35.006, alt: 10.0 },
  { name: "贝鲁特", en: "Beirut", country: "黎巴嫩", countryEn: "Lebanon", py: "beirut", lat: 33.889, lon: 35.494, alt: 30.0 },
  { name: "大马士革", en: "Damascus", country: "叙利亚", countryEn: "Syria", py: "damascus", lat: 33.513, lon: 36.292, alt: 690.0 },
  { name: "阿勒颇", en: "Aleppo", country: "叙利亚", countryEn: "Syria", py: "aleppo", lat: 36.202, lon: 37.161, alt: 380.0 },
  { name: "特拉维夫", en: "Tel Aviv", country: "以色列", countryEn: "Israel", py: "telaviv", lat: 32.086, lon: 34.781, alt: 15.0 },
  { name: "伊斯坦布尔", en: "Istanbul", country: "土耳其", countryEn: "Turkey", py: "istanbul", lat: 41.008, lon: 28.978, alt: 39.0 },
  { name: "安卡拉", en: "Ankara", country: "土耳其", countryEn: "Turkey", py: "ankara", lat: 39.933, lon: 32.859, alt: 938.0 },
  { name: "伊兹密尔", en: "Izmir", country: "土耳其", countryEn: "Turkey", py: "izmir", lat: 38.423, lon: 27.143, alt: 25.0 },
  { name: "安塔利亚", en: "Antalya", country: "土耳其", countryEn: "Turkey", py: "antalya", lat: 36.897, lon: 30.713, alt: 30.0 },
  { name: "巴库", en: "Baku", country: "阿塞拜疆", countryEn: "Azerbaijan", py: "baku", lat: 40.409, lon: 49.867, alt: -20.0 },
  { name: "第比利斯", en: "Tbilisi", country: "格鲁吉亚", countryEn: "Georgia", py: "tbilisi", lat: 41.716, lon: 44.783, alt: 450.0 },
  { name: "埃里温", en: "Yerevan", country: "亚美尼亚", countryEn: "Armenia", py: "yerevan", lat: 40.183, lon: 44.513, alt: 990.0 },
  { name: "萨那", en: "Sanaa", country: "也门", countryEn: "Yemen", py: "sanaa", lat: 15.369, lon: 44.191, alt: 2250.0 },
  { name: "亚丁", en: "Aden", country: "也门", countryEn: "Yemen", py: "aden", lat: 12.786, lon: 45.037, alt: 10.0 },
  { name: "尼科西亚", en: "Nicosia", country: "塞浦路斯", countryEn: "Cyprus", py: "nicosia", lat: 35.185, lon: 33.382, alt: 150.0 },

  // —— 俄罗斯 / 东欧 ——
  { name: "莫斯科", en: "Moscow", country: "俄罗斯", countryEn: "Russia", py: "moscow", lat: 55.756, lon: 37.617, alt: 156.0 },
  { name: "圣彼得堡", en: "Saint Petersburg", country: "俄罗斯", countryEn: "Russia", py: "saintpetersburg", lat: 59.939, lon: 30.315, alt: 3.0 },
  { name: "新西伯利亚", en: "Novosibirsk", country: "俄罗斯", countryEn: "Russia", py: "novosibirsk", lat: 55.030, lon: 82.921, alt: 150.0 },
  { name: "叶卡捷琳堡", en: "Yekaterinburg", country: "俄罗斯", countryEn: "Russia", py: "yekaterinburg", lat: 56.839, lon: 60.605, alt: 255.0 },
  { name: "符拉迪沃斯托克", en: "Vladivostok", country: "俄罗斯", countryEn: "Russia", py: "vladivostok", lat: 43.116, lon: 131.882, alt: 30.0 },
  { name: "喀山", en: "Kazan", country: "俄罗斯", countryEn: "Russia", py: "kazan", lat: 55.796, lon: 49.106, alt: 60.0 },
  { name: "下诺夫哥罗德", en: "Nizhny Novgorod", country: "俄罗斯", countryEn: "Russia", py: "nizhnynovgorod", lat: 56.327, lon: 44.006, alt: 130.0 },
  { name: "萨马拉", en: "Samara", country: "俄罗斯", countryEn: "Russia", py: "samara", lat: 53.195, lon: 50.100, alt: 100.0 },
  { name: "乌法", en: "Ufa", country: "俄罗斯", countryEn: "Russia", py: "ufa", lat: 54.735, lon: 55.958, alt: 160.0 },
  { name: "彼尔姆", en: "Perm", country: "俄罗斯", countryEn: "Russia", py: "perm", lat: 58.010, lon: 56.229, alt: 150.0 },
  { name: "伏尔加格勒", en: "Volgograd", country: "俄罗斯", countryEn: "Russia", py: "volgograd", lat: 48.708, lon: 44.514, alt: 80.0 },
  { name: "顿河畔罗斯托夫", en: "Rostov-on-Don", country: "俄罗斯", countryEn: "Russia", py: "rostovondon", lat: 47.222, lon: 39.720, alt: 70.0 },
  { name: "克拉斯诺达尔", en: "Krasnodar", country: "俄罗斯", countryEn: "Russia", py: "krasnodar", lat: 45.035, lon: 38.975, alt: 30.0 },
  { name: "索契", en: "Sochi", country: "俄罗斯", countryEn: "Russia", py: "sochi", lat: 43.586, lon: 39.723, alt: 30.0 },
  { name: "加里宁格勒", en: "Kaliningrad", country: "俄罗斯", countryEn: "Russia", py: "kaliningrad", lat: 54.710, lon: 20.452, alt: 10.0 },
  { name: "摩尔曼斯克", en: "Murmansk", country: "俄罗斯", countryEn: "Russia", py: "murmansk", lat: 68.970, lon: 33.075, alt: 50.0 },
  { name: "阿尔汉格尔斯克", en: "Arkhangelsk", country: "俄罗斯", countryEn: "Russia", py: "arkhangelsk", lat: 64.540, lon: 40.518, alt: 10.0 },
  { name: "普列谢茨克", en: "Plesetsk", country: "俄罗斯", countryEn: "Russia", py: "plesetsk", lat: 62.926, lon: 40.577, alt: 100.0 },  // 航天发射场
  { name: "车里雅宾斯克", en: "Chelyabinsk", country: "俄罗斯", countryEn: "Russia", py: "chelyabinsk", lat: 55.160, lon: 61.403, alt: 230.0 },
  { name: "秋明", en: "Tyumen", country: "俄罗斯", countryEn: "Russia", py: "tyumen", lat: 57.153, lon: 65.534, alt: 100.0 },
  { name: "鄂木斯克", en: "Omsk", country: "俄罗斯", countryEn: "Russia", py: "omsk", lat: 54.989, lon: 73.369, alt: 90.0 },
  { name: "诺里尔斯克", en: "Norilsk", country: "俄罗斯", countryEn: "Russia", py: "norilsk", lat: 69.349, lon: 88.201, alt: 90.0 },
  { name: "克拉斯诺亚尔斯克", en: "Krasnoyarsk", country: "俄罗斯", countryEn: "Russia", py: "krasnoyarsk", lat: 56.015, lon: 92.893, alt: 150.0 },
  { name: "伊尔库茨克", en: "Irkutsk", country: "俄罗斯", countryEn: "Russia", py: "irkutsk", lat: 52.287, lon: 104.281, alt: 440.0 },
  { name: "乌兰乌德", en: "Ulan-Ude", country: "俄罗斯", countryEn: "Russia", py: "ulanude", lat: 51.834, lon: 107.584, alt: 500.0 },
  { name: "赤塔", en: "Chita", country: "俄罗斯", countryEn: "Russia", py: "chita", lat: 52.034, lon: 113.499, alt: 650.0 },
  { name: "雅库茨克", en: "Yakutsk", country: "俄罗斯", countryEn: "Russia", py: "yakutsk", lat: 62.028, lon: 129.732, alt: 100.0 },
  { name: "布拉戈维申斯克", en: "Blagoveshchensk", country: "俄罗斯", countryEn: "Russia", py: "blagoveshchensk", lat: 50.278, lon: 127.540, alt: 130.0 },
  { name: "东方发射场", en: "Vostochny", country: "俄罗斯", countryEn: "Russia", py: "vostochny", lat: 51.884, lon: 128.334, alt: 250.0 },  // 航天发射场
  { name: "哈巴罗夫斯克", en: "Khabarovsk", country: "俄罗斯", countryEn: "Russia", py: "khabarovsk", lat: 48.480, lon: 135.072, alt: 70.0 },
  { name: "南萨哈林斯克", en: "Yuzhno-Sakhalinsk", country: "俄罗斯", countryEn: "Russia", py: "yuzhnosakhalinsk", lat: 46.959, lon: 142.738, alt: 30.0 },
  { name: "马加丹", en: "Magadan", country: "俄罗斯", countryEn: "Russia", py: "magadan", lat: 59.561, lon: 150.808, alt: 50.0 },
  { name: "堪察加彼得罗巴甫洛夫斯克", en: "Petropavlovsk-Kamchatsky", country: "俄罗斯", countryEn: "Russia", py: "petropavlovskkamchatsky", lat: 53.037, lon: 158.655, alt: 40.0 },
  { name: "阿纳德尔", en: "Anadyr", country: "俄罗斯", countryEn: "Russia", py: "anadyr", lat: 64.734, lon: 177.497, alt: 30.0 },
  { name: "蒂克西", en: "Tiksi", country: "俄罗斯", countryEn: "Russia", py: "tiksi", lat: 71.643, lon: 128.868, alt: 10.0 },
  { name: "迪克森", en: "Dikson", country: "俄罗斯", countryEn: "Russia", py: "dikson", lat: 73.507, lon: 80.525, alt: 10.0 },
  { name: "基辅", en: "Kyiv", country: "乌克兰", countryEn: "Ukraine", py: "kyiv", lat: 50.450, lon: 30.523, alt: 179.0 },
  { name: "哈尔科夫", en: "Kharkiv", country: "乌克兰", countryEn: "Ukraine", py: "kharkiv", lat: 49.994, lon: 36.231, alt: 150.0 },
  { name: "敖德萨", en: "Odesa", country: "乌克兰", countryEn: "Ukraine", py: "odesa", lat: 46.483, lon: 30.723, alt: 40.0 },
  { name: "第聂伯罗", en: "Dnipro", country: "乌克兰", countryEn: "Ukraine", py: "dnipro", lat: 48.464, lon: 35.046, alt: 100.0 },
  { name: "利沃夫", en: "Lviv", country: "乌克兰", countryEn: "Ukraine", py: "lviv", lat: 49.840, lon: 24.030, alt: 296.0 },
  { name: "明斯克", en: "Minsk", country: "白俄罗斯", countryEn: "Belarus", py: "minsk", lat: 53.902, lon: 27.562, alt: 220.0 },
  { name: "基希讷乌", en: "Chisinau", country: "摩尔多瓦", countryEn: "Moldova", py: "chisinau", lat: 47.010, lon: 28.864, alt: 85.0 },

  // —— 欧洲 ——
  { name: "伦敦", en: "London", country: "英国", countryEn: "United Kingdom", py: "london", lat: 51.507, lon: -0.128, alt: 11.0 },
  { name: "曼彻斯特", en: "Manchester", country: "英国", countryEn: "United Kingdom", py: "manchester", lat: 53.480, lon: -2.243, alt: 38.0 },
  { name: "古恩希利", en: "Goonhilly", country: "英国", countryEn: "United Kingdom", py: "goonhilly", lat: 50.048, lon: -5.182, alt: 100.0 },  // 卫星地面站
  { name: "伯明翰", en: "Birmingham", country: "英国", countryEn: "United Kingdom", py: "birmingham", lat: 52.486, lon: -1.890, alt: 140.0 },
  { name: "爱丁堡", en: "Edinburgh", country: "英国", countryEn: "United Kingdom", py: "edinburgh", lat: 55.953, lon: -3.189, alt: 47.0 },
  { name: "格拉斯哥", en: "Glasgow", country: "英国", countryEn: "United Kingdom", py: "glasgow", lat: 55.864, lon: -4.252, alt: 20.0 },
  { name: "贝尔法斯特", en: "Belfast", country: "英国", countryEn: "United Kingdom", py: "belfast", lat: 54.597, lon: -5.930, alt: 5.0 },
  { name: "哈密尔顿（百慕大）", en: "Hamilton (Bermuda)", country: "英国", countryEn: "United Kingdom", py: "hamiltonbermuda", lat: 32.294, lon: -64.782, alt: 20.0 },
  { name: "阿森松岛", en: "Ascension Island", country: "英国", countryEn: "United Kingdom", py: "ascensionisland", lat: -7.947, lon: -14.356, alt: 80.0 },  // 地面站
  { name: "巴黎", en: "Paris", country: "法国", countryEn: "France", py: "paris", lat: 48.857, lon: 2.352, alt: 35.0 },
  { name: "图卢兹", en: "Toulouse", country: "法国", countryEn: "France", py: "toulouse", lat: 43.605, lon: 1.444, alt: 146.0 },  // CNES / 航天工业
  { name: "马赛", en: "Marseille", country: "法国", countryEn: "France", py: "marseille", lat: 43.296, lon: 5.370, alt: 10.0 },
  { name: "里昂", en: "Lyon", country: "法国", countryEn: "France", py: "lyon", lat: 45.764, lon: 4.836, alt: 170.0 },
  { name: "尼斯", en: "Nice", country: "法国", countryEn: "France", py: "nice", lat: 43.710, lon: 7.262, alt: 10.0 },
  { name: "波尔多", en: "Bordeaux", country: "法国", countryEn: "France", py: "bordeaux", lat: 44.838, lon: -0.579, alt: 10.0 },
  { name: "斯特拉斯堡", en: "Strasbourg", country: "法国", countryEn: "France", py: "strasbourg", lat: 48.573, lon: 7.752, alt: 140.0 },
  { name: "柏林", en: "Berlin", country: "德国", countryEn: "Germany", py: "berlin", lat: 52.520, lon: 13.405, alt: 34.0 },
  { name: "法兰克福", en: "Frankfurt", country: "德国", countryEn: "Germany", py: "frankfurt", lat: 50.110, lon: 8.682, alt: 112.0 },
  { name: "慕尼黑", en: "Munich", country: "德国", countryEn: "Germany", py: "munich", lat: 48.135, lon: 11.582, alt: 519.0 },
  { name: "达姆施塔特", en: "Darmstadt", country: "德国", countryEn: "Germany", py: "darmstadt", lat: 49.872, lon: 8.651, alt: 144.0 },  // ESOC 测控中心
  { name: "汉堡", en: "Hamburg", country: "德国", countryEn: "Germany", py: "hamburg", lat: 53.551, lon: 9.994, alt: 10.0 },
  { name: "科隆", en: "Cologne", country: "德国", countryEn: "Germany", py: "cologne", lat: 50.938, lon: 6.960, alt: 50.0 },
  { name: "杜塞尔多夫", en: "Dusseldorf", country: "德国", countryEn: "Germany", py: "dusseldorf", lat: 51.228, lon: 6.773, alt: 40.0 },
  { name: "斯图加特", en: "Stuttgart", country: "德国", countryEn: "Germany", py: "stuttgart", lat: 48.776, lon: 9.183, alt: 245.0 },
  { name: "莱比锡", en: "Leipzig", country: "德国", countryEn: "Germany", py: "leipzig", lat: 51.340, lon: 12.375, alt: 113.0 },
  { name: "不来梅", en: "Bremen", country: "德国", countryEn: "Germany", py: "bremen", lat: 53.079, lon: 8.802, alt: 10.0 },
  { name: "韦尔海姆", en: "Weilheim", country: "德国", countryEn: "Germany", py: "weilheim", lat: 47.881, lon: 11.084, alt: 590.0 },  // DLR 地面站
  { name: "赖斯廷", en: "Raisting", country: "德国", countryEn: "Germany", py: "raisting", lat: 47.902, lon: 11.113, alt: 560.0 },  // 地面站
  { name: "乌辛根", en: "Usingen", country: "德国", countryEn: "Germany", py: "usingen", lat: 50.335, lon: 8.537, alt: 380.0 },  // 地面站
  { name: "罗马", en: "Rome", country: "意大利", countryEn: "Italy", py: "rome", lat: 41.903, lon: 12.496, alt: 21.0 },
  { name: "米兰", en: "Milan", country: "意大利", countryEn: "Italy", py: "milan", lat: 45.464, lon: 9.190, alt: 120.0 },
  { name: "富奇诺", en: "Fucino", country: "意大利", countryEn: "Italy", py: "fucino", lat: 42.000, lon: 13.600, alt: 680.0 },  // 卫星地面站
  { name: "那不勒斯", en: "Naples", country: "意大利", countryEn: "Italy", py: "naples", lat: 40.852, lon: 14.268, alt: 17.0 },
  { name: "都灵", en: "Turin", country: "意大利", countryEn: "Italy", py: "turin", lat: 45.070, lon: 7.687, alt: 239.0 },
  { name: "威尼斯", en: "Venice", country: "意大利", countryEn: "Italy", py: "venice", lat: 45.438, lon: 12.327, alt: 1.0 },
  { name: "巴勒莫", en: "Palermo", country: "意大利", countryEn: "Italy", py: "palermo", lat: 38.116, lon: 13.361, alt: 14.0 },
  { name: "卡利亚里", en: "Cagliari", country: "意大利", countryEn: "Italy", py: "cagliari", lat: 39.223, lon: 9.121, alt: 4.0 },
  { name: "弗拉斯卡蒂", en: "Frascati", country: "意大利", countryEn: "Italy", py: "frascati", lat: 41.807, lon: 12.681, alt: 320.0 },  // ESA ESRIN
  { name: "马泰拉", en: "Matera", country: "意大利", countryEn: "Italy", py: "matera", lat: 40.667, lon: 16.604, alt: 400.0 },  // ASI 地面站
  { name: "马德里", en: "Madrid", country: "西班牙", countryEn: "Spain", py: "madrid", lat: 40.417, lon: -3.704, alt: 667.0 },
  { name: "巴塞罗那", en: "Barcelona", country: "西班牙", countryEn: "Spain", py: "barcelona", lat: 41.385, lon: 2.173, alt: 12.0 },
  { name: "瓦伦西亚", en: "Valencia", country: "西班牙", countryEn: "Spain", py: "valencia", lat: 39.470, lon: -0.377, alt: 15.0 },
  { name: "塞维利亚", en: "Seville", country: "西班牙", countryEn: "Spain", py: "seville", lat: 37.389, lon: -5.984, alt: 7.0 },
  { name: "拉斯帕尔马斯", en: "Las Palmas", country: "西班牙", countryEn: "Spain", py: "laspalmas", lat: 28.124, lon: -15.430, alt: 8.0 },
  { name: "马斯帕洛马斯", en: "Maspalomas", country: "西班牙", countryEn: "Spain", py: "maspalomas", lat: 27.763, lon: -15.634, alt: 160.0 },  // ESA 地面站
  { name: "塞夫雷罗斯", en: "Cebreros", country: "西班牙", countryEn: "Spain", py: "cebreros", lat: 40.453, lon: -4.368, alt: 800.0 },  // ESA 深空站
  { name: "罗夫莱多", en: "Robledo de Chavela", country: "西班牙", countryEn: "Spain", py: "robledodechavela", lat: 40.427, lon: -4.249, alt: 830.0 },  // NASA 深空网
  { name: "里斯本", en: "Lisbon", country: "葡萄牙", countryEn: "Portugal", py: "lisbon", lat: 38.722, lon: -9.139, alt: 100.0 },
  { name: "波尔图", en: "Porto", country: "葡萄牙", countryEn: "Portugal", py: "porto", lat: 41.150, lon: -8.611, alt: 100.0 },
  { name: "丰沙尔", en: "Funchal", country: "葡萄牙", countryEn: "Portugal", py: "funchal", lat: 32.650, lon: -16.908, alt: 25.0 },
  { name: "蓬塔德尔加达", en: "Ponta Delgada", country: "葡萄牙", countryEn: "Portugal", py: "pontadelgada", lat: 37.741, lon: -25.675, alt: 20.0 },
  { name: "圣玛丽亚（亚速尔）", en: "Santa Maria (Azores)", country: "葡萄牙", countryEn: "Portugal", py: "santamariaazores", lat: 36.997, lon: -25.136, alt: 280.0 },  // ESA 地面站
  { name: "阿姆斯特丹", en: "Amsterdam", country: "荷兰", countryEn: "Netherlands", py: "amsterdam", lat: 52.370, lon: 4.895, alt: 2.0 },
  { name: "鹿特丹", en: "Rotterdam", country: "荷兰", countryEn: "Netherlands", py: "rotterdam", lat: 51.924, lon: 4.478, alt: 0.0 },
  { name: "诺德韦克", en: "Noordwijk", country: "荷兰", countryEn: "Netherlands", py: "noordwijk", lat: 52.239, lon: 4.436, alt: 5.0 },  // ESA ESTEC
  { name: "布吕姆", en: "Burum", country: "荷兰", countryEn: "Netherlands", py: "burum", lat: 53.283, lon: 6.211, alt: 0.0 },  // 地面站
  { name: "布鲁塞尔", en: "Brussels", country: "比利时", countryEn: "Belgium", py: "brussels", lat: 50.851, lon: 4.352, alt: 56.0 },
  { name: "安特卫普", en: "Antwerp", country: "比利时", countryEn: "Belgium", py: "antwerp", lat: 51.220, lon: 4.402, alt: 8.0 },
  { name: "勒迪", en: "Redu", country: "比利时", countryEn: "Belgium", py: "redu", lat: 50.002, lon: 5.146, alt: 350.0 },  // ESA 地面站
  { name: "卢森堡", en: "Luxembourg", country: "卢森堡", countryEn: "Luxembourg", py: "luxembourg", lat: 49.611, lon: 6.130, alt: 305.0 },
  { name: "贝茨多夫", en: "Betzdorf", country: "卢森堡", countryEn: "Luxembourg", py: "betzdorf", lat: 49.683, lon: 6.348, alt: 320.0 },  // SES 地面站
  { name: "苏黎世", en: "Zurich", country: "瑞士", countryEn: "Switzerland", py: "zurich", lat: 47.377, lon: 8.542, alt: 408.0 },
  { name: "日内瓦", en: "Geneva", country: "瑞士", countryEn: "Switzerland", py: "geneva", lat: 46.204, lon: 6.143, alt: 375.0 },  // ITU 所在地
  { name: "伯尔尼", en: "Bern", country: "瑞士", countryEn: "Switzerland", py: "bern", lat: 46.948, lon: 7.447, alt: 540.0 },
  { name: "洛伊克", en: "Leuk", country: "瑞士", countryEn: "Switzerland", py: "leuk", lat: 46.318, lon: 7.634, alt: 950.0 },  // 地面站
  { name: "维也纳", en: "Vienna", country: "奥地利", countryEn: "Austria", py: "vienna", lat: 48.209, lon: 16.373, alt: 170.0 },
  { name: "格拉茨", en: "Graz", country: "奥地利", countryEn: "Austria", py: "graz", lat: 47.071, lon: 15.439, alt: 353.0 },
  { name: "布拉格", en: "Prague", country: "捷克", countryEn: "Czechia", py: "prague", lat: 50.076, lon: 14.438, alt: 200.0 },
  { name: "布尔诺", en: "Brno", country: "捷克", countryEn: "Czechia", py: "brno", lat: 49.195, lon: 16.608, alt: 237.0 },
  { name: "华沙", en: "Warsaw", country: "波兰", countryEn: "Poland", py: "warsaw", lat: 52.230, lon: 21.012, alt: 100.0 },
  { name: "克拉科夫", en: "Krakow", country: "波兰", countryEn: "Poland", py: "krakow", lat: 50.064, lon: 19.945, alt: 219.0 },
  { name: "格但斯克", en: "Gdansk", country: "波兰", countryEn: "Poland", py: "gdansk", lat: 54.352, lon: 18.646, alt: 7.0 },
  { name: "布达佩斯", en: "Budapest", country: "匈牙利", countryEn: "Hungary", py: "budapest", lat: 47.498, lon: 19.040, alt: 102.0 },
  { name: "布加勒斯特", en: "Bucharest", country: "罗马尼亚", countryEn: "Romania", py: "bucharest", lat: 44.427, lon: 26.103, alt: 70.0 },
  { name: "克卢日", en: "Cluj-Napoca", country: "罗马尼亚", countryEn: "Romania", py: "clujnapoca", lat: 46.771, lon: 23.624, alt: 340.0 },
  { name: "康斯坦察", en: "Constanta", country: "罗马尼亚", countryEn: "Romania", py: "constanta", lat: 44.160, lon: 28.635, alt: 25.0 },
  { name: "索菲亚", en: "Sofia", country: "保加利亚", countryEn: "Bulgaria", py: "sofia", lat: 42.698, lon: 23.322, alt: 550.0 },
  { name: "瓦尔纳", en: "Varna", country: "保加利亚", countryEn: "Bulgaria", py: "varna", lat: 43.205, lon: 27.911, alt: 30.0 },
  { name: "贝尔格莱德", en: "Belgrade", country: "塞尔维亚", countryEn: "Serbia", py: "belgrade", lat: 44.787, lon: 20.449, alt: 117.0 },
  { name: "雅典", en: "Athens", country: "希腊", countryEn: "Greece", py: "athens", lat: 37.984, lon: 23.728, alt: 70.0 },
  { name: "塞萨洛尼基", en: "Thessaloniki", country: "希腊", countryEn: "Greece", py: "thessaloniki", lat: 40.640, lon: 22.944, alt: 10.0 },
  { name: "伊拉克利翁", en: "Heraklion", country: "希腊", countryEn: "Greece", py: "heraklion", lat: 35.339, lon: 25.144, alt: 20.0 },
  { name: "斯德哥尔摩", en: "Stockholm", country: "瑞典", countryEn: "Sweden", py: "stockholm", lat: 59.329, lon: 18.069, alt: 28.0 },
  { name: "哥德堡", en: "Gothenburg", country: "瑞典", countryEn: "Sweden", py: "gothenburg", lat: 57.709, lon: 11.975, alt: 10.0 },
  { name: "马尔默", en: "Malmo", country: "瑞典", countryEn: "Sweden", py: "malmo", lat: 55.605, lon: 13.003, alt: 10.0 },
  { name: "基律纳", en: "Kiruna", country: "瑞典", countryEn: "Sweden", py: "kiruna", lat: 67.856, lon: 20.225, alt: 530.0 },  // Esrange / ESA 地面站
  { name: "奥斯陆", en: "Oslo", country: "挪威", countryEn: "Norway", py: "oslo", lat: 59.914, lon: 10.752, alt: 23.0 },
  { name: "朗伊尔城", en: "Longyearbyen", country: "挪威", countryEn: "Norway", py: "longyearbyen", lat: 78.223, lon: 15.648, alt: 30.0 },  // 斯瓦尔巴极地地面站
  { name: "卑尔根", en: "Bergen", country: "挪威", countryEn: "Norway", py: "bergen", lat: 60.392, lon: 5.324, alt: 10.0 },
  { name: "特隆赫姆", en: "Trondheim", country: "挪威", countryEn: "Norway", py: "trondheim", lat: 63.430, lon: 10.395, alt: 10.0 },
  { name: "特罗姆瑟", en: "Tromso", country: "挪威", countryEn: "Norway", py: "tromso", lat: 69.649, lon: 18.956, alt: 10.0 },  // KSAT 地面站
  { name: "安岛", en: "Andoya", country: "挪威", countryEn: "Norway", py: "andoya", lat: 69.294, lon: 16.021, alt: 10.0 },  // 航天发射场
  { name: "新奥勒松", en: "Ny-Alesund", country: "挪威", countryEn: "Norway", py: "nyalesund", lat: 78.923, lon: 11.923, alt: 10.0 },
  { name: "哥本哈根", en: "Copenhagen", country: "丹麦", countryEn: "Denmark", py: "copenhagen", lat: 55.676, lon: 12.568, alt: 14.0 },
  { name: "奥胡斯", en: "Aarhus", country: "丹麦", countryEn: "Denmark", py: "aarhus", lat: 56.162, lon: 10.204, alt: 10.0 },
  { name: "赫尔辛基", en: "Helsinki", country: "芬兰", countryEn: "Finland", py: "helsinki", lat: 60.170, lon: 24.938, alt: 26.0 },
  { name: "坦佩雷", en: "Tampere", country: "芬兰", countryEn: "Finland", py: "tampere", lat: 61.498, lon: 23.761, alt: 90.0 },
  { name: "罗瓦涅米", en: "Rovaniemi", country: "芬兰", countryEn: "Finland", py: "rovaniemi", lat: 66.503, lon: 25.729, alt: 100.0 },
  { name: "索丹屈莱", en: "Sodankyla", country: "芬兰", countryEn: "Finland", py: "sodankyla", lat: 67.368, lon: 26.633, alt: 180.0 },  // 地面站
  { name: "都柏林", en: "Dublin", country: "爱尔兰", countryEn: "Ireland", py: "dublin", lat: 53.350, lon: -6.260, alt: 20.0 },
  { name: "科克", en: "Cork", country: "爱尔兰", countryEn: "Ireland", py: "cork", lat: 51.898, lon: -8.476, alt: 10.0 },
  { name: "雷克雅未克", en: "Reykjavik", country: "冰岛", countryEn: "Iceland", py: "reykjavik", lat: 64.147, lon: -21.940, alt: 61.0 },
  { name: "维尔纽斯", en: "Vilnius", country: "立陶宛", countryEn: "Lithuania", py: "vilnius", lat: 54.687, lon: 25.280, alt: 112.0 },
  { name: "里加", en: "Riga", country: "拉脱维亚", countryEn: "Latvia", py: "riga", lat: 56.950, lon: 24.106, alt: 10.0 },
  { name: "塔林", en: "Tallinn", country: "爱沙尼亚", countryEn: "Estonia", py: "tallinn", lat: 59.437, lon: 24.754, alt: 10.0 },
  { name: "布拉迪斯拉发", en: "Bratislava", country: "斯洛伐克", countryEn: "Slovakia", py: "bratislava", lat: 48.149, lon: 17.107, alt: 134.0 },
  { name: "卢布尔雅那", en: "Ljubljana", country: "斯洛文尼亚", countryEn: "Slovenia", py: "ljubljana", lat: 46.056, lon: 14.506, alt: 298.0 },
  { name: "萨格勒布", en: "Zagreb", country: "克罗地亚", countryEn: "Croatia", py: "zagreb", lat: 45.815, lon: 15.982, alt: 158.0 },
  { name: "萨拉热窝", en: "Sarajevo", country: "波黑", countryEn: "Bosnia and Herzegovina", py: "sarajevo", lat: 43.856, lon: 18.413, alt: 518.0 },
  { name: "波德戈里察", en: "Podgorica", country: "黑山", countryEn: "Montenegro", py: "podgorica", lat: 42.441, lon: 19.263, alt: 44.0 },
  { name: "地拉那", en: "Tirana", country: "阿尔巴尼亚", countryEn: "Albania", py: "tirana", lat: 41.328, lon: 19.819, alt: 110.0 },
  { name: "斯科普里", en: "Skopje", country: "北马其顿", countryEn: "North Macedonia", py: "skopje", lat: 41.997, lon: 21.428, alt: 240.0 },
  { name: "瓦莱塔", en: "Valletta", country: "马耳他", countryEn: "Malta", py: "valletta", lat: 35.899, lon: 14.514, alt: 56.0 },
  { name: "摩纳哥", en: "Monaco", country: "摩纳哥", countryEn: "Monaco", py: "monaco", lat: 43.738, lon: 7.425, alt: 40.0 },
  { name: "安道尔城", en: "Andorra la Vella", country: "安道尔", countryEn: "Andorra", py: "andorralavella", lat: 42.507, lon: 1.522, alt: 1023.0 },
  { name: "瓦杜兹", en: "Vaduz", country: "列支敦士登", countryEn: "Liechtenstein", py: "vaduz", lat: 47.141, lon: 9.521, alt: 455.0 },
  { name: "圣马力诺", en: "San Marino", country: "圣马力诺", countryEn: "San Marino", py: "sanmarino", lat: 43.936, lon: 12.447, alt: 650.0 },

  // —— 非洲 ——
  { name: "开罗", en: "Cairo", country: "埃及", countryEn: "Egypt", py: "cairo", lat: 30.044, lon: 31.236, alt: 23.0 },
  { name: "亚历山大", en: "Alexandria", country: "埃及", countryEn: "Egypt", py: "alexandria", lat: 31.200, lon: 29.918, alt: 12.0 },
  { name: "阿斯旺", en: "Aswan", country: "埃及", countryEn: "Egypt", py: "aswan", lat: 24.089, lon: 32.899, alt: 100.0 },
  { name: "塞得港", en: "Port Said", country: "埃及", countryEn: "Egypt", py: "portsaid", lat: 31.257, lon: 32.284, alt: 3.0 },
  { name: "拉各斯", en: "Lagos", country: "尼日利亚", countryEn: "Nigeria", py: "lagos", lat: 6.524, lon: 3.379, alt: 41.0 },
  { name: "阿布贾", en: "Abuja", country: "尼日利亚", countryEn: "Nigeria", py: "abuja", lat: 9.058, lon: 7.495, alt: 476.0 },
  { name: "卡诺", en: "Kano", country: "尼日利亚", countryEn: "Nigeria", py: "kano", lat: 12.002, lon: 8.592, alt: 470.0 },
  { name: "伊巴丹", en: "Ibadan", country: "尼日利亚", countryEn: "Nigeria", py: "ibadan", lat: 7.378, lon: 3.947, alt: 230.0 },
  { name: "哈科特港", en: "Port Harcourt", country: "尼日利亚", countryEn: "Nigeria", py: "portharcourt", lat: 4.816, lon: 7.050, alt: 15.0 },
  { name: "内罗毕", en: "Nairobi", country: "肯尼亚", countryEn: "Kenya", py: "nairobi", lat: -1.286, lon: 36.817, alt: 1795.0 },
  { name: "蒙巴萨", en: "Mombasa", country: "肯尼亚", countryEn: "Kenya", py: "mombasa", lat: -4.043, lon: 39.668, alt: 50.0 },
  { name: "马林迪", en: "Malindi", country: "肯尼亚", countryEn: "Kenya", py: "malindi", lat: -3.218, lon: 40.117, alt: 10.0 },  // ASI 地面站
  { name: "亚的斯亚贝巴", en: "Addis Ababa", country: "埃塞俄比亚", countryEn: "Ethiopia", py: "addisababa", lat: 9.005, lon: 38.763, alt: 2355.0 },
  { name: "约翰内斯堡", en: "Johannesburg", country: "南非", countryEn: "South Africa", py: "johannesburg", lat: -26.204, lon: 28.047, alt: 1753.0 },
  { name: "开普敦", en: "Cape Town", country: "南非", countryEn: "South Africa", py: "capetown", lat: -33.925, lon: 18.424, alt: 25.0 },
  { name: "比勒陀利亚", en: "Pretoria", country: "南非", countryEn: "South Africa", py: "pretoria", lat: -25.746, lon: 28.188, alt: 1339.0 },
  { name: "德班", en: "Durban", country: "南非", countryEn: "South Africa", py: "durban", lat: -29.858, lon: 31.022, alt: 10.0 },
  { name: "伊丽莎白港", en: "Gqeberha (Port Elizabeth)", country: "南非", countryEn: "South Africa", py: "gqeberhaportelizabeth", lat: -33.958, lon: 25.600, alt: 10.0 },
  { name: "布隆方丹", en: "Bloemfontein", country: "南非", countryEn: "South Africa", py: "bloemfontein", lat: -29.117, lon: 26.216, alt: 1395.0 },
  { name: "哈特比斯胡克", en: "Hartebeesthoek", country: "南非", countryEn: "South Africa", py: "hartebeesthoek", lat: -25.887, lon: 27.707, alt: 1400.0 },  // 地面站
  { name: "卡萨布兰卡", en: "Casablanca", country: "摩洛哥", countryEn: "Morocco", py: "casablanca", lat: 33.573, lon: -7.590, alt: 50.0 },
  { name: "拉巴特", en: "Rabat", country: "摩洛哥", countryEn: "Morocco", py: "rabat", lat: 34.021, lon: -6.842, alt: 75.0 },
  { name: "马拉喀什", en: "Marrakech", country: "摩洛哥", countryEn: "Morocco", py: "marrakech", lat: 31.630, lon: -7.992, alt: 466.0 },
  { name: "丹吉尔", en: "Tangier", country: "摩洛哥", countryEn: "Morocco", py: "tangier", lat: 35.760, lon: -5.834, alt: 20.0 },
  { name: "阿尔及尔", en: "Algiers", country: "阿尔及利亚", countryEn: "Algeria", py: "algiers", lat: 36.754, lon: 3.060, alt: 25.0 },
  { name: "奥兰", en: "Oran", country: "阿尔及利亚", countryEn: "Algeria", py: "oran", lat: 35.698, lon: -0.636, alt: 10.0 },
  { name: "塔曼拉塞特", en: "Tamanrasset", country: "阿尔及利亚", countryEn: "Algeria", py: "tamanrasset", lat: 22.785, lon: 5.523, alt: 1320.0 },
  { name: "突尼斯", en: "Tunis", country: "突尼斯", countryEn: "Tunisia", py: "tunis", lat: 36.807, lon: 10.181, alt: 25.0 },
  { name: "达喀尔", en: "Dakar", country: "塞内加尔", countryEn: "Senegal", py: "dakar", lat: 14.717, lon: -17.467, alt: 22.0 },
  { name: "阿克拉", en: "Accra", country: "加纳", countryEn: "Ghana", py: "accra", lat: 5.604, lon: -0.187, alt: 61.0 },
  { name: "库马西", en: "Kumasi", country: "加纳", countryEn: "Ghana", py: "kumasi", lat: 6.688, lon: -1.624, alt: 250.0 },
  { name: "阿比让", en: "Abidjan", country: "科特迪瓦", countryEn: "Cote d'Ivoire", py: "abidjan", lat: 5.360, lon: -4.008, alt: 18.0 },
  { name: "亚穆苏克罗", en: "Yamoussoukro", country: "科特迪瓦", countryEn: "Cote d'Ivoire", py: "yamoussoukro", lat: 6.827, lon: -5.289, alt: 210.0 },
  { name: "金沙萨", en: "Kinshasa", country: "刚果（金）", countryEn: "DR Congo", py: "kinshasa", lat: -4.322, lon: 15.307, alt: 240.0 },
  { name: "卢本巴希", en: "Lubumbashi", country: "刚果（金）", countryEn: "DR Congo", py: "lubumbashi", lat: -11.660, lon: 27.479, alt: 1230.0 },
  { name: "基桑加尼", en: "Kisangani", country: "刚果（金）", countryEn: "DR Congo", py: "kisangani", lat: 0.517, lon: 25.204, alt: 400.0 },
  { name: "罗安达", en: "Luanda", country: "安哥拉", countryEn: "Angola", py: "luanda", lat: -8.839, lon: 13.234, alt: 6.0 },
  { name: "达累斯萨拉姆", en: "Dar es Salaam", country: "坦桑尼亚", countryEn: "Tanzania", py: "daressalaam", lat: -6.792, lon: 39.208, alt: 24.0 },
  { name: "多多马", en: "Dodoma", country: "坦桑尼亚", countryEn: "Tanzania", py: "dodoma", lat: -6.163, lon: 35.752, alt: 1120.0 },
  { name: "桑给巴尔", en: "Zanzibar", country: "坦桑尼亚", countryEn: "Tanzania", py: "zanzibar", lat: -6.165, lon: 39.199, alt: 15.0 },
  { name: "哈拉雷", en: "Harare", country: "津巴布韦", countryEn: "Zimbabwe", py: "harare", lat: -17.825, lon: 31.033, alt: 1490.0 },
  { name: "布拉瓦约", en: "Bulawayo", country: "津巴布韦", countryEn: "Zimbabwe", py: "bulawayo", lat: -20.150, lon: 28.583, alt: 1358.0 },
  { name: "卢萨卡", en: "Lusaka", country: "赞比亚", countryEn: "Zambia", py: "lusaka", lat: -15.387, lon: 28.323, alt: 1279.0 },
  { name: "喀土穆", en: "Khartoum", country: "苏丹", countryEn: "Sudan", py: "khartoum", lat: 15.501, lon: 32.559, alt: 385.0 },
  { name: "苏丹港", en: "Port Sudan", country: "苏丹", countryEn: "Sudan", py: "portsudan", lat: 19.616, lon: 37.216, alt: 10.0 },
  { name: "马普托", en: "Maputo", country: "莫桑比克", countryEn: "Mozambique", py: "maputo", lat: -25.966, lon: 32.581, alt: 47.0 },
  { name: "贝拉", en: "Beira", country: "莫桑比克", countryEn: "Mozambique", py: "beira", lat: -19.833, lon: 34.839, alt: 10.0 },
  { name: "楠普拉", en: "Nampula", country: "莫桑比克", countryEn: "Mozambique", py: "nampula", lat: -15.117, lon: 39.267, alt: 440.0 },
  { name: "安塔那那利佛", en: "Antananarivo", country: "马达加斯加", countryEn: "Madagascar", py: "antananarivo", lat: -18.879, lon: 47.508, alt: 1276.0 },
  { name: "图阿马西纳", en: "Toamasina", country: "马达加斯加", countryEn: "Madagascar", py: "toamasina", lat: -18.150, lon: 49.400, alt: 10.0 },
  { name: "的黎波里", en: "Tripoli", country: "利比亚", countryEn: "Libya", py: "tripoli", lat: 32.887, lon: 13.191, alt: 10.0 },
  { name: "班加西", en: "Benghazi", country: "利比亚", countryEn: "Libya", py: "benghazi", lat: 32.117, lon: 20.068, alt: 20.0 },
  { name: "努瓦克肖特", en: "Nouakchott", country: "毛里塔尼亚", countryEn: "Mauritania", py: "nouakchott", lat: 18.079, lon: -15.965, alt: 7.0 },
  { name: "巴马科", en: "Bamako", country: "马里", countryEn: "Mali", py: "bamako", lat: 12.639, lon: -8.003, alt: 350.0 },
  { name: "尼亚美", en: "Niamey", country: "尼日尔", countryEn: "Niger", py: "niamey", lat: 13.512, lon: 2.112, alt: 207.0 },
  { name: "恩贾梅纳", en: "N'Djamena", country: "乍得", countryEn: "Chad", py: "ndjamena", lat: 12.135, lon: 15.055, alt: 298.0 },
  { name: "瓦加杜古", en: "Ouagadougou", country: "布基纳法索", countryEn: "Burkina Faso", py: "ouagadougou", lat: 12.371, lon: -1.520, alt: 305.0 },
  { name: "班珠尔", en: "Banjul", country: "冈比亚", countryEn: "Gambia", py: "banjul", lat: 13.454, lon: -16.579, alt: 0.0 },
  { name: "比绍", en: "Bissau", country: "几内亚比绍", countryEn: "Guinea-Bissau", py: "bissau", lat: 11.863, lon: -15.598, alt: 30.0 },
  { name: "科纳克里", en: "Conakry", country: "几内亚", countryEn: "Guinea", py: "conakry", lat: 9.641, lon: -13.578, alt: 20.0 },
  { name: "弗里敦", en: "Freetown", country: "塞拉利昂", countryEn: "Sierra Leone", py: "freetown", lat: 8.484, lon: -13.229, alt: 30.0 },
  { name: "蒙罗维亚", en: "Monrovia", country: "利比里亚", countryEn: "Liberia", py: "monrovia", lat: 6.301, lon: -10.797, alt: 10.0 },
  { name: "洛美", en: "Lome", country: "多哥", countryEn: "Togo", py: "lome", lat: 6.131, lon: 1.222, alt: 25.0 },
  { name: "科托努", en: "Cotonou", country: "贝宁", countryEn: "Benin", py: "cotonou", lat: 6.367, lon: 2.418, alt: 8.0 },
  { name: "雅温得", en: "Yaounde", country: "喀麦隆", countryEn: "Cameroon", py: "yaounde", lat: 3.848, lon: 11.502, alt: 726.0 },
  { name: "杜阿拉", en: "Douala", country: "喀麦隆", countryEn: "Cameroon", py: "douala", lat: 4.051, lon: 9.768, alt: 13.0 },
  { name: "马拉博", en: "Malabo", country: "赤道几内亚", countryEn: "Equatorial Guinea", py: "malabo", lat: 3.750, lon: 8.783, alt: 30.0 },
  { name: "圣多美", en: "Sao Tome", country: "圣多美和普林西比", countryEn: "Sao Tome and Principe", py: "saotome", lat: 0.336, lon: 6.731, alt: 10.0 },
  { name: "利伯维尔", en: "Libreville", country: "加蓬", countryEn: "Gabon", py: "libreville", lat: 0.416, lon: 9.467, alt: 15.0 },
  { name: "布拉柴维尔", en: "Brazzaville", country: "刚果（布）", countryEn: "Republic of the Congo", py: "brazzaville", lat: -4.263, lon: 15.243, alt: 320.0 },
  { name: "黑角", en: "Pointe-Noire", country: "刚果（布）", countryEn: "Republic of the Congo", py: "pointenoire", lat: -4.795, lon: 11.851, alt: 10.0 },
  { name: "班吉", en: "Bangui", country: "中非", countryEn: "Central African Republic", py: "bangui", lat: 4.395, lon: 18.558, alt: 369.0 },
  { name: "朱巴", en: "Juba", country: "南苏丹", countryEn: "South Sudan", py: "juba", lat: 4.859, lon: 31.571, alt: 550.0 },
  { name: "阿斯马拉", en: "Asmara", country: "厄立特里亚", countryEn: "Eritrea", py: "asmara", lat: 15.322, lon: 38.925, alt: 2325.0 },
  { name: "吉布提", en: "Djibouti", country: "吉布提", countryEn: "Djibouti", py: "djibouti", lat: 11.589, lon: 43.145, alt: 10.0 },
  { name: "摩加迪沙", en: "Mogadishu", country: "索马里", countryEn: "Somalia", py: "mogadishu", lat: 2.047, lon: 45.318, alt: 10.0 },
  { name: "坎帕拉", en: "Kampala", country: "乌干达", countryEn: "Uganda", py: "kampala", lat: 0.347, lon: 32.582, alt: 1190.0 },
  { name: "基加利", en: "Kigali", country: "卢旺达", countryEn: "Rwanda", py: "kigali", lat: -1.944, lon: 30.062, alt: 1567.0 },
  { name: "布琼布拉", en: "Bujumbura", country: "布隆迪", countryEn: "Burundi", py: "bujumbura", lat: -3.383, lon: 29.362, alt: 774.0 },
  { name: "利隆圭", en: "Lilongwe", country: "马拉维", countryEn: "Malawi", py: "lilongwe", lat: -13.963, lon: 33.774, alt: 1050.0 },
  { name: "温得和克", en: "Windhoek", country: "纳米比亚", countryEn: "Namibia", py: "windhoek", lat: -22.559, lon: 17.083, alt: 1655.0 },
  { name: "沃尔维斯湾", en: "Walvis Bay", country: "纳米比亚", countryEn: "Namibia", py: "walvisbay", lat: -22.958, lon: 14.506, alt: 5.0 },
  { name: "哈博罗内", en: "Gaborone", country: "博茨瓦纳", countryEn: "Botswana", py: "gaborone", lat: -24.654, lon: 25.909, alt: 1010.0 },
  { name: "马塞卢", en: "Maseru", country: "莱索托", countryEn: "Lesotho", py: "maseru", lat: -29.316, lon: 27.483, alt: 1600.0 },
  { name: "姆巴巴内", en: "Mbabane", country: "斯威士兰", countryEn: "Eswatini", py: "mbabane", lat: -26.317, lon: 31.133, alt: 1150.0 },
  { name: "路易港", en: "Port Louis", country: "毛里求斯", countryEn: "Mauritius", py: "portlouis", lat: -20.162, lon: 57.499, alt: 10.0 },
  { name: "维多利亚（塞舌尔）", en: "Victoria (Seychelles)", country: "塞舌尔", countryEn: "Seychelles", py: "victoriaseychelles", lat: -4.620, lon: 55.452, alt: 10.0 },
  { name: "莫罗尼", en: "Moroni", country: "科摩罗", countryEn: "Comoros", py: "moroni", lat: -11.702, lon: 43.256, alt: 10.0 },
  { name: "圣但尼", en: "Saint-Denis", country: "留尼汪", countryEn: "Reunion", py: "saintdenis", lat: -20.879, lon: 55.448, alt: 20.0 },
  { name: "普拉亚", en: "Praia", country: "佛得角", countryEn: "Cape Verde", py: "praia", lat: 14.933, lon: -23.513, alt: 30.0 },

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
  { name: "菲尼克斯", en: "Phoenix", country: "美国", countryEn: "United States", py: "phoenix", lat: 33.448, lon: -112.074, alt: 331.0 },
  { name: "费城", en: "Philadelphia", country: "美国", countryEn: "United States", py: "philadelphia", lat: 39.953, lon: -75.165, alt: 12.0 },
  { name: "圣迭戈", en: "San Diego", country: "美国", countryEn: "United States", py: "sandiego", lat: 32.716, lon: -117.161, alt: 20.0 },
  { name: "圣何塞（加州）", en: "San Jose (California)", country: "美国", countryEn: "United States", py: "sanjosecalifornia", lat: 37.339, lon: -121.895, alt: 25.0 },
  { name: "圣安东尼奥", en: "San Antonio", country: "美国", countryEn: "United States", py: "sanantonio", lat: 29.424, lon: -98.494, alt: 198.0 },
  { name: "奥斯汀", en: "Austin", country: "美国", countryEn: "United States", py: "austin", lat: 30.267, lon: -97.743, alt: 150.0 },
  { name: "底特律", en: "Detroit", country: "美国", countryEn: "United States", py: "detroit", lat: 42.331, lon: -83.046, alt: 183.0 },
  { name: "明尼阿波利斯", en: "Minneapolis", country: "美国", countryEn: "United States", py: "minneapolis", lat: 44.978, lon: -93.265, alt: 264.0 },
  { name: "圣路易斯", en: "St. Louis", country: "美国", countryEn: "United States", py: "stlouis", lat: 38.627, lon: -90.199, alt: 142.0 },
  { name: "堪萨斯城", en: "Kansas City", country: "美国", countryEn: "United States", py: "kansascity", lat: 39.100, lon: -94.578, alt: 275.0 },
  { name: "纳什维尔", en: "Nashville", country: "美国", countryEn: "United States", py: "nashville", lat: 36.163, lon: -86.782, alt: 170.0 },
  { name: "夏洛特", en: "Charlotte", country: "美国", countryEn: "United States", py: "charlotte", lat: 35.227, lon: -80.843, alt: 230.0 },
  { name: "匹兹堡", en: "Pittsburgh", country: "美国", countryEn: "United States", py: "pittsburgh", lat: 40.441, lon: -79.996, alt: 230.0 },
  { name: "新奥尔良", en: "New Orleans", country: "美国", countryEn: "United States", py: "neworleans", lat: 29.951, lon: -90.072, alt: 2.0 },
  { name: "奥兰多", en: "Orlando", country: "美国", countryEn: "United States", py: "orlando", lat: 28.538, lon: -81.379, alt: 25.0 },
  { name: "坦帕", en: "Tampa", country: "美国", countryEn: "United States", py: "tampa", lat: 27.951, lon: -82.457, alt: 15.0 },
  { name: "盐湖城", en: "Salt Lake City", country: "美国", countryEn: "United States", py: "saltlakecity", lat: 40.761, lon: -111.891, alt: 1288.0 },
  { name: "波特兰", en: "Portland", country: "美国", countryEn: "United States", py: "portland", lat: 45.515, lon: -122.678, alt: 15.0 },
  { name: "阿尔伯克基", en: "Albuquerque", country: "美国", countryEn: "United States", py: "albuquerque", lat: 35.084, lon: -106.651, alt: 1619.0 },
  { name: "帕萨迪纳", en: "Pasadena", country: "美国", countryEn: "United States", py: "pasadena", lat: 34.148, lon: -118.144, alt: 260.0 },  // JPL
  { name: "亨茨维尔", en: "Huntsville", country: "美国", countryEn: "United States", py: "huntsville", lat: 34.730, lon: -86.586, alt: 190.0 },  // NASA MSFC
  { name: "戈尔德斯通", en: "Goldstone", country: "美国", countryEn: "United States", py: "goldstone", lat: 35.427, lon: -116.890, alt: 1000.0 },  // NASA 深空网
  { name: "白沙", en: "White Sands", country: "美国", countryEn: "United States", py: "whitesands", lat: 32.541, lon: -106.612, alt: 1470.0 },  // NASA 地面站
  { name: "沃洛普斯", en: "Wallops Island", country: "美国", countryEn: "United States", py: "wallopsisland", lat: 37.940, lon: -75.466, alt: 3.0 },  // 航天发射场
  { name: "博卡奇卡", en: "Boca Chica", country: "美国", countryEn: "United States", py: "bocachica", lat: 25.997, lon: -97.155, alt: 3.0 },  // SpaceX 星舰基地
  { name: "科迪亚克", en: "Kodiak", country: "美国", countryEn: "United States", py: "kodiak", lat: 57.790, lon: -152.407, alt: 30.0 },  // 航天发射场
  { name: "费尔班克斯", en: "Fairbanks", country: "美国", countryEn: "United States", py: "fairbanks", lat: 64.838, lon: -147.716, alt: 136.0 },  // 极轨地面站
  { name: "圣胡安", en: "San Juan", country: "美国", countryEn: "United States", py: "sanjuan", lat: 18.466, lon: -66.106, alt: 10.0 },  // 波多黎各
  { name: "塞班", en: "Saipan", country: "美国", countryEn: "United States", py: "saipan", lat: 15.178, lon: 145.751, alt: 20.0 },  // 北马里亚纳
  { name: "帕果帕果", en: "Pago Pago", country: "美国", countryEn: "United States", py: "pagopago", lat: -14.276, lon: -170.702, alt: 5.0 },  // 美属萨摩亚
  { name: "乌特恰维克", en: "Utqiagvik (Barrow)", country: "美国", countryEn: "United States", py: "utqiagvikbarrow", lat: 71.290, lon: -156.789, alt: 5.0 },
  { name: "多伦多", en: "Toronto", country: "加拿大", countryEn: "Canada", py: "toronto", lat: 43.653, lon: -79.383, alt: 76.0 },
  { name: "温哥华", en: "Vancouver", country: "加拿大", countryEn: "Canada", py: "vancouver", lat: 49.283, lon: -123.121, alt: 70.0 },
  { name: "蒙特利尔", en: "Montreal", country: "加拿大", countryEn: "Canada", py: "montreal", lat: 45.502, lon: -73.567, alt: 36.0 },
  { name: "渥太华", en: "Ottawa", country: "加拿大", countryEn: "Canada", py: "ottawa", lat: 45.421, lon: -75.697, alt: 70.0 },
  { name: "卡尔加里", en: "Calgary", country: "加拿大", countryEn: "Canada", py: "calgary", lat: 51.045, lon: -114.057, alt: 1045.0 },
  { name: "伊努维克", en: "Inuvik", country: "加拿大", countryEn: "Canada", py: "inuvik", lat: 68.361, lon: -133.730, alt: 15.0 },  // 极地地面站
  { name: "埃德蒙顿", en: "Edmonton", country: "加拿大", countryEn: "Canada", py: "edmonton", lat: 53.546, lon: -113.494, alt: 645.0 },
  { name: "温尼伯", en: "Winnipeg", country: "加拿大", countryEn: "Canada", py: "winnipeg", lat: 49.895, lon: -97.138, alt: 239.0 },
  { name: "魁北克城", en: "Quebec City", country: "加拿大", countryEn: "Canada", py: "quebeccity", lat: 46.813, lon: -71.208, alt: 98.0 },
  { name: "哈利法克斯", en: "Halifax", country: "加拿大", countryEn: "Canada", py: "halifax", lat: 44.649, lon: -63.575, alt: 30.0 },
  { name: "圣约翰斯", en: "St. John's", country: "加拿大", countryEn: "Canada", py: "stjohns", lat: 47.562, lon: -52.713, alt: 70.0 },
  { name: "加蒂诺", en: "Gatineau", country: "加拿大", countryEn: "Canada", py: "gatineau", lat: 45.477, lon: -75.701, alt: 60.0 },  // 地面站
  { name: "阿尔伯特王子城", en: "Prince Albert", country: "加拿大", countryEn: "Canada", py: "princealbert", lat: 53.203, lon: -105.753, alt: 430.0 },  // 地面站
  { name: "丘吉尔", en: "Churchill", country: "加拿大", countryEn: "Canada", py: "churchill", lat: 58.768, lon: -94.165, alt: 10.0 },
  { name: "黄刀", en: "Yellowknife", country: "加拿大", countryEn: "Canada", py: "yellowknife", lat: 62.454, lon: -114.372, alt: 206.0 },
  { name: "白马", en: "Whitehorse", country: "加拿大", countryEn: "Canada", py: "whitehorse", lat: 60.721, lon: -135.057, alt: 670.0 },
  { name: "伊魁特", en: "Iqaluit", country: "加拿大", countryEn: "Canada", py: "iqaluit", lat: 63.749, lon: -68.522, alt: 30.0 },
  { name: "阿勒特", en: "Alert", country: "加拿大", countryEn: "Canada", py: "alert", lat: 82.501, lon: -62.348, alt: 30.0 },
  { name: "墨西哥城", en: "Mexico City", country: "墨西哥", countryEn: "Mexico", py: "mexicocity", lat: 19.433, lon: -99.133, alt: 2240.0 },
  { name: "瓜达拉哈拉", en: "Guadalajara", country: "墨西哥", countryEn: "Mexico", py: "guadalajara", lat: 20.677, lon: -103.347, alt: 1566.0 },
  { name: "蒙特雷", en: "Monterrey", country: "墨西哥", countryEn: "Mexico", py: "monterrey", lat: 25.686, lon: -100.316, alt: 540.0 },
  { name: "蒂华纳", en: "Tijuana", country: "墨西哥", countryEn: "Mexico", py: "tijuana", lat: 32.514, lon: -117.038, alt: 20.0 },
  { name: "梅里达", en: "Merida", country: "墨西哥", countryEn: "Mexico", py: "merida", lat: 20.967, lon: -89.624, alt: 10.0 },
  { name: "坎昆", en: "Cancun", country: "墨西哥", countryEn: "Mexico", py: "cancun", lat: 21.161, lon: -86.851, alt: 10.0 },
  { name: "哈瓦那", en: "Havana", country: "古巴", countryEn: "Cuba", py: "havana", lat: 23.113, lon: -82.366, alt: 59.0 },
  { name: "圣地亚哥（古巴）", en: "Santiago de Cuba", country: "古巴", countryEn: "Cuba", py: "santiagodecuba", lat: 20.020, lon: -75.822, alt: 50.0 },
  { name: "巴拿马城", en: "Panama City", country: "巴拿马", countryEn: "Panama", py: "panamacity", lat: 8.983, lon: -79.517, alt: 2.0 },
  { name: "努克", en: "Nuuk", country: "格陵兰", countryEn: "Greenland", py: "nuuk", lat: 64.175, lon: -51.738, alt: 30.0 },
  { name: "皮图菲克", en: "Pituffik (Thule)", country: "格陵兰", countryEn: "Greenland", py: "pituffikthule", lat: 76.531, lon: -68.703, alt: 77.0 },  // 地面站
  { name: "危地马拉城", en: "Guatemala City", country: "危地马拉", countryEn: "Guatemala", py: "guatemalacity", lat: 14.634, lon: -90.507, alt: 1500.0 },
  { name: "贝尔莫潘", en: "Belmopan", country: "伯利兹", countryEn: "Belize", py: "belmopan", lat: 17.251, lon: -88.759, alt: 76.0 },
  { name: "特古西加尔巴", en: "Tegucigalpa", country: "洪都拉斯", countryEn: "Honduras", py: "tegucigalpa", lat: 14.072, lon: -87.192, alt: 990.0 },
  { name: "圣萨尔瓦多", en: "San Salvador", country: "萨尔瓦多", countryEn: "El Salvador", py: "sansalvador", lat: 13.699, lon: -89.191, alt: 658.0 },
  { name: "马那瓜", en: "Managua", country: "尼加拉瓜", countryEn: "Nicaragua", py: "managua", lat: 12.115, lon: -86.236, alt: 83.0 },
  { name: "圣何塞（哥斯达黎加）", en: "San Jose (Costa Rica)", country: "哥斯达黎加", countryEn: "Costa Rica", py: "sanjosecostarica", lat: 9.928, lon: -84.091, alt: 1170.0 },
  { name: "圣多明各", en: "Santo Domingo", country: "多米尼加", countryEn: "Dominican Republic", py: "santodomingo", lat: 18.486, lon: -69.931, alt: 14.0 },
  { name: "太子港", en: "Port-au-Prince", country: "海地", countryEn: "Haiti", py: "portauprince", lat: 18.594, lon: -72.307, alt: 40.0 },
  { name: "金斯敦", en: "Kingston", country: "牙买加", countryEn: "Jamaica", py: "kingston", lat: 17.997, lon: -76.793, alt: 10.0 },
  { name: "拿骚", en: "Nassau", country: "巴哈马", countryEn: "Bahamas", py: "nassau", lat: 25.048, lon: -77.355, alt: 5.0 },
  { name: "西班牙港", en: "Port of Spain", country: "特立尼达和多巴哥", countryEn: "Trinidad and Tobago", py: "portofspain", lat: 10.667, lon: -61.517, alt: 20.0 },
  { name: "布里奇敦", en: "Bridgetown", country: "巴巴多斯", countryEn: "Barbados", py: "bridgetown", lat: 13.098, lon: -59.617, alt: 10.0 },

  // —— 南美 ——
  { name: "圣保罗", en: "Sao Paulo", country: "巴西", countryEn: "Brazil", py: "saopaulo", lat: -23.551, lon: -46.633, alt: 760.0 },
  { name: "里约热内卢", en: "Rio de Janeiro", country: "巴西", countryEn: "Brazil", py: "riodejaneiro", lat: -22.907, lon: -43.173, alt: 11.0 },
  { name: "巴西利亚", en: "Brasilia", country: "巴西", countryEn: "Brazil", py: "brasilia", lat: -15.794, lon: -47.883, alt: 1172.0 },
  { name: "贝洛奥里藏特", en: "Belo Horizonte", country: "巴西", countryEn: "Brazil", py: "belohorizonte", lat: -19.917, lon: -43.935, alt: 852.0 },
  { name: "萨尔瓦多", en: "Salvador", country: "巴西", countryEn: "Brazil", py: "salvador", lat: -12.972, lon: -38.501, alt: 8.0 },
  { name: "福塔莱萨", en: "Fortaleza", country: "巴西", countryEn: "Brazil", py: "fortaleza", lat: -3.732, lon: -38.527, alt: 16.0 },
  { name: "累西腓", en: "Recife", country: "巴西", countryEn: "Brazil", py: "recife", lat: -8.054, lon: -34.881, alt: 4.0 },
  { name: "纳塔尔", en: "Natal", country: "巴西", countryEn: "Brazil", py: "natal", lat: -5.795, lon: -35.211, alt: 30.0 },
  { name: "贝伦", en: "Belem", country: "巴西", countryEn: "Brazil", py: "belem", lat: -1.456, lon: -48.490, alt: 10.0 },
  { name: "马瑙斯", en: "Manaus", country: "巴西", countryEn: "Brazil", py: "manaus", lat: -3.119, lon: -60.022, alt: 92.0 },
  { name: "库里蒂巴", en: "Curitiba", country: "巴西", countryEn: "Brazil", py: "curitiba", lat: -25.429, lon: -49.267, alt: 934.0 },
  { name: "阿雷格里港", en: "Porto Alegre", country: "巴西", countryEn: "Brazil", py: "portoalegre", lat: -30.035, lon: -51.218, alt: 10.0 },
  { name: "圣若泽杜斯坎波斯", en: "Sao Jose dos Campos", country: "巴西", countryEn: "Brazil", py: "saojosedoscampos", lat: -23.180, lon: -45.887, alt: 600.0 },  // INPE
  { name: "库亚巴", en: "Cuiaba", country: "巴西", countryEn: "Brazil", py: "cuiaba", lat: -15.601, lon: -56.098, alt: 165.0 },  // INPE 地面站
  { name: "阿尔坎塔拉", en: "Alcantara", country: "巴西", countryEn: "Brazil", py: "alcantara", lat: -2.373, lon: -44.396, alt: 30.0 },  // 航天发射场
  { name: "库鲁", en: "Kourou", country: "法属圭亚那", countryEn: "French Guiana", py: "kourou", lat: 5.159, lon: -52.650, alt: 10.0 },  // 圭亚那航天中心
  { name: "卡宴", en: "Cayenne", country: "法属圭亚那", countryEn: "French Guiana", py: "cayenne", lat: 4.922, lon: -52.313, alt: 5.0 },
  { name: "布宜诺斯艾利斯", en: "Buenos Aires", country: "阿根廷", countryEn: "Argentina", py: "buenosaires", lat: -34.604, lon: -58.382, alt: 25.0 },
  { name: "科尔多瓦", en: "Cordoba", country: "阿根廷", countryEn: "Argentina", py: "cordoba", lat: -31.420, lon: -64.188, alt: 390.0 },
  { name: "罗萨里奥", en: "Rosario", country: "阿根廷", countryEn: "Argentina", py: "rosario", lat: -32.945, lon: -60.639, alt: 25.0 },
  { name: "门多萨", en: "Mendoza", country: "阿根廷", countryEn: "Argentina", py: "mendoza", lat: -32.889, lon: -68.846, alt: 750.0 },
  { name: "马拉圭", en: "Malargue", country: "阿根廷", countryEn: "Argentina", py: "malargue", lat: -35.476, lon: -69.585, alt: 1550.0 },  // ESA 深空站
  { name: "乌斯怀亚", en: "Ushuaia", country: "阿根廷", countryEn: "Argentina", py: "ushuaia", lat: -54.802, lon: -68.303, alt: 25.0 },
  { name: "圣地亚哥", en: "Santiago", country: "智利", countryEn: "Chile", py: "santiago", lat: -33.449, lon: -70.669, alt: 570.0 },
  { name: "瓦尔帕莱索", en: "Valparaiso", country: "智利", countryEn: "Chile", py: "valparaiso", lat: -33.047, lon: -71.620, alt: 20.0 },
  { name: "康塞普西翁", en: "Concepcion", country: "智利", countryEn: "Chile", py: "concepcion", lat: -36.827, lon: -73.050, alt: 10.0 },
  { name: "安托法加斯塔", en: "Antofagasta", country: "智利", countryEn: "Chile", py: "antofagasta", lat: -23.652, lon: -70.398, alt: 40.0 },
  { name: "蓬塔阿雷纳斯", en: "Punta Arenas", country: "智利", countryEn: "Chile", py: "puntaarenas", lat: -53.163, lon: -70.908, alt: 30.0 },  // 极轨地面站
  { name: "复活节岛", en: "Easter Island", country: "智利", countryEn: "Chile", py: "easterisland", lat: -27.150, lon: -109.433, alt: 50.0 },
  { name: "利马", en: "Lima", country: "秘鲁", countryEn: "Peru", py: "lima", lat: -12.046, lon: -77.043, alt: 154.0 },
  { name: "库斯科", en: "Cusco", country: "秘鲁", countryEn: "Peru", py: "cusco", lat: -13.532, lon: -71.967, alt: 3400.0 },
  { name: "伊基托斯", en: "Iquitos", country: "秘鲁", countryEn: "Peru", py: "iquitos", lat: -3.749, lon: -73.254, alt: 105.0 },
  { name: "波哥大", en: "Bogota", country: "哥伦比亚", countryEn: "Colombia", py: "bogota", lat: 4.711, lon: -74.072, alt: 2640.0 },
  { name: "麦德林", en: "Medellin", country: "哥伦比亚", countryEn: "Colombia", py: "medellin", lat: 6.244, lon: -75.581, alt: 1495.0 },
  { name: "卡利", en: "Cali", country: "哥伦比亚", countryEn: "Colombia", py: "cali", lat: 3.452, lon: -76.532, alt: 1000.0 },
  { name: "巴兰基亚", en: "Barranquilla", country: "哥伦比亚", countryEn: "Colombia", py: "barranquilla", lat: 10.964, lon: -74.797, alt: 18.0 },
  { name: "加拉加斯", en: "Caracas", country: "委内瑞拉", countryEn: "Venezuela", py: "caracas", lat: 10.481, lon: -66.904, alt: 900.0 },
  { name: "马拉开波", en: "Maracaibo", country: "委内瑞拉", countryEn: "Venezuela", py: "maracaibo", lat: 10.654, lon: -71.640, alt: 6.0 },
  { name: "基多", en: "Quito", country: "厄瓜多尔", countryEn: "Ecuador", py: "quito", lat: -0.180, lon: -78.468, alt: 2850.0 },
  { name: "瓜亚基尔", en: "Guayaquil", country: "厄瓜多尔", countryEn: "Ecuador", py: "guayaquil", lat: -2.190, lon: -79.887, alt: 4.0 },
  { name: "加拉帕戈斯", en: "Galapagos", country: "厄瓜多尔", countryEn: "Ecuador", py: "galapagos", lat: -0.742, lon: -90.313, alt: 10.0 },
  { name: "蒙得维的亚", en: "Montevideo", country: "乌拉圭", countryEn: "Uruguay", py: "montevideo", lat: -34.901, lon: -56.164, alt: 43.0 },
  { name: "拉巴斯", en: "La Paz", country: "玻利维亚", countryEn: "Bolivia", py: "lapaz", lat: -16.500, lon: -68.150, alt: 3640.0 },
  { name: "圣克鲁斯", en: "Santa Cruz de la Sierra", country: "玻利维亚", countryEn: "Bolivia", py: "santacruzdelasierra", lat: -17.784, lon: -63.182, alt: 416.0 },
  { name: "亚松森", en: "Asuncion", country: "巴拉圭", countryEn: "Paraguay", py: "asuncion", lat: -25.264, lon: -57.576, alt: 43.0 },
  { name: "乔治敦", en: "Georgetown", country: "圭亚那", countryEn: "Guyana", py: "georgetown", lat: 6.801, lon: -58.155, alt: 0.0 },
  { name: "帕拉马里博", en: "Paramaribo", country: "苏里南", countryEn: "Suriname", py: "paramaribo", lat: 5.852, lon: -55.204, alt: 3.0 },

  // —— 大洋洲 ——
  { name: "悉尼", en: "Sydney", country: "澳大利亚", countryEn: "Australia", py: "sydney", lat: -33.869, lon: 151.209, alt: 58.0 },
  { name: "墨尔本", en: "Melbourne", country: "澳大利亚", countryEn: "Australia", py: "melbourne", lat: -37.814, lon: 144.963, alt: 31.0 },
  { name: "堪培拉", en: "Canberra", country: "澳大利亚", countryEn: "Australia", py: "canberra", lat: -35.281, lon: 149.129, alt: 578.0 },
  { name: "布里斯班", en: "Brisbane", country: "澳大利亚", countryEn: "Australia", py: "brisbane", lat: -27.469, lon: 153.026, alt: 27.0 },
  { name: "珀斯", en: "Perth", country: "澳大利亚", countryEn: "Australia", py: "perth", lat: -31.953, lon: 115.857, alt: 15.0 },
  { name: "阿德莱德", en: "Adelaide", country: "澳大利亚", countryEn: "Australia", py: "adelaide", lat: -34.929, lon: 138.601, alt: 50.0 },
  { name: "达尔文", en: "Darwin", country: "澳大利亚", countryEn: "Australia", py: "darwin", lat: -12.463, lon: 130.846, alt: 30.0 },
  { name: "霍巴特", en: "Hobart", country: "澳大利亚", countryEn: "Australia", py: "hobart", lat: -42.882, lon: 147.324, alt: 5.0 },
  { name: "凯恩斯", en: "Cairns", country: "澳大利亚", countryEn: "Australia", py: "cairns", lat: -16.920, lon: 145.771, alt: 5.0 },
  { name: "汤斯维尔", en: "Townsville", country: "澳大利亚", countryEn: "Australia", py: "townsville", lat: -19.259, lon: 146.817, alt: 10.0 },
  { name: "爱丽斯泉", en: "Alice Springs", country: "澳大利亚", countryEn: "Australia", py: "alicesprings", lat: -23.698, lon: 133.881, alt: 580.0 },
  { name: "卡那封", en: "Carnarvon", country: "澳大利亚", countryEn: "Australia", py: "carnarvon", lat: -24.884, lon: 113.661, alt: 5.0 },
  { name: "蒂德宾比拉", en: "Tidbinbilla", country: "澳大利亚", countryEn: "Australia", py: "tidbinbilla", lat: -35.401, lon: 148.982, alt: 660.0 },  // NASA 深空网
  { name: "新诺西亚", en: "New Norcia", country: "澳大利亚", countryEn: "Australia", py: "newnorcia", lat: -31.048, lon: 116.191, alt: 250.0 },  // ESA 深空站
  { name: "东加拉", en: "Dongara", country: "澳大利亚", countryEn: "Australia", py: "dongara", lat: -29.046, lon: 115.349, alt: 30.0 },  // 地面站
  { name: "伍默拉", en: "Woomera", country: "澳大利亚", countryEn: "Australia", py: "woomera", lat: -31.199, lon: 136.825, alt: 165.0 },  // 靶场
  { name: "圣诞岛", en: "Christmas Island", country: "澳大利亚", countryEn: "Australia", py: "christmasisland", lat: -10.421, lon: 105.679, alt: 260.0 },
  { name: "布鲁姆", en: "Broome", country: "澳大利亚", countryEn: "Australia", py: "broome", lat: -17.955, lon: 122.240, alt: 10.0 },
  { name: "奥克兰", en: "Auckland", country: "新西兰", countryEn: "New Zealand", py: "auckland", lat: -36.848, lon: 174.763, alt: 26.0 },
  { name: "惠灵顿", en: "Wellington", country: "新西兰", countryEn: "New Zealand", py: "wellington", lat: -41.286, lon: 174.776, alt: 31.0 },
  { name: "基督城", en: "Christchurch", country: "新西兰", countryEn: "New Zealand", py: "christchurch", lat: -43.531, lon: 172.637, alt: 20.0 },
  { name: "马希亚", en: "Mahia", country: "新西兰", countryEn: "New Zealand", py: "mahia", lat: -39.261, lon: 177.865, alt: 30.0 },  // 航天发射场
  { name: "苏瓦", en: "Suva", country: "斐济", countryEn: "Fiji", py: "suva", lat: -18.141, lon: 178.442, alt: 15.0 },
  { name: "楠迪", en: "Nadi", country: "斐济", countryEn: "Fiji", py: "nadi", lat: -17.775, lon: 177.416, alt: 20.0 },
  { name: "莫尔兹比港", en: "Port Moresby", country: "巴布亚新几内亚", countryEn: "Papua New Guinea", py: "portmoresby", lat: -9.478, lon: 147.150, alt: 40.0 },
  { name: "帕皮提", en: "Papeete", country: "法属波利尼西亚", countryEn: "French Polynesia", py: "papeete", lat: -17.535, lon: -149.570, alt: 10.0 },
  { name: "努美阿", en: "Noumea", country: "新喀里多尼亚", countryEn: "New Caledonia", py: "noumea", lat: -22.276, lon: 166.458, alt: 10.0 },
  { name: "霍尼亚拉", en: "Honiara", country: "所罗门群岛", countryEn: "Solomon Islands", py: "honiara", lat: -9.446, lon: 159.972, alt: 10.0 },
  { name: "维拉港", en: "Port Vila", country: "瓦努阿图", countryEn: "Vanuatu", py: "portvila", lat: -17.734, lon: 168.322, alt: 15.0 },
  { name: "阿皮亚", en: "Apia", country: "萨摩亚", countryEn: "Samoa", py: "apia", lat: -13.833, lon: -171.762, alt: 5.0 },
  { name: "努库阿洛法", en: "Nuku'alofa", country: "汤加", countryEn: "Tonga", py: "nukualofa", lat: -21.139, lon: -175.204, alt: 5.0 },
  { name: "塔拉瓦", en: "Tarawa", country: "基里巴斯", countryEn: "Kiribati", py: "tarawa", lat: 1.451, lon: 172.977, alt: 3.0 },
  { name: "马朱罗", en: "Majuro", country: "马绍尔群岛", countryEn: "Marshall Islands", py: "majuro", lat: 7.090, lon: 171.380, alt: 3.0 },
  { name: "夸贾林", en: "Kwajalein", country: "马绍尔群岛", countryEn: "Marshall Islands", py: "kwajalein", lat: 8.717, lon: 167.733, alt: 3.0 },  // 靶场
  { name: "帕利基尔", en: "Palikir", country: "密克罗尼西亚", countryEn: "Micronesia", py: "palikir", lat: 6.918, lon: 158.159, alt: 90.0 },
  { name: "科罗尔", en: "Koror", country: "帕劳", countryEn: "Palau", py: "koror", lat: 7.342, lon: 134.479, alt: 20.0 },
  { name: "富纳富提", en: "Funafuti", country: "图瓦卢", countryEn: "Tuvalu", py: "funafuti", lat: -8.521, lon: 179.196, alt: 2.0 },
  { name: "亚伦", en: "Yaren", country: "瑙鲁", countryEn: "Nauru", py: "yaren", lat: -0.547, lon: 166.921, alt: 20.0 },
  { name: "拉罗汤加", en: "Rarotonga", country: "库克群岛", countryEn: "Cook Islands", py: "rarotonga", lat: -21.207, lon: -159.776, alt: 10.0 },

  // —— 极地（高纬 / 极轨过顶站）——
  { name: "麦克默多站", en: "McMurdo Station", country: "南极洲", countryEn: "Antarctica", py: "mcmurdo", lat: -77.846, lon: 166.669, alt: 10.0 },
  { name: "中山站", en: "Zhongshan Station", country: "南极洲", countryEn: "Antarctica", py: "zhongshan", lat: -69.373, lon: 76.377, alt: 15.0 },
  { name: "长城站", en: "Great Wall Station", country: "南极洲", countryEn: "Antarctica", py: "greatwall", lat: -62.216, lon: -58.961, alt: 10.0 },
  { name: "昆仑站", en: "Kunlun Station", country: "南极洲", countryEn: "Antarctica", py: "kunlun", lat: -80.417, lon: 77.117, alt: 4087.0 },
  { name: "泰山站", en: "Taishan Station", country: "南极洲", countryEn: "Antarctica", py: "taishanstation", lat: -73.863, lon: 76.975, alt: 2621.0 },
  { name: "秦岭站", en: "Qinling Station", country: "南极洲", countryEn: "Antarctica", py: "qinlingstation", lat: -74.933, lon: 163.700, alt: 20.0 },
  { name: "阿蒙森-斯科特站", en: "Amundsen-Scott South Pole Station", country: "南极洲", countryEn: "Antarctica", py: "amundsenscottsouthpolestation", lat: -90.000, lon: 0.000, alt: 2835.0 },
  { name: "特罗尔站", en: "Troll Station", country: "南极洲", countryEn: "Antarctica", py: "trollstation", lat: -72.012, lon: 2.535, alt: 1275.0 },  // KSAT 地面站
  { name: "凯西站", en: "Casey Station", country: "南极洲", countryEn: "Antarctica", py: "caseystation", lat: -66.283, lon: 110.528, alt: 40.0 },
  { name: "戴维斯站", en: "Davis Station", country: "南极洲", countryEn: "Antarctica", py: "davisstation", lat: -68.577, lon: 77.969, alt: 15.0 },
  { name: "罗瑟拉站", en: "Rothera Station", country: "南极洲", countryEn: "Antarctica", py: "rotherastation", lat: -67.568, lon: -68.127, alt: 16.0 },
  { name: "迪蒙·迪维尔站", en: "Dumont d'Urville Station", country: "南极洲", countryEn: "Antarctica", py: "dumontdurvillestation", lat: -66.663, lon: 140.001, alt: 40.0 },
  { name: "昭和站", en: "Syowa Station", country: "南极洲", countryEn: "Antarctica", py: "syowastation", lat: -69.004, lon: 39.581, alt: 29.0 },
  { name: "东方站", en: "Vostok Station", country: "南极洲", countryEn: "Antarctica", py: "vostokstation", lat: -78.464, lon: 106.837, alt: 3488.0 },
  { name: "康宏站", en: "Concordia Station", country: "南极洲", countryEn: "Antarctica", py: "concordiastation", lat: -75.100, lon: 123.333, alt: 3233.0 },
  { name: "新拉扎列夫站", en: "Novolazarevskaya Station", country: "南极洲", countryEn: "Antarctica", py: "novolazarevskayastation", lat: -70.777, lon: 11.833, alt: 100.0 },
  { name: "马兰比奥站", en: "Marambio Station", country: "南极洲", countryEn: "Antarctica", py: "marambiostation", lat: -64.241, lon: -56.627, alt: 200.0 },
  { name: "帕尔默站", en: "Palmer Station", country: "南极洲", countryEn: "Antarctica", py: "palmerstation", lat: -64.774, lon: -64.053, alt: 10.0 }
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

// 省份英文名（分层城市库的组名；国际组的国家名自带 countryEn）
const PROVINCE_EN = {
  '北京': 'Beijing', '上海': 'Shanghai', '天津': 'Tianjin', '重庆': 'Chongqing', '香港': 'Hong Kong', '澳门': 'Macao', '台湾': 'Taiwan',
  '黑龙江': 'Heilongjiang', '吉林': 'Jilin', '辽宁': 'Liaoning', '内蒙古': 'Inner Mongolia', '河北': 'Hebei', '山西': 'Shanxi', '山东': 'Shandong',
  '河南': 'Henan', '江苏': 'Jiangsu', '浙江': 'Zhejiang', '安徽': 'Anhui', '福建': 'Fujian', '江西': 'Jiangxi', '湖北': 'Hubei', '湖南': 'Hunan',
  '广东': 'Guangdong', '广西': 'Guangxi', '海南': 'Hainan', '四川': 'Sichuan', '贵州': 'Guizhou', '云南': 'Yunnan', '西藏': 'Tibet',
  '陕西': 'Shaanxi', '甘肃': 'Gansu', '青海': 'Qinghai', '宁夏': 'Ningxia', '新疆': 'Xinjiang', '其他': 'Other'
};
// PROVINCE_MAPPING 是按下标区间切省的，区间之外的国内条目（信关站 / 航天城市 / 极点 / 口岸 / 县级市）
// 在这里逐条给省。新加国内条目若不在任何区间里又没写进来 → 落「其他」组，不会丢。
const EXTRA_PROVINCE = {
  '怀来': '河北', '西昌': '四川', '文昌': '海南', '敦煌': '甘肃',
  '漠河': '黑龙江', '抚远': '黑龙江', '乌恰': '新疆', '曾母暗沙': '海南',
  '东风': '内蒙古', '密云': '北京', '佘山': '上海',
  '义乌': '浙江', '昆山': '江苏', '库尔勒': '新疆', '满洲里': '内蒙古', '二连浩特': '内蒙古', '瑞丽': '云南', '绥芬河': '黑龙江', '东兴': '广西'
};
function provinceOfIndex(i) {
  for (const p of PROVINCES) { const m = PROVINCE_MAPPING[p]; if (i >= m.start && i < m.start + m.count) return p; }
  return EXTRA_PROVINCE[CITIES_DATA[i].name] || '其他';
}

/**
 * 分层城市库（性能指标表 / 气象指标表「典型城市」选点用）：
 *   china — 按省份分组，组序 = PROVINCE_MAPPING 的键序（直辖市 / 港澳台 / 各省），组内按数据原序；
 *   intl  — 按国家分组，组序 = 数据里首次出现的顺序（东亚 → 东南亚 → … → 大洋洲）。
 * 条目原样带 name / en / py / lat / lon / alt（国际条目另带 country / countryEn）。
 */
let _groupedCache = null;
function listCitiesGrouped() {
  if (_groupedCache) return _groupedCache;
  const chinaMap = new Map();
  for (let i = 0; i < CHINA_CITIES_COUNT; i++) {
    const p = provinceOfIndex(i);
    if (!chinaMap.has(p)) chinaMap.set(p, []);
    chinaMap.get(p).push(CITIES_DATA[i]);
  }
  const order = PROVINCES.slice();
  for (const p of chinaMap.keys()) if (!order.includes(p)) order.push(p);
  const china = order.filter((p) => chinaMap.has(p)).map((p) => ({ province: p, provinceEn: PROVINCE_EN[p] || p, cities: chinaMap.get(p) }));
  const intlMap = new Map();
  for (let i = CHINA_CITIES_COUNT; i < CITIES_DATA.length; i++) {
    const c = CITIES_DATA[i];
    const k = c.country || '其他';
    if (!intlMap.has(k)) intlMap.set(k, { country: k, countryEn: c.countryEn || k, cities: [] });
    intlMap.get(k).cities.push(c);
  }
  _groupedCache = { china, intl: [...intlMap.values()] };
  return _groupedCache;
}

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
  listCitiesGrouped,
  getCityByName,
  searchCities,
  searchByPinyin,
  isPinyin,
  getCitiesByProvince,
  getAllProvinces,
  matchProvince,
  getCitiesStats
};
