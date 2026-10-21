#!/usr/bin/perl
# GRAPHY ポータブル 2D ビューアの起動用ローカルサーバ（macOS / Linux）。標準の Perl だけで動く。
# 媒体フォルダを読み取り専用で配信し、既定のブラウザでビューアを開く。
# 127.0.0.1 の乱数ポート・乱数トークン付き URL だけで応答する。ブラウザを閉じて一定時間たつと自動で終了する。
# Local read-only server for the GRAPHY portable 2D viewer. Serves only this media folder on 127.0.0.1.
use strict;
$| = 1;
use warnings;
use IO::Socket::INET;
use IO::Select;
use Cwd qw(abs_path);
use POSIX ":sys_wait_h";

my $root = abs_path($ARGV[0] // '.') or die "root not found\n";
my $idle = $ENV{GRAPHY_VIEWER_IDLE_SECONDS} || 180;

open(my $rnd, '<:raw', '/dev/urandom') or die "cannot read /dev/urandom: $!\n";
read($rnd, my $bytes, 16) == 16 or die "no randomness\n";
close($rnd);
my $token = unpack('H*', $bytes);

my $srv = IO::Socket::INET->new(
    LocalAddr => '127.0.0.1', LocalPort => 0, Proto => 'tcp', Listen => 64, ReuseAddr => 1,
) or die "cannot listen: $!\n";
my $port = $srv->sockport;

my %mime = (
    html => 'text/html; charset=utf-8', js => 'text/javascript; charset=utf-8', mjs => 'text/javascript; charset=utf-8',
    css => 'text/css; charset=utf-8', json => 'application/json', wasm => 'application/wasm',
    svg => 'image/svg+xml', png => 'image/png', ico => 'image/x-icon', mp4 => 'video/mp4',
    txt => 'text/plain; charset=utf-8', dcm => 'application/dicom',
);

sub reply {
    my ($c, $code, $reason, $extra, $len) = @_;
    print $c "HTTP/1.1 $code $reason\r\nContent-Length: " . ($len // 0) . "\r\nConnection: close\r\n" . ($extra // '')
        . "X-Content-Type-Options: nosniff\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer\r\n\r\n";
}

sub handle {
    my ($c) = @_;
    $c->autoflush(1);
    my $sel = IO::Select->new($c);
    return unless $sel->can_read(10);
    my $req = '';
    while ($req !~ /\r?\n\r?\n/ && length($req) < 16384) {
        my $n = sysread($c, my $buf, 4096);
        last unless $n;
        $req .= $buf;
    }
    my ($line, @hdr) = split(/\r?\n/, $req);
    return reply($c, 400, 'Bad Request') unless defined $line && $line =~ m{^(GET|HEAD) (\S+) HTTP/1\.[01]$};
    my ($method, $target) = ($1, $2);
    my %h;
    for (@hdr) { $h{lc $1} = $2 if /^([^:]+):\s*(.*)$/ }
    my $host = $h{host} // '';
    return reply($c, 400, 'Bad Request') unless $host eq "127.0.0.1:$port" || $host eq "localhost:$port";
    $target =~ s/[?#].*$//;
    my $prefix = "/$token/";
    return reply($c, 404, 'Not Found') unless index($target, $prefix) == 0;
    my $rel = substr($target, length($prefix));
    return reply($c, 204, 'No Content') if $rel eq '__ping';
    my @clean;
    for my $s (split(m{/}, $rel, -1)) {
        $s =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
        return reply($c, 404, 'Not Found') if $s eq '' || $s eq '.' || $s eq '..' || $s =~ m{[\\/\0]};
        push @clean, $s;
    }
    my $path = abs_path(join('/', $root, @clean));
    return reply($c, 404, 'Not Found') unless defined $path && index($path, "$root/") == 0 && -f $path;
    open(my $fh, '<:raw', $path) or return reply($c, 404, 'Not Found');
    my $len = -s $fh;
    my ($from, $to, $code, $reason) = (0, $len - 1, 200, 'OK');
    my $extra = '';
    if (defined $h{range} && $h{range} =~ /^bytes=(\d+)-(\d*)$/ && $1 < $len) {
        $from = $1;
        $to = ($2 ne '' && $2 < $len) ? $2 : $len - 1;
        ($code, $reason) = (206, 'Partial Content');
        $extra .= "Content-Range: bytes $from-$to/$len\r\n";
    }
    my ($ext) = $path =~ /\.([^.\/]+)$/;
    my $type = $mime{lc($ext // '')} // 'application/octet-stream';
    $extra .= "Content-Type: $type\r\nAccept-Ranges: bytes\r\nCache-Control: private, max-age=600\r\n";
    my $count = $to - $from + 1;
    reply($c, $code, $reason, $extra, $count);
    if ($method eq 'GET') {
        seek($fh, $from, 0);
        my $left = $count;
        while ($left > 0) {
            my $n = read($fh, my $buf, $left > 65536 ? 65536 : $left);
            last unless $n;
            print $c $buf;
            $left -= $n;
        }
    }
    close($fh);
}

my $url = "http://127.0.0.1:$port/$token/VIEWER/index.html";
print "VIEWER_URL=$url\n";
unless ($ENV{GRAPHY_VIEWER_NO_BROWSER}) {
    my $opener = $^O eq 'darwin' ? 'open' : 'xdg-open';
    system("$opener '$url' >/dev/null 2>&1 &");
}
print "\nビューアを開きました。このウィンドウを閉じる（Ctrl+C）と終了します（ブラウザを閉じて約 3 分後にも自動で終了します）。\n";
print "Viewer is running. Close this window (Ctrl+C) to stop; it also stops about 3 minutes after the browser is closed.\n";

$SIG{CHLD} = sub { while (waitpid(-1, WNOHANG) > 0) { } };
$SIG{PIPE} = 'IGNORE';
my $sel = IO::Select->new($srv);
my $last = time;
while (time - $last < $idle) {
    my @ready = $sel->can_read(2);
    for my $s (@ready) {
        my $c = $srv->accept or next;
        $last = time;
        my $pid = fork();
        if (!defined $pid) { close($c); next; }
        if ($pid == 0) {
            close($srv);
            eval { handle($c) };
            close($c);
            exit 0;
        }
        close($c);
    }
}
print "Idle timeout. 自動終了します / Stopping.\n";
