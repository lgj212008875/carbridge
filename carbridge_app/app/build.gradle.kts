plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.carbridge.agent"
    compileSdk = 34

    defaultConfig {
        minSdk = 21
        targetSdk = 34
        versionCode = 3
    }

    flavorDimensions += "app"

    productFlavors {
        create("caragent") {
            dimension = "app"
            applicationId = "com.carbridge.agent"
            versionName = "6.25.1"
        }
        create("obdrelay") {
            dimension = "app"
            applicationId = "com.carbridge.obd"
            versionName = "2.9.0"
        }
    }

    sourceSets {
        getByName("caragent") {
            java.srcDirs("src/caragent/java")
            res.srcDirs("src/caragent/res")
            manifest.srcFile("src/caragent/AndroidManifest.xml")
        }
        getByName("obdrelay") {
            java.srcDirs("src/obdrelay/java")
            res.srcDirs("src/obdrelay/res")
            manifest.srcFile("src/obdrelay/AndroidManifest.xml")
        }
    }

    signingConfigs {
        create("release") {
            storeFile = file("YOUR_KEYSTORE_PATH/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            versionNameSuffix = "-dev"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.preference:preference-ktx:1.2.1")
}
