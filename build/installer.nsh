; ---------------------------------------------------------------------------
; Smart Workspace - installer self-update check
;
; Before the install UI starts, query GitHub for the latest release tag.
; If the bundled installer is older than the latest published release,
; download the newest setup.exe and chain-launch it instead. Any failure
; (no internet, GitHub unreachable, parse error, timeout) silently falls
; through to the bundled installer so users are never blocked.
;
; Pass /SKIPUPDATECHECK on the command line to bypass the check.
; ---------------------------------------------------------------------------

!include "WordFunc.nsh"
!include "FileFunc.nsh"

!macro customInit
  ; Honor /SKIPUPDATECHECK switch.
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "/SKIPUPDATECHECK" $R8
  ${IfNot} ${Errors}
    Goto smartws_skip_update_check
  ${EndIf}

  ; Show a small banner while we hit the network.
  Banner::show /NOUNLOAD "Checking for the latest version..."

  ; Fetch latest release JSON from GitHub. inetc is bundled with electron-builder NSIS.
  inetc::get /SILENT /TIMEOUT 8000 /USERAGENT "SmartWorkspace-Installer" \
    "https://api.github.com/repos/KLS-Digital-Solutions/Smart-Workshop/releases/latest" \
    "$PLUGINSDIR\latest.json" /END
  Pop $R0
  ${If} $R0 != "OK"
    Banner::destroy
    Goto smartws_skip_update_check
  ${EndIf}

  ; Parse tag_name from the JSON. We look for the literal: "tag_name":"v
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\latest.json" r
  ${If} ${Errors}
    Banner::destroy
    Goto smartws_skip_update_check
  ${EndIf}
  FileRead $R1 $R2 8192
  FileClose $R1

  ; Find tag_name marker. $R3 = position.
  ${WordFind} "$R2" '"tag_name":"' "E+1{" $R3
  IfErrors smartws_parse_fail 0
  ; $R3 now is everything after the marker. Trim at next quote.
  ${WordFind} "$R3" '"' "E+1{" $R4
  IfErrors smartws_parse_fail 0
  ; $R4 is the tag, e.g. v1.0.25. Strip leading 'v' if present.
  StrCpy $R5 $R4 1
  ${If} $R5 == "v"
  ${OrIf} $R5 == "V"
    StrCpy $R4 $R4 "" 1
  ${EndIf}

  ; Compare $R4 (remote) against ${VERSION} (this installer).
  ${VersionCompare} "$R4" "${VERSION}" $R6
  ; $R6: 0 equal, 1 first newer, 2 first older.
  ${If} $R6 != "1"
    Banner::destroy
    Goto smartws_skip_update_check
  ${EndIf}

  ; Newer version available. Download it.
  Banner::destroy
  Banner::show /NOUNLOAD "Downloading latest version $R4..."
  inetc::get /SILENT /TIMEOUT 60000 /USERAGENT "SmartWorkspace-Installer" \
    "https://github.com/KLS-Digital-Solutions/Smart-Workshop/releases/latest/download/Smart%20Workspace%20Setup.exe" \
    "$PLUGINSDIR\SmartWorkspaceSetup.exe" /END
  Pop $R0
  Banner::destroy
  ${If} $R0 != "OK"
    Goto smartws_skip_update_check
  ${EndIf}

  ; Chain-launch the freshly downloaded installer and exit this one.
  ; Pass /SKIPUPDATECHECK so the new one doesn't loop back to the network.
  ExecWait '"$PLUGINSDIR\SmartWorkspaceSetup.exe" /SKIPUPDATECHECK' $R0
  Quit

smartws_parse_fail:
  Banner::destroy

smartws_skip_update_check:
!macroend
