import SwiftUI

/// Fix what the GM read: the Item's name and its condition grade. Saving is optimistic in the
/// AppModel, so the sheet closes right away and rolls back with a banner if the save fails.
struct ItemEditSheet: View {
    var item: ShelfItem
    var onSave: (_ title: String, _ grade: ConditionGrade?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title: String
    @State private var grade: ConditionGrade?
    @FocusState private var titleFocused: Bool

    init(item: ShelfItem, onSave: @escaping (_ title: String, _ grade: ConditionGrade?) -> Void) {
        self.item = item
        self.onSave = onSave
        _title = State(initialValue: item.title)
        _grade = State(initialValue: item.conditionGrade)
    }

    private var cleanTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool {
        !cleanTitle.isEmpty && (cleanTitle != item.title || grade != item.conditionGrade)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "What it is")
                        TextField("Name", text: $title)
                            .font(Typo.headline)
                            .foregroundStyle(Palette.ink)
                            .submitLabel(.done)
                            .focused($titleFocused)
                            .padding(.horizontal, Space.md)
                            .frame(height: 52)
                            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                                    .strokeBorder(titleFocused ? Palette.iris.opacity(0.5) : Palette.hairline, lineWidth: 1)
                            }
                            .onChange(of: title) { _, new in
                                if new.count > AppModel.maxTitleLength {
                                    title = String(new.prefix(AppModel.maxTitleLength))
                                }
                            }
                    }

                    VStack(alignment: .leading, spacing: Space.sm) {
                        SectionHeader(title: "Condition")
                        VStack(spacing: Space.xs) {
                            ForEach(ConditionGrade.allCases, id: \.self) { option in
                                GradeRow(grade: option, isSelected: grade == option) {
                                    withAnimation(Motion.snappy) { grade = option }
                                }
                            }
                        }
                    }

                    Text("Your GM prices and trades with these, so a quick fix keeps every deal fair.")
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)
                }
                .padding(.horizontal, Space.gutter)
                .padding(.vertical, Space.md)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.canvas)
            .navigationTitle("Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", systemImage: "checkmark") {
                        onSave(cleanTitle, grade)
                        dismiss()
                    }
                    .disabled(!canSave)
                }
            }
            .sensoryFeedback(.selection, trigger: grade)
        }
    }
}

/// 1 condition grade as a tappable row: the letter, what it means, and a check when chosen.
private struct GradeRow: View {
    var grade: ConditionGrade
    var isSelected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.md) {
                Text(grade.rawValue)
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(tint)
                    .frame(width: 40, height: 40)
                    .background(tint.opacity(0.14), in: Circle())
                Text(grade.meaning)
                    .font(Typo.headline)
                    .foregroundStyle(Palette.ink)
                Spacer()
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(tint)
                    .opacity(isSelected ? 1 : 0)
                    .scaleEffect(isSelected ? 1 : 0.6)
            }
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(isSelected ? tint.opacity(0.6) : Palette.hairline, lineWidth: isSelected ? 1.5 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Condition \(grade.rawValue), \(grade.meaning)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Same tints as `GradeChip`.
    private var tint: Color {
        switch grade {
        case .a: Palette.mint
        case .b: Palette.pool
        case .c: Palette.gold
        case .d: Palette.tangerine
        }
    }
}
