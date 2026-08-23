// Local IPC server: unix domain socket on macOS/Linux, named pipe on Windows.
// Protocol: one JSON request per line in, one JSON response per line out.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { HelperRequest, HelperResponse, StatusData } from '../shared/protocol';
import { HELPER_VERSION } from '../shared/protocol';
import { normalizeDomain, expandHostnames } from '../shared/blocklist';
import { computeTier } from '../shared/challenges';
import { isBlockedNowWithLimit, isLimitExhausted, normalizeLimit, usedTodaySeconds } from '../shared/limits';
import {
  recordSample, summarize, series, labelOf, emptyUsage,
  MAX_KEY_LENGTH, MAX_LABEL_LENGTH, MAX_BATCH_SAMPLES,
} from '../shared/usage';
import type { UsageStatsData } from '../shared/protocol';
import type { HelperState, SiteRec } from './state';
import { newId } from './state';
import * as referee from './referee';
import { RefereeError } from './referee';
import { socketPath } from './paths';

/** Hard limit on one usage_batch request — shared with the tracker's buffer cap,
 *  so a completely full buffer still fits into exactly one request. */
export { MAX_BATCH_SAMPLES };
const VALID_KEY = new RegExp(`^(app|site):.{1,${MAX_KEY_LENGTH - 5}}$`);

export interface ServerDeps {
  getState: () => HelperState;
  /** persist state and re-apply the hosts block */
  commit: () => void;
  dohApplied: () => boolean;
  log: (m: string) => void;
  /** uid of the user allowed to talk to the (root) helper; undefined in dev */
  ownerUid?: number;
}

export function statusOf(state: HelperState, dohApplied: boolean): StatusData {
  const now = Date.now();
  return {
    helperVersion: HELPER_VERSION,
    platform: process.platform,
    sites: state.sites.map((s) => ({
      id: s.id, domain: s.domain, hostnames: s.hostnames, addedAt: s.addedAt,
      pauseUntil: s.pauseUntil, pendingDeleteAt: s.pendingDeleteAt,
      schedule: s.schedule,
      dailyLimitSeconds: s.dailyLimitSeconds,
      usedTodaySeconds: Math.round(usedTodaySeconds(state.usage, s.domain, now)),
      limitExhausted: isLimitExhausted(s, state.usage, now),
      blockedNow: isBlockedNowWithLimit(s, state.usage, now),
    })),
    tier: computeTier(state.unlockLog, now),
    unlocks7d: state.unlockLog.filter((t) => t >= now - 7 * 24 * 3600_000).length,
    session: referee.currentSession(state),
    dohPolicyApplied: dohApplied,
    usageEnabled: state.usage.enabled,
    now,
  };
}

function handle(req: HelperRequest, deps: ServerDeps): unknown {
  const state = deps.getState();
  const now = Date.now();
  switch (req.op) {
    case 'status':
      return statusOf(state, deps.dohApplied());

    case 'add_site': {
      const domain = normalizeDomain(req.input);
      if (!domain) throw new RefereeError('Ez nem tűnik érvényes címnek.', 'BAD_DOMAIN');
      if (state.sites.some((s) => s.domain === domain)) {
        throw new RefereeError('Ez az oldal már a listán van.', 'DUPLICATE');
      }
      const site: SiteRec = {
        id: newId('site'),
        domain,
        hostnames: expandHostnames(domain, req.usePreset),
        addedAt: now,
        pauseUntil: null,
        pendingDeleteAt: null,
      };
      state.sites.push(site);
      deps.commit(); // adding a block is intentionally frictionless
      deps.log(`blocked ${domain} (${site.hostnames.length} hostnames)`);
      return statusOf(state, deps.dohApplied());
    }

    case 'start_unlock': {
      const session = referee.startSession(state, 'pause', req.siteId, req.minutes, now);
      deps.commit();
      return session;
    }

    case 'start_delete': {
      const session = referee.startSession(state, 'delete', req.siteId, undefined, now);
      deps.commit();
      return session;
    }

    case 'submit': {
      const result = referee.submitAnswer(state, req.sessionId, req.answer, now);
      deps.commit();
      return result;
    }

    case 'claim': {
      const result = referee.claimDelay(state, req.sessionId, now);
      deps.commit();
      return result;
    }

    case 'abandon': {
      referee.abandonSession(state, req.sessionId);
      deps.commit();
      return statusOf(state, deps.dohApplied());
    }

    case 'cancel_delete': {
      const site = state.sites.find((s) => s.id === req.siteId);
      if (site) site.pendingDeleteAt = null; // cancelling a delete is always one click
      deps.commit();
      return statusOf(state, deps.dohApplied());
    }

    case 'relock': {
      const site = state.sites.find((s) => s.id === req.siteId);
      if (site) site.pauseUntil = null; // re-locking early is always one click
      deps.commit();
      return statusOf(state, deps.dohApplied());
    }

    case 'set_schedule': {
      const result = referee.startScheduleChange(state, req.siteId, req.schedule, now);
      deps.commit();
      return result;
    }

    case 'set_limit': {
      const result = referee.startLimitChange(state, req.siteId, req.seconds, now);
      deps.commit();
      return result;
    }

    case 'usage_batch': {
      // Everything here is untrusted: the helper runs as root/SYSTEM and its
      // state file is rewritten on every commit, so unvalidated keys, labels or
      // timestamps let anything that can reach the socket grow that file
      // without bound — and once it passes what JSON.stringify can produce,
      // NOTHING can be persisted again. Validate before recording.
      const samples = Array.isArray(req.samples) ? req.samples.slice(0, MAX_BATCH_SAMPLES) : [];
      let recorded = 0;
      for (const s of samples) {
        if (!s || typeof s.key !== 'string' || !VALID_KEY.test(s.key)) continue;
        if (typeof s.seconds !== 'number' || !Number.isFinite(s.seconds) || s.seconds <= 0) continue;
        if (typeof s.at !== 'number' || !Number.isFinite(s.at)) continue;
        // A far-off timestamp could evict real history via retention, so a
        // sample may only land within a week of now in either direction.
        if (Math.abs(s.at - now) > 7 * 24 * 3600_000) continue;
        const label = typeof s.label === 'string' ? s.label.slice(0, MAX_LABEL_LENGTH) : undefined;
        recordSample(state.usage, s.key, s.seconds, s.at, label);
        recorded += 1;
      }
      deps.commit();
      return { ok: true, recorded };
    }

    case 'usage_stats': {
      const summary = summarize(state.usage, now);
      const focusKey = req.focusKey
        ?? summary.topWeekSites[0]?.key
        ?? summary.topWeekApps[0]?.key
        ?? null;
      const data: UsageStatsData = {
        summary,
        focusKey,
        focusLabel: focusKey ? labelOf(state.usage, focusKey) : '',
        focusSeries: focusKey ? series(state.usage, focusKey, now, 30) : [],
      };
      return data;
    }

    case 'usage_enable': {
      // Turning measurement off is NOT a blocking weakening, so it needs no
      // challenges — it is the user's own data. With ONE exception: a daily
      // budget is spent from measured time, so switching measurement off would
      // stop the budget from ever running out. That would be a silent bypass,
      // so it is refused while a budget exists.
      if (!req.enabled && state.sites.some((s) => normalizeLimit(s.dailyLimitSeconds) !== null)) {
        throw new RefereeError(
          'Amíg van napi időkeret beállítva, a mérés nem kapcsolható ki — abból fogy a keret.',
          'LIMIT_NEEDS_USAGE',
        );
      }
      state.usage.enabled = req.enabled;
      deps.commit();
      return statusOf(state, deps.dohApplied());
    }

    case 'usage_clear': {
      const wasEnabled = state.usage.enabled;
      state.usage = emptyUsage();
      state.usage.enabled = wasEnabled;
      deps.commit();
      return { ok: true };
    }

    default: {
      // Egy RÉGI helper (frissítés után a root démon a következő indításig a
      // régi marad) nem ismeri az új parancsokat. Enélkül az ág egyszerűen
      // kifutna, a válasz `data: undefined` lenne, a GUI meg azt hinné, hogy
      // sikerült — vagyis a felhasználó beállítana egy napi keretet, és
      // csendben SEMMI nem történne. Egy blokkoló appban ez a legrosszabb
      // hibamód, ezért itt hangosan elhasal.
      const op = (req as { op?: unknown }).op;
      throw new RefereeError(
        `A háttérszolgáltatás nem ismeri ezt a parancsot (${String(op)}) — valószínűleg régi verzió fut.`,
        'UNKNOWN_OP',
      );
    }
  }
}

