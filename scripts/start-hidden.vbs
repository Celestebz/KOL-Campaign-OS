' Launches scripts\start-service.bat with no console window.
Dim fso, shell, scriptDir, projectRoot
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = projectRoot
shell.Run "cmd.exe /c """ & projectRoot & "\scripts\start-service.bat""", 0, False
