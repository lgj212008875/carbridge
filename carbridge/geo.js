// CarBridge v4.5 — 地理工具
// ============================
// WGS84↔GCJ02 坐标转换、Haversine 距离、Nominatim 反向地理编码
// 北京时间工具函数

const https = require('https');
const config = require('./config');

// ====== WGS84→GCJ02 坐标转换（高德/腾讯地图坐标系） ======
// 纯数学算法，无需网络请求。中国境内偏差可修正到米级。

function wgs84ToGcj02(wgsLat, wgsLng) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
  const dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0);
  const dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0);
  const radLat = wgsLat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const dLat2 = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  const dLng2 = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: wgsLat + dLat2, lng: wgsLng + dLng2 };
}

/** 生成高德地图标记链接 */
function amapUrl(lat, lng, name) {
  const gcj = wgs84ToGcj02(lat, lng);
  return 'https://uri.amap.com/marker?position=' + gcj.lng.toFixed(6) + ',' + gcj.lat.toFixed(6)
    + '&name=' + encodeURIComponent(name || '车辆位置');
}

/** Haversine 公式计算两点间距（公里） */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const a = Math.sin((lat2-lat1)*Math.PI/180/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
    Math.sin((lon2-lon1)*Math.PI/180/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ====== 反向地理编码（Nominatim，免费无 API Key） ======
// 队列化：限速 1.5s/请求，防封禁。LRU 缓存已解析坐标。

let reverseGeoCache = new Map();
let _geoCacheKeyOrder = [];   // FIFO-LRU 淘汰顺序
let _geoLastRequestMs = 0;    // 上次请求时间
let _geoQueue = [];           // 待处理请求队列
let _geoQueueTimer = null;    // 队列消费定时器

function reverseGeo(lat, lng, callback) {
  const key = lat.toFixed(3) + ',' + lng.toFixed(3);
  if (reverseGeoCache.has(key)) {
    callback(reverseGeoCache.get(key));
    return;
  }
  _geoQueue.push({ lat, lng, callback });
  if (!_geoQueueTimer) _processGeoQueue();
}

function _processGeoQueue() {
  if (!_geoQueue.length) { _geoQueueTimer = null; return; }
  const wait = Math.max(0, 1500 - (Date.now() - _geoLastRequestMs));
  _geoQueueTimer = setTimeout(() => {
    if (!_geoQueue.length) { _geoQueueTimer = null; return; }
    _geoLastRequestMs = Date.now();
    const r = _geoQueue.shift();
    _reverseGeoDirect(r.lat, r.lng, r.callback);
  }, wait);
}

function _reverseGeoDirect(lat, lng, callback) {
  const key = lat.toFixed(3) + ',' + lng.toFixed(3);
  if (reverseGeoCache.has(key)) {
    const idx = _geoCacheKeyOrder.indexOf(key);
    if (idx >= 0) { _geoCacheKeyOrder.splice(idx, 1); _geoCacheKeyOrder.push(key); }
    callback(reverseGeoCache.get(key));
    return;
  }
  const opt = {
    hostname: 'nominatim.openstreetmap.org',
    port: 443,
    path: '/reverse?lat=' + lat + '&lon=' + lng + '&format=json&zoom=14&accept-language=zh',
    method: 'GET',
    headers: { 'User-Agent': 'CarBridge/4.0' },
    timeout: 5000
  };
  const req = https.request(opt, (res) => {
    let b = '';
    res.on('data', c => b += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(b);
        const name = j.display_name || key;
        _cacheGeo(key, name);
        callback(name);
      } catch(e) {
        const fallback = key;
        _cacheGeo(key, fallback);
        callback(fallback);
      }
    });
  });
  req.on('error', () => callback(key));
  req.on('timeout', () => { req.destroy(); callback(key); });
  req.end();
}

function _cacheGeo(key, value) {
  reverseGeoCache.set(key, value);
  _geoCacheKeyOrder.push(key);
  if (_geoCacheKeyOrder.length > config.MAX_GEO_CACHE) {
    reverseGeoCache.delete(_geoCacheKeyOrder.shift());
  }
}

/** 从 Nominatim display_name 提取城市名 */
function extractCity(displayName) {
  const m = displayName.match(/([\u4e00-\u9fff]+市)/);
  if (m) return m[1].replace('市', '');
  const m2 = displayName.match(/(北京|上海|天津|重庆)/);
  return m2 ? m2[1] : null;
}

// ====== 北京时间工具（纯 UTC 偏移，不依赖系统时区） ======