export function startServer(deps: ServerDeps): net.Server {
  const sock = socketPath();
  if (process.platform !== 'win32') {
    try { fs.mkdirSync(path.dirname(sock), { recursive: true }); } catch { /* ok */ }
    try { fs.unlinkSync(sock); } catch { /* ok */ }
  }
  // One request is a single JSON line; anything far past that is not a client
  // we want to keep talking to.
  const MAX_LINE_BYTES = 1024 * 1024;
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES) {
        deps.log('client sent an oversized request line; closing the connection');
        conn.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let resp: HelperResponse;
        let reqId = 0;
        try {
          const req = JSON.parse(line) as HelperRequest;
          reqId = req.id;
          resp = { id: req.id, ok: true, data: handle(req, deps) };
        } catch (e) {
          const code = e instanceof RefereeError ? e.code : 'INTERNAL';
          const msg = e instanceof Error ? e.message : String(e);
          resp = { id: reqId, ok: false, error: msg, code };
          if (code === 'INTERNAL') deps.log(`request failed: ${msg}`);
        }
        conn.write(JSON.stringify(resp) + '\n');
      }
    });
    conn.on('error', () => { /* client went away */ });
  });
  // The helper runs as root; the socket must NOT be world-writable, or any
  // local user or process could drive the root daemon. Two separate steps:
  //
  //  1. Bind under a restrictive umask. chmod()-ing afterwards leaves a window
  //     — however short — in which the socket exists with the process umask's
  //     permissions and is already accepting connections. Under a umask the
  //     kernel never creates it world-accessible in the first place. listen()
  //     binds the path synchronously, so restoring the umask right after the
  //     call is safe and keeps the change local to the bind.
  //  2. Verify, and refuse to serve if it cannot be verified. Failing open
  //     would mean a root-owned command socket that anyone can talk to.
  const prevMask = process.platform === 'win32' ? null : process.umask(0o177);
  try {
    server.listen(sock, () => deps.log(`helper listening on ${sock}`));
  } finally {
    if (prevMask !== null) process.umask(prevMask);
  }

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(sock, 0o600);
      // Hand it to the account that installed the GUI: connect() then requires
      // ownership, which the OS enforces for us. Unknown owner stays root-only.
      if (deps.ownerUid !== undefined && deps.ownerUid >= 0) {
        fs.chownSync(sock, deps.ownerUid, fs.statSync(sock).gid);
      }
      const mode = fs.statSync(sock).mode & 0o777;
      if ((mode & 0o077) !== 0) throw new Error(`socket mode is ${mode.toString(8)}`);
    } catch (e) {
      deps.log(`socket permission hardening failed, refusing to serve: ${String(e)}`);
      server.close();
      try { fs.unlinkSync(sock); } catch { /* nothing to clean up */ }
      throw new Error(`a helper socketje nem tehető biztonságossá: ${String(e)}`);
    }
  }
  return server;
}
