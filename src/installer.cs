// Windhawk Mod 翻译器 - 一键安装器
// 编译: csc.exe /target:winexe /optimize+ /win32manifest:app.manifest /resource:translate.js,translatejs /out:WindhawkModTranslator.exe installer.cs
// 功能: 部署 translate.js 到 Windhawk webview 目录、注入 index.html、修改扩展 CSP（幂等，可重复运行）
using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

class Installer
{
    const string RESOURCE_JS = "translatejs";

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        bool silent = args.Length > 0 && (args[0] == "/silent" || args[0] == "-s" || args[0] == "--silent");
        try
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string whRoot = "C:\\Program Files\\Windhawk";
            // 支持通过环境变量覆盖安装路径（可选）
            string env = Environment.GetEnvironmentVariable("WINDHAWK_PATH");
            if (!string.IsNullOrEmpty(env)) whRoot = env;

            string src = Path.Combine(whRoot, "UI", "resources", "app", "extensions", "windhawk");
            string webviewDir = Path.Combine(src, "webview");
            string extJs = Path.Combine(src, "dist", "extension.js");
            string idxHtml = Path.Combine(webviewDir, "index.html");

            StringBuilder msgs = new StringBuilder();

            if (!File.Exists(extJs) || !File.Exists(idxHtml))
            {
                MessageBox.Show(
                    "未找到 Windhawk UI 文件：\n" + extJs + "\n" + idxHtml +
                    "\n\n请确认 Windhawk 已安装到默认路径（C:\\Program Files\\Windhawk），" +
                    "或设置环境变量 WINDHAWK_PATH 指向安装目录。",
                    "Windhawk Mod 翻译器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            // 1. 备份原文件
            string bak = Path.Combine(exeDir, "backup");
            Directory.CreateDirectory(bak);
            string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            File.Copy(extJs, Path.Combine(bak, "extension.js." + stamp + ".bak"), true);
            File.Copy(idxHtml, Path.Combine(bak, "index.html." + stamp + ".bak"), true);
            msgs.AppendLine("[OK] 已备份原文件 → backup\\" + stamp);

            // 2. 部署 translate.js（从内嵌资源提取）
            using (Stream rs = Assembly.GetExecutingAssembly().GetManifestResourceStream(RESOURCE_JS))
            {
                if (rs == null)
                {
                    MessageBox.Show("安装器内部资源缺失（translate.js 未嵌入）。", "Windhawk Mod 翻译器",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
                using (Stream f = File.Create(Path.Combine(webviewDir, "translate.js")))
                {
                    rs.CopyTo(f);
                }
            }
            msgs.AppendLine("[OK] translate.js 已部署");

            // 3. 注入 index.html（幂等）
            string html = File.ReadAllText(idxHtml);
            if (html.Contains("translate.js"))
            {
                msgs.AppendLine("[--] index.html 已包含 translate.js，跳过");
            }
            else
            {
                string tag = "<script src=\"translate.js\"></script>" + Environment.NewLine + "</body>";
                html = html.Replace("</body>", tag);
                File.WriteAllText(idxHtml, html);
                msgs.AppendLine("[OK] index.html 注入完成");
            }

            // 4. 修改 extension.js 的 CSP 放行翻译 API 域名（幂等；https: 通配支持任意 AI API 域名）
            string ext = File.ReadAllText(extJs);
            string oldCsp = "connect-src ${a.cspSource} https://mods.windhawk.net https://ramensoftware.com";
            string oldList = " https://translate.googleapis.com https://cn.bing.com https://www.bing.com https://edge.microsoft.com https://api-edge.cognitive.microsofttranslator.com https://api.mymemory.translated.net";
            string newCsp = oldCsp + " https:";
            if (ext.Contains(newCsp))
            {
                msgs.AppendLine("[--] extension.js CSP 已放行翻译域名，跳过");
            }
            else if (ext.Contains(oldCsp + oldList))
            {
                ext = ext.Replace(oldCsp + oldList, newCsp);
                File.WriteAllText(extJs, ext);
                msgs.AppendLine("[OK] extension.js CSP 已更新（收拢为 https:）");
            }
            else if (ext.Contains(oldCsp))
            {
                ext = ext.Replace(oldCsp, newCsp);
                File.WriteAllText(extJs, ext);
                msgs.AppendLine("[OK] extension.js CSP 修改完成");
            }
            else
            {
                msgs.AppendLine("[!!] 未找到预期的 CSP 片段，当前 Windhawk 版本代码结构可能已变化，请手动检查");
            }

            msgs.AppendLine();
            msgs.AppendLine("安装完成！");
            msgs.AppendLine("请完全退出 Windhawk（托盘图标右键 → Exit）后重新打开，");
            msgs.AppendLine("进入任一 Mod 的详情页，英文介绍会自动翻译为中文。");
            if (silent)
            {
                File.WriteAllText(Path.Combine(exeDir, "install.log"), msgs.ToString());
            }
            else
            {
                MessageBox.Show(msgs.ToString(), "Windhawk Mod 翻译器", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            return 0;
        }
        catch (Exception ex)
        {
            if (silent)
            {
                try { File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "install.log"), "安装失败：" + ex.Message); } catch { }
            }
            else
            {
                MessageBox.Show("安装失败：" + ex.Message, "Windhawk Mod 翻译器",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return 1;
        }
    }
}
