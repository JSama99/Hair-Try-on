import Foundation
import XCTest
@testable import TryOnCore
import ProtoStyle
import HeadFit
import HairDynamics

let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
func canonicalFace() throws -> [V3] {
    let o = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("canonical_face.json"))) as! [String: Any]
    return (o["vertices"] as! [[Double]]).map { V3($0[0], $0[1], $0[2]) }
}

final class CatalogTests: XCTestCase {
    let c = Catalog.shared

    func testCatalogLoadsAndDefaultsResolve() {
        XCTAssertEqual(c.styles.count, 5)
        XCTAssertEqual(Set(c.styles.map(\.kind)), Set(StyleKind.allCases))
        XCTAssertEqual(c.skinTones.count, 10)
        let look = Look.default()
        guard case .ok(let spec) = c.resolve(look) else { return XCTFail("default look must resolve") }
        XCTAssertTrue(spec.validate().isEmpty)
    }

    func testEveryUnlockedLookIsAValidSpecAndBodyLengthsAreLocked() {
        for s in c.styles { for z in s.sizes { for l in c.lengths {
            let r = c.resolve(Look(style: s.id, size: z.id, length: l.id, color: "1B"))
            if l.isLocked {
                guard case .locked(let msg) = r else { return XCTFail("\(l.id) must be locked") }
                XCTAssertTrue(msg.hasPrefix("\(l.label) length needs a body capture"))
                XCTAssertTrue(msg.hasSuffix("Armpit length is the longest available."))
                XCTAssertGreaterThan(l.length, maxUnsupportedLength)
            } else {
                guard case .ok(let spec) = r else { return XCTFail("\(s.id)/\(z.id)/\(l.id)") }
                XCTAssertTrue(spec.validate().isEmpty)
                if s.kind == .cornrows { XCTAssertEqual(spec.cornrowRows, z.rows) }
            }
        } } }
        if case .ok(let spec) = c.resolve(Look(style: "box_braids", size: "medium", length: "waist", color: "1"), hasBodyProxy: true) {
            XCTAssertTrue(spec.hasBodyProxy)
        } else { XCTFail("a body proxy unlocks long lengths") }
    }

    func testCaptionsMatchTheWebBuildWordForWord() {
        XCTAssertEqual(c.caption(Look(style: "knotless_braids", size: "small", length: "armpit", color: "1B/27")),
                       "Knotless braids, small (1.2 cm parts), armpit length, colour 1B/27 (off black to honey blonde)")
        XCTAssertEqual(c.caption(Look(style: "cornrows", size: "medium", length: "shoulder", color: "1")),
                       "Cornrows, 10 rows, 1.8 cm braids, shoulder-length tails, colour 1 (jet black)")
    }

    func testSwitchingStyleResetsSizeAndLength() {
        let l = Look.default().with(style: "locs")
        XCTAssertEqual(l.size, "medium"); XCTAssertEqual(l.length, "shoulder"); XCTAssertEqual(l.color, Look.default().color)
    }
}

final class ColorTests: XCTestCase {
    func testStrandJitterMatchesTheWebBuild() {
        let js = [-0.8594662048526728, 0.4622402036241815, 0.6768759399831472, -0.7027645641245797, -0.8143437830299008, -0.06995884959352172]
        for (id, want) in zip([0, 1, 2, 17, 104, 4095] as [UInt32], js) { XCTAssertEqual(LookColor.strandJitter(id), want, accuracy: 1e-15) }
    }

    func testOmbreAndJitterMatchTheWebBuild() {
        let c = LookColor.color(Catalog.shared.color("1B/27")!, at: 0.6, jitter: 0.5)
        XCTAssertEqual(c.x, 0.25072439790495255, accuracy: 1e-12)
        XCTAssertEqual(c.y, 0.10134925203553752, accuracy: 1e-12)
        XCTAssertEqual(c.z, 0.02909315488195348, accuracy: 1e-12)
        for v in [0.0, 0.02, 0.5, 1.0] { XCTAssertEqual(LookColor.toSRGB(LookColor.toLinear(v)), v, accuracy: 1e-12) }
    }

