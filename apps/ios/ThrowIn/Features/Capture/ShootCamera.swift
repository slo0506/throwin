import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import SwiftUI
import UIKit
import Vision

// The camera behind the Showcase shoot: an AVCaptureSession with a photo output, plus a
// video data output whose frames are read on device for live cues. Nothing here leaves the
// phone; only the photos the user keeps are uploaded.

/// What the camera sees right now, measured every few frames.
nonisolated struct FrameCues: Sendable, Equatable {
    /// Mean luma, 0 to 1.
    var brightness: Double
    /// Laplacian variance of a downsampled luma copy, compared against the recent peak.
    var isSharp: Bool
    /// Little change since the last measured frame.
    var isSteady: Bool
    /// Share of the frame the Vision subject mask covers. nil when Vision found no subject,
    /// which is common for flat close-ups like a tag, so it never blocks a shot.
    var coverage: Double?
}

/// 1 back-camera session for the Showcase shoot. Configured and run on its own queue;
/// frames are analyzed on another. Cues arrive on `cues`.
nonisolated final class ShootCamera: NSObject, @unchecked Sendable, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let cues: AsyncStream<FrameCues>

    private let continuation: AsyncStream<FrameCues>.Continuation
    private let sessionQueue = DispatchQueue(label: "app.throwin.shoot.session")
    private let frameQueue = DispatchQueue(label: "app.throwin.shoot.frames")
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()

    // sessionQueue only
    private var isConfigured = false

    // frameQueue only
    private var frameIndex = 0
    private var previousThumb: [UInt8] = []
    private var peakSharpness = 0.0
    private var lastCoverage: Double?

    // Guarded by `lock`: photo captures in flight, kept alive until they finish.
    private let lock = NSLock()
    private var inFlight: [Int64: PhotoCaptureHandler] = [:]

    /// Analyze every 4th frame (about 7 a second) and run Vision on every 12th.
    private static let analyzeEvery = 4
    private static let maskEvery = 12

    override init() {
        let (stream, continuation) = AsyncStream.makeStream(of: FrameCues.self, bufferingPolicy: .bufferingNewest(1))
        cues = stream
        self.continuation = continuation
        super.init()
    }

    deinit {
        continuation.finish()
    }

    /// False in the Simulator and on devices without a back camera.
    static var isAvailable: Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    }

    /// Asks for camera access the first time. False if the user said no.
    static func requestAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func start() {
        sessionQueue.async { [self] in
            if !isConfigured { configure() }
            if isConfigured, !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        sessionQueue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    /// Takes 1 photo. nil if the camera isn't running or the capture failed.
    func capturePhoto() async -> Data? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Data?, Never>) in
            sessionQueue.async { [self] in
                guard session.isRunning else {
                    continuation.resume(returning: nil)
                    return
                }
                let settings = AVCapturePhotoSettings()
                settings.photoQualityPrioritization = .balanced
                let id = settings.uniqueID
                let handler = PhotoCaptureHandler { [weak self] data in
                    self?.finishCapture(id)
                    continuation.resume(returning: data)
                }
                lock.withLock { inFlight[id] = handler }
                photoOutput.capturePhoto(with: settings, delegate: handler)
            }
        }
    }

    private func finishCapture(_ id: Int64) {
        lock.withLock { _ = inFlight.removeValue(forKey: id) }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device)
        else { return }

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard session.canAddInput(input), session.canAddOutput(photoOutput), session.canAddOutput(videoOutput) else { return }
        session.addInput(input)
        session.addOutput(photoOutput)
        photoOutput.maxPhotoQualityPrioritization = .balanced

        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        ]
        videoOutput.setSampleBufferDelegate(self, queue: frameQueue)
        session.addOutput(videoOutput)

        // The app is portrait only, so photos come out upright.
        if let connection = photoOutput.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
            connection.videoRotationAngle = 90
        }

        if (try? device.lockForConfiguration()) != nil {
            if device.isFocusModeSupported(.continuousAutoFocus) {
                device.focusMode = .continuousAutoFocus
            }
            if device.isExposureModeSupported(.continuousAutoExposure) {
                device.exposureMode = .continuousAutoExposure
            }
            device.unlockForConfiguration()
        }
        isConfigured = true
    }

    // MARK: Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        frameIndex += 1
        guard frameIndex % Self.analyzeEvery == 0,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer),
              let luma = FrameAnalyzer.luma(pixelBuffer)
        else { return }

        let motion = FrameAnalyzer.difference(luma.thumb, previousThumb)
        previousThumb = luma.thumb
        // The peak decays, so moving to a plainer subject doesn't leave it out of reach.
        peakSharpness = max(luma.sharpness, peakSharpness * 0.97)
        if frameIndex % Self.maskEvery == 0 {
            lastCoverage = FrameAnalyzer.subjectCoverage(pixelBuffer)
        }

        continuation.yield(FrameCues(
            brightness: luma.brightness,
            isSharp: luma.sharpness >= max(FrameAnalyzer.sharpnessFloor, peakSharpness * 0.55),
            isSteady: motion < FrameAnalyzer.steadyThreshold,
            coverage: lastCoverage
        ))
    }
}

