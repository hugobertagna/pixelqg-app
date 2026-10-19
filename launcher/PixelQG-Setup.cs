// PixelQG installer and uninstaller (Windows, per user: no administrator rights needed).
// Built by tools/make-release.js with the C# 5 compiler of .NET Framework 4 (csc.exe), so no newer
// syntax. Compiled together with a generated SetupInfo.cs (version), twice:
//   - the uninstaller: this program without resources (written as Desinstaller.exe when installing);
//   - the setup (PixelQG-Setup-<version>.exe): the same program carrying the release zip
//     (resource PixelQG.payload.zip) and the uninstaller (resource PixelQG.uninstaller.exe).
//
// Modes:
//   (no argument)                 setup: install window · uninstaller: same as /uninstall
//   /uninstall                    asks, then removes the install folder, the shortcuts and the
//                                 uninstall key; ~/.pixelqg (settings, skills library) is kept
//   /extract-to <dir>             release check, no window: extracts the files only (no shortcut,
//                                 no registry), prints "OK <n>" on stdout
//   /preview <png> [fin]          release check, no window: draws the install window into a PNG
//                                 ("fin": as it looks once installed)
//   /uninstall-run <dir> <pid>    internal: the temporary copy that removes the folder
// Upgrades simply overwrite the previous install.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("PixelQG (installation)")]
[assembly: AssemblyProduct("PixelQG")]
[assembly: AssemblyDescription("Installe PixelQG, le bureau de tes agents Claude Code")]
[assembly: AssemblyVersion(SetupInfo.AssemblyVersion)]
[assembly: AssemblyFileVersion(SetupInfo.AssemblyVersion)]

static class Setup
{
    public const string AppName = "PixelQG";
    const string PayloadResource = "PixelQG.payload.zip";
    const string UninstallerResource = "PixelQG.uninstaller.exe";
    public const string UninstallerName = "Desinstaller.exe";
    const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\PixelQG";

    public static string InstallDir
    {
        get
        {
            return Path.Combine(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"), AppName);
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        if (mode == "/extract-to") return args.Length >= 2 ? ExtractToConsole(args[1]) : 2;
        if (mode == "/preview") return args.Length >= 2 ? Preview(args[1], args.Length >= 3 && args[2] == "fin") : 2;
        if (mode == "/uninstall-run") return args.Length >= 3 ? UninstallRun(args[1], args[2]) : 2;
        try
        {
            if (mode == "/uninstall" || !HasResource(PayloadResource)) return Uninstall();
            Application.Run(new InstallForm(InstallDir, InstallDir));
            return 0;
        }
        catch (Exception ex)
        {
            MessageBox.Show("Une erreur inattendue s'est produite.\n\n" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // ---------------------------------------------------------------- release checks (no window)

    static int ExtractToConsole(string dir)
    {
        try
        {
            string target = Path.GetFullPath(dir);
            int files = ExtractPayload(target, null);
            if (WriteUninstaller(target)) files++;
            Console.Out.WriteLine("OK " + files);
            Console.Out.Flush();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERREUR " + ex.Message);
            Console.Error.Flush();
            return 3;
        }
    }

    static int Preview(string png, bool finished)
    {
        try
        {
            // A sample path: the picture never shows the real user name.
            using (InstallForm form = new InstallForm(InstallDir, @"C:\Users\toi\AppData\Local\Programs\PixelQG"))
            using (Bitmap bmp = new Bitmap(form.Width, form.Height))
            {
                if (finished) form.ShowFinished();
                form.DrawToBitmap(bmp, new Rectangle(0, 0, form.Width, form.Height));
                // The form is never shown, so its children are drawn one by one at their place.
                Rectangle client = form.RectangleToScreen(form.ClientRectangle);
                int dx = client.Left - form.Left;
                int dy = client.Top - form.Top;
                foreach (Control c in form.Controls)
                    c.DrawToBitmap(bmp, new Rectangle(dx + c.Left, dy + c.Top, c.Width, c.Height));
                bmp.Save(png, ImageFormat.Png);
            }
            Console.Out.WriteLine("OK");
            Console.Out.Flush();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERREUR " + ex.Message);
            Console.Error.Flush();
            return 3;
        }
    }

    // ---------------------------------------------------------------- install steps

    public static bool HasResource(string name)
    {
        foreach (string n in Assembly.GetExecutingAssembly().GetManifestResourceNames())
            if (n == name) return true;
        return false;
    }

    /// The zip's single top folder ("PixelQG-1.0.0-windows/"), stripped when extracting; null if none.
    static string TopFolder(ZipArchive zip)
    {
        string top = null;
        foreach (ZipArchiveEntry e in zip.Entries)
        {
            string name = e.FullName.Replace('\\', '/');
            int slash = name.IndexOf('/');
            if (slash <= 0) return null;
            string first = name.Substring(0, slash + 1);
            if (top == null) top = first;
            else if (!string.Equals(top, first, StringComparison.OrdinalIgnoreCase)) return null;
        }
        return top;
    }

    /// Extracts the embedded release into `target` (overwriting). Returns the number of files.
    public static int ExtractPayload(string target, Action<long, long> progress)
    {
        string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
        Directory.CreateDirectory(root);
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource))
        {
            if (s == null) throw new InvalidOperationException("Cet installateur ne contient pas PixelQG.");
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                string top = TopFolder(zip);
                long total = 0;
                foreach (ZipArchiveEntry e in zip.Entries) total += e.Length;
                long done = 0;
                int count = 0;
                byte[] buffer = new byte[256 * 1024];
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    string name = e.FullName.Replace('\\', '/');
                    if (top != null) name = name.Substring(top.Length);
                    if (name.Length == 0) continue;
                    string dest = Path.GetFullPath(Path.Combine(root, name.Replace('/', '\\')));
                    if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("Chemin invalide dans l'archive : " + e.FullName);
                    if (name.EndsWith("/"))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    if (File.Exists(dest)) File.SetAttributes(dest, FileAttributes.Normal);
                    using (Stream input = e.Open())
                    using (FileStream output = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        int n;
                        while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            output.Write(buffer, 0, n);
                            done += n;
                            if (progress != null) progress(done, total);
                        }
                    }
                    // Keep the archive dates: the server compares hq-pty.exe with its source.
                    File.SetLastWriteTime(dest, e.LastWriteTime.DateTime);
                    count++;
                }
                return count;
            }
        }
    }

