// CarBridge v6.25.1 — 行程管理
// ============================
// 行程开始/结束、GPS状态更新、OBD中继、周期统计
// v6.25.1: 移除微信推送, 推送由 OpenClaw cron 负责

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logInfo, logWarn } = require('./logger');
const storage = require('./storage');
const { reverseGeo, extractCity, haversine, amapUrl, beijingDateStr,
        beijingHour, formatTime, getWeekNumber } = require('./geo');
const { fetchFuelPrice } = require('./fuel');

// ====== 统计计算 ======

/** 从行程 GPS 点计算里程、均速、极速、耗时 */
function calcStats(trip, fuelFromClient) {
  if (!trip.points || trip.points.length < 2) return null;
  let dist = 0, maxS = 0, sumS = 0, cntS = 0;
  for (let i = 1; i < trip.points.length; i++) {
    const p1 = trip.points[i-1], p2 = trip.points[i];
    dist += haversine(p1.lat, p1.lng, p2.lat, p2.lng);
    if (p2.speed > maxS) maxS = p2.speed;
    if (p2.speed > 0) { sumS += p2.speed; cntS++; }
  }
  const durMin = Math.max(0, (new Date(trip.points[trip.points.length-1].time) - new Date(trip.startTime)) / 60000);
  return {
    mileage: dist,
    duration: Math.floor(durMin / 60) + '小时' + Math.round(durMin % 60) + '分',
    avgSpeed: cntS > 0 ? sumS / cntS : 0,
    maxSpeed: maxS,
    fuelUsed: Math.max(0, fuelFromClient - (trip.fuelStart || 0))
  };
}

// ====== 周期统计更新 ======

function updateStats(stats) {
  const st = storage;
  const now = new Date();
  const today = beijingDateStr(now);
  const weekNum = getWeekNumber(now);
  const bjNow = new Date(now.getTime() + 8 * 3600_000);
  const month = bjNow.getFullYear() + '-' + String(bjNow.getMonth() + 1).padStart(2, '0');
  const year = bjNow.getFullYear().toString();

  // 日切换
  if (st.tripStats.daily.date !== today) {
    st.tripStats.daily = { date: today, trips: 0, km: 0, fuel: 0, cost: 0 };
  }
  // 周切换
  const weekKey = bjNow.getUTCFullYear() + '-W' + weekNum;
  if (st.tripStats.weekly.weekStart !== weekKey) {
    st.tripStats.weekly = { weekStart: weekKey, trips: 0, km: 0, fuel: 0, cost: 0 };
  }
  // 月切换
  if (st.tripStats.monthly.month !== month) {
    st.tripStats.monthly = { month: month, trips: 0, km: 0, fuel: 0, cost: 0 };
  }
  // 年切换
  if (st.tripStats.yearly.year !== year) {
    st.tripStats.yearly = { year: year, trips: 0, km: 0, fuel: 0, cost: 0 };
  }

  // 累加本次行程数据
  const fuel = stats.fuelUsed || 0;
  for (const p of ['daily', 'weekly', 'monthly', 'yearly']) {
    st.tripStats[p].trips++;
    st.tripStats[p].km += stats.mileage;
    st.tripStats[p].fuel += fuel;
    st.tripStats[p].cost += fuel * st.fuelState.price;
  }
  st.saveData();
}

/** 按周期筛选行程历史 */
function getTripsForPeriod(periodKey, periodType) {
  return storage.tripHistory.filter(t => {
    const d = new Date(t.date || t.time);
    const bj = new Date(d.getTime() + 8 * 3600_000);
    if (periodType === 'week') {
      const w = getWeekNumber(d);
      const y = bj.getUTCFullYear();
      // periodKey 格式: "2026-W52"
      const parts = String(periodKey).split('-W');
      const pkYear = parseInt(parts[0]) || bj.getUTCFullYear();
      const pkWeek = parseInt(parts[1]) || 0;
      return w === pkWeek && y === pkYear;
    } else if (periodType === 'month') {
      const m = bj.getFullYear() + '-' + String(bj.getMonth() + 1).padStart(2, '0');
      return m === periodKey;
    } else if (periodType === 'year') {
      return bj.getFullYear().toString() === periodKey;
    } else {
      return bj.toISOString().slice(0, 10) === periodKey;
    }
  });
}

// ====== 行程结算 ======

/**
 * 结算行程：计算统计、写入历史、更新周期统计、推送微信
 * fuelConsumptionFromClient 来自客户端上报，始终为 0.0；
 * 实际油耗由 VPS 端 handleObd 积分维护 (dtH × fuelRate)
 */
