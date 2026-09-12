/**
 * The catalog on disk: SQLite, built into Node, one file.
 *
 * Records are kept whole as JSON in a column beside the few fields a query
 * narrows on, so a descriptor field added tomorrow needs no migration. The
 * schema is idempotent and applied at open.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
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
create table if not exists users (
  id           text primary key,
  email        text not null unique,
  created_at   text not null,
  last_seen_at text
);
create table if not exists login_tokens (
  token_hash text primary key,
  email      text not null,
  created_at text not null,
  expires_at text not null,
  used_at    text
);
create index if not exists login_tokens_email_idx on login_tokens(email, created_at desc);
create table if not exists sessions (
  id_hash    text primary key,
  user_id    text not null references users(id) on delete cascade,
  created_at text not null,
  expires_at text not null
);
`;

/** Columns added after the first release, applied when missing. */
const COLUMNS: Array<{ table: string; column: string; ddl: string }> = [{ table: "relays", column: "owner_id", ddl: "alter table relays add column owner_id text" }];

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
    for (const { table, column, ddl } of COLUMNS) {
      const present = (this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
      if (!present) this.db.exec(ddl);
    }
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

  /** Who registered a relay while signed in, or null for an anonymous one. */
  relayOwner(id: string): string | null {
    const row = this.db.prepare("select owner_id from relays where id = ?").get(id) as { owner_id: string | null } | undefined;
    return row?.owner_id ?? null;
  }

  setRelayOwner(id: string, ownerId: string | null): void {
    this.db.prepare("update relays set owner_id = ? where id = ?").run(ownerId, id);
  }

  listRelaysByOwner(ownerId: string): RelayRecord[] {
    const rows = this.db.prepare("select record from relays where owner_id = ? order by seen_at desc").all(ownerId) as { record: string }[];
    return rows.map((row) => JSON.parse(row.record) as RelayRecord);
  }

  /** Every tag in use, with how many relays carry it. */
  tags(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();
    for (const record of this.listRelays({ limit: 500 })) {
      for (const tag of record.descriptor.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // --- users ------------------------------------------------------------------

  findOrCreateUser(email: string, now: string): { id: string; email: string; created: boolean } {
    const existing = this.db.prepare("select id, email from users where email = ?").get(email) as { id: string; email: string } | undefined;
    if (existing) {
      this.db.prepare("update users set last_seen_at = ? where id = ?").run(now, existing.id);
      return { ...existing, created: false };
    }
    const id = randomUUID();
    this.db.prepare("insert into users (id, email, created_at, last_seen_at) values (?, ?, ?, ?)").run(id, email, now, now);
    return { id, email, created: true };
  }

  getUser(id: string): { id: string; email: string; createdAt: string } | null {
    const row = this.db.prepare("select id, email, created_at from users where id = ?").get(id) as { id: string; email: string; created_at: string } | undefined;
    return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null;
  }

  countLoginTokensSince(email: string, since: string): number {
    const row = this.db.prepare("select count(*) as n from login_tokens where email = ? and created_at >= ?").get(email, since) as { n: number };
    return Number(row.n);
  }

  insertLoginToken(input: { tokenHash: string; email: string; createdAt: string; expiresAt: string }): void {
    this.db.prepare("insert into login_tokens (token_hash, email, created_at, expires_at) values (?, ?, ?, ?)").run(input.tokenHash, input.email, input.createdAt, input.expiresAt);
  }

  /** Mark a token used and return its address; null when it is unknown, spent or expired. */
  consumeLoginToken(tokenHash: string, now: string): string | null {
    const row = this.db.prepare("select email from login_tokens where token_hash = ? and used_at is null and expires_at > ?").get(tokenHash, now) as { email: string } | undefined;
    if (!row) return null;
    this.db.prepare("update login_tokens set used_at = ? where token_hash = ?").run(now, tokenHash);
    return row.email;
  }

  createSession(input: { idHash: string; userId: string; createdAt: string; expiresAt: string }): void {
    this.db.prepare("insert into sessions (id_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)").run(input.idHash, input.userId, input.createdAt, input.expiresAt);
  }

  userForSession(idHash: string, now: string): { id: string; email: string } | null {
    const row = this.db
      .prepare("select u.id, u.email from sessions s join users u on u.id = s.user_id where s.id_hash = ? and s.expires_at > ?")
      .get(idHash, now) as { id: string; email: string } | undefined;
    return row ?? null;
  }

  deleteSession(idHash: string): void {
    this.db.prepare("delete from sessions where id_hash = ?").run(idHash);
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
