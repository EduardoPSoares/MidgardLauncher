const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Enable smooth 144hz rendering.
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron')
app.commandLine.appendSwitch('disable-frame-rate-limit')
app.commandLine.appendSwitch('disable-gpu-vsync')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Initialize centralized file logger.
const FileLogger = require('./app/assets/js/loggerutil')
try {
    FileLogger.initialize(app.getPath('userData'))
} catch(_) {
    FileLogger.initialize(null) // Fallback to temp dir
}
const flog = FileLogger.getLogger('Main')

// Global error handlers - captura erros não tratados no processo principal.
process.on('uncaughtException', (err) => {
    flog.fatal('Uncaught Exception:', err)
    try {
        dialog.showErrorBox('Erro Fatal - MidgardLauncher',
            `Ocorreu um erro inesperado:\n${err.message}\n\nO launcher será encerrado. Verifique os logs em:\n${FileLogger.getLogDirectory()}`
        )
    } catch(_) { /* ignore dialog errors */ }
})
process.on('unhandledRejection', (reason) => {
    flog.error('Unhandled Promise Rejection:', reason)
})
app.on('render-process-gone', (_event, _webContents, details) => {
    flog.fatal('Render process gone:', details)
})
app.on('child-process-gone', (_event, details) => {
    flog.error('Child process gone:', details)
})

// Token do GitHub (somente leitura) vem do ambiente; nunca versionar.
const GITHUB_TOKEN = process.env.GH_TOKEN || ''
process.env.GH_TOKEN = GITHUB_TOKEN
process.env.GH_DOWNLOAD_TOKEN = GITHUB_TOKEN
flog.info('GitHub token configured.')

// Requirements
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')

// Setup Lang
try {
    LangLoader.setupLanguage()
    flog.info('Language loaded successfully.')
} catch(err) {
    flog.error('Failed to load language files:', err)
}

// Helper: safely send IPC to renderer window.
function sendToRenderer(...args) {
    if(win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(...args)
    }
}

// Setup auto updater.
let autoUpdaterInitialized = false

// Auto-updater file logger for diagnostics.
let autoUpdateLogPath
try {
    autoUpdateLogPath = path.join(app.getPath('userData'), 'autoupdate.log')
} catch(_) {
    autoUpdateLogPath = path.join(__dirname, 'autoupdate.log')
}
function logUpdate(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    try { fs.appendFileSync(autoUpdateLogPath, line) } catch(_) {}
}

function initAutoUpdater(allowPrerelease) {

    if(allowPrerelease){
        autoUpdater.allowPrerelease = true
    }
    
    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    } else {
        // Use GitHub API instead of .atom feed (required for private repos).
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: 'MidgardNetwork',
            repo: 'MidgardLauncher',
            private: true,
            token: GITHUB_TOKEN
        })
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }

    // Register event listeners only once to prevent stacking.
    if(!autoUpdaterInitialized) {
        autoUpdaterInitialized = true

        autoUpdater.on('checking-for-update', () => {
            logUpdate('Checking for update...')
        })
        autoUpdater.on('update-available', (info) => {
            logUpdate(`Update available: ${info.version}`)
            sendToRenderer('autoUpdateNotification', 'update-available', info)
        })
        autoUpdater.on('download-progress', (progress) => {
            logUpdate(`Download progress: ${progress.percent.toFixed(1)}%`)
            sendToRenderer('autoUpdateNotification', 'download-progress', progress)
        })
        let updateInstallTimer
        autoUpdater.on('update-downloaded', (info) => {
            logUpdate(`Update downloaded: ${info.version} - installing and restarting...`)
            sendToRenderer('autoUpdateNotification', 'update-downloaded', info)
            if(updateInstallTimer) clearTimeout(updateInstallTimer)
            updateInstallTimer = setTimeout(() => {
                if(win && !win.isDestroyed()) {
                    autoUpdater.quitAndInstall(true, true)
                }
            }, 1500)
        })
        autoUpdater.on('update-not-available', (info) => {
            logUpdate(`No update available. Latest: ${info.version}`)
            sendToRenderer('autoUpdateNotification', 'update-not-available', info)
        })
        autoUpdater.on('error', (err) => {
            logUpdate(`ERROR: ${err.message || err}`)
            sendToRenderer('autoUpdateNotification', 'realerror', err.message || String(err))
        })
    }

    logUpdate(`Initialized. isDev=${isDev}, allowPrerelease=${autoUpdater.allowPrerelease}, version=${app.getVersion()}`)
    flog.info(`Auto-updater initialized. isDev=${isDev}, allowPrerelease=${autoUpdater.allowPrerelease}, version=${app.getVersion()}`)
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            // Auto-updater is now initialized from main process on app.ready.
            // This IPC is kept for allowPrerelease changes from the renderer.
            if(!autoUpdaterInitialized) {
                initAutoUpdater(data)
            }
            sendToRenderer('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    logUpdate(`checkForUpdates error: ${err.message || err}`)
                    sendToRenderer('autoUpdateNotification', 'realerror', err.message || String(err))
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            logUpdate('Unknown argument: ' + arg)
            break
    }
})
// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})

