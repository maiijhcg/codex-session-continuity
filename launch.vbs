Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.Run "pwsh.exe -NoProfile -File """ & root & "\supervise.ps1""", 0, False
