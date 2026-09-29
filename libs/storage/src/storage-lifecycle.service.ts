import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT } from './storage.options';

/** Fecha os sockets do cliente S3 no shutdown. */
@Injectable()
export class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly client: S3Client) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
