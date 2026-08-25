using System.Text.Json.Serialization;

namespace Trace.WorkflowRecorder;

internal sealed record PermissionSnapshot(bool ScreenRecording, bool Accessibility);
internal sealed record CapturePoint(double X, double Y);
internal sealed record CaptureBounds(double X, double Y, double Width, double Height);
internal sealed record SemanticTarget(
    string? Role,
    string? Subrole,
    string? Identifier,
    string? LabelHash,
    string? WindowTitleHash,
    CaptureBounds? Bounds);
internal sealed record CaptureEvent(
    string Id,
    string OccurredAt,
    string SessionId,
    string? ApplicationId,
    string? ApplicationName,
    string EventType,
    CapturePoint? Pointer,
    int? KeyCode,
    ulong? Modifiers,
    SemanticTarget? Target,
    IReadOnlyDictionary<string, string> Attributes);
internal sealed record FrameSample(int FrameNumber, int Width, int Height, uint? DisplayId, CaptureBounds? ContentRect);
internal sealed record RecorderStatus(
    int ProtocolVersion,
    string RecorderVersion,
    string Platform,
    string State,
    string? SessionId,
    string? ActiveApplication,
    int EventCount,
    int FrameCount,
    int RecordedBytes,
    PermissionSnapshot Permissions,
    string Timestamp);
internal sealed record RecorderError(string Code, string Message, bool Recoverable);

internal sealed class RecorderCommand
{
    public required string Type { get; init; }
    public string? SessionId { get; init; }
    public bool? Prompt { get; init; }
    public string? PermissionTarget { get; init; }
    public string? OwnerWindowHandle { get; init; }
    public string[]? ExcludedBundleIds { get; init; }
    public string[]? ExcludedWindowTitlePatterns { get; init; }
}

internal sealed record RecorderEnvelope<T>(
    int ProtocolVersion,
    string Type,
    string Timestamp,
    T Payload);
