/// <reference path="../types/fresh.d.ts" />
import { parseDevices, parseTargets, parseMetadata, localSdkPath, gradleArgs, launcherComponent } from "./lib/android-core.ts";
import type { Device, Target } from "./lib/android-core.ts";
import { AndroidLspManager } from "./lib/android-lsp.ts";
import type { AndroidLspSettings } from "./lib/android-lsp.ts";

type Config = AndroidLspSettings & { sdkPath: string; projectRoot: string; applicationId: string; activity: string; logLevel: string };
type Session = { device?: string; target?: Target; targets?: Target[]; lastAvd?: string; logcat?: number };
type Project = { root: string; session: Session };
type Choice = { text: string; value: string; description?: string };
class Cancelled extends Error {}

for (const [name, value, description] of [
  ["sdkPath", "", "Android SDK root; otherwise local.properties, environment, standard locations, then PATH"],
  ["projectRoot", "", "Gradle wrapper root; empty discovers from the active file or working directory"],
  ["applicationId", "", "Override installed app identity; empty uses built APK output metadata, never namespace"],
  ["activity", "", "Optional launcher activity (.MainActivity or fully qualified); empty asks Android package manager"],
  ["logLevel", "I", "Minimum Logcat priority: V, D, I, W, E, F, S"],
  ["lspJavaHome", "", "Optional JDK 25+ home for Java LSP; does not change the project's Gradle JDK"],
  ["kotlinLspPath", "", "Optional Kotlin LSP launcher or extracted distribution directory"],
  ["javaLspPath", "", "Optional extracted Eclipse JDT LS directory"],
]) editor.defineConfigString(name, { default: value, description });
editor.defineConfigBoolean("autoSetupLsp", { default: true, description: "Detect/configure LSP for open Kotlin/Java files in trusted local projects; downloads always require confirmation" });

// Use Fresh's native reference request/result UI, including its LSP capability checks.
// Runtime-layer bindings disappear on unload; keep unrelated user shortcuts intact.
const freshConfig = editor.getConfig();
const keybindings = freshConfig && typeof freshConfig === "object" && "keybindings" in freshConfig && Array.isArray(freshConfig.keybindings)
  ? freshConfig.keybindings : [];
editor.setSetting("keybindings", [
  ...keybindings,
  { key: "Enter", modifiers: ["ctrl"], action: "lsp_references", when: "normal" },
  { key: "Enter", modifiers: ["super"], action: "lsp_references", when: "normal" },
]);

const sessions: Record<string, Session> = {};
const projectRoots: Record<string, string> = {};
let busy = false;
let pending: { choices: Choice[]; visible: Choice[]; resolve: (value: string | null) => void } | undefined;
const promptType = "fresh-android-choice";
function config(): Config { return editor.getPluginConfig<Config>(); }
function status(message: string): void { editor.setStatus(`[Android] ${message}`); }
function session(root = editor.getCwd()): Session { return sessions[root] || (sessions[root] = {}); }
function windows(): boolean { return editor.getEnv("OS") === "Windows_NT"; }
const join = (...parts: string[]): string => editor.pathJoin(...parts);

const languageServers = new AndroidLspManager({
  settings: config,
  root: () => context().root,
  report: status,
  invocation,
  consent: async message => {
    await output("Android LSP Setup", message);
    try {
      return await choose("Install this LSP component? ", [
        { text: "Cancel", value: "cancel" },
        { text: "Download and install", value: "install" },
      ], false) === "install";
    } catch (error) {
      if (error instanceof Cancelled) return false;
      throw error;
    }
  },
});

async function output(title: string, text: string): Promise<void> {
  text = text.replace(/\r\n?/g, "\n");
  const name = `*${title}*`;
  let buffer = editor.listBuffers().find(b => b.is_virtual && b.name === name)?.id;
  if (buffer === undefined) buffer = (await editor.createVirtualBuffer({ name, readOnly: true, editingDisabled: true, showCursors: false })).bufferId;
  editor.setVirtualBufferContent(buffer, [{ text: text.endsWith("\n") ? text : `${text}\n` }]);
  editor.showBuffer(buffer);
}

