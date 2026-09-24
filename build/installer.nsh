; 卫星仿真平台 NSIS 自定义钩子。electron-builder 按「buildResources 目录下的 installer.nsh」自动引入（nsis.include 默认值），
; 安装器与卸载器两份构建都会带上它（后者定义了 BUILD_UNINSTALLER）。
;
; ── 为什么要有它 ─────────────────────────────────────────────────────────────────────────────────
; electron-builder 24 的覆盖安装是「先删旧、再装新」：新安装器先调旧版卸载器，旧卸载器 un.atomicRMDir 按 FindFirst
; （NTFS 名字序）把安装目录里的文件逐个 Rename 进 %TEMP%，全部搬完才轮到解压新版、复制进来。中文名的主程序排在
; 最后，它唯一随包的静态依赖 ffmpeg.dll 排第 4，中间夹着 resources 的四千多个文件——这期间被关机 / 强杀，目录就
; 停在「exe 在、ffmpeg.dll 不在」，双击即「由于找不到 ffmpeg.dll，无法继续执行代码」；JS 一行没跑，
; electron/services/updater.js 的启动时补装也兜不住。2026-09 同事机器 v1.4.11 自动更新时真实发生过。
; electron-builder 最新 26.x 仍是同一流程，升级打包工具解决不了。
;
; ── 改成什么 ─────────────────────────────────────────────────────────────────────────────────────
; 覆盖安装到已装位置（仅为我安装；自动更新与手动覆盖安装都算）时，新版先装进同级暂存目录，完整了再整目录换上：
;   customCheckAppRunning  照常关掉运行中的程序；摘掉 UninstallString 让模板调旧卸载器那一步直接跳过；
;                          把本次安装目标 $INSTDIR 改到「<安装目录>.__new」
;   customUnInstallCheck   调旧卸载器那一步刚返回：立即把 UninstallString 写回（注册表只空了这一瞬）
;   customFiles_*          新版已完整落进暂存目录：校验 → 正式目录改名 .__old → 暂存目录改名成正式目录 →
;                          $INSTDIR 还原，模板随后写卸载器 / 注册表 / 快捷方式都落在正式目录
;   customInstall          删掉 .__old
; 两次改名在同一卷上、各自原子。任何时刻被打断，正式目录要么是完整旧版、要么是完整新版；残留的 .__new / .__old
; 下次安装开头清掉。校验或改名失败 → 旧版原封不动、删暂存、退出码 2；已下载的更新包还在，启动时补装 /
; 正常退出时安装会再试。
;
; ── 不接管、走 electron-builder 默认流程的情形 ──────────────────────────────────────────────────────
;   · 为所有用户安装：静默更新在 UAC 提权后的内层实例里跑，模板在那里不调 CHECK_APP_RUNNING，这个钩子进不来
;   · 首次安装、装到别的目录、目标目录为空：没有要保护的旧版
;   · 建不了暂存目录、清不掉上次残留：退回默认流程（即改动前的行为）
;
; ── 维护须知 ─────────────────────────────────────────────────────────────────────────────────────
;   · 本文件在共享头部、早于模板的 Var 声明被引入：用到 $installMode / $appExe 的函数只能写进 customHeader
;     （模板在这些声明之后才展开它）；只属安装器的变量 / 函数必须包 !ifndef BUILD_UNINSTALLER，
;     否则另一份构建里「未引用」的警告在 -WX 下直接报错
;   · 定义了 customCheckAppRunning，模板就不再引 getProcessInfo.nsh、不声明 $pid（allowOnlyOneInstallerInstance.nsh），
;     customHeader 里补上
;   · customFiles_* 被这里占用：electron-builder 遇到 preCompressedFileExtensions（默认 .mp4 / .webm 等）会自动生成
;     同名宏、makensis 报重复定义，所以 package.json 的 nsis.preCompressedFileExtensions 置成了 []（这些文件照常进 7z）
;   · 日志追加到 <userData>/updater.log，前缀 [installer]。只写 ASCII：FileWrite 按 ANSI 落盘，中文会乱码
;   · 验证台 .updharness（不进仓库，跑法见 .gitignore 里那段说明）

; 追加一行日志。用法：${ssLog} "text"（可带运行时变量）
!macro ssLogCall _MSG
  Push `${_MSG}`
  Call ssLog
!macroend
!define ssLog "!insertmacro ssLogCall"

