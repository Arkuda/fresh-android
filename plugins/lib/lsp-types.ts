export type LspLanguage = "kotlin" | "java";
export type LspPlatform = { os: "windows" | "linux" | "mac"; arch: "x64" | "aarch64" };
export type LspComponent = "kotlin" | "jdtls" | "jdk";
export type LspInstallation = { component: LspComponent; version: string; root: string };
export type LspConsent = (message: string) => Promise<boolean>;
export type LspReport = (message: string) => void;
