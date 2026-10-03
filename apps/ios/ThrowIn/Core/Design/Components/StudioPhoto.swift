import CoreGraphics
import CoreImage
import CoreVideo
import ImageIO
import SwiftUI
import UIKit
import Vision

// Studio presentation for Item photos.
//
// In a trade, the photo is a promise about condition, so the user's own pixels stay the item
// photo. Studio never generates or retouches the item: Vision lifts the subject out of the
// same photo, and we place it, unchanged, on a soft canvas backdrop with a contact shadow.
// When Vision isn't sure (no subject, or a mask under 5% or over 95% of the frame), the
// original photo is what shows.

/// How `ItemArtwork` uses the studio version of its photo.
enum StudioMode {
    /// Always the original photo.
    case off
    /// The studio image when it's cached. Otherwise it's made lazily, at most 2 at a time.
    case ifReady
    /// This studio image, already made by the caller.
    case show(UIImage)
}

// MARK: - Cache

/// Studio images for this session, keyed like `ThumbnailCache` by the photo's storage path.
enum StudioCache {
    static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 120
        return cache
    }()

    /// Photos where Vision found no clean subject. We don't ask again this session.
    private static var misses: Set<NSString> = []
    private static var inFlight: [NSString: Task<StudioOutcome, Never>] = [:]

    static func cached(_ url: URL) -> UIImage? {
        images.object(forKey: ThumbnailCache.key(url))
    }

    static func hasMissed(_ url: URL) -> Bool {
        misses.contains(ThumbnailCache.key(url))
    }

    /// The studio version of this photo, making it if needed. nil means show the original.
    /// Concurrent asks for the same photo share 1 Vision pass.
    static func studio(for url: URL) async -> UIImage? {
        let key = ThumbnailCache.key(url)
        if let hit = images.object(forKey: key) { return hit }
        if misses.contains(key) { return nil }

        let task: Task<StudioOutcome, Never>
        if let running = inFlight[key] {
            task = running
        } else {
            task = Task {
                guard let original = await ThumbnailCache.image(for: url), let cgImage = original.cgImage else {
                    return .unavailable
                }
                let input = SendableCGImage(image: cgImage)
                let orientation = CGImagePropertyOrientation(original.imageOrientation)
                guard let made = await StudioRenderer.render(input, orientation: orientation) else {
                    return .noSubject
                }
                return .made(made)
            }
            inFlight[key] = task
        }

        let outcome = await task.value
        inFlight[key] = nil
        switch outcome {
        case let .made(made):
            let image = images.object(forKey: key) ?? UIImage(cgImage: made.image)
            images.setObject(image, forKey: key)
            return image
        case .noSubject:
            misses.insert(key)
            return nil
        case .unavailable:
            // A network miss, not a verdict on the photo. Try again next time.
            return nil
        }
    }
}

nonisolated enum StudioOutcome: Sendable {
    case made(SendableCGImage)
    case noSubject
    case unavailable
}

/// Keeps the Shelf grid to 2 Vision passes at a time, so a screen of cards doesn't ask for
/// a dozen at once. The detail screen skips the line.
final class StudioQueue {
    static let shared = StudioQueue()

    private let limit = 2
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if running < limit {
            running += 1
            return
        }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// Hands the slot straight to the next waiter, so `running` never goes over the limit.
    func release() {
        if waiters.isEmpty {
            running = max(0, running - 1)
        } else {
            waiters.removeFirst().resume()
        }
    }
}

// MARK: - Views

/// The soft canvas the lifted subject sits on: paper with a gentle pool of light.
struct StudioBackdrop: View {
    var body: some View {
        EllipticalGradient(
            colors: [Palette.surface, Palette.canvas],
            center: UnitPoint(x: 0.5, y: 0.42),
            startRadiusFraction: 0,
            endRadiusFraction: 0.78
        )
    }
}

/// A finished studio image on its backdrop. Fits, never crops, so the whole item shows.
struct StudioImageView: View {
    var image: UIImage

    var body: some View {
        ZStack {
            StudioBackdrop()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
        }
    }
}

/// For Shelf cards: shows the studio image once it exists, and asks for it lazily through
/// `StudioQueue`. Draws nothing until then, so the original photo underneath shows.
struct LazyStudioImage: View {
    var url: URL
    @State private var studio: UIImage?

    init(url: URL) {
        self.url = url
        _studio = State(initialValue: StudioCache.cached(url))
    }

    var body: some View {
        ZStack {
            if let studio {
                StudioImageView(image: studio)
                    .transition(.opacity)
            }
        }
        .task(id: url) {
            if let hit = StudioCache.cached(url) {
                studio = hit
                return
            }
            studio = nil
            guard !StudioCache.hasMissed(url) else { return }
            // Let the card settle (and fast scrolls pass by) before asking.
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            await StudioQueue.shared.acquire()
            defer { StudioQueue.shared.release() }
            guard !Task.isCancelled else { return }
            if let made = await StudioCache.studio(for: url) {
                withAnimation(Motion.soft) { studio = made }
            }
        }
    }
}

