; iRouter Windows 安装器 UI 钩子（由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引入）。
; 背景：页脚（NSIS BrandingText，外窗控件 id 1028 / 1256）在中文向导里的字体由
; SimpChinese.nlf 决定——宋体 9pt，`©` 在该字号下糊成一团（用户实测）。
; 且控件高只有 12px（按旧小字体设计的），放大字号后字形底部会被控件裁掉、
; 下方 2px 处的分隔线还会压住字脚（用户实测截图「文字下方像被挡住」）。
; 做法（.onGUIInit 里一次完成）：
;   1) 字体换成 10pt Segoe UI（拉丁 © 字形清晰，Win10+ 必有）；
;   2) 控件「底边不动、向上加高 8px@96dpi」（按 DPI 换算），让整行字完整落在
;      分隔线上方——不再被控件裁切、也不再被线压住（像素级实测：字底距线 1px）。
; 三个实测踩过的坑：
;   - .onGUIInit 由 MUI2 在 `MUI_LANGUAGE` 展开时定义（源码里搜不到），不能自己写
;     Function .onGUIInit，必须经 MUI_CUSTOMFUNCTION_GUIINIT / UNGUIINIT 接入；
;   - 卸载器侧的 Call 要求函数名带 `un.` 前缀，否则 makensis 直接编译失败；
;   - NSIS 代码里寄存器是 $3，`$r3` 只在 System::Call 字符串里有效——在代码里写
;     $r3 会被当成空值，算出来的矩形全零（原型阶段踩过一次）。

!include WinMessages.nsh

!define MUI_CUSTOMFUNCTION_GUIINIT iRouterFooterFont
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.iRouterUnFooterFont

Function iRouterFooterFont
  CreateFont $1 "Segoe UI" "10" "400"
  StrCpy $2 1028
  Call iRouterFooterAdjust
  StrCpy $2 1256
  Call iRouterFooterAdjust
FunctionEnd

Function un.iRouterUnFooterFont
  CreateFont $1 "Segoe UI" "10" "400"
  StrCpy $2 1028
  Call un.iRouterFooterAdjust
  StrCpy $2 1256
  Call un.iRouterFooterAdjust
FunctionEnd

; in: $1 font, $2 control id. Bottom edge stays, top edge extends upward so the
; taller 10pt line fits above the separator line instead of being clipped by it.
Function iRouterFooterAdjust
  StrCpy $R9 $HWNDPARENT
  GetDlgItem $0 $HWNDPARENT $2
  SendMessage $0 ${WM_SETFONT} $1 1
  System::Call '*(&i4, &i4, &i4, &i4) p .R0'
  System::Call 'user32::GetWindowRect(p r0, p R0)'
  System::Call '*$R0(i .r3, i .r4, i .r5, i .r6)'
  System::Free $R0
  System::Call '*(&i4, &i4) p .R0'
  System::Call 'user32::ClientToScreen(p R9, p R0)'
  System::Call '*$R0(i .r7, i .r8)'
  System::Free $R0
  IntOp $5 $5 - $3
  IntOp $6 $6 - $4
  IntOp $3 $3 - $7
  IntOp $4 $4 - $8
  System::Call 'user32::GetDpiForWindow(p R9) i .r1'
  IntOp $8 $1 * 8
  IntOp $8 $8 / 96
  IntOp $4 $4 - $8
  IntOp $6 $6 + $8
  System::Call 'user32::SetWindowPos(p r0, p 0, i r3, i r4, i r5, i r6, i 0x14)'
FunctionEnd

Function un.iRouterFooterAdjust
  StrCpy $R9 $HWNDPARENT
  GetDlgItem $0 $HWNDPARENT $2
  SendMessage $0 ${WM_SETFONT} $1 1
  System::Call '*(&i4, &i4, &i4, &i4) p .R0'
  System::Call 'user32::GetWindowRect(p r0, p R0)'
  System::Call '*$R0(i .r3, i .r4, i .r5, i .r6)'
  System::Free $R0
  System::Call '*(&i4, &i4) p .R0'
  System::Call 'user32::ClientToScreen(p R9, p R0)'
  System::Call '*$R0(i .r7, i .r8)'
  System::Free $R0
  IntOp $5 $5 - $3
  IntOp $6 $6 - $4
  IntOp $3 $3 - $7
  IntOp $4 $4 - $8
  System::Call 'user32::GetDpiForWindow(p R9) i .r1'
  IntOp $8 $1 * 8
  IntOp $8 $8 / 96
  IntOp $4 $4 - $8
  IntOp $6 $6 + $8
  System::Call 'user32::SetWindowPos(p r0, p 0, i r3, i r4, i r5, i r6, i 0x14)'
FunctionEnd