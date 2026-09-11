<?php
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/OidcProtocol.php';
/** Provider-specific client; retains both the tenant and global admin configuration. */
class OidcClient extends OidcProtocol
{
    public static function fromGlobalConfig(): self
    {
        return new self(
            OIDC['discovery_url'],
            OIDC['client_id'],
            OIDC['client_secret'],
            self::normalizeScopes(implode(' ', OIDC['scopes'])),
            OIDC['redirect_uri'],
            OIDC['issuer'] ?? null,
        );
    }

    /**
     * Create an OidcClient from an oidc_providers DB row (tenant flow).
     */
    public static function fromProvider(array $provider): self
    {
        return new self(
            $provider['discovery_url'],
            $provider['client_id'],
            $provider['client_secret'],
            self::normalizeScopes($provider['scopes'] ?? 'openid email profile'),
            OIDC['redirect_uri'],
        );
    }

    /**
     * Guarantee `openid` is requested. Without it the provider runs a plain OAuth2 flow and
     * returns no id_token — which then makes RP-initiated logout impossible, because
     * providers require `id_token_hint` to honour `post_logout_redirect_uri`. Per-account
     * provider rows carry a free-text scope list, so this is easy to get wrong in the DB.
     */
    private static function normalizeScopes(string $scopes): string
    {
        $list = preg_split('/\s+/', trim($scopes), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        if (!in_array('openid', $list, true)) {
            array_unshift($list, 'openid');
        }
        return implode(' ', $list);
    }


    public static function tryRefreshSession(int $refreshBeforeExpireSeconds = 300): bool
    {
        if (session_status() !== PHP_SESSION_ACTIVE || !in_array($_SESSION['authType'] ?? '', ['oidc', 'oidc_admin'], true)) return false;
        $tokens = $_SESSION['oidc_tokens'] ?? [];
        $expires = $tokens['expires_at'] ?? 0;
        $clear = static function (): void {
            foreach (['account', 'authType', 'admin_sub', 'admin_name', 'name', 'mail', 'oidc_tokens', 'oidc_provider_id', 'oidc_subject', 'oidc_session_expires'] as $key) unset($_SESSION[$key]);
        };
        // Old sessions without a verified identity must authenticate once after this update.
        if (empty($_SESSION['oidc_subject']) || ($_SESSION['oidc_session_expires'] ?? 0) <= time()) { $clear(); return false; }
        if (time() < $expires - $refreshBeforeExpireSeconds) return false;
        if (empty($tokens['refresh_token'])) { if (time() >= $expires) $clear(); return false; }
        try {
            $admin = $_SESSION['authType'] === 'oidc_admin';
            $provider = null;
            if ($admin) $client = self::fromGlobalConfig();
            else {
                $providerId = $_SESSION['oidc_provider_id'] ?? 0;
                require_once __DIR__ . '/DB.php';
                DB::prepare('SELECT * FROM `oidc_providers` WHERE `id` = ? AND `enabled` = 1 LIMIT 1')
                    ->bind_param('i', $providerId)->execute()->fetchOne($provider)->close();
                if (!$provider) { $clear(); return false; }
                $client = self::fromProvider($provider);
            }
            $new = $client->refreshToken($tokens['refresh_token']);
            $user = $client->getUserInfo($new['access_token']);
            $required = $admin ? (OIDC['required_group'] ?? '') : ($provider['required_group'] ?? '');
            if ($user['sub'] !== $_SESSION['oidc_subject'] || ($required !== '' && !self::inGroup($user, $required))
                || ($admin && !self::inGroup($user, OIDC['admin_group'] ?? ''))) { $clear(); return false; }
            $_SESSION['oidc_tokens'] = ['access_token' => $new['access_token'], 'id_token' => $new['id_token'] ?? $tokens['id_token'] ?? null,
                'refresh_token' => $new['refresh_token'] ?? $tokens['refresh_token'], 'expires_at' => time() + (int)$new['expires_in']];
            return true;
        } catch (Throwable $e) {
            error_log('OIDC session refresh failed.');
            if (time() >= $expires) $clear();
            return false;
        }
    }
}
