using System.Threading;
using System.Windows;

namespace WeldView.Desktop;

internal static class Program
{
    private const string MutexName = @"Global\WeldView3DStudio.SingleInstance";

    [STAThread]
    private static void Main()
    {
        // 单实例：避免重复打开时争用同一个 WebView2 用户数据目录
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            MessageBox.Show(
                "WeldView 3D Studio 已在运行。",
                "WeldView 3D Studio",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            return;
        }

        var appRoot = AppPaths.ResolveAppRoot();

        var app = new Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };

        app.Run(new MainWindow(appRoot));
    }
}
