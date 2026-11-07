// LookColor.swift — braiding-hair colour along a strand (twin of web/src/tryon.js).

import Foundation

public enum LookColor {
    public static func srgb(hex: String) -> SIMD3<Double> {
        let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return SIMD3(Double((v >> 16) & 255) / 255, Double((v >> 8) & 255) / 255, Double(v & 255) / 255)
    }
    public static func toLinear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    public static func toSRGB(_ c: Double) -> Double { c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1 / 2.4) - 0.055 }
    public static func linear(hex: String) -> SIMD3<Double> { let s = srgb(hex: hex); return SIMD3(toLinear(s.x), toLinear(s.y), toLinear(s.z)) }

    /// Ombré weight at root -> tip fraction f.
    public static func ombreWeight(_ f: Double, _ catalog: Catalog = .shared) -> Double {
        let t = min(1, max(0, (f - catalog.ombre.start) / (catalog.ombre.end - catalog.ombre.start)))
        return t * t * (3 - 2 * t)
    }

    /// Linear RGB at fraction f; `jitter` in [-1, 1] varies lightness per strand.
    public static func color(_ c: CatalogColor, at f: Double, jitter: Double = 0, _ catalog: Catalog = .shared) -> SIMD3<Double> {
        var rgb = linear(hex: c.hex)
        if let tip = c.tipHex {
            let w = ombreWeight(f, catalog)
            rgb = rgb + (linear(hex: tip) - rgb) * w
        }
        let k = 1 + 0.07 * jitter
        return SIMD3(min(1, rgb.x * k), min(1, rgb.y * k), min(1, rgb.z * k))
    }

    /// Stable per-strand jitter in [-1, 1]: the same 32-bit integer hash as the web build.
    public static func strandJitter(_ id: UInt32) -> Double {
        var x = (id &+ 1) &* 0x9E37_79B1
        x = (x ^ (x >> 16)) &* 0x85EB_CA6B
        x = (x ^ (x >> 13)) &* 0xC2B2_AE35
        x ^= x >> 16
        return Double(x) / 4_294_967_295 * 2 - 1
    }
}
