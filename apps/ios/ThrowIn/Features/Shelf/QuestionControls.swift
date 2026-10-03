import SwiftUI

/// The answer controls for 1 Refiner question: big chips for yes or no and choices, a wheel
/// or chips for pickers, a short field for text, and "Take photo" for a photo. Used on the
/// product card and in Tune up.
struct QuestionAnswerControls: View {
    var question: Question
    var onAnswer: (String) -> Void
    var onPhoto: () -> Void

    @State private var picked = ""
    @State private var typed = ""
    @FocusState private var isTyping: Bool

    private static let maxPickerChips = 6
    private static let maxAnswerLength = 200

    var body: some View {
        switch question.kind {
        case .choice where question.options.isEmpty, .picker where question.options.isEmpty:
            // Nothing to pick from: let them type it.
            textField
        case .yesNo:
            let options = question.options.isEmpty ? ["Yes", "No", "Not sure"] : question.options
            HStack(spacing: Space.xs) {
                ForEach(options, id: \.self) { option in
                    AnswerChip(text: option, isQuiet: isUnsure(option)) { onAnswer(option) }
                }
            }
        case .choice:
            VStack(spacing: Space.xs) {
                ForEach(question.options, id: \.self) { option in
                    AnswerChip(text: option, isQuiet: isUnsure(option)) { onAnswer(option) }
                }
            }
        case .picker:
            if question.options.count <= Self.maxPickerChips {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: Space.xs)], spacing: Space.xs) {
                    ForEach(question.options, id: \.self) { option in
                        AnswerChip(text: option, isQuiet: isUnsure(option)) { onAnswer(option) }
                    }
                }
            } else {
                wheel
            }
        case .text:
            textField
        case .photo:
            Button(action: onPhoto) {
                PrimaryLabel("Take photo", symbol: "camera.fill")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
        }
    }

    private var wheel: some View {
        VStack(spacing: Space.sm) {
            Picker(question.prompt, selection: $picked) {
                ForEach(question.options, id: \.self) { option in
                    Text(option)
                        .font(Typo.headline)
                        .tag(option)
                }
            }
            .pickerStyle(.wheel)
            .frame(height: 132)
            .clipped()

            Button {
                onAnswer(picked.isEmpty ? (question.options.first ?? "") : picked)
            } label: {
                PrimaryLabel("That's it", symbol: "checkmark")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
        }
        .onAppear {
            if picked.isEmpty {
                picked = question.options[question.options.count / 2]
            }
        }
    }

    private var textField: some View {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(spacing: Space.sm) {
            TextField("Type it here", text: $typed)
                .font(Typo.body)
                .focused($isTyping)
                .submitLabel(.done)
                .onSubmit(submitText)
                .padding(.horizontal, Space.md)
                .frame(height: 52)
                .background(Palette.surfaceRaised, in: Capsule())
                .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                .onChange(of: typed) { _, value in
                    if value.count > Self.maxAnswerLength { typed = String(value.prefix(Self.maxAnswerLength)) }
                }
            Button(action: submitText) {
                PrimaryLabel("Save", symbol: "checkmark")
                    .frame(height: 48)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .disabled(trimmed.isEmpty)
        }
    }

    private func submitText() {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isTyping = false
        onAnswer(trimmed)
        typed = ""
    }

    private func isUnsure(_ option: String) -> Bool {
        option.lowercased().hasPrefix("not sure")
    }
}

/// A big answer chip: 1 tap answers.
struct AnswerChip: View {
    var text: String
    var isQuiet: Bool = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 17, weight: .semibold, design: .rounded))
                .foregroundStyle(isQuiet ? Palette.inkSecondary : Palette.ink)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Space.md)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background(isQuiet ? Palette.ink.opacity(0.04) : Palette.surfaceRaised, in: Capsule())
                .overlay(Capsule().strokeBorder(Palette.hairline, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressable)
    }
}
