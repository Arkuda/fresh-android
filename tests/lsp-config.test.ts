import { test } from "node:test";
import assert from "node:assert/strict";
import { lspConfigDecision, parseJavaRuntime } from "../plugins/lib/lsp-config.ts";

const root = "/data/fresh-android/lsp";
const kotlin = { command: `${root}/kotlin/bin/intellij-server`, args: ["--stdio"], enabled: true };
const java = { command: `${root}/jdk/bin/java`, args: [], enabled: true };

test("missing effective language configuration is available without affecting other languages", () => {
  for (const effective of [{}, { lsp: {} }, { lsp: { java: [java] } }]) {
    assert.equal(lspConfigDecision(effective, {}, "kotlin", root).kind, "default");
  }
  assert.equal(lspConfigDecision({}, { lsp: { java: false } }, "kotlin", root).kind, "default");
});

test("explicit user language entries always take precedence over managed discovery", () => {
  const effective = { lsp: { kotlin: [kotlin] } };
  for (const configured of [false, null, undefined, [], {}, "", [{ command: "kotlin-lsp", args: ["--stdio"], enabled: true }], [kotlin], [{ ...kotlin, enabled: false }], [kotlin, kotlin]]) {
    assert.equal(lspConfigDecision(effective, { lsp: { kotlin: configured } }, "kotlin", root).kind, "user");
    assert.equal(lspConfigDecision({}, { lsp: { kotlin: configured } }, "kotlin", root).kind, "user");
  }
  assert.equal(lspConfigDecision({ lsp: { java: [java] } }, { lsp: { java: [java] } }, "java", root).kind, "user");
});

test("global disablement wins even when servers and user entries are present", () => {
  for (const user of [{}, { lsp: { kotlin: [kotlin] } }, null]) {
    assert.equal(lspConfigDecision({ lsp_enabled: false, lsp: { kotlin: [kotlin] } }, user, "kotlin", root).kind, "disabled");
  }
  assert.equal(lspConfigDecision({ lsp: { java: [java] } }, { lsp_enabled: false }, "java", root).kind, "disabled");
});

test("disabled managed and custom entries cannot be re-enabled by automatic setup", () => {
  for (const language of ["kotlin", "java"] as const) {
    for (const servers of [false, [{ ...(language === "kotlin" ? kotlin : java), enabled: false }], [{ command: "custom", enabled: false }]]) {
      assert.equal(lspConfigDecision({ lsp: { [language]: servers } }, {}, language, root).kind, "disabled");
    }
  }
});

test("registration must never collapse multiple effective servers or deliberately empty lists", () => {
  for (const servers of [[], [kotlin, kotlin], [kotlin, { command: "custom", args: [], enabled: true }], [kotlin, { ...kotlin, enabled: false }]]) {
    assert.equal(lspConfigDecision({ lsp: { kotlin: servers } }, {}, "kotlin", root).kind, "user");
  }
  assert.equal(lspConfigDecision({ lsp: { java: [java, java] } }, {}, "java", root).kind, "user");
});

test("malformed configuration is not interpreted as permission to replace it", () => {
  for (const malformed of [null, undefined, false, [], "invalid"]) {
    assert.equal(lspConfigDecision(malformed, {}, "kotlin", root).kind, "user");
    assert.equal(lspConfigDecision({}, malformed, "kotlin", root).kind, "user");
    assert.equal(lspConfigDecision({ lsp: malformed }, {}, "kotlin", root).kind, "user");
    assert.equal(lspConfigDecision({}, { lsp: malformed }, "kotlin", root).kind, "user");
  }
  for (const servers of [null, undefined, "kotlin-lsp", {}, [null], ["kotlin-lsp"], [{ ...kotlin, args: [null] }], [{ ...kotlin, enabled: "true" }], [{ command: kotlin.command }]]) {
    assert.equal(lspConfigDecision({ lsp: { kotlin: servers } }, {}, "kotlin", root).kind, "user");
  }
  assert.equal(lspConfigDecision({ lsp_enabled: "false" }, {}, "kotlin", root).kind, "user");
  assert.equal(lspConfigDecision({}, { lsp_enabled: null }, "kotlin", root).kind, "user");
});

