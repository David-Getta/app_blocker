// A mérés MÁSIK csendes elhasalása: a szonda lát, csak a mért idő nem jut el
// a tárolóig.
//
// A `ProbeHealth` azt fogja meg, ha az előtér-szonda nem kap adatot. Van
// azonban egy réteggel lejjebb egy ugyanolyan néma hiba, amit eddig SEMMI nem
// nézett: a minta elkészül, a segéd átveszi a kérést — és egyetlen sort sem
// rögzít belőle. A segéd minden mintát ellenőriz (kulcs alakja, hossz,
// időbélyeg a mai naptól legfeljebb egy hétre), és amit nem fogad el, azt
// szó nélkül eldobja. A válasz ettől még `ok: true`, benne a rögzítettek
// számával — csakhogy azt a számot eddig senki nem olvasta el.
//
// A következmény pontosan az, ami ellen a szonda-figyelmeztetés készült: a
// statisztika örökre nulla marad, a napi keret SOSEM fogy el, és a felület
// védelmet mutat ott, ahol nincs. Csak épp egy réteggel lejjebb, ahol a másik
// figyelmeztetés nem lát.
//
// Külön modul és külön tesztek, mert a `tracker.ts` az electronra hivatkozik,
// tehát `node:test` alól nem tölthető be — ez a rész viszont tiszta logika.

/**
 * Hány egymást követő küldés után szólunk. A küldés harmincmásodpercenként
 * fut, tehát ez másfél perc — elég ahhoz, hogy egy pillanatnyi zavar ne
 * riasszon, és elég rövid ahhoz, hogy ne egy elveszett nap végén derüljön ki.
 */
export const DELIVERY_FAIL_THRESHOLD = 3;

/** Egy küldés kimenetele. */
export interface DeliveryOutcome {
  /** eljutott-e egyáltalán a segédhez */
  delivered: boolean;
  /** ebből hány mintát rögzített ténylegesen */
  recorded: number;
  /** hány mintát küldtünk */
  sent: number;
}

export class DeliveryHealth {
  private unreachable = 0;
  private discarded = 0;

  record(o: DeliveryOutcome): void {
    if (!o.delivered) {
      // A segéd elérhetetlensége NEM adatvesztés: a puffer megtartja a
      // mintákat, és a következő kör újrapróbálja. Csak ha tartósan így
      // marad, akkor lesz belőle veszteség.
      if (this.unreachable < DELIVERY_FAIL_THRESHOLD) this.unreachable += 1;
      return;
    }
    this.unreachable = 0;
    // Kézbesítve, de SEMMI nem lett belőle. Ez a veszélyes eset: a puffer
    // ilyenkor kiürül, tehát a mért idő végleg elveszett.
    if (o.sent > 0 && o.recorded === 0) {
      if (this.discarded < DELIVERY_FAIL_THRESHOLD) this.discarded += 1;
    } else {
      this.discarded = 0;
    }
  }

  /** Sorozatban átvette, de egyetlen mintát sem rögzített: az idő elveszik. */
  get dropping(): boolean { return this.discarded >= DELIVERY_FAIL_THRESHOLD; }

  /** Sorozatban el sem érte a segédet. A puffer még őrzi, de nem sokáig. */
  get stuck(): boolean { return this.unreachable >= DELIVERY_FAIL_THRESHOLD; }
}
