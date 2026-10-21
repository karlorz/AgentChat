'use strict';

/**
 * Where provider-extracted images land.
 *
 * Default is the user-level dir already used for sessions and .env
 * (`~/.agentchat/assets`). Saving into process.cwd() dumped `ai-image-*`
 * files into whatever repo the skill was invoked from (including this one).
 *
 * Resolution order (first non-empty wins):
 *   1. cliDir (--download-dir=PATH)
 *   2. $AGENTCHAT_ASSETS_DIR
 *   3. $AGENTCHAT_HOME/assets
 *   4. $HOME/.agentchat/assets
 *
 * Values are literal: path.resolve does not expand `~`. Relative paths
 * resolve against process.cwd(). AGENTCHAT_HOME here is dest-only;
 * sessions still live under $HOME/.agentchat/sessions.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function _nonEmpty(v) {
    return (v != null && String(v).trim()) ? String(v).trim() : '';
}

function resolveAssetsDir(cliDir) {
    const fromCli = _nonEmpty(cliDir);
    if (fromCli) return path.resolve(fromCli);

    const fromEnv = _nonEmpty(process.env.AGENTCHAT_ASSETS_DIR);
    if (fromEnv) return path.resolve(fromEnv);

    const home = _nonEmpty(process.env.AGENTCHAT_HOME)
        ? path.resolve(process.env.AGENTCHAT_HOME)
        : path.join(os.homedir(), '.agentchat');
    return path.join(home, 'assets');
}

function ensureAssetsDir(cliDir) {
    const dir = resolveAssetsDir(cliDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

module.exports = { resolveAssetsDir, ensureAssetsDir };
