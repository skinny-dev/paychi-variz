package app.paychi.listener

import android.app.Notification
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Forwards bank-app deposit notifications. Listening is on by default for every app except
 * chats, email and the SMS app (anyone can put text into those); if the dashboard has an
 * app list, only those apps are forwarded.
 *
 * Battery: Android calls this for every notification on the phone, including each progress
 * update of a download or music player. The cheapest checks run first and nothing is read from
 * the notification until it could plausibly be a bank deposit. On Android 13+ the manifest also
 * asks the system not to deliver ongoing notifications and conversations at all.
 */
class NotifListener : NotificationListenerService() {
    private val personalCategories = setOf(
        Notification.CATEGORY_MESSAGE, Notification.CATEGORY_EMAIL, Notification.CATEGORY_CALL,
        Notification.CATEGORY_SOCIAL, Notification.CATEGORY_PROGRESS, Notification.CATEGORY_TRANSPORT,
        Notification.CATEGORY_SERVICE, Notification.CATEGORY_ALARM, Notification.CATEGORY_NAVIGATION,
        Notification.CATEGORY_STOPWATCH, Notification.CATEGORY_LOCATION_SHARING,
    )
    private val systemPackages = setOf("android", "com.android.systemui")
    private var smsApp: String? = null

    /** Last text seen per notification key: an app re-posting the same notification is not re-sent. */
    private val lastSeen = object : LinkedHashMap<String, Int>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?) = size > 64
    }

    override fun onListenerConnected() {
        smsApp = Telephony.Sms.getDefaultSmsPackage(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg == packageName || pkg in systemPackages) return
        val n = sbn.notification ?: return
        if (sbn.isOngoing || n.flags and (Notification.FLAG_GROUP_SUMMARY or Notification.FLAG_FOREGROUND_SERVICE) != 0) return

        val allowed = Store.packages(this)
        if (allowed.isNotEmpty() && pkg !in allowed) return
        if (allowed.isEmpty()) {
            // SMS is already handled by SmsReceiver; chat / mail notifications are untrusted text.
            if (n.category in personalCategories || pkg == smsApp) return
        }

        val extras = n.extras ?: return
        if (allowed.isEmpty() && extras.containsKey(Notification.EXTRA_MESSAGES)) return
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (text.isBlank()) return
        if (allowed.isEmpty() && !Filter.looksLikeDeposit(text)) return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val body = if (title.isBlank()) text else "$title\n$text"
        synchronized(lastSeen) {
            if (lastSeen[sbn.key] == body.hashCode()) return
            lastSeen[sbn.key] = body.hashCode()
        }
        Forwarder.submit(this, "notification", pkg, body)
    }
}
