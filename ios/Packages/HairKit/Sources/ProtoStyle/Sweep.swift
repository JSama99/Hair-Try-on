// Sweep.swift — rotation-minimising frames and swept tubes (reference/protostyle/sweep.py).

import Foundation

/// Triangle mesh. Positions and normals in metres (face frame); `uv.y` is in
/// plait periods; `fracs` (root -> tip, 0...1) and `strandIDs` are render
/// attributes outside the determinism contract (not part of the digest).
public struct Mesh: Sendable, Equatable {
    public var positions: [V3] = []
    public var normals: [V3] = []
    public var uvs: [SIMD2<Double>] = []
    public var triangles: [UInt32] = []
    public var fracs: [Float] = []
    public var strandIDs: [UInt32] = []

    public init() {}

    public var vertexCount: Int { positions.count }
    public var triangleCount: Int { triangles.count / 3 }

    public mutating func extend(_ other: Mesh) {
        let base = UInt32(positions.count)
        positions.append(contentsOf: other.positions)
        normals.append(contentsOf: other.normals)
        uvs.append(contentsOf: other.uvs)
        fracs.append(contentsOf: other.fracs)
        strandIDs.append(contentsOf: other.strandIDs)
        triangles.append(contentsOf: other.triangles.map { $0 + base })
    }
}

public func tangents(_ points: [V3]) -> [V3] {
    let n = points.count
    precondition(n >= 2, "need at least two points")
    var out: [V3] = []
    out.reserveCapacity(n)
    for i in 0..<n {
        let a: V3 = points[max(0, i - 1)]
        let b: V3 = points[min(n - 1, i + 1)]
        out.append((b - a).normalized)
    }
    return out
}

/// (T, N, B) with N seeded from `lateral0`, flipped so B faces `outward` at the root.
public func rotationMinimizingFrames(_ points: [V3], lateral0: V3, outward: V3) -> (t: [V3], n: [V3], b: [V3]) {
    let T = tangents(points)
    var n0 = lateral0 - T[0] * lateral0.dot(T[0])
    if n0.length < 1e-9 {
        let alt = abs(T[0].x) < 0.9 ? V3(1.0, 0.0, 0.0) : V3(0.0, 1.0, 0.0)
        n0 = alt - T[0] * alt.dot(T[0])
    }
    n0 = n0.normalized
    if T[0].cross(n0).dot(outward) < 0.0 { n0 = n0 * -1.0 }
    var N = [n0]
    N.reserveCapacity(points.count)
    for i in 0..<(points.count - 1) {
        let v1 = points[i + 1] - points[i]
        let c1 = v1.dot(v1)
        if c1 < 1e-24 { N.append(N[N.count - 1]); continue }
        let rL = N[i] - v1 * (2.0 / c1 * v1.dot(N[i]))
        let tL = T[i] - v1 * (2.0 / c1 * v1.dot(T[i]))
        let v2 = T[i + 1] - tL
        let c2 = v2.dot(v2)
        var r = c2 < 1e-24 ? rL : rL - v2 * (2.0 / c2 * v2.dot(rL))
        r = (r - T[i + 1] * r.dot(T[i + 1])).normalized
        N.append(r)
    }
    let B = (0..<points.count).map { T[$0].cross(N[$0]) }
    return (T, N, B)
}

public func arcLengths(_ points: [V3]) -> [Double] {
    var s = [0.0]
    s.reserveCapacity(points.count)
    if points.count > 1 { for i in 1..<points.count { s.append(s[i - 1] + (points[i] - points[i - 1]).length) } }
    return s
}

/// Limit each ring radius to `factor` × the local centreline curvature radius.
public func clampToCurvature(_ centers: [V3], _ radii: [Double], factor: Double = 0.9) -> [Double] {
    var out = radii
    if centers.count < 3 { return out }
    for k in 1..<(centers.count - 1) {
        let u = centers[k] - centers[k - 1]
        let v = centers[k + 1] - centers[k]
        let lu = u.length, lv = v.length
        if lu < 1e-12 || lv < 1e-12 { continue }
        let ang = acos(max(-1.0, min(1.0, u.dot(v) / (lu * lv))))
        if ang < 1e-9 { continue }
        let rCurv = 0.5 * (lu + lv) / ang
        if out[k] > factor * rCurv { out[k] = factor * rCurv }
    }
    return out
}

/// Tube around per-sample centres using the frame (N, B). Counter-clockwise winding seen from outside (V13).
public func tube(centers: [V3], n N: [V3], b B: [V3], radii radiiIn: [Double], sides: Int, capTip: Bool,
                 vScale: Double = 1.0, sValues: [Double]? = nil, fracs: [Float]? = nil, strandID: UInt32 = 0) -> Mesh {
    precondition(sides >= 3, "sides must be >= 3")
    var m = Mesh()
    let rings = centers.count
    let radii = clampToCurvature(centers, radiiIn)
    m.positions.reserveCapacity(rings * sides + 1)
    for k in 0..<rings {
        let c = centers[k], n = N[k], b = B[k], r = radii[k]
        let v = (sValues?[k] ?? Double(k)) * vScale
        let fr = fracs?[k] ?? 0
        for j in 0..<sides {
            let a = 2.0 * Double.pi * Double(j) / Double(sides)
            let ca = cos(a), sa = sin(a)
            let radial = n * ca + b * sa
            m.positions.append(c + radial * r)
            m.normals.append(radial)
            m.uvs.append(SIMD2(Double(j) / Double(sides), v))
            m.fracs.append(fr)
            m.strandIDs.append(strandID)
        }
    }
    let s = UInt32(sides)
    if rings > 1 {
        for k in 0..<UInt32(rings - 1) {
            let r0 = k * s, r1 = (k + 1) * s
            for j in 0..<s {
                let j1 = (j + 1) % s
                m.triangles.append(contentsOf: [r0 + j, r1 + j1, r1 + j])
                m.triangles.append(contentsOf: [r0 + j, r0 + j1, r1 + j1])
            }
        }
    }
    if capTip {
        let tipIndex = UInt32(m.positions.count)
        let t = (centers[rings - 1] - centers[rings - 2]).normalized
        m.positions.append(centers[rings - 1] + t * (radii[rings - 1] * 0.6))
        m.normals.append(t)
        m.uvs.append(SIMD2(0.5, (sValues?[rings - 1] ?? Double(rings - 1)) * vScale))
        m.fracs.append(fracs?[rings - 1] ?? 1)
        m.strandIDs.append(strandID)
        let base = UInt32(rings - 1) * s
        for j in 0..<s { m.triangles.append(contentsOf: [base + j, base + (j + 1) % s, tipIndex]) }
    }
    return m
}