    func testGradientTexelsRunRootToTip() throws {
        let r = try generate(StyleSpec(kind: .locs, width: 0.035, length: 0.12), includeLOD0: false)
        let tex = r.gradientTexels(color: Catalog.shared.color("1B/613")!)
        XCTAssertEqual(tex.count, 256)
        XCTAssertLessThan(tex[0], tex[252], "root dark, platinum tip light")
        XCTAssertEqual(tex[3], 255)
    }
}

final class HonestyTests: XCTestCase {
    func testMeasureAndHysteresis() {
        var v = [Float](repeating: 0, count: 100)
        for i in 0..<40 { v[i] = 0.9 }
        let hair = ProbabilityMap(width: 10, height: 10, values: v)
        var style = [Bool](repeating: false, count: 100)
        for i in 0..<30 { style[i] = true }
        let m = Honesty.measure(hair: hair, style: style, headArea: 100)
        XCTAssertEqual(m.ratio, 0.25)
        XCTAssertFalse(m.wrapped)
        func mm(_ r: Double, _ w: Bool = false) -> ConflictMeasure { ConflictMeasure(hairPixels: 1, uncovered: 0, ratio: r, hairShare: 1, wrapped: w) }
        XCTAssertFalse(Honesty.update(active: false, mm(0.10)))
        XCTAssertTrue(Honesty.update(active: false, mm(0.13)))
        XCTAssertTrue(Honesty.update(active: true, mm(0.10)))
        XCTAssertFalse(Honesty.update(active: true, mm(0.07)))
        XCTAssertFalse(Honesty.update(active: true, mm(0.9, true)))
        XCTAssertEqual(Honesty.tip(mm(0.345), source: .photo),
                       "About 35% of the hair in your photo falls outside this style (shown in amber). In real life that hair has to be braided in or tucked away, so the result can look different from this preview. For the truest preview, use a photo with your hair pulled back or under a wrap.")
    }

    func testProbabilityMapSamplesBilinearly() {
        let m = ProbabilityMap(width: 2, height: 1, values: [0, 1])
        XCTAssertEqual(m.sample(SIMD2(0.25, 0.5)), 0, accuracy: 1e-12)
        XCTAssertEqual(m.sample(SIMD2(0.5, 0.5)), 0.5, accuracy: 1e-12)
        XCTAssertEqual(m.sample(SIMD2(0.75, 0.5)), 1, accuracy: 1e-12)
        XCTAssertEqual(m.mask(threshold: 0.5), [false, true])
    }

    func testDilateMatchesTheWebBuild() {
        let m: [Bool] = [true, false, false, false, true, false, false, false, false]
        XCTAssertEqual(Honesty.dilate(m, width: 9, height: 1, radius: 2), [true, true, true, true, true, true, true, false, false])
        XCTAssertEqual(Honesty.closingRadius(width: 256, height: 192), 3)
        var sq = [Bool](repeating: false, count: 25); sq[12] = true
        XCTAssertEqual(Honesty.dilate(sq, width: 5, height: 5, radius: 1).filter { $0 }.count, 9)
    }

    func testRasteriserFillsExactlyTheTriangle() {
        var mask: [Bool] = []
        SilhouetteRaster.fill(triangles: [0, 1, 2, 0, 2, 3], points: [SIMD2(2, 2), SIMD2(8, 2), SIMD2(8, 8), SIMD2(2, 8)], width: 10, height: 10, into: &mask)
        XCTAssertEqual(mask.filter { $0 }.count, 36, "a 6x6 square")
        XCTAssertFalse(mask[0]); XCTAssertTrue(mask[5 * 10 + 5])
    }
}

final class ScreenMappingTests: XCTestCase {
    func testAspectFillRoundTripAndMirror() {
        let m = ScreenMapping(imageSize: SIMD2(1080, 1920), viewSize: SIMD2(390, 844), mirrored: true)
        for uv in [SIMD2(0.1, 0.2), SIMD2(0.5, 0.5), SIMD2(0.9, 0.7)] {
            let back = m.toImage(m.toView(uv))
            XCTAssertEqual(back.x, uv.x, accuracy: 1e-12); XCTAssertEqual(back.y, uv.y, accuracy: 1e-12)
        }
        let centre = m.toView(SIMD2(0.5, 0.5))
        XCTAssertEqual(centre.x, 195, accuracy: 1e-9); XCTAssertEqual(centre.y, 422, accuracy: 1e-9)
        XCTAssertGreaterThan(m.toView(SIMD2(0.1, 0.5)).x, 195, "mirrored: image left is screen right")
    }

