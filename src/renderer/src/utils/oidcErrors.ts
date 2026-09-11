import type { useI18nContext } from '@/i18n/i18n-react';

/**
 * A short title for an `oidc.*` error code, as the backend reports it on `/unauthorized?error=`.
 *
 * Shared by the web's unauthorized page and the desktop app's login page: a desktop sign-in is
 * finished in a hidden window, so a rejection there is brought back to the login page instead.
 */
export const oidcErrorTitle = (LL: ReturnType<typeof useI18nContext>['LL'], code: string | null): string => {
  switch (code) {
    case 'oidc.admin_access_denied':
      return LL.ERRORS.ADMIN_ACCESS_DENIED();
    case 'oidc.admin_config_missing':
      return LL.ERRORS.ADMIN_CONFIG_MISSING();
    case 'oidc.access_denied':
      return LL.ERRORS.ACCESS_DENIED();
    case 'oidc.no_account':
      return LL.ERRORS.NO_ACCOUNT();
    case 'oidc.no_license':
      return LL.ERRORS.NO_LICENSE_TITLE();
    case 'oidc.invalid_license':
      return LL.ERRORS.INVALID_LICENSE_TITLE();
    case 'oidc.no_provider':
      return LL.ERRORS.NO_PROVIDER_TITLE();
    case 'oidc.invalid_state':
      return LL.ERRORS.INVALID_STATE();
    case 'oidc.token_exchange_failed':
      return LL.ERRORS.TOKEN_EXCHANGE_FAILED();
    case 'oidc.userinfo_failed':
      return LL.ERRORS.USERINFO_FAILED();
    case 'oidc.authentication_failed':
      return LL.ERRORS.AUTHENTICATION_FAILED();
    case 'oidc.auth_url_failed':
      return LL.ERRORS.AUTH_URL_FAILED();
    default:
      return LL.ERRORS.UNKNOWN();
  }
};
