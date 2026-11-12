// Android Gradle Plugin 9 compiles Kotlin itself (built-in Kotlin), so no separate Kotlin plugin.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.2.1")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}