function finishTrip(trip, endLoc, _fuelConsumptionFromClient, odometer) {
  const st = storage;
  // 信任 VPS 自己积分的累计油耗，忽略客户端传来的值（客户端硬编码为 0.0）
  const vpsFuel = st.carState.fuelConsumption || 0;
  const stats = calcStats(trip, vpsFuel);

  try {
    if (stats) {
      stats.date = new Date().toISOString();
      stats.startLocation = trip.startLocation;
      stats.endLocation = endLoc;
      st.tripHistory.push(stats);
      if (st.tripHistory.length > 100) st.tripHistory = st.tripHistory.slice(-100);
      updateStats(stats);

      st.saveData();
    }

    if (odometer > 0) st.carState.odometer = odometer;
  } finally {
    // ⚠️ 无论成功失败，必须清除 _ending 防止卡死
    delete st.currentTrip._ending;
    st.currentTrip = {
      startTime: null, startLocation: '', points: [],
      fuelStart: 0, liveDistanceKm: 0, fatigueWarned: false,
      obdVoltageStart: null, obdTempStart: null, obdRpmStart: null
    };
  }

  return { statusCode: 200, body: { ok: true, stats: stats } };
}

// ====== HTTP Handler 函数（返回 {statusCode, body}） ======

/** POST /api/car/status — GPS 状态上报 */
function handleStatus(bodyStr) {
  const st = storage;
  const d = JSON.parse(bodyStr);

  // 存储车机日志快照到 logs/ 目录
  if (d._log && typeof d._log === 'string') {
    try {
      const logPath = path.join(config.LOG_DIR, 'car_agent.log');
      let logText = d._log;
      if (logText.length > 500_000) logText = logText.slice(-500_000);
      fs.writeFileSync(logPath, logText, 'utf8');
      delete d._log;
    } catch(e) { logWarn('carLog write error', e.message); }
  }

  // 更新车辆状态字段
  if (d.speed !== undefined) st.carState.speed = d.speed;
  // GPS 坐标校验: 拦截 (0,0) 及超出中国范围的无效坐标 (防止注入幽灵里程)
  if (d.lat !== undefined && d.lng !== undefined
    && d.lat > 0.1 && d.lng > 70 && d.lng < 140) {
    st.carState.lat = d.lat; st.carState.lng = d.lng;
  } else if (d.lat !== undefined && d.lng !== undefined) {
    // 保留上次有效坐标, 不更新 carState
  }
  if (d.heading) st.carState.heading = d.heading;
  if (d.engineOn !== undefined) st.carState.engineOn = d.engineOn;
  if (d.coolantTemp !== undefined) st.carState.coolantTemp = d.coolantTemp;
  if (d.obdVoltage !== undefined) st.carState.obdVoltage = d.obdVoltage;
  if (d.obdState) st.carState.obdState = d.obdState;
  if (d.obdError !== undefined) st.carState.obdError = d.obdError;
  if (d.obdElmVer) st.carState.obdElmVer = d.obdElmVer;
  if (d.obdValidCount !== undefined) st.carState.obdValidCount = d.obdValidCount;
  if (d.obdAttempted !== undefined) st.carState.obdAttempted = d.obdAttempted;
  if (d.obdSkipReason) st.carState.obdSkipReason = d.obdSkipReason;
  if (d.engineRpm !== undefined) st.carState.engineRpm = d.engineRpm;
  if (d.fuelLevel !== undefined) st.carState.fuelLevel = d.fuelLevel;
  if (d.fuelRate !== undefined) st.carState.fuelRate = d.fuelRate;
  if (d.fuelConsumption !== undefined) st.carState.fuelConsumption = d.fuelConsumption;
  st.carState.lastUpdate = new Date().toISOString();
  st.carState.lastGpsUpdate = st.carState.lastUpdate;

  // OBD 状态变化记录
  if (st.carState.obdState !== st.carState._lastObdState) {
    logInfo('OBD状态', st.carState.obdState +
      (st.carState.obdError ? ' err=' + st.carState.obdError : '') +
      (st.carState.obdElmVer ? ' elm=' + st.carState.obdElmVer : '') +
      ' attempted=' + st.carState.obdAttempted +
      (st.carState.obdSkipReason ? ' skip=' + st.carState.obdSkipReason : ''));
    st.carState._lastObdState = st.carState.obdState;
  }
  if (st.carState.obdAttempted && !st.carState._loggedObdStartup) {
    st.carState._loggedObdStartup = true;
    logInfo('OBD启动', 'attempted=' + st.carState.obdAttempted +
      (st.carState.obdSkipReason ? ' skip=' + st.carState.obdSkipReason : ' mac_ok'));
  }

  // 首次获取城市（用于油价定位）
  if (!st.fuelState.city && st.carState.lat && st.carState.lng) {
    reverseGeo(st.carState.lat, st.carState.lng, (locName) => {
      const city = extractCity(locName);
      if (city) fetchFuelPrice(city);
    });
  }

  // 记录行程 GPS 轨迹点
  if (st.currentTrip.startTime && !st.currentTrip._ending) {
    const prev = st.currentTrip.points.length > 0
      ? st.currentTrip.points[st.currentTrip.points.length - 1] : null;
    const pt = {
      lat: st.carState.lat, lng: st.carState.lng,
      speed: st.carState.speed,
      time: st.carState.lastUpdate
    };
    st.currentTrip.points.push(pt);

    // 增量累加里程 (避免 query 时 O(N) 遍历)
    if (prev) {
      const seg = haversine(prev.lat, prev.lng, pt.lat, pt.lng);
      // 过滤异常 GPS 跳点: 距离>1km 且 当段速度<5km/h → 静置漂移
      if (!(seg > 1 && prev.speed > 0 && seg / (Math.max(1, (new Date(pt.time) - new Date(prev.time)) / 3600000)) < 5)) {
        st.currentTrip.liveDistanceKm = (st.currentTrip.liveDistanceKm || 0) + seg;
        st.carState._totalOdoKm = (st.carState._totalOdoKm || 0) + seg;
      }
    }

    if (st.currentTrip.points.length > 5000) {
      st.currentTrip.points = st.currentTrip.points.slice(-5000);
    }
  }

  // 疲劳驾驶检测
  if (st.currentTrip.startTime) {
    const elapsedH = (Date.now() - new Date(st.currentTrip.startTime).getTime()) / 3600000;
    if (elapsedH >= config.DRIVE_FATIGUE_H && !st.currentTrip.fatigueWarned) {
      st.currentTrip.fatigueWarned = true;
      // v6.25.1: 疲劳提醒由车机自行处理
    }
  }

  // 版本协商
  if (d.version) {
    const vParts = d.version.split('.').map(Number);
    const minParts = config.MIN_CLIENT_VERSION.split('.').map(Number);
    for (let i = 0; i < Math.max(vParts.length, minParts.length); i++) {
      if ((vParts[i] || 0) < (minParts[i] || 0)) {
        return {
          statusCode: 200,
          body: { ok: false, error: 'OUTDATED_CLIENT',
            message: '请更新 CarAgent 到 v' + config.MIN_CLIENT_VERSION + '+' }
        };
      }
      if ((vParts[i] || 0) > (minParts[i] || 0)) break;
    }
  }

  return { statusCode: 200, body: { ok: true } };
}

