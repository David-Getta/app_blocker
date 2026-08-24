# Breaker szinkron-kiszolgáló

Ez a szolgáltatás **egy dolgot csinál**: verziózott, **titkosított** blobokat
tárol fiókonként. Nem tudja, mi van bennük, és nem is kell tudnia — a
blokklista és a mért idők a kliensen titkosítódnak
(`desktop/src/shared/sync/crypto.ts`).

Ezért **nem is kell megbízni benne**. Aki futtatja, csak átlátszatlan bájtokat
lát; ha hozzányúlna, a GCM-címke miatt a visszafejtés elhasalna a te gépeden.

Nincs függősége: se `npm install`, se natív fordítás, se adatbázis.

## Indítás

```bash
cd server
node server.js
# Breaker szinkron-kiszolgáló: http://0.0.0.0:8787 (tár: ./data)
```

Beállítások környezeti változóval:

| Változó | Alap | Mit csinál |
|---|---|---|
| `PORT` | `8787` | melyik porton hallgat |
| `BREAKER_SYNC_DIR` | `./data` | hova kerül az adat |
| `BREAKER_OPEN_SIGNUP` | `1` | `0` esetén új fiók nem regisztrálható |

Ha csak magadnak futtatod, érdemes az első fiók létrehozása után
`BREAKER_OPEN_SIGNUP=0`-val újraindítani: onnantól a címet ismerve sem tud
senki fiókot nyitni nálad.

## A leggyorsabb út: az ASZTALI APPBÓL

Ehhez nem kell se terminál, se Node: az asztali Breakerben a „Fiók és eszközök”
kártyán ott a **Kiszolgáló indítása ezen a gépen** gomb. Elindítja, és kiírja
azt a címet, amit a telefonba be kell gépelni.

Egy dolgot ki is mond: **amíg az az app nem fut (vagy a gép alszik), nincs
szinkron.** Semmi nem vész el — a következő elérésnél összefésül —, de a telefon
addig a legutóbbi állapotot mutatja.

A beépített kiszolgáló **magától bezárja a regisztrációt**, amint van egy fiók:
onnantól a hálózaton más nem tud fiókot nyitni rajta. A bejelentkezés persze
továbbra is megy — épp az kell a többi eszközhöz.

Ha külön, folyamatosan futó kiszolgálót akarsz, onnantól ez a doksi szól róla.

## Kézzel: a saját gépeden, a saját hálózatodon

Ugyanaz, csak terminálból:

```bash
cd server && node server.js
```

Kell a gép helyi IP-címe:

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I | awk '{print $1}'
```

Az appban a kiszolgáló címe ekkor `http://192.168.x.y:8787` (a saját címeddel).
A gépen `http://127.0.0.1:8787` is jó.

Amit tudni érdemes:

- **Amíg a gép alszik, nincs szinkron.** A telefon ilyenkor a legutóbbi
  állapotot mutatja, és a fiókkártyán látszik, mikor volt utoljára szinkron.
  Semmi nem vész el: a következő elérésnél összefésül.
- A helyi hálózaton belül a **belépőkulcs titkosítatlanul utazik** — a tartalom
  nem, az a kliensen titkosítódik. Otthoni hálózaton ez általában elfogadható;
  ha nem az, tegyél elé HTTPS-t (lentebb). Az appok emiatt csak a HELYI
  hálózatra engedik a titkosítatlan kapcsolatot: iPhone-on az
  `NSAllowsLocalNetworking`, Androidon egy külön hálózati beállítás — az
  internet felé mindkettő HTTPS-t vár.
- Ha a telefon nem éri el, szinte mindig a gép **tűzfala** az ok: a 8787-es
  portra be kell engedni a bejövő kapcsolatot.

## Dockerrel

```bash
docker build -t breaker-sync ./server
docker run -d --name breaker-sync -p 8787:8787 -v breaker-data:/data breaker-sync
```

## HTTPS

A kiszolgáló **sima HTTP-t** beszél, és ez szándékos: a tartalom már titkosítva
érkezik, a tanúsítványkezelést pedig sokkal jobban csinálja egy elé tett Caddy,
nginx vagy egy felhőszolgáltató.

Ettől még **tegyél elé HTTPS-t**, ha nem csak a saját hálózatodon éred el. Nem a
tartalom miatt — azt úgysem látja senki —, hanem mert a *belépőkulcs* nyílt
HTTP-n utazna, és azzal be lehetne lépni a fiókodba (olvasni nem tudná, de
felülírni igen). Caddyvel ez egy sor:

```
sync.pelda.hu {
    reverse_proxy 127.0.0.1:8787
}
```

## Végpontok

Mind `POST`, JSON be és ki. A `GET /health` az egyetlen kivétel.

| Végpont | Mit csinál |
|---|---|
| `/v1/signup` | fiók létrehozása (csak burkolt kulcsokat kap) |
| `/v1/signin` | a burkolt kulcsok és az eszközlista visszaadása |
| `/v1/rekey` | jelszócsere — csak a csomagolás változik, az adat nem |
| `/v1/pull` | egy gyűjtemény lekérése (`sites` vagy `usage`) |
| `/v1/push` | feltöltés `baseVersion`-nel; ütközésnél 409 + az aktuális tartalom |
| `/v1/usage-all` | minden eszköz mérése egy körben |
| `/v1/forget-device` | eszköz kivétele a fiókból |

### Az ütközés nem hiba, hanem a lényeg

A `/v1/push` megmondja, MELYIK verzióra épül. Ha közben más eszköz írt, a
kiszolgáló **elutasítja**, és visszaadja az aktuálisat. A kliens ekkor
összefésül (`shared/sync/merge.ts`), és újra próbálkozik.

Enélkül két eszköz párhuzamos írása csendben eltüntetné az egyikét — és pont ez
a legrosszabb, ami egy blokklistával történhet.

## Korlátok

| Mi | Mennyi | Miért |
|---|---|---|
| egy blob mérete | 1 MB | a kiszolgáló nem látja, mit tárol, tehát nem tud „ésszerű” méretet mérlegelni sem |
| egy kérés törzse | 2 MB | a korlát a KAPCSOLATON van, nem a JSON-on: enélkül egy végtelen kérés a memóriát enné |
| eszköz egy fiókban | 20 | eszközönként külön mérés-blob tárolódik; azonosítókat gyártva egy fiók korlátlanul enné a lemezt |

A huszadik eszköz felett a **legrégebben látott** esik ki a listából, nem az,
aki épp bejelentkezik. A kiesés csak a listázást érinti: a helyi blokkokhoz a
kiszolgáló amúgy sem fér hozzá.

## Amit a kiszolgáló SOSEM tesz

- **Nem old fel semmit.** Egy eszköz eltávolítása a fiókból csak a szinkronból
  veszi ki; az adott gépen a blokkok érintetlenek maradnak. Különben az „eszköz
  eltávolítása” lenne a világ legegyszerűbb feloldása.
- **Nem tudja megmondani, mi van blokkolva.** A tartalom titkosítva érkezik.
- **Nem mondja meg, van-e ilyen fiók.** Nem létező fiókra és rossz kulcsra
  ugyanaz a válasz jön.

## Tesztek

```bash
cd server && npm test
```

A tesztek a **valódi HTTP-n** keresztül mennek, és arra a három állításra
figyelnek, amin az egész áll: hitelesítés nélkül semmi nem jön ki, a párhuzamos
írás nem tüntet el adatot, és a kiszolgáló egyetlen művelete sem lazít a
blokkoláson.
