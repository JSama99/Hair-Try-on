// HairSimulation.swift — live motion for a generated style (docs/ARCHITECTURE.md §4.6).
//
// Continues the reference solver at runtime: Verlet + follow-the-leader with
// DFTL velocity correction + minimum bend radius + head/face collision, on a
// coarse chain per strand (one node per drape segment, ~1 cm). It simulates in
// world space (gravity is world -Y, as ARKit's gravity-aligned world frame) and
// resolves collisions in the head frame through the current pose. Fixed step
// 1/90 s, fixed order: deterministic for the same pose sequence.
//
// LOD1 shells are skinned to the chains: each shell vertex is bound at rest to
// a point on a coarse segment plus an offset in that segment's frame, and is
// carried by the minimal rotation from the segment's rest direction to its
// current direction.

import Foundation
import ProtoStyle

/// Rigid head pose: head (face-anchor) frame -> world. Columns of `r` are the head axes in world.
public struct HeadPose: Sendable, Equatable {
    public var c0: V3, c1: V3, c2: V3
    public var t: V3

    public init(c0: V3, c1: V3, c2: V3, t: V3) { self.c0 = c0; self.c1 = c1; self.c2 = c2; self.t = t }
    public static let identity = HeadPose(c0: V3(1, 0, 0), c1: V3(0, 1, 0), c2: V3(0, 0, 1), t: .zero)

    /// Rotation about +Y (yaw), +X (pitch), +Z (roll), radians, applied yaw * pitch * roll; then translation.
    public static func euler(yaw: Double = 0, pitch: Double = 0, roll: Double = 0, t: V3 = .zero) -> HeadPose {
        let cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp = sin(pitch), cr = cos(roll), sr = sin(roll)
        // R = Ry * Rx * Rz
        let r00 = cy * cr + sy * sp * sr, r01 = -cy * sr + sy * sp * cr, r02 = sy * cp
        let r10 = cp * sr, r11 = cp * cr, r12 = -sp
        let r20 = -sy * cr + cy * sp * sr, r21 = sy * sr + cy * sp * cr, r22 = cy * cp
        return HeadPose(c0: V3(r00, r10, r20), c1: V3(r01, r11, r21), c2: V3(r02, r12, r22), t: t)
    }

    @inlinable public func rotate(_ v: V3) -> V3 { c0 * v.x + c1 * v.y + c2 * v.z }
    @inlinable public func apply(_ p: V3) -> V3 { rotate(p) + t }
    @inlinable public func inverseRotate(_ v: V3) -> V3 { V3(c0.dot(v), c1.dot(v), c2.dot(v)) }
    @inlinable public func inverseApply(_ p: V3) -> V3 { inverseRotate(p - t) }
}

public struct SimulationParams: Sendable, Equatable {
    public var dt = 1.0 / 90.0
    public var gravity = 9.81
    public var damping = 0.97
    public var passes = 4
    public var bendStiffness = 0.35
    public var ftlDamping = 0.9
    public var maxStepsPerAdvance = 6
    public init() {}
}

/// Minimal rotation taking unit `a` to unit `b`, applied to `v` (Rodrigues).
@inlinable func rotateMinimal(_ v: V3, from a: V3, to b: V3) -> V3 {
    let axis = a.cross(b)
    let s = axis.length
    let c = a.dot(b)
    if s < 1e-12 {
        if c > 0 { return v }
        // Opposite: rotate pi about any axis perpendicular to a.
        let p = (abs(a.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0))
        let k = (p - a * p.dot(a)).normalized
        return k * (2 * k.dot(v)) - v
    }
    let k = axis * (1 / s)
    return v * c + k.cross(v) * s + k * (k.dot(v) * (1 - c))
}

public final class HairSimulation {
    public let head: HeadProxy
    public let params: SimulationParams
    public let clearance: Double
    public let minBendRadius: Double

    /// Per chain: offset into the node arrays, node count, pinned count, segment length.
    public struct ChainInfo: Sendable, Equatable { public var offset: Int; public var count: Int; public var pinned: Int; public var ds: Double }
    public private(set) var chains: [ChainInfo] = []
    public private(set) var rest: [V3] = []          // head frame
    public private(set) var restS: [Double] = []     // arc length of each rest node along its strand
    public private(set) var positions: [V3] = []     // world
    private var previous: [V3] = []
    private var accum: [V3] = []
    private var corr: [V3] = []
    private var lastStepStart: [V3] = []
    private var timeBank = 0.0
    public private(set) var pose: HeadPose = .identity
    public private(set) var stepCount = 0