/** POST /api/car/start — 行程开始 */
function handleStart(bodyStr) {
  const st = storage;
  const d = JSON.parse(bodyStr);

  if (st.currentTrip._ending || st.currentTrip._lock) {
    return { statusCode: 200, body: { ok: false, error: 'trip busy' } };
  }
  if (st.currentTrip.startTime) {
    return { statusCode: 200, body: { ok: false, error: 'already started' } };
  }

  // GPS 坐标校验：冷启动/未锁星时车机可能上报 (0,0)
  const USEABLE_COORDS = (Math.abs(d.lat) > 0.001 || Math.abs(d.lng) > 0.001);

  // ⚠️ 同步截取油耗快照, 防止异步回调期间 handleObd 污染
  const fuelStartSnapshot = st.carState.fuelConsumption || 0;

  // 异步解析地名，超时 7 秒兜底
  return new Promise((resolve) => {
    st.currentTrip._lock = true;
    let resolved = false;
    function done(placeName, fallbackLat, fallbackLng) {
      if (resolved) return; resolved = true;
      clearTimeout(timer);
      // 兜底清洗：Nominatim 异常时 callback 返回的是坐标 key (如 "0.000,0.000")
      if (/^-?\d+\.\d+,-?\d+\.\d+$/.test(placeName)) {
        placeName = '未知';
        logWarn('handleStart', 'reverseGeo 返回坐标 key，替换为未知');
      }
      const newCity = extractCity(placeName);
      if (newCity && newCity !== st.fuelState.city) fetchFuelPrice(newCity);
      st.currentTrip._lock = false;
      st.currentTrip = {
        startTime: new Date().toISOString(),
        startLocation: placeName,
        points: [],
        fuelStart: fuelStartSnapshot,
        liveDistanceKm: 0,
        fatigueWarned: false,
        obdVoltageStart: st.carState.obdVoltage ?? null,
        obdTempStart: st.carState.coolantTemp ?? null,
        obdRpmStart: st.carState.engineRpm ?? null
      };
      // 用回退坐标发地图链接（上次停车位置 or carState 缓存的 GPS）
      const mapLat = fallbackLat ?? d.lat;
      const mapLng = fallbackLng ?? d.lng;
      // v6.25.1: 行程开始
      resolve({ statusCode: 200, body: { ok: true } });
    }
    const timer = setTimeout(() => {
      logWarn('handleStart timeout', 'reverseGeo did not callback');
      const fl = (st.carState.lat && Math.abs(st.carState.lat) > 0.001) ? st.carState.lat : null;
      const fng = (st.carState.lng && Math.abs(st.carState.lng) > 0.001) ? st.carState.lng : null;
      done('未知', fl, fng);
    }, 7000);
    // 坐标为 (0,0) 时：用上次行程终点位置 + carState 缓存的 GPS 做回退
    if (!USEABLE_COORDS) {
      logWarn('handleStart', '坐标为(0,0)，尝试上次行程终点');
      const lastTrip = st.tripHistory.slice(-1)[0];
      const fallbackLoc = (lastTrip && lastTrip.endLocation && lastTrip.endLocation !== '未知')
        ? '🅿️ ' + lastTrip.endLocation : '未知';
      // carState 中上次 status 上报可能还有有效坐标
      const fallbackLat = (st.carState.lat && Math.abs(st.carState.lat) > 0.001) ? st.carState.lat : null;
      const fallbackLng = (st.carState.lng && Math.abs(st.carState.lng) > 0.001) ? st.carState.lng : null;
      done(fallbackLoc, fallbackLat, fallbackLng);
      return;
    }
    reverseGeo(d.lat, d.lng, (placeName) => done(placeName));
  });
}

