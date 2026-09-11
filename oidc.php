<?php

require_once(__DIR__ . '/classes/Cors.php');
require_once(__DIR__ . '/classes/OidcClient.php');
require_once(__DIR__ . '/classes/Auth.php');
require_once(__DIR__ . '/classes/MetricsHelper.php');
require_once(__DIR__ . '/config.php');
require_once(__DIR__ . '/classes/Logging.php');
require_once(__DIR__ . '/classes/DB.php');

// OIDC callback handler for browser redirects
// This file is called directly by the OIDC provider after login

Cors::handle();
Cors::configureSession();

session_start();
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
if (isset($_GET['error'])) {
    unset($_SESSION['oidc_state'], $_SESSION['oidc_transaction'], $_SESSION['redirect']);
    header('Location: /unauthorized?error=oidc.authentication_failed');
    exit;
}
// Repairs cookies issued under the older Origin-dependent SameSite rules, which could not
// survive the cross-site return from the IdP. Must run after session_start().
Cors::refreshSessionCookie();

if (isset($_GET['logout'])) {
    $idToken = $_SESSION['oidc_tokens']['id_token'] ?? null;
    $providerId = $_SESSION['oidc_provider_id'] ?? null;

    // Where to land after the provider has ended its session. Kept inside our own site.
    $postLogout = BASE_URL . 'login';
    // A post_logout_redirect_uri must match one of the URIs registered for the client
    // EXACTLY — OpenID providers compare the full string, query included. Anything we
    // append here (flags for the app, cache busters) therefore turns the logout into a
    // "post_logout_redirect_uri not registered" 400 at the provider. Strip the query and
    // fragment and carry the state we need in the `state` parameter instead, which the
    // provider appends to the redirect for us.
    $postLogoutBare = strtok($postLogout, '?#');
    if ($postLogoutBare !== $postLogout) {
        Logging::info('OIDC logout: dropped query/fragment from post_logout_redirect_uri ('
            . $postLogout . ' -> ' . $postLogoutBare . '); register the bare URI at the provider.');
        $postLogout = $postLogoutBare;
    }
    // "Log out and reset" — from the profile menu, or the same URL opened by hand on a stuck
    // device: `reset=cookies,storage`, either or both.
    $resetRaw = $_GET['reset'] ?? '';
    $reset = array_map('trim', explode(',', strtolower(is_string($resetRaw) ? $resetRaw : '')));
    $resetCookies = in_array('cookies', $reset, true);
    $resetStorage = in_array('storage', $reset, true);

    // Marks the return trip so the login page knows it is coming back from a logout and
    // must offer the account picker instead of signing straight back in. localStorage can
    // only be wiped by the page itself, so that request rides along in the same value; the
    // login page clears it before the app reads any of it (applyPendingReset.ts).
    $logoutState = $resetStorage ? 'logged_out_reset' : 'logged_out';
    $localFallback = $postLogout . '?state=' . $logoutState;

    if (!$idToken) {
        // No id_token to hand over. This is the normal shape of a repeated logout (a reload
        // of this URL, or a second tab): the first call already ended the provider session
        // and wiped ours. Calling end_session without an id_token_hint would either strand
        // the user on the provider's own signed-out page (post_logout_redirect_uri is only
        // honoured together with a hint) or be rejected outright, so go straight back to
        // the app instead of bouncing off the provider.
        Logging::info('OIDC logout without id_token — skipping the provider round-trip.');
        $logoutUrl = $localFallback;
    } else {
        // A tenant session was established through that account's own provider, so its
        // end_session_endpoint is the one that has to be called — the global config only
        // applies to admin logins. Using the global client here left the tenant's provider
        // session alive, and the next login was silently re-authenticated with no prompt,
        // making it impossible to switch accounts.
        $oidc = null;
        if ($providerId) {
            $providerRow = lookupProviderById((int)$providerId);
            if ($providerRow) {
                $oidc = OidcClient::fromProvider($providerRow);
            }
        }
        if ($oidc === null) {
            $oidc = OidcClient::fromGlobalConfig();
        }

        try {
            $logoutUrl = $oidc->getLogoutUrl($idToken, $postLogout, $logoutState);
        } catch (Throwable $e) {
            // Discovery unreachable — still drop the local session and go back to the login page.
            Logging::warning('OIDC logout URL lookup failed: ' . $e->getMessage());
            $logoutUrl = $localFallback;
        }
    }

    // Drop the local session completely (not just the OIDC keys), so a failed or
    // cancelled provider logout can never leave a half-authenticated session behind.
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();

    if ($resetCookies) {
        Cors::expireAllCookies();
    }

    header('Location: ' . $logoutUrl);
    exit;
}

