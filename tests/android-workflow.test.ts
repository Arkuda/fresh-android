import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import ts from "typescript";

// Each fixture is a separate QuickJS-like realm. External tools are deterministic;
// assertions cover selection, artifact identity, cancellation, and failure boundaries.
function fixture(options: { buildFails?: boolean; devices?: string; cancel?: boolean; noProject?: boolean; pid?: string; javaMajor?: number; dataDirectory?: string; lspPause?: { gate: Promise<void>; registered: () => void } } = {}) {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: Record<string, string> = {};
  const hooks: Record<string, string> = {};
  const settings: Record<string, string | boolean> = {};
  const calls: Array<{ command: string; args: string[] }> = [];
  const terminals: Array<{ command: string[] }> = [];
  const closed: number[] = [];
  const buffers: Array<{ id: number; name: string; is_virtual: boolean }> = [];
  const registered: string[] = [];
  const timers: string[] = [];
  let status = "";
  let content = "";
  const files = new Map([
    ["/project/gradlew", "wrapper"],
    ["/project/app/build/outputs/apk/demo/debug/output-metadata.json", JSON.stringify({ applicationId: "com.example.demo.debug", variantName: "demoDebug", elements: [{ outputFile: "custom-name.apk" }] })],
    ["/project/app/build/outputs/apk/demo/debug/custom-name.apk", "APK"],
  ]);
  if (options.noProject) files.delete("/project/gradlew");
  if (options.javaMajor !== undefined) {
    for (const file of ["/jdk/bin/java.exe", "/jdk/bin/javac.exe", "/jdt/plugins/org.eclipse.equinox.launcher_test.jar"]) files.set(file, "fixture");
    files.set("/jdt/config_win/config.ini", "eclipse.application=org.eclipse.jdt.ls.core.id1\n");
  }
  if (options.lspPause) files.set("/kotlin/bin/intellij-server.exe", "fixture");
  const editor = {
    defineConfigString: (name: string, opts: { default: string }) => { settings[name] = opts.default; },
    defineConfigBoolean: (name: string, opts: { default: boolean }) => { settings[name] = opts.default; },
    getPluginConfig: () => settings,
    getConfig: () => ({ keybindings: [] }),
    getUserConfig: () => ({}),
    getDataDir: () => options.dataDirectory || "/fresh-data",
    pathToFileUri: (file: string) => `file://${file}`,
    createDir: () => true,
    replaceFile: (file: string, content: string) => { files.set(file, content); return true; },
    registerLspServer: (language: string) => { registered.push(language); options.lspPause?.registered(); return true; },
    setLspRootUri: () => true,
    restartLspForLanguage: () => true,
    flush: async () => { await options.lspPause?.gate; },
    getAuthorityLabel: () => "",
    setTimeout: (_delay: number, handler: string) => { timers.push(handler); return timers.length; },
    setSetting: () => true,
    getEnv: (name: string) => options.javaMajor === undefined ? null : name === "OS" ? "Windows_NT" : name === "PROCESSOR_ARCHITECTURE" ? "AMD64" : null,
    getCwd: () => "/project",
    getActiveBufferId: () => 1,
    getBufferPath: (id: number) => { const buffer = buffers.find(b => b.id === id); return buffer && !buffer.is_virtual ? buffer.name : ""; },
    workspaceTrustLevel: () => "trusted",
    pathJoin: (...parts: string[]) => path.posix.join(...parts),
    pathDirname: path.posix.dirname,
    pathBasename: path.posix.basename,
    fileExists: (p: string) => files.has(p) || [...files.keys()].some(k => k.startsWith(`${p}/`)),
    readFile: (p: string) => files.get(p) ?? null,
    readDir: (p: string) => {
      const names = [...new Set([...files.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split("/")[0]))];
      return names.map(name => ({ name, is_dir: [...files.keys()].some(k => k.startsWith(`${p}/${name}/`)), is_file: files.has(`${p}/${name}`) }));
    },
    listBuffers: () => buffers,
    createVirtualBuffer: async ({ name }: { name: string }) => { const id = buffers.length + 1; buffers.push({ id, name, is_virtual: true }); return { bufferId: id }; },
    setVirtualBufferContent: (_id: number, entries: Array<{ text: string }>) => { content = entries.map(e => e.text).join(""); },
    showBuffer: () => true,
    setStatus: (s: string) => { status = s; },
    debug: () => {},
    on: (event: string, handler: string) => { hooks[event] = handler; },
    startPrompt: () => true,
    setPromptSuggestions: (choices: Array<{ value: string }>) => {
      queueMicrotask(() => {
        if (options.cancel) handlers[hooks.prompt_cancelled]({ prompt_type: "fresh-android-choice", input: "" });
        else {
          const selected = choices.find(c => ["app:assembleDemoDebug", "serial-b", "device"].includes(c.value)) || choices[0];
          handlers[hooks.prompt_confirmed]({ prompt_type: "fresh-android-choice", input: selected.value, selected_index: choices.indexOf(selected) });
        }
      });
    },
    createTerminal: async (opts: { command: string[] }) => { terminals.push(opts); return { terminalId: terminals.length }; },
    closeTerminal: (id: number) => { closed.push(id); },
    registerCommand: (name: string, _description: string, handler: string) => { commands[name] = handler; },
    spawnProcess: async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args.includes("-XshowSettings:properties")) return { exit_code: 0, stdout: `java.home=/jdk\njava.specification.version=${options.javaMajor}\n`, stderr: "" };
      if (args[0] === "tasks") return { exit_code: 0, stdout: "app:installDebug - Debug\napp:installDemoDebug - Demo\n", stderr: "" };
      if (args[0] === "app:assembleDemoDebug") return { exit_code: options.buildFails ? 1 : 0, stdout: "Build output", stderr: "" };
      if (args[0] === "devices") return { exit_code: 0, stdout: options.devices ?? "List of devices attached\nserial-a device model:Pixel_A\nserial-b device model:Pixel_B\n", stderr: "" };
      if (args.includes("resolve-activity")) return { exit_code: 0, stdout: "com.example.demo.debug/.LauncherAlias\n", stderr: "" };
      if (args.includes("pidof")) return { exit_code: 0, stdout: options.pid ?? "", stderr: "" };
      return { exit_code: 0, stdout: "Success", stderr: "" };
    },
  };
  const realm = createContext({ editor, registerHandler: (name: string, handler: (...args: unknown[]) => unknown) => { handlers[name] = handler; } });
  const modules = new Map<string, Record<string, unknown>>();
  function load(file: URL): Record<string, unknown> {
    const existing = modules.get(file.href);
    if (existing) return existing;
    const exports: Record<string, unknown> = {};
    modules.set(file.href, exports);
    const js = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    const evaluate: (require: (name: string) => unknown, exports: Record<string, unknown>) => void =
      runInContext(`(function(require, exports) { ${js}\n})`, realm);
    evaluate(name => load(new URL(name, file)), exports);
    return exports;
  }
  load(new URL("../plugins/android.ts", import.meta.url));
  if (options.javaMajor !== undefined) { settings.lspJavaHome = "/jdk"; settings.javaLspPath = "/jdt"; }
  if (options.lspPause) settings.kotlinLspPath = "/kotlin";
  return {
    calls, terminals, closed, settings, registered,
    run: async (name: string) => { await handlers[commands[`Android: ${name}`]](); },
    tick: async () => { const handler = timers.shift(); if (handler) await handlers[handler](); },
    openSource: (name: string) => {
      const buffer = { id: buffers.length + 1, name: `/project/${name}`, is_virtual: false };
      buffers.push(buffer);
      handlers[hooks.after_file_open]({ path: buffer.name, buffer_id: buffer.id, window_id: 1 });
    },
    status: () => status, content: () => content,
  };
}

