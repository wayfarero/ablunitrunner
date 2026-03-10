# ABLUnit Runner
  
  A VS Code extension that executes a batch script to initiate [ABLUnit](https://docs.progress.com/bundle/openedge-developer-studio-help/page/Learn-About-ABLUnit-Test-Framework.html) test runs and subsequently parses and imports the results into the VS Code Test Results view. The extension is optimized for executing long-running and large-scale unit test suites.

## Features

- **Seamless ABLUnit Testing:** Run ABLUnit tests directly from VS Code and view the results in the Test Results view.
- **Flexible Configuration Support:** The extension automatically detects and uses your project's configuration. It supports:
    - **[Progress Developer Studio for OpenEdge](https://docs.progress.com/bundle/openedge-developer-studio-help/page/Learn-About-Progress-Developer-Studio-for-OpenEdge.html) workspaces:** Automatically reads `.propath`, `databaseConnection.xml`, and `.dbconnection` files from an existing Openedge Developer Studio workspace to configure the test environment, allowing you to import and use your existing Developer Studio projects in VS Code without any extra configuration.
    - **[Riverside Software OpenEdge ABL Extension](https://marketplace.visualstudio.com/items?itemName=RiversideSoftware.openedge-abl-lsp) workspaces:** Automatically reads  `openedge-project.json` from the OpenEdge ABL extension project configuration, enabling a smooth integration with an existing VSCode ABL workspace environment.
- **Designed for Large and Small Projects:** While optimized for large, time-consuming test suites, the extension is equally effective for running single, simple test cases.

## Requirements

- **[Progress OpenEdge](https://www.progress.com/openedge)** 11.7 or later installed
- the `DLC` environment variable needs to be set to the Progress OpenEdge installation path.

**Example:**
- **Windows:** `DLC=C:\Progress\OpenEdge`

### ABLUnit Runner Editor Context Menu
![Editor context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/editor.gif)

### ABLUnit Runner Explorer Context Menu
![Explorer context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/explorer.gif)

### ABLUnit Runner Test Explorer Context Menu
![Testing context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/testexplorer.gif)

## Release Notes

### 1.0.12

- **Bug Fix:** Fixed `.metadata` folder detection for projects with multiple source entries in `.propath` files. The extension now correctly resolves test file paths when `.propath` defines multiple source directories (e.g., `Tests`, `src`) in multi-project workspaces.
- **Code Refactoring:** Extracted reusable utility functions for path normalization and source path resolution to improve code maintainability and reduce duplication.

### 1.0.11

- bug fix `Rerun Test` and `Rerun Suite` commands for Test Explorer.
- updated demo gifs

### 1.0.10

- Improved error highlighting for failed tests:
  - Error markers now reliably appear at the affected line if available.
  - If no error line is found, the marker falls back to the test method header, ensuring visibility in the editor.
  - Fixes for robust error navigation and display in the Test Explorer.

### 1.0.9

- Added `Rerun Test` and `Rerun Suite` commands for Test Explorer and Test Results views context menus.
- minor fixes for improvement

### 1.0.8

- Bug fix: corrected navigation from Test Results view to tests.

### 1.0.7

- Ensures a clean slate before every run:
  - Deletes `.ablunitrunner/results.xml` at command start.
  - Clears and refreshes the VS Code Testing view so stale results aren’t displayed prior to loading new results.

### 1.0.6

- Fixed README demo GIF links so they display correctly.

### 1.0.5

- Updated README.md, CHANGELOG.md and package.json.
- Removed obsolete/unnecessary files.

### 1.0.4

- **Native OpenEdge Developer Studio Workspace Support:**
  - The extension now automatically discovers and uses configurations from native OpenEdge Developer Studio projects.
  - **PROPATH Recognition:**
    - It correctly parses `.propath` files to build the full propath for the test execution.
    - It robustly finds the project root, making it compatible with multi-root and nested project structures.
    - It handles various path formats, including `@{ROOT}` and paths starting with `\`.
  - **Database Connection Discovery:**
    - It automatically reads database connection details from the workspace's central `databaseConnection.xml` file.
    - It uses the project-specific `.dbconnection` file to load only the database connections that are relevant to the project being tested.
- General bug fixes and stability improvements.

### 1.0.3
- Repository url updated in package.json

### 1.0.2

- Improved robustness when running tests for the first time in a new workspace.
- Added support for OpenEdge Developer Studio project folders (which use a `.propath` file for propath configuration when `openedge-project.json` is absent).
- General bug fixes and stability improvements.

### 1.0.1

- Cleaner log, grouped output files into a .ablunitrunner folder

### 1.0.0

- Initial release of ABLUnitRunner VSCode extension


## Updating the Extension

This extension is published to the Visual Studio Code Marketplace. VS Code automatically checks for updates and will notify you when a new version is available. To manually check for updates:

1.  Open the **Extensions** view (`Ctrl+Shift+X`).
2.  If you see a number on the Extensions icon, it indicates available updates.
3.  Find "ABLUnit Runner" in the list of installed extensions. If an update is available, an **Update** button will appear. Click it to install the new version.

## For more information


**Enjoy!**
