// Local IPC server: unix domain socket on macOS/Linux, named pipe on Windows.
// Protocol: one JSON request per line in, one JSON response per line out.

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { HelperRequest, HelperResponse, StatusData } from '../shared/protocol';
import { HELPER_VERSION } from '../shared/protocol';
import { normalizeDomain, expandHostnames } from '../shared/blocklist';
import { computeTier } from '../shared/challenges';
import { isBlockedNow } from '../shared/schedule';
import { recordSample, summarize, series, labelOf, emptyUsage } from '../shared/usage';
import type { UsageStatsData } from '../shared/protocol';
import type { HelperState, SiteRec } from './state';
import { newId } from './state';
import * as referee from './referee';
import { RefereeError } from './referee';
import { socketPath } from './paths';

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
      blockedNow: isBlockedNow(s, now),
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

    case 'usage_batch': {
      // Samples come from the user-session tracker; they only ever add time.
      for (const s of req.samples) {
        recordSample(state.usage, s.key, s.seconds, s.at, s.label);
      }
      deps.commit();
      return { ok: true, recorded: req.samples.length };
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
      // challenges — it is the user's own data.
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
  }
}

export function startServer(deps: ServerDeps): net.Server {
  const sock = socketPath();
  if (process.platform !== 'win32') {
    try { fs.mkdirSync(path.dirname(sock), { recursive: true }); } catch { /* ok */ }
    try { fs.unlinkSync(sock); } catch { /* ok */ }
  }
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
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
  server.listen(sock, () => {
    if (process.platform !== 'win32') {
      // The helper runs as root; the socket must NOT be world-writable, or any
      // local user/process could drive the root daemon. Restrict it to the
      // owner user (the account that installed the GUI) — connect() then
      // requires ownership, which the OS enforces. Fails closed: if the owner
      // is unknown we leave it root-only rather than world-open.
      try {
        fs.chmodSync(sock, 0o600);
        if (deps.ownerUid !== undefined && deps.ownerUid >= 0) {
          const gid = (() => { try { return fs.statSync(sock).gid; } catch { return process.getgid?.() ?? 0; } })();
          fs.chownSync(sock, deps.ownerUid, gid);
        }
      } catch (e) {
        deps.log(`socket permission hardening failed: ${String(e)}`);
      }
    }
    deps.log(`helper listening on ${sock}`);
  });
  return server;
}