test("familiar executable names without the complete default configuration are protected", () => {
  for (const [language, command] of [["kotlin", "kotlin-lsp"], ["java", "jdtls"]] as const) {
    assert.equal(lspConfigDecision({ lsp: { [language]: [{ command, args: [], enabled: true }] } }, {}, language, root).kind, "user");
    assert.equal(lspConfigDecision({ lsp: { [language]: [{ command: `/usr/local/bin/${command}`, args: [], enabled: true }] } }, {}, language, root).kind, "user");
  }
});

test("single enabled plugin-owned launchers are recognized", () => {
  assert.equal(lspConfigDecision({ lsp: { kotlin: [kotlin] } }, {}, "kotlin", root).kind, "managed");
  assert.equal(lspConfigDecision({ lsp: { java: [java] } }, {}, "java", `${root}/`).kind, "managed");
  assert.equal(lspConfigDecision({ lsp: { kotlin: [{ ...kotlin, command: `${root}/mac/Contents/MacOS/../bin/intellij-server` }] } }, {}, "kotlin", root).kind, "user");
});

test("managed namespace comparisons have strict boundaries and retain POSIX case sensitivity", () => {
  for (const command of [`${root}-evil/bin/intellij-server`, `${root}2/bin/intellij-server`, `${root}/../outside/bin/intellij-server`, `${root}/kotlin/../../outside/intellij-server`, `${root.toUpperCase()}/bin/intellij-server`, "data/fresh-android/lsp/bin/intellij-server", `${root}/bin/custom-server`]) {
    assert.equal(lspConfigDecision({ lsp: { kotlin: [{ ...kotlin, command }] } }, {}, "kotlin", root).kind, "user");
  }
  for (const managedRoot of ["", "/", "relative/lsp"]) {
    assert.equal(lspConfigDecision({ lsp: { kotlin: [kotlin] } }, {}, "kotlin", managedRoot).kind, "user");
  }
});

test("Windows drive paths normalize slash direction and case without accepting adjacent namespaces", () => {
  const managedRoot = "C:\\Users\\Some User\\Fresh\\LSP\\";
  const entry = { ...kotlin, command: "c:/USERS/some user/fresh/lsp/kotlin/bin/INTELLIJ-SERVER.EXE" };
  assert.equal(lspConfigDecision({ lsp: { kotlin: [entry] } }, {}, "kotlin", managedRoot).kind, "managed");
  for (const command of ["C:\\Users\\Some User\\Fresh\\LSP-old\\bin\\intellij-server.exe", "C:\\Users\\Some User\\Fresh\\LSP\\..\\outside\\intellij-server.exe", "C:\\Users\\Some User\\Fresh\\LSP.\\bin\\intellij-server.exe", "C:\\Users\\Some User\\Fresh\\LSP\\bin\\intellij-server.exe:other", "C:Users\\Some User\\Fresh\\LSP\\bin\\intellij-server.exe", "D:\\Users\\Some User\\Fresh\\LSP\\bin\\intellij-server.exe"]) {
    assert.equal(lspConfigDecision({ lsp: { kotlin: [{ ...entry, command }] } }, {}, "kotlin", managedRoot).kind, "user");
  }
  assert.equal(lspConfigDecision({ lsp: { kotlin: [entry] } }, {}, "kotlin", "C:\\").kind, "user");
});

test("Windows UNC managed roots use the same bounded comparison", () => {
  const entry = { ...java, command: "//HOST/Share/Fresh/LSP/jdk/bin/java.exe" };
  assert.equal(lspConfigDecision({ lsp: { java: [entry] } }, {}, "java", "\\\\host\\share\\fresh\\lsp").kind, "managed");
  assert.equal(lspConfigDecision({ lsp: { java: [entry] } }, {}, "java", "\\\\host\\share\\fresh\\ls").kind, "user");
});

