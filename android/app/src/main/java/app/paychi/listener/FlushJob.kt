package app.paychi.listener

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context

/**
 * Retries delivery of queued messages after a failure. The system runs it only once the network
 * is available and batches it with other work, so a phone that is offline costs no battery.
 */
class FlushJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Forwarder.flushForJob(this) { retry -> jobFinished(params, retry) }
        return true // finishing on the worker thread
    }

    override fun onStopJob(params: JobParameters) = true // stopped by the system: try again later

    companion object {
        private const val ID = 1001

        fun schedule(ctx: Context) {
            val js = ctx.getSystemService(JobScheduler::class.java) ?: return
            if (js.getPendingJob(ID) != null) return // already waiting; keep its backoff
            js.schedule(
                JobInfo.Builder(ID, ComponentName(ctx, FlushJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build()
            )
        }
    }
}
