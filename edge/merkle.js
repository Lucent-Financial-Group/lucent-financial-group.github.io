// BROWSER COPY of src/Core.TypeScript/merkle/merkle.js — only change: "./xxh3" -> "./xxh3.js" (browser ESM needs the extension)
// Merkle integrity — TypeScript parity oracle (#4 of TS/F#/C#/Rust), pure (no dependency).
//
// Conforms byte-for-byte to the F# canonical shape (src/Core/Merkle.fs): each leaf is hashed
// with XXH3-128 (./xxh3.ts, pure-TS, no dep — per Aaron's "pure-TS XxHash128 (no dep)"
// decision) and internal nodes combine two child hashes by concatenating their little-endian
// Hi/Lo halves and re-hashing. A tree over the same leaves yields a BYTE-IDENTICAL root in
// F#, C#, Rust, and TS — verified by merkle.test.ts against vectors generated from F#.
import { xxh3_128 } from "./xxh3.js";
const MASK64 = 0xffffffffffffffffn;
const swap64 = (x) => {
    let r = 0n;
    for (let i = 0; i < 8; i++)
        r = (r << 8n) | ((x >> BigInt(8 * i)) & 0xffn);
    return r;
};
const hex16 = (x) => x.toString(16).padStart(16, "0");
export const ZERO = { hi: 0n, lo: 0n };
/** Hex representation (hi then lo, 16 hex digits each) — matches the other oracles' ToHex. */
export const toHex = (h) => hex16(h.hi) + hex16(h.lo);
/**
 * Hash a leaf into a MerkleHash. .NET's XxHash128 emits the XXH128 canonical big-endian form,
 * so F#'s Hi/Lo are the byte-swaps of xxh3_128's low/high halves (see Rust adapter).
 */
export function ofBytes(bytes) {
    const { low, high } = xxh3_128(bytes);
    return { hi: swap64(low), lo: swap64(high) };
}
const writeU64LE = (buf, off, x) => {
    for (let i = 0; i < 8; i++)
        buf[off + i] = Number((x >> BigInt(8 * i)) & 0xffn);
};
/** Combine two child hashes into a parent (the internal-node construction). */
export function combine(a, b) {
    const buf = new Uint8Array(32);
    writeU64LE(buf, 0, a.hi & MASK64);
    writeU64LE(buf, 8, a.lo & MASK64);
    writeU64LE(buf, 16, b.hi & MASK64);
    writeU64LE(buf, 24, b.lo & MASK64);
    return ofBytes(buf);
}
/**
 * Merkle tree over a sequence of leaf blobs, built bottom-up (duplicate-last-leaf for odd
 * fan-in). The root is byte-identical to F#/C#/Rust over the same leaves.
 */
export class MerkleTree {
    levels;
    constructor(leaves) {
        const level0 = leaves.map(ofBytes);
        const all = [level0];
        let cur = level0;
        while (cur.length > 1) {
            const parent = [];
            for (let i = 0; i < cur.length; i += 2) {
                const left = cur[i];
                const right = i + 1 < cur.length ? cur[i + 1] : left; // duplicate last for odd
                parent.push(combine(left, right));
            }
            all.push(parent);
            cur = parent;
        }
        this.levels = all;
    }
    /** Root digest — byte-identical to the F#/C#/Rust root over the same leaves. */
    root() {
        const top = this.levels[this.levels.length - 1];
        return top.length === 0 ? ZERO : top[0];
    }
    /** The leaf hashes (level 0), useful for diffing. */
    leafHashes() {
        return this.levels[0];
    }
    /**
     * Merkle inclusion proof for the leaf at `index`: the O(log N) sibling path
     * from that leaf up to (but excluding) the root. Byte-identical to F#'s
     * `Proof(index)` (src/Core/Merkle.fs): walks levels[0 .. n-2], at each level
     * `selfIsLeft = idx % 2 === 0`; the sibling is `idx + 1` when self is left
     * (or self itself for the odd trailing node — duplicate-last), else `idx - 1`;
     * pushes `{ sibling, right: selfIsLeft }`; then `idx = floor(idx / 2)`.
     * A single-leaf tree has one level, so the path is empty.
     */
    proof(index) {
        const steps = [];
        let idx = index;
        // Walk every level except the topmost (the root level).
        for (let level = 0; level < this.levels.length - 1; level++) {
            const nodes = this.levels[level];
            const selfIsLeft = idx % 2 === 0;
            const siblingIdx = selfIsLeft
                ? (idx + 1 < nodes.length ? idx + 1 : idx) // duplicate-last for odd trailing node
                : idx - 1;
            steps.push({ sibling: nodes[siblingIdx], right: selfIsLeft });
            idx = Math.floor(idx / 2);
        }
        return steps;
    }
}
/**
 * Verify a Merkle inclusion proof: re-fold `leaf` up through the sibling `steps`
 * and check the result equals `expectedRoot`. Byte-identical to F#'s
 * `verifyProof`: `acc = ofBytes(leaf)`; per step `acc = right ? combine(acc, sibling)
 * : combine(sibling, acc)`; returns `acc === expectedRoot`.
 */
export function verifyProof(leaf, steps, expectedRoot) {
    let acc = ofBytes(leaf);
    for (const step of steps) {
        acc = step.right ? combine(acc, step.sibling) : combine(step.sibling, acc);
    }
    return acc.hi === expectedRoot.hi && acc.lo === expectedRoot.lo;
}
