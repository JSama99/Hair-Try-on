// HeadProxy.swift — scalp ellipsoid, face keep-out and hairline (reference/protostyle/scalp.py, v0.2).
//
// Frame = ARKit face-anchor frame: metres, +Y up, +Z out of the face, +X to the
// subject's left. theta: polar angle from the crown; phi: azimuth, 0 = front.

import Foundation

public struct HeadProxy: Hashable, Sendable, Codable {
    public var rx = 0.076, ry = 0.100, rz = 0.097
    public var cx = 0.0, cy = 0.025, cz = -0.030
    public var hairlineFront = 0.98, hairlineBack = 1.95, earNotch = 0.30, earNotchWidth = 0.38
    public var fx = 0.0, fy = -0.030, fz = 0.028
    public var frx = 0.070, fry = 0.100, frz = 0.078

    /// Fraction of the keep-out semi-height above its centre where the face slab starts (brow line).
    public static let faceSlabTop = 0.6

    public init() {}

    enum CodingKeys: String, CodingKey {
        case rx, ry, rz, cx, cy, cz
        case hairlineFront = "hairline_front", hairlineBack = "hairline_back"
        case earNotch = "ear_notch", earNotchWidth = "ear_notch_width"
        case fx, fy, fz, frx, fry, frz
    }

    public var center: V3 { V3(cx, cy, cz) }
    public var faceCenter: V3 { V3(fx, fy, fz) }

    public func point(theta: Double, phi: Double) -> V3 {
        let st = sin(theta)
        return V3(cx + rx * st * sin(phi), cy + ry * cos(theta), cz + rz * st * cos(phi))
    }

    public func normal(at p: V3) -> V3 {
        let d = p - center
        return V3(d.x / (rx * rx), d.y / (ry * ry), d.z / (rz * rz)).normalized
    }

    /// < 1 inside the head, 1 on the surface, > 1 outside.
    public func implicit(_ p: V3) -> Double {
        let d = p - center
        let a = d.x / rx, b = d.y / ry, c = d.z / rz
        return a * a + b * b + c * c
    }

    public func projectOutside(_ p: V3, clearance: Double) -> (V3, Bool) {
        pushOut(p, center: center, r0: rx + clearance, r1: ry + clearance, r2: rz + clearance)
    }

    public func projectOutsideFace(_ p: V3, clearance: Double) -> (V3, Bool) {
        pushOutFace(p, center: faceCenter, r0: frx + clearance, r1: fry + clearance, r2: frz + clearance)
    }

    /// Head first, then face — the order is part of the contract.
    public func collide(_ p: V3, clearance: Double) -> (V3, Bool) {
        let (p1, h) = projectOutside(p, clearance: clearance)
        let (p2, f) = projectOutsideFace(p1, clearance: clearance)
        return (p2, h || f)
    }

    /// < 1 inside the face keep-out (shape: see `pushOutFace`).
    public func faceImplicit(_ p: V3, clearance: Double = 0.0) -> Double {
        let d = p - faceCenter
        let r0 = frx + clearance, r1 = fry + clearance, r2 = frz + clearance
        let top = Self.faceSlabTop * r1
        let ax = d.x / r0, az = d.z / r2
        if d.y > top {
            let ay = d.y / r1
            return ax * ax + ay * ay + az * az
        }
        let dy = d.y > 0.0 ? d.y : 0.0
        let ay = dy / r1
        if d.z > 0.0 { return ax * ax + ay * ay + (dy / top) * (az * az) }
        return ax * ax + ay * ay + az * az
    }

    /// Polar angle of the hairline at azimuth phi (grows front -> back, notched over the ears).
    public func hairlineTheta(phi: Double) -> Double {
        let base = hairlineFront + (hairlineBack - hairlineFront) * (1.0 - cos(phi)) * 0.5
        let q = (abs(phi) - Double.pi * 0.5) / earNotchWidth
        let notch = earNotch * exp(-(q * q))
        return base - notch
    }

    public func insideHairline(theta: Double, phi: Double, margin: Double = 0.0) -> Bool {
        theta <= hairlineTheta(phi: phi) - margin
    }

    /// (normal, tBack, tSide) orthonormal frame at a scalp point.
    public func tangentFrame(theta: Double, phi: Double) -> (normal: V3, tBack: V3, tSide: V3) {
        let p = point(theta: theta, phi: phi)
        let n = normal(at: p)
        let ref = V3(0.0, 0.0, -1.0)
        var tBack = ref - n * ref.dot(n)
        if tBack.length < 1e-9 { tBack = V3(1.0, 0.0, 0.0) - n * n.x }
        tBack = tBack.normalized
        let tSide = n.cross(tBack).normalized
        return (n, tBack, tSide)
    }

    /// Radially re-project a point onto the ellipsoid.
    public func toSurface(_ p: V3) -> V3 {
        let d = p - center
        let a = d.x / rx, b = d.y / ry, c = d.z / rz
        let k = (a * a + b * b + c * c).squareRoot()
        return center + d * (1.0 / k)
    }

    public func thetaPhi(of p: V3) -> (theta: Double, phi: Double) {
        let d = p - center
        let nx = d.x / rx, ny = d.y / ry, nz = d.z / rz
        let theta = acos(max(-1.0, min(1.0, ny / (nx * nx + ny * ny + nz * nz).squareRoot())))
        return (theta, atan2(nx, nz))
    }
}

@inlinable func pushOut(_ p: V3, center: V3, r0: Double, r1: Double, r2: Double) -> (V3, Bool) {
    let d = p - center
    let a = d.x / r0, b = d.y / r1, c = d.z / r2
    let k = a * a + b * b + c * c
    if k >= 1.0 { return (p, false) }
    if k < 1e-18 { return (center + V3(0.0, 0.0, -r2), true) }
    let s = 1.0 / k.squareRoot()
    return (center + d * s, true)
}

/// Face keep-out (oracle v0.2, `scalp._push_out_face`). Above the brow: the face
/// ellipsoid. Below it, behind the face plane: the ellipsoid's horizontal slice.
/// In front: a slab whose depth term blends from none (below the centre) to the
/// full ellipsoid (at the brow), pushed sideways only. Continuous everywhere.
@inlinable func pushOutFace(_ p: V3, center: V3, r0: Double, r1: Double, r2: Double) -> (V3, Bool) {
    let d = p - center
    let top = HeadProxy.faceSlabTop * r1
    if d.y > top { return pushOut(p, center: center, r0: r0, r1: r1, r2: r2) }
    let dy = d.y > 0.0 ? d.y : 0.0
    let b = dy / r1
    let q = 1.0 - b * b
    let ax = d.x / r0, az = d.z / r2
    if d.z > 0.0 {
        let lim = q - (dy / top) * (az * az)
        if ax * ax >= lim { return (p, false) }
        let w = r0 * lim.squareRoot()
        return (V3(center.x + (d.x >= 0.0 ? w : -w), p.y, p.z), true)
    }
    let k = ax * ax + az * az
    if k >= q { return (p, false) }
    if k < 1e-18 { return (V3(center.x + r0 * q.squareRoot(), p.y, p.z), true) }
    let s = (q / k).squareRoot()
    return (V3(center.x + d.x * s, p.y, center.z + d.z * s), true)
}
