# ABLUnitResults README

## Features

- **Seamless ABLUnit Testing:** Run ABLUnit tests directly from VS Code and view the results in the Test Results view.
- **Flexible Configuration Support:** The extension automatically detects and uses your project's configuration. It supports:
    - **OpenEdge Developer Studio workspaces:** Automatically reads `.propath`, `databaseConnection.xml`, and `.dbconnection` files to configure the test environment, allowing you to import and use your existing Developer Studio projects in VS Code.
    - **OpenEdge ABL Extension workspaces:** Natively supports `openedge-project.json` for workspace configuration, integrating smoothly with the environment provided by the [OpenEdge ABL Language & Debug Support extension from Riverside Software](https://marketplace.visualstudio.com/items?itemName=RiversideSoftware.openedge-abl-lsp).
- **Designed for Large and Small Projects:** While optimized for large, time-consuming test suites, the extension is equally effective for running single, simple test cases.

## Requirements

- Progress OpenEdge 11.7 or later installed
- the `DLC` environment variable needs to be set to the Progress OpenEdge installation path.

**Example:**
- **Windows:** `DLC=C:\Progress\OpenEdge`


## Release Notes

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
