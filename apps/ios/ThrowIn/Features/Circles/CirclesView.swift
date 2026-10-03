import SwiftUI

/// Circles: the trusted groups you trade inside. Invite-only; density makes matches likely.
struct CirclesView: View {
    @Environment(AppModel.self) private var model
    @State private var showsNewCircle = false
    @State private var showsJoin = false

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

                    if model.circles.isEmpty {
                        Text("You're not in a Circle yet. Start one for your friends, or join with an invite link.")
                            .font(Typo.callout)
                            .foregroundStyle(Palette.inkSecondary)
                            .padding(.horizontal, 4)
                    }

                    ForEach(Array(model.circles.enumerated()), id: \.element.id) { index, circle in
                        CircleCard(circle: circle, accent: Palette.loop[(index * 2) % Palette.loop.count])
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }

                    VStack(spacing: Space.sm) {
                        dashedButton("Start a Circle", symbol: "plus") { showsNewCircle = true }
                        dashedButton("Join with an invite", symbol: "link") { showsJoin = true }
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.tabBarClearance)
                .animation(Motion.bouncy, value: model.circles.map(\.id))
            }
            .scrollIndicators(.hidden)
            .background(Palette.canvas)
            .task { await model.refreshCircles() }
            .refreshable { await model.refreshCircles() }
            .sheet(isPresented: $showsNewCircle) {
                NewCircleSheet()
                    .presentationDetents([.medium])
                    .presentationCornerRadius(32)
            }
            .sheet(isPresented: $showsJoin) {
                JoinCircleSheet()
                    .presentationDetents([.medium, .large])
                    .presentationCornerRadius(32)
            }
        }
    }

    private func dashedButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .bold))
                Text(title)
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
}

struct CircleCard: View {
    var circle: TradeCircle
    var accent: Color

    @Environment(AppModel.self) private var model
    @State private var inviteURL: URL?
    @State private var isLoadingInvite = false
    @State private var inviteError: String?

    private var summary: String {
        let members = circle.memberCount == 1 ? "1 member" : "\(circle.memberCount) members"
        guard let focus = circle.focus else { return members }
        return "\(members), mostly \(focus)"
    }

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
                        Text(summary)
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.inkSecondary)
                    }
                    if let spot = circle.defaultSpot {
                        HStack(spacing: 6) {
                            Image(systemName: "mappin.circle.fill")
                                .foregroundStyle(accent)
                            Text(spot)
                                .font(Typo.footnote)
                                .foregroundStyle(Palette.inkSecondary)
                        }
                    }
                    invite
                        .padding(.top, Space.xxs)
                    if let inviteError {
                        Text(inviteError)
                            .font(Typo.footnote)
                            .foregroundStyle(Palette.danger)
                    }
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.xl)
                .padding(.bottom, Space.lg)
            }
        }
        .onAppear {
            // Demo Circles come with their link; live ones make a fresh code on first tap.
            if inviteURL == nil, !model.isLive { inviteURL = circle.inviteURL }
        }
    }

    @ViewBuilder
    private var invite: some View {
        if let inviteURL {
            ShareLink(
                item: inviteURL,
                subject: Text("Join \(circle.name) on Throw-In"),
                message: Text("I'm trading on Throw-In. Join \(circle.name) and your GM will find trades for you.")
            ) {
                inviteLabel("Share invite link", symbol: "square.and.arrow.up")
            }
            .buttonStyle(.glass)
        } else {
            Button {
                makeInvite()
            } label: {
                inviteLabel(isLoadingInvite ? "Making a link" : "Invite a friend", symbol: "person.badge.plus")
            }
            .buttonStyle(.glass)
            .disabled(isLoadingInvite)
        }
    }

    private func inviteLabel(_ text: String, symbol: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
            Text(text)
        }
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .foregroundStyle(Palette.ink)
        .frame(maxWidth: .infinity)
        .frame(height: 30)
    }

    private func makeInvite() {
        isLoadingInvite = true
        inviteError = nil
        Task {
            do {
                let url = try await model.inviteLink(for: circle)
                withAnimation(Motion.snappy) { inviteURL = url }
            } catch {
                inviteError = "Couldn't make an invite link. Try again."
            }
            isLoadingInvite = false
        }
    }
}

