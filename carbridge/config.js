// CarBridge v6.25.1 — 配置常量 (MIT License)
// ==============================
// 所有环境相关参数集中管理，方便部署迁移

const path = require('path');

module.exports = {
  VERSION: '6.25.1',

  // --- 服务 ---
  PORT: 8899,

  // --- API Key（支持环境变量覆盖） ---
  // export CARBRIDGE_PUSH_KEY=***
  PUSH_KEY: process.env.CARBRIDGE_PUSH_KEY || 'YOUR_CARBRIDGE_API_KEY',
  // export CARBRIDGE_SCT_KEY=***
  SCT_KEY: process.env.CARBRIDGE_SCT_KEY || 'YOUR_SERVERCHAN_KEY_IF_USED',

  // --- 目录 (开源版使用相对路径, 部署时可通过环境变量覆盖) ---
  DATA_DIR: process.env.CARBRIDGE_DATA_DIR || path.join(__dirname, 'data'),
  LOG_DIR: process.env.CARBRIDGE_LOG_DIR || path.join(__dirname, 'logs'),
  DIAG_DIR: path.join(process.env.CARBRIDGE_LOG_DIR || path.join(__dirname, 'logs'), 'diag'),

  // --- 车况参数 ---
  TANK_CAPACITY: 50,               // 油箱容量 (升)
  DISPLACEMENT_L: 1.6,             // 发动机排量 (升)
  FUEL_CALIB_COEFF: 0.0045,        // 油耗估算系数 (load×rpm×排量×系数 → L/h)

  // --- 仪表盘布局 (云端下发车机渲染) ---
  // 改布局不用编译 APK, 改这里 PM2 restart 即可
  DASHBOARD: {
    theme: { bg: '#1A1C1E', accent: '#4FC3F7', text: '#E0E0E0', dim: '#546E7A',
             green: '#81C784', yellow: '#FFD600', blue: '#64B5F6', purple: '#E1BEE7',
             label: '#A5D6A7', gauge: '#FFFFFF', fuelGreen: '#00FFAA', cardBg: '#0D150D' },
    cards: [
      { type:'header', text:'车机助手' },
      { type:'gauge', key:'speed', label:'车速', unit:'公里/时', color:'#FFFFFF', size:72 },
      { type:'grid2', label: '>> 仪表盘', items: [
        { key:'fuelPer100km', label:'瞬时油耗', unit:'L/100km', fmt:'%.1f', color:'#00FFAA' },
        { key:'fuelLevel',      label:'油量',      unit:'%',       fmt:'%.0f', color:'#FFFFFF' },
        { key:'remainingRange', label:'续航里程',   unit:'km',     fmt:'%d',   color:'#64B5F6' },
        { key:'tripDistanceKm', label:'本次里程',   unit:'km',     fmt:'%.1f', color:'#81C784' },
        { key:'tripDuration',   label:'行程时长',   unit:'　',    fmt:'%s',   color:'#E1BEE7', text:true },
        { key:'tripFuelCost',   label:'本次油费',   unit:'元',     fmt:'%.1f', color:'#FFD600' },
        { key:'dailyDistanceKm',label:'本日里程',   unit:'km',     fmt:'%.1f', color:'#81C784' },
        { key:'dailyFuelCost',  label:'本日油费',   unit:'元',     fmt:'%.1f', color:'#FFD600' },
        { key:'monthlyDistanceKm',label:'本月里程', unit:'km',     fmt:'%.1f', color:'#81C784' },
        { key:'monthlyFuelCost',label:'本月油费',   unit:'元',     fmt:'%.1f', color:'#FFD600' }
      ]},
      { type:'status', key:'_status', label:'状态' },
      { type:'info', text:'v6.25.1 :: YOUR_VPS_IP:8899' }
    ]
  },

  // --- 扫描 PID ---
  SCAN_PID_LIST: [0x0D, 0x0C, 0x04, 0x05, 0x10, 0x43, 0x0B, 0x0F, 0x06, 0x07],  // 当前活跃PID, 云端下发手机轮询
  FULL_PID_LIST: [0x0D,0x0C,0x04,0x05, 0x0B,0x0F,0x10,0x11, 0x06,0x07,0x0E,0x33,0x42,0x43,0x44,0x0A],

  // --- 行程参数 ---
  DRIVE_FATIGUE_H: 2,              // 连续驾驶多少小时触发疲劳提醒
  DAILY_REPORT_HOUR: 9,            // 每日报告推送时间（北京时间）
  MIN_CLIENT_VERSION: '6.10',      // CarAgent 最低版本要求
  TRIP_TIMEOUT_MS: 30 * 60_000,    // 30分钟无GPS更新自动结束行程
  TRIP_TIMEOUT_CHECK_MS: 60_000,   // 每分钟检查一次超时
  CALIBRATION_MAX: 100,            // 校准样本上限（与 storage.js 保持一致）

  // --- 限制 ---
  MAX_BODY: 1_048_576,             // HTTP请求体上限 1MB
  MAX_GEO_CACHE: 1000,             // 反向地理编码缓存条目上限

  // --- 城市→本地宝子域名映射 ---
  // 用于从对应城市页面拉取实时油价
  CITY_DOMAIN_MAP: {
    '合肥':'hf','上海':'sh','北京':'bj','深圳':'sz','广州':'gz','杭州':'hz',
    '南京':'nj','武汉':'wh','成都':'cd','重庆':'cq','天津':'tj','苏州':'szh',
    '西安':'xa','长沙':'cs','郑州':'zz','济南':'jn','青岛':'qd','大连':'dl',
    '沈阳':'sy','哈尔滨':'heb','长春':'cc','福州':'fz','厦门':'xm','昆明':'km',
    '贵阳':'gy','南宁':'nn','海口':'hk','石家庄':'sjz','太原':'ty','兰州':'lz',
    '西宁':'xn','银川':'yc','乌鲁木齐':'wlmq','拉萨':'ls','南昌':'nc',
    '东莞':'dg','佛山':'fs','珠海':'zh','中山':'zs','惠州':'huizhou','常州':'cz',
    '无锡':'wx','温州':'wz','绍兴':'sx','嘉兴':'jx','芜湖':'whh','安庆':'aq',
    '蚌埠':'bb','马鞍山':'mas','铜陵':'tl','黄山':'hs','滁州':'czz','阜阳':'fy',
    '宿州':'szu','六安':'la','亳州':'bz','池州':'chiz','宣城':'xc',
  }
};
