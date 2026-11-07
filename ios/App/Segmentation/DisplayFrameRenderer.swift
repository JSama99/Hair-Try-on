// DisplayFrameRenderer.swift — the camera image as the person sees it, at mask resolution.
//
// ARKit's capturedImage is landscape YCbCr. Rendering it through
// ARFrame.displayTransform(for: .portrait, viewportSize:) produces the same
// orientation that ARCamera.projectPoint(_:orientation:.portrait,viewportSize:)
// uses, so mask pixels and projected head points share one coordinate system.

import ARKit
import CoreImage
import CoreVideo

final class DisplayFrameRenderer {
    let size: CGSize
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?

    init(size: CGSize) {
        self.size = size
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width),
            kCVPixelBufferHeightKey as String: Int(size.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
    }

    func render(_ frame: ARFrame) -> CVPixelBuffer? {
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let out else { return nil }
        let image = CIImage(cvPixelBuffer: frame.capturedImage)
        // displayTransform maps normalised image coordinates to normalised view coordinates.
        let w = image.extent.width, h = image.extent.height
        let toNormalized = CGAffineTransform(scaleX: 1 / w, y: 1 / h)
        let display = frame.displayTransform(for: .portrait, viewportSize: size)
        let toView = CGAffineTransform(scaleX: size.width, y: size.height)
        // Core Image's origin is bottom-left; flip into and out of the UIKit convention around the transform.
        let flipIn = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -1)
        let flipOut = CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -size.height)
        let t = toNormalized.concatenating(flipIn).concatenating(display).concatenating(toView).concatenating(flipOut)
        context.render(image.transformed(by: t).cropped(to: CGRect(origin: .zero, size: size)), to: out)
        return out
    }

    /// Whether the on-screen camera feed is mirrored relative to this rendering.
    /// UNVERIFIED (docs/BUILD.md, device check D4): set from the first on-device run by holding
    /// a hand up on one side and checking the amber overlay lands on the same side. Only the
    /// overlay depends on it; projection, honesty ratios and calibration do not.
    static let screenIsMirrored = false
}
