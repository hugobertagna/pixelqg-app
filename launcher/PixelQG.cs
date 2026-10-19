// PixelQG desktop launcher (Windows).
// Starts the Node server hidden, opens the office in a dedicated Edge app window and stops
// everything (server + Claude Code agents) when that window is closed.
// Written for the C# 5 compiler that ships with .NET Framework 4 (csc.exe), so no newer syntax.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("PixelQG")]
[assembly: AssemblyProduct("PixelQG")]
[assembly: AssemblyDescription("Le bureau de tes agents Claude Code")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    const string Title = "PixelQG";
    const int FirstPort = 4317;
    const int PortsToScan = 11;

    static string dataDir;
    static string logPath;
    static readonly object logLock = new object();
    static StreamWriter logWriter;
    static readonly List<string> recentLines = new List<string>();
    static IntPtr job = IntPtr.Zero;

    [STAThread]
    static int Main()
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();

        dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PixelQG");
        Directory.CreateDirectory(dataDir);
        logPath = Path.Combine(dataDir, "pixelqg.log");

        bool owner;
        using (Mutex mutex = new Mutex(true, "Local\\PixelQG.Launcher", out owner))
        {
            if (!owner)
            {
                // Another launcher already runs the server: just open one more window on it.
                string running = WaitForRunningServer(20000);
                if (running != null) OpenWindow(running, false);
                else Warn("PixelQG est déjà en train de démarrer. Patiente quelques secondes puis réessaie.");
                return 0;
            }

            OpenLog();
            try
            {
                return Run();
            }
            catch (Exception ex)
            {
                Log("ERREUR " + ex);
                Fail("Une erreur inattendue a empêché PixelQG de fonctionner.\n\n" + ex.Message + "\n\nJournal : " + logPath);
                return 1;
            }
            finally
            {
                CloseLog();
            }
        }
    }

    static int Run()
    {
        // A server started by hand (start.bat, npm start) is reused and left running.
        string existing = FindRunningServer();
        if (existing != null)
        {
            Log("Serveur déjà actif : " + existing);
            OpenWindow(existing, true);
            return 0;
        }

        string appDir = FindAppDir();
        if (appDir == null)
        {
            Fail("Je ne trouve pas le dossier de PixelQG.\n\nGarde « PixelQG.exe » à côté du dossier « pixelqg-app » (par exemple sur ton bureau), puis relance-le.");
            return 1;
        }
        string node = FindNode();
        if (node == null)
        {
            DialogResult r = MessageBox.Show(
                "PixelQG a besoin de Node.js (version 20 ou plus récente) pour fonctionner.\n\nVeux-tu ouvrir la page de téléchargement de Node.js ?",
                Title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes) Process.Start("https://nodejs.org/fr/download");
            return 1;
        }
        Log("Dossier : " + appDir);
        Log("Node : " + node);

        Process server = StartServer(node, appDir);
        string url = WaitForUrl(server, 30000);
        if (url == null)
        {
            string tail;
            lock (logLock) tail = string.Join("\n", recentLines.ToArray());
            StopServer(server);
            Fail("Le serveur de PixelQG n'a pas pu démarrer.\n\n" + Shorten(tail, 900) + "\n\nJournal complet : " + logPath);
            return 1;
        }
        Log("Adresse : " + url);

        while (true)
        {
            OpenWindow(url, true);
            if (server.HasExited) break;
            int busy = CountWorkingAgents(url);
            if (busy <= 0) break;
            string msg = busy == 1
                ? "1 agent ou session Claude travaille encore.\n\nOui : l'arrêter et fermer PixelQG.\nNon : rouvrir la fenêtre."
                : busy + " agents ou sessions Claude travaillent encore.\n\nOui : les arrêter et fermer PixelQG.\nNon : rouvrir la fenêtre.";
            DialogResult answer = MessageBox.Show(msg, Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer == DialogResult.Yes) break;
        }
        StopServer(server);
        return 0;
    }

    // ---------------------------------------------------------------- server

    static Process StartServer(string node, string appDir)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = Quote(Path.Combine(appDir, "server", "server.js")) + " --port " + FirstPort;
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);

        Process p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[serveur] " + e.Data); };
        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log("[serveur:err] " + e.Data); };
        p.Start();
        AttachToJob(p);
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        Log("Serveur lancé (PID " + p.Id + ")");
        return p;
    }

    static string WaitForUrl(Process server, int timeoutMs)
    {
        Regex re = new Regex(@"http://(?:127\.0\.0\.1|localhost):(\d+)", RegexOptions.IgnoreCase);
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (server.HasExited) { Thread.Sleep(300); return null; }
            string found = null;
            lock (logLock)
            {
                foreach (string line in recentLines)
                {
                    Match m = re.Match(line);
                    if (m.Success) { found = "http://127.0.0.1:" + m.Groups[1].Value + "/"; break; }
                }
            }
            if (found != null && IsPixelQG(found)) return found;
            Thread.Sleep(250);
        }
        return null;
    }

    static void StopServer(Process server)
    {
        try
        {
            if (!server.HasExited)
            {
                // Kill the whole tree: the Node server and every Claude Code process it started.
                ProcessStartInfo kill = new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F");
                kill.CreateNoWindow = true;
                kill.UseShellExecute = false;
                Process k = Process.Start(kill);
                k.WaitForExit(10000);
                server.WaitForExit(5000);
            }
            Log("Serveur arrêté");
        }
        catch (Exception ex)
        {
            Log("Arrêt du serveur : " + ex.Message);
        }
    }

    static string FindRunningServer()
    {
        for (int port = FirstPort; port < FirstPort + PortsToScan; port++)
        {
            string url = "http://127.0.0.1:" + port + "/";
            if (IsPixelQG(url)) return url;
        }
        return null;
    }

    static string WaitForRunningServer(int timeoutMs)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            string url = FindRunningServer();
            if (url != null) return url;
            Thread.Sleep(500);
        }
        return null;
    }

    static bool IsPixelQG(string url)
    {
        string body = HttpGet(url, null, 700);
        return body != null && body.Contains("<title>PixelQG</title>") && body.Contains("HQ_TOKEN");
    }

    static int CountWorkingAgents(string url)
    {
        try
        {
            string page = HttpGet(url, null, 2000);
            if (page == null) return 0;
            Match m = Regex.Match(page, "HQ_TOKEN\\s*=\\s*\"([0-9a-fA-F]+)\"");
            if (!m.Success) return 0;
            string json = HttpGet(url + "api/agents", m.Groups[1].Value, 3000);
            if (json == null) return 0;
            JavaScriptSerializer js = new JavaScriptSerializer();
            js.MaxJsonLength = int.MaxValue;
            Dictionary<string, object> root = js.Deserialize<Dictionary<string, object>>(json);
            object list;
            if (!root.TryGetValue("agents", out list)) return 0;
            int n = 0;
            foreach (object o in (IEnumerable)list)
            {
                Dictionary<string, object> a = o as Dictionary<string, object>;
                if (a == null) continue;
                object source, status, kind;
                a.TryGetValue("source", out source);
                a.TryGetValue("status", out status);
                a.TryGetValue("kind", out kind);
                if (!"root".Equals(kind)) continue;
                bool running = "working".Equals(status) || "starting".Equals(status);
                // Agents launched from the form, and claude sessions open in the integrated terminal
                // (those also count while they wait for the user: closing would cut them).
                if ("spawned".Equals(source) && running) n++;
                else if ("terminal".Equals(source) && (running || "waiting".Equals(status))) n++;
            }
            return n;
        }
        catch (Exception ex)
        {
            Log("Comptage des agents : " + ex.Message);
            return 0;
        }
    }

    static string HttpGet(string url, string token, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Proxy = null;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            if (token != null) req.Headers["X-HQ-Token"] = token;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return r.ReadToEnd();
            }
        }
        catch
        {
            return null;
        }
    }

    // ---------------------------------------------------------------- window

    static void OpenWindow(string url, bool wait)
    {
        string browser = FindBrowser();
        if (browser == null)
        {
            Process.Start(url);
            if (wait)
            {
                MessageBox.Show("PixelQG est ouvert dans ton navigateur.\n\nGarde ce message ouvert : clique sur OK quand tu veux arrêter PixelQG et ses agents.",
                    Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return;
        }

        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        int w = Math.Min(1680, (int)(area.Width * 0.9));
        int h = Math.Min(1050, (int)(area.Height * 0.9));
        int x = area.Left + (area.Width - w) / 2;
        int y = area.Top + (area.Height - h) / 2;
        string profile = Path.Combine(dataDir, "fenetre");

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = browser;
        psi.Arguments = "--app=" + Quote(url)
            + " --user-data-dir=" + Quote(profile)
            + " --window-size=" + w + "," + h
            + " --window-position=" + x + "," + y
            + " --no-first-run --no-default-browser-check --disable-sync";
        psi.UseShellExecute = false;
        Stopwatch sw = Stopwatch.StartNew();
        Process.Start(psi);
        if (!wait) return;

        // Edge often hands the window to another of its processes and the one we started exits
        // at once, so watch the real app window (main browser process of our profile) instead.
        bool seen = false;
        while (sw.ElapsedMilliseconds < 30000)
        {
            if (AppWindowOpen(profile)) { seen = true; break; }
            Thread.Sleep(500);
        }
        if (!seen)
        {
            Log("Fenêtre introuvable après 30 s");
            MessageBox.Show("PixelQG est ouvert dans ton navigateur.\n\nGarde ce message ouvert : clique sur OK seulement quand tu veux arrêter PixelQG et ses agents.",
                Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        int misses = 0;
        while (misses < 3)
        {
            Thread.Sleep(1000);
            misses = AppWindowOpen(profile) ? 0 : misses + 1;
        }
        Log("Fenêtre fermée après " + (sw.ElapsedMilliseconds / 1000) + " s");
    }

    /// True while a top-level window of the browser running our dedicated profile is open.
    /// A browser left running in the background (no window) does not count.
    static bool AppWindowOpen(string profile)
    {
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe' OR Name = 'chrome.exe'"))
            using (ManagementObjectCollection results = searcher.Get())
            {
                foreach (ManagementObject mo in results)
                {
                    using (mo)
                    {
                        string cmd = mo["CommandLine"] as string;
                        if (cmd == null || cmd.IndexOf(profile, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        if (cmd.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                        int pid = Convert.ToInt32(mo["ProcessId"]);
                        try
                        {
                            using (Process p = Process.GetProcessById(pid))
                            {
                                if (p.MainWindowHandle != IntPtr.Zero) return true;
                            }
                        }
                        catch { }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log("Surveillance de la fenêtre : " + ex.Message);
            return true; // never stop the server because of a monitoring error
        }
        return false;
    }

    static string FindBrowser()
    {
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = new string[] {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(local, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (string c in candidates) if (File.Exists(c)) return c;
        return null;
    }

    // ---------------------------------------------------------------- discovery

    static string FindAppDir()
    {
        List<string> candidates = new List<string>();
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        for (int i = 0; i < 4 && dir != null; i++)
        {
            candidates.Add(dir);
            candidates.Add(Path.Combine(dir, "pixelqg-app"));
            candidates.Add(Path.Combine(dir, "claude-hq")); // folder name before the rename
            DirectoryInfo parent = Directory.GetParent(dir.TrimEnd('\\', '/'));
            dir = parent == null ? null : parent.FullName;
        }
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "pixelqg-app"));
        candidates.Add(Path.Combine(home, @"OneDrive\Bureau\pixelqg-app"));
        candidates.Add(Path.Combine(home, @"OneDrive\Desktop\pixelqg-app"));
        candidates.Add(Path.Combine(home, @"Desktop\pixelqg-app"));
        candidates.Add(Path.Combine(home, @"Bureau\pixelqg-app"));
        foreach (string c in candidates)
        {
            try
            {
                if (File.Exists(Path.Combine(c, @"server\server.js")) && File.Exists(Path.Combine(c, @"public\index.html")))
                    return Path.GetFullPath(c);
            }
            catch { }
        }
        return null;
    }

    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(';'))
        {
            try
            {
                string p = part.Trim().Trim('"');
                if (p.Length == 0) continue;
                string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(p), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        string[] extra = new string[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("NVM_SYMLINK") ?? "", "node.exe"),
        };
        foreach (string c in extra) if (c.Length > 9 && File.Exists(c)) return c;
        return null;
    }

    // ---------------------------------------------------------------- helpers

    static string Quote(string s) { return "\"" + s.Replace("\"", "") + "\""; }

    static string Shorten(string s, int max) { return s.Length <= max ? s : "…" + s.Substring(s.Length - max); }

    static void Warn(string msg) { MessageBox.Show(msg, Title, MessageBoxButtons.OK, MessageBoxIcon.Information); }

    static void Fail(string msg) { MessageBox.Show(msg, Title, MessageBoxButtons.OK, MessageBoxIcon.Error); }

    static void OpenLog()
    {
        try
        {
            logWriter = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
            logWriter.AutoFlush = true;
        }
        catch { logWriter = null; }
        Log("PixelQG " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
    }

    static void CloseLog()
    {
        lock (logLock) { if (logWriter != null) { logWriter.Dispose(); logWriter = null; } }
    }

    static void Log(string line)
    {
        lock (logLock)
        {
            recentLines.Add(line);
            if (recentLines.Count > 40) recentLines.RemoveAt(0);
            if (logWriter != null) { try { logWriter.WriteLine(line); } catch { } }
        }
    }

    // ---------------------------------------------------------------- job object
    // The server joins a job that is killed when this launcher exits, even on a crash,
    // so no hidden Node or Claude Code process is ever left behind.

    static void AttachToJob(Process p)
    {
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                if (!SetInformationJobObject(job, 9, ptr, (uint)size)) Log("Job : configuration refusée");
            }
            finally { Marshal.FreeHGlobal(ptr); }
            if (!AssignProcessToJobObject(job, p.Handle)) Log("Job : rattachement refusé");
        }
        catch (Exception ex)
        {
            Log("Job : " + ex.Message);
        }
    }

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
