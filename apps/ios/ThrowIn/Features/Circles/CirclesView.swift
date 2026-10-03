import SwiftUI

/// Circles: the trusted groups you trade inside. Invite-only; density makes matches likely.
struct CirclesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Circles")
                            .font(Typo.title)
                            .tracking(-0.4)
                        Text("Your GM only trades inside groups you trust.")
                            .font(Typo.callout)
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    .padding(.top, Space.xs)

                    ForEach(Array(model.circles.enumerated()), id: \.element.id) { index, circle in
                        CircleCard(circle: circle, accent: Palette.loop[(index * 2) % Palette.loop.count])
                    }

                    Button {} label: {
                        HStack(spacing: Space.xs) {
                            Image(systemName: "plus")
                                .font(.system(size: 15, weight: .bold))
                            Text("Start a Circle")
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                            Spacer()
                        }
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, Space.lg)
                        .frame(height: 56)
                        .background {
                            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                                .strokeBorder(Palette.ink.opacity(0.14), style: StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
                        }
                    }
                    .buttonStyle(.pressable)
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.tabBarClearance)
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
        }
    }
}

struct CircleCard: View {
    var circle: TradeCircle
    var accent: Color

    var body: some View {
        PaperCard(padding: 0) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    LinearGradient(colors: [accent.opacity(0.35), accent.opacity(0.08)], startPoint: .topLeading, endPoint: .bottomTrailing)
                        .frame(height: 96)
                    AvatarStack(people: circle.members, size: 40, limit: 5)
                        .padding(Space.lg)
                        .offset(y: 20)
                }
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: Radius.card, topTrailingRadius: Radius.card, style: .continuous))

                VStack(alignment: .leading, spacing: Space.sm) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(circle.name)
                            .font(Typo.headline)
                            .foregroundStyle(Palette.ink)
                        Text("\(circle.members.count) members, mostly \(circle.focus)")
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    HStack(spacing: 6) {
                        Image(systemName: "mappin.circle.fill")
                            .foregroundStyle(accent)
                        Text(circle.defaultSpot)
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    ShareLink(
                        item: circle.inviteURL,
                        subject: Text("Join \(circle.name) on Throw-In"),
                        message: Text("I'm trading on Throw-In. Join \(circle.name) and your GM will find trades for you.")
                    ) {
                        HStack(spacing: 6) {
                            Image(systemName: "person.badge.plus")
                            Text("Invite a friend")
                        }
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .frame(maxWidth: .infinity)
                        .frame(height: 30)
                    }
                    .buttonStyle(.glass)
                    .padding(.top, Space.xxs)
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.xl)
                .padding(.bottom, Space.lg)
            }
        }
    }
}
