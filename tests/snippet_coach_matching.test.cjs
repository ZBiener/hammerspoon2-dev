const assert = require("node:assert/strict")
const { buildPatterns, findMatch, tokenize } = require("../../system-config/hammerspoon2/Spoons/SnippetCoach.spoon2/lib/matching.js")

const snippet = {
  uid: "example",
  name: "Hope all's well",
  keyword: ";ihop",
  snippet: "Hope all's well",
}

assert.deepEqual(tokenize("Hope {cursor} all’s well!"), ["hope", "alls", "well"])

const patterns = buildPatterns([snippet])
assert.equal(findMatch(patterns, ["hope", "alls", "well"]), snippet)
assert.equal(findMatch(patterns, ["hope", "alls", "are", "well"]), snippet)
assert.equal(findMatch(patterns, ["hope", "allss", "well"]), snippet)
assert.equal(findMatch(patterns, ["hope", "alls"]), null)
assert.equal(
  buildPatterns([{ ...snippet, dontautoexpand: true }]).length,
  0,
)
