/// <reference path="../../types/fresh.d.ts" />
import { lspConfigDecision, parseJavaRuntime } from "./lsp-config.ts";
import { detectLspPlatform, installedComponent, installComponent } from "./lsp-install.ts";
import type { LspConsent, LspLanguage, LspPlatform, LspReport } from "./lsp-types.ts";

export type AndroidLspSettings = {
  autoSetupLsp: boolean;
  lspJavaHome: string;
  kotlinLspPath: string;
  javaLspPath: string;
};
type Launch = { command: string; args: string[]; origin: string };
type JavaRuntime = { command: string; home: string; major: number };
type Options = {
  settings: () => AndroidLspSettings;
  root: () => string;
  consent: LspConsent;
  report: LspReport;
  invocation: (command: string, args: string[]) => string[];
  storeRoot?: string;
};

function canonical(path: string): string {
  const value = path.replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}

// Registration replaces Fresh's whole language-server list. Check policy both
// before asynchronous discovery/install and immediately before committing it.
export class AndroidLspManager {
  private readonly storeRoot: string;
  private readonly attempted = new Set<string>();
  private readonly states: Partial<Record<LspLanguage, string>> = {};
  private readonly errors: Partial<Record<LspLanguage, string>> = {};
  private readonly registrations: Partial<Record<LspLanguage, { command: string; args: string[] }>> = {};
  private platform: LspPlatform | undefined;
  private inFlight = false;
  private javaNotes: string[] = [];

  constructor(private readonly options: Options) {
    this.storeRoot = options.storeRoot || editor.pathJoin(editor.getDataDir(), "fresh-android", "lsp");
  }

  private assertContext(root: string): void {
    if (editor.getAuthorityLabel()) throw new Error("Automatic LSP installation is local-only; configure the remote language server in Fresh");
    if (editor.workspaceTrustLevel() !== "trusted") throw new Error("Trust this workspace before configuring or installing language servers");
    if (canonical(this.options.root()) !== canonical(root)) throw new Error("Workspace changed during LSP setup; run Android: Setup LSP in the intended project");
  }

  private async checked(command: string, args: string[], root: string): Promise<FreshSpawnResult> {
    this.assertContext(root);
    const [program, ...argv] = this.options.invocation(command, args);
    const result = await editor.spawnProcess(program, argv, root);
    this.assertContext(root);
    if (result.exit_code !== 0) throw new Error(`${command} failed (${result.exit_code}): ${(result.stderr || result.stdout).trim()}`);
    return result;
  }

  private async hostPlatform(root: string): Promise<LspPlatform> {
    this.assertContext(root);
    if (!this.platform) this.platform = await detectLspPlatform();
    this.assertContext(root);
    return this.platform;
  }

  private decision(language: LspLanguage) {
    const effective = editor.getConfig(), user = editor.getUserConfig();
    const result = lspConfigDecision(effective, user, language, this.storeRoot);
    const owned = this.registrations[language];
    // Also recognize launchers discovered outside our download directory, but
    // only while their exact registration is ours and no explicit user entry exists.
    if (result.kind === "user" && owned && lspConfigDecision({}, user, language, this.storeRoot).kind === "default"
      && effective && typeof effective === "object" && "lsp" in effective && effective.lsp && typeof effective.lsp === "object" && language in effective.lsp) {
      const servers: unknown = Reflect.get(effective.lsp, language);
      if (Array.isArray(servers) && servers.length === 1) {
        const entry: unknown = servers[0];
        if (entry && typeof entry === "object" && "command" in entry && entry.command === owned.command
          && "enabled" in entry && entry.enabled === true && "args" in entry && Array.isArray(entry.args)) {
          const args: unknown[] = entry.args;
          if (args.length === owned.args.length && owned.args.every((arg, index) => args[index] === arg)) {
            return { kind: "managed" as const, description: `${language} uses this plugin's detected server.` };
          }
        }
      }
    }
    return result;
  }

