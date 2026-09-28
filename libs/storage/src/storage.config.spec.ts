import { z } from 'zod';
import { storageConfigShape } from './storage.config';

const schema = z.object(storageConfigShape);
const minimal = {
  S3_ENDPOINT: 'http://garage:3900',
  S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
  S3_SECRET_ACCESS_KEY: 'x'.repeat(64),
};

describe('storageConfigShape', () => {
  it('aplica defaults do Garage (região, buckets e path-style)', () => {
    expect(schema.parse(minimal)).toEqual({
      ...minimal,
      S3_REGION: 'garage',
      S3_BUCKET_RAW: 'fiapx-raw',
      S3_BUCKET_ZIPS: 'fiapx-zips',
      S3_FORCE_PATH_STYLE: true,
    });
  });

  it('aceita S3_FORCE_PATH_STYLE=false', () => {
    expect(schema.parse({ ...minimal, S3_FORCE_PATH_STYLE: 'false' }).S3_FORCE_PATH_STYLE).toBe(
      false,
    );
  });

  it('rejeita endpoint inválido e credenciais curtas', () => {
    const result = schema.safeParse({
      S3_ENDPOINT: 'garage:3900 sem esquema',
      S3_ACCESS_KEY_ID: 'GK1',
      S3_SECRET_ACCESS_KEY: 'curta',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      'S3_ACCESS_KEY_ID',
      'S3_ENDPOINT',
      'S3_SECRET_ACCESS_KEY',
    ]);
  });
});
