// Fig2AE-Setup.exe — one-click Windows installer (C# 5 / .NET Framework 4.5; built by make-release.js
// with csc.exe on Windows or mcs on Linux; the payload is Fig2AE.zip, embedded as a resource).
// Installs, per user, no admin rights:
//   %LOCALAPPDATA%\Fig2AE\figma-plugin\            the Figma plugin (imported into Figma via manifest.json)
//   %APPDATA%\Adobe\CEP\extensions\fig2ae\         Fig2AE for After Effects: hidden server + panel (Window > Extensions > Fig2AE)
//   HKCU\Software\Adobe\CSXS.<9..16> PlayerDebugMode=1   unsigned CEP extensions (only where not set yet)
//   <AE prefs>\<version>\Scripts\ScriptUI Panels\Fig2AE.jsx   fallback import panel
//   %APPDATA%\Fig2AE\install.json                  where things are, for auto-update (cep/updater.js)
//   an "Apps & features" entry with Uninstall
// Switches: /quiet (no UI), /uninstall. FIG2AE_TEST_ROOT=<dir> redirects every folder and registry key into a sandbox.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

static class Setup
{
    public const string Version = "0.4.1";
    static string LocalApp, RoamingApp, RegRoot;

    public static string AppDir { get { return Path.Combine(LocalApp, "Fig2AE"); } }
    public static string PluginDir { get { return Path.Combine(AppDir, "figma-plugin"); } }
    public static string ManifestPath { get { return Path.Combine(PluginDir, "manifest.json"); } }
    static string CepDir { get { return Path.Combine(RoamingApp, "Adobe", "CEP", "extensions", "fig2ae"); } }
    static string AeBase { get { return Path.Combine(RoamingApp, "Adobe", "After Effects"); } }
    static string CfgDir { get { return Path.Combine(RoamingApp, "Fig2AE"); } }
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
                if (!quiet && MessageBox.Show("Удалить Fig2AE с этого компьютера?", "Fig2AE", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return 0;
                Uninstall();
                if (!quiet) MessageBox.Show("Fig2AE удалён.\nВ Figma уберите плагин: Plugins > Development > Manage plugins in development.", "Fig2AE");
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
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(Installed()));
        return 0;
    }

    public static bool Installed()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(UninstallKey)) return k != null;
    }

    public static bool AeRunning() { try { return Process.GetProcessesByName("AfterFX").Length > 0; } catch { return false; } }

    static void Wipe(string dir) { if (Directory.Exists(dir)) Directory.Delete(dir, true); }

    static List<string> AeVersions()
    {
        var list = new List<string>();
        if (!Directory.Exists(AeBase)) return list;
        foreach (var d in Directory.GetDirectories(AeBase))
        {
            double n;
            if (double.TryParse(Path.GetFileName(d), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out n)) list.Add(d);
        }
        return list;
    }

    static string Json(string s) { return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    /** returns a line per step, for the log */
    public static List<string> Install()
    {
        var log = new List<string>();
        byte[] panel = null;
        Wipe(PluginDir);
        Wipe(CepDir);
        using (var zip = new ZipArchive(Assembly.GetExecutingAssembly().GetManifestResourceStream("Fig2AE.zip")))
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
                dest = dest.Replace('/', Path.DirectorySeparatorChar);
                Directory.CreateDirectory(Path.GetDirectoryName(dest));
                using (var s = e.Open()) using (var f = File.Create(dest)) s.CopyTo(f);
            }
        }
        log.Add("Figma plugin: " + PluginDir);
        log.Add("After Effects extension: " + CepDir);

        for (int v = 9; v <= 16; v++)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RegRoot + @"Adobe\CSXS." + v))
                if ((k.GetValue("PlayerDebugMode") as string) != "1") k.SetValue("PlayerDebugMode", "1", RegistryValueKind.String);
        }

        foreach (var d in AeVersions())
        {
            string panels = Path.Combine(d, "Scripts", "ScriptUI Panels");
            Directory.CreateDirectory(panels);
            if (panel != null) File.WriteAllBytes(Path.Combine(panels, "Fig2AE.jsx"), panel);
            string old = Path.Combine(d, "Scripts", "Startup", "Fig2AE Startup.jsx");
            if (File.Exists(old)) File.Delete(old);
            log.Add("After Effects " + Path.GetFileName(d) + ": fallback panel");
        }

        // for auto-update; a fresh install also forgets a pending "restart AE" state
        Directory.CreateDirectory(CfgDir);
        File.WriteAllText(Path.Combine(CfgDir, "install.json"), "{\n  \"figmaPlugin\": " + Json(PluginDir) + ",\n  \"cep\": " + Json(CepDir) + "\n}\n");
        string upd = Path.Combine(CfgDir, "update.json");
        if (File.Exists(upd)) File.Delete(upd);

        string self = Assembly.GetExecutingAssembly().Location, copy = Path.Combine(AppDir, "Fig2AE-Setup.exe");
        if (!string.Equals(Path.GetFullPath(self), Path.GetFullPath(copy), StringComparison.OrdinalIgnoreCase)) File.Copy(self, copy, true);
        using (var k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", "Fig2AE (Figma to After Effects)");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", "Яйца Клауд");
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
            string p = Path.Combine(d, "Scripts", "ScriptUI Panels", "Fig2AE.jsx");
            if (File.Exists(p)) File.Delete(p);
        }
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        Wipe(PluginDir);
        Wipe(CfgDir);
        string self = Assembly.GetExecutingAssembly().Location;
        if (self.StartsWith(AppDir, StringComparison.OrdinalIgnoreCase))     // a running exe can't delete itself
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + AppDir + "\"") { CreateNoWindow = true, UseShellExecute = false });
        else Wipe(AppDir);
    }
}

