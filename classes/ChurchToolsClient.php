<?php

/**
 * ChurchToolsClient — HTTP client for the ChurchTools REST API.
 *
 * URL and token are passed explicitly so that each account can have its own
 * ChurchTools instance configured in the database rather than in a global
 * config constant.
 */
class ChurchToolsClient
{
    /** @param array{url:string,token:string} $cfg */
    public static function get(string $path, array $params = [], array $cfg = [])
    {
        return self::request('GET', $path, $params, [], $cfg);
    }

    /** @param array{url:string,token:string} $cfg */
    public static function post(string $path, array $params = [], array $data = [], array $cfg = [])
    {
        return self::request('POST', $path, $params, $data, $cfg);
    }

    /** @param array{url:string,token:string} $cfg */
    public static function put(string $path, array $params = [], array $data = [], array $cfg = [])
    {
        return self::request('PUT', $path, $params, $data, $cfg);
    }

    /** @param array{url:string,token:string} $cfg */
    public static function patch(string $path, array $params = [], array $data = [], array $cfg = [])
    {
        return self::request('PATCH', $path, $params, $data, $cfg);
    }

    /** @param array{url:string,token:string} $cfg */
    public static function delete(string $path, array $params = [], array $cfg = [])
    {
        return self::request('DELETE', $path, $params, [], $cfg);
    }

    /** @param array{url:string,token:string} $cfg */
    public static function addToken(string $url, array $cfg = []): string
    {
        $token = $cfg['token'] ?? '';
        return $url . (parse_url($url, PHP_URL_QUERY) ? '&' : '?') . 'login_token=' . $token;
    }

    /**
     * Derive the ChurchTools instance root (scheme://host[:port]) from the configured
     * API URL (which typically ends in `/api/`). Legacy endpoints live at the root,
     * not under `/api`.
     */
    private static function instanceRoot(array $cfg = []): string
    {
        $parts = parse_url($cfg['url'] ?? '');
        if (empty($parts['scheme']) || empty($parts['host'])) {
            return rtrim($cfg['url'] ?? '', '/');
        }
        return $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    }