// MARK: - Renderer

nonisolated struct SendableCGImage: @unchecked Sendable {
    let image: CGImage
}

/// Lifts the subject with Vision and composes it, unaltered, onto a transparent square with a
/// contact shadow. The backdrop is drawn by SwiftUI so it follows light and dark mode.
nonisolated enum StudioRenderer {
    static let maxSide: CGFloat = 1200
    static let coverageRange = 0.05...0.95

    @concurrent
    static func render(_ input: SendableCGImage, orientation: CGImagePropertyOrientation) async -> SendableCGImage? {
        let context = CIContext(options: [.cacheIntermediates: false])
        var source = input.image
        if orientation != .up {
            let upright = CIImage(cgImage: source).oriented(orientation)
            guard let drawn = context.createCGImage(upright, from: upright.extent) else { return nil }
            source = drawn
        }

        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: source, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        guard let observation = request.results?.first,
              !observation.allInstances.isEmpty,
              let subject = subjectBounds(of: observation.instanceMask),
              coverageRange.contains(subject.coverage),
              let maskedBuffer = try? observation.generateMaskedImage(
                  ofInstances: observation.allInstances,
                  from: handler,
                  croppedToInstancesExtent: false
              )
        else { return nil }

        let maskedImage = CIImage(cvPixelBuffer: maskedBuffer)
        guard let masked = context.createCGImage(maskedImage, from: maskedImage.extent) else { return nil }
        let pixelRect = CGRect(
            x: subject.rect.minX * CGFloat(masked.width),
            y: subject.rect.minY * CGFloat(masked.height),
            width: subject.rect.width * CGFloat(masked.width),
            height: subject.rect.height * CGFloat(masked.height)
        )
        .integral
        .intersection(CGRect(x: 0, y: 0, width: masked.width, height: masked.height))
        guard !pixelRect.isEmpty, let cutout = masked.cropping(to: pixelRect) else { return nil }
        return compose(cutout).map(SendableCGImage.init(image:))
    }

    /// The subject's bounding box (normalized, top-left origin) and how much of the frame it
    /// covers, from Vision's instance mask, where 0 is background.
    static func subjectBounds(of mask: CVPixelBuffer) -> (rect: CGRect, coverage: Double)? {
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent8,
              let base = CVPixelBufferGetBaseAddress(mask)
        else { return nil }

        let width = CVPixelBufferGetWidth(mask)
        let height = CVPixelBufferGetHeight(mask)
        let rowBytes = CVPixelBufferGetBytesPerRow(mask)
        guard width > 0, height > 0 else { return nil }
        let bytes = base.assumingMemoryBound(to: UInt8.self)

        var count = 0
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            let row = bytes + y * rowBytes
            for x in 0..<width where row[x] != 0 {
                count += 1
                minX = min(minX, x)
                maxX = max(maxX, x)
                minY = min(minY, y)
                maxY = max(maxY, y)
            }
        }
        guard count > 0 else { return nil }
        let rect = CGRect(
            x: Double(minX) / Double(width),
            y: Double(minY) / Double(height),
            width: Double(maxX - minX + 1) / Double(width),
            height: Double(maxY - minY + 1) / Double(height)
        )
        return (rect, Double(count) / Double(width * height))
    }

    /// Centers the cutout on a transparent square with room around it, a soft blurred ellipse
    /// where it meets the ground, and a faint lift shadow. Scales only; pixels stay as shot.
    static func compose(_ cutout: CGImage) -> CGImage? {
        let subjectWidth = CGFloat(cutout.width)
        let subjectHeight = CGFloat(cutout.height)
        let frame = max(subjectWidth, subjectHeight) / 0.76
        let scale = min(1, maxSide / frame)
        let side = (frame * scale).rounded(.up)
        let width = subjectWidth * scale
        let height = subjectHeight * scale

        guard let context = CGContext(
            data: nil, width: Int(side), height: Int(side), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high

        // CG's origin is bottom-left. Sit the subject a touch above center so the shadow has room.
        let drawRect = CGRect(x: (side - width) / 2, y: (side - height) / 2 + side * 0.03, width: width, height: height)

        // Contact shadow: draw the ellipse off canvas and let only its blurred shadow land.
        let away = side * 2
        let ellipse = CGRect(
            x: side / 2 - width * 0.42,
            y: drawRect.minY - max(3, height * 0.035),
            width: width * 0.84,
            height: max(6, height * 0.07)
        )
        context.saveGState()
        context.setShadow(offset: CGSize(width: -away, height: 0), blur: max(8, height * 0.06), color: CGColor(gray: 0, alpha: 0.26))
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fillEllipse(in: ellipse.offsetBy(dx: away, dy: 0))
        context.restoreGState()

        // A faint lift shadow follows the subject's own outline.
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -side * 0.008), blur: side * 0.025, color: CGColor(gray: 0, alpha: 0.12))
        context.draw(cutout, in: drawRect)
        context.restoreGState()

        return context.makeImage()
    }
}

nonisolated extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