/** dark, Notion-like window: one page to install, one page with the two last steps */
class SetupForm : Form
{
    static readonly Color Bg = Color.FromArgb(25, 25, 25), Card = Color.FromArgb(37, 37, 37), Text1 = Color.FromArgb(230, 230, 230),
                          Text2 = Color.FromArgb(150, 150, 150), Blue = Color.FromArgb(35, 131, 226), BlueHi = Color.FromArgb(0, 119, 212),
                          Warn = Color.FromArgb(214, 166, 92), Green = Color.FromArgb(77, 171, 154);
    readonly Panel page = new Panel { Dock = DockStyle.Fill };
    readonly float k;
    readonly bool installed;

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public SetupForm(bool installed)
    {
        this.installed = installed;
        using (var g = CreateGraphics()) k = g.DpiX / 96f;
        Text = "Fig2AE";
        ClientSize = new Size(S(520), S(400));
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Bg; ForeColor = Text1;
        Font = new Font("Segoe UI", 9.75f);
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        page.BackColor = Bg;
        Controls.Add(page);
        Welcome();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { int on = 1; if (DwmSetWindowAttribute(Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref on, 4); } catch { }   // dark title bar
    }

    int S(int v) { return (int)Math.Round(v * k); }

    Label Lbl(string s, int y, float size, bool bold, Color c)
    {
        var l = new Label { Text = s, Left = S(28), Top = y, Width = S(464), AutoSize = false, ForeColor = c, BackColor = Color.Transparent,
                            Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular), UseMnemonic = false };
        using (var g = CreateGraphics()) l.Height = (int)Math.Ceiling(g.MeasureString(s, l.Font, l.Width).Height) + S(2);
        page.Controls.Add(l);
        return l;
    }

    Button Btn(string s, int x, int y, int w, bool primary, EventHandler click)
    {
        var b = new Button { Text = s, Left = x, Top = y, Width = w, Height = S(36), FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand,
                             BackColor = primary ? Blue : Card, ForeColor = primary ? Color.White : Text1,
                             Font = new Font("Segoe UI", 9.75f, primary ? FontStyle.Bold : FontStyle.Regular) };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = primary ? BlueHi : Color.FromArgb(50, 50, 50);
        b.FlatAppearance.MouseDownBackColor = primary ? BlueHi : Color.FromArgb(60, 60, 60);
        b.Click += click;
        page.Controls.Add(b);
        return b;
    }

