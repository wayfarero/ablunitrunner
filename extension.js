// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DOMParser } = require('xmldom');

// Global ABLUnit Runner output channel (singleton)
let ablUnitOutputChannel;
function getAblUnitOutputChannel() {
    if (!ablUnitOutputChannel) {
        ablUnitOutputChannel = vscode.window.createOutputChannel('ABLUnit Runner');
    }
    return ablUnitOutputChannel;
}

const STOP_ABLUNIT_COMMAND_ID = 'ABLUnitRunner._stopActiveRun';
const HAS_FAILED_TESTS_CONTEXT_KEY = 'ablunitRunner.hasFailedTests';
const LINUX_KILL_GRACE_MS = 3000;

/**
 * @typedef {Object} FailedTestEntry
 * @property {string} key
 * @property {string} filePath
 * @property {string} testName
 * @property {vscode.TestItem} testItem
 */

/** @type {Map<string, FailedTestEntry>} */
const failedTestsByKey = new Map();

/**
 * Build a normalized lookup key for matching a test case across runs.
 * @param {string} filePath
 * @param {string} testName
 * @returns {string}
 */
function makeTestLookupKey(filePath, testName) {
    const normalizedPath = path.normalize(filePath || '');
    const pathKey = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
    return `${pathKey}::${(testName || '').trim().toLowerCase()}`;
}

/**
 * Update VS Code context key controlling visibility of 'Rerun Failed Tests'.
 * @param {boolean} hasFailures
 */
function setHasFailedTestsContext(hasFailures) {
    vscode.commands.executeCommand('setContext', HAS_FAILED_TESTS_CONTEXT_KEY, Boolean(hasFailures));
}

/**
 * @typedef {Object} ActiveAblUnitSession
 * @property {import('child_process').ChildProcess | null} proc
 * @property {number | null} pid
 * @property {boolean} isCancelled
 * @property {() => void} cancel
 * @property {() => void} disposeOnDeactivate
 */

/** @type {ActiveAblUnitSession | null} */
let activeAblUnitSession = null;

/**
 * Display a warning when the user attempts to start an overlapping ABLUnit run.
 */
function showOverlappingRunWarning() {
    const pidPart = activeAblUnitSession?.pid !== null && activeAblUnitSession?.pid !== undefined
        ? ` [PID ${activeAblUnitSession.pid}]`
        : '';
    vscode.window.showWarningMessage(
        `An ABLUnit test session${pidPart} is already running. Stop the active run or wait for it to finish before starting another.`
    );
}

/**
 * Check whether a POSIX process group still has live processes.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessGroupAlive(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

/**
 * Terminate a spawned runner process tree across Windows and Linux/POSIX.
 * Returns a cleanup callback to clear any pending escalation timer.
 *
 * @param {import('child_process').ChildProcess | null} proc
 * @param {boolean} [immediate=false]
 * @returns {() => void}
 */
function terminateProcessTree(proc, immediate = false) {
    if (!proc || proc.pid === undefined || proc.pid === null) {
        return () => {};
    }

    const pid = proc.pid;

    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
            windowsHide: true,
            stdio: 'ignore'
        });
        killer.unref();
        killer.on('error', (err) => {
            console.error(`Failed to execute taskkill for PID ${pid}:`, err);
            try {
                proc.kill();
            } catch {
                // Process already exited
            }
        });
        return () => {};
    }

    const sendGroupSignal = (signal) => {
        try {
            process.kill(-pid, signal);
        } catch (err) {
            if (err && err.code !== 'ESRCH') {
                try {
                    proc.kill(signal);
                } catch {
                    // Process already exited
                }
            }
        }
    };

    if (immediate) {
        sendGroupSignal('SIGKILL');
        return () => {};
    }

    sendGroupSignal('SIGTERM');
    const escalationTimer = setTimeout(() => {
        if (isProcessGroupAlive(pid)) {
            getAblUnitOutputChannel().appendLine(`Process group ${pid} still running after ${LINUX_KILL_GRACE_MS / 1000}s; escalating to SIGKILL.`);
            sendGroupSignal('SIGKILL');
        }
    }, LINUX_KILL_GRACE_MS);

    return () => {
        clearTimeout(escalationTimer);
    };
}

/**
 * Show a status bar spinner while an ABLUnit process is running.
 * Returns helpers to update PID, stop with a transient completion message, or dispose immediately.
 *
 * @param {string} [commandId]
 * @returns {{ stop: (finalText?: string) => void, setPid: (newPid: number | undefined) => void, disposeNow: () => void }}
 */
function startAblUnitRunStatus(commandId) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    const startedAt = Date.now();
    let pid = null;
    let disposeTimer = null;

    if (commandId) {
        item.command = commandId;
    }

    const update = () => {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        const pidPart = pid !== null ? ` [PID ${pid}]` : '';
        item.text = `$(sync~spin) ABLUnit Running ${elapsedSec}s${pidPart}`;
        item.tooltip = `ABLUnit run in progress (${elapsedSec}s)${pidPart} — Click to stop`;
    };

    update();
    item.show();

    const timer = setInterval(update, 1000);
    let stopped = false;

    const stop = (finalText) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        item.command = undefined;

        if (finalText) {
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            const textWithTime = `${finalText} (${elapsedSec}s)`;
            item.text = textWithTime;
            item.tooltip = textWithTime;
            disposeTimer = setTimeout(() => {
                disposeTimer = null;
                item.dispose();
            }, 2500);
            return;
        }

        item.dispose();
    };

    const disposeNow = () => {
        stopped = true;
        clearInterval(timer);
        if (disposeTimer !== null) {
            clearTimeout(disposeTimer);
            disposeTimer = null;
        }
        item.command = undefined;
        item.dispose();
    };

    const setPid = (newPid) => {
        pid = newPid ?? null;
        update();
    };

    return { stop, setPid, disposeNow };
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {string} xmpPath
 */
function parseResultsXml(xmlPath) {
    const xml = fs.readFileSync(xmlPath, 'utf-8');
    return new DOMParser().parseFromString(xml, 'text/xml');

}


/**
 * @param {Element} node
 */

function getDirectChildrenByTag(node, tagName) {
    const result = [];

    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];

        if (child.nodeType === 1 && child.tagName === tagName) {
            result.push(child);
        }
    }

    return result;
}


function getDirectChildText(node, tagName) {
    for (let i = 0; i < node.childNodes.length; i++) {
        const child = node.childNodes[i];
        if (child.nodeType === 1 && child.tagName === tagName) {
            if (child.childNodes.length > 0) {
                return child.childNodes[0].nodeValue;
            }
        }
    }
    return '';
}


// Return true if the character at pos is a word boundary relative to ABL identifiers
function isWordBoundary(line, pos) {
    if (pos < 0 || pos >= line.length) return true;
    return !/[A-Za-z0-9_]/.test(line[pos]);
}

/**
 * Find the range of a test declaration for a given name in an ABL source file.
 * Prioritizes METHOD, then PROCEDURE, then FUNCTION lines, and falls back to
 * the first word-boundary occurrence of the test name.
 * @param {string} filePath
 * @param {string} testName
 * @returns {vscode.Range}
 */
function findAblTestRange(filePath, testName) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split(/\r?\n/);
        const nameLower = (testName || '').toLowerCase();

        const tryFindOnLines = (predicate) => {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!predicate(line)) continue;
                const lower = line.toLowerCase();
                let idx = lower.indexOf(nameLower);
                while (idx >= 0) {
                    const before = idx - 1;
                    const after = idx + testName.length;
                    if (isWordBoundary(lower, before) && isWordBoundary(lower, after)) {
                        return new vscode.Range(i, idx, i, idx + testName.length);
                    }
                    idx = lower.indexOf(nameLower, idx + 1);
                }
            }
            return undefined;
        };

        // 1) METHOD ... <name>
        const methodRange = tryFindOnLines(line => /^\s*method\b/i.test(line));
        if (methodRange) return methodRange;

        // 2) PROCEDURE <name>
        const procRange = tryFindOnLines(line => /^\s*procedure\b/i.test(line));
        if (procRange) return procRange;

        // 3) FUNCTION <name>
        const funcRange = tryFindOnLines(line => /^\s*function\b/i.test(line));
        if (funcRange) return funcRange;

        // 4) Fallback: first word-boundary occurrence anywhere
        const anyRange = tryFindOnLines(() => true);
        if (anyRange) return anyRange;
    } catch (e) {
        // ignore and fall back
    }
    return new vscode.Range(0, 0, 0, 0);
}

