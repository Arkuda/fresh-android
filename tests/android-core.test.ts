import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDevices, parseTargets, parseMetadata, localSdkPath, gradleArgs, launcherComponent } from "../plugins/lib/android-core.ts";

test("ADB preserves unavailable devices without treating daemon chatter as a device", () => {
  assert.deepEqual(parseDevices("* daemon started successfully *\r\nList of devices attached\r\nusb1\tunauthorized usb:1\r\nemulator-5554 device product:sdk model:Pixel_8\r\nusb2 offline\r\nusb3 no permissions (user in plugdev group)\n"), [
    { serial: "usb1", state: "unauthorized", description: "usb:1" },
    { serial: "emulator-5554", state: "device", description: "product:sdk model:Pixel 8" },
    { serial: "usb2", state: "offline", description: "" },
    { serial: "usb3", state: "no permissions", description: "(user in plugdev group)" },
  ]);
});

test("runnable targets keep nested modules and flavors but exclude tests and libraries", () => {
  assert.deepEqual(parseTargets("installDebug - Root app\napp:installDemoDebug - Installs demo debug\nfeature:phone:installPaidRelease - Installs paid release\napp:installDemoDebugAndroidTest - Test APK\nlibrary:assembleDebug - Library\napp:uninstallDemoDebug - Uninstall\napp:installDemoDebug - Duplicate\n"), [
    { module: ":", variant: "debug", assemble: "assembleDebug" },
    { module: ":app", variant: "demoDebug", assemble: "app:assembleDemoDebug" },
    { module: ":feature:phone", variant: "paidRelease", assemble: "feature:phone:assemblePaidRelease" },
  ]);
});

test("APK metadata preserves variant applicationId and rejects paths outside output directory", () => {
  const metadata = { applicationId: "com.example.demo.debug", variantName: "demoDebug", elements: [{ outputFile: "renamed-demo.apk", filters: [] }] };
  assert.deepEqual(parseMetadata(JSON.stringify(metadata)), metadata);
  for (const outputFile of ["../other.apk", "C:\\other.apk", "/other.apk", "nested/other.apk"]) {
    assert.throws(() => parseMetadata(JSON.stringify({ ...metadata, elements: [{ outputFile }] })), /own directory/);
  }
  assert.throws(() => parseMetadata(JSON.stringify({ ...metadata, applicationId: "bad;id" })), /Invalid/);
});

test("SDK local.properties unescapes Windows paths without corrupting separators", () => {
  assert.equal(localSdkPath("# SDK\nsdk.dir=C\\:\\\\Users\\\\Some User\\\\Android\\\\Sdk\n"), "C:\\Users\\Some User\\Android\\Sdk");
  assert.equal(localSdkPath("sdk.dir=/home/me/Android/Sdk"), "/home/me/Android/Sdk");
  assert.equal(localSdkPath("# sdk.dir=/not-active"), undefined);
});

test("Gradle task input supports multiple tasks/options but not shell execution", () => {
  assert.deepEqual(gradleArgs(":app:assembleDebug :app:testDebugUnitTest --offline -Pmode=demo"), [":app:assembleDebug", ":app:testDebugUnitTest", "--offline", "-Pmode=demo"]);
  for (const value of ["", "clean && whoami", "clean;whoami", "clean %PATH%", "clean $(whoami)", "clean\"x"]) assert.throws(() => gradleArgs(value));
});

test("launcher resolution accepts aliases and rejects missing/wrong application", () => {
  assert.equal(launcherComponent("priority=0\r\ncom.example.debug/.LauncherAlias\r\n", "com.example.debug"), "com.example.debug/.LauncherAlias");
  assert.throws(() => launcherComponent("No activity found", "com.example.debug"), /No launcher/);
  assert.throws(() => launcherComponent("com.other/.Main", "com.example.debug"), /No launcher/);
});