test("Run installs chosen flavored APK and launches its built identity on the chosen serial", async () => {
  const f = fixture();
  await f.run("Run");
  const install = f.calls.find(c => c.args.includes("install"))!;
  assert.deepEqual([...install.args], ["-s", "serial-b", "install", "-r", "/project/app/build/outputs/apk/demo/debug/custom-name.apk"]);
  const launch = f.calls.find(c => c.args.includes("start"))!;
  assert.deepEqual([...launch.args], ["-s", "serial-b", "shell", "am", "start", "-W", "-n", "com.example.demo.debug/.LauncherAlias"]);
  await f.run("ADB Shell");
  assert.deepEqual([...f.terminals[0].command], ["adb", "-s", "serial-b", "shell"]);
});

test("failed build never installs or launches an old APK", async () => {
  const f = fixture({ buildFails: true });
  await f.run("Run");
  assert.match(f.status(), /failed/);
  assert.match(f.content(), /Build output/);
  assert.equal(f.calls.some(c => c.args.includes("install") || c.args.includes("start")), false);
});

test("unavailable devices block deployment and expose their actual state", async () => {
  const f = fixture({ devices: "List of devices attached\nusb1 unauthorized\nemulator-5554 offline\n" });
  await f.run("Run");
  assert.match(f.status(), /usb1: unauthorized.*emulator-5554: offline/);
  assert.equal(f.calls.some(c => c.args.includes("app:assembleDemoDebug") || c.args.includes("install")), false);
});

test("cancelling destructive confirmation cannot clear application data", async () => {
  const f = fixture({ cancel: true, devices: "only-device device\n" });
  f.settings.applicationId = "com.example.demo.debug";
  await f.run("Clear Data");
  assert.match(f.status(), /Cancelled/);
  assert.equal(f.calls.some(c => c.args.includes("clear")), false);
});

test("whole-device Logcat needs no Gradle project, replaces only its own terminal", async () => {
  const f = fixture({ noProject: true });
  f.settings.logLevel = "W";
  await f.run("Logcat");
  await f.run("Logcat");
  await f.run("Stop Logcat");
  assert.deepEqual([...f.terminals[0].command], ["adb", "-s", "serial-b", "logcat", "-v", "threadtime", "*:W"]);
  assert.deepEqual(f.closed, [1, 2]);
  assert.equal(f.calls.some(c => /pkill|killall/.test(c.command)), false);
});

test("Setup LSP rejects JDK 24 but accepts JDK 25 for the pinned JDT LS", async () => {
  const incompatible = fixture({ javaMajor: 24 });
  await incompatible.run("Setup LSP");
  assert.deepEqual(incompatible.registered, []);
  assert.match(incompatible.content(), /JDK 25\+/);

  const compatible = fixture({ javaMajor: 25 });
  await compatible.run("Setup LSP");
  assert.deepEqual(compatible.registered, ["java"]);
});

test("opening another language during automatic setup is processed after the current setup finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const registered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ javaMajor: 25, lspPause: { gate, registered: started } });
  f.openSource("Hello.kt");
  const firstSetup = f.tick();
  await registered;
  f.openSource("Greeter.java");
  await f.tick();
  release();
  await firstSetup;
  await f.tick();
  assert.deepEqual(f.registered, ["kotlin", "java"]);
});

test("unsafe Equinox data-directory encoding cannot start a Java server in shared parent storage", async () => {
  const f = fixture({ javaMajor: 25, dataDirectory: "/fresh%data" });
  await f.run("Setup LSP");
  assert.deepEqual(f.registered, []);
});
