// CarBridge v6.25.1 — 车机推送中转服务 入口
// =========================================
// HTTP 路由分发、鉴权、统一错误处理
// v6.25.1: 移除 push.js, 微信推送由 OpenClaw cron 负责

const http = require('http');
const url = require('url');
const config = require('./config');
const { logInfo, logWarn } = require('./logger');
const storage = require('./storage');
const { handleStatus, handleStart, handleEnd, handleObd,
        handleAlert, handleDiag, getTripsForPeriod, startTripTimeoutChecker,
        calcRange, rollingAvgFuelPer100km,
        getTripDuration, refuel, calibratedFuelLevel } = require('./trip');
const { fetchFuelPrice, handleCalibration } = require('./fuel');
const { beijingDateStr, beijingHour, isNightNow } = require('./geo');

// ====== HTTP 服务 ======

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const routePath = parsed.pathname;
  const authOk = parsed.query.key === config.PUSH_KEY;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 鉴权（/health /api/query/pid_config /api/query/pid_scan /api/query/ui_config /api/query/state 跳过）
  if (!authOk && routePath !== '/health' && routePath !== '/api/query/pid_config' && routePath !== '/api/query/pid_scan' && routePath !== '/api/query/ui_config' && routePath !== '/api/query/state') {
    logWarn('Auth 401', routePath + ' key=***');
    res.writeHead(401); res.end('Unauthorized'); return;
  }

  // 请求体读取（限制大小）
  let body = '', bodyLen = 0;
  let destroyed = false;
  req.on('data', chunk => {
    bodyLen += chunk.length;
    if (bodyLen > config.MAX_BODY) {
      if (!destroyed) {
        destroyed = true;
        json(res, 413, { error: 'Payload too large' });
      }
      req.destroy(); return;
    }
    body += chunk;
  });

  req.on('end', () => {
    if (destroyed) return;
    route(routePath, body, req, res).catch(e => {
      logWarn('HTTP ERR', e.message);
      try { json(res, 500, { error: e.message }); } catch(_) {}
    });
  });
});

// ====== 辅助: 统计日/月/年里程和油费 ======

function getDailyStats() {
  const today = beijingDateStr();
  const trips = getTripsForPeriod(today, 'day');
  let km = 0, fuel = 0;
  for (const t of trips) { km += t.mileage || 0; fuel += t.fuelUsed || 0; }
  // 累加当前进行中的行程 (未结束的行程不在 tripHistory 中)
  const cur = getCurrentTripDelta();
  km += cur.km; fuel += cur.fuel;
  return { km: Math.round(km * 100) / 100, fuel: Math.round(fuel * 100) / 100,
           cost: Math.round(fuel * storage.fuelState.price * 100) / 100 };
}

function getMonthlyStats() {
  const bjNow = new Date(Date.now() + 8 * 3600_000);
  const month = bjNow.getFullYear() + '-' + String(bjNow.getMonth() + 1).padStart(2, '0');
  const trips = getTripsForPeriod(month, 'month');
  let km = 0, fuel = 0;
  for (const t of trips) { km += t.mileage || 0; fuel += t.fuelUsed || 0; }
  // 累加当前进行中的行程
  const cur = getCurrentTripDelta();
  km += cur.km; fuel += cur.fuel;
  return { km: Math.round(km * 100) / 100, fuel: Math.round(fuel * 100) / 100,
           cost: Math.round(fuel * storage.fuelState.price * 100) / 100 };
}

// 当前活跃行程的里程与油耗增量
function getCurrentTripDelta() {
  const trip = storage.currentTrip;
  if (!trip.startTime) return { km: 0, fuel: 0 };
  const km = trip.liveDistanceKm || 0;
  const fuel = Math.max(0, (storage.carState.fuelConsumption || 0) - (trip.fuelStart || 0));
  return { km, fuel };
}

function getTripFuelCost() {
  // 本次行程油耗费用 = 行程开始后消耗的燃油 × 油价
  const trip = storage.currentTrip;
  if (!trip.startTime) return 0;
  const fuelCons = storage.carState.fuelConsumption || 0;
  const fuelStart = trip.fuelStart || 0;
  const tripFuel = Math.max(0, fuelCons - fuelStart);
  return Math.round(tripFuel * storage.fuelState.price * 100) / 100;
}

// 加到满需要的费用
function getFillUpCost() {
  const fuelLvl = storage.carState.fuelLevel;
  if (fuelLvl == null || fuelLvl >= 100) return 0;
  const remainingPct = (100 - fuelLvl) / 100;
  return Math.round(remainingPct * config.TANK_CAPACITY * storage.fuelState.price * 100) / 100;
}

// ====== 路由分发 ======