// Fetch news from private GitHub repo.
ipcMain.handle('fetchNews', async () => {
    const https = require('https')
    const newsUrl = 'https://api.github.com/repos/MidgardNetwork/MidgardLauncher/contents/news.json?ref=main&t=' + Date.now()

    return new Promise((resolve) => {
        let resolved = false
        const safeResolve = (val) => { if(!resolved) { resolved = true; resolve(val) } }
        const req = https.get(newsUrl, {
            headers: {
                'Authorization': 'Bearer ' + GITHUB_TOKEN,
                'Accept': 'application/vnd.github.v3.raw',
                'User-Agent': 'MidgardLauncher',
                'Cache-Control': 'no-cache'
            }
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                try {
                    if(res.statusCode !== 200) {
                        safeResolve(null)
                        return
                    }
                    safeResolve(JSON.parse(data))
                } catch(e) {
                    safeResolve(null)
                }
            })
        })
        req.on('error', () => safeResolve(null))
        req.setTimeout(5000, () => { req.destroy(); safeResolve(null) })
    })
})

// Fetch releases from private GitHub repo.
ipcMain.handle('fetchReleases', async () => {
    const https = require('https')
    const url = 'https://api.github.com/repos/MidgardNetwork/MidgardLauncher/releases?per_page=10'

    return new Promise((resolve) => {
        let resolved = false
        const safeResolve = (val) => { if(!resolved) { resolved = true; resolve(val) } }
        const req = https.get(url, {
            headers: {
                'Authorization': 'Bearer ' + GITHUB_TOKEN,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MidgardLauncher'
            }
        }, (res) => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                try {
                    if(res.statusCode !== 200) { safeResolve(null); return }
                    safeResolve(JSON.parse(data))
                } catch(e) { safeResolve(null) }
            })
        })
        req.on('error', () => safeResolve(null))
        req.setTimeout(5000, () => { req.destroy(); safeResolve(null) })
    })
})

// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        flog.debug('Trashed item:', args[0])
        return {
            result: true
        }
    } catch(error) {
        flog.warn('Failed to trash item:', args[0], error)
        return {
            result: false,
            error: error
        }
    }
})

// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()


