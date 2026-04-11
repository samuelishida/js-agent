## session-facts (2026-04-06)
- The local and cloud LLM code paths are located in `src/app`.
- The user is interested in identifying potential flaws in the local vs cloud LLM routing.
- **CORRECTION**: NEVER read code outside especified folder for this project `D:\Code\Agent`.
- **CORRECTION**: WRONG: The assistant did not specify the exact files being reviewed. RIGHT: Clearly mention the specific files or 
components being analyzed in the project.

## session-facts (2026-04-06)
- The project is located in `D:\Code\Agent`.
- The source code for the JS agent is in `D:\Code\Agent\src\app`.
- **CORRECTION**: NEVER read code outside especified folder for this project `D:\Code\Agent`.
- **CORRECTION**: WRONG: The assistant mentioned reviewing the local/cloud routing code without specifying the correct folder. RIGHT: Focus on the `D:\Code\Agent\src\app` directory for the JS agent files.

## session-facts (2026-04-06)
- The project has a directory structure with specific folders for `src` and `proxy`.
- The local backend implementation is found in `src/app/local-backend.js`.
- The cloud vs local backend logic is searched using specific keywords in the codebase.
- **CORRECTION**: WRONG: The assistant did not specify the exact files being read. RIGHT: Always mention the specific files being analyzed for clarity.

## session-facts (2026-04-06)
- The local backend defaults to ENABLED if the key doesn't exist, causing potential hang-ups if the local server crashes.
- The function `getLaneForRequest()` in `llm.js` does not handle errors properly when the local URL is invalid.
- **CORRECTION**: WRONG: The assistant did not specify the exact lines of code where issues were found. RIGHT: Always reference specific lines and files when discussing code issues.

## session-facts (2026-04-06)
- The local backend defaults to ENABLED if the key doesn't exist, causing potential issues if the local server crashes.
- The function `getLaneForRequest()` in `llm.js` does not handle errors properly when the local URL is invalid.
- There is a message normalization bug in `llm.js` that needs to be addressed.
- **CORRECTION**: WRONG: The assistant suggested reading the file content first. RIGHT: The assistant should directly address the identified issues based on the review provided.
