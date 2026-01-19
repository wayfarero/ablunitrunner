# ABLUnitResults README

## Features

A simple extension that calls a bat script which runs the ABLUnit over the selected test file and then reads the generated results.xml into the VScode Test Results view

## Requirements

OE 12 installed

## Extension Settings

## Known Issues


## Release Notes

### 1.0.2

- Improved robustness when running tests for the first time in a new workspace.
- Added support for OpenEdge Developer Studio project folders (which use a `.propath` file for propath configuration when `openedge-project.json` is absent).
- General bug fixes and stability improvements.

### 1.0.1

Cleaner log, grouped output files into a .ablunitrunner folder

### 1.0.0

Initial release of ABLUnitRunner VSCode extension

## Working with Markdown


## Updating the Extension

To ensure you see the latest changes and bug fixes, please follow these steps when updating the extension to a new version:

1.  **Uninstall Previous Version:** In VS Code, go to the Extensions view (Ctrl+Shift+X or Cmd+Shift+X). Find "ABLUnit Runner", click the gear icon next to it, and select "Uninstall".
2.  **Install New Version:** From the Extensions view, click the "..." (three dots) menu at the top, select "Install from VSIX...", and then choose the new `.vsix` file from the `ablunitrunner\build\` directory (e.g., `ablunitrunner-1.0.2.vsix`).
3.  **Reload VS Code:** If prompted, reload VS Code to activate the new version. If not prompted, a full restart of VS Code might be necessary to clear any cached information.

## For more information


**Enjoy!**
