// HairTryOnApp.swift — entry point.
//
// NOT COMPILED IN THIS REPOSITORY'S CI: the app layer needs the iOS 18 SDK
// (ARKit, RealityKit, MediaPipe). Everything it builds on (HairKit) is compiled
// and tested on Linux. See docs/BUILD.md for the on-device checklist.

import SwiftUI
import ARKit

@main
struct HairTryOnApp: App {
    @State private var store = TryOnStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @Environment(TryOnStore.self) private var store

    var body: some View {
        switch store.phase {
        case .unsupported:
            UnsupportedDeviceView()
        case .onboarding:
            OnboardingView()
        case .live:
            TryOnScreen()
        }
    }
}
