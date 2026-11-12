package app.paychi.listener

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Material 3 setup screen.
 * Default path: sign in with the dashboard phone + password and the phone pairs itself.
 * Developer path: paste a device token created in the dashboard.
 */
class MainActivity : AppCompatActivity() {
    private var tokenMode = false

    /** Where the guided permission setup is; it continues by itself when the user comes back. */
    private enum class Step { NONE, SMS, NOTIF, APP_INFO }
    private var step = Step.NONE
    private var unlockFor = Step.NONE

    companion object {
        private const val REQ_SMS = 2
        private const val SYNC_EVERY_MS = 15 * 60_000L
    }

    /** In-app QR scanner: reads the dashboard's quick-connect code (<server>/connect#<code>). */
    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val text = result.contents ?: return@registerForActivityResult
        val uri = Uri.parse(text.trim())
        // The user chose to scan this code, so connect straight away; only ask when it would
        // replace an existing connection.
        val ask = Store.token(this).isNotEmpty()
        when {
            uri.scheme == "paychi" && uri.host == "pair" ->
                confirmPair(uri.getQueryParameter("u").orEmpty(), uri.getQueryParameter("c").orEmpty(), ask)
            uri.scheme in setOf("http", "https") && uri.path == "/connect" && !uri.fragment.isNullOrEmpty() ->
                confirmPair("${uri.scheme}://${uri.encodedAuthority}", uri.fragment!!, ask)
            else -> MaterialAlertDialogBuilder(this)
                .setMessage(R.string.scan_invalid)
                .setPositiveButton(android.R.string.ok, null)
                .show()
        }
    }

    private fun <T : View> v(id: Int): T = findViewById(id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val url = v<TextInputEditText>(R.id.url)
        val phone = v<TextInputEditText>(R.id.phone)
        val password = v<TextInputEditText>(R.id.password)
        val token = v<TextInputEditText>(R.id.token)
        val login = v<MaterialButton>(R.id.login)
        val error = v<TextView>(R.id.error)
        url.setText(Store.serverUrl(this).ifEmpty { getString(R.string.default_server_url) })

        v<MaterialButton>(R.id.scan).setOnClickListener {
            scanner.launch(
                ScanOptions()
                    .setCaptureActivity(ScanActivity::class.java)
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(getString(R.string.scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(false)
            )
        }

        v<MaterialButton>(R.id.mode).setOnClickListener {
            tokenMode = !tokenMode
            applyMode()
        }

        login.setOnClickListener {
            val server = url.text.toString().trim()
            val secret = (if (tokenMode) token.text else password.text).toString()
            if (server.isEmpty() || secret.isEmpty() || (!tokenMode && phone.text.isNullOrBlank())) {
                error.setText(R.string.fill_all)
                error.visibility = View.VISIBLE
                return@setOnClickListener
            }
            error.visibility = View.GONE
            login.isEnabled = false
            login.setText(R.string.connecting)
            val done = { ok: Boolean, message: String ->
                runOnUiThread {
                    login.isEnabled = true
                    if (ok) {
                        password.setText("")
                        token.setText("")
                    } else {
                        error.text = getString(R.string.sync_error, message)
                        error.visibility = View.VISIBLE
                    }
                    applyMode()
                    refresh()
                    if (ok) nextSetupStep()
                }
            }
            if (tokenMode) Forwarder.connectWithToken(this, server, secret, done)
            else Forwarder.login(this, server, phone.text.toString(), secret, done)
        }

        v<MaterialButton>(R.id.logout).setOnClickListener {
            Forwarder.logout(this) { runOnUiThread { refresh() } }
        }
        v<MaterialButton>(R.id.setupAll).setOnClickListener { advanceSetup() }
        v<MaterialButton>(R.id.grantSms).setOnClickListener { askSms() }
        v<MaterialButton>(R.id.grantNotif).setOnClickListener { openNotifAccess() }
        v<MaterialButton>(R.id.openAppInfo).setOnClickListener { goUnlock(if (!smsGranted()) Step.SMS else Step.NOTIF) }
        applyMode()
        handlePairLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairLink(intent)
    }

    /**
     * paychi://pair?u=<server>&c=<code> from the dashboard's quick-connect page.
     * Any web page can fire this link, so nothing happens until the user confirms the server shown.
     */
    private fun handlePairLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW || data.scheme != "paychi" || data.host != "pair") return
        intent.data = null // handle once, not again on rotation
        confirmPair(data.getQueryParameter("u").orEmpty(), data.getQueryParameter("c").orEmpty())
    }

    /** Show which server this phone would report to and connect only if the user agrees. */
    private fun confirmPair(serverRaw: String, code: String, ask: Boolean = true) {
        val server = serverRaw.trim().trimEnd('/')
        val parsed = Uri.parse(server)
        if (code.isEmpty() || parsed.host.isNullOrEmpty() || parsed.scheme !in setOf("http", "https")) return

        val connect = {
            val error = v<TextView>(R.id.error)
            error.visibility = View.GONE
            Forwarder.pair(this, server, code) { ok, msg ->
                runOnUiThread {
                    if (!ok) {
                        error.text = getString(R.string.sync_error, msg)
                        error.visibility = View.VISIBLE
                        MaterialAlertDialogBuilder(this)
                            .setMessage(getString(R.string.sync_error, msg))
                            .setPositiveButton(android.R.string.ok, null)
                            .show()
                    }
                    refresh()
                    if (ok) nextSetupStep()
                }
            }
        }
        if (!ask) return connect()

        var message = getString(R.string.pair_message, server)
        if (Store.token(this).isNotEmpty()) {
            message += "\n\n" + getString(R.string.pair_replace, Store.account(this).ifEmpty { Store.serverUrl(this) })
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.pair_title)
            .setMessage(message)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.pair_confirm) { _, _ -> connect() }
            .show()
    }

    private fun smsGranted() =
        checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    private fun notifGranted(): Boolean {
        val cn = android.content.ComponentName(this, NotifListener::class.java)
        if (Build.VERSION.SDK_INT >= 27) {
            return getSystemService(android.app.NotificationManager::class.java)
                ?.isNotificationListenerAccessGranted(cn) == true
        }
        return Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
            ?.split(':')?.any { it == cn.flattenToString() } == true
    }

    // Keep the setup position if Android recreates this screen while the user is in Settings.
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("step", step.name)
        outState.putString("unlockFor", unlockFor.name)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        step = Step.valueOf(savedInstanceState.getString("step") ?: Step.NONE.name)
        unlockFor = Step.valueOf(savedInstanceState.getString("unlockFor") ?: Step.NONE.name)
    }

    // ------------------------------------------------------------------ guided permission setup
    //
    // One button runs: SMS permission → notification access (opened on this app's own switch)
    // → done. If Android's "restricted setting" lock gets in the way, the user is sent to App info
    // with the exact steps, and the setup carries on by itself when they come back.

    /** Right after connecting, start the guided setup straight away. */
    private fun nextSetupStep() = advanceSetup()

    private fun advanceSetup() {
        if (Store.token(this).isEmpty()) return
        when {
            !smsGranted() -> askSms()
            !notifGranted() -> openNotifAccess()
            else -> {
                if (step != Step.NONE) snack(getString(R.string.all_set))
                step = Step.NONE
            }
        }
    }

    private fun askSms() {
        step = Step.SMS
        requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), REQ_SMS)
    }

    /** Opens the notification-access page for this app only (a single switch) where Android supports it. */
    private fun openNotifAccess() {
        step = Step.NOTIF
        val cn = android.content.ComponentName(this, NotifListener::class.java).flattenToString()
        val direct = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
            .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, cn)
        try {
            startActivity(if (Build.VERSION.SDK_INT >= 30) direct else Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        android.widget.Toast.makeText(this, R.string.notif_toast, android.widget.Toast.LENGTH_LONG).show()
    }

    /** Explain Android's lock once, then open App info; the setup resumes when the user returns. */
    private fun showUnlock(target: Step) {
        step = Step.NONE // the dialog's buttons decide what comes next; no second dialog on resume
        Store.setUnlockHint(this, true)
        val reason = getString(if (target == Step.SMS) R.string.unlock_sms else R.string.unlock_notif)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.unlock_title)
            .setMessage(reason + getString(R.string.unlock_steps))
            .setNegativeButton(R.string.later) { _, _ -> step = Step.NONE }
            .setPositiveButton(R.string.unlock_go) { _, _ -> goUnlock(target) }
            .setCancelable(false)
            .show()
    }

    private fun goUnlock(target: Step) {
        step = Step.APP_INFO
        unlockFor = target
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
        )
    }

    private fun snack(text: String, action: Pair<Int, () -> Unit>? = null) {
        val bar = com.google.android.material.snackbar.Snackbar.make(
            v(R.id.status), text, com.google.android.material.snackbar.Snackbar.LENGTH_LONG,
        )
        action?.let { (label, run) -> bar.setAction(label) { run() } }
        bar.show()
    }

    /** Switch the form between phone + password and token. */
    private fun applyMode() {
        v<View>(R.id.phoneLayout).visibility = if (tokenMode) View.GONE else View.VISIBLE
        v<View>(R.id.passwordLayout).visibility = if (tokenMode) View.GONE else View.VISIBLE
        v<View>(R.id.loginHint).visibility = if (tokenMode) View.GONE else View.VISIBLE
        v<View>(R.id.tokenLayout).visibility = if (tokenMode) View.VISIBLE else View.GONE
        v<MaterialButton>(R.id.login).setText(if (tokenMode) R.string.connect else R.string.login)
        v<MaterialButton>(R.id.mode).setText(if (tokenMode) R.string.use_login else R.string.use_token)
    }

    override fun onResume() {
        super.onResume()
        Components.update(this)
        refresh()
        // The sender lists rarely change: sync at most every 15 minutes instead of on every open.
        if (Store.token(this).isNotEmpty() && System.currentTimeMillis() - Store.lastSync(this) > SYNC_EVERY_MS) {
            Forwarder.sync(this) { runOnUiThread { refresh() } }
        }

        // Continue the guided setup where the user left it.
        when (step) {
            Step.NOTIF -> when {
                notifGranted() -> advanceSetup()
                Build.VERSION.SDK_INT >= 33 -> showUnlock(Step.NOTIF)
                else -> step = Step.NONE
            }
            Step.APP_INFO -> when (unlockFor) {
                Step.SMS -> if (smsGranted()) advanceSetup() else askSms()
                Step.NOTIF -> if (notifGranted()) advanceSetup() else openNotifAccess()
                else -> step = Step.NONE
            }
            else -> Unit
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
        if (requestCode != REQ_SMS) return
        when {
            smsGranted() -> advanceSetup() // straight on to notification access
            // Refused without Android showing its question: the restricted-settings lock, or
            // "don't ask again". Both are fixed from App info.
            !shouldShowRequestPermissionRationale(Manifest.permission.RECEIVE_SMS) -> showUnlock(Step.SMS)
            else -> {
                step = Step.NONE
                snack(getString(R.string.sms_denied), R.string.retry to { askSms() })
            }
        }
    }

    private fun refresh() {
        val connected = Store.token(this).isNotEmpty()
        v<View>(R.id.signedOut).visibility = if (connected) View.GONE else View.VISIBLE
        v<View>(R.id.signedIn).visibility = if (connected) View.VISIBLE else View.GONE
        v<TextView>(R.id.account).text = getString(R.string.connected_as, Store.account(this).ifEmpty { "—" })
        v<TextView>(R.id.server).text = Store.serverUrl(this)

        val sms = smsGranted()
        val notif = notifGranted()

        fun show(stateId: Int, buttonId: Int, granted: Boolean) {
            v<TextView>(stateId).setText(if (granted) R.string.granted else R.string.not_granted)
            v<View>(buttonId).visibility = if (granted) View.GONE else View.VISIBLE
        }
        show(R.id.smsState, R.id.grantSms, sms)
        show(R.id.notifState, R.id.grantNotif, notif)
        // Permissions only make sense once connected (the listeners are switched off before that).
        v<View>(R.id.permCard).visibility = if (connected) View.VISIBLE else View.GONE
        v<View>(R.id.setupAll).visibility = if (sms && notif) View.GONE else View.VISIBLE
        v<TextView>(R.id.permHint).setText(if (sms && notif) R.string.perms_done else R.string.perms_hint)
        if (sms && notif) Store.setUnlockHint(this, false)
        // The unlock card appears only after Android's lock actually got in the way once.
        v<View>(R.id.restrictedHelp).visibility =
            if (connected && Store.unlockHint(this) && (!sms || !notif)) View.VISIBLE else View.GONE

        v<TextView>(R.id.status).text = listOfNotNull(
            if (Store.smsSenders(this).isEmpty() && Store.packages(this).isEmpty()) getString(R.string.sources_all)
            else getString(R.string.sources_line, Store.smsSenders(this).size, Store.packages(this).size),
            getString(R.string.queue_line, Store.queue(this).length()),
            Store.lastStatus(this).ifEmpty { null },
        ).joinToString("\n")
    }
}
