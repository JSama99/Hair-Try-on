// Parting.swift — where each braid / twist / loc / cornrow is rooted (reference/protostyle/parting.py).

import Foundation

public struct Root: Hashable, Sendable {
    public var index: Int
    public var theta: Double
    public var phi: Double
    public var point: V3
    public var normal: V3
    public var tBack: V3
    public var tSide: V3
}

public enum ProtoStyleError: Error, Equatable, CustomStringConvertible {
    case invalidParameter(String)
    case invalidSpec([String])

    public var description: String {
        switch self {
        case .invalidParameter(let s): return s
        case .invalidSpec(let p): return p.joined(separator: "; ")
        }
    }
}

func meanRadius(_ h: HeadProxy) -> Double { (h.rx + h.ry + h.rz) / 3.0 }

/// Brick-offset grid of roughly square sections laid out in scalp (theta, phi) space.
public func gridSections(head: HeadProxy, sectionSize: Double, jitter: Double, seed: UInt64,
                         hairlineMargin: Double = 0.0) throws -> [Root] {
    guard sectionSize >= 0.004 && sectionSize <= 0.08 else {
        throw ProtoStyleError.invalidParameter("section_size must be between 4 mm and 8 cm")
    }
    guard jitter >= 0.0 && jitter <= 0.45 else { throw ProtoStyleError.invalidParameter("jitter must be in [0, 0.45]") }
    var rng = SplitMix64(seed: deriveSeed(seed, "grid_sections"))
    let rMean = meanRadius(head)
    let dTheta = sectionSize / rMean
    let thetaMax = head.hairlineBack
    var roots: [Root] = []
    var row = 0
    var theta = dTheta * 0.5
    while theta < thetaMax {
        let circ = 2.0 * Double.pi * rMean * sin(theta)
        let cols = max(1, pyRound(circ / sectionSize))
        let step = 2.0 * Double.pi / Double(cols)
        let offset = row % 2 == 1 ? 0.5 * step : 0.0
        for c in 0..<cols {
            let phi = -Double.pi + (Double(c) + 0.5) * step + offset
            // Jitter is drawn unconditionally so the stream does not depend on the hairline test.
            let jt = rng.nextSigned() * jitter * dTheta
            let jp = rng.nextSigned() * jitter * step
            var th = theta + jt
            var ph = phi + jp
            if ph > Double.pi { ph -= 2.0 * Double.pi }
            if ph <= -Double.pi { ph += 2.0 * Double.pi }
            if th <= 0.0 { th = 1e-4 }
            if !head.insideHairline(theta: th, phi: ph, margin: hairlineMargin) { continue }
            let p = head.point(theta: th, phi: ph)
            let f = head.tangentFrame(theta: th, phi: ph)
            roots.append(Root(index: roots.count, theta: th, phi: ph, point: p, normal: f.normal, tBack: f.tBack, tSide: f.tSide))
        }
        theta += dTheta
        row += 1
    }
    return roots
}

/// Uniform arc-length resampling; always keeps the first and last point.
public func resamplePolyline(_ points: [V3], spacing: Double) -> [V3] {
    if points.count < 2 { return points }
    var seg: [Double] = []
    seg.reserveCapacity(points.count - 1)
    for i in 0..<(points.count - 1) { seg.append((points[i + 1] - points[i]).length) }
    let total = pySum(seg)
    let n = max(1, Int((total / spacing - 1e-9).rounded(.up)))  // oracle v0.2: ignore noise at exact integers
    var out = [points[0]]
    let targetStep = total / Double(n)
    var i = 0
    var acc = 0.0
    if n > 1 {
        for k in 1..<n {
            let target = Double(k) * targetStep
            while acc + seg[i] < target {
                acc += seg[i]
                i += 1
            }
            let t = (target - acc) / seg[i]
            out.append(V3.lerp(points[i], points[i + 1], t))
        }
    }
    out.append(points[points.count - 1])
    return out
}

/// Straight-back cornrow centre paths on the scalp surface.
public func cornrowPaths(head: HeadProxy, rows: Int, widthFraction: Double, spacing: Double,
                         hairlineMargin: Double = 0.02) throws -> [[V3]] {
    guard rows >= 2 && rows <= 24 else { throw ProtoStyleError.invalidParameter("rows must be between 2 and 24") }
    guard widthFraction >= 0.2 && widthFraction <= 0.95 else {
        throw ProtoStyleError.invalidParameter("width_fraction must be in [0.2, 0.95]")
    }
    var paths: [[V3]] = []
    for k in 0..<rows {
        let u = -1.0 + (2.0 * Double(k) + 1.0) / Double(rows)
        let x = u * widthFraction * head.rx
        let q = x / head.rx
        let s = max(0.0, 1.0 - q * q).squareRoot()
        var inside: [V3] = []
        var best: [V3] = []
        let samples = 480
        for i in 0...samples {
            let a = -0.2 + (Double.pi + 0.9) * Double(i) / Double(samples)
            let p = V3(head.cx + x, head.cy + head.ry * s * sin(a), head.cz + head.rz * s * cos(a))
            let tp = head.thetaPhi(of: p)
            if head.insideHairline(theta: tp.theta, phi: tp.phi, margin: hairlineMargin) {
                inside.append(p)
            } else {
                if inside.count > best.count { best = inside }
                inside = []
            }
        }
        if inside.count > best.count { best = inside }
        if best.count < 2 { continue }
        paths.append(resamplePolyline(best, spacing: spacing).map { head.toSurface($0) })
    }
    return paths
}