  private absolute(path: string, root: string): string {
    return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path) ? path : editor.pathJoin(root, path);
  }

  private workspaceDirectory(root: string): string {
    const identity = canonical(root);
    let fnv = 2166136261, djb = 5381;
    for (let index = 0; index < identity.length; index++) {
      const code = identity.charCodeAt(index);
      fnv = Math.imul(fnv ^ code, 16777619);
      djb = Math.imul(djb, 33) ^ code;
    }
    const key = (fnv >>> 0).toString(16).padStart(8, "0") + (djb >>> 0).toString(16).padStart(8, "0");
    // Equinox repeatedly decodes configuration URLs. Fresh's percent-escaped
    // Windows workdir names are unsafe; keep plugin caches under an opaque key.
    const directory = editor.pathJoin(editor.getDataDir(), "fresh-android", "workspaces", key);
    const marker = editor.pathJoin(directory, "workspace-root");
    const exists = editor.fileExists(marker);
    if (exists && editor.readFile(marker) !== identity) throw new Error(`Workspace cache identity mismatch: ${directory}`);
    if (!exists && (!editor.createDir(directory) || !editor.replaceFile(marker, identity))) throw new Error(`Cannot create workspace cache: ${directory}`);
    return directory;
  }

  private pathCandidates(names: string[], platform: LspPlatform): string[] {
    const paths = (editor.getEnv("PATH") || "").split(platform.os === "windows" ? ";" : ":").filter(Boolean);
    const result: string[] = [];
    for (const dir of paths) for (const name of names) {
      const full = editor.pathJoin(dir.replace(/^"|"$/g, ""), name);
      if (editor.fileExists(full)) result.push(full);
    }
    return result;
  }

  private kotlinLauncher(path: string, platform: LspPlatform): string | undefined {
    if (!editor.fileExists(path)) return undefined;
    const file = editor.pathBasename(path);
    if (/^(?:intellij-server(?:\.exe)?|kotlin-lsp(?:\.sh|\.cmd|\.bat|\.exe)?)$/i.test(file)) return path;
    for (const relative of platform.os === "windows"
      ? ["bin/intellij-server.exe", "kotlin-lsp.cmd", "kotlin-lsp.bat"]
      : ["bin/intellij-server", "MacOS/intellij-server", "Contents/MacOS/intellij-server", "Contents/bin/intellij-server", "kotlin-lsp.sh"]) {
      const candidate = editor.pathJoin(path, relative);
      if (editor.fileExists(candidate)) return candidate;
    }
    return undefined;
  }

  private async kotlin(root: string, platform: LspPlatform, consent: LspConsent): Promise<Launch | undefined> {
    const explicit = this.options.settings().kotlinLspPath.trim();
    if (explicit) {
      const command = this.kotlinLauncher(this.absolute(explicit, root), platform);
      if (!command) throw new Error("kotlinLspPath must name a Kotlin LSP launcher or its extracted directory");
      return { command, args: ["--stdio"], origin: "kotlinLspPath" };
    }
    const env = editor.getEnv("KOTLIN_LSP_DIR");
    if (env) {
      const command = this.kotlinLauncher(env, platform);
      if (command) return { command, args: ["--stdio"], origin: "KOTLIN_LSP_DIR" };
    }
    const names = platform.os === "windows" ? ["kotlin-lsp.exe", "kotlin-lsp.cmd", "kotlin-lsp.bat", "intellij-server.exe"] : ["kotlin-lsp", "kotlin-lsp.sh", "intellij-server"];
    const existing = this.pathCandidates(names, platform)[0];
    if (existing) return { command: existing, args: ["--stdio"], origin: "PATH" };
    const install = installedComponent("kotlin", platform, this.storeRoot)
      || await installComponent("kotlin", platform, this.storeRoot, consent, this.options.report);
    if (!install) return undefined;
    const command = this.kotlinLauncher(install.root, platform);
    if (!command) throw new Error("Installed Kotlin LSP has no supported launcher");
    return { command, args: ["--stdio"], origin: `managed Kotlin LSP ${install.version}` };
  }

  private async javaRuntime(root: string, platform: LspPlatform, consent?: LspConsent): Promise<JavaRuntime | undefined> {
    this.javaNotes = [];
    const executable = platform.os === "windows" ? "java.exe" : "java";
    const compiler = platform.os === "windows" ? "javac.exe" : "javac";
    const explicit = this.options.settings().lspJavaHome.trim();
    const roots: string[] = [];
    if (explicit) roots.push(this.absolute(explicit, root));
    else {
      for (const name of ["JAVA_HOME", "JDK_HOME"]) { const home = editor.getEnv(name); if (home) roots.push(home); }
      for (const binary of this.pathCandidates([executable], platform)) roots.push(editor.pathDirname(editor.pathDirname(binary)));
      const home = editor.getEnv("HOME") || editor.getEnv("USERPROFILE") || "";
      const vendorDirs = platform.os === "windows"
        ? [editor.pathJoin(editor.getEnv("ProgramFiles") || "C:/Program Files", "Java"), editor.pathJoin(editor.getEnv("ProgramFiles") || "C:/Program Files", "Eclipse Adoptium"), editor.pathJoin(editor.getEnv("ProgramFiles") || "C:/Program Files", "Microsoft")]
        : platform.os === "mac" ? ["/Library/Java/JavaVirtualMachines"] : ["/usr/lib/jvm", "/usr/java", "/opt/java"];
      vendorDirs.push(editor.pathJoin(home, ".jdks"), editor.pathJoin(home, ".gradle", "jdks"));
      for (const dir of vendorDirs) if (editor.fileExists(dir)) {
        for (const entry of editor.readDir(dir).filter(e => e.is_dir)) {
          const candidate = editor.pathJoin(dir, entry.name);
          roots.push(candidate, editor.pathJoin(candidate, "Contents", "Home"));
        }
      }
      if (platform.os === "windows") roots.push(editor.pathJoin(editor.getEnv("ProgramFiles") || "C:/Program Files", "Android", "Android Studio", "jbr"));
      else if (platform.os === "mac") roots.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home", "/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home");
      else roots.push("/opt/android-studio/jbr", editor.pathJoin(home, ".sdkman", "candidates", "java", "current"));
      const managed = installedComponent("jdk", platform, this.storeRoot);
      if (managed) roots.push(managed.root);
    }
    const seen = new Set<string>();
    for (const home of roots) {
      if (seen.has(canonical(home))) continue;
      seen.add(canonical(home));
      const command = editor.pathJoin(home, "bin", executable);
      if (!editor.fileExists(command)) continue;
      try {
        const result = await this.checked(command, ["-XshowSettings:properties", "-version"], root);
        const runtime = parseJavaRuntime(result.stdout + "\n" + result.stderr);
        if (!runtime) { this.javaNotes.push(`${home}: JVM did not report java.home/version`); continue; }
        if (runtime.major < 25) { this.javaNotes.push(`${runtime.home}: Java ${runtime.major} (pinned JDT LS requires 25+)`); continue; }
        if (!editor.fileExists(editor.pathJoin(runtime.home, "bin", compiler))) { this.javaNotes.push(`${runtime.home}: runtime only, no javac`); continue; }
        return { command: editor.pathJoin(runtime.home, "bin", executable), ...runtime };
      } catch (error) { this.javaNotes.push(`${home}: ${String(error)}`); }
    }
    if (explicit) throw new Error(`lspJavaHome must be a working JDK 25+: ${this.javaNotes.join("; ") || explicit}`);
    if (!consent) return undefined;
    const installed = await installComponent("jdk", platform, this.storeRoot, consent, this.options.report);
    if (!installed) return undefined;
    const command = editor.pathJoin(installed.root, "bin", executable);
    const result = await this.checked(command, ["-XshowSettings:properties", "-version"], root);
    const runtime = parseJavaRuntime(result.stdout + "\n" + result.stderr);
    if (!runtime || runtime.major < 25 || !editor.fileExists(editor.pathJoin(runtime.home, "bin", compiler))) throw new Error("Managed JDK did not pass the JDK 25+ runtime check");
    return { command, ...runtime };
  }

  private jdtRoot(path: string, platform: LspPlatform): string | undefined {
    const base = platform.os === "windows" ? "config_win" : platform.os === "mac" ? "config_mac" : "config_linux";
    const configuration = base + (platform.arch === "aarch64" ? "_arm" : "");
    for (const candidate of [path, editor.pathDirname(path), editor.pathDirname(editor.pathDirname(path)), editor.pathJoin(path, "libexec"), editor.pathJoin(path, "share", "java", "jdtls")]) {
      if (editor.fileExists(editor.pathJoin(candidate, "plugins")) && editor.fileExists(editor.pathJoin(candidate, configuration, "config.ini"))) return candidate;
    }
    return undefined;
  }

  private async java(root: string, platform: LspPlatform, consent: LspConsent): Promise<Launch | undefined> {
    if (editor.getDataDir().includes("%")) throw new Error("JDT LS cannot safely use '%' in Fresh's data-directory path; configure Java LSP explicitly in Fresh with safe configuration/data paths");
    const explicit = this.options.settings().javaLspPath.trim();
    const env = editor.getEnv("JDTLS_HOME");
    let server = explicit ? this.jdtRoot(this.absolute(explicit, root), platform) : env ? this.jdtRoot(env, platform) : undefined;
    if (explicit && !server) throw new Error("javaLspPath must name an extracted JDT LS directory with plugins and the platform config directory");
    const names = platform.os === "windows" ? ["jdtls.exe", "jdtls.cmd", "jdtls.bat"] : ["jdtls"];
    const pathLauncher = !server ? this.pathCandidates(names, platform)[0] : undefined;
    if (pathLauncher) server = this.jdtRoot(pathLauncher, platform);
    const managed = !server && !pathLauncher ? installedComponent("jdtls", platform, this.storeRoot) : undefined;
    if (managed) server = managed.root;
    let installedVersion = managed?.version || "external";
    const java = await this.javaRuntime(root, platform, consent);
    if (!java) return undefined;
    if (!server && !pathLauncher) {
      const installed = await installComponent("jdtls", platform, this.storeRoot, consent, this.options.report);
      if (!installed) return undefined;
      server = installed.root;
      installedVersion = installed.version;
    }
    const workspace = editor.pathJoin(this.workspaceDirectory(root), "jdtls");
    if (!editor.createDir(workspace)) throw new Error(`Cannot create JDT LS workspace: ${workspace}`);
    const data = editor.pathJoin(workspace, "data");
    if (!server && pathLauncher) {
      // The upstream jdtls wrapper locates its own Equinox distribution. Set
      // JAVA_HOME for that process only; never modify the editor/global PATH.
      if (platform.os !== "windows") return { command: "env", args: [`JAVA_HOME=${java.home}`, pathLauncher, "-data", data], origin: "PATH jdtls wrapper" };
      this.options.invocation(pathLauncher, [java.home]); // validate batch metacharacters using the shared policy
      if (/["%!&|<>^\r\n]/.test(java.home + pathLauncher)) throw new Error("Unsupported metacharacters in Windows JDT LS/JDK path");
      const wrapper = editor.pathJoin(workspace, "launch-jdtls.cmd");
      const text = `@echo off\r\nset "JAVA_HOME=${java.home}"\r\ncall "${pathLauncher}" %*\r\n`;
      if (!editor.replaceFile(wrapper, text)) throw new Error("Cannot create process-local JDT LS launcher");
      return { command: wrapper, args: ["-data", data], origin: "PATH jdtls wrapper" };
    }
    if (!server) throw new Error("JDT LS distribution was not found");
    const jars = editor.readDir(editor.pathJoin(server, "plugins")).filter(e => e.is_file && /^org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(e.name));
    if (jars.length !== 1) throw new Error(`Expected one Equinox launcher in ${server}; found ${jars.length}`);
    const base = platform.os === "windows" ? "config_win" : platform.os === "mac" ? "config_mac" : "config_linux";
    const configuration = base + (platform.arch === "aarch64" ? "_arm" : "");
    const source = editor.pathJoin(server, configuration);
    const destination = editor.pathJoin(workspace, `config-${installedVersion}-${configuration}`);
    const ini = editor.readFile(editor.pathJoin(source, "config.ini"));
    if (!ini) throw new Error("JDT LS configuration has no config.ini");
    if (editor.readFile(editor.pathJoin(destination, "config.ini")) !== ini) {
      if (!editor.createDir(destination) || !editor.replaceFile(editor.pathJoin(destination, "config.ini"), ini)) throw new Error("Cannot initialize private JDT LS config.ini");
    }
    return {
      command: java.command,
      args: ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Xmx1G", "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED", "-jar", editor.pathJoin(server, "plugins", jars[0].name), "-configuration", editor.pathToFileUri(destination), "-data", editor.pathToFileUri(data)],
      origin: `${explicit ? "javaLspPath" : env && server ? "JDTLS_HOME" : managed || installedVersion !== "external" ? "managed JDT LS" : "PATH"}; JDK ${java.major} at ${java.home}`,
    };
  }

  async setup(languages: LspLanguage[]): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const root = this.options.root();
    try {
      this.assertContext(root);
      for (const language of languages) {
        const before = this.decision(language);
        if (before.kind === "user" || before.kind === "disabled") {
          this.states[language] = before.description;
          this.options.report(`${language}: ${before.description}`);
          continue;
        }
        const consent: LspConsent = async message => {
          this.assertContext(root);
          const accepted = await this.options.consent(message);
          this.assertContext(root);
          // A user may have configured/disabled LSP while reading the prompt.
          const current = this.decision(language);
          return accepted && current.kind !== "user" && current.kind !== "disabled";
        };
        try {
          const platform = await this.hostPlatform(root);
          const launch = language === "kotlin" ? await this.kotlin(root, platform, consent) : await this.java(root, platform, consent);
          if (!launch) { this.states[language] = "Installation cancelled; existing configuration left unchanged"; continue; }
          this.assertContext(root);
          const current = this.decision(language);
          if (current.kind === "user" || current.kind === "disabled") { this.states[language] = current.description; continue; }
          if (language === "kotlin" && /(?:^|[\\/])intellij-server(?:\.exe)?$/i.test(launch.command)) {
            const cache = editor.pathJoin(this.workspaceDirectory(root), "kotlin");
            if (!editor.createDir(cache)) throw new Error("Cannot create Kotlin LSP workspace cache");
            launch.args.push(`--system-path=${cache}`, "--data-sharing=none");
          }
          const [command, ...args] = this.options.invocation(launch.command, launch.args);
          if (!editor.registerLspServer(language, { command, args, autoStart: true, initializationOptions: null, processLimits: null })) throw new Error("Fresh refused the LSP registration");
          this.registrations[language] = { command, args };
          await editor.flush();
          this.assertContext(root);
          editor.setLspRootUri(language, editor.pathToFileUri(root));
          editor.restartLspForLanguage(language);
          this.states[language] = `Registered with auto-start (${launch.origin}): ${command} ${args.join(" ")}`;
          delete this.errors[language];
          this.options.report(`${language}: configured; Fresh is starting the server`);
        } catch (error) {
          this.states[language] = String(error);
          this.options.report(`${language} LSP: ${String(error)}`);
          editor.debug(`[Android LSP] ${language}: ${String(error)}`);
        }
      }
    } finally { this.inFlight = false; }
  }

  async automatic(): Promise<void> {
    if (!this.options.settings().autoSetupLsp || this.inFlight || editor.workspaceTrustLevel() !== "trusted" || editor.getAuthorityLabel()) return;
    const root = this.options.root();
    const languages = new Set<LspLanguage>();
    for (const buffer of editor.listBuffers()) {
      if (buffer.is_virtual) continue;
      const path = editor.getBufferPath(buffer.id);
      const language = /\.kts?$/i.test(path) ? "kotlin" : /\.java$/i.test(path) ? "java" : undefined;
      if (!language) continue;
      const key = `${canonical(root)}:${language}`;
      if (this.attempted.has(key)) continue;
      this.attempted.add(key);
      languages.add(language);
    }
    if (languages.size) await this.setup([...languages]);
  }

  resetAutomatic(): void {
    this.attempted.clear();
  }

  recordError(language: string, message: string): void {
    if (language === "kotlin" || language === "java") this.errors[language] = message;
  }

  async diagnostics(): Promise<string[]> {
    const rows = ["\nLanguage servers", `Automatic setup: ${this.options.settings().autoSetupLsp ? "enabled" : "disabled"}`, `Managed downloads: ${this.storeRoot}`];
    for (const language of ["kotlin", "java"] as const) {
      const decision = this.decision(language);
      rows.push(`${language}: ${decision.kind === "user" || decision.kind === "disabled" ? decision.description : this.states[language] || decision.description}`);
      if (this.errors[language]) rows.push(`${language} last server error: ${this.errors[language]}`);
    }
    if (editor.workspaceTrustLevel() !== "trusted" || editor.getAuthorityLabel()) rows.push("JDK detection/setup requires a trusted local workspace; remote LSP configuration is left to Fresh.");
    else {
      try {
        const root = this.options.root();
        const java = await this.javaRuntime(root, await this.hostPlatform(root));
        rows.push(java ? `Java server JDK: ${java.major} — ${java.home}` : "Java server JDK: no working JDK 25+ found (Setup LSP can install a portable JDK)");
        rows.push(...this.javaNotes);
      } catch (error) { rows.push(`JDK detection: ${String(error)}`); }
    }
    rows.push("Registration is not a readiness claim. See Fresh's language-server status for indexing/startup errors.");
    return rows;
  }
}
