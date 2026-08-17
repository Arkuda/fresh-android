# fresh-android

Android development workflow plugin for [Fresh IDE](https://getfresh.dev/), inspired by [`rizukirr/droid-nvim`](https://github.com/rizukirr/droid-nvim).

The plugin ports the core Android workflow commands from Neovim/Lua to Fresh's TypeScript plugin runtime: Gradle build/install/run, device and emulator helpers, logcat, screenshots, scrcpy mirroring, and Android CLI docs lookup.

## Requirements

- Fresh IDE with TypeScript plugin support.
- Android SDK tools on `PATH` (`adb`, `emulator`, and optionally `android`).
- A Gradle Android project with `./gradlew` in the workspace root.
- Optional: `scrcpy` for device mirroring.

## Installation

Install this repository with Fresh's package manager:

1. Open the command palette.
2. Run `pkg: Install from URL`.
3. Enter this repository URL.
4. Restart Fresh.

Fresh packages are described by `package.json`; this plugin registers `plugins/android.ts` as the package entrypoint.

## Commands

| Fresh command | What it does |
| --- | --- |
| `Android: Run` | Build, install, launch the app, then open logcat. |
| `Android: Build` | Run `./gradlew assemble<Variant>`. Defaults to `debug`. |
| `Android: Install` | Run `./gradlew install<Variant>`. Defaults to `debug`. |
| `Android: Clean` | Run `./gradlew clean`. |
| `Android: Sync` | Run `./gradlew dependencies`. |
| `Android: Gradle Task` | Run an arbitrary Gradle task passed as command arguments. |
| `Android: Devices` | Show `adb devices -l` output in a Fresh buffer when supported. |
| `Android: Emulator` | List AVDs, or start a named AVD if a name is supplied. Uses `android emulator` when available. |
| `Android: Stop Emulator` | Stop the active emulator through `adb emu kill`. |
| `Android: Mirror` | Launch `scrcpy` for the first connected device. |
| `Android: Clear Data` | Clear data for the detected app package. |
| `Android: Force Stop` | Force-stop the detected app package. |
| `Android: Uninstall` | Uninstall the detected app package. |
| `Android: Logcat` | Open `adb logcat`, optionally filtered by the detected package and a log level. |
| `Android: Clear Logcat` | Clear the logcat ring buffer. |
| `Android: Stop Logcat` | Stop running `adb logcat` processes. |
| `Android: Screenshot` | Capture a screenshot via `android screenshot` or `adb exec-out screencap`. |
| `Android: Docs` | Search Android CLI docs with `android docs <query>`. |

## Notes

Fresh plugins run in a QuickJS sandbox and interact with the editor through the `editor` API. This port therefore focuses on workflow commands that can be represented as external process invocations. Neovim-specific features from `droid-nvim` such as buffer-local LSP setup, Treesitter integrations, and Vim keymaps are intentionally not copied directly.
