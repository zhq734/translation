// Windows UIA 选区直读 helper。
//
// 常驻进程，通过 stdin/stdout 行分隔 JSON 与宿主通信：
//   请求: {"id":1,"method":"readSelection"}
//   响应: {"id":1,"status":"present","text":"..."}
//
// 三级读取链：
//   1. 焦点控件的 TextPattern.GetSelection 获取选区文本
//   2. WM_COPY 向焦点控件发送复制消息
//   3. （宿主层负责全局 Ctrl+C 兜底，本 helper 不处理）
//
// 编译: csc.exe /target:exe /out:windows-uia-reader.exe Program.cs
// 需要引用 UIAutomationClient 与 UIAutomationTypes 程序集。
//
// @author zhenghq

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace WindowsUiaReader
{
    /// <summary>
    /// Windows UIA 选区直读 helper 主程序。
    /// 常驻运行，逐行读取 stdin 的 JSON 请求，通过 UI Automation 读取选区文本。
    /// </summary>
    /// <author>zhenghq</author>
    internal static class Program
    {
        /// <summary>
        /// 程序入口：启动 stdin 读取循环，逐行处理 readSelection 请求。
        /// </summary>
        /// <param name="args">命令行参数（未使用）。</param>
        /// <author>zhenghq</author>
        private static void Main(string[] args)
        {
            // 设置标准输入/输出为 UTF-8，避免编码问题。
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            string? line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0)
                {
                    continue;
                }

                ReadRequest? request = null;
                try
                {
                    request = ParseRequest(line);
                }
                catch
                {
                    // 无法解析的行直接跳过。
                    continue;
                }

                if (request == null)
                {
                    continue;
                }

                if (request.method != "readSelection")
                {
                    Respond(request.id, "unknown", null, "unsupported-method");
                    continue;
                }

                try
                {
                    var (status, text, reason) = ReadSelectionViaUia();
                    Respond(request.id, status, text, reason);
                }
                catch (Exception ex)
                {
                    Respond(request.id, "unknown", null, "exception: " + ex.Message);
                }
            }
        }

        /// <summary>
        /// 解析一行 JSON 请求，提取 id 与 method 字段。
        /// </summary>
        /// <param name="line">单行 JSON 文本。</param>
        /// <returns>解析出的请求对象；字段缺失时返回 null。</returns>
        /// <author>zhenghq</author>
        private static ReadRequest? ParseRequest(string line)
        {
            // 使用 System.Text.Json（.NET 4.7.2 无内置，手动解析）。
            int id = -1;
            string method = "";

            // 简单 JSON 解析：查找 "id" 和 "method" 字段。
            var matchId = System.Text.RegularExpressions.Regex.Match(
                line, @"""id""\s*:\s*(\d+)");
            if (matchId.Success)
            {
                id = int.Parse(matchId.Groups[1].Value);
            }

            var matchMethod = System.Text.RegularExpressions.Regex.Match(
                line, @"""method""\s*:\s*""([^""]+)""");
            if (matchMethod.Success)
            {
                method = matchMethod.Groups[1].Value;
            }

            if (id < 0)
            {
                return null;
            }

            return new ReadRequest { id = id, method = method };
        }

        /// <summary>
        /// 通过 UI Automation 读取当前焦点控件的选区文本。
        /// 优先使用 TextPattern.GetSelection，失败时尝试 WM_COPY。
        /// </summary>
        /// <returns>读取结果元组：状态、文本、失败原因。</returns>
        /// <author>zhenghq</author>
        private static (string status, string? text, string? reason) ReadSelectionViaUia()
        {
            // 获取焦点元素。
            AutomationElement? focusedElement = null;
            try
            {
                focusedElement = AutomationElement.FocusedElement;
            }
            catch
            {
                return ("unknown", null, "no-focus");
            }

            if (focusedElement == null)
            {
                return ("unknown", null, "no-focus");
            }

            // 第一级：TextPattern.GetSelection。
            try
            {
                var pattern = focusedElement.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                if (pattern != null)
                {
                    var selections = pattern.GetSelection();
                    if (selections != null && selections.Count > 0)
                    {
                        var sb = new StringBuilder();
                        foreach (TextPatternRange range in selections)
                        {
                            sb.Append(range.GetText(-1));
                        }

                        string text = sb.ToString();
                        if (text.Length > 0)
                        {
                            return ("present", text, null);
                        }

                        // 有选区但文本为空，确认有选区。
                        return ("empty", null, null);
                    }

                    // TextPattern 存在但无选区。
                    return ("empty", null, null);
                }
            }
            catch
            {
                // TextPattern 不可用，继续尝试下一级。
            }

            // 第二级：WM_COPY 向焦点控件发送复制消息。
            string? copyText = TryWmCopy(focusedElement);
            if (copyText != null)
            {
                if (copyText.Length > 0)
                {
                    return ("present", copyText, null);
                }

                return ("empty", null, null);
            }

            // 两级均失败，返回 unknown 让宿主降级到全局 Ctrl+C。
            return ("unknown", null, "no-text-pattern");
        }

        /// <summary>
        /// 向焦点控件发送 WM_COPY 消息并从剪贴板读取结果。
        /// </summary>
        /// <param name="element">焦点控件。</param>
        /// <returns>读取到的文本；不可用时返回 null。</returns>
        /// <author>zhenghq</author>
        private static string? TryWmCopy(AutomationElement element)
        {
            try
            {
                IntPtr hwnd = GetHandleFromElement(element);
                if (hwnd == IntPtr.Zero)
                {
                    return null;
                }

                // 记录旧剪贴板内容以便恢复。
                string? oldClipboard = null;
                try
                {
                    oldClipboard = Clipboard.GetText();
                }
                catch
                {
                    // 剪贴板不可读时忽略。
                }

                // 清空剪贴板。
                Clipboard.Clear();

                // 发送 WM_COPY。
                SendMessageTimeout(hwnd, WM_COPY, IntPtr.Zero, IntPtr.Zero,
                    SMTO_BLOCK, 500, out IntPtr result);

                // 等待剪贴板内容出现（轮询 200ms）。
                string? text = null;
                for (int i = 0; i < 20; i++)
                {
                    Thread.Sleep(10);
                    try
                    {
                        if (Clipboard.ContainsText())
                        {
                            text = Clipboard.GetText();
                            break;
                        }
                    }
                    catch
                    {
                        // 剪贴板异常时继续轮询。
                    }
                }

                // 恢复旧剪贴板内容。
                try
                {
                    Clipboard.Clear();
                    if (oldClipboard != null)
                    {
                        Clipboard.SetText(oldClipboard);
                    }
                }
                catch
                {
                    // 恢复失败时忽略。
                }

                return text;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 从 AutomationElement 获取原生窗口句柄。
        /// </summary>
        /// <param name="element">UI Automation 元素。</param>
        /// <returns>窗口句柄；获取失败时返回 IntPtr.Zero。</returns>
        /// <author>zhenghq</author>
        private static IntPtr GetHandleFromElement(AutomationElement element)
        {
            try
            {
                object? hwndObj = element.GetCurrentPropertyValue(AutomationElement.NativeWindowHandleProperty);
                if (hwndObj is int handleInt)
                {
                    return new IntPtr(handleInt);
                }

                if (hwndObj is long handleLong)
                {
                    return new IntPtr(handleLong);
                }
            }
            catch
            {
                // 获取句柄失败时返回零。
            }

            return IntPtr.Zero;
        }

        /// <summary>
        /// 向 stdout 输出一行 JSON 响应。
        /// </summary>
        /// <param name="id">请求标识。</param>
        /// <param name="status">直读状态。</param>
        /// <param name="text">读到的文本（可选）。</param>
        /// <param name="reason">失败原因（可选）。</param>
        /// <author>zhenghq</author>
        private static void Respond(int id, string status, string? text, string? reason)
        {
            var sb = new StringBuilder();
            sb.Append('{');
            sb.Append("\"id\":").Append(id).Append(',');
            sb.Append("\"status\":\"").Append(EscapeJson(status)).Append('"');
            if (text != null)
            {
                sb.Append(",\"text\":\"").Append(EscapeJson(text)).Append('"');
            }

            if (reason != null)
            {
                sb.Append(",\"reason\":\"").Append(EscapeJson(reason)).Append('"');
            }

            sb.Append('}');
            Console.WriteLine(sb.ToString());
            Console.Out.Flush();
        }

        /// <summary>
        /// 转义 JSON 字符串中的特殊字符。
        /// </summary>
        /// <param name="s">待转义的文本。</param>
        /// <returns>转义后的 JSON 字符串值（不含外层引号）。</returns>
        /// <author>zhenghq</author>
        private static string EscapeJson(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20)
                        {
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        }
                        else
                        {
                            sb.Append(c);
                        }

                        break;
                }
            }

            return sb.ToString();
        }

        // Win32 API 声明。

        private const uint WM_COPY = 0x0301;
        private const uint SMTO_BLOCK = 0x0001;

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SendMessageTimeout(
            IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    }

    /// <summary>
    /// 从 stdin 解析的取词请求。
    /// </summary>
    /// <author>zhenghq</author>
    internal class ReadRequest
    {
        /// <summary>请求标识，用于响应配对。</summary>
        public int id;

        /// <summary>方法名，当前仅支持 readSelection。</summary>
        public string method = "";
    }
}
