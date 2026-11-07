// ARContainer.swift — hosts the engine's ARView (and the honesty overlay) in SwiftUI.

import SwiftUI
import RealityKit

struct ARContainer: UIViewRepresentable {
    let engine: TryOnEngine

    func makeUIView(context: Context) -> UIView {
        let host = UIView()
        engine.arView.frame = host.bounds
        engine.arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        engine.overlay.frame = host.bounds
        engine.overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(engine.arView)
        host.addSubview(engine.overlay)
        engine.start()
        return host
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    static func dismantleUIView(_ uiView: UIView, coordinator: ()) {
        uiView.subviews.compactMap { $0 as? ARView }.first?.session.pause()
    }
}
