<?php
/**
 * PayPal subscription capture (Phase 1).
 *
 * Called from the /support page's PayPal `onApprove` handler with the newly
 * created subscription id. We look the subscription up via the PayPal API using
 * SERVER-SIDE credentials (kept OUTSIDE the web root, never in the repo), pull
 * the *verified* subscriber email, notify the team, and append to a CSV stored
 * outside any web root.
 *
 * Security note: the lookup uses our own credentials, so a caller can only ever
 * resolve subscriptions that belong to our PayPal account — an arbitrary id
 * just 404s. No customer data is returned to the browser.
 *
 * POST fields: subscription_id (required, e.g. I-XXXXXXXXXXXX)
 *
 * Credentials: a PHP file returning
 *   ['client_id' => '...', 'secret' => '...', 'env' => 'live'|'sandbox']
 * located at env PAYPAL_CONFIG, or the default path below.
 */

header('Content-Type: application/json; charset=utf-8');

function respond_fail(int $code, string $err): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $err]);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond_fail(405, 'method_not_allowed');
}

$sid = isset($_POST['subscription_id']) ? trim((string) $_POST['subscription_id']) : '';
// PayPal subscription ids look like I-XXXXXXXXXXXX.
if ($sid === '' || !preg_match('/^[A-Za-z0-9-]{6,64}$/', $sid)) {
    respond_fail(422, 'invalid_subscription_id');
}

$configPath = getenv('PAYPAL_CONFIG') ?: '/home/tatsunidas76/graphy-data/paypal.php';
if (!is_file($configPath)) {
    respond_fail(500, 'not_configured');
}
$cfg      = require $configPath;
$clientId = $cfg['client_id'] ?? '';
$secret   = $cfg['secret'] ?? '';
$env      = (($cfg['env'] ?? 'live') === 'sandbox') ? 'sandbox' : 'live';
if ($clientId === '' || $secret === '') {
    respond_fail(500, 'not_configured');
}

$api = $env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';

/**
 * @return array{0:int,1:mixed} [http_status, decoded_json]
 */
function pp_request(string $url, array $headers, ?string $post = null, ?string $userpwd = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $post);
    }
    if ($userpwd !== null) {
        curl_setopt($ch, CURLOPT_USERPWD, $userpwd);
    }
    $body   = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$status, json_decode((string) $body, true)];
}

// 1) OAuth token (client_credentials).
[$st, $tok] = pp_request(
    "$api/v1/oauth2/token",
    ['Accept: application/json'],
    'grant_type=client_credentials',
    "$clientId:$secret"
);
$token = is_array($tok) ? ($tok['access_token'] ?? '') : '';
if ($st !== 200 || $token === '') {
    respond_fail(502, 'auth_failed');
}

// 2) Subscription lookup.
[$st2, $sub] = pp_request(
    "$api/v1/billing/subscriptions/" . rawurlencode($sid),
    ['Authorization: Bearer ' . $token, 'Content-Type: application/json']
);
if ($st2 !== 200 || !is_array($sub)) {
    respond_fail(502, 'lookup_failed');
}

$email   = $sub['subscriber']['email_address'] ?? '';
$given   = $sub['subscriber']['name']['given_name'] ?? '';
$surname = $sub['subscriber']['name']['surname'] ?? '';
$status  = $sub['status'] ?? '';
$planId  = $sub['plan_id'] ?? '';

// Best-effort notify (never fail the request if mail() is unavailable).
$to      = 'customerservices@vis-ionary.com';
$from    = 'wordpress@vis-ionary.com';
$subject = '[GRAPHY] サポート購読の登録';
$body    = "subscription_id: {$sid}\nstatus: {$status}\nplan_id: {$planId}\n"
         . "email: {$email}\nname: {$given} {$surname}\n";
@mail($to, $subject, $body, "From: {$from}\r\nContent-Type: text/plain; charset=UTF-8\r\n");

// Best-effort append to a CSV kept OUTSIDE any web root (not downloadable).
// View with:  ssh <server> cat ~/graphy-data/subscribers-paid.csv
$dir = getenv('GRAPHY_DATA_DIR') ?: '/home/tatsunidas76/graphy-data';
if (!is_dir($dir)) { @mkdir($dir, 0700, true); }
$line = sprintf(
    "%s,%s,%s,%s,\"%s %s\"\n",
    date('c'), $sid, $status, $email,
    str_replace('"', "'", $given), str_replace('"', "'", $surname)
);
@file_put_contents($dir . '/subscribers-paid.csv', $line, FILE_APPEND | LOCK_EX);

echo json_encode(['ok' => true]);
