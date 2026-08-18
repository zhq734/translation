# 安装完成后使用独立 ICO 文件重建现有快捷方式，避免 Windows 图标缓存读取 EXE 资源失败。
# @author zhenghq
!macro customInstall
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}

  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\app-icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
