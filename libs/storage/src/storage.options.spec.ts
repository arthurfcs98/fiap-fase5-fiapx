import { resolveBuckets, storageOptionsFromConfig } from './storage.options';

const config = {
  S3_ENDPOINT: 'http://garage:3900',
  S3_REGION: 'garage',
  S3_BUCKET_RAW: 'raw-x',
  S3_BUCKET_ZIPS: 'zips-x',
  S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
  S3_SECRET_ACCESS_KEY: 'y'.repeat(64),
  S3_FORCE_PATH_STYLE: true,
};

describe('storage.options', () => {
  it('converte as variáveis S3_* nas opções do módulo', () => {
    expect(storageOptionsFromConfig(config)).toEqual({
      endpoint: 'http://garage:3900',
      region: 'garage',
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: true,
      buckets: { raw: 'raw-x', zips: 'zips-x' },
    });
  });

  it('resolveBuckets usa os buckets padrão quando não informados', () => {
    const base = storageOptionsFromConfig(config);
    expect(resolveBuckets(base)).toEqual({ raw: 'raw-x', zips: 'zips-x' });
    expect(resolveBuckets({ ...base, buckets: undefined })).toEqual({
      raw: 'fiapx-raw',
      zips: 'fiapx-zips',
    });
  });
});
