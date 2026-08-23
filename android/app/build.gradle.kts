plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "hu.lakat.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "hu.lakat.app"
        minSdk = 26
        targetSdk = 34
        // A CI a git tagből állítja be (LAKAT_VERSION_*). Helyi buildhez marad a default.
        versionCode = (System.getenv("LAKAT_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("LAKAT_VERSION_NAME") ?: "0.1.0"
    }

    // Kiadási aláírás env-ből (CI secret). Ha nincs, a debug kulcsra esik vissza,
    // hogy a közvetlen terjesztésű APK mindig telepíthető és konzisztens legyen.
    // Éles Play Store-hoz állítsd be a saját feltöltési kulcsod (docs/releasing.md).
    // A kulcs MEGLÉTE dönt, nem a változó létezése: a CI mindig beállítja a
    // LAKAT_KEYSTORE-t, csak épp üres sztringre, ha nincs secret. A régi
    // `!= null` vizsgálat emiatt a release configot választotta storeFile
    // nélkül, és a packageRelease „Keystore file not set" hibával elhasalt —
    // vagyis az első kiadás sosem készült volna el.
    val keystorePath = System.getenv("LAKAT_KEYSTORE")?.takeIf { it.isNotBlank() }
    val keystoreFile = keystorePath?.let { file(it) }?.takeIf { it.exists() }

    signingConfigs {
        create("release") {
            if (keystoreFile != null) {
                storeFile = keystoreFile
                storePassword = System.getenv("LAKAT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LAKAT_KEY_ALIAS")
                keyPassword = System.getenv("LAKAT_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (keystoreFile != null) {
                signingConfigs.getByName("release")
            } else {
                // Debug kulcs: telepíthető APK a közvetlen terjesztéshez. Play
                // Store-hoz saját feltöltési kulcs kell (docs/releasing.md).
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.09.02"))
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
