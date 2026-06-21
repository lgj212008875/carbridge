// CarBridge v4.5 — 油价与油耗校准
// ====================================
// 从本地宝拉取实时 92# 油价
// 加油校准：加权平均计算 OBD 油耗修正系数

const https = require('https');
const config = require('./config');
const { logInfo, logWarn } = require('./logger');
const { extractCity } = require('./geo');

// 延迟获取 storage，避免启动时的循环依赖
let storage = null;
function getStorage() {
  if (!storage) storage = require('./storage');
  return storage;
}

// ====== 城市→本地宝子域名 ======

function getBendibaoDomain(cityName) {
  return config.CITY_DOMAIN_MAP[cityName] || null;
}

// ====== 实时油价拉取 ======

function fetchFuelPrice(cityName) {
  // 尝试多种来源确定城市
  let city = cityName;
  const st = getStorage();
  if (!city) city = st.fuelState.city;
  if (!city) return; // 没有城市信息，跳过

  const subdomain = getBendibaoDomain(city);
  const hostname = subdomain ? subdomain + '.bendibao.com' : 'm.bendibao.com';

  const opts = {
    hostname: hostname,
    path: '/news/youjiachaxun/',
    method: 'GET',
    timeout: 10000
  };

  const req = https.get(opts, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) { logWarn('油价拉取 HTTP ' + res.statusCode); return; }
      try {
        // 解析页面中的 oilData JS 变量
        const match = data.match(/var oilData = ({[^;]+})/);
        if (!match) { logWarn('油价解析失败', '未找到 oilData'); return; }
        const oilData = JSON.parse(match[1]);
        const idx92 = oilData.data.findIndex(d => d.name.includes('92'));
        if (idx92 < 0) { logWarn('油价解析失败', '未找到92号汽油'); return; }
        const prices = oilData.data[idx92].list;
        const latest = parseFloat(prices[prices.length - 1]);
        if (latest > 0) {
          st.fuelState.price = latest;
          st.fuelState.time = new Date().toISOString();
          st.fuelState.city = city;
          st.fuelState.subdomain = subdomain || 'm';
          st.saveData();
          logInfo('油价更新', city + ' 92# = ¥' + st.fuelState.price + '/L (本地宝)');
        }
      } catch(e) { logWarn('油价异常', e.message); }
    });
  });
  req.on('error', (e) => logWarn('油价拉取错误', e.message));
  req.on('timeout', () => { req.destroy(); logWarn('油价拉取超时'); });
}

// ====== 油耗校准 ======

/**
 * 处理加油校准请求
 * POST /api/car/calibration
 * Body: { tag, actualLiters, cumulativeFuel, ... }
 * 校准公式: 加权平均(实际加油量 / APP累计油耗)
 * @returns {{statusCode: number, body: object}}
 */
function handleCalibration(bodyStr) {
  const st = getStorage();
  const d = JSON.parse(bodyStr);
  d.receivedAt = new Date().toISOString();

  st.carState._calibrations = st.carState._calibrations || [];
  st.carState._calibrations.push(d);
  // 保留最近 N 条（与 config.CALIBRATION_MAX 一致）
  if (st.carState._calibrations.length > config.CALIBRATION_MAX) {
    st.carState._calibrations = st.carState._calibrations.slice(-config.CALIBRATION_MAX);
  }

  // 计算校准系数: 实际加油量 / APP累计油耗
  const pairs = st.carState._calibrations
    .filter(c => c.actualLiters > 0 && c.cumulativeFuel > 0 && c.tag === '满油')
    .map(c => ({
      ratio: parseFloat(c.actualLiters) / parseFloat(c.cumulativeFuel),
      fuel: parseFloat(c.cumulativeFuel)
    }));

  if (pairs.length > 0) {
    // 加权平均: 加油量越大权重越高
    const totalWeight = pairs.reduce((s, p) => s + p.fuel, 0);
    st.carState._fuelCalibCoeff = pairs.reduce((s, p) => s + p.ratio * p.fuel, 0) / totalWeight;
  }
  const coeff = st.carState._fuelCalibCoeff || 1.0;

  logInfo('油耗校准',
    `${d.tag || '?'} | 累计=${d.cumulativeFuel}L | ` +
    (d.actualLiters ? `实际=${d.actualLiters}L` : '标记') +
    ` | coeff=${coeff.toFixed(3)} | 样本数=${pairs.length}`);

  st.saveData(); // 校准后立即持久化

  return {
    statusCode: 200,
    body: {
      ok: true,
      coefficient: coeff,
      samples: pairs.length,
      idleCoeff: st.carState._fuelCalibIdleCoeff || 1.0,
      cruiseCoeff: st.carState._fuelCalibCruiseCoeff || 1.0,
      wotCoeff: st.carState._fuelCalibWotCoeff || 1.15
    }
  };
}

module.exports = { fetchFuelPrice, handleCalibration, getBendibaoDomain };
