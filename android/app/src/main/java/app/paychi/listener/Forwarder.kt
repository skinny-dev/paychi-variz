package app.paychi.listener

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

/** Settings, the optional sender lists synced from the server, and a small retry queue. */
object Store {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("paychi", Context.MODE_PRIVATE)

    fun serverUrl(ctx: Context) = prefs(ctx).getString("url", "")!!.trimEnd('/')
    fun token(ctx: Context) = prefs(ctx).getString("token", "")!!
    fun account(ctx: Context) = prefs(ctx).getString("account", "")!!
    fun save(ctx: Context, url: String, token: String, account: String = "") {
        prefs(ctx).edit()
            .putString("url", url.trim().trimEnd('/'))
            .putString("token", token.trim())
            .putString("account", account)
            .commit()
        Components.update(ctx)
    }

    /** Forget the connection (keeps the server address for the next sign-in). */
    fun signOut(ctx: Context) {
        prefs(ctx).edit().remove("token").remove("account").remove("sms").remove("pkg")
            .remove("queue").remove("status").remove("lastSync").commit()
        Components.update(ctx)
    }

    /** Set once Android's "restricted setting" lock blocked a permission, to keep showing how to unlock it. */
    fun unlockHint(ctx: Context) = prefs(ctx).getBoolean("unlockHint", false)
    fun setUnlockHint(ctx: Context, on: Boolean) = prefs(ctx).edit().putBoolean("unlockHint", on).apply()

    /** When the optional sender lists were last downloaded (to avoid syncing on every app open). */
    fun lastSync(ctx: Context) = prefs(ctx).getLong("lastSync", 0)
    fun setLastSync(ctx: Context) = prefs(ctx).edit().putLong("lastSync", System.currentTimeMillis()).apply()

    /** Stable id of this app install, so signing in again reuses the same device entry. */
    fun installId(ctx: Context): String {
        prefs(ctx).getString("install", null)?.let { return it }
        val id = UUID.randomUUID().toString()
        prefs(ctx).edit().putString("install", id).apply()
        return id
    }

    fun smsSenders(ctx: Context): Set<String> = prefs(ctx).getStringSet("sms", emptySet())!!
    fun packages(ctx: Context): Set<String> = prefs(ctx).getStringSet("pkg", emptySet())!!
    fun saveSources(ctx: Context, sms: Set<String>, pkg: Set<String>) =
        prefs(ctx).edit().putStringSet("sms", sms).putStringSet("pkg", pkg).apply()

    fun lastStatus(ctx: Context) = prefs(ctx).getString("status", "")!!
    fun setStatus(ctx: Context, s: String) = prefs(ctx).edit().putString("status", s).apply()

    @Synchronized
    fun queue(ctx: Context): JSONArray = JSONArray(prefs(ctx).getString("queue", "[]"))

    @Synchronized
    fun setQueue(ctx: Context, q: JSONArray) = prefs(ctx).edit().putString("queue", q.toString()).apply()
}

object Forwarder {
    private val io = Executors.newSingleThreadExecutor()
    private const val MAX_QUEUE = 200

    /** Queue a message and try to deliver everything pending. `done` runs when the attempt finishes. */
    fun submit(ctx: Context, type: String, sender: String, body: String, done: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        io.execute {
            try {
                val q = Store.queue(app)
                q.put(
                    JSONObject()
                        .put("type", type)
                        .put("sender", sender)
                        .put("body", body)
                        .put("received_at", System.currentTimeMillis())
                )
                while (q.length() > MAX_QUEUE) q.remove(0)
                Store.setQueue(app, q)
                flushLocked(app)
            } finally {
                done?.invoke()
            }
        }
    }

    fun flush(ctx: Context) {
        val app = ctx.applicationContext
        io.execute { flushLocked(app) }
    }

    /** Used by [FlushJob]: deliver the queue, report whether it should be retried later. */
    fun flushForJob(ctx: Context, done: (retry: Boolean) -> Unit) {
        val app = ctx.applicationContext
        io.execute { done(flushLocked(app, fromJob = true)) }
    }

    /**
     * Deliver queued messages in order. Returns true when delivery stopped on a temporary problem
     * (no network, server error, rate limit) and should be retried. Retries are left to the system
     * ([FlushJob], runs only when the network is up, exponential backoff) — no timers, no wakelocks.
     */
    private fun flushLocked(app: Context, fromJob: Boolean = false): Boolean {
        val url = Store.serverUrl(app)
        val token = Store.token(app)
        if (url.isEmpty() || token.isEmpty()) return false
        val q = Store.queue(app)
        var retry = false
        while (q.length() > 0) {
            val code = try {
                request("POST", "$url/api/device/ingest", token, q.getJSONObject(0).toString()).first
            } catch (e: Exception) {
                Store.setStatus(app, "خطای شبکه: ${e.message}")
                -1
            }
            // 2xx: delivered. 4xx (except 401/429): the server rejected it for good — drop it.
            val drop = code in 200..299 || (code in 400..499 && code != 401 && code != 429)
            if (!drop) {
                if (code > 0) Store.setStatus(app, "خطای سرور: $code")
                retry = code != 401 // 401 needs the user to reconnect, retrying cannot help
                break
            }
            q.remove(0)
            Store.setQueue(app, q)
            if (code in 200..299) Store.setStatus(app, "آخرین ارسال موفق: " + java.util.Date())
        }
        if (retry && !fromJob) FlushJob.schedule(app)
        return retry
    }

