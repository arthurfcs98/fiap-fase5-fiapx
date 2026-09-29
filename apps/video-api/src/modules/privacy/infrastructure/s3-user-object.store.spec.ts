import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3UserObjectStore } from './s3-user-object.store';

describe('S3UserObjectStore', () => {
  it('lists the owner prefixes (paginated, Delimiter "/")', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        CommonPrefixes: [{ Prefix: 'u1/' }, {}],
        IsTruncated: true,
        NextContinuationToken: 't1',
      })
      .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'u2/' }], IsTruncated: false });
    const store = new S3UserObjectStore({ send }, { delete: jest.fn() });

    await expect(store.listOwnerIds('fiapx-raw')).resolves.toEqual(['u1', 'u2']);
    const first = send.mock.calls[0]?.[0] as ListObjectsV2Command;
    expect(first).toBeInstanceOf(ListObjectsV2Command);
    expect(first.input).toMatchObject({ Bucket: 'fiapx-raw', Delimiter: '/' });
    expect((send.mock.calls[1]?.[0] as ListObjectsV2Command).input.ContinuationToken).toBe('t1');
  });

  it('deletes every object under {userId}/ through the storage port', async () => {
    const send = jest.fn().mockResolvedValue({
      Contents: [{ Key: 'u1/a.mp4' }, { Key: 'u1/a.zip' }, {}],
      IsTruncated: false,
    });
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const store = new S3UserObjectStore({ send }, storage);

    await expect(store.deleteAllOf('fiapx-zips', 'u1')).resolves.toBe(2);
    expect((send.mock.calls[0]?.[0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: 'fiapx-zips',
      Prefix: 'u1/',
    });
    expect(storage.delete.mock.calls).toEqual([
      ['fiapx-zips', 'u1/a.mp4'],
      ['fiapx-zips', 'u1/a.zip'],
    ]);
  });

  it('handles empty listings', async () => {
    const store = new S3UserObjectStore(
      { send: jest.fn().mockResolvedValue({}) },
      { delete: jest.fn() },
    );
    await expect(store.listOwnerIds('b')).resolves.toEqual([]);
    await expect(store.deleteAllOf('b', 'u')).resolves.toBe(0);
  });
});
