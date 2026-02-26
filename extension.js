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
 * Load and parse `openedge-project.json` from the supplied path.
 * Returns an object (empty on missing file or parse errors).
 *
 * @param {string|undefined} filePath
 * @returns {Object}
 */
function loadOpenEdgeProjectConfig(filePath) {
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
    if (vscode.workspace.workspaceFile) {
        metadataRoot = path.dirname(vscode.workspace.workspaceFile.fsPath);
    } else {
        metadataRoot = workspaceRoot;
    }

    const dbConnXmlPath = path.join(metadataRoot, '.metadata', '.plugins', 'com.openedge.pdt.project', 'databaseConnection.xml');
    const dbConnFilterPath = path.join(oeProjectRoot, '.dbconnection');
    
    if (!cfg.dbConnections && fs.existsSync(dbConnXmlPath)) {
        vscode.window.showInformationMessage("databaseConnection.xml exists: " + dbConnXmlPath);
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
function buildPropathStr(projectCfg) {
    const collected = [];

    if (Array.isArray(projectCfg.buildPath)) {
        // Add all path entries regardless of type
        for (const entry of projectCfg.buildPath) {
            if (entry && entry.path) {
                let s = entry.path.replace(/\\\//g, '/');
                // Replace @{DLC}, ${DLC}, @{dlc}, ${dlc} with %DLC%
                s = s.replace(/@\{[Dd][Ll][Cc]\}|\$\{[Dd][Ll][Cc]\}/g, '%DLC%');
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
function executeCommandString(commandString, filePath, onCloseCommand) {
    try {
        const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath || process.cwd();
        const outputChannel = getAblUnitOutputChannel();
        outputChannel.show(true);
        outputChannel.appendLine(`Executing: ${commandString}`);

        const proc = spawn(commandString, { shell: true, cwd: workspaceFolderPath, env: process.env });

        proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
        proc.stderr.on('data', (data) => outputChannel.append(data.toString()));

        proc.on('error', (err) => {
            outputChannel.appendLine(`Failed to start process: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to run ABLUnit: ${err.message}`);
        });

        proc.on('close', (code) => {
            outputChannel.appendLine(`Process exited with code ${code}`);
            const msg = code === 0 ? 'Run completed successfully' : `Run completed with exit code ${code}`;
            vscode.window.showInformationMessage(msg);
            // Optionally execute a function callback or a registered VS Code command after the process exits
            if (onCloseCommand) {
                try {
                    if (typeof onCloseCommand === 'function') {
                        // Call the function and pass the exit code
                        onCloseCommand(code);
                    } else {
                        vscode.commands.executeCommand(onCloseCommand);
                    }
                } catch (err) {
                    console.error('Failed to execute onCloseCommand:', err);
                }
            }
        });

        vscode.window.showInformationMessage(`Executing command (see 'ABLUnit Runner' output)`);
    } catch (err) {
        console.error('Failed to execute command:', err);
        vscode.window.showErrorMessage('Failed to execute prepared command. See developer console for details.');
    }
}

/**
 * @param {vscode.TestController} controller
 * @param {string} xmlPath
 * @param {vscode.TestRun} xmlPath
 */
function loadAblUnitResults(controller, xmlPath, run) {

    const outputChannel = getAblUnitOutputChannel();
    outputChannel.appendLine(`Start loading AblUnit results..`);    

    vscode.commands.executeCommand('workbench.view.testing');
    vscode.commands.executeCommand('testing.showMostRecentOutput');
    
    // Clear previous test items
    controller.items.replace([]);

    const xml = parseResultsXml(xmlPath);
    const xmlWorkspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(xmlPath));
    const baseWorkspacePath = xmlWorkspaceFolder ? xmlWorkspaceFolder.uri.fsPath : path.dirname(xmlPath);

    function addSuiteRecursive(suiteNode, parentItem) {
        const suiteName = suiteNode.getAttribute("classname") || suiteNode.getAttribute("name") || "UnnamedSuite";
        const suiteFile = suiteNode.getAttribute("name") || "";
        const suiteId = suiteNode.getAttribute("id") || Math.random().toString(36).substr(2, 9);
        const suitePath = path.isAbsolute(suiteFile) ? suiteFile : path.join(baseWorkspacePath, suiteFile);
        const suiteUri = vscode.Uri.file(suitePath);
        const suiteItem = controller.createTestItem(suiteId, suiteName, suiteUri);
        suiteItem.contextValue = "ablunitSuite";
        if (parentItem) {
            parentItem.children.add(suiteItem);
        } else {
            controller.items.add(suiteItem);
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
            const testPath = path.isAbsolute(testFile) ? testFile : path.join(baseWorkspacePath, testFile);
            const uri = vscode.Uri.file(testPath);
            const range = findAblTestRange(uri.fsPath, testName);
            const testId = `${suiteId}:${testName}`;
            const testItem = controller.createTestItem(testId, testName + ' (' + testTime + ')', uri);
            testItem.contextValue = "ablunitTest";
                testItem.range = range;
                console.log(`[ABLUnitRunner] Set range for testItem ${testItem.id}:`, range);
            suiteItem.children.add(testItem);
            if (testStatus === "Success") {
                testItem.busy = false;
                testItem.error = undefined;
                run.passed(testItem);
            } else if (testStatus === "Error" || testStatus === "Failure") {
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
    outputChannel.appendLine(`Done loading AblUnit results.`);    

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

    // Register handler for running tests (via CodeLens, Test Results view, etc.)
    controller.runHandler = async (request) => {
        const tests = request.include || [];
        for (const test of tests) {
            // Extract test name from test ID (format: "suiteId:testName")
            const testName = test.id.includes(':') ? test.id.split(':')[1] : undefined;
            // Run the test using the existing command
            await vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', test.uri, testName);
        }
    };


	// Internal helper: read the project's `results.xml` (optionally from a supplied project folder) and load it into the test controller
	function readResultsXml(outputFolder) {
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
		
		const run = controller.createTestRun(new vscode.TestRunRequest());

		loadAblUnitResults(controller, resultsFile, run);

		run.end();

//		vscode.window.showInformationMessage('ABLUnit results refreshed.');

}


    const runABLUnitOnFile = vscode.commands.registerCommand('ABLUnitRunner.RunABLUnitOnFile', function (resource, selectedTestName) {
        // When invoked from the explorer/context menu VS Code passes the resource (Uri) as the
        // first argument. Fall back to the active editor if it's not provided.
        const filePath = resource?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;

        if (!filePath) {
            vscode.window.showInformationMessage('ABLUnit: No file selected');
            return;
        }

        // Start each run with a clean output channel
        const outputChannel = getAblUnitOutputChannel();
        outputChannel.clear();

        // Attempt to load OpenEdge project configuration from the workspace folder containing the selected file
        let projectCfg = {};
        // Load configuration if found (delegated to helper)
        projectCfg = loadOpenEdgeProjectConfig(filePath);

        // Read DLC environment variable if present
        const dlcEnv = process.env.DLC || process.env.dlc;
        // If the project references ${DLC} (or %DLC%), require the DLC env var to be set
        if (!dlcEnv) {
            vscode.window.showErrorMessage('Environment variable DLC is not set. Please set %DLC% to your OpenEdge installation path and restart VS Code.');
            return;
        }

        // Extract fields and build pieces
        const runner = path.join( context.extensionPath, 'resources', 'scripts', 'run_ABLUNIT.bat' );
        const extraParams = projectCfg.extraParameters || '';
        const propathStr = buildPropathStr(projectCfg);
        const dbConnectStr = getDbConnectsSpaceSeparated(projectCfg);


        // Split filePath into workspace folder and relative path
        const fileUri = vscode.Uri.file(filePath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        const workdir = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(filePath);
        let relPath = workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, filePath).replace(/\\/g, '/') : path.basename(filePath);

        if (filePath.toLowerCase().endsWith('.cls')) {
            const sourcePaths = projectCfg.buildPath
                ?.filter(p => p.type === 'source' && p.path)
                .map(p => {
                    let pth = p.path.replace(/\\/g, '/');
                    // Remove leading './' if it exists and path is not just '.'
                    if (pth.startsWith('./') && pth.length > 1) {
                        pth = pth.substring(2);
                    } else if (pth === '.') { // If path is just '.', treat as empty string for root matching
                        pth = '';
                    }
                    return pth;
                }) || [];
            sourcePaths.sort((a, b) => b.length - a.length); // Sort by longest path first

            for (const sourcePath of sourcePaths) {
                if (relPath.startsWith(sourcePath + '/')) {
                    relPath = relPath.substring(sourcePath.length + 1);
                    break;
                }
            }
        }

        const outputFolder = path.join(workdir, '.ablunitrunner');

        // Clear the Testing view and previous results immediately
        try {
            controller.items.replace([]);
            controller.invalidateTestResults();
            // Publish a blank, most-recent test run so the output panel resets
            const blankRun = controller.createTestRun(new vscode.TestRunRequest(), 'No current test results', true);
            blankRun.end();
            vscode.commands.executeCommand('workbench.view.testing');
            vscode.commands.executeCommand('testing.showMostRecentOutput');
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
            return;
        }

        const resolvedTestName = typeof selectedTestName === 'string'
            ? (selectedTestName.trim().split(/\s+/)[0] || '')
            : '';
        const testFileArg = resolvedTestName ? `${relPath}#${resolvedTestName}` : relPath;

        const commandString = `${runner} --workdir "${workdir}" --testfile "${testFileArg}"` +
            (propathStr ? ` --propath "${propathStr}"` : '') +
            (dlcEnv ? ` --dlc "${dlcEnv}"` : '');

        // Execute the prepared command in the workspace folder and run the internal refresh when it finishes
        executeCommandString(commandString, workdir, readResultsXml.bind(null, outputFolder));
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
            vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri, selectedTestName);
            return;
        }

        vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri);
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
        vscode.commands.executeCommand('ABLUnitRunner.RunABLUnitOnFile', testUri);
    });
    
    context.subscriptions.push(runABLUnitOnFile);
    context.subscriptions.push(runABLUnitOnTestItem);
    context.subscriptions.push(runABLUnitOnTestSuite);

}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
    deactivate
}



