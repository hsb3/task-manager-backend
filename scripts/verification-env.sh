#!/bin/sh
# Source from the checkout root before running verification tools.

verification_root=$(pwd -P)
if [ ! -d "$verification_root/node_modules" ]; then
  echo "❌ Verification environment missing — run mise trust && make setup" >&2
  return 1
fi
for verification_tool in bun; do
  verification_pin=$(sed -n "s/^$verification_tool = \"\(.*\)\"/\1/p" mise.toml)
  verification_found=$($verification_tool --version 2>/dev/null)
  verification_found=${verification_found#v}
  if [ "$verification_found" != "$verification_pin" ] && command -v mise >/dev/null 2>&1; then
    verification_tool_dir=$(mise where "$verification_tool@$verification_pin") || return 1
    PATH="$verification_tool_dir/bin:$PATH"
    export PATH
    verification_found=$($verification_tool --version 2>/dev/null)
    verification_found=${verification_found#v}
  fi
  if [ "$verification_found" != "$verification_pin" ]; then
    echo "❌ Bun $verification_pin required — run mise trust && make setup" >&2
    return 1
  fi
done
# The prepared tree is root node_modules at package.json's devDependencies pins (bun install).
bun -e '
const pins = (await Bun.file("package.json").json()).devDependencies ?? {};
for (const [name, pin] of Object.entries(pins)) {
  const installed = await Bun.file(`node_modules/${name}/package.json`).json().catch(() => null);
  if (!installed || !Bun.semver.satisfies(installed.version, pin)) {
    console.error(`❌ ${name}@${pin} required — run mise trust && make setup`);
    process.exit(1);
  }
}
' || return 1
