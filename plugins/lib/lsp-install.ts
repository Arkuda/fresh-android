import type { LspComponent, LspConsent, LspInstallation, LspPlatform, LspReport } from "./lsp-types.ts";
import { pinnedRelease, type LspRelease } from "./lsp-releases.ts";

const markerName = ".fresh-android-complete";
const join = (...parts: string[]): string => editor.pathJoin(...parts);
// Git/MSYS tar can shadow the native tool and treats C: as a remote host.
const windowsTool = (name: string): string => join(editor.getEnv("SystemRoot") || "C:/Windows", "System32", name);

function requireTrustedLocal(): void {
  if (editor.workspaceTrustLevel() !== "trusted") throw new Error("Trust this workspace before installing or probing language-server tools");
  if (editor.getAuthorityLabel() !== "") throw new Error("Automatic language-server setup supports local workspaces only");
}

// Check on both sides of every await: an authority/trust change must not allow
// a later host process to run or publish the result of an earlier operation.
async function run(program: string, args: string[], cwd?: string): Promise<FreshSpawnResult> {
  requireTrustedLocal();
  const result = await editor.spawnProcess(program, args, cwd);
  requireTrustedLocal();
  if (result.exit_code !== 0) throw new Error(`${program} failed (exit ${result.exit_code}): ${(result.stderr || result.stdout).trim()}`);
  return result;
}

function architecture(value: string): LspPlatform["arch"] {
  switch (value.trim().toLowerCase()) {
    case "amd64": case "x86_64": case "x64": return "x64";
    case "arm64": case "aarch64": return "aarch64";
    default: throw new Error(`Unsupported language-server architecture: ${value || "unknown"}`);
  }
}

export async function detectLspPlatform(): Promise<LspPlatform> {
  requireTrustedLocal();
  if (editor.getEnv("OS")?.toLowerCase() === "windows_nt") {
    return { os: "windows", arch: architecture(editor.getEnv("PROCESSOR_ARCHITEW6432") || editor.getEnv("PROCESSOR_ARCHITECTURE") || "") };
  }
  const system = (await run("uname", ["-s"])).stdout.trim();
  const os = system === "Darwin" ? "mac" : system === "Linux" ? "linux" : undefined;
  if (!os) throw new Error(`Unsupported language-server operating system: ${system || "unknown"}`);
  return { os, arch: architecture((await run("uname", ["-m"])).stdout) };
}

function destination(component: LspComponent, platform: LspPlatform, storeRoot: string, release: LspRelease): string {
  if (/[\x00-\x1f]/.test(storeRoot) || !(platform.os === "windows" ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(storeRoot) : storeRoot.startsWith("/"))) {
    throw new Error("Language-server storage must be an absolute local filesystem path");
  }
  return join(storeRoot, `${component}-${release.version}-${platform.os}-${platform.arch}`);
}

function isFile(path: string): boolean {
  return editor.readDir(editor.pathDirname(path)).some(entry => entry.name === editor.pathBasename(path) && entry.is_file);
}

function isDirectory(path: string): boolean {
  return editor.readDir(editor.pathDirname(path)).some(entry => entry.name === editor.pathBasename(path) && entry.is_dir);
}

function executable(component: LspComponent, platform: LspPlatform, root: string): string | undefined {
  if (component === "jdk") return join(root, "bin", platform.os === "windows" ? "java.exe" : "java");
  if (component !== "kotlin") return undefined;
  const bin = join(root, "bin", platform.os === "windows" ? "intellij-server.exe" : "intellij-server");
  if (isFile(bin)) return bin;
  return platform.os === "mac" ? join(root, "MacOS", "intellij-server") : bin;
}

