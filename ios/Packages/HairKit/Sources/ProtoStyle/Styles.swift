// Styles.swift — style catalogue and generate() (reference/protostyle/styles.py, v0.2).
//
// generate(spec, head) is pure: same spec + head -> identical geometry. Roots are
// independent, so they are built in parallel and assembled in root order; the
// result is bit-identical to a serial build (tested).

import Foundation

public let cornrowWidthFraction = 0.93
public let relaxMinMove = 1e-9

public enum StyleKind: String, CaseIterable, Codable, Sendable {
    case boxBraids = "box_braids"
    case knotlessBraids = "knotless_braids"
    case twoStrandTwists = "two_strand_twists"
    case locs
    case cornrows
}

public struct StyleSpec: Hashable, Sendable, Codable {
    public var kind: StyleKind
    public var seed: UInt64 = 0x5EED
    public var width = 0.020
    public var length = 0.30
    public var jitter = 0.18
    public var hairlineMargin = 0.03
    public var cornrowRows = 10
    public var lod0Sides = 6
    public var lod1Sides = 6
    public var samplesPerPeriod = 10
    public var hasBodyProxy = false

    public init(kind: StyleKind, seed: UInt64 = 0x5EED, width: Double = 0.020, length: Double = 0.30,
                jitter: Double = 0.18, hairlineMargin: Double = 0.03, cornrowRows: Int = 10,
                lod0Sides: Int = 6, lod1Sides: Int = 6, samplesPerPeriod: Int = 10, hasBodyProxy: Bool = false) {
        self.kind = kind; self.seed = seed; self.width = width; self.length = length; self.jitter = jitter
        self.hairlineMargin = hairlineMargin; self.cornrowRows = cornrowRows; self.lod0Sides = lod0Sides
        self.lod1Sides = lod1Sides; self.samplesPerPeriod = samplesPerPeriod; self.hasBodyProxy = hasBodyProxy
    }

    enum CodingKeys: String, CodingKey {
        case kind, seed, width, length, jitter
        case hairlineMargin = "hairline_margin", cornrowRows = "cornrow_rows"
        case lod0Sides = "lod0_sides", lod1Sides = "lod1_sides"
        case samplesPerPeriod = "samples_per_period", hasBodyProxy = "has_body_proxy"
    }

    public func validate() -> [String] {
        var problems: [String] = []
        if !(width >= 0.004 && width <= 0.06) { problems.append("width must be between 4 mm and 6 cm") }
        if !(length >= 0.0 && length <= 1.2) { problems.append("length must be between 0 and 1.2 m") }
        if length > maxUnsupportedLength && !hasBodyProxy {
            problems.append(String(format: "length %.2f m exceeds %.2f m without a torso collider; strands would hang through the shoulders",
                                   length, maxUnsupportedLength))
        }
        if !(3...16).contains(lod0Sides) || !(3...16).contains(lod1Sides) { problems.append("sides must be between 3 and 16") }
        if !(6...32).contains(samplesPerPeriod) { problems.append("samples_per_period must be between 6 and 32") }
        if kind == .cornrows && !(2...24).contains(cornrowRows) { problems.append("cornrow_rows must be between 2 and 24") }
        return problems
    }
}

public struct Profile: Hashable, Sendable {
    public var strands: Int
    public var lateralAmp: Double
    public var depthAmp: Double
    public var strandRadius: Double
    public var period: Double
    public var shellRadius: Double

    public static func of(_ kind: StyleKind) -> Profile {
        switch kind {
        case .boxBraids, .knotlessBraids: return Profile(strands: 3, lateralAmp: 0.30, depthAmp: 0.09, strandRadius: 0.26, period: 1.50, shellRadius: 0.56)
        case .twoStrandTwists: return Profile(strands: 2, lateralAmp: 0.22, depthAmp: 0.22, strandRadius: 0.24, period: 1.60, shellRadius: 0.46)
        case .locs: return Profile(strands: 1, lateralAmp: 0.0, depthAmp: 0.0, strandRadius: 0.40, period: 1.00, shellRadius: 0.46)
        case .cornrows: return Profile(strands: 3, lateralAmp: 0.30, depthAmp: 0.10, strandRadius: 0.24, period: 1.30, shellRadius: 0.54)
        }
    }
}

