/** Business counters of the video-api (contratos.md, section 11). */
export interface VideoMetrics {
  uploaded(): void;
  completed(): void;
  failed(errorCode: string): void;
}

export const VIDEO_METRICS = Symbol('VIDEO_METRICS');
