<?php

/**
 * Emits CORS headers and handles preflight OPTIONS requests.
 * Also provides session cookie configuration for cross-origin requests.
 *
 * Call Cors::handle() at the very top of rest.php / oidc.php, before any
 * output or session_start().
 * Call Cors::configureSession() immediately before session_start() so that
 * the session cookie is sent correctly across origins.
 *
 * Allowed origins are configured via CORS_ALLOWED_ORIGINS in config.php.
 * If the constant is not defined (legacy configs) the class does nothing.
 */
class Cors
{
    /** Session lifetime in seconds — users stay logged in for 30 days. */
    private const SESSION_LIFETIME = 30 * 24 * 60 * 60;

    public static function handle(): void
    {
        if (!defined('CORS_ALLOWED_ORIGINS')) {
            return;
        }

        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';

        if (self::isAllowedOrigin($origin)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Accept, Authorization, X-Requested-With');
            header('Access-Control-Max-Age: 86400'); // cache preflight for 24 h
        }

        // Respond immediately to preflight requests
        if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    /**
     * Configure the PHP session cookie for cross-origin use.
     * Must be called BEFORE session_start().
     *
     * When the request comes from a cross-origin allowed by CORS_ALLOWED_ORIGINS,
     * the session cookie is set to SameSite=None; Secure so the browser will
     * include it in cross-origin fetch/XHR requests (credentials: 'include').
     *
     * Without this, the default SameSite=Lax blocks the cookie on cross-origin
     * API calls even though CORS headers allow the request itself.
     *
     * The Secure flag is always set to true when the connection is over HTTPS.
     * iOS Safari 16+ (and modern browsers in general) will not reliably store or
     * send cookies that lack the Secure flag on HTTPS pages — particularly when
     * the cookie was set during a cross-site redirect chain (such as an OIDC
     * callback from an external identity provider).  Without Secure=true the
     * session cookie is silently dropped and every subsequent API call returns 401.
     */
    public static function configureSession(): void
    {
        if (!defined('CORS_ALLOWED_ORIGINS')) {
            return;
        }

        // Keep the session alive for 30 days so users stay logged in across restarts.
        // Session ini settings can only be changed while no session is active, which is
        // why this lives here and not in sessionCookieParams() (also called afterwards).
        ini_set('session.gc_maxlifetime', (string)self::SESSION_LIFETIME);
        session_set_cookie_params(self::sessionCookieParams());
    }

    /**
     * The session cookie parameters for this deployment.
     *
     * SameSite is deliberately NOT derived from the current request's Origin header.
     * A cookie is identified by (name, domain, path) only — SameSite is not part of its
     * identity — and PHP emits Set-Cookie just once, when it creates the session. So the
     * single request that happened to create the session used to fix SameSite for the
     * whole 30-day lifetime: a session born on a plain navigation got `Lax`, and `Lax`
     * cookies are not sent on the cross-site POST that SimpleSAMLphp uses to return from
     * the IdP. The callback then landed in a brand-new session with no `oidc_state`,
     * failed the state check and bounced back to the login page — for as long as that
     * cookie survived. A private window worked because it started the flow from scratch.
     *
     * Over HTTPS the app always needs the cookie to survive a cross-site return (OIDC /
     * SAML) and cross-origin XHR from the desktop app, so `None; Secure` is the only
     * correct setting. Plain HTTP (local dev) cannot use `None` — browsers reject a
     * non-Secure `SameSite=None` cookie — so it falls back to `Lax`.
     */
    private static function sessionCookieParams(): array
    {
        $isHttps = self::isHttps();

        return [
            'lifetime' => self::SESSION_LIFETIME,
            'path'     => '/',
            'domain'   => '',
            'secure'   => $isHttps,
            'httponly' => true,
            'samesite' => $isHttps ? 'None' : 'Lax',
        ];
    }

    /**
     * Re-send the session cookie with the current parameters. Call right AFTER
     * session_start().
     *
     * PHP only emits Set-Cookie when it creates a new session, so a client that already
     * holds a cookie written under the old (Origin-dependent) rules would keep it — and
     * stay broken — for the full 30 days. Rewriting it on every request repairs those
     * clients on their next page load instead of requiring them to clear site data.
     */
    public static function refreshSessionCookie(): void
    {
        if (!defined('CORS_ALLOWED_ORIGINS')) {
            return;
        }
        if (session_status() !== PHP_SESSION_ACTIVE || headers_sent()) {
            return;
        }
        $params = self::sessionCookieParams();
        $params['expires'] = time() + $params['lifetime'];
        unset($params['lifetime']);
        setcookie(session_name(), session_id(), $params);
    }

    /**
     * Expire every cookie the browser sent with this request — the "delete cookies" half of
     * "Log out and reset".
     *
     * A cookie is only replaced when name, domain and path all match, so this reaches cookies
     * set host-only on `/`, which is how this app sets its own. Names are read from the raw
     * Cookie header because PHP rewrites dots and spaces in `$_COOKIE` keys.
     *
     * `Clear-Site-Data: "cookies"` is deliberately not used: it clears the whole registrable
     * domain, which on a shared parent domain would also end the identity provider's session
     * before the logout redirect ever reaches it.
     */
    public static function expireAllCookies(): void
    {
        if (headers_sent()) {
            return;
        }
        $isHttps = self::isHttps();
        foreach (explode(';', $_SERVER['HTTP_COOKIE'] ?? '') as $pair) {
            $name = trim(explode('=', $pair, 2)[0]);
            if ($name === '') {
                continue;
            }
            try {
                setcookie($name, '', [
                    'expires'  => time() - 42000,
                    'path'     => '/',
                    'domain'   => '',
                    'secure'   => $isHttps,
                    'httponly' => true,
                    'samesite' => $isHttps ? 'None' : 'Lax',
                ]);
            } catch (Throwable) {
                // setcookie() rejects some characters in names — such a cookie is not ours.
            }
        }
    }

    /**
     * Returns true when the current request arrived over HTTPS.
     * Checks the standard $_SERVER['HTTPS'] flag and common reverse-proxy
     * headers (X-Forwarded-Proto, X-Forwarded-SSL) so it works whether the
     * PHP process terminates TLS directly or sits behind nginx/Apache.
     */
    private static function isHttps(): bool
    {
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
            return true;
        }
        if (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
            return true;
        }
        if (!empty($_SERVER['HTTP_X_FORWARDED_SSL']) && $_SERVER['HTTP_X_FORWARDED_SSL'] === 'on') {
            return true;
        }
        // Fallback: trust BASE_URL if defined (set to https:// in production config)
        if (defined('BASE_URL') && str_starts_with(BASE_URL, 'https://')) {
            return true;
        }
        return false;
    }

    private static function isAllowedOrigin(string $origin): bool
    {
        if (!$origin || !defined('CORS_ALLOWED_ORIGINS')) {
            return false;
        }

        $allowed = CORS_ALLOWED_ORIGINS;

        // Auto-include the WS_HOST origin so it doesn't need to be listed twice.
        // The WS server shares the same host/origin as the frontend when routed
        // through the same reverse proxy.
        if (defined('WS_HOST') && is_array(WS_HOST) && !empty(WS_HOST['host'])) {
            $wsScheme = !empty(WS_HOST['wss']) ? 'https' : 'http';
            $wsPort   = (int)(WS_HOST['port'] ?? 443);
            $wsHost   = WS_HOST['host'];
            // Only include port in origin when it's non-standard
            $isDefaultPort = ($wsScheme === 'https' && $wsPort === 443)
                          || ($wsScheme === 'http'  && $wsPort === 80);
            $wsOrigin = $wsScheme . '://' . $wsHost . ($isDefaultPort ? '' : ':' . $wsPort);
            if (!in_array($wsOrigin, $allowed, true)) {
                $allowed[] = $wsOrigin;
            }
        }

        return in_array($origin, $allowed, true);
    }
}