/** POST /api/car/end — 行程结束 */
function handleEnd(bodyStr) {
  const st = storage;
  const d = JSON.parse(bodyStr);

  if (!st.currentTrip.startTime) {
    return { statusCode: 200, body: { ok: false, error: 'no active trip' } };
  }
  if (st.currentTrip._ending) {
    return { statusCode: 200, body: { ok: false, error: 'already ending' } };
  }
  st.currentTrip._ending = true;
  const trip = st.currentTrip;

  // GPS 坐标校验：复用 handleStart 的回退逻辑
  const USEABLE_COORDS = (Math.abs(d.lat) > 0.001 || Math.abs(d.lng) > 0.001);

  return new Promise((resolve) => {
    let resolved = false;
    function done(endLoc) {
      if (resolved) return; resolved = true;
      clearTimeout(timer);
      if (/^-?\d+\.\d+,-?\d+\.\d+$/.test(endLoc)) {
        endLoc = trip.startLocation || '未知';
      }
      resolve(finishTrip(trip, endLoc, d.fuelConsumption || 0, d.odometer));
    }
    const timer = setTimeout(() => {
      logWarn('handleEnd timeout', 'reverseGeo did not callback');
      done(trip.startLocation || '未知');
    }, 7000);

    // 坐标 (0,0) 时跳过 Nominatim，用出发地名
    if (!USEABLE_COORDS) {
      logWarn('handleEnd', '坐标为(0,0)，跳过反向编码，用出发地名');
      done(trip.startLocation || '未知');
      return;
    }
    reverseGeo(d.lat, d.lng, (endLoc) => done(endLoc));
  });
}

// ====== OBD PID 注册表 & 解析引擎 (VPS 侧唯一权威) ======
// 手机端只负责发送原始 hex，解析逻辑全部集中在 VPS
// 公式来源: SAE J1979 / ISO 15031-5

// 从 hex 字符串提取原始数据字节
function obdB(data, offset = 0) { const idx = offset * 2; return idx + 2 <= data.length ? parseInt(data.slice(idx, idx + 2), 16) : 0; }
function obdW(data, offset = 0) { const idx = offset * 2; return idx + 4 <= data.length ? parseInt(data.slice(idx, idx + 2), 16) * 256 + parseInt(data.slice(idx + 2, idx + 4), 16) : 0; }

const PID_REGISTRY = {
  0x04: { key: 'engineLoad',   parse: d => obdB(d) / 2.55 },
  0x05: { key: 'coolantTemp',  parse: d => obdB(d) - 40 },
  0x06: { key: 'fuelTrimS1',   parse: d => (obdB(d) - 128) * 100 / 128 },
  0x07: { key: 'fuelTrimL1',   parse: d => (obdB(d) - 128) * 100 / 128 },
  0x0A: { key: 'fuelPressure', parse: d => obdB(d) * 3 },
  0x0B: { key: 'intakeMAP',    parse: d => obdB(d) },
  0x0C: { key: 'engineRpm',    parse: d => obdW(d) / 4 },
  0x0D: { key: 'obdSpeed',     parse: d => obdB(d) },
  0x0E: { key: 'timingAdv',    parse: d => (obdB(d) - 128) / 2 },
  0x0F: { key: 'intakeTemp',   parse: d => obdB(d) - 40 },
  0x10: { key: 'mafRate',      parse: d => obdW(d) / 100 },
  0x11: { key: 'throttlePos',  parse: d => obdB(d) / 2.55 },
  0x2F: { key: 'fuelLevel',    parse: d => obdB(d) / 2.55 },
  0x33: { key: 'baroPressure', parse: d => obdB(d) },
  0x42: { key: 'voltage',      parse: d => obdW(d) / 1000 },
  0x43: { key: 'absLoad',      parse: d => obdW(d) / 2.55 },
  0x44: { key: 'equivRatio',   parse: d => obdW(d) / 32768 },
  0x5E: { key: 'fuelRate',     parse: d => obdW(d) * 0.05 },
};

