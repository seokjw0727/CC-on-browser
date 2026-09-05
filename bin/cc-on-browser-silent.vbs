' cc-on-browser-silent.vbs - console-free launcher for Windows.
'
' Why: running npm's generated cc-on-browser.cmd from Win+R or Explorer creates a
' cmd.exe console the moment it starts, and that window stays until the parent
' process exits (1-3 s). Node cannot hide a console that already exists.
' wscript.exe is a GUI-subsystem program, so it has no console at all; starting
' node from here with a hidden window means the user only ever sees the browser.
'
' How it is invoked (this is exactly what `cc-on-browser --shortcut` writes into
' the .lnk it creates):
'   wscript.exe //nologo "<...>\bin\cc-on-browser-silent.vbs" "<...>\node.exe" [options...]
'
' The first argument is the absolute path to node.exe - we never rely on PATH
' lookup (the shortcut embeds process.execPath from the moment it was created).
' Any further arguments are forwarded to cc-on-browser (e.g. --port 9000).
'
' NOTE ON ENCODING: WSH reads .vbs source using the system ANSI code page unless
' the file is UTF-16LE with a BOM, so every string in this file is kept ASCII-only.
' Non-ASCII text here would show up as mojibake in the message boxes below.
'
' NOTE ON ERROR REPORTING: MsgBox is the only channel a console-less launcher has.
' We wait for the short-lived parent Node process (it spawns the background daemon
' and exits) so a nonzero exit is actually reported instead of vanishing.

Option Explicit

Dim args, shell, fso, nodeExe, scriptPath, cmd, i, rc

Set args = WScript.Arguments
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If args.Count < 1 Then
  MsgBox "cc-on-browser: missing the node.exe path argument." & vbCrLf & vbCrLf & _
         "Recreate the shortcut:  cc-on-browser --shortcut", _
         16, "CC on Browser"
  WScript.Quit 1
End If

nodeExe = args(0)
' This .vbs lives in the package's bin/, next to the entry point.
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "cc-on-browser.mjs")

If Not fso.FileExists(nodeExe) Then
  MsgBox "cc-on-browser: node.exe not found at" & vbCrLf & nodeExe & vbCrLf & vbCrLf & _
         "If you reinstalled Node.js, recreate the shortcut:  cc-on-browser --shortcut", _
         16, "CC on Browser"
  WScript.Quit 1
End If

If Not fso.FileExists(scriptPath) Then
  MsgBox "cc-on-browser: entry point not found at" & vbCrLf & scriptPath & vbCrLf & vbCrLf & _
         "Reinstall the package.", 16, "CC on Browser"
  WScript.Quit 1
End If

' Paths contain spaces, so quote every token. The tokens themselves never contain
' quotes: paths come from the file system and options are short flags like --port.
cmd = """" & nodeExe & """ """ & scriptPath & """"
For i = 1 To args.Count - 1
  cmd = cmd & " """ & args(i) & """"
Next

' 0 = hidden window. True = wait for it: the parent only spawns the daemon, prints
' its URL and exits, so waiting costs a few seconds at most and lets us report a
' failure that would otherwise be invisible (bad option, missing client bundle,
' port taken by a foreign server, ...).
rc = shell.Run(cmd, 0, True)

If rc <> 0 Then
  MsgBox "cc-on-browser could not start (exit code " & rc & ")." & vbCrLf & vbCrLf & _
         "Run this in a terminal to see why:" & vbCrLf & _
         "    cc-on-browser --no-open", _
         16, "CC on Browser"
  WScript.Quit rc
End If
