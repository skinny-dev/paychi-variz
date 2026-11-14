plugins {
    id("com.android.application")
}

android {
    namespace = "app.paychi.listener"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.paychi.listener"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // Material Design 3 components (brings in AppCompat).
    implementation("com.google.android.material:material:1.12.0")
    // QR scanner (ZXing, works without Google Play services).
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
