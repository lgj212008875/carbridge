# CarBridge

> 开源车载 OBD-II 实时数据仪表盘系统

**CarBridge** 通过 ELM327 蓝牙 OBD 读取车辆实时数据，在 Android 车机上展示精致的仪表盘。

```
┌──────────┐   ELM327 Bluetooth   ┌──────────┐   HTTP/JSON   ┌──────────┐
│ ObdRelay │ ── raw hex POST ──▶  │ VPS      │ ── /api/     │ CarAgent │
│ (手机)   │   fire-and-forget    │ (自建)   │   query/ ▶   │ (车机)   │
│          │                      │ Node.js  │   200ms       │ Android  │
│ 后台转发 │                      │ 解析存储 │              │ 纯仪表盘 │
└──────────┘                      └──────────┘              └──────────┘
```

## 特性

- **三端分离架构**：手机只转发不解析 → VPS 全盘计算 → 车机纯显示
- **10 项仪表盘数据**：转速/车速/水温/负荷/油量/瞬时油耗/续航/里程/时长/油费
- **自动行程判定**：ECU 连接即开始，断开 30s 即结束
- **MAF 优先油耗估算** → 负载×转速兜底（适配不支持 0x5E 的 ECU）
- **EMA 车速平滑** — 告别跳动的数字
- **怠速分情景油耗**（冷车/热车/空调）
- **日落日出自动日夜 UI 切换**（系统 → 天文 → 日历三级兜底）
- **农历时间显示**（纯查表算法，零依赖）
- **200ms 刷新率** — 适配低端车机（紫光展锐 7870）
- **零外部依赖 Kotlin**：HttpURLConnection + org.json，无 OkHttp/Gson

## 硬件需求

| 设备 | 说明 |
|------|------|
| ELM327 蓝牙适配器 | OBD-II 协议（推荐 v2.1 以上） |
| Android 手机 **或 ESP32** | 手机安装 ObdRelay；ESP32 可替代（仅需蓝牙+WiFi） |
| Android 车机 | 可自由安装 APK 的原生系统车机 |
| Linux VPS | Node.js v24+，2核 1G 即可 |

### 🤔 为什么不在车机上直接装 OBD App？

大部分 Android 车机的蓝牙**只支持免提通话和音频播放**，系统裁剪掉了蓝牙 SPP（串口协议）。即使少数车机支持，蓝牙芯片同时连 OBD ELM327 和手机打电话会冲突。

CarBridge 把"读 OBD"这件事拆出来，交给手机（或 ESP32）单独处理，车机只负责展示 UI——各司其职，互不干扰。

## 快速开始

### 1. 部署 VPS

```bash
# 安装依赖
cd carbridge && npm install

# 配置
# 编辑 config.js，修改 YOUR_VPS_IP 和 YOUR_CARBRIDGE_API_KEY
# 或在环境变量中设置:
export CARBRIDGE_PUSH_KEY="your-secret-key"

# 启动（PM2 推荐）
pm2 start ecosystem.config.js
```

### 2. 部署手机端 (ObdRelay)

1. 修改 `app/src/obdrelay/java/com/carbridge/obd/ObdRelayService.kt`：
   - `YOUR_ELM327_MAC_ADDRESS` → 你的 ELM327 蓝牙 MAC
   - `YOUR_VPS_IP` → 你的 VPS IP
2. 修改协议（如非协议5）：
   - `AT SP5` → `AT SP0`（自动检测协议）
3. 编译：`./gradlew assembleObdrelayRelease`
4. 安装到手机，授予蓝牙/位置权限，启动服务

### 3. 部署车机端 (CarAgent)

1. 修改 API 地址：`MainActivity.kt` 中的 `YOUR_VPS_IP`
2. 编译：`./gradlew assembleCaragentRelease`
3. 安装 APK 到车机

### 💡 进阶：ESP32 替代手机

ObdRelay 只做蓝牙→HTTP 转发，不依赖 GPS。如果你不想占用一台手机，可以用 ESP32 开发板替代：

- ESP32 支持 Bluetooth Classic (SPP) → 直连 ELM327
- WiFi 连车载热点/随身WiFi → HTTP POST 到 VPS
- 不需要 GPS 模块（CarAgent 车机自带 GPS）
- 预计成本 ~¥30，固件量 ~200 行 Arduino 代码

> 📡 **联网依赖**：ESP32 仅支持 WiFi，需确保车上已有 WiFi 热点（随身WiFi / 车机热点）。

### 配置指引

## 项目结构

```
carbridge/              # VPS 服务端 (Node.js)
├── server.js           # HTTP 路由 · 鉴权
├── trip.js             # OBD 解析引擎 · 行程判定
├── storage.js          # 状态管理 · JSON 持久化
├── fuel.js             # 油耗校准 · 油价拉取
├── geo.js              # 坐标转换 · 日出日落
├── logger.js           # 日志输出
├── config.js           # 集中配置
└── ecosystem.config.js # PM2 配置

carbridge_app/          # Android 客户端
├── app/src/caragent/   # 车机仪表盘
│   ├── MainActivity.kt     # UI · 日夜切换 · 农历
│   ├── CarAgentService.kt  # 前台服务 · GPS
│   ├── BootReceiver.kt     # 开机自启
│   └── ConfigActivity.kt   # 配置界面
├── app/src/obdrelay/   # 手机 OBD 转发
│   ├── ObdRelayService.kt  # 蓝牙 · 轮询 · 转发
│   └── MainActivity.kt     # 启停控制
└── app/build.gradle.kts   # 编译配置
```

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/query/state` | 仪表盘 10 项核心数据 |
| `GET /api/query/pid_config` | 活跃 PID 列表 |
| `POST /api/car/obd` | 接收手机 raw hex（需鉴权） |
| `POST /api/car/refuel` | 加油重置（需鉴权） |

## PID 说明

当前活跃 PID（可修改 `config.js` 中 `SCAN_PID_LIST`）：

| PID | 数据 | 公式 |
|-----|------|------|
| 0x0D | 车速 | km/h |
| 0x0C | 转速 | rpm |
| 0x04 | 负荷 | % |
| 0x05 | 水温 | °C |
| 0x10 | MAF | g/s（油耗优先数据源） |
| ... | ... | ... |

**油耗估算**：MAF→L/h 优先，不支持则用负载×转速×排量估算。

## 油量校准

首次使用时需要校准油量系数：

1. 加满油 → 调用 `POST /api/car/refuel`
2. 行驶至 75% / 50% / 25% 油表位置 → 加满
3. 调用 `POST /api/car/calibration`，提交实际加油量
4. 系统自动调整校准系数

## 开源协议

MIT License — 详见 [LICENSE](LICENSE)

## 安全提醒

> ⚠️ 本项目默认使用 HTTP 明文通信。部署到公网时，强烈建议配置 Nginx SSL 反向代理启用 HTTPS，保护 API Key 和行车数据不被窃听。

## 免责声明

本项目仅供学习和研究使用。行车安全第一，请勿在驾驶时操作屏幕。
