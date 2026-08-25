using System.Diagnostics;

namespace Trace.WorkflowRecorder;

internal sealed class RecorderService : IDisposable
{
    private readonly JsonLineWriter writer;
    private readonly object gate = new();
    private readonly WindowsCaptureObserver screenObserver;
    private readonly InputObserver inputObserver;
    private string state = "idle";
    private string? sessionId;
    private int eventCount;
    private int frameCount;

    public RecorderService(JsonLineWriter writer)
    {
        this.writer = writer;
        screenObserver = new WindowsCaptureObserver(HandleFrame);
        inputObserver = new InputObserver(HandleEvent);
    }

    public async Task<bool> HandleAsync(RecorderCommand command)
    {
        switch (command.Type)
        {
            case "status":
                SendStatus();
                break;
            case "permissions":
                if (command.Prompt == true && !screenObserver.HasCaptureTarget)
                {
                    if (!nint.TryParse(command.OwnerWindowHandle, out var owner) || owner == 0)
                    {
                        SendError("owner_window_required", "A parent window is required for the Windows capture picker", true);
                    }
                    else if (!await screenObserver.SelectTargetAsync(owner))
                    {
                        SendError("capture_target_not_selected", "No display or window was selected", true);
                    }
                }
                writer.Send("permissions", Permissions());
                SendStatus();
                break;
            case "policy":
                inputObserver.UpdatePolicy(command.ExcludedBundleIds ?? [], command.ExcludedWindowTitlePatterns ?? []);
                SendStatus();
                break;
            case "start":
            case "resume":
                Start(command.SessionId);
                break;
            case "pause":
                Pause();
                break;
            case "stop":
                Stop();
                break;
            case "shutdown":
                Stop();
                return false;
            default:
                SendError("unknown_command", $"Unknown recorder command: {command.Type}", true);
                break;
        }
        return true;
    }

    public void SendStatus()
    {
        string currentState;
        string? currentSession;
        int currentEvents;
        int currentFrames;
        lock (gate)
        {
            currentState = state;
            currentSession = sessionId;
            currentEvents = eventCount;
            currentFrames = frameCount;
        }
        writer.Send("status", new RecorderStatus(
            1,
            "0.2.0",
            "windows",
            currentState,
            currentSession,
            ActiveProcessName(),
            currentEvents,
            currentFrames,
            0,
            Permissions(),
            DateTimeOffset.UtcNow.ToString("O")));
    }

    private PermissionSnapshot Permissions() => new(screenObserver.HasCaptureTarget, true);

    private void Start(string? requestedSessionId)
    {
        if (!screenObserver.HasCaptureTarget)
        {
            SendError("permissions_required", "Select a display or window before starting capture", true);
            SendStatus();
            return;
        }
        try
        {
            var nextSession = requestedSessionId ?? sessionId ?? Guid.NewGuid().ToString();
            screenObserver.Start();
            inputObserver.Start(nextSession);
            lock (gate)
            {
                sessionId = nextSession;
                state = "observing";
            }
            SendStatus();
        }
        catch (Exception error)
        {
            lock (gate) state = "interrupted";
            SendError("capture_start_failed", error.Message, true);
            SendStatus();
        }
    }

    private void Pause()
    {
        inputObserver.Stop();
        screenObserver.Pause();
        lock (gate) state = "paused";
        SendStatus();
    }

    private void Stop()
    {
        inputObserver.Stop();
        screenObserver.Pause();
        lock (gate)
        {
            state = "idle";
            sessionId = null;
        }
        SendStatus();
    }

    private void HandleEvent(CaptureEvent captureEvent)
    {
        lock (gate) eventCount++;
        writer.Send("capture-event", captureEvent);
    }

    private void HandleFrame(FrameSample frame)
    {
        lock (gate) frameCount = frame.FrameNumber;
        writer.Send("frame-sample", frame);
    }

    private void SendError(string code, string message, bool recoverable) =>
        writer.Send("error", new RecorderError(code, message, recoverable));

    private static string? ActiveProcessName()
    {
        try
        {
            var window = GetForegroundWindow();
            _ = GetWindowThreadProcessId(window, out var processId);
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName;
        }
        catch { return null; }
    }

    public void Dispose()
    {
        inputObserver.Dispose();
        screenObserver.Dispose();
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint processId);
}
