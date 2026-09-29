const loginOptionsCancelContainer = document.getElementById('loginOptionCancelContainer')
const loginOptionMicrosoft = document.getElementById('loginOptionMicrosoft')
const loginOptionMojang = document.getElementById('loginOptionMojang')
const loginOptionOffline = document.getElementById('loginOptionOffline')
const loginOptionsCancelButton = document.getElementById('loginOptionCancelButton')

let loginOptionsCancellable = false

let loginOptionsViewOnLoginSuccess
let loginOptionsViewOnLoginCancel
let loginOptionsViewOnCancel
let loginOptionsViewCancelHandler

function loginOptionsCancelEnabled(val){
    if(val){
        $(loginOptionsCancelContainer).show()
    } else {
        $(loginOptionsCancelContainer).hide()
    }
}

loginOptionMicrosoft.onclick = (e) => {
    switchView(getCurrentView(), VIEWS.waiting, 500, 500, () => {
        ipcRenderer.send(
            MSFT_OPCODE.OPEN_LOGIN,
            loginOptionsViewOnLoginSuccess,
            loginOptionsViewOnLoginCancel
        )
    })
}

loginOptionMojang.onclick = (e) => {
    switchView(getCurrentView(), VIEWS.login, 500, 500, () => {
        loginViewOnSuccess = loginOptionsViewOnLoginSuccess
        loginViewOnCancel = loginOptionsViewOnLoginCancel
        loginCancelEnabled(true)
    })
}

loginOptionOffline.onclick = (e) => {
    let offlineUsername = ''
    setOverlayContent(
        Lang.queryJS('loginOptions.offlineLoginTitle'),
        Lang.queryJS('loginOptions.offlineLoginDesc'),
        Lang.queryJS('loginOptions.offlineLoginConfirm'),
        Lang.queryJS('loginOptions.offlineLoginCancel')
    )
    setOverlayHandler(() => {
        const input = document.getElementById('offlineUsernameInput')
        if(input && input.value.trim().length >= 3 && input.value.trim().length <= 16 && /^[a-zA-Z0-9_]+$/.test(input.value.trim())) {
            const username = input.value.trim()
            const account = AuthManager.addOfflineAccount(username)
            updateSelectedAccount(account)
            toggleOverlay(false)
            switchView(getCurrentView(), loginOptionsViewOnLoginSuccess, 500, 500, async () => {
                if(loginOptionsViewOnLoginSuccess === VIEWS.settings){
                    await prepareSettings()
                }
            })
        }
    })
    setDismissHandler(() => {
        toggleOverlay(false)
    })
    toggleOverlay(true, true)
    // Inject username input into overlay after it shows
    setTimeout(() => {
        const overlayDesc = document.getElementById('overlayDesc')
        if(overlayDesc && !document.getElementById('offlineUsernameInput')) {
            const br = document.createElement('br')
            const inp = document.createElement('input')
            inp.id = 'offlineUsernameInput'
            inp.type = 'text'
            inp.placeholder = Lang.queryJS('loginOptions.offlineUsernamePlaceholder')
            inp.style.cssText = 'width:60%;padding:8px 12px;margin-top:12px;border:2px solid #555;border-radius:4px;background:#333;color:#fff;font-size:14px;outline:none;text-align:center;'
            inp.maxLength = 16
            inp.autofocus = true
            overlayDesc.appendChild(br)
            overlayDesc.appendChild(inp)
            inp.focus()
        }
    }, 600)
}

loginOptionsCancelButton.onclick = (e) => {
    switchView(getCurrentView(), loginOptionsViewOnCancel, 500, 500, () => {
        // Clear login values (Mojang login)
        // No cleanup needed for Microsoft.
        loginUsername.value = ''
        loginPassword.value = ''
        if(loginOptionsViewCancelHandler != null){
            loginOptionsViewCancelHandler()
            loginOptionsViewCancelHandler = null
        }
    })
}