    void Header(string title, string sub)
    {
        var logo = new PictureBox { Left = S(28), Top = S(26), Width = S(40), Height = S(40), SizeMode = PictureBoxSizeMode.Zoom };
        try { logo.Image = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location).ToBitmap(); } catch { }
        page.Controls.Add(logo);
        var t = Lbl(title, S(24), 15f, true, Text1); t.Left = S(80); t.Width = S(410);
        var s = Lbl(sub, t.Bottom, 9.75f, false, Text2); s.Left = S(80); s.Width = S(410);
    }

    void Welcome()
    {
        page.Controls.Clear();
        Header("Fig2AE " + Setup.Version, "Figma → After Effects");
        var t = Lbl("Выделите фрейм в Figma, нажмите одну кнопку — он соберётся в After Effects: редактируемые фигуры, живой текст, градиенты, маски и тени.", S(92), 10f, false, Text1);
        var l = Lbl("Будет установлено только для вас, без прав администратора:\n" +
                    "•   панель Fig2AE в After Effects (Window → Extensions → Fig2AE)\n" +
                    "•   плагин для Figma\n" +
                    "•   автообновление — новые версии ставятся сами", t.Bottom + S(14), 9.75f, false, Text2);
        if (Setup.AeRunning()) Lbl("After Effects запущен — после установки перезапустите его.", l.Bottom + S(14), 9.75f, false, Warn);
        var go = Btn(installed ? "Обновить" : "Установить", S(28), S(336), S(150), true, delegate { DoInstall(); });
        AcceptButton = go;
        if (installed) Btn("Удалить", S(188), S(336), S(110), false, delegate {
            try { Process.Start(Path.Combine(Setup.AppDir, "Fig2AE-Setup.exe"), "/uninstall"); } catch (Exception e) { MessageBox.Show(e.Message, "Fig2AE"); }
            Close();
        });
        Btn("Отмена", S(372), S(336), S(120), false, delegate { Close(); });
    }

    void DoInstall()
    {
        Cursor = Cursors.WaitCursor;
        try { Setup.Install(); }
        catch (Exception e) { Cursor = Cursors.Default; MessageBox.Show("Не удалось установить:\n" + e.Message, "Fig2AE", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
        Cursor = Cursors.Default;
        page.Controls.Clear();
        Header(installed ? "Обновлено" : "Установлено", "Осталось два шага");
        var s1 = Lbl("1.  After Effects" + (Setup.AeRunning() ? " — перезапустите его" : "") + ". Один раз: Edit → Preferences → Scripting & Expressions → " +
                     "«Allow Scripts to Write Files and Access Network». Панель: Window → Extensions → Fig2AE.", S(92), 9.75f, false, Text1);
        var s2 = Lbl("2.  Figma (приложение): Plugins → Development → Import plugin from manifest… и выберите этот файл" +
                     (installed ? " (если плагин уже подключён отсюда — ничего делать не нужно)" : "") + ":", s1.Bottom + S(12), 9.75f, false, Text1);
        var path = new TextBox { Text = Setup.ManifestPath, ReadOnly = true, Left = S(28), Top = s2.Bottom + S(8), Width = S(464),
                                 BackColor = Card, ForeColor = Text1, BorderStyle = BorderStyle.FixedSingle };
        page.Controls.Add(path);
        Label ok = null;
        Btn("Скопировать путь", S(28), path.Bottom + S(10), S(160), false, delegate {
            try { Clipboard.SetText(Setup.ManifestPath); if (ok != null) ok.Text = "Путь скопирован"; } catch { }
        });
        Btn("Открыть папку", S(198), path.Bottom + S(10), S(140), false, delegate { Process.Start("explorer.exe", "/select,\"" + Setup.ManifestPath + "\""); });
        ok = Lbl("", path.Bottom + S(18), 9.75f, false, Green); ok.Left = S(350); ok.Width = S(142);
        AcceptButton = Btn("Готово", S(372), S(336), S(120), true, delegate { Close(); });
    }
}
