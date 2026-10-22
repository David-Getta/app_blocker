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