    func testMaskSize() {
        XCTAssertEqual(ScreenMapping.maskSize(imageWidth: 1080, imageHeight: 1920).width, 144)
        XCTAssertEqual(ScreenMapping.maskSize(imageWidth: 1080, imageHeight: 1920).height, 256)
    }
}

final class RenderAttributeTests: XCTestCase {
    func testOneAttributePerVertexAndParamsPerKind() throws {
        let r = try generate(StyleSpec(kind: .twoStrandTwists, width: 0.035, length: 0.12), includeLOD0: false)
        let a = RenderAttributes(result: r)
        XCTAssertEqual(a.uv0.count, r.lod1.vertexCount)
        XCTAssertEqual(a.uv1.count, r.lod1.vertexCount)
        XCTAssertEqual(a.indices.count, r.lod1.triangleCount * 3)
        XCTAssertTrue(a.uv1.allSatisfy { $0.x >= 0 && $0.x <= 1 && $0.y >= -1 && $0.y <= 1 })
        XCTAssertEqual(RenderAttributes.params(for: .locs).lobes, 0)
    }
}

final class LiveSessionTests: XCTestCase {
    func testStillHeadBuildsExactlyOnceAfterWarmup() throws {
        let face = try canonicalFace()
        let s = LiveSession(preset: .mediapipe)
        var builds = 0
        for f in 0..<200 { if s.observeFace(vertices: face, time: Double(f) / 60) != nil { builds += 1 } }
        XCTAssertEqual(builds, 1)
        XCTAssertGreaterThanOrEqual(s.filter.frames, HeadProxyFilter.warmupFrames)
    }

    func testNoBuildBeforeWarmupAndRebuildOnARealChange() throws {
        let face = try canonicalFace()
        let s = LiveSession(preset: .mediapipe)
        for f in 0..<(HeadProxyFilter.warmupFrames - 1) { XCTAssertNil(s.observeFace(vertices: face, time: Double(f) / 60)) }
        var t = 1.0
        while s.observeFace(vertices: face, time: t) == nil && t < 5 { t += 1 / 60 }
        XCTAssertLessThan(t, 5)
        // Jitter below the threshold: no rebuild.
        var rng = SplitMix64(seed: 7)
        var rebuilt = 0
        for _ in 0..<120 {
            t += 1 / 60
            let noisy = face.map { $0 + V3(rng.nextSigned(), rng.nextSigned(), rng.nextSigned()) * 0.0002 }
            if s.observeFace(vertices: noisy, time: t) != nil { rebuilt += 1 }
        }
        XCTAssertEqual(rebuilt, 0, "tracking jitter must not regenerate the style")
        // A bigger head (a different person): exactly one rebuild once it settles.
        let bigger = face.map { $0 * 1.08 }
        for _ in 0..<240 { t += 1 / 60; if s.observeFace(vertices: bigger, time: t) != nil { rebuilt += 1 } }
        XCTAssertEqual(rebuilt, 1)
    }

    func testCalibrationIsAppliedToTheNextBuild() throws {
        let face = try canonicalFace()
        let s = LiveSession(preset: .mediapipe)
        var t = 0.0
        while s.observeFace(vertices: face, time: t) == nil { t += 1 / 60 }
        s.applyCalibration(HairlineFit(hairlineFront: 1.05, earNotch: 0.2))
        var head: HeadProxy?
        while head == nil && t < 10 { t += 1 / 60; head = s.observeFace(vertices: face, time: t) }
        XCTAssertEqual(head?.hairlineFront, 1.05)
        XCTAssertEqual(head?.earNotch, 0.2)
    }

    func testInstallAdvanceSkinAndConflict() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        let r = try generate(StyleSpec(kind: .cornrows, width: 0.02, length: 0.12, cornrowRows: 8), head: head, includeLOD0: false)
        let s = LiveSession(preset: .mediapipe)
        s.install(r, pose: .identity)
        for f in 0..<30 { s.advance(pose: .euler(yaw: 0.01 * Double(f)), time: Double(f) / 60) }
        var p: [Float] = [], n: [Float] = []
        s.skin(positions: &p, normals: &n)
        XCTAssertEqual(p.count, r.lod1.vertexCount * 3)
        XCTAssertTrue(p.allSatisfy(\.isFinite))
        s.trackingLost()

