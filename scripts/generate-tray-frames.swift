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
    MotionFrame(offsetX: 0.0, offsetY: -2.8, rotation: 0.0),
    MotionFrame(offsetX: -1.8, offsetY: 0.8, rotation: -5.2),
    MotionFrame(offsetX: -2.8, offsetY: 4.6, rotation: -8.5),
    MotionFrame(offsetX: -1.4, offsetY: 6.5, rotation: -4.8),
    MotionFrame(offsetX: 0.6, offsetY: 5.2, rotation: 1.8),
    MotionFrame(offsetX: 2.6, offsetY: 2.5, rotation: 7.8),
    MotionFrame(offsetX: 2.5, offsetY: -0.4, rotation: 6.2),
    MotionFrame(offsetX: 1.0, offsetY: -2.2, rotation: 2.0),
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
        operation: NSCompositingOperation.sourceOver,
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
