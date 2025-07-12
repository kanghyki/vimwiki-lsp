const {
    createConnection,
    TextDocuments,
    CompletionItemKind,
    ProposedFeatures,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const fs = require("fs");
const path = require("path");

const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let wikiRoot = "";

connection.onInitialize((params) => {
    wikiRoot = params.initializationOptions?.wikiRoot || "./wiki";
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            completionProvider: {
                triggerCharacters: ["["],
            },
        },
    };
});

function findMatchingFiles(prefix) {
    const results = [];

    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const relative = path
                    .relative(wikiRoot, fullPath)
                    .replace(/\.md$/, "");
                if (relative.toLowerCase().includes(prefix.toLowerCase())) {
                    results.push({
                        label: relative,
                        kind: CompletionItemKind.File,
                        detail: "Wiki file",
                    });
                }
            }
        }
    }

    walk(wikiRoot);
    return results;
}

connection.onCompletion(async ({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    const lines = doc.getText().split("\n");
    const line = lines[position.line];
    const prefix = line.slice(0, position.character);
    const match = prefix.match(/\[\[([^\]]*)$/);

    if (match) {
        const query = match[1]; // 사용자가 [[ 이후에 입력한 문자열
        return findMatchingFiles(query);
    }

    return [];
});

documents.listen(connection);
connection.listen();
