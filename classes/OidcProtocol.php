<?php
declare(strict_types=1);

/** Authorization-code client for HTTPS providers issuing RS256 ID tokens. PHP 8.1+, curl, OpenSSL. */
class OidcTransportException extends RuntimeException
{
    public function __construct(public int $httpStatus, public int $curlError)
    {
        parent::__construct('OIDC provider request failed (HTTP ' . $httpStatus . ', cURL ' . $curlError . ').');
    }
}

class OidcProtocol
{
    private ?array $discovery = null;
    private ?string $subject = null;

    public function __construct(
        private string $discoveryUrl,
        private string $clientId,
        private string $clientSecret,
        private string $scopes,
        private string $redirectUri,
        private ?string $issuer = null,
    ) {}

    private static function https(string $url): void
    {
        $p = parse_url($url);
        if (!$p || ($p['scheme'] ?? '') !== 'https' || empty($p['host']) || isset($p['user']) || isset($p['pass']) || isset($p['fragment'])) {
            throw new RuntimeException('OIDC endpoints must be absolute HTTPS URLs without credentials or fragments.');
        }
    }

    protected function request(string $url, ?array $form = null, ?string $bearer = null): array
    {
        self::https($url);
        if (!function_exists('curl_init')) throw new RuntimeException('The PHP cURL extension is unavailable.');
        $ch = curl_init($url);
        $headers = ['Accept: application/json'];
        if ($bearer !== null) {
            if (preg_match('/[\r\n]/', $bearer)) throw new RuntimeException('Invalid access token.');
            $headers[] = 'Authorization: Bearer ' . $bearer;
        }
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 15,
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
        if ($form !== null) {
            $headers[] = 'Content-Type: application/x-www-form-urlencoded';
            curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($form)]);
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_errno($ch);
        if ($status !== 200 || !is_string($body)) throw new OidcTransportException((int)$status, $curlError);
        if (strlen($body) > 2097152) throw new RuntimeException('Invalid OIDC response size.');
        $json = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($json) || array_is_list($json)) throw new RuntimeException('Invalid OIDC response.');
        return $json;
    }

    public function metadata(): array
    {
        if ($this->discovery !== null) return $this->discovery;
        self::https($this->discoveryUrl);
        $d = $this->request($this->discoveryUrl);
        foreach (['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint'] as $key) {
            if (!isset($d[$key]) || !is_string($d[$key])) throw new RuntimeException('Incomplete OIDC metadata.');
            self::https($d[$key]);
        }
        // A configured issuer is pinned exactly; legacy clients pin the discovery authority.
        if (($this->issuer !== null && $d['issuer'] !== $this->issuer)
            || self::origin($d['issuer']) !== self::origin($this->discoveryUrl)) throw new RuntimeException('OIDC issuer mismatch.');
        return $this->discovery = $d;
    }

    public function getAuthorizationUrl(string $state): string
    {
        self::https($this->redirectUri);
        if ($this->clientId === '' || $this->clientSecret === '') throw new RuntimeException('OIDC credentials are missing.');
        $d = $this->metadata();
        $verifier = self::encode(random_bytes(32));
        $nonce = self::encode(random_bytes(32));
        $_SESSION['oidc_transaction'] = ['state' => $state, 'nonce' => $nonce, 'verifier' => $verifier,
            'created' => time(), 'client' => $this->clientId, 'discovery' => $this->discoveryUrl, 'redirect' => $this->redirectUri];
        $scopes = array_unique(array_merge(['openid'], preg_split('/\s+/', trim($this->scopes), -1, PREG_SPLIT_NO_EMPTY)));
        return self::query($d['authorization_endpoint'], ['client_id' => $this->clientId, 'redirect_uri' => $this->redirectUri,
            'response_type' => 'code', 'response_mode' => 'query', 'scope' => implode(' ', $scopes), 'state' => $state,
            'nonce' => $nonce, 'code_challenge' => self::encode(hash('sha256', $verifier, true)), 'code_challenge_method' => 'S256']);
    }

    public function getToken(string $code): array
    {
        $t = $_SESSION['oidc_transaction'] ?? null;
        unset($_SESSION['oidc_transaction']); // A callback, including a failed exchange, is single-use.
        if (!is_array($t) || !is_string($_GET['state'] ?? null) || !hash_equals($t['state'], $_GET['state'])
            || time() - $t['created'] > 600 || $t['created'] > time() || $t['client'] !== $this->clientId
            || $t['discovery'] !== $this->discoveryUrl || $t['redirect'] !== $this->redirectUri || $code === '') {
            throw new RuntimeException('Invalid or expired login transaction.');
        }
        $d = $this->metadata();
        if (isset($_GET['iss']) && $_GET['iss'] !== $d['issuer']) throw new RuntimeException('Authorization issuer mismatch.');
        $tokens = $this->tokenRequest(['grant_type' => 'authorization_code', 'code' => $code,
            'redirect_uri' => $this->redirectUri, 'code_verifier' => $t['verifier']]);
        if (!is_string($tokens['id_token'] ?? null)) throw new RuntimeException('Missing ID token.');
        $claims = $this->parseIdToken($tokens['id_token'], $t['nonce']);
        if (isset($claims['at_hash']) && (!is_string($claims['at_hash']) || !hash_equals($claims['at_hash'], self::encode(substr(hash('sha256', $tokens['access_token'], true), 0, 16))))) {
            throw new RuntimeException('Access token hash mismatch.');
        }
        $this->subject = $claims['sub'];
        return $tokens;
    }

    private function tokenRequest(array $params): array
    {
        $t = $this->request($this->metadata()['token_endpoint'], $params + ['client_id' => $this->clientId, 'client_secret' => $this->clientSecret]);
        if (!is_string($t['access_token'] ?? null) || $t['access_token'] === '' || strtolower($t['token_type'] ?? '') !== 'bearer'
            || !is_numeric($t['expires_in'] ?? null) || $t['expires_in'] <= 0) throw new RuntimeException('Invalid token response.');
        return $t;
    }

    public function refreshToken(string $refreshToken): array
    {
        $tokens = $this->tokenRequest(['grant_type' => 'refresh_token', 'refresh_token' => $refreshToken]);
        if (isset($tokens['id_token'])) $this->subject = $this->parseIdToken($tokens['id_token'])['sub'];
        return $tokens;
    }

    public function getUserInfo(string $accessToken): array
    {
        $u = $this->request($this->metadata()['userinfo_endpoint'], null, $accessToken);
        if (!is_string($u['sub'] ?? null) || $u['sub'] === '' || ($this->subject !== null && $u['sub'] !== $this->subject)) throw new RuntimeException('UserInfo subject mismatch.');
        foreach (['name', 'email', 'preferred_username'] as $key) {
            if (isset($u[$key]) && !is_string($u[$key])) throw new RuntimeException('Invalid profile claim.');
        }
        foreach (['groups', 'group_ids'] as $key) if (isset($u[$key])) $u[$key] = self::groups($u[$key]);
        return $u;
    }

    public static function groups(mixed $groups): array
    {
        if (!is_array($groups) || !array_is_list($groups)) throw new RuntimeException('Group claim must be an array of strings.');
        foreach ($groups as $g) if (!is_string($g) || trim($g) === '') throw new RuntimeException('Invalid group claim.');
        return array_values(array_unique(array_map('trim', $groups)));
    }

    public static function inGroup(array $claims, string $group, string $claim = 'groups'): bool
    {
        if (!in_array($claim, ['groups', 'group_ids'], true) || trim($group) === '') return false;
        $values = self::groups($claims[$claim] ?? []);
        return $claim === 'group_ids' ? in_array(trim($group), $values, true)
            : in_array(strtolower(trim($group)), array_map('strtolower', $values), true);
    }

    public function parseIdToken(string $jwt, ?string $nonce = null): array
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3 || strlen($jwt) > 131072) throw new RuntimeException('Invalid ID token.');
        [$h, $p, $s] = $parts;
        $header = json_decode(self::decode($h), true, 16, JSON_THROW_ON_ERROR);
        $claims = json_decode(self::decode($p), true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($header) || !is_array($claims) || ($header['alg'] ?? '') !== 'RS256' || isset($header['crit'])
            || !is_string($header['kid'] ?? null)) throw new RuntimeException('Unsupported ID token header.');
        $jwks = $this->request($this->metadata()['jwks_uri']);
        $keys = array_values(array_filter($jwks['keys'] ?? [], fn($k) => is_array($k) && ($k['kid'] ?? null) === $header['kid']
            && ($k['kty'] ?? '') === 'RSA' && ($k['use'] ?? 'sig') === 'sig' && ($k['alg'] ?? 'RS256') === 'RS256'
            && (!isset($k['key_ops']) || in_array('verify', $k['key_ops'], true))));
        if (count($keys) !== 1 || openssl_verify($h . '.' . $p, self::decode($s), self::pem($keys[0]), OPENSSL_ALGO_SHA256) !== 1) throw new RuntimeException('Invalid ID token signature.');
        $aud = $claims['aud'] ?? null;
        $aud = is_string($aud) ? [$aud] : $aud;
        if (($claims['iss'] ?? null) !== $this->metadata()['issuer'] || !is_array($aud) || !array_is_list($aud)
            || count(array_filter($aud, 'is_string')) !== count($aud) || !in_array($this->clientId, $aud, true)
            || (count($aud) > 1 && !isset($claims['azp'])) || (isset($claims['azp']) && $claims['azp'] !== $this->clientId)
            || !is_string($claims['sub'] ?? null) || $claims['sub'] === ''
            || !is_int($claims['exp'] ?? null) || $claims['exp'] <= time() - 30
            || !is_int($claims['iat'] ?? null) || $claims['iat'] > time() + 30 || $claims['exp'] <= $claims['iat']
            || (isset($claims['nbf']) && (!is_int($claims['nbf']) || $claims['nbf'] > time() + 30))
            || ($nonce !== null && (!is_string($claims['nonce'] ?? null) || !hash_equals($nonce, $claims['nonce'])))) throw new RuntimeException('Invalid ID token claims.');
        return $claims;
    }

    public function getLogoutUrl(?string $idToken = null, ?string $redirect = null, ?string $state = null): string
    {
        if (!$idToken) return $redirect ?? $this->redirectUri;
        $endpoint = $this->metadata()['end_session_endpoint'] ?? null;
        if (!$endpoint) return $redirect ?? $this->redirectUri;
        self::https($endpoint);
        return self::query($endpoint, array_filter(['id_token_hint' => $idToken, 'post_logout_redirect_uri' => $redirect, 'state' => $state], fn($v) => $v !== null));
    }

    public static function safeRedirect(mixed $target, string $fallback): string
    {
        if (!is_string($target) || $target === '' || preg_match('/[\x00-\x20\\\\]/', rawurldecode($target))) return $fallback;
        if (str_starts_with($target, '/') && !str_starts_with(rawurldecode($target), '//')) return $target;
        $p = parse_url($target);
        return $p && !isset($p['user']) && !isset($p['pass']) && self::origin($target) !== ''
            && self::origin($target) === self::origin($fallback) ? $target : $fallback;
    }

    private static function origin(string $url): string
    {
        $p = parse_url($url);
        if (!$p || !in_array($p['scheme'] ?? '', ['http', 'https'], true) || empty($p['host'])) return '';
        return strtolower($p['scheme'] . '://' . $p['host']) . ':' . ($p['port'] ?? ($p['scheme'] === 'https' ? 443 : 80));
    }
    private static function query(string $url, array $params): string { return $url . (str_contains($url, '?') ? '&' : '?') . http_build_query($params, '', '&', PHP_QUERY_RFC3986); }
    private static function encode(string $v): string { return rtrim(strtr(base64_encode($v), '+/', '-_'), '='); }
    private static function decode(string $v): string
    {
        if ($v === '' || preg_match('/[^a-zA-Z0-9_-]/', $v) || strlen($v) % 4 === 1) throw new RuntimeException('Invalid base64url.');
        $r = base64_decode(strtr($v, '-_', '+/'), true);
        if ($r === false) throw new RuntimeException('Invalid base64url.');
        return $r;
    }
    private static function der(string $tag, string $data): string
    {
        $len = strlen($data);
        $bytes = '';
        if ($len >= 128) { for ($n = $len; $n > 0; $n >>= 8) $bytes = chr($n & 255) . $bytes; }
        return $tag . ($len < 128 ? chr($len) : chr(128 | strlen($bytes)) . $bytes) . $data;
    }
    private static function pem(array $key): string
    {
        $n = self::decode($key['n'] ?? ''); $e = self::decode($key['e'] ?? '');
        if (strlen($n) < 256) throw new RuntimeException('RSA key must be at least 2048 bits.');
        $integer = fn($v) => self::der("\x02", (ord($v[0]) > 127 ? "\x00" : '') . $v);
        $rsa = self::der("\x30", $integer($n) . $integer($e));
        $spki = self::der("\x30", "\x30\x0d\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00" . self::der("\x03", "\x00" . $rsa));
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }
}
