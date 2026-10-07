import SwiftUI

/// Your chats with the GM, sliding in from the leading edge like Messages' or Claude's list:
/// the main conversation (where you met your GM) pinned as "Your GM", then every other chat
/// by when you last used it, and New chat at the top. The GM's memory of you is the same in
/// all of them; each keeps its own history. Swipe it away or tap outside to close.
struct GMConversationDrawer: View {
    @Binding var isPresented: Bool
    var onOpen: (String) -> Void
    var onNew: () -> Void

    @Environment(AppModel.self) private var model
    @GestureState private var drag: CGFloat = 0

    private var chat: GMChatModel { model.gm }

    var body: some View {
        GeometryReader { proxy in
            let width = min(330, proxy.size.width * 0.84)
            ZStack(alignment: .leading) {
                Color.black.opacity(0.28 * progress(width))
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                    .accessibilityLabel("Close your chats")
                    .accessibilityAddTraits(.isButton)

                panel
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .background(Palette.canvas)
                    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: Radius.card, topTrailingRadius: Radius.card, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 30, x: 8)
                    .offset(x: min(0, drag))
                    .gesture(
                        DragGesture(minimumDistance: 12)
                            .updating($drag) { value, state, _ in state = value.translation.width }
                            .onEnded { value in
                                if value.translation.width < -width / 3 || value.predictedEndTranslation.width < -width / 2 {
                                    close()
                                }
                            }
                    )
                    .transition(.move(edge: .leading))
            }
        }
        .transition(.opacity)
        .sensoryFeedback(.impact(flexibility: .soft, intensity: 0.5), trigger: isPresented)
    }

    private func progress(_ width: CGFloat) -> Double {
        max(0, min(1, 1 + Double(drag) / Double(width)))
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack {
                Text("Chats")
                    .font(Typo.title2)
                    .foregroundStyle(Palette.ink)
                Spacer()
                Button {
                    onNew()
                    close()
                } label: {
                    Label("New chat", systemImage: "square.and.pencil")
                        .font(.system(size: 15, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, Space.md)
                        .frame(height: 38)
                }
                .buttonStyle(.glass)
                .disabled(chat.isBusy)
            }
            .padding(.top, Space.xl)

            ScrollView {
                VStack(alignment: .leading, spacing: Space.xs) {
                    if let main = chat.conversations.first(where: \.isMain) {
                        row(main)
                    }
                    let others = chat.conversations.filter { !$0.isMain }
                    if !others.isEmpty {
                        Text("Recent").sectionLabel()
                            .padding(.top, Space.md)
                            .padding(.horizontal, 4)
                        ForEach(others) { row($0) }
                    }
                }
                .padding(.bottom, Space.xl)
            }
            .scrollIndicators(.hidden)

            if chat.isBusy {
                Text("Your GM is replying. You can switch when it's done.")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkTertiary)
                    .padding(.bottom, Space.lg)
            }
        }
        .padding(.horizontal, Space.lg)
        .animation(Motion.snappy, value: chat.conversations)
    }

    private func row(_ c: GMConversationSummary) -> some View {
        let isOpen = c.id == chat.conversationID
        return Button {
            if !isOpen { onOpen(c.id) }
            close()
        } label: {
            HStack(spacing: Space.sm) {
                if c.isMain {
                    GMOrbView(mood: .idle, size: 30, showsGlow: false)
                } else {
                    Image(systemName: "bubble.left.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Palette.iris)
                        .frame(width: 30, height: 30)
                        .background(Palette.iris.opacity(0.12), in: Circle())
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.isMain ? "Your GM" : (c.title ?? "New chat"))
                        .font(.system(size: 16, weight: .semibold, design: .rounded))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(c.isMain ? "Where you met. Asks, deals, anything" : Self.when(c.updated))
                        .font(Typo.footnote)
                        .foregroundStyle(Palette.inkSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .frame(minHeight: 52)
            .background(
                isOpen ? Palette.ink.opacity(0.07) : .clear,
                in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(chat.isBusy && !isOpen)
        .accessibilityAddTraits(isOpen ? .isSelected : [])
    }

    private func close() {
        withAnimation(Motion.soft) { isPresented = false }
    }

    /// "Just now", "2h ago", "Yesterday", "Mon", "Oct 3".
    static func when(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "Just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "\(Int(seconds / 3600))h ago" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if seconds < 6 * 86_400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
