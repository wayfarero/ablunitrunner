// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DOMParser } = require('xmldom');

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

    vscode.window.showInformationMessage("started loadOpenEdgeProjectConfig for file: " + filePath);

    if (filePath) {
        try {
            const fileUri = vscode.Uri.file(filePath);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
            if (workspaceFolder) {
                workspaceRoot = workspaceFolder.uri.fsPath;
            }
        } catch (err) {
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
            vscode.window.showInformationMessage("openedge-project.json parsed: " + openedgeProjectJsonPath);
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
            vscode.window.showInformationMessage(".propath parsed: " + propathPath);

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
                vscode.window.showInformationMessage(".dbconnection found: " + dbConnFilterPath);
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
            vscode.window.showInformationMessage("databaseConnection.xml parsed.");
        } catch (err) {
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
 * @param {string} [channelName]
 */
function executeCommandString(commandString, filePath, channelName = 'ABLUnit Runner', onCloseCommand) {
    try {
        const workspaceFolderPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath || process.cwd();
        const outputChannel = vscode.window.createOutputChannel(channelName);
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

        vscode.window.showInformationMessage(`Executing command (see '${channelName}' output)`);
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

    // //Create output channel
    // let ABLUnitResultsLog = vscode.window.createOutputChannel("ABLUnitResultsLog");
    // //Write to output.    
    // ABLUnitResultsLog.appendLine("Started loadAblUnitResults..");
    // ABLUnitResultsLog.show(true);
    
    vscode.commands.executeCommand('workbench.view.testing');
    vscode.commands.executeCommand('testing.showMostRecentOutput');
    
    // Clear previous test items
    controller.items.replace([]);

    const xml = parseResultsXml(xmlPath);
    const testSuites = xml.getElementsByTagName("testsuite");

    for (let i = 0; i < testSuites.length; i++) {
        const suiteNode = testSuites[i];

        const suiteName = suiteNode.getAttribute("classname") || "UnnamedSuite";
        const suiteFile = suiteNode.getAttribute("name") || "";
        const suiteId= suiteNode.getAttribute("id") || "";
        const suiteUri = vscode.Uri.file(path.resolve(suiteFile));

        // ---- Create Suite TestItem ----
        const suiteItem = controller.createTestItem(suiteId, suiteName, suiteUri);
        controller.items.add(suiteItem);

        // Parse test cases inside this suite
        //const testCaseNodes = suiteNode.getElementsByTagName("testcase");
        const testCaseNodes = getDirectChildrenByTag(suiteNode, "testcase");

        for (let j = 0; j < testCaseNodes.length; j++) {
            const testNode = testCaseNodes[j];
            
            const suiteFile = suiteNode.getAttribute("name") || "";
            const testName = testNode.getAttribute("name") || "UnnamedTest";
            const testFile = testNode.getAttribute("classname") || suiteFile ;
            const testLine = parseInt(testNode.getAttribute("line") || "1", 10);
            const testTime = testNode.getAttribute('time') || '0.000';
            const testStatus = testNode.getAttribute("status");

            const uri = vscode.Uri.file(path.resolve(testFile));

            // ABLUnitResultsLog.appendLine("handling testName: " + testName);
            // ABLUnitResultsLog.show(true);

            const range = new vscode.Range(testLine - 1, 0, testLine - 1, 0);

            // ---- Create Test Item ----
            const testId = `${suiteId}:${testName}`;
            const testItem = controller.createTestItem(testId, testName + ' (' + testTime + ')', uri);

            // Let VS Code highlight the test location
            testItem.range = range;

            // Attach to suite node
            suiteItem.children.add(testItem);

            // ---- Parse Results ----

            if (testStatus === "Success") {
                testItem.busy = false;
                testItem.error = undefined;
                run.passed(testItem);
            } else if (testStatus === "Error" || testStatus === "Failure") {
                 
                const errorNode = testNode.getElementsByTagName(testStatus.toLowerCase())[0];
                const errorMessage = errorNode.getAttribute("message")  || "Test failed";
                const errorType = errorNode.getAttribute("type") || "Unknown error";
                
                testItem.error = new vscode.TestMessage(errorMessage) ;
                testItem.error.location = new vscode.Location(uri, range);
                run.failed(testItem, new vscode.TestMessage(errorType + " : " + errorMessage + "\n" + errorNode.childNodes[0]));

            }

        }
    }
}


/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

	// Use the console to output diagnostic information (console.>log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension ABLUnit Runner is now active!');

	const controller = vscode.tests.createTestController('ablunitController', 'ABLUnit Tests');
    context.subscriptions.push(controller);

	// Internal helper: read the project's `results.xml` (optionally from a supplied project folder) and load it into the test controller
	function readResultsXml(outputFolder) {
		vscode.window.showInformationMessage('Refreshing ABLUnit results...');

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

		vscode.window.showInformationMessage('ABLUnit results refreshed.');
/*  TODO: cleanup output folder
        try {
            vscode.workspace.fs.delete(vscode.Uri.file(outputFolder), {
            recursive: true,
            useTrash: false   // set true if you want it in OS trash
        });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to remove .ablunitrunner output folder: ${err.message}`
            );
        }
*/
    }


    const runABLUnitOnFile = vscode.commands.registerCommand('ABLUnitRunner.RunABLUnitOnFile', function (resource) {
        // When invoked from the explorer/context menu VS Code passes the resource (Uri) as the
        // first argument. Fall back to the active editor if it's not provided.
        const filePath = resource?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;

        if (!filePath) {
            vscode.window.showInformationMessage('ABLUnit: No file selected');
            return;
        }

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

        const commandString = `${runner} --workdir "${workdir}" --testfile "${relPath}"` +
            (propathStr ? ` --propath "${propathStr}"` : '') +
            (dlcEnv ? ` --dlc "${dlcEnv}"` : '');

        // Execute the prepared command in the workspace folder and run the internal refresh when it finishes
        executeCommandString(commandString, workdir, 'ABLUnit Runner', readResultsXml.bind(null, outputFolder));
    });
    
    context.subscriptions.push(runABLUnitOnFile);

}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}



