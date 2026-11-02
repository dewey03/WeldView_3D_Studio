using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Windows;

namespace WeldView.Desktop;

/// <summary>
/// C# 宿主 HTTP 服务（对应前端 <c>hostBase()</c> 的 hostPort）。
///
/// 接口契约由 <c>assets/app/wv33.js</c> 中的调用点逆向确定：
///   GET  /api/read_cad_file?path=&amp;raw=1   → 原始字节；不带 raw 时返回 {base64}
///   GET  /api/check_dir?path=               → {writable, path, reason}
///   GET  /api/pick_folder?initial=          → {ok, path} / {ok:false, canceled:true}
///   POST /api/open_folder?path=             → {ok}
///   POST /api/save_deliverable              → body {fileName, content, dir} → {ok, savedPath}
///   POST /api/save_project?ask=1            → body {fileName, content, dir} → {ok, savedPath}
///   POST /api/open_project?path=            → {ok, content, path} / {ok:false, canceled:true}
///
/// 页面源为 https://weldview.local，调用 http://127.0.0.1:PORT 属跨源，
/// 因此必须返回 CORS 头并处理 OPTIONS 预检。
/// </summary>
internal sealed class HostApi : IDisposable
{
    private const int DefaultPort = 18765;
    private const int PortScanRange = 100;

    /// <summary>
    /// 前端发送的是 camelCase（fileName / content / dir），
    /// C# 属性为 PascalCase，必须开启大小写不敏感匹配。
    /// </summary>
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private HttpListener? _listener;
    private CancellationTokenSource? _cts;

    public int Port { get; private set; }
    public string BaseUrl => $"http://127.0.0.1:{Port}";

    /// <summary>启动服务，返回实际监听端口。端口被占用时顺延。</summary>
    public int Start()
    {
        for (var port = DefaultPort; port < DefaultPort + PortScanRange; port++)
        {
            if (!IsPortFree(port)) continue;

            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            try
            {
                listener.Start();
            }
            catch (HttpListenerException)
            {
                listener.Close();
                continue;
            }

            _listener = listener;
            Port = port;
            _cts = new CancellationTokenSource();
            _ = Task.Run(() => AcceptLoop(listener, _cts.Token));
            return port;
        }

        throw new InvalidOperationException(
            $"无法在 {DefaultPort}–{DefaultPort + PortScanRange} 范围内绑定宿主端口。");
    }

    private static bool IsPortFree(int port)
    {
        try
        {
            var probe = new TcpListener(IPAddress.Loopback, port);
            probe.Start();
            probe.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    private async Task AcceptLoop(HttpListener listener, CancellationToken token)
    {
        while (!token.IsCancellationRequested && listener.IsListening)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await listener.GetContextAsync();
            }
            catch (Exception)
            {
                break;
            }

            _ = Task.Run(() =>
            {
                try { Handle(ctx); }
                catch (Exception ex) { TryWrite(ctx, 500, new { ok = false, error = ex.Message }); }
            }, token);
        }
    }

    // ------------------------------------------------------------------ 路由

