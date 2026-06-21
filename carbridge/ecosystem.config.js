// CarBridge v6.25.1 — PM2 进程管理配置 (MIT License)
// ======================================================
// 开源版使用相对路径, 生产部署改成绝对路径
// 部署: cd carbridge && pm2 start ecosystem.config.js
// 或:   pm2 start server.js --name carbridge

module.exports = {
  apps: [{
    name: 'carbridge',
    script: './server.js',
    cwd: __dirname,
    watch: false,
    max_restarts: 20,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
