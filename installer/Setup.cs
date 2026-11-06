// Fig2AE-Setup.exe — one-click Windows installer (C# 5 / .NET Framework 4.5, built by make-installer.js).
// Installs, per user, no admin rights:
//   %LOCALAPPDATA%\Fig2AE\figma-plugin\            the Figma plugin (imported into Figma via manifest.json)
//   %APPDATA%\Adobe\CEP\extensions\fig2ae\         Fig2AE Server: starts with After Effects, takes exports from Figma
//   HKCU\Software\Adobe\CSXS.<9..16> PlayerDebugMode=1   unsigned CEP extensions (only where not set yet)
//   <AE prefs>\<version>\Scripts\ScriptUI Panels\Fig2AE.jsx   manual import panel; removes the old polling watcher
//   an "Apps & features" entry with Uninstall
// FIG2AE_TEST_ROOT=<dir> redirects every folder and registry key into a sandbox (tests).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    public const string Version = "0.4.0";
    static string LocalApp, RoamingApp, RegRoot;

    public static string AppDir { get { return Path.Combine(LocalApp, "Fig2AE"); } }
    public static string ManifestPath { get { return Path.Combine(AppDir, @"figma-plugin\manifest.json"); } }
    static string CepDir { get { return Path.Combine(RoamingApp, @"Adobe\CEP\extensions\fig2ae"); } }
    static string AeBase { get { return Path.Combine(RoamingApp, @"Adobe\After Effects"); } }
    static string UninstallKey { get { return RegRoot + @"Microsoft\Windows\CurrentVersion\Uninstall\Fig2AE"; } }

    [STAThread]
    static int Main(string[] args)
    {
        string test = Environment.GetEnvironmentVariable("FIG2AE_TEST_ROOT");
        LocalApp = test != null ? Path.Combine(test, "Local") : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        RoamingApp = test != null ? Path.Combine(test, "Roaming") : Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        RegRoot = test != null ? @"Software\Fig2AE-test\" : @"Software\";
        bool quiet = Array.IndexOf(args, "/quiet") >= 0;
        try
        {
            if (Array.IndexOf(args, "/uninstall") >= 0)
            {
                if (!quiet && MessageBox.Show("Remove Fig2AE from this computer?", "Fig2AE", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 0;
                Uninstall();
                if (!quiet) MessageBox.Show("Fig2AE has been removed.\nIn Figma, remove the plugin under Plugins > Development > Manage plugins in development.", "Fig2AE");
                return 0;
            }
            if (quiet) { Console.WriteLine(string.Join(Environment.NewLine, Install().ToArray())); return 0; }
        }
        catch (Exception e)
        {
            if (quiet) { Console.Error.WriteLine(e); return 1; }
            MessageBox.Show(e.Message, "Fig2AE", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Application.EnableVisualStyles();
        Application.Run(new SetupForm(Installed()));
        return 0;
    }

    public static bool Installed()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey)) return k != null;
    }

    public static bool AeRunning() { return Process.GetProcessesByName("AfterFX").Length > 0; }

    static void Wipe(string dir) { if (Directory.Exists(dir)) Directory.Delete(dir, true); }

    static List<string> AeVersions()
    {
        var list = new List<string>();
        if (!Directory.Exists(AeBase)) return list;
        foreach (var d in Directory.GetDirectories(AeBase))
        {
            string v = Path.GetFileName(d);
            double n;
            if (double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out n)) list.Add(d);
        }
        return list;
    }

    /** returns a line per step, for the log */
    public static List<string> Install()
    {
        var log = new List<string>();
        byte[] panel = null;
        Wipe(Path.Combine(AppDir, "figma-plugin"));
        Wipe(CepDir);
        using (var zip = new ZipArchive(Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip")))
        {
            foreach (var e in zip.Entries)
            {
                string name = e.FullName.Replace('\\', '/');
                if (name.EndsWith("/")) continue;
                string dest = null;
                if (name.StartsWith("figma-plugin/")) dest = Path.Combine(AppDir, name);
                else if (name.StartsWith("cep/")) dest = Path.Combine(CepDir, name.Substring(4));
                else if (name == "ae/Fig2AE Panel.jsx")
                {
                    using (var s = e.Open()) using (var m = new MemoryStream()) { s.CopyTo(m); panel = m.ToArray(); }
                    continue;
                }
                if (dest == null) continue;
                dest = dest.Replace('/', '\\');
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                using (var s = e.Open()) using (var f = File.Create(dest)) s.CopyTo(f);
            }
        }
        log.Add("Figma plugin: " + Path.Combine(AppDir, "figma-plugin"));
        log.Add("Fig2AE Server for After Effects: " + CepDir);

        for (int v = 9; v <= 16; v++)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RegRoot + @"Adobe\CSXS." + v))
                if ((k.GetValue("PlayerDebugMode") as string) != "1") k.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
        }

        var versions = AeVersions();
        foreach (var d in versions)
        {
            string panels = Path.Combine(d, @"Scripts\ScriptUI Panels");
            Directory.CreateDirectory(panels);
            if (panel != null) File.WriteAllBytes(Path.Combine(panels, "Fig2AE.jsx"), panel);
            string old = Path.Combine(d, @"Scripts\Startup\Fig2AE Startup.jsx");
            if (File.Exists(old)) File.Delete(old);
            log.Add("After Effects " + Path.GetFileName(d) + ": import panel (Window > Fig2AE.jsx)");
        }
        if (versions.Count == 0) log.Add("After Effects settings not found — start After Effects once and run Setup again for the import panel.");

        string self = Assembly.GetExecutingAssembly().Location, copy = Path.Combine(AppDir, "Fig2AE-Setup.exe");
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase)) File.Copy(self, copy, true);
        using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", "Fig2AE (Figma to After Effects)");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "Fig2AE");
            k.SetValue("InstallLocation", AppDir);
            k.SetValue("DisplayIcon", copy);
            k.SetValue("UninstallString", "\"" + copy + "\" /uninstall");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
        return log;
    }

    /** PlayerDebugMode stays: other unsigned extensions (AEUX…) may need it */
    static void Uninstall()
    {
        Wipe(CepDir);
        foreach (var d in AeVersions())
        {
            string p = Path.Combine(d, @"Scripts\ScriptUI Panels\Fig2AE.jsx");
            if (File.Exists(p)) File.Delete(p);
        }
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        Wipe(Path.Combine(AppDir, "figma-plugin"));
        string self = Assembly.GetExecutingAssembly().Location;
        if (self.StartsWith(AppDir, StringComparison.OrdinalIgnoreCase))     // a running exe can't delete itself
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + AppDir + "\"") { CreateNoWindow = true, UseShellExecute = false });
        else Wipe(AppDir);
    }
}

