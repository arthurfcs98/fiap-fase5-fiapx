import * as fixtures from '@fiapx/contracts/fixtures';
import * as contracts from './index';

describe('barrel de @fiapx/contracts', () => {
  it('não exporta fixtures (não entram no bundle de produção)', () => {
    expect(Object.keys(contracts).some((name) => name.endsWith('Fixture'))).toBe(false);
    expect(contracts.videoUploadedEvent).toBeDefined();
  });

  it('expõe as fixtures pelo subpath @fiapx/contracts/fixtures', () => {
    expect(fixtures.videoUploadedFixture.type).toBe(contracts.EVENT_TYPES.videoUploaded);
  });
});