function findProjectRoot(startDir) {
    let currentDir = startDir;
    const fsRoot = path.parse(startDir).root;
    while (currentDir !== fsRoot) {
        const propathFile = path.join(currentDir, '.propath');
        const oedgeProjectFile = path.join(currentDir, 'openedge-project.json');
        if (fs.existsSync(propathFile) || fs.existsSync(oedgeProjectFile)) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    // Check the root directory itself
    const propathFile = path.join(currentDir, '.propath');
    const oedgeProjectFile = path.join(currentDir, 'openedge-project.json');
    if (fs.existsSync(propathFile) || fs.existsSync(oedgeProjectFile)) {
        return currentDir;
    }

    return null;
}

/**
 * Find the .metadata folder by walking up from the starting directory.
 * @param {string} startDir
 * @returns {string|null}
 */
function findMetadataRoot(startDir) {
    let currentDir = startDir;
    const fsRoot = path.parse(startDir).root;
    
    // Walk up the directory tree looking for .metadata
    while (currentDir !== fsRoot) {
        const metadataDir = path.join(currentDir, '.metadata');
        if (fs.existsSync(metadataDir)) {
            return currentDir;
        }
        currentDir = path.dirname(currentDir);
    }
    
    // Check the root directory itself
    const metadataDir = path.join(currentDir, '.metadata');
    if (fs.existsSync(metadataDir)) {
        return currentDir;
    }
    
    return null;
}




/**
 * Return a newline-separated string (one connect per line) of all `connect` values from the project's `dbConnections` array.
 * - Preserves order
 * - Removes duplicates
 * - Normalizes whitespace
 *
 * @param {Object} projectCfg
 * @returns {string}
 */
function getDbConnectsSpaceSeparated(projectCfg) {
    if (!projectCfg || !Array.isArray(projectCfg.dbConnections)) return '';

    const raw = projectCfg.dbConnections.map(d => d && d.connect).filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());

    // Remove duplicates while preserving order
    const seen = new Set();
    const unique = [];
    for (const v of raw) {
        if (!seen.has(v)) {
            seen.add(v);
            unique.push(v);
        }
    }

    // Return one connect per line so dbconn.pf contains each connection on its own row
    return unique.join('\n');
}

/**
 * Read the active OpenEdge ABL profile name from `<projectRoot>/.vscode/profile.json`.
 *
 * @param {string} projectRoot
 * @returns {string|undefined}
 */
function readActiveProfileName(projectRoot) {
    if (!projectRoot) return undefined;

    const profilePath = path.join(projectRoot, '.vscode', 'profile.json');
    if (!fs.existsSync(profilePath)) {
        return undefined;
    }

    try {
        const raw = fs.readFileSync(profilePath, 'utf8').trim();
        if (!raw) {
            return undefined;
        }

        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const candidate = parsed.profile ?? parsed.name;
            return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
        }

        return undefined;
    } catch (err) {
        console.error('Failed to read .vscode/profile.json:', err);
        return undefined;
    }
}

/**
 * Resolve and merge a named OpenEdge ABL profile from `openedge-project.json` onto root defaults,
 * following `inherits` chains recursively with cycle protection.
 *
 * @param {Object} baseCfg
 * @param {string|undefined} profileName
 * @param {{ silent?: boolean }} [options]
 * @returns {Object}
 */
function resolveOpenEdgeProfileConfig(baseCfg, profileName, options) {
    if (!baseCfg || typeof baseCfg !== 'object' || !profileName || profileName === 'default') {
        return baseCfg;
    }

    const silent = Boolean(options?.silent);
    const profiles = Array.isArray(baseCfg.profiles) ? baseCfg.profiles : [];
    const findProfile = (name) => profiles.find(p => p && typeof p === 'object' && p.name === name);

    const targetProfile = findProfile(profileName);
    if (!targetProfile) {
        if (!silent) {
            getAblUnitOutputChannel().appendLine(`Warning: OpenEdge ABL profile '${profileName}' not found in openedge-project.json; using default configuration.`);
        }
        return baseCfg;
    }

    // Build inheritance chain from derived -> root-most ancestor, guarding against cycles
    const chain = [];
    const visited = new Set();
    let current = targetProfile;

    while (current) {
        if (visited.has(current.name)) {
            if (!silent) {
                getAblUnitOutputChannel().appendLine(`Warning: Circular profile inheritance detected at '${current.name}'; stopping inheritance chain.`);
            }
            break;
        }
        visited.add(current.name);
        chain.push(current);

        const parentName = typeof current.inherits === 'string' ? current.inherits.trim() : '';
        if (!parentName || parentName === 'default') {
            break;
        }

        const parentProfile = findProfile(parentName);
        if (!parentProfile) {
            if (!silent) {
                getAblUnitOutputChannel().appendLine(`Warning: Parent OpenEdge ABL profile '${parentName}' inherited by '${current.name}' not found; stopping at root defaults.`);
            }
            break;
        }
        current = parentProfile;
    }

    const merged = { ...baseCfg };
    for (let i = chain.length - 1; i >= 0; i--) {
        const profileValue = chain[i].value;
        if (profileValue && typeof profileValue === 'object') {
            Object.assign(merged, profileValue);
        }
    }

    Object.defineProperty(merged, '_resolvedProfileName', {
        value: profileName,
        enumerable: false,
        configurable: true
    });

    return merged;
}

/**
 * Load and parse `openedge-project.json` from the supplied path, applying any active
 * custom profile from `<oeProjectRoot>/.vscode/profile.json`.
 * Returns an object (empty on missing file or parse errors).
 *
 * @param {string|undefined} filePath
 * @param {{ silent?: boolean }} [options]
 * @returns {Object}
 */
function loadOpenEdgeProjectConfig(filePath, options) {
    let cfg = {};
    let workspaceRoot;
    let oeProjectRoot;

    //vscode.window.showInformationMessage("started loadOpenEdgeProjectConfig for file: " + filePath);

    if (filePath) {
        try {
            const fileUri = vscode.Uri.file(filePath);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (workspaceFolder) {
                workspaceRoot = workspaceFolder.uri.fsPath;
            }
        } catch (err) {
            vscode.window.showErrorMessage('Failed to determine workspace folder for file: ' + (err.message || err.toString()));
            console.error('Failed to determine workspace folder for file:', err);
            return {}; // Return empty on error
        }
    }

    if (!workspaceRoot) {
        return {}; // Cannot determine a root, return empty config
    }
    
    oeProjectRoot = findProjectRoot(path.dirname(filePath));
    if (!oeProjectRoot) {
        oeProjectRoot = workspaceRoot; // Fallback
    }

    const openedgeProjectJsonPath = path.join(oeProjectRoot, 'openedge-project.json');
    const propathPath = path.join(oeProjectRoot, '.propath');

    if (fs.existsSync(openedgeProjectJsonPath)) {
        try {
            const raw = fs.readFileSync(openedgeProjectJsonPath, 'utf8');
            cfg = JSON.parse(raw);
            //vscode.window.showInformationMessage("openedge-project.json parsed: " + openedgeProjectJsonPath);
        } catch (err) {
           vscode.window.showErrorMessage('Failed to load openedge-project.json: ' + (err.message || err.toString()));
        }
    }

    const activeProfileName = readActiveProfileName(oeProjectRoot);
    if (activeProfileName) {
        cfg = resolveOpenEdgeProfileConfig(cfg, activeProfileName, options);
    }

    if (!cfg.buildPath && fs.existsSync(propathPath)) {
        try {
            const raw = fs.readFileSync(propathPath, 'utf8');
            const xml = new DOMParser().parseFromString(raw, 'text/xml');
            const propathEntries = xml.getElementsByTagName('propathentry');
            const buildPath = [];
            for (let i = 0; i < propathEntries.length; i++) {
                let pathValue = propathEntries[i].getAttribute('path');
                const kindValue = propathEntries[i].getAttribute('kind');
                if (pathValue) {
                    pathValue = pathValue.replace(/@\{ROOT\}/g, '.');
                    if (pathValue.startsWith('\\')) {
                        pathValue = '..' + pathValue;
                    }
                    if (kindValue === 'src') {
                        buildPath.push({
                            type: 'source',
                            path: pathValue
                        });
                    } else {
                        buildPath.push({
                            type: 'propath',
                            path: pathValue
                        });
                    }
                }
            }
            cfg.buildPath = buildPath;
            //vscode.window.showInformationMessage(".propath parsed: " + propathPath);

        } catch (err) {
            console.error('Failed to load or parse .propath file:', err);
        }
    }

    let metadataRoot;
    // First, try to find .metadata folder starting from the project root
    if (oeProjectRoot) {
        metadataRoot = findMetadataRoot(oeProjectRoot);
    }
    // Fallback to workspace file directory if no .metadata found
    if (!metadataRoot && vscode.workspace.workspaceFile) {
        metadataRoot = path.dirname(vscode.workspace.workspaceFile.fsPath);
    }
    // Final fallback to workspace root
    if (!metadataRoot) {
        metadataRoot = workspaceRoot;
    }

    const dbConnXmlPath = path.join(metadataRoot, '.metadata', '.plugins', 'com.openedge.pdt.project', 'databaseConnection.xml');
    const dbConnFilterPath = path.join(oeProjectRoot, '.dbconnection');
    
    if (!cfg.dbConnections && fs.existsSync(dbConnXmlPath)) {
        //vscode.window.showInformationMessage("databaseConnection.xml exists: " + dbConnXmlPath);
        try {
            let activeIds = null;
            if (fs.existsSync(dbConnFilterPath)) {
                //vscode.window.showInformationMessage(".dbconnection found: " + dbConnFilterPath);
                try {
                    const rawDbConnFilter = fs.readFileSync(dbConnFilterPath, 'utf8');
                    const xmlDbConnFilter = new DOMParser().parseFromString(rawDbConnFilter, 'text/xml');
                    const connectionEntries = xmlDbConnFilter.getElementsByTagName('connectionentry');
                    activeIds = [];
                    for (let i = 0; i < connectionEntries.length; i++) {
                        const identifier = connectionEntries[i].getAttribute('identifier');
                        if (identifier) {
                            activeIds.push(identifier);
                        }
                    }
                } catch (err) {
                    console.error('Failed to parse .dbconnection file:', err);
                    activeIds = null; // Revert to no filter if parsing fails
                }
            }

            const rawXml = fs.readFileSync(dbConnXmlPath, 'utf8');
            const xml = new DOMParser().parseFromString(rawXml, 'text/xml');
            const dbConnections = xml.getElementsByTagName('databaseconnection');
            const connections = [];

            for (let i = 0; i < dbConnections.length; i++) {
                const dbConnNode = dbConnections[i];
                const identifier = dbConnNode.getAttribute('identifier');

                if (activeIds === null || activeIds.includes(identifier)) {
                    const db = getDirectChildText(dbConnNode, 'physicalname');
                    const host = getDirectChildText(dbConnNode, 'host');
                    const service = getDirectChildText(dbConnNode, 'service');

                    if (db && host && service) {
                        const connectString = `-db ${db} -H ${host} -S ${service}`;
                        connections.push({
                            connect: connectString
                        });
                    }
                }
            }
            cfg.dbConnections = connections;
            //vscode.window.showInformationMessage("databaseConnection.xml parsed.");
        } catch (err) {
            vscode.window.showErrorMessage('Failed to load or parse databaseConnection.xml file:' + (err.message || err.toString()));
            console.error('Failed to load or parse databaseConnection.xml file:', err);
        }
    }

    return cfg;
}



