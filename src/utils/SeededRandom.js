/**
 * SeededRandom - Deterministic random number generator
 *
 * Uses the mulberry32 algorithm.
 * Given the same seed, produces the same sequence of random numbers every time.
 */

export class SeededRandom {
    constructor(seed = 12345) {
        this.seed = seed;
        this.state = seed;
    }

    /**
     * Reset the seed
     */
    reset(seed = this.seed) {
        this.seed = seed;
        this.state = seed;
    }

    /**
     * Generate a random number in the range 0-1 (mulberry32)
     */
    random() {
        let t = this.state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    /**
     * Generate a random number in the range min-max
     */
    range(min, max) {
        return min + this.random() * (max - min);
    }

    /**
     * Generate a random integer
     */
    int(min, max) {
        return Math.floor(this.range(min, max + 1));
    }

    /**
     * Pick one element at random from an array
     */
    pick(array) {
        return array[this.int(0, array.length - 1)];
    }

    /**
     * Return true with the given probability
     */
    chance(probability = 0.5) {
        return this.random() < probability;
    }

    /**
     * Random number following a Gaussian (normal) distribution
     */
    gaussian(mean = 0, stdDev = 1) {
        const u1 = this.random();
        const u2 = this.random();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return z0 * stdDev + mean;
    }
}

// Global instance (seed can be specified via URL parameter)
const urlParams = new URLSearchParams(window.location.search);
const globalSeed = parseInt(urlParams.get('seed')) || Date.now();

export const rng = new SeededRandom(globalSeed);

if (import.meta.env.DEV) console.log(`[SeededRandom] Initialized with seed: ${globalSeed}`);
