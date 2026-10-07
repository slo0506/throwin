import SwiftUI

/// You: profile, what your GM knows (view and delete), autonomy, notifications, and
/// account deletion (App Store 5.1.1(v)).
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var isDeleting = false
    @State private var deleteError: String?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    profileHeader

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "What your GM knows", trailing: "\(model.tasteFacts.count) facts")
                        PaperCard(padding: 0) {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(factGroups.enumerated()), id: \.element.category) { groupIndex, group in
                                    Text(group.category.label)
                                        .sectionLabel()
                                        .padding(.horizontal, Space.lg)
                                        .padding(.top, groupIndex == 0 ? Space.md : Space.lg)
                                        .padding(.bottom, Space.xxs)
                                    ForEach(Array(group.facts.enumerated()), id: \.element.id) { index, fact in
                                        TasteFactRow(fact: fact) {
                                            model.deleteTasteFact(fact.id)
                                        }
                                        if index < group.facts.count - 1 {
                                            Divider().padding(.leading, Space.lg)
                                        }
                                    }
                                }
                                if model.tasteFacts.isEmpty {
                                    Text("Nothing yet. Your GM learns as you chat.")
                                        .font(Typo.callout)
                                        .foregroundStyle(Palette.inkSecondary)
                                        .padding(Space.lg)
                                } else {
                                    Color.clear.frame(height: Space.xs)
                                }
                            }
                            .animation(Motion.snappy, value: model.tasteFacts)
                        }
                        Text("Tap the minus to forget something. Your GM won't use it again.")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkTertiary)
                            .padding(.horizontal, 4)
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Which deals to bring you")
                        VStack(spacing: Space.xs) {
                            ForEach(AutonomyLevel.allCases, id: \.self) { level in
                                AutonomyOption(level: level, isSelected: model.autonomy == level) {
                                    model.setAutonomy(level)
                                }
                            }
                        }
                        Text("For every Ask. Your GM never approves a trade for you.")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkTertiary)
                            .padding(.horizontal, 4)
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Notifications")
                        PaperCard {
                            Toggle(isOn: $model.notificationsOn) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Deals and handoffs")
                                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                                    Text("At most 3 a day. Never promotional.")
                                        .font(Typo.footnote)
                                        .foregroundStyle(Palette.inkSecondary)
                                }
                            }
                            .tint(Palette.iris)
                        }
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Account")
                        Button {
                            Task { await model.signOut() }
                        } label: {
                            Text("Sign out")
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .frame(maxWidth: .infinity)
                                .frame(height: 36)
                        }
                        .buttonStyle(.glass)
                        .tint(Palette.ink)
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            HStack {
                                if isDeleting {
                                    LoopIndicator(people: 2, size: 20)
                                }
                                Text(isDeleting ? "Deleting" : "Delete account")
                            }
                            .font(.system(size: 16, weight: .semibold, design: .rounded))
                            .frame(maxWidth: .infinity)
                            .frame(height: 36)
                        }
                        .buttonStyle(.glass)
                        .tint(Palette.danger)
                        .disabled(isDeleting)
                        if let deleteError {
                            Text(deleteError)
                                .font(Typo.footnote)
                                .foregroundStyle(Palette.danger)
                        }
                        Text("Deletes your Shelf, Asks, what your GM knows and your chats. Finished trades stay anonymized for the other people in them.")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkTertiary)
                            .padding(.horizontal, 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.tabBarClearance)
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .task { await model.loadTasteFacts() }
            .refreshable { await model.loadTasteFacts() }
            .quietBanner()
            .confirmationDialog(
                "Delete your account?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete account", role: .destructive, action: deleteAccount)
            } message: {
                Text("This can't be undone.")
            }
        }
    }

    /// Facts grouped by category, in a fixed order, skipping empty groups.
    private var factGroups: [(category: TasteCategory, facts: [TasteFact])] {
        let grouped = Dictionary(grouping: model.tasteFacts, by: \.group)
        return TasteCategory.allCases.compactMap { category in
            guard let facts = grouped[category], !facts.isEmpty else { return nil }
            return (category, facts)
        }
    }

    private var profileHeader: some View {
        HStack(spacing: Space.md) {
            Avatar(person: Person(id: "me", name: model.firstName, hue: 2, rating: 5, circle: ""), size: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(model.firstName)
                    .font(Typo.title)
                    .tracking(-0.4)
                HStack(spacing: Space.xs) {
                    Pill(text: "New trader", symbol: "sparkles", tint: Palette.iris)
                    Pill(text: "\(model.circles.count) Circles", tint: Palette.ink)
                }
            }
            Spacer()
        }
        .padding(.top, Space.md)
    }

    private func deleteAccount() {
        isDeleting = true
        deleteError = nil
        Task {
            do {
                try await model.deleteAccount()
            } catch {
                deleteError = "Couldn't delete right now. Try again in a moment."
            }
            isDeleting = false
        }
    }
}

private struct TasteFactRow: View {
    var fact: TasteFact
    var onForget: () -> Void

    var body: some View {
        HStack(spacing: Space.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(fact.value)
                    .font(Typo.callout)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let source = fact.source, !source.isEmpty {
                    Text("From \(source)")
                        .font(Typo.caption)
                        .foregroundStyle(Palette.inkTertiary)
                }
            }
            Spacer()
            Button(action: onForget) {
                Image(systemName: "minus.circle.fill")
                    .font(.system(size: 20))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Palette.danger)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Forget \(fact.value)")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .transition(.opacity.combined(with: .move(edge: .leading)))
    }
}

struct AutonomyOption: View {
    var level: AutonomyLevel
    var isSelected: Bool
    var onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: Space.md) {
                ZStack {
                    Circle()
                        .strokeBorder(isSelected ? Palette.iris : Palette.ink.opacity(0.2), lineWidth: 2)
                    Circle()
                        .fill(Palette.iris)
                        .padding(5)
                        .scaleEffect(isSelected ? 1 : 0.01)
                }
                .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(level.title)
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                    Text(level.detail)
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                }
                Spacer()
            }
            .padding(Space.md)
            .background {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Palette.surface)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(isSelected ? Palette.iris.opacity(0.5) : Palette.hairline, lineWidth: isSelected ? 1.5 : 1)
            }
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.selection, trigger: isSelected)
    }
}