test("JDT launcher ownership can use an external Java executable", () => {
  const launcher = `${root}/jdtls/plugins/org.eclipse.equinox.launcher_1.7.0.jar`;
  const entry = { command: "/opt/jdk/bin/java", enabled: true, args: ["-Xmx1g", "-jar", launcher, "-configuration", `${root}/jdtls/config_linux`] };
  assert.equal(lspConfigDecision({ lsp: { java: [entry] } }, {}, "java", root).kind, "managed");
  assert.equal(lspConfigDecision({ lsp: { java: [{ ...entry, enabled: false }] } }, {}, "java", root).kind, "disabled");
  const windowsEntry = { ...entry, command: "C:\\Program Files\\Java\\bin\\java.exe", args: ["-jar", "c:/FRESH/lsp/jdtls/plugins/org.eclipse.equinox.launcher_1.jar"] };
  assert.equal(lspConfigDecision({ lsp: { java: [windowsEntry] } }, {}, "java", "C:\\fresh\\LSP").kind, "managed");
});

test("mentioning a managed JDT jar is not sufficient to claim a different executable or jar", () => {
  const launcher = `${root}/jdtls/plugins/org.eclipse.equinox.launcher_1.jar`;
  for (const args of [["-classpath", launcher], ["-jar"], ["-jar", `${root}-evil/plugins/org.eclipse.equinox.launcher_1.jar`], ["-jar", `${root}/jdtls/plugins/not-jdt.jar`], ["-jar", "/custom/server.jar", "-jar", launcher], ["-jar", `${root}/jdtls/../../outside/org.eclipse.equinox.launcher_1.jar`]]) {
    assert.equal(lspConfigDecision({ lsp: { java: [{ command: "java", enabled: true, args }] } }, {}, "java", root).kind, "user");
  }
  assert.equal(lspConfigDecision({ lsp: { java: [{ command: "/custom/wrapper", enabled: true, args: ["-jar", launcher] }] } }, {}, "java", root).kind, "user");
});

test("Java settings parsing preserves Windows paths with spaces and CRLF", () => {
  assert.deepEqual(parseJavaRuntime("Property settings:\r\n    java.home = C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.1+1\r\n    java.specification.version = 21\r\n    java.version = 21.0.12.1\r\nopenjdk version \"21.0.12.1\" 2026-10-20\r\n"), {
    major: 21, home: "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.1+1",
  });
});

test("Java specification versions distinguish Java 8 and modern JDK releases", () => {
  for (const [specification, major] of [["1.8", 8], ["17", 17], ["21", 21], ["25", 25]] as const) {
    assert.deepEqual(parseJavaRuntime(`  java.specification.version = ${specification}\n  java.home = /opt/Java Home/jdk-${major}\n`), { major, home: `/opt/Java Home/jdk-${major}` });
  }
});

test("Java version property is usable when the specification property is absent", () => {
  for (const [version, major] of [["1.8.0_442-b06", 8], ["17.0.14+7", 17], ["21.0.12.1+1-LTS", 21], ["25-ea", 25]] as const) {
    assert.deepEqual(parseJavaRuntime(`java.home=/opt/jdk=${major}\njava.version=${version}\n`), { major, home: `/opt/jdk=${major}` });
  }
});

test("Java parsing rejects missing, malformed, or contradictory runtime properties", () => {
  for (const output of ["", "openjdk version \"21\"", "java.home=/opt/jdk", "java.specification.version=21", "java.home=\njava.specification.version=21", "java.home=/opt/jdk\njava.specification.version=unknown", "java.home=/opt/jdk\njava.specification.version=21oops", "java.home=/opt/jdk\njava.specification.version=0", "java.home=/opt/jdk\njava.specification.version=9999999999999999999999", "java.home=/opt/jdk\njava.specification.version=21\njava.version=17.0.1", "java.home=/opt/one\njava.home=/opt/two\njava.specification.version=21", "java.home=/opt/jdk\njava.specification.version=17\njava.specification.version=21", "java.home=/opt/jdk\njava.version=17.0.1\njava.version=21.0.1"]) {
    assert.equal(parseJavaRuntime(output), undefined);
  }
});
