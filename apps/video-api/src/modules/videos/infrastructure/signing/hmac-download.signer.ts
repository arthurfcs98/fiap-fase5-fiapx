import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DownloadSigner } from '../../application/ports/download.signer';

/**
 * `sig = base64url(HMAC-SHA256(DOWNLOAD_URL_SECRET, "v1:<videoId>:<exp>"))`, compared in
 * constant time. The version prefix allows changing the format without accepting old links.
 */
export class HmacDownloadSigner implements DownloadSigner {
  constructor(private readonly secret: string) {}

  sign(videoId: string, expiresAt: number): string {
    return createHmac('sha256', this.secret)
      .update(`v1:${videoId}:${expiresAt}`)
      .digest('base64url');
  }

  verify(videoId: string, expiresAt: number, signature: string): boolean {
    const expected = Buffer.from(this.sign(videoId, expiresAt));
    const received = Buffer.from(signature);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
}
