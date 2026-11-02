using System.IO;

namespace WeldView.Desktop;

/// <summary>
/// 路径与虚拟主机配置。
/// 目录布局与发行版安装目录保持一致：
///   &lt;root&gt;/WeldView_3D_Studio.exe
///   &lt;root&gt;/WeldView_3D_Studio_V3.3.html     宿主页面
///   &lt;root&gt;/assets/app/wv33.js
///   &lt;root&gt;/assets/vendor/{three,occt}
/// </summary>
internal static class AppPaths
{
    /// <summary>WebView2 虚拟主机名。把本地目录映射为 https 源，ES Module 与 WASM 才能加载。</summary>
    public const string VirtualHost = "weldview.local";

    /// <summary>宿主页面文件名（与安装目录一致）。</summary>
    public const string HostPageName = "WeldView_3D_Studio_V3.3.html";

    /// <summary>应用根目录（包含 assets/ 与宿主页面的目录）。</summary>
    public static string AppRoot { get; private set; } = AppContext.BaseDirectory;

    /// <summary>用户数据目录：%LOCALAPPDATA%\WeldView 3D Studio</summary>
    public static string UserDataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "WeldView 3D Studio");

    /// <summary>WebView2 用户配置目录，对应安装目录下的 webview_profile。</summary>
    public static string WebViewProfileDir => Path.Combine(UserDataDir, "webview_profile");

    /// <summary>默认导出目录：我的文档\WeldView Exports</summary>
    public static string ExportDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        "WeldView Exports");

    /// <summary>窗口位置与尺寸缓存。</summary>
    public static string WindowStateFile => Path.Combine(UserDataDir, "window.json");

    /// <summary>
    /// 解析应用根目录：
    /// 1) 安装态 —— exe 同级存在宿主页面与 assets/app/wv33.js；
    /// 2) 开发态 —— 从 bin 输出目录向上回溯，找到仓库根。
    /// </summary>
    public static string ResolveAppRoot()
    {
        var baseDir = AppContext.BaseDirectory;

        if (IsAppRoot(baseDir))
        {
            AppRoot = baseDir;
            return AppRoot;
        }

        var probe = new DirectoryInfo(baseDir);
        for (var i = 0; i < 8 && probe is not null; i++)
        {
            if (IsAppRoot(probe.FullName))
            {
                AppRoot = probe.FullName;
                return AppRoot;
            }
            probe = probe.Parent;
        }

        AppRoot = baseDir;
        return AppRoot;
    }

    private static bool IsAppRoot(string dir) =>
        File.Exists(Path.Combine(dir, HostPageName)) &&
        File.Exists(Path.Combine(dir, "assets", "app", "wv33.js"));

    /// <summary>宿主页面相对路径。</summary>
    public static string HostPage => HostPageName;

    /// <summary>宿主页面完整地址。</summary>
    public static string HostUrl => $"https://{VirtualHost}/{HostPage}";
}
