// Az app azonosítója — egy helyen, mert három rendszer is ehhez köti.
//
// A telepítő (electron-builder.yml `appId`) ezzel jelöli a csomagot: macOS-en
// ez a bundle-azonosító és az aláírásé (a füstpróba nézi), Windowson a Start
// menü parancsikonjának AppUserModelID-je. A futó appnak Windowson ugyanezt
// kell mondania (`app.setAppUserModelId`): az Electron magától
// „electron.app.Breaker”-t mondana, és akkor a Windows az értesítéseket nem
// kötné a telepített apphoz — se a nevét, se az ikonját nem kapnák, a Gépház
// értesítési listáján sem „Breaker” néven állna (pont ott, ahova a beállítások
// lapja küldi a felhasználót), és a tálcán a futó app külön ikont kapna a
// kitűzött mellett. Egy teszt őrzi, hogy a kettő ugyanaz maradjon.
export const APP_ID = 'hu.breaker.app';
