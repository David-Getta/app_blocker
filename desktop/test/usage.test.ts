import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  emptyUsage, recordSample, pruneOld, dayKey, dayKeysBack, totalsForDays,
  rank, sumOf, series, weekOverWeek, summarize, formatDuration,
  siteKey, appKey, kindOf, idOf, labelOf,
  RETENTION_DAYS, MAX_RECORD_SECONDS, MAX_TARGETS_PER_DAY, MAX_LABEL_LENGTH,
  OTHER_SITE_KEY, decideSample, domainFromBrowserUrl, type UsageState,
} from '../src/shared/usage';

/** An instant N local days before `now` (stepped at noon, DST-safe). */
function daysAgo(now: number, n: number): number {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

const NOW = new Date(2026, 4, 20, 15, 30, 0).getTime(); // 2026-05-20 15:30 local

test('keys: build and parse', () => {
  assert.equal(siteKey('youtube.com'), 'site:youtube.com');
  assert.equal(appKey('com.apple.Safari'), 'app:com.apple.Safari');
  assert.equal(kindOf('site:youtube.com'), 'site');
  assert.equal(kindOf('app:Slack'), 'app');
  assert.equal(idOf('site:youtube.com'), 'youtube.com');
  // ids containing a colon survive (only the first separator is consumed)
  assert.equal(idOf('app:com.foo:bar'), 'com.foo:bar');
});

test('dayKey and dayKeysBack', () => {
  assert.equal(dayKey(NOW), '2026-05-20');
  const back3 = dayKeysBack(NOW, 3);
  assert.deepEqual(back3, ['2026-05-18', '2026-05-19', '2026-05-20']);
  assert.equal(dayKeysBack(NOW, 1)[0], dayKey(NOW), 'single day is today');
  assert.equal(dayKeysBack(NOW, 30).length, 30);
});

test('recordSample accumulates into today and stores labels', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('youtube.com'), 5, NOW, 'YouTube');
  recordSample(st, siteKey('youtube.com'), 5, NOW);
  recordSample(st, appKey('Slack'), 10, NOW, 'Slack');
  assert.equal(st.days.length, 1);
  assert.equal(st.days[0].day, '2026-05-20');
  assert.equal(st.days[0].seconds['site:youtube.com'], 10);
  assert.equal(st.days[0].seconds['app:Slack'], 10);
  assert.equal(labelOf(st, siteKey('youtube.com')), 'YouTube');
  // unknown label falls back to the raw id
  assert.equal(labelOf(st, siteKey('reddit.com')), 'reddit.com');
});

test('recordSample ignores invalid samples and honours the off switch', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 0, NOW);
  recordSample(st, siteKey('a.com'), -5, NOW);
  recordSample(st, siteKey('a.com'), Number.NaN, NOW);
  assert.equal(st.days.length, 0, 'no bucket created for invalid samples');

  // a batch that waited out a long outage is kept in full...
  recordSample(st, siteKey('a.com'), 8 * 3600, NOW);
  assert.equal(st.days[0].seconds['site:a.com'], 8 * 3600, 'batched time is not truncated');
  // ...but more than a day for one target in one day is impossible, so it caps
  recordSample(st, siteKey('b.com'), 40 * 3600, NOW);
  assert.equal(st.days[0].seconds['site:b.com'], MAX_RECORD_SECONDS);

  const off: UsageState = { ...emptyUsage(), enabled: false };
  recordSample(off, siteKey('b.com'), 5, NOW);
  assert.equal(off.days.length, 0, 'disabled tracking records nothing');
});

test('samples land in separate buckets across day boundaries', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, 1));
  recordSample(st, siteKey('a.com'), 20, NOW);
  assert.equal(st.days.length, 2);
  assert.deepEqual(st.days.map((d) => d.day), ['2026-05-19', '2026-05-20'], 'kept in date order');
  assert.equal(totalsForDays(st, [dayKey(NOW)])['site:a.com'], 20);
});

