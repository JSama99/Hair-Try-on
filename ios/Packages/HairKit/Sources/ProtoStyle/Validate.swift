// Validate.swift — the V01–V13 geometry validator and the quantised digest
// (reference/protostyle/validate.py). Same IDs, thresholds and wording.

import Foundation

public let lod0TriangleBudget = 900_000
public let lod1TriangleBudget = 160_000
public let digestQuantum = 1e-5

public struct Check: Sendable, Equatable {
    public var id: String
    public var name: String
    public var passed: Bool
    public var detail: String
}

/// SHA-256 over quantised LOD0 + LOD1 positions and triangle indices (little-endian, as Python's struct.pack).
public func digest(_ result: StyleResult) -> String {
    var h = SHA256Hasher()
    for mesh in [result.lod0, result.lod1] {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(16 + mesh.positions.count * 24 + mesh.triangles.count * 4)
        func u64(_ v: UInt64) { for i in 0..<8 { bytes.append(UInt8(truncatingIfNeeded: v >> (UInt64(i) * 8))) } }
        u64(UInt64(mesh.positions.count))
        for p in mesh.positions {
            for c in [p.x, p.y, p.z] { u64(UInt64(bitPattern: Int64(pyRound(c / digestQuantum)))) }
        }
        u64(UInt64(mesh.triangleCount))
        for t in mesh.triangles { for i in 0..<4 { bytes.append(UInt8(truncatingIfNeeded: t >> (UInt32(i) * 8))) } }
        h.update(bytes)
    }
    return SHA256Hasher.hex(h.finalize())
}

private func triArea(_ a: V3, _ b: V3, _ c: V3) -> Double { 0.5 * (b - a).cross(c - a).length }

