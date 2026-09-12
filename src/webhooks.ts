/**
 * Telling subscribers what changed.
 *
 * A subscription is a URL, a secret and a list of events. A delivery is one
 * POST with the event as JSON, signed with the secret so the receiver can
 * tell it came from this catalog and not from anyone who found the URL.
 * Three attempts, then the failure is written down; fifty failures in a row
 * and the subscription goes inactive, still listed, so the owner sees why.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Catalog } from "./db.ts";
import type { CatalogEvent, RelayRecord, WebhookDelivery } from "./spec.ts";
import type { Fetcher } from "./mcp/client.ts";

export const SIGNATURE_HEADER = "x-openmcp-signature";
export const EVENT_HEADER = "x-openmcp-event";
export const DELIVERY_HEADER = "x-openmcp-delivery";

/** `sha256=<hex hmac of the raw body>`. */
export function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** What a receiver calls with the header and the raw body it was sent. */
export function verifySignature(secret: string, header: string | null | undefined, rawBody: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(secret, rawBody));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface DeliverOptions {
  fetch?: Fetcher;
  attempts?: number;
  timeoutMs?: number;
  /** The catalog's public origin, put in every delivery so a receiver knows who is talking. */
  catalog: string;
  log?: (line: string) => void;
}

/** Send one event to every subscription that wants it. Never throws. */
export async function deliver(store: Catalog, event: CatalogEvent, relay: RelayRecord | { id: string }, options: DeliverOptions): Promise<number> {
  const fetcher = options.fetch ?? fetch;
  const at = new Date().toISOString();
  let sent = 0;
  for (const hook of store.listWebhooks()) {
    if (!hook.active) continue;
    if (!hook.events.includes(event)) continue;
    if (hook.relays.length && !hook.relays.includes(relay.id)) continue;

    const delivery: WebhookDelivery = { id: randomUUID(), event, at, catalog: options.catalog, relay };
    const body = JSON.stringify(delivery);
    let status: number | null = null;
    let error: string | null = null;
    let attempts = 0;
    for (; attempts < (options.attempts ?? 3); attempts++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await fetcher(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "openmcp-catalog",
            [SIGNATURE_HEADER]: sign(hook.secret, body),
            [EVENT_HEADER]: event,
            [DELIVERY_HEADER]: delivery.id,
          },
          body,
          signal: controller.signal,
        });
        status = response.status;
        error = null;
        if (response.ok) break;
        error = `answered ${response.status}`;
        // A 4xx is the receiver's decision; retrying does not change it.
        if (response.status >= 400 && response.status < 500) {
          attempts++;
          break;
        }
      } catch (caught) {
        status = null;
        error = (caught as Error).name === "AbortError" ? "timed out" : (caught as Error).message;
      } finally {
        clearTimeout(timer);
      }
    }
    store.recordDelivery({ id: delivery.id, webhookId: hook.id, event, relayId: relay.id, at, status, error, attempts });
    if (status !== null && status >= 200 && status < 300) sent++;
    else options.log?.(`webhook ${hook.id} ${hook.url}: ${error ?? "failed"}`);
  }
  return sent;
}
