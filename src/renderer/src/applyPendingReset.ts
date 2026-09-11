/**
 * Finishes a "Log out and reset" on the page the logout returns to: wipes this device's
 * local data when the logout asked for it (`state=logged_out_reset`, see oidc.php).
 *
 * A side-effect module on purpose, imported FIRST by login.tsx. The store's slices read
 * localStorage while their modules are evaluated, and ES modules run in import order — any
 * later and the old values would already sit in memory, to be written straight back by the
 * next dispatch.
 */
import { clearLocalData, takeStorageResetMarker } from '@/utils/localDataReset';

if (takeStorageResetMarker()) {
  clearLocalData();
}
