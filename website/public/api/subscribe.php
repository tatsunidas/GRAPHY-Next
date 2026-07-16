<?php
/**
 * Email-capture endpoint for the GRAPHY site.
 *
 * Deployed alongside the static site on Xserver (PHP available). The single
 * source of truth for the subscriber list is graphy-backend's
 * mailing_list_subscriber table (shared with the demo login's opt-in
 * checkbox, see backend/.../auth/AuthController.java `POST /subscribe`) so
 * that /unsubscribe on demo.vis-ionary.com covers signups from here too.
 * The mail() notify + CSV append below are kept only as a local best-effort
 * fallback/audit trail in case graphy-backend is unreachable — they are not
 * meant to be used as an actual send list anymore.
 *
 * POST fields: email (required), source (optional), website (honeypot).
 */

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method_not_allowed']);
    exit;
}

// Honeypot: real users leave this empty.
if (!empty($_POST['website'])) {
    echo json_encode(['ok' => true]); // pretend success
    exit;
}

$email  = isset($_POST['email']) ? trim((string) $_POST['email']) : '';
$source = isset($_POST['source']) ? substr(preg_replace('/[^a-zA-Z0-9_\-]/', '', (string) $_POST['source']), 0, 40) : 'unknown';

if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254) {
    http_response_code(422);
    echo json_encode(['ok' => false, 'error' => 'invalid_email']);
    exit;
}

$dir = getenv('GRAPHY_DATA_DIR') ?: '/home/tatsunidas76/graphy-data';

// Primary store: graphy-backend's mailing_list_subscriber table. Secret lives
// OUTSIDE the web root/repo (never commit it) — see deploy/demo/.env.example
// GRAPHY_AUTH_SUBSCRIBE_API_KEY for the paired value on the backend side.
$apiKey = getenv('GRAPHY_SUBSCRIBE_API_KEY') ?: @file_get_contents($dir . '/subscribe-api-key.txt');
$synced = false;
if ($apiKey) {
    $ch = curl_init('https://demo.vis-ionary.com/subscribe');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query(['email' => $email]),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . trim($apiKey)],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 5,
    ]);
    curl_exec($ch);
    $synced = curl_getinfo($ch, CURLINFO_HTTP_CODE) === 204;
    curl_close($ch);
}

// Fallback/audit trail only (not the send list) if graphy-backend was unreachable.
if (!$synced) {
    $to      = 'customerservices@vis-ionary.com';
    $from    = 'wordpress@vis-ionary.com';
    $subject = '[GRAPHY] 更新通知の登録（backend同期失敗・要確認）';
    $body    = "email: {$email}\nsource: {$source}\nip: {$_SERVER['REMOTE_ADDR']}\nua: {$_SERVER['HTTP_USER_AGENT']}\n";
    $headers = "From: {$from}\r\nContent-Type: text/plain; charset=UTF-8\r\n";
    @mail($to, $subject, $body, $headers);

    if (!is_dir($dir)) { @mkdir($dir, 0700, true); }
    $line = sprintf("%s,%s,%s,\"%s\"\n", date('c'), $email, $source, str_replace('"', "'", $_SERVER['REMOTE_ADDR'] ?? ''));
    @file_put_contents($dir . '/subscribers.csv', $line, FILE_APPEND | LOCK_EX);
}

echo json_encode(['ok' => true]);
