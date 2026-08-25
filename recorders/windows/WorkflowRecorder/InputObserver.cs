using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using System.Windows.Automation;

namespace Trace.WorkflowRecorder;

internal sealed class InputObserver : IDisposable
{
    private const int WhKeyboardLl = 13;
    private const int WhMouseLl = 14;
    private const int WmKeyDown = 0x0100;
    private const int WmSysKeyDown = 0x0104;
    private const int WmLButtonDown = 0x0201;
    private const int WmRButtonDown = 0x0204;
    private const int WmMButtonDown = 0x0207;
    private const int WmMouseWheel = 0x020A;

    private readonly Action<CaptureEvent> onEvent;
    private readonly object gate = new();
    private readonly HookProc keyboardProc;
    private readonly HookProc mouseProc;
    private Thread? hookThread;
    private nint keyboardHook;
    private nint mouseHook;
    private uint hookThreadId;
    private string sessionId = string.Empty;
    private HashSet<string> excludedApplicationIds = [];
    private HashSet<string> excludedWindowTitleHashes = [];
    private string? lastApplicationId;

    public InputObserver(Action<CaptureEvent> onEvent)
    {
        this.onEvent = onEvent;
        keyboardProc = KeyboardCallback;
        mouseProc = MouseCallback;
    }

    public void UpdatePolicy(IEnumerable<string> applicationIds, IEnumerable<string> windowTitleHashes)
    {
        lock (gate)
        {
            excludedApplicationIds = applicationIds.ToHashSet(StringComparer.OrdinalIgnoreCase);
            excludedWindowTitleHashes = windowTitleHashes.ToHashSet(StringComparer.OrdinalIgnoreCase);
        }
    }

    public void Start(string activeSessionId)
    {
        Stop();
        lock (gate) sessionId = activeSessionId;
        hookThread = new Thread(HookLoop) { IsBackground = true, Name = "Trace input observer" };
        hookThread.SetApartmentState(ApartmentState.STA);
        hookThread.Start();
    }

    public void Stop()
    {
        if (hookThreadId != 0) PostThreadMessage(hookThreadId, 0x0012, 0, 0);
        hookThread?.Join(TimeSpan.FromSeconds(1));
        hookThread = null;
        hookThreadId = 0;
    }

    private void HookLoop()
    {
        hookThreadId = GetCurrentThreadId();
        keyboardHook = SetWindowsHookEx(WhKeyboardLl, keyboardProc, 0, 0);
        mouseHook = SetWindowsHookEx(WhMouseLl, mouseProc, 0, 0);
        while (GetMessage(out var message, 0, 0, 0) > 0)
        {
            TranslateMessage(ref message);
            DispatchMessage(ref message);
        }
        if (keyboardHook != 0) UnhookWindowsHookEx(keyboardHook);
        if (mouseHook != 0) UnhookWindowsHookEx(mouseHook);
        keyboardHook = 0;
        mouseHook = 0;
    }

    private nint KeyboardCallback(int code, nint message, nint data)
    {
        if (code >= 0 && ((int)message == WmKeyDown || (int)message == WmSysKeyDown))
        {
            var keyboard = Marshal.PtrToStructure<KbdLlHookStruct>(data);
            Emit("key-down", null, (int)keyboard.VirtualKey, FocusedTarget());
        }
        return CallNextHookEx(keyboardHook, code, message, data);
    }