public struct Strand: Sendable, Equatable {
    public var rootIndex: Int
    public var centerline: [V3]
    public var radiusMax: Double
    /// Arc length where the pinned prefix ends and hanging begins.
    public var freeFromS: Double
}

public enum RootRecord: Sendable, Equatable {
    case grid(Root)
    case cornrow(V3)
    public var point: V3 {
        switch self {
        case .grid(let r): return r.point
        case .cornrow(let p): return p
        }
    }
}

public struct StyleStats: Codable, Equatable, Sendable {
    public var kind: String
    public var roots: Int
    public var strandsPerRoot: Int
    public var lod0Vertices: Int
    public var lod0Triangles: Int
    public var lod1Vertices: Int
    public var lod1Triangles: Int
    public var meanLengthM: Double

    enum CodingKeys: String, CodingKey {
        case kind, roots
        case strandsPerRoot = "strands_per_root", lod0Vertices = "lod0_vertices", lod0Triangles = "lod0_triangles"
        case lod1Vertices = "lod1_vertices", lod1Triangles = "lod1_triangles", meanLengthM = "mean_length_m"
    }
}

public struct StyleResult: Sendable {
    public var spec: StyleSpec
    public var head: HeadProxy
    public var roots: [RootRecord]
    public var strands: [Strand]
    public var lod0: Mesh
    public var lod1: Mesh
    public var stats: StyleStats
    /// For each LOD1 vertex, the strand and arc length it was swept at (for skinning).
    public var lod1Binding: [(strand: UInt32, s: Float)]
}

@inlinable func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
    let t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3.0 - 2.0 * t)
}

