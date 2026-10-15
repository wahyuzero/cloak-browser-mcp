/**
 * Shared fingerprint helpers (BUG-3 fix).
 *
 * UA cannot be changed on an already-created Playwright browser context via
 * context options — but it CAN be overridden at runtime per-page via the CDP
 * `Emulation.setUserAgentOverride` command, and for future navigations via an
 * init script that patches `navigator.userAgent` / `navigator.platform`.
 */

export const PLATFORM_UA_FRAGMENTS: Record<string, string> = {
  windows: "Windows NT 10.0; Win64; x64",
  macos: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
  android: "Linux; Android 14; K",
  chromeos: "X11; CrOS x86_64 14541.0.0",
};

const PLATFORM_NAV_PLATFORM: Record<string, string> = {
  windows: "Win32",
  macos: "MacIntel",
  linux: "Linux x86_64",
  android: "Linux armv8l",
  chromeos: "Linux x86_64",
};

/** Matches the platform fragment inside a stock Chrome UA string. */
const PLATFORM_TOKEN_RE =
  /(Windows NT [\d.]+; Win64; x64|Macintosh; Intel Mac OS X [\d_]+|X11; CrOS x86_64 [\d.]+|X11; Linux x86_64|Linux; Android [\d.]+; K)/;

const FALLBACK_UA =
  "Mozilla/5.0 (PLATFORM) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

/**
 * Build a full Chrome UA string for the given logical platform, reusing the
 * browser/version of `currentUA` when it matches a known platform token so the
 * Chrome build number stays truthful.
 */
export function uaForPlatform(currentUA: string, platform: string): string | undefined {
  const frag = PLATFORM_UA_FRAGMENTS[platform.toLowerCase()];
  if (!frag) return undefined;
  if (PLATFORM_TOKEN_RE.test(currentUA)) return currentUA.replace(PLATFORM_TOKEN_RE, frag);
  return FALLBACK_UA.replace("(PLATFORM)", `(${frag})`);
}

/**
 * Init script that patches navigator surfaces for the chosen platform. Safe to
 * inject on any context; wrapped in try/catch so exotic pages never break.
 */
export function fingerprintOverrideScript(platform: string, ua: string): string {
  const navPlatform = PLATFORM_NAV_PLATFORM[platform.toLowerCase()] ?? platform;
  const dataPlatform = platform.toLowerCase() === "macos" ? "macOS" : platform.charAt(0).toUpperCase() + platform.slice(1).toLowerCase();
  return `(() => { try {
    Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(ua)} });
    Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(navPlatform)} });
    Object.defineProperty(navigator, 'appVersion', { get: () => ${JSON.stringify(ua.replace(/^Mozilla\//, ""))} });
    if (navigator.userAgentData) {
      try { Object.defineProperty(navigator.userAgentData, 'platform', { get: () => ${JSON.stringify(dataPlatform)} }); } catch (e) {}
    }
  } catch (e) {} })();`;
}

/**
 * Per-page persistent CDP sessions for UA overrides. Detaching a CDP session
 * reverts its Emulation.setUserAgentOverride, so sessions must be kept alive
 * (and reused) for as long as the override should apply.
 */
const uaCdpSessions = new WeakMap<object, any>();

export async function applyUaOverride(
  pages: Array<{ context: () => any } & Record<string, any>>,
  ua: string,
  platform: string,
): Promise<void> {
  for (const page of pages) {
    let client = uaCdpSessions.get(page);
    try {
      if (!client) {
        client = await page.context().newCDPSession(page);
        uaCdpSessions.set(page, client);
      }
      await client.send("Emulation.setUserAgentOverride", { userAgent: ua, platform });
    } catch (e) {
      // best-effort: page may have closed
    }
  }
}
