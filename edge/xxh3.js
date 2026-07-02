// XXH3-128 — pure TypeScript port (no dependency), byte-identical to .NET's
// System.IO.Hashing.XxHash128 / the `xxhash-rust` 0.8.10 reference. Faithful port of the
// xxhash-rust const implementation (src/const_xxh3.rs + xxh3_common.rs) for seed = 0 — all
// length classes (0, 1-3, 4-8, 9-16, 17-128, 129-240, 241+) including the long accumulate/
// scramble/merge path. BigInt for all 64-bit math (wrapping via & MASK64). Verified
// byte-for-byte against golden vectors generated from the F# Merkle (merkle.test.ts).
//
// Returns the XXH3 canonical halves { low, high } (= XXH3 low64 | high64<<64); the Merkle
// layer maps these to its Hi/Lo convention (merkle.ts).
const MASK64 = 0xffffffffffffffffn;
const MASK32 = 0xffffffffn;
const P32_1 = 0x9e3779b1n;
const P32_2 = 0x85ebca77n;
const P32_3 = 0xc2b2ae3dn;
const P64_1 = 0x9e3779b185ebca87n;
const P64_2 = 0xc2b2ae3d27d4eb4fn;
const P64_3 = 0x165667b19e3779f9n;
const P64_4 = 0x85ebca77c2b2ae63n;
const P64_5 = 0x27d4eb2f165667c5n;
// The 192-byte default secret (xxh3_common.rs DEFAULT_SECRET).
const SECRET = new Uint8Array([
    0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c,
    0xde, 0xd4, 0x6d, 0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f,
    0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0, 0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21,
    0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0, 0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c,
    0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b, 0x1b, 0x53, 0x2e, 0xa3,
    0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac, 0xd8,
    0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d,
    0x8a, 0x51, 0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64,
    0xea, 0xc5, 0xac, 0x83, 0x34, 0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb,
    0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49, 0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e,
    0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8, 0xd1, 0x7a, 0xd0, 0x31, 0xce,
    0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b, 0x40, 0x7e,
]);
const STRIPE_LEN = 64;
const ACC_NB = 8;
const SECRET_CONSUME_RATE = 8;
const SECRET_MERGEACCS_START = 11;
const SECRET_LASTACC_START = 7;
const SECRET_SIZE_MIN = 136;
// ── primitive wrapping ops over BigInt ──
const add64 = (a, b) => (a + b) & MASK64;
const sub64 = (a, b) => (a - b) & MASK64;
const mul64 = (a, b) => (a * b) & MASK64;
const neg64 = (x) => (-x) & MASK64;
const not64 = (x) => x ^ MASK64;
const xorshift64 = (v, s) => v ^ (v >> s);
const rotl32 = (x, r) => ((x << r) | (x >> (32n - r))) & MASK32;
const swap64 = (x) => {
    let r = 0n;
    for (let i = 0; i < 8; i++)
        r = (r << 8n) | ((x >> BigInt(8 * i)) & 0xffn);
    return r;
};
const swap32 = (x) => {
    let r = 0n;
    for (let i = 0; i < 4; i++)
        r = (r << 8n) | ((x >> BigInt(8 * i)) & 0xffn);
    return r & MASK32;
};
const readU64 = (b, off) => {
    let r = 0n;
    for (let i = 0; i < 8; i++)
        r |= BigInt(b[off + i]) << BigInt(8 * i);
    return r;
};
const readU32 = (b, off) => {
    let r = 0n;
    for (let i = 0; i < 4; i++)
        r |= BigInt(b[off + i]) << BigInt(8 * i);
    return r;
};
const mult32to64 = (a, b) => ((a & MASK32) * (b & MASK32)) & MASK64;
// [lo64, hi64] of the full 128-bit product
const mul64to128 = (a, b) => {
    const p = a * b;
    return [p & MASK64, (p >> 64n) & MASK64];
};
const mul128fold64 = (a, b) => {
    const [lo, hi] = mul64to128(a, b);
    return lo ^ hi;
};
const avalanche = (v) => {
    v = xorshift64(v, 37n);
    v = mul64(v, 0x165667919e3779f9n);
    return xorshift64(v, 32n);
};
const xxh64Avalanche = (v) => {
    v = v ^ (v >> 33n);
    v = mul64(v, P64_2);
    v = v ^ (v >> 29n);
    v = mul64(v, P64_3);
    v = v ^ (v >> 32n);
    return v;
};
// seed is always 0n for our use; kept as a parameter to mirror the reference exactly.
const SEED = 0n;
const mix16b = (input, ioff, secret, soff, seed) => {
    let lo = readU64(input, ioff);
    let hi = readU64(input, ioff + 8);
    lo ^= add64(readU64(secret, soff), seed);
    hi ^= sub64(readU64(secret, soff + 8), seed);
    return mul128fold64(lo, hi);
};
const mix32b = (acc, in1, off1, in2, off2, secret, soff, seed) => {
    let [a0, a1] = acc;
    a0 = add64(a0, mix16b(in1, off1, secret, soff, seed));
    a0 ^= add64(readU64(in2, off2), readU64(in2, off2 + 8));
    a1 = add64(a1, mix16b(in2, off2, secret, soff + 16, seed));
    a1 ^= add64(readU64(in1, off1), readU64(in1, off1 + 8));
    return [a0, a1];
};
const h128_1to3 = (input, secret) => {
    const len = input.length;
    const c1 = BigInt(input[0]);
    const c2 = BigInt(input[len >> 1]);
    const c3 = BigInt(input[len - 1]);
    const inputLo = ((c1 << 16n) | (c2 << 24n) | c3 | (BigInt(len) << 8n)) & MASK32;
    const inputHi = rotl32(swap32(inputLo), 13n);
    const flipLo = add64((readU32(secret, 0) ^ readU32(secret, 4)), SEED);
    const flipHi = sub64((readU32(secret, 8) ^ readU32(secret, 12)), SEED);
    const keyedLo = inputLo ^ flipLo;
    const keyedHi = inputHi ^ flipHi;
    return [xxh64Avalanche(keyedLo), xxh64Avalanche(keyedHi)];
};
const h128_4to8 = (input, secret) => {
    const len = input.length;
    const lo32 = readU32(input, 0);
    const hi32 = readU32(input, len - 4);
    const input64 = add64(lo32, hi32 << 32n);
    const flip = add64((readU64(secret, 16) ^ readU64(secret, 24)), SEED);
    const keyed = input64 ^ flip;
    let [lo, hi] = mul64to128(keyed, add64(P64_1, BigInt(len) << 2n));
    hi = add64(hi, (lo << 1n) & MASK64);
    lo ^= hi >> 3n;
    lo = mul64(xorshift64(lo, 35n), 0x9fb21c651e98df25n);
    lo = xorshift64(lo, 28n);
    hi = avalanche(hi);
    return [lo, hi];
};
const h128_9to16 = (input, secret) => {
    const len = input.length;
    const flipLo = sub64((readU64(secret, 32) ^ readU64(secret, 40)), SEED);
    const flipHi = add64((readU64(secret, 48) ^ readU64(secret, 56)), SEED);
    const inputLo = readU64(input, 0);
    let inputHi = readU64(input, len - 8);
    let [mulLow, mulHigh] = mul64to128(inputLo ^ inputHi ^ flipLo, P64_1);
    mulLow = add64(mulLow, (BigInt(len - 1) << 54n) & MASK64);
    inputHi ^= flipHi;
    // 64-bit target branch
    mulHigh = add64(mulHigh, add64(inputHi, mult32to64(inputHi & MASK32, P32_2 - 1n)));
    mulLow ^= swap64(mulHigh);
    let [resultLow, resultHi] = mul64to128(mulLow, P64_2);
    resultHi = add64(resultHi, mul64(mulHigh, P64_2));
    return [avalanche(resultLow), avalanche(resultHi)];
};
const h128_0to16 = (input, secret) => {
    const len = input.length;
    if (len > 8)
        return h128_9to16(input, secret);
    if (len >= 4)
        return h128_4to8(input, secret);
    if (len > 0)
        return h128_1to3(input, secret);
    const flipLo = readU64(secret, 64) ^ readU64(secret, 72);
    const flipHi = readU64(secret, 80) ^ readU64(secret, 88);
    return [xxh64Avalanche(SEED ^ flipLo), xxh64Avalanche(SEED ^ flipHi)];
};
const h128_7to128 = (input, secret) => {
    const len = input.length;
    let acc = [mul64(BigInt(len), P64_1), 0n];
    if (len > 32) {
        if (len > 64) {
            if (len > 96)
                acc = mix32b(acc, input, 48, input, len - 64, secret, 96, SEED);
            acc = mix32b(acc, input, 32, input, len - 48, secret, 64, SEED);
        }
        acc = mix32b(acc, input, 16, input, len - 32, secret, 32, SEED);
    }
    acc = mix32b(acc, input, 0, input, len - 16, secret, 0, SEED);
    const resultLo = add64(acc[0], acc[1]);
    const resultHi = add64(add64(mul64(acc[0], P64_1), mul64(acc[1], P64_4)), mul64(sub64(BigInt(len), SEED), P64_2));
    return [avalanche(resultLo), neg64(avalanche(resultHi))];
};
const h128_129to240 = (input, secret) => {
    const len = input.length;
    const START_OFFSET = 3;
    const LAST_OFFSET = 17;
    const nbRounds = Math.floor(len / 32);
    let acc = [mul64(BigInt(len), P64_1), 0n];
    let idx = 0;
    for (; idx < 4; idx++)
        acc = mix32b(acc, input, 32 * idx, input, 32 * idx + 16, secret, 32 * idx, SEED);
    acc = [avalanche(acc[0]), avalanche(acc[1])];
    for (; idx < nbRounds; idx++) {
        acc = mix32b(acc, input, 32 * idx, input, 32 * idx + 16, secret, START_OFFSET + 32 * (idx - 4), SEED);
    }
    acc = mix32b(acc, input, len - 16, input, len - 32, secret, SECRET_SIZE_MIN - LAST_OFFSET - 16, neg64(SEED));
    const resultLo = add64(acc[0], acc[1]);
    const resultHi = add64(add64(mul64(acc[0], P64_1), mul64(acc[1], P64_4)), mul64(sub64(BigInt(len), SEED), P64_2));
    return [avalanche(resultLo), neg64(avalanche(resultHi))];
};
// ── long path (>240) ──
const INITIAL_ACC = () => [P32_3, P64_1, P64_2, P64_3, P64_4, P32_2, P64_5, P32_1];
const accumulate512 = (acc, input, ioff, secret, soff) => {
    for (let i = 0; i < ACC_NB; i++) {
        const dataVal = readU64(input, ioff + 8 * i);
        const dataKey = dataVal ^ readU64(secret, soff + 8 * i);
        const adjacent = acc[i ^ 1];
        const current = acc[i];
        if (adjacent === undefined || current === undefined)
            throw new Error("accumulator out of bounds");
        const dataKeyLo = dataKey & MASK32;
        const dataKeyHi = dataKey >> 32n;
        acc[i ^ 1] = add64(adjacent, dataVal);
        acc[i] = add64(current, mult32to64(dataKeyLo, dataKeyHi));
    }
};
const scrambleAcc = (acc, secret, soff) => {
    for (let i = 0; i < ACC_NB; i++) {
        const key = readU64(secret, soff + 8 * i);
        let v = xorshift64(acc[i], 47n);
        v ^= key;
        acc[i] = mul64(v, P32_1);
    }
};
const accumulateLoop = (acc, input, ioff, secret, soff, nbStripes) => {
    for (let i = 0; i < nbStripes; i++) {
        accumulate512(acc, input, ioff + i * STRIPE_LEN, secret, soff + i * SECRET_CONSUME_RATE);
    }
};
const mixTwoAccs = (acc, aoff, secret, soff) => mul128fold64(acc[aoff] ^ readU64(secret, soff), acc[aoff + 1] ^ readU64(secret, soff + 8));
const mergeAccs = (acc, secret, soff, start) => {
    let result = start;
    for (let i = 0; i < 4; i++)
        result = add64(result, mixTwoAccs(acc, i * 2, secret, soff + i * 16));
    return avalanche(result);
};
const hashLongInternalLoop = (input, secret) => {
    const acc = INITIAL_ACC();
    const len = input.length;
    const nbStripes = Math.floor((secret.length - STRIPE_LEN) / SECRET_CONSUME_RATE);
    const blockLen = STRIPE_LEN * nbStripes;
    const nbBlocks = Math.floor((len - 1) / blockLen);
    for (let i = 0; i < nbBlocks; i++) {
        accumulateLoop(acc, input, i * blockLen, secret, 0, nbStripes);
        scrambleAcc(acc, secret, secret.length - STRIPE_LEN);
    }
    const nbStripes2 = Math.floor((len - 1 - blockLen * nbBlocks) / STRIPE_LEN);
    accumulateLoop(acc, input, nbBlocks * blockLen, secret, 0, nbStripes2);
    accumulate512(acc, input, len - STRIPE_LEN, secret, secret.length - STRIPE_LEN - SECRET_LASTACC_START);
    return acc;
};
const h128_long = (input, secret) => {
    const acc = hashLongInternalLoop(input, secret);
    const len = BigInt(input.length);
    const lo = mergeAccs(acc, secret, SECRET_MERGEACCS_START, mul64(len, P64_1));
    const hi = mergeAccs(acc, secret, secret.length - ACC_NB * 8 - SECRET_MERGEACCS_START, not64(mul64(len, P64_2)));
    return [lo, hi];
};
/** XXH3-128 of `input` with seed 0. Returns the canonical { low, high } 64-bit halves. */
export function xxh3_128(input) {
    const len = input.length;
    let lo;
    let hi;
    if (len <= 16)
        [lo, hi] = h128_0to16(input, SECRET);
    else if (len <= 128)
        [lo, hi] = h128_7to128(input, SECRET);
    else if (len <= 240)
        [lo, hi] = h128_129to240(input, SECRET);
    else
        [lo, hi] = h128_long(input, SECRET); // seed 0 → custom secret == DEFAULT_SECRET
    return { low: lo, high: hi };
}
