<?php
/**
 * Minimal email-capture endpoint for the GRAPHY site (Phase 1).
 *
 * Deployed alongside the static site on Xserver (PHP available). Notifies the
 * team and appends to a CSV stored OUTSIDE the web root. Phase 2 will replace
 * this with a proper ESP / Stripe-linked list.
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

$to      = 'customerservices@vis-ionary.com';
$from    = 'wordpress@vis-ionary.com';
$subject = '[GRAPHY] 更新通知の登録';
$body    = "email: {$email}\nsource: {$source}\nip: {$_SERVER['REMOTE_ADDR']}\nua: {$_SERVER['HTTP_USER_AGENT']}\n";
$headers = "From: {$from}\r\nContent-Type: text/plain; charset=UTF-8\r\n";

// Best-effort notify (do not fail the request if mail() is unavailable).
@mail($to, $subject, $body, $headers);

// Best-effort append to a CSV kept outside the document root.
$dir = __DIR__ . '/../../graphy-data';
if (!is_dir($dir)) { @mkdir($dir, 0700, true); }
$line = sprintf("%s,%s,%s,\"%s\"\n", date('c'), $email, $source, str_replace('"', "'", $_SERVER['REMOTE_ADDR'] ?? ''));
@file_put_contents($dir . '/subscribers.csv', $line, FILE_APPEND | LOCK_EX);

echo json_encode(['ok' => true]);
