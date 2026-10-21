/**
 * Updates from GitHub Releases (tauri-plugin-updater): the installed app reads latest.json
 * of the latest published release, and installs a newer version once the user says so.
 * Updates are signed with the project's key; the app only installs ones that check out.
 */
import { create } from "zustand";
import { inTauri } from "./api";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "none"; checkedAt: number }
  | { status: "available"; version: string; notes: string }
  | { status: "downloading"; version: string; notes: string; done: number; total: number | null }
  | { status: "installing"; version: string; notes: string }
  | { status: "error"; message: string };

interface Updates {
  state: UpdateState;
  set: (state: UpdateState) => void;
}

export const useUpdates = create<Updates>((set) => ({ state: { status: "idle" }, set: (state) => set({ state }) }));

// the plugin's update object: kept here, its methods download and install
let pending: import("@tauri-apps/plugin-updater").Update | null = null;

/** Looks for a newer version. `quiet`: a failure (offline…) isn't shown as an error. */
export async function checkForUpdate(quiet = false): Promise<UpdateState> {
  const { set, state } = useUpdates.getState();
  if (!inTauri) {
    const s: UpdateState = { status: "error", message: "Updates are checked in the installed app" };
    if (!quiet) set(s);
    return s;
  }
  if (state.status === "downloading" || state.status === "installing") return state;
  set({ status: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    pending = update;
    const s: UpdateState = update ? { status: "available", version: update.version, notes: update.body ?? "" } : { status: "none", checkedAt: Date.now() };
    set(s);
    return s;
  } catch (e) {
    const s: UpdateState = quiet ? { status: "idle" } : { status: "error", message: `Couldn't check for updates: ${String(e)}` };
    set(s);
    return s;
  }
}

/** Downloads and installs the found update, then restarts (on Windows the installer closes the app). */
export async function installUpdate() {
  const { set, state } = useUpdates.getState();
  if (!pending || state.status !== "available") return;
  const { version, notes } = state;
  let done = 0;
  let total: number | null = null;
  try {
    await pending.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? null;
      else if (e.event === "Progress") done += e.data.chunkLength;
      else if (e.event === "Finished") return set({ status: "installing", version, notes });
      set({ status: "downloading", version, notes, done, total });
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    set({ status: "error", message: `The update didn't install: ${String(e)}` });
  }
}