function suggestions(input: string): void {
  if (!pending) return;
  const words = input.toLowerCase().trim().split(/\s+/);
  pending.visible = pending.choices.filter(c => words.every(w => `${c.text} ${c.description || ""}`.toLowerCase().includes(w)));
  editor.setPromptSuggestions(pending.visible.map(c => ({ id: c.value, ...c })));
}
registerHandler("android_choice_changed", (event: FreshPromptEvent) => {
  if (event.prompt_type === promptType) suggestions(event.input);
});
registerHandler("android_choice_confirmed", (event: FreshPromptEvent) => {
  if (event.prompt_type !== promptType || !pending) return;
  const current = pending;
  pending = undefined;
  const exact = current.visible.find(c => c.value === event.input || c.text === event.input);
  const chosen = exact || current.visible[event.selected_index ?? 0];
  current.resolve(chosen?.value ?? null);
});
registerHandler("android_choice_cancelled", (event: FreshPromptEvent) => {
  if (event.prompt_type !== promptType || !pending) return;
  const current = pending;
  pending = undefined;
  current.resolve(null);
});
editor.on("prompt_changed", "android_choice_changed");
editor.on("prompt_confirmed", "android_choice_confirmed");
editor.on("prompt_cancelled", "android_choice_cancelled");

async function choose(label: string, choices: Choice[], autoSingle = true): Promise<string> {
  if (!choices.length) throw new Error(`No choices available: ${label}`);
  if (autoSingle && choices.length === 1) return choices[0].value;
  const value = await new Promise<string | null>(resolve => {
    pending = { choices, visible: choices, resolve };
    editor.startPrompt(label, promptType);
    suggestions("");
  });
  if (value === null) throw new Cancelled();
  return value;
}
async function ask(label: string, initial = ""): Promise<string> {
  const value = await editor.prompt(label, initial);
  if (value === null) throw new Cancelled();
  if (!value.trim()) throw new Error("A value is required");
  return value.trim();
}
async function confirm(label: string): Promise<void> {
  if (await choose(label, [{ text: "Cancel", value: "no" }, { text: "Confirm", value: "yes" }], false) !== "yes") throw new Cancelled();
}

