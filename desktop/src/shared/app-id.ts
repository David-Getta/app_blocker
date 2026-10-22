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

// A Windows-értesítés kattintását fogadó COM-osztály azonosítója. Az Electron
// 41 óta az első értesítéskor az app a felhasználó saját Start menüjébe is tesz
// egy „Breaker” parancsikont (ezzel az azonosítóval), és a HKCU alá bejegyzi az
// osztályt. Magától véletlen azonosítót választana — azt az eltávolító nem
// tudná megnevezni. Ezért rögzített; az eltávolító (build/installer.nsh) és a
// kézi eltávolító (scripts/uninstall-windows.ps1) ugyanezt veszi le, és egy
// teszt őrzi, hogy a három ugyanaz maradjon. SOHA NE VÁLTOZZON: a meglévő
// parancsikonokban ez áll.
export const TOAST_ACTIVATOR_CLSID = '{E34DF69A-9041-4581-B6D2-54E40EEB0A50}';
