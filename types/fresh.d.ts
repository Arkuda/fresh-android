declare type FreshSpawnResult = {
  exit_code: number;
  stdout?: string;
  stderr?: string;
};

declare type FreshEditor = {
  registerCommand(name: string, description: string, handler: string, context?: string): void;
  setStatus(message: string): void;
  debug(message: string): void;
  spawnProcess(command: string, args?: string[], options?: Record<string, unknown>): Promise<FreshSpawnResult>;
  openFile?(path: string): Promise<void> | void;
  createVirtualBuffer?(name: string, content: string, mode?: string): Promise<unknown> | unknown;
  getCurrentFilePath?(): string | undefined;
};

declare const editor: FreshEditor;
declare function registerHandler(name: string, handler: (...args: string[]) => void | Promise<void>): void;
