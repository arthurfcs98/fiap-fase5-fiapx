import type { ApiConfig } from '../../../config/api.config';

export interface VideoSettings {
  maxUploadMb: number;
  maxUploadBytes: number;
  /** Origin of the signed download links. */
  publicBaseUrl: string;
  /** Signed link lifetime (contract: 5 minutes). */
  downloadUrlTtlSeconds: number;
  /** LGPD retention of the zips (`ZIP_RETENTION_DAYS`). */
  zipRetentionDays: number;
}

export const VIDEO_SETTINGS = Symbol('VIDEO_SETTINGS');

export const DOWNLOAD_URL_TTL_SECONDS = 300;

const MB = 1024 * 1024;

export function videoSettingsFromConfig(config: ApiConfig): VideoSettings {
  return {
    maxUploadMb: config.MAX_UPLOAD_MB,
    maxUploadBytes: config.MAX_UPLOAD_MB * MB,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    downloadUrlTtlSeconds: DOWNLOAD_URL_TTL_SECONDS,
    zipRetentionDays: config.ZIP_RETENTION_DAYS,
  };
}
