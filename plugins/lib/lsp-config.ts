// Pure configuration policy and Java property parsing; no editor or filesystem access.
import type { LspLanguage } from "./lsp-types.ts";

type ConfigDecision = { kind: "disabled" | "user" | "default" | "managed"; description: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => owns(value, key));
}

// A familiar command alone is not evidence that an effective entry is Fresh's default.
function freshDefault(entry: Record<string, unknown>, language: LspLanguage): boolean {
  if (!keysAre(entry, ["command", "enabled", "name", "args", "auto_start", "root_markers", "env", "language_id_overrides", "initialization_options", "only_features", "except_features", "process_limits"])) return false;
  const kotlin = language === "kotlin";
  const expectedArgs = kotlin ? ["--stdio"] : [];
  const expectedMarkers = kotlin ? ["settings.gradle.kts", "settings.gradle", "pom.xml", "workspace.json"] : ["pom.xml", "build.gradle", "build.gradle.kts", ".git"];
  const limits = entry.process_limits;
  const args = entry.args;
  const markers = entry.root_markers;
  return entry.command === (kotlin ? "kotlin-lsp" : "jdtls")
    && entry.enabled === true && entry.name === null && entry.auto_start === false
    && Array.isArray(args) && args.length === expectedArgs.length && expectedArgs.every((arg, index) => args[index] === arg)
    && Array.isArray(markers) && markers.length === expectedMarkers.length && expectedMarkers.every((marker, index) => markers[index] === marker)
    && record(entry.env) && keysAre(entry.env, []) && record(entry.language_id_overrides) && keysAre(entry.language_id_overrides, [])
    && entry.initialization_options === null && entry.only_features === null && entry.except_features === null
    && record(limits) && keysAre(limits, ["max_memory_percent", "max_cpu_percent", "enabled"])
    && limits.max_memory_percent === 50 && limits.max_cpu_percent === 90 && limits.enabled === false;
}

function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^(?:\\\\|\/\/)[^\\/]/.test(path);
}

