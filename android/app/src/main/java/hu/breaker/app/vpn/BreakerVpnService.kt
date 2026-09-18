package hu.breaker.app.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import hu.breaker.app.MainActivity
import hu.breaker.app.R
import hu.breaker.app.core.AliasLogic
import hu.breaker.app.core.FilterHitLogic
import hu.breaker.app.core.KeywordLogic
import hu.breaker.app.core.UsageLogic
import hu.breaker.app.core.AppState
import hu.breaker.app.core.BreakerStore
import hu.breaker.app.core.DigestLogic
import hu.breaker.app.core.Focus
import hu.breaker.app.core.LockdownLogic
import hu.breaker.app.core.Referee
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
        /** A heti ablak beérésének egyszeri értesítése — a 2-es a visszavonásé. */
        private const val NOTIF_WINDOW_ID = 3
        /** A közelgő heti ablak egyszeri értesítése. */
        private const val NOTIF_WINDOW_SOON_ID = 4
        /**
         * A zárlat-ablak értesítéseinek saját csatornája: egyszeri és látható —
         * nem a sáv halk, állandó csatornája, amit a rendszer joggal tesz hátra.
         */
        private const val LOCKDOWN_CHANNEL_ID = "breaker_lockdown"
        /** A hétfő reggeli visszatekintés — saját csatornán, hogy külön is kikapcsolható legyen. */
        private const val NOTIF_DIGEST_ID = 5
        private const val DIGEST_CHANNEL_ID = "breaker_digest"
        /** Percenként elég kérdezni, esedékes-e: a válasz egy hétig ugyanaz. */
        private const val DIGEST_CHECK_MS = 60_000L
        /** A sokadik megakadás értesítése — lehúzható, saját csatornán, hogy külön lehessen elnémítani. */
        private const val NOTIF_NUDGE_ID = 6
        private const val NUDGE_CHANNEL_ID = "breaker_hits"
        /** Az előjelzés a csúcs-óra előtt — ugyanazon a csatornán, külön azonosítóval. */
        private const val NOTIF_PEAK_ID = 7
        /** Az előjelzés a menet-óra előtt — ugyanazon a csatornán, külön azonosítóval. */
        private const val NOTIF_FOCUS_HOUR_ID = 8

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
    /** Az utolsó kiírt értesítés-szöveg kulcsa — csak változásnál rajzolunk újra. */
    private var lastNotifKey: String? = null
    /**
     * A már bejelentett ablak-zárlat vége. -1, amíg az első kör nem futott: a
     * szolgáltatás indulásakor talált zárlatot nem jelentjük be újra — a sáv
     * úgyis mondja —, csak azt, ami a szolgáltatás élete alatt ér be.
     */
    private var noticedWindowUntil: Long = -1L
    /** A már bejelentett közelgő ablak-kezdés; egy kezdésről egyszer szólunk. */
    private var warnedWindowStart: Long = 0L
    /** A már elkönyvelt hét — memóriában is, hogy a tár hibája se szólaltassa meg minden körben. */
    private var digestDoneKey: String? = null
    private var digestCheckedAt: Long = 0L
    private var usageTimer: java.util.Timer? = null
    /** hoszt → az utoljára számolt megakadás ideje; csak a szűrő szálán, nem tárolódik */
    private val hitSeen = HashMap<String, Long>()
    /** A már kimondott lépcső („nap:lépcső”): naponta lépcsőnként egyszer; egy újraindítás legfeljebb egy duplát enged. */
    @Volatile private var nudgedKey = ""
    /** A már kimondott csúcs-óra előjelzés kulcsa („nap:óra”) — naponta egyszer. */
    private var warnedPeakKey: String? = null
    /** A már kimondott menet-óra előjelzés kulcsa („nap:óra”) — naponta egyszer. */
    private var warnedFocusHourKey: String? = null
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
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    /**
     * A tartós értesítés — MUNKAMENET ALATT mást mond.
     *
     * A telefonon a fehérlistás menetnek nincs „letiltva” oldala: a DNS-válasz
     * elmarad, a böngésző pedig egy hálózati hibát mutat. Az egyetlen hely, ahol
     * a felhasználó megnézi, mi történik, ez az értesítés. Ha ilyenkor is azt
     * írná, hogy „a blokkolt oldalak nem érhetők el”, az félrevezetés lenne:
     * nem a blokkolt oldalak nem érhetők el, hanem MINDEN, ami nincs a csomagon.
     */
    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val now = System.currentTimeMillis()
        val st = BreakerStore.state.value
        val run = BreakerStore.runningFocus(now)
        val pack = BreakerStore.runningFocusPack(now)
        val lock = LockdownLogic.live(st.lockdown, now)
        // A hűtés a munkamenet UTÁN jön: a menet mindenre szól, az adag egy
        // oldalra — a szélesebb állapot a fontosabb mondanivaló.
        val cooling = if (run == null) BreakerStore.coolingSites(now) else emptyList()
        val title: String
        val text: String
        // A szigorú Privát DNS a legfontosabb mondanivaló: a szűrő fut, a
        // rendszer mégis mellette viszi a névfeloldást — a tiltás nem érvényesül.
        val strictDns = PrivateDns.strictHostname(this)
        if (strictDns != null) {
            title = getString(R.string.vpn_privatedns_title)
            text = getString(R.string.vpn_privatedns_text, strictDns)
        } else if (run != null) {
            title = getString(R.string.vpn_focus_title, pack?.name ?: "Munkamenet")
            // Az ablak szerint indult menetnél a sáv is kimondja: aki nem maga
            // indította, tudja meg, miért fut — és hogy a vége az ablak vége.
            text = getString(
                if (Focus.isWindowRun(run, st.focusPacks)) R.string.vpn_focus_window_text else R.string.vpn_focus_text,
                Focus.formatRemaining(run.endsAt - now),
            )
        } else if (lock != null) {
            // A zárlat alatt a sáv mondja meg, miért nincs lazítás — és meddig. Az
            // ablak zárlatát ablakénak mondja: aki nem maga indította, tudja meg,
            // mi tartja. A menet elé nem kerül: az mondja meg, mi jön be egyáltalán.
            val byWindow = LockdownLogic.isWindowLockdown(lock, st.lockdownWindows.map { it.band })
            title = getString(if (byWindow) R.string.vpn_lockdown_window_title else R.string.vpn_lockdown_title)
            text = getString(R.string.vpn_lockdown_text, LockdownLogic.formatRemaining(lock.until - now), clockLabel(lock.until, now))
        } else if (cooling.isNotEmpty()) {
            // A telefonon a betelt adagnak nincs tiltó lapja — a böngésző csak
            // hálózati hibát mutat. Ez az értesítés mondja meg, mi történt, és
            // mikor nyílik újra; nélküle a hűtés meghibásodásnak látszana.
            val remaining = Focus.formatRemaining(cooling.first().second - now)
            if (cooling.size == 1) {
                title = getString(R.string.vpn_burst_title, AliasLogic.displayName(cooling.first().first))
                text = getString(R.string.vpn_burst_text, remaining)
            } else {
                title = getString(R.string.vpn_burst_title_many, cooling.size)
                text = getString(R.string.vpn_burst_text_many, remaining)
            }
        } else {
            title = getString(R.string.vpn_notification_title)
            text = getString(R.string.vpn_notification_text)
        }
        // A mai megakadások a sor végén: tükör a kísértés pillanatában, ítélet
        // nélkül — a szigorú Privát DNS sorát nem tolja el, az a fontosabb.
        val hitsToday = FilterHitLogic.hitsToday(st.filterHits, now)
        // A CSÚCS-ÓRÁBAN a sor azt is mondja, hogy most van — a tükör a pillanaté.
        val peakNow = FilterHitLogic.isPeakNow(FilterHitLogic.peakHour(st.filterHitHours, now), now)
        // A CSÚCS-NAPON azt is, hogy ma van — négy hétből, csak elég mintából.
        val peakDay = FilterHitLogic.isPeakDayNow(FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(st.filterHits, now)), now)
        // A MENET-NAPON és a MENET-ÓRÁBAN a tükör másik fele: ma szoktál leülni,
        // most szoktál elkezdeni — ugyanaz a küszöb, mint a csúcs-napé. Ha a
        // menet-óra a csúcs-óra, csak a csúcs-óra szava áll ott: kétszer ugyanazt nem.
        val focusDay = FilterHitLogic.isPeakDayNow(FilterHitLogic.peakWeekday(Focus.byWeekday(st.focusLog, now)), now)
        val focusHourNow = !peakNow && Focus.isHourNow(Focus.peakHour(Focus.byHour(st.focusLog, now)), now)
        // A MÉRT IDŐ NAPJÁN a tükör harmadik fele is: ma megy el a legtöbb idő — a kártya szava, csak elég mintából.
        val usageDay = UsageLogic.isDayNow(FilterHitLogic.peakWeekday(UsageLogic.byWeekday(st.usage, now)), now)
        // A MENET-SOROZAT is: hány napja ülsz le minden nap — kettőtől, mint a mag szövege; tény, nem felszólítás.
        val streak = Focus.dayStreak(st.focusLog, now)
        val hitsPart = (if (hitsToday > 0) " · Ma $hitsToday megakadás" else "") + (if (peakNow) " · most a csúcs-óra" else "") +
            (if (peakDay) " · ma a csúcs-nap" else "") + (if (focusDay) " · ma a menet-nap" else "") +
            (if (focusHourNow) " · most a menet-óra" else "") + (if (usageDay) " · ma a legnagyobb nap" else "") +
            (if (streak >= Focus.STREAK_MIN_DAYS) " · $streak napja minden nap" else "")
        val textWithHits = if (hitsPart.isNotEmpty() && strictDns == null) text + hitsPart else text
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle(title)
            .setContentText(textWithHits)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
    }

    /**
     * Az értesítés frissítése, ha változott a mondanivalója.
     *
     * Csak akkor ír, ha tényleg más a szöveg: egy percenként újrarajzolt
     * értesítés fölösleges munka, és néhány rendszeren villog is tőle a sáv.
     */
    private fun refreshNotification() {
        val now = System.currentTimeMillis()
        val run = BreakerStore.runningFocus(now)
        // A Privát DNS állapota is a kulcs része: átállításkor azonnal
        // átrajzolunk, közben nem.
        val strictKey = if (PrivateDns.strictHostname(this) != null) "strict:" else ""
        // A zárlat is a kulcs része: kezdéskor, percváltásnál és lejáratkor
        // átrajzolunk — közben nem.
        val st = BreakerStore.state.value
        val lock = LockdownLogic.live(st.lockdown, now)
        val lockKey = if (lock == null) "" else "lock:${lock.until}:${LockdownLogic.formatRemaining(lock.until - now)}:"
        // Amikor a heti ablak beér, egyszer külön is szólunk: a sáv állandó, ez a
        // pillanaté — aki nem maga indította, tudja meg, miért zárt be minden.
        val byWindow = lock != null && LockdownLogic.isWindowLockdown(lock, st.lockdownWindows.map { it.band })
        if (noticedWindowUntil == -1L) {
            noticedWindowUntil = lock?.until ?: 0L
        } else if (lock != null && byWindow && lock.until != noticedWindowUntil) {
            noticedWindowUntil = lock.until
            runCatching { notifyWindowLockdown(lock, now) }
        }
        // Tíz perccel a heti ablak beérése előtt egyszer szólunk — ami nyitva van,
        // mentsd el. Ha egy futó zárlat úgyis túlér rajta, nincs miről.
        val soon = LockdownLogic.windowStartingSoon(lock, st.lockdownWindows.map { it.band }, now)
        if (soon != null && soon.startsAt != warnedWindowStart) {
            warnedWindowStart = soon.startsAt
            runCatching { notifyWindowSoon(soon, now) }
        }
        maybePeakWarning(st, now)
        maybeFocusHourWarning(st, now)
        // A mai megakadások is a kulcs része: a sáv sora a következő körben
        // mondja az új számot — nem csak akkor, ha valami más is változik.
        val hitsKey = "hits:${FilterHitLogic.hitsToday(st.filterHits, now)}:" +
            "${FilterHitLogic.isPeakNow(FilterHitLogic.peakHour(st.filterHitHours, now), now)}:" +
            "${FilterHitLogic.isPeakDayNow(FilterHitLogic.peakWeekday(FilterHitLogic.byWeekday(st.filterHits, now)), now)}:"
        val key = strictKey + lockKey + hitsKey + if (run != null) {
            "${run.packId}:${Focus.formatRemaining(run.endsAt - now)}"
        } else {
            // A hűtés is a kulcs része: induláskor, percváltásnál és lejáratkor
            // átrajzolunk — közben nem.
            val cooling = BreakerStore.coolingSites(now)
            if (cooling.isEmpty()) "-" else {
                "burst:${cooling.size}:${cooling.first().first.id}:" +
                    Focus.formatRemaining(cooling.first().second - now)
            }
        }
        if (key == lastNotifKey) return
        lastNotifKey = key
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
    }

    /** A zárlat vége olvashatóan: ma csak az óra, máskor a nap is. */
    private fun clockLabel(at: Long, now: Long): String {
        val a = java.util.Calendar.getInstance().apply { timeInMillis = at }
        val n = java.util.Calendar.getInstance().apply { timeInMillis = now }
        val sameDay = a.get(java.util.Calendar.YEAR) == n.get(java.util.Calendar.YEAR) &&
            a.get(java.util.Calendar.DAY_OF_YEAR) == n.get(java.util.Calendar.DAY_OF_YEAR)
        return if (sameDay) java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(at))
        else java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(at))
    }

    /**
     * Egyszeri értesítés, amikor a heti ablak beér — a gép is ezt teszi. Külön
     * azonosítón, hogy ne a sáv állandó értesítését írja felül; lehúzható.
     */
    private fun notifyWindowLockdown(lock: LockdownLogic.Lockdown, now: Long) {
        notifyOnce(
            NOTIF_WINDOW_ID, getString(R.string.vpn_lockdown_window_title),
            getString(R.string.vpn_lockdown_window_notice_text,
                LockdownLogic.formatRemaining(lock.until - now), clockLabel(lock.until, now)),
        )
    }

    /** Tíz perccel a heti ablak beérése előtt — egyszer, lehúzható. */
    private fun notifyWindowSoon(occ: Focus.Occurrence, now: Long) {
        notifyOnce(
            NOTIF_WINDOW_SOON_ID, getString(R.string.vpn_window_soon_title),
            getString(R.string.vpn_window_soon_text,
                LockdownLogic.formatRemaining(occ.startsAt - now), clockLabel(occ.endsAt, now)),
        )
    }

    /**
     * Egyszeri, lehúzható értesítés — alapból a zárlat-ablak csatornáján; az
     * appot nyitja. A hosszú szöveg kinyitva is olvasható (BigText), nem egy
     * sorra csonkolva.
     */
    private fun notifyOnce(
        id: Int, title: String, text: String,
        channel: String = LOCKDOWN_CHANNEL_ID, channelName: String = "Zárlat-ablak",
        // EGY KOPPINTÁS az értesítésről a menetig: a javaslat gombja, ha van.
        action: Notification.Action? = null,
        // EGY KOPPINTÁS az ablakig: a második gomb, ha az órára ablak tehető.
        second: Notification.Action? = null,
    ) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(channel, channelName, NotificationManager.IMPORTANCE_DEFAULT),
        )
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(this, channel)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
        val actions = listOfNotNull(action, second)
        if (actions.isNotEmpty()) builder.setActions(*actions.toTypedArray())
        nm.notify(id, builder.build())
    }

    /**
     * EGY KOPPINTÁS az értesítésről a menetig: a gomb a legutóbb használt
     * csomagot indítja a szokásos hosszával (`FocusStartReceiver`) — ugyanaz
     * az út, mint a kezdőlap kártyájáé. Futó menet mellett nincs gomb: egyszerre
     * egy menet fut. Csomag nélkül sincs — üres ígéret helyett semmi.
     */
    private fun startAction(st: AppState, now: Long, notifId: Int): Notification.Action? {
        if (BreakerStore.runningFocus(now) != null) return null
        val pick = Focus.lastUsedPack(st.focusPacks, st.focusLog) ?: return null
        val intent = Intent(this, FocusStartReceiver::class.java)
            .setAction(FocusStartReceiver.ACTION_START)
            .putExtra(FocusStartReceiver.EXTRA_PACK_ID, pick.id)
            .putExtra(FocusStartReceiver.EXTRA_MINUTES, pick.defaultMinutes)
            .putExtra(FocusStartReceiver.EXTRA_NOTIF_ID, notifId)
        val pi = PendingIntent.getBroadcast(
            this, notifId, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_media_play),
            "Munkamenet: ${pick.name}, ${pick.defaultMinutes} perc",
            pi,
        ).build()
    }

    /**
     * EGY KOPPINTÁS az értesítésről az ablakig: az előjelzés második gombja
     * heti ablakot tesz a legutóbbi csomagra az óra egy órájában, minden napra
     * (`FocusWindowReceiver`) — ugyanazok a kapuk, mint a statisztika gombjánál,
     * a jelöltet a mag dönti (`peakWindowPick`); ha nem tehető rá ablak, nincs gomb.
     */
    private fun windowAction(st: AppState, now: Long, hour: Int, notifId: Int, what: String): Notification.Action? {
        val (pick, _) = Focus.peakWindowPick(st.focusPacks, st.focusLog, BreakerStore.runningFocus(now), hour, now) ?: return null
        val intent = Intent(this, FocusWindowReceiver::class.java)
            .setAction(FocusWindowReceiver.ACTION_WINDOW)
            .putExtra(FocusWindowReceiver.EXTRA_PACK_ID, pick.id)
            .putExtra(FocusWindowReceiver.EXTRA_HOUR, hour)
            .putExtra(FocusWindowReceiver.EXTRA_NOTIF_ID, notifId)
        val pi = PendingIntent.getBroadcast(
            this, notifId + 100, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_menu_my_calendar),
            "Heti ablak a $what: ${pick.name}",
            pi,
        ).build()
    }

    /**
     * ELŐJELZÉS a csúcs-óra előtt: tíz perccel a hét csúcs-órája előtt egyszer
     * szólunk — a megakadások csatornáján, naponta egyszer. Tükör időzítéssel:
     * ilyenkor jár a kéz magától. Nem tilt, nem ítél; a mag mondja, mikor.
     */
    private fun maybePeakWarning(st: AppState, now: Long) {
        if (st.quietSuggestions) return // ha nem kéred, csendben marad
        // Futó menet mellett nincs előjelzés: a menet már megy, a figyelmeztetés zaj lenne.
        if (BreakerStore.runningFocus(now) != null) return
        val peak = FilterHitLogic.peakHour(st.filterHitHours, now) ?: return
        val key = FilterHitLogic.peakWarnKey(peak, now) ?: return
        if (key == warnedPeakKey) return
        warnedPeakKey = key
        runCatching {
            notifyOnce(
                NOTIF_PEAK_ID, "Mindjárt a csúcs-óra", FilterHitLogic.peakWarnText(peak), NUDGE_CHANNEL_ID, "Megakadások",
                startAction(st, now, NOTIF_PEAK_ID), windowAction(st, now, peak.first, NOTIF_PEAK_ID, "csúcs-órára"),
            )
        }
            .onFailure { Log.w(TAG, "az előjelzés nem szólt: $it") }
    }

    /**
     * ELŐJELZÉS a menet-óra előtt: tíz perccel a négy hét menet-órája előtt
     * egyszer szólunk — a csúcs-óra előjelzésének tükre, ugyanazzal a kulccsal
     * és küszöbbel. Ha a menet-óra a csúcs-óra, a csúcs-óra előjelzése szól,
     * kétszer ugyanazt nem. Nem tilt, nem ítél; a mag mondja, mikor.
     */
    private fun maybeFocusHourWarning(st: AppState, now: Long) {
        if (st.quietSuggestions) return // ha nem kéred, csendben marad
        if (BreakerStore.runningFocus(now) != null) return
        val peak = Focus.peakHour(Focus.byHour(st.focusLog, now)) ?: return
        if (FilterHitLogic.peakHour(st.filterHitHours, now)?.first == peak.first) return
        val key = FilterHitLogic.peakWarnKey(peak, now) ?: return
        if (key == warnedFocusHourKey) return
        warnedFocusHourKey = key
        runCatching {
            notifyOnce(
                NOTIF_FOCUS_HOUR_ID, "Mindjárt a menet-óra", Focus.hourWarnText(peak), NUDGE_CHANNEL_ID, "Megakadások",
                startAction(st, now, NOTIF_FOCUS_HOUR_ID), windowAction(st, now, peak.first, NOTIF_FOCUS_HOUR_ID, "menet-órára"),
            )
        }
            .onFailure { Log.w(TAG, "a menet-óra előjelzése nem szólt: $it") }
    }

    /**
     * Heti visszatekintés: hétfő reggel egy értesítés az elmúlt 7 napról — a
     * gépen a felület mondja (és csak amíg fut), itt a szolgáltatás, ami az app
     * nélkül is fut. Egy hétről egyszer, eszközönként: a hét kulcsa az
     * állapotban marad. Engedély híján csendben marad, és a hetet sem könyveli
     * el: majd szól, ha szólhat. Ha nincs miről beszélni, a hét el van
     * könyvelve, értesítés nincs — egy üres mondat zaj lenne.
     */
    private fun maybeDigest(now: Long = System.currentTimeMillis()) {
        if (now - digestCheckedAt < DIGEST_CHECK_MS) return
        digestCheckedAt = now
        val st = BreakerStore.state.value
        val key = DigestLogic.due(st.digestWeekKey, now) ?: return
        if (key == digestDoneKey) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(DIGEST_CHANNEL_ID, "Heti visszatekintés", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val blocked = nm.getNotificationChannel(DIGEST_CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE
        if (!nm.areNotificationsEnabled() || blocked) return
        // A memóriában is: ha a tár nem ír, ne szóljon minden körben újra.
        digestDoneKey = key
        val text = digestText(st, now)
        // A hét el van könyvelve, a mondat a naplóba kerül — az üres hét (null)
        // nem sor, de a hét régi sorát sem hagyja ott.
        BreakerStore.mutate {
            it.copy(digestWeekKey = key, digestLog = DigestLogic.record(it.digestLog, key, text))
        }
        if (text == null) return
        notifyOnce(NOTIF_DIGEST_ID, getString(R.string.digest_title), text, DIGEST_CHANNEL_ID, "Heti visszatekintés")
    }

    /**
     * A visszatekintés mondata a mostani állapotból — a mag adja, a címkézés a
     * statisztikáé: rejtett listánál sorszám, fedőnévnél a fedőnév. A rejtést a
     * BEÁLLÍTÁS dönti, nem a felület pillanatnyi felfedése: az értesítés a
     * zárolt képernyőn is ott van.
     */
    private fun digestText(st: AppState, now: Long): String? {
        val labelOf: (String) -> String = { raw ->
            val idx = st.sites.indexOfFirst { it.domain == raw }
            when {
                idx < 0 -> raw
                st.hideSiteList -> AliasLogic.maskedLabel(st.sites[idx], idx)
                else -> AliasLogic.displayName(st.sites[idx])
            }
        }
        // A bemenetet a mag rakja össze — a felület élő mondata ugyanezt kéri.
        return DigestLogic.text(DigestLogic.inputFor(st, UsageLogic.summarize(st.usage, now), now), labelOf)
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
                    // Ugyanezen a körön frissül az értesítés is: a munkamenet
                    // hátralévő ideje ott a legfontosabb, mert a telefonon nincs
                    // „letiltva” oldal, ami megmondaná, mi történik.
                    runCatching { refreshNotification() }
                        .onFailure { Log.w(TAG, "notification refresh failed: $it") }
                    // És a hétfő reggeli visszatekintés is innen szól: a
                    // szolgáltatás az app nélkül is fut, tehát itt tényleg
                    // hétfő reggel jön, nem az első megnyitáskor.
                    runCatching { maybeDigest() }
                        .onFailure { Log.w(TAG, "digest failed: $it") }
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
            val now = System.currentTimeMillis()
            // A döntés MAGA a `Focus.verdict` — a sorrendje ott van leírva, és a
            // legfontosabb pontja, hogy a BLOKKLISTA MINDIG NYER. A munkamenet
            // sosem old fel semmit, csak hozzátesz; enélkül egy csomagba felvett
            // `youtube.com` próbatétel nélkül feloldaná a tiltott YouTube-ot.
            val verdict = if (name == null) {
                Focus.Verdict.ALLOW
            } else {
                Focus.verdict(
                    name,
                    BreakerStore.runningFocus(now),
                    BreakerStore.runningFocusPack(now),
                    now,
                    BreakerStore.blockedHostnamesNow(now),
                    BreakerStore.syncHost(),
                    // A kulcsszó a hosztnévben is tilt — a telefon ennyit lát belőle.
                    BreakerStore.state.value.keywords,
                )
            }
            val blocked = verdict != Focus.Verdict.ALLOW
            // Feed the active-time tracker: a resolved (non-blocked) name is our
            // only signal for which page a foreground browser is showing.
            if (!blocked && name != null) UsageTracker.noteDomain(name, now)
            // MEGAKADÁS: a tiltott név egy megakadás — hosztonként két percen
            // belül egyszer, mert egy oldalbetöltés tucatnyi lekérdezés. A
            // könyv a statisztikáé és a heti mondaté; a döntést nem lassítja.
            // CSAK A LISTA és a KULCSSZÓ tiltása: a munkamenet fehérlistáján kívül a háttér-
            // forgalom is elakad (követők, CDN-ek, más appok), és az nem a kéz
            // mozdulata — így számolva a sáv százat mondana egy csendes órára.
            val reason = FilterHitLogic.reasonOf(verdict)
            if (reason != null && name != null && FilterHitLogic.shouldCount(hitSeen, name, now)) {
                val day = UsageLogic.dayKey(now)
                val hour = FilterHitLogic.hourOf(now)
                // Oldalanként is: a lista tételével, nem a nyers hoszttal.
                val site = FilterHitLogic.siteOf(name, BreakerStore.state.value.sites.map { s -> s.domain to s.hostnames })
                // Kulcsszavanként is: a kulcsszó okánál a fogó szó — melyik kulcsszó dolgozik.
                val keyword = if (reason == FilterHitLogic.REASON_KEYWORD) KeywordLogic.keywordInHost(BreakerStore.state.value.keywords, name) else null
                runCatching {
                    BreakerStore.mutate {
                        it.copy(
                            filterHits = FilterHitLogic.sweep(FilterHitLogic.record(it.filterHits, day), day),
                            filterHitHours = FilterHitLogic.cleanHours(FilterHitLogic.recordHour(it.filterHitHours, day, hour)),
                            filterHitHosts = FilterHitLogic.cleanSites(FilterHitLogic.recordSite(it.filterHitHosts, day, site)),
                            // Okonként is: melyik szabály dolgozik — a lista vagy a kulcsszó.
                            filterHitReasons = FilterHitLogic.cleanSites(FilterHitLogic.recordSite(it.filterHitReasons, day, reason)),
                            filterHitKeywords = if (keyword != null) FilterHitLogic.cleanSites(FilterHitLogic.recordSite(it.filterHitKeywords, day, keyword)) else it.filterHitKeywords,
                        )
                    }
                }
                    .onFailure { Log.w(TAG, "megakadás nem könyvelve: $it") }
                // A SOKADIK megakadás: az ötödik, tizedik, huszadik mainál egyszer
                // szólunk — egy munkamenet vagy egy rövid zárlat most segítene. Nem
                // tilt, nem ítél; a sáv sora a számot mondja, ez a lépést.
                val cur = BreakerStore.state.value
                val step = FilterHitLogic.nudgeStep(FilterHitLogic.hitsToday(cur.filterHits, now))
                val nudgeKey = "$day:$step"
                // Ha nem kéred, csendben marad — a kártya a lapon akkor is mondja.
                // Futó menet mellett sem szól: a lépés, amit ajánlanánk, már megvan.
                if (step > 0 && nudgeKey != nudgedKey && !cur.quietSuggestions && BreakerStore.runningFocus(now) == null) {
                    nudgedKey = nudgeKey
                    runCatching {
                        notifyOnce(NOTIF_NUDGE_ID, "A sokadik megakadás", FilterHitLogic.nudgeText(step), NUDGE_CHANNEL_ID, "Megakadások", startAction(cur, now, NOTIF_NUDGE_ID))
                    }
                        .onFailure { Log.w(TAG, "a sokadik megakadás nem szólt: $it") }
                }
            }

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
