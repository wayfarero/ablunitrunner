# Change Log

## 1.0.7

- Added a fix to clear previous test run artifacts before each execution:
  - Deletes the `results.xml` file in the `.ablunitrunner` output folder at the start of every "Run ABLUnit" command.
  - Clears and refreshes the VS Code Testing view so stale results are not shown prior to loading fresh results.

## 1.0.6

- Fixed README demo GIF links so they display correctly.

## 1.0.5

- Updated README.md, CHANGELOG.md and package.json
- Removed obsolete/unnecessary files.

## 1.0.4

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

## 1.0.3
- Repository url updated in package.json

## 1.0.2

- Improved robustness when running tests for the first time in a new workspace.
- Added support for OpenEdge Developer Studio project folders (which use a `.propath` file for propath configuration when `openedge-project.json` is absent).
- General bug fixes and stability improvements.

## 1.0.1

- Cleaner log, grouped output files into a .ablunitrunner folder

## 1.0.0

- Initial release of ABLUnitRunner VSCode extension