    private nint MouseCallback(int code, nint message, nint data)
    {
        if (code >= 0 && ((int)message is WmLButtonDown or WmRButtonDown or WmMButtonDown or WmMouseWheel))
        {
            var mouse = Marshal.PtrToStructure<MouseLlHookStruct>(data);
            var point = new CapturePoint(mouse.Point.X, mouse.Point.Y);
            var eventType = (int)message switch
            {
                WmLButtonDown => "mouse-left-down",
                WmRButtonDown => "mouse-right-down",
                WmMButtonDown => "mouse-other-down",
                _ => "scroll"
            };
            Emit(eventType, point, null, TargetAt(mouse.Point.X, mouse.Point.Y));
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }

    private void Emit(string eventType, CapturePoint? pointer, int? keyCode, SemanticTarget? target)
    {
        var (applicationId, applicationName) = ForegroundApplication();
        lock (gate)
        {
            if (string.IsNullOrEmpty(sessionId) || (applicationId is not null && excludedApplicationIds.Contains(applicationId))) return;
            if (target?.WindowTitleHash is not null && excludedWindowTitleHashes.Contains(target.WindowTitleHash)) return;

            if (!string.Equals(lastApplicationId, applicationId, StringComparison.OrdinalIgnoreCase))
            {
                lastApplicationId = applicationId;
                onEvent(CreateEvent("application-activated", applicationId, applicationName, null, null, null));
            }
            onEvent(CreateEvent(eventType, applicationId, applicationName, pointer, keyCode, target));
        }
    }

    private CaptureEvent CreateEvent(string eventType, string? applicationId, string? applicationName, CapturePoint? pointer, int? keyCode, SemanticTarget? target) =>
        new(
            Guid.NewGuid().ToString(),
            DateTimeOffset.UtcNow.ToString("O"),
            sessionId,
            applicationId,
            applicationName,
            eventType,
            pointer,
            keyCode,
            (ulong)System.Windows.Forms.Control.ModifierKeys,
            target,
            new Dictionary<string, string>());

    private static SemanticTarget? TargetAt(double x, double y)
    {
        try { return BuildTarget(AutomationElement.FromPoint(new System.Windows.Point(x, y))); }
        catch (ElementNotAvailableException) { return null; }
    }

    private static SemanticTarget? FocusedTarget()
    {
        try { return BuildTarget(AutomationElement.FocusedElement); }
        catch (ElementNotAvailableException) { return null; }
    }

    private static SemanticTarget? BuildTarget(AutomationElement? element)
    {
        if (element is null) return null;
        try
        {
            var current = element.Current;
            var rectangle = current.BoundingRectangle;
            var windowTitle = FindWindowTitle(element);
            return new SemanticTarget(
                current.ControlType?.ProgrammaticName,
                current.LocalizedControlType,
                current.AutomationId,
                Hash(current.Name),
                Hash(windowTitle),
                rectangle.IsEmpty ? null : new CaptureBounds(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height));
        }
        catch (ElementNotAvailableException) { return null; }
    }

    private static string? FindWindowTitle(AutomationElement element)
    {
        var current = element;
        for (var depth = 0; depth < 12 && current is not null; depth++)
        {
            if (current.Current.ControlType == ControlType.Window) return current.Current.Name;
            current = TreeWalker.ControlViewWalker.GetParent(current);
        }
        return null;
    }

    private static string? Hash(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }

    private static (string?, string?) ForegroundApplication()
    {
        var window = GetForegroundWindow();
        _ = GetWindowThreadProcessId(window, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return (process.ProcessName, process.MainModule?.FileVersionInfo.FileDescription ?? process.ProcessName);
        }
        catch { return (null, null); }
    }

    public void Dispose() => Stop();

    private delegate nint HookProc(int code, nint message, nint data);
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseLlHookStruct { public NativePoint Point; public uint MouseData; public uint Flags; public uint Time; public nint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct KbdLlHookStruct { public uint VirtualKey; public uint ScanCode; public uint Flags; public uint Time; public nint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeMessage { public nint Window; public uint Message; public nuint WParam; public nint LParam; public uint Time; public NativePoint Point; }

    [DllImport("user32.dll")] private static extern nint SetWindowsHookEx(int hookId, HookProc callback, nint module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("user32.dll")] private static extern int GetMessage(out NativeMessage message, nint window, uint minimum, uint maximum);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref NativeMessage message);
    [DllImport("user32.dll")] private static extern nint DispatchMessage(ref NativeMessage message);
    [DllImport("user32.dll")] private static extern bool PostThreadMessage(uint threadId, uint message, nuint wParam, nint lParam);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
}