/**
 * Construct the propath string for the project:
 * - Includes all buildPath entries regardless of type
 * - Normalizes escaped slashes and replaces @{DLC}, ${DLC}, @{dlc}, ${dlc} with %DLC% for expansion
 * - Removes duplicates while preserving order
 * - Joins entries using comma delimiter
 *
 * @param {Object} projectCfg
 * @returns {string}
 */
function getOpenEdgeAblRuntimeConfig(filePath) {
    try {
        const fileUri = filePath ? vscode.Uri.file(filePath) : undefined;
        const ablScopedConfig = fileUri
            ? vscode.workspace.getConfiguration('abl', fileUri)
            : vscode.workspace.getConfiguration('abl');
        const nestedRuntimes = ablScopedConfig.get('configuration.runtimes');
        if (nestedRuntimes) {
            return nestedRuntimes;
        }

        const rawScopedConfig = fileUri
            ? vscode.workspace.getConfiguration(undefined, fileUri)
            : vscode.workspace.getConfiguration();
        return rawScopedConfig.get('abl.configuration.runtimes');
    } catch (err) {
        console.error('Failed to read OpenEdge ABL runtime configuration:', err);
        return undefined;
    }
}

function normalizeRuntimeEntries(runtimeConfig) {
    if (!runtimeConfig) return [];

    if (Array.isArray(runtimeConfig)) {
        return runtimeConfig.filter(runtime => runtime);
    }

    return [];
}

function getRuntimeVersion(runtime) {
    if (runtime && typeof runtime === 'object') {
        return runtime.name;
    }
    return undefined;
}

function getRuntimeDlc(runtime) {
    if (!runtime) return undefined;
    if (typeof runtime === 'string') return runtime;
    if (typeof runtime !== 'object') return undefined;
    return runtime.dlc || runtime.DLC || runtime.path || runtime.location || runtime.installPath;
}

function resolveDlcFromOpenEdgeProject(projectCfg, runtimeConfig) {
    if (!projectCfg || typeof projectCfg !== 'object') {
        return undefined;
    }

    const projectOeVersion = projectCfg.oeversion || projectCfg.oeVersion;
    const runtimeEntries = normalizeRuntimeEntries(runtimeConfig);

    if (projectOeVersion) {
        const matchedRuntime = runtimeEntries.find(runtime => {
            const runtimeVersion = getRuntimeVersion(runtime);
            return runtimeVersion && String(runtimeVersion) === String(projectOeVersion) && !!getRuntimeDlc(runtime);
        });
        if (matchedRuntime) {
            return getRuntimeDlc(matchedRuntime);
        }
    }

    const projectDlc = projectCfg.dlc || projectCfg.DLC;
    if (projectDlc) {
        return projectDlc;
    }

    const firstRuntimeDlc = runtimeEntries.find(runtime => !!getRuntimeDlc(runtime));
    if (firstRuntimeDlc) {
        return getRuntimeDlc(firstRuntimeDlc);
    }

    return undefined;
}

function normalizeDlcPlaceholders(value) {
    if (!value) {
        return value;
    }

    return value.replace(/@\{[Dd][Ll][Cc]\}|\$\{[Dd][Ll][Cc]\}|%[Dd][Ll][Cc]%/g, '%DLC%');
}

function resolvePropathDlc(value, dlcPath) {
    if (!value || !dlcPath) {
        return value;
    }

    return expandDlcPlaceholders(value, dlcPath);
}

