// PixelQG — ConPTY bridge (docs/TERMINAL.md section 1).
//
// Runs a command line inside a Windows pseudoconsole (ConPTY, Windows 10 1809+) and relays it over stdio:
//   stdout : raw bytes read from the pseudoconsole output pipe (UTF-8 VT sequences), flushed promptly.
//   stdin  : framed messages [type u8][length u32 little-endian][payload]
//              0 = input  (payload bytes written to the pseudoconsole input pipe)
//              1 = resize (payload = cols u16 LE, rows u16 LE)
//              2 = terminate (kill the whole process tree and exit)
//            EOF on stdin = terminate.
// When the child exits, the remaining output is drained, the pseudoconsole is closed and the bridge
// exits with the child's exit code. Fatal errors: one French line on stderr, exit code 90+.
//
// The bridge and every process started inside the pseudoconsole live in a kill-on-close Job Object,
// so killing the bridge (or its parent closing it) tears down the whole shell tree.
//
// Build (C# 5, .NET Framework compiler shipped with Windows), see build-pty.bat:
//   csc.exe /nologo /codepage:65001 /target:exe /optimize+ /out:hq-pty.exe hq-pty.cs
//
// Usage: hq-pty.exe --cols <n> --rows <n> --cwd <dir> --cmd "<full command line>"

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace PixelQG
{
    internal static class Native
    {
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const uint CREATE_SUSPENDED = 0x00000004;
        public const int STARTF_USESTDHANDLES = 0x00000100;
        public static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);
        public const uint INFINITE = 0xFFFFFFFF;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        public struct COORD
        {
            public short X;
            public short Y;
        }

        // All pointer-sized members are IntPtr so that the layout is right on both x86 and x64.
        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        // JOBOBJECT_BASIC_LIMIT_INFORMATION: LARGE_INTEGER -> long, SIZE_T / ULONG_PTR -> UIntPtr, DWORD -> uint.
        // Sequential layout with natural alignment gives 64 bytes on x64 (48 on x86), matching winnt.h.
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        // 144 bytes on x64 (112 on x86).
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern void ClosePseudoConsole(IntPtr hPC);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cbInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(SafeFileHandle hFile, byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteFile(SafeFileHandle hFile, byte[] lpBuffer, int nNumberOfBytesToWrite, out int lpNumberOfBytesWritten, IntPtr lpOverlapped);
    }

    internal sealed class Options
    {
        public int Cols;
        public int Rows;
        public string Cwd;
        public string Cmd;
    }

    internal static class Program
    {
        private const int ExitBadArgs = 90;
        private const int ExitJob = 91;
        private const int ExitCwd = 92;
        private const int ExitConsole = 93;
        private const int ExitSpawn = 94;
        private const int ExitUnexpected = 95;
        private const uint ExitTerminated = 1;
        private const int MaxFrame = 16 * 1024 * 1024;

        private static readonly object Sync = new object();
        private static readonly ManualResetEvent OutputDone = new ManualResetEvent(false);
        private static volatile int lastOutputTick;
        private static bool exiting;
        private static IntPtr job = IntPtr.Zero;
        private static IntPtr pseudoConsole = IntPtr.Zero;
        private static IntPtr childProcess = IntPtr.Zero;
        private static SafeFileHandle inputWrite;
        private static SafeFileHandle outputRead;
        private static Stream stdout;

        private static int Main(string[] args)
        {
            try
            {
                return Run(args);
            }
            catch (Exception ex)
            {
                return Fail(ExitUnexpected, "Erreur inattendue du pont terminal : " + ex.Message);
            }
        }

        private static int Fail(int code, string message)
        {
            try
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(message.Replace('\r', ' ').Replace('\n', ' ') + "\n");
                Stream err = Console.OpenStandardError();
                err.Write(bytes, 0, bytes.Length);
                err.Flush();
            }
            catch (Exception)
            {
                // Nothing else can be reported.
            }
            return code;
        }

        private static Options Parse(string[] args)
        {
            Options o = new Options();
            o.Cols = 120;
            o.Rows = 30;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (i + 1 >= args.Length) return null;
                string v = args[++i];
                if (a == "--cols")
                {
                    if (!int.TryParse(v, out o.Cols) || o.Cols < 1 || o.Cols > 1000) return null;
                }
                else if (a == "--rows")
                {
                    if (!int.TryParse(v, out o.Rows) || o.Rows < 1 || o.Rows > 1000) return null;
                }
                else if (a == "--cwd")
                {
                    o.Cwd = v;
                }
                else if (a == "--cmd")
                {
                    o.Cmd = v;
                }
                else
                {
                    return null;
                }
            }
            if (string.IsNullOrEmpty(o.Cwd) || string.IsNullOrEmpty(o.Cmd)) return null;
            return o;
        }

        private static int Run(string[] args)
        {
            Options o = Parse(args);
            if (o == null)
            {
                return Fail(ExitBadArgs, "Arguments invalides. Usage : hq-pty.exe --cols <n> --rows <n> --cwd <dossier> --cmd \"<ligne de commande>\"");
            }
            if (!Directory.Exists(o.Cwd))
            {
                return Fail(ExitCwd, "Dossier de travail introuvable : " + o.Cwd);
            }

            // 1. Kill-on-close job. The bridge joins it first so that conhost and the shell inherit it.
            job = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                return Fail(ExitJob, "Impossible de créer l'objet de tâche Windows (code " + Marshal.GetLastWin32Error() + ").");
            }
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits, limitsSize))
            {
                return Fail(ExitJob, "Impossible de configurer l'objet de tâche Windows (code " + Marshal.GetLastWin32Error() + ", taille " + limitsSize + ").");
            }
            bool selfInJob = Native.AssignProcessToJobObject(job, Native.GetCurrentProcess());

            // 2. Pipes + pseudoconsole.
            SafeFileHandle inputRead;
            SafeFileHandle outputWrite;
            if (!Native.CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0) ||
                !Native.CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0))
            {
                return Fail(ExitConsole, "Impossible de créer les tuyaux du terminal (code " + Marshal.GetLastWin32Error() + ").");
            }
            Native.COORD size = new Native.COORD();
            size.X = (short)o.Cols;
            size.Y = (short)o.Rows;
            int hr;
            try
            {
                hr = Native.CreatePseudoConsole(size, inputRead, outputWrite, 0, out pseudoConsole);
            }
            catch (EntryPointNotFoundException)
            {
                return Fail(ExitConsole, "Ta version de Windows ne propose pas de pseudo-console (Windows 10 version 1809 ou plus récente requise).");
            }
            if (hr != 0)
            {
                return Fail(ExitConsole, "Impossible de créer la pseudo-console (code 0x" + hr.ToString("X8") + ").");
            }
            // The pseudoconsole keeps its own copies of these ends: closing ours lets EOF propagate.
            inputRead.Dispose();
            outputWrite.Dispose();

            stdout = Console.OpenStandardOutput();
            lastOutputTick = Environment.TickCount;
            Thread reader = new Thread(PumpOutput);
            reader.IsBackground = true;
            reader.Name = "hq-pty-output";
            reader.Start();

            // 3. Child process attached to the pseudoconsole.
            IntPtr attrSize = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
            IntPtr attrList = Marshal.AllocHGlobal(attrSize);
            Native.PROCESS_INFORMATION pi;
            try
            {
                if (!Native.InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize))
                {
                    return Fail(ExitSpawn, "Impossible de préparer le lancement du shell (code " + Marshal.GetLastWin32Error() + ").");
                }
                try
                {
                    if (!Native.UpdateProcThreadAttribute(attrList, 0, Native.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole,
                        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    {
                        return Fail(ExitSpawn, "Impossible d'attacher la pseudo-console au shell (code " + Marshal.GetLastWin32Error() + ").");
                    }
                    Native.STARTUPINFOEX si = new Native.STARTUPINFOEX();
                    si.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
                    // Null standard handles: the child must use the pseudoconsole, not the bridge's redirected stdio.
                    si.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                    si.lpAttributeList = attrList;
                    StringBuilder commandLine = new StringBuilder(o.Cmd);
                    if (!Native.CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                        Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_SUSPENDED, IntPtr.Zero, o.Cwd, ref si, out pi))
                    {
                        return Fail(ExitSpawn, "Impossible de lancer « " + o.Cmd + " » (code " + Marshal.GetLastWin32Error() + ").");
                    }
                }
                finally
                {
                    Native.DeleteProcThreadAttributeList(attrList);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(attrList);
            }

            if (!selfInJob && !Native.AssignProcessToJobObject(job, pi.hProcess))
            {
                int err = Marshal.GetLastWin32Error();
                Native.TerminateProcess(pi.hProcess, ExitTerminated);
                return Fail(ExitJob, "Impossible de placer le shell dans l'objet de tâche Windows (code " + err + ").");
            }
            childProcess = pi.hProcess;
            Native.ResumeThread(pi.hThread);
            Native.CloseHandle(pi.hThread);

            Thread waiter = new Thread(WaitForChild);
            waiter.IsBackground = true;
            waiter.Name = "hq-pty-wait";
            waiter.Start();

            // 4. Framed input from stdin until EOF or a terminate frame.
            PumpInput();
            Terminate();
            return (int)ExitTerminated;
        }

        private static void PumpOutput()
        {
            byte[] buffer = new byte[65536];
            try
            {
                for (;;)
                {
                    int read;
                    if (!Native.ReadFile(outputRead, buffer, buffer.Length, out read, IntPtr.Zero) || read <= 0) break;
                    lastOutputTick = Environment.TickCount;
                    stdout.Write(buffer, 0, read);
                    stdout.Flush();
                }
            }
            catch (Exception)
            {
                // Broken stdout: the parent is gone, stdin EOF will terminate the bridge.
            }
            OutputDone.Set();
        }

        private static bool ReadExact(Stream stream, byte[] buffer, int count)
        {
            int offset = 0;
            while (offset < count)
            {
                int n;
                try
                {
                    n = stream.Read(buffer, offset, count - offset);
                }
                catch (IOException)
                {
                    return false;
                }
                if (n <= 0) return false;
                offset += n;
            }
            return true;
        }

        private static void PumpInput()
        {
            Stream stdin = Console.OpenStandardInput();
            byte[] header = new byte[5];
            for (;;)
            {
                if (!ReadExact(stdin, header, 5)) return;
                int type = header[0];
                long length = (long)header[1] | ((long)header[2] << 8) | ((long)header[3] << 16) | ((long)header[4] << 24);
                if (length > MaxFrame) return; // protocol violation: treat as terminate
                byte[] payload = new byte[length];
                if (length > 0 && !ReadExact(stdin, payload, (int)length)) return;
                switch (type)
                {
                    case 0:
                        WriteInput(payload);
                        break;
                    case 1:
                        if (payload.Length >= 4) Resize(payload[0] | (payload[1] << 8), payload[2] | (payload[3] << 8));
                        break;
                    case 2:
                        return;
                    default:
                        break; // unknown frame types are ignored for forward compatibility
                }
            }
        }

        private static void WriteInput(byte[] data)
        {
            int offset = 0;
            while (offset < data.Length)
            {
                byte[] chunk = data;
                if (offset > 0)
                {
                    chunk = new byte[data.Length - offset];
                    Buffer.BlockCopy(data, offset, chunk, 0, chunk.Length);
                }
                int written;
                if (!Native.WriteFile(inputWrite, chunk, chunk.Length, out written, IntPtr.Zero) || written <= 0) return;
                offset += written;
            }
        }

        private static void Resize(int cols, int rows)
        {
            if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
            lock (Sync)
            {
                if (exiting || pseudoConsole == IntPtr.Zero) return;
                Native.COORD size = new Native.COORD();
                size.X = (short)cols;
                size.Y = (short)rows;
                Native.ResizePseudoConsole(pseudoConsole, size);
            }
        }

        private static void WaitForChild()
        {
            Native.WaitForSingleObject(childProcess, Native.INFINITE);
            uint code;
            if (!Native.GetExitCodeProcess(childProcess, out code)) code = ExitTerminated;

            // Let conhost paint the last frame: wait until the output has been quiet for 150 ms (1.5 s max).
            int start = Environment.TickCount;
            while (Environment.TickCount - start < 1500 && Environment.TickCount - lastOutputTick < 150)
            {
                Thread.Sleep(25);
            }
            lock (Sync)
            {
                if (exiting) return;
                exiting = true;
            }
            // Closing the pseudoconsole flushes and ends its output pipe; the reader drains it meanwhile.
            Native.ClosePseudoConsole(pseudoConsole);
            OutputDone.WaitOne(3000);
            try
            {
                stdout.Flush();
            }
            catch (Exception)
            {
                // Parent already gone.
            }
            Environment.Exit((int)code);
        }

        private static void Terminate()
        {
            bool childExitInProgress;
            lock (Sync)
            {
                childExitInProgress = exiting;
                exiting = true;
            }
            if (childExitInProgress)
            {
                // The child already exited: WaitForChild drains the output and exits with its code.
                Thread.Sleep(Timeout.Infinite);
                return;
            }
            try
            {
                stdout.Flush();
            }
            catch (Exception)
            {
                // Parent already gone.
            }
            // Kills the shell tree (and the bridge itself when it joined the job).
            Native.TerminateJobObject(job, ExitTerminated);
            Native.ClosePseudoConsole(pseudoConsole);
            Environment.Exit((int)ExitTerminated);
        }
    }
}
