// A mérés előtér-szondájának „kap-e egyáltalán adatot” állapota.
//
// Külön modul, mert a tracker.ts az electronra hivatkozik (powerMonitor), tehát
// node:test alól nem tölthető be — ez a rész viszont tiszta logika, és pont
// olyan, amit tesztelni akarunk.

// ----------------------------------------------------------- probe health

/**
 * Meddig tűrjük, hogy az előtér-szonda semmit ne lásson, mielőtt szólunk.
 *
 * macOS-en az első lekérdezés MAGA hozza fel az engedélykérő ablakot, és amíg
 * a felhasználó nem válaszol, az osascript vár — vagyis pár üres minta a
 * legnormálisabb dolog a világon. Windowson a szonda-folyamat első sora is
 * késik pár másodpercet. Ezért nem az első hiba számít, hanem a sorozat.
 */
export const PROBE_FAIL_THRESHOLD = 3;

/**
 * „Kap-e egyáltalán adatot a mérés?”
 *
 * Ez azért kell, mert a szonda csendben hasal el: ha a felhasználó megtagadja
 * az engedélyt, az osascript hibázik, a minta elmarad, és a statisztika örökre
 * üres marad — magyarázat nélkül. A napi keret ilyenkor SOSEM fogyna el, tehát
 * a felhasználó azt hinné, hogy védi valami, közben semmi. Inkább kimondjuk.
 */
export class ProbeHealth {
  private fails = 0;
  private everSucceeded = false;

  record(ok: boolean): void {
    if (ok) {
      this.fails = 0;
      this.everSucceeded = true;
      return;
    }
    if (this.fails < PROBE_FAIL_THRESHOLD) this.fails += 1;
  }

  /** Sorozatban ennyiszer nem látott semmit → valószínűleg engedély hiányzik. */
  get blocked(): boolean {
    return this.fails >= PROBE_FAIL_THRESHOLD;
  }

  /** Igaz, ha a szonda MÉG SOHA nem látott semmit — az első indítás esete. */
  get neverWorked(): boolean {
    return !this.everSucceeded;
  }
}
