const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { LoggerUtil }        = require('helios-core')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')
const DropinModUtil            = require('./dropinmodutil')
const { AZURE_CLIENT_ID }      = require('./ipcconstants')

const logger = LoggerUtil.getLogger('ProcessBuilder')

let FileLog
try {
    const FileLogger = require('./loggerutil')
    FileLog = FileLogger.getLogger('ProcessBuilder')
} catch(_) {
    FileLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} }
}


/**
 * Only forge and fabric are top level mod loaders.
 * 
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 * 
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }
    
    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        fs.ensureDirSync(this.gameDir)
        FileLog.info(`Building game process for server: ${this.server.rawServer.id}`)
        FileLog.info(`Game directory: ${this.gameDir}`)
        this.migrateMinimapData()
        this.enforceBlockedDropinMods()
        this.applyAudioSensitivity()
        this.applyPerformanceSettings()
        this.forceResourcePack()
        this.ensureServerEntry()
        this.forceAcceptServerResourcePack()
        this.clearServerPackCache()
        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.randomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        FileLog.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
        FileLog.info('Using fabric loader:', this.usingFabricLoader)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)
        
        // Mod list below 1.13
        // Fabric only supports 1.14+
        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }
        
        const uberModArr = modObj.fMods.concat(modObj.lMods)
        let args = this.constructJVMArguments(uberModArr, tempNativePath)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            //args = args.concat(this.constructModArguments(modObj.fMods))
            args = args.concat(this.constructModList(modObj.fMods))
        }

        logger.info('Launch Arguments:', args)
        const safeArgs = args.map(a => typeof a === 'string' && a.startsWith('eyJ') ? a.substring(0, 12) + '...[REDACTED]' : a)
        FileLog.info('Launch Arguments:', safeArgs.join(' '))

        const javaExec = ConfigManager.getJavaExecutable(this.server.rawServer.id)
        FileLog.info('Java Executable:', javaExec)

        const child = child_process.spawn(javaExec, args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            FileLog.debug('[GAME STDOUT]', data.trimEnd())
        })
        child.stderr.on('data', (data) => {
            FileLog.warn('[GAME STDERR]', data.trimEnd())
        })
        child.on('close', (code, signal) => {
            logger.info('Exited with code', code)
            FileLog.info(`Game process exited with code ${code}${signal ? ', signal ' + signal : ''}`)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                    FileLog.warn('Error deleting temp native dir:', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
        })

        return child
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     * 
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     * 
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     * 
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     * 
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute(){
        try {
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }
        
        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     * 
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether or not we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids
        
        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    // /**
    //  * Construct the mod argument list for forge 1.13
    //  * 
    //  * @param {Array.<Object>} mods An array of mods to add to the mod list.
    //  */
    // constructModArguments(mods){
    //     const argStr = mods.map(mod => {
    //         return mod.getExtensionlessMavenIdentifier()
    //     }).join(',')

    //     if(argStr){
    //         return [
    //             '--fml.mavenRoots',
    //             path.join('..', '..', 'common', 'modstore'),
    //             '--fml.mods',
    //             argStr
    //         ]
    //     } else {
    //         return []
    //     }
        
    // }

    /**
     * Construct the mod argument list for forge 1.13 and Fabric
     * 
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(this.server.rawServer.autoconnect){
            if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                args.push('--quickPlayMultiplayer')
                args.push(`${this.server.hostname}:${this.server.port}`)
            } else {
                args.push('--server')
                args.push(this.server.hostname)
                args.push('--port')
                args.push(this.server.port)
            }
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(mods, tempNativePath){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments112(mods, tempNativePath){

        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=MidgardLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.13+
     * 
     * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments113(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.vanillaManifest.arguments.jvm

        // Debug securejarhandler
        // args.push('-Dbsl.debug=true')

        if(this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                args.push(argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id)
                )
            }
        }

        //args.push('-Dlog4j.configurationFile=D:\\WesterosCraft\\game\\common\\assets\\log_configs\\client-1.12.xml')

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=MidgardLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + ConfigManager.getMaxRAM(this.server.rawServer.id))
        args.push('-Xms' + ConfigManager.getMinRAM(this.server.rawServer.id))
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Vanilla Arguments
        args = args.concat(this.vanillaManifest.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){
                
                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = vanillaManifest.id
                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            if(this.authUser.type === 'microsoft'){
                                val = 'msa'
                            } else {
                                val = 'legacy'
                            }
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'Midgard-Launcher')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'clientid':
                            val = AZURE_CLIENT_ID
                            break
                        case 'auth_xuid':
                            val = this.authUser.microsoft?.xuid || ''
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator())
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Autoconnect
        this._processAutoConnectArg(args)
        

        // Forge Specific Arguments
        args = args.concat(this.modManifest.arguments.game)

        // Filter null values
        args = args.filter(arg => {
            return arg != null
        })

        return args
    }

    /**
     * Resolve the arguments required by forge.
     * 
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs(){
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        // Replace the declared variables with their proper values.
        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = vanillaManifest.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        if(this.authUser.type === 'microsoft'){
                            val = 'msa'
                        } else {
                            val = 'legacy'
                        }
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }
        
        // Mod List File Argument
        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }
        

        // LiteLoader
        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)

            // Set first arg to liteloader tweak class
            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     * 
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath){
        let cpArgs = []

        if(!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+.
            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }
        

        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     * 
     * TODO - clean up function
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){

                // Pre-1.19 has a natives object.
                if(lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            const destPath = path.join(tempNativePath, fileName)
                            const resolvedDest = path.resolve(destPath)
                            if(!resolvedDest.startsWith(path.resolve(tempNativePath))) {
                                logger.warn('Skipping zip entry with path traversal:', fileName)
                                continue
                            }
                            fs.writeFile(destPath, zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // 1.19+ logic
                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    if(!regexTest) {
                        logger.warn(`Natives library has unexpected format, skipping: ${lib.name}`)
                        continue
                    }
                    // const os = regexTest[1]
                    const arch = regexTest[2] ?? 'x64'

                    if(arch != process.arch) {
                        continue
                    }

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if(!shouldExclude){
                            const destPath = path.join(tempNativePath, extractName)
                            const resolvedDest = path.resolve(destPath)
                            if(!resolvedDest.startsWith(path.resolve(tempNativePath))) {
                                logger.warn('Skipping zip entry with path traversal:', fileName)
                                continue
                            }
                            fs.writeFile(destPath, zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Fabric/Libraries
        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    if(Object.keys(res).length > 0){
                        libs = {...libs, ...res}
                    }
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                if(Object.keys(res).length > 0){
                    libs = {...libs, ...res}
                }
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     * 
     * @param {Object} mdl A module object from the server distro index.
     * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(!mdl.subModules.length > 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){

                if(sm.rawModule.classpath ?? true) {
                    libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                if(Object.keys(res).length > 0){
                    libs = {...libs, ...res}
                }
            }
        }
        return libs
    }

    /**
     * Enforce blocked mods by removing any blocked drop-in mods
     * from the mods directory before launch.
     */
    enforceBlockedDropinMods(){
        const blockedPatterns = this.server.rawServer.blockedMods
        if(!blockedPatterns || blockedPatterns.length === 0){
            return
        }
        const modsDir = path.join(this.gameDir, 'mods')
        const removed = DropinModUtil.enforceBlockedMods(modsDir, this.server.rawServer.minecraftVersion, blockedPatterns)
        if(removed.length > 0){
            logger.info('Blocked mods removed before launch:', removed)
            FileLog.info('Blocked mods removed before launch:', removed.join(', '))
        }
    }

    /**
     * Apply audio sensitivity settings to Minecraft's options.txt.
     * When audio sensitivity is enabled, lowers in-game volume levels.
     */
    applyAudioSensitivity(){
        const currentSensitivity = ConfigManager.getAudioSensitivity()
        const appliedSensitivity = ConfigManager.getAppliedAudioSensitivity()
        
        // Only apply if the setting changed since last launch
        if(currentSensitivity === appliedSensitivity){
            return
        }

        if(!currentSensitivity){
            ConfigManager.setAppliedAudioSensitivity(false)
            ConfigManager.save()
            return
        }

        const optionsPath = path.join(this.gameDir, 'options.txt')

        const sensitiveVolumes = {
            'soundCategory_master': '0.25',
            'soundCategory_music': '0.15',
            'soundCategory_weather': '0.15',
            'soundCategory_hostile': '0.2',
            'soundCategory_ambient': '0.15'
        }

        let content = ''
        if(fs.existsSync(optionsPath)){
            content = fs.readFileSync(optionsPath, 'utf8')
        }

        for(const [key, value] of Object.entries(sensitiveVolumes)){
            const regex = new RegExp(`^${key}:.*$`, 'm')
            if(regex.test(content)){
                content = content.replace(regex, `${key}:${value}`)
            } else {
                content += `${key}:${value}\n`
            }
        }

        fs.writeFileSync(optionsPath, content, 'utf8')
        ConfigManager.setAppliedAudioSensitivity(true)
        ConfigManager.save()
        logger.info('Audio sensitivity settings applied to options.txt')
    }

    /**
     * Apply performance settings to Minecraft's options.txt based on the selected tier.
     * Configures graphics, render distance, and other settings for optimal gameplay.
     * Also configures optimization mods (Sodium, Entity Culling, ImmediatelyFast).
     */
    applyPerformanceSettings(){
        const tier = ConfigManager.getPerformanceTier()
        if(!tier) return

        // Only apply if the tier changed since last application
        const appliedTier = ConfigManager.getAppliedPerformanceTier()
        if(tier === appliedTier){
            logger.info(`Performance tier (${tier}) already applied, preserving user settings.`)
            return
        }

        const optionsPath = path.join(this.gameDir, 'options.txt')
        const configDir = path.join(this.gameDir, 'config')

        const tierSettings = {
            high: {
                'renderDistance': '16',
                'simulationDistance': '12',
                'graphicsMode': '2',
                'ao': 'true',
                'maxFps': '0',
                'particles': '0',
                'renderClouds': '"true"',
                'entityShadows': 'true',
                'biomeBlendRadius': '5',
                'mipmapLevels': '4',
                'entityDistanceScaling': '1.0',
                'fov': '0.0'
            },
            medium: {
                'renderDistance': '10',
                'simulationDistance': '8',
                'graphicsMode': '2',
                'ao': 'true',
                'maxFps': '120',
                'particles': '1',
                'renderClouds': '"fast"',
                'entityShadows': 'true',
                'biomeBlendRadius': '3',
                'mipmapLevels': '4',
                'entityDistanceScaling': '0.75',
                'fov': '0.0'
            },
            low: {
                'renderDistance': '6',
                'simulationDistance': '5',
                'graphicsMode': '1',
                'ao': 'false',
                'maxFps': '60',
                'particles': '2',
                'renderClouds': '"false"',
                'entityShadows': 'false',
                'biomeBlendRadius': '0',
                'mipmapLevels': '0',
                'entityDistanceScaling': '0.5',
                'fov': '0.0'
            }
        }

        const settings = tierSettings[tier]
        if(!settings) return

        // Apply vanilla options.txt settings
        let content = ''
        if(fs.existsSync(optionsPath)){
            content = fs.readFileSync(optionsPath, 'utf8')
        }

        for(const [key, value] of Object.entries(settings)){
            const regex = new RegExp(`^${key}:.*$`, 'm')
            if(regex.test(content)){
                content = content.replace(regex, `${key}:${value}`)
            } else {
                content += `${key}:${value}\n`
            }
        }

        fs.writeFileSync(optionsPath, content, 'utf8')
        logger.info(`Performance settings (${tier}) applied to options.txt`)

        // Apply optimization mod configs
        fs.ensureDirSync(configDir)
        this.applySodiumConfig(configDir, tier)
        this.applyEntityCullingConfig(configDir, tier)
        this.applyImmediatelyFastConfig(configDir, tier)

        // Mark this tier as applied so we don't overwrite user changes next launch
        ConfigManager.setAppliedPerformanceTier(tier)
        ConfigManager.save()
    }

    /**
     * Apply Sodium configuration based on performance tier.
     */
    applySodiumConfig(configDir, tier){
        const sodiumPath = path.join(configDir, 'sodium-options.json')

        const sodiumConfigs = {
            high: {
                quality: {
                    weather_quality: 'FANCY',
                    leaves_quality: 'FANCY',
                    enable_vignette: true
                },
                advanced: {
                    enable_memory_tracing: false,
                    use_advanced_staging_buffers: true,
                    cpu_render_ahead_limit: 3
                },
                performance: {
                    chunk_builder_threads: 0,
                    always_defer_chunk_updates_v2: true,
                    animate_only_visible_textures: false,
                    use_entity_culling: true,
                    use_fog_occlusion: true,
                    use_block_face_culling: true,
                    use_no_error_g_l_context: true
                },
                notifications: {
                    has_cleared_donation_button: false,
                    has_seen_donation_prompt: false
                }
            },
            medium: {
                quality: {
                    weather_quality: 'DEFAULT',
                    leaves_quality: 'DEFAULT',
                    enable_vignette: true
                },
                advanced: {
                    enable_memory_tracing: false,
                    use_advanced_staging_buffers: true,
                    cpu_render_ahead_limit: 3
                },
                performance: {
                    chunk_builder_threads: 0,
                    always_defer_chunk_updates_v2: true,
                    animate_only_visible_textures: true,
                    use_entity_culling: true,
                    use_fog_occlusion: true,
                    use_block_face_culling: true,
                    use_no_error_g_l_context: true
                },
                notifications: {
                    has_cleared_donation_button: false,
                    has_seen_donation_prompt: false
                }
            },
            low: {
                quality: {
                    weather_quality: 'FAST',
                    leaves_quality: 'FAST',
                    enable_vignette: false
                },
                advanced: {
                    enable_memory_tracing: false,
                    use_advanced_staging_buffers: true,
                    cpu_render_ahead_limit: 2
                },
                performance: {
                    chunk_builder_threads: 0,
                    always_defer_chunk_updates_v2: true,
                    animate_only_visible_textures: true,
                    use_entity_culling: true,
                    use_fog_occlusion: true,
                    use_block_face_culling: true,
                    use_no_error_g_l_context: true
                },
                notifications: {
                    has_cleared_donation_button: false,
                    has_seen_donation_prompt: false
                }
            }
        }

        const config = sodiumConfigs[tier]
        if(!config) return

        // Preserve existing notification state if file exists
        if(fs.existsSync(sodiumPath)){
            try {
                const existing = JSON.parse(fs.readFileSync(sodiumPath, 'utf8'))
                if(existing.notifications){
                    config.notifications = existing.notifications
                }
            } catch(e) { /* ignore parse errors */ }
        }

        fs.writeFileSync(sodiumPath, JSON.stringify(config, null, 2), 'utf8')
        logger.info(`Sodium config (${tier}) applied`)
    }

    /**
     * Apply Entity Culling configuration based on performance tier.
     */
    applyEntityCullingConfig(configDir, tier){
        const ecPath = path.join(configDir, 'entityculling.json')

        // Load existing config to preserve whitelists
        let existing = {}
        if(fs.existsSync(ecPath)){
            try {
                existing = JSON.parse(fs.readFileSync(ecPath, 'utf8'))
            } catch(e) { /* ignore */ }
        }

        const ecConfigs = {
            high: {
                tracingDistance: 128,
                sleepDelay: 10,
                hitboxLimit: 50,
                captureRate: 5,
                tickCulling: false,
                skipEntityCulling: false,
                skipBlockEntityCulling: false,
                blockEntityFrustumCulling: true
            },
            medium: {
                tracingDistance: 128,
                sleepDelay: 10,
                hitboxLimit: 50,
                captureRate: 5,
                tickCulling: true,
                skipEntityCulling: false,
                skipBlockEntityCulling: false,
                blockEntityFrustumCulling: true
            },
            low: {
                tracingDistance: 64,
                sleepDelay: 20,
                hitboxLimit: 30,
                captureRate: 10,
                tickCulling: true,
                skipEntityCulling: false,
                skipBlockEntityCulling: false,
                blockEntityFrustumCulling: true
            }
        }

        const tierConfig = ecConfigs[tier]
        if(!tierConfig) return

        // Merge: keep existing whitelists/version, override performance values
        const merged = Object.assign({}, existing, tierConfig)
        fs.writeFileSync(ecPath, JSON.stringify(merged, null, 2), 'utf8')
        logger.info(`Entity Culling config (${tier}) applied`)
    }

    /**
     * Apply ImmediatelyFast configuration based on performance tier.
     */
    applyImmediatelyFastConfig(configDir, tier){
        const ifPath = path.join(configDir, 'immediatelyfast.json')

        const ifConfigs = {
            high: {
                font_atlas_resizing: true,
                map_atlas_generation: true,
                hud_batching: true,
                fast_text_lookup: true,
                fast_buffer_upload: true,
                dont_add_info_into_debug_hud: false,
                experimental_disable_error_checking: false,
                experimental_disable_resource_pack_conflict_handling: false,
                experimental_sign_text_buffering: false,
                experimental_screen_batching: false
            },
            medium: {
                font_atlas_resizing: true,
                map_atlas_generation: true,
                hud_batching: true,
                fast_text_lookup: true,
                fast_buffer_upload: true,
                dont_add_info_into_debug_hud: false,
                experimental_disable_error_checking: false,
                experimental_disable_resource_pack_conflict_handling: false,
                experimental_sign_text_buffering: true,
                experimental_screen_batching: true
            },
            low: {
                font_atlas_resizing: true,
                map_atlas_generation: true,
                hud_batching: true,
                fast_text_lookup: true,
                fast_buffer_upload: true,
                dont_add_info_into_debug_hud: false,
                experimental_disable_error_checking: true,
                experimental_disable_resource_pack_conflict_handling: false,
                experimental_sign_text_buffering: true,
                experimental_screen_batching: true
            }
        }

        const config = ifConfigs[tier]
        if(!config) return

        fs.writeFileSync(ifPath, JSON.stringify(config, null, 2), 'utf8')
        logger.info(`ImmediatelyFast config (${tier}) applied`)
    }

    /**
     * Force the server resource pack to be enabled in options.txt.
     * Also protects the pack file from being deleted or modified.
     */
    forceResourcePack(){
        const optionsPath = path.join(this.gameDir, 'options.txt')
        const packFileName = 'MidgardRP_Texture.zip'
        const packEntry = 'file/' + packFileName

        let content = ''
        if(fs.existsSync(optionsPath)){
            content = fs.readFileSync(optionsPath, 'utf8')
        }

        const regex = /^resourcePacks:\[(.*)\]$/m
        if(regex.test(content)){
            const match = content.match(regex)
            let packs = match[1].split(',').map(p => p.replace(/"/g, '').trim()).filter(p => p.length > 0)
            
            // If pack is already present (check both formats), no changes needed
            if(packs.includes(packEntry) || packs.includes(packFileName)){
                logger.info('Resource pack already configured in options.txt, skipping.')
                return
            }

            // Remove any old entries to rebuild cleanly
            packs = packs.filter(p => p !== packEntry && p !== packFileName && p !== 'vanilla' && p !== 'fabric')
            
            // Rebuild pack list with vanilla and fabric first, then our pack
            packs.unshift('fabric')
            packs.unshift('vanilla')
            packs.push(packEntry)
            
            const newPacksStr = packs.map(p => `"${p}"`).join(',')
            content = content.replace(regex, `resourcePacks:[${newPacksStr}]`)
        } else {
            content += `\nresourcePacks:["vanilla","fabric","${packEntry}"]\n`
        }

        fs.writeFileSync(optionsPath, content, 'utf8')
        logger.info('Forced server resource pack in options.txt')
    }

    /**
     * Ensure the MidgardRP server entry exists in servers.dat.
     * If servers.dat already exists, preserves all existing entries and only
     * adds/updates the MidgardRP entry. Creates a new file only on first launch.
     */
    ensureServerEntry(){
        const serversDatPath = path.join(this.gameDir, 'servers.dat')
        const serverIp = 'midgardrp.net'
        const serverName = 'MidgardRP'

        // Helper to write NBT tags
        const writeByte = (v) => { const b = Buffer.alloc(1); b.writeInt8(v, 0); return b }
        const writeShort = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b }
        const writeString = (s) => { const buf = Buffer.from(s, 'utf8'); return Buffer.concat([writeShort(buf.length), buf]) }

        // If servers.dat already exists, check if MidgardRP entry is present
        if(fs.existsSync(serversDatPath)){
            try {
                const data = fs.readFileSync(serversDatPath)
                const ipBuf = Buffer.from(serverIp)
                if(data.indexOf(ipBuf) !== -1){
                    logger.info('MidgardRP entry already present in servers.dat, preserving user servers.')
                    return
                }
                // MidgardRP entry not found - we need to add it.
                // To safely add to existing NBT, we find the server list count and append.
                // Since NBT manipulation is complex, we'll only create from scratch if
                // the file doesn't contain any server entries yet.
                logger.info('MidgardRP entry not found in servers.dat, adding it.')
            } catch(err) {
                logger.warn('Could not read servers.dat, recreating:', err)
            }
        }

        // Build a minimal servers.dat NBT file with the MidgardRP entry
        const parts = []

        // Root TAG_Compound (type=10, name="")
        parts.push(writeByte(10))
        parts.push(writeString(''))

        // TAG_List "servers" (type=9, element type=10 TAG_Compound)
        parts.push(writeByte(9))
        parts.push(writeString('servers'))
        parts.push(writeByte(10))
        const countBuf = Buffer.alloc(4)
        countBuf.writeInt32BE(1, 0)
        parts.push(countBuf)

        // Server entry TAG_Compound
        parts.push(writeByte(8))
        parts.push(writeString('name'))
        parts.push(writeString(serverName))

        parts.push(writeByte(8))
        parts.push(writeString('ip'))
        parts.push(writeString(serverIp))

        parts.push(writeByte(1))
        parts.push(writeString('acceptTextures'))
        parts.push(writeByte(1))

        // End server compound
        parts.push(writeByte(0))

        // End root compound
        parts.push(writeByte(0))

        fs.writeFileSync(serversDatPath, Buffer.concat(parts))
        logger.info('Created servers.dat with MidgardRP server entry.')
    }

    /**
     * Force acceptTextures=1 in servers.dat for the MidgardRP server.
     * This auto-accepts the server resource pack without prompting the user.
     * Uses direct binary buffer manipulation to avoid AJV/CSP issues.
     */
    forceAcceptServerResourcePack(){
        const serversDatPath = path.join(this.gameDir, 'servers.dat')
        
        if(!fs.existsSync(serversDatPath)){
            logger.info('servers.dat not found, skipping acceptTextures.')
            return
        }

        try {
            const data = fs.readFileSync(serversDatPath)
            const serverIp = Buffer.from('midgardrp.net')

            if(data.indexOf(serverIp) === -1){
                logger.info('midgardrp.net not found in servers.dat, skipping.')
                return
            }

            // NBT TAG_Byte for "acceptTextures": 0x01 (tag type) + 0x00 0x0E (name length 14) + "acceptTextures" + value byte
            const tagName = Buffer.from('acceptTextures')
            let modified = false
            let offset = 0

            while(offset < data.length){
                const idx = data.indexOf(tagName, offset)
                if(idx === -1) break

                // Verify this is a TAG_Byte (0x01) with name length 14 (0x000E)
                if(idx >= 3 && data[idx - 3] === 0x01 && data[idx - 2] === 0x00 && data[idx - 1] === 0x0E){
                    const valueOffset = idx + tagName.length
                    // Set to 1 (ACCEPT) - auto-accept as fallback if skip mod fails
                    if(valueOffset < data.length && data[valueOffset] !== 1){
                        data[valueOffset] = 1
                        modified = true
                        logger.info('Set acceptTextures=1 (accept) in servers.dat')
                    }
                }
                offset = idx + 1
            }

            if(modified){
                fs.writeFileSync(serversDatPath, data)
                logger.info('Updated servers.dat with acceptTextures.')
            } else {
                logger.info('servers.dat already has acceptTextures=1 for MidgardRP.')
            }
        } catch(err) {
            logger.error('Error updating servers.dat:', err)
        }
    }

    /**
     * Migrate minimap mod data (waypoints, world maps) from previous instance directories.
     * Supports Xaero's Minimap/WorldMap, JourneyMap, and VoxelMap.
     * This preserves player data when the server ID changes (e.g. Minecraft version update).
     */
    migrateMinimapData(){
        const minimapDirs = [
            'XaeroWaypoints',
            'XaeroWaypoints_BACKUP',
            'XaeroWorldMap',
            'journeymap',
            'voxelmap'
        ]

        // Check if any minimap data already exists in current gameDir
        const hasExistingData = minimapDirs.some(dir => fs.existsSync(path.join(this.gameDir, dir)))
        if(hasExistingData){
            return
        }

        // Look for previous instance directories with minimap data
        const instancesDir = ConfigManager.getInstanceDirectory()
        if(!fs.existsSync(instancesDir)){
            return
        }

        const currentDirName = path.basename(this.gameDir)
        let candidates
        try {
            candidates = fs.readdirSync(instancesDir)
                .filter(name => name !== currentDirName)
                .map(name => ({
                    name,
                    fullPath: path.join(instancesDir, name),
                    mtime: fs.statSync(path.join(instancesDir, name)).mtimeMs
                }))
                .filter(entry => fs.statSync(entry.fullPath).isDirectory())
                .sort((a, b) => b.mtime - a.mtime)
        } catch(err) {
            logger.warn('Could not scan instance directories for minimap migration:', err)
            return
        }

        for(const candidate of candidates){
            let migrated = false
            for(const dir of minimapDirs){
                const srcDir = path.join(candidate.fullPath, dir)
                const destDir = path.join(this.gameDir, dir)
                if(fs.existsSync(srcDir) && !fs.existsSync(destDir)){
                    try {
                        fs.copySync(srcDir, destDir)
                        logger.info(`Migrated minimap data: ${dir} from ${candidate.name}`)
                        FileLog.info(`Migrated minimap data: ${dir} from ${candidate.name}`)
                        migrated = true
                    } catch(err) {
                        logger.warn(`Failed to migrate ${dir} from ${candidate.name}:`, err)
                    }
                }
            }
            if(migrated) break
        }
    }

    /**
     * Clear the server resource pack download cache to prevent stale/duplicate downloads.
     * Clears both the legacy 'downloads/' cache and the modern 'server-resource-packs/' cache.
     * The skip-RP mod handles server packs, so cached downloads are unnecessary.
     */
    clearServerPackCache(){
        const cacheDirs = [
            path.join(this.gameDir, 'downloads'),
            path.join(this.gameDir, 'server-resource-packs')
        ]
        for(const dir of cacheDirs){
            if(fs.existsSync(dir)){
                try {
                    fs.removeSync(dir)
                    logger.info(`Cleared server resource pack cache: ${dir}`)
                } catch(err) {
                    logger.warn(`Could not clear cache ${dir}:`, err)
                }
            }
        }
    }

}

module.exports = ProcessBuilder