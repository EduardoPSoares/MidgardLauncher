const fs        = require('fs-extra')
const path      = require('path')
const { ipcRenderer, shell } = require('electron')
const { SHELL_OPCODE } = require('./ipcconstants')

const { LoggerUtil } = require('helios-core')
const logger = LoggerUtil.getLogger('DropinModUtil')

// Group #1: File Name (without .disabled, if any)
// Group #2: File Extension (jar, zip, or litemod)
// Group #3: If it is disabled (if string 'disabled' is present)
const MOD_REGEX = /^(.+(jar|zip|litemod))(?:\.(disabled))?$/
const DISABLED_EXT = '.disabled'

const SHADER_REGEX = /^(.+)\.zip$/
const SHADER_OPTION = /shaderPack=(.+)/
const SHADER_DIR = 'shaderpacks'
const SHADER_CONFIG = 'optionsshaders.txt'

/**
 * Convert a glob-like pattern (with * wildcards) into a RegExp.
 * Only supports * as wildcard (matches any characters).
 * 
 * @param {string} pattern The glob pattern (e.g. "*xray*").
 * @returns {RegExp} A case-insensitive RegExp.
 */
function globToRegex(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    const regexStr = escaped.replace(/\*/g, '.*')
    return new RegExp(`^${regexStr}$`, 'i')
}

/**
 * Check if a mod file name matches any of the blocked mod patterns.
 * 
 * @param {string} modFileName The file name of the mod (without path).
 * @param {string[]} blockedPatterns An array of glob patterns for blocked mods.
 * @returns {boolean} True if the mod is blocked.
 */
exports.isModBlocked = function(modFileName, blockedPatterns) {
    if(!blockedPatterns || blockedPatterns.length === 0) {
        return false
    }
    const baseName = modFileName.replace(DISABLED_EXT, '').toLowerCase()
    for(const pattern of blockedPatterns) {
        if(globToRegex(pattern).test(baseName)) {
            return true
        }
    }
    return false
}

/**
 * Remove all blocked drop-in mods from the mods directory.
 * This should be called before game launch to enforce the block list.
 * 
 * @param {string} modsDir The path to the mods directory.
 * @param {string} version The minecraft version.
 * @param {string[]} blockedPatterns An array of glob patterns for blocked mods.
 * @returns {string[]} An array of file names that were removed.
 */
exports.enforceBlockedMods = function(modsDir, version, blockedPatterns) {
    if(!blockedPatterns || blockedPatterns.length === 0) {
        return []
    }
    const removed = []
    if(!fs.existsSync(modsDir)) {
        return removed
    }

    const dirs = [modsDir]
    const versionDir = path.join(modsDir, version)
    if(fs.existsSync(versionDir)) {
        dirs.push(versionDir)
    }

    for(const dir of dirs) {
        const files = fs.readdirSync(dir)
        for(const file of files) {
            const fullPath = path.join(dir, file)
            if(fs.statSync(fullPath).isFile() && MOD_REGEX.test(file)) {
                if(exports.isModBlocked(file, blockedPatterns)) {
                    try {
                        fs.removeSync(fullPath)
                        removed.push(file)
                        logger.info(`Blocked mod removed: ${file}`)
                    } catch(err) {
                        logger.warn(`Failed to remove blocked mod ${file}:`, err)
                    }
                }
            }
        }
    }
    return removed
}

/**
 * Validate that the given directory exists. If not, it is
 * created.
 * 
 * @param {string} modsDir The path to the mods directory.
 */
exports.validateDir = function(dir) {
    fs.ensureDirSync(dir)
}

/**
 * Scan for drop-in mods in both the mods folder and version
 * safe mods folder.
 * 
 * @param {string} modsDir The path to the mods directory.
 * @param {string} version The minecraft version of the server configuration.
 * @param {string[]} blockedPatterns Optional array of glob patterns for blocked mods.
 * 
 * @returns {{fullName: string, name: string, ext: string, disabled: boolean, blocked: boolean}[]}
 * An array of objects storing metadata about each discovered mod.
 */
exports.scanForDropinMods = function(modsDir, version, blockedPatterns) {
    const modsDiscovered = []
    if(fs.existsSync(modsDir)){
        let modCandidates = fs.readdirSync(modsDir)
        let verCandidates = []
        const versionDir = path.join(modsDir, version)
        if(fs.existsSync(versionDir)){
            verCandidates = fs.readdirSync(versionDir)
        }
        for(let file of modCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: match[0],
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null,
                    blocked: exports.isModBlocked(match[1], blockedPatterns)
                })
            }
        }
        for(let file of verCandidates){
            const match = MOD_REGEX.exec(file)
            if(match != null){
                modsDiscovered.push({
                    fullName: path.join(version, match[0]),
                    name: match[1],
                    ext: match[2],
                    disabled: match[3] != null,
                    blocked: exports.isModBlocked(match[1], blockedPatterns)
                })
            }
        }
    }
    return modsDiscovered
}

/**
 * Add dropin mods. Rejects mods that match the blocked patterns.
 * 
 * @param {FileList} files The files to add.
 * @param {string} modsDir The path to the mods directory.
 * @param {string[]} blockedPatterns Optional array of glob patterns for blocked mods.
 * @returns {string[]} An array of file names that were rejected due to being blocked.
 */