// ====== 油量校准映射表 ======
// 线性插值: 已知 (rawA→pctA), (rawB→pctB)，求 rawX 对应 pct
// 例如 { "16":52, "255":100 } — 加满跳枪和用户读表喂的点
function calibratedFuelLevel(rawByte) {
  const map = storage.fuelLevelMap;
  const keys = Object.keys(map).map(Number).sort((a,b)=>a-b);
  if (keys.length === 0) return rawByte / 2.55; // 兜底: 标准 J1979

  if (keys.length === 1) {
    const k = keys[0];
    return rawByte >= k ? map[k] : (rawByte / k * map[k]);
  }

  // 找到区间
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i+1];
    if (rawByte >= a && rawByte <= b) {
      return map[a] + (rawByte - a) / (b - a) * (map[b] - map[a]);
    }
  }
  // 区间外: 用最近点外推
  if (rawByte < keys[0]) {
    const a = keys[0], b = keys[1];
    const slope = (map[b] - map[a]) / (b - a);
    return Math.max(0, map[a] + (rawByte - a) * slope);
  }
  const a = keys[keys.length-2], b = keys[keys.length-1];
  const slope = (map[b] - map[a]) / (b - a);
  return Math.min(100, map[b] + (rawByte - b) * slope);
}

// ====== 滚动油耗窗口 (续航计算) ======
const { TANK_CAPACITY, DISPLACEMENT_L, FUEL_CALIB_COEFF } = config;
if (!TANK_CAPACITY) throw new Error('config.TANK_CAPACITY 未设置');

// 每 ~1km 产一个油耗样本 (L/100km)
function addFuelSample(odoKm, fuelCons) {
  const samples = storage.fuelSamples;
  const last = samples.length > 0 ? samples[samples.length-1] : null;
  if (!last || odoKm - last.km >= 0.5) {
    samples.push({ km: odoKm, fuel: fuelCons });
    if (samples.length > 30) samples.shift(); // 只保留最近 ~30km
  }
}

// 滚动加权平均: 越新的样本权重越高
function rollingAvgFuelPer100km() {
  const samples = storage.fuelSamples;
  if (samples.length < 2) {
    // 没样本: 用全局平均兜底 (至少跑了 5km 才算)
    const odo = storage.carState._totalOdoKm || 0;
    if (odo < 5) return null;
    const cons = storage.carState.fuelConsumption || 0;
    return cons / odo * 100;
  }
  let sumW = 0, sumV = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i === 0) continue; // 第一个点没前驱
    const dKm = samples[i].km - samples[i-1].km;
    const dFuel = samples[i].fuel - samples[i-1].fuel;
    if (dKm < 0.1) continue;
    const v = dFuel / dKm * 100; // L/100km for this segment
    const w = (i + 1) / samples.length; // 线性权重: 越新越重
    sumW += w; sumV += v * w;
  }
  return sumW > 0 ? sumV / sumW : 8.0; // 兜底 8 L/100km
}

function calcRange(fuelLevelPct, avgFuelPer100km) {
  if (!avgFuelPer100km || avgFuelPer100km <= 0) return null;  // 无数据不显示
  const fuelRemaining = TANK_CAPACITY * (fuelLevelPct / 100);
  return fuelRemaining / avgFuelPer100km * 100;
}

function getTripDuration() {
  const trip = storage.currentTrip;
  if (!trip.startTime) return '--';
  const ms = Date.now() - new Date(trip.startTime).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return (h > 0 ? h + 'h' : '') + String(m).padStart(2, '0') + 'min';
}

