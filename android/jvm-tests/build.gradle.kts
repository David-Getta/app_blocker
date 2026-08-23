// JVM test harness for the Android app's platform-independent code.
//
// The core logic (blocklist, challenge engine, schedules, usage aggregation,
// referee, store JSON, usage tracker) barely touches Android — only Context,
// SharedPreferences and a handful of system services. Those are stubbed in
// src/stubs, so the REAL production sources compile and run here on a plain
// JVM. That means this logic can be tested in CI without an Android SDK, and
// it catches type errors in files the Compose UI build would otherwise be the
// only thing to check.
//
// Run: ./gradlew test    (from android/jvm-tests)

plugins {
    kotlin("jvm") version "2.0.20"
}

repositories { mavenCentral() }

dependencies {
    implementation("org.json:json:20240303")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.1")
    testImplementation(kotlin("test"))
}

sourceSets {
    main {
        kotlin {
            srcDir("src/stubs/kotlin")
            // The production sources under test, compiled straight from the app
            // module so this harness can never drift from what ships.
            srcDir("../app/src/main/java")
            include(
                "android/**",
                "hu/breaker/app/core/**",
                "hu/breaker/app/usage/**",
            )
        }
    }
}

// No pinned toolchain on purpose: this harness only needs *a* JDK, and pinning
// one makes it fail on machines that happen to have a different version.

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
