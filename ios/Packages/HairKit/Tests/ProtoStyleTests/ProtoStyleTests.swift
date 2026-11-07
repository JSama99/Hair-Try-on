import Foundation
import XCTest
@testable import ProtoStyle

/// Repository root, located from this file (Tests/ProtoStyleTests/ -> ../../../../..).
let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func golden(_ name: String) throws -> [String: Any] {
    let url = repoRoot.appendingPathComponent("reference/golden/\(name)")
    return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}

func spec(fromGolden g: [String: Any]) throws -> StyleSpec {
    let data = try JSONSerialization.data(withJSONObject: g["spec"]!)
    return try JSONDecoder().decode(StyleSpec.self, from: data)
}

final class RNGTests: XCTestCase {
    func testSplitMix64MatchesGoldenBitForBit() throws {
        let g = try golden("rng_splitmix64.json")
        var rng = SplitMix64(seed: UInt64(g["seed"] as! Int))
        for want in g["u64"] as! [String] { XCTAssertEqual(String(rng.nextU64()), want) }
        for (salt, want) in g["derive_seed"] as! [String: String] {
            XCTAssertEqual(String(deriveSeed(UInt64(g["seed"] as! Int), salt)), want, salt)
        }
    }

    func testUnitRange() {
        var rng = SplitMix64(seed: 42)
        for _ in 0..<10_000 {
            let u = rng.nextUnit()
            XCTAssert(u >= 0 && u < 1)
        }
    }
}