function buildPropathStr(projectCfg) {
    const collected = [];

    if (Array.isArray(projectCfg.buildPath)) {
        // Add all path entries regardless of type
        for (const entry of projectCfg.buildPath) {
            if (entry && entry.path) {
                let s = entry.path.replace(/\\\//g, '/');
                s = normalizeDlcPlaceholders(s);
                collected.push(s);
            }
        }
    }

    // Remove duplicates while preserving order
    const seen = new Set();
    const unique = [];
    for (const p of collected) {
        if (!p) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        unique.push(p);
    }

    return unique.join(',');
}

/**
 * Execute a shell command string in the workspace folder for the given file (or cwd fallback).
 * Streams stdout/stderr into an OutputChannel and notifies on completion.
 *
 * @param {string} commandString
 * @param {string} filePath
 * @param {function|undefined} [onCloseCommand]
 */
function expandDlcPlaceholders(value, dlcPath) {
    if (!value || !dlcPath) {
        return value;
    }

    const normalizedDlc = process.platform === 'win32'
        ? dlcPath.replace(/\//g, '\\')
        : dlcPath.replace(/\\/g, '/');
    const expanded = value.replace(
        /@\{[Dd][Ll][Cc]\}|\$\{[Dd][Ll][Cc]\}|%[Dd][Ll][Cc]%/g,
        normalizedDlc
    );

    return process.platform === 'win32'
        ? expanded.replace(/\//g, '\\')
        : expanded.replace(/\\/g, '/');
}

/**
 * Execute a shell command string in the workspace folder for the given file (or cwd fallback).
 * Streams stdout/stderr into an OutputChannel, supports cancellation, and resolves on completion.
 *
 * @param {string} commandString
 * @param {string} filePath
 * @param {function|string|undefined} [onCloseCommand]
 * @param {string|undefined} [resolvedDlc]
 * @param {{ testRun?: vscode.TestRun, cancellationToken?: vscode.CancellationToken, activeProfileName?: string }} [runOptions]
 * @returns {Promise<{ code: number | null, cancelled: boolean }>}
 */
function executeCommandString(commandString, filePath, onCloseCommand, resolvedDlc, runOptions) {
    return new Promise((resolve) => {
        const testRun = runOptions?.testRun;
        const externalToken = runOptions?.cancellationToken;
        const activeProfileName = runOptions?.activeProfileName;
        let runStatus = null;
        let clearKillTimer = () => {};
        let runTokenListener = null;
        let externalTokenListener = null;
        let settled = false;

        const endTestRunSafely = () => {
            if (!testRun) return;
            try {
                testRun.end();
            } catch (endErr) {
                console.error('Failed to end TestRun:', endErr);
            }
        };

        const cleanupSessionResources = () => {
            clearKillTimer();
            clearKillTimer = () => {};
            if (runTokenListener) {
                runTokenListener.dispose();
                runTokenListener = null;
            }
            if (externalTokenListener) {
                externalTokenListener.dispose();
                externalTokenListener = null;
            }
            activeAblUnitSession = null;
        };

        try {
            const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath || process.cwd();
            runStatus = startAblUnitRunStatus(STOP_ABLUNIT_COMMAND_ID);
            getAblUnitOutputChannel().show(true);
            if (activeProfileName) {
                getAblUnitOutputChannel().appendLine(`Using OpenEdge ABL profile: ${activeProfileName}`);
            }
            const displayCommandString = resolvedDlc ? expandDlcPlaceholders(commandString, resolvedDlc) : commandString;
            getAblUnitOutputChannel().appendLine(`Executing: ${displayCommandString}`);

            const proc = spawn(commandString, {
                shell: true,
                cwd: workspaceFolderPath,
                env: process.env,
                detached: process.platform !== 'win32'
            });
            getAblUnitOutputChannel().appendLine(`Started process with PID ${proc.pid}`);
            runStatus.setPid(proc.pid);

            const session = {
                proc,
                pid: proc.pid ?? null,
                isCancelled: false,
                cancel: () => {
                    if (session.isCancelled || settled) return;
                    session.isCancelled = true;
                    getAblUnitOutputChannel().appendLine(`Cancelling ABLUnit process${proc.pid ? ` (PID ${proc.pid})` : ''}...`);
                    clearKillTimer = terminateProcessTree(proc, false);
                },
                disposeOnDeactivate: () => {
                    if (settled) return;
                    settled = true;
                    session.isCancelled = true;
                    cleanupSessionResources();
                    terminateProcessTree(proc, true);
                    if (runStatus) {
                        runStatus.disposeNow();
                    }
                    endTestRunSafely();
                    resolve({ code: null, cancelled: true });
                }
            };
            activeAblUnitSession = session;

            if (testRun?.token) {
                if (testRun.token.isCancellationRequested) {
                    session.cancel();
                } else {
                    runTokenListener = testRun.token.onCancellationRequested(() => session.cancel());
                }
            }

            if (externalToken) {
                if (externalToken.isCancellationRequested) {
                    session.cancel();
                } else {
                    externalTokenListener = externalToken.onCancellationRequested(() => session.cancel());
                }
            }

            proc.stdout.on('data', (data) => getAblUnitOutputChannel().append(data.toString()));
            proc.stderr.on('data', (data) => getAblUnitOutputChannel().append(data.toString()));

            proc.on('error', (err) => {
                if (settled) return;
                settled = true;
                const wasCancelled = session.isCancelled;
                cleanupSessionResources();

                if (wasCancelled) {
                    runStatus.stop('$(circle-slash) ABLUnit cancelled');
                    getAblUnitOutputChannel().appendLine('ABLUnit run cancelled by user.');
                    endTestRunSafely();
                    vscode.window.showInformationMessage('ABLUnit run cancelled');
                    resolve({ code: null, cancelled: true });
                    return;
                }

                runStatus.stop('$(error) ABLUnit failed');
                getAblUnitOutputChannel().appendLine(`Failed to start process: ${err.message}`);
                endTestRunSafely();
                vscode.window.showErrorMessage(`Failed to run ABLUnit: ${err.message}`);
                resolve({ code: null, cancelled: false });
            });

            proc.on('close', (code) => {
                if (settled) return;
                settled = true;
                const wasCancelled = session.isCancelled;
                cleanupSessionResources();

                if (wasCancelled) {
                    runStatus.stop('$(circle-slash) ABLUnit cancelled');
                    getAblUnitOutputChannel().appendLine('ABLUnit run cancelled by user.');
                    endTestRunSafely();
                    vscode.window.showInformationMessage('ABLUnit run cancelled');
                    resolve({ code, cancelled: true });
                    return;
                }

                runStatus.stop(code === 0 ? '$(check) ABLUnit done' : `$(error) ABLUnit failed (${code})`);
                getAblUnitOutputChannel().appendLine(`Process exited with code ${code}`);
                const msg = code === 0 ? 'Run completed successfully' : `Run completed with exit code ${code}`;
                vscode.window.showInformationMessage(msg);

                // Optionally execute a function callback or a registered VS Code command after the process exits
                try {
                    if (onCloseCommand) {
                        if (typeof onCloseCommand === 'function') {
                            onCloseCommand(code);
                        } else {
                            vscode.commands.executeCommand(onCloseCommand);
                        }
                    }
                } catch (err) {
                    console.error('Failed to execute onCloseCommand:', err);
                } finally {
                    endTestRunSafely();
                }

                resolve({ code, cancelled: false });
            });

            vscode.window.showInformationMessage(`Executing command (see 'ABLUnit Runner' output)`);
        } catch (err) {
            settled = true;
            cleanupSessionResources();
            if (runStatus) {
                runStatus.disposeNow();
            }
            endTestRunSafely();
            console.error('Failed to execute command:', err);
            vscode.window.showErrorMessage('Failed to execute prepared command. See developer console for details.');
            resolve({ code: null, cancelled: false });
        }
    });
}

/**
 * Format a test file path (and optional test case/method name) into the target string
 * expected by ABLUnitCore.p (stripping matching source buildPath prefixes for .cls files).
 *
 * @param {string} filePath
 * @param {string|undefined} selectedTestName
 * @param {string} workdir
 * @param {Object} projectCfg
 * @returns {string}
 */
function formatAblTestTarget(filePath, selectedTestName, workdir, projectCfg) {
    const fileUri = vscode.Uri.file(filePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    let relPath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, filePath).replace(/\\/g, '/')
        : path.relative(workdir, filePath).replace(/\\/g, '/') || path.basename(filePath);

    if (filePath.toLowerCase().endsWith('.cls')) {
        const sourcePaths = projectCfg?.buildPath
            ?.filter(p => p.type === 'source' && p.path)
            .map(p => {
                let pth = p.path.replace(/\\/g, '/');
                if (pth.startsWith('./') && pth.length > 1) {
                    pth = pth.substring(2);
                } else if (pth === '.') {
                    pth = '';
                }
                return pth;
            }) || [];
        sourcePaths.sort((a, b) => b.length - a.length);

        for (const sourcePath of sourcePaths) {
            if (sourcePath && relPath.startsWith(sourcePath + '/')) {
                relPath = relPath.substring(sourcePath.length + 1);
                break;
            }
        }
    }

    const resolvedTestName = typeof selectedTestName === 'string'
        ? (selectedTestName.trim().split(/\s+/)[0] || '')
        : '';
    return resolvedTestName ? `${relPath}#${resolvedTestName}` : relPath;
}

/**
 * Normalize a filesystem path for case-appropriate identity/equality checks.
 *
 * @param {string} fsPath
 * @returns {string}
 */
function normalizeFsPathKey(fsPath) {
    const normalized = path.normalize(fsPath || '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Recursively collect `.cls` and `.p` files inside a directory in deterministic order,
 * skipping hidden/metadata/tooling directories and guarding against symlink cycles.
 *
 * @param {string} dirPath
 * @param {(filePath: string) => void} onValidFile
 * @param {Set<string>} [visitedDirs]
 */
function collectAblFilesInDirectory(dirPath, onValidFile, visitedDirs = new Set()) {
    let canonicalDir = dirPath;
    try {
        canonicalDir = fs.realpathSync(dirPath);
    } catch {
        // Fall back to dirPath if realpath resolution fails
    }

    const dirKey = normalizeFsPathKey(canonicalDir);
    if (visitedDirs.has(dirKey)) {
        return;
    }
    visitedDirs.add(dirKey);

    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
        console.error(`Failed to read directory ${dirPath}:`, err);
        return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const shouldSkipSubdir = (name) => !name || name.startsWith('.') || name.toLowerCase() === 'node_modules';
    const isAblTestFileName = (name) => {
        const lower = name.toLowerCase();
        return lower.endsWith('.cls') || lower.endsWith('.p');
    };

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (!shouldSkipSubdir(entry.name)) {
                collectAblFilesInDirectory(fullPath, onValidFile, visitedDirs);
            }
            continue;
        }

        if (entry.isFile()) {
            if (isAblTestFileName(entry.name)) {
                onValidFile(fullPath);
            }
            continue;
        }

        if (entry.isSymbolicLink()) {
            try {
                const targetStat = fs.statSync(fullPath);
                if (targetStat.isDirectory() && !shouldSkipSubdir(entry.name)) {
                    collectAblFilesInDirectory(fullPath, onValidFile, visitedDirs);
                } else if (targetStat.isFile() && isAblTestFileName(entry.name)) {
                    onValidFile(fullPath);
                }
            } catch {
                // Ignore broken symlinks inside expanded folders
            }
        }
    }
}

/**
 * Resolve and filter arguments passed to `ABLUnitRunner.RunABLUnitOnFile` across Explorer
 * file/folder multi-selection (`vscode.Uri[]`), single-test reruns (`string`), Editor menus, and Command Palette.
 *
 * @param {vscode.Uri|undefined} resource
 * @param {vscode.Uri[]|string|undefined} secondArg
 * @returns {{
 *   hasCandidates: boolean,
 *   validFiles: string[],
 *   emptyDirs: string[],
 *   skippedItems: Array<{ filePath: string, reason: string }>,
 *   selectedTestName: string|undefined
 * }}
 */
function resolveRunFileSelection(resource, secondArg) {
    const reviveUriSafe = (candidate) => {
        if (!candidate) return undefined;
        try {
            const revived = vscode.Uri.revive(candidate);
            return revived?.fsPath ? revived : undefined;
        } catch {
            return typeof candidate.fsPath === 'string' && candidate.fsPath ? candidate : undefined;
        }
    };

    const isExplorerSelection = Array.isArray(secondArg);
    const selectedTestName = !isExplorerSelection && typeof secondArg === 'string'
        ? secondArg
        : undefined;

    const rawUris = isExplorerSelection
        ? (secondArg.length > 0 ? secondArg : (resource ? [resource] : []))
        : [reviveUriSafe(resource) || vscode.window.activeTextEditor?.document.uri].filter(Boolean);

    const seenCandidateKeys = new Set();
    const candidatePaths = [];
    for (const candidate of rawUris) {
        const uri = reviveUriSafe(candidate);
        if (!uri?.fsPath) continue;
        const key = normalizeFsPathKey(uri.fsPath);
        if (!seenCandidateKeys.has(key)) {
            seenCandidateKeys.add(key);
            candidatePaths.push(uri.fsPath);
        }
    }

    const validFiles = [];
    const seenValidKeys = new Set();
    const addValidFile = (filePath) => {
        const key = normalizeFsPathKey(filePath);
        if (!seenValidKeys.has(key)) {
            seenValidKeys.add(key);
            validFiles.push(filePath);
        }
    };

    const emptyDirs = [];
    const skippedItems = [];
    const visitedDirs = new Set();
    for (const candidatePath of candidatePaths) {
        let stat;
        try {
            stat = fs.statSync(candidatePath);
        } catch {
            skippedItems.push({ filePath: candidatePath, reason: 'file not found' });
            continue;
        }

        if (stat.isDirectory()) {
            const countBefore = validFiles.length;
            collectAblFilesInDirectory(candidatePath, addValidFile, visitedDirs);
            if (validFiles.length === countBefore) {
                emptyDirs.push(candidatePath);
            }
            continue;
        }
        if (!stat.isFile()) {
            skippedItems.push({ filePath: candidatePath, reason: 'not a regular file' });
            continue;
        }

        const lowerPath = candidatePath.toLowerCase();
        if (!lowerPath.endsWith('.cls') && !lowerPath.endsWith('.p')) {
            skippedItems.push({ filePath: candidatePath, reason: 'unsupported file extension' });
            continue;
        }

        addValidFile(candidatePath);
    }

    return {
        hasCandidates: candidatePaths.length > 0,
        validFiles,
        emptyDirs,
        skippedItems,
        selectedTestName
    };
}

/**
 * Verify that all resolved test files and any selected empty folders belong to the same
 * VS Code workspace folder and the same OpenEdge project root.
 *
 * @param {string[]} filePaths
 * @param {string[]} [emptyDirs=[]]
 * @returns {boolean}
 */
function areSelectionScopesInSameWorkspaceAndProject(filePaths, emptyDirs = []) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return true;
    }

    const resolveScopeKeys = (targetPath, isDirectory) => {
        const startDir = isDirectory ? targetPath : path.dirname(targetPath);
        const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetPath))?.uri.fsPath || '';
        const oeProjectRoot = findProjectRoot(startDir) || wsFolder || startDir;
        return {
            workspaceKey: normalizeFsPathKey(wsFolder),
            projectKey: normalizeFsPathKey(oeProjectRoot)
        };
    };

    const baseKeys = resolveScopeKeys(filePaths[0], false);

    for (let i = 1; i < filePaths.length; i++) {
        const currentKeys = resolveScopeKeys(filePaths[i], false);
        if (currentKeys.workspaceKey !== baseKeys.workspaceKey || currentKeys.projectKey !== baseKeys.projectKey) {
            return false;
        }
    }

    for (const dirPath of emptyDirs) {
        const dirPrefix = normalizeFsPathKey(dirPath) + path.sep;
        const containsAlreadySelectedFile = filePaths.some(fp => normalizeFsPathKey(fp).startsWith(dirPrefix));
        if (containsAlreadySelectedFile) {
            continue;
        }
        const dirKeys = resolveScopeKeys(dirPath, true);
        if (dirKeys.workspaceKey !== baseKeys.workspaceKey || dirKeys.projectKey !== baseKeys.projectKey) {
            return false;
        }
    }

    return true;
}