    private void Handle(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var path = req.Url?.AbsolutePath ?? "/";
        var query = req.Url?.QueryParams() ?? new NameValueCollection();

        // CORS：页面在 https://weldview.local，属跨源请求
        ctx.Response.Headers["Access-Control-Allow-Origin"] = "*";
        ctx.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        ctx.Response.Headers["Access-Control-Allow-Headers"] = "Content-Type";

        if (req.HttpMethod.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
        {
            ctx.Response.StatusCode = 204;
            ctx.Response.Close();
            return;
        }

        switch (path)
        {
            case "/api/health":
                TryWrite(ctx, 200, new
                {
                    ok = true,
                    service = "WeldView_3D_Host",
                    version = "3.7",
                    port = Port,
                    features = new[] { "read_cad_file", "check_dir", "pick_folder", "open_folder",
                                       "save_deliverable", "save_project", "open_project" }
                });
                return;

            case "/api/read_cad_file":
                ReadCadFile(ctx, query);
                return;

            case "/api/check_dir":
                CheckDir(ctx, query);
                return;

            case "/api/pick_folder":
                PickFolder(ctx, query);
                return;

            case "/api/open_folder":
                OpenFolder(ctx, query);
                return;

            case "/api/save_deliverable":
                SaveFile(ctx, ask: false, extension: ".html");
                return;

            case "/api/save_project":
                SaveFile(ctx, ask: query["ask"] == "1", extension: ".wvproj");
                return;

            case "/api/open_project":
                OpenProject(ctx, query);
                return;

            default:
                TryWrite(ctx, 404, new { ok = false, error = $"未知接口: {path}" });
                return;
        }
    }

    // ------------------------------------------------------------ 各接口实现

    private static void ReadCadFile(HttpListenerContext ctx, NameValueCollection query)
    {
        var path = query["path"];
        if (string.IsNullOrWhiteSpace(path))
        {
            TryWrite(ctx, 400, new { ok = false, error = "缺少参数 path" });
            return;
        }
        if (!File.Exists(path))
        {
            TryWrite(ctx, 404, new { ok = false, error = "文件不存在", path });
            return;
        }

        var bytes = File.ReadAllBytes(path);

        if (query["raw"] == "1")
        {
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "application/octet-stream";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.Close();
            return;
        }

        TryWrite(ctx, 200, new
        {
            ok = true,
            fileName = Path.GetFileName(path),
            size = bytes.Length,
            base64 = Convert.ToBase64String(bytes)
        });
    }

    private static void CheckDir(HttpListenerContext ctx, NameValueCollection query)
    {
        var path = (query["path"] ?? string.Empty).Trim();

        if (path.Length == 0)
        {
            TryWrite(ctx, 200, new { writable = false, path, reason = "路径为空" });
            return;
        }

        try
        {
            if (!Directory.Exists(path))
            {
                TryWrite(ctx, 200, new { writable = false, path, reason = "目录不存在" });
                return;
            }

            // 实际写一个探针文件，比检查 ACL 更可靠
            var probe = Path.Combine(path, $".wv_write_test_{Guid.NewGuid():N}.tmp");
            using (var fs = File.Create(probe, 1, FileOptions.DeleteOnClose))
            {
                fs.WriteByte(0);
            }

            TryWrite(ctx, 200, new { writable = true, path });
        }
        catch (Exception ex)
        {
            TryWrite(ctx, 200, new { writable = false, path, reason = ex.Message });
        }
    }

    private void PickFolder(HttpListenerContext ctx, NameValueCollection query)
    {
        var initial = query["initial"] ?? string.Empty;

        var result = OnUiThread(() =>
        {
            using var dialog = new System.Windows.Forms.FolderBrowserDialog
            {
                Description = "选择焊缝成果导出目录",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = true
            };
            if (Directory.Exists(initial)) dialog.SelectedPath = initial;

            return dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK
                ? new { ok = true, path = dialog.SelectedPath, canceled = false }
                : new { ok = false, path = string.Empty, canceled = true };
        });

        TryWrite(ctx, 200, result);
    }

    private static void OpenFolder(HttpListenerContext ctx, NameValueCollection query)
    {
        var path = query["path"];
        if (string.IsNullOrWhiteSpace(path)) path = AppPaths.ExportDir;

        try
        {
            Directory.CreateDirectory(path);
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"\"{path}\"",
                UseShellExecute = true
            });
            TryWrite(ctx, 200, new { ok = true, path });
        }
        catch (Exception ex)
        {
            TryWrite(ctx, 500, new { ok = false, error = ex.Message });
        }
    }

    /// <summary>
    /// 保存交付物 / 工程文件。
    /// 优先写入 body.dir（前端设置中的输出目录）；为空或不可写时：
    ///   - 交付物 → 安装目录下 exports\
    ///   - 工程文件（ask=true）→ 弹出另存为对话框
    /// </summary>
    private void SaveFile(HttpListenerContext ctx, bool ask, string extension)
    {
        SaveRequest? body;
        using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
        {
            var raw = reader.ReadToEnd();
            body = JsonSerializer.Deserialize<SaveRequest>(raw, JsonOpts);
        }

        if (body is null || string.IsNullOrEmpty(body.Content))
        {
            TryWrite(ctx, 400, new { ok = false, error = "请求体缺少 fileName / content" });
            return;
        }

        var fileName = string.IsNullOrWhiteSpace(body.FileName)
            ? $"weldview-{DateTime.Now:yyyyMMdd-HHmmss}{extension}"
            : Path.GetFileName(body.FileName);

        // 1) 指定目录且可写
        if (!string.IsNullOrWhiteSpace(body.Dir) && Directory.Exists(body.Dir))
        {
            try
            {
                var target = Path.Combine(body.Dir, fileName);
                File.WriteAllText(target, body.Content, new UTF8Encoding(false));
                TryWrite(ctx, 200, new { ok = true, savedPath = target, canceled = false });
                return;
            }
            catch
            {
                // 落到后续分支
            }
        }

        // 2) 另存为对话框
        if (ask)
        {
            var picked = OnUiThread(() =>
            {
                using var dialog = new System.Windows.Forms.SaveFileDialog
                {
                    Title = "保存文件",
                    FileName = fileName,
                    Filter = extension == ".wvproj"
                        ? "WeldView 工程 (*.wvproj)|*.wvproj|所有文件 (*.*)|*.*"
                        : "HTML 成果 (*.html)|*.html|所有文件 (*.*)|*.*",
                    OverwritePrompt = true
                };
                return dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK
                    ? dialog.FileName
                    : null;
            });

            if (picked is null)
            {
                TryWrite(ctx, 200, new { ok = false, canceled = true, error = "用户取消" });
                return;
            }

            try
            {
                File.WriteAllText(picked, body.Content, new UTF8Encoding(false));
                TryWrite(ctx, 200, new { ok = true, savedPath = picked, canceled = false });
            }
            catch (Exception ex)
            {
                TryWrite(ctx, 500, new { ok = false, error = ex.Message });
            }
            return;
        }

        // 3) 默认落到安装目录 exports\
        try
        {
            var dir = Path.Combine(AppPaths.AppRoot, "exports");
            Directory.CreateDirectory(dir);
            var target = Path.Combine(dir, fileName);
            File.WriteAllText(target, body.Content, new UTF8Encoding(false));
            TryWrite(ctx, 200, new { ok = true, savedPath = target, canceled = false });
        }
        catch (Exception ex)
        {
            TryWrite(ctx, 500, new { ok = false, error = ex.Message });
        }
    }

    private void OpenProject(HttpListenerContext ctx, NameValueCollection query)
    {
        var path = query["path"];

        if (string.IsNullOrWhiteSpace(path))
        {
            path = OnUiThread(() =>
            {
                using var dialog = new System.Windows.Forms.OpenFileDialog
                {
                    Title = "打开 WeldView 工程",
                    Filter = "WeldView 工程 (*.wvproj)|*.wvproj|所有文件 (*.*)|*.*",
                    CheckFileExists = true
                };
                return dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK
                    ? dialog.FileName
                    : null;
            });
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            TryWrite(ctx, 200, new { ok = false, canceled = true, error = "用户取消" });
            return;
        }

        try
        {
            var content = File.ReadAllText(path, Encoding.UTF8);
            TryWrite(ctx, 200, new { ok = true, content, path });
        }
        catch (Exception ex)
        {
            TryWrite(ctx, 500, new { ok = false, error = ex.Message });
        }
    }

    // ------------------------------------------------------------------ 工具

    private sealed class SaveRequest
    {
        public string? FileName { get; set; }
        public string? Content { get; set; }
        public string? Dir { get; set; }
    }

    private static T OnUiThread<T>(Func<T> fn)
    {
        var app = System.Windows.Application.Current;
        if (app is null || app.Dispatcher.CheckAccess()) return fn();
        return app.Dispatcher.Invoke(fn);
    }

    private static void TryWrite(HttpListenerContext ctx, int status, object payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload);
            var bytes = Encoding.UTF8.GetBytes(json);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.Close();
        }
        catch
        {
            try { ctx.Response.Abort(); } catch { /* 忽略 */ }
        }
    }

    public void Dispose()
    {
        try { _cts?.Cancel(); } catch { /* 忽略 */ }
        try { _listener?.Stop(); } catch { /* 忽略 */ }
        try { _listener?.Close(); } catch { /* 忽略 */ }
        _cts?.Dispose();
    }
}

internal static class UriExtensions
{
    /// <summary>把查询串解析为 NameValueCollection，便于按 key 取值。</summary>
    public static NameValueCollection QueryParams(this Uri uri)
    {
        var nvc = new NameValueCollection(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(uri.Query)) return nvc;

        var query = uri.Query.TrimStart('?');
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var idx = pair.IndexOf('=');
            var key = idx < 0 ? pair : pair[..idx];
            var value = idx < 0 ? string.Empty : pair[(idx + 1)..];
            nvc[Uri.UnescapeDataString(key)] = Uri.UnescapeDataString(value);
        }
        return nvc;
    }
}
