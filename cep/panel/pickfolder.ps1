# Fig2AE: the normal Windows Explorer folder picker (IFileOpenDialog + FOS_PICKFOLDERS),
# not the old tree-only "Browse For Folder" box. Prints the chosen path as UTF-8 base64 ('' = cancelled).
param([string]$Start = '', [string]$Title = 'Where Fig2AE keeps exports and images')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class F2APick {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint c, IntPtr f);
        void SetFileTypeIndex(uint i);
        void GetFileTypeIndex(out uint i);
        void Advise(IntPtr p, out uint c);
        void Unadvise(uint c);
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(IShellItem si);
        void SetFolder(IShellItem si);
        void GetFolder(out IShellItem si);
        void GetCurrentSelection(out IShellItem si);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
        void GetResult(out IShellItem si);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem si);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attr);
        void Compare(IShellItem psi, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    public static string Pick(string title, string start) {
        IFileDialog d = (IFileDialog)new FileOpenDialogRCW();
        uint o; d.GetOptions(out o);
        d.SetOptions(o | 0x20 | 0x40 | 0x800);        // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST
        d.SetTitle(title);
        d.SetOkButtonLabel("Select folder");
        if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
            try { IShellItem f; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out f); d.SetFolder(f); } catch { }
        }
        if (d.Show(GetForegroundWindow()) != 0) return "";   // cancelled
        IShellItem r; d.GetResult(out r);
        string p; r.GetDisplayName(0x80058000, out p);      // SIGDN_FILESYSPATH
        return p;
    }
}
'@
$p = [F2APick]::Pick($Title, $Start)
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))
