// HairSegmenter.swift — the replaceable segmentation component (docs/ARCHITECTURE.md §4.4).
// A fine-tuned model drops in behind this protocol without touching callers.

import CoreVideo
import TryOnCore

struct SegmentationResult: Sendable {
    /// Display-oriented frame timestamp in ms (matches the FrameSnapshot it came from).
    var timestampMs: Int
    var hair: ProbabilityMap
    /// nil when the model has no skin classes (hair-only model).
    var skin: ProbabilityMap?
}

protocol HairSegmenting: AnyObject {
    var name: String { get }
    var providesSkin: Bool { get }
    /// True while a frame is in flight: callers skip rendering the next frame until it clears.
    var isBusy: Bool { get }
    /// Submit a display-oriented BGRA frame. Returns false if a frame is still in flight (dropped).
    func submit(_ pixelBuffer: CVPixelBuffer, timestampMs: Int) -> Bool
    var onResult: (@Sendable (SegmentationResult) -> Void)? { get set }
}

/// Used when no model could be loaded: the app still works, without the honesty check or calibration.
final class UnavailableSegmenter: HairSegmenting {
    let name = "unavailable"
    let providesSkin = false
    var onResult: (@Sendable (SegmentationResult) -> Void)?
    var isBusy: Bool { true }
    func submit(_ pixelBuffer: CVPixelBuffer, timestampMs: Int) -> Bool { false }
}

enum SegmenterFactory {
    /// Multiclass first (hair + skin in one pass), hair-only second, otherwise unavailable.
    static func make() -> HairSegmenting {
        #if canImport(MediaPipeTasksVision)
        if let s = try? MediaPipeHairSegmenter(model: .multiclass) { return s }
        if let s = try? MediaPipeHairSegmenter(model: .hairOnly) { return s }
        #endif
        return UnavailableSegmenter()
    }
}
