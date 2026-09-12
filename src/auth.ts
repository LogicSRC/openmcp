/**
 * Who is signed in, and how they got there.
 *
 * The way in from nothing is an emailed link, and it doubles as registration:
 * proving you can read an address is the whole requirement, so an unknown
 * address makes the account rather than being turned away. The link is a
 * random token whose hash is kept; it works once and for twenty minutes.
 *
 * Nothing here says whether an address has an account. The answer to "send
 * me a link" is the same whatever the address, and so is the answer to a
 * rate limit, because a different answer would let anyone list who has
 * registered.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Catalog } from "./db.ts";
import type { Mailer } from "./mail.ts";

/** Twenty minutes. A link left in an inbox should stop being a key fairly quickly. */
export const LINK_MS = 20 * 60 * 1000;
/** Links per address per hour, before we stop sending and still say "sent". */
export const MAX_LINKS_PER_HOUR = 5;
/** Thirty days of session. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "openmcp_session";

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export function looksLikeEmail(value: unknown): value is string {
  const email = String(value ?? "").trim();
  return email.length <= 254 && EMAIL_RE.test(email);
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface AuthContext {
  store: Catalog;
  mailer: Mailer;
  /** The catalog's public origin, for the link. */
  url: string;
  name?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export type LinkOutcome = { ok: true } | { ok: false; error: "invalid-email" | "email-not-configured" | "send-failed" };

/**
 * Issue a sign-in link and email it. The outcome is the same to the caller
 * whether the address is new, known, or over its hourly limit; only a
 * malformed address or mail being off is reported.
 */
export async function requestSignInLink(ctx: AuthContext, email: unknown): Promise<LinkOutcome> {
  if (!looksLikeEmail(email)) return { ok: false, error: "invalid-email" };
  const now = (ctx.now ?? (() => new Date()))();
  const address = normalizeEmail(email);
  const recent = ctx.store.countLoginTokensSince(address, new Date(now.getTime() - 60 * 60 * 1000).toISOString());
  if (recent >= MAX_LINKS_PER_HOUR) {
    ctx.log?.(`sign-in link for ${address} not sent: ${recent} in the last hour`);
    return { ok: true };
  }
  const token = newToken();
  ctx.store.insertLoginToken({ tokenHash: hashToken(token), email: address, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + LINK_MS).toISOString() });
  const link = `${ctx.url.replace(/\/+$/, "")}/auth/magic?t=${encodeURIComponent(token)}`;
  const site = ctx.name ?? "OpenMCP";
  const sent = await ctx.mailer.send({
    to: address,
    subject: `Your ${site} sign-in link`,
    text: [`Here is your sign-in link for ${site}:`, "", link, "", "It works once and expires in 20 minutes.", "If you did not ask for this, ignore it; nothing has changed."].join("\n"),
  });
  if (!sent.ok) return { ok: false, error: sent.error === "email-not-configured" ? "email-not-configured" : "send-failed" };
  return { ok: true };
}

export type ConsumeOutcome = { ok: true; userId: string; email: string; created: boolean; session: string } | { ok: false; error: "invalid-or-expired" };

/** Spend a link. Expired, used and never-existed are one answer: ask for a new one. */
export function consumeSignInLink(ctx: AuthContext, token: unknown): ConsumeOutcome {
  const raw = typeof token === "string" ? token.trim() : "";
  if (!raw) return { ok: false, error: "invalid-or-expired" };
  const now = (ctx.now ?? (() => new Date()))();
  const email = ctx.store.consumeLoginToken(hashToken(raw), now.toISOString());
  if (!email) return { ok: false, error: "invalid-or-expired" };
  const user = ctx.store.findOrCreateUser(email, now.toISOString());
  const session = newToken();
  ctx.store.createSession({ idHash: hashToken(session), userId: user.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_MS).toISOString() });
  return { ok: true, userId: user.id, email: user.email, created: user.created, session };
}

export interface SessionUser {
  id: string;
  email: string;
}

/** The user behind a session cookie value, or null. */
export function userForSession(ctx: AuthContext, session: string | undefined): SessionUser | null {
  if (!session) return null;
  const now = (ctx.now ?? (() => new Date()))().toISOString();
  return ctx.store.userForSession(hashToken(session), now);
}

export function endSession(ctx: AuthContext, session: string | undefined): void {
  if (session) ctx.store.deleteSession(hashToken(session));
}

/** Read one cookie out of a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function sessionCookie(value: string, secure: boolean, maxAgeMs = SESSION_MS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

export const clearedSessionCookie = (secure: boolean): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