/// Uniform Catmull-Rom densification; control points are emitted exactly. Also returns their dense indices.
public func catmullRomIndexed(_ points: [V3], spacing: Double) -> ([V3], [Int]) {
    if points.count < 2 { return (points, Array(0..<points.count)) }
    var out = [points[0]]
    var idx = [0]
    let n = points.count
    for i in 0..<(n - 1) {
        let p0 = points[max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[min(n - 1, i + 2)]
        let seg = (p2 - p1).length
        let steps = ceilCount(seg / spacing)
        if steps > 1 {
            for k in 1..<steps {
                let t = Double(k) / Double(steps)
                let t2 = t * t, t3 = t * t * t
                func c(_ d: Int) -> Double {
                    0.5 * ((2.0 * p1[d]) + (-p0[d] + p2[d]) * t + (2.0 * p0[d] - 5.0 * p1[d] + 4.0 * p2[d] - p3[d]) * t2
                        + (-p0[d] + 3.0 * p1[d] - 3.0 * p2[d] + p3[d]) * t3)
                }
                out.append(V3(c(0), c(1), c(2)))
            }
        }
        out.append(p2)
        idx.append(out.count - 1)
    }
    return (out, idx)
}

public func catmullRom(_ points: [V3], spacing: Double) -> [V3] { catmullRomIndexed(points, spacing: spacing).0 }

/// Remove bends tighter than `minRadius`; the first `keep` samples never move.
public func relaxCurvature(head: HeadProxy, _ points: [V3], minRadius: Double, clearance: Double, spacing: Double,
                           keep: Int = 1, iterations: Int = 60) -> [V3] {
    var pts = points
    let n = pts.count
    for _ in 0..<iterations {
        var moved = false
        var i = keep
        while i < n - 1 {
            defer { i += 1 }
            let a = pts[i - 1], b = pts[i], c = pts[i + 1]
            let u = b - a, v = c - b
            let lu = u.length, lv = v.length
            if lu < 1e-12 || lv < 1e-12 { continue }
            let ang = acos(max(-1.0, min(1.0, u.dot(v) / (lu * lv))))
            if ang < 1e-9 || 0.5 * (lu + lv) / ang >= minRadius { continue }
            let mid = (a + c) * 0.5
            let q = head.collide(b + (mid - b) * 0.6, clearance: clearance).0
            if (q - b).length < relaxMinMove { continue }  // held by a collider: not a move (v0.2)
            pts[i] = q
            moved = true
        }
        if !moved { break }
    }
    let headPart = Array(pts[0..<keep])
    let tail = resamplePolyline(Array(pts[(keep - 1)...]), spacing: spacing)
    return headPart + tail.dropFirst()
}

/// 1-D lattice value noise, cosine interpolation.
public struct ValueNoise: Sendable {
    public let cell: Double
    public let values: [Double]
    public init(seed: UInt64, cell: Double, count: Int) {
        var rng = SplitMix64(seed: seed)
        self.cell = cell
        values = (0..<(count + 2)).map { _ in rng.nextSigned() }
    }
    public func callAsFunction(_ s: Double) -> Double {
        let x = max(0.0, s / cell)
        var i = Int(x.rounded(.down))
        i = min(i, values.count - 2)
        let f = x - Double(i)
        let w = (1.0 - cos(f * Double.pi)) * 0.5
        return values[i] * (1.0 - w) + values[i + 1] * w
    }
}

func radiusProfile(_ kind: StyleKind, s: Double, total: Double, width: Double, strandRadius: Double, noise: ValueNoise) -> Double {
    var r = strandRadius * width
    switch kind {
    case .boxBraids:
        let q = s / 0.010
        r *= 1.0 + 0.28 * exp(-(q * q))
    case .knotlessBraids:
        r *= 0.45 + 0.55 * smoothstep(0.0, 0.035, s)
    case .locs:
        r *= 1.0 + 0.12 * noise(s)
    default: break
    }
    let taperStart = total * 0.94
    if s > taperStart && total > 0.0 { r *= 1.0 - 0.45 * smoothstep(taperStart, total, s) }
    return r
}

func feedScale(_ kind: StyleKind, _ s: Double) -> Double {
    kind == .knotlessBraids ? 0.45 + 0.55 * smoothstep(0.0, 0.035, s) : 1.0
}

func strandOffset(_ profile: Profile, strand: Int, s: Double, width: Double) -> (Double, Double) {
    if profile.strands == 1 {
        return (0.04 * width * sin(2.0 * Double.pi * s / (profile.period * width)), 0.0)
    }
    let omega = 2.0 * Double.pi / (profile.period * width)
    if profile.strands == 3 {
        let phase = omega * s + 2.0 * Double.pi * Double(strand) / 3.0
        return (profile.lateralAmp * width * sin(phase), profile.depthAmp * width * sin(2.0 * phase))
    }
    let phase = omega * s + Double.pi * Double(strand)
    return (profile.lateralAmp * width * cos(phase), profile.depthAmp * width * sin(phase))
}

struct RootBuild: Sendable {
    var strand: Strand
    var lod0: Mesh
    var lod1: Mesh
    var binding: [(strand: UInt32, s: Float)]
    var rootRecord: RootRecord
}

func sweepStrands(spec: StyleSpec, profile: Profile, centerline: [V3], lateral0: V3, outward: V3, noise: ValueNoise,
                  strandID: UInt32, includeLOD0: Bool) -> (rMax: Double, lod0: Mesh, lod1: Mesh, binding: [(strand: UInt32, s: Float)]) {
    let frames = rotationMinimizingFrames(centerline, lateral0: lateral0, outward: outward)
    let N = frames.n, B = frames.b
    let sVals = arcLengths(centerline)
    let total = sVals[sVals.count - 1]
    let w = spec.width
    let fracs: [Float] = sVals.map { total > 0 ? Float($0 / total) : 0 }
    var rMax = 0.0
    var lod0 = Mesh(), lod1 = Mesh()
    for strand in 0..<profile.strands {
        var centers: [V3] = [], radii: [Double] = []
        centers.reserveCapacity(sVals.count)
        radii.reserveCapacity(sVals.count)
        for k in 0..<sVals.count {
            let s = sVals[k]
            let (lat, dep) = strandOffset(profile, strand: strand, s: s, width: w)
            let scale = feedScale(spec.kind, s)
            centers.append(centerline[k] + (N[k] * (lat * scale) + B[k] * (dep * scale)))
            let r = radiusProfile(spec.kind, s: s, total: total, width: w, strandRadius: profile.strandRadius, noise: noise)
            radii.append(r)
            rMax = max(rMax, r)
        }
        if includeLOD0 {
            var Ns = N, Bs = B
            if profile.strands > 1 {
                let f = rotationMinimizingFrames(centers, lateral0: N[0], outward: outward)
                Ns = f.n; Bs = f.b
            }
            lod0.extend(tube(centers: centers, n: Ns, b: Bs, radii: radii, sides: spec.lod0Sides, capTip: true,
                             vScale: 1.0 / (profile.period * w), sValues: sVals, fracs: fracs, strandID: strandID))
        }
    }
    var idx = Array(stride(from: 0, to: centerline.count, by: 4))
    if idx[idx.count - 1] != centerline.count - 1 { idx.append(centerline.count - 1) }
    let shellC = idx.map { centerline[$0] }
    let shellR: [Double] = idx.map { i in
        let s = sVals[i]
        var base = profile.shellRadius * w * feedScale(spec.kind, s)
        if spec.kind == .locs { base *= 1.0 + 0.12 * noise(s) }
        if s > total * 0.94 { base *= 1.0 - 0.45 * smoothstep(total * 0.94, total, s) }
        return base
    }
    let shellS = idx.map { sVals[$0] }
    lod1.extend(tube(centers: shellC, n: idx.map { N[$0] }, b: idx.map { B[$0] }, radii: shellR, sides: spec.lod1Sides,
                     capTip: true, vScale: 1.0 / (profile.period * w), sValues: shellS, fracs: idx.map { fracs[$0] }, strandID: strandID))
    var binding: [(strand: UInt32, s: Float)] = []
    binding.reserveCapacity(lod1.vertexCount)
    for s in shellS { for _ in 0..<spec.lod1Sides { binding.append((strandID, Float(s))) } }
    binding.append((strandID, Float(shellS[shellS.count - 1])))
    return (rMax, lod0, lod1, binding)
}

func partDirection(_ root: Root) -> V3 {
    let sweep = 1.1 * max(0.0, cos(root.phi))
    return (root.normal + root.tBack * sweep).normalized
}

func polylineLength(_ points: [V3]) -> Double {
    pySum((1..<max(1, points.count)).map { (points[$0] - points[$0 - 1]).length })
}

/// Slots filled by `concurrentPerform` workers and read after all of them finish.
/// Raw storage (not an Array) so concurrent writes to distinct indices never touch
/// shared copy-on-write state; each index is written by exactly one worker.
final class ParallelSlots<T>: @unchecked Sendable {
    private let base: UnsafeMutablePointer<T?>
    let count: Int
    init(count: Int) {
        self.count = count
        base = .allocate(capacity: count)
        base.initialize(repeating: nil, count: count)
    }
    deinit {
        base.deinitialize(count: count)
        base.deallocate()
    }
    func set(_ i: Int, _ v: T) { base[i] = v }
    var values: [T] { (0..<count).map { base[$0]! } }
}

func parallelMap<T>(_ count: Int, parallel: Bool, _ body: (Int) throws -> T) rethrows -> [T] {
    if !parallel || count < 4 { return try (0..<count).map(body) }
    let slots = ParallelSlots<Result<T, Error>>(count: count)
    withoutActuallyEscaping(body) { body in
        let box = UncheckedBox(body)
        DispatchQueue.concurrentPerform(iterations: count) { i in
            slots.set(i, Result { try box.value(i) })
        }
    }
    return try slots.values.map { try $0.get() }
}

struct UncheckedBox<T>: @unchecked Sendable { let value: T; init(_ v: T) { value = v } }

/// Generate a style on a head. `progress` is called with (done, total) from worker threads.
public func generate(_ spec: StyleSpec, head: HeadProxy = HeadProxy(), drapeParams: DrapeParams = DrapeParams(),
                     includeLOD0: Bool = true, parallel: Bool = true,
                     progress: (@Sendable (Int, Int) -> Void)? = nil) throws -> StyleResult {
    let problems = spec.validate()
    if !problems.isEmpty { throw ProtoStyleError.invalidSpec(problems) }
    let profile = Profile.of(spec.kind)
    let w = spec.width
    let period = profile.period * w
    let denseSpacing = period / Double(spec.samplesPerPeriod)
    let drapeSegment = max(0.5 * w, 0.008)
    let clearance = profile.shellRadius * w
    let counter = ProgressCounter()

    var builds: [RootBuild]
    if spec.kind == .cornrows {
        let paths = try cornrowPaths(head: head, rows: spec.cornrowRows, widthFraction: cornrowWidthFraction,
                                     spacing: drapeSegment, hairlineMargin: spec.hairlineMargin)
        builds = try parallelMap(paths.count, parallel: parallel) { ri in
            let path = paths[ri]
            let lifted = path.map { $0 + head.normal(at: head.toSurface($0)) * (0.35 * w) }
            let coarse = try drape(head: head, fixed: lifted, freeLength: spec.length, segment: drapeSegment,
                                   clearance: clearance, params: drapeParams, minBendRadius: 1.25 * clearance)
            var (dense, ctrl) = catmullRomIndexed(coarse, spacing: denseSpacing)
            let keep = ctrl[lifted.count - 1] + 1
            dense = relaxCurvature(head: head, dense, minRadius: 1.1 * clearance, clearance: 0.9 * clearance,
                                   spacing: denseSpacing, keep: keep)
            let outward = head.normal(at: head.toSurface(path[0]))
            let t0 = (path[1] - path[0]).normalized
            let lateral0 = outward.cross(t0).normalized
            let noise = ValueNoise(seed: deriveSeed(spec.seed, "noise:\(ri)"), cell: 0.02,
                                   count: pyInt(Double(dense.count) * denseSpacing / 0.02) + 4)
            let sw = sweepStrands(spec: spec, profile: profile, centerline: dense, lateral0: lateral0, outward: outward,
                                  noise: noise, strandID: UInt32(ri), includeLOD0: includeLOD0)
            progress?(counter.increment(), paths.count)
            return RootBuild(strand: Strand(rootIndex: ri, centerline: dense, radiusMax: sw.rMax, freeFromS: polylineLength(lifted)),
                             lod0: sw.lod0, lod1: sw.lod1, binding: sw.binding, rootRecord: .cornrow(path[0]))
        }
    } else {
        let roots = try gridSections(head: head, sectionSize: w, jitter: spec.jitter, seed: spec.seed, hairlineMargin: spec.hairlineMargin)
        let lift = 0.6 * w
        builds = try parallelMap(roots.count, parallel: parallel) { i in
            let root = roots[i]
            let fixed = [root.point, root.point + partDirection(root) * lift]
            let coarse = try drape(head: head, fixed: fixed, freeLength: spec.length, segment: drapeSegment,
                                   clearance: clearance, params: drapeParams, minBendRadius: 1.25 * clearance)
            let dense = relaxCurvature(head: head, catmullRom(coarse, spacing: denseSpacing), minRadius: 1.1 * clearance,
                                       clearance: 0.9 * clearance, spacing: denseSpacing, keep: 1)
            let noise = ValueNoise(seed: deriveSeed(spec.seed, "noise:\(root.index)"), cell: 0.02,
                                   count: pyInt((spec.length + lift) / 0.02) + 6)
            let sw = sweepStrands(spec: spec, profile: profile, centerline: dense, lateral0: root.tSide, outward: root.normal,
                                  noise: noise, strandID: UInt32(root.index), includeLOD0: includeLOD0)
            progress?(counter.increment(), roots.count)
            return RootBuild(strand: Strand(rootIndex: root.index, centerline: dense, radiusMax: sw.rMax, freeFromS: lift),
                             lod0: sw.lod0, lod1: sw.lod1, binding: sw.binding, rootRecord: .grid(root))
        }
    }

    var lod0 = Mesh(), lod1 = Mesh()
    var binding: [(strand: UInt32, s: Float)] = []
    for b in builds {
        lod0.extend(b.lod0)
        lod1.extend(b.lod1)
        binding.append(contentsOf: b.binding)
    }
    let strands = builds.map(\.strand)
    let lengths = strands.map { arcLengths($0.centerline).last ?? 0 }
    let stats = StyleStats(kind: spec.kind.rawValue, roots: strands.count, strandsPerRoot: profile.strands,
                           lod0Vertices: lod0.vertexCount, lod0Triangles: lod0.triangleCount,
                           lod1Vertices: lod1.vertexCount, lod1Triangles: lod1.triangleCount,
                           meanLengthM: lengths.isEmpty ? 0.0 : pyRoundDigits(pySum(lengths) / Double(lengths.count), 6))
    return StyleResult(spec: spec, head: head, roots: builds.map(\.rootRecord), strands: strands, lod0: lod0, lod1: lod1,
                       stats: stats, lod1Binding: binding)
}

final class ProgressCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func increment() -> Int { lock.lock(); defer { lock.unlock() }; n += 1; return n }
}
