// Fixed native-messaging launcher. Compiled locally by Windows PowerShell 5.1
// against the Windows .NET Framework; never invokes a command from a message.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

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
        // With stderr redirected, .NET Framework passes the existing stdin and stdout
        // handles to Python. Browser messages then travel as raw bytes in both directions.
        info.RedirectStandardError = true;
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
    public static int Main(string[] args) {
        try {
            string home = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
            string homeArgs = "--home " + Quote(home);
            foreach (string arg in args) homeArgs += " " + Quote(arg);
            using (Process child = Process.Start(StartInfo(home, "native_host.py", homeArgs))) {
                child.StandardError.BaseStream.CopyTo(Console.OpenStandardError());
                child.WaitForExit();
                return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("Anagram native host: " + error.Message); return 1; }
    }
}
