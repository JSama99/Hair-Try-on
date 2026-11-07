// ARConversions.swift — between ARKit's Float SIMD types and HairKit's Double V3.

import ARKit
import simd
import ProtoStyle
import HairDynamics

extension V3 {
    init(_ v: SIMD3<Float>) { self.init(Double(v.x), Double(v.y), Double(v.z)) }
}

extension SIMD3 where Scalar == Float {
    init(_ v: V3) { self.init(Float(v.x), Float(v.y), Float(v.z)) }
}

extension HeadPose {
    /// Face-anchor transform (head frame -> world).
    init(_ m: simd_float4x4) {
        let c0 = SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z)
        let c1 = SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z)
        let c2 = SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        let t = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        self.init(c0: V3(simd_normalize(c0)), c1: V3(simd_normalize(c1)), c2: V3(simd_normalize(c2)), t: V3(t))
    }
}

/// Projects head-frame points into a display-oriented image of `size` (the mask grid).
struct MaskProjector {
    let camera: ARCamera
    let faceTransform: simd_float4x4
    let size: CGSize
    private let view: simd_float4x4

    init(camera: ARCamera, faceTransform: simd_float4x4, size: CGSize) {
        self.camera = camera
        self.faceTransform = faceTransform
        self.size = size
        view = camera.viewMatrix(for: .portrait)
    }

    /// Pixel position (x right, y down) or nil when the point is behind the camera.
    func pixel(_ p: V3) -> SIMD2<Double>? {
        let world = faceTransform * SIMD4<Float>(Float(p.x), Float(p.y), Float(p.z), 1)
        let eye = view * world
        guard eye.z < 0 else { return nil }  // camera looks down -Z
        let pt = camera.projectPoint(SIMD3(world.x, world.y, world.z), orientation: .portrait, viewportSize: size)
        return SIMD2(Double(pt.x), Double(pt.y))
    }

    /// Normalised image coordinates (0...1).
    func normalized(_ p: V3) -> SIMD2<Double>? {
        pixel(p).map { SIMD2($0.x / Double(size.width), $0.y / Double(size.height)) }
    }
}
