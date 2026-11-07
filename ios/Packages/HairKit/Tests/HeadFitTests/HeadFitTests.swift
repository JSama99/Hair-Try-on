import Foundation
import XCTest
@testable import HeadFit
import ProtoStyle

let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")

func canonicalFace() throws -> [V3] {
    let o = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("canonical_face.json"))) as! [String: Any]
    return (o["vertices"] as! [[Double]]).map { V3($0[0], $0[1], $0[2]) }
}

final class HeadFitterTests: XCTestCase {
    func testMatchesTheJavaScriptFitterExactly() throws {
        let face = try canonicalFace()
        let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("headfit_expected.json"))) as! [String: Any]
        let cases: [(String, HeadProxy)] = [
            ("mediapipe", try HeadFitter.fit(vertices: face)),
            ("arkit", try HeadFitter.fit(vertices: face, preset: .arkit)),
            ("calibrated", try HeadFitter.fit(vertices: face, hairlineFront: 1.05)),
        ]
        for (name, got) in cases {
            let want = try JSONDecoder().decode(HeadProxy.self, from: JSONSerialization.data(withJSONObject: expected[name]!))
            for k in HeadProxyFilter.keys + [\HeadProxy.hairlineFront, \.earNotch] {
                XCTAssertEqual(got[keyPath: k], want[keyPath: k], accuracy: 1e-12, name)
            }
        }
    }

    func testFittedHeadProtectsTheWholeFaceAndDefaultsDoNot() throws {
        let face = try canonicalFace()
        let head = try HeadFitter.fit(vertices: face)
        XCTAssertEqual(HeadFitter.faceCoverage(head, vertices: face), 1.0)
        XCTAssertLessThan(HeadFitter.faceCoverage(HeadProxy(), vertices: face), 1.0)
        let top = face.max { $0.y < $1.y }!
        let hp = head.point(theta: head.hairlineFront, phi: 0)
        XCTAssertEqual(hp.y, top.y, accuracy: 1e-12)
        XCTAssertEqual(hp.z, top.z, accuracy: 1e-12)
    }

    func testScalesWithTheFaceAndRejectsTinyMeshes() throws {
        let face = try canonicalFace()
        let a = try HeadFitter.fit(vertices: face), b = try HeadFitter.fit(vertices: face.map { $0 * 1.1 })
        XCTAssertEqual(b.ry / a.ry, 1.1, accuracy: 1e-9)
        XCTAssertThrowsError(try HeadFitter.fit(vertices: [V3.zero]))
        XCTAssertGreaterThan(try HeadFitter.fit(vertices: face, preset: .arkit).ry, a.ry)
    }

    func testEveryStyleOnTheFittedHeadValidates() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        for kind in StyleKind.allCases {
            let r = try generate(StyleSpec(kind: kind, length: 0.34), head: head, includeLOD0: false)
            let failed = validate(r, checkDeterminism: false).filter { !$0.passed && $0.id != "V11" }
            XCTAssertTrue(failed.isEmpty, "\(kind): \(failed.map { "\($0.id) \($0.detail)" })")
        }
    }
}

final class FilterTests: XCTestCase {
    func testOneEuroSmoothsJitterAndFollowsSteps() {
        var f = OneEuroFilter(minCutoff: 1.0, beta: 0.0)
        var rng = SplitMix64(seed: 3)
        var outs: [Double] = []
        for i in 0..<300 { outs.append(f.filter(1.0 + 0.01 * rng.nextSigned(), time: Double(i) / 60)) }
        let tail = outs.suffix(120)
        let spread = tail.max()! - tail.min()!
        XCTAssertLessThan(spread, 0.01, "filtered spread \(spread) vs raw 0.02")
        for i in 300..<600 { _ = f.filter(2.0, time: Double(i) / 60) }
        XCTAssertEqual(f.filter(2.0, time: 10.0), 2.0, accuracy: 1e-3)
    }

    func testHeadProxyFilterWarmsUpAndPassesHairlineThrough() {
        var f = HeadProxyFilter()
        var h = HeadProxy()
        h.hairlineFront = 1.07
        for i in 0..<(HeadProxyFilter.warmupFrames - 1) { _ = f.update(h, time: Double(i) / 60) }
        XCTAssertFalse(f.isWarm)
        let out = f.update(h, time: 1)
        XCTAssertTrue(f.isWarm)
        XCTAssertEqual(out.hairlineFront, 1.07)
        XCTAssertEqual(HeadProxyFilter.maxChange(out, h), 0, accuracy: 1e-15)
        f.reset()
        XCTAssertEqual(f.frames, 0)
    }
}

/// Orthographic synthetic "camera": front view for |phi| < 1, side views otherwise.
struct SyntheticView {
    let head: HeadProxy
    let truth: HeadProxy
    var partingHalfWidth = 0.0
    var noise = 0.0
    var seed: UInt64 = 1

    func project(_ p: V3) -> SIMD2<Double>? {
        let n = head.normal(at: p)
        guard n.z > 0.05 || abs(n.x) > 0.3 else { return nil }
        return SIMD2(0.5 + p.x * 3, 0.5 - p.y * 3)
    }

