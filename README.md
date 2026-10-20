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
- the `DLC` environment variable needs to be set to the Progress OpenEdge installation path, or the project `openedge-project.json` `oeversion` must match a runtime in VS Code setting `abl.configuration.runtimes`.

**Example:**
- **Windows:** `DLC=C:\Progress\OpenEdge`
- **Linux:** `DLC=/usr/dlc`

### ABLUnit Runner Editor Context Menu
![Editor context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/editor.gif)

### ABLUnit Runner Explorer Context Menu
![Explorer context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/explorer.gif)

### ABLUnit Runner Test Explorer Context Menu
![Testing context](https://github.com/wayfarero/ablunitrunner/raw/main/resources/demo/testexplorer.gif)

## Release Notes

### 1.0.17

- **Bugfixes:** 
  - corrected DLC resolving based on Openedge ABL runtime configuration.
  

For the complete release history, see [CHANGELOG.md](CHANGELOG.md).

## Updating the Extension

This extension is published to the Visual Studio Code Marketplace. VS Code automatically checks for updates and will notify you when a new version is available. To manually check for updates:

1.  Open the **Extensions** view (`Ctrl+Shift+X`).
2.  If you see a number on the Extensions icon, it indicates available updates.
3.  Find "ABLUnit Runner" in the list of installed extensions. If an update is available, an **Update** button will appear. Click it to install the new version.

## For more information


**Enjoy!**
