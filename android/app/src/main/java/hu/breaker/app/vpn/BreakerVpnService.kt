package hu.breaker.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import hu.breaker.app.MainActivity
import hu.breaker.app.R
import hu.breaker.app.core.Blocklist
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.Referee
import hu.breaker.app.core.UsageLogic
import hu.breaker.app.usage.UsageTracker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor

/**
 * DNS sinkhole VPN. Only the virtual DNS addresses are routed into the TUN, so
 * ordinary traffic flows untouched; every DNS lookup passes through us and
 * blocked names get NXDOMAIN — in every app and browser, incognito included.
 */
class BreakerVpnService : VpnService() {

    companion object {
        const val ACTION_START = "hu.breaker.app.START"
        const val ACTION_STOP = "hu.breaker.app.STOP"
        private const val TAG = "BreakerVpn"
        private const val CHANNEL_ID = "breaker_vpn"
        private const val NOTIF_ID = 1

        private val _running = MutableStateFlow(false)
        val running: StateFlow<Boolean> get() = _running

        fun start(context: Context) {
            val intent = Intent(context, BreakerVpnService::class.java).setAction(ACTION_START)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, BreakerVpnService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }

    private var tun: ParcelFileDescriptor? = null
    private var usageTimer: java.util.Timer? = null
    @Volatile private var stopping = false
    private var readerThread: Thread? = null
    private val resolverPool = Executors.newFixedThreadPool(8) as ThreadPoolExecutor
    private val upstreams = listOf("1.1.1.1", "8.8.8.8")

    override fun onCreate() {
        super.onCreate()
        BreakerStore.init(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdown()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startForegroundWithNotification()
                if (tun == null) establishAndRun()
                return START_STICKY
            }
        }
    }

    private fun startForegroundWithNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Breaker védelem", NotificationManager.IMPORTANCE_LOW),
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notif: Notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle(getString(R.string.vpn_notification_title))
            .setContentText(getString(R.string.vpn_notification_text))
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun establishAndRun() {
        val builder = Builder()
            .setSession("Breaker")
            .setMtu(1500)
            .addAddress(DnsEngine.TUN_ADDR4, 24)
            .addAddress(DnsEngine.TUN_ADDR6, 64)
            .addDnsServer(DnsEngine.VIRTUAL_DNS4)
            .addDnsServer(DnsEngine.VIRTUAL_DNS6)
            .addRoute(DnsEngine.VIRTUAL_DNS4, 32)
            .addRoute(DnsEngine.VIRTUAL_DNS6, 128)
            .setBlocking(true)
        val pfd = builder.establish()
        if (pfd == null) {
            Log.w(TAG, "establish() returned null — missing VPN consent?")
            stopSelf()
            return
        }
        tun = pfd
        stopping = false
        _running.value = true
        BreakerStore.mutate { it.copy(protectionOn = true) }
        readerThread = Thread({ readLoop(pfd) }, "breaker-tun-reader").also { it.start() }
        startUsageSampling()
    }

    /**
     * Active-time sampling runs on this always-on service so it keeps measuring
     * with the UI closed. Ticks are cheap; the tracker itself decides whether
     * the moment counts (screen on, unlocked, usage access granted).
     */
    private fun startUsageSampling() {
        usageTimer?.cancel()
        UsageTracker.resetClock()
        usageTimer = java.util.Timer("breaker-usage", true).also { t ->
            t.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    runCatching { UsageTracker.tick(this@BreakerVpnService) }
                        .onFailure { Log.w(TAG, "usage tick failed: $it") }
                }
            }, UsageLogic.SAMPLE_INTERVAL_MS, UsageLogic.SAMPLE_INTERVAL_MS)
        }
    }

    private fun readLoop(pfd: ParcelFileDescriptor) {
        val input = FileInputStream(pfd.fileDescriptor)
        val output = FileOutputStream(pfd.fileDescriptor)
        val buf = ByteArray(32 * 1024)
        while (!stopping) {
            val n = try {
                input.read(buf)
            } catch (e: Exception) {
                if (!stopping) Log.w(TAG, "tun read failed: $e")
                break
            }
            if (n <= 0) continue
            val q = DnsEngine.parseUdp(buf, n) ?: continue
            val payload = q.dnsPayload
            // Housekeeping piggybacks on DNS traffic + a UI-side timer.
            Referee.tick(System.currentTimeMillis())
            // Shed load on a deep backlog (the pool has 8 threads; each task can
            // block up to 8s on slow upstreams) — the client simply retries.
            if (resolverPool.queue.size >= 128) continue
            resolverPool.execute { handleQuery(q, payload, output) }
        }
        _running.value = false
    }

    private fun handleQuery(q: DnsEngine.UdpQuery, payload: ByteArray, output: FileOutputStream) {
        try {
            val name = DnsEngine.queryName(payload)
            val blocked = name != null &&
                Blocklist.matches(name, BreakerStore.blockedHostnamesNow(System.currentTimeMillis()))
            // Feed the active-time tracker: a resolved (non-blocked) name is our
            // only signal for which page a foreground browser is showing.
            if (!blocked && name != null) UsageTracker.noteDomain(name, System.currentTimeMillis())

            val answer: ByteArray? = if (blocked) {
                DnsEngine.buildNxdomain(payload)
            } else {
                forwardUpstream(payload)
            }
            if (answer != null) {
                val packet = DnsEngine.wrapResponse(q, answer)
                synchronized(output) { output.write(packet) }
            }
        } catch (e: Exception) {
            Log.w(TAG, "query handling failed: $e")
        }
    }

    private fun forwardUpstream(payload: ByteArray): ByteArray? {
        for (upstream in upstreams) {
            try {
                DatagramSocket().use { socket ->
                    protect(socket)
                    socket.soTimeout = 4000
                    socket.send(DatagramPacket(payload, payload.size, InetSocketAddress(upstream, 53)))
                    val resp = DatagramPacket(ByteArray(4096), 4096)
                    socket.receive(resp)
                    return resp.data.copyOfRange(0, resp.length)
                }
            } catch (_: Exception) {
                // try next upstream
            }
        }
        return null
    }

    override fun onRevoke() {
        // The user (or another VPN app) pulled the plug. We cannot silently
        // re-establish without consent — surface it loudly instead.
        shutdown()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Breaker védelem", NotificationManager.IMPORTANCE_HIGH),
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        nm.notify(
            2,
            Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setContentTitle(getString(R.string.vpn_revoked_title))
                .setContentText(getString(R.string.vpn_revoked_text))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build(),
        )
        stopSelf()
    }

    private fun shutdown() {
        stopping = true
        usageTimer?.cancel()
        usageTimer = null
        runCatching { UsageTracker.flush() } // do not lose buffered measurement
        _running.value = false
        BreakerStore.mutate { it.copy(protectionOn = false) }
        try { tun?.close() } catch (_: Exception) { }
        tun = null
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() {
        stopping = true
        usageTimer?.cancel()
        resolverPool.shutdownNow()
        try { tun?.close() } catch (_: Exception) { }
        super.onDestroy()
    }
}
