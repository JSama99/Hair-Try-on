// MediaPipeHairSegmenter.swift — MediaPipe ImageSegmenter in live-stream mode.
//
// One frame in flight; a 1 s watchdog clears a lost callback so segmentation
// can never stall for the session. Masks are copied on MediaPipe's callback
// thread (the MPPMask memory is only valid there).

#if canImport(MediaPipeTasksVision)
import Foundation
import CoreVideo
import MediaPipeTasksVision
import TryOnCore

final class MediaPipeHairSegmenter: NSObject, HairSegmenting, ImageSegmenterLiveStreamDelegate, @unchecked Sendable {
    enum Model {
        case multiclass, hairOnly
        var file: String { self == .multiclass ? "selfie_multiclass_256x256" : "hair_segmenter" }
    }

    let name: String
    let providesSkin: Bool
    var onResult: (@Sendable (SegmentationResult) -> Void)?

    private var segmenter: ImageSegmenter!
    private let lock = NSLock()
    private var inFlightSince: Date?

    init(model: Model) throws {
        guard let path = Bundle.main.path(forResource: model.file, ofType: "tflite") else {
            throw NSError(domain: "HairSegmenter", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(model.file).tflite is not bundled; run scripts/fetch-models.sh"])
        }
        name = model.file
        providesSkin = model == .multiclass
        super.init()
        let options = ImageSegmenterOptions()
        options.baseOptions.modelAssetPath = path
        options.runningMode = .liveStream
        options.shouldOutputConfidenceMasks = true
        options.shouldOutputCategoryMask = false
        options.imageSegmenterLiveStreamDelegate = self
        segmenter = try ImageSegmenter(options: options)
    }

    func submit(_ pixelBuffer: CVPixelBuffer, timestampMs: Int) -> Bool {
        lock.lock()
        if let t = inFlightSince, Date().timeIntervalSince(t) < 1.0 { lock.unlock(); return false }
        inFlightSince = Date()
        lock.unlock()
        do {
            let image = try MPImage(pixelBuffer: pixelBuffer)
            try segmenter.segmentAsync(image: image, timestampInMilliseconds: timestampMs)
            return true
        } catch {
            clearInFlight()
            return false
        }
    }

    var isBusy: Bool {
        lock.lock(); defer { lock.unlock() }
        guard let t = inFlightSince else { return false }
        return Date().timeIntervalSince(t) < 1.0
    }

    private func clearInFlight() { lock.lock(); inFlightSince = nil; lock.unlock() }

    func imageSegmenter(_ imageSegmenter: ImageSegmenter, didFinishSegmentation result: ImageSegmenterResult?,
                        timestampInMilliseconds: Int, error: Error?) {
        defer { clearInFlight() }
        guard let masks = result?.confidenceMasks, !masks.isEmpty else { return }
        func copy(_ m: Mask) -> ProbabilityMap {
            let n = m.width * m.height
            let src = m.float32Data
            return ProbabilityMap(width: m.width, height: m.height, values: Array(UnsafeBufferPointer(start: src, count: n)))
        }
        let hair: ProbabilityMap
        var skin: ProbabilityMap?
        if providesSkin, masks.count >= 4 {
            // selfie_multiclass: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other.
            hair = copy(masks[1])
            let body = copy(masks[2]), face = copy(masks[3])
            skin = ProbabilityMap(width: face.width, height: face.height, values: zip(body.values, face.values).map { min(1, $0 + $1) })
        } else {
            hair = copy(masks[masks.count > 1 ? 1 : 0])
        }
        onResult?(SegmentationResult(timestampMs: timestampInMilliseconds, hair: hair, skin: skin))
    }
}
#endif
