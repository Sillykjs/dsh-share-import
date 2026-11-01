/**
 * The one error type crossing a source reader's boundary.
 *
 * It lives in its own module because two readers (DeepSeek and Doubao) throw it
 * and `share.js` reads it: keeping it in either one would make the two modules
 * import each other. `share.js` re-exports it, so importers still see a single
 * public surface.
 *
 * @module dsh-share-import/errors
 */

/** A failure with a stable `code` the browser half can localize. */
export class ShareError extends Error {
  /**
   * @param {string} code - stable code, upper case.
   * @param {string} message - diagnostic message (may be shown).
   */
  constructor(code, message) {
    super(message)
    this.name = 'ShareError'
    this.code = code
  }
}
