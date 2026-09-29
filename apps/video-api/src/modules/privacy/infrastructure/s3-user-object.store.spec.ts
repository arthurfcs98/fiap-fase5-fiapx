import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
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

  it('lists every object of the bucket with its upload time', async () => {
    const at = new Date('2026-10-10T10:00:00Z');
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'u1/v1.mp4', LastModified: at }, {}],
        IsTruncated: true,
        NextContinuationToken: 't1',
      })
      .mockResolvedValueOnce({ Contents: [{ Key: 'u2/v2.mkv' }] });
    const store = new S3UserObjectStore({ send }, { delete: jest.fn() });

    await expect(store.listObjects('fiapx-raw')).resolves.toEqual([
      { key: 'u1/v1.mp4', lastModified: at },
      { key: 'u2/v2.mkv', lastModified: undefined },
    ]);
    expect((send.mock.calls[0]?.[0] as ListObjectsV2Command).input).toEqual({
      Bucket: 'fiapx-raw',
      ContinuationToken: undefined,
    });
  });

  it('aborts only the multipart uploads started before the cutoff (paginated)', async () => {
    const cutoff = new Date('2026-10-10T12:00:00Z');
    const old = new Date('2026-10-10T10:00:00Z');
    const recent = new Date('2026-10-10T11:59:59Z');
    const send = jest.fn((command: unknown) => {
      if (command instanceof ListMultipartUploadsCommand) {
        return Promise.resolve(
          command.input.KeyMarker === undefined
            ? {
                Uploads: [
                  { Key: 'u1/v1.mp4', UploadId: 'up-1', Initiated: old },
                  { Key: 'u1/v2.mp4', UploadId: 'up-2', Initiated: cutoff },
                  { Key: 'u1/v3.mp4' },
                ],
                IsTruncated: true,
                NextKeyMarker: 'u1/v3.mp4',
                NextUploadIdMarker: 'up-3',
              }
            : { Uploads: [{ Key: 'u2/v4.zip', UploadId: 'up-4', Initiated: recent }] },
        );
      }
      return Promise.resolve({});
    });
    const store = new S3UserObjectStore({ send }, { delete: jest.fn() });

    await expect(store.abortIncompleteUploads('fiapx-raw', recent)).resolves.toBe(1);

    const commands: unknown[] = send.mock.calls.map(([command]) => command);
    const aborts = commands
      .filter((command) => command instanceof AbortMultipartUploadCommand)
      .map((command) => command.input);
    expect(aborts).toEqual([{ Bucket: 'fiapx-raw', Key: 'u1/v1.mp4', UploadId: 'up-1' }]);
    const listings = commands.filter((command) => command instanceof ListMultipartUploadsCommand);
    expect(listings[1]?.input).toMatchObject({
      KeyMarker: 'u1/v3.mp4',
      UploadIdMarker: 'up-3',
    });
  });

  it('uploads without an initiation time count as old; no uploads = nothing to abort', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ Uploads: [{ Key: 'k', UploadId: 'u' }] })
      .mockResolvedValue({});
    const store = new S3UserObjectStore({ send }, { delete: jest.fn() });

    await expect(store.abortIncompleteUploads('b', new Date())).resolves.toBe(1);
    await expect(store.abortIncompleteUploads('b', new Date())).resolves.toBe(0);
  });
});