/** POST /api/car/obd — OBD 数据中继 (v5: 支持 raw hex 和旧版 key-value) */
function handleObd(bodyStr) {
  const st = storage;
  const d = JSON.parse(bodyStr);

  // 存储 OBD 中继日志到 logs/ 目录 (手机端 diag 上传)
  if (d._log && typeof d._log === 'string') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = path.join(config.LOG_DIR, `obd_relay_${today}.log`);
      const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
      fs.appendFileSync(logPath, `\n=== ${ts} ===\n${d._log}\n`);
      delete d._log;
    } catch(e) { logWarn('obdLog write error', e.message); }
  }

  st.carState.obdData = st.carState.obdData || {};

  // v6.25.1 扫描期: 手机端发原始 ELM327 响应, 摸底 ECU 支持的 PID
  if (d._type === "debug_raw") {
    const pid = d.pid;
    const resp = d.resp || '';
    const isRejected = resp.includes('7F');
    st._pidScan = st._pidScan || {};
    if (!st._pidScan[pid]) st._pidScan[pid] = { ok: 0, fail: 0, lastResp: '' };
    if (isRejected) {
      st._pidScan[pid].fail++;
      st._pidScan[pid].lastResp = resp.slice(0, 60);
    }
    // don't log every single 7F — only log on first discovery and every 30th
    if (isRejected && st._pidScan[pid].fail === 1) {
      logInfo(`❌ PID 0x${pid?.toString(16)?.toUpperCase()}`, `不支持 (7F)`);
    }
    if (!isRejected) {
      // shouldn't happen since raw dispatches go through _type="raw"
    }
    delete d._type; delete d.pid; delete d.resp; delete d.loop;
  }

  // v5: 手机端发送 raw hex 格式 {"_type":"raw","0C":"410C1BA4","0D":"410D3C",...}
  // 带 ELM327 响应前缀 "41XX"，VPS 裁剪后解析
  if (d._type === 'raw') {
    delete d._type;
    for (const [pidHex, hexRaw] of Object.entries(d)) {
      if (pidHex === 'apiKey' || pidHex.startsWith('_')) continue;
      const pid = parseInt(pidHex, 16);
      const def = PID_REGISTRY[pid];
      if (!def) continue;
      // 裁剪 "41XX" 前缀 (4字符) → 纯数据 hex
      const data = hexRaw.length > 4 ? hexRaw.slice(4) : hexRaw;
      const val = def.parse(data);
      // 扫描期: 记录所有 PID 原始 hex 用于摸底
      logInfo(`PID_RAW 0x${pidHex}`, `hexRaw="${hexRaw}" data="${data}" val=${val}`);
      // 标记 PID 可用
      st._pidScan = st._pidScan || {};
      if (!st._pidScan[pid]) st._pidScan[pid] = { ok: 0, fail: 0, lastResp: '' };
      st._pidScan[pid].ok++;
      st.carState.obdData[def.key] = val;
    }
  } else {
    // 旧版兼容: 手机端发已解析的 key-value {"engineRpm":1769,...}
    for (const [k, v] of Object.entries(d)) {
      if (k === 'type' || k === 'apiKey' || k.startsWith('_')) continue;
      st.carState.obdData[k] = v;
    }
  }

  // 每 10 次记录一行调试日志
  st.carState._obdCount = (st.carState._obdCount || 0) + 1;
  if (st.carState._obdCount % 10 === 1) {
    const keys = Object.keys(st.carState.obdData);
    logInfo('OBD接收', keys.join(' ') + ' #' + st.carState._obdCount);
  }

  // 同步到顶层字段 & 油耗积分
  const od = st.carState.obdData;
  if (od.voltage !== undefined) st.carState.obdVoltage = od.voltage;
  if (od.coolantTemp !== undefined) st.carState.coolantTemp = od.coolantTemp;
  if (od.engineRpm !== undefined) st.carState.engineRpm = od.engineRpm;
  if (od.obdSpeed !== undefined) {
    // 低通滤波平滑 (EMA α=0.35)，消起步跳变感
    if (st._smoothSpeed === undefined) st._smoothSpeed = od.obdSpeed;
    st._smoothSpeed = st._smoothSpeed * 0.65 + od.obdSpeed * 0.35;
    st.carState.obdSpeed = Math.round(st._smoothSpeed * 10) / 10;
  }
  // 油耗率计算: MAF优先 → ECU直读(0x5E) → 负荷×转速估算
  if (od.mafRate !== undefined && od.mafRate > 0) {
    // 🎯 最准: MAF(g/s) ÷ 14.7 ÷ 737 = L/h  (737g是1升汽油质量)
    st.carState.fuelRate = od.mafRate / 14.7 / 737 * 3600;
  } else if (od.fuelRate !== undefined) {
    st.carState.fuelRate = od.fuelRate;
  } else if (od.engineLoad !== undefined && od.engineRpm !== undefined) {
    // 兜底: 负荷×转速×排量×系数
    st.carState.fuelRate = (od.engineLoad / 100) * od.engineRpm * DISPLACEMENT_L * FUEL_CALIB_COEFF;
  }
  if (st.carState.fuelRate !== undefined && st.carState.obdLastSeen) {
    const dtH = (Date.now() - new Date(st.carState.obdLastSeen).getTime()) / 3600000;
    if (dtH > 0 && dtH < 0.01) {
      st.carState.fuelConsumption += st.carState.fuelRate * dtH;
      const odo = st.carState._totalOdoKm || 0;
      addFuelSample(odo, st.carState.fuelConsumption);
    }
  }
  // 油量: 由累计油耗反推 (0x2F 不支持, 无OBD直读)
  // 加油后累计油耗归零, fuelLevel 回到 100%
  const cons = st.carState.fuelConsumption || 0;
  st.carState.fuelLevel = Math.max(0, (TANK_CAPACITY - cons) / TANK_CAPACITY * 100);
  const carSpeed = st.carState.obdSpeed ?? st.carState.speed ?? 0;

  // === 行程以 ECU 连接/断开为界 ===
  // ECU连上且未在行程中 → 自动开始
  if (!st.currentTrip.startTime) {
    const now = new Date().toISOString();
    st.currentTrip.startTime = now;
    st.currentTrip.points = [];
    st.currentTrip.liveDistanceKm = 0;
    st.currentTrip.startLocation = 'ECU连接';
    st.currentTrip.fatigueWarned = false;
    st.currentTrip._lock = false;
    st.currentTrip._ending = false;
    st.currentTrip.fuelStart = st.carState.fuelConsumption || 0;
    st.currentTrip.obdVoltageStart = st.carState.obdVoltage ?? null;
    st.currentTrip.obdTempStart = st.carState.coolantTemp ?? null;
    st.currentTrip.obdRpmStart = st.carState.engineRpm ?? null;
    logInfo('行程开始(ECU连接)', `fuelStart=${st.currentTrip.fuelStart?.toFixed(2)}L 油量=${(st.carState.fuelLevel||0).toFixed(1)}%`);
  }
  // === OBD 车速累计里程 (替代 GPS 轨迹) ===
  if (st.currentTrip.startTime && carSpeed > 0 && st.carState._prevObdMs) {
    const dtH = (Date.now() - st.carState._prevObdMs) / 3600000;
    if (dtH > 0 && dtH < 0.01) {  // < 36秒, 防大跳
      const seg = carSpeed * dtH;
      st.currentTrip.liveDistanceKm = (st.currentTrip.liveDistanceKm || 0) + seg;
      st.carState._totalOdoKm = (st.carState._totalOdoKm || 0) + seg;
    }
  }
  st.carState._prevObdMs = Date.now();

  // === 瞬时油耗 (行进: L/100km, 怠速: L/h 分情景) ===
  const fuelRate = st.carState.fuelRate;
  const coolantT = st.carState.coolantTemp;
  const engLoad = od.engineLoad;
  const rpm = st.carState.engineRpm;

  if (fuelRate !== undefined && carSpeed > 1) {
    // 行进中: L/100km
    st.carState.fuelPer100km = Math.round((fuelRate / carSpeed) * 100 * 100) / 100;
  } else if (fuelRate !== undefined && rpm !== undefined && rpm > 0) {
    // 怠速/低速: L/h, 根据工况微调
    // 基准值: fuelRate 本身已是 L/h (燃料率, L/h)
    // hotIdle 基准 = fuelRate × 1.0 (发动机负荷已反映真实油耗)
    const baseFuelLph = fuelRate;  // L/h, 已经由负荷×转速算出
    let fuelLph = baseFuelLph;
    let scenario = '怠速';

    // 冷车 (<50°C): 加浓 ~ +40%
    if (coolantT != null && coolantT < 50) {
      fuelLph = baseFuelLph * 1.4;
      scenario = '冷车怠速';
    } else if (coolantT != null && engLoad != null && engLoad > 22) {
      // 热车高负荷 (开空调/用电): +20%
      fuelLph = baseFuelLph * 1.2;
      scenario = '热车+空调';
    }
    // else: 热车怠速 (基准), fuelLph = baseFuelLph

    st.carState.fuelPer100km = Math.round(fuelLph * 100) / 100; // 单位: L/h
    st.carState._idleScenario = scenario;
  } else {
    st.carState.fuelPer100km = null;
  }
  st.carState.obdState = 'polling';
  st.carState.obdAttempted = true;
  st.carState.obdSkipReason = null;
  st.carState.obdLastSeen = new Date().toISOString();
  st._ecuLastDataMs = Date.now();  // ECU 活跃时间戳

  // 疲劳驾车时 pushFatigueAlert 会写入 _carNotify，由 /api/query/state 消费
  // 此处仅回传已有通知（不删除），车机轮询 /api/query/state 才是唯一消费点
  const carNotify = st.carState._carNotify ?? null;
  return { statusCode: 200, body: { ok: true, carNotify: carNotify } };
}

