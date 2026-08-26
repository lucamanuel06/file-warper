import sharp from 'sharp';

/**
 * Shared sharp configuration. Import this from every module that touches sharp.
 *
 * `cache(false)` is not an optimisation — it is a correctness fix on Windows.
 * libvips keeps decoded images AND their open file handles in an operation
 * cache, so a file sharp has read stays locked. The scheduler deletes every
 * intermediate between hops and discards the staging file on failure, and on
 * Windows those deletes fail with `EBUSY: resource busy or locked`. CI caught
 * exactly that: 12 sharp conversions failed on windows-latest with EBUSY and
 * `UNKNOWN: unknown error, open …` while all of them passed on macOS.
 *
 * The cache buys little here anyway: each conversion reads a different file
 * once, so there is nothing to reuse.
 */
sharp.cache(false);

/**
 * Bound libvips' own thread pool. It defaults to one thread per core, which on
 * a many-core machine competes with our own worker pool for no gain — the
 * scheduler already runs several conversions in parallel and caps sharp at 4.
 */
sharp.concurrency(1);

export { sharp };
