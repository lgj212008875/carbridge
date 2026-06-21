// ============================================================
// ESP32 OBD Relay Firmware — 替代 Android ObdRelay
// ============================================================
// 功能: Bluetooth SPP 连接 ELM327 → 轮询 OBD PID → HTTP POST 到 VPS
// 芯片: ESP32-WROOM-32 (必须经典蓝牙 SPP, S3/C3 不支持)
// 依赖: ArduinoJson, BluetoothSerial (内置)
//
// 配置方法:
//   1. 修改下方 WIFI_* / VPS_* / OBD_MAC
//   2. Arduino IDE 选 "ESP32 Dev Module"
//   3. 安装库: ArduinoJson (by Benoit Blanchon)
//   4. 编译上传, 串口监视器看日志
// ============================================================

#include <WiFi.h>
#include <BluetoothSerial.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ==================== 配置 (修改这里) ====================
const char* WIFI_SSID     = "YOUR_WIFI_SSID";      // 车上WiFi热点名
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";   // WiFi密码

const char* VPS_URL       = "http://YOUR_VPS_IP:8899";
const char* API_KEY       = "YOUR_CARBRIDGE_API_KEY";
const char* OBD_MAC       = "YOUR_ELM327_MAC";      // 格式: "13:E0:2F:8D:4C:FF"

// ==================== OBD PID 列表 ====================
// 启动时从 VPS 拉取, 拉不到用此兜底
const uint8_t PID_LIST[] = {
  0x0D,  // 车速
  0x0C,  // 转速
  0x04,  // 负荷
  0x05,  // 水温
  0x0B,  // 进气歧管压力 MAP
  0x0F,  // 进气温度
  0x10,  // 空气流量 MAF
  0x11,  // 节气门位置
  0x06,  // 短时燃油修正 STFT
  0x07,  // 长时燃油修正 LTFT
  0x0E,  // 点火提前角
  0x33,  // 大气压力
  0x42,  // 电瓶电压
  0x43,  // 绝对负荷值
  0x44,  // 空燃比当量
  0x0A   // 燃油压力
};
const int PID_COUNT = sizeof(PID_LIST) / sizeof(PID_LIST[0]);

// ==================== 全局状态 ====================
BluetoothSerial SerialBT;
bool obdConnected = false;
unsigned long lastReconnectAttempt = 0;
int loopCount = 0;

// ==================== 连接 WiFi ====================
void connectWiFi() {
  Serial.print("WiFi 连接中: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("WiFi OK, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi 失败, 继续尝试...");
  }
}

// ==================== 连接 ELM327 (蓝牙 SPP) ====================
bool connectOBD() {
  if (obdConnected) return true;

  Serial.print("蓝牙连接 OBD: ");
  Serial.println(OBD_MAC);

  // 解析 MAC 地址
  uint8_t mac[6];
  sscanf(OBD_MAC, "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx",
         &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]);

  // BluetoothSerial 的 connect(address) 需要 MAC 数组
  // 注意: ESP32 Arduino BluetoothSerial 支持 connect(uint8_t*) 和 connect(String)
  if (!SerialBT.connect(mac)) {
    // 备用方式: 用字符串连接
    Serial.println("  地址连接失败, 尝试字符串...");
    if (!SerialBT.connect(OBD_MAC)) {
      Serial.println("  蓝牙连接失败");
      return false;
    }
  }

  Serial.println("  蓝牙已连接");
  obdConnected = true;
  return true;
}

// ==================== 发送 AT 命令并读取响应 ====================
String sendCommand(const char* cmd, unsigned long timeoutMs = 1500) {
  // 清空缓冲区
  while (SerialBT.available() > 0) SerialBT.read();

  // 发送命令
  SerialBT.print(cmd);
  SerialBT.print("\r");
  SerialBT.flush();

  // 读取响应直到 '>' 或超时
  String resp;
  unsigned long deadline = millis() + timeoutMs;

  while (millis() < deadline) {
    while (SerialBT.available() > 0) {
      char ch = SerialBT.read();
      if (ch == '>') return resp;  // ELM327 提示符
      if (ch == '\r' || ch == '\n') {
        if (resp.length() > 0 && resp[resp.length() - 1] != '\n')
          resp += '\n';
      } else if (ch >= 32) {
        resp += ch;
      }
    }
    delay(10);
  }
  return resp;
}

// ==================== 发送 AT 并检查 OK ====================
bool sendAt(const char* cmd, unsigned long waitMs = 800) {
  String resp = sendCommand(cmd, waitMs);
  bool ok = resp.indexOf("OK") >= 0 || resp.length() > 0;
  if (!ok) {
    Serial.print("  AT ");
    Serial.print(cmd);
    Serial.print(" 异常: ");
    Serial.println(resp);
  }
  delay(waitMs / 2);  // 命令间短暂间隔
  return ok;
}

// ==================== 初始化 ELM327 ====================
bool initializeELM() {
  Serial.println("初始化 ELM327...");

  sendAt("AT Z", 4000);   // 复位
  delay(600);
  sendAt("AT E0", 800);   // 关回显
  sendAt("AT L0", 500);   // 关换行
  sendAt("AT H0", 500);   // 关CAN头
  sendAt("AT S0", 500);   // 关空格
  sendAt("AT SP 5", 2000); // KWP2000 Fast

  String ver = sendCommand("AT I", 1500);
  if (ver.length() > 0) {
    Serial.print("  ELM327: ");
    Serial.println(ver);
  }

  Serial.println("初始化完成");
  return true;
}

// ==================== HTTP POST (fire-and-forget) ====================
void postToVPS(const char* path, const String& jsonBody) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(VPS_URL) + path;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  int code = http.POST(jsonBody);
  // fire-and-forget: 不管结果
  if (code < 0) {
    Serial.print("  POST 失败: ");
    Serial.println(code);
  }
  http.end();
}

