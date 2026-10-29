// Pure Android/Gradle parsing. No editor, Node, shell, or filesystem dependencies.
export type Device = { serial: string; state: string; description: string };
export type Target = { module: string; variant: string; assemble: string };
export type ApkMetadata = { applicationId: string; variantName: string; elements: Array<{ outputFile: string; filters?: Array<{ filterType: string; value: string }> }> };

export function parseDevices(output: string): Device[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)\b\s*(.*)$/.exec(line.trim());
    return match ? [{ serial: match[1], state: match[2], description: match[3].replace(/_/g, " ") }] : [];
  });
}

// Install tasks identify application variants; assemble-only library/test tasks aren't runnable apps.
export function parseTargets(output: string): Target[] {
  const targets = new Map<string, Target>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([\w.:-]*:)?install([A-Z][\w]*)\s+-\s/.exec(line);
    if (!match || /AndroidTest$/.test(match[2])) continue;
    const module = (match[1] || ":").replace(/:$/, "");
    const prefix = module ? `${module.replace(/^:/, "")}:` : "";
    const variant = match[2][0].toLowerCase() + match[2].slice(1);
    targets.set(`${module}:${variant}`, { module: module ? `:${module.replace(/^:/, "")}` : ":", variant, assemble: `${prefix}assemble${match[2]}` });
  }
  return [...targets.values()];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMetadata(text: string): ApkMetadata {
  const data: unknown = JSON.parse(text);
  if (!record(data) || typeof data.applicationId !== "string" || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(data.applicationId) || typeof data.variantName !== "string" || !Array.isArray(data.elements) || data.elements.length === 0) {
    throw new Error("Invalid Android Gradle Plugin output-metadata.json");
  }
  const elements = data.elements.map((item: unknown) => {
    if (!record(item) || typeof item.outputFile !== "string" || !/^[^/\\]+\.apk$/i.test(item.outputFile) || item.outputFile.includes("..")) {
      throw new Error("APK metadata must reference an APK in its own directory");
    }
    if (item.filters !== undefined && !Array.isArray(item.filters)) throw new Error("Invalid APK output filters");
    const filters = (item.filters || []).map((filter: unknown) => {
      if (!record(filter) || typeof filter.filterType !== "string" || typeof filter.value !== "string") throw new Error("Invalid APK output filter");
      return { filterType: filter.filterType, value: filter.value };
    });
    return { outputFile: item.outputFile, ...(item.filters !== undefined ? { filters } : {}) };
  });
  return { applicationId: data.applicationId, variantName: data.variantName, elements };
}

export function localSdkPath(text: string): string | undefined {
  const line = text.split(/\r?\n/).find(l => /^\s*sdk\.dir\s*[=:]/.test(l));
  return line?.replace(/^\s*sdk\.dir\s*[=:]\s*/, "").replace(/\\([\\:= ])/g, "$1").trim() || undefined;
}

export function gradleArgs(input: string): string[] {
  const args = input.trim().split(/\s+/).filter(Boolean);
  // Batch files on Windows pass through cmd.exe; never allow shell metacharacters.
  if (!args.length || args.some(arg => !/^[\w:.=,+/@-]+$/.test(arg))) {
    throw new Error("Use space-separated Gradle tasks/options without quotes or shell metacharacters");
  }
  return args;
}

export function launcherComponent(output: string, applicationId: string): string {
  const component = output.split(/\r?\n/).map(l => l.trim()).find(l => /^[\w.$]+\/[\w.$]+$/.test(l));
  if (!component || component.split("/")[0] !== applicationId) throw new Error(`No launcher activity for ${applicationId}`);
  return component;
}
