// CarBridge v4.5 — 状态管理与持久化
// =====================================
// 所有全局状态集中管理，JSON 文件落盘。
// 定期自动保存（10分钟），服务退出时同步写入。
// parkHistory 已完全移除。

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logInfo, logWarn } = require('./logger');

// ====== 全局状态 ======

// 收进对象避免原始类型导出脱耦：exports.fuelPrice 是值拷贝，
// 外部 st.fuelPrice = x 写不到此局部变量。用 fuelState 对象引用共享。
let fuelState = {
  price: 8.00,       // 实时 92# 油价（从本地宝拉取）
  time: null,        // 油价更新时间 ISO
  city: null,        // 当前油价对应城市
  subdomain: null    // 本地宝子域名
};

let carState = {
  speed: 0, lat: 0, lng: 0,
  heading: '', battery: 100, engineOn: false,
  obdState: 'disconnected', obdError: null, obdElmVer: null,
  obdValidCount: 0, obdAttempted: false, obdSkipReason: null,
  coolantTemp: 0,
  obdVoltage: 12.5,
  fuelConsumption: 0,          // OBD 累计油耗 (L)
  odometer: 0,                 // 仪表盘总里程 (km)
  lastUpdate: null,            // GPS 心跳时间 (ISO)
  lastGpsUpdate: null,         // 最后一次 GPS 更新时间
  destinationName: '',
  obdData: {},                 // 手机中继全部 OBD 字段
  obdLastSeen: null,           // OBD 最后到达时间
  // 校准状态（前缀 _ 表示不持久化到 carState.json 顶层，单独存 calibrations.json）
  _calibrations: [],           // 校准样本数组
  _fuelCalibCoeff: 1.0,       // 加权平均校准系数
  _fuelCalibIdleCoeff: 1.0,   // 怠速校准系数
  _fuelCalibCruiseCoeff: 1.0, // 巡航校准系数
  _fuelCalibWotCoeff: 1.15,   // 急加速校准系数
  _carNotify: null,            // 车机通知（疲劳提醒等，消费后清除）
};

let tripHistory = [];
let currentTrip = {
  startTime: null, startLocation: '',
  points: [],
  fuelStart: 0,
  fatigueWarned: false,
  obdVoltageStart: null, obdTempStart: null, obdRpmStart: null
};

let tripStats = {
  daily:   { date: '', trips: 0, km: 0, fuel: 0, cost: 0 },
  weekly:  { weekStart: '', trips: 0, km: 0, fuel: 0, cost: 0 },
  monthly: { month: '', trips: 0, km: 0, fuel: 0, cost: 0 },
  yearly:  { year: '', trips: 0, km: 0, fuel: 0, cost: 0 }
};

let lastDailyReport = { date: '' };  // 对象引用，避免 let 原语导出脱耦

// ====== 油量校准映射表 ======
// 用户喂数据: { raw: 0x10, pct: 52 } → 线性插值
let fuelLevelMap = {};  // { "rawVal": pct }  如 {"16":52, "255":100}

// ====== 滚动油耗窗口 (续航计算) ======
let fuelSamples = [];  // [{km: totalOdo, fuel: cons}, ...] 只保留最近 30 km 的样本

// 确保 data 目录存在
if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });

// ====== 持久化函数 ======

/** 异步保存所有数据（定期调用） */
function saveData() {
  const fp = { price: fuelState.price, time: fuelState.time, city: fuelState.city, subdomain: fuelState.subdomain };
  const car = {
    odometer: carState.odometer,
    fuelConsumption: carState.fuelConsumption,
    fuelLevel: carState.fuelLevel,
    fuelCalibCoeff: carState._fuelCalibCoeff || 1.0,
    fuelCalibIdleCoeff: carState._fuelCalibIdleCoeff || 1.0,
    fuelCalibCruiseCoeff: carState._fuelCalibCruiseCoeff || 1.0,
    fuelCalibWotCoeff: carState._fuelCalibWotCoeff || 1.15
  };
  const calib = (carState._calibrations || []).slice(-config.CALIBRATION_MAX);

  fs.promises.writeFile(path.join(config.DATA_DIR, 'fuelPrice.json'), JSON.stringify(fp))
    .catch(e => logWarn('save fuelPrice', e.message));
  fs.promises.writeFile(path.join(config.DATA_DIR, 'tripHistory.json'), JSON.stringify(tripHistory))
    .catch(e => logWarn('save tripHistory', e.message));
  fs.promises.writeFile(path.join(config.DATA_DIR, 'tripStats.json'), JSON.stringify(tripStats))
    .catch(e => logWarn('save tripStats', e.message));
  fs.promises.writeFile(path.join(config.DATA_DIR, 'carState.json'), JSON.stringify(car))
    .catch(e => logWarn('save carState', e.message));
  fs.promises.writeFile(path.join(config.DATA_DIR, 'calibrations.json'), JSON.stringify(calib))
    .catch(e => logWarn('save calibrations', e.message));
  fs.promises.writeFile(path.join(config.DATA_DIR, 'fuelLevelMap.json'), JSON.stringify(fuelLevelMap))
    .catch(e => logWarn('save fuelLevelMap', e.message));
}

