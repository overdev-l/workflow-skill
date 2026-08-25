using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;

namespace Trace.WorkflowRecorder;

internal sealed class WindowsCaptureObserver : IDisposable
{
    private readonly Action<FrameSample> onFrame;
    private readonly object gate = new();
    private Direct3DDeviceBundle? device;
    private Direct3D11CaptureFramePool? framePool;
    private GraphicsCaptureSession? session;
    private GraphicsCaptureItem? item;
    private int frameCount;
    private DateTimeOffset lastEmittedAt = DateTimeOffset.MinValue;

    public bool IsSupported => GraphicsCaptureSession.IsSupported();
    public bool HasCaptureTarget => item is not null;

    public WindowsCaptureObserver(Action<FrameSample> onFrame)
    {
        this.onFrame = onFrame;
    }

    public async Task<bool> SelectTargetAsync(nint ownerWindowHandle)
    {
        if (!IsSupported) return false;
        var picker = new GraphicsCapturePicker();
        WinRT.Interop.InitializeWithWindow.Initialize(picker, ownerWindowHandle);
        var selectedItem = await picker.PickSingleItemAsync();
        if (selectedItem is null) return false;
        item = selectedItem;
        item.Closed += OnItemClosed;
        return true;
    }

    public void Start()
    {
        lock (gate)
        {
            if (session is not null) return;
            if (item is null) throw new InvalidOperationException("A capture target must be selected first");

            device ??= Direct3D11Helper.CreateDevice();
            framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device.ProjectedDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                item.Size);
            framePool.FrameArrived += OnFrameArrived;
            session = framePool.CreateCaptureSession(item);
            session.IsCursorCaptureEnabled = true;
            session.StartCapture();
        }
    }

    public void Pause()
    {
        lock (gate)
        {
            session?.Dispose();
            session = null;
            if (framePool is not null) framePool.FrameArrived -= OnFrameArrived;
            framePool?.Dispose();
            framePool = null;
        }
    }

    private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
    {
        using var frame = sender.TryGetNextFrame();
        var currentFrame = Interlocked.Increment(ref frameCount);
        var now = DateTimeOffset.UtcNow;
        if (now - lastEmittedAt < TimeSpan.FromSeconds(1)) return;
        lastEmittedAt = now;
        onFrame(new FrameSample(currentFrame, frame.ContentSize.Width, frame.ContentSize.Height, null, null));
    }

    private void OnItemClosed(GraphicsCaptureItem sender, object args)
    {
        Pause();
        item = null;
    }

    public void Dispose()
    {
        Pause();
        item = null;
        device?.Dispose();
        device = null;
    }
}
