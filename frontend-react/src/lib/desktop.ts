/**
 * desktop.ts — the only file that knows the app might be running inside Tauri.
 *
 * Everything here has a browser answer as well as a desktop one, because
 * `npm run dev` at :3000 against a hand-started backend is still the
 * development loop and must not break. `isDesktop()` is the single branch;
 * nothing else in the app imports @tauri-apps/*.
 *
 * The names on the Rust side of this contract live in src-tauri/src/lib.rs
 * (commands) and src-tauri/src/backend.rs (events).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const EV_READY = "backend-ready";
export const EV_EXITED = "backend-exited";
export const EV_CLOSING = "app-closing";

export type ExitInfo = { code: number | null; port_busy: boolean; tail: string };
export type ShellState = {
  ready: boolean;
  running: boolean;
  error: string | null;
  tail: string;
};

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function shellState(): Promise<ShellState | null> {
  if (!isDesktop()) return null;
  try {
    return await invoke<ShellState>("shell_state");
  } catch {
    return null;
  }
}

export async function startBackend(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    await invoke("start_backend");
    return null;
  } catch (e) {
    return String(e);
  }
}

/** Rust-side, not /activity/open_folder: the moment this is most needed is the
 *  moment the backend is not answering. */
export async function openLogsFolderNative(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    await invoke("open_logs_folder");
    return true;
  } catch {
    return false;
  }
}

export function onDesktopEvent<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  if (!isDesktop()) return () => {};
  let unlisten: UnlistenFn | null = null;
  let dead = false;
  void listen<T>(event, e => handler(e.payload)).then(fn => {
    if (dead) fn();
    else unlisten = fn;
  });
  return () => {
    dead = true;
    unlisten?.();
  };
}
