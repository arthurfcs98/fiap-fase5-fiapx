/** Business metrics of the video-api (contratos.md, section 11). */
export interface VideoMetrics {
  uploaded(): void;
  /**
   * A video reached COMPLETED `turnaroundSeconds` after its upload (queue wait included: the
   * "tempo até o resultado" SLI, contratos.md section 13).
   */
  completed(turnaroundSeconds: number): void;
  failed(errorCode: string): void;
}

export const VIDEO_METRICS = Symbol('VIDEO_METRICS');
