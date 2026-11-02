using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace WeldView.Desktop;

/// <summary>
/// 桌面主窗口：承载 WebView2，把本地应用目录映射为 https 虚拟源后加载宿主页面。
///
/// 设计依据（来自对发行版 exe 与安装目录的静态分析）：
///   - PE 含 .CLR_UEF 节区、仅导入 Win32 + UCRT → .NET 桌面程序；
///   - 二进制含 WebView2 特征串，安装目录含 webview_profile → 使用 WebView2 内核；
///   - 宿主页面与 wv33.js 均无 chrome.webview / postMessage 调用 → 无 JS↔宿主 IPC，
///     页面完全在浏览器内核内自洽运行，宿主只负责窗口与文件下载。
/// </summary>
public partial class MainWindow : Window
{
    private readonly string _appRoot;
    private bool _webViewReady;

    public MainWindow(string appRoot)
    {
        _appRoot = appRoot;
        InitializeComponent();

        RestoreWindowBounds();

        Loaded += async (_, _) => await InitializeWebViewAsync();
        Closing += (_, _) => SaveWindowBounds();
    }

    // ---------------- WebView2 初始化 ----------------

    private async Task InitializeWebViewAsync()
    {
        if (_webViewReady) return;

        try
        {
            Directory.CreateDirectory(AppPaths.WebViewProfileDir);

            SplashStatus.Text = "正在创建 WebView2 运行环境…";

            var env = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: AppPaths.WebViewProfileDir);

            await View.EnsureCoreWebView2Async(env);

            var core = View.CoreWebView2;
            ConfigureSettings(core);
            RegisterHandlers(core);

            // 关键：把本地目录映射为 https 源。
            // 直接用 file:// 加载时，ES Module 与 WASM 会被浏览器安全策略拦截。
            core.SetVirtualHostNameToFolderMapping(
                AppPaths.VirtualHost,
                _appRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            SplashStatus.Text = "正在加载焊缝识别工作台…";
            core.Navigate(AppPaths.HostUrl);

            _webViewReady = true;
        }
        catch (Exception ex)
        {
            SplashStatus.Text =
                "初始化失败。\n\n" +
                "常见原因：本机未安装 WebView2 运行时（Evergreen Runtime）。\n" +
                "下载地址：https://developer.microsoft.com/microsoft-edge/webview2/\n\n" +
                $"详细信息：{ex.Message}";
        }
    }

    private static void ConfigureSettings(CoreWebView2 core)
    {
        var s = core.Settings;
        s.AreDefaultContextMenusEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = true;
        s.AreBrowserAcceleratorKeysEnabled = true;   // 保留 F5 / Ctrl+滚轮等
        s.IsSwipeNavigationEnabled = false;
        s.AreHostObjectsAllowed = false;             // 无宿主对象注入，与观测一致
        s.IsWebMessageEnabled = false;               // 无 postMessage 通道，与观测一致
        s.AreDevToolsEnabled = false;                // 发行版关闭；调试时改为 true
    }

    private void RegisterHandlers(CoreWebView2 core)
    {
        // 外部链接：交给系统默认浏览器，避免在应用窗口内跳出
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        };

        core.DownloadStarting += OnDownloadStarting;

        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess)
            {
                Splash.Visibility = Visibility.Collapsed;
                View.Visibility = Visibility.Visible;
            }
            else
            {
                SplashStatus.Text = $"页面加载失败：{e.WebErrorStatus}";
            }
        };

        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited)
            {
                core.Reload();
            }
        };
    }

    // ---------------- 下载与导出 ----------------

    private void OnDownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.ExportDir);

            var suggested = Path.GetFileName(e.ResultFilePath);
            if (string.IsNullOrWhiteSpace(suggested))
            {
                suggested = "weldview-export.html";
            }

            e.ResultFilePath = Path.Combine(AppPaths.ExportDir, suggested);
            e.Handled = true;
        }
        catch
        {
            // 导出目录不可写时回退到系统默认下载流程
        }
    }

    private static void OpenExternal(string uri)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = uri,
                UseShellExecute = true
            });
        }
        catch
        {
            // 忽略无法打开的外部链接
        }
    }

    // ---------------- 窗口状态持久化 ----------------

    private sealed class WindowStateDto
    {
        public double Left { get; set; }
        public double Top { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
        public bool Maximized { get; set; }
    }

    private void RestoreWindowBounds()
    {
        try
        {
            if (!File.Exists(AppPaths.WindowStateFile)) return;

            var dto = JsonSerializer.Deserialize<WindowStateDto>(
                File.ReadAllText(AppPaths.WindowStateFile));
            if (dto is null) return;

            // 防止显示器变更后窗口落在屏幕外
            var vLeft = SystemParameters.VirtualScreenLeft;
            var vTop = SystemParameters.VirtualScreenTop;
            var vRight = vLeft + SystemParameters.VirtualScreenWidth;
            var vBottom = vTop + SystemParameters.VirtualScreenHeight;

            var visible = dto.Left < vRight - 80
                          && dto.Left + dto.Width > vLeft + 80
                          && dto.Top < vBottom - 60
                          && dto.Top + dto.Height > vTop;

            if (visible && dto.Width > 400 && dto.Height > 300)
            {
                WindowStartupLocation = WindowStartupLocation.Manual;
                Left = dto.Left;
                Top = dto.Top;
                Width = dto.Width;
                Height = dto.Height;
            }

            if (dto.Maximized) WindowState = WindowState.Maximized;
        }
        catch
        {
            // 配置损坏时忽略，使用默认尺寸
        }
    }

    private void SaveWindowBounds()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.UserDataDir);

            var bounds = WindowState == WindowState.Normal
                ? new Rect(Left, Top, Width, Height)
                : RestoreBounds;

            var dto = new WindowStateDto
            {
                Left = bounds.Left,
                Top = bounds.Top,
                Width = bounds.Width,
                Height = bounds.Height,
                Maximized = WindowState == WindowState.Maximized
            };

            File.WriteAllText(
                AppPaths.WindowStateFile,
                JsonSerializer.Serialize(dto, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch
        {
            // 写盘失败不影响退出
        }
    }
}
