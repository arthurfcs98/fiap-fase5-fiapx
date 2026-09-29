import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { stack } from './env';

export const BUCKETS = { raw: 'fiapx-raw', zips: 'fiapx-zips' } as const;

let client: S3Client | undefined;

function s3(): S3Client {
  const { endpoint, accessKeyId, secretAccessKey } = stack.s3;
  client ??= new S3Client({
    endpoint,
    region: 'garage',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

/** Object keys under a prefix (contratos.md, section 7: `{userId}/...`). */
export async function listKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    keys.push(...(page.Contents ?? []).map((object) => object.Key ?? ''));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Raw object of a video (`{userId}/{videoId}{ext}`), if it still exists. */
export async function rawObjectsOf(userId: string, videoId: string): Promise<string[]> {
  return listKeys(BUCKETS.raw, `${userId}/${videoId}`);
}

export function closeStorage(): void {
  client?.destroy();
  client = undefined;
}
