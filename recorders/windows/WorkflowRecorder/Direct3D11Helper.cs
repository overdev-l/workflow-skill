using System.Runtime.InteropServices;
using Windows.Graphics.DirectX.Direct3D11;

namespace Trace.WorkflowRecorder;

internal sealed class Direct3DDeviceBundle : IDisposable
{
    public SharpDX.Direct3D11.Device NativeDevice { get; }
    public IDirect3DDevice ProjectedDevice { get; }

    public Direct3DDeviceBundle(SharpDX.Direct3D11.Device nativeDevice, IDirect3DDevice projectedDevice)
    {
        NativeDevice = nativeDevice;
        ProjectedDevice = projectedDevice;
    }

    public void Dispose()
    {
        (ProjectedDevice as IDisposable)?.Dispose();
        NativeDevice.Dispose();
    }
}

internal static class Direct3D11Helper
{
    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice", ExactSpelling = true)]
    private static extern uint CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    public static Direct3DDeviceBundle CreateDevice()
    {
        var nativeDevice = new SharpDX.Direct3D11.Device(
            SharpDX.Direct3D.DriverType.Hardware,
            SharpDX.Direct3D11.DeviceCreationFlags.BgraSupport);

        using var dxgiDevice = nativeDevice.QueryInterface<SharpDX.DXGI.Device3>();
        var result = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out var inspectable);
        if (result != 0) Marshal.ThrowExceptionForHR((int)result);

#pragma warning disable CA1416
        try
        {
            var projected = Marshal.GetObjectForIUnknown(inspectable) as IDirect3DDevice
                ?? throw new InvalidOperationException("Unable to project the Direct3D device");
            return new Direct3DDeviceBundle(nativeDevice, projected);
        }
        finally
        {
            Marshal.Release(inspectable);
        }
#pragma warning restore CA1416
    }
}