// If no authorization code or state, start login
if (!isset($_GET['code']) && !isset($_GET['state'])) {
    // Optional redirect target after successful login
    $redirect = OidcProtocol::safeRedirect($_GET['redirect'] ?? null, BASE_URL);
    try {
        $state = bin2hex(random_bytes(16));
    } catch (Throwable $e) {
        $state = bin2hex(openssl_random_pseudo_bytes(16));
    }
    $_SESSION['oidc_state'] = $state;
    $_SESSION['redirect'] = $redirect;
    // Persist admin login intent across the OIDC redirect round-trip
    $_SESSION['oidc_admin'] = !empty($_GET['admin']);

    // Determine which OIDC provider to use
    $license = isset($_GET['license']) ? intval($_GET['license']) : null;

    if (!empty($_SESSION['oidc_admin'])) {
        // Admin login — use global config
        unset($_SESSION['oidc_license']);
        unset($_SESSION['oidc_provider_id']);
        $oidc = OidcClient::fromGlobalConfig();
    } elseif ($license === null) {
        // Neither an admin login nor a license: the callback would run the tenant branch
        // with a null license and fatal on Auth::checkById(int). Refuse up front instead.
        header('Location: /unauthorized?error=oidc.no_account_selected');
        exit;
    } else {
        // Tenant login — look up the default provider for this license
        $provider = lookupDefaultProvider($license);
        if (!$provider) {
            header('Location: /unauthorized?error=oidc.no_provider&license=' . $license);
            exit;
        }
        $_SESSION['oidc_license'] = $license;
        $_SESSION['oidc_provider_id'] = (int)$provider['id'];
        $oidc = OidcClient::fromProvider($provider);
    }

    try { $authUrl = $oidc->getAuthorizationUrl($state); }
    catch (Throwable $e) {
        unset($_SESSION['oidc_transaction'], $_SESSION['oidc_state']);
        Logging::error('OIDC authorization could not be started.');
        header('Location: /unauthorized?error=oidc.authentication_failed');
        exit;
    }

    header('Location: ' . $authUrl);
    exit;
}

$state = $_GET['state'] ?? null;
$code = $_GET['code'] ?? null;

if (!is_string($code) || !is_string($state) || !isset($_SESSION['oidc_state']) || !hash_equals($_SESSION['oidc_state'], $state)) {
    MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'invalid_state']);
    header('Location: /unauthorized?error=oidc.invalid_state');
    exit;
}
unset($_SESSION['oidc_state']);

