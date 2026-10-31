// MIT. Owner-operated existing-key entry. No network, plaintext file or key argument/log.
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;
using System.Collections.Generic;
using System.Text.RegularExpressions;

internal static class WintrConcerts {
  [STAThread] private static int Main(string[] args) {
    try {
      if (args.Length != 0) return 1;
      var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Wintr");
      if (!Directory.Exists(directory) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new Exception();
      var profileFile = Path.Combine(directory, "profile.json");
      var info = new FileInfo(profileFile); if (!info.Exists || info.Length < 1 || info.Length > 65536 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception();
      var serializer = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 8 };
      var profile = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(profileFile, Encoding.UTF8));
      object id, enabled, approved;
      if (!profile.TryGetValue("profileId", out id) || !(id is string) || !Regex.IsMatch((string)id, "^[a-f0-9]{32}$") || !profile.TryGetValue("enabled", out enabled) || !true.Equals(enabled) || !profile.TryGetValue("approved", out approved) || !true.Equals(approved)) throw new Exception();
      var destination = Path.Combine(directory, "ticketmaster.dpapi");
      if (File.Exists(destination)) { MessageBox.Show("Ticketmaster is already connected. No saved key was replaced.", "Wintr"); return 0; }
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      using (var form = new Form { Text = "Connect Ticketmaster to Wintr", ClientSize = new Size(450, 300), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, BackColor = Color.White, Font = new Font("Segoe UI", 10) }) {
        var title = new Label { Text = "Your Ticketmaster API key", AutoSize = true, Location = new Point(24, 24), Font = new Font("Segoe UI", 13, FontStyle.Bold) };
        var key = new TextBox { Location = new Point(24, 64), Width = 402, UseSystemPasswordChar = true, MaxLength = 256 };
        var terms = new Label { Text = "Stored encrypted on this PC. Used only for concert lookups.\r\nArtists, city and dates go to Ticketmaster when you search.\r\nUp to 250 requests per 24 hours. No ticket purchases.", AutoSize = false, Location = new Point(24, 104), Size = new Size(402, 86) };
        var status = new Label { AutoSize = false, Location = new Point(24, 198), Size = new Size(402, 34) };
        var connect = new Button { Text = "Connect", Location = new Point(302, 242), Size = new Size(124, 36) };
        var cancel = new Button { Text = "Cancel", Location = new Point(166, 242), Size = new Size(124, 36), DialogResult = DialogResult.Cancel };
        connect.Click += (sender, e) => {
          byte[] plain = null, encrypted = null; string pending = null;
          try {
            var value = key.Text.Trim(); if (!Regex.IsMatch(value, "^[A-Za-z0-9_-]{16,256}$")) { status.Text = "Paste the API key from your Ticketmaster developer account."; return; }
            var packet = new Dictionary<string, object> { {"schema",1}, {"kind","wintr-ticketmaster-v1"}, {"profileId",id}, {"approved",true}, {"authority","until_revoked"}, {"dailyLimit",250}, {"createdAt",(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds}, {"apiKey",value} };
            plain = Encoding.UTF8.GetBytes(serializer.Serialize(packet));
            encrypted = ProtectedData.Protect(plain, Encoding.UTF8.GetBytes("wintr-personal-providers-v1"), DataProtectionScope.CurrentUser);
            pending = Path.Combine(directory, "ticketmaster-" + Guid.NewGuid().ToString("N") + ".pending");
            using (var stream = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(encrypted, 0, encrypted.Length); stream.Flush(true); }
            File.Move(pending, destination); pending = null; key.Clear(); connect.Enabled = false; key.Enabled = false;
            status.Text = "Connected. Open Concerts in Wintr again."; cancel.Text = "Close";
          } catch { status.Text = "Could not save the key. No existing connection was changed."; }
          finally { if (plain != null) Array.Clear(plain,0,plain.Length); if (encrypted != null) Array.Clear(encrypted,0,encrypted.Length); if (pending != null) try { File.Delete(pending); } catch {} }
        };
        form.Controls.AddRange(new Control[] { title,key,terms,status,connect,cancel }); form.AcceptButton = connect; form.CancelButton = cancel;
        form.ShowDialog(); key.Clear();
      }
      return 0;
    } catch { MessageBox.Show("Open Wintr once before connecting Ticketmaster.", "Wintr"); return 1; }
  }
}
