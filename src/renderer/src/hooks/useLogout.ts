import { useCallback } from 'react';
import { useUpdateSetting } from '@/store/settingsSlice';
import { oidcLogoutUrl } from '@/utils';
import { clearLocalData, type ResetOptions } from '@/utils/localDataReset';

/**
 * Signs out through the backend's OIDC logout, optionally resetting this device on the way.
 *
 * Hands off to `oidc?logout=1`, which destroys the PHP session AND ends the provider session
 * before returning to the login page. Calling DELETE /rest/Session first would destroy the
 * session that still holds the id_token needed for that.
 */
export const useLogout = () => {
  const updateSetting = useUpdateSetting();

  return useCallback(
    (reset?: Partial<ResetOptions>) => {
      // So the login page does not default back to the same account (especially important
      // when logging out of admin).
      updateSetting('lastSelectedAccount', '');
      // Offline mode would otherwise outlive the logout, and the login page forwards an
      // offline device straight back into an app that fetches nothing: a device that looks
      // signed in but sees no data.
      updateSetting('offlineMode', false);
      // Wiped here as well as on the page the logout returns to — that return never comes
      // when the provider rejects the logout, and the device should be reset regardless.
      if (reset?.storage) clearLocalData();
      window.location.assign(oidcLogoutUrl(reset));
    },
    [updateSetting],
  );
};
