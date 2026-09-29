# MidgardLauncher

Launcher desktop (Electron) do servidor Minecraft Midgard: login Microsoft, download e verificação dos arquivos
do jogo, atualização automática e notícias.

Baseado no [HeliosLauncher](https://github.com/dscalzi/HeliosLauncher) (MIT), com personalização e
funcionalidades próprias.

## O que foi adicionado

- Identidade visual e telas próprias do servidor.
- Scripts de validação da distribuição (`npm run validate`) e de proteção de assets antes do build.
- Patches no motor de download (timeouts, opções de Java) aplicados no `postinstall`.
- Atualização automática por `electron-updater` e publicação por GitHub Releases.
- `midgard-badge-api`: API serverless (Cloudflare Workers + D1) para insígnias de jogadores.
- `midgard-badge-mod` e `midgard-skiprp-mod`: mods Fabric que acompanham o launcher.

## Stack

Electron · Node.js · EJS · helios-core · Cloudflare Workers · Fabric (Java 21)

## Como rodar

```bash
npm install
npm start
```

Build para Windows: `npm run dist`.
