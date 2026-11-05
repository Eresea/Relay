# Android release

Relay's Android build is a Tauri mobile target. The generated Android Studio
project under `src-tauri/gen/android` is ignored and recreated by CI.

Local setup and unsigned builds:

```text
npm run android:init
npm run android:build -- --debug --target aarch64 --apk
```

Releases ship one signed arm64 APK for sideloading, with no AAB and no other
architecture. The release workflow expects these GitHub secrets:

- `ANDROID_KEY_BASE64` — base64-encoded upload keystore
- `ANDROID_KEY_ALIAS` — upload key alias
- `ANDROID_KEY_PASSWORD` — keystore/key password

The mobile dashboard checks the latest GitHub release and opens its signed APK
for Android's package installer. Android still requires the user's final
install confirmation; Tauri's built-in updater remains desktop-only.
