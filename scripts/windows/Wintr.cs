// MIT. Native local launcher. No policy changes, credential access or process kills.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Wintr {
  private static string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
  private static string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Wintr");
  private static string Quote(string value) { if (value.IndexOf('"') >= 0 || value.IndexOf('\n') >= 0 || value.IndexOf('\r') >= 0) throw new Exception(); return "\"" + value + "\""; }
  private static ProcessStartInfo Node(string file, string extra) {
    return new ProcessStartInfo(Path.Combine(root, "runtime", "node.exe"), Quote(Path.Combine(root, "dist", "server", "server", file)) + " " + extra + " --data-dir " + Quote(data)) {
      UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = root,
      RedirectStandardOutput = true, RedirectStandardError = true
    };
  }
  private static Dictionary<string, object> Helper(string command) {
    using (var p = Process.Start(Node("desktop-launcher.js", command))) {
      var text = p.StandardOutput.ReadToEnd(); p.StandardError.ReadToEnd(); p.WaitForExit();
      if (p.ExitCode != 0 || text.Length > 4096) return null;
      return new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 5 }.Deserialize<Dictionary<string, object>>(text);
    }
  }
  private static void Open(Dictionary<string, object> ready) {
    object value; if (ready == null || !ready.TryGetValue("origin", out value) || !(value is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)value, @"^http://127\.0\.0\.1:[0-9]{4,5}$")) throw new Exception();
    Process.Start(new ProcessStartInfo((string)value) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
  }
  [STAThread] private static int Main(string[] args) {
    Mutex mutex = null; bool owned = false; Process server = null;
    try {
      if (args.Length > 1 || (args.Length == 1 && args[0] != "stop" && args[0] != "setup")) return 1;
      if (args.Length == 1 && args[0] == "setup") {
        using (var setup = Process.Start(Node("personal-connect.js", ""))) {
          setup.StandardOutput.ReadToEnd(); setup.StandardError.ReadToEnd(); setup.WaitForExit();
          if (setup.ExitCode != 0) { MessageBox.Show("Google could not connect. Please try setup again.", "Wintr"); return 1; }
        }
        var connected = Helper("describe"); object profileId;
        if (connected == null || !connected.TryGetValue("profileId", out profileId)) throw new Exception();
        using (var stopped = new Mutex(false, "Local\\Wintr-" + (string)profileId)) {
          bool acquired; try { acquired = stopped.WaitOne(45000); } catch (AbandonedMutexException) { acquired = true; }
          if (!acquired) throw new Exception(); stopped.ReleaseMutex();
        }
        Process.Start(new ProcessStartInfo(Path.Combine(root, "runtime", "Wintr.exe")) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
        return 0;
      }
      if (args.Length == 1) { Helper("stop"); return 0; }
      var description = Helper("describe"); object id;
      if (description == null || !description.TryGetValue("profileId", out id) || !(id is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)id, "^[a-f0-9]{32}$")) {
        MessageBox.Show("Wintr needs its one-time connection. Finish connecting Google before opening Wintr.", "Wintr"); return 1;
      }
      mutex = new Mutex(false, "Local\\Wintr-" + (string)id);
      try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
      if (owned) {
        var running = Helper("probe"); if (running != null) { Open(running); return 0; }
        var logs = Path.Combine(data, "logs"); Directory.CreateDirectory(logs); var run = Guid.NewGuid().ToString("N");
        var output = new StreamWriter(Path.Combine(logs, run + ".out.log"), false, new UTF8Encoding(false));
        var errors = new StreamWriter(Path.Combine(logs, run + ".err.log"), false, new UTF8Encoding(false));
        server = new Process { StartInfo = Node("personal-entry.js", ""), EnableRaisingEvents = true };
        server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (output) { output.WriteLine(e.Data); output.Flush(); } };
        server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (errors) { errors.WriteLine(e.Data); errors.Flush(); } };
        server.Start(); server.BeginOutputReadLine(); server.BeginErrorReadLine();
        var ready = Helper("wait");
        if (ready != null) Open(ready);
        else MessageBox.Show("Wintr could not connect. Check your internet connection and try again. If Google has disconnected, reconnect it in Wintr setup.", "Wintr");
        // Keep the mutex until this owned runtime ends, including failed startup.
        server.WaitForExit(); output.Dispose(); errors.Dispose(); return ready == null ? 1 : 0;
      }
      var existing = Helper("wait"); if (existing == null) throw new Exception(); Open(existing); return 0;
    } catch { MessageBox.Show("Wintr could not start. Check its connection in Wintr setup.", "Wintr"); return 1; }
    finally { if (server != null) server.Dispose(); if (owned && mutex != null) mutex.ReleaseMutex(); if (mutex != null) mutex.Dispose(); }
  }
}
