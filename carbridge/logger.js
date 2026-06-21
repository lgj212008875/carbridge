// CarBridge v4.5 — 日志系统
// ============================
// 每日日志文件轮转 + 7天自动清理
// WARN 级别同时输出到 stderr，方便 PM2 捕获

const fs = require('fs');
const path = require('path');
const config = require('./config');

// 确保日志目录存在
[config.LOG_DIR, config.DIAG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/** 启动时清理 7 天前的日志文件（含 diag 子目录） */
(function cleanupOldLogs() {
  try {
    const now = Date.now();
    // 主日志目录
    const files = fs.readdirSync(config.LOG_DIR);
    for (const f of files) {
      const fp = path.join(config.LOG_DIR, f);
      if (f.endsWith('.log') && (now - fs.statSync(fp).mtimeMs > 7 * 86400_000)) {
        fs.unlinkSync(fp);
        process.stdout.write('[LOG] 清理旧日志: ' + f + '\n');
      }
    }
    // diag 子目录清理（30天，防 OBD 诊断日志无限增长）
    if (fs.existsSync(config.DIAG_DIR)) {
      const diagFiles = fs.readdirSync(config.DIAG_DIR);
      for (const f of diagFiles) {
        const fp = path.join(config.DIAG_DIR, f);
        if (now - fs.statSync(fp).mtimeMs > 30 * 86400_000) {
          fs.unlinkSync(fp);
          process.stdout.write('[LOG] 清理旧诊断: ' + f + '\n');
        }
      }
    }
  } catch(e) { /* 忽略清理异常 */ }
})();

/**
 * 写入日志行
 * @param {'INFO'|'WARN'} level
 * @param {string} msg   主消息
 * @param {string} [detail] 可选的附加详情
 */
function writeLog(level, msg, detail) {
  // 北京时间 ISO 格式 (UTC+8)
  const now = new Date(Date.now() + 8 * 3600_000);
  const ts = now.toISOString().replace('Z', '+08');
  const line = '[' + ts + '] ' + level + '  ' + msg + (detail ? ' | ' + detail : '') + '\n';
  // WARN 级别双写：stdout + stderr
  if (level === 'WARN') process.stderr.write(line);
  else process.stdout.write(line);
  // 写入当日日志文件
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(config.LOG_DIR, today + '.log');
  try { fs.appendFileSync(logPath, line); } catch(e) {}
}

/** INFO 日志 */
function logInfo(msg, detail) { writeLog('INFO', msg, detail); }

/** WARN 日志 */
function logWarn(msg, detail) { writeLog('WARN', msg, detail); }

module.exports = { writeLog, logInfo, logWarn };
