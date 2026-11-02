using System.Threading;

namespace WeldView.Desktop;

internal static class Program
{
    private const string MutexName = @"Global\WeldView3DStudio.SingleInstance";

    [STAThread]
    private static void Main()
    {
        // 单实例：避免重复打开时争用同一个 WebView2 用户数据目录与宿主端口
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            System.Windows.MessageBox.Show(
                "WeldView 3D Studio 已在运行，请从系统托盘图标打开窗口。",
                "WeldView 3D Studio",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Information);
            return;
        }

        var appRoot = AppPaths.ResolveAppRoot();

        // 显式限定为 WPF Application（项目同时引用 WinForms，存在同名类型）
        var app = new System.Windows.Application
        {
            ShutdownMode = System.Windows.ShutdownMode.OnMainWindowClose
        };

        app.Run(new MainWindow(appRoot));
    }
}