// ==================== 拉取云端 PID 配置 ====================
void fetchPidConfig() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(VPS_URL) + "/api/query/pid_config";

  http.begin(url);
  http.setTimeout(5000);

  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    StaticJsonDocument<1024> doc;
    DeserializationError err = deserializeJson(doc, body);
    if (!err) {
      JsonArray pids = doc["pids"];
      if (pids.size() > 0) {
        Serial.print("云端PID配置: ");
        Serial.print(pids.size());
        Serial.println(" 个");
        // ESP32 可在这里更新全局 PID 列表 (简化版用静态列表)
        // 完整版需用 vector 或动态分配
      }
    }
  } else {
    Serial.print("PID配置拉取失败, 用本地");
    Serial.print(PID_COUNT);
    Serial.println("个");
  }
  http.end();
}

// ==================== 读取一个 PID 并上报 ====================
bool readAndReportPID(uint8_t pid) {
  char cmd[8];
  snprintf(cmd, sizeof(cmd), "01 %02X", pid);
  String resp = sendCommand(cmd, 1500);
  if (resp.length() == 0) return false;

  // 检查错误响应
  const char* errors[] = {
    "NO DATA", "SEARCHING", "ERROR",
    "UNABLE TO CONNECT", "CAN ERROR", "BUS INIT", "STOPPED"
  };
  for (const char* e : errors) {
    if (resp.indexOf(e) >= 0) return false;
  }

  // 提取 41XX 行 (有效 hex)
  char prefix[8];
  snprintf(prefix, sizeof(prefix), "41%02X", pid);
  bool found = false;
  String hex;

  int start = 0;
  while (start < resp.length()) {
    int end = resp.indexOf('\n', start);
    if (end < 0) end = resp.length();

    String line = resp.substring(start, end);
    line.trim();
    line.replace(" ", "");  // 去空格

    // 检查是否纯 hex 且以 41XX 开头
    bool isHex = true;
    for (int i = 0; i < line.length(); i++) {
      char c = line[i];
      if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f'))) {
        isHex = false;
        break;
      }
    }
    if (isHex && line.startsWith(prefix)) {
      hex = line;
      found = true;
      break;
    }

    start = end + 1;
  }

  if (!found) return false;

  // 构造 JSON 上报
  char pidStr[4];
  snprintf(pidStr, sizeof(pidStr), "%02X", pid);

  StaticJsonDocument<256> doc;
  doc["_type"] = "raw";
  doc[pidStr] = hex;

  String body;
  serializeJson(doc, body);

  char url[128];
  snprintf(url, sizeof(url), "/api/car/obd?key=%s", API_KEY);
  postToVPS(url, body);

  return true;
}

// ==================== 主轮询循环 ====================
void pollingLoop() {
  int consecutiveNoData = 0;
  Serial.println("开始轮询...");

  while (obdConnected && SerialBT.connected()) {
    bool ecuResponded = false;

    for (int i = 0; i < PID_COUNT; i++) {
      if (!obdConnected) return;

      bool ok = readAndReportPID(PID_LIST[i]);
      if (ok) {
        ecuResponded = true;
        consecutiveNoData = 0;
      }
    }

    loopCount++;

    // ECU 失联检测: 连续30轮无数据 → 发送行程结束
    if (!ecuResponded) {
      consecutiveNoData++;
      if (consecutiveNoData > 30) {
        Serial.print("ECU失联 loop=");
        Serial.println(loopCount);

        StaticJsonDocument<128> doc;
        doc["lat"] = 0.0;
        doc["lng"] = 0.0;
        doc["_source"] = "esp32-obd";

        String body;
        serializeJson(doc, body);

        char url[128];
        snprintf(url, sizeof(url), "/api/car/end?key=%s", API_KEY);
        postToVPS(url, body);

        obdConnected = false;
        return;
      }
    }

    // 每100轮打印状态
    if (loopCount % 100 == 0) {
      Serial.print("轮询中... loop=");
      Serial.print(loopCount);
      Serial.print(" 内存=");
      Serial.print(ESP.getFreeHeap());
      Serial.println("B");
    }
  }
}

// ==================== 主 loop ====================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("=== ESP32 OBD Relay ===");
  Serial.print("芯片: ");
  Serial.println(ESP.getChipModel());
  Serial.print("蓝牙MAC: ");
  Serial.println(OBD_MAC);
  Serial.print("VPS: ");
  Serial.println(VPS_URL);

  // 1. 连接 WiFi
  connectWiFi();

  // 2. 初始化蓝牙 SPP
  if (!SerialBT.begin("ESP32-OBD", true)) {
    Serial.println("蓝牙初始化失败!");
    return;
  }
  Serial.println("蓝牙SPP就绪");
}

void loop() {
  // 确保 WiFi 连接
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(5000);
    return;
  }

  // 连接 OBD
  if (!obdConnected) {
    // 重连间隔 10 秒
    if (millis() - lastReconnectAttempt < 10000) {
      delay(1000);
      return;
    }
    lastReconnectAttempt = millis();

    if (connectOBD()) {
      if (initializeELM()) {
        fetchPidConfig();
        pollingLoop();
      } else {
        obdConnected = false;
      }
    }

    // 清理
    if (!obdConnected) {
      SerialBT.disconnect();
      delay(1000);
    }
  } else {
    // 检查连接是否还在
    if (!SerialBT.connected()) {
      Serial.println("蓝牙连接断开");
      obdConnected = false;
    }
    delay(500);
  }

  // 喂狗 (如果需要)
  // esp_task_wdt_reset();
}
