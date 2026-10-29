import type { LspComponent, LspPlatform } from "./lsp-types.ts";

export type LspRelease = {
  version: string;
  url: string;
  sha256: string;
  archive: "tar" | "zip";
  license: string;
  source: string;
};

// Kotlin's published standalone release checksums, not the VS Code extension assets:
// https://github.com/Kotlin/kotlin-lsp/releases/tag/kotlin-lsp%2Fv263.7084.0
const kotlinHashes: Record<string, string> = {
  "windows-x64": "be3bc4ef430cde315e6a83900ffb5d9cc454a36aabe9dd3ba7d4141b2d628164",
  "windows-aarch64": "1fdf633252c098973613b69cc2e4c8ab8fe6c3e6d07241e3d424f3579745db5d",
  "linux-x64": "ae0c4b01e17ab73a4a5227a78ea99e6dcbe3e499600315b22759a4e4cddd11df",
  "linux-aarch64": "450ab7c1d80e48106aa429b48cb4226d82ca12a8a2400447ae02386794780cac",
  "mac-x64": "b29c393a5e541153d03d626e7946268437e358a667a5f914a126dbb4007664b1",
  "mac-aarch64": "b403bf8a54bd458e3ba6731cf8abb3340be08b439c03576dfc02b13faf3694b8",
};

// Official Adoptium GA package metadata for jdk-25.0.5+8:
// https://api.adoptium.net/v3/assets/feature_releases/25/ga?image_type=jdk&vendor=eclipse
// Windows ARM64 uses Microsoft's native OpenJDK package (Temurin 25 has no such asset).
// https://learn.microsoft.com/en-us/java/openjdk/download
// Versions and publisher SHA-256 are pinned; never resolve "latest" at install time.
const jdkHashes: Record<string, string> = {
  "windows-x64": "636bdc13dc649ddc7d5921c5c7d23cca6e44fd19d662b45cc9c02135a6c96c42",
  "windows-aarch64": "f227cc459fbd65a42c1b28123d68e207eb500899c1c78238f21a038cd33688a3",
  "linux-x64": "68982529869257d0ee6b824ec5aa270ff8b118bb438670da0b97ebdab178d7fb",
  "linux-aarch64": "bb5b2ded252f21c6090cf780b0a408ad0d83bbb557e702955643557f13231880",
  "mac-x64": "32cd4d2151c91aa00d0fc911edfd05245ed40fa6b1aa894d5f35c928cd67a59d",
  "mac-aarch64": "36dc14d797aaff6d89aab302cd053fdba6207dfdcf772052fa7b023a94b0e857",
};

export function pinnedRelease(component: LspComponent, platform: LspPlatform): LspRelease {
  const key = `${platform.os}-${platform.arch}`;
  if (!kotlinHashes[key] || !jdkHashes[key]) throw new Error(`Unsupported language-server platform: ${key}`);
  if (component === "kotlin") {
    const version = "263.7084.0";
    const suffix = platform.os === "windows" ? ".win.zip" : platform.os === "mac" ? ".sit" : ".tar.gz";
    const filename = `kotlin-server-${version}${platform.arch === "aarch64" ? "-aarch64" : ""}${suffix}`;
    return {
      version, url: `https://download.jetbrains.com/language-server/kotlin-server/${version}/${filename}`,
      sha256: kotlinHashes[key], archive: platform.os === "linux" ? "tar" : "zip",
      license: "Apache 2.0 repository license plus proprietary JetBrains components and bundled third-party terms (https://github.com/Kotlin/kotlin-lsp/blob/main/LICENSE.txt; https://github.com/Kotlin/kotlin-lsp#project-status)",
      source: "JetBrains / Kotlin (https://github.com/Kotlin/kotlin-lsp)",
    };
  }
  if (component === "jdk") {
    if (platform.os === "windows" && platform.arch === "aarch64") return {
      version: "25.0.5.0.2",
      url: "https://aka.ms/download-jdk/microsoft-jdk-25.0.5.0.2-windows-aarch64.zip",
      sha256: jdkHashes[key], archive: "zip",
      license: "GNU GPL v2 with Classpath Exception (https://learn.microsoft.com/en-us/java/openjdk/faq)",
      source: "Microsoft Build of OpenJDK (https://learn.microsoft.com/en-us/java/openjdk/download)",
    };
    const filename = `OpenJDK25U-jdk_${platform.arch}_${platform.os}_hotspot_25.0.5_8.${platform.os === "windows" ? "zip" : "tar.gz"}`;
    return {
      version: "25.0.5+8",
      url: `https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/${filename}`,
      sha256: jdkHashes[key], archive: platform.os === "windows" ? "zip" : "tar",
      license: "GNU GPL v2 with Classpath Exception (https://adoptium.net/about/license)",
      source: "Eclipse Adoptium Temurin (https://github.com/adoptium/temurin25-binaries)",
    };
  }
  if (component !== "jdtls") throw new Error(`Unknown language-server component: ${String(component)}`);
  return {
    version: "1.63.0",
    url: "https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz",
    sha256: "b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4", archive: "tar",
    license: "Eclipse Public License 2.0 and bundled third-party licenses (https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/main/LICENSE)",
    source: "Eclipse JDT Language Server (https://github.com/eclipse-jdtls/eclipse.jdt.ls)",
  };
}