    /**
     * GET helper that shares one cookie jar across the legacy login handshake.
     * Returns the decoded JSON (array), the raw body (string) for non-JSON, or null.
     */
    private static function cookieGet(string $url, string $cookieFile)
    {
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
            CURLOPT_COOKIEJAR      => $cookieFile, // persist any Set-Cookie (session)
            CURLOPT_COOKIEFILE     => $cookieFile, // and send cookies already captured
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 8,
        ]);
        $response = curl_exec($ch);

        if ($response === false) {
            return null;
        }
        $decoded = json_decode($response, true);
        return is_array($decoded) ? $decoded : $response;
    }

    /**
     * Call a legacy ChurchTools AJAX function (`index.php?q=churchservice/ajax`).
     *
     * Some capabilities — notably CCLI SongSelect title search
     * (`getCCLISongsMatchingTitle`) — are NOT exposed by the REST API and only live
     * on this legacy endpoint, which the ChurchTools web UI drives. It validates a
     * `csrf-token` header against the *current session*, so a stateless `login_token`
     * request per call won't do (the token would belong to a different session — the
     * "CSRF-Token is invalid" failure). Instead we reproduce the browser flow:
     *
     *   1. `whoami?login_token=…` once to log in and capture the session cookie.
     *   2. `csrftoken` using only that cookie → a CSRF token bound to that session.
     *   3. POST the legacy endpoint with the same cookie + matching CSRF header.
     *
     * @param array<string,scalar> $formData Additional form fields (besides `func`).
     * @param array{url:string,token:string} $cfg
     * @return array<mixed>|false Decoded response, or false on transport failure.
     */
    public static function legacyAjax(string $func, array $formData = [], array $cfg = [])
    {
        $raw = self::legacyAjaxRaw($func, $formData, $cfg);
        $response = $raw['body'];
        if (!is_string($response)) {
            return false;
        }
        $decoded = json_decode($response, true);
        if (is_array($decoded)) {
            return $decoded;
        }
        // Non-JSON response (e.g. an HTML login/error page when auth or CSRF failed).
        // Return it for diagnostics rather than swallowing it silently.
        return [
            '_nonJson'   => true,
            '_httpCode'  => $raw['httpCode'],
            '_csrfSent'  => $raw['csrf'],
            '_loggedIn'  => $raw['loggedIn'],
            '_raw'       => substr($response, 0, 2000),
        ];
    }

    /**
     * Like {@see legacyAjax} but returns the raw (binary-safe) response body + metadata —
     * for legacy funcs that return a *file* (e.g. `getCCLIChordsFile` → a PDF) rather than JSON.
     *
     * @param array<string,scalar> $formData
     * @param array{url:string,token:string} $cfg
     * @return array{body:?string,httpCode:int,csrf:bool,loggedIn:bool,error:string}
     */
    public static function legacyAjaxRaw(string $func, array $formData = [], array $cfg = []): array
    {
        $root  = self::instanceRoot($cfg);
        $token = $cfg['token'] ?? '';
        $cookieFile = tempnam(sys_get_temp_dir(), 'ct_sess_');

        // 1. Log in with the token to establish a session cookie (captured in $cookieFile).
        $whoami = self::cookieGet($root . '/api/whoami?login_token=' . urlencode($token), $cookieFile);
        // 2. CSRF token for THAT session — cookie only (login_token would spawn a fresh session).
        $csrfResp = self::cookieGet($root . '/api/csrftoken', $cookieFile);
        $csrf = is_array($csrfResp) ? ($csrfResp['data'] ?? null) : null;

        $headers = [
            'Accept: application/json, text/javascript, */*; q=0.01',
            'X-Requested-With: XMLHttpRequest',
            'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
        ];
        if ($csrf !== null && $csrf !== '') {
            $headers[] = 'csrf-token: ' . $csrf;
        }

        // 3. POST the legacy endpoint reusing the session cookie (no login_token here).
        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $root . '/index.php?q=churchservice/ajax',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => http_build_query(array_merge(['func' => $func], $formData)),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_COOKIEFILE     => $cookieFile,
            CURLOPT_COOKIEJAR      => $cookieFile,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 20,
        ]);
        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);

        if (is_string($cookieFile)) {
            @unlink($cookieFile);
        }

        $loggedIn = is_array($whoami) && (int)($whoami['data']['id'] ?? 0) > 0;

        // Diagnostic log for the legacy CCLI calls — visible in the admin Logs viewer.
        require_once(__DIR__ . '/Logging.php');
        Logging::debug(sprintf(
            'legacyAjax func=%s http=%d csrf=%s loggedIn=%s err=%s len=%d resp=%s',
            $func,
            $httpCode,
            ($csrf !== null && $csrf !== '') ? 'yes' : 'no',
            $loggedIn ? 'yes' : 'no',
            $curlError !== '' ? $curlError : '-',
            is_string($response) ? strlen($response) : 0,
            substr(is_string($response) ? $response : '', 0, 400)
        ));

        return [
            'body'     => $response === false ? null : $response,
            'httpCode' => $httpCode,
            'csrf'     => $csrf !== null && $csrf !== '',
            'loggedIn' => $loggedIn,
            'error'    => $curlError,
        ];
    }

    /**
     * Download a ChurchTools file by its id (e.g. the CCLI chord PDF that `getCCLIChordsFile`
     * stores and returns by `{id, filename}`). Returns the raw bytes, or null.
     *
     * `GET /api/files/{id}/meta` yields the authoritative `fileUrl` (a legacy
     * `?q=public/filedownload&…` URL). That endpoint authorizes via an *authenticated session*
     * cookie — NOT a `login_token` query param (which 401s) — so we establish a session with
     * whoami and stream the file with that cookie, like the browser does.
     *
     * @param array{url:string,token:string} $cfg
     */
    public static function downloadFileById(int $id, array $cfg): ?string
    {
        require_once(__DIR__ . '/Logging.php');

        $meta    = self::get("files/{$id}/meta", [], $cfg);
        $fileUrl = is_array($meta) ? ($meta['data']['fileUrl'] ?? null) : null;
        if (!is_string($fileUrl) || $fileUrl === '') {
            Logging::debug("downloadFileById id={$id}: no fileUrl in /files/{id}/meta response: "
                . substr(is_array($meta) ? (string)json_encode($meta) : (string)$meta, 0, 200));
            return null;
        }
        // fileUrl is normally absolute; guard against a relative one just in case.
        if (stripos($fileUrl, 'http') !== 0) {
            $fileUrl = self::instanceRoot($cfg) . '/' . ltrim($fileUrl, '/');
        }

        // Attempt 1: login token appended (works for files attached to an arrangement — same as
        // the existing arrangement-file download). Attempt 2: authenticated session cookie.
        $pdf = self::fetchFileUrl($id, self::addToken($fileUrl, $cfg), $cfg, false, 'token');
        if (is_string($pdf) && str_starts_with($pdf, '%PDF')) {
            return $pdf;
        }
        return self::fetchFileUrl($id, $fileUrl, $cfg, true, 'cookie');
    }

    /** GET a file URL, optionally within an authenticated session cookie; returns the raw bytes. */
    private static function fetchFileUrl(int $id, string $url, array $cfg, bool $useCookie, string $mode): ?string
    {
        require_once(__DIR__ . '/Logging.php');
        $cookieFile = null;
        $opts = [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 20,
        ];
        if ($useCookie) {
            $cookieFile = tempnam(sys_get_temp_dir(), 'ct_sess_');
            self::cookieGet(self::instanceRoot($cfg) . '/api/whoami?login_token=' . urlencode($cfg['token'] ?? ''), $cookieFile);
            $opts[CURLOPT_COOKIEFILE] = $cookieFile;
            $opts[CURLOPT_COOKIEJAR]  = $cookieFile;
        }
        $ch = curl_init();
        curl_setopt_array($ch, $opts);
        $body     = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr  = curl_error($ch);

        if (is_string($cookieFile)) {
            @unlink($cookieFile);
        }

        substr(is_string($body) ? $body : '', 0, 8)
          |> (fn ($x) => sprintf('downloadFileById id=%d mode=%s http=%d err=%s len=%d head=%s', $id, $mode, $httpCode, $curlErr !== '' ? $curlErr : '-', is_string($body) ? strlen($body) : 0, $x))
          |> Logging::debug(...);
        return is_string($body) && $body !== '' ? $body : null;
    }

    /** @param array{url:string,token:string} $cfg */
    private static function request(string $method, string $path, array $params = [], array $data = [], array $cfg = [])
    {
        $ch = curl_init();

        $baseUrl = rtrim($cfg['url'] ?? '', '/') . '/';
        $url = $baseUrl . $path;

        if (!empty($params)) {
            $url .= '?' . http_build_query($params);
        }

        $headers = [
            'Authorization: Login ' . ($cfg['token'] ?? ''),
                'Accept: application/json',
            ];

        if ($method === 'POST' || $method === 'PUT' || $method === 'PATCH') {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
        }

        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
        ]);

        $response = curl_exec($ch);

        unset($ch);

        if ($response === false) {
            return false;
        }

        return json_decode($response, true);
    }
}
