import { composeImage } from '@fiapx/testing';
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';

/**
 * Mailpit in a disposable container, with the SAME image (tag + digest) as the compose stack,
 * plus its HTTP API: the integration test asserts the e-mail really arrived. "Chaos" is enabled
 * so the test can make the SMTP server answer 451 (transient) or 550 (permanent) on RCPT TO.
 *
 * Kept inside the app (not in `test/support`, which belongs to the foundation); it can move to
 * `@fiapx/testing` if another project needs it.
 */
export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitSummary {
  ID: string;
  MessageID: string;
  To: MailpitAddress[];
  Subject: string;
}

export interface MailpitMessage extends MailpitSummary {
  From: MailpitAddress;
  HTML: string;
  Text: string;
}

export interface ChaosTrigger {
  ErrorCode: number;
  /** 0-100. */
  Probability: number;
}

export interface StartedMailpit {
  container: StartedTestContainer;
  smtpHost: string;
  smtpPort: number;
  apiUrl: string;
  /** Messages whose recipients include `address` (newest first). */
  messagesTo(address: string): Promise<MailpitSummary[]>;
  message(id: string): Promise<MailpitMessage>;
  headers(id: string): Promise<Record<string, string[]>>;
  /** Makes RCPT TO fail with `ErrorCode` (`Probability: 0` turns it off). */
  setRecipientChaos(trigger: ChaosTrigger): Promise<void>;
  stop(): Promise<void>;
}

export async function startMailpit(): Promise<StartedMailpit> {
  const container = await new GenericContainer(composeImage('mailpit'))
    .withEnvironment({
      MP_SMTP_AUTH_ACCEPT_ANY: '1',
      MP_SMTP_AUTH_ALLOW_INSECURE: '1',
      MP_ENABLE_CHAOS: 'true',
    })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .withStartupTimeout(60_000)
    .start();
  const host = container.getHost();
  const apiUrl = `http://${host}:${container.getMappedPort(8025)}`;

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiUrl}${path}`, init);
    if (!response.ok) throw new Error(`Mailpit ${path}: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  return {
    container,
    smtpHost: host,
    smtpPort: container.getMappedPort(1025),
    apiUrl,
    messagesTo: async (address) => {
      const list = await api<{ messages: MailpitSummary[] }>('/api/v1/messages?limit=500');
      return list.messages.filter((message) =>
        message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()),
      );
    },
    message: (id) => api<MailpitMessage>(`/api/v1/message/${id}`),
    headers: (id) => api<Record<string, string[]>>(`/api/v1/message/${id}/headers`),
    setRecipientChaos: async (trigger) => {
      await api('/api/v1/chaos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Recipient: trigger }),
      });
    },
    stop: async () => {
      await container.stop();
    },
  };
}
