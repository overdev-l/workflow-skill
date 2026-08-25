using System.Text.Json;

namespace Trace.WorkflowRecorder;

internal static class Program
{
    [STAThread]
    private static async Task Main(string[] args)
    {
        var writer = new JsonLineWriter();
        using var service = new RecorderService(writer);
        var mode = args.FirstOrDefault() ?? "status";
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        if (mode.Equals("serve", StringComparison.OrdinalIgnoreCase))
        {
            service.SendStatus();
            while (Console.ReadLine() is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var command = JsonSerializer.Deserialize<RecorderCommand>(line, options)
                        ?? throw new JsonException("Command payload was empty");
                    if (!await service.HandleAsync(command)) break;
                }
                catch (Exception error)
                {
                    writer.Send("error", new RecorderError("invalid_command", error.Message, true));
                }
            }
        }
        else
        {
            await service.HandleAsync(new RecorderCommand
            {
                Type = mode,
                SessionId = args.Skip(1).FirstOrDefault(),
                Prompt = mode.Equals("permissions", StringComparison.OrdinalIgnoreCase)
            });
        }
    }
}