try {
    // Reconstruct the correct OidcClient instance
    $isAdminLogin = !empty($_SESSION['oidc_admin']);
    unset($_SESSION['oidc_admin']); // Clean up immediately

    $license = $_SESSION['oidc_license'] ?? null;
    $providerId = $_SESSION['oidc_provider_id'] ?? null;
    unset($_SESSION['oidc_license']); // only needed during the redirect round-trip
    // Keep oidc_provider_id in session so the token refresh can reconstruct the correct OidcClient

    if ($isAdminLogin) {
        $oidc = OidcClient::fromGlobalConfig();
        $providerRow = null;
    } elseif ($license === null) {
        // Should be unreachable (the authorize step refuses this), but the tenant branch
        // below would call Auth::checkById(null) and fatal on the int type — TypeError is
        // an Error, not an Exception, so the catch below would not contain it either.
        MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'no_account_selected']);
        header('Location: /unauthorized?error=oidc.no_account_selected');
        exit;
    } else {
        // Re-fetch provider from DB using the stored provider_id
        $providerRow = lookupDefaultProvider((int)$license);
        if (!$providerRow || (int)$providerRow['id'] !== (int)$providerId) {
            MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'provider_not_found']);
            header('Location: /unauthorized?error=oidc.provider_not_found');
            exit;
        }
        $oidc = OidcClient::fromProvider($providerRow);
    }

    $tokens = $oidc->getToken($code);
    if (empty($tokens['access_token'])) {
        MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'token_exchange_failed']);
        header('Location: /unauthorized?error=oidc.token_exchange_failed');
        exit;
    }
    $userinfo = $oidc->getUserInfo($tokens['access_token']);
    if (empty($userinfo['sub'])) {
        MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'userinfo_failed']);
        header('Location: /unauthorized?error=oidc.userinfo_failed');
        exit;
    }
    $sub = $userinfo['sub'];
    $email = $userinfo['email'] ?? null;
    $name = $userinfo['name'] ?? $userinfo['preferred_username'] ?? $sub;
    $groups = OidcProtocol::groups($userinfo['groups'] ?? []);

    if ($isAdminLogin) {
        // ── Admin login ──────────────────────────────────────────────────
        // Check global OIDC required_group first (if configured)
        if (defined('OIDC') && is_array(OIDC) && !empty(OIDC['required_group'])) {
            $requiredGroup = strtolower(trim(OIDC['required_group']));
            $userGroupsLower = array_map(fn ($g) => strtolower(trim($g)), $groups);
            if (!in_array($requiredGroup, $userGroupsLower)) {
                $userGroups = count($groups) > 0 ? implode(', ', $groups) : '[none]';
                Logging::warning('OIDC access denied for user ' . $sub . '. Required group: ' . OIDC['required_group'] . '. User groups: ' . $userGroups);
                MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'access_denied', 'sub' => $sub]);
                header('Location: /unauthorized?error=oidc.access_denied');
                exit;
            }
        }

        // Enforce admin_group
        if (!defined('OIDC') || !is_array(OIDC) || empty(OIDC['admin_group'])) {
            Logging::warning('Admin login attempted but OIDC[admin_group] is not configured');
            MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'admin_group_not_configured', 'sub' => $sub]);
            header('Location: /unauthorized?error=oidc.admin_access_denied');
            exit;
        }
        $adminGroup = strtolower(trim(OIDC['admin_group']));
        $userGroupsLower = array_map(fn ($g) => strtolower(trim($g)), $groups);
        if (!in_array($adminGroup, $userGroupsLower)) {
            $userGroups = count($groups) > 0 ? implode(', ', $groups) : '[none]';
            Logging::warning('Admin access denied for user ' . $sub . '. Required admin group: ' . OIDC['admin_group'] . '. User groups: ' . $userGroups);
            MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'admin_access_denied', 'sub' => $sub]);
            header('Location: /unauthorized?error=oidc.admin_access_denied');
            exit;
        }
        // Admin login successful
        Auth::setAdminSessionFromOidc($sub, $name, $email);
    } else {
        // ── Tenant login ─────────────────────────────────────────────────
        // Check provider's required_group (if configured)
        $requiredGroup = $providerRow['required_group'] ?? null;
        if (!empty($requiredGroup)) {
            $requiredGroupLower = strtolower(trim($requiredGroup));
            $userGroupsLower = array_map(fn ($g) => strtolower(trim($g)), $groups);
            if (!in_array($requiredGroupLower, $userGroupsLower)) {
                $userGroups = count($groups) > 0 ? implode(', ', $groups) : '[none]';
                Logging::warning('OIDC access denied for user ' . $sub . ' on license ' . $license . '. Required group: ' . $requiredGroup . '. User groups: ' . $userGroups);
                MetricsHelper::record('login_failed', $license, ['method' => 'oidc', 'reason' => 'access_denied', 'sub' => $sub]);
                header('Location: /unauthorized?error=oidc.access_denied');
                exit;
            }
        }

        // Verify the account exists and is active, set session
        if (!Auth::checkById($license)) {
            MetricsHelper::record('login_failed', $license, ['method' => 'oidc', 'reason' => 'account_not_found', 'sub' => $sub]);
            header('Location: /unauthorized?error=oidc.account_not_found');
            exit;
        }

        // Update last activity
        Auth::updateLastActivity($license);

        // Keep oidc_provider_id so token refresh can reconstruct the correct OidcClient
        if ($providerId) {
            $_SESSION['oidc_provider_id'] = (int)$providerId;
        }
    }

    session_regenerate_id(true);
    $_SESSION['oidc_subject'] = $sub;
    $_SESSION['oidc_session_expires'] = time() + 28800;
    $_SESSION['oidc_tokens'] = [
      'access_token' => $tokens['access_token'],
      'id_token' => $tokens['id_token'] ?? null,
      'refresh_token' => $tokens['refresh_token'] ?? null,
      'expires_at' => time() + ($tokens['expires_in'] ?? 3600),
    ];
    $redirectUrl = OidcProtocol::safeRedirect($_SESSION['redirect'] ?? null, BASE_URL);
    unset($_SESSION['redirect']);
    // Log the effective cookie parameters for iOS/session debugging
    $cookieParams = session_get_cookie_params();
    Logging::info('OIDC login successful for user: ' . $sub . ($license ? ' (license ' . $license . ')' : ' (admin)')
        . ' | cookie: secure=' . ($cookieParams['secure'] ? 'true' : 'false')
        . ', samesite=' . ($cookieParams['samesite'] ?? 'n/a')
        . ', lifetime=' . $cookieParams['lifetime']
        . ' | UA: ' . ($_SERVER['HTTP_USER_AGENT'] ?? 'unknown'));
    MetricsHelper::record('login', $isAdminLogin ? null : $license, ['method' => 'oidc', 'admin' => $isAdminLogin]);

    header('Location: ' . $redirectUrl);
    exit;
} catch (Throwable $e) {
    Logging::error('OIDC Auth error: ' . $e->getMessage());
    MetricsHelper::record('login_failed', null, ['method' => 'oidc', 'reason' => 'exception', 'message' => $e->getMessage()]);

    header('Location: /unauthorized?error=oidc.authentication_failed');
    exit;
}

