// Fixed native-messaging launcher. Compiled locally by Windows PowerShell 5.1
// against the Windows .NET Framework; never invokes a command from a message.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class AnagramNativeLauncher {
    static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append(c); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes = 0;
        }
        b.Append('\\', slashes * 2); b.Append('"'); return b.ToString();
    }
    static ProcessStartInfo StartInfo(string home, string script, string tail) {
        var info = new ProcessStartInfo(Path.Combine(home, "venv", "Scripts", "python.exe"));
        info.Arguments = "-I -u " + Quote(Path.Combine(home, "app", script)) + " " + tail;
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.WorkingDirectory = home;
        info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.EnvironmentVariables.Clear();
        foreach (string key in new string[] {"USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"}) {
            string value = Environment.GetEnvironmentVariable(key);
            if (value != null) info.EnvironmentVariables[key] = value;
        }
        info.EnvironmentVariables["PATH"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");
        info.EnvironmentVariables["HF_HOME"] = Path.Combine(home, "hf");
        info.EnvironmentVariables["XDG_CACHE_HOME"] = Path.Combine(home, "cache");
        info.EnvironmentVariables["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1";
        info.EnvironmentVariables["HF_HUB_DISABLE_TELEMETRY"] = "1";
        return info;
    }
    static Thread Pump(Stream source, Stream target, bool closeTarget) {
        var thread = new Thread(delegate() {
            try { source.CopyTo(target); target.Flush(); }
            catch (IOException) {} catch (ObjectDisposedException) {}
            finally { if (closeTarget) try { target.Close(); } catch {} }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }
    public static int Main(string[] args) {
        try {
            string home = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
            string homeArgs = "--home " + Quote(home);
            foreach (string arg in args) homeArgs += " " + Quote(arg);
            using (Process child = Process.Start(StartInfo(home, "native_host.py", homeArgs))) {
                // Raw byte streams preserve native messaging length prefixes and UTF-8.
                Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
                Thread output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                Thread errors = Pump(child.StandardError.BaseStream, Console.OpenStandardError(), false);
                child.WaitForExit(); output.Join(); errors.Join(); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("Anagram native host: " + error.Message); return 1; }
    }
}
