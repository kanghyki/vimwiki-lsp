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

// hover용 파일 정보 가져오기 (상대 경로 처리)
function getWikiFileInfoForHover(wikiLink, currentDir) {
    try {
        let targetPath;

        // 상대 경로인지 확인
        if (wikiLink.startsWith("../") || wikiLink.startsWith("./")) {
            // 상대 경로: 현재 디렉터리 기준으로 해석
            targetPath = path.resolve(currentDir, wikiLink + ".md");
        } else {
            // 절대 경로: wikiRoot 기준으로 해석
            targetPath = path.join(wikiRoot, wikiLink + ".md");
        }

        // 파일 존재 확인
        if (!fs.existsSync(targetPath)) {
            // 파일이 없으면 전체 검색
            const foundPath = findExactFile(wikiLink);
            if (foundPath) {
                targetPath = foundPath;
            } else {
                console.log(`File not found: ${wikiLink}`);
                return null;
            }
        }

        const content = fs.readFileSync(targetPath, "utf-8");
        const frontmatter = parseFrontmatter(content);

        if (!frontmatter) {
            return { title: wikiLink, summary: "No frontmatter found" };
        }

        return {
            title: frontmatter.title || wikiLink,
            summary: frontmatter.summary || "No summary available",
            date: frontmatter.date,
            updated: frontmatter.updated,
        };
    } catch (error) {
        console.error(`Error reading file for hover ${wikiLink}:`, error);
        return null;
    }
}

// 파일을 정확히 찾기 위한 헬퍼 함수
function findExactFile(targetPath) {
    function walk(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const result = walk(fullPath);
                    if (result) return result;
                } else if (entry.isFile() && entry.name.endsWith(".md")) {
                    const relative = path
                        .relative(wikiRoot, fullPath)
                        .replace(/\.md$/, "");
                    // 정확한 매치 또는 파일명만 매치
                    if (
                        relative === targetPath ||
                        path.basename(relative) === targetPath ||
                        relative.toLowerCase() === targetPath.toLowerCase()
                    ) {
                        return fullPath;
                    }
                }
            }
        } catch (error) {
            console.error(`Error walking directory ${dir}:`, error);
        }
        return null;
    }

    return walk(wikiRoot);
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
    try {
        const doc = documents.get(textDocument.uri);
        if (!doc) return null;

        const lines = doc.getText().split("\n");
        const line = lines[position.line];

        // 현재 라인에서 [[]] 패턴 찾기
        const wikiLink = extractWikiLink(line, position.character);

        if (!wikiLink) return null;

        // 현재 문서의 디렉터리 경로 계산
        const currentDocPath = textDocument.uri.replace("file://", "");
        const currentDir = path.dirname(currentDocPath);

        // 파일 정보 가져오기 (상대 경로 고려)
        const fileInfo = getWikiFileInfoForHover(wikiLink, currentDir);

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

        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: hoverContent,
            },
        };
    } catch (error) {
        console.error("Hover error:", error);
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**Error**\n\nFailed to load file information`,
            },
        };
    }
});

function findMatchingFiles(prefix, currentDocumentUri) {
    const results = [];

    // 현재 문서의 디렉토리 경로 계산
    const currentDocPath = currentDocumentUri.replace("file://", "");
    const currentDir = path.dirname(currentDocPath);

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
                    // 현재 파일에서 대상 파일로의 상대 경로 계산
                    const targetPath = path.join(wikiRoot, relative + ".md");
                    const relativePath = path
                        .relative(currentDir, targetPath)
                        .replace(/\.md$/, "")
                        .replace(/\\/g, "/"); // Windows 경로 구분자를 슬래시로 변경

                    // 파일의 frontmatter 정보 읽기
                    const fileInfo = getFileInfoForCompletion(fullPath);

                    // 디렉터리 정보 생성
                    const dirName = path.dirname(relative);
                    const displayDir = dirName === "." ? "root" : dirName;

                    results.push({
                        label: relativePath,
                        kind: CompletionItemKind.File,
                        detail: displayDir, // 디렉터리만 간단히 표시
                        documentation: {
                            kind: MarkupKind.Markdown,
                            value: fileInfo.summary
                                ? `**${fileInfo.title || relative}**\n\n${
                                      fileInfo.summary
                                  }`
                                : `**${fileInfo.title || relative}**`,
                        },
                        // 정렬을 위한 sortText (옵션)
                        sortText: relativePath.toLowerCase(),
                        // 실제 삽입될 텍스트
                        insertText: relativePath,
                    });
                }
            }
        }
    }
    walk(wikiRoot);
    return results;
}

// 자동완성용 파일 정보 가져오기 (성능 최적화)
function getFileInfoForCompletion(fullPath) {
    try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const frontmatter = parseFrontmatter(content);

        if (!frontmatter) {
            return { title: null, summary: null };
        }

        return {
            title: frontmatter.title || null,
            summary: frontmatter.summary || null,
        };
    } catch (error) {
        console.error(`Error reading file for completion ${fullPath}:`, error);
        return { title: null, summary: null };
    }
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
        // 현재 문서의 URI를 전달
        return findMatchingFiles(query, textDocument.uri);
    }
    return [];
});

documents.listen(connection);
connection.listen();
