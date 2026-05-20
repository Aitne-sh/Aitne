import type { HostProfile } from "../types.js";
import { detectChromiumBrowser } from "./chromium.js";

export function detectComet(host: HostProfile, cacheRoot: string) {
  return detectChromiumBrowser("comet", host, cacheRoot);
}
