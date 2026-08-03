' Launches scripts\start-service.bat with no console window.
Dim fso, shell, scriptDir, appRoot
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
appRoot = fso.GetParentFolderName(scriptDir)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = appRoot
shell.Run "cmd.exe /c """ & appRoot & "\scripts\start-service.bat""", 0, False
