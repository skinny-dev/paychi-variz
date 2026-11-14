package app.paychi.listener

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Forwards bank deposit SMS. Listening is on by default for every sender; if the dashboard
 * has a sender list, only those senders are forwarded.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (Store.token(context).isEmpty()) return
        val allowed = Store.smsSenders(context).map { it.lowercase() }.toSet()

        // Multipart messages arrive as several PDUs from the same sender: join them.
        val bySender = LinkedHashMap<String, StringBuilder>()
        for (msg in Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return) {
            val sender = msg.displayOriginatingAddress ?: continue
            bySender.getOrPut(sender) { StringBuilder() }.append(msg.displayMessageBody ?: "")
        }
        val matches = bySender.filter { (sender, body) ->
            val text = body.toString()
            // Why a message stays on the phone (the text of ignored messages is never logged).
            val skip = when {
                allowed.isNotEmpty() && sender.lowercase() !in allowed -> "فرستنده در لیست فرستنده‌های مجاز داشبورد نیست"
                allowed.isNotEmpty() -> null
                Filter.isMobileNumber(sender) -> "فرستنده شماره موبایل است (بانک‌ها از سرشماره پیامک می‌دهند)"
                !Filter.looksLikeDeposit(text) -> "شبیه پیامک واریز نبود (کلمه «واریز» یا مبلغ با + ندارد)"
                else -> null
            }
            if (skip != null) EventLog.info(context, "پیامک نادیده گرفته شد", "از: $sender\nدلیل: $skip")
            else EventLog.info(context, "پیامک بانکی دریافت شد — در حال ارسال", "از: $sender\n" + text.take(300))
            skip == null
        }
        if (matches.isEmpty()) return

        val pending = goAsync()
        var left = matches.size
        for ((sender, body) in matches) {
            Forwarder.submit(context, "sms", sender, body.toString()) {
                synchronized(this) { if (--left == 0) pending.finish() }
            }
        }
    }
}
