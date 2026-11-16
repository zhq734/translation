// Windows UIA 选区直读 helper。
//
// 常驻进程，通过 stdin/stdout 行分隔 JSON 与宿主通信：
//   请求: {"id":1,"method":"readSelection"}
//   响应: {"id":1,"status":"present","text":"..."}
//
// 读取链：
//   1. 焦点控件的 TextPattern.GetSelection 获取选区文本
//   2. 无 TextPattern 时返回 unknown，不接触剪贴板
//   3. 宿主复制事务负责 WM_COPY 与全局 Ctrl+C 兜底
//
// 编译目标为 .NET Framework 4.x 的 C# 5，确保 Windows 7 SP1 自带的旧版 csc.exe
// 也能生成 helper。源码本身不依赖 System.Text.Json 或新语法。
//
// @author zhenghq

using System;
using System.Text;
using System.Text.RegularExpressions;
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
        [STAThread]
        private static void Main(string[] args)
        {
            // 设置标准输入/输出为 UTF-8，避免中文取词出现乱码。
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0)
                {
                    continue;
                }

                ReadRequest request;
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
                    ReadSelectionResult result = ReadSelectionViaUia();
                    Respond(request.id, result.status, result.text, result.reason);
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
        private static ReadRequest ParseRequest(string line)
        {
            int id = -1;
            string method = string.Empty;

            // 宿主只发送固定结构的单行 JSON，使用轻量正则避免引入 JSON 库。
            Match matchId = Regex.Match(line, @"""id""\s*:\s*(\d+)");
            if (matchId.Success)
            {
                id = int.Parse(matchId.Groups[1].Value);
            }

            Match matchMethod = Regex.Match(line, @"""method""\s*:\s*""([^""]+)""");
            if (matchMethod.Success)
            {
                method = matchMethod.Groups[1].Value;
            }

            if (id < 0)
            {
                return null;
            }

            ReadRequest request = new ReadRequest();
            request.id = id;
            request.method = method;
            return request;
        }

        /// <summary>
        /// 通过 UI Automation 读取当前焦点控件的选区文本。
        /// 仅使用 TextPattern.GetSelection；失败时返回 unknown 交给宿主复制事务。
        /// </summary>
        /// <returns>包含状态、文本与失败原因的读取结果。</returns>
        /// <author>zhenghq</author>
        private static ReadSelectionResult ReadSelectionViaUia()
        {
            AutomationElement focusedElement;
            try
            {
                focusedElement = AutomationElement.FocusedElement;
            }
            catch
            {
                return ReadSelectionResult.Create("unknown", null, "no-focus");
            }

            if (focusedElement == null)
            {
                return ReadSelectionResult.Create("unknown", null, "no-focus");
            }

            // 第一级：TextPattern.GetSelection。
            try
            {
                TextPattern pattern = focusedElement.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                if (pattern != null)
                {
                    TextPatternRange[] selections = pattern.GetSelection();
                    if (selections != null && selections.Length > 0)
                    {
                        StringBuilder builder = new StringBuilder();
                        foreach (TextPatternRange range in selections)
                        {
                            builder.Append(range.GetText(-1));
                        }

                        string selectedText = builder.ToString();
                        if (selectedText.Length > 0)
                        {
                            return ReadSelectionResult.Create("present", selectedText, null);
                        }

                        return ReadSelectionResult.Create("empty", null, null);
                    }

                    return ReadSelectionResult.Create("empty", null, null);
                }
            }
            catch
            {
                // TextPattern 不可用，返回 unknown；后台预取不得清空或恢复剪贴板。
            }

            // 纯只读 helper 不发送复制消息，避免过期预取覆盖宿主剪贴板哨兵。
            return ReadSelectionResult.Create("unknown", null, "no-text-pattern");
        }

        /// <summary>
        /// 向 stdout 输出一行 JSON 响应。
        /// </summary>
        /// <param name="id">请求标识。</param>
        /// <param name="status">直读状态。</param>
        /// <param name="text">读到的文本（可选）。</param>
        /// <param name="reason">失败原因（可选）。</param>
        /// <author>zhenghq</author>
        private static void Respond(int id, string status, string text, string reason)
        {
            StringBuilder builder = new StringBuilder();
            builder.Append('{');
            builder.Append("\"id\":").Append(id).Append(',');
            builder.Append("\"status\":\"").Append(EscapeJson(status)).Append('"');
            if (text != null)
            {
                builder.Append(",\"text\":\"").Append(EscapeJson(text)).Append('"');
            }

            if (reason != null)
            {
                builder.Append(",\"reason\":\"").Append(EscapeJson(reason)).Append('"');
            }

            builder.Append('}');
            Console.WriteLine(builder.ToString());
            Console.Out.Flush();
        }

        /// <summary>
        /// 转义 JSON 字符串中的特殊字符。
        /// </summary>
        /// <param name="value">待转义的文本。</param>
        /// <returns>转义后的 JSON 字符串值（不含外层引号）。</returns>
        /// <author>zhenghq</author>
        private static string EscapeJson(string value)
        {
            StringBuilder builder = new StringBuilder();
            foreach (char character in value)
            {
                switch (character)
                {
                    case '\\': builder.Append("\\\\"); break;
                    case '"': builder.Append("\\\""); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u").Append(((int)character).ToString("x4"));
                        }
                        else
                        {
                            builder.Append(character);
                        }

                        break;
                }
            }

            return builder.ToString();
        }


    }

    /// <summary>
    /// 从 stdin 解析的取词请求。
    /// </summary>
    /// <author>zhenghq</author>
    internal sealed class ReadRequest
    {
        /// <summary>请求标识，用于响应配对。</summary>
        public int id;

        /// <summary>方法名，当前仅支持 readSelection。</summary>
        public string method = string.Empty;
    }

    /// <summary>
    /// UIA 直读结果，替代 C# 7 元组以兼容旧版 csc.exe。
    /// </summary>
    /// <author>zhenghq</author>
    internal sealed class ReadSelectionResult
    {
        /// <summary>直读状态。</summary>
        public string status;

        /// <summary>读取到的文本；不可用时为 null。</summary>
        public string text;

        /// <summary>失败原因；成功时为 null。</summary>
        public string reason;

        /// <summary>
        /// 创建不可变语义的读取结果实例。
        /// </summary>
        /// <param name="status">直读状态。</param>
        /// <param name="text">读取到的文本。</param>
        /// <param name="reason">失败原因。</param>
        /// <returns>新的读取结果。</returns>
        /// <author>zhenghq</author>
        public static ReadSelectionResult Create(string status, string text, string reason)
        {
            ReadSelectionResult result = new ReadSelectionResult();
            result.status = status;
            result.text = text;
            result.reason = reason;
            return result;
        }
    }
}
