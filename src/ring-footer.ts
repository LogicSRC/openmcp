/**
 * The Profullstack network footer (webring row, built.indie and pwamart badges,
 * copyright) from @profullstack/footer. Off unless PROFULLSTACK_FOOTER=1: a
 * catalog someone else runs from this package is not part of that network.
 *
 * It is rendered into the HTML on the server because the ring's verifier reads
 * the page and never runs script. Pages render synchronously, so each site's
 * footer is kept as a string: the bundled template first, then the @latest
 * template from the CDN, refreshed at most every 15 minutes in the background.
 * A failed refresh keeps the last good copy.
 */
import { descriptorResponse, footerHtml, footerHtmlSync } from "@profullstack/footer";

const REFRESH_MS = 15 * 60_000;

interface Entry {
  html: string;
  at: number;
  pending: boolean;
}

const cache = new Map<string, Entry>();

export function ringFooterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.PROFULLSTACK_FOOTER ?? "");
}

const options = (site: string) => ({ site, since: 2026 });

/** The footer for a site's homepage (with a trailing slash), or "" when the footer is off. */
export function ringFooter(site: string): string {
  if (!ringFooterEnabled()) return "";
  let entry = cache.get(site);
  if (!entry) {
    entry = { html: footerHtmlSync(options(site)), at: 0, pending: false };
    cache.set(site, entry);
  }
  if (!entry.pending && Date.now() - entry.at > REFRESH_MS) {
    const current = entry;
    current.pending = true;
    footerHtml(options(site))
      .then((html) => {
        if (typeof html === "string" && html.includes("/ring/profullstack") && html.length < 64_000) current.html = html;
      })
      .catch(() => {})
      .finally(() => {
        current.at = Date.now();
        current.pending = false;
      });
  }
  return entry.html;
}

/** /.well-known/openwebring.json for a site, or null when the footer is off. */
export function ringDescriptor(site: string, name: string): Response | null {
  return ringFooterEnabled() ? descriptorResponse({ site, name }) : null;
}
