import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { installComponent, installedComponent } from "../plugins/lib/lsp-install.ts";
import { pinnedRelease } from "../plugins/lib/lsp-releases.ts";

const platform = { os: "linux", arch: "x64" } as const;
function probe(options: { cancel?: boolean; revoke?: "consent" | "download"; digest?: string; member?: string; downloadStatus?: number; marker?: string; remote?: boolean } = {}) {
  let trusted = true;
  let downloads = 0, scratch = 0, discarded = 0, published = 0;
  const processes: Array<{ program: string; args: string[] }> = [];
  const directories: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "editor");
  const bridge = {
    workspaceTrustLevel: () => trusted ? "trusted" : "restricted",
    getAuthorityLabel: () => options.remote ? "SSH:test" : "",
    pathJoin: (...parts: string[]) => path.posix.join(...parts),
    pathDirname: path.posix.dirname,
    pathBasename: path.posix.basename,
    readFile: () => options.marker || null,
    fileExists: () => false,
    scratchCreate: () => { scratch++; return "staging"; },
    scratchPath: () => "/tmp/fresh-staging",
    scratchDiscard: () => { discarded++; return true; },
    createDir: (directory: string) => { directories.push(directory); return true; },
    writeFile: () => { published++; return true; },
    replaceFile: () => { published++; return true; },
    spawnProcess: async (program: string, args: string[]) => {
      processes.push({ program, args });
      if (program === "curl") {
        downloads++;
        if (options.revoke === "download") trusted = false;
        return { exit_code: options.downloadStatus || 0, stdout: "", stderr: "download failure" };
      }
      return { exit_code: 0, stdout: program === "sha256sum" ? `${options.digest || pinnedRelease("jdtls", platform).sha256}  archive\n` : `${options.member || "../escape"}\n`, stderr: "" };
    },
  };
  Object.defineProperty(globalThis, "editor", { value: bridge, configurable: true });
  return {
    run: () => installComponent("jdtls", platform, "/fresh-owned", async () => {
      if (options.revoke === "consent") trusted = false;
      return !options.cancel;
    }, () => {}),
    stats: () => ({ downloads, scratch, discarded, published, processes, directories }),
    restore: () => { if (descriptor) Object.defineProperty(globalThis, "editor", descriptor); else Reflect.deleteProperty(globalThis, "editor"); },
  };
}

test("declining an install never downloads, executes a helper, or creates staging storage", async () => {
  const p = probe({ cancel: true });
  try {
    assert.equal(await p.run(), undefined);
    assert.deepEqual(p.stats(), { downloads: 0, scratch: 0, discarded: 0, published: 0, processes: [], directories: [] });
  } finally { p.restore(); }
});

test("trust revoked during confirmation prevents the download", async () => {
  const p = probe({ revoke: "consent" });
  try {
    await assert.rejects(p.run(), /Trust/);
    assert.equal(p.stats().downloads, 0);
    assert.equal(p.stats().scratch, 0);
  } finally { p.restore(); }
});

test("trust revoked during download prevents execution and discards staging", async () => {
  const p = probe({ revoke: "download" });
  try {
    await assert.rejects(p.run(), /Trust/);
    assert.equal(p.stats().processes.some(c => c.program !== "curl"), false);
    assert.equal(p.stats().published, 0);
    assert.equal(p.stats().discarded, 1);
  } finally { p.restore(); }
});

test("checksum mismatch cannot extract or publish an executable installation", async () => {
  const p = probe({ digest: "0".repeat(64) });
  try {
    await assert.rejects(p.run(), /SHA-256/);
    assert.equal(p.stats().processes.some(c => c.program === "tar"), false);
    assert.deepEqual(p.stats().directories, []);
    assert.equal(p.stats().published, 0);
    assert.equal(p.stats().discarded, 1);
  } finally { p.restore(); }
});

test("absolute and traversing archive members cannot write outside the managed directory", async () => {
  for (const member of ["../escape", "/absolute/file", "C:/outside/file", "safe/../../escape"]) {
    const p = probe({ member });
    try {
      await assert.rejects(p.run(), /unsafe/);
      assert.equal(p.stats().processes.some(c => c.args.includes("-xf")), false);
      assert.deepEqual(p.stats().directories, []);
      assert.equal(p.stats().published, 0);
      assert.equal(p.stats().discarded, 1);
    } finally { p.restore(); }
  }
});

test("HTTP failure discards staging without publishing a partial install", async () => {
  const p = probe({ downloadStatus: 503 });
  try {
    await assert.rejects(p.run(), /Download failed/);
    assert.equal(p.stats().processes.some(c => c.program !== "curl"), false);
    assert.equal(p.stats().published, 0);
    assert.equal(p.stats().discarded, 1);
  } finally { p.restore(); }
});

test("remote authority is never allowed to install host language servers", async () => {
  const p = probe({ remote: true });
  try {
    await assert.rejects(p.run(), /local/);
    assert.equal(p.stats().downloads, 0);
    assert.equal(p.stats().scratch, 0);
  } finally { p.restore(); }
});

test("a forged completion marker cannot redirect payload discovery outside managed storage", () => {
  const release = pinnedRelease("jdtls", platform);
  const p = probe({ marker: `${release.version}\n${release.sha256}\n../../outside\n` });
  try { assert.equal(installedComponent("jdtls", platform, "/fresh-owned"), undefined); }
  finally { p.restore(); }
});