async function route(routePath, body, req, res) {
  let result;

  switch (routePath) {
    case '/api/car/status':
      result = handleStatus(body);
      break;
    case '/api/car/start':
      result = await handleStart(body);
      break;
    case '/api/car/end':
      result = await handleEnd(body);
      break;
    case '/api/car/alert':
      result = handleAlert(body);
      break;
    case '/api/car/diag':
      result = handleDiag(body);
      break;
    case '/api/car/obd':
      result = handleObd(body);
      break;
    case '/api/car/calibration':
      result = handleCalibration(body);
      break;
    case '/api/car/refuel':
      result = refuel();
      break;

    // --- 查询接口 ---
    case '/api/query/state': {
      const od = storage.carState.obdData || {};
      const daily = getDailyStats();
      const monthly = getMonthlyStats();
      const fuelLvl = storage.carState.fuelLevel;  // 由累计油耗反推
      const avgFuel = rollingAvgFuelPer100km();
      const resp = {
        // 行程状态
        inTrip: !!storage.currentTrip.startTime,
        tripStartedAt: storage.currentTrip.startTime
          ? new Date(storage.currentTrip.startTime).getTime() : 0,
        // 仪表盘 10 项（全部 ?? null 确保 0 不被吞、字段永不缺失）
        engineRpm: storage.carState.engineRpm ?? null,
        obdSpeed: storage.carState.obdSpeed ?? storage.carState.obdData?.obdSpeed ?? 0,
        coolantTemp: storage.carState.coolantTemp ?? null,
        engineLoad: storage.carState.obdData?.engineLoad ?? null,
        fuelPer100km: storage.carState.fuelPer100km ?? null,
        fuelLevel: fuelLvl ?? null,
        remainingRange: (() => { if (fuelLvl == null) return null; const r = calcRange(fuelLvl, avgFuel); return r != null ? Math.round(r) : null; })(),
        tripDistanceKm: Math.round((storage.currentTrip.liveDistanceKm || 0) * 100) / 100,
        tripDuration: getTripDuration(),
        tripFuelCost: getTripFuelCost(),
        fillUpCost: getFillUpCost(),
        dailyDistanceKm: daily.km,
        dailyFuelCost: daily.cost,
        monthlyDistanceKm: monthly.km,
        monthlyFuelCost: monthly.cost,
        fuelPrice: storage.fuelState.price,
        carNotify: storage.carState._carNotify ?? null,
        isNight: isNightNow(storage.carState.lat, storage.carState.lng)
      };
      if (storage.carState._carNotify) delete storage.carState._carNotify;
      // ECU 断开快照 — 始终带上字段（null 表示无断连记录）
      resp._ecuSnapshot = storage._ecuSnapshot ?? null;
      json(res, 200, resp);
      return;
    }
    case '/api/query/trips': {
      const limit = parseInt(url.parse(req.url, true).query.limit) || 5;
      json(res, 200, { ok: true, data: storage.tripHistory.slice(-limit) });
      return;
    }
    case '/api/query/current':
      json(res, 200, { ok: true,
        inTrip: !!storage.currentTrip.startTime,
        data: storage.currentTrip });
      return;
    case '/api/query/pid_scan': {
      // 扫描报告: 哪些 PID 有数据, 哪些返回 7F
      const scan = storage.carState._pidScan || {};
      json(res, 200, { ok: true, scan });
      return;
    }
    case '/api/query/pid_config': {
      json(res, 200, { pids: config.SCAN_PID_LIST });
      return;
    }
    case '/api/query/ui_config': {
      json(res, 200, config.DASHBOARD);
      return;
    }
    case '/api/query/stats':
      // 返回日/周/月/年统计（供 OpenClaw 生成微信推送）
      json(res, 200, {
        ok: true,
        daily: storage.tripStats.daily,
        weekly: storage.tripStats.weekly,
        monthly: storage.tripStats.monthly,
        yearly: storage.tripStats.yearly,
        fuelPrice: storage.fuelState.price,
        tripsToday: getTripsForPeriod(beijingDateStr(), 'day')
      });
      return;

    // --- 健康检查 ---
    case '/health': {
      const mem = process.memoryUsage();
      json(res, 200, {
        status: 'ok',
        version: config.VERSION,
        uptime: process.uptime().toFixed(0),
        memoryMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
        totalTrips: storage.tripHistory.length,
        fuelPrice: storage.fuelState.price
      });
      return;
    }

    default:
      json(res, 404, { error: 'Not found' });
      return;
  }

  if (result) json(res, result.statusCode, result.body);
}

// ====== 辅助函数 ======

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ====== 启动 ======

storage.loadData();
startTripTimeoutChecker();

// 油价定时刷新（每 6 小时）
setInterval(() => {
  if (storage.fuelState.city) fetchFuelPrice(storage.fuelState.city);
}, 6 * 3600_000);

// 启动 HTTP 服务
server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`🚗 CarBridge v6.25.1 | Port: ${config.PORT} | Data: ${config.DATA_DIR}`);
});

// ====== 优雅退出 ======
process.on('SIGTERM', () => { storage.saveDataSync(); process.exit(0); });
process.on('SIGINT', () => { storage.saveDataSync(); process.exit(0); });
process.on('uncaughtException', (err) => {
  logWarn('uncaughtException', err.message);
  storage.saveDataSync();
  process.exit(1);
});
