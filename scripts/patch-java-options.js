/**
 * Patches helios-core's DistributionFactory to fix a bug where
 * effectiveJavaOptions ignores the server's declared supported/suggestedMajor
 * values and falls back to defaults (Java 17 instead of 21).
 *
 * The bug is in defaultUndefinedJavaOptions():
 *   supported: props.distribution ?? ...   (should be props.supported)
 *   suggestedMajor: ...                     (same operator precedence issue)
 *
 * Run via: npm run postinstall
 */
const fs = require('fs')
const path = require('path')

const factoryPath = path.join(__dirname, '..', 'node_modules', 'helios-core', 'dist', 'common', 'distribution', 'DistributionFactory.js')

if (!fs.existsSync(factoryPath)) {
    console.log('[patch-java] DistributionFactory.js not found, skipping patch.')
    process.exit(0)
}

let content = fs.readFileSync(factoryPath, 'utf8')

const marker = 'MIDGARD_JAVA_PATCH'
if (content.includes(marker)) {
    console.log('[patch-java] DistributionFactory.js already patched.')
    process.exit(0)
}

// Fix 1: "supported" uses props.distribution instead of props.supported
const buggySupported = "props.distribution ?? (0, MojangUtils_1.mcVersionAtLeast)('1.17', this.rawServer.minecraftVersion) ? '>=17.x' : '8.x'"
const fixedSupported = "props.supported ?? ((0, MojangUtils_1.mcVersionAtLeast)('1.17', this.rawServer.minecraftVersion) ? '>=17.x' : '8.x') /* MIDGARD_JAVA_PATCH */"

if (!content.includes(buggySupported)) {
    console.log('[patch-java] Could not find buggy supported line, skipping.')
    process.exit(0)
}

content = content.replace(buggySupported, fixedSupported)

// Fix 2: suggestedMajor has same operator precedence issue
const buggySuggested = "props.suggestedMajor ?? (0, MojangUtils_1.mcVersionAtLeast)('1.17', this.rawServer.minecraftVersion) ? 17 : 8"
const fixedSuggested = "props.suggestedMajor ?? ((0, MojangUtils_1.mcVersionAtLeast)('1.17', this.rawServer.minecraftVersion) ? 17 : 8)"

if (content.includes(buggySuggested)) {
    content = content.replace(buggySuggested, fixedSuggested)
    console.log('[patch-java] Fixed suggestedMajor fallback too.')
}

fs.writeFileSync(factoryPath, content, 'utf8')
console.log('[patch-java] DistributionFactory.js patched successfully.')
