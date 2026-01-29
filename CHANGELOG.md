# Change Log

  Initial release 1.0.0

## 1.0.4

- **Enhanced OpenEdge Project Configuration Support:**
    - The extension now more robustly identifies the OpenEdge project root within various workspace structures, including multi-root workspaces.
    - Improved parsing of `.propath` files:
        - Correctly identifies source (`src`) entries, enabling proper prefix stripping for relevant test files.
        - Replaces `@{ROOT}` with `.` in `.propath` entries for accurate path resolution.
        - Handles project-relative paths starting with `\` by prepending `..` for better compatibility.
- **Database Connection Discovery:**
    - Integrated support for discovering database connection details from OpenEdge Developer Studio's `databaseConnection.xml` file.
    - Reads project-specific database connection identifiers from `.dbconnection` files (located next to `.propath`) to filter and load only relevant database configurations.
    - Generates connection strings in the format `-db <physicalname> -H <host> -S <service>` for use in the ABLUnit test environment.