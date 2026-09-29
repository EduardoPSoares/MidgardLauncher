const { DistributionAPI } = require('helios-core/common')
const got = require('got')

const ConfigManager = require('./configmanager')

let FileLog
try {
    const FileLogger = require('./loggerutil')
    FileLog = FileLogger.getLogger('DistroManager')
} catch(_) {
    FileLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}

// MidgardRP distribution
exports.REMOTE_DISTRO_URL = 'https://raw.githubusercontent.com/MidgardNetwork/MidgardLauncher/main/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

// Use GitHub Contents API to avoid CDN cache on raw.githubusercontent.com
const GITHUB_API_URL = 'https://api.github.com/repos/MidgardNetwork/MidgardLauncher/contents/distribution.json?ref=main'

api.pullRemote = async function() {
    try {
        const headers = {
            'Accept': 'application/vnd.github.v3.raw',
            'User-Agent': 'MidgardLauncher'
        }
        if(process.env.GH_DOWNLOAD_TOKEN) {
            headers['Authorization'] = 'Bearer ' + process.env.GH_DOWNLOAD_TOKEN
        }
        FileLog.debug('Fetching remote distribution index via GitHub API...')
        const res = await got.get(GITHUB_API_URL, { headers, responseType: 'json' })
        FileLog.info('Remote distribution index fetched successfully.')
        return { data: res.body, responseStatus: 'SUCCESS' }
    } catch(err) {
        // Fallback to raw.githubusercontent.com if API fails
        FileLog.warn('GitHub API failed, falling back to raw URL:', err.message || err)
        try {
            const opts = { responseType: 'json' }
            if(process.env.GH_DOWNLOAD_TOKEN) {
                opts.headers = { Authorization: 'Bearer ' + process.env.GH_DOWNLOAD_TOKEN }
            }
            const res = await got.get(this.remoteUrl + '?t=' + Date.now(), opts)
            FileLog.info('Remote distribution index fetched via fallback.')
            return { data: res.body, responseStatus: 'SUCCESS' }
        } catch(err2) {
            FileLog.error('Failed to fetch remote distribution index:', err2.message || err2)
            return { data: null, responseStatus: 'ERROR' }
        }
    }
}

exports.DistroAPI = api