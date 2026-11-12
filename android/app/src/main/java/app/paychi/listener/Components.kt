package app.paychi.listener

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService

/**
 * The SMS receiver and the notification listener are switched off at the system level while the
 * phone is not connected to an account: Android then never wakes the app for SMS or notifications.
 */
object Components {
    private val listeners = listOf(SmsReceiver::class.java, NotifListener::class.java)

    fun update(ctx: Context) {
        val on = Store.token(ctx).isNotEmpty()
        val pm = ctx.packageManager
        val want = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        for (cls in listeners) {
            val cn = ComponentName(ctx, cls)
            if (pm.getComponentEnabledSetting(cn) == want) continue
            pm.setComponentEnabledSetting(cn, want, PackageManager.DONT_KILL_APP)
            if (on && cls == NotifListener::class.java) {
                // If notification access was granted earlier, ask the system to bind the listener again.
                try {
                    NotificationListenerService.requestRebind(cn)
                } catch (_: Exception) {
                }
            }
        }
    }
}
