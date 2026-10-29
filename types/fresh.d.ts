// Minimal subset of Fresh 0.5.4's generated EditorAPI, used by this package.
// Full declarations: fresh --cmd script types
// Processes receive cwd as their third argument, not an options object.
type FreshSpawnResult = { exit_code: number; stdout: string; stderr: string };
// Runtime requires id even though Fresh 0.5.4's generated PromptSuggestion omits it.
type FreshSuggestion = { id: string; text: string; description?: string; value?: string; disabled?: boolean };
type FreshPromptEvent = { prompt_type: string; input: string; selected_index?: number | null };
type FreshBuffer = { id: number; name: string; is_virtual: boolean };
type FreshLspConfig = {
  command: string;
  args: string[];
  autoStart: boolean | null;
  initializationOptions: Record<string, unknown> | null;
  processLimits: { maxMemoryPercent: number | null; maxCpuPercent: number | null; enabled: boolean | null } | null;
};
declare const editor: {
  registerCommand(name: string, description: string, handler: string, context?: string | null): void;
  setStatus(message: string): void;
  debug(message: string): void;
  spawnProcess(command: string, args: string[], cwd?: string, stdoutTo?: string): Promise<FreshSpawnResult>;
  getEnv(name: string): string | null;
  getCwd(): string;
  workspaceTrustLevel(): string;
  getAuthorityLabel(): string;
  pathJoin(...parts: string[]): string;
  pathDirname(path: string): string;
  pathBasename(path: string): string;
  fileExists(path: string): boolean;
  readFile(path: string): string | null;
  readDir(path: string): Array<{ name: string; is_file: boolean; is_dir: boolean }>;
  writeFile(path: string, content: string): boolean;
  replaceFile(path: string, content: string): boolean;
  createDir(path: string): boolean;
  scratchCreate(label: string): string | null;
  scratchPath(token: string): string | null;
  scratchDiscard(token: string): boolean;
  getActiveBufferId(): number;
  getBufferPath(bufferId: number): string;
  listBuffers(): FreshBuffer[];
  showBuffer(bufferId: number): boolean;
  createVirtualBuffer(options: { name: string; readOnly?: boolean; editingDisabled?: boolean; showCursors?: boolean }): Promise<{ bufferId: number; splitId: number | null }>;
  setVirtualBufferContent(bufferId: number, entries: Array<{ text: string }>): boolean;
  createTerminal(options: { cwd?: string; command?: string[]; title?: string; direction?: string; ratio?: number; persistent?: boolean; env?: Record<string, string> }): Promise<{ bufferId: number; terminalId: number; splitId: number }>;
  closeTerminal(id: number): boolean;
  prompt(label: string, initialValue: string): Promise<string | null>;
  startPrompt(label: string, promptType: string, floatingOverlay?: boolean): boolean;
  setPromptSuggestions(suggestions: FreshSuggestion[], selectedIndex?: number | null): boolean;
  on(event: string, handler: string): void;
  defineConfigString(name: string, options: { default: string; description?: string }): string;
  getPluginConfig<T = unknown>(): T;
  getConfig(): unknown;
  getUserConfig(): unknown;
  getDataDir(): string;
  pathToFileUri(path: string): string;
  registerLspServer(language: string, config: FreshLspConfig): boolean;
  restartLspForLanguage(language: string): boolean;
  setLspRootUri(language: string, uri: string): boolean;
  defineConfigBoolean(name: string, options: { default: boolean; description?: string }): boolean;
  setTimeout(delayMs: number, handler: string): number;
  setSetting(path: string, value: unknown): boolean;
  flush(): Promise<void>;
};
declare function registerHandler<T extends unknown[]>(name: string, handler: (...args: T) => unknown): void;
