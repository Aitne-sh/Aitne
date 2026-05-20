import type { HostProfile } from "../types.js";
import { detectChromiumBrowser } from "./chromium.js";

export function detectAtlas(host: HostProfile, cacheRoot: string) {
  return detectChromiumBrowser("atlas", host, cacheRoot);
}
