// TryOnScreen.swift — the live camera with the style, status, honesty tip and controls.

import SwiftUI
import TryOnCore

struct TryOnScreen: View {
    @Environment(TryOnStore.self) private var store
    @State private var engine: TryOnEngine?
    @Environment(\.scenePhase) private var scenePhase
    @State private var wasBackgrounded = false

    var body: some View {
        ZStack(alignment: .bottom) {
            if let engine {
                ARContainer(engine: engine).ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack(spacing: 10) {
                HStack {
                    Text(store.status)
                        .font(.footnote.monospaced())
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(.ultraThinMaterial, in: Capsule())
                        .accessibilityLabel("Status: \(store.status)")
                    Spacer()
                    if store.isBuilding { ProgressView().tint(.white) }
                }
                Spacer()
                if let tip = store.conflictTip { NoticeCard(title: "Your own hair would still show.", text: tip, systemImage: "exclamationmark.triangle.fill", tint: .orange) }
                if let locked = store.lockedMessage { NoticeCard(title: "Locked length", text: locked, systemImage: "lock.fill", tint: .secondary) }
                ControlPanel(engine: engine)
            }
            .padding()

            if let p = store.calibrationProgress { CalibrationOverlay(progress: p) { engine?.cancelCalibration() } }
        }
        .onAppear { if engine == nil { engine = TryOnEngine(store: store) } }
        .onChange(of: scenePhase) { _, phase in
            // Returning from the background goes background -> inactive -> active, so remember the
            // background visit; Control Centre or a banner (active -> inactive -> active) must not
            // reset the session and rebuild the style.
            switch phase {
            case .background:
                wasBackgrounded = true
                engine?.pause()
            case .active where wasBackgrounded:
                wasBackgrounded = false
                engine?.start()
            default:
                break
            }
        }
        .sheet(item: Bindable(store).capture) { look in CaptureSheet(look: look) }
    }
}

struct NoticeCard: View {
    let title: String
    let text: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.bold())
                Text(text).font(.footnote)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}
