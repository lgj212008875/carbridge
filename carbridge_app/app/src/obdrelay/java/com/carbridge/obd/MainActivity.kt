// ObdRelay v3.0 — 极简界面: 启动服务 + 轮询计数
package com.carbridge.obd

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.carbridge.agent.R
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private var refreshRunnable: Runnable? = null

    private lateinit var tvStatus: TextView
    private lateinit var tvLoopCount: TextView
    private lateinit var tvLog: TextView

    private val logLines = mutableListOf<String>()
    private var lastLogText = ""
    private var serviceStarted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tv_status)
        tvLoopCount = findViewById(R.id.tv_loop_count)
        tvLog = findViewById(R.id.tv_log)

        appendLog("OBD中继 v3.0 启动")
        checkPermissionsAndStart()
    }

    override fun onResume() {
        super.onResume()
        startUiRefresh()
    }

    override fun onPause() {
        super.onPause()
        stopUiRefresh()
    }

    private fun checkPermissionsAndStart() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED)
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED)
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED)
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isNotEmpty()) {
            appendLog("请求权限: $needed")
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 1001)
        } else {
            startObdService()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1001) startObdService()
    }

    private fun startObdService() {
        if (serviceStarted) return
        serviceStarted = true
        try {
            val intent = Intent(this, ObdRelayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            appendLog("中继服务已启动 ✓")
        } catch (e: Exception) {
            appendLog("❌ 启动失败: ${e.message}")
        }
    }

    private fun startUiRefresh() {
        stopUiRefresh()
        refreshRunnable = object : Runnable {
            override fun run() {
                val running = ObdRelayService.isRunning
                val loops = ObdRelayService.loopCount
                tvStatus.text = ">> ${if (running) "后台运行中" else "未启动"}"
                tvStatus.setTextColor(if (running) 0xFF00FF41.toInt() else 0xFFFFD600.toInt())
                tvLoopCount.text = "已轮询 $loops 轮"
                handler.postDelayed(this, 2000L)
            }
        }
        handler.postDelayed(refreshRunnable!!, 500L)
    }

    private fun stopUiRefresh() {
        refreshRunnable?.let { handler.removeCallbacks(it) }
        refreshRunnable = null
    }

    private fun appendLog(line: String) {
        val ts = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        logLines.add("$ts  $line")
        if (logLines.size > 40) logLines.removeAt(0)
        val text = logLines.joinToString("\n")
        if (text != lastLogText) {
            tvLog.text = text
            lastLogText = text
        }
    }
}