test('pruneOld bounds history by bucket count and cleans orphaned labels', () => {
  const st = emptyUsage();
  // more days than retention allows
  for (let i = RETENTION_DAYS + 10; i >= 0; i--) {
    recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, i), 'A');
  }
  assert.equal(st.days.length, RETENTION_DAYS, 'never more than RETENTION_DAYS buckets');
  assert.equal(st.days[st.days.length - 1].day, dayKey(NOW), 'newest kept');

  const st2 = emptyUsage();
  recordSample(st2, siteKey('old.com'), 10, daysAgo(NOW, 5), 'Old');
  recordSample(st2, siteKey('new.com'), 10, NOW, 'New');
  st2.days = st2.days.filter((d) => d.day === dayKey(NOW)); // simulate the old day ageing out
  pruneOld(st2, NOW);
  assert.ok(!('site:old.com' in st2.labels), 'label of a dropped target is cleaned up');
  assert.equal(st2.labels['site:new.com'], 'New');
});

test('a wrong system clock never wipes history (either direction)', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, 1));
  recordSample(st, siteKey('a.com'), 10, NOW);
  const before = st.days.length;
  // clock jumps a year forward, then a year back: retention must not delete
  pruneOld(st, NOW + 365 * 24 * 3600_000);
  assert.equal(st.days.length, before, 'forward jump keeps history');
  pruneOld(st, NOW - 365 * 24 * 3600_000);
  assert.equal(st.days.length, before, 'backward jump keeps history');
});

test('a late/backdated sample never deletes newer history (clock-jump safety)', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 10, NOW);
  recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, 1));
  // now a sample arrives stamped 20 days in the past (backfill, NTP correction,
  // DST or a user clock change) — today's and yesterday's buckets must survive
  recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, 20));
  assert.equal(st.days.length, 3, 'all three buckets kept');
  assert.equal(totalsForDays(st, [dayKey(NOW)])['site:a.com'], 10, 'today intact');
  assert.equal(sumOf(totalsForDays(st, dayKeysBack(NOW, 30))), 30);

  // a sample stamped in the FUTURE must not wipe the present either
  recordSample(st, siteKey('a.com'), 10, daysAgo(NOW, -3));
  assert.equal(totalsForDays(st, [dayKey(NOW)])['site:a.com'], 10, 'today still intact');
});

test('totals, rank and sum', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('youtube.com'), 100, NOW, 'YouTube');
  recordSample(st, siteKey('reddit.com'), 50, NOW, 'Reddit');
  recordSample(st, appKey('Slack'), 75, NOW, 'Slack');
  const totals = totalsForDays(st, [dayKey(NOW)]);
  assert.equal(sumOf(totals), 225);

  const all = rank(st, totals);
  assert.deepEqual(all.map((r) => r.key),
    ['site:youtube.com', 'app:Slack', 'site:reddit.com'], 'sorted by time desc');

  const sitesOnly = rank(st, totals, { kind: 'site' });
  assert.deepEqual(sitesOnly.map((r) => r.key), ['site:youtube.com', 'site:reddit.com']);
  assert.equal(sitesOnly[0].label, 'YouTube');

  assert.equal(rank(st, totals, { limit: 2 }).length, 2);
});

test('series is zero-filled and ordered oldest first', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 30, daysAgo(NOW, 2));
  recordSample(st, siteKey('a.com'), 10, NOW);
  const s = series(st, siteKey('a.com'), NOW, 3);
  assert.deepEqual(s.map((x) => x.seconds), [30, 0, 10]);
  assert.equal(s[2].day, dayKey(NOW), 'last entry is today');
  // a target with no data at all yields zeros, not an empty array
  assert.deepEqual(series(st, siteKey('none.com'), NOW, 3).map((x) => x.seconds), [0, 0, 0]);
});

