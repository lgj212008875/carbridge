package com.carbridge.agent

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.*
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    data class CellCfg(val label: String, val unit: String, val valueTag: String, val bind: (TextView) -> Unit)

    // === 配色方案 ===
    data class Palette(
        val bg: String, val card: String, val cardStroke: String,
        val textPri: String, val textSec: String, val textDim: String,
        val accent: String, val green: String, val yellow: String, val cyan: String,
        val speed: String, val status: String
    )

    private val DAY = Palette(
        bg = "#ECF0F3", card = "#FFFFFF", cardStroke = "#DDE1E5",
        textPri = "#1A1C1E", textSec = "#546E7A", textDim = "#90A4AE",
        accent = "#1565C0", green = "#2E7D32", yellow = "#E65100", cyan = "#00695C",
        speed = "#0D47A1", status = "#1565C0"
    )
    private val NIGHT = Palette(
        bg = "#0B0E14", card = "#161B22", cardStroke = "#21262D",
        textPri = "#E6EDF3", textSec = "#7D8590", textDim = "#484F58",
        accent = "#58A6FF", green = "#3FB950", yellow = "#D29922", cyan = "#39D2C0",
        speed = "#79C0FF", status = "#4FC3F7"
    )

    private var palette = NIGHT
    private var lastMode = true
    private var vpsIsNight: Boolean? = null

    private val handler = Handler(Looper.getMainLooper())
    private val httpThread = Executors.newSingleThreadExecutor { r -> Thread(r, "Http").also { it.isDaemon = true } }

    private lateinit var root: LinearLayout
    private lateinit var tvStatus: TextView
    private lateinit var tvDateTime: TextView
    private lateinit var tvLunar: TextView
    private lateinit var tvSpeed: TextView
    private lateinit var tvSpeedUnit: TextView
    private lateinit var tvRpm: TextView
    private lateinit var tvCoolant: TextView
    private lateinit var tvLoad: TextView
    private lateinit var tvFuelLvl: TextView
    private lateinit var tvFuelInst: TextView
    private lateinit var tvRange: TextView
    private lateinit var tvTripD: TextView
    private lateinit var tvTripT: TextView
    private lateinit var tvTripC: TextView
    private lateinit var tvDayD: TextView
    private lateinit var tvDayC: TextView
    private lateinit var tvMonD: TextView
    private lateinit var tvMonC: TextView

    private var polling = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotifyChannel()
        requestPermissions()
        buildUI()
        startPolling()
        startDayNightWatcher()
    }

    // P2修复: 清除所有回调防内存泄漏 + 断开悬空HTTP连接
    override fun onDestroy() {
        super.onDestroy()
        polling = false
        pendingConn?.let { try { it.disconnect() } catch (_: Exception) {} }
        handler.removeCallbacksAndMessages(null)
    }

    // ====== 农历 (零依赖, 1900-2100) ======

    companion object {
        // 农历年信息编码: 低12位=月大小(1=30天,0=29天), 高4位=闰月(0=无闰)
        // 位序: bit10=正月, bit0=十一月? No. 标准: bit11=正月(第1个月), bit0=十二月(第12个月)
        // 简便方案: 低12位从正月到十二月, MSB first 还是 LSB first?
        // 采用常见编码: 低4位=闰月(0=无), bit4..15=月大小(bit4=正月...bit15=十二月)
        // 实际上用更简单的: info & 0xf = 闰月, (info >> 4) & 0xfff = 12个月大小(bit0=正月)
        private val LUNAR_INFO = intArrayOf(
            // 1900-1909
            0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
            // 1910-1919
            0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
            // 1920-1929
            0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
            // 1930-1939
            0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
            // 1940-1949
            0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
            // 1950-1959
            0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
            // 1960-1969
            0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
            // 1970-1979
            0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
            // 1980-1989
            0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
            // 1990-1999
            0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,
            // 2000-2009
            0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
            // 2010-2019
            0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
            // 2020-2029
            0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
            // 2030-2039
            0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
            // 2040-2049
            0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
            // 2050-2059
            0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0,
            // 2060-2069
            0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
            // 2070-2079
            0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
            // 2080-2089
            0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
            // 2090-2099
            0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252
        )

        private val HEAVENLY_STEMS = arrayOf("甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸")
        private val EARTHLY_BRANCHES = arrayOf("子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥")
        private val LUNAR_MONTHS = arrayOf("正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊")
        private val LUNAR_DAYS = arrayOf(
            "初一","初二","初三","初四","初五","初六","初七","初八","初九","初十",
            "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十",
            "廿一","廿二","廿三","廿四","廿五","廿六","廿七","廿八","廿九","三十"
        )

        private val BASE_YEAR = 1900
        private val BASE_DAYS = 49 // 1900-01-31 是农历正月初一, 1900-01-01 距正月初一的天数
        // 1900-01-01 到 1900-01-31 = 30天, 但公历1月31日是正月初一。实测需要从1900-01-01偏移。

        fun lunarDate(cal: Calendar): String {
            // P1修复: 范围校验防系统时间异常导致 ArrayIndexOutOfBounds
            val year = cal.get(Calendar.YEAR)
            val index = year - BASE_YEAR
            if (index < 0 || index >= LUNAR_INFO.size) return "未知农历"
            // 计算距 1900-01-01 的天数
            val days = daysBetween(BASE_YEAR, 1, 1, year, cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH))

            var lunarYear = BASE_YEAR
            var offset = days
            // 跳过农历年
            while (lunarYear < 2101) {
                val yearDays = lunarYearDays(lunarYear)
                if (offset < yearDays) break
                offset -= yearDays
                lunarYear++
            }
            if (lunarYear > 2100) lunarYear = 2100

            // 月份
            val leapMonth = LUNAR_INFO[lunarYear - BASE_YEAR] and 0xf
            var month = 0
            var isLeap = false
            while (month < 12) {
                val leap = (leapMonth > 0 && month + 1 == leapMonth && !isLeap)
                val mDays = if (leap) lunarLeapDays(lunarYear) else lunarMonthDays(lunarYear, month + 1)
                if (offset < mDays) {
                    isLeap = leap
                    break
                }
                offset -= mDays
                month++
                if (leap && !isLeap) month-- // 重试闰月
            }
            month++
            val day = offset + 1

            val stem = HEAVENLY_STEMS[(lunarYear - 4) % 10]
            val branch = EARTHLY_BRANCHES[(lunarYear - 4) % 12]
            val yearName = "$stem$branch"
            val monthName = (if (isLeap) "闰" else "") + LUNAR_MONTHS[month - 1]
            return "$yearName\u5E74 $monthName\u6708${LUNAR_DAYS[day - 1]}"
        }

        private fun daysBetween(y1: Int, m1: Int, d1: Int, y2: Int, m2: Int, d2: Int): Int {
            val c1 = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { set(y1, m1-1, d1, 0, 0, 0) }
            val c2 = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { set(y2, m2-1, d2, 0, 0, 0) }
            return ((c2.timeInMillis - c1.timeInMillis) / 86400000).toInt()
        }

        private fun lunarYearDays(y: Int): Int {
            var sum = 348 // 12 * 29
            for (i in 0 until 12) {
                if (((LUNAR_INFO[y - BASE_YEAR] shr (16 - i)) and 1) == 1) sum++
            }
            sum += lunarLeapDays(y)
            return sum
        }

        private fun lunarLeapDays(y: Int): Int {
            val leap = LUNAR_INFO[y - BASE_YEAR] and 0xf
            return if (leap == 0) 0 else if (((LUNAR_INFO[y - BASE_YEAR] shr 4) and 1) == 1) 30 else 29
        }

        private fun lunarMonthDays(y: Int, m: Int): Int {
            return if ((LUNAR_INFO[y - BASE_YEAR] shr (16 - m) and 1) == 1) 30 else 29
        }
    }

    // ====== 日/夜切换 ======

    private fun startDayNightWatcher() {
        handler.post(object : Runnable {
            override fun run() {
                checkDayNight()
                handler.postDelayed(this, 30_000L)
            }
        })
    }

    private fun checkDayNight() {
        val uiMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        val isNight = when (uiMode) {
            Configuration.UI_MODE_NIGHT_YES -> true
            Configuration.UI_MODE_NIGHT_NO -> false
            else -> vpsIsNight ?: run {
                val h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)
                h < 6 || h >= 18
            }
        }
        if (isNight != lastMode) {
            lastMode = isNight
            palette = if (isNight) NIGHT else DAY
            applyTheme()
        }
    }

    private fun applyTheme() {
        root.setBackgroundColor(Color.parseColor(palette.bg))
        tvStatus.setTextColor(Color.parseColor(palette.status))
        tvDateTime.setTextColor(Color.parseColor(palette.textDim))
        tvLunar.setTextColor(Color.parseColor(palette.textSec))
        tvSpeed.setTextColor(Color.parseColor(palette.speed))
        tvSpeedUnit.setTextColor(Color.parseColor(palette.textSec))
        applyColors(root)
    }

    private fun applyColors(parent: ViewGroup) {
        for (i in 0 until parent.childCount) {
            val v = parent.getChildAt(i)
            if (v is TextView) {
                when (v.tag as? String ?: "") {
                    "label" -> v.setTextColor(Color.parseColor(palette.textSec))
                    "unit" -> v.setTextColor(Color.parseColor(palette.textDim))
                    "green" -> v.setTextColor(Color.parseColor(palette.green))
                    "yellow" -> v.setTextColor(Color.parseColor(palette.yellow))
                    "cyan" -> v.setTextColor(Color.parseColor(palette.cyan))
                    "accent" -> v.setTextColor(Color.parseColor(palette.accent))
                    "value" -> v.setTextColor(Color.parseColor(palette.textPri))
                }
            }
            if (v is ViewGroup) {
                if (v.tag == "card") {
                    val gd = v.background as? GradientDrawable
                    gd?.setColor(Color.parseColor(palette.card))
                    gd?.setStroke(dp(1), Color.parseColor(palette.cardStroke))
                }
                applyColors(v)
            }
        }
    }

    // ====== UI 构建 ======

    private fun buildUI() {
        palette = if (lastMode) NIGHT else DAY

        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.parseColor(palette.bg))
            isVerticalScrollBarEnabled = false
        }

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(10), dp(14), dp(14))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        // ── 顶栏: 日期时间 · 连接状态 ──
        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(4) }
        }
        tvDateTime = label("", palette.textDim, 12f).apply { gravity = Gravity.CENTER }
        topBar.addView(tvDateTime)
        tvLunar = label("", palette.textSec, 12f)
        tvStatus = label("⏳ 等待数据", palette.status, 12f).apply { typeface = Typeface.DEFAULT_BOLD }
        val statusRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
        }
        statusRow.addView(tvLunar)
        statusRow.addView(label(" · ", palette.textDim, 12f))
        statusRow.addView(tvStatus)
        topBar.addView(statusRow)
        root.addView(topBar)

        // ── 大车速卡片 (居中) ──
        val speedCard = cardView().apply { setPadding(dp(20), dp(12), dp(20), dp(12)) }
        val speedInner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
        }
        tvSpeed = valueText("--", palette.speed, 64f).apply {
            typeface = Typeface.defaultFromStyle(Typeface.BOLD)
            tag = "speed"; gravity = Gravity.CENTER
        }
        speedInner.addView(tvSpeed)
        tvSpeedUnit = label("km/h", palette.textSec, 13f)
        speedInner.addView(tvSpeedUnit)
        speedCard.addView(speedInner)
        root.addView(speedCard)
        root.addView(gap(8))

        // ── 三列: 转速 / 水温 / 负荷 ──
        root.addView(tripleRow(
            CellCfg("转速", "rpm", "value", { tvRpm = it }),
            CellCfg("水温", "°C", "value", { tvCoolant = it }),
            CellCfg("负荷", "%", "value", { tvLoad = it })
        ))
        root.addView(gap(6))

        // ── 三列: 油量 / 瞬时油耗 / 续航 ──
        root.addView(tripleRow(
            CellCfg("油量", "%", "value", { tvFuelLvl = it }),
            CellCfg("瞬时油耗", "", "cyan", { tvFuelInst = it }),
            CellCfg("续航", "km", "accent", { tvRange = it })
        ))
        root.addView(gap(6))

        // ── 三列: 本次里程 / 行程时长 / 本次油费 ──
        root.addView(tripleRow(
            CellCfg("本次里程", "km", "value", { tvTripD = it }),
            CellCfg("时长", "", "value", { tvTripT = it }),
            CellCfg("本次油费", "元", "yellow", { tvTripC = it })
        ))
        root.addView(gap(6))

        // ── 双列: 本日 / 本月 ──
        root.addView(doubleRow("本日里程", "km", "本日油费", "元") { a, b -> tvDayD = a; tvDayC = b })
        root.addView(gap(6))
        root.addView(doubleRow("本月里程", "km", "本月油费", "元") { a, b -> tvMonD = a; tvMonC = b })

        // ── 脚标 ──
        root.addView(gap(8))
        root.addView(label("v6.25.1  ·  YOUR_VPS_IP  ·  CarBridge", palette.textDim, 10f).apply { gravity = Gravity.CENTER })

        scroll.addView(root)
        setContentView(scroll)
    }

    // ====== 卡片组件 ======

    private fun cardView() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
        tag = "card"
        val gd = GradientDrawable().apply {
            setColor(Color.parseColor(palette.card))
            cornerRadius = dp(10).toFloat()
            setStroke(dp(1), Color.parseColor(palette.cardStroke))
        }
        background = gd
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun label(t: String, color: String, size: Float) = TextView(this).apply {
        text = t; setTextColor(Color.parseColor(color)); textSize = size
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        tag = "label"
    }

    private fun valueText(t: String, color: String, size: Float) = TextView(this).apply {
        text = t; setTextColor(Color.parseColor(color)); textSize = size
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        tag = "value"
    }

    private fun unitText(t: String, color: String) = TextView(this).apply {
        text = t; setTextColor(Color.parseColor(color)); textSize = 11f
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        tag = "unit"
    }

    private fun cell(label: String, unit: String, valueTag: String, bind: (TextView) -> Unit): View {
        val cell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(4), dp(6), dp(4), dp(6))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        cell.addView(label(label, palette.textSec, 10f).apply { gravity = Gravity.CENTER })
        cell.addView(gap(2))
        val valTv = valueText("--", when(valueTag) {
            "cyan" -> palette.cyan; "yellow" -> palette.yellow
            "accent" -> palette.accent; else -> palette.textPri
        }, 20f).apply {
            tag = valueTag; gravity = Gravity.CENTER
        }
        cell.addView(valTv)
        if (unit.isNotEmpty()) cell.addView(unitText(unit, palette.textDim).apply { gravity = Gravity.CENTER })
        bind(valTv)
        return cell
    }

    private fun tripleRow(c1: CellCfg, c2: CellCfg, c3: CellCfg): View {
        val card = cardView().apply { setPadding(dp(6), dp(6), dp(6), dp(6)) }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(cell(c1.label, c1.unit, c1.valueTag, c1.bind))
        row.addView(cell(c2.label, c2.unit, c2.valueTag, c2.bind))
        row.addView(cell(c3.label, c3.unit, c3.valueTag, c3.bind))
        card.addView(row)
        return card
    }

    private fun doubleRow(l1: String, u1: String, l2: String, u2: String,
                          bind: (TextView, TextView) -> Unit): View {
        val card = cardView().apply { setPadding(dp(10), dp(8), dp(10), dp(8)) }
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        var a: TextView? = null; var b: TextView? = null
        row.addView(cell(l1, u1, "value") { a = it })
        row.addView(cell(l2, u2, "yellow") { b = it })
        card.addView(row)
        bind(a!!, b!!)
        return card
    }

    private fun spacer(w: Int, weight: Float) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(if (w > 0) dp(w) else 0, LinearLayout.LayoutParams.WRAP_CONTENT, weight)
    }

    private fun gap(h: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(h))
    }

    // ====== 数据轮询 200ms ======

    // 旧请求取消: 车库出来后堆积请求会集中返回，新请求发起时断开旧的
    @Volatile private var pendingConn: HttpURLConnection? = null

    private fun startPolling() {
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (!polling) return
                httpThread.execute { fetchAndRefresh() }
                handler.postDelayed(this, 200L)
            }
        }, 200L)
    }

    private fun fetchAndRefresh() {
        // 断开上一轮未完成的连接（地下车库断网后堆积，新请求立即取消旧的）
        pendingConn?.let {
            try { it.disconnect() } catch (_: Exception) {}
        }
        try {
            val conn = URL("http://YOUR_VPS_IP:8899/api/query/state").openConnection() as HttpURLConnection
            conn.connectTimeout = 2000; conn.readTimeout = 2000
            pendingConn = conn
            if (conn.responseCode != 200) { conn.disconnect(); pendingConn = null; return }
            val body = conn.inputStream.bufferedReader().readText(); conn.disconnect(); pendingConn = null
            val j = JSONObject(body)

            val rpm = j.optDouble("engineRpm", -1.0)
            val spd = j.optDouble("obdSpeed", 0.0)
            val cool = j.optDouble("coolantTemp", -1.0)
            val load = j.opt("engineLoad")?.let { (it as? Number)?.toDouble() } ?: -1.0
            val fuelLvl = j.optDouble("fuelLevel", 0.0)
            val fuelInst = j.opt("fuelPer100km")?.let { (it as? Number)?.toDouble() }
            val range = j.opt("remainingRange")?.let { (it as? Number)?.toInt() }
            val tripD = j.optDouble("tripDistanceKm", 0.0)
            val tripT = j.optString("tripDuration", "--")
            val tripC = j.optDouble("tripFuelCost", 0.0)
            val dayD = j.optDouble("dailyDistanceKm", 0.0)
            val dayC = j.optDouble("dailyFuelCost", 0.0)
            val monD = j.optDouble("monthlyDistanceKm", 0.0)
            val monC = j.optDouble("monthlyFuelCost", 0.0)
            val inTrip = j.optBoolean("inTrip", false)
            val isNight = j.optBoolean("isNight", lastMode)
            vpsIsNight = isNight

            val status = when {
                inTrip -> "● 行驶中"
                rpm > 0 -> "● ${rpm.toInt()} rpm"
                else -> "○ 等待"
            }
            val cal = Calendar.getInstance()
            val dateTimeStr = String.format("%04d-%02d-%02d %02d:%02d:%02d",
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH),
                cal.get(Calendar.HOUR_OF_DAY), cal.get(Calendar.MINUTE), cal.get(Calendar.SECOND))
            val lunarStr = lunarDate(cal)

            handler.post {
                // P0修复: Activity已销毁时放弃UI更新
                if (isFinishing || isDestroyed) return@post
                tvDateTime.text = dateTimeStr
                tvLunar.text = lunarStr
                if (status != tvStatus.text) tvStatus.text = status
                if (spd >= 0) tvSpeed.text = if (spd > 0) spd.toInt().toString() else "0"
                if (rpm >= 0) tvRpm.text = rpm.toInt().toString()
                if (cool >= 0) tvCoolant.text = cool.toInt().toString()
                if (load >= 0) tvLoad.text = "%.0f".format(load)
                tvFuelLvl.text = "%.0f".format(fuelLvl)
                tvFuelInst.text = if (fuelInst != null && fuelInst > 0) "%.1f".format(fuelInst) else "--"
                tvRange.text = range?.toString() ?: "--"
                tvTripD.text = "%.1f".format(tripD)
                tvTripT.text = tripT
                tvTripC.text = "%.1f".format(tripC)
                tvDayD.text = "%.1f".format(dayD)
                tvDayC.text = "%.1f".format(dayC)
                tvMonD.text = "%.1f".format(monD)
                tvMonC.text = "%.1f".format(monC)
            }
        } catch (_: Exception) { pendingConn = null }
    }

    // ====== 权限 ======

    private fun requestPermissions() {
        val perms = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            perms.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                perms.add(Manifest.permission.POST_NOTIFICATIONS)
        if (perms.isNotEmpty()) ActivityCompat.requestPermissions(this, perms.toTypedArray(), 1001)
    }

    private fun createNotifyChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel("caragent_channel", "车机助手", NotificationManager.IMPORTANCE_LOW))
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
}