/// Name a new Circle. The creator is its owner and first member.
private struct NewCircleSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isSaving = false
    @State private var errorText: String?
    @FocusState private var focused: Bool

    private var cleanName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Start a Circle").font(Typo.title2)
                Text("A group you'd trade with in person, like friends, your office or a hobby club.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }
            SheetTextField(placeholder: "Thursday Lego Circle", text: $name)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(save)
            if let errorText {
                Text(errorText).font(Typo.footnote).foregroundStyle(Palette.danger)
            }
            Button(action: save) {
                PrimaryLabel(isSaving ? "Starting" : "Start Circle", symbol: "circle.hexagongrid")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .disabled(cleanName.isEmpty || cleanName.count > 60 || isSaving)
            Spacer(minLength: 0)
        }
        .padding(Space.xl)
        .onAppear { focused = true }
    }

    private func save() {
        guard !cleanName.isEmpty, cleanName.count <= 60, !isSaving else { return }
        isSaving = true
        errorText = nil
        Task {
            do {
                try await model.createCircle(named: cleanName)
                dismiss()
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't start the Circle. Try again."
            }
            isSaving = false
        }
    }
}

/// Paste an invite link or code, see whose Circle it is, then join.
struct JoinCircleSheet: View {
    var initialCode: String = ""

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var preview: InvitePreview?
    @State private var isWorking = false
    @State private var errorText: String?
    @State private var joined = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Join a Circle").font(Typo.title2)
                Text("Paste the invite link a friend sent you.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }

            if let preview {
                previewCard(preview)
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                SheetTextField(placeholder: "throwin.app/i/...", text: $text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(lookUp)
            }

            if let errorText {
                Text(errorText).font(Typo.footnote).foregroundStyle(Palette.danger)
            }

            if let preview {
                if preview.status == .open {
                    Button(action: join) {
                        PrimaryLabel(isWorking ? "Joining" : "Join \(preview.circleName)", symbol: "person.badge.plus")
                    }
                    .buttonStyle(.glassProminent)
                    .tint(Palette.ink)
                    .disabled(isWorking)
                }
                Button("Use a different link") {
                    withAnimation(Motion.snappy) {
                        self.preview = nil
                        errorText = nil
                    }
                }
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
                .frame(maxWidth: .infinity)
            } else {
                Button(action: lookUp) {
                    PrimaryLabel(isWorking ? "Looking it up" : "Look it up", symbol: "magnifyingglass")
                }
                .buttonStyle(.glassProminent)
                .tint(Palette.ink)
                .disabled(AppModel.inviteCode(from: text) == nil || isWorking)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.xl)
        .animation(Motion.bouncy, value: preview)
        .sensoryFeedback(.success, trigger: joined)
        .onAppear {
            if text.isEmpty, !initialCode.isEmpty {
                text = initialCode
                lookUp()
            }
        }
    }

    private func previewCard(_ p: InvitePreview) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(p.inviterFirstName.map { "\($0) invited you to" } ?? "You're invited to")
                .font(Typo.callout)
                .foregroundStyle(Palette.inkSecondary)
            Text(p.circleName)
                .font(Typo.headline)
                .foregroundStyle(Palette.ink)
            Text(p.memberCount == 1 ? "1 member" : "\(p.memberCount) members")
                .font(Typo.footnote)
                .foregroundStyle(Palette.inkSecondary)
            if let note = statusNote(p.status) {
                Text(note)
                    .font(Typo.footnote)
                    .foregroundStyle(p.status == .alreadyMember ? Palette.mint : Palette.danger)
                    .padding(.top, Space.xxs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.lg)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }

    private func statusNote(_ status: InvitePreview.Status) -> String? {
        switch status {
        case .open: nil
        case .alreadyMember: "You're already in this Circle."
        case .expired: "This invite expired. Ask for a new link."
        case .full: "This invite has been used up. Ask for a new link."
        }
    }

    private func lookUp() {
        guard let code = AppModel.inviteCode(from: text), !isWorking else { return }
        isWorking = true
        errorText = nil
        Task {
            do {
                let found = try await model.previewInvite(code)
                withAnimation(Motion.bouncy) { preview = found }
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't check that link. Try again."
            }
            isWorking = false
        }
    }

    private func join() {
        guard let preview, !isWorking else { return }
        isWorking = true
        errorText = nil
        Task {
            do {
                try await model.joinCircle(code: preview.code)
                joined += 1
                dismiss()
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't join. Try again."
            }
            isWorking = false
        }
    }
}

/// A single-line field on paper, like the Item edit sheet's.
private struct SheetTextField: View {
    var placeholder: String
    @Binding var text: String

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Palette.inkTertiary))
            .font(Typo.headline)
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.md)
            .frame(height: 52)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.small, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.small, style: .continuous)
                    .strokeBorder(Palette.hairline, lineWidth: 1)
            }
    }
}
