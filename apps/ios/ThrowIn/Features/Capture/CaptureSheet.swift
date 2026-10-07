import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Add to Shelf: take photos, film a shelf or choose from the library, then send them. The
/// sheet only collects. "Add to Shelf" hands the photos to the AppModel and closes at once:
/// the GM's work shows where its result lands, as a live card on the Shelf (and in the chat
/// when the GM asked for the photo). Closing the sheet early keeps the photos as a draft.
struct CaptureSheet: View {
    /// The tray: the AppModel's unsent draft, so nothing is lost on a swipe down.
    var capture: CaptureModel
    /// Who asked: the Shelf's camera button or the GM. Decides where progress shows.
    var source: CaptureModel.Source = .shelf
    /// Gets the new Items once they land, for example so the GM can carry on with them.
    var onLanded: (([ShelfItem]) -> Void)?

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var isPickerPresented = false
    @State private var isCameraPresented = false
    /// The camera opens for video (Film a shelf) or for stills (Take photos).
    @State private var cameraFilms = true
    @State private var sent = 0

    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.canvas.ignoresSafeArea()
                collecting
                    .padding(.horizontal, Space.gutter)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .photosPicker(
            isPresented: $isPickerPresented,
            selection: $pickerItems,
            maxSelectionCount: max(1, FrameTools.maxFrames - capture.frames.count),
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .compatible
        )
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            pickerItems = []
            // Placeholders first, so the tray answers the pick right away.
            capture.expect(items.count)
            Task { await load(items) }
        }
        .fullScreenCover(isPresented: $isCameraPresented) {
            CameraPicker(allowsVideo: cameraFilms) { result in
                capture.expect(1)
                Task {
                    switch result {
                    case let .photo(data): await capture.add(imageData: [data])
                    case let .video(url): await capture.add(videoAt: url)
                    }
                    capture.settle()
                }
            }
            .ignoresSafeArea()
        }
        .sensoryFeedback(.success, trigger: sent)
    }

    // MARK: Collecting

    private var collecting: some View {
        VStack(spacing: Space.xl) {
            VStack(spacing: Space.xs) {
                Text(isEmpty ? "What are you trading?" : photoCount)
                    .font(Typo.title)
                    .tracking(-0.4)
                    .contentTransition(.numericText())
                Text(isEmpty
                     ? "Snap a few things, or film a whole shelf. We'll name and price each one."
                     : capture.pending > 0 ? "Getting your photos ready." : "Add more, or add these to your Shelf.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, Space.xl)

            if isEmpty {
                sourceButtons
                Spacer()
            } else {
                tray
                Spacer()
                HStack(spacing: Space.sm) {
                    Menu {
                        if cameraAvailable {
                            Button("Take photos", systemImage: "camera") { openCamera(filming: false) }
                            Button("Film a shelf", systemImage: "video") { openCamera(filming: true) }
                        }
                        Button("Choose from library", systemImage: "photo.on.rectangle") { isPickerPresented = true }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 19, weight: .bold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 56, height: 56)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .disabled(capture.isFull)
                    .accessibilityLabel("Add more")

                    Button(action: send) {
                        PrimaryLabel("Add to Shelf", symbol: "plus")
                            .frame(height: 48)
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                    .disabled(!capture.canSubmit)
                }
                .padding(.bottom, Space.lg)
            }
        }
    }

    private var isEmpty: Bool { capture.frames.isEmpty && capture.pending == 0 }

    private var photoCount: String {
        let n = capture.frames.count + capture.pending
        return n == 1 ? "1 photo" : "\(n) photos"
    }

    private func openCamera(filming: Bool) {
        cameraFilms = filming
        isCameraPresented = true
    }

    private var sourceButtons: some View {
        VStack(spacing: Space.md) {
            SourceTile(
                title: "Take photos",
                detail: cameraAvailable ? "1 or a few things at a time" : "Needs a camera",
                symbol: "camera.fill",
                tint: Palette.tangerine
            ) { openCamera(filming: false) }
            .disabled(!cameraAvailable)

            SourceTile(
                title: "Film a shelf",
                detail: cameraAvailable ? "Slow pan, 15 to 60 seconds" : "Needs a camera",
                symbol: "video.fill",
                tint: Palette.bubblegum
            ) { openCamera(filming: true) }
            .disabled(!cameraAvailable)

            SourceTile(
                title: "Choose from library",
                detail: "Up to 30 photos, or a video",
                symbol: "photo.stack.fill",
                tint: Palette.iris
            ) { isPickerPresented = true }

            #if DEBUG && targetEnvironment(simulator)
            DebugMediaButton(capture: capture)
            #endif
        }
    }

    private var tray: some View {
        ScrollView(.horizontal) {
            HStack(spacing: Space.sm) {
                ForEach(capture.frames) { frame in
                    ZStack(alignment: .topTrailing) {
                        thumbnail(frame)
                            .frame(width: 112, height: 140)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                        Button {
                            capture.remove(frame.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(Palette.ink)
                                .frame(width: 26, height: 26)
                        }
                        .glassEffect(.regular.interactive(), in: .circle)
                        .padding(6)
                        .accessibilityLabel("Remove photo")
                    }
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
                ForEach(0..<capture.pending, id: \.self) { _ in
                    PendingTile()
                        .frame(width: 112, height: 140)
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
            }
            .padding(.vertical, Space.xs)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    @ViewBuilder
    private func thumbnail(_ frame: PreparedFrame) -> some View {
        if let image = capture.thumbnails[frame.id] {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            Palette.surface
        }
    }

    // MARK: Actions

    /// Hands the photos to the AppModel, which sends them and follows the GM's work, and
    /// closes. Nothing here waits.
    private func send() {
        guard capture.canSubmit else { return }
        sent += 1
        capture.source = source
        app.submitCapture(capture, onLanded: onLanded)
        dismiss()
    }

    private func load(_ items: [PhotosPickerItem]) async {
        for item in items {
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                    await capture.add(videoAt: movie.url)
                }
            } else if let data = try? await item.loadTransferable(type: Data.self) {
                await capture.add(imageData: [data])
            }
            capture.settle()
        }
    }
}

// MARK: - Source tile

/// A photo still loading: a soft pulsing tile in the photo's place.
private struct PendingTile: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            .fill(Palette.surface)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                    .fill(Palette.ink.opacity(pulse ? 0.08 : 0.03))
            }
            .overlay { ProgressView().tint(Palette.inkTertiary) }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
            }
            .accessibilityLabel("Loading photo")
    }
}

private struct SourceTile: View {
    var title: String
    var detail: String
    var symbol: String
    var tint: Color
    var action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                Image(systemName: symbol)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 56, height: 56)
                    .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Typo.headline).foregroundStyle(Palette.ink)
                    Text(detail).font(Typo.footnote).foregroundStyle(Palette.inkSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Palette.inkTertiary)
            }
            .padding(Space.md)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
        }
        .buttonStyle(.pressable)
    }
}

// MARK: - Pickers

/// A video from the photo library, copied somewhere we own before the picker deletes it.
nonisolated struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let destination = FileManager.default.temporaryDirectory
                .appending(path: "\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: destination)
            return PickedMovie(url: destination)
        }
    }
}

/// The system camera, for 1 photo or a video up to 60 seconds. `allowsVideo: false` is
/// photos only, for answering the GM's photo request.
struct CameraPicker: UIViewControllerRepresentable {
    enum Result {
        case photo(Data)
        case video(URL)
    }

    var allowsVideo = true
    var onCapture: (Result) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        if allowsVideo {
            picker.mediaTypes = [UTType.movie.identifier, UTType.image.identifier]
            picker.cameraCaptureMode = .video
            picker.videoMaximumDuration = 60
            picker.videoQuality = .typeHigh
        } else {
            picker.mediaTypes = [UTType.image.identifier]
            picker.cameraCaptureMode = .photo
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                let destination = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).\(url.pathExtension)")
                if (try? FileManager.default.copyItem(at: url, to: destination)) != nil {
                    parent.onCapture(.video(destination))
                }
            } else if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.92) {
                parent.onCapture(.photo(data))
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