function normalizedPath(path: string, windows: boolean): string | undefined {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) return undefined;
  if (windows) {
    if (!windowsPath(path)) return undefined;
    path = path.replace(/\\/g, "/").toLowerCase();
  } else if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return undefined;
  }
  path = path.replace(/\/+$/, "");
  const segments = path.split("/");
  // Reject ambiguous paths rather than claiming ownership through traversal or Win32 aliases.
  if (segments.some((segment, index) => segment === "." || segment === ".."
    || (windows && (/[. ]$/.test(segment) || /[<>"|?*]/.test(segment) || (segment.includes(":") && !(index === 0 && /^[a-z]:$/.test(segment))))))) return undefined;
  if (windows && path.startsWith("//") && segments.filter(Boolean).length < 2) return undefined;
  return path;
}

function managedPath(path: string, root: string): boolean {
  const windows = windowsPath(root);
  const normalizedRoot = normalizedPath(root, windows);
  const normalized = normalizedPath(path, windows);
  // A drive/filesystem root cannot be a plugin-owned namespace.
  return normalizedRoot !== undefined && normalized !== undefined
    && normalizedRoot !== "" && !/^[a-z]:$/.test(normalizedRoot)
    && normalized.startsWith(`${normalizedRoot}/`);
}

function managedEntry(entry: Record<string, unknown>, language: LspLanguage, root: string): boolean {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)
    || !entry.args.every((arg: unknown) => typeof arg === "string") || entry.enabled !== true) return false;
  const command = (entry.command.replace(/\\/g, "/").split("/").pop() || "").toLowerCase();
  if (language === "kotlin") {
    return /^(?:intellij-server(?:\.exe)?|kotlin-lsp(?:\.sh|\.bat|\.exe)?)$/.test(command) && managedPath(entry.command, root);
  }
  if (command !== "java" && command !== "java.exe") return false;
  if (managedPath(entry.command, root)) return true;
  const jar = entry.args.indexOf("-jar");
  if (jar < 0 || entry.args.lastIndexOf("-jar") !== jar) return false;
  const launcher: unknown = entry.args[jar + 1];
  return typeof launcher === "string" && /^org\.eclipse\.equinox\.launcher_[^/\\]+\.jar$/.test(launcher.replace(/\\/g, "/").split("/").pop() || "") && managedPath(launcher, root);
}

export function lspConfigDecision(effective: unknown, user: unknown, language: LspLanguage, managedRoot: string): ConfigDecision {
  if (record(effective) && effective.lsp_enabled === false) return { kind: "disabled", description: "LSP is globally disabled." };
  if (!record(user)) return { kind: "user", description: "User configuration is not a recognized object; preserving it." };
  if (owns(user, "lsp_enabled") && typeof user.lsp_enabled !== "boolean") return { kind: "user", description: "Unrecognized user LSP setting is preserved." };
  if (user.lsp_enabled === false) return { kind: "disabled", description: "LSP is disabled in user configuration." };
  if (owns(user, "lsp")) {
    if (!record(user.lsp)) return { kind: "user", description: "User LSP configuration is not a recognized object; preserving it." };
    if (owns(user.lsp, language)) return { kind: "user", description: `Explicit user ${language} configuration is preserved.` };
  }
  if (!record(effective)) return { kind: "user", description: "Effective configuration is not a recognized object; preserving it." };
  if (owns(effective, "lsp_enabled") && typeof effective.lsp_enabled !== "boolean") return { kind: "user", description: "Unrecognized global LSP setting is preserved." };
  if (!owns(effective, "lsp")) return { kind: "default", description: `No effective ${language} server is configured.` };
  if (!record(effective.lsp)) return { kind: "user", description: "Unrecognized effective LSP configuration is preserved." };
  if (!owns(effective.lsp, language)) return { kind: "default", description: `No effective ${language} server is configured.` };
  const servers: unknown = effective.lsp[language];
  if (servers === false) return { kind: "disabled", description: `The effective ${language} server is disabled.` };
  // Registration replaces the entire language list: even two managed entries must be preserved.
  if (!Array.isArray(servers) || servers.length !== 1 || !record(servers[0])) return { kind: "user", description: `Existing ${language} server configuration is preserved.` };
  const entry = servers[0];
  if (entry.enabled === false) return { kind: "disabled", description: `The effective ${language} server is disabled.` };
  if (managedEntry(entry, language, managedRoot)) return { kind: "managed", description: `${language} uses a plugin-managed server.` };
  if (freshDefault(entry, language)) return { kind: "default", description: `${language} uses Fresh's built-in default.` };
  return { kind: "user", description: `Existing custom ${language} server configuration is preserved.` };
}

function versionMajor(version: string): number | undefined {
  const match = /^(?:1\.([1-9]\d*)|([1-9]\d*))(?:[._+-][A-Za-z0-9._+-]+)?$/.exec(version);
  if (!match) return undefined;
  const major = Number(match[1] || match[2]);
  return Number.isSafeInteger(major) ? major : undefined;
}

export function parseJavaRuntime(output: string): { major: number; home: string } | undefined {
  let home: string | undefined;
  let specification: string | undefined;
  let version: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const property = /^\s*(java\.home|java\.specification\.version|java\.version)\s*=\s*(.*?)\s*$/.exec(line);
    if (!property) continue;
    const value = property[2];
    if (property[1] === "java.home") {
      if (home !== undefined && home !== value) return undefined;
      home = value;
    } else if (property[1] === "java.specification.version") {
      if (specification !== undefined && specification !== value) return undefined;
      specification = value;
    } else {
      if (version !== undefined && version !== value) return undefined;
      version = value;
    }
  }
  if (!home || /[\x00-\x1f\x7f]/.test(home)) return undefined;
  if (specification !== undefined && !/^(?:1\.)?[1-9]\d*$/.test(specification)) return undefined;
  const major = versionMajor(specification ?? version ?? "");
  if (major === undefined) return undefined;
  if (version !== undefined && versionMajor(version) !== major) return undefined;
  return { major, home };
}
