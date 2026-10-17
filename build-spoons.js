const fs = require("node:fs")
const path = require("node:path")

const root = __dirname
const sources = path.join(root, "spoons")
const output = path.join(root, "..", "system-config", "hammerspoon2", "Spoons")

for (const name of fs.readdirSync(sources)) {
  const source = path.join(sources, name)
  if (!fs.statSync(source).isDirectory()) continue

  const bundle = path.join(output, `${name}.spoon2`)
  fs.mkdirSync(bundle, { recursive: true })
  fs.copyFileSync(path.join(source, "spoon.json"), path.join(bundle, "spoon.json"))
  fs.copyFileSync(path.join(source, "init.js"), path.join(bundle, "init.js"))
}