    /// Writes the embedded uninstaller as Desinstaller.exe. False when this exe carries none.
    public static bool WriteUninstaller(string dir)
    {
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(UninstallerResource))
        {
            if (s == null) return false;
            string dest = Path.Combine(dir, UninstallerName);
            if (File.Exists(dest)) File.SetAttributes(dest, FileAttributes.Normal);
            using (FileStream output = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                s.CopyTo(output);
            return true;
        }
    }

    public static string DesktopShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); } }

    public static string StartMenuShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); } }

    /// Creates a .lnk through the WScript.Shell COM object (late binding: no interop assembly).
    public static void CreateShortcut(string lnk, string target, string workDir)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(lnk));
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(type);
        try
        {
            object link = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            try
            {
                Type lt = link.GetType();
                lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { workDir });
                lt.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "Le bureau de tes agents Claude Code" });
                lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { target + ",0" });
                lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
            }
            finally { Marshal.FinalReleaseComObject(link); }
        }
        finally { Marshal.FinalReleaseComObject(shell); }
    }

    /// Per-user entry of « Applications installées » (Apps & features).
    public static void Register(string dir, long bytes)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("DisplayVersion", SetupInfo.Version);
            k.SetValue("Publisher", AppName);
            k.SetValue("DisplayIcon", Path.Combine(dir, AppName + ".exe") + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", "\"" + Path.Combine(dir, UninstallerName) + "\" /uninstall");
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, bytes / 1024), RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    public static long FolderSize(string dir)
    {
        long total = 0;
        try
        {
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(f).Length; }
                catch { }
            }
        }
        catch { }
        return total;
    }

    // ---------------------------------------------------------------- running PixelQG

    /// Names of the PixelQG programs running from `dir` (launcher, its Node.js, the terminal bridge).
    public static List<string> RunningFrom(string dir)
    {
        List<string> found = new List<string>();
        string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        foreach (string name in new string[] { "PixelQG", "node", "hq-pty" })
        {
            Process[] list;
            try { list = Process.GetProcessesByName(name); }
            catch { continue; }
            foreach (Process p in list)
            {
                try
                {
                    string file = ImagePath(p.Id);
                    if (file != null && file.StartsWith(root, StringComparison.OrdinalIgnoreCase) && !found.Contains(name)) found.Add(name);
                }
                catch { }
                finally { p.Dispose(); }
            }
        }
        return found;
    }

    static string ImagePath(int pid)
    {
        IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString(0, size) : null;
        }
        finally { CloseHandle(h); }
    }

    /// Asks the user to close PixelQG while it runs from `dir`. False when they give up.
    public static bool EnsureNotRunning(IWin32Window owner, string dir)
    {
        while (RunningFrom(dir).Count > 0)
        {
            DialogResult r = MessageBox.Show(owner,
                "PixelQG est ouvert.\n\nFerme d'abord sa fenêtre (les agents en cours s'arrêtent avec lui), puis clique sur « Réessayer ».",
                AppName, MessageBoxButtons.RetryCancel, MessageBoxIcon.Warning);
            if (r != DialogResult.Retry) return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- uninstall

    static bool LooksInstalled(string dir)
    {
        try
        {
            return string.Equals(Path.GetFileName(Path.GetFullPath(dir).TrimEnd('\\')), AppName, StringComparison.OrdinalIgnoreCase)
                && (File.Exists(Path.Combine(dir, AppName + ".exe")) || File.Exists(Path.Combine(dir, @"server\server.js")));
        }
        catch { return false; }
    }

    static bool IsInside(string file, string dir)
    {
        string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        return Path.GetFullPath(file).StartsWith(root, StringComparison.OrdinalIgnoreCase);
    }

    static int Uninstall()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(self);
        if (!LooksInstalled(dir)) dir = InstallDir;
        if (!LooksInstalled(dir))
        {
            MessageBox.Show("PixelQG n'est pas installé dans ce dossier :\n" + dir, AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        DialogResult answer = MessageBox.Show(
            "Désinstaller PixelQG de cet ordinateur ?\n\nTes réglages et ta bibliothèque de skills (dossier .pixelqg de ton profil) sont conservés.",
            "Désinstaller PixelQG", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return 1;
        if (!EnsureNotRunning(null, dir)) return 1;
        if (IsInside(self, dir))
        {
            // An exe cannot delete the folder it runs from: carry on from a temporary copy.
            string tmp = Path.Combine(Path.GetTempPath(), "PixelQG-desinstallation-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
            File.Copy(self, tmp, true);
            ProcessStartInfo psi = new ProcessStartInfo(tmp, "/uninstall-run \"" + dir + "\" " + Process.GetCurrentProcess().Id);
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetTempPath();
            Process.Start(psi);
            return 0;
        }
        return RemoveInstall(dir);
    }

    static int UninstallRun(string dir, string pidText)
    {
        int pid;
        if (int.TryParse(pidText, out pid))
        {
            try { using (Process p = Process.GetProcessById(pid)) p.WaitForExit(15000); }
            catch { }
        }
        int code;
        try { code = RemoveInstall(dir); }
        catch (Exception ex)
        {
            MessageBox.Show("La désinstallation a échoué.\n\n" + ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            code = 1;
        }
        DeleteSelfLater();
        return code;
    }

    static int RemoveInstall(string dir)
    {
        if (!LooksInstalled(dir))
        {
            MessageBox.Show("Dossier inattendu, rien n'a été supprimé :\n" + dir, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        foreach (string lnk in new string[] { DesktopShortcut, StartMenuShortcut })
        {
            try { if (File.Exists(lnk)) File.Delete(lnk); }
            catch { }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); }
        catch { }
        bool removed = DeleteFolder(dir);
        if (removed)
            MessageBox.Show("PixelQG a été désinstallé.\n\nTes réglages et ta bibliothèque de skills (dossier .pixelqg) sont conservés.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        else
            MessageBox.Show("PixelQG a été désinstallé, mais certains fichiers n'ont pas pu être supprimés :\n" + dir + "\n\nSupprime ce dossier à la main.", AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return removed ? 0 : 1;
    }

    static bool DeleteFolder(string dir)
    {
        for (int i = 0; i < 10 && Directory.Exists(dir); i++)
        {
            try
            {
                foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(f, FileAttributes.Normal); }
                    catch { }
                }
                Directory.Delete(dir, true);
            }
            catch
            {
                Thread.Sleep(500); // a process may still be releasing its files
            }
        }
        return !Directory.Exists(dir);
    }

    /// The temporary uninstaller removes itself once it has exited (hidden cmd.exe).
    static void DeleteSelfLater()
    {
        try
        {
            string self = Assembly.GetExecutingAssembly().Location;
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /c ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\"");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(psi);
        }
        catch { }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
}

/// The small install window: title, install folder, progress bar, « Installer » / « Lancer PixelQG ».
class InstallForm : Form
{
    readonly string dir;
    readonly ProgressBar bar;
    readonly Label status;
    readonly Button main;
    readonly Button close;
    bool busy;
    bool installed;

    public InstallForm(string installDir, string shownDir)
    {
        dir = installDir;
        Text = "Installer PixelQG";
        Font = new Font("Segoe UI", 9F);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(480, 244);
        BackColor = Color.White;
        Icon appIcon = null;
        try { appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { }
        if (appIcon != null) Icon = appIcon;

        PictureBox logo = new PictureBox();
        logo.SetBounds(20, 18, 48, 48);
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        if (appIcon != null)
        {
            try { logo.Image = new Icon(appIcon, 48, 48).ToBitmap(); }
            catch { }
        }

        Label title = new Label();
        title.Text = "Installer PixelQG";
        title.Font = new Font("Segoe UI", 14F, FontStyle.Bold);
        title.SetBounds(80, 16, 380, 30);

        Label sub = new Label();
        sub.Text = "Version " + SetupInfo.Version + " · le bureau en pixel art de tes agents Claude Code";
        sub.ForeColor = Color.DimGray;
        sub.SetBounds(82, 46, 380, 20);

        Label where = new Label();
        where.Text = "Dossier d'installation :";
        where.SetBounds(20, 86, 440, 18);

        TextBox path = new TextBox();
        path.Text = shownDir;
        path.ReadOnly = true;
        path.TabStop = false;
        path.SetBounds(20, 106, 440, 23);

        bar = new ProgressBar();
        bar.SetBounds(20, 142, 440, 16);
        bar.Minimum = 0;
        bar.Maximum = 1000;

        status = new Label();
        status.SetBounds(20, 164, 440, 34); // two lines at most
        bool upgrade = File.Exists(Path.Combine(installDir, Setup.AppName + ".exe"));
        status.Text = upgrade
            ? "PixelQG est déjà installé : il sera mis à jour."
            : "Clique sur « Installer » pour commencer.";

        main = new Button();
        main.Text = "Installer";
        main.SetBounds(244, 202, 120, 28);
        main.Click += delegate { if (installed) Launch(); else StartInstall(); };

        close = new Button();
        close.Text = "Annuler";
        close.SetBounds(370, 202, 90, 28);
        close.Click += delegate { Close(); };

        AcceptButton = main;
        CancelButton = close;
        Controls.AddRange(new Control[] { logo, title, sub, where, path, bar, status, main, close });
        FormClosing += delegate (object s, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }

    void SetStatus(string text) { status.Text = text; }

    /// The end state, for /preview fin.
    public void ShowFinished() { Done(); }

    void StartInstall()
    {
        if (!Setup.EnsureNotRunning(this, dir)) return;
        busy = true;
        main.Enabled = false;
        close.Enabled = false;
        SetStatus("Copie des fichiers…");
        Thread worker = new Thread(Work);
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.STA); // WScript.Shell for the shortcuts
        worker.Start();
    }

    void Work()
    {
        try
        {
            int lastPermille = -1;
            Setup.ExtractPayload(dir, delegate (long done, long total)
            {
                int permille = total > 0 ? (int)(done * 1000 / total) : 0;
                if (permille == lastPermille) return;
                lastPermille = permille;
                BeginInvoke((MethodInvoker)delegate { bar.Value = Math.Min(bar.Maximum, permille); });
            });
            Setup.WriteUninstaller(dir);
            BeginInvoke((MethodInvoker)delegate { SetStatus("Création des raccourcis…"); });
            string exe = Path.Combine(dir, Setup.AppName + ".exe");
            Setup.CreateShortcut(Setup.DesktopShortcut, exe, dir);
            Setup.CreateShortcut(Setup.StartMenuShortcut, exe, dir);
            Setup.Register(dir, Setup.FolderSize(dir));
            BeginInvoke((MethodInvoker)Done);
        }
        catch (Exception ex)
        {
            string msg = ex.Message;
            BeginInvoke((MethodInvoker)delegate { Failed(msg); });
        }
    }

    void Done()
    {
        busy = false;
        installed = true;
        bar.Value = bar.Maximum;
        SetStatus("PixelQG est installé : son raccourci est sur ton bureau et dans le menu Démarrer.");
        main.Text = "Lancer PixelQG";
        main.Enabled = true;
        close.Text = "Fermer";
        close.Enabled = true;
        main.Focus();
    }

    void Failed(string message)
    {
        busy = false;
        main.Text = "Réessayer";
        main.Enabled = true;
        close.Enabled = true;
        SetStatus("L'installation n'a pas abouti.");
        MessageBox.Show(this, "L'installation n'a pas abouti.\n\n" + message + "\n\nSi PixelQG est ouvert, ferme-le, puis clique sur « Réessayer ».",
            Setup.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    void Launch()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(dir, Setup.AppName + ".exe"));
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = true;
            Process.Start(psi);
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, "Impossible de lancer PixelQG.\n\n" + ex.Message, Setup.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
