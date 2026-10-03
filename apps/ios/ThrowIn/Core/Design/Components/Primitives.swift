import SwiftUI

// MARK: - Paper card

/// Opaque content card: paper surface, hairline stroke, 2-layer soft shadow.
struct PaperCard<Content: View>: View {
    var padding: CGFloat = Space.lg
    var radius: CGFloat = Radius.card
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(Palette.surface)
                    .shadow(color: .black.opacity(0.07), radius: 24, y: 8)
                    .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
    }
}

// MARK: - Pressable

/// Springy press feedback for any tappable card.
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.97

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? -0.015 : 0)
            .animation(Motion.snappy, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}

// MARK: - Chips

struct GradeChip: View {
    var grade: ConditionGrade

    var body: some View {
        HStack(spacing: 4) {
            Text(grade.rawValue)
                .font(.system(size: 12, weight: .heavy, design: .rounded))
            Text(grade.meaning)
                .font(Typo.caption)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(color.opacity(0.12), in: Capsule())
        .accessibilityLabel("Condition \(grade.rawValue), \(grade.meaning)")
    }

    private var color: Color {
        switch grade {
        case .a: Palette.mint
        case .b: Palette.pool
        case .c: Palette.gold
        case .d: Palette.tangerine
        }
    }
}

struct WillingnessDot: View {
    var willingness: Willingness

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(Palette.surface, lineWidth: 2))
            .accessibilityLabel(willingness.label)
    }

    private var color: Color {
        switch willingness {
        case .wouldTrade: Palette.mint
        case .openToOffers: Palette.gold
        case .notAvailable: Palette.inkTertiary
        }
    }
}

struct Pill: View {
    var text: String
    var symbol: String?
    var tint: Color = Palette.ink

    var body: some View {
        HStack(spacing: 5) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 11, weight: .bold))
            }
            Text(text).font(Typo.caption)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(tint.opacity(0.1), in: Capsule())
    }
}

// MARK: - Value range bar

/// Values are always ranges. A soft track, a filled span from low to high, and a mid tick.
/// `scaleMax` lets several bars share 1 scale (for example on a Deal Sheet).
struct ValueRangeBar: View {
    var range: ValueRange
    var tint: Color = Palette.iris
    var scaleMax: Int?
    var showsLabels: Bool = true

    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let maxValue = Double(scaleMax ?? Int(Double(range.highCents) * 1.25))
                let lowX = width * Double(range.lowCents) / maxValue
                let highX = width * Double(range.highCents) / maxValue
                let midX = width * Double(range.midCents) / maxValue
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.hairline)
                    Capsule()
                        .fill(LinearGradient(colors: [tint.opacity(0.55), tint], startPoint: .leading, endPoint: .trailing))
                        .frame(width: appeared ? max(8, highX - lowX) : 8)
                        .offset(x: appeared ? lowX : midX - 4)
                    Capsule()
                        .fill(Palette.surface)
                        .frame(width: 3, height: 12)
                        .shadow(color: .black.opacity(0.2), radius: 1, y: 0.5)
                        .offset(x: midX - 1.5)
                        .opacity(appeared ? 1 : 0)
                }
                .frame(height: 6)
                .frame(maxHeight: .infinity)
            }
            .frame(height: 12)

            if showsLabels {
                HStack {
                    Text(Money.dollars(range.lowCents))
                    Spacer()
                    Text(Money.dollars(range.highCents))
                }
                .font(Typo.caption.monospacedDigit())
                .foregroundStyle(Palette.inkSecondary)
            }
        }
        .onAppear {
            withAnimation(Motion.bouncy.delay(0.1)) { appeared = true }
        }
        .accessibilityElement()
        .accessibilityLabel("Worth about \(range.label)")
    }
}

// MARK: - Avatar

struct Avatar: View {
    var person: Person
    var size: CGFloat = 36

    var body: some View {
        let color = Palette.loop[person.hue % Palette.loop.count]
        Text(person.initials)
            .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background {
                Circle().fill(
                    LinearGradient(colors: [color.opacity(0.85), color], startPoint: .topLeading, endPoint: .bottomTrailing)
                )
            }
            .overlay(Circle().stroke(Palette.surface, lineWidth: 2))
            .accessibilityLabel(person.name)
    }
}

struct AvatarStack: View {
    var people: [Person]
    var size: CGFloat = 30
    var limit: Int = 4

    var body: some View {
        HStack(spacing: -size * 0.32) {
            ForEach(Array(people.prefix(limit))) { person in
                Avatar(person: person, size: size)
            }
            if people.count > limit {
                Text("+\(people.count - limit)")
                    .font(.system(size: size * 0.36, weight: .bold, design: .rounded))
                    .foregroundStyle(Palette.inkSecondary)
                    .frame(width: size, height: size)
                    .background(Circle().fill(Palette.surfaceRaised))
                    .overlay(Circle().stroke(Palette.surface, lineWidth: 2))
            }
        }
    }
}

// MARK: - Section header

struct SectionHeader: View {
    var title: String
    var trailing: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).sectionLabel()
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
            }
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - Primary button label

/// Label for `.glassProminent` buttons tinted with ink. Text uses the canvas color so it
/// reads in both light and dark mode.
struct PrimaryLabel: View {
    var text: String
    var symbol: String?

    init(_ text: String, symbol: String? = nil) {
        self.text = text
        self.symbol = symbol
    }

    var body: some View {
        HStack(spacing: 8) {
            if let symbol {
                Image(systemName: symbol)
            }
            Text(text)
        }
        .font(.system(size: 17, weight: .bold, design: .rounded))
        .foregroundStyle(Palette.canvas)
        .frame(maxWidth: .infinity)
        .frame(height: 40)
    }
}
