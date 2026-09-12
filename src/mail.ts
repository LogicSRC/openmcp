/**
 * One way to send mail: Resend's REST API, by fetch, no SDK.
 *
 * Without a key nothing is sent; the caller decides what that means. The
 * catalog prints the sign-in link to its log in that case so a local run can
 * still be signed into, and says so loudly.
 */
export interface MailOptions {
  /** RESEND_API_KEY. Absent means mail is off. */
  resendKey?: string;
  /** "Name <address>", the sender. */
  from?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  enabled: boolean;
  send(mail: Mail): Promise<{ ok: boolean; error?: string }>;
}

export function createMailer(options: MailOptions = {}): Mailer {
  const fetcher = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const from = options.from ?? "OpenMCP <openmcp@localhost>";
  if (!options.resendKey) {
    return {
      enabled: false,
      async send(mail) {
        log(`mail is off (no RESEND_API_KEY); would have sent to ${mail.to}: ${mail.subject}\n${mail.text}`);
        return { ok: false, error: "email-not-configured" };
      },
    };
  }
  return {
    enabled: true,
    async send(mail) {
      try {
        const response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${options.resendKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          log(`resend answered ${response.status} for ${mail.to}: ${body.slice(0, 200)}`);
          return { ok: false, error: `send-failed-${response.status}` };
        }
        return { ok: true };
      } catch (error) {
        log(`resend failed for ${mail.to}: ${(error as Error).message}`);
        return { ok: false, error: "send-failed" };
      }
    },
  };
}