/**
 * Index existing test case and suite items currently in the TestController tree.
 *
 * @param {vscode.TestController} controller
 * @returns {{ testsByKey: Map<string, vscode.TestItem>, suitesByPath: Map<string, vscode.TestItem> }}
 */
function indexExistingControllerItems(controller) {
    const testsByKey = new Map();
    const suitesByPath = new Map();

    const normalizePathKey = (fsPath) => {
        const norm = path.normalize(fsPath || '');
        return process.platform === 'win32' ? norm.toLowerCase() : norm;
    };

    const visitCollection = (collection) => {
        if (!collection || typeof collection.forEach !== 'function') {
            return;
        }
        collection.forEach((item) => {
            if (item.uri?.fsPath) {
                if (item.contextValue === 'ablunitTest' || item.id.includes(':')) {
                    const colonIdx = item.id.lastIndexOf(':');
                    const rawName = colonIdx >= 0
                        ? item.id.substring(colonIdx + 1)
                        : (item.label || '').trim().split(/\s+/)[0];
                    const key = makeTestLookupKey(item.uri.fsPath, rawName);
                    testsByKey.set(key, item);
                } else {
                    suitesByPath.set(normalizePathKey(item.uri.fsPath), item);
                }
            }
            if (item.children) {
                visitCollection(item.children);
            }
        });
    };

    visitCollection(controller.items);
    return { testsByKey, suitesByPath };
}

/**
 * @param {vscode.TestController} controller
 * @param {string} xmlPath
 * @param {vscode.TestRun} run
 * @param {string} [baseWorkspacePath] - Override the base workspace path for resolving test file paths
 * @param {Object} [projectCfg] - Project configuration for source path resolution
 * @param {{ merge?: boolean }} [options] - When merge is true, updates existing TestItems in-place
 */
