package app.paychi.listener

/**
 * On-device filter used when the dashboard has no explicit sender list.
 * Only messages that look like a bank deposit leave the phone, so login codes
 * and private messages are never forwarded.
 */
object Filter {
    private val mobileSender = Regex("^(\\+?98|0098|0)?9\\d{9}$")
    private val depositWord = Regex("واریز|deposit|credited", RegexOption.IGNORE_CASE)
    private val plusAmount = Regex("(\\+\\s*\\d[\\d,]{3,})|(\\d[\\d,]{3,}\\s*\\+)")
    private val spaces = Regex("[\\s-]")

    private fun latinDigits(s: String) = buildString(s.length) {
        for (c in s) append(
            when (c) {
                in '۰'..'۹' -> '0' + (c - '۰')
                in '٠'..'٩' -> '0' + (c - '٠')
                'ي' -> 'ی'
                else -> c
            }
        )
    }

    /** Banks send from sender names or short codes, never from a personal mobile number. */
    fun isMobileNumber(sender: String) =
        mobileSender.matches(latinDigits(sender).replace(spaces, ""))

    fun looksLikeDeposit(body: String): Boolean {
        val text = latinDigits(body)
        return depositWord.containsMatchIn(text) || plusAmount.containsMatchIn(text)
    }
}
