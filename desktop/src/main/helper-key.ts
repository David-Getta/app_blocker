// Az app KULCSA a Windows-segédhez (lásd shared/client-key.ts).
//
// Az app adatkönyvtárában él (Windowson %APPDATA%\Breaker): a felhasználó
// profilja, amit más felhasználó nem olvas. A segéd csak a lenyomatát kapja
// meg, a telepítéskor. Ha a fájl elvész (újratelepített profil), a következő
// telepítés újat ír — a régi lenyomatú segéd addig szóba sem áll, és ezt a
// felület ki is mondja.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { isClientKey, newClientKey } from '../shared/client-key';

export function helperKeyPath(): string {
  return path.join(app.getPath('userData'), 'helper-key');
}

/** A meglévő kulcs, vagy null (nincs, vagy nem kulcs alakú). */
export function readHelperKey(): string | null {
  try {
    const key = fs.readFileSync(helperKeyPath(), 'utf8').trim();
    return isClientKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** A kulcs — ha még nincs, most születik. A telepítő hívja. */
export function ensureHelperKey(): string {
  const existing = readHelperKey();
  if (existing !== null) return existing;
  const key = newClientKey();
  fs.mkdirSync(path.dirname(helperKeyPath()), { recursive: true });
  fs.writeFileSync(helperKeyPath(), `${key}\n`, { mode: 0o600 });
  return key;
}
