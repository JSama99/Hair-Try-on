// RenderAttributes.swift — what the GPU needs for an LOD1 shell (docs/ARCHITECTURE.md §4.7).
//
// uv0: (around the shell, along it in plait periods) — drives the plait relief.
// uv1: (root -> tip fraction, per-strand jitter) — drives ombré and variation.

import Foundation
import ProtoStyle

public struct ShaderParams: Sendable, Equatable {
    /// Visible crossings per plait period around the shell (3-strand: 2 per side; twist: 1).
    public var lobes: Float
    /// Groove darkening between lobes, 0...1.
    public var groove: Float
    /// Fibre fuzz amount, 0...1.
    public var fuzz: Float
    /// Lobe tilt: + for a plait chevron, constant for a twist helix, 0 for a loc.
    public var slant: Float
}

public struct RenderAttributes: Sendable {
    public var uv0: [SIMD2<Float>]
    public var uv1: [SIMD2<Float>]
    public var indices: [UInt32]
    public var params: ShaderParams

    public init(result: StyleResult) {
        let m = result.lod1
        uv0 = m.uvs.map { SIMD2(Float($0.x), Float($0.y)) }
        uv1 = zip(m.fracs, m.strandIDs).map { SIMD2($0, Float(LookColor.strandJitter($1))) }
        indices = m.triangles
        params = Self.params(for: result.spec.kind)
    }

    public static func params(for kind: StyleKind) -> ShaderParams {
        switch kind {
        case .boxBraids, .knotlessBraids: return ShaderParams(lobes: 2, groove: 0.55, fuzz: 0.25, slant: 0.7)
        case .cornrows: return ShaderParams(lobes: 2, groove: 0.6, fuzz: 0.2, slant: 0.7)
        case .twoStrandTwists: return ShaderParams(lobes: 1, groove: 0.45, fuzz: 0.3, slant: 0.6)
        case .locs: return ShaderParams(lobes: 0, groove: 0.0, fuzz: 0.55, slant: 0)
        }
    }
}

public extension StyleResult {
    /// Gradient for a look as `width` sRGB-encoded RGBA texels, root (index 0) to tip.
    func gradientTexels(color: CatalogColor, width: Int = 64, catalog: Catalog = .shared) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(width * 4)
        for i in 0..<width {
            let f = Double(i) / Double(max(1, width - 1))
            let c = LookColor.color(color, at: f, catalog)
            for ch in [c.x, c.y, c.z] { out.append(UInt8((LookColor.toSRGB(ch) * 255).rounded())) }
            out.append(255)
        }
        return out
    }
}