test('weekOverWeek compares the last 7 days against the 7 before', () => {
  const st = emptyUsage();
  // previous week (days 7..13 back): 600s ; this week (days 0..6 back): 300s
  recordSample(st, siteKey('youtube.com'), 100, daysAgo(NOW, 8), 'YouTube');
  recordSample(st, siteKey('youtube.com'), 100, daysAgo(NOW, 9));
  recordSample(st, siteKey('youtube.com'), 100, daysAgo(NOW, 10));
  recordSample(st, siteKey('youtube.com'), 100, daysAgo(NOW, 2));
  // a target only present this week has no baseline
  recordSample(st, siteKey('new.com'), 50, NOW, 'New');

  const rows = weekOverWeek(st, NOW);
  const yt = rows.find((r) => r.key === 'site:youtube.com')!;
  assert.equal(yt.thisWeek, 100);
  assert.equal(yt.lastWeek, 300);
  assert.ok(yt.deltaPct !== null && Math.round(yt.deltaPct) === -67, 'roughly -67%');

  const fresh = rows.find((r) => r.key === 'site:new.com')!;
  assert.equal(fresh.lastWeek, 0);
  assert.equal(fresh.deltaPct, null, 'no baseline -> null, not Infinity');
});

test('summarize reports today/yesterday/7/30 and split top lists', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('youtube.com'), 120, NOW, 'YouTube');
  recordSample(st, appKey('Slack'), 60, NOW, 'Slack');
  recordSample(st, siteKey('youtube.com'), 90, daysAgo(NOW, 1));
  recordSample(st, siteKey('youtube.com'), 30, daysAgo(NOW, 20));

  const s = summarize(st, NOW);
  assert.equal(s.enabled, true);
  assert.equal(s.todaySeconds, 180);
  assert.equal(s.yesterdaySeconds, 90);
  assert.equal(s.last7Seconds, 270);
  assert.equal(s.last30Seconds, 300);
  assert.equal(s.daysTracked, 3);
  assert.deepEqual(s.topToday.map((r) => r.key), ['site:youtube.com', 'app:Slack']);
  assert.deepEqual(s.topWeekSites.map((r) => r.key), ['site:youtube.com']);
  assert.deepEqual(s.topWeekApps.map((r) => r.key), ['app:Slack']);
});

test('summarize on an empty state is all zeros, not a crash', () => {
  const s = summarize(emptyUsage(), NOW);
  assert.equal(s.todaySeconds, 0);
  assert.equal(s.last30Seconds, 0);
  assert.deepEqual(s.topToday, []);
  assert.deepEqual(s.weekOverWeek, []);
  assert.equal(s.daysTracked, 0);
});

test('decideSample: only counts focused, non-idle time', () => {
  const base = {
    lastAt: NOW - 5000, now: NOW,
    fg: { appId: 'com.google.Chrome', appName: 'Chrome', domain: 'youtube.com' },
    intervalMs: 5000, idleThresholdMs: 60_000,
  };
  // in a browser tab -> attributed to the SITE (not the browser app)
  const d = decideSample({ ...base, idleSeconds: 2 })!;
  assert.equal(d.key, 'site:youtube.com');
  assert.equal(d.seconds, 5);

  // no readable tab -> attributed to the app
  const app = decideSample({ ...base, idleSeconds: 2, fg: { appId: 'Slack', appName: 'Slack' } })!;
  assert.equal(app.key, 'app:Slack');

  // idle past the threshold -> nothing counts, even though a window is focused
  assert.equal(decideSample({ ...base, idleSeconds: 60 }), null);
  assert.equal(decideSample({ ...base, idleSeconds: 3600 }), null);
  // right at the edge: 59s idle still counts, 60s does not
  assert.ok(decideSample({ ...base, idleSeconds: 59 }) !== null);

  // nothing focused (locked screen, no window) -> nothing counts
  assert.equal(decideSample({ ...base, idleSeconds: 1, fg: null }), null);
});

