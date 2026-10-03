import SwiftUI

/// The Shelf: everything you'd trade, priced as ranges. Capture opens the camera and photo
/// picker; in demo mode it plays a sample capture instead.
struct ShelfView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var itemNamespace
    @State private var isCapturing = false
    @State private var scanGeneration = 0
    @State private var isCaptureSheetPresented = false

    private let columns = [
        GridItem(.flexible(), spacing: Space.md),
        GridItem(.flexible(), spacing: Space.md),
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.canvas.ignoresSafeArea()
                if model.shelf.isEmpty {
                    ShelfEmptyState(isCapturing: isCapturing, onCapture: capture)
                        .transition(.blurReplace)
                } else {
                    grid
                        .transition(.blurReplace)
                }
            }
            .animation(Motion.soft, value: model.shelf.isEmpty)
            .task { await model.refreshShelf() }
            .sheet(isPresented: $isCaptureSheetPresented) {
                CaptureSheet {
                    Task {
                        await model.refreshShelf()
                        scanGeneration += 1
                    }
                }
            }
            .overlay(alignment: .top) {
                if let message = model.shelfError {
                    Text(message)
                        .font(Typo.callout)
                        .padding(.horizontal, Space.md)
                        .padding(.vertical, Space.sm)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.top, Space.xs)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task {
                            try? await Task.sleep(for: .seconds(3))
                            withAnimation(Motion.soft) { model.shelfError = nil }
                        }
                }
            }
            .animation(Motion.bouncy, value: model.shelfError)
            .navigationDestination(for: ShelfItem.self) { item in
                ItemDetailView(itemID: item.id)
                    .navigationTransition(.zoom(sourceID: item.id, in: itemNamespace))
            }
        }
    }

    private var grid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Shelf")
                            .font(Typo.title)
                            .tracking(-0.4)
                        Text("\(model.shelf.count) items, about \(Money.dollars(totalValue))")
                            .font(Typo.callout)
                            .foregroundStyle(Palette.inkSecondary)
                            .contentTransition(.numericText())
                    }
                    Spacer()
                    Button(action: capture) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(Palette.ink)
                            .frame(width: 48, height: 48)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Add to Shelf")
                }

                LazyVGrid(columns: columns, spacing: Space.md) {
                    ForEach(Array(model.shelf.enumerated()), id: \.element.id) { index, item in
                        NavigationLink(value: item) {
                            ItemCard(item: item, scanTrigger: scanGeneration, scanDelay: Double(index) * 0.12)
                        }
                        .buttonStyle(.pressable)
                        .matchedTransitionSource(id: item.id, in: itemNamespace)
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.xs)
            .padding(.bottom, Space.tabBarClearance)
        }
        .scrollIndicators(.hidden)
        .refreshable { await model.refreshShelf() }
    }

    private var totalValue: Int {
        model.shelf.compactMap(\.value?.midCents).reduce(0, +)
    }

    private func capture() {
        if model.isLive {
            isCaptureSheetPresented = true
            return
        }
        guard !isCapturing else { return }
        isCapturing = true
        Task {
            try? await Task.sleep(for: .seconds(1.4))
            scanGeneration += 1
            model.loadDemoShelf()
            isCapturing = false
        }
    }
}

// MARK: - Item card

struct ItemCard: View {
    var item: ShelfItem
    var scanTrigger: Int = 0
    var scanDelay: Double = 0

    @State private var lifted = false
    @State private var touch: CGPoint?
    @State private var size: CGSize = .zero
    @State private var localScan = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            ItemArtwork(item: item)
                .aspectRatio(1, contentMode: .fit)
                .appraiseScan(trigger: localScan, duration: 1.5)
                .overlay(alignment: .topTrailing) {
                    WillingnessDot(willingness: item.willingness)
                        .padding(10)
                }
                .overlay(alignment: .bottomLeading) {
                    if item.status == .needsPhotos {
                        Label("1 more photo", systemImage: "camera.viewfinder")
                            .font(Typo.caption)
                            .foregroundStyle(Palette.ink)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .glassEffect(.regular, in: .capsule)
                            .padding(8)
                    }
                }

