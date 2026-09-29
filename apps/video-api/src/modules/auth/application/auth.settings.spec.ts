import { testConfig } from '../../../../test/support/config';
import { authSettingsFromConfig } from './auth.settings';

describe('authSettingsFromConfig', () => {
  it('takes the privacy policy version from the configuration', () => {
    expect(authSettingsFromConfig(testConfig({ PRIVACY_POLICY_VERSION: '2027-01-01' }))).toEqual({
      privacyPolicyVersion: '2027-01-01',
    });
  });
});
