import { Client } from 'pg';
import { stack } from './env';

/** One query against a service database, through the published Postgres port. */
export async function queryDb<T extends Record<string, unknown>>(
  database: 'fiapx_video' | 'fiapx_notification',
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const video = database === 'fiapx_video';
  const client = new Client({
    ...stack.postgres,
    database,
    user: video ? 'fiapx_video' : 'fiapx_notification',
    password: video ? stack.videoDbPassword : stack.notificationDbPassword,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/** Messages Mailpit received for one address (newest first). */
export async function mailsTo(address: string): Promise<MailpitMessage[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const res = await fetch(`${stack.mailpitUrl}/api/v1/search?query=${query}`);
  if (!res.ok) throw new Error(`Mailpit respondeu ${res.status}`);
  const body = (await res.json()) as { messages?: MailpitMessage[] };
  return body.messages ?? [];
}

/** Text body and headers of one Mailpit message. */
export async function mailDetail(
  id: string,
): Promise<{ text: string; headers: Record<string, string[]> }> {
  const [message, headers] = await Promise.all([
    fetch(`${stack.mailpitUrl}/api/v1/message/${id}`).then(
      (r) => r.json() as Promise<{ Text: string }>,
    ),
    fetch(`${stack.mailpitUrl}/api/v1/message/${id}/headers`).then(
      (r) => r.json() as Promise<Record<string, string[]>>,
    ),
  ]);
  return { text: message.Text, headers };
}

/** Ready messages of a RabbitMQ queue (management API, vhost "/"). */
export async function queueDepth(queue: string): Promise<number> {
  const auth = Buffer.from(`fiapx:${stack.rabbitmqPassword}`).toString('base64');
  const res = await fetch(`${stack.rabbitmqUrl}/api/queues/%2F/${encodeURIComponent(queue)}`, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`RabbitMQ respondeu ${res.status} para a fila ${queue}`);
  const body = (await res.json()) as { messages?: number };
  return body.messages ?? 0;
}
