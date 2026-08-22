// Persistent helper state. Lives in a root/SYSTEM protected directory so the
// GUI (and the user) cannot simply edit the blocklist file to skip challenges.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Step } from '../shared/challenges';
import type { Schedule } from '../shared/schedule';
import { stateFilePath } from './paths';

export interface SiteRec {
  id: string;
  domain: string;
  hostnames: string[];
  addedAt: number;
  pauseUntil: number | null;
  pendingDeleteAt: number | null;
  /** optional weekly schedule; absent = always blocked */
  schedule?: Schedule;
}

export interface SessionRec {
  id: string;
  kind: 'pause' | 'delete';
  siteId: string;
  minutes?: number;
  steps: Step[];
  stepIndex: number;
  createdAt: number;
}

export interface HelperState {
  version: 1;
  sites: SiteRec[];
  /** epoch ms of every successful unlock/delete request, for difficulty tiers */
  unlockLog: number[];
  lastCombo: string | null;
  session: SessionRec | null;
  dohApplied: boolean;
}

export function defaultState(): HelperState {
  return { version: 1, sites: [], unlockLog: [], lastCombo: null, session: null, dohApplied: false };
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function loadState(): HelperState {
  const file = stateFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as HelperState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.sites)) return parsed;
  } catch {
    // missing or corrupt -> start fresh
  }
  return defaultState();
}

export function saveState(state: HelperState): void {
  const file = stateFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
