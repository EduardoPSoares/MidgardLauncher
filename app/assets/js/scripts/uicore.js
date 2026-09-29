/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

let FileLog, FileLogUpdater
try {
    const FileLogger = require('./assets/js/loggerutil')
    FileLog = FileLogger.getLogger('UICore')
    FileLogUpdater = FileLogger.getLogger('AutoUpdater')
} catch(_) {
    FileLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} }
    FileLogUpdater = FileLog
}

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

// Disable eval function.
// eslint-disable-next-line
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    // Warnings are displayed via styled console messages in DevTools
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

// Initialize auto updates in production environments.
// Updates are fully silent: download in background, install and relaunch automatically.
let updateCheckListener
if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'ready':
                updateCheckListener = setInterval(() => {
                    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                }, 1800000)
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                break
            case 'update-available':
                FileLogUpdater.info('Update available.')
                showUpdateOverlay()
                break
            case 'download-progress':
                updateDownloadProgress(info.percent)
                break
            case 'update-downloaded':
                FileLogUpdater.info('Update downloaded, installing...')
                updateDownloadComplete()
                break
            case 'update-not-available':
                FileLogUpdater.info('No update available.')
                resetUpdateButton()
                break
            case 'realerror':
                loggerAutoUpdater.error('Auto update error:', info)
                FileLogUpdater.error('Auto update error:', info)
                resetUpdateButton()
                break
            default:
                break
        }
    })
}

function resetUpdateButton() {
    if(typeof populateSettingsUpdateInformation === 'function') {
        populateSettingsUpdateInformation(null)
    }
}

function showUpdateOverlay() {
    const overlay = document.getElementById('updateOverlay')
    if(overlay) overlay.style.display = 'flex'
}

function updateDownloadProgress(percent) {
    const bar = document.getElementById('updateProgressBar')
    const text = document.getElementById('updateProgressText')
    if(bar) bar.style.width = Math.round(percent) + '%'
    if(text) text.textContent = Math.round(percent) + '%'
}

