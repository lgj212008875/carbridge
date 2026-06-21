package com.carbridge.obd

// ObdRelay v3.0 — OBD蓝牙中继服务 (纯后台, 零UI)
// 连接 ELM327 → 逐PID读取 → 逐条异步上报 VPS
// MAC/服务器/密钥 硬编码, 免配置

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ObdRelayService : Service() {

    companion object {
        const val TAG = "ObdRelay"
        const val NOTIFICATION_ID = 2001
        const val CHANNEL_ID = "obd_relay_channel"

        // 硬编码配置 (免配置)
        const val OBD_MAC = "YOUR_ELM327_MAC_ADDRESS"
        const val SERVER_URL = "http://YOUR_VPS_IP:8899"
        const val API_KEY = "YOUR_CARBRIDGE_API_KEY"

        // 轮询PID列表 — 启动时从云端拉取, 拉不到用本地16个兜底
        // FULL_PID_LIST 必须在 PID_LIST 之前定义
        private val FULL_PID_LIST = listOf(
            0x0D,            // 车速
            0x0C,            // 转速
            0x04,            // 负荷
            0x05,            // 水温
            0x0B,            // 进气歧管压力 MAP
            0x0F,            // 进气温度
            0x10,            // 空气流量 MAF
            0x11,            // 节气门位置
            0x06,            // 短时燃油修正 STFT
            0x07,            // 长时燃油修正 LTFT
            0x0E,            // 点火提前角
            0x33,            // 大气压力
            0x42,            // 电瓶电压
            0x43,            // 绝对负荷值
            0x44,            // 空燃比当量
            0x0A             // 燃油压力
        )
        private var PID_LIST = FULL_PID_LIST

        @Volatile var isRunning = false
        @Volatile var loopCount: Int = 0

        private val SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }

    private var obdThread: Thread? = null
    private var httpExecutor: ExecutorService? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 有界队列: 网络断开时防止无界堆积 → OOM
        val queue = java.util.concurrent.LinkedBlockingQueue<Runnable>(50)
        httpExecutor = java.util.concurrent.ThreadPoolExecutor(
            3, 3, 0L, java.util.concurrent.TimeUnit.MILLISECONDS, queue,
            java.util.concurrent.ThreadPoolExecutor.DiscardPolicy()
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            isRunning = true

            // 检查蓝牙权限
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                    != PackageManager.PERMISSION_GRANTED) {
                    Log.e(TAG, "蓝牙权限未授予, 停止服务")
                    stopSelf()
                    return START_NOT_STICKY
                }
            }

            createNotificationChannel()
            // Android 14+ 必须显式 foregroundServiceType
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }

            obdThread?.interrupt()
            try { obdThread?.join(2000) } catch (_: Exception) {}
            obdThread = PollingThread()
            obdThread?.start()

            return START_STICKY
        } catch (e: Exception) {
            Log.e(TAG, "启动失败", e)
            stopSelf()
            return START_NOT_STICKY
        }
    }

    @Volatile private var currentSocket: BluetoothSocket? = null

    override fun onDestroy() {
        isRunning = false
        try { currentSocket?.close() } catch (_: Exception) {}
        obdThread?.interrupt()
        httpExecutor?.shutdown()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_ID, "OBD中继", NotificationManager.IMPORTANCE_LOW
                ).apply { description = "OBD数据中继服务" }
                val nm = getSystemService(NotificationManager::class.java)
                nm.createNotificationChannel(channel)
            }
        } catch (e: Exception) {
            Log.e(TAG, "通知通道创建失败", e)
        }
    }

    private fun buildNotification(): Notification {
        val configIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("OBD中继")
            .setContentText("后台运行中")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(configIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    // ========== 轮询线程 ==========

    inner class PollingThread : Thread("OBD-Poller") {

        private var socket: BluetoothSocket? = null
        private var writer: OutputStreamWriter? = null

        override fun run() {
            while (isRunning) {
                Log.i(TAG, "开始连接 $OBD_MAC ...")
                try {
                    connect()
                    initialize()
                    Log.i(TAG, "连接成功, 拉取云端PID配置...")
                    fetchPidConfig()
                    Log.i(TAG, "PID列表: ${PID_LIST.map { String.format("%02X",it) }}, 开始轮询")
                    pollingLoop()
                } catch (e: InterruptedException) {
                    return
                } catch (e: Exception) {
                    Log.w(TAG, "异常: ${e.message}")
                } finally {
                    closeSocket()
                }
                if (isRunning) {
                    try { Thread.sleep(10_000) } catch (_: InterruptedException) { return }
                }
            }
        }

        // ===== 蓝牙连接 (3种方式尝试, 避免闪退) =====

        private fun connect() {
            val adapter = BluetoothAdapter.getDefaultAdapter()
                ?: throw RuntimeException("无蓝牙硬件")
            if (!adapter.isEnabled) throw RuntimeException("蓝牙未开启")

            // Android 12+ 运行时权限检查
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (this@ObdRelayService.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                    != PackageManager.PERMISSION_GRANTED) {
                    throw RuntimeException("蓝牙CONNECT权限未授予")
                }
            }

            val device = adapter.getRemoteDevice(OBD_MAC)
            Log.i(TAG, "OBD设备: ${device.name ?: "未知"}")

            var lastErr = ""

            // 方法1: createRfcommSocketToServiceRecord (标准)
            try {
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                    .also { currentSocket = it }
                socket?.connect()
                writer = OutputStreamWriter(socket!!.outputStream)
                Log.i(TAG, "SPP连接成功")
                return
            } catch (e: Exception) {
                lastErr = "SPP=${e.message?.take(30)}"
                try { socket?.close() } catch (_: Exception) {}
            }

            // 方法2: createInsecureRfcommSocket
            try {
                socket = device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                    .also { currentSocket = it }
                socket?.connect()
                writer = OutputStreamWriter(socket!!.outputStream)
                Log.i(TAG, "Insecure连接成功")
                return
            } catch (e: Exception) {
                lastErr += " | Insecure=${e.message?.take(30)}"
                try { socket?.close() } catch (_: Exception) {}
            }

            // 方法3: 反射 createRfcommSocket(int)
            try {
                val m = device.javaClass.getMethod("createRfcommSocket",
                    Int::class.javaPrimitiveType)
                for (ch in 1..30) {
                    if (!isRunning) break
                    try {
                        socket = (m.invoke(device, ch) as BluetoothSocket)
                            .also { currentSocket = it }
                        socket?.connect()
                        writer = OutputStreamWriter(socket!!.outputStream)
                        Log.i(TAG, "反射通道 $ch 连接成功")
                        return
                    } catch (_: Exception) {
                        try { socket?.close() } catch (_: Exception) {}
                    }
                }
                lastErr += " | 反射1-30失败"
            } catch (e: Exception) {
                lastErr += " | 反射不可用: ${e.message?.take(20)}"
            }

            throw RuntimeException("蓝牙连接失败 ($lastErr)")
        }

        // ===== 初始化 ELM327 =====

        private fun initialize() {
            // 排空缓冲
            try { while (socket?.inputStream?.available() ?: 0 > 0) socket?.inputStream?.read() } catch (_: Exception) {}

            sendAt("AT Z", 4000)    // 复位
            Thread.sleep(600)
            sendAt("AT E0", 800)    // 关回显
            sendAt("AT L0", 500)    // 关换行
            sendAt("AT H0", 500)    // 关CAN头
            sendAt("AT S0", 500)    // 关空格
            sendAt("AT SP 5", 2000) // KWP2000 Fast
            val ver = sendCommand("AT I", 1500)
            if (ver.isNotBlank()) Log.i(TAG, "ELM327: $ver")
            Log.i(TAG, "初始化完成")
        }

        private fun sendAt(cmd: String, waitMs: Long) {
            val resp = sendCommand(cmd, waitMs)
            val ok = resp.contains("OK", ignoreCase = true) || resp.isNotBlank()
            if (!ok) Log.w(TAG, "AT $cmd 异常: $resp")
        }

        // ===== 命令发送 (收到 '>' 即返回, 无 BufferedReader) =====
        // 经验教训: 绝对不能用 BufferedReader/InputStreamReader, 缓冲区吞数据 → 本地crash

        private fun sendCommand(cmd: String, timeoutMs: Long): String {
            try { while (socket?.inputStream?.available() ?: 0 > 0) socket?.inputStream?.read() } catch (_: Exception) {}
            try { writer?.write("$cmd\r"); writer?.flush() } catch (_: Exception) { return "" }
            val ins = socket?.inputStream ?: return ""
            val deadline = System.currentTimeMillis() + timeoutMs
            val sb = StringBuilder()
            try {
                while (System.currentTimeMillis() < deadline) {
                    while (ins.available() > 0) {
                        val b = ins.read()
                        if (b < 0) return sb.toString().trim()
                        val ch = b.toChar()
                        if (ch == '>') return sb.toString().trim()
                        if (ch == '\r' || ch == '\n') {
                            if (sb.isNotEmpty() && sb.last() != '\n') sb.append('\n')
                        } else if (ch.code >= 32) sb.append(ch)
                    }
                    Thread.sleep(10)
                }
            } catch (_: Exception) {}
            return sb.toString().trim()
        }

        // ===== PID 轮询: 逐条读取 → 原样转发VPS (VPS负责解析+诊断) =====

        private val logBuf = mutableListOf<String>()  // 手机端日志缓冲区

        private fun appendLog(msg: String) {
            synchronized(logBuf) { logBuf.add("${System.currentTimeMillis() % 100000} $msg"); if (logBuf.size > 30) logBuf.removeAt(0) }
        }

        private fun drainLog(): String = synchronized(logBuf) { val s = logBuf.joinToString("|"); logBuf.clear(); s }


        // 启动时从 VPS 拉取 PID 配置, 拉不到用本地 FULL_PID_LIST 兜底
        private fun fetchPidConfig() {
            try {
                val url = URL("$SERVER_URL/api/query/pid_config")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 5000; conn.readTimeout = 3000
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val arr = JSONObject(body).optJSONArray("pids") ?: return
                    val list = mutableListOf<Int>()
                    for (i in 0 until arr.length()) list.add(arr.getInt(i))
                    if (list.isNotEmpty()) { PID_LIST = list; appendLog("云端PID:" + list.size + "个") }
                }
                conn.disconnect()
            } catch (e: Exception) {
                appendLog("PID拉取失败,用本地" + FULL_PID_LIST.size + "个")
            }
        }

        private fun pollingLoop() {
            var loop = 0
            var consecutiveFails = 0
            val executor = httpExecutor ?: return

            appendLog("轮询启动 ${PID_LIST.size}PID")

            while (isRunning && socket?.isConnected == true) {
                var ecuResponded = false
                for (pid in PID_LIST) {
                    if (!isRunning) return
                    val cmd = String.format("01 %02X", pid)
                    val resp = sendCommand(cmd, 1500)
                    if (resp.isBlank()) continue
                    val errs = listOf("NO DATA", "SEARCHING", "ERROR", "UNABLE TO CONNECT", "CAN ERROR", "BUS INIT", "STOPPED")
                    if (errs.any { resp.contains(it, ignoreCase = true) }) continue

                    // 尝试提取 41XX 行 (有效数据)
                    val pidPrefix = String.format("41%02X", pid)
                    val hex = resp.lines()
                        .map { it.trim().replace(" ", "").replace("\r", "") }
                        .filter { it.startsWith(pidPrefix) && it.all { c -> c in "0123456789ABCDEFabcdef" } }
                        .firstOrNull()

                    val json = JSONObject()
                    if (hex != null) {
                        json.put("_type", "raw")
                        json.put(String.format("%02X", pid), hex)
                        ecuResponded = true
                        consecutiveFails = 0
                    } else {
                        // 无 41XX 行: 把原始响应发 VPS 诊断
                        if (loop % 5 == 0) {
                            json.put("_type", "debug_raw")
                            json.put("pid", pid)
                            json.put("resp", resp.take(300))
                            json.put("loop", loop)
                        } else {
                            continue  // 不发, 跳过
                        }
                    }

                    // 附带手机端日志
                    json.put("_log", drainLog())

                    executor.submit {
                        postFireAndForget("$SERVER_URL/api/car/obd?key=$API_KEY", json)
                    }
                }
                loop++

                if (!ecuResponded) {
                    consecutiveFails++
                    if (consecutiveFails > 30) {
                        appendLog("ECU失联 loop=$loop")
                        val json = JSONObject().apply {
                            put("lat", 0.0); put("lng", 0.0)
                            put("_source", "phone-obd")
                            put("_log", drainLog())
                        }
                        httpFireAndForget("$SERVER_URL/api/car/end?key=$API_KEY", json)
                        return
                    }
                }

                Companion.loopCount = loop
            }
        }

        // ===== HTTP 工具 =====

        // 异步无返回值 POST (不阻塞轮询)
        private fun postFireAndForget(urlStr: String, json: JSONObject) {
            try {
                val conn = URL(urlStr).openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 3000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(json.toString().toByteArray()) }
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                // fire-and-forget: 失败不重试, 不影响下一PID
            }
        }

        private fun httpFireAndForget(urlStr: String, json: JSONObject) {
            val executor = httpExecutor ?: return
            executor.submit {
                try {
                    val conn = URL(urlStr).openConnection() as HttpURLConnection
                    conn.connectTimeout = 5000
                    conn.readTimeout = 3000
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.outputStream.use { it.write(json.toString().toByteArray()) }
                    conn.responseCode
                    conn.disconnect()
                } catch (_: Exception) {}
            }
        }

        // ===== 清理 =====

        private fun closeSocket() {
            try { writer?.close() } catch (_: Exception) {}
            try { socket?.close() } catch (_: Exception) {}
            socket = null; writer = null
        }
    }
}
