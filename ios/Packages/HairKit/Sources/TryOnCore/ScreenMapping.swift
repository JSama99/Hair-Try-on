// ScreenMapping.swift — where a mask pixel lands on screen.
//
// The camera image is shown aspect-filled (cropped) and, for the front camera,
// mirrored. Masks are computed on the display-oriented image, so mapping is a
// scale + offset (+ mirror) between normalised mask space and view points.

import Foundation

public struct ScreenMapping: Sendable, Equatable {
    public var imageSize: SIMD2<Double>
    public var viewSize: SIMD2<Double>
    public var mirrored: Bool

    public init(imageSize: SIMD2<Double>, viewSize: SIMD2<Double>, mirrored: Bool) {
        self.imageSize = imageSize; self.viewSize = viewSize; self.mirrored = mirrored
    }

    var scale: Double { max(viewSize.x / imageSize.x, viewSize.y / imageSize.y) }
    var offset: SIMD2<Double> { (viewSize - imageSize * scale) * 0.5 }

    /// Normalised image coordinates (0...1, y down) -> view points.
    public func toView(_ uv: SIMD2<Double>) -> SIMD2<Double> {
        let u = mirrored ? 1 - uv.x : uv.x
        return SIMD2(u * imageSize.x, uv.y * imageSize.y) * scale + offset
    }

    /// View points -> normalised image coordinates.
    public func toImage(_ p: SIMD2<Double>) -> SIMD2<Double> {
        let q = (p - offset) / scale
        let u = q.x / imageSize.x
        return SIMD2(mirrored ? 1 - u : u, q.y / imageSize.y)
    }

    /// Working size for masks: long side `longSide`, aspect preserved.
    public static func maskSize(imageWidth: Int, imageHeight: Int, longSide: Int = 256) -> (width: Int, height: Int) {
        let s = Double(longSide) / Double(max(imageWidth, imageHeight))
        return (max(1, Int((Double(imageWidth) * s).rounded())), max(1, Int((Double(imageHeight) * s).rounded())))
    }
}
