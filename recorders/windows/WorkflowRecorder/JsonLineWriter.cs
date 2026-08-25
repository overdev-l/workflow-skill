using System.Text.Json;

namespace Trace.WorkflowRecorder;

internal sealed class JsonLineWriter
{
    private readonly object gate = new();
    private readonly JsonSerializerOptions options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    public void Send<T>(string type, T payload)
    {
        var envelope = new RecorderEnvelope<T>(1, type, DateTimeOffset.UtcNow.ToString("O"), payload);
        var line = JsonSerializer.Serialize(envelope, options);
        lock (gate) Console.Out.WriteLine(line);
    }
}
