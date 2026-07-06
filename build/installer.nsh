!macro customInit
  InitPluginsDir
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  Push SHELL_CONTEXT
  Call uninstallOldVersion
  Push SHELL_CONTEXT
  Call handleUninstallResult

  ${if} $installMode == "all"
    Push HKEY_CURRENT_USER
    Call uninstallOldVersion
    Push HKEY_CURRENT_USER
    Call handleUninstallResult
  ${endif}
!macroend
