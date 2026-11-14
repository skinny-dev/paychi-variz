package app.paychi.listener

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet

/**
 * On-device event log for the developer screen: what arrived, what was sent, what the server
 * answered. Stays on the phone (never uploaded); the newest [MAX] entries are kept.
 * Also mirrored to logcat under the tag "Paychi".
 */
object EventLog {
    enum class Level { SUCCESS, ERROR, WARN, INFO }

    data class Entry(val time: Long, val level: Level, val title: String, val detail: String)

    private const val MAX = 300
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val stamp = SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.US)

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("paychi_log", Context.MODE_PRIVATE)

    fun success(ctx: Context, title: String, detail: String = "") = add(ctx, Level.SUCCESS, title, detail)
    fun error(ctx: Context, title: String, detail: String = "") = add(ctx, Level.ERROR, title, detail)
    fun warn(ctx: Context, title: String, detail: String = "") = add(ctx, Level.WARN, title, detail)
    fun info(ctx: Context, title: String, detail: String = "") = add(ctx, Level.INFO, title, detail)

    @Synchronized
    fun add(ctx: Context, level: Level, title: String, detail: String = "") {
        val arr = try { JSONArray(prefs(ctx).getString("log", "[]")) } catch (_: Exception) { JSONArray() }
        arr.put(
            JSONObject()
                .put("t", System.currentTimeMillis())
                .put("l", level.name)
                .put("title", title)
                .put("d", detail.take(2000))
        )
        while (arr.length() > MAX) arr.remove(0)
        prefs(ctx).edit().putString("log", arr.toString()).apply()
        val priority = when (level) {
            Level.ERROR -> android.util.Log.ERROR
            Level.WARN -> android.util.Log.WARN
            else -> android.util.Log.INFO
        }
        android.util.Log.println(priority, "Paychi", if (detail.isEmpty()) title else "$title | ${detail.replace('\n', ' ')}")
        listeners.forEach { it() }
    }

    /** Newest first. */
    @Synchronized
    fun all(ctx: Context): List<Entry> {
        val arr = try { JSONArray(prefs(ctx).getString("log", "[]")) } catch (_: Exception) { JSONArray() }
        return (arr.length() - 1 downTo 0).map {
            val o = arr.getJSONObject(it)
            Entry(
                o.optLong("t"),
                runCatching { Level.valueOf(o.optString("l")) }.getOrDefault(Level.INFO),
                o.optString("title"),
                o.optString("d"),
            )
        }
    }

    @Synchronized
    fun clear(ctx: Context) {
        prefs(ctx).edit().remove("log").apply()
        listeners.forEach { it() }
    }

    fun time(t: Long): String = synchronized(stamp) { stamp.format(Date(t)) }

    fun format(e: Entry): String {
        val tag = when (e.level) {
            Level.SUCCESS -> "OK  "
            Level.ERROR -> "ERR "
            Level.WARN -> "WARN"
            Level.INFO -> "INFO"
        }
        return "[${time(e.time)}] $tag ${e.title}" + if (e.detail.isEmpty()) "" else "\n    " + e.detail.replace("\n", "\n    ")
    }

    fun listen(l: () -> Unit) = listeners.add(l)
    fun unlisten(l: () -> Unit) = listeners.remove(l)

    /** 12,345,000 */
    fun money(v: Long): String = String.format(Locale.US, "%,d", v)

    /** True for addresses only reachable on a local network (a dev server), not from the internet. */
    fun isLocalServer(url: String): Boolean {
        val host = runCatching { android.net.Uri.parse(url).host }.getOrNull()?.lowercase() ?: return false
        if (host == "localhost" || host.endsWith(".local") || host.startsWith("127.") || host.startsWith("10.") ||
            host.startsWith("192.168.")
        ) return true
        val m = Regex("^172\\.(\\d+)\\.").find(host) ?: return false
        return m.groupValues[1].toInt() in 16..31
    }
}
