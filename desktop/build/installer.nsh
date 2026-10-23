; A Breaker saját eltávolító-lépése (electron-builder: customUnInstall).
;
; Az Electron 41 óta az app az első értesítéskor a felhasználó SAJÁT Start
; menüjébe is tesz egy Breaker parancsikont, és a HKCU alá bejegyzi az
; értesítés kattintását fogadó COM-osztályt. Az osztály azonosítója rögzített
; (src/shared/app-id.ts, TOAST_ACTIVATOR_CLSID; egy teszt őrzi, hogy ez
; ugyanaz). A gépszintű telepítés eltávolítója ezekről magától nem tud: a
; parancsikon a törölt exe-re mutatva a Start menüben maradna.
;
; Frissítéskor a régi verzió eltávolítója a --updated kapcsolóval fut: akkor
; nem nyúlunk hozzájuk, az új verzió ugyanezeket használja.
;
; KORLÁT: az emelt eltávolító jelenlegi felhasználója az, aki a rendszergazdai
; jóváhagyást adta. Ha egy sima felhasználó egy másik fiók jelszavával hagyta
; jóvá, az ő profilját ez nem éri el, és a többi profilt sem; azokat a kézi
; eltávolító (scripts/uninstall-windows.ps1) végigjárja.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    DeleteRegKey HKCU "Software\Classes\CLSID\{E34DF69A-9041-4581-B6D2-54E40EEB0A50}"
    ; A sablon további lépései (a gépszintű Start menü, az eltávolítás
    ; bejegyzése a HKLM alatt) a gépszintű kontextusban futnak: vissza oda,
    ; különben a Gépház listájában ott maradna a Breaker.
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  ${endIf}
!macroend

; AZ ŐR (#149): a segéd mellé telepített őr (BreakerGuard feladat, a
; „Breaker Guard” mappa a 64 bites Program Files alatt) az app törlése után is
; tart — ha az app nincs meg, a teljes lista tilt. Ez szándékos: az app
; eltávolítása nem lehet ingyenes lazítás. Ezért ez az eltávolító a feladatokhoz
; és a hosts fájlhoz NEM nyúl; csak kimondja, mi marad, és hol a teljes
; eltávolító. Frissítéskor (--updated) és csendes módban nem kérdez.
!macro customUnInit
  ${ifNot} ${isUpdated}
    ${if} ${FileExists} "$PROGRAMFILES64\Breaker Guard\uninstall-windows.ps1"
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "A Breaker védelme az app eltávolítása után is megmarad: ha az app nincs meg, a teljes lista tiltva lesz (néhány perc múlva).$\r$\n$\r$\nHa a védelmet is le akarod venni, futtasd rendszergazdaként:$\r$\npowershell -ExecutionPolicy Bypass -File $\"$PROGRAMFILES64\Breaker Guard\uninstall-windows.ps1$\"$\r$\n$\r$\nFolytatod az app eltávolítását?" /SD IDOK IDOK protectionNoticeOk
      Quit
      protectionNoticeOk:
    ${endIf}
  ${endIf}
!macroend
