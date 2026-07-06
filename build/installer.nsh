!macro customInit
  InitPluginsDir
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  StrCpy $0 ""
  StrCpy $1 ""

  ReadRegStr $2 HKEY_LOCAL_MACHINE "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $3 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $2 != ""
  ${orIf} $3 != ""
    ${if} $2 == ""
      StrCpy $2 "registered install"
    ${endif}
    StrCpy $0 "true"
    StrCpy $1 "$1$\r$\n- All users: $2"
  ${endif}

  ReadRegStr $2 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $3 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $2 != ""
  ${orIf} $3 != ""
    ${if} $2 == ""
      StrCpy $2 "registered install"
    ${endif}
    StrCpy $0 "true"
    StrCpy $1 "$1$\r$\n- Current user: $2"
  ${endif}

  ${if} $0 == "true"
    MessageBox MB_ICONQUESTION|MB_YESNO "Existing SSH Studio installations were found:$1$\r$\n$\r$\nUninstall them before installing this version?" IDYES +2
    Quit

    Push HKEY_LOCAL_MACHINE
    Call uninstallOldVersion
    Push HKEY_LOCAL_MACHINE
    Call handleUninstallResult

    Push HKEY_CURRENT_USER
    Call uninstallOldVersion
    Push HKEY_CURRENT_USER
    Call handleUninstallResult
  ${endif}
!macroend
