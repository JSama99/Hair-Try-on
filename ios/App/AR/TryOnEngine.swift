// TryOnEngine.swift — owns the ARView and runs the per-frame loop.
//
//   face anchor update  -> LiveSession.observeFace (fit + filter) -> store.headChanged when it settles
//                       -> face occluder mesh follows her expression
//   scene update        -> LiveSession.advance (hair physics) -> skin LOD1 -> GPU buffer 0
//   ~10 Hz              -> display-oriented frame -> segmenter
//   segmentation result -> calibration (if running) or the honesty check, using the
//                          camera/pose snapshot of the frame it came from
//
// NOT COMPILED IN THIS REPOSITORY'S CI (needs the iOS SDK). docs/BUILD.md lists what to verify on device.

import ARKit
import RealityKit
import Combine
import UIKit
import ProtoStyle
import HeadFit
import HairDynamics
import TryOnCore

@MainActor
final class TryOnEngine: NSObject, ARSessionDelegate {
    let arView: ARView
    let overlay = DimOverlayView()
    private weak var store: TryOnStore?

    private let live: LiveSession
    private let faceAnchor = AnchorEntity(.face)
    private let hairEntity = ModelEntity()
    private let faceOccluder = ModelEntity()
    private let skullOccluder = ModelEntity()
    private var hairMesh: HairMesh?
    private var faceMesh: FaceOccluderMesh?
    private var installed: StyleResult?
    private var attributes: RenderAttributes?
    private var skinP: [Float] = [], skinN: [Float] = []

    private var pose: HeadPose = .identity
    private var faceTransform = matrix_identity_float4x4
    private var faceVerticesHead: [V3] = []
    private var faceTriangles: [UInt32] = []
    private var faceVisible = false
    private var updates: Cancellable?

    private var segmenter: HairSegmenting
    private var renderer: DisplayFrameRenderer?
    private var lastSegmentTime: TimeInterval = 0
    private struct FrameSnapshot { var camera: ARCamera; var faceTransform: simd_float4x4; var head: HeadProxy; var face: [V3] }
    private var snapshots: [Int: FrameSnapshot] = [:]
    private var calibration: CalibrationSession?

    init(store: TryOnStore) {
        self.store = store
        arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        live = LiveSession(preset: .arkit, calibration: store.calibration.map { HairlineFit(hairlineFront: $0.hairlineFront, earNotch: $0.earNotch) })
        segmenter = SegmenterFactory.make()
        super.init()
        arView.session.delegate = self
        arView.renderOptions.insert(.disableMotionBlur)
        faceOccluder.model = nil
        faceAnchor.addChild(skullOccluder)
        faceAnchor.addChild(faceOccluder)
        faceAnchor.addChild(hairEntity)
        arView.scene.addAnchor(faceAnchor)
        updates = arView.scene.subscribe(to: SceneEvents.Update.self) { [weak self] e in
            MainActor.assumeIsolated { self?.tick(time: CACurrentMediaTime(), dt: e.deltaTime) }
        }
        segmenter.onResult = { [weak self] r in Task { @MainActor in self?.handleSegmentation(r) } }
        store.engine = self
    }

    // MARK: session

    func start() {
        let config = ARFaceTrackingConfiguration()
        config.maximumNumberOfTrackedFaces = 1
        config.isLightEstimationEnabled = true
        live.restart()
        arView.session.run(config, options: [.resetTracking])
    }

