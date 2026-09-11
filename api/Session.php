<?php

require_once(__DIR__ . '/RestController.php');
require_once(__DIR__ . '/../config.php');

class Session extends RestController
{
    protected function get(Request &$req, Response &$res): never
    {
        // Optional sub-routes under /rest/Session/...
        $subRoute = strtolower($req->path->get(0, ''));

        switch ($subRoute) {
            case 'oidc-auth-url':
                // Returns a URL that starts the OIDC login flow.
                // The client should open this URL (web: window.location, electron: shell.openExternal).
                $redirect = $req->query->get('redirect', BASE_URL);
                $redirect = filter_var($redirect, FILTER_SANITIZE_URL);

                // Ensure redirect stays within our domain (basic safety)
                if (str_starts_with($redirect, '/')) {
                    $redirect = BASE_URL . ltrim($redirect, '/');
                }

                $admin = $req->query->getAsBool('admin', false);
                // License is optional - use get() with valueRequired=false instead of getAsInt()
                $licenseRaw = $req->query->get('license', null, false);
                $license = $licenseRaw !== null ? intval($licenseRaw) : null;

                // Return an absolute URL pointing to the backend oidc handler.
                // This is required when the frontend is on a different origin (e.g. Electron
                // dev server on localhost:5173 vs the PHP backend on its own domain).
                // On production, BASE_URL already points to the correct server.
                $url = BASE_URL . 'oidc?redirect=' . urlencode($redirect);
                if ($admin) {
                    $url .= '&admin=1';
                } elseif ($license !== null) {
                    $url .= '&license=' . intval($license);
                }

                $res->success([
                    'url' => $url
                ]);
                break;
            default:
                $account = $_SESSION['account'] ?? 0;
                $ctEnabled = false;
                // The name the user picked on the login page — shown instead of the mail
                // address wherever the app names the current account.
                $name = $_SESSION['name'] ?? $_SESSION['admin_name'] ?? '';
                if ($account) {
                    $ctStmt = self::prepare('SELECT `name`, `church_tools_url`, `church_tools_token` FROM `account` WHERE `license` = ?');
                    $ctStmt->bind_param('i', $account)->execute()->fetchOne($ctRow)->close();
                    $ctEnabled = !empty($ctRow['church_tools_url']) && !empty($ctRow['church_tools_token']);
                    // Sessions established before the name was stored have none — read it
                    // from the account row instead of forcing a re-login.
                    if ($name === '' && !empty($ctRow['name'])) {
                        $name = $ctRow['name'];
                    }
                }
                $res->success([
                    'account' => $account,
                    'name' => $name,
                    'mail' => $_SESSION['mail'] ?? '',
                    'isAuthenticated' => isset($_SESSION['authType']) && !empty($_SESSION['authType']),
                    'authType' => $_SESSION['authType'] ?? null,
                    'settings' => [
                        // Drives the dev banner every page paints over itself. Deliberately
                        // part of the unauthenticated response: the login page has to show it
                        // too, and knowing a deployment calls itself a dev one gives away
                        // nothing an operator could not already see from its address.
                        'development' => defined('DEVELOPMENT') && (bool) DEVELOPMENT,
                        'bibleEnabled' => defined('BIBLE_API') && is_array(BIBLE_API) && !empty(BIBLE_API['enabled']) && BIBLE_API['enabled'],
                        'churchToolsEnabled' => $ctEnabled,
                        'wsHost' => defined('WS_HOST') && is_array(WS_HOST) && !empty(WS_HOST['host'])
                            ? [
                                'host' => WS_HOST['host'],
                                'port' => (int)(WS_HOST['port'] ?? 443),
                                'path' => WS_HOST['path'] ?? '/',
                                'wss'  => !empty(WS_HOST['wss']),
                              ]
                            : null,
                        // Where the text viewer is deployed. Usually its own subdomain, so it
                        // cannot be derived from this app's address. Trailing slash trimmed so
                        // the client can append '/?token=…' without doubling it.
                        'viewerUrl' => defined('VIEWER_URL') && is_string(VIEWER_URL) && trim(VIEWER_URL) !== ''
                            ? rtrim(trim(VIEWER_URL), '/')
                            : null,
                    ],
                ]);
        }
    }

    protected function delete(Request &$req, Response &$res): never
    {
        session_unset();
        session_destroy();

        $res->success([
            'message' => 'successfully logged out'
        ]);
    }
}