test('decideSample: sleep/wake gaps cannot inflate a sample', () => {
  const fg = { appId: 'Slack', appName: 'Slack' };
  // machine slept 8 hours between ticks; the user was not present for it
  const d = decideSample({
    lastAt: NOW - 8 * 3600_000, now: NOW, idleSeconds: 1, fg,
    intervalMs: 5000, idleThresholdMs: 60_000,
  })!;
  assert.equal(d.seconds, 10, 'clamped to two sample intervals');

  // a non-advancing or backwards clock records nothing
  assert.equal(decideSample({ lastAt: NOW, now: NOW, idleSeconds: 1, fg }), null);
  assert.equal(decideSample({ lastAt: NOW + 1000, now: NOW, idleSeconds: 1, fg }), null);
});

test('only a real URL from a browser becomes a tracked site', () => {
  // A probe reads the address bar through accessibility APIs, which also expose
  // every text field on the page. Anything that is not an absolute http(s) URL
  // must be refused, or what the user typed would become a stored "site".
  assert.equal(domainFromBrowserUrl('https://www.youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(domainFromBrowserUrl('http://example.com'), 'example.com');

  // typed into a compose box, a search field or a login form
  assert.equal(domainFromBrowserUrl('Szia! Holnap ráérek, hívj nyugodtan'), null);
  assert.equal(domainFromBrowserUrl('alice@clinic.example'), null, 'an email is not a site');
  assert.equal(domainFromBrowserUrl('clinic.example'), null, 'a bare hostname is not a URL');
  assert.equal(domainFromBrowserUrl('hunter2'), null);
  assert.equal(domainFromBrowserUrl(''), null);
  assert.equal(domainFromBrowserUrl('file:///Users/me/napló.txt'), null, 'only http(s)');
  assert.equal(domainFromBrowserUrl('javascript:alert(1)'), null);
});

test('a day cannot hold unbounded targets and the tail is not lost', () => {
  const st = emptyUsage();
  // a page fetching random subdomains, or anything else inventing target names
  for (let i = 0; i < MAX_TARGETS_PER_DAY + 150; i++) {
    recordSample(st, siteKey(`flood${i}.example`), i + 1, NOW);
  }
  const bucket = st.days[0];
  const keys = Object.keys(bucket.seconds);
  assert.ok(keys.length <= MAX_TARGETS_PER_DAY, `kept ${keys.length}, cap is ${MAX_TARGETS_PER_DAY}`);
  assert.ok(keys.includes(OTHER_SITE_KEY), 'the folded tail goes to a catch-all');

  // the day's TOTAL is preserved exactly — only the breakdown loses its tail
  const expectedTotal = ((MAX_TARGETS_PER_DAY + 150) * (MAX_TARGETS_PER_DAY + 151)) / 2;
  assert.equal(sumOf(bucket.seconds), expectedTotal, 'no measured time is dropped');

  // the biggest targets are the ones kept
  assert.ok(keys.includes(siteKey(`flood${MAX_TARGETS_PER_DAY + 149}.example`)),
    'the largest target survives');
});

test('long labels are truncated before they are stored', () => {
  const st = emptyUsage();
  recordSample(st, siteKey('a.com'), 5, NOW, 'x'.repeat(10_000));
  assert.equal(st.labels[siteKey('a.com')].length, MAX_LABEL_LENGTH);
});

test('formatDuration is human readable in Hungarian', () => {
  assert.equal(formatDuration(0), '0 mp');
  assert.equal(formatDuration(30), '30 mp');
  assert.equal(formatDuration(59), '59 mp');
  assert.equal(formatDuration(60), '1 p');
  assert.equal(formatDuration(45 * 60), '45 p');
  assert.equal(formatDuration(3600), '1 ó');
  assert.equal(formatDuration(2 * 3600 + 15 * 60), '2 ó 15 p');
  assert.equal(formatDuration(-5), '0 mp', 'negatives clamp to zero');
});
