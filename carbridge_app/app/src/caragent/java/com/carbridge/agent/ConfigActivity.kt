package com.carbridge.agent

import android.content.res.Configuration
import android.graphics.Typeface
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.preference.PreferenceManager

class ConfigActivity : AppCompatActivity() {

    private var BG = 0xFF0A0E0A.toInt()
    private var CARD = 0xFF0D150D.toInt()
    private var TEXT_PRIMARY = 0xFF00FF41.toInt()
    private var TEXT_SECONDARY = 0xFF00AA33.toInt()
    private var TEXT_DIM = 0xFF00661F.toInt()
    private var BTN_BG = 0xFF00FF41.toInt()
    private var BTN_TEXT = 0xFF0A0E0A.toInt()
    private var EDIT_BG = 0  // set by pickColors()
    private var EDIT_TEXT = 0xFFCCFFCC.toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_config)
        pickColors()
        styleAll()
        loadPrefs()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        pickColors()
        styleAll()
    }

    private fun pickColors() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        if (night) {
            BG = 0xFF0A0E0A.toInt(); CARD = 0xFF0D150D.toInt()
            TEXT_PRIMARY = 0xFF00FF41.toInt(); TEXT_SECONDARY = 0xFF00AA33.toInt()
            TEXT_DIM = 0xFF00661F.toInt(); BTN_BG = 0xFF00FF41.toInt(); BTN_TEXT = 0xFF0A0E0A.toInt()
            EDIT_BG = 0xFF1A2A1A.toInt(); EDIT_TEXT = 0xFFCCFFCC.toInt()
        } else {
            BG = 0xFFFAFAFA.toInt(); CARD = 0xFFFFFFFF.toInt()
            TEXT_PRIMARY = 0xFF1B5E20.toInt(); TEXT_SECONDARY = 0xFF388E3C.toInt()
            TEXT_DIM = 0xFF4CAF50.toInt(); BTN_BG = 0xFF2E7D32.toInt(); BTN_TEXT = 0xFFFFFFFF.toInt()
            EDIT_BG = 0xFFFFFFFF.toInt(); EDIT_TEXT = 0xFF1B5E20.toInt()
        }
    }

    private fun styleAll() {
        findViewById<ScrollView>(R.id.config_scroll).setBackgroundColor(BG)
        findViewById<LinearLayout>(R.id.config_layout).setBackgroundColor(BG)

        val labels = listOf(R.id.tv_config_title, R.id.tv_label_server, R.id.tv_label_key, R.id.tv_label_interval)
        val edits = listOf(R.id.et_server_url, R.id.et_api_key, R.id.et_interval)

        for (id in labels) {
            val tv = findViewById<TextView>(id)
            tv.setTextColor(TEXT_PRIMARY)
            tv.typeface = Typeface.MONOSPACE
            if (id == R.id.tv_config_title) tv.setTextColor(TEXT_SECONDARY)
        }
        for (id in edits) {
            val et = findViewById<EditText>(id)
            et.setTextColor(EDIT_TEXT)
            et.setBackgroundColor(EDIT_BG)
            et.typeface = Typeface.MONOSPACE
            et.setHintTextColor(TEXT_DIM)
        }

        val btn = findViewById<Button>(R.id.btn_save)
        btn.setTextColor(BTN_TEXT)
        btn.setBackgroundColor(BTN_BG)
        btn.textSize = 13f
        btn.typeface = Typeface.MONOSPACE
        btn.text = "[ 保存 ]"
    }

    private fun loadPrefs() {
        val prefs = PreferenceManager.getDefaultSharedPreferences(this)
        findViewById<EditText>(R.id.et_server_url).setText(prefs.getString("server_url", "http://YOUR_VPS_IP:8899"))
        findViewById<EditText>(R.id.et_api_key).setText(prefs.getString("api_key", "YOUR_CARBRIDGE_API_KEY"))
        findViewById<EditText>(R.id.et_interval).setText(prefs.getString("report_interval", "30"))
        findViewById<Button>(R.id.btn_save).setOnClickListener {
            prefs.edit()
                .putString("server_url", findViewById<EditText>(R.id.et_server_url).text.toString().trim())
                .putString("api_key", findViewById<EditText>(R.id.et_api_key).text.toString().trim())
                .putString("report_interval", findViewById<EditText>(R.id.et_interval).text.toString().trim())
                .apply()
            finish()
        }
    }
}
