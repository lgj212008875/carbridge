# ESP32 OBD 中继固件

用 ESP32 开发板替代 Android 手机运行 ObdRelay，蓝牙读取 ELM327 → WiFi 上报 VPS。

## 硬件要求

| 硬件 | 型号 | 说明 |
|------|------|------|
| 开发板 | **ESP32-WROOM-32** 开发板 | 必须经典蓝牙 SPP，❌ S3/C3 不支持 |
| OBD | ELM327 蓝牙版 | v1.5/v2.1 均可 |
| 供电 | Micro USB 车充 | 点烟器转 USB |

## 依赖库

Arduino IDE 中安装：

1. **ArduinoJson** → 库管理搜索 "ArduinoJson" (by Benoit Blanchon)
2. **BluetoothSerial** → ESP32 板包内置，无需安装

## 刷写步骤

1. 安装 Arduino IDE（https://www.arduino.cc/en/software）
2. 文件 → 首选项 → 附加开发板管理器网址，填入：
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. 工具 → 开发板 → 开发板管理器 → 搜索 `esp32` → 安装
4. 工具 → 开发板 → 选择 `ESP32 Dev Module`
5. USB 数据线连接电脑，选择端口
6. 打开 `esp32_obd_relay.ino`，修改配置（见下方）
7. 上传

## 配置修改

固件顶部 6 行常量，改成你自己的：

```cpp
const char* WIFI_SSID     = "你的车上WiFi名";        // 手机热点或随身WiFi
const char* WIFI_PASSWORD = "WiFi密码";
const char* VPS_URL       = "http://你的VPS_IP:8899";
const char* API_KEY       = "你的API密钥";
const char* OBD_MAC       = "13:E0:2F:8D:4C:FF";   // ELM327 蓝牙MAC
```

## 串口监视

上传后打开 工具 → 串口监视器（波特率 115200），应看到：

```
=== ESP32 OBD Relay ===
芯片: ESP32-D0WDQ6
蓝牙MAC: 13:E0:2F:8D:4C:FF
VPS: http://121.41.74.182:8899
WiFi 连接中: 你的WiFi
WiFi OK, IP: 192.168.1.100
蓝牙SPP就绪
蓝牙连接 OBD: 13:E0:2F:8D:4C:FF
  蓝牙已连接
初始化 ELM327...
  ELM327: ELM327 v1.5
初始化完成
开始轮询...
轮询中... loop=100 内存=234560B
```

## 上车安装

1. ESP32 用双面胶固定在中控台下方（避开金属遮挡）
2. Micro USB 插点烟器车充取电
3. 通电自动连接 WiFi + 蓝牙，无需任何操作

## 成本

| 物料 | 价格 |
|------|------|
| ESP32 开发板 | ¥18-25 |
| Micro USB 车充 | ¥10 |
| 双面胶 | ¥1 |
| **合计** | **~¥30** |

vs 备用 Android 手机（¥500+ / 夏天电池鼓包风险）

## 注意事项

- ❌ 不支持 ESP32-S3 / ESP32-C3（只有 BLE，无经典蓝牙 SPP）
- ⚠️ 避开大量金属遮挡（蓝牙信号衰减）
- ⚠️ 夏天车内高温可能导致板子不稳定，建议放在空调出风口附近
