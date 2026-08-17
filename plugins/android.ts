/// <reference path="../types/fresh.d.ts" />

// Android workflow plugin for Fresh IDE.
// Ported from the command surface of droid.nvim: Gradle build/install/run,
// device helpers, emulator helpers, logcat, scrcpy mirroring, screenshots,
// and Android CLI docs lookup.

type SpawnResult = FreshSpawnResult;

type AndroidConfig = {
  androidHome?: string;
  androidAvdHome?: string;
  androidCli?: "auto" | "always" | "never";
  variant?: string;
  packageName?: string;
  logLevel?: string;
};

const state: {
  config: AndroidConfig;
  logcatRunning: boolean;
} = {
  config: {
    androidCli: "auto",
    variant: "debug",
    logLevel: "V",
  },
  logcatRunning: false,
};

function status(message: string): void {
  editor.setStatus(`[Android] ${message}`);
}

function normalizeVariant(raw?: string): string {
  const value = (raw || state.config.variant || "debug").trim();
  return value.length === 0 ? "debug" : value;
}

function upperFirst(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function gradleCommand(): string {
  return processPlatform() === "win32" ? "gradlew.bat" : "./gradlew";
}

function processPlatform(): string {
  // QuickJS Fresh plugins do not expose Node's process object. Keep this helper
  // isolated so future Fresh runtimes can add a real platform API without
  // changing command implementations.
  return "linux";
}

async function run(command: string, args: string[], label: string): Promise<SpawnResult> {
  status(`${label}: ${command} ${args.join(" ")}`);
  const result = await editor.spawnProcess(command, args);
  const out = (result.stdout || "").trim();
  const err = (result.stderr || "").trim();
  if (out) editor.debug(out);
  if (err) editor.debug(err);
  if (result.exit_code === 0) {
    status(`${label} completed`);
  } else {
    status(`${label} failed with exit code ${result.exit_code}`);
  }
  return result;
}

async function commandExists(command: string): Promise<boolean> {
  const probe = await editor.spawnProcess("sh", ["-lc", `command -v ${quoteShell(command)} >/dev/null 2>&1`]);
  return probe.exit_code === 0;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function preferAndroidCli(): Promise<boolean> {
  if (state.config.androidCli === "never") return false;
  const found = await commandExists("android");
  if (!found && state.config.androidCli === "always") {
    status("android CLI was requested but was not found on PATH");
  }
  return found;
}

async function gradleTask(task: string): Promise<SpawnResult> {
  return run(gradleCommand(), [task], `Gradle ${task}`);
}

async function selectedDevice(): Promise<string | undefined> {
  const result = await editor.spawnProcess("adb", ["devices"]);
  const devices = (result.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"))
    .map((line) => line.split(/\s+/)[0]);
  return devices[0];
}

async function detectPackageName(): Promise<string | undefined> {
  if (state.config.packageName) return state.config.packageName;

  const manifest = await editor.spawnProcess("sh", [
    "-lc",
    "find . -path '*/src/main/AndroidManifest.xml' -print -quit 2>/dev/null",
  ]);
  const manifestPath = (manifest.stdout || "").trim();
  if (manifestPath) {
    const packageResult = await editor.spawnProcess("sh", [
      "-lc",
      `sed -n 's/.*package="\\([^"]*\\)".*/\\1/p' ${quoteShell(manifestPath)} | head -1`,
    ]);
    const packageName = (packageResult.stdout || "").trim();
    if (packageName) return packageName;
  }

  const namespaceResult = await editor.spawnProcess("sh", [
    "-lc",
    "sed -n \"s/.*namespace[ =] *['\\\"]\\([^'\\\"]*\\)['\\\"].*/\\1/p\" build.gradle settings.gradle app/build.gradle build.gradle.kts app/build.gradle.kts 2>/dev/null | head -1",
  ]);
  const namespaceName = (namespaceResult.stdout || "").trim();
  return namespaceName || undefined;
}

async function openOutputBuffer(name: string, content: string): Promise<void> {
  if (editor.createVirtualBuffer) {
    await editor.createVirtualBuffer(name, content, "android");
    return;
  }
  editor.debug(`${name}\n${content}`);
}

registerHandler("android_build", async (...args: string[]) => {
  const variant = normalizeVariant(args[0]);
  state.config.variant = variant;
  await gradleTask(`assemble${upperFirst(variant)}`);
});

registerHandler("android_install", async (...args: string[]) => {
  const variant = normalizeVariant(args[0]);
  state.config.variant = variant;
  await gradleTask(`install${upperFirst(variant)}`);
});

registerHandler("android_run", async (...args: string[]) => {
  const variant = normalizeVariant(args[0]);
  state.config.variant = variant;

  if (await preferAndroidCli()) {
    const apkGlob = `app/build/outputs/apk/${variant}/*.apk`;
    await run("sh", ["-lc", `android run --apks=${quoteShell(apkGlob)}`], "Android run");
  } else {
    const install = await gradleTask(`install${upperFirst(variant)}`);
    if (install.exit_code !== 0) return;
    const pkg = await detectPackageName();
    if (!pkg) {
      status("Installed APK, but package name was not detected for launch");
      return;
    }
    await run("adb", ["shell", "monkey", "-p", pkg, "1"], "Launch app");
  }
  await openLogcat();
});

registerHandler("android_clean", async () => {
  await gradleTask("clean");
});

registerHandler("android_sync", async () => {
  await gradleTask("dependencies");
});

registerHandler("android_task", async (...args: string[]) => {
  const task = args.join(" ").trim();
  if (!task) {
    status("Usage: Android: Gradle Task <task>");
    return;
  }
  await gradleTask(task);
});

registerHandler("android_devices", async () => {
  const result = await run("adb", ["devices", "-l"], "List devices");
  await openOutputBuffer("Android Devices", result.stdout || result.stderr || "No devices found");
});

registerHandler("android_emulator", async (...args: string[]) => {
  const avd = args.join(" ").trim();
  if (await preferAndroidCli()) {
    await run("android", avd ? ["emulator", "start", avd] : ["emulator", "list"], "Android emulator");
    return;
  }
  if (!avd) {
    const result = await run("emulator", ["-list-avds"], "List AVDs");
    await openOutputBuffer("Android AVDs", result.stdout || "No AVDs found");
    return;
  }
  await run("emulator", ["-avd", avd], `Start emulator ${avd}`);
});

registerHandler("android_emulator_stop", async () => {
  const device = await selectedDevice();
  await run("adb", device ? ["-s", device, "emu", "kill"] : ["emu", "kill"], "Stop emulator");
});

registerHandler("android_mirror", async () => {
  const device = await selectedDevice();
  await run("scrcpy", device ? ["--serial", device] : [], "Mirror device");
});

registerHandler("android_clear_data", async () => {
  const pkg = await detectPackageName();
  if (!pkg) return status("Package name was not detected");
  await run("adb", ["shell", "pm", "clear", pkg], "Clear app data");
});

registerHandler("android_force_stop", async () => {
  const pkg = await detectPackageName();
  if (!pkg) return status("Package name was not detected");
  await run("adb", ["shell", "am", "force-stop", pkg], "Force stop app");
});

registerHandler("android_uninstall", async () => {
  const pkg = await detectPackageName();
  if (!pkg) return status("Package name was not detected");
  await run("adb", ["uninstall", pkg], "Uninstall app");
});

async function openLogcat(...args: string[]): Promise<void> {
  const level = (args[0] || state.config.logLevel || "V").toUpperCase();
  state.config.logLevel = level;
  const pkg = await detectPackageName();
  const filter = pkg ? [`--pid=$(adb shell pidof -s ${quoteShell(pkg)})`, `*:${level}`] : [`*:${level}`];
  const result = await run("sh", ["-lc", `adb logcat -d ${filter.join(" ")}`], "Logcat");
  state.logcatRunning = result.exit_code === 0;
  await openOutputBuffer("Android Logcat", result.stdout || result.stderr || "Logcat produced no output");
}

registerHandler("android_logcat", openLogcat);

registerHandler("android_logcat_clear", async () => {
  await run("adb", ["logcat", "-c"], "Clear logcat");
});

registerHandler("android_logcat_stop", async () => {
  await run("sh", ["-lc", "pkill -f 'adb logcat' || true"], "Stop logcat");
  state.logcatRunning = false;
});

registerHandler("android_screenshot", async (...args: string[]) => {
  const path = args[0] || "android-screenshot.png";
  if (await preferAndroidCli()) {
    await run("android", ["screenshot", path], "Screenshot");
    return;
  }
  await run("sh", ["-lc", `adb exec-out screencap -p > ${quoteShell(path)}`], "Screenshot");
  if (editor.openFile) await editor.openFile(path);
});

registerHandler("android_docs", async (...args: string[]) => {
  const query = args.join(" ").trim();
  if (!query) return status("Usage: Android: Docs <query>");
  if (!(await preferAndroidCli())) return status("android CLI is required for docs search");
  const result = await run("android", ["docs", query], "Android docs");
  await openOutputBuffer("Android Docs", result.stdout || result.stderr || "No documentation results");
});

const commands: Array<[string, string, string]> = [
  ["Android: Run", "Build, install, launch, and open logcat", "android_run"],
  ["Android: Build", "Build APK with the selected or supplied variant", "android_build"],
  ["Android: Install", "Build and install APK", "android_install"],
  ["Android: Clean", "Run Gradle clean", "android_clean"],
  ["Android: Sync", "Resolve Gradle dependencies", "android_sync"],
  ["Android: Gradle Task", "Run any Gradle task", "android_task"],
  ["Android: Devices", "Show adb devices", "android_devices"],
  ["Android: Emulator", "List or start an Android emulator", "android_emulator"],
  ["Android: Stop Emulator", "Stop the active emulator", "android_emulator_stop"],
  ["Android: Mirror", "Mirror a device with scrcpy", "android_mirror"],
  ["Android: Clear Data", "Clear the detected app package data", "android_clear_data"],
  ["Android: Force Stop", "Force stop the detected app package", "android_force_stop"],
  ["Android: Uninstall", "Uninstall the detected app package", "android_uninstall"],
  ["Android: Logcat", "Open a filtered adb logcat snapshot", "android_logcat"],
  ["Android: Clear Logcat", "Clear adb logcat", "android_logcat_clear"],
  ["Android: Stop Logcat", "Stop adb logcat", "android_logcat_stop"],
  ["Android: Screenshot", "Capture a device screenshot", "android_screenshot"],
  ["Android: Docs", "Search Android CLI documentation", "android_docs"],
];

for (const [name, description, handler] of commands) {
  editor.registerCommand(name, description, handler);
}

status("plugin loaded");