!macro customHeader
  !include "getProcessInfo.nsh"
  Var pid

  !ifndef BUILD_UNINSTALLER
    Var ssRealDir       ; 非空 = 本次走暂存换目录，值为正式安装目录
    Var ssStageDir
    Var ssOldDir
    Var ssSavedUninst
    !ifdef UNINSTALL_REGISTRY_KEY_2
      Var ssSavedUninst2
    !endif

    ; <userData> 不存在（程序从没运行过）就不写：不替 Electron 建目录
    Function ssLog
      Exch $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      Push $6
      Push $7
      Push $8
      ${If} ${FileExists} "$APPDATA\${APP_FILENAME}\*.*"
        System::Call '*(&i2,&i2,&i2,&i2,&i2,&i2,&i2,&i2) p .r1'
        System::Call 'kernel32::GetSystemTime(p)i(r1)'
        System::Call '*$1(&i2,&i2,&i2,&i2,&i2,&i2,&i2,&i2)p(.r2,.r3,,.r4,.r5,.r6,.r7,.r8)'
        System::Free $1
        IntFmt $3 "%02u" $3
        IntFmt $4 "%02u" $4
        IntFmt $5 "%02u" $5
        IntFmt $6 "%02u" $6
        IntFmt $7 "%02u" $7
        IntFmt $8 "%03u" $8
        ClearErrors
        FileOpen $1 "$APPDATA\${APP_FILENAME}\updater.log" a
        ${IfNot} ${Errors}
          FileSeek $1 0 END
          FileWrite $1 "$2-$3-$4T$5:$6:$7.$8Z [info] [installer] $0$\r$\n"
          FileClose $1
        ${EndIf}
      ${EndIf}
      Pop $8
      Pop $7
      Pop $6
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    ; customCheckAppRunning 里、模板调旧卸载器之前
    Function ssPrepareStaging
      Push $0
      Push $1
      StrCpy $ssRealDir ""
      ${If} $installMode != "CurrentUser"
        Goto ssPrepDone
      ${EndIf}
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
      ${OrIf} $0 != $INSTDIR
        Goto ssPrepDone
      ${EndIf}
      ; 盘符根目录没有同级目录可言
      StrLen $1 $INSTDIR
      ${If} $1 < 4
        Goto ssPrepDone
      ${EndIf}
      StrCpy $ssStageDir "$INSTDIR.__new"
      StrCpy $ssOldDir "$INSTDIR.__old"
      ; DirState：-1 不存在 / 0 空 / 1 有内容。空壳很常见：模板 .onInit 的 SetOutPath 会按 /D 先建出目标目录，
      ; 模板卸载器也删不掉作为自己当前目录的那一层
      ${DirState} "$INSTDIR" $1
      ; 上次恰好死在两次改名之间：正式目录没了（或只剩空壳）、旧版在 .__old → 先放回原位
      ${If} $1 != 1
        ${DirState} "$ssOldDir" $0
        ${If} $0 == 1
          ; 空壳可能正是本进程的当前目录，挪开才删得掉
          SetOutPath "$PLUGINSDIR"
          RMDir "$INSTDIR"
          ClearErrors
          Rename "$ssOldDir" "$INSTDIR"
          ${ssLog} "restored the previous version left behind by an interrupted swap"
          ${DirState} "$INSTDIR" $1
        ${EndIf}
      ${EndIf}
      ; 没有要保护的旧版（首装、卸载后留下的空壳）：走默认流程
      ${If} $1 != 1
        Goto ssPrepDone
      ${EndIf}
      RMDir /r "$ssStageDir"
      RMDir /r "$ssOldDir"
      ${If} ${FileExists} "$ssStageDir\*.*"
      ${OrIf} ${FileExists} "$ssOldDir\*.*"
        ${ssLog} "leftover staging dirs could not be removed, using the default update flow"
        Goto ssPrepDone
      ${EndIf}
      ClearErrors
      CreateDirectory "$ssStageDir"
      ${If} ${Errors}
      ${OrIfNot} ${FileExists} "$ssStageDir\*.*"
        ${ssLog} "cannot create the staging dir, using the default update flow"
        Goto ssPrepDone
      ${EndIf}
      ; 模板的 uninstallOldVersion 读不到 UninstallString 就直接返回；customUnInstallCheck 里写回
      ReadRegStr $ssSavedUninst SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
      !ifdef UNINSTALL_REGISTRY_KEY_2
        ReadRegStr $ssSavedUninst2 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
        DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      !endif
      StrCpy $ssRealDir $INSTDIR
      StrCpy $INSTDIR $ssStageDir
      ${ssLog} "installing ${VERSION} into a staging dir next to the current install"
    ssPrepDone:
      Pop $1
      Pop $0
    FunctionEnd

    ; customFiles_*：模板刚把新版解压并复制进 $INSTDIR（= 暂存目录）
    Function ssSwapInStaged
      Push $0
      Push $1
      Push $2
      Push $3
      Push $4
      Push $5
      ; 模板复制失败 5 次后会先删 7z-out、再直接解压到目标并忽略错误——那样的暂存目录不可信
      ${IfNot} ${FileExists} "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}"
        StrCpy $5 "extraction fell back to direct unpack"
        Goto ssSwapAbort
      ${EndIf}
      ${GetSize} "$PLUGINSDIR\7z-out" "" $0 $1 $2
      ${GetSize} "$ssStageDir" "" $0 $3 $4
      ${If} $3 < $1
      ${OrIf} $4 < $2
      ${OrIfNot} ${FileExists} "$ssStageDir\${APP_EXECUTABLE_FILENAME}"
        StrCpy $5 "staged tree incomplete: $3/$1 files, $4/$2 dirs"
        Goto ssSwapAbort
      ${EndIf}
      ; 卸载器先放进暂存目录（模板稍后在正式目录再写一遍，同一份数据）：换上之后、模板写它之前若被打断，也不缺它
      SetOutPath "$ssStageDir"
      File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ; 进程当前目录不能留在要改名的目录里
      SetOutPath "$PLUGINSDIR"
      ; 旧版挪开。占用多半一闪而过（杀软扫描、安装期间被双击起来又自行退出的实例），最多等 10 s；
      ; 用户在安装期间开着旧版干活就放弃本次，不替他杀进程
      StrCpy $0 0
      ${Do}
        ClearErrors
        Rename "$ssRealDir" "$ssOldDir"
        ${IfNot} ${Errors}
          ${Break}
        ${EndIf}
        IntOp $0 $0 + 1
        ${If} $0 >= 40
          StrCpy $5 "the current install is in use"
          Goto ssSwapAbort
        ${EndIf}
        Sleep 250
      ${Loop}
      ; 新版就位
      StrCpy $0 0
      ${Do}
        ClearErrors
        Rename "$ssStageDir" "$ssRealDir"
        ${IfNot} ${Errors}
          ${Break}
        ${EndIf}
        IntOp $0 $0 + 1
        ${If} $0 >= 40
          StrCpy $5 "the staging dir could not be moved into place"
          Goto ssSwapAbort
        ${EndIf}
        Sleep 250
      ${Loop}
      StrCpy $INSTDIR $ssRealDir
      SetOutPath $INSTDIR
      ${ssLog} "swapped in ${VERSION} ($3 files)"
      Goto ssSwapDone

    ssSwapAbort:
      SetOutPath "$PLUGINSDIR"
      ; 新版就位那步失败时旧版在 .__old：先挪回原位
      ${IfNot} ${FileExists} "$ssRealDir\*.*"
        StrCpy $0 0
        ${Do}
          ClearErrors
          Rename "$ssOldDir" "$ssRealDir"
          ${IfNot} ${Errors}
            ${Break}
          ${EndIf}
          IntOp $0 $0 + 1
          ${If} $0 >= 40
            ${Break}
          ${EndIf}
          Sleep 250
        ${Loop}
      ${EndIf}
      ${If} ${FileExists} "$ssRealDir\*.*"
        RMDir /r "$ssStageDir"
        StrCpy $INSTDIR $ssRealDir
        ${ssLog} "update to ${VERSION} aborted, previous version kept: $5"
        ${If} ${isForceRun}
          ; 启动时补装 / 立即重启安装拉起的：用户在等程序出来。带 --updated，启动决策据此清掉补装标记、照常开窗
          ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "--updated"
        ${EndIf}
        SetErrorLevel 2
        Quit
      ${EndIf}
      ; 两个目录都挪不动（极端情形）：新版已校验完整，整份复制进正式目录，按安装成功收尾
      CreateDirectory "$ssRealDir"
      CopyFiles /SILENT "$ssStageDir\*.*" "$ssRealDir"
      RMDir /r "$ssStageDir"
      StrCpy $INSTDIR $ssRealDir
      SetOutPath $INSTDIR
      ${ssLog} "could not restore the previous version, copied ${VERSION} in place instead ($5)"

    ssSwapDone:
      Pop $5
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd
  !endif
