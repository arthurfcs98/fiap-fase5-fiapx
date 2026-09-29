import { aUser, aVideo } from '../../../../test/support/fakes';
import { terminalEventFor } from './video-events';

describe('terminalEventFor', () => {
  it('builds nothing for non-terminal videos', () => {
    expect(terminalEventFor(aVideo({ status: 'PROCESSING' }), aUser(), 'cid')).toBeNull();
  });

  it('uses safe fallbacks when optional columns are empty', () => {
    const completed = terminalEventFor(
      aVideo({ status: 'COMPLETED', frameCount: null }),
      aUser(),
      'cid',
    );
    expect(completed).toMatchObject({ type: 'video.completed', payload: { frameCount: 1 } });
    const failed = terminalEventFor(
      aVideo({ status: 'FAILED', errorCode: null, errorMessage: null }),
      aUser(),
      'cid',
    );
    expect(failed).toMatchObject({
      type: 'video.failed',
      payload: { errorCode: 'P0099', errorMessage: '' },
    });
  });
});
