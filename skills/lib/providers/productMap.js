/**
 * Product map — single in-process inventory for the demo hub, /api/health,
 * and /api/stats. Provider keys come from chain.js (SSOT). Skill names are
 * the directories that actually exist under skills/.
 */
'use strict';

const { PROVIDER_CHAIN } = require('./chain');

const HUB_SKILLS = [
    { key: 'oneweb', name: 'AgentChat-OneWeb', href: 'webextended.html', kind: 'skill' },
    { key: 'independent', name: 'AgentChat-IndependentTasks', href: 'freesubagent.html', kind: 'skill' },
    { key: 'websubagent', name: 'AgentChat-WebSubAgent', href: 'workflow.html', kind: 'skill' },
    { key: 'setup', name: 'agentweb-setup', href: 'setup.html', kind: 'skill' },
    { key: 'mcp', name: 'MCP Server', href: 'mcp.html', kind: 'tool' },
    { key: 'python', name: 'Python SDK', href: 'python.html', kind: 'sdk' },
    { key: 'locales', name: 'locales', href: 'locales.html', kind: 'lib' },
];

const LANGUAGES = Object.freeze(['zh_CN', 'zh_TW', 'en', 'ja']);
const SKILLS = Object.freeze(HUB_SKILLS.filter(s => s.kind === 'skill'));
const PROVIDERS = Object.freeze(
    PROVIDER_CHAIN.map(p => Object.freeze({ key: p.key, name: p.name, url: p.url }))
);

function productMap() {
    return {
        providers: PROVIDERS,
        skills: SKILLS,
        languages: LANGUAGES,
        providerCount: PROVIDERS.length,
        skillCount: SKILLS.length,
    };
}

module.exports = { productMap, HUB_SKILLS, LANGUAGES };