!macroend

!macro customCheckAppRunning
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    Call ssPrepareStaging
  !endif
!macroend

; 替换模板 handleUninstallResult 对 SHELL_CONTEXT 的结果处理；非暂存分支与模板原逻辑一致
!macro customUnInstallCheck
  ${If} $ssRealDir != ""
    ${If} $ssSavedUninst != ""
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString "$ssSavedUninst"
    ${EndIf}
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $ssSavedUninst2 != ""
        WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString "$ssSavedUninst2"
      ${EndIf}
    !endif
  ${ElseIf} ${Errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${ElseIf} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro ssAfterExtract
  ${If} $ssRealDir != ""
    Call ssSwapInStaged
  ${EndIf}
!macroend
!macro customFiles_x64
  !insertmacro ssAfterExtract
!macroend
!macro customFiles_ia32
  !insertmacro ssAfterExtract
!macroend
!macro customFiles_arm64
  !insertmacro ssAfterExtract
!macroend

!macro customInstall
  ${If} $ssRealDir != ""
    RMDir /r "$ssOldDir"
    ${If} ${FileExists} "$ssOldDir\*.*"
      ${ssLog} "update to ${VERSION} done, the previous version dir is left for the next update to remove"
    ${Else}
      ${ssLog} "update to ${VERSION} done"
    ${EndIf}
  ${EndIf}
!macroend

; 真卸载时顺手清掉被打断的更新留下的同级目录（更新流程调旧卸载器时不动它们）
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    StrLen $0 "$INSTDIR"
    ${If} $0 > 3
      RMDir /r "$INSTDIR.__new"
      RMDir /r "$INSTDIR.__old"
    ${EndIf}
    Pop $0
  ${EndIf}
!macroend
