import AppKit
import Foundation

struct MotionFrame {
    let amount: CGFloat
}

let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let resources = projectRoot.appendingPathComponent("apps/desktop/resources")
let sourceURL = resources.appendingPathComponent("trace-tray-spirit.png")
let frames = [
    MotionFrame(amount: 0.0),
    MotionFrame(amount: 0.7),
    MotionFrame(amount: 1.0),
    MotionFrame(amount: 0.7),
    MotionFrame(amount: 0.0),
    MotionFrame(amount: -0.7),
    MotionFrame(amount: -1.0),
    MotionFrame(amount: -0.7),
]

guard
    let sourceData = try? Data(contentsOf: sourceURL),
    let sourceBitmap = NSBitmapImageRep(data: sourceData)
else {
    fputs("Unable to decode \(sourceURL.path)\n", stderr)
    exit(1)
}

func smoothstep(_ value: CGFloat) -> CGFloat {
    let t = min(1, max(0, value))
    return t * t * (3 - 2 * t)
}

func sampleSource(x: Int, y: CGFloat) -> NSColor {
    let clampedY = min(CGFloat(sourceBitmap.pixelsHigh - 1), max(0, y))
    let y0 = Int(floor(clampedY))
    let y1 = min(sourceBitmap.pixelsHigh - 1, y0 + 1)
    let fraction = clampedY - CGFloat(y0)
    let first = sourceBitmap.colorAt(x: x, y: y0)?.usingColorSpace(.deviceRGB) ?? .clear
    let second = sourceBitmap.colorAt(x: x, y: y1)?.usingColorSpace(.deviceRGB) ?? .clear

    return NSColor(
        deviceRed: first.redComponent + (second.redComponent - first.redComponent) * fraction,
        green: first.greenComponent + (second.greenComponent - first.greenComponent) * fraction,
        blue: first.blueComponent + (second.blueComponent - first.blueComponent) * fraction,
        alpha: first.alphaComponent + (second.alphaComponent - first.alphaComponent) * fraction
    )
}

for (index, frame) in frames.enumerated() {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 64,
        pixelsHigh: 64,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bitmapFormat: .alphaNonpremultiplied,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fputs("Unable to allocate frame \(index)\n", stderr)
        exit(1)
    }

    bitmap.size = NSSize(width: 64, height: 64)

    for y in 0..<bitmap.pixelsHigh {
        for x in 0..<bitmap.pixelsWide {
            // Keep the head, face and arms pixel-identical across every frame.
            // The deformation fades in below y=39 and reaches its maximum only
            // at the skirt edge, so the icon never bobs or rotates as a whole.
            let verticalWeight = smoothstep((CGFloat(y) - 39) / 17)
            let horizontalWeight = smoothstep((CGFloat(x) - 15) / 5)
                * smoothstep((51 - CGFloat(x)) / 5)
            let skirtWave = sin((CGFloat(x) - 10) / 44 * .pi * 2)
            let displacement = frame.amount * 3.2 * skirtWave
                * verticalWeight * horizontalWeight
            bitmap.setColor(sampleSource(x: x, y: CGFloat(y) - displacement), atX: x, y: y)
        }
    }

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fputs("Unable to encode frame \(index)\n", stderr)
        exit(1)
    }
    let outputURL = resources.appendingPathComponent("trace-tray-frame-\(index).png")
    try png.write(to: outputURL, options: .atomic)
}

print("Generated \(frames.count) tray animation frames in \(resources.path)")
