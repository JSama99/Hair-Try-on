// Drape.swift — deterministic rest-pose drape (reference/protostyle/drape.py).
//
// Verlet chain with exact follow-the-leader inextensibility (Müller et al. 2012),
// DFTL velocity correction, a minimum-bend-radius constraint and head/face
// collision. Fixed step, fixed order. The same three constraint functions are
// reused by HairDynamics for live motion.

import Foundation

public let maxUnsupportedLength = 0.40

public struct DrapeParams: Hashable, Sendable {
    public var steps = 220
    public var passes = 10
    public var gravity = 9.81
    public var dt = 1.0 / 90.0
    public var damping = 0.985
    public var bendStiffness = 0.35
    public var ftlDamping = 0.9
    public init() {}
}

/// Minimum-bend-radius constraint across each joint (i-2, i-1, i). Pinned nodes never move.
public func applyBend(_ pos: inout [V3], fixedCount nFixed: Int, ds: Double, stiffness: Double, minRadius: Double) {
    var i = max(nFixed, 2)
    while i < pos.count {
        let a = pos[i - 2], m = pos[i - 1], b = pos[i]
        let l1 = (m - a).length
        let l2 = ds
        var phi = minRadius > 0.0 ? (l1 + l2) / (2.0 * minRadius) : 0.35
        phi = min(phi, 2.6)
        let rest = max(0.0, l1 * l1 + l2 * l2 + 2.0 * l1 * l2 * cos(phi)).squareRoot()
        let d = b - a
        let dist = d.length
        if dist >= rest || dist < 1e-12 { i += 1; continue }
        let corr = (dist - rest) / dist * stiffness
        if i - 2 < nFixed {
            pos[i] = b - d * corr
        } else {
            let half = d * (0.5 * corr)
            pos[i - 2] = a + half
            pos[i] = b - half
        }
        i += 1
    }
}

/// Exact inextensibility: walk root -> tip placing each node `ds` from its predecessor.
/// Writes per-node correction vectors into `corr` when given (zero for pinned nodes).
public func applyFollowTheLeader(_ pos: inout [V3], fixedCount nFixed: Int, ds: Double, corrections corr: UnsafeMutablePointer<V3>? = nil) {
    var i = nFixed
    while i < pos.count {
        var d = pos[i] - pos[i - 1]
        var dist = d.length
        if dist < 1e-12 { d = V3(0.0, -1.0, 0.0); dist = 1.0 }
        let target = pos[i - 1] + d * (ds / dist)
        if let corr { corr[i] = target - pos[i] }
        pos[i] = target
        i += 1
    }
}

public func applyCollision(_ pos: inout [V3], fixedCount nFixed: Int, head: HeadProxy, clearance: Double) {
    var i = nFixed
    while i < pos.count {
        pos[i] = head.collide(pos[i], clearance: clearance).0
        i += 1
    }
}

/// Settled polyline: the fixed prefix followed by the free nodes.
public func drape(head: HeadProxy, fixed: [V3], freeLength: Double, segment: Double, clearance: Double,
                  params: DrapeParams = DrapeParams(), minBendRadius: Double = 0.0) throws -> [V3] {
    guard fixed.count >= 2 else { throw ProtoStyleError.invalidParameter("drape needs at least two fixed points") }
    guard segment > 0.0 else { throw ProtoStyleError.invalidParameter("segment must be positive") }
    guard freeLength >= 0.0 else { throw ProtoStyleError.invalidParameter("free_length must be >= 0") }
    let nFree = pyRound(freeLength / segment)
    if nFree == 0 { return fixed }
    let ds = freeLength / Double(nFree)
    let nFixed = fixed.count
    let last = fixed[nFixed - 1]
    let direction = (last - fixed[nFixed - 2]).normalized
    var pos = fixed
    pos.reserveCapacity(nFixed + nFree)
    for i in 1...nFree { pos.append(last + direction * (ds * Double(i))) }
    var prev = pos
    let g = V3(0.0, -params.gravity * params.dt * params.dt, 0.0)
    let count = pos.count
    var acc = [V3](repeating: .zero, count: count)
    var corr = [V3](repeating: .zero, count: count)

    for _ in 0..<params.steps {
        for i in nFixed..<count {
            let p = pos[i]
            let v = (p - prev[i]) * params.damping
            prev[i] = p
            pos[i] = (p + v) + g
        }
        for i in 0..<count { acc[i] = .zero }
        for _ in 0..<params.passes {
            corr.withUnsafeMutableBufferPointer { buf in
                applyFollowTheLeader(&pos, fixedCount: nFixed, ds: ds, corrections: buf.baseAddress)
            }
            for i in 0..<count { acc[i] = acc[i] + corr[i] }
            applyBend(&pos, fixedCount: nFixed, ds: ds, stiffness: params.bendStiffness, minRadius: minBendRadius)
            applyCollision(&pos, fixedCount: nFixed, head: head, clearance: clearance)
        }
        if nFixed < count - 1 {
            for i in nFixed..<(count - 1) { prev[i] = prev[i] + acc[i + 1] * params.ftlDamping }
        }
    }
    for _ in 0..<6 {
        applyBend(&pos, fixedCount: nFixed, ds: ds, stiffness: 1.0, minRadius: minBendRadius)
        applyCollision(&pos, fixedCount: nFixed, head: head, clearance: clearance)
        applyFollowTheLeader(&pos, fixedCount: nFixed, ds: ds)
    }
    return pos
}
