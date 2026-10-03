import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// 1 photo or video frame, ready to upload.
nonisolated struct PreparedFrame: Identifiable, Sendable {
    let id = UUID()
    var jpeg: Data
    /// About 360 px on the long edge, for the capture tray.
    var thumbnail: Data
    var width: Int
    var height: Int
    /// Variance of the Laplacian on a small grayscale copy. Higher is sharper.
    var sharpness: Double
}

/// Turns photos and videos into upload-ready JPEGs off the main actor.
nonisolated enum FrameTools {
    /// The server downsizes again to 1000 px for the model; 1600 keeps crops sharp.
    static let maxEdge = 1600
    static let maxFrames = 30

    /// Decodes any image the system reads (HEIC, JPEG, PNG), applies its orientation and
    /// downsizes it, without ever decoding the full-size bitmap.
    @concurrent
    static func prepare(imageData: Data) async -> PreparedFrame? {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxEdge,
              ] as CFDictionary)
        else { return nil }
        return frame(from: image)
    }

    /// Samples a video at about 1 frame a second, drops blurry frames, and keeps at most 30.
    @concurrent
    static func frames(fromVideo url: URL) async throws -> [PreparedFrame] {
        let asset = AVURLAsset(url: url)
        let seconds = try await asset.load(.duration).seconds
        guard seconds.isFinite, seconds > 0 else { return [] }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxEdge, height: maxEdge)
        let tolerance = CMTime(seconds: 0.25, preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance

        // 1 per second, from half a second in, with room for the blur filter to drop some.
        let count = min(maxFrames * 2, max(1, Int(seconds)))
        var frames: [PreparedFrame] = []
        for i in 0..<count {
            try Task.checkCancellation()
            let time = CMTime(seconds: min(Double(i) + 0.5, max(0, seconds - 0.1)), preferredTimescale: 600)
            if let image = try? await generator.image(at: time).image, let frame = frame(from: image) {
                frames.append(frame)
            }
        }
        return keepSharp(frames)
    }

    /// Drops frames far blurrier than the capture's typical frame (motion blur while panning),
    /// then thins evenly to `maxFrames`, keeping order.
    static func keepSharp(_ frames: [PreparedFrame]) -> [PreparedFrame] {
        var kept = frames
        if frames.count > 3 {
            let sorted = frames.map(\.sharpness).sorted()
            let median = sorted[sorted.count / 2]
            kept = frames.filter { $0.sharpness >= median * 0.4 }
        }
        guard kept.count > maxFrames else { return kept }
        let step = Double(kept.count) / Double(maxFrames)
        return (0..<maxFrames).map { kept[Int(Double($0) * step)] }
    }

    static func frame(from image: CGImage) -> PreparedFrame? {
        guard let jpeg = encode(image, quality: 0.82),
              let small = resized(image, maxEdge: 360),
              let thumbnail = encode(small, quality: 0.8)
        else { return nil }
        return PreparedFrame(
            jpeg: jpeg,
            thumbnail: thumbnail,
            width: image.width,
            height: image.height,
            sharpness: sharpness(of: image)
        )
    }

    static func encode(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    static func resized(_ image: CGImage, maxEdge: Int) -> CGImage? {
        let scale = min(1, Double(maxEdge) / Double(max(image.width, image.height)))
        let width = max(1, Int(Double(image.width) * scale))
        let height = max(1, Int(Double(image.height) * scale))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// Variance of a 4-neighbor Laplacian over a 160 px wide grayscale copy.
    static func sharpness(of image: CGImage) -> Double {
        let width = 160
        let height = max(3, Int(Double(image.height) * Double(width) / Double(max(image.width, 1))))
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return 0 }

        var sum = 0.0
        var sumOfSquares = 0.0
        var count = 0.0
        for y in 1..<(height - 1) {
            for x in 1..<(width - 1) {
                let i = y * width + x
                let laplacian = 4 * Double(pixels[i]) - Double(pixels[i - 1]) - Double(pixels[i + 1])
                    - Double(pixels[i - width]) - Double(pixels[i + width])
                sum += laplacian
                sumOfSquares += laplacian * laplacian
                count += 1
            }
        }
        guard count > 0 else { return 0 }
        let mean = sum / count
        return max(0, sumOfSquares / count - mean * mean)
    }
}
