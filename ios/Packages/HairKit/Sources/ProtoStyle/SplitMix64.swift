// SplitMix64.swift — the only randomness source (reference/protostyle/rng.py).
// Integer-exact: must match reference/golden/rng_splitmix64.json bit for bit.

public struct SplitMix64: Sendable {
    public private(set) var state: UInt64

    public init(seed: UInt64) { state = seed }

    public mutating func nextU64() -> UInt64 {
        state = state &+ 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Uniform double in [0, 1) from the top 53 bits.
    public mutating func nextUnit() -> Double { Double(nextU64() >> 11) * (1.0 / 9_007_199_254_740_992.0) }

    /// Uniform double in [-1, 1).
    public mutating func nextSigned() -> Double { nextUnit() * 2.0 - 1.0 }
}

/// Stable child seed: FNV-1a 64 over the UTF-8 salt, mixed with the parent seed.
public func deriveSeed(_ seed: UInt64, _ salt: String) -> UInt64 {
    var h: UInt64 = 0xCBF2_9CE4_8422_2325
    for b in salt.utf8 {
        h ^= UInt64(b)
        h = h &* 0x0000_0100_0000_01B3
    }
    var r = SplitMix64(seed: seed ^ h)
    return r.nextU64()
}
