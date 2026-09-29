const {ipcRenderer}  = require('electron')
const fs             = require('fs-extra')
const os             = require('os')
const path           = require('path')

const ConfigManager  = require('./configmanager')
const { DistroAPI }  = require('./distromanager')
const LangLoader     = require('./langloader')
const { LoggerUtil } = require('helios-core')
// eslint-disable-next-line no-unused-vars
const { HeliosDistribution } = require('helios-core/common')
const FileLogger     = require('./loggerutil')

// Initialize file logger in renderer process.
try {
    const remote = require('@electron/remote')
    FileLogger.initialize(remote.app.getPath('userData'))
} catch(_) {
    FileLogger.initialize(null)
}
const flog = FileLogger.getLogger('Preloader')

// Global error handlers for renderer process.
window.addEventListener('error', (event) => {
    flog.fatal('Uncaught Error in renderer:', event.error || event.message)
})
window.addEventListener('unhandledrejection', (event) => {
    flog.error('Unhandled Promise Rejection in renderer:', event.reason)
})

// In production, redirect console output to the file logger so that
// helios-core LoggerUtil messages (which use console internally) are
// captured in the log files for diagnostics.
const isDev = require('./isdev')
if(!isDev) {
    const consoleFileLog = FileLogger.getLogger('Console')
    console.log   = (...args) => consoleFileLog.info(...args)
    console.info  = (...args) => consoleFileLog.info(...args)
    console.warn  = (...args) => consoleFileLog.warn(...args)
    console.error = (...args) => consoleFileLog.error(...args)
    console.debug = (...args) => consoleFileLog.debug(...args)
    console.trace = (...args) => consoleFileLog.debug('TRACE:', ...args)
}

// Ensure download token is available for child processes (DownloadEngine).
// Normally inherited from main process; fallback to GH_TOKEN if missing.
if(!process.env.GH_DOWNLOAD_TOKEN) {
    process.env.GH_DOWNLOAD_TOKEN = process.env.GH_TOKEN || ''
}

const logger = LoggerUtil.getLogger('Preloader')

logger.info('Loading..')
flog.info('Preloader starting...')

// Load ConfigManager
try {
    ConfigManager.load()
    flog.info('ConfigManager loaded successfully.')
} catch(err) {
    flog.fatal('Failed to load ConfigManager:', err)
}

// Yuck!
// TODO Fix this
DistroAPI['commonDir'] = ConfigManager.getCommonDirectory()
DistroAPI['instanceDir'] = ConfigManager.getInstanceDirectory()

// Load Strings
try {
    LangLoader.setupLanguage()
    flog.info('Language files loaded in renderer.')
} catch(err) {
    flog.error('Failed to load language files in renderer:', err)
}

/**
 * 
 * @param {HeliosDistribution} data 
 */
function onDistroLoad(data){
    if(data != null){
        
        // Resolve the selected server if its value has yet to be set.
        if(ConfigManager.getSelectedServer() == null || data.getServerById(ConfigManager.getSelectedServer()) == null){
            logger.info('Determining default selected server..')
            ConfigManager.setSelectedServer(data.getMainServer().rawServer.id)
            ConfigManager.save()
        }
    }
    ipcRenderer.send('distributionIndexDone', data != null)
}

// Ensure Distribution is downloaded and cached.
DistroAPI.getDistribution()
    .then(heliosDistro => {
        logger.info('Loaded distribution index.')
        flog.info('Distribution index loaded successfully.')

        onDistroLoad(heliosDistro)
    })
    .catch(err => {
        logger.info('Failed to load an older version of the distribution index.')
        logger.info('Application cannot run.')
        logger.error(err)
        flog.fatal('Failed to load distribution index. Application cannot run.', err)

        onDistroLoad(null)
    })

// Clean up temp dir incase previous launches ended unexpectedly. 
fs.remove(path.join(os.tmpdir(), ConfigManager.getTempNativeFolder()), (err) => {
    if(err){
        if(err.code === 'EPERM' || err.code === 'EBUSY') {
            logger.info('Natives directory in use, will be cleaned on next launch.')
            flog.debug('Natives directory in use (game running), skipping cleanup.')
        } else {
            logger.warn('Error while cleaning natives directory', err)
            flog.warn('Error cleaning natives directory:', err)
        }
    } else {
        logger.info('Cleaned natives directory.')
        flog.debug('Cleaned natives directory.')
    }
})