class SetupForm : Form
{
    readonly Panel page = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20) };

    public SetupForm(bool installed)
    {
        Text = "Fig2AE Setup";
        ClientSize = new Size(560, 400);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9.5f);
        BackColor = Color.White;
        Controls.Add(page);
        Welcome(installed);
    }

    Label Text_(string s, int y, float size, bool bold)
    {
        var l = new Label { Text = s, Left = 20, Top = y, Width = 520, AutoSize = false, Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular) };
        using (var g = CreateGraphics()) l.Height = (int)Math.Ceiling(g.MeasureString(s, l.Font, l.Width).Height) + 4;
        page.Controls.Add(l);
        return l;
    }

    Button Btn(string s, int x, int y, int w, EventHandler click)
    {
        var b = new Button { Text = s, Left = x, Top = y, Width = w, Height = 32 };
        b.Click += click;
        page.Controls.Add(b);
        return b;
    }

    void Welcome(bool installed)
    {
        page.Controls.Clear();
        Text_("Fig2AE — Figma to After Effects", 20, 15, true);
        var t = Text_("Select a frame in Figma, press one button — it is rebuilt in After Effects: editable shapes, live text, " +
                      "gradients, masks, shadows. Like AEUX, without its bugs.\n\nSetup installs, for your Windows user only:\n" +
                      "  •  Fig2AE Server for After Effects (takes exports from Figma)\n" +
                      "  •  the Figma plugin\n" +
                      "  •  the import panel in After Effects (Window > Fig2AE.jsx)", 60, 9.5f, false);
        int y = t.Bottom + 12;
        if (Setup.AeRunning()) { var w = Text_("After Effects is running — restart it after the installation.", y, 9.5f, true); w.ForeColor = Color.DarkOrange; y = w.Bottom + 8; }
        var go = Btn(installed ? "Update" : "Install", 20, 340, 140, delegate { DoInstall(); });
        go.BackColor = Color.FromArgb(24, 160, 251); go.ForeColor = Color.White; go.FlatStyle = FlatStyle.Flat;
        AcceptButton = go;
        if (installed)
            Btn("Uninstall", 170, 340, 110, delegate {
                Process.Start(Path.Combine(Setup.AppDir, "Fig2AE-Setup.exe"), "/uninstall");
                Close();
            });
        Btn("Cancel", 420, 340, 120, delegate { Close(); });
    }

    void DoInstall()
    {
        try { Setup.Install(); }
        catch (Exception e) { MessageBox.Show("Installation failed:\n" + e.Message, "Fig2AE", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        page.Controls.Clear();
        Text_("Installed. Two last steps:", 20, 15, true);
        var s1 = Text_("1.  After Effects: " + (Setup.AeRunning() ? "restart it. " : "") +
                       "Edit > Preferences > Scripting & Expressions > turn on \"Allow Scripts to Write Files and Access Network\" (once).", 64, 9.5f, false);
        var s2 = Text_("2.  Figma desktop app: Plugins > Development > Import plugin from manifest… and choose this file:", s1.Bottom + 10, 9.5f, false);
        var path = new TextBox { Text = Setup.ManifestPath, ReadOnly = true, Left = 40, Top = s2.Bottom + 4, Width = 500 };
        page.Controls.Add(path);
        Btn("Copy path", 40, path.Bottom + 8, 120, delegate { Clipboard.SetText(Setup.ManifestPath); });
        Btn("Open folder", 170, path.Bottom + 8, 120, delegate { Process.Start("explorer.exe", "/select,\"" + Setup.ManifestPath + "\""); });
        Text_("Then: select a frame > Plugins > Development > Fig2AE > Send selection to After Effects.", path.Bottom + 52, 9.5f, false);
        AcceptButton = Btn("Done", 420, 340, 120, delegate { Close(); });
    }
}