final class NumericsTests: XCTestCase {
    func testPythonRoundSumAndCeil() {
        XCTAssertEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999].map(pyRound), [0, 2, 2, 0, -2, 2])
        XCTAssertEqual(pySum([1e16, 1.0, -1e16]), 1.0)
        XCTAssertEqual(pySum([0.1, 0.2, 0.3]), 0.6)
        XCTAssertEqual(ceilCount(4.0 + 1e-15), 4)
        XCTAssertEqual(ceilCount(4.01), 5)
        XCTAssertEqual(ceilCount(0.0), 1)
        XCTAssertEqual(pyRoundDigits(0.1338514999, 6), 0.133851)
    }

    func testSHA256KnownVectors() {
        func h(_ s: String) -> String { var x = SHA256Hasher(); x.update(Array(s.utf8)); return SHA256Hasher.hex(x.finalize()) }
        XCTAssertEqual(h(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(h("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(h(String(repeating: "a", count: 1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
        var x = SHA256Hasher()   // streaming in odd chunks equals one shot
        for chunk in stride(from: 0, to: 1000, by: 37) { x.update(Array(String(repeating: "a", count: min(37, 1000 - chunk)).utf8)) }
        XCTAssertEqual(SHA256Hasher.hex(x.finalize()), h(String(repeating: "a", count: 1000)))
    }
}

final class ScalpTests: XCTestCase {
    func testScalpMatchesGolden() throws {
        let g = try golden("scalp.json")
        let head = try JSONDecoder().decode(HeadProxy.self, from: JSONSerialization.data(withJSONObject: g["head"]!))
        XCTAssertEqual(head, HeadProxy())
        for pair in g["hairline_theta"] as! [[Double]] {
            XCTAssertEqual(head.hairlineTheta(phi: pair[0]), pair[1], accuracy: 1e-9)
        }
        for s in g["points"] as! [[String: Any]] {
            let p = head.point(theta: s["theta"] as! Double, phi: s["phi"] as! Double)
            let n = head.normal(at: p)
            let gp = s["point"] as! [Double], gn = s["normal"] as! [Double]
            for i in 0..<3 {
                XCTAssertEqual(p[i], gp[i], accuracy: 1e-9)
                XCTAssertEqual(n[i], gn[i], accuracy: 1e-9)
            }
        }
    }

    func testFaceSlabPushesSidewaysAndIsContinuous() {
        let head = HeadProxy()
        let p = V3(0.01, head.fy - 0.10, head.fz + 0.02)
        let (q, hit) = head.projectOutsideFace(p, clearance: 0)
        XCTAssertTrue(hit)
        XCTAssertEqual(q.y, p.y); XCTAssertEqual(q.z, p.z); XCTAssertEqual(q.x, head.fx + head.frx)
        XCTAssertEqual(head.faceImplicit(q), 1.0, accuracy: 1e-12)
        let dy = HeadProxy.faceSlabTop * head.fry
        for x in [0.0, 0.03, 0.05] {
            for z in [1e-6, 0.02, 0.05, 0.09] {
                let above = head.faceImplicit(V3(head.fx + x, head.fy + dy + 1e-9, head.fz + z))
                let below = head.faceImplicit(V3(head.fx + x, head.fy + dy - 1e-9, head.fz + z))
                XCTAssertEqual(above, below, accuracy: 1e-6)
            }
        }
    }
}

final class GoldenStyleTests: XCTestCase {
    static let fixtures = ["box_braids", "knotless_braids", "two_strand_twists", "locs", "cornrows", "box_braids_long"]

    func testEveryFixtureMatchesTheOracle() throws {
        for name in Self.fixtures {
            let g = try golden("style_\(name).json")
            let s = try spec(fromGolden: g)
            let res = try generate(s)
            let stats = try JSONDecoder().decode(StyleStats.self, from: JSONSerialization.data(withJSONObject: g["stats"]!))
            XCTAssertEqual(res.stats, stats, name)
            let tol = g["tolerance_abs_m"] as! Double
            let roots = g["roots"] as! [[String: Any]]
            XCTAssertEqual(res.roots.count, roots.count, name)
            for (r, gr) in zip(res.roots, roots) {
                switch r {
                case .grid(let root):
                    XCTAssertEqual(root.theta, gr["theta"] as! Double, accuracy: 1e-9)
                    XCTAssertEqual(root.phi, gr["phi"] as! Double, accuracy: 1e-9)
                case .cornrow(let p):
                    let gp = gr["point"] as! [Double]
                    for i in 0..<3 { XCTAssertEqual(p[i], gp[i], accuracy: 1e-9) }
                }
            }
            let cl = stride(from: 0, to: res.strands[0].centerline.count, by: 5).map { res.strands[0].centerline[$0] }
            let gcl = g["strand0_centerline_every5"] as! [[Double]]
            XCTAssertEqual(cl.count, gcl.count, name)
            for (p, q) in zip(cl, gcl) { for i in 0..<3 { XCTAssertEqual(p[i], q[i], accuracy: tol, name) } }
            for (k, q) in (g["lod1_positions_head"] as! [[Double]]).enumerated() {
                for i in 0..<3 { XCTAssertEqual(res.lod1.positions[k][i], q[i], accuracy: tol, name) }
            }
            XCTAssertEqual(Array(res.lod1.triangles.prefix(144)).map(Int.init), (g["lod1_triangles_head"] as! [[Int]]).flatMap { $0 }, name)
            // On Linux (glibc libm, as CPython) the digest matches exactly; Darwin libm may differ by an ulp
            // at a quantisation edge (docs/ARCHITECTURE.md §9), so it is checked only here.
            #if os(Linux)
            XCTAssertEqual(digest(res), g["digest_sha256_q10um"] as! String, name)
            #endif
            let checks = validate(res, checkDeterminism: false)
            XCTAssertTrue(allPassed(checks), "\(name): \(checks.filter { !$0.passed }.map { "\($0.id) \($0.detail)" })")
        }
    }

    func testParallelBuildIsBitIdenticalToSerial() throws {
        let s = StyleSpec(kind: .knotlessBraids, width: 0.035, length: 0.12)
        let a = try generate(s, parallel: true), b = try generate(s, parallel: false)
        XCTAssertEqual(a.lod0, b.lod0)
        XCTAssertEqual(a.lod1, b.lod1)
        XCTAssertEqual(digest(a), digest(b))
    }

    func testDefaultStylesPassEveryCheck() throws {
        for kind in StyleKind.allCases {
            let res = try generate(StyleSpec(kind: kind))
            let checks = validate(res)
            XCTAssertTrue(allPassed(checks), "\(kind): \(checks.filter { !$0.passed }.map { "\($0.id) \($0.detail)" })")
        }
    }

    func testNoHairHangsInFrontOfTheFace() throws {
        let head = HeadProxy()
        for kind in [StyleKind.boxBraids, .knotlessBraids, .locs, .twoStrandTwists] {
            let res = try generate(StyleSpec(kind: kind, length: 0.30), includeLOD0: false)
            let bad = res.strands.flatMap(\.centerline).filter { p in
                p.y - head.fy < HeadProxy.faceSlabTop * head.fry && p.z - head.fz > 0 && abs(p.x - head.fx) < 0.8 * head.frx
            }
            XCTAssertEqual(bad.count, 0, "\(kind)")
        }
    }
}

final class ValidatorTests: XCTestCase {
    var base: StyleResult!
    override func setUpWithError() throws { base = try generate(StyleSpec(kind: .boxBraids, width: 0.035, length: 0.12)) }

    func failing(_ r: StyleResult) -> Set<String> { Set(validate(r, checkDeterminism: false).filter { !$0.passed }.map(\.id)) }

    func testCatchesNaN() { var r = base!; r.lod1.positions[3] = V3(.nan, 0, 0); XCTAssertTrue(failing(r).contains("V01")) }
    func testCatchesRootOffScalp() {
        var r = base!
        if case .grid(var root) = r.roots[0] { root.point = root.point * 1.1; r.roots[0] = .grid(root) }
        XCTAssertTrue(failing(r).contains("V02"))
    }
    func testCatchesDegenerateTriangle() { var r = base!; r.lod1.triangles[1] = r.lod1.triangles[0]; XCTAssertTrue(failing(r).contains("V06")) }
    func testCatchesPenetration() {
        var r = base!
        let n = r.strands[0].centerline.count
        r.strands[0].centerline[n - 1] = r.head.center
        XCTAssertTrue(failing(r).contains("V04"))
    }
    func testCatchesInvertedWinding() {
        var r = base!
        var t = 0
        while t < r.lod1.triangles.count { r.lod1.triangles.swapAt(t + 1, t + 2); t += 3 }
        XCTAssertTrue(failing(r).contains("V13"))
    }
    func testMicroBraidsExceedTheLiveBudgetByDesign() throws {
        let r = try generate(StyleSpec(kind: .boxBraids, width: 0.01, length: 0.2))
        XCTAssertEqual(failing(r), ["V07"])
    }
    func testSpecPolicy() {
        XCTAssertTrue(StyleSpec(kind: .locs, length: 0.40).validate().isEmpty)
        XCTAssertEqual(StyleSpec(kind: .locs, length: 0.55).validate().count, 1)
        XCTAssertTrue(StyleSpec(kind: .locs, length: 0.55, hasBodyProxy: true).validate().isEmpty)
        XCTAssertThrowsError(try generate(StyleSpec(kind: .locs, width: 0.002)))
    }
    func testLOD1BindingCoversEveryVertex() {
        XCTAssertEqual(base.lod1Binding.count, base.lod1.vertexCount)
        XCTAssertEqual(base.lod1.fracs.count, base.lod1.vertexCount)
    }
}
