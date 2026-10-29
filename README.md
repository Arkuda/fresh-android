# fresh-android

Android development workflows for [Fresh](https://getfresh.dev/): Gradle application variants, explicit device selection, build/install/launch, emulators, SDK tools, live Logcat, automatic Kotlin/Java LSP setup and **Find Usages with Ctrl+Enter / Cmd+Enter**. Runs in Fresh's QuickJS plugin runtime; Node.js is **not** required to use the plugin.

## Requirements

- Fresh with the plugin API shipped in **0.5.4**, including plugin configuration, LSP registration, filesystem and native scratch-storage APIs.
- Android SDK: `platform-tools` for ADB, `emulator` for AVDs, `cmdline-tools` for SDK/AVD management. Install system images before creating an AVD.
- A suitable JDK for your Android Gradle Plugin and a working Gradle wrapper (`gradlew` / `gradlew.bat`), including for language-server project import.
- Optional: `scrcpy` on PATH for mirroring.
- For Find Usages: Fresh's bundled Find References plugin. Kotlin/Java servers can be detected and installed through **Android: Setup LSP**; language servers are not needed for build/device commands.

The implementation handles Windows batch wrappers and Unix executables separately. It does not require `sh`, `sed`, `find`, `pkill`, or the unrelated `android` CLI. Local Windows runtime smoke verification is described below; macOS/Linux have not been runtime-tested here.

Automatic server installation additionally uses `curl` and archive/checksum tools: native `tar.exe` and `certutil.exe` on Windows; `tar`, `sha256sum`, `chmod` on Linux; `tar`, `unzip`, `shasum`, `chmod` on macOS. Downloads are streamed to disk because Fresh's HTTP bridge has a 64 MiB body limit.

## Installation

Use Fresh's package manager command **Install from URL**, enter this repository URL, then restart Fresh. The package entrypoint is `plugins/android.ts`; imported helpers live in `plugins/lib/` so they are not loaded as standalone plugins.

For development, open the saved `plugins/android.ts` and run **Load Plugin from Buffer** (the command may be translated in your locale). Reload it after saving changes. Imports require a saved file.

## First run

1. Open your Android project, then run **Android: Doctor**.
2. If SDK discovery selected the wrong installation, set `sdkPath` on this plugin's page in Fresh Settings. Doctor shows the selected path and actual tool output, including missing tools and Java failures.
3. Trust the workspace before executing its Gradle wrapper or starting language-server setup.
4. Run **Android: Select Build Variant** and select an application module/variant, e.g. `:app · demoDebug`.
5. Run **Android: Select Device**, or start an AVD with **Android: Emulator**, wait for Android to boot, then select its device.
6. Run **Android: Run**. Open **Android: Logcat** separately when needed.

**Android: Menu** is the searchable entrypoint for all actions. Commands that require values prompt for them; command-palette arguments are not required. Escape cancels a picker without performing its action.

Open a Kotlin/Java source file to trigger [automatic language-server setup](#language-server-setup), or run **Android: Setup LSP** explicitly. After updating an installed copy of this plugin, reload it or restart Fresh.

## Find usages

Place the caret on a symbol, then use the shortcut for your platform:

| Platform | Shortcut |
| --- | --- |
| Windows / Linux | **Ctrl+Enter** |
| macOS | **Cmd+Enter** |

Both shortcuts invoke Fresh's native **Find References** action. Results are semantic LSP references, not matching text: an unrelated local symbol with the same name is not a usage of the selected symbol.

In the result list, use **↑ / ↓** to select a location and **Enter** to open its file at the symbol. **Escape** dismisses the list. The shortcut itself does not insert a new line into the source.

### Language server setup

1. Open a Kotlin/Java file in a **trusted local workspace**. With `autoSetupLsp` enabled, the plugin checks open source files after activation and file-open events.
2. Existing explicit Fresh `lsp.kotlin` / `lsp.java` settings are preserved, including disabled entries and multi-server configurations. The global LSP disable switch is respected. A missing executable in an explicit user configuration is reported rather than silently replaced.
3. For an unconfigured language, the plugin checks its path override, standard environment variables, PATH and completed managed installations. Java setup probes JDKs from `lspJavaHome`, `JAVA_HOME`, `JDK_HOME`, PATH and common installation directories.
4. Missing components are offered for download. The confirmation shows the official source, version, license information, archive URL, SHA-256 and destination. **Cancel/Escape does not download or register a substitute.**
5. A detected or installed server is registered with auto-start. Existing open buffers are attached through Fresh's restart/reopen mechanism. Wait for the native LSP status to report readiness and for project import/indexing to finish.
6. Keep Fresh's bundled **Find References** plugin enabled; it provides the result UI. Ctrl+Enter/Cmd+Enter also work in other LSP-supported languages.

Run **Android: Setup LSP** to choose Kotlin, Java or both and repeat discovery after cancellation or a failed setup. Automatic attempts are limited to once per language/project per plugin session; changing trust/settings or invoking the command permits another attempt. `autoSetupLsp=false` disables automatic attempts, not the explicit setup command.

#### Managed components

| Component | Pinned release | Purpose |
| --- | --- | --- |
| [Official Kotlin LSP](https://github.com/Kotlin/kotlin-lsp/releases/tag/kotlin-lsp%2Fv263.7084.0) | `263.7084.0` | Kotlin server with its platform launcher and bundled runtime |
| [Eclipse JDT LS](https://download.eclipse.org/jdtls/milestones/1.63.0/) | `1.63.0` | Java language server |
| [Eclipse Temurin JDK](https://github.com/adoptium/temurin25-binaries/releases/tag/jdk-25.0.5%2B8) | `25.0.5+8` | Portable Java-server JDK, offered only if no working JDK 25+ is found |
| [Microsoft OpenJDK](https://learn.microsoft.com/en-us/java/openjdk/download) | `25.0.5.0.2` | Native Windows ARM64 JDK; Temurin 25 does not publish this platform |

Archives come directly from their publishers, not from this repository. The installer supports Windows/Linux/macOS on x64 and ARM64 using platform-specific releases. Downloads can be several hundred megabytes. Pinned SHA-256 is verified before extraction; unsafe archive member paths are rejected. A completion marker is published only after payload validation, and concurrent installs use separate immutable payload directories.

Managed files live under `<Fresh data directory>/fresh-android/lsp/`. No global PATH/JAVA_HOME or user `config.json` is changed. The portable JDK is for **the Java server**, not an automatic replacement for your Android project's Gradle JDK. The pinned JDT LS build requires Java 25. Server caches live under `<Fresh data directory>/fresh-android/workspaces/<workspace-key>/`; the full project identity is checked before reuse. JDT LS has private configuration/data directories; the current native Kotlin launcher receives a private cache and `--data-sharing=none`.

Setup rechecks workspace trust and configuration after asynchronous work and before registration. SSH/container authorities are not auto-installed: configure the language server on that authority through Fresh. No download/update runs in the background without confirmation. Managed versions change with plugin updates; an alpha Kotlin build may require updating the plugin when upstream expires that build.

Equinox's legacy URL handling makes literal `%` unsafe in Fresh's data-directory path. Automatic Java setup refuses that layout rather than using unintended shared parent caches; configure Java LSP explicitly in Fresh with safe configuration/data paths in that case.

**Android: Doctor** reports configuration ownership, selected server launch details, JDK discovery failures and the last reported server error. “Registered” means Fresh was asked to start the server, not that indexing succeeded.

Kotlin LSP is Alpha and its Android Gradle import is experimental; JDT LS also describes Android import as experimental. Registration cannot guarantee Android Studio-equivalent project analysis.

### Shortcut behavior and troubleshooting

- Other custom shortcuts are retained. Existing normal-mode Ctrl+Enter/Cmd+Enter bindings are overridden while this plugin is loaded.
- No bindings are saved to `config.json`; unloading the plugin removes its runtime overrides. Reload the plugin after changing custom keybinding configuration.
- If references are unavailable, check **Android: Doctor**, the native language-server status and whether the server supports references for the current project. Run **Android: Setup LSP** to retry. There is no text-search fallback.
- In a terminal, the terminal must transmit Ctrl+Enter/Cmd+Enter distinctly from plain Enter. If it does not, use Fresh's **Find References** action directly or configure a terminal/keyboard protocol that transmits the combination.

## Build and deployment

- Gradle wrapper root is discovered upward from the active file, then from the remembered project/current working directory. `projectRoot` overrides discovery. Output panels do not discard the remembered project.
- Application variants come from Gradle's `install<Variant>` tasks (`tasks --all`), including module-qualified and flavored tasks. AndroidTest and assemble-only library tasks are excluded. Select Build Variant refreshes discovery. Root-only application projects are supported; when module-qualified application tasks exist, root aggregate tasks are omitted.
- **Build** assembles the selected variant. **Install** and **Run** first select a ready device, assemble the APK, then call `adb -s SERIAL install -r APK`. A failed build never installs a stale APK.
- Built artifact selection reads `MODULE/build/outputs/apk/**/output-metadata.json`. The final `applicationId`, including flavor/build-type suffixes, comes from that metadata, **not** `namespace` or a source-manifest guess. Custom APK filenames work. Multiple APK outputs open a picker; choose a standalone APK compatible with the device. Split-APK sets and custom module/build-output directories are not supported.
- Run resolves the installed MAIN/LAUNCHER activity with Android's package manager, then invokes `am start -W -n COMPONENT`. `activity` can override resolution. Launch starts an already installed app without rebuilding.
- Variant and device selections are scoped to the project and kept in memory until plugin reload/editor restart. Unavailable remembered devices are reselected; offline/unauthorized devices are shown but never silently used for deployment.
- Gradle output appears in the reusable **Android Output** buffer when the process finishes; the status bar identifies the running operation. Only one Android action/prompt runs at a time.

## Commands

All names have the `Android: ` prefix.

| Group | Commands |
| --- | --- |
| Entry and diagnostics | Menu, Doctor, Setup LSP |
| Project | Select Build Variant, Build, Install, Run, Launch, Clean, Dependencies, Gradle Tasks, Gradle Task |
| Devices | Devices, Select Device, ADB Shell, Connect Device, Pair Device, Mirror |
| Emulators | Emulator, Stop Emulator, Create AVD, Delete AVD |
| SDK | SDK Packages, Install SDK Package, SDK Licenses |
| App control | Force Stop, Clear Data, Uninstall |
| Logs and capture | Logcat, Logcat Snapshot, Clear Logcat, Stop Logcat, Screenshot |
| Documentation | Docs |

### Devices, SDK and AVDs

Device/SDK/emulator utilities can be used without a Gradle project. Devices shows raw ADB details, including unauthorized/offline devices. Select Device chooses only ready devices. ADB Shell and Mirror reuse the selected device. Connect Device prompts for the connection `host:port`; Pair Device opens an interactive pairing-code terminal. Pairing and connection ports can differ.

SDK discovery order: explicit `sdkPath` → project `local.properties` (`sdk.dir`) → `ANDROID_HOME` → `ANDROID_SDK_ROOT` → standard Windows/Linux/macOS SDK locations. Tools not found inside that SDK fall back to PATH. Command-line tools use `cmdline-tools/latest/bin`, then the highest installed numeric version. On Windows, paths/arguments passed through a batch wrapper may contain spaces, but shell expansion/metacharacters (`" % ! & | < > ^` and newlines) are rejected rather than executed.

Emulator lists AVDs in a picker (one AVD starts directly; the last selection is listed first next time). It starts the emulator in an owned terminal without waiting forever for the emulator process to exit. Boot readiness is not inferred from process creation: wait for Android before deployment. Stop Emulator only offers ready emulator serials and asks for confirmation; it never targets a physical phone.

Create AVD selects an **installed** system image and prompts for a new name. It refuses to overwrite an existing AVD. Complete avdmanager's hardware-profile question in its terminal (usually answer `no`). Install SDK Package accepts one package ID, e.g. `system-images;android-36;google_apis;x86_64`, and leaves license prompts interactive. AVD and SDK operations inherit the editor's environment, including `ANDROID_AVD_HOME` and `JAVA_HOME`.

Delete AVD checks connected emulators and refuses to delete a running or unverifiable selected AVD; deletion requires confirmation. The plugin never globally kills emulator or ADB processes.

### Logcat, screenshots and app control

Logcat prompts for **Selected app** or **Whole device** and streams into a real terminal. App scope resolves the current PID; an app must already be running. Restart Logcat after an app restart/PID change. Whole-device logs do not need an Android project. A second stream replaces the plugin's previous stream for that project; Stop Logcat closes only that terminal, not other `adb logcat` processes. A terminal already open when the plugin is reloaded can be closed manually.

Logcat Snapshot shows at most 1000 recent entries. `logLevel` controls minimum priority. Clear Logcat asks for confirmation because the ring buffers belong to the device, not just this plugin.

Screenshot prompts for a new local PNG path, uses `screencap` on the selected device, pulls the file, and removes only its uniquely named temporary device file. Existing local files are not overwritten. No binary data passes through Fresh's text process-output API.

Clear Data and Uninstall show the application ID and device before confirmation. Force Stop, these app actions, Launch, and app-scoped Logcat normally use the selected variant's existing build metadata; set `applicationId` to override the installed package identity. The app control/Launch commands require a project root, even with an identity override.

Docs displays a URL for an official Android documentation search; it does not depend on a third-party CLI or pretend to provide an embedded browser.

## Settings

Set these fields on the plugin's page under **Plugins** in Fresh Settings. Settings are read for each action; changing them does not require rebuilding the plugin.

| Field | Default | Meaning |
| --- | --- | --- |
| `sdkPath` | empty | Explicit Android SDK root |
| `projectRoot` | empty | Explicit Gradle wrapper directory |
| `applicationId` | empty | Override the installed package identity |
| `activity` | empty | Launcher class, e.g. `.MainActivity`, otherwise resolve on device |
| `logLevel` | `I` | Minimum Logcat priority: `V`, `D`, `I`, `W`, `E`, `F`, `S` |
| `autoSetupLsp` | `true` | Detect/configure LSP when Kotlin/Java sources are open in a trusted local workspace |
| `lspJavaHome` | empty | Explicit working JDK 25+ for Java LSP; invalid explicit paths are reported, not ignored |
| `kotlinLspPath` | empty | Existing Kotlin LSP launcher or extracted distribution directory |
| `javaLspPath` | empty | Existing extracted JDT LS directory with `plugins` and platform configuration |

Gradle Task accepts multiple space-separated tasks/options, e.g. `:app:assembleDebug :app:testDebugUnitTest --offline`. Quotes, whitespace inside an argument, and shell syntax are intentionally unsupported. Dependencies is a Gradle dependency report, **not** Android Studio model sync. The old misleading Sync and global Stop Logcat behavior have been removed.

## Design references and boundaries

The workflow was redesigned with these extensions as references; their VS Code implementation was not copied:

- [pavi2410/android-devkit](https://github.com/pavi2410/android-devkit): explicit device/build selection, SDK/AVD workflows, a central command menu.
- [adelphes/android-dev-ext](https://github.com/adelphes/android-dev-ext): separate deployment/launch stages and installed artifact identity rather than source namespace guesses.
- [Dannark/Android-Launcher-for-VSCode](https://github.com/Dannark/Android-Launcher-for-VSCode): AVD list/select/start/create/delete and reuse of the last selection.

This is not a VS Code API shim. The plugin configures external Kotlin/Java language servers; it does not implement their analyzers. JDWP/DAP debugging, tree/webview panels, Compose/layout previews, device filesystem browsing and docking emulator windows are not implemented. Run launches an app; it is not a debugger.

## Development and verification

Development only: Node.js **22.18+** (native TypeScript stripping) and npm.

```sh
npm install
npm run check
npm test
fresh --cmd script check plugins/android.ts
```

Tests cover Android workflow parsing and failure isolation, LSP configuration ownership/disable precedence, JVM detection and the JDT LS Java 25 boundary, cancellation, trust revocation, download/checksum failures, unsafe archive paths, completion-marker boundaries and file-open events arriving during automatic setup. Workflow/installer fault tests use isolated editor/tool fixtures; they do not prove a real Android build/deployment.

Runtime smoke exercised Fresh 0.5.4 on Windows: actual plugin loading, registered commands, menu filtering/confirmation, Doctor with installed ADB/emulator tools, refusal to proceed without a ready device, and invocation of a disposable `.bat` wrapper in a directory containing spaces. No Android device was connected, so real APK installation/launch, emulator boot, device capture and streaming Logcat were not runtime-verified in this change.

Navigation smoke used a real TypeScript language server in Fresh 0.5.4: both Ctrl+Enter and Meta+Enter returned three cross-file references, excluded an unrelated same-named local symbol, and left source text unchanged. Meta was sent through Fresh's web keyboard path on Windows; a physical macOS terminal was not exercised.

LSP setup smoke downloaded and verified the pinned Kotlin, JDT LS and Temurin 25 archives, reused completed installs without redownloading, and exercised automatic file-open registration and Doctor in Fresh 0.5.4 on Windows x64. Real Kotlin and Java servers returned a declaration and its call through Ctrl+Enter in a disposable Maven project; Kotlin project import used an isolated Maven 3.9.16 installation. Server installation does not install Gradle/Maven or project dependencies. Android Gradle import and Linux/macOS/ARM64 runtime behavior were not verified by this smoke.
