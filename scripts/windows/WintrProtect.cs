// MIT. CurrentUser DPAPI IPC only; no arguments contain secret material.
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Threading;

internal static class WintrProtect {
  private static int Main(string[] args) {
    byte[] plain = null, result = null;
    try {
      if (args.Length == 2 && args[0] == "setup-lock" && System.Text.RegularExpressions.Regex.IsMatch(args[1], "^[a-f0-9]{32}$")) {
        using (var mutex = new Mutex(false, "Local\\Wintr-Setup-" + args[1])) {
          bool owned; try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
          if (!owned) return 2;
          try { Console.Out.WriteLine("locked"); Console.Out.Flush(); Console.In.Read(); return 0; }
          finally { mutex.ReleaseMutex(); }
        }
      }
      if (args.Length != 1 || (args[0] != "protect" && args[0] != "unprotect")) throw new Exception();
      Console.InputEncoding = new UTF8Encoding(false, true);
      Console.OutputEncoding = new UTF8Encoding(false, true);
      var input = new StringBuilder(); var chunk = new char[4096]; int n;
      while ((n = Console.In.Read(chunk, 0, chunk.Length)) > 0) {
        input.Append(chunk, 0, n); if (input.Length > 200000) throw new Exception();
      }
      var parser = new JavaScriptSerializer { MaxJsonLength = 200000, RecursionLimit = 5 };
      var packet = parser.Deserialize<Dictionary<string, object>>(input.ToString());
      if (packet == null || packet.Count != 2 || !packet.ContainsKey("purpose") || !packet.ContainsKey("data")) throw new Exception();
      string purpose = packet["purpose"] as string, encoded = packet["data"] as string;
      if (purpose != "wintr-personal-google-v1" && purpose != "wintr-personal-providers-v1" && purpose != "wintr-personal-desktop-v1") throw new Exception();
      plain = Convert.FromBase64String(encoded); if (plain.Length == 0 || plain.Length > 131072) throw new Exception();
      var entropy = Encoding.UTF8.GetBytes(purpose);
      result = args[0] == "protect" ? ProtectedData.Protect(plain, entropy, DataProtectionScope.CurrentUser) : ProtectedData.Unprotect(plain, entropy, DataProtectionScope.CurrentUser);
      Console.Out.Write(Convert.ToBase64String(result)); return 0;
    } catch { Console.Error.Write("windows_protection_failed"); return 1; }
    finally { if (plain != null) Array.Clear(plain, 0, plain.Length); if (result != null) Array.Clear(result, 0, result.Length); }
  }
}
