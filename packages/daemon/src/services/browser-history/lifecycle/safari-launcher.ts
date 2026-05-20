import { spawn } from "node:child_process";
import type { HostProfile } from "../types.js";

function runOsa(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`osascript exited with ${code}`));
    });
  });
}

export async function launchSafari(host: HostProfile): Promise<"launched" | "unsupported"> {
  if (host.os !== "darwin") return "unsupported";
  await runOsa('tell application "Safari" to launch');
  return "launched";
}

export async function quitSafari(host: HostProfile): Promise<"quit" | "unsupported"> {
  if (host.os !== "darwin") return "unsupported";
  await runOsa('tell application "Safari" to quit');
  return "quit";
}