function project(): Project {
  const configured = config().projectRoot.trim();
  const activePath = editor.getBufferPath(editor.getActiveBufferId());
  const starts = configured ? [configured] : [activePath ? editor.pathDirname(activePath) : "", projectRoots[editor.getCwd()] || "", editor.getCwd()].filter(Boolean);
  for (const start of starts) {
    let root = start;
    for (;;) {
      if (editor.fileExists(join(root, windows() ? "gradlew.bat" : "gradlew"))) {
        projectRoots[editor.getCwd()] = root;
        return { root, session: session(root) };
      }
      if (configured) break;
      const parent = editor.pathDirname(root);
      if (parent === root || parent === "." || !parent) break;
      root = parent;
    }
  }
  throw new Error("No Gradle wrapper found. Open an Android project or set projectRoot in Fresh plugin settings.");
}
function context(): Project {
  try { return project(); }
  catch { return { root: editor.getCwd(), session: session() }; }
}
function sdkRoot(root = context().root): string | undefined {
  const explicit = config().sdkPath.trim();
  if (explicit) {
    if (!editor.fileExists(explicit)) throw new Error(`Android SDK directory does not exist: ${explicit}`);
    return explicit;
  }
  const local = localSdkPath(editor.readFile(join(root, "local.properties")) || "");
  const home = editor.getEnv("HOME") || editor.getEnv("USERPROFILE") || "";
  const paths = [local, editor.getEnv("ANDROID_HOME"), editor.getEnv("ANDROID_SDK_ROOT"),
    windows() ? join(editor.getEnv("LOCALAPPDATA") || join(home, "AppData", "Local"), "Android", "Sdk") : join(home, "Android", "Sdk"),
    join(home, "Library", "Android", "sdk")];
  return paths.find((p): p is string => !!p && editor.fileExists(p));
}
function tool(name: string, root?: string): string {
  const sdk = sdkRoot(root);
  const filename = name + (windows() ? (["sdkmanager", "avdmanager"].includes(name) ? ".bat" : ".exe") : "");
  if (sdk) {
    const folder: Record<string, string> = { adb: "platform-tools", emulator: "emulator" };
    if (folder[name]) {
      const path = join(sdk, folder[name], filename);
      if (editor.fileExists(path)) return path;
    } else {
      const base = join(sdk, "cmdline-tools");
      const versions = editor.fileExists(base) ? editor.readDir(base).filter(e => e.is_dir && /^\d+(\.\d+)*$/.test(e.name)).map(e => e.name).sort((a, b) => {
        const x = a.split(".").map(Number), y = b.split(".").map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
        return 0;
      }) : [];
      for (const version of ["latest", ...versions]) {
        const path = join(base, version, "bin", filename);
        if (editor.fileExists(path)) return path;
      }
    }
  }
  return filename;
}
// Only batch scripts need cmd.exe. No shell for adb, emulator, scrcpy, or APK paths.
function invocation(command: string, args: string[]): string[] {
  if (!windows() || !/\.(?:bat|cmd)$/i.test(command)) return [command, ...args];
  // cmd expansion is not argument quoting. Refuse expansion/metacharacters rather than executing them.
  if ([command, ...args].some(a => /["%!&|<>^\r\n]/.test(a))) throw new Error("Unsafe characters in Windows batch path/arguments");
  const batch = command.replace(/^(?:\/\/\?\/|\\\\\?\\)/, "").replace(/\//g, "\\");
  return [editor.getEnv("COMSPEC") || "cmd.exe", "/d", "/c", "call", batch, ...args];
}
async function execute(command: string, args: string[], cwd?: string): Promise<FreshSpawnResult> {
  const [program, ...argv] = invocation(command, args);
  return await editor.spawnProcess(program, argv, cwd);
}
async function run(command: string, args: string[], label: string, cwd?: string): Promise<FreshSpawnResult> {
  status(`${label}…`);
  const result = await execute(command, args, cwd);
  const text = `$ ${command} ${args.join(" ")}\n\n${result.stdout}\n${result.stderr}\nExit: ${result.exit_code}`;
  await output("Android Output", text);
  if (result.exit_code !== 0) throw new Error(`${label} failed (${result.exit_code}); see Android Output`);
  status(`${label} completed`);
  return result;
}
async function gradle(p: Project, args: string[]): Promise<FreshSpawnResult> {
  if (editor.workspaceTrustLevel() !== "trusted") throw new Error("Trust this workspace before running its Gradle wrapper");
  return await run(join(p.root, windows() ? "gradlew.bat" : "gradlew"), [...args, "--console=plain"], `Gradle ${args.join(" ")}`, p.root);
}
async function targets(p: Project, refresh = false): Promise<Target[]> {
  if (!p.session.targets || refresh) p.session.targets = parseTargets((await gradle(p, ["tasks", "--all"])).stdout);
  if (!p.session.targets.length) throw new Error("No installable Android variants found in Gradle tasks --all");
  // Root aggregate tasks duplicate module tasks, but a root-only Android application is valid.
  return p.session.targets.some(t => t.module !== ":") ? p.session.targets.filter(t => t.module !== ":") : p.session.targets;
}
async function target(p: Project, refresh = false): Promise<Target> {
  if (p.session.target && !refresh) return p.session.target;
  const list = await targets(p, refresh);
  const key = await choose("Android build variant: ", list.map(t => ({ text: `${t.module} · ${t.variant}`, value: t.assemble })), !refresh);
  p.session.target = list.find(t => t.assemble === key)!;
  status(`Variant: ${p.session.target.module} ${p.session.target.variant}`);
  return p.session.target;
}
async function devices(root?: string): Promise<Device[]> {
  return parseDevices((await run(tool("adb", root), ["devices", "-l"], "List devices", root)).stdout);
}
async function device(s: Session, root?: string, force = false, emulatorOnly = false): Promise<string> {
  const all = await devices(root);
  const ready = all.filter(d => d.state === "device" && (!emulatorOnly || /^emulator-/.test(d.serial)));
  if (!force && s.device && ready.some(d => d.serial === s.device)) return s.device;
  if (!ready.length) throw new Error(`No ready ${emulatorOnly ? "emulator" : "device"}. ${all.map(d => `${d.serial}: ${d.state}`).join(", ") || "Connect a device or start an AVD."}`);
  s.device = await choose("Android device: ", ready.map(d => ({ text: d.serial, value: d.serial, description: d.description })), !force);
  status(`Device: ${s.device}`);
  return s.device;
}
async function adb(serial: string, args: string[], label: string, root?: string): Promise<FreshSpawnResult> {
  return await run(tool("adb", root), ["-s", serial, ...args], label, root);
}
function metadataFiles(dir: string): string[] {
  if (!editor.fileExists(dir)) return [];
  return editor.readDir(dir).flatMap(e => e.is_dir ? metadataFiles(join(dir, e.name)) : e.name === "output-metadata.json" ? [join(dir, e.name)] : []);
}
async function artifact(p: Project, t: Target): Promise<{ path: string; applicationId: string }> {
  // Android Gradle Plugin writes final variant identity here, including applicationIdSuffix.
  const dir = join(p.root, ...t.module.split(":").filter(Boolean), "build", "outputs", "apk");
  const matches = metadataFiles(dir).map(path => ({ path, metadata: parseMetadata(editor.readFile(path) || "") })).filter(x => x.metadata.variantName.toLowerCase() === t.variant.toLowerCase());
  if (matches.length !== 1) throw new Error(`Expected one APK metadata file for ${t.module} ${t.variant}; found ${matches.length}. Custom build output directories are not supported.`);
  const { path, metadata } = matches[0];
  const apk = await choose("APK output: ", metadata.elements.map(e => ({ text: e.outputFile, value: e.outputFile, description: (e.filters || []).map(f => `${f.filterType}=${f.value}`).join(", ") })));
  const apkPath = join(editor.pathDirname(path), apk);
  if (!editor.fileExists(apkPath)) throw new Error(`Built APK does not exist: ${apkPath}`);
  return { path: apkPath, applicationId: metadata.applicationId };
}
async function app(p: Project): Promise<string> {
  const override = config().applicationId.trim();
  const id = override || (await artifact(p, await target(p))).applicationId;
  if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(id)) throw new Error("Invalid applicationId");
  return id;
}
async function launch(serial: string, id: string, root: string): Promise<void> {
  if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(id)) throw new Error("Invalid applicationId");
  const activity = config().activity.trim();
  if (activity && !/^[\w.$]+$/.test(activity)) throw new Error("Invalid launcher activity");
  const component = activity ? `${id}/${activity}` : launcherComponent((await adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", id], "Resolve launcher", root)).stdout, id);
  const result = await adb(serial, ["shell", "am", "start", "-W", "-n", component], "Launch app", root);
  // am may print an error while returning zero.
  if (/Error:|Error type \d|Exception/.test(result.stdout + result.stderr)) throw new Error("Android could not launch the activity; see Android Output");
}
async function buildInstall(launchApp: boolean): Promise<void> {
  const p = project();
  const t = await target(p);
  const serial = await device(p.session, p.root);
  await gradle(p, [t.assemble]);
  const apk = await artifact(p, t);
  await adb(serial, ["install", "-r", apk.path], "Install APK", p.root);
  if (launchApp) await launch(serial, config().applicationId.trim() || apk.applicationId, p.root);
}
async function terminal(command: string, args: string[], title: string, cwd?: string): Promise<number> {
  return (await editor.createTerminal({ command: invocation(command, args), cwd, title, direction: "horizontal", ratio: 0.3, persistent: false })).terminalId;
}
async function logcat(snapshot = false): Promise<void> {
  const p = context();
  const serial = await device(p.session, p.root);
  const level = config().logLevel.toUpperCase();
  if (!/^[VDIWEFS]$/.test(level)) throw new Error("logLevel must be V, D, I, W, E, F, or S");
  const scope = await choose("Logcat scope: ", [{ text: "Selected app", value: "app" }, { text: "Whole device", value: "device" }], false);
  const args = ["-s", serial, "logcat", "-v", "threadtime"];
  if (scope === "app") {
    const id = await app(p);
    const pid = (await adb(serial, ["shell", "pidof", "-s", id], "Find app process", p.root)).stdout.trim();
    if (!/^\d+$/.test(pid)) throw new Error(`${id} is not running; start it before app-filtered Logcat`);
    args.push(`--pid=${pid}`);
  }
  if (snapshot) args.push("-d", "-t", "1000");
  args.push(`*:${level}`);
  if (snapshot) await run(tool("adb", p.root), args, "Logcat snapshot", p.root);
  else {
    if (p.session.logcat !== undefined) editor.closeTerminal(p.session.logcat);
    p.session.logcat = await terminal(tool("adb", p.root), args, `Android Logcat · ${serial}`, p.root);
    status("Logcat streaming; Stop Logcat closes only this plugin's terminal");
  }
}
async function avds(): Promise<string[]> {
  return (await run(tool("emulator"), ["-list-avds"], "List AVDs")).stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}
async function chooseAvd(): Promise<string> {
  const list = await avds();
  const last = context().session.lastAvd;
  if (last && list.includes(last)) list.splice(0, 0, ...list.splice(list.indexOf(last), 1));
  return await choose("Android virtual device: ", list.map(name => ({ text: name, value: name })));
}
async function appAction(action: "stop" | "clear" | "uninstall"): Promise<void> {
  const p = project(), serial = await device(p.session, p.root), id = await app(p);
  if (action !== "stop") await confirm(`${action === "clear" ? "Clear all data for" : "Uninstall"} ${id} on ${serial}? `);
  const args = action === "stop" ? ["shell", "am", "force-stop", id] : action === "clear" ? ["shell", "pm", "clear", id] : ["uninstall", id];
  await adb(serial, args, `${action} ${id}`, p.root);
}

const commands: Array<{ name: string; description: string; action: () => Promise<void> }> = [
  { name: "Menu", description: "Android workflow actions", action: async () => {
    const chosen = await choose("Android: ", commands.filter(c => c.name !== "Menu").map(c => ({ text: c.name, value: c.name, description: c.description })), false);
    await commands.find(c => c.name === chosen)!.action();
  } },
  { name: "Doctor", description: "Check SDK, tools, Java, project and device availability", action: async () => {
    let root = editor.getCwd(), projectInfo = "No Gradle wrapper";
    try { root = project().root; projectInfo = root; } catch (error) { projectInfo = String(error); }
    const rows = [`Fresh Android`, `Platform: ${windows() ? "Windows" : "Unix"}`, `Project: ${projectInfo}`, `Trust: ${editor.workspaceTrustLevel()}`, `SDK: ${sdkRoot(root) || "PATH only"}`, `JAVA_HOME: ${editor.getEnv("JAVA_HOME") || "unset"}`];
    for (const [name, args] of [["adb", ["version"]], ["emulator", ["-version"]], ["java", ["-version"]]] as Array<[string, string[]]>) {
      const command = name === "java" ? name : tool(name, root);
      try { const r = await execute(command, args, root); rows.push(`\n${command} (exit ${r.exit_code})\n${r.stdout}${r.stderr}`); }
      catch (e) { rows.push(`\n${command}: ${String(e)}`); }
    }
    try { rows.push(`\nDevices\n${(await execute(tool("adb", root), ["devices", "-l"], root)).stdout}`); } catch (e) { rows.push(String(e)); }
    rows.push(...await languageServers.diagnostics());
    await output("Android Doctor", rows.join("\n"));
    status("Diagnostics ready");
  } },
  { name: "Setup LSP", description: "Detect/configure Kotlin and Java LSP; confirm missing downloads", action: async () => {
    const language = await choose("Configure language servers: ", [
      { text: "Kotlin and Java", value: "both" },
      { text: "Kotlin", value: "kotlin" },
      { text: "Java", value: "java" },
    ], false);
    await languageServers.setup(language === "both" ? ["kotlin", "java"] : language === "kotlin" ? ["kotlin"] : ["java"]);
    await output("Android LSP Setup", (await languageServers.diagnostics()).join("\n"));
  } },
  { name: "Select Build Variant", description: "Refresh Gradle application modules and variants", action: async () => { const p = project(); await target(p, true); } },
  { name: "Build", description: "Assemble the selected module and variant", action: async () => { const p = project(); await gradle(p, [(await target(p)).assemble]); } },
  { name: "Install", description: "Build and install on the selected device", action: async () => { await buildInstall(false); } },
  { name: "Run", description: "Build, install and launch on the selected device", action: async () => { await buildInstall(true); } },
  { name: "Launch", description: "Launch the already installed selected app", action: async () => { const p = project(); await launch(await device(p.session, p.root), await app(p), p.root); } },
  { name: "Clean", description: "Gradle clean", action: async () => { await gradle(project(), ["clean"]); } },
  { name: "Dependencies", description: "Gradle dependency report (not IDE sync)", action: async () => { await gradle(project(), ["dependencies"]); } },
  { name: "Gradle Tasks", description: "Show all Gradle tasks", action: async () => { await gradle(project(), ["tasks", "--all"]); } },
  { name: "Gradle Task", description: "Prompt for Gradle tasks and options", action: async () => { const p = project(); await gradle(p, gradleArgs(await ask("Gradle tasks: ", "tasks --all"))); p.session.targets = undefined; p.session.target = undefined; } },
  { name: "Devices", description: "Show all devices, including unauthorized and offline", action: async () => { await devices(); } },
  { name: "Select Device", description: "Choose a ready device or emulator", action: async () => { const p = context(); await device(p.session, p.root, true); } },
  { name: "Emulator", description: "Choose and start an AVD in an owned terminal", action: async () => {
    const avd = await chooseAvd();
    await terminal(tool("emulator"), ["-avd", avd], `Android Emulator · ${avd}`);
    context().session.lastAvd = avd;
    status(`Starting ${avd}; wait for Android to boot, then Select Device`);
  } },
  { name: "Stop Emulator", description: "Select a running emulator and confirm shutdown", action: async () => {
    const serial = await device(context().session, undefined, true, true);
    await confirm(`Stop ${serial}? `); await adb(serial, ["emu", "kill"], "Stop emulator");
  } },
  { name: "Create AVD", description: "Create an emulator from an installed SDK system image", action: async () => {
    const sdk = sdkRoot();
    if (!sdk) throw new Error("Set sdkPath or ANDROID_HOME before creating an AVD");
    const images: string[] = [];
    const base = join(sdk, "system-images");
    if (editor.fileExists(base)) for (const api of editor.readDir(base).filter(e => e.is_dir)) for (const tag of editor.readDir(join(base, api.name)).filter(e => e.is_dir)) for (const abi of editor.readDir(join(base, api.name, tag.name)).filter(e => e.is_dir)) if (editor.fileExists(join(base, api.name, tag.name, abi.name, "package.xml"))) images.push(`system-images;${api.name};${tag.name};${abi.name}`);
    const image = await choose("Installed system image: ", images.map(i => ({ text: i, value: i })));
    const name = await ask("New AVD name: ");
    if (!/^[\w.-]+$/.test(name)) throw new Error("AVD name may contain letters, digits, _, -, and .");
    if ((await avds()).includes(name)) throw new Error(`AVD ${name} already exists; it will not be overwritten`);
    // avdmanager asks about a custom hardware profile: keep its stdin in a real terminal.
    await terminal(tool("avdmanager"), ["create", "avd", "-n", name, "-k", image], "Android Create AVD");
    status("Complete the hardware profile prompt in Android Create AVD (usually 'no')");
  } },
  { name: "Delete AVD", description: "Confirm and delete a stopped AVD", action: async () => {
    const avd = await chooseAvd();
    const connected = (await devices()).filter(d => /^emulator-/.test(d.serial));
    for (const d of connected) {
      if (d.state !== "device") throw new Error(`Cannot verify running AVD while ${d.serial} is ${d.state}`);
      const name = (await adb(d.serial, ["emu", "avd", "name"], "Check running AVD")).stdout.split(/\r?\n/)[0].trim();
      if (name === avd) throw new Error(`Stop ${avd} before deleting it`);
    }
    await confirm(`Permanently delete AVD ${avd} and its data? `);
    await run(tool("avdmanager"), ["delete", "avd", "-n", avd], `Delete ${avd}`);
  } },
  { name: "SDK Packages", description: "Show installed and available SDK packages", action: async () => { await run(tool("sdkmanager"), ["--list"], "SDK packages"); } },
  { name: "Install SDK Package", description: "Install a package, with interactive license prompts", action: async () => {
    const name = await ask("SDK package ID: ", "platform-tools");
    if (!/^[\w.;-]+$/.test(name) || name.startsWith("-")) throw new Error("Enter one SDK package ID, for example system-images;android-35;google_apis;x86_64");
    await terminal(tool("sdkmanager"), [name], `Android SDK · ${name}`);
  } },
  { name: "SDK Licenses", description: "Review and accept SDK licenses in a terminal", action: async () => { await terminal(tool("sdkmanager"), ["--licenses"], "Android SDK Licenses"); } },
  { name: "ADB Shell", description: "Open a shell on the selected device", action: async () => { const serial = await device(context().session); await terminal(tool("adb"), ["-s", serial, "shell"], `Android Shell · ${serial}`); } },
  { name: "Connect Device", description: "Connect ADB over TCP/IP to host:port", action: async () => {
    const address = await ask("ADB host:port: ");
    if (!/^[\w.\[\]:-]+:\d+$/.test(address)) throw new Error("Enter host:port");
    await run(tool("adb"), ["connect", address], "Connect device");
  } },
  { name: "Pair Device", description: "Pair wireless debugging interactively", action: async () => {
    const address = await ask("ADB pairing host:port: ");
    if (!/^[\w.\[\]:-]+:\d+$/.test(address)) throw new Error("Enter host:port");
    await terminal(tool("adb"), ["pair", address], "Android Wireless Pairing");
  } },
  { name: "Mirror", description: "Mirror the selected device with scrcpy", action: async () => { const serial = await device(context().session); await terminal(windows() ? "scrcpy.exe" : "scrcpy", ["--serial", serial], "Android Mirror"); } },
  { name: "Force Stop", description: "Force-stop the selected app", action: async () => { await appAction("stop"); } },
  { name: "Clear Data", description: "Confirm clearing the selected app's data", action: async () => { await appAction("clear"); } },
  { name: "Uninstall", description: "Confirm uninstalling the selected app", action: async () => { await appAction("uninstall"); } },
  { name: "Logcat", description: "Stream app/device logs in an owned terminal", action: async () => { await logcat(); } },
  { name: "Logcat Snapshot", description: "Show up to 1000 recent log entries", action: async () => { await logcat(true); } },
  { name: "Clear Logcat", description: "Confirm clearing the selected device's logs", action: async () => { const serial = await device(context().session); await confirm(`Clear Logcat buffers on ${serial}? `); await adb(serial, ["logcat", "-c"], "Clear Logcat"); } },
  { name: "Stop Logcat", description: "Close only this plugin's Logcat terminal", action: async () => {
    const s = context().session;
    if (s.logcat !== undefined) { editor.closeTerminal(s.logcat); s.logcat = undefined; }
    status("Logcat stopped");
  } },
  { name: "Screenshot", description: "Capture and pull a PNG without shell redirection", action: async () => {
    const serial = await device(context().session);
    const path = await ask("Save screenshot as: ", join(editor.getCwd(), `android-${Date.now()}.png`));
    if (editor.fileExists(path)) throw new Error(`File already exists: ${path}`);
    const remote = `/data/local/tmp/fresh-android-${Date.now()}.png`;
    await adb(serial, ["shell", "screencap", "-p", remote], "Capture screenshot");
    try { await adb(serial, ["pull", remote, path], "Save screenshot"); }
    finally { await adb(serial, ["shell", "rm", "-f", remote], "Remove temporary screenshot"); }
    status(`Screenshot saved: ${path}`);
  } },
  { name: "Docs", description: "Show an official Android documentation search URL", action: async () => { const query = await ask("Android documentation: "); await output("Android Docs", `https://developer.android.com/s/results?q=${encodeURIComponent(query)}`); } },
];

for (const [index, command] of commands.entries()) {
  const handler = `android_command_${index}`;
  registerHandler(handler, async () => {
    if (busy) { status("Another Android action is in progress; finish or cancel its prompt first"); return; }
    busy = true;
    try { await command.action(); }
    catch (error) {
      if (error instanceof Cancelled) status("Cancelled");
      else { editor.debug(`[Android] ${String(error)}`); status(String(error)); }
    } finally { busy = false; scheduleLspSetup(); }
  });
  editor.registerCommand(`Android: ${command.name}`, command.description, handler, null);
}

let lspSetupScheduled = false;
let lspSetupPending = false;
function scheduleLspSetup(): void {
  if (lspSetupScheduled) return;
  lspSetupScheduled = true;
  editor.setTimeout(200, "android_auto_lsp_setup");
}
registerHandler("android_auto_lsp_setup", async () => {
  lspSetupScheduled = false;
  // A file/trust event can arrive while another automatic setup awaits I/O.
  if (busy) { lspSetupPending = true; return; }
  lspSetupPending = false;
  busy = true;
  try { await languageServers.automatic(); }
  catch (error) { editor.debug(`[Android LSP] ${String(error)}`); status(String(error)); }
  finally {
    busy = false;
    if (lspSetupPending) scheduleLspSetup();
  }
});
registerHandler("android_lsp_settings_changed", () => {
  languageServers.resetAutomatic();
  scheduleLspSetup();
});
registerHandler("android_lsp_error", (event: { language: string; message: string }) => {
  languageServers.recordError(event.language, event.message);
});
registerHandler("android_schedule_lsp_setup", scheduleLspSetup);
for (const event of ["ready", "after_file_open", "buffer_activated"]) editor.on(event, "android_schedule_lsp_setup");
for (const event of ["config_changed", "trust_changed", "authority_changed"]) editor.on(event, "android_lsp_settings_changed");
editor.on("lsp_server_error", "android_lsp_error");
scheduleLspSetup();
status("Ready · Android: Menu / Android: Doctor");