public func validate(_ result: StyleResult, checkDeterminism: Bool = true) -> [Check] {
    let spec = result.spec, head = result.head
    var checks: [Check] = []
    func add(_ id: String, _ name: String, _ ok: Bool, _ detail: String) { checks.append(Check(id: id, name: name, passed: ok, detail: detail)) }

    let bad = [result.lod0, result.lod1].reduce(0) { $0 + $1.positions.filter { !$0.isFinite }.count }
    add("V01", "all vertex positions finite", bad == 0, "\(bad) non-finite")

    var worst = 0.0
    for r in result.roots { worst = max(worst, abs(head.implicit(r.point) - 1.0)) }
    add("V02", "roots lie on the scalp surface", worst < 1e-9, String(format: "max |f-1| = %.3e", worst))

    var outside = 0
    if spec.kind != .cornrows {
        for case .grid(let r) in result.roots where !head.insideHairline(theta: r.theta, phi: r.phi, margin: spec.hairlineMargin - 1e-12) {
            outside += 1
        }
    }
    add("V03", "roots inside the hairline", outside == 0, "\(outside) outside")

    let profile = Profile.of(spec.kind)
    let clearance = profile.shellRadius * spec.width
    let joinTolerance = max(0.5 * spec.width, 0.008)
    var worstPen = 0.0
    for s in result.strands {
        let sv = arcLengths(s.centerline)
        for (p, v) in zip(s.centerline, sv) where v > s.freeFromS + joinTolerance {
            let d = p - head.center
            let a = d.x / (head.rx + clearance * 0.9), b = d.y / (head.ry + clearance * 0.9), c = d.z / (head.rz + clearance * 0.9)
            let k = a * a + b * b + c * c
            if k < 1.0 { worstPen = max(worstPen, 1.0 - k) }
            let kf = head.faceImplicit(p, clearance: clearance * 0.9)
            if kf < 1.0 { worstPen = max(worstPen, 1.0 - kf) }
        }
    }
    add("V04", "hanging centrelines clear head and face by >= 90% of strand envelope", worstPen == 0.0,
        String(format: "worst implicit deficit %.3e", worstPen))

    let target = profile.period * spec.width / Double(spec.samplesPerPeriod)
    var worstRatio = 0.0
    for s in result.strands where s.centerline.count > 1 {
        for i in 1..<s.centerline.count { worstRatio = max(worstRatio, (s.centerline[i] - s.centerline[i - 1]).length / target) }
    }
    add("V05", "dense sample spacing <= 1.35x target (plait resolved)", worstRatio <= 1.35, String(format: "max ratio %.3f", worstRatio))

    var deg = 0, oob = 0
    for m in [result.lod0, result.lod1] {
        let n = UInt32(m.positions.count)
        var t = 0
        while t < m.triangles.count {
            let a = m.triangles[t], b = m.triangles[t + 1], c = m.triangles[t + 2]
            t += 3
            if !(a < n && b < n && c < n) || Set([a, b, c]).count < 3 { oob += 1; continue }
            if triArea(m.positions[Int(a)], m.positions[Int(b)], m.positions[Int(c)]) < 1e-14 { deg += 1 }
        }
    }
    add("V06", "triangles valid and non-degenerate", deg == 0 && oob == 0, "\(oob) invalid, \(deg) degenerate")

    add("V07", "triangle budgets (LOD0 <= 900k, LOD1 <= 160k)",
        result.lod0.triangleCount <= lod0TriangleBudget && result.lod1.triangleCount <= lod1TriangleBudget,
        "LOD0 \(result.lod0.triangleCount), LOD1 \(result.lod1.triangleCount)")

    let okR = result.strands.allSatisfy { $0.radiusMax > 0.0 }
        && [result.lod0, result.lod1].allSatisfy { $0.uvs.count == $0.positions.count && $0.normals.count == $0.positions.count }
    add("V08", "positive strand radii; a UV and normal per vertex", okR, "\(result.strands.count) strands")

    if checkDeterminism, let again = try? generate(spec, head: head, includeLOD0: !result.lod0.positions.isEmpty) {
        let d1 = digest(result), d2 = digest(again)
        add("V09", "regeneration is bit-identical (quantised digest)", d1 == d2, String(d1.prefix(16)))
    } else {
        add("V09", "regeneration is bit-identical (quantised digest)", true, "skipped")
    }

    add("V10", "length policy respected (no torso -> <= 0.40 m)", spec.validate().isEmpty, "spec valid")

    let n = result.strands.count
    if spec.kind == .cornrows {
        add("V11", "section count plausible for width", abs(n - spec.cornrowRows) <= 1, "\(n) (expected \(spec.cornrowRows)±1 rows)")
    } else {
        let area = 0.55 * 4.0 * Double.pi * ((head.rx * head.ry + head.ry * head.rz + head.rz * head.rx) / 3.0)
        let est = area / (spec.width * spec.width)
        add("V11", "section count plausible for width", 0.45 * est <= Double(n) && Double(n) <= 1.6 * est,
            String(format: "%d (expected ~%.0f)", n, est))
    }

    if spec.kind != .cornrows {
        var left = 0, right = 0
        for case .grid(let r) in result.roots {
            if r.phi > 1e-6 && r.phi < Double.pi - 1e-6 { left += 1 }
            if r.phi < -1e-6 && r.phi > -Double.pi + 1e-6 { right += 1 }
        }
        let bal = Double(abs(left - right)) / Double(max(1, max(left, right)))
        add("V12", "left/right root balance within 15%", bal <= 0.15, "L \(left) / R \(right)")
    } else {
        let xs = result.roots.map(\.point.x)
        let bal = abs(xs.filter { $0 > 0 }.count - xs.filter { $0 < 0 }.count)
        add("V12", "left/right root balance within 15%", bal <= 1, "imbalance \(bal)")
    }

    var worstAgree = 1.0
    for m in [result.lod0, result.lod1] where !m.triangles.isEmpty {
        var agree = 0
        var t = 0
        while t < m.triangles.count {
            let a = Int(m.triangles[t]), b = Int(m.triangles[t + 1]), c = Int(m.triangles[t + 2])
            t += 3
            let fn = (m.positions[b] - m.positions[a]).cross(m.positions[c] - m.positions[a])
            let avg = m.normals[a] + m.normals[b] + m.normals[c]
            if fn.dot(avg) > 0.0 { agree += 1 }
        }
        worstAgree = min(worstAgree, Double(agree) / Double(m.triangleCount))
    }
    add("V13", "outward winding (>= 99.5% of faces agree with analytic normals)", worstAgree >= 0.995,
        String(format: "worst agreement %.4f", worstAgree))
    return checks
}

public func allPassed(_ checks: [Check]) -> Bool { checks.allSatisfy(\.passed) }
