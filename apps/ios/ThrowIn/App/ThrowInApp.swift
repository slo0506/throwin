import SwiftUI

@main
struct ThrowInApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(Palette.iris)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()
            switch model.phase {
            case .onboarding:
                OnboardingFlow()
                    .transition(.blurReplace)
            case .main:
                MainShell()
                    .transition(.blurReplace)
            }
        }
        .animation(Motion.soft, value: model.phase)
    }
}

/// The signed-in app: 4 tabs kept alive in a stack, the floating Loop tab bar, and the GM.
struct MainShell: View {
    @Environment(AppModel.self) private var model
    @State private var rippleOrigin: CGPoint = .zero
    @State private var rippleTrigger = 0

    var body: some View {
        @Bindable var model = model
        ZStack(alignment: .bottom) {
            ZStack {
                ForEach(AppTab.allCases) { tab in
                    let isSelected = model.tab == tab
                    screen(for: tab)
                        .opacity(isSelected ? 1 : 0)
                        .scaleEffect(isSelected ? 1 : 0.985)
                        .blur(radius: isSelected ? 0 : 8)
                        .allowsHitTesting(isSelected)
                        .accessibilityHidden(!isSelected)
                }
            }
            .rippleRing(at: rippleOrigin, trigger: rippleTrigger)

            LoopTabBar(selection: $model.tab, orbMood: model.isGMPresented ? .thinking : .idle) { origin in
                rippleOrigin = origin
                rippleTrigger += 1
                Task {
                    try? await Task.sleep(for: .milliseconds(140))
                    model.openGM()
                }
            }
            .padding(.bottom, 2)
        }
        .sheet(isPresented: $model.isGMPresented) {
            GMChatView()
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(38)
                .presentationBackground(Palette.canvas)
        }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView()
        case .shelf: ShelfView()
        case .circles: CirclesView()
        case .you: SettingsView()
        }
    }
}
