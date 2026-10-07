import SwiftUI

/// The Shelf: everything you'd trade, priced as ranges, each card marked with how ready it
/// is. A tap opens the product card, a long press lifts the card with quick actions, and the
/// grid scrolls like any grid. Capture opens the camera and photo picker; in demo mode it
/// plays a sample capture instead.
struct ShelfView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var itemNamespace
    @State private var isCapturing = false
    @State private var isCaptureSheetPresented = false
    @State private var filter: ShelfFilter = .all
    @State private var openItem: ItemRoute?
    @State private var tuneUp: TuneUpRoute?

    private let columns = [
        GridItem(.flexible(), spacing: Space.md),
        GridItem(.flexible(), spacing: Space.md),
    ]

    var body: some View {
        NavigationStack {
            ZStack {
                Palette.canvas.ignoresSafeArea()
                if model.shelf.isEmpty, model.captures.isEmpty {
                    ShelfEmptyState(isCapturing: isCapturing, onCapture: capture)
                        .transition(.blurReplace)
                } else {
                    grid
                        .transition(.blurReplace)
                }
            }
            .animation(Motion.soft, value: model.shelf.isEmpty && model.captures.isEmpty)
            .task {
                await model.refreshShelf()
                await model.loadQuestions()
            }
            .sheet(isPresented: $isCaptureSheetPresented) {
                CaptureSheet(capture: model.draftCapture())
            }
            .sheet(item: $openItem) { route in
                ProductPage(itemID: route.id)
                    .navigationTransition(.zoom(sourceID: route.id, in: itemNamespace))
            }
            .fullScreenCover(item: $tuneUp) { route in
                TuneUpView(itemID: route.itemID)
            }
            .quietBanner()
        }
    }

    private var visibleItems: [ShelfItem] {
        model.shelf.filter { filter.includes($0) }
    }

    private var grid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                header

                // Photos on their way: the GM's work shows here, where the Items will land.
                ForEach(model.captures) { capture in
                    CaptureStatusCard(capture: capture) {
                        tuneUp = TuneUpRoute(itemID: nil)
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                ShelfFilterBar(selection: $filter)

                if visibleItems.isEmpty, !model.shelf.isEmpty {
                    Text(filter == .ready
                         ? "Nothing ready to show yet. A quick Tune up gets you there."
                         : "Everything here is ready to show.")
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.xxl)
                        .transition(.opacity)
                }

                LazyVGrid(columns: columns, spacing: Space.md) {
                    ForEach(visibleItems) { item in
                        // A plain Button, so a tap opens the card and a drag scrolls the grid.
                        // The long press belongs to the system context menu, which lifts the card.
                        Button {
                            openItem = ItemRoute(id: item.id)
                        } label: {
                            ItemCard(item: item)
                        }
                        .buttonStyle(.pressable)
                        .matchedTransitionSource(id: item.id, in: itemNamespace)
                        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .contextMenu {
                            quickActions(for: item)
                        } preview: {
                            ItemCard(item: item)
                                .frame(width: 220)
                        }
                        .accessibilityHint("Opens the product card")
                    }
                }
                .animation(Motion.snappy, value: filter)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.xs)
            .padding(.bottom, Space.tabBarClearance)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            await model.refreshShelf()
            await model.loadQuestions()
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Shelf")
                    .font(Typo.title)
                    .tracking(-0.4)
                Text(countLine)
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
                    .contentTransition(.numericText())
                if let worth = worthLine {
                    Text(worth)
                        .font(Typo.footnote.monospacedDigit())
                        .foregroundStyle(Palette.inkTertiary)
                        .contentTransition(.numericText())
                }
            }
            .animation(Motion.snappy, value: countLine)
            Spacer(minLength: 0)
            TuneUpButton(count: model.tuneUpCount) {
                tuneUp = TuneUpRoute(itemID: nil)
            }
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
    }

    @ViewBuilder
    private func quickActions(for item: ShelfItem) -> some View {
        Picker("Would you trade it?", selection: willingnessBinding(for: item)) {
            ForEach(Willingness.allCases, id: \.self) { option in
                Text(option.label).tag(option)
            }
        }
        .pickerStyle(.inline)
        Button("Tune up this item", systemImage: "wand.and.stars") {
            tuneUp = TuneUpRoute(itemID: item.id)
        }
        if !item.isReserved {
            Button("Remove", systemImage: "trash", role: .destructive) {
                model.removeItem(item.id)
            }
        }
    }

    private func willingnessBinding(for item: ShelfItem) -> Binding<Willingness> {
        Binding(
            get: { model.shelf.first { $0.id == item.id }?.willingness ?? item.willingness },
            set: { model.setWillingness($0, for: item.id) }
        )
    }

    /// "13 items, 2 ready to show"
    private var countLine: String {
        let count = model.shelf.count
        let ready = model.shelf.filter { $0.readiness == .showcase }.count
        return "\(count) \(count == 1 ? "item" : "items"), \(ready) ready to show"
    }

    /// Values are always ranges, so the total is too.
    private var worthLine: String? {
        let values = model.shelf.compactMap(\.value)
        guard !values.isEmpty else { return nil }
        let low = values.map(\.lowCents).reduce(0, +)
        let high = values.map(\.highCents).reduce(0, +)
        return "Worth \(Money.range(low: low, high: high))"
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
            model.loadDemoShelf()
            isCapturing = false
        }
    }
}