    func pause() { arView.session.pause() }

    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard let face = anchors.compactMap({ $0 as? ARFaceAnchor }).first else { return }
        let transform = face.transform
        let tracked = face.isTracked
        let verts = face.geometry.vertices
        let indices = face.geometry.triangleIndices
        MainActor.assumeIsolated { self.faceUpdated(transform: transform, tracked: tracked, vertices: verts, indices: indices) }
    }

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // ARKit delivers on the main queue (delegateQueue is nil), so the frame never crosses actors.
        nonisolated(unsafe) let frame = frame
        MainActor.assumeIsolated { self.maybeSegment(frame) }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let message = (error as NSError).localizedDescription
        MainActor.assumeIsolated { self.store?.status = "Camera stopped: \(message)" }
    }

    private func faceUpdated(transform: simd_float4x4, tracked: Bool, vertices: [SIMD3<Float>], indices: [Int16]) {
        if !tracked {
            if faceVisible { live.trackingLost(); store?.status = "Looking for your face…" }
            faceVisible = false
            return
        }
        faceVisible = true
        faceTransform = transform
        pose = HeadPose(transform)
        faceVerticesHead = vertices.map(V3.init)
        if faceTriangles.isEmpty { faceTriangles = indices.map { UInt32(UInt16(bitPattern: $0)) } }
        if let faceMesh { faceMesh.update(vertices: vertices) }
        else if let m = try? FaceOccluderMesh(vertices: vertices, indices: indices) {
            faceMesh = m
            faceOccluder.model = ModelComponent(mesh: m.resource, materials: [OcclusionMaterial()])
        }
        if let head = live.observeFace(vertices: faceVerticesHead, time: CACurrentMediaTime()) {
            placeSkull(head)
            store?.headChanged(head)
        }
    }

    private func placeSkull(_ head: HeadProxy) {
        if skullOccluder.model == nil {
            skullOccluder.model = ModelComponent(mesh: .generateSphere(radius: 1), materials: [OcclusionMaterial()])
        }
        // Slightly inside the proxy so hair roots on the scalp are not hidden.
        skullOccluder.scale = SIMD3(Float(head.rx), Float(head.ry), Float(head.rz)) * 0.985
        skullOccluder.position = SIMD3(Float(head.cx), Float(head.cy), Float(head.cz))
    }

    // MARK: style

    func install(_ result: StyleResult, color: CatalogColor) {
        installed = result
        live.install(result, pose: pose)
        let attrs = RenderAttributes(result: result)
        attributes = attrs
        live.skin(positions: &skinP, normals: &skinN)
        guard let mesh = try? HairMesh(attributes: attrs, positions: skinP, normals: skinN) else {
            store?.status = "Could not create the hair mesh on this device."
            return
        }
        hairMesh = mesh
        hairEntity.model = ModelComponent(mesh: mesh.resource, materials: [HairMaterialFactory.placeholder(color: color)])
        updateColor(color)
    }

    private var colorTask: Task<Void, Never>?

    func updateColor(_ color: CatalogColor) {
        guard let attributes else { return }
        colorTask?.cancel()  // a slower, older material must never land after a newer one
        colorTask = Task {
            let m = try? await HairMaterialFactory.material(color: color, params: attributes.params)
            guard !Task.isCancelled, let m else { return }
            hairEntity.model?.materials = [m]
        }
    }

    private func tick(time: TimeInterval, dt: TimeInterval) {
        guard faceVisible, hairMesh != nil else { return }
        live.advance(pose: pose, time: time)
        live.skin(positions: &skinP, normals: &skinN)
        hairMesh?.update(positions: skinP, normals: skinN)
    }

    // MARK: segmentation, honesty, calibration

    private func maybeSegment(_ frame: ARFrame) {
        guard faceVisible, let head = live.lastBuiltHead, frame.timestamp - lastSegmentTime >= 0.1, !segmenter.isBusy else { return }
        let viewSize = arView.bounds.size
        guard viewSize.width > 0 else { return }
        let ms = ScreenMapping.maskSize(imageWidth: Int(viewSize.width), imageHeight: Int(viewSize.height))
        if renderer?.size != CGSize(width: ms.width, height: ms.height) { renderer = DisplayFrameRenderer(size: CGSize(width: ms.width, height: ms.height)) }
        guard let buffer = renderer?.render(frame) else { return }
        let ts = Int(frame.timestamp * 1000)
        guard segmenter.submit(buffer, timestampMs: ts) else { return }
        lastSegmentTime = frame.timestamp
        snapshots[ts] = FrameSnapshot(camera: frame.camera, faceTransform: faceTransform, head: head, face: faceVerticesHead)
        if snapshots.count > 8 { snapshots = snapshots.filter { $0.key >= ts - 2000 } }
    }

    private func handleSegmentation(_ r: SegmentationResult) {
        guard let snap = snapshots.removeValue(forKey: r.timestampMs) else { return }
        let size = CGSize(width: r.hair.width, height: r.hair.height)
        let projector = MaskProjector(camera: snap.camera, faceTransform: snap.faceTransform, size: size)
        if let cal = calibration {
            cal.add(head: snap.head, project: projector.normalized, hair: r.hair, skin: r.skin)
            store?.calibrationProgress = cal.progress
            if cal.isComplete {
                calibration = nil
                if let fit = cal.fit(head: snap.head) { store?.applyCalibration(fit) }
                else { store?.calibrationProgress = nil; store?.status = "Couldn't see your hairline clearly. Try again with your hair pulled back." }
            }
            return
        }
        let (headV, headT) = Self.headSilhouetteMesh(head: snap.head, face: snap.face, faceTriangles: faceTriangles)
        guard let m = live.measureConflict(hair: r.hair, project: projector.pixel, headVertices: headV, headTriangles: headT) else { return }
        store?.conflictTip = live.conflictActive ? Honesty.tip(m, source: .camera) : nil
        overlay.show(hair: r.hair, style: live.lastStyleMask, active: live.conflictActive, mirrored: DisplayFrameRenderer.screenIsMirrored)
    }

    /// Head silhouette = scalp ellipsoid + tracked face (for the "is she wearing a wrap" share).
    static func headSilhouetteMesh(head: HeadProxy, face: [V3], faceTriangles: [UInt32]) -> ([V3], [UInt32]) {
        var v: [V3] = [], t: [UInt32] = []
        let rings = 16, segs = 24
        for i in 0...rings {
            let th = Double.pi * Double(i) / Double(rings)
            for j in 0..<segs { v.append(head.point(theta: th, phi: 2 * Double.pi * Double(j) / Double(segs) - Double.pi)) }
        }
        for i in 0..<rings { for j in 0..<segs {
            let a = UInt32(i * segs + j), b = UInt32(i * segs + (j + 1) % segs), c = a + UInt32(segs), d = b + UInt32(segs)
            t += [a, c, b, b, c, d]
        } }
        let base = UInt32(v.count)
        v += face
        t += faceTriangles.map { $0 + base }
        return (v, t)
    }

    func beginCalibration() {
        calibration = CalibrationSession(targetFrames: 30)
        store?.calibrationProgress = 0
    }

    func cancelCalibration() {
        calibration = nil
        store?.calibrationProgress = nil
    }

    func applyCalibration(_ fit: HairlineFit?) { live.applyCalibration(fit) }

    var segmentationAvailable: Bool { !(segmenter is UnavailableSegmenter) }
    var segmentationProvidesSkin: Bool { segmenter.providesSkin }

    // MARK: capture

    func capture(caption: String) async -> UIImage? {
        let shot: UIImage? = await withCheckedContinuation { cont in arView.snapshot(saveToHDR: false) { cont.resume(returning: $0) } }
        guard let shot else { return nil }
        let w = shot.size.width
        let band = max(96, w * 0.16)
        let format = UIGraphicsImageRendererFormat()
        format.scale = shot.scale
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: shot.size.height + band), format: format).image { ctx in
            shot.draw(at: .zero)
            UIColor(white: 0.08, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: shot.size.height, width: w, height: band))
            let para = NSMutableParagraphStyle(); para.lineBreakMode = .byWordWrapping
            (caption as NSString).draw(in: CGRect(x: 20, y: shot.size.height + 16, width: w - 40, height: band - 40), withAttributes: [
                .font: UIFont.systemFont(ofSize: max(15, w * 0.036), weight: .medium), .foregroundColor: UIColor.white, .paragraphStyle: para])
            ("Preview from Hair Try-On" as NSString).draw(at: CGPoint(x: 20, y: shot.size.height + band - 26), withAttributes: [
                .font: UIFont.monospacedSystemFont(ofSize: 11, weight: .regular), .foregroundColor: UIColor(white: 0.7, alpha: 1)])
        }
    }
}

/// Amber wash over the hair the style leaves uncovered (mask resolution, stretched to the view).
final class DimOverlayView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.contentsGravity = .resize
        layer.magnificationFilter = .linear
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    func show(hair: ProbabilityMap, style: [Bool], active: Bool, mirrored: Bool) {
        guard active, style.count == hair.values.count else { layer.contents = nil; return }
        let w = hair.width, h = hair.height
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let t = Float(Catalog.shared.honesty.maskThreshold)
        for i in 0..<(w * h) where hair.values[i] >= t && !style[i] {
            let a: Float = 0.55   // premultiplied RGBA
            px[4 * i] = UInt8(245 * a); px[4 * i + 1] = UInt8(158 * a); px[4 * i + 2] = UInt8(11 * a); px[4 * i + 3] = UInt8(255 * a)
        }
        guard let provider = CGDataProvider(data: Data(px) as CFData),
              let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return }
        layer.contents = image
        layer.setAffineTransform(mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity)
    }
}
