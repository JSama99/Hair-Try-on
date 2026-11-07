// TryOnStore.swift — the single source of truth for the UI.
// Views read it and send intents; the engine reports back through it.

import SwiftUI
import ARKit
import Observation
import ProtoStyle
import HeadFit
import TryOnCore

@MainActor
@Observable
final class TryOnStore {
    enum Phase { case unsupported, onboarding, live }

    let catalog = Catalog.shared
    var phase: Phase
    var look: Look = .default() { didSet { if look != oldValue { lookChanged() } } }
    var status = "Looking for your face…"
    var isBuilding = false
    var lockedMessage: String?
    var conflictTip: String?
    var calibrationProgress: Double?
    var calibration: SavedCalibration? = CalibrationStore.load()
    var capture: CapturedLook?

    /// Set by TryOnEngine when it starts; weak so the engine's lifetime follows the view.
    @ObservationIgnored weak var engine: TryOnEngine?
    @ObservationIgnored private var buildTask: Task<Void, Never>?
    @ObservationIgnored private var lastHead: HeadProxy?
    @ObservationIgnored private var installedSpec: StyleSpec?
    @ObservationIgnored private var cache: [CacheKey: StyleResult] = [:]

    struct CacheKey: Hashable { var spec: StyleSpec; var head: HeadProxy }

    init() {
        phase = ARFaceTrackingConfiguration.isSupported
            ? (UserDefaults.standard.bool(forKey: "onboarding.done.v1") ? .live : .onboarding)
            : .unsupported
    }

    var caption: String { catalog.caption(look) }

    func finishOnboarding() {
        UserDefaults.standard.set(true, forKey: "onboarding.done.v1")
        phase = .live
    }

    // MARK: intents

    func select(style id: String) { look = look.with(style: id, catalog) }
    func select(size id: String) { look.size = id }
    func select(color id: String) { look.color = id }
    func select(length id: String) {
        guard let l = catalog.length(id) else { return }
        if l.isLocked { lockedMessage = catalog.lockedMessage(for: l); return }
        lockedMessage = nil
        look.length = id
    }

    private func lookChanged() {
        if let c = catalog.color(look.color) { engine?.updateColor(c) }
        // A colour change only recolours; geometry is rebuilt only when the spec changes.
        guard let head = lastHead, case .ok(let spec) = catalog.resolve(look), spec != installedSpec else { return }
        generate(on: head)
    }

    // MARK: generation (off the main actor)

    /// Called by the engine when the fitted head settles on a new shape.
    func headChanged(_ head: HeadProxy) {
        lastHead = head
        generate(on: head)
    }

    func generate(on head: HeadProxy) {
        guard case .ok(let spec) = catalog.resolve(look) else { return }
        let key = CacheKey(spec: spec, head: head)
        buildTask?.cancel()  // an older build must not land after this one (cache hit or not)
        buildTask = nil
        if let hit = cache[key] { finish(hit); return }
        isBuilding = true
        status = "Building \(catalog.style(look.style)?.name.lowercased() ?? "style")…"
        buildTask = Task { [weak self] in
            let result = await Task.detached(priority: .userInitiated) {
                try? ProtoStyle.generate(spec, head: head, includeLOD0: false)
            }.value
            guard let self, !Task.isCancelled, let result else { return }
            self.cache[key] = result
            if self.cache.count > 12 { self.cache.removeAll() }
            self.finish(result)
        }
    }

    private func finish(_ result: StyleResult) {
        isBuilding = false
        installedSpec = result.spec
        engine?.install(result, color: catalog.color(look.color) ?? catalog.colors[0])
        let unit = switch result.spec.kind {
        case .cornrows: "rows"
        case .locs: "locs"
        case .twoStrandTwists: "twists"
        default: "braids"
        }
        status = "\(result.stats.roots) \(unit) · \(result.stats.lod1Triangles / 1000)k triangles"
    }

    // MARK: calibration

    func applyCalibration(_ fit: HairlineFit) {
        let saved = SavedCalibration(hairlineFront: fit.hairlineFront, earNotch: fit.earNotch)
        calibration = saved
        CalibrationStore.save(saved)
        engine?.applyCalibration(fit)
        calibrationProgress = nil
    }

    func resetCalibration() {
        calibration = nil
        CalibrationStore.clear()
        engine?.applyCalibration(nil)
    }
}

struct CapturedLook: Identifiable {
    let id = UUID()
    let image: UIImage
    let caption: String
}