            VStack(alignment: .leading, spacing: 6) {
                Text(item.title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2, reservesSpace: true)
                    .multilineTextAlignment(.leading)
                if let grade = item.conditionGrade {
                    GradeChip(grade: grade)
                }
                if let value = item.value {
                    ValueRangeBar(range: value, tint: ArtworkStyle(category: item.category).tint)
                }
            }
            .padding(.horizontal, 4)
        }
        .padding(Space.sm)
        .background {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: .black.opacity(lifted ? 0.16 : 0.06), radius: lifted ? 30 : 18, y: lifted ? 18 : 6)
        }
        .overlay {
            specular
        }
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
        .onGeometryChange(for: CGSize.self) { proxy in
            proxy.size
        } action: { newSize in
            size = newSize
        }
        .rotation3DEffect(.degrees(tilt.x), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
        .rotation3DEffect(.degrees(tilt.y), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
        .scaleEffect(lifted ? 1.04 : 1)
        .zIndex(lifted ? 1 : 0)
        .animation(Motion.bouncy, value: lifted)
        .animation(.interactiveSpring(response: 0.25, dampingFraction: 0.7), value: touch)
        .gesture(liftGesture)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.7), trigger: lifted) { _, isLifted in isLifted }
        .task(id: scanTrigger) {
            guard scanTrigger > 0 else { return }
            try? await Task.sleep(for: .seconds(scanDelay))
            localScan += 1
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens item details")
    }

    /// Tilt toward the finger, up to 10 degrees.
    private var tilt: (x: Double, y: Double) {
        guard lifted, let touch, size.width > 0, size.height > 0 else { return (0, 0) }
        let nx = Double((touch.x / size.width - 0.5) * 2)
        let ny = Double((touch.y / size.height - 0.5) * 2)
        return (x: -ny * 10, y: nx * 10)
    }

    private var specular: some View {
        let point = touch ?? CGPoint(x: size.width * 0.3, y: size.height * 0.2)
        return RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
            .fill(
                RadialGradient(
                    colors: [.white.opacity(0.55), .white.opacity(0)],
                    center: UnitPoint(
                        x: size.width > 0 ? point.x / size.width : 0.3,
                        y: size.height > 0 ? point.y / size.height : 0.2
                    ),
                    startRadius: 0,
                    endRadius: max(size.width, 1) * 0.7
                )
            )
            .blendMode(.overlay)
            .opacity(lifted ? 1 : 0)
            .allowsHitTesting(false)
    }

    private var liftGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.28)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .onChanged { value in
                switch value {
                case .first(true):
                    lifted = true
                case .second(true, let drag):
                    lifted = true
                    touch = drag?.location
                default:
                    break
                }
            }
            .onEnded { _ in
                lifted = false
                touch = nil
            }
    }
}

// MARK: - Empty state

struct ShelfEmptyState: View {
    var isCapturing: Bool
    var onCapture: () -> Void

    @State private var float = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Space.xl) {
            Spacer()
            ZStack {
                ForEach(Array([DemoData.shelf[2], DemoData.shelf[0], DemoData.shelf[3]].enumerated()), id: \.element.id) { index, item in
                    let angle = Double(index - 1) * 11
                    ItemArtwork(item: item, cornerRadius: 26)
                        .frame(width: 118, height: 118)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .shadow(color: .black.opacity(0.08), radius: 18, y: 10)
                        .rotationEffect(.degrees(angle + (float ? Double(index - 1) * 2 : 0)))
                        .offset(x: Double(index - 1) * 74, y: (index == 1 ? -14 : 8) + (float ? -6 : 4))
                        .zIndex(index == 1 ? 1 : 0)
                }
            }
            .frame(height: 180)
            .appraiseScan(trigger: isCapturing ? 1 : 0, duration: 1.4)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) { float = true }
            }

            VStack(spacing: Space.xs) {
                Text("Film a shelf.\nYour GM does the rest.")
                    .font(Typo.title)
                    .tracking(-0.4)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Palette.ink)
                Text("15 to 60 seconds is plenty. Items show up named and priced, as ranges.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Space.xl)
            }

            Button(action: onCapture) {
                ZStack {
                    PrimaryLabel(AppConfig.backend == .demo ? "Try a sample capture" : "Add to your Shelf", symbol: "camera.fill")
                        .opacity(isCapturing ? 0 : 1)
                    HStack(spacing: Space.xs) {
                        LoopIndicator(people: 3, size: 20)
                        Text("Reading your shelf")
                            .font(.system(size: 17, weight: .bold, design: .rounded))
                            .foregroundStyle(Palette.canvas)
                    }
                    .opacity(isCapturing ? 1 : 0)
                }
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .padding(.horizontal, Space.xxl)
            .animation(Motion.snappy, value: isCapturing)

            Spacer()
            Spacer()
        }
        .padding(.bottom, Space.tabBarClearance * 0.5)
    }
}

#Preview {
    ShelfView()
        .environment(AppModel())
}
