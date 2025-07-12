const {
    createConnection,
    TextDocuments,
    CompletionItemKind,
    ProposedFeatures,
    TextDocumentSyncKind,
    MarkupKind,
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");
const fs = require("fs");
const path = require("path");
const logFile = "/tmp/wiki-lsp.log";
function log(...args) {
    const msg = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
    fs.appendFileSync(logFile, msg);
}

const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let wikiRoot = "";

connection.onInitialize((params) => {
    wikiRoot = params.initializationOptions?.wikiRoot || "./wiki";
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                triggerCharacters: ["["],
            },
            // hover 기능 추가
            hoverProvider: true,
        },
    };
});

// frontmatter 파싱 함수
function parseFrontmatter(content) {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
    const match = content.match(frontmatterRegex);

    if (!match) return null;

    const frontmatter = {};
    const lines = match[1].split("\n");

    for (const line of lines) {
        const colonIndex = line.indexOf(":");
        if (colonIndex !== -1) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            frontmatter[key] = value;
        }
    }

    return frontmatter;
}

// 파일 경로에서 wiki 파일 정보 가져오기
function getWikiFileInfo(filePath) {
    try {
        const fullPath = path.join(wikiRoot, filePath + ".md");

        if (!fs.existsSync(fullPath)) {
            return null;
        }

        const content = fs.readFileSync(fullPath, "utf-8");
        const frontmatter = parseFrontmatter(content);

        if (!frontmatter) {
            return { title: filePath, summary: "No frontmatter found" };
        }

        return {
            title: frontmatter.title || filePath,
            summary: frontmatter.summary || "No summary available",
            date: frontmatter.date,
            updated: frontmatter.updated,
        };
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return null;
    }
}

// [[]] 패턴에서 파일 경로 추출
function extractWikiLink(text, position) {
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;

        if (position >= start && position <= end) {
            return match[1]; // 대괄호 안의 파일 경로
        }
    }

    return null;
}

// hover 이벤트 처리
connection.onHover(({ textDocument, position }) => {
    log("hover");
    const doc = documents.get(textDocument.uri);
    if (!doc) return null;

    const lines = doc.getText().split("\n");
    const line = lines[position.line];

    // 현재 라인에서 [[]] 패턴 찾기
    const wikiLink = extractWikiLink(line, position.character);

    if (!wikiLink) return null;

    // 파일 정보 가져오기
    const fileInfo = getWikiFileInfo(wikiLink);

    if (!fileInfo) {
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**${wikiLink}**\n\n*File not found*`,
            },
        };
    }

    // hover 내용 구성
    let hoverContent = `**${fileInfo.title}**\n\n`;

    if (fileInfo.summary) {
        hoverContent += `${fileInfo.summary}\n\n`;
    }

    if (fileInfo.date) {
        hoverContent += `📅 Created: ${fileInfo.date}\n`;
    }

    if (fileInfo.updated) {
        hoverContent += `🔄 Updated: ${fileInfo.updated}\n`;
    }
    log(hoverContent);

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: hoverContent,
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
    if (!doc) return [];

    const lines = doc.getText().split("\n");
    const line = lines[position.line];
    const prefix = line.slice(0, position.character);
    const match = prefix.match(/\[\[([^\]]*)$/);

    if (match) {
        const query = match[1];
        return findMatchingFiles(query);
    }
    return [];
});

documents.listen(connection);
connection.listen();
