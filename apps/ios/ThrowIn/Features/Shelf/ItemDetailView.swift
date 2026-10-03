import SwiftUI
import UIKit

/// Full Item detail, 1 step past the product card: the photo (scanned on arrival, and on a
/// loop while the GM re-reads it), what the GM thinks it is, a value range, the willingness
/// control, edit and remove. Never shows raw confidence scores.
struct ItemDetailView: View {
    var itemID: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scan = 0
    @State private var confirmRemove = false
    @State private var isEditing = false

    // Studio presentation
    @State private var studioImage: UIImage?
    @State private var showsOriginal = false

    private var item: ShelfItem? { model.shelf.first { $0.id == itemID } }
    private var isAppraising: Bool { item?.isAppraising ?? false }

    var body: some View {
        ScrollView {
            if let item {
                VStack(alignment: .leading, spacing: Space.xl) {
                    hero(item)

                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(item.brand ?? "").sectionLabel()
                        Text(item.title)
                            .font(Typo.title)
                            .tracking(-0.4)
                            .foregroundStyle(Palette.ink)
                            .contentTransition(.opacity)
                        HStack(spacing: Space.xs) {
                            if let grade = item.conditionGrade {
                                GradeChip(grade: grade)
                                    .transition(.blurReplace)
                            }
                            Pill(text: item.readiness.confidencePhrase, symbol: "sparkles", tint: Palette.iris)
                        }
                    }
                    .animation(Motion.snappy, value: item.conditionGrade)

                    if item.isAppraising {
                        RereadingCard()
                    }

                    if let value = item.value {
                        PaperCard {
                            VStack(alignment: .leading, spacing: Space.md) {
                                Text("Worth about").sectionLabel()
                                Text(value.label)
                                    .font(Typo.valueLarge)
                                    .foregroundStyle(Palette.ink)
                                    .contentTransition(.numericText())
                                ValueRangeBar(range: value, tint: ArtworkStyle(category: item.category).tint)
                                Text("From recent sold listings for this item in this condition. A range, not a price: the final number is whatever you both agree on.")
                                    .font(Typo.footnote)
                                    .foregroundStyle(Palette.inkSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .transition(.blurReplace)
                    } else if item.isPricing {
                        PaperCard {
                            VStack(alignment: .leading, spacing: Space.md) {
                                Text("Worth about").sectionLabel()
                                Text("Pricing")
                                    .font(Typo.valueLarge)
                                    .foregroundStyle(Palette.inkSecondary)
                                    .loopShimmer()
                                PricingPlaceholder(showsLabels: false)
                                Text("Your GM is checking recent sold listings. The range shows up here in a moment.")
                                    .font(Typo.footnote)
                                    .foregroundStyle(Palette.inkSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .transition(.blurReplace)
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Would you trade it?")
                        WillingnessPicker(selection: willingnessBinding(for: item))
                    }

                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: {
                        Text("Remove from Shelf")
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .frame(height: 36)
                    }
                    .buttonStyle(.glass)
                    .tint(Palette.danger)
                    .confirmationDialog("Remove \(item.title)?", isPresented: $confirmRemove, titleVisibility: .visible) {
                        Button("Remove", role: .destructive) {
                            dismiss()
                            Task {
                                try? await Task.sleep(for: .milliseconds(350))
                                model.removeItem(item.id)
                            }
                        }
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.tabBarClearance)
                .animation(Motion.soft, value: item.isAppraising)
                .animation(Motion.soft, value: item.status)
                .animation(Motion.soft, value: item.value)
            }
        }
        .scrollIndicators(.hidden)
        .background(Palette.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let item, !item.isReserved {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit", systemImage: "pencil") { isEditing = true }
                        .accessibilityLabel("Edit item")
                }
            }
        }
        .sheet(isPresented: $isEditing) {
            if let item {
                ItemEditSheet(item: item) { title, grade in
                    model.editItem(item.id, title: title, conditionGrade: grade)
                }
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(280))
            scan += 1
        }
        .task(id: isAppraising) {
            // Keep the scan sweeping while the GM re-reads the photo.
            while isAppraising, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.1))
                guard isAppraising, !Task.isCancelled else { break }
                scan += 1
            }
        }
        .task(id: isAppraising) {
            // Opened while the Appraiser is still working: follow it here. No-op if already followed.
            guard isAppraising else { return }
            await model.followAppraisal(itemID)
        }
        .task(id: StudioKey(url: item?.thumbnailUrl, allowed: item?.studioAllowed ?? false)) {
            await loadStudio()
        }
    }

    // MARK: Photo

    private func hero(_ item: ShelfItem) -> some View {
        let studio: StudioMode = if let studioImage, !showsOriginal { .show(studioImage) } else { .off }
        return ItemArtwork(item: item, cornerRadius: 32, symbolScale: 0.34, studio: studio)
            .aspectRatio(1, contentMode: .fit)
            .appraiseScan(trigger: scan, duration: 1.8)
            .shadow(color: .black.opacity(0.08), radius: 24, y: 12)
            .overlay(alignment: .bottomTrailing) {
                if studioImage != nil {
                    StudioToggle(showsOriginal: $showsOriginal)
                        .padding(Space.sm)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .animation(Motion.soft, value: showsOriginal)
            .animation(Motion.bouncy, value: studioImage != nil)
    }

    /// Studio by default when the photo is good enough and Vision finds a clean subject;
    /// otherwise the original stays and there is no toggle.
    private func loadStudio() async {
        guard item?.studioAllowed == true, let url = item?.thumbnailUrl.flatMap(URL.init(string:)) else {
            studioImage = nil
            return
        }
        if let cached = StudioCache.cached(url) {
            studioImage = cached
            return
        }
        studioImage = nil
        guard let made = await StudioCache.studio(for: url), !Task.isCancelled else { return }
        withAnimation(Motion.soft) { studioImage = made }
    }

    // MARK: Actions

    private func willingnessBinding(for item: ShelfItem) -> Binding<Willingness> {
        Binding(
            get: { model.shelf.first { $0.id == item.id }?.willingness ?? item.willingness },
            set: { model.setWillingness($0, for: item.id) }
        )
    }
}

/// Shown while the GM takes another look at the Item.
struct RereadingCard: View {
    var body: some View {
        PaperCard {
            HStack(spacing: Space.md) {
                LoopIndicator(people: 3, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Taking another look")
                        .font(Typo.headline)
                        .foregroundStyle(Palette.ink)
                        .loopShimmer()
                    Text("Your GM is updating this item. This takes a few seconds.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .transition(.blurReplace)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Studio toggle

/// A small glass switch between the studio presentation and the original photo.
struct StudioToggle: View {
    @Binding var showsOriginal: Bool
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 2) {
            option("Studio", isSelected: !showsOriginal) { showsOriginal = false }
            option("Original", isSelected: showsOriginal) { showsOriginal = true }
        }
        .padding(3)
        .glassEffect(.regular.interactive(), in: .capsule)
        .sensoryFeedback(.selection, trigger: showsOriginal)
    }

    private func option(_ title: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button {
            withAnimation(Motion.snappy) { action() }
        } label: {
            Text(title)
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background {
                    if isSelected {
                        Capsule()
                            .fill(Palette.surface.opacity(0.92))
                            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                            .matchedGeometryEffect(id: "thumb", in: thumb)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// Reloads Studio when the photo changes or Studio becomes allowed.
struct StudioKey: Hashable {
    var url: String?
    var allowed: Bool
}

// MARK: - Willingness

/// 3-way segmented control with a sliding glass thumb.
struct WillingnessPicker: View {
    @Binding var selection: Willingness
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Willingness.allCases, id: \.self) { option in
                let isSelected = option == selection
                Button {
                    withAnimation(Motion.bouncy) { selection = option }
                } label: {
                    HStack(spacing: 6) {
                        WillingnessDot(willingness: option)
                        Text(option.label)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(isSelected ? Palette.ink : Palette.inkSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background {
                        if isSelected {
                            Capsule()
                                .fill(Palette.surface)
                                .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
                                .matchedGeometryEffect(id: "thumb", in: thumb)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Palette.ink.opacity(0.06), in: Capsule())
        .sensoryFeedback(.selection, trigger: selection)
    }
}
