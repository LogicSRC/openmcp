/**
 * The catalog on disk: SQLite, built into Node, one file.
 *
 * Records are kept whole as JSON in a column beside the few fields a query
 * narrows on, so a descriptor field added tomorrow needs no migration. The
 * schema is idempotent and applied at open.
 */
import { DatabaseSync } from "node:sqlite";
import type { CatalogEvent, RelayRecord, WebhookSubscription } from "./spec.ts";

const SCHEMA = `
create table if not exists relays (
  id            text primary key,
  online        integer not null default 0,
  verified      integer not null default 0,
  via           text,
  first_seen_at text not null,
  seen_at       text,
  record        text not null
);
create table if not exists webhooks (
  id         text primary key,
  url        text not null,
  secret     text not null,
  events     text not null,
  relays     text not null,
  created_at text not null,
  failures   integer not null default 0,
  active     integer not null default 1
);
create table if not exists deliveries (
  id         text primary key,
  webhook_id text not null references webhooks(id) on delete cascade,
  event      text not null,
  relay_id   text not null,
  at         text not null,
  status     integer,
  error      text,
  attempts   integer not null default 0
);
create index if not exists deliveries_webhook_idx on deliveries(webhook_id, at desc);
create table if not exists peers (
  url        text primary key,
  added_at   text not null,
  synced_at  text,
  last_error text
);
`;

export interface RelayQuery {
  online?: boolean;
  tag?: string;
  q?: string;
  limit?: number;
}

export class Catalog {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("pragma journal_mode = wal;");
    this.db.exec("pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- relays ------------------------------------------------------------------

  listRelays(options: RelayQuery = {}): RelayRecord[] {
    const rows = this.db.prepare("select record from relays order by online desc, seen_at desc").all() as { record: string }[];
    let records = rows.map((row) => JSON.parse(row.record) as RelayRecord);
    if (options.online) records = records.filter((record) => record.online);
    if (options.tag) {
      const tag = options.tag.toLowerCase();
      records = records.filter((record) => (record.descriptor.tags ?? []).includes(tag));
    }
    if (options.q) {
      const needle = options.q.toLowerCase();
      records = records.filter((record) => searchText(record).includes(needle));
    }
    return records.slice(0, Math.max(1, Math.min(500, options.limit ?? 100)));
  }

  getRelay(id: string): RelayRecord | null {
    const row = this.db.prepare("select record from relays where id = ?").get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as RelayRecord) : null;
  }

  /** Insert or replace. Says what changed, for the webhooks. */
  putRelay(record: RelayRecord): { event: CatalogEvent | null; previous: RelayRecord | null } {
    const previous = this.getRelay(record.id);
    this.db
      .prepare(
        `insert into relays (id, online, verified, via, first_seen_at, seen_at, record) values (?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set online = excluded.online, verified = excluded.verified, via = excluded.via,
           seen_at = excluded.seen_at, record = excluded.record`,
      )
      .run(record.id, record.online ? 1 : 0, record.verified ? 1 : 0, record.via, record.firstSeenAt, record.seenAt, JSON.stringify(record));
    if (!previous) return { event: "relay.registered", previous: null };
    if (previous.online !== record.online) return { event: record.online ? "relay.online" : "relay.offline", previous };
    if (JSON.stringify(previous.descriptor) !== JSON.stringify(record.descriptor) || JSON.stringify(previous.tools) !== JSON.stringify(record.tools)) {
      return { event: "relay.updated", previous };
    }
    return { event: null, previous };
  }

  removeRelay(id: string): boolean {
    return this.db.prepare("delete from relays where id = ?").run(id).changes > 0;
  }

  counts(): { relays: number; online: number } {
    const row = this.db.prepare("select count(*) as relays, coalesce(sum(online), 0) as online from relays").get() as { relays: number; online: number };
    return { relays: Number(row.relays), online: Number(row.online) };
  }

