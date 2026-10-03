import SwiftUI
import UIKit

// Design tokens. Source of truth: docs/design.md.
// Everything here is `nonisolated` so shaders, renderers and Sendable closures can use it.

nonisolated func dynamicColor(light: UInt32, dark: UInt32) -> Color {
    Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
    })
}

nonisolated extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

nonisolated enum Palette {
    // Surfaces
    static let canvas = dynamicColor(light: 0xF6F4EF, dark: 0x0B0B0E)
    static let surface = dynamicColor(light: 0xFFFFFF, dark: 0x16161B)
    static let surfaceRaised = dynamicColor(light: 0xFBFAF7, dark: 0x1D1D23)
    static let ink = dynamicColor(light: 0x121216, dark: 0xF4F2EE)
    static let inkSecondary = ink.opacity(0.58)
    static let inkTertiary = ink.opacity(0.36)
    static let hairline = ink.opacity(0.08)

    // The Loop
    static let tangerine = dynamicColor(light: 0xFF7A2F, dark: 0xFF8A45)
    static let bubblegum = dynamicColor(light: 0xFF4F9A, dark: 0xFF6AAB)
    static let iris = dynamicColor(light: 0x7A5CFF, dark: 0x8F76FF)
    static let pool = dynamicColor(light: 0x2FC4FF, dark: 0x4FD0FF)

    // Semantic
    static let mint = dynamicColor(light: 0x22C997, dark: 0x3EDDAA)
    static let gold = dynamicColor(light: 0xFFB020, dark: 0xFFC24D)
    static let give = tangerine
    static let receive = pool
    static let danger = dynamicColor(light: 0xE5484D, dark: 0xFF6369)

    static let loop: [Color] = [tangerine, bubblegum, iris, pool]
    static let loopGradient = LinearGradient(
        colors: [tangerine, bubblegum, iris, pool],
        startPoint: .leading,
        endPoint: .trailing
    )
    static let loopAngular = AngularGradient(
        colors: [tangerine, bubblegum, iris, pool, tangerine],
        center: .center
    )
}

nonisolated enum Typo {
    static let display = Font.system(size: 40, weight: .heavy, design: .rounded)
    static let title = Font.system(size: 28, weight: .bold, design: .rounded)
    static let title2 = Font.system(size: 22, weight: .bold, design: .rounded)
    static let headline = Font.system(size: 19, weight: .semibold, design: .rounded)
    static let body = Font.system(size: 17, weight: .regular)
    static let bodyEmphasis = Font.system(size: 17, weight: .semibold)
    static let callout = Font.system(size: 15, weight: .medium)
    static let footnote = Font.system(size: 13, weight: .medium)
    static let caption = Font.system(size: 12, weight: .semibold)
    static let value = Font.system(size: 17, weight: .semibold, design: .rounded).monospacedDigit()
    static let valueLarge = Font.system(size: 28, weight: .bold, design: .rounded).monospacedDigit()
}

nonisolated enum Space {
    static let xxs: CGFloat = 4
    static let xs: CGFloat = 8
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
    static let huge: CGFloat = 48
    static let gutter: CGFloat = 20
    /// Room for the floating tab bar at the bottom of scrolling screens.
    static let tabBarClearance: CGFloat = 110
}

nonisolated enum Radius {
    static let card: CGFloat = 28
    static let tile: CGFloat = 20
    static let small: CGFloat = 14
}

nonisolated enum Motion {
    static let snappy = Animation.spring(response: 0.30, dampingFraction: 0.80)
    static let bouncy = Animation.spring(response: 0.45, dampingFraction: 0.62)
    static let soft = Animation.spring(response: 0.60, dampingFraction: 0.90)
}

// MARK: - Text styles

extension View {
    /// Uppercase label used above sections and on chips.
    func sectionLabel() -> some View {
        self
            .font(Typo.caption)
            .tracking(0.6)
            .textCase(.uppercase)
            .foregroundStyle(Palette.inkSecondary)
    }
}

// MARK: - Money

nonisolated enum Money {
    /// "$180" from cents. Whole dollars: values are estimates, cents add false precision.
    static func dollars(_ cents: Int) -> String {
        let dollars = Double(cents) / 100
        return dollars.formatted(.currency(code: "USD").precision(.fractionLength(0)))
    }

    /// "$180 to $250"
    static func range(low: Int, high: Int) -> String {
        "\(dollars(low)) to \(dollars(high))"
    }
}
