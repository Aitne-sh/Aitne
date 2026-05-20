import type { HostProfile } from "../types.js";
import { detectChromiumBrowser } from "./chromium.js";

export function detectChrome(host: HostProfile, cacheRoot: string) {
  return detectChromiumBrowser("chrome", host, cacheRoot);
}
