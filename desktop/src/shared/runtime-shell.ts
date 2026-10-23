// A védett futtatókörnyezet telepítője (#151, macOS): a gyökér-héj parancsa.
//
// MIT CSINÁL. A rendszergazda egyetlen jóváhagyásával a segéd egy csak root
// által írható helyre kerül (helper-runtime.ts: RUNTIME_ROOT), és onnan fut —
// nem az app-csomagból, amit az app tulajdonosa írhat. A bemenetek (a segéd
// csomagja, a Node tarballja) a felhasználó helyéről jönnek, ezért a héj:
//   - mindent ELŐBB egy rootnak írható mappába másol (időkorláttal, mérethatárral
//     — egy FIFO vagy egy lassú kötet nem akaszthatja meg), és csak a másolatot
//     nézi: a felhasználó a vizsgált fájlt már nem cserélheti ki;
//   - a másolat ujjlenyomatát a parancsba égetett értékkel veti össze (a csomagét
//     az app adja, a Node-ét a rögzítés: helper-runtime.ts), a Node bináris
//     aláíróját is (Node.js Foundation, Team ID);
//   - a kibontott fát egységes jogokra hozza (root:wheel, se ACL, se kiterjesztett
//     attribútum), és ellenőrzi: nincs benne link, idegen tulajdonos, írható fájl;
//   - lefuttatja a segéd önellenőrzését (--selfcheck) a beállított Node-dal;
//   - ELŐBB az őrt teszi a helyére (ha az új segéd el sem indulna, az őr már
//     ismeri az új elrendezést), csak utána vált: a `current` link egy
//     átnevezéssel mutat át, a LaunchDaemon-leíró egy átnevezéssel cserélődik;
//   - újraindítja a segédet, és megvárja, hogy jelentkezzen (a segéd a
//     futtatókörnyezetbe írt `.ok-<név>` jellel mondja, hogy fut és tilt). Ha nem
//     jelentkezik, visszaáll pontosan oda, ahol a kattintás előtt volt.
//
// TISZTA KÖRNYEZET. A parancs `env -i`-vel indul: a felhasználó által
// beállítható környezeti változók (DYLD_*, NODE_OPTIONS, OPENSSL_CONF, PERL5OPT)
// nem utaznak a rendszergazdai jóváhagyással. A belső szkript base64-ben megy:
// semmilyen idézés nem törheti el.
//
// A HIBA. Minden megállás egy `BRK:<jel>` sort ír a hibakimenetre; a felület
// (main/install.ts) ebből mond magyar mondatot.
//
// TESZTELHETŐ. POSIX sh; a macOS-saját eszközök (launchctl, codesign, chmod -N,
// mv -h, ls -le …) egy-egy héjfüggvény mögött vannak, a teszt Linuxon dash-sel,
// csonkokkal futtatja (test/runtime-shell.test.ts).

import * as crypto from 'crypto';
import { shQuote } from './guard-script';
import { DAEMON_LABEL } from './install-script';
import {
  NODE_RUNTIME, PAYLOAD_ENTRY, RUNTIME_ID_RE, RUNTIME_ROOT, runtimeId, type NodeRuntimePin,
} from './helper-runtime';
import { MANIFEST_MAX_BYTES, NODE_TAR_MAX_BYTES, PAYLOAD_MAX_BYTES } from './helper-manifest';

/** A segéd LaunchDaemon-leírója. */
export const HELPER_PLIST_PATH = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
/** A segéd állapotmappája (az őr, a szigorú blokk, a napló is itt). */
export const BREAKER_DIR = '/Library/Application Support/Breaker';
/**
 * A segéd naplója a védett elrendezésben: az állapotmappában (a telepítő
 * ellenőrzi és létrehozza), nem a /Library/Logs alatt — azt a mappát az új
 * telepítő nem hozná létre, és a launchd a szülő nélkül el sem indítaná a segédet.
 */
export const HELPER_LOG = `${BREAKER_DIR}/helper.log`;

/** A futtatókörnyezet jele, hogy az adott változat elindult és tilt. */
export function okMarkName(id: string): string {
  return `.ok-${id}`;
}