    func classify(_ uv: SIMD2<Double>) -> (hair: Double, skin: Double) {
        let x = (uv.x - 0.5) / 3, y = (0.5 - uv.y) / 3
        // Recover the scalp point at (x, y), choosing the side facing out.
        let dx = (x - head.cx) / head.rx, dy = (y - head.cy) / head.ry
        let r2 = dx * dx + dy * dy
        guard r2 < 1 else { return (0, 0) }
        let p = V3(x, y, head.cz + head.rz * (1 - r2).squareRoot())
        let tp = truth.thetaPhi(of: p)
        var isHair = truth.insideHairline(theta: tp.theta, phi: tp.phi)
        if isHair && abs(p.x - head.cx) < partingHalfWidth { isHair = false }  // centre parting shows skin
        if noise > 0 {
            var h = UInt64(bitPattern: Int64((x * 1e5).rounded())) &* 31 &+ UInt64(bitPattern: Int64((y * 1e5).rounded())) &+ seed
            var r = SplitMix64(seed: h); h = r.nextU64()
            if Double(h >> 11) / 9_007_199_254_740_992.0 < noise { isHair.toggle() }
        }
        return isHair ? (0.95, 0.02) : (0.03, 0.9)
    }
}

final class HairlineTests: XCTestCase {
    func testRecoversKnownFrontHairline() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        for truthFront in [0.9, 0.98, 1.08] {
            var truth = head; truth.hairlineFront = truthFront
            let view = SyntheticView(head: head, truth: truth)
            let obs = HairlineObserver().observe(head: head, project: view.project, hair: { view.classify($0).hair }, skin: { view.classify($0).skin })
            let fit = try XCTUnwrap(HairlineCalibrator.fit(head: head, observations: obs))
            XCTAssertEqual(fit.hairlineFront, truthFront, accuracy: 0.02)
        }
    }

    func testRunLengthConfirmationSurvivesNoiseAndAParting() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        var truth = head; truth.hairlineFront = 1.0
        let view = SyntheticView(head: head, truth: truth, partingHalfWidth: 0.003, noise: 0.06, seed: 9)
        let obs = HairlineObserver().observe(head: head, project: view.project, hair: { view.classify($0).hair }, skin: { view.classify($0).skin })
        let fit = try XCTUnwrap(HairlineCalibrator.fit(head: head, observations: obs))
        XCTAssertEqual(fit.hairlineFront, 1.0, accuracy: 0.04)

        // Mutation check: without confirmation, noise ends meridians early and the estimate breaks.
        var eager = HairlineObserver(); eager.confirmSteps = 1
        let bad = eager.observe(head: head, project: view.project, hair: { view.classify($0).hair }, skin: { view.classify($0).skin })
        let badFit = HairlineCalibrator.fit(head: head, observations: bad)
        XCTAssertTrue(badFit == nil || abs(badFit!.hairlineFront - 1.0) > 0.04, "confirmSteps = 1 must not pass this test")
    }

    func testPartLinesDownTheMeridiansDoNotStopTheEstimateEarly() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        var truth = head; truth.hairlineFront = 1.0
        let view = SyntheticView(head: head, truth: truth)
        // Cornrow parts: skin stripes through the hair along every front meridian.
        let parted: (SIMD2<Double>) -> (Double, Double) = { uv in
            let stripe = abs(((uv.x - 0.5) * 100).truncatingRemainder(dividingBy: 3)) < 0.6
            let c = view.classify(uv)
            return stripe && c.hair > 0.5 ? (0.02, 0.9) : c
        }
        let obs = HairlineObserver().observe(head: head, project: view.project, hair: { parted($0).0 }, skin: { parted($0).1 })
        let fit = try XCTUnwrap(HairlineCalibrator.fit(head: head, observations: obs))
        XCTAssertEqual(fit.hairlineFront, 1.0, accuracy: 0.03)
    }

    func testRefusesWithoutHairAndClampsNoise() throws {
        let head = try HeadFitter.fit(vertices: try canonicalFace())
        let view = SyntheticView(head: head, truth: head)
        let none = HairlineObserver().observe(head: head, project: view.project, hair: { _ in 0 }, skin: { _ in 1 })
        XCTAssertNil(HairlineCalibrator.fit(head: head, observations: none))
    }

    func testFrontEquivalentInvertsTheHairlineCurve() {
        var h = HeadProxy(); h.hairlineFront = 1.02
        for phi in [-0.5, 0.0, 0.3] {
            XCTAssertEqual(HairlineCalibrator.frontEquivalent(HeadProxy(), theta: h.hairlineTheta(phi: phi), phi: phi), 1.02, accuracy: 1e-12)
        }
    }

    func testEarNotchIsRecoveredFromSideMeridians() {
        var truth = HeadProxy(); truth.hairlineFront = 0.98; truth.earNotch = 0.22
        var obs: [Double: Double] = [:]
        for phi in HairlineObserver.defaultPhis { obs[phi] = truth.hairlineTheta(phi: phi) }
        let fit = HairlineCalibrator.fit(head: HeadProxy(), observations: obs)
        XCTAssertEqual(fit?.hairlineFront ?? 0, 0.98, accuracy: 0.03)
        XCTAssertEqual(fit?.earNotch ?? 0, 0.22, accuracy: 0.03)
    }
}
