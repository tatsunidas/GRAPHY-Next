# GRAPHY ポータブル 2D ビューアの起動用ローカルサーバ（Windows）。
# 媒体フォルダを読み取り専用で配信し、既定のブラウザでビューアを開く。
# 127.0.0.1 の乱数ポート・乱数トークン付き URL だけで応答する。ブラウザを閉じて一定時間たつと自動で終了する。
# Local read-only server for the GRAPHY portable 2D viewer. Serves only this media folder on 127.0.0.1.
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [int]$IdleSeconds = $(if ($env:GRAPHY_VIEWER_IDLE_SECONDS) { [int]$env:GRAPHY_VIEWER_IDLE_SECONDS } else { 180 })
)
$ErrorActionPreference = 'Stop'
$Root = [System.IO.Path]::GetFullPath($Root)

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public static class MediaServer
{
    static HttpListener listener;
    static string root;
    static string token;
    static int port;
    static long lastTick;
    static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".mjs", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" }, { ".json", "application/json" }, { ".wasm", "application/wasm" },
        { ".svg", "image/svg+xml" }, { ".png", "image/png" }, { ".ico", "image/x-icon" }, { ".mp4", "video/mp4" },
        { ".txt", "text/plain; charset=utf-8" }, { ".dcm", "application/dicom" }
    };

    public static string Start(string rootPath)
    {
        root = rootPath.TrimEnd('\\', '/');
        byte[] b = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) { rng.GetBytes(b); }
        token = BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        Random r = new Random();
        for (int i = 0; i < 50; i++)
        {
            int p = 49152 + r.Next(16000);
            HttpListener l = new HttpListener();
            l.Prefixes.Add("http://127.0.0.1:" + p + "/" + token + "/");
            try { l.Start(); listener = l; port = p; break; } catch (HttpListenerException) { l.Close(); }
        }
        if (listener == null) throw new InvalidOperationException("no free port");
        lastTick = Environment.TickCount;
        Thread t = new Thread(Loop);
        t.IsBackground = true;
        t.Start();
        return "http://127.0.0.1:" + port + "/" + token + "/";
    }

    public static int IdleSeconds() { return (int)((uint)(Environment.TickCount - (int)lastTick) / 1000); }

    static void Loop()
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); } catch (Exception) { return; }
            ThreadPool.QueueUserWorkItem(delegate { Handle(ctx); });
        }
    }

    static void Fail(HttpListenerContext c, int code)
    {
        try { c.Response.StatusCode = code; c.Response.ContentLength64 = 0; c.Response.OutputStream.Close(); } catch (Exception) { }
    }

    static void Handle(HttpListenerContext c)
    {
        try
        {
            lastTick = Environment.TickCount;
            string host = c.Request.Headers["Host"] ?? "";
            if (host != "127.0.0.1:" + port && host != "localhost:" + port) { Fail(c, 400); return; }
            string m = c.Request.HttpMethod;
            if (m != "GET" && m != "HEAD") { Fail(c, 405); return; }
            string abs = c.Request.Url.AbsolutePath;
            string prefix = "/" + token + "/";
            if (!abs.StartsWith(prefix, StringComparison.Ordinal)) { Fail(c, 404); return; }
            string rel = abs.Substring(prefix.Length);
            if (rel == "__ping") { Fail(c, 204); return; }
            string[] segs = rel.Split('/');
            List<string> clean = new List<string>();
            foreach (string s0 in segs)
            {
                string s = Uri.UnescapeDataString(s0);
                if (s.Length == 0 || s == "." || s == ".." || s.IndexOfAny(new char[] { '\\', ':', '\0', '*', '?', '"', '<', '>', '|' }) >= 0) { Fail(c, 404); return; }
                clean.Add(s);
            }
            string full = Path.GetFullPath(Path.Combine(root, string.Join("\\", clean.ToArray())));
            if (!full.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { Fail(c, 404); return; }
            string mime;
            if (!Mime.TryGetValue(Path.GetExtension(full), out mime)) mime = "application/octet-stream";
            using (FileStream fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                long len = fs.Length, from = 0, to = len - 1;
                string range = c.Request.Headers["Range"];
                int status = 200;
                if (range != null && range.StartsWith("bytes=", StringComparison.Ordinal))
                {
                    string[] pr = range.Substring(6).Split('-');
                    long a, e;
                    if (pr.Length == 2 && pr[0].Length > 0 && long.TryParse(pr[0], out a) && a < len)
                    {
                        from = a;
                        if (pr[1].Length > 0 && long.TryParse(pr[1], out e) && e < len) to = e;
                        status = 206;
                    }
                }
                c.Response.StatusCode = status;
                c.Response.ContentType = mime;
                c.Response.AddHeader("X-Content-Type-Options", "nosniff");
                c.Response.AddHeader("Cross-Origin-Resource-Policy", "same-origin");
                c.Response.AddHeader("Referrer-Policy", "no-referrer");
                c.Response.AddHeader("Accept-Ranges", "bytes");
                c.Response.AddHeader("Cache-Control", "private, max-age=600");
                if (status == 206) c.Response.AddHeader("Content-Range", "bytes " + from + "-" + to + "/" + len);
                long count = to - from + 1;
                c.Response.ContentLength64 = count;
                if (m != "HEAD")
                {
                    fs.Seek(from, SeekOrigin.Begin);
                    byte[] buf = new byte[81920];
                    long left = count;
                    while (left > 0)
                    {
                        int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) break;
                        c.Response.OutputStream.Write(buf, 0, n);
                        left -= n;
                    }
                }
                c.Response.OutputStream.Close();
            }
        }
        catch (Exception) { try { c.Response.Abort(); } catch (Exception) { } }
    }
}
'@

if (-not (Test-Path -LiteralPath (Join-Path $Root 'DICOMDIR'))) {
    Write-Host "DICOMDIR が見つかりません / DICOMDIR not found in: $Root"
}
Add-Type -TypeDefinition $source -Language CSharp
$base = [MediaServer]::Start($Root)
$url = $base + 'VIEWER/index.html'
Write-Host "VIEWER_URL=$url"
if (-not $env:GRAPHY_VIEWER_NO_BROWSER) {
    Start-Process $url
}
Write-Host ''
Write-Host 'ビューアを開きました。このウィンドウを閉じると終了します（ブラウザを閉じて約 3 分後にも自動で終了します）。'
Write-Host 'Viewer is running. Close this window to stop (it also stops about 3 minutes after the browser is closed).'
while ([MediaServer]::IdleSeconds() -lt $IdleSeconds) {
    Start-Sleep -Seconds 2
}
Write-Host 'Idle timeout. 自動終了します / Stopping.'