function updateDownloadComplete() {
    const title = document.getElementById('updateOverlayTitle')
    const subtitle = document.getElementById('updateOverlaySubtitle')
    const text = document.getElementById('updateProgressText')
    const bar = document.getElementById('updateProgressBar')
    if(bar) bar.style.width = '100%'
    if(text) text.textContent = '100%'
    if(title) title.textContent = 'Instalando atualização...'
    if(subtitle) subtitle.textContent = 'O launcher será reiniciado automaticamente.'
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 * 
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')
        FileLog.info('UICore initializing...')

        // Bind close button.
        Array.from(document.getElementsByClassName('fCb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.close()
            })
        })

        // Bind restore down button.
        Array.from(document.getElementsByClassName('fRb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                if(window.isMaximized()){
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                document.activeElement.blur()
            })
        })

        // Bind minimize button.
        Array.from(document.getElementsByClassName('fMb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.minimize()
                document.activeElement.blur()
            })
        })

        // Remove focus from social media buttons once they're clicked.
        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

        // Set background music volume and source
        const bgMusic = document.getElementById('bg-music')
        if(bgMusic) {
            const path = require('path')
            const fs = require('fs')
            const AssetGuard = require('./assets/js/assetguard')
            const ConfigManager = require('./assets/js/configmanager')

            // Load audio source
            const protectedMusicPath = path.join(AssetGuard.getProtectedDir(), 'sounds', 'The Luminara.dat')
            const appPath = remote.app.getAppPath()
            const originalSoundsDir = path.join(appPath, 'sounds')
            const originalMusicPath = path.join(originalSoundsDir, 'The Luminara.wav')

            try {
                let buf
                if(fs.existsSync(protectedMusicPath)) {
                    buf = AssetGuard.loadProtectedAsset(protectedMusicPath)
                } else {
                    buf = fs.readFileSync(originalMusicPath)
                }
                const base64 = buf.toString('base64')
                bgMusic.src = 'data:audio/wav;base64,' + base64
            } catch(err) {
                FileLog.warn('Background music load failed:', err.message || err)
            }

            // Function to start music with the correct volume
            function startMusicWithVolume() {
                const sensitive = ConfigManager.getAudioSensitivity()
                bgMusic.volume = sensitive ? 0.04 : 0.15
                const musicSliderEl = document.getElementById('musicVolumeSlider')
                if(musicSliderEl) {
                    musicSliderEl.value = sensitive ? 4 : 15
                }
                bgMusic.play().catch((err) => {
                    FileLog.warn('Background music autoplay blocked:', err.message || err)
                })
            }

            // Function to show performance prompt
            function showPerformancePromptIfNeeded() {
                if(!ConfigManager.isPerformancePromptShown()) {
                    const perfPromptEl = document.getElementById('performancePrompt')
                    if(perfPromptEl) {
                        perfPromptEl.style.display = 'flex'

                        document.getElementById('performanceHigh').addEventListener('click', () => {
                            ConfigManager.setPerformanceTier('high')
                            ConfigManager.setPerformancePromptShown(true)
                            ConfigManager.save()
                            perfPromptEl.style.display = 'none'
                        })

                        document.getElementById('performanceMedium').addEventListener('click', () => {
                            ConfigManager.setPerformanceTier('medium')
                            ConfigManager.setPerformancePromptShown(true)
                            ConfigManager.save()
                            perfPromptEl.style.display = 'none'
                        })

                        document.getElementById('performanceLow').addEventListener('click', () => {
                            ConfigManager.setPerformanceTier('low')
                            ConfigManager.setPerformancePromptShown(true)
                            ConfigManager.save()
                            perfPromptEl.style.display = 'none'
                        })
                    }
                }
            }

            // Show accessibility prompt if not shown before, otherwise start music directly
            if(!ConfigManager.isAccessibilityPromptShown()) {
                const promptEl = document.getElementById('accessibilityPrompt')
                if(promptEl) {
                    promptEl.style.display = 'flex'

                    document.getElementById('accessibilityYes').addEventListener('click', () => {
                        ConfigManager.setAudioSensitivity(true)
                        ConfigManager.setAccessibilityPromptShown(true)
                        ConfigManager.save()
                        promptEl.style.display = 'none'
                        startMusicWithVolume()
                        showPerformancePromptIfNeeded()
                    })

                    document.getElementById('accessibilityNo').addEventListener('click', () => {
                        ConfigManager.setAudioSensitivity(false)
                        ConfigManager.setAccessibilityPromptShown(true)
                        ConfigManager.save()
                        promptEl.style.display = 'none'
                        startMusicWithVolume()
                        showPerformancePromptIfNeeded()
                    })
                } else {
                    startMusicWithVolume()
                    showPerformancePromptIfNeeded()
                }
            } else {
                startMusicWithVolume()
                showPerformancePromptIfNeeded()
            }
        }

        // Music toggle and volume control
        const musicToggleBtn = document.getElementById('musicToggleButton')
        const musicSliderContainer = document.getElementById('musicVolumeSliderContainer')
        const musicSlider = document.getElementById('musicVolumeSlider')
        const musicIconPath = document.getElementById('musicIconPath')

        const ICON_VOLUME = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'
        const ICON_MUTED = 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z'

        if(musicToggleBtn && bgMusic) {
            musicToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation()
                if(musicSliderContainer.style.display === 'none') {
                    musicSliderContainer.style.display = 'flex'
                } else {
                    musicSliderContainer.style.display = 'none'
                }
            })

            musicToggleBtn.addEventListener('dblclick', (e) => {
                e.stopPropagation()
                bgMusic.muted = !bgMusic.muted
                musicIconPath.setAttribute('d', bgMusic.muted ? ICON_MUTED : ICON_VOLUME)
            })

            if(musicSlider) {
                musicSlider.addEventListener('input', (e) => {
                    const vol = parseInt(e.target.value) / 100
                    bgMusic.volume = vol
                    bgMusic.muted = false
                    musicIconPath.setAttribute('d', vol === 0 ? ICON_MUTED : ICON_VOLUME)
                })
            }

            document.addEventListener('click', (e) => {
                if(!musicToggleBtn.contains(e.target) && !musicSliderContainer.contains(e.target)) {
                    musicSliderContainer.style.display = 'none'
                }
            })
        }

    } else if(document.readyState === 'complete'){

        //266.01
        //170.8
        //53.21
        // Bind progress bar length to length of bot wrapper
        //const targetWidth = document.getElementById("launch_content").getBoundingClientRect().width
        //const targetWidth2 = document.getElementById("server_selection").getBoundingClientRect().width
        //const targetWidth3 = document.getElementById("launch_button").getBoundingClientRect().width

        document.getElementById('launch_details').style.maxWidth = 266.01
        document.getElementById('launch_progress').style.width = 170.8
        document.getElementById('launch_details_right').style.maxWidth = 170.8
        document.getElementById('launch_progress_label').style.width = 53.21
        
    }

}, false)

/**
 * Scale the UI proportionally when the window is larger than the design size.
 * This prevents elements from being too spread out in fullscreen/maximized mode.
 */
const DESIGN_WIDTH = 980
const DESIGN_HEIGHT = 552

function updateUIScale(){
    const win = remote.getCurrentWindow()
    const [w, h] = win.getContentSize()
    const scale = Math.min(w / DESIGN_WIDTH, h / DESIGN_HEIGHT)
    webFrame.setZoomFactor(Math.max(0.7, scale))
}

remote.getCurrentWindow().on('resize', updateUIScale)
updateUIScale()

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code. 
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})

// Clean up intervals when window is about to close
window.addEventListener('beforeunload', () => {
    if(updateCheckListener) {
        clearInterval(updateCheckListener)
        updateCheckListener = null
    }
})