// ── Helper functions ──────────────────────────────────────────────────

/**
 * Look up the default OIDC provider for a given license from the DB.
 * Returns the oidc_providers row or null.
 */
function lookupDefaultProvider(int $license): ?array
{
    $db = new mysqli(DB['host'], DB['user'], DB['password'], DB['database']);
    if ($db->connect_error) {
        Logging::error('DB connection failed in lookupDefaultProvider: ' . $db->connect_error);
        return null;
    }
    $db->set_charset('utf8mb4');

    $stmt = $db->prepare('
    SELECT p.*
    FROM oidc_providers p
    JOIN account_oidc_providers aop ON p.id = aop.provider_id
    WHERE aop.license = ? AND aop.is_default = 1 AND p.enabled = 1
    LIMIT 1
  ');
    $stmt->bind_param('i', $license);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();
    $stmt->close();
    $db->close();

    return $row ?: null;
}

/**
 * Look up an OIDC provider by its ID.
 * Returns the oidc_providers row or null.
 */
function lookupProviderById(int $providerId): ?array
{
    $db = new mysqli(DB['host'], DB['user'], DB['password'], DB['database']);
    if ($db->connect_error) {
        Logging::error('DB connection failed in lookupProviderById: ' . $db->connect_error);
        return null;
    }
    $db->set_charset('utf8mb4');

    $stmt = $db->prepare('
    SELECT * FROM oidc_providers
    WHERE id = ? AND enabled = 1
    LIMIT 1
  ');
    $stmt->bind_param('i', $providerId);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();
    $stmt->close();
    $db->close();

    return $row ?: null;
}