    /** Sign in with the account's phone + password; the server creates this device and returns its token. */
    fun login(ctx: Context, url: String, phone: String, password: String, cb: (ok: Boolean, message: String) -> Unit) {
        val app = ctx.applicationContext
        val base = url.trim().trimEnd('/')
        io.execute {
            try {
                val body = JSONObject()
                    .put("phone", phone.trim())
                    .put("password", password)
                    .put("platform", "android")
                    .put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    .put("install_id", Store.installId(app))
                val (code, text) = request("POST", "$base/api/device/login", null, body.toString())
                if (code == 200) {
                    val json = JSONObject(text)
                    val acc = json.getJSONObject("account")
                    val name = acc.optString("name").ifEmpty { acc.optString("phone") }
                    Store.save(app, base, json.getString("token"), name)
                    syncLocked(app)
                    cb(true, name)
                } else {
                    cb(false, errorMessage(text, code))
                }
            } catch (e: Exception) {
                cb(false, e.message ?: "error")
            }
        }
    }

    /** Quick connect: redeem the one-time code from the dashboard's QR / link. */
    fun pair(ctx: Context, url: String, code: String, cb: (ok: Boolean, message: String) -> Unit) {
        val app = ctx.applicationContext
        val base = url.trim().trimEnd('/')
        io.execute {
            try {
                val body = JSONObject()
                    .put("code", code)
                    .put("platform", "android")
                    .put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                    .put("install_id", Store.installId(app))
                val (status, text) = request("POST", "$base/api/device/pair", null, body.toString())
                if (status == 200) {
                    val json = JSONObject(text)
                    val acc = json.getJSONObject("account")
                    val name = acc.optString("name").ifEmpty { acc.optString("phone") }
                    Store.signOut(app)
                    Store.save(app, base, json.getString("token"), name)
                    syncLocked(app)
                    cb(true, name)
                } else {
                    cb(false, errorMessage(text, status))
                }
            } catch (e: Exception) {
                cb(false, e.message ?: "error")
            }
        }
    }

    /** Developer path: connect with a device token created in the dashboard. */
    fun connectWithToken(ctx: Context, url: String, token: String, cb: (ok: Boolean, message: String) -> Unit) {
        val app = ctx.applicationContext
        io.execute {
            try {
                val base = url.trim().trimEnd('/')
                val (code, text) = request("GET", "$base/api/device/config", token.trim(), null)
                if (code == 200) {
                    val acc = JSONObject(text).optJSONObject("account")
                    val name = acc?.optString("name")?.ifEmpty { acc.optString("phone") } ?: ""
                    Store.save(app, base, token, name)
                    syncLocked(app)
                    cb(true, name)
                } else {
                    cb(false, errorMessage(text, code))
                }
            } catch (e: Exception) {
                cb(false, e.message ?: "error")
            }
        }
    }

    /** Revoke this device on the server (best effort) and forget it locally. */
    fun logout(ctx: Context, cb: () -> Unit) {
        val app = ctx.applicationContext
        io.execute {
            try {
                request("POST", Store.serverUrl(app) + "/api/device/logout", Store.token(app), "{}")
            } catch (_: Exception) {
            }
            Store.signOut(app)
            cb()
        }
    }

    /** Refresh the optional sender lists. */
    fun sync(ctx: Context, cb: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        io.execute {
            try {
                syncLocked(app)
            } catch (_: Exception) {
            }
            cb?.invoke()
        }
    }

    private fun syncLocked(app: Context) {
        val (code, text) = request("GET", Store.serverUrl(app) + "/api/device/config", Store.token(app), null)
        if (code != 200) return
        val json = JSONObject(text)
        Store.saveSources(app, json.getJSONArray("sms_senders").toSet(), json.getJSONArray("notification_packages").toSet())
        Store.setLastSync(app)
        flushLocked(app)
    }

    private fun errorMessage(text: String, code: Int): String =
        try {
            JSONObject(text).getJSONObject("error").getString("message")
        } catch (_: Exception) {
            "HTTP $code"
        }

    private fun JSONArray.toSet(): Set<String> = (0 until length()).map { getString(it) }.toSet()

    private fun request(method: String, url: String, token: String?, body: String?): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = 10_000
            if (!token.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val stream = if (code in 200..299) c.inputStream else c.errorStream
            // Reading the body to the end (and not calling disconnect) lets the connection be reused,
            // so back-to-back messages skip a new TCP/TLS handshake and the radio wakes less.
            return code to (stream?.bufferedReader()?.use { it.readText() } ?: "")
        } catch (e: Exception) {
            c.disconnect()
            throw e
        }
    }
}
