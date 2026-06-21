package com.carbridge.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.location.Criteria
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.preference.PreferenceManager
import java.util.concurrent.Executors
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader  // unused now
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID  // unused now
import java.util.concurrent.ConcurrentLinkedQueue

class CarAgentService : Service() {

    companion object {
        private const val TAG = "CarAgent"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "caragent_channel"
        @Volatile var isRunning = false
            private set

        // Public for MainActivity dashboard (all @Volatile: written on main thread, read on HTTP thread)
        @Volatile var currentSpeedKmh = 0f
            private set
        @Volatile var currentHeading = "--"
            private set
        @Volatile var currentLat = 0.0
            private set
        @Volatile var currentLng = 0.0
            private set
        @Volatile var altitude = 0.0
            private set
        @Volatile var satCount = 0
            private set
        @Volatile var tripActive = false
        @Volatile var tripStarted = false
        @Volatile var tripStartedAt: Long = 0L
            private set
        @Volatile var tripElapsedMs = 0L
            private set

        // v6.0 仪表盘 10 项 (全部由 VPS /api/query/state 下发)
        @Volatile var fuelPer100km: Float? = null    // L/100km
        @Volatile var fuelLevel: Float? = null        // %
        @Volatile var remainingRange: Int? = null     // 续航里程 km
        @Volatile var tripDistanceKm: Double = 0.0    // 本次里程 km
            private set
        @Volatile var tripDuration: String = "--"     // 行程时长 (hhH mmmin)
        @Volatile var tripFuelCost: Double = 0.0      // 本次油费 元
        @Volatile var dailyDistKm: Double = 0.0       // 本日里程 km
        @Volatile var dailyFuelCost: Double = 0.0     // 本日油费 元
        @Volatile var monthlyDistKm: Double = 0.0     // 本月里程 km
        @Volatile var monthlyFuelCost: Double = 0.0   // 本月油费 元

        // OBD 连接状态
        @Volatile var obdConnectionState = "⏳ 等待数据"
            private set
        @Volatile var lastObdFetchTime: Long = 0
        @Volatile var obdLostSince: Long = 0
            private set
        @Volatile var lastObdFetchError: String? = null
            private set
        @Volatile var carNotifyTitle: String? = null
        @Volatile var carNotifyMsg: String? = null
        @Volatile var carNotifyTime: Long = 0L
        @Volatile var _vpsInTrip = false
        @Volatile var _vpsTripStartedAt: Long = 0L
        fun consumeCarNotify(): Pair<String, String>? {
            val title = carNotifyTitle; val msg = carNotifyMsg
            if (title != null && msg != null) { carNotifyTitle = null; carNotifyMsg = null; return Pair(title, msg) }
            return null
        }

        private const val FATIGUE_ALERT_MS = 2 * 60 * 60 * 1000L

        private val obdFetchExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "ObdFetch").also { it.isDaemon = true }
        }
        @Volatile var isFetchingObd = false  // 防堆积：上一次未拉完则跳过本轮

        @JvmStatic
            fun fetchObdFromRelayStatic(serverUrl: String, apiKey: String) {
            if (isFetchingObd) return
            isFetchingObd = true
            obdFetchExecutor.execute {
                try {
                    val urlStr = "$serverUrl/api/query/state?key=$apiKey"
                    val conn = URL(urlStr).openConnection() as HttpURLConnection
                    conn.connectTimeout = 5000; conn.readTimeout = 5000
                    val code = conn.responseCode
                    if (code == 200) {
                        val body = conn.inputStream.bufferedReader().readText()
                        conn.disconnect()
                        val j = org.json.JSONObject(body)
                        // v6.0: 10项仪表盘数据 + 行程状态
                        var changed = false
                        if (j.has("fuelPer100km") && !j.isNull("fuelPer100km")) { val v = j.getDouble("fuelPer100km").toFloat(); if (fuelPer100km != v) changed = true; fuelPer100km = v }
                        if (j.has("fuelLevel") && !j.isNull("fuelLevel")) { val v = j.getDouble("fuelLevel").toFloat(); if (fuelLevel != v) changed = true; fuelLevel = v }
                        if (j.has("remainingRange") && !j.isNull("remainingRange")) { remainingRange = j.getInt("remainingRange") }
                        if (j.has("tripDistanceKm") && !j.isNull("tripDistanceKm")) { tripDistanceKm = j.getDouble("tripDistanceKm") }
                        if (j.has("tripDuration") && !j.isNull("tripDuration")) { tripDuration = j.getString("tripDuration") }
                        if (j.has("tripFuelCost") && !j.isNull("tripFuelCost")) { tripFuelCost = j.getDouble("tripFuelCost") }
                        if (j.has("dailyDistanceKm") && !j.isNull("dailyDistanceKm")) { dailyDistKm = j.getDouble("dailyDistanceKm") }
                        if (j.has("dailyFuelCost") && !j.isNull("dailyFuelCost")) { dailyFuelCost = j.getDouble("dailyFuelCost") }
                        if (j.has("monthlyDistanceKm") && !j.isNull("monthlyDistanceKm")) { monthlyDistKm = j.getDouble("monthlyDistanceKm") }
                        if (j.has("monthlyFuelCost") && !j.isNull("monthlyFuelCost")) { monthlyFuelCost = j.getDouble("monthlyFuelCost") }
                        if (j.has("carNotify") && !j.isNull("carNotify")) {
                            val cn = j.getJSONObject("carNotify")
                            carNotifyTitle = cn.optString("title", null)
                            carNotifyMsg = cn.optString("msg", null)
                            carNotifyTime = cn.optLong("time", System.currentTimeMillis())
                        }
                        lastObdFetchTime = System.currentTimeMillis()
                        lastObdFetchError = null
                        obdConnectionState = "🟢 已同步"
                        obdLostSince = 0L
                        _vpsInTrip = j.optBoolean("inTrip", false)
                        _vpsTripStartedAt = j.optLong("tripStartedAt", 0L)
                        if (changed) Log.d(TAG, "OBD刷新: ${fuelPer100km} L/100km ${fuelLevel}% 续航${remainingRange}km")
                    } else {
                        conn.disconnect()
                        lastObdFetchError = "HTTP $code"
                        obdConnectionState = "🔴 HTTP $code"
                        Log.w(TAG, "OBD fetch HTTP $code")
                    }
                } catch (e: Exception) {
                    lastObdFetchError = e.message ?: "unknown"
                    obdConnectionState = "🔴 ${e.message?.take(30)}"
                    Log.w(TAG, "OBD fetch fail: ${e.message}")
                } finally { isFetchingObd = false }
            }
        }

        // 车机日志缓冲（传VPS远程分析）
        @Volatile @JvmField var carAgentLog = ""
        private val carLogLock = Any()
        @JvmStatic fun appendCarLog(msg: String) {
            synchronized(carLogLock) {
                val ts = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
                val lines = carAgentLog.split("\n").takeLast(50)
                carAgentLog = (lines + "[$ts] $msg").joinToString("\n")
            }
        }
    }

    private lateinit var locationManager: LocationManager
    private lateinit var prefs: SharedPreferences
    private lateinit var prefsListener: SharedPreferences.OnSharedPreferenceChangeListener

    private val handler = Handler(Looper.getMainLooper())
    private var reportRunnable: Runnable? = null
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // 离线缓存队列 (url -> jsonBody -> seqId)
    data class OfflineItem(val url: String, val body: String, val seqId: Long)
    private val offlineQueue = ConcurrentLinkedQueue<OfflineItem>()
    private val offlineQueueFile: File
        get() = File(filesDir, "offline_queue.json")

    // Trip state
    private var fatigueAlerted = false

    // Current data (internal)
    private var currentSpeedMs = 0.0f
    private var currentBearing = 0.0f

    // OBD bluetooth — 已移至手机中继 App，车机不再直连

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service onCreate"); appendCarLog("Service onCreate")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Service onStartCommand"); appendCarLog("onStartCommand")
        isRunning = true

        prefs = PreferenceManager.getDefaultSharedPreferences(this)

        prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            restartReporting()
            // OBD 已移至手机中继 App，不再本地连接
        }
        prefs.registerOnSharedPreferenceChangeListener(prefsListener)

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        loadOfflineQueue()
        registerNetworkCallback()
        startLocationUpdates()
        startPeriodicReporting()
        startObdPolling()
        // OBD 已移至手机中继 App

        Log.i(TAG, "CarAgent Service fully started!"); appendCarLog("服务已启动")
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        prefs.unregisterOnSharedPreferenceChangeListener(prefsListener)
        stopPeriodicReporting()
        stopObdPolling()
        // P0修复: connectivityManager 是 nullable (?.) 已安全, locationManager 是 lateinit 需 isInitialized
        networkCallback?.let { try { connectivityManager?.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        if (::locationManager.isInitialized) {
            try { locationManager.removeUpdates(locationListener) } catch (_: Exception) {}
        }
        Log.d(TAG, "Service onDestroy"); appendCarLog("onDestroy")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // --- Notification ---

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "CarAgent",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "车辆追踪后台服务"
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val configIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, ConfigActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CarAgent")
            .setContentText("正在追踪")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(configIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    // --- Location ---

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            currentLat = loc.latitude
            currentLng = loc.longitude
            currentSpeedMs = loc.speed
            currentBearing = loc.bearing
            currentSpeedKmh = loc.speed * 3.6f
            currentHeading = formatHeading(loc.bearing)
            altitude = if (loc.hasAltitude()) loc.altitude else 0.0
            loc.extras?.let { extras ->
                satCount = extras.getInt("satellites", 0)
            }
            // 行程由手机中继判定
        }
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    private fun startLocationUpdates() {
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            val criteria = Criteria().apply {
                accuracy = Criteria.ACCURACY_FINE
                powerRequirement = Criteria.POWER_HIGH
            }
            val provider = locationManager.getBestProvider(criteria, true)
            if (provider != null) {
                locationManager.requestLocationUpdates(provider, 5000L, 0f, locationListener, Looper.getMainLooper())
            } else {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000L, 0f, locationListener, Looper.getMainLooper())
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "No location permission"); appendCarLog("[E]无定位权限")
        }
    }

    // 行程由手机OBD中继判定(ECU响应→开始, ECU丢失→结束)
    // 车机仅负责GPS展示和OBD轮询，不再本地判定行程

    // --- Periodic Reporting ---

    private fun startPeriodicReporting() {
        stopPeriodicReporting()
        val intervalMs = getReportIntervalMs()
        reportRunnable = object : Runnable {
            override fun run() {
                sendStatusReport()
                // 行程由手机中继判定，车机不再本地累加里程
                updateNotification()
                handler.postDelayed(this, intervalMs)
            }
        }
        handler.postDelayed(reportRunnable!!, intervalMs)
    }

    private fun stopPeriodicReporting() {
        reportRunnable?.let { handler.removeCallbacks(it) }
        reportRunnable = null
    }

    private fun restartReporting() {
        stopPeriodicReporting()
        startPeriodicReporting()
    }

    // --- 独立 OBD 轮询 (200ms，与GPS上报脱钩) ---
    // 行程判定由 VPS + 手机中继主责，车机只收集 GPS 并服从 VPS 权威状态
    private var obdRunnable: Runnable? = null
    private val OBD_POLL_MS = 500L

    private fun startObdPolling() {
        stopObdPolling()
        obdRunnable = object : Runnable {
            override fun run() {
                fetchObdFromRelay()
                // VPS 权威行程状态判定（异步 fetch 完成后 _vpsInTrip 已更新）
                if (Companion._vpsInTrip && !Companion.tripStarted) {
                    Companion.tripStarted = true
                    Companion.tripStartedAt = if (Companion._vpsTripStartedAt > 0) Companion._vpsTripStartedAt else System.currentTimeMillis()
                    Companion.tripActive = true
                    Companion.tripElapsedMs = 0L
                    Companion.tripDistanceKm = 0.0
                    appendCarLog("行程开始(VPS判定)")
                    Log.i(TAG, "Trip started by VPS!")
                } else if (!Companion._vpsInTrip && Companion.tripStarted) {
                    endTrip()
                    appendCarLog("行程结束(VPS判定)")
                    Log.i(TAG, "Trip ended by VPS")
                }
                handler.postDelayed(this, OBD_POLL_MS)
            }
        }
        handler.post(obdRunnable!!)
    }

    private fun stopObdPolling() {
        obdRunnable?.let { handler.removeCallbacks(it) }
        obdRunnable = null
    }

    private fun getReportIntervalMs(): Long {
        val seconds = try {
            prefs.getString("report_interval", "30")?.toLong() ?: 30L
        } catch (_: NumberFormatException) { 30L }
        return seconds.coerceIn(5L, 300L) * 1000L
    }

    private fun endTrip() {
        Companion._vpsInTrip = false  // 阻断 VPS 权威状态，防本轮/下轮 if 立马又开启行程
        Companion.tripStarted = false
        fatigueAlerted = false
        Companion.tripActive = false
        Companion.tripElapsedMs = 0L
        Companion.tripDistanceKm = 0.0
        Log.i(TAG, "Trip ended!"); appendCarLog("行程结束")
        // 通知 VPS 行程结束 (手机中继可能先断, 车机兜底)
        try {
            val json = JSONObject().apply {
                put("lat", currentLat); put("lng", currentLng)
                put("fuelConsumption", 0.0); put("_source", "caragent-timeout")
            }
            httpPost("${getServerUrl()}/api/car/end?key=${getApiKey()}", json.toString())
        } catch (_: Exception) {}
    }

    // --- HTTP Requests ---

    // OBD数据拉取 —— 从VPS获取手机中继上报的实时OBD
    private fun fetchObdFromRelay() {
        fetchObdFromRelayStatic(getServerUrl(), getApiKey())
    }

    private fun sendStatusReport() {
        val serverUrl = getServerUrl()
        val apiKey = getApiKey()

        val json = JSONObject().apply {
            put("speed", (currentSpeedMs * 3.6).toInt())
            put("lat", currentLat)
            put("lng", currentLng)
            put("engineOn", currentSpeedMs > 0f)
            put("heading", formatHeading(currentBearing))
            put("version", "6.18")
            // tripDistanceKm 由 VPS 独立计算, 车机不重复上报
            synchronized(carLogLock) { put("_log", carAgentLog) }
        }


        httpPost("$serverUrl/api/car/status?key=${apiKey}", json.toString())
    }

    private fun updateNotification() {
        // P2修复: 服务正在销毁时不刷新通知
        if (!isRunning) return
        try {
            val nm = getSystemService(NotificationManager::class.java) ?: return
            val parts = mutableListOf<String>()
            if (currentSpeedKmh > 0) parts.add("🚗${currentSpeedKmh.toInt()}km/h")
            // v6.0: 电压不再由车机显示 (OBD中继负责)
            if (Companion.tripActive && Companion.tripStartedAt > 0) {
                val mins = (System.currentTimeMillis() - Companion.tripStartedAt) / 60000
                if (mins > 0) parts.add("⏱${mins}min")
            }
            val text = if (parts.isNotEmpty()) parts.joinToString(" · ") else "正在追踪"
            val configIntent = PendingIntent.getActivity(
                this, 0,
                Intent(this, ConfigActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notification = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("CarAgent")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentIntent(configIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
            nm.notify(NOTIFICATION_ID, notification)
        } catch (e: Exception) { Log.w(TAG, "updateNotification error: ${e.message}") }
    }

    // P1修复: 复用线程池替代每次 new Thread(), 防线程爆炸
    private val httpExecutor = java.util.concurrent.Executors.newCachedThreadPool()

    private fun httpPost(urlString: String, jsonBody: String, retries: Int = 3) {
        httpExecutor.submit {
            var lastError: Exception? = null
            for (attempt in 1..retries) {
                try {
                    val url = URL(urlString)
                    val conn = url.openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000

                    val writer = OutputStreamWriter(conn.outputStream)
                    writer.write(jsonBody)
                    writer.flush()
                    writer.close()

                    val responseCode = conn.responseCode
                    if (responseCode in 200..299) {
                        Log.d(TAG, "HTTP $responseCode OK (attempt $attempt)"); appendCarLog("HTTP OK")
                        conn.disconnect()
                        return@submit
                    }
                    Log.w(TAG, "HTTP $responseCode, retrying...")
                    conn.disconnect()
                } catch (e: Exception) {
                    lastError = e
                    Log.w(TAG, "HTTP error attempt $attempt: ${e.message}")
                }
                try { Thread.sleep(5000) } catch (_: InterruptedException) {}
            }
            Log.e(TAG, "HTTP failed after $retries attempts: ${lastError?.message}"); appendCarLog("[E]HTTP失败")
            enqueueOffline(urlString, jsonBody)
        }
    }

    // --- Offline Queue ---

    // 所有离线队列文件操作需同步（flush/dequeue/load 多线程竞争）
    private val offlineFileLock = Any()

    private fun loadOfflineQueue() {
        synchronized(offlineFileLock) {
            try {
                val f = offlineQueueFile
                if (!f.exists()) return
                val arr = JSONArray(f.readText())
                for (i in 0 until arr.length()) {
                    val item = arr.getJSONObject(i)
                    offlineQueue.add(OfflineItem(item.getString("url"), item.getString("body"), item.optLong("seq", 0L)))
                }
                Log.i(TAG, "Loaded ${offlineQueue.size} offline items"); appendCarLog("离线队列${offlineQueue.size}条")
                f.delete()
            } catch (e: Exception) { Log.w(TAG, "Load offline queue error: ${e.message}") }
        }
    }

    private fun saveOfflineQueue() {
        synchronized(offlineFileLock) {
            try {
                val arr = JSONArray()
                for (item in offlineQueue) {
                    val obj = JSONObject().apply { put("url", item.url); put("body", item.body); put("seq", item.seqId) }
                    arr.put(obj)
                }
                offlineQueueFile.writeText(arr.toString())
            } catch (e: Exception) { Log.w(TAG, "Save offline queue error: ${e.message}") }
        }
    }

    // reuseSeqId: 重试时传入原始 seqId，保持去重键不变，否则 retry count 重置
    private fun enqueueOffline(url: String, body: String, reuseSeqId: Long? = null) {
        if (offlineQueue.size < 200) {  // 最多缓存200条
            val seqId = reuseSeqId ?: offlineSeq.incrementAndGet()
            offlineQueue.add(OfflineItem(url, body, seqId))
            saveOfflineQueue()
            Log.i(TAG, "Offline queued #$seqId (${offlineQueue.size} items)")
        }
    }

    // 串行重传，避免瞬间大量并发线程
    @Volatile private var flushingOffline = false
    private val offlineRetries = java.util.concurrent.ConcurrentHashMap<String, Int>()
    private val MAX_OFFLINE_RETRIES = 3
    private val offlineSeq = java.util.concurrent.atomic.AtomicLong(0)  // 原子递增ID做去重键

    private fun flushOfflineQueue() {
        if (offlineQueue.isEmpty() || flushingOffline) return
        flushingOffline = true
        httpExecutor.submit {
            try {
                Log.i(TAG, "Flushing ${offlineQueue.size} offline items...")
                var item = offlineQueue.poll()
                while (item != null) {
                    val (url, body, seqId) = item
                    val dedupKey = "$url|$seqId"
                    try {
                        val conn = URL(url).openConnection() as HttpURLConnection
                        conn.connectTimeout = 10_000
                        conn.readTimeout = 10_000
                        conn.doOutput = true
                        conn.setRequestProperty("Content-Type", "application/json")
                        conn.outputStream.use { it.write(body.toByteArray()) }
                        val code = conn.responseCode
                        conn.disconnect()
                        if (code in 200..299) {
                            offlineRetries.remove(dedupKey)
                            Log.d(TAG, "Offline flushed OK")
                        } else {
                            val count = offlineRetries.merge(dedupKey, 1) { _, v -> v + 1 } ?: 1
                            if (count < MAX_OFFLINE_RETRIES) {
                                enqueueOffline(url, body, seqId)  // 传入原seqId保持去重键
                            } else {
                                offlineRetries.remove(dedupKey)
                                Log.w(TAG, "Offline item discarded after $MAX_OFFLINE_RETRIES retries: HTTP $code")
                            }
                            break  // 服务器不可用，停止，等下次网络恢复
                        }
                    } catch (e: Exception) {
                        val count = offlineRetries.merge(dedupKey, 1) { _, v -> v + 1 } ?: 1
                        if (count < MAX_OFFLINE_RETRIES) {
                            enqueueOffline(url, body, seqId)  // 传入原seqId保持去重键
                        } else {
                            offlineRetries.remove(dedupKey)
                            Log.w(TAG, "Offline item discarded after $MAX_OFFLINE_RETRIES retries: ${e.message}")
                        }
                        break  // 网络不可用，停止
                    }
                    item = offlineQueue.poll()
                }
                saveOfflineQueue()
            } finally { flushingOffline = false }
        }
    }

    private fun registerNetworkCallback() {
        try {
            connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.i(TAG, "Network available, flushing offline queue")
                    flushOfflineQueue()
                    // 网络恢复后立即上报一次
                    sendStatusReport()
                }
            }
            connectivityManager!!.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                cb
            )
            networkCallback = cb
        } catch (e: Exception) { Log.w(TAG, "Network callback error: ${e.message}") }
    }

    // --- Helpers ---

    private fun getServerUrl(): String {
        return prefs.getString("server_url", "http://YOUR_VPS_IP:8899") ?: "http://YOUR_VPS_IP:8899"
    }

    private fun getApiKey(): String {
        return prefs.getString("api_key", "YOUR_CARBRIDGE_API_KEY") ?: "YOUR_CARBRIDGE_API_KEY"
    }

    private fun formatHeading(bearing: Float): String {
        return when {
            bearing < 22.5f || bearing >= 337.5f -> "N"
            bearing < 67.5f -> "NE"
            bearing < 112.5f -> "E"
            bearing < 157.5f -> "SE"
            bearing < 202.5f -> "S"
            bearing < 247.5f -> "SW"
            bearing < 292.5f -> "W"
            else -> "NW"
        }
    }

}