    struct Binding { var a: Int; var b: Int; var t: Double; var offset: V3; var restDir: V3; var normal: V3 }
    private var bindings: [Binding] = []
    public private(set) var lod1Rest: Mesh

    public init(result: StyleResult, params: SimulationParams = SimulationParams()) {
        head = result.head
        self.params = params
        let profile = Profile.of(result.spec.kind)
        clearance = profile.shellRadius * result.spec.width
        minBendRadius = 1.25 * clearance
        lod1Rest = result.lod1
        let segment = max(0.5 * result.spec.width, 0.008)
        for strand in result.strands {
            let total = arcLengths(strand.centerline).last ?? 0
            let nodes = resamplePolyline(strand.centerline, spacing: segment)
            let ds = total / Double(max(1, nodes.count - 1))
            let s = (0..<nodes.count).map { Double($0) * ds }
            let pinned = max(2, s.lastIndex { $0 <= strand.freeFromS + 1e-9 }.map { $0 + 1 } ?? 2)
            chains.append(ChainInfo(offset: rest.count, count: nodes.count, pinned: min(pinned, nodes.count), ds: ds))
            rest.append(contentsOf: nodes)
            restS.append(contentsOf: s)
        }
        bind(result)
        reset(pose: .identity)
    }

    private func bind(_ result: StyleResult) {
        bindings.reserveCapacity(result.lod1.vertexCount)
        for (v, b) in result.lod1Binding.enumerated() {
            let ch = chains[Int(b.strand)]
            let s = Double(b.s)
            var i = min(ch.count - 2, max(0, Int(s / ch.ds)))
            if i < 0 { i = 0 }
            let t = min(1, max(0, (s - Double(i) * ch.ds) / ch.ds))
            let a = ch.offset + i, bb = ch.offset + i + 1
            let base = V3.lerp(rest[a], rest[bb], t)
            let dir = (rest[bb] - rest[a]).normalized
            bindings.append(Binding(a: a, b: bb, t: t, offset: result.lod1.positions[v] - base, restDir: dir, normal: result.lod1.normals[v]))
        }
    }

    /// Place every chain at its rest shape under `pose`, at rest (zero velocity).
    public func reset(pose: HeadPose) {
        self.pose = pose
        positions = rest.map(pose.apply)
        previous = positions
        accum = Array(repeating: .zero, count: positions.count)
        corr = accum
        timeBank = 0
    }

    /// Run `seconds` of simulation at a fixed pose, then zero the velocity. Called once when a
    /// style is installed: the oracle's 220-step drape can leave a strand still sliding slowly
    /// (up to ~8 cm over the next two seconds), which should not play out on screen.
    public func settle(pose p: HeadPose, seconds: Double = 2.5) {
        reset(pose: p)
        for _ in 0..<Int(seconds / params.dt) { step(pose: p) }
        previous = positions
        lastStepStart = positions
        timeBank = 0
    }

    /// Advance to the new pose over `elapsed` seconds in fixed steps; pinned nodes interpolate between poses.
    public func advance(to newPose: HeadPose, elapsed: Double) {
        timeBank += max(0, elapsed)
        var steps = Int(timeBank / params.dt)
        if steps > params.maxStepsPerAdvance { steps = params.maxStepsPerAdvance; timeBank = 0 } else { timeBank -= Double(steps) * params.dt }
        if steps == 0 { pose = newPose; pinTo(newPose); return }
        let from = pose
        for k in 1...steps {
            let f = Double(k) / Double(steps)
            step(pose: Self.interpolate(from, newPose, f))
        }
        pose = newPose
    }

    static func interpolate(_ a: HeadPose, _ b: HeadPose, _ f: Double) -> HeadPose {
        // Linear blend of axes re-orthonormalised (poses between frames differ by a few degrees).
        let x = V3.lerp(a.c0, b.c0, f).normalized
        var y = V3.lerp(a.c1, b.c1, f)
        y = (y - x * x.dot(y)).normalized
        return HeadPose(c0: x, c1: y, c2: x.cross(y), t: V3.lerp(a.t, b.t, f))
    }

