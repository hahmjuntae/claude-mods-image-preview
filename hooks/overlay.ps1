# 터미널에 칠한 마커 칸을 화면에서 찾아 그 위에 원본 이미지 창을 덮는 Windows 오버레이
# spec 파일 한 줄은 'RRGGBB<TAB>path', 플러그인이 수 초마다 다시 써서 생존 신호로 사용
param(
  [Parameter(Mandatory = $true)] [string] $Spec,
  [switch] $Probe
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace ModsImagePreview
{
    static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    }

    public class Tile : Form
    {
        public int Key { get; private set; }
        public string Path { get; private set; }
        public double Aspect { get { return (double)picture.Width / picture.Height; } }
        public Rectangle Last { get; set; }
        readonly Image picture;
        Color fill = Color.Black;

        public Tile(int key, string path)
        {
            Key = key;
            Path = path;
            picture = Image.FromStream(new MemoryStream(File.ReadAllBytes(path)));
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams p = base.CreateParams;
                // NOACTIVATE, TOOLWINDOW, TRANSPARENT, LAYERED, TOPMOST: 포커스와 클릭을 터미널에 남기는 창
                p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020 | 0x00080000 | 0x00000008;
                return p;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Native.SetLayeredWindowAttributes(Handle, 0, 255, 2);
            // 다음 캡처에 이 창이 잡히지 않아 그 아래 마커를 계속 찾는 기준
            Native.SetWindowDisplayAffinity(Handle, 0x11);
        }

        public void Place(Rectangle bounds, Color background)
        {
            if (bounds != Bounds || background != fill)
            {
                fill = background;
                Bounds = bounds;
                Invalidate();
            }

            if (!Visible) Show();
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(fill);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;

            double scale = Math.Min(1.0, Math.Min((double)ClientSize.Width / picture.Width, (double)ClientSize.Height / picture.Height));
            int width = Math.Max(1, (int)Math.Round(picture.Width * scale));
            int height = Math.Max(1, (int)Math.Round(picture.Height * scale));
            Rectangle target = new Rectangle((ClientSize.Width - width) / 2, (ClientSize.Height - height) / 2, width, height);

            using (ImageAttributes attributes = new ImageAttributes())
            {
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(picture, target, 0, 0, picture.Width, picture.Height, GraphicsUnit.Pixel, attributes);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) picture.Dispose();
            base.Dispose(disposing);
        }
    }

    public static class Overlay
    {
        const int Stride = 3;
        const int Margin = 160;
        const int FullScanMs = 400;
        static readonly TimeSpan Stale = TimeSpan.FromSeconds(15);
        static DateTime lastFullScan = DateTime.MinValue;

        static string spec;
        static string status;
        static DateTime specTime;
        static string lastStatus = "";
        static string rejection = "";
        static readonly Dictionary<int, Tile> tiles = new Dictionary<int, Tile>();
        static Bitmap frame;
        static int[] pixels = new int[0];
        static int frameWidth;
        static int frameHeight;

        public static void Run(string specPath)
        {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }

            spec = specPath;
            status = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(specPath), "overlay-status.txt");
            Console.Out.WriteLine("ready");
            Console.Out.Flush();

            Timer timer = new Timer();
            timer.Interval = 100;
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Application.Run();
        }

        // 화면 전체를 한 번 훑어 spec 의 마커 위치만 보고하는 진단 모드
        public static string Probe(string specPath)
        {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }

            Dictionary<int, double> keys = new Dictionary<int, double>();
            foreach (string line in File.ReadAllLines(specPath))
            {
                string[] parts = line.Split('\t');
                if (parts.Length != 2) continue;
                using (Image image = Image.FromFile(parts[1])) keys[Convert.ToInt32(parts[0], 16)] = (double)image.Width / image.Height;
            }

            Rectangle screen = SystemInformation.VirtualScreen;
            Capture(screen);
            List<string> lines = new List<string>();
            foreach (KeyValuePair<int, double> key in keys)
            {
                Rectangle found = Find(key.Key, key.Value);
                lines.Add(key.Key.ToString("x6") + (found.IsEmpty ? " not found " + rejection + " " + Nearest(key.Key) : " at " + Offset(found, screen.Location)));
            }

            return string.Join(Environment.NewLine, lines.ToArray());
        }

        static void Tick()
        {
            try
            {
                if (!Reload()) { Application.Exit(); return; }
                if (tiles.Count == 0) return;

                Rectangle bounds = SystemInformation.VirtualScreen;

                // 직전에 모두 찾았으면 그 주변만, 아니면 전체 화면을 FullScanMs 간격으로만 캡처해 CPU 사용을 낮추는 기준
                Rectangle area = bounds;
                bool isTracking = true;
                Rectangle union = Rectangle.Empty;
                foreach (Tile tile in tiles.Values)
                {
                    if (tile.Last.IsEmpty) { isTracking = false; break; }
                    union = union.IsEmpty ? tile.Last : Rectangle.Union(union, tile.Last);
                }
                if (isTracking)
                {
                    union.Inflate(Margin, Margin);
                    union.Intersect(bounds);
                    if (!union.IsEmpty) area = union;
                }
                else
                {
                    if (DateTime.UtcNow - lastFullScan < TimeSpan.FromMilliseconds(FullScanMs)) return;
                    lastFullScan = DateTime.UtcNow;
                }

                Capture(area);

                List<string> report = new List<string>();
                foreach (Tile tile in tiles.Values)
                {
                    Rectangle found = Find(tile.Key, tile.Aspect);

                    if (found.IsEmpty)
                    {
                        tile.Last = Rectangle.Empty;
                        if (tile.Visible) tile.Hide();
                        report.Add(tile.Key.ToString("x6") + " not found " + rejection + " " + Nearest(tile.Key));
                        continue;
                    }

                    Rectangle screen = Offset(found, area.Location);
                    tile.Last = screen;
                    tile.Place(screen, Background(found));
                    report.Add(tile.Key.ToString("x6") + " at " + screen);
                }

                Report(string.Join(Environment.NewLine, report.ToArray()));
            }
            catch (Exception error)
            {
                HideAll("error " + error.Message);
            }
        }

        static bool Reload()
        {
            if (!File.Exists(spec)) return false;

            DateTime time = File.GetLastWriteTimeUtc(spec);

            if (DateTime.UtcNow - time > Stale) return false;
            if (time == specTime) return true;

            specTime = time;
            Dictionary<int, string[]> wanted = new Dictionary<int, string[]>();
            foreach (string line in File.ReadAllLines(spec))
            {
                string[] parts = line.Split('\t');
                if (parts.Length == 2 && File.Exists(parts[1])) wanted[Convert.ToInt32(parts[0], 16)] = parts;
            }

            foreach (int key in new List<int>(tiles.Keys))
            {
                string[] parts;
                if (!wanted.TryGetValue(key, out parts) || parts[1] != tiles[key].Path)
                {
                    tiles[key].Close();
                    tiles.Remove(key);
                }
            }

            foreach (KeyValuePair<int, string[]> entry in wanted)
            {
                if (tiles.ContainsKey(entry.Key)) continue;

                // GDI+ 가 못 읽는 형식은 건너뛰어 그 칸은 마커 그대로 두는 기준
                try { tiles[entry.Key] = new Tile(entry.Key, entry.Value[1]); }
                catch (Exception) { }
            }

            return true;
        }

        static void Capture(Rectangle area)
        {
            if (frame == null || frame.Width != area.Width || frame.Height != area.Height)
            {
                if (frame != null) frame.Dispose();
                frame = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb);
                pixels = new int[area.Width * area.Height];
            }

            using (Graphics g = Graphics.FromImage(frame))
            {
                g.CopyFromScreen(area.Left, area.Top, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
            }

            BitmapData data = frame.LockBits(new Rectangle(0, 0, frame.Width, frame.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < frame.Height; y++)
                {
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), pixels, y * frame.Width, frame.Width);
                }
            }
            finally
            {
                frame.UnlockBits(data);
            }

            frameWidth = frame.Width;
            frameHeight = frame.Height;
        }

        static int At(int x, int y)
        {
            return pixels[y * frameWidth + x] & 0xFFFFFF;
        }

        // 터미널 색 보정 오차는 채널당 Tolerance 까지 같은 마커로 보고, 0x11 간격의 이웃 마커와는 겹치지 않는 기준
        const int Tolerance = 8;

        static bool Near(int color, int key)
        {
            return Math.Abs(((color >> 16) & 255) - ((key >> 16) & 255)) <= Tolerance
                && Math.Abs(((color >> 8) & 255) - ((key >> 8) & 255)) <= Tolerance
                && Math.Abs((color & 255) - (key & 255)) <= Tolerance;
        }

        // 같은 색 덩어리마다 사각형을 키워, 꽉 차 있고 가로세로 비율이 이미지와 글꼴 칸 비율 범위 안에서 맞는 가장 큰 것만 인정
        static Rectangle Find(int key, double aspect)
        {
            Rectangle best = Rectangle.Empty;
            List<Rectangle> tested = new List<Rectangle>();
            rejection = "";

            for (int y = 0; y < frameHeight; y += Stride)
            {
                int row = y * frameWidth;
                for (int x = 0; x < frameWidth; x += Stride)
                {
                    if (!Near(pixels[row + x], key) || Inside(tested, x, y)) continue;

                    Rectangle candidate = Grow(x, y, key);
                    tested.Add(candidate);

                    string reason = Check(candidate, key, aspect);
                    if (reason != null)
                    {
                        if (candidate.Width * candidate.Height >= 64) rejection = reason + " " + candidate;
                        continue;
                    }

                    if (candidate.Width * candidate.Height > best.Width * best.Height) best = candidate;
                }
            }

            return best;
        }

        static bool Inside(List<Rectangle> rectangles, int x, int y)
        {
            foreach (Rectangle rectangle in rectangles) if (rectangle.Contains(x, y)) return true;
            return false;
        }

        static Rectangle Grow(int x, int y, int key)
        {
            int left = x, right = x, top = y, bottom = y;
            while (left > 0 && Near(At(left - 1, y), key)) left--;
            while (right < frameWidth - 1 && Near(At(right + 1, y), key)) right++;
            while (top > 0 && Near(At(x, top - 1), key)) top--;
            while (bottom < frameHeight - 1 && Near(At(x, bottom + 1), key)) bottom++;
            return Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
        }

        static string Check(Rectangle candidate, int key, double aspect)
        {
            if (candidate.Width < 8 || candidate.Height < 8) return "small";

            int total = 0;
            int matched = 0;
            for (int y = candidate.Top; y < candidate.Bottom; y += Stride)
            {
                for (int x = candidate.Left; x < candidate.Right; x += Stride)
                {
                    total++;
                    if (Near(At(x, y), key)) matched++;
                }
            }
            if (matched < total * 0.9) return "sparse " + matched + "/" + total;

            double ratio = ((double)candidate.Width / candidate.Height) / aspect;
            if (ratio < 0.55 || ratio > 1.8) return "ratio " + ratio.ToString("0.00");

            return null;
        }

        // 마커 왼쪽 바깥 픽셀을 여백 색으로 써서 비율이 다른 이미지 둘레를 터미널 배경과 맞추는 기준
        static Color Background(Rectangle found)
        {
            int x = found.Left > 0 ? found.Left - 1 : found.Right;
            int y = found.Top + found.Height / 2;
            if (x >= frameWidth) return Color.Black;
            return Color.FromArgb(At(x, y));
        }

        // 못 찾았을 때 터미널이 색을 바꿔 그리는지 진단하려고 마커와 가장 가까운 색을 보고
        static string Nearest(int key)
        {
            int best = -1;
            int distance = int.MaxValue;
            for (int i = 0; i < frameWidth * frameHeight; i += 7)
            {
                int color = pixels[i] & 0xFFFFFF;
                int dr = ((color >> 16) & 255) - ((key >> 16) & 255);
                int dg = ((color >> 8) & 255) - ((key >> 8) & 255);
                int db = (color & 255) - (key & 255);
                int d = dr * dr + dg * dg + db * db;
                if (d < distance) { distance = d; best = color; }
            }
            return best < 0 ? "" : "nearest " + best.ToString("x6") + " d2=" + distance;
        }

        static Rectangle Offset(Rectangle found, Point origin)
        {
            return new Rectangle(found.Left + origin.X, found.Top + origin.Y, found.Width, found.Height);
        }

        static void HideAll(string reason)
        {
            foreach (Tile tile in tiles.Values)
            {
                tile.Last = Rectangle.Empty;
                if (tile.Visible) tile.Hide();
            }
            Report(reason);
        }

        // 상태가 바뀔 때만 최근 40건을 남겨, 찾음과 못 찾음이 오간 흐름을 진단하는 기록
        static readonly List<string> history = new List<string>();

        static void Report(string text)
        {
            if (text == lastStatus) return;
            lastStatus = text;
            history.Add(DateTime.Now.ToString("HH:mm:ss.fff") + " " + text.Replace(Environment.NewLine, " | "));
            if (history.Count > 40) history.RemoveAt(0);
            try { File.WriteAllLines(status, history.ToArray()); }
            catch (IOException) { }
        }
    }
}
'@

if ($Probe) {
  [ModsImagePreview.Overlay]::Probe($Spec)
} else {
  [ModsImagePreview.Overlay]::Run($Spec)
}