/** POST /api/car/alert — 自定义提醒 */
function handleAlert(bodyStr) {
  const d = JSON.parse(bodyStr);
  // v6.25.1: 自定义提醒仅记录，不推送微信
  logInfo('ALERT', (d.message || '自定义提醒').substring(0, 50));
  return { statusCode: 200, body: { ok: true } };
}

/** POST /api/car/diag — 诊断数据接收 */
function handleDiag(bodyStr) {
  const d = JSON.parse(bodyStr);
  const label = (d.label || '诊断').replace(/[^a-zA-Z0-9_\u4e00-\u9fff\-]/g, '_');
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const diagPath = path.join(config.DIAG_DIR, `diag_${label}.txt`);
  const header = `=== ${label} | ${d.device || '?'} | Android ${d.android || '?'} | ${ts} ===`;
  try {
    if (!fs.existsSync(config.DIAG_DIR)) fs.mkdirSync(config.DIAG_DIR, { recursive: true });
    fs.writeFileSync(diagPath, header + '\n' + (d.output || ''), 'utf8');
    logInfo('CarDiag接收', `${label} | ${d.device} | ${(d.output||'').length}字符`);
    return { statusCode: 200, body: { ok: true } };
  } catch(e) {
    logWarn('diag write error', e.message);
    return { statusCode: 200, body: { ok: false, error: e.message } };
  }
}

// ====== 行程超时自动结束 ======

let _timeoutCheckerInterval = null;