        // Orthographic front camera onto a 128x128 mask covering ±0.25 m.
        let project: (V3) -> SIMD2<Double>? = { SIMD2(64 + $0.x * 256, 64 - $0.y * 256) }
        // Her hair: a big afro disc around the head, much larger than cornrows.
        var vals = [Float](repeating: 0, count: 128 * 128)
        for y in 0..<128 { for x in 0..<128 { let dx = Double(x) - 64, dy = Double(y) - 50; if dx * dx + dy * dy < 40 * 40 && dy < 5 { vals[y * 128 + x] = 0.95 } } }
        let hair = ProbabilityMap(width: 128, height: 128, values: vals)
        let face = try canonicalFace()
        let tris = (try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("canonical_face.json"))) as! [String: Any])["triangles"] as! [[Int]]
        let m = try XCTUnwrap(s.measureConflict(hair: hair, project: project, headVertices: face, headTriangles: tris.flatMap { $0.map(UInt32.init) }))
        XCTAssertGreaterThan(m.ratio, 0.12)
        XCTAssertTrue(s.conflictActive)
        XCTAssertEqual(s.lastStyleMask.count, 128 * 128)
        XCTAssertGreaterThan(s.lastStyleMask.filter { $0 }.count, 100)
    }
}

final class CalibrationSessionTests: XCTestCase {
    /// Front view of the head proxy with a known hairline; noise and partial views.
    func syntheticMaps(head: HeadProxy, truth: HeadProxy, size: Int = 160) -> (hair: ProbabilityMap, skin: ProbabilityMap, project: (V3) -> SIMD2<Double>?) {
        let scale = 3.0
        var h = [Float](repeating: 0, count: size * size), s = h
        for y in 0..<size { for x in 0..<size {
            let px = (Double(x) + 0.5) / Double(size), py = (Double(y) + 0.5) / Double(size)
            let X = (px - 0.5) / scale, Y = (0.5 - py) / scale
            let dx = (X - head.cx) / head.rx, dy = (Y - head.cy) / head.ry
            let r2 = dx * dx + dy * dy
            guard r2 < 1 else { continue }
            let p = V3(X, Y, head.cz + head.rz * (1 - r2).squareRoot())
            let tp = truth.thetaPhi(of: p)
            if truth.insideHairline(theta: tp.theta, phi: tp.phi) { h[y * size + x] = 0.95 } else { s[y * size + x] = 0.9 }
        } }
        let project: (V3) -> SIMD2<Double>? = { p in head.normal(at: p).z > 0.05 ? SIMD2(0.5 + p.x * scale, 0.5 - p.y * scale) : nil }
        return (ProbabilityMap(width: size, height: size, values: h), ProbabilityMap(width: size, height: size, values: s), project)
    }

    func testPoolsFramesAndRecoversTheHairline() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        var truth = head; truth.hairlineFront = 1.04
        let maps = syntheticMaps(head: head, truth: truth)
        let cal = CalibrationSession(targetFrames: 10)
        XCTAssertNil(cal.fit(head: head))
        for _ in 0..<10 { cal.add(head: head, project: maps.project, hair: maps.hair, skin: maps.skin) }
        XCTAssertTrue(cal.isComplete)
        XCTAssertEqual(cal.progress, 1)
        let fit = try XCTUnwrap(cal.fit(head: head))
        XCTAssertEqual(fit.hairlineFront, 1.04, accuracy: 0.03)
        cal.reset()
        XCTAssertEqual(cal.frames, 0)
    }

    func testNoFitWithoutEnoughHairline() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        let empty = ProbabilityMap(width: 8, height: 8, values: Array(repeating: 0, count: 64))
        let cal = CalibrationSession(targetFrames: 3)
        for _ in 0..<3 { cal.add(head: head, project: { _ in SIMD2(0.5, 0.5) }, hair: empty, skin: nil) }
        XCTAssertNil(cal.fit(head: head))
    }
}
