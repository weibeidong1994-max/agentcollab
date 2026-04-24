import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function ptySpawn(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}): Promise<string> {
  return invoke<string>("pty_spawn", {
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    env: opts.env ?? null,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
  });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export function listenPtyOutput(
  onOutput: (id: string, data: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; data: string }>("pty-output", (event) => {
    const binary = atob(event.payload.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    onOutput(event.payload.id, bytes);
  });
}

export function listenPtyExit(
  onExit: (id: string, exitCode: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; exit_code: number | null }>("pty-exit", (event) => {
    onExit(event.payload.id, event.payload.exit_code);
  });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function mkdirp(path: string): Promise<void> {
  return invoke("mkdirp", { path });
}

export async function listDir(path: string): Promise<string[]> {
  return invoke<string[]>("list_dir", { path });
}
