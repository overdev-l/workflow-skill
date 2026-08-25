import AppKit
import Foundation

struct MotionFrame {
    let offsetX: CGFloat
    let offsetY: CGFloat
    let rotation: CGFloat
}

let projectRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let resources = projectRoot.appendingPathComponent("apps/desktop/resources")
let sourceURL = resources.appendingPathComponent("trace-tray-spirit.png")
let frames = [
    MotionFrame(offsetX: 0, offsetY: 0, rotation: 0),
    MotionFrame(offsetX: -0.4, offsetY: 1.4, rotation: -2.2),
    MotionFrame(offsetX: -0.7, offsetY: 2.7, rotation: -3.8),
    MotionFrame(offsetX: -0.3, offsetY: 3.4, rotation: -2.0),
    MotionFrame(offsetX: 0.4, offsetY: 2.7, rotation: 1.8),
    MotionFrame(offsetX: 0.7, offsetY: 1.4, rotation: 3.7),
    MotionFrame(offsetX: 0.4, offsetY: 0, rotation: 2.0),
    MotionFrame(offsetX: 0, offsetY: -0.7, rotation: 0),
]

guard let source = NSImage(contentsOf: sourceURL) else {
    fputs("Unable to load \(sourceURL.path)\n", stderr)
    exit(1)
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
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fputs("Unable to allocate frame \(index)\n", stderr)
        exit(1)
    }

    bitmap.size = NSSize(width: 64, height: 64)
    NSGraphicsContext.saveGraphicsState()
    guard let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        fputs("Unable to create graphics context for frame \(index)\n", stderr)
        exit(1)
    }
    NSGraphicsContext.current = graphics
    graphics.cgContext.clear(CGRect(x: 0, y: 0, width: 64, height: 64))
    graphics.imageInterpolation = .high
    graphics.cgContext.translateBy(x: 32 + frame.offsetX, y: 32 + frame.offsetY)
    graphics.cgContext.rotate(by: frame.rotation * .pi / 180)
    source.draw(
        in: NSRect(x: -27, y: -27, width: 54, height: 54),
        from: NSRect(origin: .zero, size: source.size),
        operation: .sourceOver,
        fraction: 1
    )
    NSGraphicsContext.restoreGraphicsState()

    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        fputs("Unable to encode frame \(index)\n", stderr)
        exit(1)
    }
    let outputURL = resources.appendingPathComponent("trace-tray-frame-\(index).png")
    try png.write(to: outputURL, options: .atomic)
}

print("Generated \(frames.count) tray animation frames in \(resources.path)")
