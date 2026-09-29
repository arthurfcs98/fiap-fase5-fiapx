import type { ApiConfig } from '../../../config/api.config';

/** Auth settings derived from the configuration (keeps `process.env` out of the use cases). */
export interface AuthSettings {
  /** Version stored with the consent (`users.privacy_policy_version`). */
  privacyPolicyVersion: string;
}

export const AUTH_SETTINGS = Symbol('AUTH_SETTINGS');

export function authSettingsFromConfig(config: ApiConfig): AuthSettings {
  return { privacyPolicyVersion: config.PRIVACY_POLICY_VERSION };
}
