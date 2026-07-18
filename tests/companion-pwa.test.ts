import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the companion's installability recipe (dm_sum docs/companion-pwa-install.md,
// proven on Android Chrome 2026-07-18). The two load-bearing empirical criteria —
// the standard mobile-web-app-capable meta and "any maskable" icon purpose —
// were the ONLY deltas between the sibling deployment that installed and this
// one, which didn't. Neither appears in Chromium's documented install criteria,
// so this pin is what keeps them from being "reasoned away" in a refactor.

const MANIFEST = "site/companion/manifest.webmanifest";
const PAGE = "site/companion/index.html";

describe("companion PWA install recipe", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    name?: string; short_name?: string; start_url?: string; scope?: string;
    display?: string; icons?: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
  };

  it("manifest carries the standalone companion-scoped shape", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.display).toBe("standalone");
    // Scoping matters: installing from anywhere must install the companion,
    // not the whole site.
    expect(manifest.start_url).toBe("/companion");
    expect(manifest.scope).toBe("/companion");
  });

  it("icons are 192+512 PNG, purpose 'any maskable', and REAL pixel dims match declared", () => {
    const icons = manifest.icons ?? [];
    for (const size of [192, 512]) {
      const icon = icons.find((entry) => entry.sizes === `${size}x${size}`);
      expect(icon, `manifest declares a ${size}x${size} icon`).toBeTruthy();
      expect(icon!.type).toBe("image/png");
      expect(icon!.purpose).toBe("any maskable");
      // Actual IHDR dimensions, not the declared ones — a mismatch silently
      // disqualifies the install offer.
      const png = readFileSync(`site/companion/${icon!.src.split("/").pop()}`);
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });

  it("page head links the manifest and carries BOTH capable metas", () => {
    const head = readFileSync(PAGE, "utf8");
    expect(head).toContain('rel="manifest"');
    // The standard form is the empirical Android criterion; the apple-
    // variant stays for iOS. Both, not either.
    expect(head).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(head).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
  });
});