function loadAblUnitResults(controller, xmlPath, run, baseWorkspacePath, projectCfg, options) {
    const isMerge = Boolean(options?.merge);

    getAblUnitOutputChannel().appendLine(`Start loading AblUnit results..`);    

    vscode.commands.executeCommand('workbench.view.testing');
    vscode.commands.executeCommand('testing.showMostRecentOutput');
    
    const existingIndex = isMerge
        ? indexExistingControllerItems(controller)
        : { testsByKey: new Map(), suitesByPath: new Map() };

    if (!isMerge) {
        // Clear previous test items and failed-test tracking on full/non-merged runs
        controller.items.replace([]);
        failedTestsByKey.clear();
    }

    const xml = parseResultsXml(xmlPath);

    // Use provided baseWorkspacePath, or fallback to workspace folder detection or directory of xmlPath
    if (!baseWorkspacePath) {
        const xmlWorkspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xmlPath));
        baseWorkspacePath = xmlWorkspaceFolder ? xmlWorkspaceFolder.uri.fsPath : path.dirname(xmlPath);
    }

    // Extract source paths from project config
    const sourcePaths = projectCfg && Array.isArray(projectCfg.buildPath)
        ? projectCfg.buildPath
            .filter(p => p.type === 'source' && p.path)
            .map(p => {
                let pth = p.path.replace(/\\\//g, '/');
                // Remove leading './' if it exists and path is not just '.'
                if (pth.startsWith('./') && pth.length > 1) {
                    pth = pth.substring(2);
                } else if (pth === '.') {
                    pth = '';
                }
                return pth;
            })
        : [];
    
    // Sort by longest path first to match the most specific path
    sourcePaths.sort((a, b) => b.length - a.length);

    const normalizeSuitePathKey = (fsPath) => {
        const norm = path.normalize(fsPath || '');
        return process.platform === 'win32' ? norm.toLowerCase() : norm;
    };

    function addSuiteRecursive(suiteNode, parentItem) {
        const suiteName = suiteNode.getAttribute("classname") || suiteNode.getAttribute("name") || "UnnamedSuite";
        const suiteFile = suiteNode.getAttribute("name") || "";
        const suiteId = suiteNode.getAttribute("id") || Math.random().toString(36).substr(2, 9);
        
        // Try to find the correct path by checking source paths first
        let suitePath = null;
        if (path.isAbsolute(suiteFile)) {
            suitePath = suiteFile;
        } else {
            // Try each source path to see which one exists
            for (const sourcePath of sourcePaths) {
                const candidatePath = path.join(baseWorkspacePath, sourcePath, suiteFile);
                if (fs.existsSync(candidatePath)) {
                    suitePath = candidatePath;
                    break;
                }
            }
            // Fallback: try without source path
            if (!suitePath) {
                suitePath = path.join(baseWorkspacePath, suiteFile);
            }
        }
        
        const suiteUri = vscode.Uri.file(suitePath);
        let suiteItem = isMerge ? existingIndex.suitesByPath.get(normalizeSuitePathKey(suitePath)) : undefined;
        if (!suiteItem) {
            suiteItem = controller.createTestItem(suiteId, suiteName, suiteUri);
            suiteItem.contextValue = "ablunitSuite";
            if (parentItem) {
                parentItem.children.add(suiteItem);
            } else {
                controller.items.add(suiteItem);
            }
            if (isMerge) {
                existingIndex.suitesByPath.set(normalizeSuitePathKey(suitePath), suiteItem);
            }
        }

        // Add nested suites recursively
        const nestedSuites = getDirectChildrenByTag(suiteNode, "testsuite");
        for (let i = 0; i < nestedSuites.length; i++) {
            addSuiteRecursive(nestedSuites[i], suiteItem);
        }

        // Add test cases
        const testCaseNodes = getDirectChildrenByTag(suiteNode, "testcase");
        for (let j = 0; j < testCaseNodes.length; j++) {
            const testNode = testCaseNodes[j];
            const testName = testNode.getAttribute("name") || "UnnamedTest";
            const testTime = testNode.getAttribute('time') || '0.000';
            const testStatus = testNode.getAttribute("status");
            const testFile = suiteFile;
            
            // Try to find the correct path by checking source paths first
            let testPath = null;
            if (path.isAbsolute(testFile)) {
                testPath = testFile;
            } else {
                // Try each source path to see which one exists
                for (const sourcePath of sourcePaths) {
                    const candidatePath = path.join(baseWorkspacePath, sourcePath, testFile);
                    if (fs.existsSync(candidatePath)) {
                        testPath = candidatePath;
                        break;
                    }
                }
                // Fallback: try without source path
                if (!testPath) {
                    testPath = path.join(baseWorkspacePath, testFile);
                }
            }
            
            const uri = vscode.Uri.file(testPath);
            const range = findAblTestRange(uri.fsPath, testName);
            const lookupKey = makeTestLookupKey(uri.fsPath, testName);
            let testItem = isMerge ? existingIndex.testsByKey.get(lookupKey) : undefined;
            if (testItem) {
                testItem.label = testName + ' (' + testTime + ')';
                testItem.range = range;
            } else {
                const testId = `${suiteItem.id}:${testName}`;
                testItem = controller.createTestItem(testId, testName + ' (' + testTime + ')', uri);
                testItem.contextValue = "ablunitTest";
                testItem.range = range;
                suiteItem.children.add(testItem);
                if (isMerge) {
                    existingIndex.testsByKey.set(lookupKey, testItem);
                }
            }

            if (testStatus === "Success") {
                testItem.busy = false;
                testItem.error = undefined;
                failedTestsByKey.delete(lookupKey);
                run.passed(testItem);
            } else if (testStatus === "Error" || testStatus === "Failure") {
                testItem.busy = false;
                const errorNode = testNode.getElementsByTagName(testStatus.toLowerCase())[0];
                let errorMessage = "";
                let errorType = "Unknown error";
                let fullErrorText = "";
                if (errorNode) {
                    errorMessage = errorNode.getAttribute("message") || "";
                    errorType = errorNode.getAttribute("type") || "Unknown error";
                    if (errorNode.childNodes && errorNode.childNodes.length > 0) {
                        fullErrorText = errorNode.childNodes[0].nodeValue || "";
                    }
                }
                const displayMessage = errorMessage && errorMessage.trim() ? errorMessage : (errorType && errorType.trim() ? errorType : "Test failed");
                testItem.error = displayMessage;
                const fullErrorDetails = fullErrorText && fullErrorText.trim() ? fullErrorText : displayMessage;

                // Improved: Find the line in the error text that contains the test method name, extract the line number from that line
                let errorLine = null;
                if (fullErrorText && testName) {
                    const lines = fullErrorText.split(/\r?\n/);
                    for (const line of lines) {
                        if (line.includes(testName)) {
                            const match = /line\s+(\d+)/i.exec(line);
                            if (match && match[1]) {
                                errorLine = parseInt(match[1], 10) - 1; // VSCode lines are 0-based
                                break;
                            }
                        }
                    }
                }
                // Fallback: try to extract from errorMessage or anywhere in fullErrorText
                if (errorLine === null) {
                    const lineMatch = /line\s+(\d+)/i.exec(errorMessage) || /line\s+(\d+)/i.exec(fullErrorText);
                    if (lineMatch && lineMatch[1]) {
                        errorLine = parseInt(lineMatch[1], 10) - 1;
                    }
                }
                // Only use the error line for the error marker, not for navigation
                let errorRange = null;
                if (errorLine !== null && !isNaN(errorLine)) {
                    errorRange = new vscode.Range(errorLine, 0, errorLine, 1000);
                }
                const testMsg = new vscode.TestMessage(errorType + ": " + displayMessage + "\n" + fullErrorDetails);
                if (errorRange) {
                    testMsg.location = new vscode.Location(uri, errorRange);
                }
                failedTestsByKey.set(lookupKey, {
                    key: lookupKey,
                    filePath: uri.fsPath,
                    testName,
                    testItem
                });
                run.failed(testItem, [testMsg]);
            }
        }
    }

    // Start recursion for all top-level suites (direct children of <testsuites>)
    const testsuitesRoot = xml.getElementsByTagName("testsuites")[0];
    if (testsuitesRoot) {
        const topSuites = getDirectChildrenByTag(testsuitesRoot, "testsuite");
        for (let i = 0; i < topSuites.length; i++) {
            addSuiteRecursive(topSuites[i], null);
        }
    } else {
        // Fallback: if no <testsuites> root, treat all <testsuite> as top-level
        const testSuites = xml.getElementsByTagName("testsuite");
        for (let i = 0; i < testSuites.length; i++) {
            addSuiteRecursive(testSuites[i], null);
        }
    }
    setHasFailedTestsContext(failedTestsByKey.size > 0);
    getAblUnitOutputChannel().appendLine(`Done loading AblUnit results.`);    

}


/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

    // Navigate to test method in editor when a test is selected in the Test Explorer
    if (vscode.tests.onDidChangeTestSelection) {
        const testSelectionDisposable = vscode.tests.onDidChangeTestSelection(e => {
            if (!e.selected || e.selected.length !== 1) return;
            const testItem = e.selected[0];
            if (testItem.uri && testItem.range) {
                vscode.window.showTextDocument(testItem.uri, { selection: testItem.range, preview: true });
            }
        });
        context.subscriptions.push(testSelectionDisposable);
    }

	// Use the console to output diagnostic information (console.>log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension ABLUnit Runner is now active!');

	const controller = vscode.tests.createTestController('ablunitController', 'ABLUnit Tests');
    context.subscriptions.push(controller);
    setHasFailedTestsContext(false);

    // Register handler for running tests (via CodeLens, Test Results view, etc.)
    const runProfile = controller.createRunProfile(
        'Run ABLUnit Tests',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
            if (activeAblUnitSession) {
                showOverlappingRunWarning();
                return;
            }
            const tests = request.include || [];
            for (const test of tests) {
                if (token?.isCancellationRequested) {
                    break;
                }
                // Extract test name from test ID (format: "suiteId:testName")
                const testName = test.id.includes(':') ? test.id.split(':')[1] : undefined;
                // Run the test using the existing command
                const result = await vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', test.uri, testName, token);
                if (token?.isCancellationRequested || result?.cancelled) {
                    break;
                }
            }
        },
        true // isDefault
    );
    context.subscriptions.push(runProfile);

    // Internal-only command bound to the status bar spinner to confirm and cancel an active run
    const stopAblUnitRun = vscode.commands.registerCommand(STOP_ABLUNIT_COMMAND_ID, async function () {
        if (!activeAblUnitSession || activeAblUnitSession.isCancelled) {
            return;
        }
        const sessionSnapshot = activeAblUnitSession;
        const pidLabel = sessionSnapshot.pid !== null ? ` [PID ${sessionSnapshot.pid}]` : '';
        const choice = await vscode.window.showWarningMessage(
            `Stop the running ABLUnit test session${pidLabel}?`,
            { modal: true },
            'Stop'
        );
        if (choice === 'Stop' && activeAblUnitSession === sessionSnapshot && !sessionSnapshot.isCancelled) {
            sessionSnapshot.cancel();
        }
    });
    context.subscriptions.push(stopAblUnitRun);


	// Internal helper: read the project's `results.xml` (optionally from a supplied project folder) and load it into the test controller
	function readResultsXml(outputFolder, baseWorkspacePath, projectCfg, existingRun, options) {
		//vscode.window.showInformationMessage('Refreshing ABLUnit results...');

		let resultsFile;
		if (outputFolder) {
			resultsFile = path.join(outputFolder, 'results.xml');
		} else {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders) {
				vscode.window.showErrorMessage('Open a workspace to read results.xml');
				return;
			}
			resultsFile = path.join(workspaceFolders[0].uri.fsPath, 'results.xml');
		}

		if (!fs.existsSync(resultsFile)) {
			vscode.window.showErrorMessage(`results.xml not found at ${resultsFile}`);
			return;
		}
		
		const ownsRun = !existingRun;
		const run = existingRun || controller.createTestRun(new vscode.TestRunRequest());

		try {
			loadAblUnitResults(controller, resultsFile, run, baseWorkspacePath, projectCfg, options);
		} catch (err) {
			console.error('Failed to parse or load results.xml:', err);
			vscode.window.showErrorMessage('Failed to load ABLUnit results.xml: ' + (err.message || err.toString()));
		} finally {
			if (ownsRun) {
				run.end();
			}
		}

