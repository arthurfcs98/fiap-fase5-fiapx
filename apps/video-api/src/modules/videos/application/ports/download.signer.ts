/** Signed download links (HMAC): `GET /api/downloads/:id?exp=&sig=` needs no Bearer token. */
export interface DownloadSigner {
  /** `expiresAt` in epoch seconds. */
  sign(videoId: string, expiresAt: number): string;
  verify(videoId: string, expiresAt: number, signature: string): boolean;
}

export const DOWNLOAD_SIGNER = Symbol('DOWNLOAD_SIGNER');