function validPayload(component: LspComponent, platform: LspPlatform, root: string): boolean {
  if (component === "jdtls") {
    const config = `config_${platform.os === "windows" ? "win" : platform.os}${platform.arch === "aarch64" ? "_arm" : ""}`;
    return isDirectory(join(root, config)) && editor.readDir(join(root, "plugins")).some(entry =>
      entry.is_file && /^org\.eclipse\.equinox\.launcher_[^/\\]+\.jar$/.test(entry.name));
  }
  const program = executable(component, platform, root);
  if (!program || !isFile(program)) return false;
  if (component === "kotlin") return isDirectory(join(root, "lib"));
  const release = editor.readFile(join(root, "release"));
  return isFile(join(root, "bin", platform.os === "windows" ? "javac.exe" : "javac")) &&
    release !== null && /^JAVA_VERSION="25\./m.test(release);
}

function safeRelativePath(path: string, allowRoot = false): boolean {
  if (allowRoot && path === ".") return true;
  // Backslash is also a separator on Windows; colon rejects drive and ADS paths.
  // Control characters make line-oriented archive listings ambiguous.
  if (!path || /^[\\/]/.test(path) || /[\\:\x00-\x1f\x7f]/.test(path)) return false;
  return path.split("/").every(part => part !== ".." && (part === "." || !/[ .]$/.test(part)) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function installedComponent(component: LspComponent, platform: LspPlatform, storeRoot: string): LspInstallation | undefined {
  requireTrustedLocal();
  const release = pinnedRelease(component, platform);
  const directory = destination(component, platform, storeRoot, release);
  const marker = editor.readFile(join(directory, markerName));
  if (!marker) return undefined;
  const fields = marker.split("\n");
  if (fields.length !== 4 || fields[0] !== release.version || fields[1] !== release.sha256 || fields[3] !== "" || !safeRelativePath(fields[2], true)) return undefined;
  const root = fields[2] === "." ? directory : join(directory, fields[2]);
  return validPayload(component, platform, root) ? { component, version: release.version, root } : undefined;
}

function payloadRoots(directory: string): string[] {
  const candidates = [".", "Contents", "Contents/Home"];
  // Official archives have either a flat payload or one top-level folder/.app.
  for (const entry of editor.readDir(directory)) {
    if (entry.is_dir && safeRelativePath(entry.name) && !entry.name.includes("/")) {
      candidates.push(entry.name, `${entry.name}/Contents`, `${entry.name}/Contents/Home`);
    }
  }
  return candidates;
}

async function verifyChecksum(platform: LspPlatform, archive: string, expected: string): Promise<void> {
  const result = platform.os === "windows"
    ? await run(windowsTool("certutil.exe"), ["-hashfile", archive, "SHA256"])
    : platform.os === "mac"
      ? await run("shasum", ["-a", "256", archive])
      : await run("sha256sum", [archive]);
  // certutil's surrounding text is localized; the digest line is not.
  const hashes = result.stdout.split(/\r?\n/).map(line => line.trim().match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase()).filter(value => value !== undefined);
  if (hashes.length !== 1 || hashes[0] !== expected) throw new Error("Language-server archive SHA-256 mismatch; nothing was extracted");
}

async function extractArchive(release: LspRelease, platform: LspPlatform, archive: string, directory: string): Promise<void> {
  const useUnzip = release.archive === "zip" && platform.os !== "windows";
  const listing = useUnzip ? await run("unzip", ["-Z1", archive]) : await run(platform.os === "windows" ? windowsTool("tar.exe") : "tar", ["-tf", archive]);
  const members = listing.stdout.replace(/\r\n/g, "\n").split("\n");
  if (members[members.length - 1] === "") members.pop();
  if (!members.length || members.some(member => !safeRelativePath(member))) throw new Error("Archive contains unsafe or unreadable member paths; nothing was extracted");
  if (members.some(member => member.split("/").includes(markerName))) throw new Error("Archive contains a reserved installation marker");
  requireTrustedLocal();
  if (!editor.createDir(directory)) throw new Error(`Cannot create language-server installation directory: ${directory}`);
  if (useUnzip) await run("unzip", ["-q", "-o", archive, "-d", directory]);
  else await run(platform.os === "windows" ? windowsTool("tar.exe") : "tar", ["-xf", archive, "-C", directory]);
}

export async function installComponent(
  component: LspComponent, platform: LspPlatform, storeRoot: string, consent: LspConsent, report: LspReport,
): Promise<LspInstallation | undefined> {
  requireTrustedLocal();
  const existing = installedComponent(component, platform, storeRoot);
  if (existing) return existing;
  const release = pinnedRelease(component, platform);
  const directory = destination(component, platform, storeRoot, release);
  const tools = platform.os === "windows" ? "curl.exe, tar.exe and certutil.exe" : platform.os === "mac" ? "curl, tar, unzip (Kotlin), shasum and chmod" : "curl, tar, sha256sum and chmod";
  const accepted = await consent(`Download and install ${component} ${release.version} (${platform.os}/${platform.arch})?\nSource: ${release.source}\nLicense: ${release.license}\nArchive: ${release.url}\nSHA-256: ${release.sha256}\nDestination: ${directory}\nRequires: ${tools}. No global installation, PATH or JAVA_HOME changes.`);
  requireTrustedLocal();
  if (!accepted) { report(`${component} installation cancelled; no download performed`); return undefined; }
  const token = editor.scratchCreate(`fresh-android-${component}`);
  if (!token) throw new Error("Fresh could not create native download staging storage");
  try {
    const staging = editor.scratchPath(token);
    if (!staging) throw new Error("Fresh download staging storage is unavailable");
    const archive = join(staging, release.url.slice(release.url.lastIndexOf("/") + 1));
    requireTrustedLocal();
    report(`Downloading ${component} ${release.version} from ${release.source}`);
    // Fresh's HTTP bridge caps bodies at 64 MiB; Kotlin/JDK archives exceed it.
    // curl streams bytes to staging, never through the editor's text API.
    const downloaded = await editor.spawnProcess(platform.os === "windows" ? windowsTool("curl.exe") : "curl", [
      "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--silent", "--show-error", "--output", archive, release.url,
    ]);
    requireTrustedLocal();
    if (downloaded.exit_code !== 0) throw new Error(`Download failed (curl exit ${downloaded.exit_code}): ${downloaded.stderr}`);
    await verifyChecksum(platform, archive, release.sha256);
    requireTrustedLocal();
    const completed = installedComponent(component, platform, storeRoot);
    if (completed) return completed;
    const marker = join(directory, markerName);
    // Each extraction has an immutable payload path. Another Fresh process
    // installing the same version cannot overwrite binaries already in use.
    const payload = `payload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const payloadDirectory = join(directory, payload);
    report(`Extracting verified ${component} archive`);
    await extractArchive(release, platform, archive, payloadDirectory);
    const relative = payloadRoots(payloadDirectory).find(candidate => validPayload(component, platform, candidate === "." ? payloadDirectory : join(payloadDirectory, candidate)));
    if (relative === undefined) throw new Error(`Extracted ${component} archive has no complete ${platform.os}/${platform.arch} executable payload`);
    const root = relative === "." ? payloadDirectory : join(payloadDirectory, relative);
    const program = executable(component, platform, root);
    if (platform.os !== "windows" && program) {
      const programs = component === "jdk" ? [program, join(root, "bin", "javac")] : [program];
      await run("chmod", ["u+x", ...programs]);
    }
    requireTrustedLocal();
    const content = `${release.version}\n${release.sha256}\n${payload}${relative === "." ? "" : `/${relative}`}\n`;
    const published = editor.fileExists(marker) ? editor.replaceFile(marker, content) : editor.writeFile(marker, content);
    if (!published) throw new Error("Could not publish completed language-server installation marker");
    report(`Installed ${component} ${release.version}: ${root}`);
    return { component, version: release.version, root };
  } finally {
    if (!editor.scratchDiscard(token)) report(`Fresh could not discard ${component} download staging storage`);
  }
}
