plugins {
    // 8.13: az utolsó 8-as AGP, ami a 36-os API-t ismeri (a Google Play 2026.
    // augusztus 31. óta csak API 36-ra célzó frissítést fogad). A 9-es sorozat
    // beépített Kotlinnal és új DSL-lel jön — az külön lépés.
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.0.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.20" apply false
}
