/**
 * robots.txt and sitemap.xml for the catalog and for each hosted relay.
 *
 * Every origin describes only itself: the catalog lists its directory pages and
 * one page per relay, a hosted relay (its own subdomain) lists its landing page.
 */

export interface SitemapEntry {
  loc: string;
  lastmod?: string | null;
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A <urlset>. lastmod is trimmed to the date when it parses. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const date = entry.lastmod ? new Date(entry.lastmod) : null;
    const lastmod = date && !Number.isNaN(date.getTime()) ? `<lastmod>${date.toISOString().slice(0, 10)}</lastmod>` : "";
    return `  <url><loc>${xmlEscape(entry.loc)}</loc>${lastmod}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Allow everything public, keep crawlers out of the API, the MCP endpoint and account pages. */
export function robotsTxt(origin: string, disallow: string[] = []): string {
  return ["User-agent: *", "Allow: /", ...disallow.map((path) => `Disallow: ${path}`), "", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n");
}

export const XML_HEADERS = { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" };
export const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" };
