import SwiftUI

/// First-time experience (PRD target: under 4 minutes to a first Ask).
/// Invite landing, sign in, third-party AI consent, then the GM says hello.
/// The full intake chat and first Ask arrive with the GM harness in Milestone 2.
struct OnboardingFlow: View {
    enum Step: Int, CaseIterable {
        case invite, name, consent, hello
    }

    @Environment(AppModel.self) private var model
    @State private var step: Step = .invite
    @State private var firstName = ""
    @State private var email = ""
    @FocusState private var emailFocused: Bool
    @State private var consented = false
    @State private var isWorking = false
    @State private var errorText: String?
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            MeshBackdrop(intensity: step == .hello ? 1.15 : 0.9)
                .paperGrain(strength: 0.03)

            VStack(spacing: 0) {
                progress
                    .padding(.top, Space.sm)

                Spacer(minLength: Space.lg)

                GMOrbView(mood: orbMood, size: orbSize)
                    .animation(Motion.bouncy, value: step)
                    .padding(.bottom, Space.xl)

                Group {
                    switch step {
                    case .invite: inviteStep
                    case .name: nameStep
                    case .consent: consentStep
                    case .hello: HelloStep(firstName: model.firstName) { model.finishOnboarding() }
                    }
                }
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 28)),
                        removal: .opacity.combined(with: .scale(scale: 0.95))
                    )
                )

                Spacer(minLength: Space.lg)
            }
            .padding(.horizontal, Space.xl)
        }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: step)
    }

    private var orbMood: OrbMood {
        switch step {
        case .invite: .idle
        case .name: nameFocused ? .thinking : .idle
        case .consent: .idle
        case .hello: .speaking
        }
    }

    private var orbSize: CGFloat {
        switch step {
        case .invite: 150
        case .name: 104
        case .consent: 84
        case .hello: 176
        }
    }

    private func go(_ next: Step) {
        withAnimation(Motion.bouncy) { step = next }
    }

    // MARK: Progress

    private var progress: some View {
        HStack(spacing: 6) {
            ForEach(Step.allCases, id: \.self) { s in
                Capsule()
                    .fill(s.rawValue <= step.rawValue ? AnyShapeStyle(Palette.ink) : AnyShapeStyle(Palette.ink.opacity(0.12)))
                    .frame(width: s == step ? 22 : 6, height: 6)
            }
        }
        .animation(Motion.bouncy, value: step)
        .accessibilityElement()
        .accessibilityLabel("Step \(step.rawValue + 1) of \(Step.allCases.count)")
    }

    // MARK: Invite

    private var inviteStep: some View {
        VStack(spacing: Space.lg) {
            VStack(spacing: Space.sm) {
                HStack(spacing: Space.xs) {
                    Avatar(person: DemoData.jordan, size: 26)
                    Text("Jordan invited you to")
                        .font(Typo.callout)
                        .foregroundStyle(Palette.inkSecondary)
                }
                Text("Thursday Lego Circle")
                    .font(Typo.display)
                    .tracking(-0.8)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Palette.ink)
                Text("Trade what you have for what you want. Your GM does the legwork.")
                    .font(Typo.body)
                    .foregroundStyle(Palette.inkSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Space.md)
            }

            HStack(spacing: Space.xs) {
                AvatarStack(people: DemoData.circles[0].members, size: 30)
                Text("\(DemoData.circles[0].members.count) members")
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.inkSecondary)
            }

            Button {
                go(.name)
            } label: {
                PrimaryLabel("Join the Circle")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .padding(.top, Space.sm)
        }
    }

    // MARK: Name

    private var nameStep: some View {
        VStack(spacing: Space.xl) {
            VStack(spacing: Space.xs) {
                Text("What should your GM call you?")
                    .font(Typo.title)
                    .tracking(-0.4)
                    .multilineTextAlignment(.center)
                Text("First name is plenty.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }

            VStack(spacing: 10) {
                TextField("", text: $firstName, prompt: Text("Your first name").foregroundStyle(Palette.inkTertiary))
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .multilineTextAlignment(.center)
                    .textContentType(.givenName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(model.isLive ? .next : .continue)
                    .focused($nameFocused)
                    .onSubmit {
                        if model.isLive { emailFocused = true } else { submitName() }
                    }
                Capsule()
                    .fill(Palette.loopGradient)
                    .frame(height: 3)
                    .frame(maxWidth: nameFocused ? .infinity : 80)
                    .animation(Motion.bouncy, value: nameFocused)

                if model.isLive {
                    TextField("", text: $email, prompt: Text("Email").foregroundStyle(Palette.inkTertiary))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                        .multilineTextAlignment(.center)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.continue)
                        .focused($emailFocused)
                        .onSubmit(submitName)
                        .padding(.top, Space.md)
                    Capsule()
                        .fill(Palette.ink.opacity(emailFocused ? 0.5 : 0.12))
                        .frame(height: 2)
                        .frame(maxWidth: 200)
                        .animation(Motion.snappy, value: emailFocused)
                }
            }
            .padding(.horizontal, Space.xl)

            if let errorText {
                Text(errorText)
                    .font(Typo.footnote)
                    .foregroundStyle(Palette.danger)
            }

            Button(action: submitName) {
                ZStack {
                    Text("Continue").opacity(isWorking ? 0 : 1)
                    LoopIndicator(people: 3, size: 22).opacity(isWorking ? 1 : 0)
                }
                .font(.system(size: 17, weight: .bold, design: .rounded))
                .foregroundStyle(Palette.canvas)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .disabled(!canSubmitName || isWorking)

            #if DEBUG
            Text(model.isLive ? "Dev sign-in with email. Sign in with Apple replaces this once the Developer account is set up." : "Demo mode. Nothing leaves this phone.")
                .font(Typo.caption)
                .foregroundStyle(Palette.inkTertiary)
                .multilineTextAlignment(.center)
            #endif
        }
        .onAppear { nameFocused = true }
    }

    private var canSubmitName: Bool {
        guard !trimmedName.isEmpty else { return false }
        guard model.isLive else { return true }
        let value = email.trimmingCharacters(in: .whitespaces)
        return value.contains("@") && value.contains(".")
    }

    private var trimmedName: String {
        firstName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitName() {
        guard canSubmitName, !isWorking else { return }
        isWorking = true
        errorText = nil
        Task {
            do {
                try await model.signIn(firstName: trimmedName, email: model.isLive ? email : nil)
                emailFocused = false
                nameFocused = false
                go(.consent)
            } catch {
                errorText = (error as? APIError)?.message ?? "Couldn't sign in. Check your connection and try again."
            }
            isWorking = false
        }
    }

    // MARK: Consent (App Store 5.1.2(i))

    private var consentStep: some View {
        VStack(spacing: Space.lg) {
            VStack(spacing: Space.xs) {
                Text("Your GM runs on Claude")
                    .font(Typo.title)
                    .tracking(-0.4)
                Text("Here's what that means for your stuff.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.inkSecondary)
            }
            .multilineTextAlignment(.center)

            PaperCard(padding: Space.lg) {
                VStack(alignment: .leading, spacing: Space.md) {
                    consentRow("camera.viewfinder", Palette.tangerine, "Photos you add are analyzed to identify and price your items.")
                    consentRow("bubble.left.and.text.bubble.right", Palette.iris, "Your chats with your GM are processed by Anthropic's Claude models.")
                    consentRow("hand.raised", Palette.mint, "We never sell your data or use it for ads. Delete it all anytime.")
                }
            }

            Toggle(isOn: $consented.animation(Motion.snappy)) {
                Text("I agree to let Anthropic's models process my photos and messages.")
                    .font(Typo.callout)
                    .foregroundStyle(Palette.ink)
            }
            .tint(Palette.iris)
            .padding(.horizontal, Space.xxs)
            .sensoryFeedback(.selection, trigger: consented)

            Button {
                model.recordAIConsent()
                go(.hello)
            } label: {
                PrimaryLabel("Continue")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .disabled(!consented)
        }
    }

    private func consentRow(_ symbol: String, _ tint: Color, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Space.sm) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text(text)
                .font(Typo.callout)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The GM's first words, streamed with the bloom.
private struct HelloStep: View {
    var firstName: String
    var onDone: () -> Void

    @State private var streamed = StreamedText()
    @State private var epoch = Date()
    @State private var finished = false

    var body: some View {
        VStack(spacing: Space.xl) {
            BloomingText(
                streamed: streamed,
                epoch: epoch,
                font: .system(size: 26, weight: .bold, design: .rounded)
            )
            .multilineTextAlignment(.center)
            .frame(minHeight: 140, alignment: .top)

            Button(action: onDone) {
                PrimaryLabel("Let's go")
            }
            .buttonStyle(.glassProminent)
            .tint(Palette.ink)
            .opacity(finished ? 1 : 0)
            .scaleEffect(finished ? 1 : 0.9)
            .animation(Motion.bouncy, value: finished)
        }
        .task {
            epoch = Date()
            let line = "Hi \(firstName). I'm your GM. Tell me 1 thing you want, and I'll find someone in your Circles who'd trade for it."
            try? await Task.sleep(for: .milliseconds(350))
            await streamDemoText(line, epoch: epoch) { token, arrival in
                streamed.append(token, at: arrival)
            }
            try? await Task.sleep(for: .milliseconds(400))
            finished = true
        }
    }
}

#Preview {
    OnboardingFlow()
        .environment(AppModel())
}
