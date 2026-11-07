// HairMaterial.swift — CustomMaterial running HairSurface.metal, with a PBR fallback.

import RealityKit
import Metal
import UIKit
import TryOnCore

@MainActor
enum HairMaterialFactory {
    static let device = MTLCreateSystemDefaultDevice()
    static let library = device?.makeDefaultLibrary()

    /// Immediate stand-in while the custom material and its gradient texture are created.
    static func placeholder(color: CatalogColor) -> PhysicallyBasedMaterial {
        var m = PhysicallyBasedMaterial()
        let c = LookColor.srgb(hex: color.hex)
        m.baseColor = .init(tint: UIColor(red: c.x, green: c.y, blue: c.z, alpha: 1))
        m.roughness = 0.5
        m.metallic = 0
        return m
    }

    static func material(color: CatalogColor, params: ShaderParams) async throws -> CustomMaterial {
        guard let library else { throw MaterialError.noMetal }
        let shader = CustomMaterial.SurfaceShader(named: "hairSurface", in: library)
        var m = try CustomMaterial(surfaceShader: shader, lightingModel: .lit)
        m.custom.value = SIMD4(params.lobes, params.groove, params.fuzz, params.slant)
        m.custom.texture = .init(try await gradient(color: color))
        m.faceCulling = .back  // LOD1 shells: tubes capped at the tip (Sweep.tube); the open root end sits on the scalp
        return m
    }

    /// 64x1 root -> tip gradient (sRGB) for a colour, ombré included.
    static func gradient(color: CatalogColor, width: Int = 64) async throws -> TextureResource {
        var px: [UInt8] = []
        for i in 0..<width {
            let c = LookColor.color(color, at: Double(i) / Double(width - 1))
            for ch in [c.x, c.y, c.z] { px.append(UInt8((LookColor.toSRGB(ch) * 255).rounded())) }
            px.append(255)
        }
        let provider = CGDataProvider(data: Data(px) as CFData)!
        let image = CGImage(width: width, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
        return try await TextureResource(image: image, withName: "hair-gradient-\(color.id)", options: .init(semantic: .color))
    }

    enum MaterialError: Error { case noMetal }
}
