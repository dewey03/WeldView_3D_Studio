using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using WinForms = System.Windows.Forms;

namespace WeldView.Desktop;

/// <summary>
/// 桌面主窗口：托盘常驻宿主 + WebView2 承载前端。
///
/// 架构（依据发行版二进制与前端代码逆向确定）：
///   前端页面  https://weldview.local/            ← WebView2 虚拟主机映射
///   宿主 API  http://127.0.0.1:{动态端口}/api/*  ← 本类 HostApi，端口经 ?hostPort= 传给页面
///   桥接服务  http://127.0.0.1:18766/api/open_sw ← tools/ 下的 Python 服务（SolidWorks COM）
/// </summary>
public partial class MainWindow : Window
{
    private readonly string _appRoot;
    private readonly HostApi _host = new();
    private WinForms.NotifyIcon? _tray;
    private bool _webViewReady;
    private bool _reallyExit;

    public MainWindow(string appRoot)
    {
        _appRoot = appRoot;
        InitializeComponent();

        RestoreWindowBounds();
        SetupTray();

        Loaded += async (_, _) => await InitializeWebViewAsync();
        Closing += OnClosing;
    }

    // ------------------------------------------------------------ 托盘常驻

    private void SetupTray()
    {
        var menu = new WinForms.ContextMenuStrip();
        menu.Items.Add("显示主窗口", null, (_, _) => RestoreFromTray());
        menu.Items.Add(new WinForms.ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApplication());

        _tray = new WinForms.NotifyIcon
        {
            Text = "WeldView 3D Studio",
            Icon = LoadTrayIcon(),
            Visible = true,
            ContextMenuStrip = menu
        };
        _tray.DoubleClick += (_, _) => RestoreFromTray();
    }

    private static System.Drawing.Icon LoadTrayIcon()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(exe))
            {
                var icon = System.Drawing.Icon.ExtractAssociatedIcon(exe);
                if (icon is not null) return icon;
            }
        }
        catch
        {
            // 回退到系统默认图标
        }
        return System.Drawing.SystemIcons.Application;
    }

    private void RestoreFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        _reallyExit = true;
        Close();
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        SaveWindowBounds();

        // 点关闭按钮 → 收进托盘；通过托盘「退出」才真正结束
        if (!_reallyExit)
        {
            e.Cancel = true;
            Hide();
            _tray?.ShowBalloonTip(1500, "WeldView 3D Studio",
                "程序仍在后台运行，可从托盘图标恢复窗口。", WinForms.ToolTipIcon.Info);
            return;
        }

        _tray?.Dispose();
        _host.Dispose();
    }

    // ------------------------------------------------------ WebView2 初始化

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

            // 本地目录 → https 虚拟源。file:// 下 ES Module 与 WASM 会被安全策略拦截。
            core.SetVirtualHostNameToFolderMapping(
                AppPaths.VirtualHost,
                _appRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // 启动宿主 API，并把动态端口通过查询串交给页面（前端 hostBase() 读取 hostPort）
            var port = _host.Start();

            SplashStatus.Text = $"正在加载焊缝识别工作台（宿主端口 {port}）…";
            core.Navigate($"{AppPaths.HostUrl}?hostPort={port}");

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
        s.AreBrowserAcceleratorKeysEnabled = true;
        s.IsSwipeNavigationEnabled = false;
        s.AreHostObjectsAllowed = false;   // 前端不使用宿主对象注入
        s.IsWebMessageEnabled = false;     // 前端不使用 postMessage
        s.AreDevToolsEnabled = false;      // 调试时改为 true
    }

    private void RegisterHandlers(CoreWebView2 core)
    {
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

    // -------------------------------------------------------- 下载与导出

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
            // 导出目录不可写时回退到系统默认流程
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

    // ------------------------------------------------------ 窗口状态持久化

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
            // 配置损坏时忽略
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