exports.addDropinMods = function(files, modsdir, blockedPatterns) {

    exports.validateDir(modsdir)

    const rejected = []
    for(let f of files) {
        if(MOD_REGEX.exec(f.name) != null) {
            if(exports.isModBlocked(f.name, blockedPatterns)) {
                rejected.push(f.name)
                logger.info(`Blocked mod rejected on add: ${f.name}`)
            } else {
                try {
                    fs.moveSync(f.path, path.join(modsdir, f.name))
                } catch(err) {
                    logger.error(`Failed to add mod ${f.name}:`, err)
                    rejected.push(f.name)
                }
            }
        }
    }
    return rejected

}

/**
 * Delete a drop-in mod from the file system.
 * 
 * @param {string} modsDir The path to the mods directory.
 * @param {string} fullName The fullName of the discovered mod to delete.
 * 
 * @returns {Promise.<boolean>} True if the mod was deleted, otherwise false.
 */
exports.deleteDropinMod = async function(modsDir, fullName){

    const res = await ipcRenderer.invoke(SHELL_OPCODE.TRASH_ITEM, path.join(modsDir, fullName))

    if(!res.result) {
        shell.beep()
        return false
    }

    return true
}

/**
 * Toggle a discovered mod on or off. This is achieved by either 
 * adding or disabling the .disabled extension to the local file.
 * 
 * @param {string} modsDir The path to the mods directory.
 * @param {string} fullName The fullName of the discovered mod to toggle.
 * @param {boolean} enable Whether to toggle on or off the mod.
 * 
 * @returns {Promise.<void>} A promise which resolves when the mod has
 * been toggled. If an IO error occurs the promise will be rejected.
 */
exports.toggleDropinMod = function(modsDir, fullName, enable){
    return new Promise((resolve, reject) => {
        const oldPath = path.join(modsDir, fullName)
        const newPath = path.join(modsDir, enable ? fullName.substring(0, fullName.indexOf(DISABLED_EXT)) : fullName + DISABLED_EXT)

        fs.rename(oldPath, newPath, (err) => {
            if(err){
                reject(err)
            } else {
                resolve()
            }
        })
    })
}

/**
 * Check if a drop-in mod is enabled.
 * 
 * @param {string} fullName The fullName of the discovered mod to toggle.
 * @returns {boolean} True if the mod is enabled, otherwise false.
 */
exports.isDropinModEnabled = function(fullName){
    return !fullName.endsWith(DISABLED_EXT)
}

/**
 * Scan for shaderpacks inside the shaderpacks folder.
 * 
 * @param {string} instanceDir The path to the server instance directory.
 * 
 * @returns {{fullName: string, name: string}[]}
 * An array of objects storing metadata about each discovered shaderpack.
 */
exports.scanForShaderpacks = function(instanceDir){
    const shaderDir = path.join(instanceDir, SHADER_DIR)
    const packsDiscovered = [{
        fullName: 'OFF',
        name: 'Off (Default)'
    }]
    if(fs.existsSync(shaderDir)){
        let modCandidates = fs.readdirSync(shaderDir)
        for(let file of modCandidates){
            const match = SHADER_REGEX.exec(file)
            if(match != null){
                packsDiscovered.push({
                    fullName: match[0],
                    name: match[1]
                })
            }
        }
    }
    return packsDiscovered
}

/**
 * Read the optionsshaders.txt file to locate the current
 * enabled pack. If the file does not exist, OFF is returned.
 * 
 * @param {string} instanceDir The path to the server instance directory.
 * 
 * @returns {string} The file name of the enabled shaderpack.
 */
exports.getEnabledShaderpack = function(instanceDir){
    exports.validateDir(instanceDir)

    const optionsShaders = path.join(instanceDir, SHADER_CONFIG)
    if(fs.existsSync(optionsShaders)){
        const buf = fs.readFileSync(optionsShaders, {encoding: 'utf-8'})
        const match = SHADER_OPTION.exec(buf)
        if(match != null){
            return match[1]
        }
    }
    return 'OFF'
}

/**
 * Set the enabled shaderpack.
 * 
 * @param {string} instanceDir The path to the server instance directory.
 * @param {string} pack the file name of the shaderpack.
 */
exports.setEnabledShaderpack = function(instanceDir, pack){
    exports.validateDir(instanceDir)

    const optionsShaders = path.join(instanceDir, SHADER_CONFIG)
    let buf
    if(fs.existsSync(optionsShaders)){
        buf = fs.readFileSync(optionsShaders, {encoding: 'utf-8'})
        buf = buf.replace(SHADER_OPTION, `shaderPack=${pack}`)
    } else {
        buf = `shaderPack=${pack}`
    }
    fs.writeFileSync(optionsShaders, buf, {encoding: 'utf-8'})
}

/**
 * Add shaderpacks.
 * 
 * @param {FileList} files The files to add.
 * @param {string} instanceDir The path to the server instance directory.
 */
exports.addShaderpacks = function(files, instanceDir) {

    const p = path.join(instanceDir, SHADER_DIR)

    exports.validateDir(p)

    for(let f of files) {
        if(SHADER_REGEX.exec(f.name) != null) {
            fs.moveSync(f.path, path.join(p, f.name))
        }
    }

}