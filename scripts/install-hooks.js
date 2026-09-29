/**
 * Instala o git hook de pre-commit que valida/corrige automaticamente o distribution.json.
 * Rode: node scripts/install-hooks.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HOOK_DIR = path.join(ROOT, '.git', 'hooks')
const HOOK_PATH = path.join(HOOK_DIR, 'pre-commit')

const HOOK_CONTENT = `#!/bin/sh
#
# MidgardLauncher - Pre-commit hook
# Corrige automaticamente MD5/tamanho no distribution.json antes de cada commit.
#

CHANGED=$(git diff --cached --name-only)

NEEDS_CHECK=false
for file in $CHANGED; do
    case "$file" in
        repo/*|servers/*|distribution.json)
            NEEDS_CHECK=true
            break
            ;;
    esac
done

if [ "$NEEDS_CHECK" = false ]; then
    exit 0
fi

echo "[MidgardRP] Validando distribution.json..."
node scripts/validate-distribution.js --fix

if ! git diff --quiet distribution.json 2>/dev/null; then
    echo "[MidgardRP] distribution.json corrigido automaticamente, adicionando ao commit."
    git add distribution.json
fi

exit 0
`

if (!fs.existsSync(HOOK_DIR)) {
    fs.mkdirSync(HOOK_DIR, { recursive: true })
}

fs.writeFileSync(HOOK_PATH, HOOK_CONTENT, { mode: 0o755 })
console.log('Git hook pre-commit instalado com sucesso!')