    private func pinTo(_ p: HeadPose) {
        for ch in chains { for i in 0..<ch.pinned { positions[ch.offset + i] = p.apply(rest[ch.offset + i]) } }
    }

    /// One fixed step at `p`.
    public func step(pose p: HeadPose) {
        let g = V3(0, -params.gravity * params.dt * params.dt, 0)
        lastStepStart = positions
        pinTo(p)
        for ch in chains {
            for i in ch.pinned..<ch.count {
                let k = ch.offset + i
                let x = positions[k]
                let v = (x - previous[k]) * params.damping
                previous[k] = x
                positions[k] = (x + v) + g
                accum[k] = .zero
            }
        }
        for _ in 0..<params.passes {
            for ch in chains { solve(ch, pose: p) }
        }
        for ch in chains where ch.pinned < ch.count - 1 {
            for i in ch.pinned..<(ch.count - 1) {
                let k = ch.offset + i
                previous[k] = previous[k] + accum[k + 1] * params.ftlDamping
            }
        }
        stepCount += 1
    }

    private func solve(_ ch: ChainInfo, pose p: HeadPose) {
        // Work on a local copy of the chain in head frame for the constraint functions shared with ProtoStyle.
        // Runtime pass order: bend, collide, then follow-the-leader last, so every
        // step ends exactly inextensible and all FTL corrections feed the DFTL
        // velocity correction (a trailing uncorrected FTL pass would inject energy).
        var local = (0..<ch.count).map { p.inverseApply(positions[ch.offset + $0]) }
        applyBend(&local, fixedCount: ch.pinned, ds: ch.ds, stiffness: params.bendStiffness, minRadius: minBendRadius)
        applyCollision(&local, fixedCount: ch.pinned, head: head, clearance: clearance)
        corr.withUnsafeMutableBufferPointer { buf in
            applyFollowTheLeader(&local, fixedCount: ch.pinned, ds: ch.ds, corrections: buf.baseAddress! + ch.offset)
        }
        for i in ch.pinned..<ch.count { accum[ch.offset + i] = accum[ch.offset + i] + p.rotate(corr[ch.offset + i]) }
        for i in ch.pinned..<ch.count { positions[ch.offset + i] = p.apply(local[i]) }
    }

    /// Current chain nodes in the head frame (what the renderer, a child of the face anchor, needs).
    public func nodesInHeadFrame() -> [V3] { positions.map(pose.inverseApply) }

    /// Skinned LOD1 positions and normals in the head frame, as Float triples (renderer-ready).
    public func skinLOD1(positions outP: inout [Float], normals outN: inout [Float]) {
        let nodes = nodesInHeadFrame()
        let n = bindings.count
        if outP.count != 3 * n { outP = Array(repeating: 0, count: 3 * n) }
        if outN.count != 3 * n { outN = Array(repeating: 0, count: 3 * n) }
        for (v, b) in bindings.enumerated() {
            let a = nodes[b.a], c = nodes[b.b]
            let d = c - a
            let len = d.length
            let dir = len > 1e-12 ? d * (1 / len) : b.restDir
            let off = rotateMinimal(b.offset, from: b.restDir, to: dir)
            let nrm = rotateMinimal(b.normal, from: b.restDir, to: dir)
            let p = V3.lerp(a, c, b.t) + off
            outP[3 * v] = Float(p.x); outP[3 * v + 1] = Float(p.y); outP[3 * v + 2] = Float(p.z)
            outN[3 * v] = Float(nrm.x); outN[3 * v + 1] = Float(nrm.y); outN[3 * v + 2] = Float(nrm.z)
        }
    }

    /// Largest free-node speed (m/s) over the last step, from actual displacement — used to detect a settled state.
    public var maxSpeed: Double {
        guard lastStepStart.count == positions.count else { return 0 }
        var m = 0.0
        for ch in chains { for i in ch.pinned..<ch.count { let k = ch.offset + i; m = max(m, (positions[k] - lastStepStart[k]).length) } }
        return m / params.dt
    }
}