const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient'

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if(msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle'),
        parent: win
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            flog.warn('Microsoft auth window closed without completing login.')
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('render-process-gone', (_, details) => {
        flog.error('Microsoft auth window render process gone:', details.reason)
        if(msftAuthWindow && !msftAuthWindow.isDestroyed()) {
            msftAuthWindow.close()
        }
    })

    msftAuthWindow.on('unresponsive', () => {
        flog.warn('Microsoft auth window became unresponsive. Attempting recovery.')
        if(msftAuthWindow && !msftAuthWindow.isDestroyed()) {
            msftAuthWindow.reload()
        }
    })

    const handleAuthRedirect = (uri) => {
        if(msftAuthSuccess) return
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            flog.info('Microsoft auth redirect detected:', uri)
            const url = new URL(uri)
            const queryMap = Object.fromEntries(url.searchParams.entries())

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    }

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => handleAuthRedirect(uri))
    msftAuthWindow.webContents.on('will-redirect', (_, uri) => handleAuthRedirect(uri))
    msftAuthWindow.webContents.on('did-fail-load', (_, errorCode, errorDesc, validatedURL) => {
        flog.error('Microsoft auth page failed to load:', { errorCode, errorDesc, validatedURL })
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&response_mode=query&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
    msftAuthWindow.focus()
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    let logoutReplyPending = true
    const sendLogoutReply = (success) => {
        if(!logoutReplyPending) return
        logoutReplyPending = false
        if(success) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        } else {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        }
    }
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle'),
        parent: win
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        sendLogoutReply(msftLogoutSuccess)
    })

    msftLogoutWindow.webContents.on('render-process-gone', (_, details) => {
        flog.error('Microsoft logout window render process gone:', details.reason)
        if(msftLogoutWindow && !msftLogoutWindow.isDestroyed()) {
            msftLogoutWindow.close()
        }
    })

    const handleLogoutRedirect = (uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(msftLogoutWindow && !msftLogoutWindow.isDestroyed()) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    }

    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => handleLogoutRedirect(uri))
    msftLogoutWindow.webContents.on('will-redirect', (_, uri) => handleLogoutRedirect(uri))
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {
    flog.info('Creating main window...')

    win = new BrowserWindow({
        width: 980,
        height: 552,
        minWidth: 980,
        minHeight: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    // Count backgrounds from protected dir (prod) or originals (dev)
    const protectedBgDir = path.join(__dirname, 'app', 'assets', 'protected', 'backgrounds')
    const originalBgDir = path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')
    let bgDir, bgCount
    if(fs.existsSync(protectedBgDir)) {
        bgDir = protectedBgDir
        bgCount = fs.readdirSync(bgDir).filter(f => !f.startsWith('.')).length
    } else if(fs.existsSync(originalBgDir)) {
        bgDir = originalBgDir
        bgCount = fs.readdirSync(bgDir).filter(f => !f.startsWith('.')).length
    } else {
        bgCount = 1
    }

    const data = {
        bkid: Math.floor(Math.random() * bgCount),
        bgcount: bgCount,
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    flog.info('Loading app.ejs...')
    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    win.webContents.on('crashed', (event, killed) => {
        flog.fatal('Web contents crashed!', { killed })
    })
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        flog.error('Failed to load page:', { errorCode, errorDescription, validatedURL })
    })
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        // level: 0=verbose, 1=info, 2=warning, 3=error
        if(level >= 2) {
            flog.warn(`[Renderer Console] ${message} (${sourceId}:${line})`)
        }
    })

    // Open DevTools in dev mode for debugging.
    if(isDev) {
        win.webContents.openDevTools({ mode: 'detach' })
    }



    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        flog.info('Main window closed.')
        win = null
    })
}

// Log quando o app estiver pronto para sair
app.on('before-quit', () => {
    flog.info('Application is quitting...')
    FileLogger.shutdown()
})

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

app.on('ready', () => {
    flog.info(`App ready. Platform: ${process.platform}, Version: ${app.getVersion()}, Electron: ${process.versions.electron}`)
})
app.on('ready', createWindow)
app.on('ready', createMenu)

// Initialize auto-updater directly from the main process.
// Previously depended on IPC from renderer which could fail to arrive.
app.on('ready', () => {
    if(!isDev) {
        initAutoUpdater(false)
        // Check for updates 5s after launch, then every 30 minutes.
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch(err => {
                logUpdate(`checkForUpdates error: ${err.message || err}`)
            })
        }, 5000)
        setInterval(() => {
            autoUpdater.checkForUpdates().catch(err => {
                logUpdate(`Periodic checkForUpdates error: ${err.message || err}`)
            })
        }, 1800000)
    }
})

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})