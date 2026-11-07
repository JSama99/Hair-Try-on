// Numerics.swift — the exact Python semantics the determinism contract depends on.
// docs/ARCHITECTURE.md §9; mirrored in web/src/protostyle.js.

import Foundation

/// Python `round(x)`: round half to even, never -0.
@inlinable public func pyRound(_ x: Double) -> Int {
    let r = x.rounded(.toNearestOrEven)
    return r == 0 ? 0 : Int(r)
}

/// CPython ≥ 3.12 `sum()` over floats: Neumaier compensation, compensation added last.
public func pySum<S: Sequence>(_ values: S) -> Double where S.Element == Double {
    var f = 0.0
    var c = 0.0
    for x in values {
        let t = f + x
        if abs(f) >= abs(x) { c += (f - t) + x } else { c += (x - t) + f }
        f = t
    }
    if c != 0 && c.isFinite { f += c }
    return f
}

/// `ceil()` that ignores rounding noise at exact integers (oracle v0.2, `styles._ceil_count`).
@inlinable public func ceilCount(_ ratio: Double) -> Int {
    max(1, Int((ratio - 1e-9).rounded(.up)))
}

/// Python `round(x, digits)` for display-level stats (correctly rounded decimal).
public func pyRoundDigits(_ x: Double, _ digits: Int) -> Double {
    Double(String(format: "%.\(digits)f", x)) ?? x
}

/// Python `int(x)` for non-negative values: truncation toward zero.
@inlinable public func pyInt(_ x: Double) -> Int { Int(x.rounded(.towardZero)) }
