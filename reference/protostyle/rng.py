"""SplitMix64 — the only randomness source in protostyle.

Chosen because it is integer-only (exactly portable to Swift's UInt64 wrapping
arithmetic: &+, &*, >>) and has no platform-dependent state. Every stochastic
choice in the generator (section jitter, loc radius noise) draws from one of
these, seeded from the StyleSpec seed plus a stable per-purpose salt.

Port contract (ios/Packages/HairKit ProtoStyle, web/src/protostyle.js): the sequence of next_u64() values for
seed 0x5EED must equal golden/rng_splitmix64.json bit for bit.
"""

MASK64 = (1 << 64) - 1


class SplitMix64:
    __slots__ = ("state",)

    def __init__(self, seed: int):
        self.state = seed & MASK64

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def next_unit(self) -> float:
        """Uniform double in [0, 1) from the top 53 bits (exact in IEEE-754)."""
        return (self.next_u64() >> 11) * (1.0 / 9007199254740992.0)

    def next_signed(self) -> float:
        """Uniform double in [-1, 1)."""
        return self.next_unit() * 2.0 - 1.0


def derive_seed(seed: int, salt: str) -> int:
    """Stable child seed: FNV-1a 64 over the UTF-8 salt, mixed with the parent seed.

    Integer-only so Swift can reproduce it exactly.
    """
    h = 0xCBF29CE484222325
    for b in salt.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & MASK64
    return SplitMix64((seed ^ h) & MASK64).next_u64()