/** 同步保存所有数据（仅退出时使用，确保不丢） */
function saveDataSync() {
  try {
    const fp = { price: fuelState.price, time: fuelState.time, city: fuelState.city, subdomain: fuelState.subdomain };
    fs.writeFileSync(path.join(config.DATA_DIR, 'fuelPrice.json'), JSON.stringify(fp));
    fs.writeFileSync(path.join(config.DATA_DIR, 'tripHistory.json'), JSON.stringify(tripHistory));
    fs.writeFileSync(path.join(config.DATA_DIR, 'tripStats.json'), JSON.stringify(tripStats));
    fs.writeFileSync(path.join(config.DATA_DIR, 'carState.json'), JSON.stringify({
      odometer: carState.odometer,
      fuelConsumption: carState.fuelConsumption,
      fuelLevel: carState.fuelLevel,
      fuelCalibCoeff: carState._fuelCalibCoeff || 1.0,
      fuelCalibIdleCoeff: carState._fuelCalibIdleCoeff || 1.0,
      fuelCalibCruiseCoeff: carState._fuelCalibCruiseCoeff || 1.0,
      fuelCalibWotCoeff: carState._fuelCalibWotCoeff || 1.15
    }));
    fs.writeFileSync(path.join(config.DATA_DIR, 'calibrations.json'),
      JSON.stringify(carState._calibrations || []));
    fs.writeFileSync(path.join(config.DATA_DIR, 'fuelLevelMap.json'), JSON.stringify(fuelLevelMap));
  } catch(e) { logWarn('saveDataSync error', e.message); }
}

/** 启动时从 JSON 文件恢复所有状态 */
function loadData() {
  try {
    // 恢复行程历史
    const th = path.join(config.DATA_DIR, 'tripHistory.json');
    if (fs.existsSync(th)) tripHistory = JSON.parse(fs.readFileSync(th, 'utf8'));

    // 恢复统计
    const ts = path.join(config.DATA_DIR, 'tripStats.json');
    if (fs.existsSync(ts)) tripStats = JSON.parse(fs.readFileSync(ts, 'utf8'));

    // 恢复车辆状态 + 校准系数
    const cs = path.join(config.DATA_DIR, 'carState.json');
    if (fs.existsSync(cs)) {
      const c = JSON.parse(fs.readFileSync(cs, 'utf8'));
      if (c.odometer != null) carState.odometer = c.odometer;
      if (c.fuelConsumption != null) carState.fuelConsumption = c.fuelConsumption;
      if (c.fuelLevel != null) carState.fuelLevel = c.fuelLevel;
      if (c.fuelCalibCoeff != null) carState._fuelCalibCoeff = c.fuelCalibCoeff;
      if (c.fuelCalibIdleCoeff != null) carState._fuelCalibIdleCoeff = c.fuelCalibIdleCoeff;
      if (c.fuelCalibCruiseCoeff != null) carState._fuelCalibCruiseCoeff = c.fuelCalibCruiseCoeff;
      if (c.fuelCalibWotCoeff != null) carState._fuelCalibWotCoeff = c.fuelCalibWotCoeff;
    }

    // 恢复油价
    const fp = path.join(config.DATA_DIR, 'fuelPrice.json');
    if (fs.existsSync(fp)) {
      const f = JSON.parse(fs.readFileSync(fp, 'utf8'));
      fuelState.price = f.price || 8.00;
      fuelState.time = f.time || null;
      fuelState.city = f.city || null;
      fuelState.subdomain = f.subdomain || null;
    }

    // 恢复校准记录
    const calPath = path.join(config.DATA_DIR, 'calibrations.json');
    if (fs.existsSync(calPath)) {
      const raw = JSON.parse(fs.readFileSync(calPath, 'utf8'));
      carState._calibrations = raw.slice(-config.CALIBRATION_MAX);
    }

    // 恢复油量映射表
    const flmPath = path.join(config.DATA_DIR, 'fuelLevelMap.json');
    if (fs.existsSync(flmPath)) {
      fuelLevelMap = JSON.parse(fs.readFileSync(flmPath, 'utf8'));
    }

    logInfo('数据已加载',
      'trips=' + tripHistory.length +
      ' 油价=¥' + fuelState.price +
      (fuelState.city ? ' (' + fuelState.city + ')' : '') +
      ' 校准=' + (carState._calibrations || []).length + '条' +
      ' 油量映射=' + Object.keys(fuelLevelMap).length + '点' +
      ' (coeff=' + ((carState._fuelCalibCoeff || 1.0).toFixed(3)) + ')');

    // 延迟加载 fuel 模块避免循环依赖
    if (fuelState.city) {
      const { fetchFuelPrice } = require('./fuel');
      fetchFuelPrice(fuelState.city);
    }
  } catch(e) { logWarn('loadData error', e.message); }
}

// 每 10 分钟自动持久化，防进程 crash 丢数据
setInterval(() => { saveData(); }, 10 * 60_000);

module.exports = {
  // 状态对象（引用导出，模块间共享同一实例）
  carState, currentTrip, tripHistory, tripStats,
  fuelState,  // 油价状态对象（引用，避免原始类型值拷贝）
  lastDailyReport,
  fuelLevelMap, fuelSamples,  // 油量映射表 + 滚动油耗窗口
  // 函数
  saveData, saveDataSync, loadData
};
