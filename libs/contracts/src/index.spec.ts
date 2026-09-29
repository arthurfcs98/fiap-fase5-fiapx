import * as fixtures from '@fiapx/contracts/fixtures';
import * as contracts from './index';

describe('barrel de @fiapx/contracts', () => {
  it('não exporta fixtures (não entram no bundle de produção)', () => {
    const names = Object.keys(contracts);
    expect(names.some((name) => name.endsWith('Fixture') || /FIXTURE/.test(name))).toBe(false);
    expect(contracts.videoUploadedEvent).toBeDefined();
  });

  it('expõe os eventos de vídeo, de usuário e o registro pelo barrel', () => {
    expect(contracts.EVENT_TYPES.userDeleted).toBe('user.deleted');
    expect(contracts.userDeletedEvent).toBeDefined();
    expect(contracts.notificationEvent).toBeDefined();
    expect(contracts.EVENT_SCHEMAS['user.deleted']).toBe(contracts.userDeletedEvent);
  });

  it('expõe as fixtures pelo subpath @fiapx/contracts/fixtures', () => {
    expect(fixtures.videoUploadedFixture.type).toBe(contracts.EVENT_TYPES.videoUploaded);
    expect(fixtures.EVENT_FIXTURES['user.deleted']).toBe(fixtures.userDeletedFixture);
  });
});
