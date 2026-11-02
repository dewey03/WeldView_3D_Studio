; ============================================================================
;  WeldView 3D Studio — Inno Setup 6 安装脚本（重建）
;
;  说明：发行版原安装器配置未留存，本脚本依据安装目录的可观察结果重建：
;    - 安装根目录含 WeldView_3D_Studio.exe、Uninstall.exe、assets\、samples\、
;      exports\、webview_profile\
;    - 程序依赖 WebView2 运行时（Evergreen）
;    - 无服务、无注册表业务项
;
;  构建：ISCC.exe installer\WeldView_Setup.iss
;  产物：dist\WeldView_3D_Studio_Setup_V3.7.exe
; ============================================================================

#define AppName        "WeldView 3D Studio"
#define AppVersion     "3.7"
#define AppPublisher   "WeldView"
#define AppExeName     "WeldView_3D_Studio.exe"
#define RepoRoot       ".."
#define PublishDir     RepoRoot + "\dist\publish"

[Setup]
; AppId 一经发布不可更改，否则升级会变成并存安装
AppId={{9C4B7E62-3D18-4A5F-B0C1-7E2D8A61F4B3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} V{#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion=3.7.0.0
VersionInfoProductName={#AppName}

DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes

OutputDir={#RepoRoot}\dist
OutputBaseFilename=WeldView_3D_Studio_Setup_V{#AppVersion}
SetupIconFile={#RepoRoot}\desktop\app.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} V{#AppVersion}

Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

; 默认按当前用户安装（无需管理员），用户可在向导中切换为全局安装
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english";     MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; --- 主程序（dotnet publish 单文件输出）---
Source: "{#PublishDir}\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; --- 宿主页面与前端资源（保持相对路径结构，否则 assets 解析失败）---
Source: "{#RepoRoot}\WeldView_3D_Studio_V3.3.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RepoRoot}\assets\app\*";                 DestDir: "{app}\assets\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\assets\vendor\*";              DestDir: "{app}\assets\vendor"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#RepoRoot}\assets\icons\*";               DestDir: "{app}\assets\icons"; Flags: ignoreversion recursesubdirs createallsubdirs

; --- 样例与导出目录（首次安装时创建，卸载不删除用户导出）---
Source: "{#RepoRoot}\samples\*"; DestDir: "{app}\samples"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist

[Dirs]
Name: "{app}\exports";             Permissions: users-modify
Name: "{app}\webview_profile";     Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}";              Filename: "{app}\{#AppExeName}"
Name: "{group}\卸载 {#AppName}";          Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";        Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 仅清理运行时缓存，保留 exports 目录中的用户导出结果
Type: filesandordirs; Name: "{app}\webview_profile"

[Code]
// ---------------------------------------------------------------------------
// 安装前检查 WebView2 Evergreen Runtime，缺失则提示下载（不强制阻断）
// ---------------------------------------------------------------------------
function WebView2RuntimeInstalled(): Boolean;
var
  Version: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version);

  if Result and (Version <> '') and (Version <> '0.0.0.0') then
    Result := True
  else
    Result := False;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not WebView2RuntimeInstalled() then
  begin
    if MsgBox('未检测到 Microsoft Edge WebView2 运行时。' + #13#10 + #13#10 +
              'WeldView 3D Studio 依赖该运行时渲染三维视图，缺少时将无法启动。' + #13#10 +
              '可继续安装，但需自行安装运行时后再运行程序。' + #13#10 + #13#10 +
              '是否继续安装？', mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;