/// Holds 1 photo capture's completion until AVFoundation hands back the photo.
nonisolated final class PhotoCaptureHandler: NSObject, @unchecked Sendable, AVCapturePhotoCaptureDelegate {
    private let lock = NSLock()
    private var completion: (@Sendable (Data?) -> Void)?

    init(completion: @escaping @Sendable (Data?) -> Void) {
        self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: (any Error)?) {
        finish(error == nil ? photo.fileDataRepresentation() : nil)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: (any Error)?) {
        // Always the last callback. Covers a capture that never produced a photo.
        finish(nil)
    }

    /// Calls the completion exactly once.
    private func finish(_ data: Data?) {
        let done = lock.withLock { () -> (@Sendable (Data?) -> Void)? in
            defer { completion = nil }
            return completion
        }
        done?(data)
    }
}

// MARK: - Frame analysis

/// Cheap per-frame measurements on the luma plane of a 420f buffer.
nonisolated enum FrameAnalyzer {
    nonisolated struct Luma: Sendable {
        var brightness: Double
        var sharpness: Double
        /// A 16 by 12 luma thumbnail, for frame-to-frame motion.
        var thumb: [UInt8]
    }

    /// Below this, a frame is soft whatever the recent peak.
    static let sharpnessFloor = 18.0
    /// Mean absolute luma change (0 to 255) under which the phone counts as still.
    static let steadyThreshold = 7.0

    private static let gridEdge = 160
    private static let thumbWidth = 16
    private static let thumbHeight = 12

    /// Brightness, sharpness and a motion thumbnail from a grid of about 160 px on the long
    /// edge, sampled straight from the luma plane.
    static func luma(_ pixelBuffer: CVPixelBuffer) -> Luma? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 1,
              let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)
        else { return nil }

        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let step = max(1, max(width, height) / gridEdge)
        let gridWidth = width / step
        let gridHeight = height / step
        guard gridWidth > 4, gridHeight > 4 else { return nil }

        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var grid = [Double](repeating: 0, count: gridWidth * gridHeight)
        var total = 0.0
        for gy in 0..<gridHeight {
            let row = bytes + gy * step * rowBytes
            for gx in 0..<gridWidth {
                let value = Double(row[gx * step])
                grid[gy * gridWidth + gx] = value
                total += value
            }
        }

        // Variance of a 4-neighbor Laplacian, like FrameTools.sharpness.
        var sum = 0.0
        var sumOfSquares = 0.0
        var count = 0.0
        for y in 1..<(gridHeight - 1) {
            for x in 1..<(gridWidth - 1) {
                let i = y * gridWidth + x
                let laplacian = 4 * grid[i] - grid[i - 1] - grid[i + 1] - grid[i - gridWidth] - grid[i + gridWidth]
                sum += laplacian
                sumOfSquares += laplacian * laplacian
                count += 1
            }
        }
        let mean = count > 0 ? sum / count : 0
        let variance = count > 0 ? max(0, sumOfSquares / count - mean * mean) : 0

        var thumb = [UInt8](repeating: 0, count: thumbWidth * thumbHeight)
        for ty in 0..<thumbHeight {
            for tx in 0..<thumbWidth {
                let gx = min(gridWidth - 1, tx * gridWidth / thumbWidth)
                let gy = min(gridHeight - 1, ty * gridHeight / thumbHeight)
                thumb[ty * thumbWidth + tx] = UInt8(grid[gy * gridWidth + gx])
            }
        }

        return Luma(brightness: total / Double(gridWidth * gridHeight) / 255, sharpness: variance, thumb: thumb)
    }

    /// Mean absolute difference of 2 thumbnails. Large when there's nothing to compare.
    static func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 255 }
        var total = 0
        for i in a.indices {
            total += abs(Int(a[i]) - Int(b[i]))
        }
        return Double(total) / Double(a.count)
    }

    /// How much of the frame Vision's subject mask covers, or nil when it finds no subject.
    static func subjectCoverage(_ pixelBuffer: CVPixelBuffer) -> Double? {
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        guard (try? handler.perform([request])) != nil,
              let observation = request.results?.first,
              !observation.allInstances.isEmpty
        else { return nil }
        return StudioRenderer.subjectBounds(of: observation.instanceMask)?.coverage
    }
}

// MARK: - Preview

/// The live camera image, filling its frame.
struct CameraPreview: UIViewRepresentable {
    var camera: ShootCamera

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = camera.session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer {
            // layerClass guarantees the type.
            layer as! AVCaptureVideoPreviewLayer
        }
    }
}