/** 启动定时器：每分钟检查行程是否超时（30分钟无GPS更新自动结束） */
function startTripTimeoutChecker() {
  if (_timeoutCheckerInterval) return; // 防止重复启动

  _timeoutCheckerInterval = setInterval(() => {
    const st = storage;
    // 没有活跃行程 或 正在结束中 → 跳过
    if (!st.currentTrip.startTime || st.currentTrip._ending) return;
    // 没有 GPS 更新时间 → 跳过
    if (!st.carState.lastGpsUpdate) return;

    const idleMs = Date.now() - new Date(st.carState.lastGpsUpdate).getTime();
    if (idleMs >= config.TRIP_TIMEOUT_MS) {
      logInfo('行程超时',
        Math.floor(idleMs / 60000) + '分钟无GPS更新，自动结束行程');
      st.currentTrip._ending = true;
      const trip = st.currentTrip;
      const endLoc = trip.points.length > 0 ? trip.startLocation : '未知';

      // 超时结束 — 先计算统计，再推送
      const stats = calcStats(trip, st.carState.fuelConsumption || 0);
      if (stats) {
        stats.date = new Date().toISOString();
        stats.startLocation = trip.startLocation;
        stats.endLocation = endLoc;
        st.tripHistory.push(stats);
        if (st.tripHistory.length > 100) st.tripHistory = st.tripHistory.slice(-100);
        updateStats(stats);
       // v6.25.1: 超时结束 不推送
      }
      st.saveData();
      delete st.currentTrip._ending;
      st.currentTrip = {
        startTime: null, startLocation: '', points: [],
        fuelStart: 0, fatigueWarned: false,
        obdVoltageStart: null, obdTempStart: null, obdRpmStart: null
      };
    }
  }, config.TRIP_TIMEOUT_CHECK_MS);

  logInfo('行程超时检测已启动',
    '间隔=' + (config.TRIP_TIMEOUT_CHECK_MS / 1000) + 's 超时=' + (config.TRIP_TIMEOUT_MS / 60000) + 'min');

  // === ECU 断开/重连检测 ===
  const ECU_TIMEOUT_MS = 30_000;      // 30秒无 OBD 数据 → 判定 ECU 断开
  const ECU_WATCH_MS = 15_000;        // 每 15 秒检查一次
  let _ecuWatcherInterval = setInterval(() => {
    const last = storage._ecuLastDataMs || 0;
    const gap = Date.now() - last;
    const wasDisconnected = storage._ecuDisconnected === true;

    if (gap >= ECU_TIMEOUT_MS && !wasDisconnected) {
      // ECU 刚断开 → 结束当前行程 + 记录快照
      storage._ecuDisconnected = true;
      storage._ecuSnapshot = {
        disconnectedAt: new Date().toISOString(),
        fuelConsumption: storage.carState.fuelConsumption,
        fuelLevel: storage.carState.fuelLevel,
        engineRpm: storage.carState.engineRpm ?? null,
        obdSpeed: storage.carState.obdSpeed ?? 0,
        coolantTemp: storage.carState.coolantTemp ?? null,
        _desc: 'ECU 断开前最后数据'
      };

      // 结束当前行程
      if (storage.currentTrip.startTime && !storage.currentTrip._ending) {
        const trip = storage.currentTrip;
        storage.currentTrip._ending = true;
        finishTrip(trip, 'ECU断开', 0, 0);
      }

      logInfo('🔌 ECU断开', `油耗= ${storage._ecuSnapshot.fuelConsumption?.toFixed(2)}L ` +
        `油量=${storage._ecuSnapshot.fuelLevel?.toFixed(1)}% ` +
        `转速=${storage._ecuSnapshot.engineRpm}rpm 车速=${storage._ecuSnapshot.obdSpeed}km/h`);
    } else if (gap < ECU_TIMEOUT_MS && wasDisconnected && storage._ecuSnapshot) {
      // ECU 重连 → 对比
      const snap = storage._ecuSnapshot;
      const now = storage.carState;
      const fuelConsumed = (now.fuelConsumption || 0) - (snap.fuelConsumption || 0);
      const levelChange = (now.fuelLevel || 0) - (snap.fuelLevel || 0);
      logInfo('🔗 ECU重连',
        `断开前油量=${snap.fuelLevel?.toFixed(1)}% ` +
        `现在=${now.fuelLevel?.toFixed(1)}% ` +
        `差值=${levelChange.toFixed(1)}% ` +
        `离线油耗=${Math.abs(fuelConsumed).toFixed(2)}L ` +
        (snap._desc || ''));
      storage._ecuSnapshot._reconnectedAt = new Date().toISOString();
      storage._ecuSnapshot._deltaFuelConsumed = fuelConsumed;
      storage._ecuSnapshot._deltaFuelLevel = levelChange;
      storage._ecuDisconnected = false;
    }
  }, ECU_WATCH_MS);
  logInfo('ECU断开检测已启动', `超时=${ECU_TIMEOUT_MS/1000}s 检查=${ECU_WATCH_MS/1000}s`);
}

// ====== 加油重置 ======

function refuel() {
  const st = storage.carState;
  st.fuelConsumption = 0;
  st.fuelLevel = 100;
  st._fuelLevelRaw = 0;
  storage.saveData();
  logInfo('⛽ 加油重置', '油耗归零, 油量→100%');
  return { statusCode: 200, body: { fuelLevel: 100, fuelConsumption: 0 } };
}

module.exports = {
  handleStatus, handleStart, handleEnd, handleObd,
  // 工具函数 (供 server.js 调用)
  calibratedFuelLevel, addFuelSample, rollingAvgFuelPer100km, calcRange, getTripDuration,
  handleAlert, handleDiag, finishTrip,
  calcStats, updateStats, getTripsForPeriod,
  startTripTimeoutChecker, refuel
};