  /** Every tool across every online relay that matches, with where it lives. */
  findTools(q: string, limit = 50): Array<{ relay: string; name: string; description?: string }> {
    const needle = q.toLowerCase();
    const out: Array<{ relay: string; name: string; description?: string }> = [];
    for (const record of this.listRelays({ online: true, limit: 500 })) {
      for (const tool of record.tools) {
        if (`${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase().includes(needle)) {
          out.push({ relay: record.id, name: tool.name, ...(tool.description ? { description: tool.description } : {}) });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // --- webhooks ------------------------------------------------------------------

  addWebhook(input: { id: string; url: string; secret: string; events: CatalogEvent[]; relays: string[] }): WebhookSubscription {
    const createdAt = new Date().toISOString();
    this.db
      .prepare("insert into webhooks (id, url, secret, events, relays, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(input.id, input.url, input.secret, JSON.stringify(input.events), JSON.stringify(input.relays), createdAt);
    return { id: input.id, url: input.url, events: input.events, relays: input.relays, createdAt, failures: 0, active: true };
  }

  listWebhooks(): Array<WebhookSubscription & { secret: string }> {
    const rows = this.db.prepare("select * from webhooks order by created_at").all() as Array<{
      id: string;
      url: string;
      secret: string;
      events: string;
      relays: string;
      created_at: string;
      failures: number;
      active: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      secret: row.secret,
      events: JSON.parse(row.events) as CatalogEvent[],
      relays: JSON.parse(row.relays) as string[],
      createdAt: row.created_at,
      failures: row.failures,
      active: row.active === 1,
    }));
  }

  removeWebhook(id: string): boolean {
    return this.db.prepare("delete from webhooks where id = ?").run(id).changes > 0;
  }

  recordDelivery(input: { id: string; webhookId: string; event: CatalogEvent; relayId: string; at: string; status: number | null; error: string | null; attempts: number }): void {
    this.db
      .prepare("insert into deliveries (id, webhook_id, event, relay_id, at, status, error, attempts) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.webhookId, input.event, input.relayId, input.at, input.status, input.error, input.attempts);
    const ok = input.status !== null && input.status >= 200 && input.status < 300;
    if (ok) this.db.prepare("update webhooks set failures = 0, active = 1 where id = ?").run(input.webhookId);
    // Fifty failures in a row and the endpoint is gone; it stays listed, inactive, so the owner can see why.
    else this.db.prepare("update webhooks set failures = failures + 1, active = case when failures + 1 < 50 then 1 else 0 end where id = ?").run(input.webhookId);
  }

  listDeliveries(webhookId: string, limit = 50): unknown[] {
    return this.db.prepare("select id, event, relay_id as relay, at, status, error, attempts from deliveries where webhook_id = ? order by at desc limit ?").all(webhookId, limit);
  }

  // --- peers ------------------------------------------------------------------

  addPeer(url: string): boolean {
    return this.db.prepare("insert or ignore into peers (url, added_at) values (?, ?)").run(url, new Date().toISOString()).changes > 0;
  }

  listPeers(): Array<{ url: string; addedAt: string; syncedAt: string | null; lastError: string | null }> {
    const rows = this.db.prepare("select * from peers order by added_at").all() as Array<{ url: string; added_at: string; synced_at: string | null; last_error: string | null }>;
    return rows.map((row) => ({ url: row.url, addedAt: row.added_at, syncedAt: row.synced_at, lastError: row.last_error }));
  }

  removePeer(url: string): boolean {
    return this.db.prepare("delete from peers where url = ?").run(url).changes > 0;
  }

  markPeer(url: string, error: string | null): void {
    this.db.prepare("update peers set synced_at = ?, last_error = ? where url = ?").run(new Date().toISOString(), error, url);
  }
}

function searchText(record: RelayRecord): string {
  const d = record.descriptor;
  return [record.id, d.name, d.description, d.url, ...(d.tags ?? []), ...record.tools.map((tool) => `${tool.name} ${tool.description ?? ""}`)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