function beijingDateStr(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function beijingHour() {
  return new Date(Date.now() + 8 * 3600_000).getUTCHours();
}

function formatTime() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

/** 计算北京时间所在周数（纯 UTC，不依赖服务器系统时区） */
function getWeekNumber(realNow = new Date()) {
  const bjTs = realNow.getTime() + 8 * 3600_000;  // 北京时间毫秒（假UTC）
  const bjDate = new Date(bjTs);
  // 用 Date.UTC 构造年初，避免服务器本地时区偏移
  const startOfYear = Date.UTC(bjDate.getUTCFullYear(), 0, 1);
  const diff = bjTs - startOfYear;
  const jan1Day = new Date(startOfYear).getUTCDay();  // 1月1日是周几 (0=日)
  return Math.ceil((diff / 86400000 + jan1Day + 1) / 7);
}

/**
 * 计算指定日期的日出日落时间 (北京时间 HH:MM)
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @param {Date} date 日期 (默认今天)
 * @returns {{sunrise: string, sunset: string}} 北京时间
 */
function calcSunriseSunset(lat, lng, date) {
  const d = date ? new Date(date) : new Date(Date.now() + 8 * 3600_000);
  // 使用北京时间正午的UTC日序
  const bjNoon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 0, 0)); // 12:00 BJT = 04:00 UTC
  const doy = dayOfYear(bjNoon);
  
  // 太阳平均近点角
  const meanAnomaly = (357.5291 + 0.98560028 * (doy - 1)) % 360;
  const maRad = meanAnomaly * Math.PI / 180;
  
  // 方程中心
  const eqCenter = 1.9148 * Math.sin(maRad) + 0.02 * Math.sin(2 * maRad) + 0.0003 * Math.sin(3 * maRad);
  
  // 黄道经度
  const eclipticLng = (meanAnomaly + eqCenter + 180 + 102.9372) % 360;
  const elRad = eclipticLng * Math.PI / 180;
  
  // 太阳赤纬
  const declination = Math.asin(Math.sin(elRad) * Math.sin(23.44 * Math.PI / 180));
  
  // 时差 (分钟)
  const timeEq = 4 * (
    7.53 * Math.cos(maRad)
    + 1.5 * Math.sin(maRad)
    - 9.87 * Math.sin(2 * maRad)
  );
  
  // 日出/日落时角
  const latRad = lat * Math.PI / 180;
  const cosHa = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(latRad) * Math.sin(declination))
    / (Math.cos(latRad) * Math.cos(declination));
  
  // 极昼/极夜保护
  let haDeg;
  if (cosHa > 1) haDeg = 0;     // 极夜
  else if (cosHa < -1) haDeg = 180; // 极昼
  else haDeg = Math.acos(cosHa) * 180 / Math.PI;
  
  // 正午 UTC 分钟
  const solarNoonUtc = 720 - 4 * lng - timeEq;
  const sunriseUtc = solarNoonUtc - 4 * haDeg;
  const sunsetUtc = solarNoonUtc + 4 * haDeg;

  // 转为北京时间
  const sunriseBjt = (sunriseUtc + 480) % 1440; // UTC→BJT +8h=480min
  const sunsetBjt = (sunsetUtc + 480) % 1440;
  
  const fmt = (mins) => {
    const h = Math.floor(mins / 60) % 24;
    const m = Math.round(mins % 60);
    return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  };
  
  return { sunrise: fmt(sunriseBjt), sunset: fmt(sunsetBjt) };
}

function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return Math.floor((date.getTime() - start) / 86400000);
}

/**
 * 判断当前是否夜间
 * @param {number} lat 纬度
 * @param {number} lng 经度
 * @returns {boolean} true=夜间
 */
function isNightNow(lat, lng) {
  if (!lat || !lng || Math.abs(lat) < 0.01) {
    // 无 GPS, 用北京时间 6:00-18:00 兜底
    const h = beijingHour();
    return h < 6 || h >= 18;
  }
  const { sunrise, sunset } = calcSunriseSunset(lat, lng);
  const now = beijingHour() * 60 + new Date(Date.now() + 8 * 3600_000).getUTCMinutes();
  const riseMins = parseInt(sunrise.split(':')[0]) * 60 + parseInt(sunrise.split(':')[1]);
  const setMins = parseInt(sunset.split(':')[0]) * 60 + parseInt(sunset.split(':')[1]);
  return now < riseMins || now >= setMins;
}

module.exports = {
  wgs84ToGcj02, amapUrl, haversine,
  reverseGeo, extractCity,
  beijingDateStr, beijingHour, formatTime, getWeekNumber,
  calcSunriseSunset, isNightNow
};
