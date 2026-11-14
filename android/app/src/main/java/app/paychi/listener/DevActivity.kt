package app.paychi.listener

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.ChipGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder

/** Developer screen: connection details and the colored event log. */
class DevActivity : AppCompatActivity() {
    private var filter: EventLog.Level? = null
    private val onChange: () -> Unit = { runOnUiThread { render() } }

    private fun <T : View> v(id: Int): T = findViewById(id)
    private fun dp(x: Int) = (x * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dev)
        v<MaterialToolbar>(R.id.toolbar).setNavigationOnClickListener { finish() }

        v<MaterialButton>(R.id.ping).setOnClickListener { btn ->
            btn.isEnabled = false
            Forwarder.ping(this) { runOnUiThread { btn.isEnabled = true; renderInfo() } }
        }
        v<MaterialButton>(R.id.flush).setOnClickListener {
            val n = Store.queue(this).length()
            if (n == 0) EventLog.info(this, "صف خالی است", "پیامی برای ارسال نیست")
            else {
                EventLog.info(this, "ارسال دستی صف", "$n پیام")
                Forwarder.flush(this)
            }
        }
        v<MaterialButton>(R.id.copy).setOnClickListener {
            val text = infoText() + "\n\n" + entries().joinToString("\n\n") { EventLog.format(it) }
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Paychi log", text))
            Toast.makeText(this, R.string.dev_copied, Toast.LENGTH_SHORT).show()
        }
        v<MaterialButton>(R.id.clear).setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setMessage(R.string.dev_clear_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.dev_clear) { _, _ -> EventLog.clear(this) }
                .show()
        }
        v<ChipGroup>(R.id.filters).setOnCheckedStateChangeListener { _, ids ->
            filter = when (ids.firstOrNull()) {
                R.id.fSuccess -> EventLog.Level.SUCCESS
                R.id.fError -> EventLog.Level.ERROR
                R.id.fWarn -> EventLog.Level.WARN
                R.id.fInfo -> EventLog.Level.INFO
                else -> null
            }
            render()
        }
    }

    override fun onResume() {
        super.onResume()
        EventLog.listen(onChange)
        render()
    }

    override fun onPause() {
        super.onPause()
        EventLog.unlisten(onChange)
    }

    private fun entries() = EventLog.all(this).let { all -> filter?.let { f -> all.filter { it.level == f } } ?: all }

    private fun smsGranted() = checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
    private fun notifGranted(): Boolean {
        val cn = android.content.ComponentName(this, NotifListener::class.java)
        return Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
            ?.split(':')?.any { it == cn.flattenToString() } == true
    }

    private fun yesNo(b: Boolean) = if (b) "✓" else "✗"

    private fun infoText(): String {
        val pi = packageManager.getPackageInfo(packageName, 0)
        val url = Store.serverUrl(this)
        val sync = Store.lastSync(this)
        return listOf(
            "سرور: ${url.ifEmpty { "—" }}" + if (EventLog.isLocalServer(url)) "  ⚠ محلی" else "",
            "حساب: ${Store.account(this).ifEmpty { "—" }}   اتصال: ${yesNo(Store.token(this).isNotEmpty())}",
            "دسترسی پیامک: ${yesNo(smsGranted())}   دسترسی اعلان: ${yesNo(notifGranted())}",
            "فرستنده‌های مجاز: " + (if (Store.smsSenders(this).isEmpty()) "همه بانک‌ها" else Store.smsSenders(this).joinToString(", ")),
            "در صف ارسال: ${Store.queue(this).length()}",
            "آخرین همگام‌سازی: " + if (sync > 0) EventLog.time(sync) else "—",
            "نسخه برنامه: ${pi.versionName}   اندروید: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "دستگاه: ${Build.MANUFACTURER} ${Build.MODEL}",
        ).joinToString("\n")
    }

    private fun renderInfo() {
        v<TextView>(R.id.info).text = infoText()
    }

    private fun render() {
        renderInfo()
        val list = v<LinearLayout>(R.id.list)
        list.removeAllViews()
        val items = entries()
        v<View>(R.id.empty).visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        for (e in items) list.addView(row(e))
    }

    private fun color(level: EventLog.Level) = getColor(
        when (level) {
            EventLog.Level.SUCCESS -> R.color.log_success
            EventLog.Level.ERROR -> R.color.log_error
            EventLog.Level.WARN -> R.color.log_warn
            EventLog.Level.INFO -> R.color.log_info
        }
    )

    private fun row(e: EventLog.Entry): View {
        val c = color(e.level)
        val icon = when (e.level) {
            EventLog.Level.SUCCESS -> "●"
            EventLog.Level.ERROR -> "●"
            EventLog.Level.WARN -> "▲"
            EventLog.Level.INFO -> "○"
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(10), 0, dp(10))
        }
        // Colored bar at the start edge.
        row.addView(View(this).apply { setBackgroundColor(c) }, LinearLayout.LayoutParams(dp(4), LinearLayout.LayoutParams.MATCH_PARENT))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPaddingRelative(dp(12), 0, 0, 0)
        }
        col.addView(TextView(this).apply {
            text = "$icon  ${e.title}"
            setTextColor(c)
            setTypeface(typeface, Typeface.BOLD)
            textSize = 15f
        })
        col.addView(TextView(this).apply {
            text = EventLog.time(e.time)
            textSize = 11f
            alpha = 0.6f
            textDirection = View.TEXT_DIRECTION_LTR
            gravity = Gravity.START
        })
        if (e.detail.isNotEmpty()) col.addView(TextView(this).apply {
            text = e.detail
            textSize = 13f
            setLineSpacing(0f, 1.25f)
            setPadding(0, dp(4), 0, 0)
            setTextIsSelectable(true)
        })
        row.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.setOnLongClickListener {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Paychi log", EventLog.format(e)))
            Toast.makeText(this, R.string.dev_copied, Toast.LENGTH_SHORT).show()
            true
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(row)
            addView(View(context).apply { setBackgroundColor(getColor(R.color.md_outline_variant)) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1))
        }
    }
}