/// Which Item's product card is open.
struct ItemRoute: Identifiable, Hashable {
    let id: String
}

/// Tune up for the whole Shelf (nil) or 1 Item.
struct TuneUpRoute: Identifiable, Hashable {
    let id = UUID()
    var itemID: String?
}

// MARK: - Filters

enum ShelfFilter: String, CaseIterable, Identifiable {
    case all, ready, needsLook

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: "All"
        case .ready: "Ready to show"
        case .needsLook: "Needs a look"
        }
    }

    func includes(_ item: ShelfItem) -> Bool {
        switch self {
        case .all: true
        case .ready: item.readiness == .showcase
        case .needsLook: item.readiness != .showcase
        }
    }
}

private struct ShelfFilterBar: View {
    @Binding var selection: ShelfFilter
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: Space.xs) {
            ForEach(ShelfFilter.allCases) { option in
                let isSelected = option == selection
                Button {
                    withAnimation(Motion.snappy) { selection = option }
                } label: {
                    Text(option.label)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(isSelected ? Palette.canvas : Palette.ink)
                        .lineLimit(1)
                        .padding(.horizontal, 14)
                        .frame(height: 34)
                        .background {
                            if isSelected {
                                Capsule()
                                    .fill(Palette.ink)
                                    .matchedGeometryEffect(id: "filter", in: thumb)
                            } else {
                                Capsule().strokeBorder(Palette.hairline, lineWidth: 1)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

// MARK: - Tune up button

/// A glass "Tune up" capsule with a badge for every open question on the Shelf.
private struct TuneUpButton: View {
    var count: Int
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Tune up", systemImage: "wand.and.stars")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .padding(.horizontal, 14)
                .frame(height: 48)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .overlay(alignment: .topTrailing) {
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(Palette.iris, in: Capsule())
                    .offset(x: 4, y: -4)
                    .contentTransition(.numericText())
                    .transition(.scale.combined(with: .opacity))
                    .allowsHitTesting(false)
            }
        }
        .animation(Motion.bouncy, value: count)
        .accessibilityLabel(count > 0 ? "Tune up, \(count) questions" : "Tune up")
    }
}

// MARK: - Item card

/// A Shelf card: photo, readiness mark, at most 1 tag, title, condition and range. Taps and
/// long presses belong to the Button and context menu around it, never to the card, so
/// nothing here competes with the ScrollView for touches. The scan plays only while the GM
/// is pricing or re-reading the Item.
struct ItemCard: View {
    var item: ShelfItem

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            ItemArtwork(item: item, studio: item.studioAllowed ? .ifReady : .off)
                .aspectRatio(1, contentMode: .fit)
                .appraiseScan(while: item.isAppraising, duration: 1.5)
                .overlay(alignment: .topLeading) {
                    if item.hasInventoryPhoto {
                        InventoryPhotoTag()
                            .padding(8)
                            .transition(.scale(scale: 0.8).combined(with: .opacity))
                    }
                }
                .overlay(alignment: .topTrailing) {
                    WillingnessDot(willingness: item.willingness)
                        .padding(10)
                }
                .overlay(alignment: .bottomLeading) {
                    ReadinessMark(readiness: item.readiness, isWorking: item.isAppraising)
                        .padding(8)
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
                } else if item.isPricing {
                    PricingPlaceholder()
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 4)
            .animation(Motion.soft, value: item.value)
        }
        .padding(Space.sm)
        .background {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .fill(Palette.surface)
                .shadow(color: .black.opacity(0.06), radius: 18, y: 6)
        }
        .overlay {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(Palette.hairline, lineWidth: 1)
        }
        .animation(Motion.bouncy, value: item.readiness)
        .animation(Motion.bouncy, value: item.hasInventoryPhoto)
        .accessibilityElement(children: .combine)
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
                Text("Trade what you have\nfor what you want.")
                    .font(Typo.title)
                    .tracking(-0.4)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Palette.ink)
                Text("Snap a few things or film a shelf. Each one shows up named, with a value range.")
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
