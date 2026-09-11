<?php

// Development mode flag - set to false in production
const DEVELOPMENT = true;

if (DEVELOPMENT) {
    ini_set('display_errors', '1');
    ini_set('display_startup_errors', '1');
    error_reporting(E_ALL);
}

const DOMAIN = 'localhost';
const BASE_URL = 'http://' . DOMAIN . '/';

// CORS: list of origins that may call the API.
const CORS_ALLOWED_ORIGINS = [
    'http://localhost:5173',  // Vite dev server
    'http://localhost:4173',  // Vite preview
    'null',                   // Electron packaged (file:// sends Origin: null)
];

const DEFAULT_LANGUAGE = 'de'; // Default language: 'en' (English) or 'de' (German)

// Database
const DB = [
    'host'     => 'localhost',
    'database' => 'db',
    'user'     => 'user',
    'password' => 'password',
];

const SEARCH_RESULT_LIMIT = 10;
const CUSTOM_NUMBER_LIMIT = 10000;
const CUSTOM_NUMBER_SYNC = false;

// OIDC Configuration
const OIDC = [
    // Pin to the exact issuer in the discovery document (not its module.php path).
    'issuer' => 'https://idp.efsh.de',
    'discovery_url'  => 'https://idp.efsh.de/.well-known/openid-configuration',
    'client_id'      => 'client_id',
    'client_secret'  => 'client_secret',
    'admin_group'    => 'admin',
    'required_group' => '', // Optional: require user to be in this group (leave empty for no restriction)
    'redirect_uri'   => BASE_URL . 'oidc',
    'scopes'         => ['openid', 'email', 'profile', 'groups'],
];

// WebSocket Relay Server
// Configure the standalone WebSocket server that clients (operator + musician) connect to.
// Set 'wss' => true when the server is behind a TLS-terminating reverse proxy.
// 'path' is optional (default: '/'). Use a sub-path (e.g. '/ws') when the WS server
// shares the same hostname as the PHP app and is routed by path in the reverse proxy.
// Leave host empty or remove this constant to disable WebSocket sync.
const WS_HOST = [
    // 'wss'  => true,
    // 'host' => 'presenter.example.com',
    // 'port' => 443,
    // 'path' => '/ws',
];

// Text Viewer
// Base URL of the deployed viewer page (viewer/index.php). It is commonly hosted on its
// own subdomain rather than alongside this app, so the link and QR code offered under
// Settings → Viewer Token cannot be derived from this app's own address.
//
// Give the URL the viewer is reached at, with no query string — a trailing slash is
// optional. '?token=…' is appended to it.
//   e.g. 'https://text.example.com'  or  'https://example.com/viewer'
//
// Leave empty to fall back to '<this app>/viewer/', which is correct only when the
// viewer is served from this same host.
const VIEWER_URL = '';

// Bible API Configuration
// Only JSON-based APIs are supported. The translation is user-selectable at runtime.
const BIBLE_API = [
    'enabled'              => false,
    'name'                 => 'API.Bible',
    'base_url'             => 'https://api.scripture.api.bible/v1',
    'api_key'              => 'your-api-key-here',
    'translations_endpoint' => '/bibles',
    'translations_path'    => 'data',
    'translation_id_field' => 'id',
    'translation_name_field' => 'name',
    'translation_lang_field' => 'language.id',
    'verse_endpoint'       => '/bibles/{translation}/search',
    'verse_path'           => 'data.passages',
    'verse_text_field'     => 'content',
    'verse_ref_field'      => 'reference',
];