/** A Node-bináris aláírójának kötelező tulajdonságai (codesign -R). */
export function nodeRequirement(pin: NodeRuntimePin = NODE_RUNTIME): string {
  return '=anchor apple generic'
    + ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    + ` and certificate leaf[subject.OU] = "${pin.teamId}"`
    + ` and identifier "${pin.identifier}"`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A segéd LaunchDaemon-leírója a védett futtatókörnyezetből. Egyszer íródik
 * (a telepítéskor): a csendes frissítés csak a `current` linket állítja át, a
 * leíró nem változik. Környezet: csak az OpenSSL modulmappája, egy üres,
 * rootnak írható mappára — a hivatalos Node beépített modulmappája egy
 * /Users/admin/… út, amit egy „admin” nevű felhasználó létrehozhatna.
 */
export function macHelperPlist(ownerUid: number, root: string = RUNTIME_ROOT, logPath: string = HELPER_LOG): string {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) throw new Error('érvénytelen felhasználó-azonosító');
  const cur = `${root}/current`;
  const args = [`${cur}/node`, '--disable-sigusr1', '--no-addons', `${cur}/${PAYLOAD_ENTRY}`, `--owner-uid=${ownerUid}`];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENSSL_MODULES</key><string>${xmlEscape(`${cur}/ossl-modules`)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(cur)}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array><string>hu.breaker.app</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/** A macOS-saját eszközök — a teszt Linuxon csonkokkal cseréli őket. */
export interface MacShellTools {
  launchctl: string;
  codesign: string;
  openssl: string;
  tar: string;
  /** a kibontás kapcsolói: se tulajdonos, se ACL, se kiterjesztett attribútum, se jelző */
  tarSafeFlags: string;
  sysctl: string;
  swVers: string;
  plutil: string;
  /** a kiterjesztett attribútumok törlése, rekurzívan */
  xattrClear: string;
  base64Decode: string;
  /** az ACL-ek törlése, rekurzívan */
  aclStrip: string;
  /** az ACL-ek törlése egyetlen útról (nem rekurzívan) */
  aclStripOne: string;
  /** egy fa tulajdonosa root:wheel, rekurzívan */
  ownRoot: string;
  /** egy linket cserél egy másikra (a cél egy mappára mutató link — nem bele, hanem helyette) */
  swapLink: string;
  /** egy fa listája ACL-sorokkal (macOS: ls -leR) */
  aclList: string;
  df: string;
  /**
   * Egy parancs a megadott felhasználóként (`<asUser> "#<uid>" <parancs…>`): a
   * csendes frissítés bemeneteit a felkínáló jogaival olvassuk — amit ő nem
   * olvashat, azt a segéd sem másolja be neki.
   */
  asUser: string;
}

export const MAC_SHELL_TOOLS: MacShellTools = {
  launchctl: '/bin/launchctl',
  codesign: '/usr/bin/codesign',
  openssl: '/usr/bin/openssl',
  tar: '/usr/bin/tar',
  tarSafeFlags: '--no-same-owner --no-xattrs --no-acls --no-fflags --no-mac-metadata',
  sysctl: '/usr/sbin/sysctl',
  swVers: '/usr/bin/sw_vers',
  plutil: '/usr/bin/plutil',
  xattrClear: '/usr/bin/xattr -cr',
  base64Decode: '/usr/bin/base64 -D',
  aclStrip: '/bin/chmod -RN',
  aclStripOne: '/bin/chmod -N',
  ownRoot: '/usr/sbin/chown -R root:wheel',
  swapLink: '/bin/mv -fh',
  aclList: '/bin/ls -leR',
  df: '/bin/df -Pk',
  asUser: '/usr/bin/sudo -n -u',
};

export interface MacRuntimeShellOptions {
  /** a segéd állapotmappája (az őr itt) */
  dir: string;
  /** a védett futtatókörnyezet */
  runtime: string;
  /** a LaunchDaemon-leírók mappája */
  daemonsDir: string;
  /** a megbízható tulajdonos (root) */
  ownerUid: number;
  /** a mappa szülei, amiknek a rootéknak kell lenniük */
  trustChain: string[];
  tools: MacShellTools;
  pin: NodeRuntimePin;
  /** egy felhasználói fájl bemásolásának időkorlátja (s) */
  copySeconds: number;
  /** az önellenőrzés időkorlátja (s) */
  selfcheckSeconds: number;
  /** ennyi ideig várunk, hogy az új segéd jelentkezzen (s) */
  healthSeconds: number;
  /** a leállás és az indítás próbálkozásai közti várakozás (s) */
  pollSeconds: number;
  /** szabad hely, ami nélkül nem kezdünk bele (KiB) */
  minFreeKb: number;
  /** a legkisebb macOS (a Node-é) */
  minMacos: readonly [number, number];
}

export const MAC_RUNTIME_SHELL_DEFAULTS: MacRuntimeShellOptions = {
  dir: BREAKER_DIR,
  runtime: RUNTIME_ROOT,
  daemonsDir: '/Library/LaunchDaemons',
  ownerUid: 0,
  trustChain: ['/', '/Library', '/Library/Application Support'],
  tools: MAC_SHELL_TOOLS,
  pin: NODE_RUNTIME,
  copySeconds: 60,
  selfcheckSeconds: 30,
  healthSeconds: 45,
  pollSeconds: 1,
  minFreeKb: 400 * 1024,
  minMacos: NODE_RUNTIME.minMacos,
};

/** Amit a telepítés a felülettől kap. */
export interface MacInstallInputs {
  /** a telepítő felhasználó (a segéd csatornája erre szűkül) */
  ownerUid: number;
  /** a segéd csomagja az app-csomagban (Contents/Resources/helper/payload.tar) */
  payloadTar: string;
  payloadSha256: string;
  payloadSize: number;
  /** a letöltött Node tarball; null, ha a futó futtatókörnyezet Node-ja is jó */
  nodeTar: string | null;
  /** az őr szkriptje és leírója (guard-script.ts) */
  guardScript: string;
  guardPlist: string;
}

const SHA_RE = /^[0-9a-f]{64}$/;
/** A felhasználótól jövő út: abszolút, sorvég és NUL nélkül. */
function checkPath(p: string, what: string): void {
  if (!p.startsWith('/') || /[\0\n\r]/.test(p)) throw new Error(`${what}: érvénytelen út`);
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** A közös eleje: tiszta beállítások, eszközök, hiba-jelek, a bizalmi lánc, a futtatókörnyezet mappája. */
function prologue(o: MacRuntimeShellOptions): string[] {
  const t = o.tools;
  return [
    'set -eu',
    'umask 077',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    'export PATH',
    'LC_ALL=C',
    'export LC_ALL',
    `D=${shQuote(o.dir)}`,
    `RT=${shQuote(o.runtime)}`,
    `LD=${shQuote(o.daemonsDir)}`,
    `DP="$LD/${DAEMON_LABEL}.plist"`,
    'LOCK="$RT/.lock"',
    'HOLD=0',
    'DIED=',
    'S=',
    '',
    `lctl() { ${t.launchctl} "$@"; }`,
    `b64d() { ${t.base64Decode}; }`,
    `acl_strip() { ${t.aclStrip} "$@"; }`,
    `acl_strip_one() { ${t.aclStripOne} "$@"; }`,
    `own_root() { ${t.ownRoot} "$@"; }`,
    `swap_link() { ${t.swapLink} "$@"; }`,
    `acl_list() { ${t.aclList} "$@"; }`,
    `xattr_clear() { ${t.xattrClear} "$@"; }`,
    '',
    '# A hibakimenet egy saját leírón (3) is: egy csapda kezelője a megszakított',
    '# parancs átirányításán belül is futhat (dash), és a jel ott nem veszhet el.',
    'exec 3>&2',
    '# Megállás egy jellel: a felület ebből mond mondatot.',
    'die() { DIED=1; printf \'BRK:%s\\n\' "$1" >&3; exit 1; }',
    '# A zárat csak akkor engedjük el, ha még a miénk (egy átvett zárat nem).',
    'cleanup() {',
    '  rc=$?',
    '  [ -n "$S" ] && rm -rf "$S"',
    '  if [ "$HOLD" = 1 ] && [ "$(head -n 1 "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK"; fi',
    '  if [ "$rc" != 0 ] && [ -z "$DIED" ]; then printf \'BRK:fail\\n\' >&3; fi',
    '}',
    'trap cleanup EXIT',
    "trap 'exit 1' HUP INT TERM",
    '# Ha a jelszóablak közben feladta (lezárt kimenet), az írás ne ölje meg a héjat.',
    "trap '' PIPE",
    '',
    '# Egy út a rooté-e, nem link, és se a csoport, se más nem írhatja.',
    'trusted() {',
    `  [ ! -L "$1" ] && [ -n "$(find "$1" -prune -user ${o.ownerUid} ! -perm -0020 ! -perm -0002 2>/dev/null)" ]`,
    '}',
    '',
    '# SHA-256 a standard bemenetről (a fájlnév nem kerül a kimenetbe).',
    `sha_of() { ${t.openssl} dgst -sha256 < "$1" | awk '{print $NF}'; }`,
    '',
    '# Egy KÜLSŐ parancs időkorláttal. Nem várunk rá vakon: tizedmásodpercenként',
    '# megnézzük, él-e még; ha lejárt az idő, leállítjuk, és MAGÁRA HAGYJUK — egy',
    '# meg nem szakítható kernel-várakozásban (egy beragadt hálózati kötet) a',
    '# leállítás sem érné el azonnal, a telepítő viszont ettől nem akadhat meg.',
    '# (Függvényt ne: a háttérbe tett függvény egy köztes héj, a leállítás nem a',
    '# parancsot érné.)',
    'limited() {',
    '  secs=$1; shift',
    '  "$@" 3>&- &',
    '  lp=$!',
    '  ln=0',
    '  while kill -0 "$lp" 2>/dev/null; do',
    '    if [ "$ln" -ge $((secs * 10)) ]; then kill -9 "$lp" 2>/dev/null; return 124; fi',
    '    sleep 0.1',
    '    ln=$((ln + 1))',
    '  done',
    '  wait "$lp"',
    '}',
    '',
    '# Felhasználói fájl bemásolása: csak sima fájl, legfeljebb N×64 KiB, időkorláttal.',
    '# A felhasználó útjához a root héj maga nem nyúl: a vizsgálat (link? sima fájl?)',
    '# és a másolás is egy időkorlátos gyermekfolyamatban fut — egy FIFO vagy egy',
    '# beragadt kötet azt akasztja meg, nem a telepítőt. Utána CSAK a másolatot',
    '# nézzük: azt a felhasználó már nem cserélheti ki.',
    'copy_in() {',
    `  limited ${o.copySeconds} /bin/sh -c '[ ! -L "$1" ] && [ -f "$1" ] && exec dd if="$1" of="$2" bs=65536 count="$3"' copy_in "$1" "$2" "$3" >/dev/null 2>&1`,
    '}',
    '',
    '# A bizalmi lánc: a szülők és az állapotmappa a rooté, más nem írhatja.',
    ...o.trustChain.map((p) => `trusted ${shQuote(p)} || die untrusted`),
    'if [ ! -e "$D" ] && [ ! -L "$D" ]; then mkdir -m 755 "$D"; fi',
    'if [ -L "$D" ] || [ ! -d "$D" ]; then die untrusted; fi',
    'acl_strip_one "$D" 2>/dev/null || true',
    'chmod go-w "$D"',
    'trusted "$D" || die untrusted',
    '# A futtatókörnyezet: root:wheel 0700, ACL nélkül.',
    'if [ ! -e "$RT" ] && [ ! -L "$RT" ]; then mkdir -m 700 "$RT"; fi',
    'if [ -L "$RT" ] || [ ! -d "$RT" ]; then die untrusted; fi',
    'own_root "$RT"',
    'chmod 700 "$RT"',
    'acl_strip "$RT"',
    'trusted "$RT" || die untrusted',
  ];
}

/** A zár: egyszerre egy telepítés vagy frissítés. Egy halott tartó zárját átvesszük. */
function lockPart(): string[] {
  return [
    'take_lock() {',
    '  if mkdir "$LOCK" 2>/dev/null; then HOLD=1; echo $$ > "$LOCK/pid"; return 0; fi',
    '  old=$(head -n 1 "$LOCK/pid" 2>/dev/null || true)',
    "  case \"$old\" in ''|*[!0-9]*) old= ;; esac",
    '  stale=0',
    '  # Üres azonosító: lehet, hogy a tartó épp most hozta létre — csak ha már percek óta így áll.',
    '  if [ -z "$old" ]; then',
    '    if [ -n "$(find "$LOCK" -prune -mmin +1 2>/dev/null)" ]; then stale=1; fi',
    '  elif ! kill -0 "$old" 2>/dev/null; then',
    '    stale=1',
    '  fi',
    '  if [ -n "$(find "$LOCK" -prune -mmin +10 2>/dev/null)" ]; then stale=1; fi',
    '  [ "$stale" = 1 ] || die busy',
    '  rm -rf "$LOCK"',
    '  mkdir "$LOCK" 2>/dev/null || die busy',
    '  HOLD=1',
    '  echo $$ > "$LOCK/pid"',
    '}',
    'take_lock',
  ];
}

interface StageValues {
  payloadTar: string;
  payloadSha256: string;
  payloadSize: number;
  nodeTar: string | null;
}

/**
 * A változat összeállítása a stage-ben: Node (a futóból kölcsönözve, vagy a
 * tarballból), a csomag, egységes jogok, önellenőrzés. A `current`-hez, a
 * leíróhoz és a többi változathoz nem nyúl.
 */
function stagePart(o: MacRuntimeShellOptions, v: StageValues): string[] {
  const t = o.tools;
  const p = o.pin;
  const ids = { arm64: runtimeId(v.payloadSha256, p.arm64.binSha256), x64: runtimeId(v.payloadSha256, p.x64.binSha256) };
  for (const id of Object.values(ids)) if (!RUNTIME_ID_RE.test(id)) throw new Error('érvénytelen változatnév');
  const [minMajor, minMinor] = o.minMacos;
  return [
    '# macOS: a Node ennél régebbin nem indul.',
    `V=$(${t.swVers} -productVersion 2>/dev/null || true)`,
    'case "$V" in *.*) ;; *) V="$V.0" ;; esac',
    'MAJ=${V%%.*}',
    'REST=${V#*.}',
    'MIN=${REST%%.*}',
    "case \"$MAJ\" in ''|*[!0-9]*) die macos ;; esac",
    "case \"$MIN\" in ''|*[!0-9]*) die macos ;; esac",
    `if [ "$MAJ" -lt ${minMajor} ] || { [ "$MAJ" -eq ${minMajor} ] && [ "$MIN" -lt ${minMinor} ]; }; then die macos; fi`,
    '',
    `FREE=$(${t.df} "$RT" | awk 'NR==2{print $4}')`,
    "case \"$FREE\" in ''|*[!0-9]*) FREE=0 ;; esac",
    `[ "$FREE" -ge ${o.minFreeKb} ] || die space`,
    '',
    '# A gép architektúrája (Rosetta alatt is a natív).',
    `if [ "$(${t.sysctl} -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; else ARCH=x64; fi`,
    '# A változat neve a csomag és a Node ujjlenyomatából (helper-runtime.ts: runtimeId).',
    'case "$ARCH" in',
    `  arm64) TAR_SHA=${p.arm64.tarSha256}; TAR_SIZE=${p.arm64.tarSize}; MEMBER=${shQuote(p.arm64.member)}; BIN_SHA=${p.arm64.binSha256}; B=${ids.arm64} ;;`,
    `  *) TAR_SHA=${p.x64.tarSha256}; TAR_SIZE=${p.x64.tarSize}; MEMBER=${shQuote(p.x64.member)}; BIN_SHA=${p.x64.binSha256}; B=${ids.x64} ;;`,
    'esac',
    `PAY_SHA=${v.payloadSha256}`,
    `PAY_SIZE=${v.payloadSize}`,
    `PAY_TAR=${shQuote(v.payloadTar)}`,
    `NODE_TAR=${v.nodeTar === null ? "''" : shQuote(v.nodeTar)}`,
    '',
    'S=$(mktemp -d "$RT/.stage.XXXXXX") || die fail',
    '',
    '# A Node: a futó futtatókörnyezetéből (kemény link, ugyanaz a fájl), ha a',
    '# rögzítés szerinti; különben a tarballból.',
    'if [ -f "$RT/current/node" ] && ln "$RT/current/node" "$S/node" 2>/dev/null; then',
    '  [ "$(sha_of "$S/node")" = "$BIN_SHA" ] || rm -f "$S/node"',
    'fi',
    'if [ ! -f "$S/node" ]; then',
    '  [ -n "$NODE_TAR" ] || die need-node',
    `  copy_in "$NODE_TAR" "$S/n.txz" ${NODE_TAR_MAX_BYTES / 65536} || die copy`,
    '  [ "$(wc -c < "$S/n.txz" | tr -d \' \')" = "$TAR_SIZE" ] || die verify',
    '  [ "$(sha_of "$S/n.txz")" = "$TAR_SHA" ] || die verify',
    '  mkdir "$S/nx"',
    `  ${t.tar} ${t.tarSafeFlags} -xJ -f "$S/n.txz" -C "$S/nx" "$MEMBER" || die verify`,
    '  [ -f "$S/nx/$MEMBER" ] && [ ! -L "$S/nx/$MEMBER" ] || die verify',
    '  mv "$S/nx/$MEMBER" "$S/node"',
    '  rm -rf "$S/nx" "$S/n.txz"',
    '  [ "$(sha_of "$S/node")" = "$BIN_SHA" ] || die verify',
    `  ${t.codesign} --verify --strict -R ${shQuote(nodeRequirement(p))} "$S/node" >/dev/null 2>&1 || die codesign`,
    'fi',
    '',
    '# A segéd csomagja: bemásolva, ujjlenyomat, kibontás; benne csak sima fájl és mappa.',
    `copy_in "$PAY_TAR" "$S/p.tar" ${PAYLOAD_MAX_BYTES / 65536} || die copy`,
    '[ "$(wc -c < "$S/p.tar" | tr -d \' \')" = "$PAY_SIZE" ] || die verify',
    '[ "$(sha_of "$S/p.tar")" = "$PAY_SHA" ] || die verify',
    `${t.tar} ${t.tarSafeFlags} -x -f "$S/p.tar" -C "$S" app || die verify`,
    'rm -f "$S/p.tar"',
    `[ -f "$S/${PAYLOAD_ENTRY}" ] || die verify`,
    'mkdir "$S/ossl-modules"',
    'printf \'{"payloadSha256":"%s","binSha256":"%s","nodeVersion":"%s","arch":"%s"}\\n\' '
      + `"$PAY_SHA" "$BIN_SHA" ${shQuote(p.version)} "$ARCH" > "$S/runtime.json"`,
    '',
    '# Egységes jogok: root:wheel, se ACL, se kiterjesztett attribútum; aztán ellenőrzés.',
    'xattr_clear "$S" 2>/dev/null || true',
    'acl_strip "$S"',
    'own_root "$S"',
    'chmod -R u=rwX,go=rX "$S"',
    'chmod 755 "$S/node"',
    'TOP=$(ls -A "$S" | tr \'\\n\' \' \')',
    '[ "$TOP" = "app node ossl-modules runtime.json " ] || die verify',
    `[ -z "$(find "$S" \\( ! -user ${o.ownerUid} -o -perm -0020 -o -perm -0002 -o \\( ! -type f ! -type d \\) \\) -print | head -n 1)" ] || die verify`,
    "if acl_list \"$S\" | grep -Eq '^ [0-9]+: '; then die verify; fi",
    '',
    '# Önellenőrzés: a beállított Node betölti a segéd teljes kódját, tiszta környezetben.',
    `limited ${o.selfcheckSeconds} env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin OPENSSL_MODULES="$S/ossl-modules" \\`,
    `  "$S/node" --disable-sigusr1 --no-addons "$S/${PAYLOAD_ENTRY}" --selfcheck > "$S/.check" 2>/dev/null \\`,
    '  || { rm -f "$S/.check"; die selfcheck; }',
    '[ "$(cat "$S/.check")" = ok ] || { rm -f "$S/.check"; die selfcheck; }',
    'rm -f "$S/.check"',
  ];
}

/**
 * A kész változat a helyére: a neve a tartalmából jön. Ha már megvan (javítás),
 * a régit félretesszük, és pontosan a most ellenőrzött fa kerül a helyére.
 */
function placePart(): string[] {
  return [
    'if [ -e "$RT/$B" ] || [ -L "$RT/$B" ]; then',
    '  OLD=$(mktemp -d "$RT/.old.XXXXXX")',
    '  mv "$RT/$B" "$OLD/"',
    'fi',
    'mv "$S" "$RT/$B"',
    'S=',
    'sync',
  ];
}

/** Az őr előbb: ha az új segéd el sem indulna, az őr már az új elrendezést ismeri. */
function guardPart(o: MacRuntimeShellOptions, guardScript: string, guardPlist: string): string[] {
  const sha = (x: string) => crypto.createHash('sha256').update(x, 'utf8').digest('hex');
  return [
    '# Egy fájl a helyére: ideiglenes fájl az állapotmappában, az ujjlenyomata a',
    '# parancsba égetett (egy betelt lemezen félbemaradt írás sem kerülhet a',
    '# helyére), aztán átnevezés. Minden lépés hibája megállít.',
    'put() {',
    '  pt=$(mktemp "$D/.put.XXXXXX") || return 1',
    '  printf \'%s\' "$1" | b64d > "$pt" || { rm -f "$pt"; return 1; }',
    '  [ "$(sha_of "$pt")" = "$4" ] || { rm -f "$pt"; return 1; }',
    '  { own_root "$pt" && chmod "$3" "$pt" && sync && mv -f "$pt" "$2"; } || { rm -f "$pt"; return 1; }',
    '}',
    `GUARD_SH="$D/guard.sh"`,
    `GUARD_PL="$LD/hu.breaker.guard.plist"`,
    `put ${shQuote(b64(guardScript))} "$GUARD_SH" 755 ${sha(guardScript)} || die guard`,
    'GCHANGED=1',
    `if [ -f "$GUARD_PL" ] && [ ! -L "$GUARD_PL" ] && [ "$(sha_of "$GUARD_PL")" = ${sha(guardPlist)} ]; then GCHANGED=0; fi`,
    'if [ "$GCHANGED" = 1 ]; then',
    `  put ${shQuote(b64(guardPlist))} "$D/.guard.plist.new" 644 ${sha(guardPlist)} || die guard`,
    `  ${o.tools.plutil} -lint "$D/.guard.plist.new" >/dev/null 2>&1 || { rm -f "$D/.guard.plist.new"; die guard; }`,
    '  mv -f "$D/.guard.plist.new" "$GUARD_PL" || { rm -f "$D/.guard.plist.new"; die guard; }',
    'fi',
    '# Betöltés: ha fut és változott, előbb ki (megvárva), aztán be — próbálkozással.',
    '# Ha így sem megy, a leíró a helyén van: a gép következő indításakor elindul.',
    'guard_load() {',
    '  if lctl print system/hu.breaker.guard >/dev/null 2>&1; then',
    '    [ "$GCHANGED" = 1 ] || return 0',
    '    lctl bootout system/hu.breaker.guard >/dev/null 2>&1',
    '    n=0',
    `    while lctl print system/hu.breaker.guard >/dev/null 2>&1 && [ $n -lt 10 ]; do sleep ${o.pollSeconds}; n=$((n + 1)); done`,
    '  fi',
    '  n=0',
    `  until lctl bootstrap system "$GUARD_PL" >/dev/null 2>&1; do n=$((n + 1)); [ $n -ge 10 ] && return 1; sleep ${o.pollSeconds}; done`,
    '  return 0',
    '}',
    'guard_load || die guard',
  ];
}

/**
 * A váltás: a `current` link és a leíró, újraindítás, és a jel megvárása. Ha az
 * új segéd nem jelentkezik, visszaállunk; ha igen, a régi változatokat töröljük.
 */
function activatePart(o: MacRuntimeShellOptions, plist: string): string[] {
  const t = o.tools;
  const polls = Math.max(1, Math.ceil(o.healthSeconds / Math.max(o.pollSeconds, 0.01)));
  return [
    '# A leíró előbb az állapotmappába, ellenőrizve — a LaunchDaemons alá csak kész fájl kerül.',
    'NEWPL="$D/.helper.plist.new"',
    'rm -f "$NEWPL"',
    `printf '%s' ${shQuote(b64(plist))} | b64d > "$NEWPL"`,
    `${t.plutil} -lint "$NEWPL" >/dev/null 2>&1 || { rm -f "$NEWPL"; die plist; }`,
    'own_root "$NEWPL"',
    'chmod 644 "$NEWPL"',
    '',
    '# Innen nincs megállás félúton: minden hiba a visszaállásba fut. A kattintás',
    '# előtti állapotot pontosan feljegyezzük — a visszaállás ezt teszi vissza, nem',
    '# találgat: volt-e leíró, és mire mutatott a current link.',
    'set +e',
    'HADPL=0',
    '[ -f "$DP" ] && HADPL=1',
    'OLDCUR=$(readlink "$RT/current" 2>/dev/null)',
    "case \"$OLDCUR\" in ????????????????) case \"$OLDCUR\" in *[!0-9a-f]*) OLDCUR= ;; esac ;; *) OLDCUR= ;; esac",
    'BACKUP=',
    'if [ "$HADPL" = 1 ] && ! cmp -s "$DP" "$NEWPL"; then',
    '  BACKUP="$D/helper.plist.prev"',
    '  rm -f "$BACKUP"',
    '  cp -p "$DP" "$BACKUP" || { rm -f "$NEWPL"; die fail; }',
    'fi',
    'set_current() {',
    '  rm -f "$RT/.current.new"',
    '  ln -s "$1" "$RT/.current.new" && swap_link "$RT/.current.new" "$RT/current"',
    '}',
    'reload() {',
    `  lctl bootout system/${DAEMON_LABEL} >/dev/null 2>&1`,
    '  n=0',
    `  while lctl print system/${DAEMON_LABEL} >/dev/null 2>&1 && [ $n -lt 10 ]; do sleep ${o.pollSeconds}; n=$((n + 1)); done`,
    '  [ -f "$DP" ] || return 0',
    '  n=0',
    `  until lctl bootstrap system "$DP" >/dev/null 2>&1; do n=$((n + 1)); [ $n -ge 10 ] && return 1; sleep ${o.pollSeconds}; done`,
    '  return 0',
    '}',
    '# Vissza a kattintás előtti állapotba: a current oda, ahová mutatott (vagy',
    '# sehová), a leíró az előző (vagy semmi, ha nem volt), és újraindítás. Ha az',
    '# újraindítás sem megy, kimondjuk: a gép következő indításakor indul.',
    'rollback() {',
    "  trap '' HUP INT TERM",
    '  if [ -n "$OLDCUR" ]; then',
    '    [ "$OLDCUR" = "$B" ] || set_current "$OLDCUR"',
    '  else',
    '    rm -f "$RT/current"',
    '  fi',
    '  if [ -n "$BACKUP" ]; then',
    '    mv -f "$BACKUP" "$DP"',
    '  elif [ "$HADPL" = 0 ]; then',
    '    rm -f "$DP"',
    '  fi',
    '  rm -f "$RT/.pending" "$NEWPL"',
    '  sync',
    '  reload || die restore',
    '  die "$1"',
    '}',
    '',
    `rm -f "$RT/${okMarkName('$B')}"`,
    '# A szándék előbb a lemezre: ha a telepítő félúton leállna (áramszünet,',
    '# leállítás), az őr ebből tudja, mire álljon vissza (guard-script.ts).',
    'printf \'%s\\n%s\\n\' "$B" "$OLDCUR" > "$RT/.pending" || { rm -f "$NEWPL"; die fail; }',
    'sync',
    "trap 'rollback interrupted' HUP INT TERM",
    'set_current "$B" || rollback fail',
    'mv -f "$NEWPL" "$DP" || rollback plist',
    'sync',
    'reload || rollback bootstrap',
    '',
    '# Az új segéd jele: elindult a futtatókörnyezetből, a csatorna nyitva, egy kör lefutott.',
    'n=0',
    `while [ ! -f "$RT/${okMarkName('$B')}" ] && [ $n -lt ${polls} ]; do sleep ${o.pollSeconds}; n=$((n + 1)); done`,
    `[ -f "$RT/${okMarkName('$B')}" ] || rollback health`,
    '',
    '# Rendben: a régi változatok, a félbemaradt stage-ek és a mentés mehet.',
    'for e in "$RT"/* "$RT"/.[!.]*; do',
    '  [ -e "$e" ] || [ -L "$e" ] || continue',
    '  n=${e##*/}',
    `  case "$n" in "$B"|current|.lock|.bad|.offer.json|${okMarkName('"$B"')}) continue ;; esac`,
    '  rm -rf "$e"',
    'done',
    "trap 'exit 1' HUP INT TERM",
    'rm -f "$D/helper.plist.prev" "$D"/.put.* "$D/.guard.plist.new"',
    'printf \'ok %s\\n\' "$B"',
    'exit 0',
  ];
}

/**
 * A teljes telepítés (rendszergazdaként): előfeltételek, zár, összeállítás,
 * őr, váltás, egészség-ellenőrzés. A belső szkript — a tesztek ezt futtatják.
 */
export function macInstallScript(inputs: MacInstallInputs, o: MacRuntimeShellOptions = MAC_RUNTIME_SHELL_DEFAULTS): string {
  if (!Number.isSafeInteger(inputs.ownerUid) || inputs.ownerUid < 0) throw new Error('érvénytelen felhasználó-azonosító');
  if (!SHA_RE.test(inputs.payloadSha256)) throw new Error('érvénytelen csomag-ujjlenyomat');
  if (!Number.isSafeInteger(inputs.payloadSize) || inputs.payloadSize <= 0 || inputs.payloadSize > PAYLOAD_MAX_BYTES) {
    throw new Error('érvénytelen csomagméret');
  }
  checkPath(inputs.payloadTar, 'a csomag');
  if (inputs.nodeTar !== null) checkPath(inputs.nodeTar, 'a Node');
  return `${[
    ...prologue(o),
    ...lockPart(),
    ...stagePart(o, inputs),
    ...guardPart(o, inputs.guardScript, inputs.guardPlist),
    ...placePart(),
    ...activatePart(o, macHelperPlist(inputs.ownerUid, o.runtime)),
  ].join('\n')}\n`;
}

/** A csendes frissítés bemenetei: a felülettől kapott utak. */
export interface MacFetchInputs {
  /** a csomag mappája (…/Contents/Resources/helper): manifest.json, manifest.sig, payload.tar */
  bundle: string;
  /** a letöltött Node tarball (ha a frissítés új Node-ot kér) */
  nodeTar: string | null;
  /** a felkínáló (a socket gazdája): az ő jogaival olvasunk */
  readAs: number;
}

/**
 * A frissítés bemeneteinek bemásolása (a segéd futtatja, rootként, a zárat a
 * segéd tartja): egy `$RT/.in.*` mappába, a telepítő `copy_in`-jével —
 * időkorláttal, mérethatárral, csak sima fájlt. A kimenet: `in <mappa>`.
 */
export function macFetchScript(inputs: MacFetchInputs, o: MacRuntimeShellOptions = MAC_RUNTIME_SHELL_DEFAULTS): string {
  checkPath(inputs.bundle, 'a csomag mappája');
  if (inputs.nodeTar !== null) checkPath(inputs.nodeTar, 'a Node');
  if (!Number.isSafeInteger(inputs.readAs) || inputs.readAs <= 0) throw new Error('érvénytelen felhasználó');
  return `${[
    ...prologue(o),
    `BUNDLE=${shQuote(inputs.bundle)}`,
    `NODE_TAR=${inputs.nodeTar === null ? "''" : shQuote(inputs.nodeTar)}`,
    `READ_AS=${inputs.readAs}`,
    '# A felkínált fájlokat a felkínáló JOGAIVAL olvassuk (nem rootként): egy',
    '# keménylink vagy egy közben kicserélt link így sem visz el egy csak root',
    '# által olvasható fájlhoz. Az olvasó gyermek a kimenetére ír, a fájlt a root',
    '# héj nyitja — a másolat a rooté.',
    'copy_as() {',
    `  limited ${o.copySeconds} ${o.tools.asUser} "#$READ_AS" /bin/sh -c '[ ! -L "$1" ] && [ -f "$1" ] && exec dd if="$1" bs=65536 count="$2"' copy_as "$1" "$3" > "$2" 2>/dev/null`,
    '}',
    'S=$(mktemp -d "$RT/.in.XXXXXX") || die fail',
    `copy_as "$BUNDLE/manifest.json" "$S/manifest.json" ${MANIFEST_MAX_BYTES / 65536} || die copy`,
    `copy_as "$BUNDLE/manifest.sig" "$S/manifest.sig" 1 || die copy`,
    `copy_as "$BUNDLE/payload.tar" "$S/payload.tar" ${PAYLOAD_MAX_BYTES / 65536} || die copy`,
    `if [ -n "$NODE_TAR" ]; then copy_as "$NODE_TAR" "$S/node.tar.xz" ${NODE_TAR_MAX_BYTES / 65536} || die copy; fi`,
    'IN="$S"',
    'S=',
    'printf \'in %s\\n\' "$IN"',
  ].join('\n')}\n`;
}

/** A csendes frissítés összeállítása: a már ellenőrzött (aláírt) leíró szerint. */
export interface MacStageInputs {
  payloadTar: string;
  payloadSha256: string;
  payloadSize: number;
  nodeTar: string | null;
}

/**
 * Egy új változat összeállítása és a helyére tétele (a segéd futtatja, a zárat
 * a segéd tartja) — ugyanaz az összeállítás, mint a telepítésé, de a `current`
 * linkhez, a leíróhoz és az őrhöz nem nyúl. A Node rögzítése az aláírt leíróból
 * jön (`o.pin`), a Team ID és az azonosító a futó segéd kódjából. A kimenet:
 * `ok <név>`.
 */
export function macStageScript(inputs: MacStageInputs, o: MacRuntimeShellOptions = MAC_RUNTIME_SHELL_DEFAULTS): string {
  if (!SHA_RE.test(inputs.payloadSha256)) throw new Error('érvénytelen csomag-ujjlenyomat');
  if (!Number.isSafeInteger(inputs.payloadSize) || inputs.payloadSize <= 0 || inputs.payloadSize > PAYLOAD_MAX_BYTES) {
    throw new Error('érvénytelen csomagméret');
  }
  checkPath(inputs.payloadTar, 'a csomag');
  if (inputs.nodeTar !== null) checkPath(inputs.nodeTar, 'a Node');
  return `${[
    ...prologue(o),
    ...stagePart(o, inputs),
    ...placePart(),
    'printf \'ok %s\\n\' "$B"',
  ].join('\n')}\n`;
}

/**
 * A gyökér-héj parancsa: a belső szkript tiszta környezetben (`env -i`) fut,
 * base64-ben átadva — egy idézőjel sem törheti el. A KÜLSŐ héjat (amit a
 * `do shell script` indít) az `env -i` nem védi: ezért a felület az osascriptet
 * maga is tiszta, minimális környezettel indítja (main/install.ts), és itt csak
 * abszolút utak szerepelnek (exportált függvény nem írhatja felül őket).
 */
export function macRootCommand(script: string): string {
  return 'exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL=C /bin/sh -c '
    + `"$(/bin/echo ${b64(script)} | /usr/bin/base64 -D)"`;
}

/** A rendszergazdai ablak szövege. */
export const MAC_INSTALL_PROMPT = 'A Breaker a védelem háttérszolgáltatását telepíti vagy javítja: egy csak rendszergazda '
  + 'által módosítható helyre teszi, és rendszerjoggal indítja.';

/** A `BRK:<jel>` → magyar mondat (a felület ezt mutatja). */
export const MAC_INSTALL_ERRORS: Record<string, string> = {
  untrusted: 'A védelem mappája nem megbízható (nem a rendszergazdáé, vagy szimbolikus link). Nézd meg a /Library/Application Support/Breaker mappát.',
  busy: 'Épp fut egy másik telepítés vagy frissítés. Próbáld újra pár perc múlva.',
  macos: 'A védelemhez macOS 13.5 vagy újabb kell (ingyenes: Rendszerbeállítások › Általános › Szoftverfrissítés).',
  space: 'Nincs elég szabad hely a telepítéshez (legalább 400 MB kell).',
  'need-node': 'A telepítéshez le kell tölteni a Node.js futtatót. Próbáld újra, ha van internet.',
  copy: 'A telepítő nem tudta beolvasni a fájlokat. Próbáld újra.',
  verify: 'A telepítendő fájlok nem egyeznek a várttal (sérült vagy módosított letöltés). Töltsd le újra az appot.',
  codesign: 'A Node.js futtató aláírása nem a Node.js Foundationé. A telepítés megállt.',
  selfcheck: 'A háttérszolgáltatás próbaindítása nem sikerült. A telepítés megállt, semmi nem változott.',
  guard: 'A védelem őrét nem sikerült elindítani; a gép következő indításakor elindul. A háttérszolgáltatáshoz nem nyúltunk.',
  plist: 'A háttérszolgáltatás leírója hibás lett. Visszaálltunk az előzőre.',
  bootstrap: 'A háttérszolgáltatást nem sikerült elindítani. Visszaálltunk az előzőre.',
  health: 'Az új háttérszolgáltatás nem jelentkezett. Visszaálltunk az előzőre.',
  interrupted: 'A telepítés megszakadt. Visszaálltunk az előzőre.',
  restore: 'A telepítés nem sikerült, és az előző háttérszolgáltatást sem sikerült most újraindítani; a gép következő indításakor elindul.',
  fail: 'A telepítés váratlan hibán állt meg.',
};

/** A hibakimenetből a jel mondata (az utolsó BRK sor dönt); null, ha nincs jel. */
export function macInstallError(output: string): string | null {
  const tokens = [...output.matchAll(/BRK:([a-z-]+)/g)].map((m) => m[1]);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];
  return MAC_INSTALL_ERRORS[last] ?? MAC_INSTALL_ERRORS.fail;
}