//		vscode.window.showInformationMessage('ABLUnit results refreshed.');

}


    const runABLUnitOnFile = vscode.commands.registerCommand('ABLUnitRunner.RunABLUnitOnFile', function (resource, secondArg, cancellationToken) {
        // Guard against overlapping runs before touching output channel, TestController, or .ablunitrunner files
        if (activeAblUnitSession) {
            showOverlappingRunWarning();
            return Promise.resolve({ code: null, cancelled: false });
        }

        const {
            hasCandidates,
            validFiles,
            emptyDirs,
            skippedItems,
            selectedTestName
        } = resolveRunFileSelection(resource, secondArg);

        if (!hasCandidates) {
            vscode.window.showInformationMessage('ABLUnit: No file selected');
            return Promise.resolve({ code: null, cancelled: false });
        }

        if (validFiles.length === 0) {
            if (skippedItems.length > 0) {
                getAblUnitOutputChannel().clear();
                for (const skipped of skippedItems) {
                    getAblUnitOutputChannel().appendLine(`Skipping unsupported item (${skipped.reason}): ${skipped.filePath}`);
                }
            }
            vscode.window.showInformationMessage('ABLUnit: No valid .cls or .p test files selected');
            return Promise.resolve({ code: null, cancelled: false });
        }

        if ((validFiles.length > 1 || emptyDirs.length > 0) && !areSelectionScopesInSameWorkspaceAndProject(validFiles, emptyDirs)) {
            vscode.window.showWarningMessage(
                'Selected files or folders span multiple workspace folders or OpenEdge projects. Please select items within the same project.'
            );
            return Promise.resolve({ code: null, cancelled: false });
        }

        const primaryFilePath = validFiles[0];

        // Start each run with a clean output channel and log any skipped items from multi-selection
        getAblUnitOutputChannel().clear();
        for (const skipped of skippedItems) {
            getAblUnitOutputChannel().appendLine(`Skipping unsupported item (${skipped.reason}): ${skipped.filePath}`);
        }

        // Attempt to load OpenEdge project configuration from the workspace folder containing the selected file(s)
        let projectCfg = {};
        projectCfg = loadOpenEdgeProjectConfig(primaryFilePath);

        // Read DLC from the OpenEdge ABL project config when available, using the
        // runtime entry that matches the project's oeversion. Fall back to the
        // environment variable when the Riverside project config is absent or incomplete.
        const dlcEnv = process.env.DLC || process.env.dlc;
        const runtimeConfig = getOpenEdgeAblRuntimeConfig(primaryFilePath);
        const projectDlc = resolveDlcFromOpenEdgeProject(projectCfg, runtimeConfig);
        const hasRiversideProjectConfig = !!(projectCfg && (
            projectCfg.oeversion ||
            projectCfg.oeVersion ||
            runtimeConfig ||
            (Array.isArray(projectCfg.buildPath) && projectCfg.buildPath.length > 0) ||
            (Array.isArray(projectCfg.dbConnections) && projectCfg.dbConnections.length > 0) ||
            projectCfg.extraParameters ||
            projectCfg.propath
        ));
        const effectiveDlc = projectDlc || dlcEnv;
        if (!effectiveDlc) {
            vscode.window.showErrorMessage('DLC could not be resolved. Set environment variable DLC or configure abl.configuration.runtimes to match openedge-project.json oeversion.');
            return Promise.resolve({ code: null, cancelled: false });
        }

        const fallbackProjectCfg = !hasRiversideProjectConfig && effectiveDlc
            ? { ...projectCfg, buildPath: [{ type: 'propath', path: effectiveDlc }] }
            : projectCfg;

        // Extract fields and build pieces
        const isWindows = process.platform === 'win32';
        const runner = path.join(context.extensionPath, 'resources', 'scripts', isWindows ? 'run_ABLUNIT.bat' : 'run_ABLUNIT.sh');
        const runnerCommand = isWindows ? `"${runner}"` : `sh "${runner}"`;
        const extraParams = fallbackProjectCfg.extraParameters || '';
        const propathStr = buildPropathStr(fallbackProjectCfg);
        const resolvedPropathStr = resolvePropathDlc(propathStr, effectiveDlc);
        const dbConnectStr = getDbConnectsSpaceSeparated(fallbackProjectCfg);

        // Resolve workspace folder and build single or comma-separated relative test target(s)
        const primaryUri = vscode.Uri.file(primaryFilePath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(primaryUri);
        const workdir = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(primaryFilePath);

        const seenTargets = new Set();
        const targetList = [];
        const targetTestName = validFiles.length === 1 ? selectedTestName : undefined;
        for (const targetFilePath of validFiles) {
            const target = formatAblTestTarget(targetFilePath, targetTestName, workdir, projectCfg);
            if (target && !seenTargets.has(target)) {
                seenTargets.add(target);
                targetList.push(target);
            }
        }
        const testFileArg = targetList.join(',');

        const outputFolder = path.join(workdir, '.ablunitrunner');

        // Clear the Testing view and previous results immediately
        try {
            controller.items.replace([]);
            controller.invalidateTestResults();
            failedTestsByKey.clear();
            setHasFailedTestsContext(false);
        } catch (clearErr) {
            console.error('Failed to clear testing view/results:', clearErr);
        }

        try {
            if (!fs.existsSync(outputFolder)){
                fs.mkdirSync(outputFolder, { recursive: true });
            }

            const dbConnFilePath = path.join(outputFolder, 'dbconn.pf');
            fs.writeFileSync(dbConnFilePath, dbConnectStr, 'utf8');

            const extraPfPath = path.join(outputFolder,'extra.pf');
            fs.writeFileSync(extraPfPath, extraParams || '', 'utf8');

            // Remove any previous results.xml at the start of the run
            const resultsXmlPath = path.join(outputFolder, 'results.xml');
            try {
                if (fs.existsSync(resultsXmlPath)) {
                    fs.unlinkSync(resultsXmlPath);
                }
            } catch (delErr) {
                console.error('Failed to delete previous results.xml:', delErr);
                // Non-fatal: continue with the run even if deletion fails
            }
        } catch (err) {
            console.error('Failed to write to .ablunitrunner folder:', err);
            vscode.window.showErrorMessage('Failed to write to .ablunitrunner folder: ' + err.message);
            return Promise.resolve({ code: null, cancelled: false });
        }

        // Open an active TestRun for the duration of execution so VS Code's native Testing 'Stop' button is enabled
        let activeTestRun;
        try {
            activeTestRun = controller.createTestRun(new vscode.TestRunRequest(), 'ABLUnit Test Run', true);
            vscode.commands.executeCommand('workbench.view.testing');
            vscode.commands.executeCommand('testing.showMostRecentOutput');
        } catch (runErr) {
            console.error('Failed to create active TestRun:', runErr);
        }

        const commandString = `${runnerCommand} --workdir "${workdir}" --testfile "${testFileArg}"` +
            (resolvedPropathStr ? ` --propath "${resolvedPropathStr}"` : '') +
            (effectiveDlc ? ` --dlc "${effectiveDlc}"` : '');

        // Execute the prepared command in the workspace folder and run the internal refresh when it finishes.
        // Log the fully expanded DLC path for readability while still passing the original command string
        // to the shell so Windows can resolve %DLC% expansions during execution.
        return executeCommandString(
            commandString,
            workdir,
            () => readResultsXml(outputFolder, workdir, fallbackProjectCfg, activeTestRun),
            effectiveDlc,
            { testRun: activeTestRun, cancellationToken, activeProfileName: projectCfg._resolvedProfileName }
        );
    });

    const runABLUnitOnTestItem = vscode.commands.registerCommand('ABLUnitRunner.RunABLUnitOnTestItem', function (testItemOrItems) {
        const selected = Array.isArray(testItemOrItems) ? testItemOrItems[0] : testItemOrItems;

        const reviveUri = (candidate) => {
            if (!candidate) return undefined;
            try {
                return vscode.Uri.revive(candidate);
            } catch {
                return undefined;
            }
        };

        // Supports both:
        // - testing/item/context (TestItem-like args)
        // - testing/item/result (ITestItemContext-style args with tests[] payload)
        const testUri = reviveUri(selected?.uri)
            || reviveUri(selected?.tests?.[0]?.uri)
            || reviveUri(selected?.tests?.[0]?.item?.uri)
            || reviveUri(selected?.test?.uri)
            || reviveUri(selected?.item?.uri);

        const selectedTestName = selected?.label
            || selected?.tests?.[0]?.label
            || selected?.tests?.[0]?.item?.label
            || selected?.test?.label
            || selected?.item?.label;

        const selectedTestId = selected?.id
            || selected?.tests?.[0]?.id
            || selected?.tests?.[0]?.item?.extId
            || selected?.tests?.[0]?.item?.id
            || selected?.test?.id
            || selected?.item?.id;

        if (!testUri?.fsPath) {
            vscode.window.showInformationMessage('ABLUnit: Selected test item has no source file path');
            return;
        }

        const lower = testUri.fsPath.toLowerCase();
        if (!lower.endsWith('.cls') && !lower.endsWith('.p')) {
            vscode.window.showInformationMessage('ABLUnit: Selected test item is not an ABL .cls or .p file');
            return;
        }

        // Distinguish a single test item from a suite/group item:
        // our generated test IDs are in the form "<suiteId>:<testName>".
        const isSingleTest = typeof selectedTestId === 'string' && selectedTestId.includes(':');

        if (isSingleTest) {
            return vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri, selectedTestName);
        }

        return vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri);
    });

    const runABLUnitOnTestSuite = vscode.commands.registerCommand('ABLUnitRunner.RunABLUnitOnTestSuite', function (testItemOrItems) {
        const selected = Array.isArray(testItemOrItems) ? testItemOrItems[0] : testItemOrItems;

        const reviveUri = (candidate) => {
            if (!candidate) return undefined;
            try {
                return vscode.Uri.revive(candidate);
            } catch {
                return undefined;
            }
        };

        const testUri = reviveUri(selected?.uri)
            || reviveUri(selected?.tests?.[0]?.uri)
            || reviveUri(selected?.tests?.[0]?.item?.uri)
            || reviveUri(selected?.test?.uri)
            || reviveUri(selected?.item?.uri);

        if (!testUri?.fsPath) {
            vscode.window.showInformationMessage('ABLUnit: Selected test item has no source file path');
            return;
        }

        const lower = testUri.fsPath.toLowerCase();
        if (!lower.endsWith('.cls') && !lower.endsWith('.p')) {
            vscode.window.showInformationMessage('ABLUnit: Selected test item is not an ABL .cls or .p file');
            return;
        }

        // Suite rerun: always execute against the suite file without #<testName> suffix.
        return vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri);
    });

    const rerunFailedTests = vscode.commands.registerCommand('ABLUnitRunner.RerunFailedTests', function () {
        if (activeAblUnitSession) {
            showOverlappingRunWarning();
            return Promise.resolve({ code: null, cancelled: false });
        }

        const failedEntries = Array.from(failedTestsByKey.values());
        if (failedEntries.length === 0) {
            setHasFailedTestsContext(false);
            vscode.window.showInformationMessage('ABLUnit: No failed tests to rerun');
            return Promise.resolve({ code: null, cancelled: false });
        }

        const primaryFilePath = failedEntries[0].filePath;
        getAblUnitOutputChannel().clear();

        const projectCfg = loadOpenEdgeProjectConfig(primaryFilePath);
        const dlcEnv = process.env.DLC || process.env.dlc;
        const runtimeConfig = getOpenEdgeAblRuntimeConfig(primaryFilePath);
        const projectDlc = resolveDlcFromOpenEdgeProject(projectCfg, runtimeConfig);
        const hasRiversideProjectConfig = !!(projectCfg && (
            projectCfg.oeversion ||
            projectCfg.oeVersion ||
            runtimeConfig ||
            (Array.isArray(projectCfg.buildPath) && projectCfg.buildPath.length > 0) ||
            (Array.isArray(projectCfg.dbConnections) && projectCfg.dbConnections.length > 0) ||
            projectCfg.extraParameters ||
            projectCfg.propath
        ));
        const effectiveDlc = projectDlc || dlcEnv;
        if (!effectiveDlc) {
            vscode.window.showErrorMessage('DLC could not be resolved. Set environment variable DLC or configure abl.configuration.runtimes to match openedge-project.json oeversion.');
            return Promise.resolve({ code: null, cancelled: false });
        }

        const fallbackProjectCfg = !hasRiversideProjectConfig && effectiveDlc
            ? { ...projectCfg, buildPath: [{ type: 'propath', path: effectiveDlc }] }
            : projectCfg;

        const isWindows = process.platform === 'win32';
        const runner = path.join(context.extensionPath, 'resources', 'scripts', isWindows ? 'run_ABLUNIT.bat' : 'run_ABLUNIT.sh');
        const runnerCommand = isWindows ? `"${runner}"` : `sh "${runner}"`;
        const extraParams = fallbackProjectCfg.extraParameters || '';
        const propathStr = buildPropathStr(fallbackProjectCfg);
        const resolvedPropathStr = resolvePropathDlc(propathStr, effectiveDlc);
        const dbConnectStr = getDbConnectsSpaceSeparated(fallbackProjectCfg);

        const primaryUri = vscode.Uri.file(primaryFilePath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(primaryUri);
        const workdir = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(primaryFilePath);

        // Build deduplicated comma-separated "<relPath>#<testName>" list for a single _progres batch session
        const seenTargets = new Set();
        const targetList = [];
        const cfgByDir = new Map([[path.dirname(primaryFilePath), projectCfg]]);
        for (const entry of failedEntries) {
            const entryDir = path.dirname(entry.filePath);
            let entryCfg = cfgByDir.get(entryDir);
            if (!entryCfg) {
                entryCfg = loadOpenEdgeProjectConfig(entry.filePath, { silent: true });
                cfgByDir.set(entryDir, entryCfg);
            }
            const target = formatAblTestTarget(entry.filePath, entry.testName, workdir, entryCfg);
            if (target && !seenTargets.has(target)) {
                seenTargets.add(target);
                targetList.push(target);
            }
        }
        const testFileArg = targetList.join(',');

        const outputFolder = path.join(workdir, '.ablunitrunner');
        try {
            if (!fs.existsSync(outputFolder)) {
                fs.mkdirSync(outputFolder, { recursive: true });
            }

            const dbConnFilePath = path.join(outputFolder, 'dbconn.pf');
            fs.writeFileSync(dbConnFilePath, dbConnectStr, 'utf8');

            const extraPfPath = path.join(outputFolder, 'extra.pf');
            fs.writeFileSync(extraPfPath, extraParams || '', 'utf8');

            const resultsXmlPath = path.join(outputFolder, 'results.xml');
            try {
                if (fs.existsSync(resultsXmlPath)) {
                    fs.unlinkSync(resultsXmlPath);
                }
            } catch (delErr) {
                console.error('Failed to delete previous results.xml:', delErr);
            }
        } catch (err) {
            console.error('Failed to write to .ablunitrunner folder:', err);
            vscode.window.showErrorMessage('Failed to write to .ablunitrunner folder: ' + err.message);
            return Promise.resolve({ code: null, cancelled: false });
        }

        // Start a scoped TestRun without clearing controller.items so previously passed items stay visible
        let activeTestRun;
        try {
            const rerunItems = failedEntries.map(e => e.testItem).filter(Boolean);
            const runRequest = rerunItems.length > 0
                ? new vscode.TestRunRequest(rerunItems)
                : new vscode.TestRunRequest();
            activeTestRun = controller.createTestRun(runRequest, 'ABLUnit Rerun Failed Tests', true);
            for (const item of rerunItems) {
                if (typeof activeTestRun.started === 'function') {
                    activeTestRun.started(item);
                }
            }
            vscode.commands.executeCommand('workbench.view.testing');
            vscode.commands.executeCommand('testing.showMostRecentOutput');
        } catch (runErr) {
            console.error('Failed to create active TestRun for rerun:', runErr);
        }

        const commandString = `${runnerCommand} --workdir "${workdir}" --testfile "${testFileArg}"` +
            (resolvedPropathStr ? ` --propath "${resolvedPropathStr}"` : '') +
            (effectiveDlc ? ` --dlc "${effectiveDlc}"` : '');

        return executeCommandString(
            commandString,
            workdir,
            () => readResultsXml(outputFolder, workdir, fallbackProjectCfg, activeTestRun, { merge: true }),
            effectiveDlc,
            { testRun: activeTestRun, activeProfileName: projectCfg._resolvedProfileName }
        );
    });
    
    context.subscriptions.push(runABLUnitOnFile);
    context.subscriptions.push(runABLUnitOnTestItem);
    context.subscriptions.push(rerunFailedTests);
    context.subscriptions.push(runABLUnitOnTestSuite);

}

// This method is called when your extension is deactivated
function deactivate() {
    failedTestsByKey.clear();
    if (activeAblUnitSession) {
        activeAblUnitSession.disposeOnDeactivate();
    }
    if (ablUnitOutputChannel) {
        ablUnitOutputChannel.dispose();
        ablUnitOutputChannel = undefined;
    }
}

module.exports = {
	activate,
    deactivate
}
